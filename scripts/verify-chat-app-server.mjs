import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const requireFromServer = createRequire(
  new URL('../packages/server/package.json', import.meta.url),
);
const packageJsonPath =
  process.env['NODERAG_CHAT_SMOKE_CODEX_PACKAGE'] === undefined
    ? requireFromServer.resolve('@openai/codex/package.json')
    : resolve(process.env['NODERAG_CHAT_SMOKE_CODEX_PACKAGE']);
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (packageJson.version !== '0.147.0') {
  throw new Error(`Unexpected @openai/codex version: ${String(packageJson.version)}`);
}

const cliPath = join(dirname(packageJsonPath), 'bin', 'codex.js');
const isolatedCredentialRoot = await mkdtemp(join(tmpdir(), 'noderag-chat-appserver-'));
if (!isolatedCredentialRoot.startsWith(join(tmpdir(), 'noderag-chat-appserver-'))) {
  throw new Error('Unexpected app-server test directory.');
}
const child = spawn(
  process.execPath,
  [
    cliPath,
    'app-server',
    '--stdio',
    '--strict-config',
    '-c',
    'analytics.enabled=false',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'forced_login_method="chatgpt"',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: isolatedCredentialRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${String(chunk)}`.slice(-8_000);
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== 'object' || !('id' in message)) return;
  const handler = pending.get(String(message.id));
  if (handler === undefined) return;
  pending.delete(String(message.id));
  if ('error' in message) handler.reject(new Error(`app-server request failed: ${message.id}`));
  else handler.resolve(message.result);
});

const request = (id, method, params) =>
  new Promise((resolve, reject) => {
    pending.set(String(id), { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out.`)), 15_000).unref();
    }),
  ]);

try {
  const initialized = await withTimeout(
    request(1, 'initialize', {
      clientInfo: { name: 'noderag-chat-feasibility', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }),
    'initialize',
  );
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const account = await withTimeout(
    request(2, 'account/read', { refreshToken: false }),
    'account/read',
  );
  const models = await withTimeout(
    request(3, 'model/list', { cursor: null, includeHidden: false, limit: 1 }),
    'model/list',
  );
  const firstModel = Array.isArray(models?.data) ? models.data[0] : undefined;
  const supportedReasoningEfforts = Array.isArray(firstModel?.supportedReasoningEfforts)
    ? firstModel.supportedReasoningEfforts
    : null;
  if (
    initialized === null ||
    typeof initialized !== 'object' ||
    !('platformOs' in initialized) ||
    account === null ||
    typeof account !== 'object' ||
    typeof account.requiresOpenaiAuth !== 'boolean' ||
    models === null ||
    typeof models !== 'object' ||
    !Array.isArray(models.data) ||
    firstModel === undefined ||
    supportedReasoningEfforts === null ||
    supportedReasoningEfforts.some(
      (effort) =>
        effort === null || typeof effort !== 'object' || typeof effort.reasoningEffort !== 'string',
    )
  ) {
    throw new Error('app-server returned an invalid feasibility response.');
  }
  console.info(
    JSON.stringify({
      package: '@openai/codex',
      version: packageJson.version,
      platformOs: initialized.platformOs,
      platformFamily: initialized.platformFamily,
      initialized: true,
      unauthenticatedStatusRead: true,
      boundedModelCatalogRead: true,
      modelCatalogPageSize: models.data.length,
      liveReasoningEffortCount: supportedReasoningEfforts.length,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      isolatedCredentialStore: true,
      forcedLoginMethod: 'chatgpt',
      analyticsEnabled: false,
    }),
  );
} catch (error) {
  if (stderr.trim().length > 0) console.error(stderr.trim());
  throw error;
} finally {
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdin.end();
  const gracefulTimeout = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  }, 1_000);
  await closed;
  clearTimeout(gracefulTimeout);
  lines.close();
  await rm(isolatedCredentialRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
