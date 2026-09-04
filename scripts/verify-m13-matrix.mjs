import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve('platform/m13-fault-security-matrix.json');
const matrix = JSON.parse(await readFile(path, 'utf8'));
if (matrix.version !== 1 || matrix.milestone !== 'M13' || matrix.unknownPolicy !== 'fail')
  throw new Error('M13 fault/security matrix identity is invalid.');
if (!Array.isArray(matrix.cases) || matrix.cases.length !== 18)
  throw new Error('M13 fault/security matrix must contain exactly 18 required cases.');
const identifiers = new Set();
for (const entry of matrix.cases) {
  if (!/^M13-FS-\d{3}$/.test(entry.id) || identifiers.has(entry.id))
    throw new Error(`Invalid or duplicate M13 matrix ID: ${entry.id}`);
  identifiers.add(entry.id);
  if (!['automated', 'automated-with-dsm-repeat'].includes(entry.gate))
    throw new Error(`M13 matrix case ${entry.id} has no executable gate.`);
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0)
    throw new Error(`M13 matrix case ${entry.id} has no evidence.`);
  for (const evidence of entry.evidence) await access(resolve(evidence));
}
if (JSON.stringify(matrix.dsmRepeat) !== JSON.stringify(['DSM-013', 'DSM-016', 'DSM-024']))
  throw new Error('M13 DSM repeat register is incomplete.');
console.info(`Verified ${matrix.cases.length} M13 fault/security matrix cases and evidence paths.`);
