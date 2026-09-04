import { spawn } from 'node:child_process';

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const commands = [
  ['--filter', '@noderag/server', 'dev:api'],
  ['--filter', '@noderag/server', 'dev:worker'],
  ['--filter', '@noderag/ui', 'dev'],
];
const children = commands.map((args) =>
  spawn(corepack, ['pnpm@11.25.0', ...args], {
    env: process.env,
    shell: false,
    stdio: 'inherit',
  }),
);

const stop = (signal) => {
  for (const child of children) child.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

const exitCode = await Promise.race(
  children.map(
    (child) =>
      new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolveExit(code ?? 1));
      }),
  ),
);
stop('SIGTERM');
process.exitCode = exitCode;
