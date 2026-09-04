import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const manifestPath = path.join(root, 'fixtures/evaluation/m12/corpus-manifest.json');
const goldenPath = path.join(root, 'fixtures/evaluation/m12/golden-set.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
const failures = [];
const requireValue = (condition, message) => {
  if (!condition) failures.push(message);
};

requireValue(manifest.version === 1, 'corpus manifest version must be 1');
requireValue(golden.version === 2, 'golden-set version must be 2');
requireValue(golden.synthetic === false, 'golden-set must be explicitly non-synthetic');
requireValue(
  golden.cases.length >= 50 && golden.cases.length <= 100,
  'golden-set must contain 50-100 cases',
);

const manifestDocuments = new Map(manifest.documents.map((document) => [document.path, document]));
const formats = new Set();
const silos = new Set();
const queryClasses = new Set();
const ids = new Set();
let hasCrossPage = false;
let hasSheetLocator = false;
let hasVisionLocator = false;
let hasUnicode = false;

for (const document of manifest.documents) {
  const absolutePath = path.join(root, 'fixtures/evaluation/m12', document.path);
  const bytes = await readFile(absolutePath);
  const details = await stat(absolutePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  requireValue(
    details.size === document.bytes,
    `${document.path}: byte count differs from manifest`,
  );
  requireValue(digest === document.sha256, `${document.path}: SHA-256 differs from manifest`);
  requireValue(
    ['md', 'txt', 'docx', 'pdf', 'xlsx'].includes(document.format),
    `${document.path}: unsupported format`,
  );
}

for (const testCase of golden.cases) {
  requireValue(
    typeof testCase.id === 'string' && testCase.id.length > 0,
    'every case must have an id',
  );
  requireValue(!ids.has(testCase.id), `${testCase.id}: duplicate case id`);
  ids.add(testCase.id);
  requireValue(
    testCase.answerable === true,
    `${testCase.id}: release corpus cases must be answerable`,
  );
  requireValue(
    typeof testCase.query === 'string' && testCase.query.trim().length > 0,
    `${testCase.id}: query is empty`,
  );
  requireValue(
    Array.isArray(testCase.relevant) && testCase.relevant.length > 0,
    `${testCase.id}: no relevant documents`,
  );
  formats.add(testCase.expectedFormat);
  silos.add(testCase.silo);
  queryClasses.add(testCase.queryClass);
  hasUnicode ||= [...testCase.query].some((character) => (character.codePointAt(0) ?? 0) > 127);

  for (const expected of testCase.relevant ?? []) {
    const document = manifestDocuments.get(expected.document);
    requireValue(
      Boolean(document),
      `${testCase.id}: relevant document is not in the corpus manifest`,
    );
    if (!document) continue;
    requireValue(
      expected.sha256 === document.sha256,
      `${testCase.id}: relevant document hash is not pinned`,
    );
    requireValue(
      testCase.expectedFormat === document.format,
      `${testCase.id}: expectedFormat disagrees with document`,
    );
    requireValue(testCase.silo === document.silo, `${testCase.id}: silo disagrees with document`);
    requireValue(
      !(expected.pages && expected.sheets),
      `${testCase.id}: relevance cannot use pages and sheets together`,
    );

    if (expected.pages) {
      const uniquePages = new Set(expected.pages);
      requireValue(
        uniquePages.size === expected.pages.length,
        `${testCase.id}: duplicate page locator`,
      );
      requireValue(
        expected.pages.every(
          (page) => Number.isInteger(page) && page >= 1 && page <= document.pages,
        ),
        `${testCase.id}: invalid one-based page locator`,
      );
      hasCrossPage ||= expected.pages.length > 1;
      hasVisionLocator ||= expected.pages.some((page) => document.visionPages?.includes(page));
    }
    if (expected.sheets) {
      const uniqueSheets = new Set(expected.sheets);
      requireValue(
        uniqueSheets.size === expected.sheets.length,
        `${testCase.id}: duplicate sheet locator`,
      );
      requireValue(
        expected.sheets.every((sheet) => document.sheets?.includes(sheet)),
        `${testCase.id}: invalid exact sheet locator`,
      );
      hasSheetLocator = true;
    }
  }
}

for (const expectedFormat of ['md', 'txt', 'docx', 'pdf', 'xlsx']) {
  requireValue(formats.has(expectedFormat), `format coverage missing: ${expectedFormat}`);
}
for (const silo of manifest.silos.map(({ slug }) => slug)) {
  requireValue(silos.has(silo), `silo coverage missing: ${silo}`);
}
for (const queryClass of [
  'semantic',
  'exact_identifier',
  'exact_name',
  'error_code',
  'quoted_phrase',
  'cross_page',
  'table',
  'vision',
  'multilingual',
  'unicode',
]) {
  requireValue(queryClasses.has(queryClass), `query-class coverage missing: ${queryClass}`);
}
requireValue(hasCrossPage, 'no case pins relevance across multiple pages');
requireValue(hasSheetLocator, 'no case pins an exact XLSX sheet');
requireValue(hasVisionLocator, 'no case targets a raster-only vision page');
requireValue(hasUnicode, 'no query exercises non-ASCII Unicode');

if (failures.length > 0) {
  console.error(`M12 corpus validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.info(
    JSON.stringify(
      {
        status: 'passed',
        corpus: manifest.id,
        goldenSet: golden.id,
        cases: golden.cases.length,
        documents: manifest.documents.length,
        formats: [...formats].sort(),
        silos: [...silos].sort(),
        queryClasses: [...queryClasses].sort(),
      },
      null,
      2,
    ),
  );
}
