import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import prettier from 'prettier';

const check = process.argv.includes('--check');
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
const dependencies = [];
for (const [license, entries] of Object.entries(inventory)) {
  for (const entry of entries) {
    for (const version of entry.versions) {
      dependencies.push({
        name: entry.name,
        version,
        license,
        homepage: entry.homepage,
      });
    }
  }
}
const unique = [
  ...new Map(
    dependencies.map((dependency) => [
      `${dependency.name}\0${dependency.version}\0${dependency.license}`,
      dependency,
    ]),
  ).values(),
].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
if (unique.length < 50) throw new Error('SBOM runtime dependency inventory is unexpectedly small.');

const spdxId = (dependency) =>
  `SPDXRef-Package-${createHash('sha256')
    .update(`${dependency.name}@${dependency.version}`, 'utf8')
    .digest('hex')
    .slice(0, 20)}`;
const lockDigest = createHash('sha256')
  .update(await readFile(resolve('pnpm-lock.yaml')))
  .digest('hex');
const packages = unique.map((dependency) => ({
  name: dependency.name,
  SPDXID: spdxId(dependency),
  versionInfo: dependency.version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: dependency.license,
  licenseDeclared: dependency.license,
  copyrightText: 'NOASSERTION',
  ...(typeof dependency.homepage === 'string' ? { homepage: dependency.homepage } : {}),
  externalRefs: [
    {
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: `pkg:npm/${encodeURIComponent(dependency.name)}@${dependency.version}`,
    },
  ],
}));
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'NodeRag-runtime-dependencies',
  documentNamespace: `https://noderag.local/sbom/${lockDigest}`,
  creationInfo: {
    created: '2026-09-04T00:00:00Z',
    creators: ['Tool: NodeRag scripts/generate-sbom.mjs'],
  },
  documentDescribes: packages.map((item) => item.SPDXID),
  packages,
  relationships: packages.map((item) => ({
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: item.SPDXID,
  })),
};
const sbomText = await prettier.format(JSON.stringify(sbom), { parser: 'json' });

const grouped = new Map();
for (const dependency of unique) {
  const values = grouped.get(dependency.license) ?? [];
  values.push(`\`${dependency.name}@${dependency.version}\``);
  grouped.set(dependency.license, values);
}
const notices = await prettier.format(
  `# Third-Party Notices

Generated from the exact production dependency graph locked by
\`pnpm-lock.yaml\`. The machine-readable companion is
\`platform/sbom.spdx.json\` (SPDX 2.3; lock digest \`${lockDigest}\`).

| Declared license | Locked runtime packages |
| --- | --- |
${[...grouped.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, values]) => `| ${license} | ${values.join(', ')} |`)
  .join('\n')}

## Non-npm runtime components

- PostgreSQL 17 and pgvector are distributed under the PostgreSQL License.
- ONNX Runtime is distributed under the MIT License.
- Qwen3-Embedding-0.6B model and tokenizer artifacts are distributed under Apache-2.0.
- The pinned Node.js runtime is distributed under its upstream permissive license terms.

All runtime licenses must remain allowed by \`LICENSE-POLICY.md\`. Unknown,
copyleft, source-available, or custom terms block a release until reviewed and
documented. Regenerate this file and the SBOM after every lockfile or bundled
runtime change.
`,
  { parser: 'markdown' },
);

const outputs = [
  [resolve('platform/sbom.spdx.json'), sbomText],
  [resolve('THIRD-PARTY.md'), notices],
];
for (const [path, content] of outputs) {
  if (check) {
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing !== content) throw new Error(`${path} is stale; run pnpm sbom:generate.`);
  } else {
    await writeFile(path, content, 'utf8');
  }
}
console.info(`Generated SPDX SBOM and notices for ${unique.length} locked runtime packages.`);
