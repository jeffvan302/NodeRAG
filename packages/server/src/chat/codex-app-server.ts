import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const CODEX_PACKAGE_VERSION = '0.147.0';
const MAX_REQUEST_ID = 2_147_483_647;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_MAX_BYTES = 8 * 1_048_576;
const MODEL_CATALOG_TIMEOUT_MS = 30_000;

const ADMINISTRATION_METHODS = new Set([
  'account/read',
  'account/login/start',
  'account/login/cancel',
  'account/logout',
  'account/rateLimits/read',
  'model/list',
]);

const CHAT_METHODS = new Set(['thread/start', 'turn/start', 'turn/interrupt', 'thread/delete']);

type JsonRpcId = number;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup?: () => void;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  readonly id: number;
}

export class CodexAppServerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
    this.retryable = retryable;
  }
}

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export interface CodexModelCapacityEvidence {
  readonly model: string;
  readonly effectiveContextTokens: number;
  readonly maximumContextTokens: number;
  readonly maximumOutputTokens: number | null;
}

const catalogInteger = (value: unknown, maximum: number): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : null;

/**
 * Extracts only bounded capacity evidence from the raw Codex model catalog. The full catalog also
 * contains large instruction templates that NodeRag neither stores nor exposes.
 */
export const parseCodexModelCapacityCatalog = (
  value: string | unknown,
): readonly CodexModelCapacityEvidence[] => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new CodexAppServerError(
        'openai_capacity_catalog_malformed',
        'The OpenAI model capacity catalog was malformed.',
      );
    }
  }
  const root = objectRecord(parsed);
  const models = root?.['models'];
  if (!Array.isArray(models) || models.length > 1_000) {
    throw new CodexAppServerError(
      'openai_capacity_catalog_malformed',
      'The OpenAI model capacity catalog was malformed.',
    );
  }
  const capacities: CodexModelCapacityEvidence[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const record = objectRecord(item);
    const model = typeof record?.['slug'] === 'string' ? record['slug'].trim() : '';
    const effectiveContextTokens = catalogInteger(record?.['context_window'], 10_000_000);
    const maximumContextTokens =
      catalogInteger(record?.['max_context_window'], 10_000_000) ?? effectiveContextTokens;
    const maximumOutputTokens =
      catalogInteger(record?.['max_output_tokens'], 1_000_000) ??
      catalogInteger(record?.['maximum_output_tokens'], 1_000_000) ??
      catalogInteger(record?.['output_token_limit'], 1_000_000);
    const key = model.toLowerCase();
    if (
      model.length === 0 ||
      model.length > 180 ||
      effectiveContextTokens === null ||
      maximumContextTokens === null ||
      maximumContextTokens < effectiveContextTokens ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    capacities.push({
      model,
      effectiveContextTokens,
      maximumContextTokens,
      maximumOutputTokens,
    });
  }
  if (capacities.length === 0) {
    throw new CodexAppServerError(
      'openai_capacity_catalog_empty',
      'The OpenAI model capacity catalog contained no usable measurements.',
    );
  }
  return capacities;
};

const responseError = (value: unknown): CodexAppServerError => {
  const record = objectRecord(value);
  const numericCode = typeof record?.['code'] === 'number' ? record['code'] : null;
  return new CodexAppServerError(
    numericCode === null ? 'app_server_request_failed' : `app_server_error_${String(numericCode)}`,
    'The OpenAI connection service rejected the request.',
    numericCode === -32_603 || numericCode === -32_000,
  );
};

/**
 * Redacts credential-shaped values before app-server stderr is retained for diagnostics.
 * This is deliberately broader than the credential file schema.
 */
export const redactCodexDiagnosticText = (value: string): string =>
  value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(
      /("?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret)"?\s*[:=]\s*")[^"]*(")/giu,
      '$1[REDACTED]$2',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/gu,
      '[REDACTED-JWT]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED-KEY]');

export interface JsonLinePeerOptions {
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly onNotification?: (notification: AppServerNotification) => void;
  readonly onRequest?: (request: AppServerRequest) => Promise<unknown>;
  readonly onProtocolError?: (error: CodexAppServerError) => void;
}

/** A bounded newline-delimited JSON-RPC peer used by the supervised app-server process. */
export class JsonLineAppServerPeer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #maxFrameBytes: number;
  readonly #maxPendingRequests: number;
  readonly #requestTimeoutMs: number;
  readonly #onNotification: ((notification: AppServerNotification) => void) | undefined;
  readonly #onRequest: ((request: AppServerRequest) => Promise<unknown>) | undefined;
  readonly #onProtocolError: ((error: CodexAppServerError) => void) | undefined;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #buffer = '';
  #nextRequestId = 1;
  #closed = false;

  constructor(input: Readable, output: Writable, options: JsonLinePeerOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onProtocolError = options.onProtocolError;
    input.setEncoding('utf8');
    input.on('data', this.#handleData);
    input.on('error', this.#handleStreamError);
    input.on('end', this.#handleStreamEnd);
    output.on('error', this.#handleStreamError);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(
    method: string,
    params: unknown,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(
        new CodexAppServerError(
          'app_server_unavailable',
          'The OpenAI connection service is closed.',
        ),
      );
    if (!/^[a-z][A-Za-z0-9]*(?:\/[A-Za-z0-9]+)+$/u.test(method) && method !== 'initialize') {
      return Promise.reject(
        new CodexAppServerError('app_server_invalid_method', 'Invalid app-server method.'),
      );
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(
        new CodexAppServerError(
          'app_server_capacity_exceeded',
          'The OpenAI connection service has too many pending requests.',
          true,
        ),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new CodexAppServerError(
          'app_server_request_cancelled',
          'The app-server request was cancelled.',
        ),
      );
    }
    const id = this.#allocateRequestId();
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      return Promise.reject(
        new CodexAppServerError('app_server_invalid_timeout', 'Invalid app-server timeout.'),
      );
    }
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.abortCleanup?.();
        rejectRequest(
          new CodexAppServerError(
            'app_server_request_timeout',
            'The OpenAI connection service did not respond in time.',
            true,
          ),
        );
      }, timeoutMs);
      timer.unref();
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        rejectRequest(
          new CodexAppServerError(
            'app_server_request_cancelled',
            'The app-server request was cancelled.',
          ),
        );
      };
      const abortCleanup =
        options.signal === undefined
          ? undefined
          : (): void => options.signal?.removeEventListener('abort', onAbort);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        ...(abortCleanup === undefined ? {} : { abortCleanup }),
      });
      const frame = `${JSON.stringify({ id, method, params })}\n`;
      if (Buffer.byteLength(frame, 'utf8') > this.#maxFrameBytes) {
        clearTimeout(timer);
        abortCleanup?.();
        this.#pending.delete(id);
        rejectRequest(
          new CodexAppServerError(
            'app_server_frame_too_large',
            'The app-server request is too large.',
          ),
        );
        return;
      }
      this.#output.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) throw new CodexAppServerError('app_server_unavailable', 'App-server closed.');
    const payload = params === undefined ? { method } : { method, params };
    this.#output.write(`${JSON.stringify(payload)}\n`);
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off('data', this.#handleData);
    this.#input.off('error', this.#handleStreamError);
    this.#input.off('end', this.#handleStreamEnd);
    this.#output.off('error', this.#handleStreamError);
    const failure =
      error ??
      new CodexAppServerError('app_server_unavailable', 'The OpenAI connection service closed.');
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.abortCleanup?.();
      request.reject(failure);
    }
    this.#pending.clear();
  }

  #allocateRequestId(): number {
    for (let attempt = 0; attempt < MAX_REQUEST_ID; attempt += 1) {
      const id = this.#nextRequestId;
      this.#nextRequestId = id === MAX_REQUEST_ID ? 1 : id + 1;
      if (!this.#pending.has(id)) return id;
    }
    throw new CodexAppServerError('app_server_request_ids_exhausted', 'No request IDs available.');
  }

  readonly #handleData = (chunk: string | Buffer): void => {
    if (this.#closed) return;
    this.#buffer += String(chunk);
    if (
      Buffer.byteLength(this.#buffer, 'utf8') > this.#maxFrameBytes &&
      !this.#buffer.includes('\n')
    ) {
      this.#protocolFault('app_server_frame_too_large');
      return;
    }
    let boundary = this.#buffer.indexOf('\n');
    while (boundary >= 0 && !this.#closed) {
      const line = this.#buffer.slice(0, boundary).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(boundary + 1);
      if (Buffer.byteLength(line, 'utf8') > this.#maxFrameBytes) {
        this.#protocolFault('app_server_frame_too_large');
        return;
      }
      if (line.length > 0) this.#handleFrame(line);
      boundary = this.#buffer.indexOf('\n');
    }
  };

  readonly #handleStreamError = (): void => {
    this.close(
      new CodexAppServerError(
        'app_server_transport_failed',
        'The OpenAI connection service transport failed.',
        true,
      ),
    );
  };

  readonly #handleStreamEnd = (): void => {
    this.close(
      new CodexAppServerError(
        'app_server_transport_closed',
        'The OpenAI connection service stopped.',
        true,
      ),
    );
  };

  #handleFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#protocolFault('app_server_malformed_json');
      return;
    }
    const message = objectRecord(parsed);
    if (message === null) {
      this.#protocolFault('app_server_malformed_frame');
      return;
    }
    if ('id' in message) {
      const id = message['id'];
      if (!Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > MAX_REQUEST_ID) {
        this.#protocolFault('app_server_invalid_response_id');
        return;
      }
      if (typeof message['method'] === 'string') {
        const requestId = Number(id);
        const method = message['method'];
        if (this.#onRequest === undefined) {
          this.#output.write(
            `${JSON.stringify({ id, error: { code: -32_601, message: 'Method not available' } })}\n`,
          );
          return;
        }
        void this.#onRequest({ id: requestId, method, params: message['params'] })
          .then((result) => this.#output.write(`${JSON.stringify({ id: requestId, result })}\n`))
          .catch(() =>
            this.#output.write(
              `${JSON.stringify({ id: requestId, error: { code: -32_000, message: 'Request failed' } })}\n`,
            ),
          );
        return;
      }
      const pending = this.#pending.get(Number(id));
      if (pending === undefined) {
        this.#protocolFault('app_server_unknown_response_id');
        return;
      }
      const hasResult = 'result' in message;
      const hasError = 'error' in message;
      if (hasResult === hasError) {
        this.#protocolFault('app_server_invalid_response');
        return;
      }
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      this.#pending.delete(Number(id));
      if (hasError) pending.reject(responseError(message['error']));
      else pending.resolve(message['result']);
      return;
    }
    if (typeof message['method'] !== 'string' || 'result' in message || 'error' in message) {
      this.#protocolFault('app_server_invalid_notification');
      return;
    }
    this.#onNotification?.({ method: message['method'], params: message['params'] });
  }

  #protocolFault(code: string): void {
    const error = new CodexAppServerError(code, 'The OpenAI connection service sent invalid data.');
    this.#onProtocolError?.(error);
    this.close(error);
  }
}

export type CodexAppServerState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

export interface CodexAppServerOptions {
  readonly credentialHome: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly stderrLimitBytes?: number;
  readonly onNotification?: (notification: AppServerNotification) => void;
  readonly onRequest?: (request: AppServerRequest) => Promise<unknown>;
  readonly spawnProcess?: (input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }) => ChildProcessWithoutNullStreams;
}

const resolveCodexExecutable = async (): Promise<{ cliPath: string; version: string }> => {
  const entryDirectory = dirname(resolve(process.argv[1] ?? process.cwd()));
  const candidates = [
    process.env['NODERAG_CODEX_CLI'],
    join(entryDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.cwd(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ].filter((value): value is string => value !== undefined && value.length > 0);
  for (const candidate of new Set(candidates.map((value) => resolve(value)))) {
    try {
      const information = await lstat(candidate);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      const packagePath = join(dirname(dirname(candidate)), 'package.json');
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
      if (packageJson.version !== CODEX_PACKAGE_VERSION) {
        throw new CodexAppServerError(
          'app_server_version_mismatch',
          `Expected @openai/codex ${CODEX_PACKAGE_VERSION}.`,
        );
      }
      return { cliPath: candidate, version: packageJson.version };
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
    }
  }
  throw new CodexAppServerError(
    'app_server_executable_missing',
    'The pinned OpenAI connection service is not installed.',
  );
};

export const preparePrivateCodexHome = async (path: string): Promise<string> => {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const information = await lstat(absolute);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new CodexAppServerError(
      'app_server_credential_home_unsafe',
      'The OpenAI credential directory must be a regular directory.',
    );
  }
  await chmod(absolute, 0o700);
  const runtime = join(absolute, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  return absolute;
};

export class SupervisedCodexAppServer {
  readonly #options: CodexAppServerOptions;
  #state: CodexAppServerState = 'stopped';
  #process: ChildProcessWithoutNullStreams | null = null;
  #peer: JsonLineAppServerPeer | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #stderr = '';

  constructor(options: CodexAppServerOptions) {
    this.#options = options;
  }

  get state(): CodexAppServerState {
    return this.#state;
  }

  get diagnostics(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state !== 'stopped') {
      throw new CodexAppServerError(
        'app_server_invalid_state',
        'App-server cannot be started now.',
      );
    }
    this.#state = 'starting';
    try {
      const home = await preparePrivateCodexHome(this.#options.credentialHome);
      const runtime = join(home, 'runtime');
      const executable =
        this.#options.spawnProcess === undefined
          ? await resolveCodexExecutable()
          : { cliPath: '@openai/codex-test-double', version: CODEX_PACKAGE_VERSION };
      const arguments_ = [
        executable.cliPath,
        'app-server',
        '--stdio',
        '--strict-config',
        '-c',
        'analytics.enabled=false',
        '-c',
        'cli_auth_credentials_store="file"',
        '-c',
        'forced_login_method="chatgpt"',
      ] as const;
      const spawnProcess =
        this.#options.spawnProcess ??
        ((input): ChildProcessWithoutNullStreams =>
          spawn(input.executable, input.arguments, {
            cwd: input.cwd,
            env: input.environment,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          }));
      const child = spawnProcess({
        executable: process.execPath,
        arguments: arguments_,
        cwd: runtime,
        environment: { ...process.env, CODEX_HOME: home },
      });
      this.#process = child;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string | Buffer) => {
        const limit = this.#options.stderrLimitBytes ?? 16_384;
        this.#stderr = redactCodexDiagnosticText(`${this.#stderr}${String(chunk)}`).slice(-limit);
      });
      child.once('close', () => {
        if (this.#state === 'stopping' || this.#state === 'stopped') return;
        this.#state = 'failed';
        this.#peer?.close(
          new CodexAppServerError(
            'app_server_process_stopped',
            'The OpenAI connection service stopped unexpectedly.',
            true,
          ),
        );
      });
      this.#peer = new JsonLineAppServerPeer(child.stdout, child.stdin, {
        requestTimeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(this.#options.onNotification === undefined
          ? {}
          : { onNotification: this.#options.onNotification }),
        ...(this.#options.onRequest === undefined ? {} : { onRequest: this.#options.onRequest }),
        onProtocolError: () => {
          this.#state = 'failed';
          if (child.exitCode === null) child.kill('SIGTERM');
        },
      });
      await this.#peer.request(
        'initialize',
        {
          clientInfo: { name: 'noderag', title: 'NodeRag', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        },
        { timeoutMs: this.#options.startupTimeoutMs ?? 15_000 },
      );
      this.#peer.notify('initialized');
      this.#state = 'ready';
      const heartbeatMs = this.#options.heartbeatIntervalMs ?? 60_000;
      if (heartbeatMs >= 1_000) {
        this.#heartbeat = setInterval(() => {
          void this.call('account/read', { refreshToken: false }).catch(() => {
            this.#state = 'failed';
            this.#peer?.close(
              new CodexAppServerError(
                'app_server_heartbeat_failed',
                'The OpenAI connection service heartbeat failed.',
                true,
              ),
            );
            if (child.exitCode === null) child.kill('SIGTERM');
          });
        }, heartbeatMs);
        this.#heartbeat.unref();
      }
    } catch (error) {
      this.#state = 'failed';
      await this.stop();
      throw error;
    }
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!ADMINISTRATION_METHODS.has(method) && !CHAT_METHODS.has(method)) {
      throw new CodexAppServerError(
        'app_server_method_denied',
        'This app-server method is not available to NodeRag.',
      );
    }
    if (this.#state !== 'ready' || this.#peer === null) {
      throw new CodexAppServerError(
        'app_server_unavailable',
        'The OpenAI connection service is not ready.',
        true,
      );
    }
    return this.#peer.request(method, params, signal === undefined ? {} : { signal });
  }

  async readModelCapacities(): Promise<readonly CodexModelCapacityEvidence[]> {
    if (this.#state !== 'ready') {
      throw new CodexAppServerError(
        'app_server_unavailable',
        'The OpenAI connection service is not ready.',
        true,
      );
    }
    const home = await preparePrivateCodexHome(this.#options.credentialHome);
    const executable = await resolveCodexExecutable();
    const runtime = join(home, 'runtime');
    return new Promise((resolveCatalog, rejectCatalog) => {
      const child = spawn(process.execPath, [executable.cliPath, 'debug', 'models'], {
        cwd: runtime,
        env: { ...process.env, CODEX_HOME: home },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let failure: CodexAppServerError | null = null;
      let settled = false;
      const finish = (
        error: CodexAppServerError | null,
        capacities?: readonly CodexModelCapacityEvidence[],
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error !== null) rejectCatalog(error);
        else resolveCatalog(capacities ?? []);
      };
      const timeout = setTimeout(() => {
        failure = new CodexAppServerError(
          'openai_capacity_catalog_timeout',
          'The OpenAI model capacity catalog timed out.',
          true,
        );
        child.kill('SIGTERM');
        finish(failure);
      }, MODEL_CATALOG_TIMEOUT_MS);
      timeout.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string | Buffer) => {
        if (failure !== null) return;
        stdout += String(chunk);
        if (Buffer.byteLength(stdout, 'utf8') > MODEL_CATALOG_MAX_BYTES) {
          stdout = '';
          failure = new CodexAppServerError(
            'openai_capacity_catalog_too_large',
            'The OpenAI model capacity catalog exceeded its safe size limit.',
          );
          child.kill('SIGTERM');
          finish(failure);
        }
      });
      child.stderr.resume();
      child.once('error', () =>
        finish(
          new CodexAppServerError(
            'openai_capacity_catalog_unavailable',
            'The OpenAI model capacity catalog could not be read.',
            true,
          ),
        ),
      );
      child.once('close', (code) => {
        if (failure !== null) return finish(failure);
        if (code !== 0) {
          return finish(
            new CodexAppServerError(
              'openai_capacity_catalog_unavailable',
              'The OpenAI model capacity catalog could not be read.',
              true,
            ),
          );
        }
        try {
          finish(null, parseCodexModelCapacityCatalog(stdout));
        } catch (error) {
          finish(
            error instanceof CodexAppServerError
              ? error
              : new CodexAppServerError(
                  'openai_capacity_catalog_malformed',
                  'The OpenAI model capacity catalog was malformed.',
                ),
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#state = 'stopping';
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const child = this.#process;
    this.#peer?.close();
    this.#peer = null;
    this.#process = null;
    if (child !== null && child.exitCode === null) {
      const closed = new Promise<void>((resolveClosed) =>
        child.once('close', () => resolveClosed()),
      );
      child.stdin.end();
      const forced = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM');
      }, 1_000);
      forced.unref();
      await Promise.race([
        closed,
        new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 2_000);
          timer.unref();
        }),
      ]);
      clearTimeout(forced);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.#state = 'stopped';
  }
}
