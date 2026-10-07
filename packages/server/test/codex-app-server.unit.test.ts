import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerError,
  JsonLineAppServerPeer,
  SupervisedCodexAppServer,
  parseCodexModelCapacityCatalog,
  preparePrivateCodexHome,
  redactCodexDiagnosticText,
} from '../src/chat/codex-app-server.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const protocolHarness = (onNotification?: (method: string) => void) => {
  const serverOutput = new PassThrough();
  const clientOutput = new PassThrough();
  const sent: string[] = [];
  clientOutput.setEncoding('utf8');
  clientOutput.on('data', (chunk) => sent.push(String(chunk)));
  const peer = new JsonLineAppServerPeer(serverOutput, clientOutput, {
    ...(onNotification === undefined
      ? {}
      : { onNotification: (notification) => onNotification(notification.method) }),
  });
  return { peer, serverOutput, sent };
};

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Codex app-server protocol peer', () => {
  it('extracts bounded effective, maximum, and future output capacity fields', () => {
    expect(
      parseCodexModelCapacityCatalog({
        models: [
          {
            slug: 'gpt-capacity',
            context_window: 272_000,
            max_context_window: 1_000_000,
            max_output_tokens: 128_000,
            instructions: 'not retained',
          },
          { slug: 'invalid', context_window: 2_000_000, max_context_window: 1_000_000 },
        ],
      }),
    ).toEqual([
      {
        model: 'gpt-capacity',
        effectiveContextTokens: 272_000,
        maximumContextTokens: 1_000_000,
        maximumOutputTokens: 128_000,
      },
    ]);
  });

  it('rejects an empty or malformed capacity catalog', () => {
    expect(() => parseCodexModelCapacityCatalog('{not-json')).toThrowError(
      expect.objectContaining({ code: 'openai_capacity_catalog_malformed' }),
    );
    expect(() => parseCodexModelCapacityCatalog({ models: [] })).toThrowError(
      expect.objectContaining({ code: 'openai_capacity_catalog_empty' }),
    );
  });

  it('answers only explicitly handled server requests without exposing handler failures', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk) => sent.push(String(chunk)));
    const peer = new JsonLineAppServerPeer(input, output, {
      onRequest: async (request) => {
        expect(request).toMatchObject({ id: 41, method: 'item/tool/call' });
        return { success: true, contentItems: [{ type: 'inputText', text: 'bounded' }] };
      },
    });
    input.write(
      `${JSON.stringify({ id: 41, method: 'item/tool/call', params: { tool: 'research.read_page.v1' } })}\n`,
    );
    await nextTick();
    expect(sent.join('')).toContain(
      JSON.stringify({
        id: 41,
        result: { success: true, contentItems: [{ type: 'inputText', text: 'bounded' }] },
      }),
    );
    peer.close();
  });

  it('reassembles fragmented frames and resolves concurrent requests by bounded numeric ID', async () => {
    const { peer, serverOutput, sent } = protocolHarness();
    const first = peer.request('account/read', { refreshToken: false });
    const second = peer.request('model/list', { limit: 100 });
    await nextTick();
    const requests = sent
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number });
    expect(requests.map(({ id }) => id)).toEqual([1, 2]);
    const responseTwo = JSON.stringify({ id: 2, result: { data: [] } });
    serverOutput.write(responseTwo.slice(0, 7));
    serverOutput.write(`${responseTwo.slice(7)}\n`);
    serverOutput.write(`${JSON.stringify({ id: 1, result: { requiresOpenaiAuth: true } })}\n`);
    await expect(second).resolves.toEqual({ data: [] });
    await expect(first).resolves.toEqual({ requiresOpenaiAuth: true });
    expect(peer.pendingCount).toBe(0);
    peer.close();
  });

  it('delivers notifications in wire order while requests are pending', async () => {
    const notifications: string[] = [];
    const { peer, serverOutput } = protocolHarness((method) => notifications.push(method));
    const pending = peer.request('account/login/start', { type: 'chatgptDeviceCode' });
    serverOutput.write(`${JSON.stringify({ method: 'account/updated', params: {} })}\n`);
    serverOutput.write(
      `${JSON.stringify({ method: 'account/login/completed', params: { success: true } })}\n`,
    );
    serverOutput.write(
      `${JSON.stringify({ id: 1, result: { type: 'chatgptDeviceCode', loginId: 'one', verificationUrl: 'https://example.test', userCode: 'CODE' } })}\n`,
    );
    await pending;
    expect(notifications).toEqual(['account/updated', 'account/login/completed']);
    peer.close();
  });

  it('fails closed on malformed frames and rejects every pending request', async () => {
    const { peer, serverOutput } = protocolHarness();
    const pending = peer.request('account/read', { refreshToken: false });
    serverOutput.write('{not-json}\n');
    await expect(pending).rejects.toMatchObject({ code: 'app_server_malformed_json' });
    await expect(peer.request('account/read', {})).rejects.toMatchObject({
      code: 'app_server_unavailable',
    });
  });

  it('bounds pending capacity, request size, and cancellation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonLineAppServerPeer(input, output, {
      maxPendingRequests: 1,
      maxFrameBytes: 100,
    });
    const first = peer.request('account/read', {});
    await expect(peer.request('account/read', {})).rejects.toMatchObject({
      code: 'app_server_capacity_exceeded',
    });
    input.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    await first;
    await expect(peer.request('model/list', { text: 'x'.repeat(200) })).rejects.toMatchObject({
      code: 'app_server_frame_too_large',
    });
    const controller = new AbortController();
    const cancelled = peer.request('account/read', {}, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'app_server_request_cancelled' });
    peer.close();
  });
});

describe('Codex app-server supervision security', () => {
  it('redacts tokens and key-shaped diagnostics', () => {
    const text = redactCodexDiagnosticText(
      'Authorization: Bearer secret-token {"access_token":"abc","refresh_token":"def"} eyJabcdefghijk.abcdefghijk.signature sk-abcdefghijklmnop',
    );
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('"abc"');
    expect(text).not.toContain('"def"');
    expect(text).not.toContain('eyJabcdefghijk');
    expect(text).not.toContain('sk-abcdefghijklmnop');
  });

  it('creates a private, non-symbolic credential home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-codex-home-test-'));
    temporaryRoots.push(root);
    const home = join(root, 'private');
    await preparePrivateCodexHome(home);
    expect((await lstat(home)).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect((await lstat(home)).mode & 0o777).toBe(0o700);

    const target = join(root, 'target');
    const unsafe = join(root, 'unsafe');
    await preparePrivateCodexHome(target);
    await symlink(target, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preparePrivateCodexHome(unsafe)).rejects.toBeInstanceOf(CodexAppServerError);
  });

  it('initializes under the isolated home and permits only the Chat allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-codex-supervisor-test-'));
    temporaryRoots.push(root);
    const serverOutputs: PassThrough[] = [];
    let environment: NodeJS.ProcessEnv | undefined;
    const supervisor = new SupervisedCodexAppServer({
      credentialHome: join(root, 'home'),
      heartbeatIntervalMs: 0,
      spawnProcess: (input) => {
        environment = input.environment;
        const child = new EventEmitter() as EventEmitter & {
          stdin: PassThrough;
          stdout: PassThrough;
          stderr: PassThrough;
          exitCode: number | null;
          kill: (signal?: NodeJS.Signals) => boolean;
        };
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.kill = () => {
          child.exitCode = 0;
          child.emit('close', 0);
          return true;
        };
        child.stdin.setEncoding('utf8');
        child.stdin.on('data', (chunk) => {
          for (const line of String(chunk).trim().split('\n')) {
            if (line.length === 0) continue;
            const message = JSON.parse(line) as { id?: number; method: string };
            if (message.method === 'initialize' && message.id !== undefined) {
              child.stdout.write(
                `${JSON.stringify({ id: message.id, result: { platformOs: 'test' } })}\n`,
              );
            } else if (message.method === 'thread/start' && message.id !== undefined) {
              child.stdout.write(
                `${JSON.stringify({ id: message.id, result: { thread: { id: 'safe-thread' } } })}\n`,
              );
            }
          }
        });
        serverOutputs.push(child.stdout);
        return child as never;
      },
    });
    await supervisor.start();
    expect(environment?.['CODEX_HOME']).toBe(join(root, 'home'));
    await expect(supervisor.call('thread/start', {})).resolves.toEqual({
      thread: { id: 'safe-thread' },
    });
    await expect(supervisor.call('command/exec', {})).rejects.toMatchObject({
      code: 'app_server_method_denied',
    });
    await expect(supervisor.call('web/search', {})).rejects.toMatchObject({
      code: 'app_server_method_denied',
    });
    expect(serverOutputs).toHaveLength(1);
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
  });
});
