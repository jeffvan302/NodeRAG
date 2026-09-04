import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = 18787;
const child = spawn(process.execPath, [resolve(root, 'packages/server/dist/server.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    NODERAG_HOST: '127.0.0.1',
    NODERAG_PORT: String(port),
    NODERAG_UI_ROOT: resolve(root, 'packages/server/dist/ui'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const fetchPath = (path) =>
  new Promise((resolveResponse, reject) => {
    const call = request({ host: '127.0.0.1', port, path, timeout: 1_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolveResponse({ body, status: response.statusCode }));
    });
    call.on('timeout', () => call.destroy(new Error('request timeout')));
    call.on('error', reject);
    call.end();
  });

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetchPath('/health');
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  if (health?.status !== 200 || !health.body.includes('"status":"ok"')) {
    throw new Error(`Built server health failed: ${JSON.stringify(health)}`);
  }
  const ui = await fetchPath('/');
  if (ui.status !== 200 || !ui.body.includes('<title>NodeRag')) {
    throw new Error('Built server did not serve the compiled UI.');
  }
  console.info('Built Fastify server and Preact UI smoke test passed.');
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
}
