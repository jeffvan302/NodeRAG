import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const outputDirectory = path.resolve(repositoryRoot, 'fixtures', 'evaluation', 'm12', 'corpus');
const previewDirectory = path.resolve(
  repositoryRoot,
  'runtime-data',
  'm12-artifacts',
  'xlsx-preview',
);
await fs.mkdir(outputDirectory, { recursive: true });
await fs.mkdir(previewDirectory, { recursive: true });

const workbook = Workbook.create();
const quality = workbook.worksheets.add('Quality Thresholds');
const candidates = workbook.worksheets.add('Candidate Matrix');
const unicode = workbook.worksheets.add('Unicode Cases');
const font = 'Arial';
const navy = '#1F4E78';
const paleBlue = '#EEF3F8';
const border = '#D9D9D9';

const styleSheet = (sheet, titleRange, tableRange) => {
  sheet.showGridLines = false;
  sheet.getUsedRange().format.font = { name: font, size: 10 };
  sheet.getRange(titleRange).format.font = { name: font, size: 16, bold: true, color: '#000000' };
  sheet.getRange(tableRange).format.borders = { preset: 'all', style: 'thin', color: border };
};

quality.getRange('A1').values = [['NodeRag quality thresholds']];
quality.getRange('A2').values = [['Approved Milestone 12 release gates from the project plan']];
quality.getRange('A4:D4').values = [['Metric', 'Threshold', 'Unit', 'Scope']];
quality.getRange('A5:D13').values = [
  ['Cross-silo leakage', 0, 'count', 'All returned hits'],
  ['Locator mismatches', 0, 'count', 'Relevant document hits'],
  ['Overall Recall at 10', 0.85, 'ratio', 'Answerable cases'],
  ['Format Recall at 10', 0.8, 'ratio', 'Each supported format'],
  ['Zero-result rate', 0.05, 'maximum ratio', 'Answerable cases'],
  ['Idle search p95', 3000, 'milliseconds', 'Recorded Docker envelope'],
  ['Active ingest search p95', 5000, 'milliseconds', 'Recorded Docker envelope'],
  ['Maximum Recall regression', 0.01, 'absolute ratio', 'Overall and major formats'],
  ['Maximum chunk RLS overhead', 0.15, 'ratio', 'p95 with correct plans'],
];
quality.getRange('A4:D4').format = {
  fill: navy,
  font: { name: font, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
};
quality.getRange('B7:B9').format.numberFormat = '0.0%';
quality.getRange('B12:B13').format.numberFormat = '0.0%';
quality.getRange('A5:D13').format.wrapText = true;
quality.getRange('A5:D13').format.verticalAlignment = 'center';
quality.getRange('A5:D13').conditionalFormats.addCustom('=MOD(ROW(),2)=0', { fill: paleBlue });
quality.getRange('A1:D13').format.autofitColumns();
quality.getRange('A1:D13').format.autofitRows();
quality.getRange('A:A').format.columnWidth = 28;
quality.getRange('D:D').format.columnWidth = 32;
quality.freezePanes.freezeRows(4);
styleSheet(quality, 'A1:D1', 'A4:D13');

candidates.getRange('A1').values = [['NodeRag candidate settings matrix']];
candidates.getRange('A2').values = [
  ['Configurations that every repeatable evaluation run compares'],
];
candidates.getRange('A4:I4').values = [
  [
    'Candidate',
    'Search mode',
    'Quantization',
    'Target characters',
    'Overlap characters',
    'Heading prefix',
    'EF search',
    'Session plan',
    'Decision rule',
  ],
];
candidates.getRange('A5:I13').values = [
  ['C01', 'vector', 'q8', 1200, 200, true, 50, 'shared', 'Quality and latency thresholds'],
  ['C02', 'vector', 'q8', 2000, 300, true, 100, 'shared', 'Initial release reference'],
  ['C03', 'vector', 'q8', 3000, 400, true, 200, 'shared', 'Quality and latency thresholds'],
  ['C04', 'vector', 'q8', 2000, 300, false, 100, 'shared', 'Measure heading-prefix effect'],
  ['C05', 'keyword', 'none', 2000, 300, true, 100, 'shared', 'Exact-query reference'],
  [
    'C06',
    'hybrid',
    'q8',
    2000,
    300,
    true,
    100,
    'shared',
    'Gain at least 0.02 Recall; p95 at most 2 times',
  ],
  [
    'C07',
    'vector',
    'q4',
    2000,
    300,
    true,
    100,
    'shared',
    'At least 1.5 times faster; Recall loss at most 0.01',
  ],
  [
    'C08',
    'vector',
    'q8',
    2000,
    300,
    true,
    100,
    'query and ingest',
    'Use only if memory permits and active p95 improves',
  ],
  [
    'C09',
    'vector',
    'q8',
    2000,
    300,
    true,
    100,
    'shared with chunk RLS',
    'RLS overhead at most 15 percent',
  ],
];
candidates.getRange('A4:I4').format = {
  fill: navy,
  font: { name: font, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
};
candidates.getRange('A5:I13').format.wrapText = true;
candidates.getRange('A5:I13').format.verticalAlignment = 'center';
candidates.getRange('A5:I13').conditionalFormats.addCustom('=MOD(ROW(),2)=0', { fill: paleBlue });
candidates.getRange('A1:I13').format.autofitColumns();
candidates.getRange('A1:I13').format.autofitRows();
candidates.getRange('A:A').format.columnWidth = 12;
candidates.getRange('B:C').format.columnWidth = 15;
candidates.getRange('H:H').format.columnWidth = 22;
candidates.getRange('I:I').format.columnWidth = 43;
candidates.freezePanes.freezeRows(4);
styleSheet(candidates, 'A1:I1', 'A4:I13');

unicode.getRange('A1').values = [['NodeRag Unicode retrieval cases']];
unicode.getRange('A2').values = [
  ['Real project phrases used to verify NFC normalization and multilingual search'],
];
unicode.getRange('A4:D4').values = [['Case', 'Language', 'Stored phrase', 'Expected behavior']];
unicode.getRange('A5:D10').values = [
  ['UNI-001', 'French', 'café', 'NFC and NFD queries retrieve the same document'],
  [
    'UNI-002',
    'Afrikaans',
    'plaaslike kennis bly op die NAS',
    'Accented and plain Latin text remains searchable',
  ],
  [
    'UNI-003',
    'Japanese',
    'ローカル検索は文書の境界を守ります。',
    'CJK text survives ingestion and retrieval',
  ],
  [
    'UNI-004',
    'Arabic',
    'البحث المحلي يحمي حدود المستندات',
    'Right-to-left text survives extraction',
  ],
  ['UNI-005', 'Korean', '로컬 검색은 문서 경계를 보호합니다.', 'Hangul text remains normalized'],
  ['UNI-006', 'Emoji', 'storage check ✅', 'Supplementary Unicode does not break UTF-16 locators'],
];
unicode.getRange('A4:D4').format = {
  fill: navy,
  font: { name: font, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
};
unicode.getRange('A5:D10').format.wrapText = true;
unicode.getRange('A5:D10').format.verticalAlignment = 'center';
unicode.getRange('A5:D10').conditionalFormats.addCustom('=MOD(ROW(),2)=0', { fill: paleBlue });
unicode.getRange('A1:D10').format.autofitColumns();
unicode.getRange('A1:D10').format.autofitRows();
unicode.getRange('C:C').format.columnWidth = 42;
unicode.getRange('D:D').format.columnWidth = 45;
unicode.freezePanes.freezeRows(4);
styleSheet(unicode, 'A1:D1', 'A4:D10');

for (const sheetName of ['Quality Thresholds', 'Candidate Matrix', 'Unicode Cases']) {
  const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.5, format: 'png' });
  await fs.writeFile(
    path.resolve(previewDirectory, `${sheetName.toLowerCase().replaceAll(' ', '-')}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const inspection = await workbook.inspect({
  kind: 'table',
  range: 'Quality Thresholds!A1:D13',
  include: 'values,formulas',
  tableMaxRows: 20,
  tableMaxCols: 12,
});
console.info(inspection.ndjson);
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 300 },
  summary: 'final formula error scan',
});
console.info(errors.ndjson);

const output = await SpreadsheetFile.exportXlsx(workbook);
const target = path.resolve(outputDirectory, 'evaluation-matrix.xlsx');
await output.save(target);
console.info(target);
