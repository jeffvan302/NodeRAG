import { spawnSync } from 'node:child_process';

const npmExecPath = process.env['npm_execpath'];
const command = npmExecPath === undefined ? 'corepack' : process.execPath;
const args =
  npmExecPath === undefined
    ? ['pnpm@11.25.0', 'licenses', 'list', '--prod', '--json']
    : [npmExecPath, 'licenses', 'list', '--prod', '--json'];
const result = spawnSync(command, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'pnpm license inventory failed');
const inventory = JSON.parse(result.stdout);
const approved = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'PostgreSQL',
  'Python-2.0',
]);
const licenses = Object.keys(inventory);
const blocked = licenses.filter((license) => !approved.has(license));
if (blocked.length > 0) {
  throw new Error(`Unapproved runtime licenses: ${blocked.join(', ')}`);
}
console.info(`Runtime license inventory passed for ${licenses.length} license classes.`);
