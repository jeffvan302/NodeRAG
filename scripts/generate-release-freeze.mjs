import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const metadataPath = resolve(root, 'platform/release-candidate.v1.json');
const outputPath = resolve(root, 'platform/release-freeze.v1.json');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const migrations = JSON.parse(
  await readFile(resolve(root, 'platform/migration-checksums.v1.json'), 'utf8'),
);
const parserRevisions = JSON.parse(await readFile(resolve(root, metadata.parserRevisions), 'utf8'));
const openApi = JSON.parse(await readFile(resolve(root, metadata.openApi), 'utf8'));
const info = await readFile(resolve(root, 'spk/noderag/INFO'), 'utf8');
if (packageJson.version !== metadata.releaseVersion) throw new Error('release-version-mismatch');
if (migrations.expectedHead !== metadata.migrationHead) throw new Error('migration-head-mismatch');
if (openApi.info?.version !== metadata.releaseVersion) throw new Error('openapi-version-mismatch');
if (!info.includes(`version="${metadata.spkPackageVersion}"`))
  throw new Error('spk-version-mismatch');
if (!info.includes('beta="yes"')) throw new Error('spk-prerelease-marker-missing');

const freezePaths = [
  ...new Set([
    ...metadata.freezeInputs,
    ...migrations.migrations.map(({ path }) => path),
    ...parserRevisions.sources,
  ]),
].sort();
const inputs = [];
for (const path of freezePaths) {
  const bytes = await readFile(resolve(root, path));
  inputs.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const aggregateSha256 = sha256(
  Buffer.from(inputs.map(({ path, sha256: digest }) => `${path}\0${digest}\n`).join(''), 'utf8'),
);
const document = {
  schemaVersion: 1,
  releaseVersion: metadata.releaseVersion,
  spkPackageVersion: metadata.spkPackageVersion,
  artifactName: metadata.artifactName,
  migrationHead: metadata.migrationHead,
  inputCount: inputs.length,
  aggregateSha256,
  inputs,
};
const rendered = await format(JSON.stringify(document), {
  ...(await resolveConfig(outputPath)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error('platform/release-freeze.v1.json is out of date; run pnpm release:freeze');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
}
