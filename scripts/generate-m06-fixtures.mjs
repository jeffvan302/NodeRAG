import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const formats = resolve(root, 'fixtures/formats');
const serverRequire = createRequire(resolve(root, 'packages/server/package.json'));
const iconv = serverRequire('iconv-lite');

const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const save = async (relative, bytes) => {
  const path = resolve(formats, relative);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, bytes);
};

const zip = (entries) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
          name,
          value instanceof Uint8Array ? value : strToU8(value),
        ]),
      ),
      { level: 6, mtime: new Date('1980-01-02T00:00:00.000Z') },
    ),
  );

const pdf = (lines) => {
  const stream = lines
    .map(
      ({ x = 72, y, text }) =>
        `BT /F1 12 Tf ${String(x)} ${String(y)} Td (${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`,
    )
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'ascii'))} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let output = '%PDF-1.4\n%NodeRag synthetic fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer << /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
};

const layoutPdf = (pages) => {
  const escapedPdfText = (value) =>
    String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const pageReferences = pages.map((_, index) => 3 + index * 2);
  const fontStart = 3 + pages.length * 2;
  const fontReferences = { F1: fontStart, F2: fontStart + 1, F3: fontStart + 2 };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.map((reference) => `${String(reference)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`,
  ];
  for (const [index, page] of pages.entries()) {
    const pageReference = pageReferences[index];
    if (pageReference === undefined) throw new Error('layout-page-reference-missing');
    const contentReference = pageReference + 1;
    const stream = [
      ...(page.commands ?? []),
      ...page.lines.map(
        ({ x = 72, y, text, font = 'F1', size = 12 }) =>
          `BT /${font} ${String(size)} Tf ${String(x)} ${String(y)} Td (${escapedPdfText(text)}) Tj ET`,
      ),
    ].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(fontReferences.F1)} 0 R /F2 ${String(fontReferences.F2)} 0 R /F3 ${String(fontReferences.F3)} 0 R >> >> /Contents ${String(contentReference)} 0 R >>`,
      `<< /Length ${String(Buffer.byteLength(stream, 'ascii'))} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
  );
  let output = '%PDF-1.4\n%NodeRag synthetic layout fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer << /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
};

const documentContentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const rootRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const wrapDocument = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;

const paragraph = (text, style = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${xml(text)}</w:t></w:r></w:p>`;

const docx = (body, extras = {}) =>
  zip({
    '[Content_Types].xml': documentContentTypes,
    '_rels/.rels': rootRelationships,
    'word/document.xml': wrapDocument(body),
    ...extras,
  });

const xlsxContentTypes = (sheetCount) => `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

const columnName = (number) => {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
};

const cellXml = (cell, row, column) => {
  const reference = `${columnName(column)}${String(row)}`;
  if (cell === null || cell === undefined || cell === '') return '';
  if (typeof cell === 'object' && 'formula' in cell) {
    const cached = cell.cached === undefined ? '' : `<v>${xml(cell.cached)}</v>`;
    return `<c r="${reference}"${cell.style ? ` s="${String(cell.style)}"` : ''}><f>${xml(cell.formula)}</f>${cached}</c>`;
  }
  if (typeof cell === 'object' && 'number' in cell) {
    return `<c r="${reference}" s="${String(cell.style ?? 0)}" t="n"><v>${String(cell.number)}</v></c>`;
  }
  if (typeof cell === 'boolean') {
    return `<c r="${reference}" t="b"><v>${cell ? '1' : '0'}</v></c>`;
  }
  if (typeof cell === 'number') return `<c r="${reference}" t="n"><v>${String(cell)}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t>${xml(cell)}</t></is></c>`;
};

const sheetXml = (rows, merges = []) => `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rows
    .map(
      (row, rowIndex) =>
        `<row r="${String(rowIndex + 1)}">${row.map((cell, column) => cellXml(cell, rowIndex + 1, column + 1)).join('')}</row>`,
    )
    .join('')}</sheetData>
  ${merges.length > 0 ? `<mergeCells count="${String(merges.length)}">${merges.map((range) => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>` : ''}
</worksheet>`;

const xlsx = (sheets) => {
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.map(({ name }, index) => `<sheet name="${xml(name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join('')}</sheets>
</workbook>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <numFmts count="2"><numFmt numFmtId="200" formatCode="yyyy-mm-dd"/><numFmt numFmtId="201" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
 <fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>
 <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
 <borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
 <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="200" applyNumberFormat="1"/><xf numFmtId="201" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;
  return zip({
    '[Content_Types].xml': xlsxContentTypes(sheets.length),
    '_rels/.rels': rootRelationships.replace('word/document.xml', 'xl/workbook.xml'),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': relationships,
    'xl/styles.xml': styles,
    ...Object.fromEntries(
      sheets.map(({ rows, merges = [] }, index) => [
        `xl/worksheets/sheet${String(index + 1)}.xml`,
        sheetXml(rows, merges),
      ]),
    ),
  });
};

await save(
  'txt/utf8.txt',
  Buffer.from('UTF-8 maintenance notes\n\nPump 😀 is operational.\n', 'utf8'),
);
await save(
  'txt/utf16-no-bom.txt',
  Buffer.from('BOM-less UTF-16 maintenance\r\n\r\nSecond paragraph.\r\n', 'utf16le'),
);
await save('txt/shift-jis.txt', iconv.encode('設備保全\r\n\r\nポンプ点検\r\n', 'shift_jis'));
await save(
  'md/structure.md',
  Buffer.from('# Structure\n\n- first\n- second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'),
);
await save('md/nfd-accents.md', Buffer.from('# Cafe\u0301\n\nRe\u0301sume\u0301 normalization.\n'));
await save('md/astral-rtl.md', Buffer.from('# Astral and RTL 😀\n\nمرحبا بالعالم\n'));

await save(
  'pdf/ligatures.pdf',
  pdf([
    { y: 720, text: 'Ligature reading fixture' },
    { y: 695, text: 'office flower efficient waffle' },
  ]),
);
await save(
  'pdf/hyphenated.pdf',
  pdf([
    { y: 720, text: 'Conservative hyphenation' },
    { y: 695, text: 'The electro-' },
    { y: 680, text: 'mechanical pump remains operational.' },
  ]),
);
await save('pdf/no-tounicode.pdf', await readFile(resolve(formats, 'pdf/scanned.pdf')));
await save(
  'pdf/layout-headings.pdf',
  layoutPdf([
    {
      lines: [
        { y: 742, text: 'Annual Financial Report', font: 'F2', size: 24 },
        { y: 700, text: 'Revenue sources', font: 'F2', size: 18 },
        { y: 676, text: 'Revenue increased during the reporting period.' },
        { y: 638, text: 'Tax revenue', font: 'F2', size: 14 },
        { y: 615, text: 'Personal and corporate tax remain the primary sources.' },
      ],
    },
  ]),
);
await save(
  'pdf/legal-lists.pdf',
  layoutPdf([
    {
      lines: [
        { y: 742, text: '1. Revenue', font: 'F2', size: 18 },
        { y: 710, text: '1.1 Tax revenue', font: 'F2', size: 14 },
        { y: 685, text: 'The authority collects the following revenue sources:' },
        { x: 90, y: 660, text: '1. Personal income tax' },
        { x: 90, y: 638, text: '2. Corporate income tax' },
        { x: 108, y: 616, text: '- Assessed monthly' },
        { x: 108, y: 594, text: '- Reconciled annually' },
      ],
    },
  ]),
);
await save(
  'pdf/three-column.pdf',
  layoutPdf([
    {
      lines: [
        { y: 750, text: 'Three-column operating summary', font: 'F2', size: 18 },
        { x: 54, y: 710, text: 'First column A' },
        { x: 54, y: 690, text: 'First column B' },
        { x: 224, y: 710, text: 'Second column A' },
        { x: 224, y: 690, text: 'Second column B' },
        { x: 394, y: 710, text: 'Third column A' },
        { x: 394, y: 690, text: 'Third column B' },
      ],
    },
  ]),
);
await save(
  'pdf/simple-table.pdf',
  layoutPdf([
    {
      commands: [
        '0.5 w 65 675 m 535 675 l S',
        '0.5 w 65 650 m 535 650 l S',
        '0.5 w 65 625 m 535 625 l S',
        '0.5 w 65 600 m 535 600 l S',
        '0.5 w 65 600 m 65 675 l S',
        '0.5 w 245 600 m 245 675 l S',
        '0.5 w 390 600 m 390 675 l S',
        '0.5 w 535 600 m 535 675 l S',
      ],
      lines: [
        { y: 725, text: 'Revenue by source', font: 'F2', size: 18 },
        { x: 72, y: 658, text: 'Source', font: 'F2' },
        { x: 260, y: 658, text: '2025', font: 'F2' },
        { x: 405, y: 658, text: '2026', font: 'F2' },
        { x: 72, y: 633, text: 'Tax revenue' },
        { x: 260, y: 633, text: '40.2' },
        { x: 405, y: 633, text: '42.8' },
        { x: 72, y: 608, text: 'Service fees' },
        { x: 260, y: 608, text: '8.1' },
        { x: 405, y: 608, text: '8.6' },
      ],
    },
  ]),
);
await save(
  'pdf/complex-table.pdf',
  layoutPdf([
    {
      lines: [
        { y: 725, text: 'Complex revenue table', font: 'F2', size: 18 },
        { x: 72, y: 670, text: 'Source' },
        { x: 245, y: 670, text: 'Forecast years' },
        { x: 245, y: 648, text: '2025' },
        { x: 345, y: 648, text: '2026' },
        { x: 445, y: 648, text: 'Change' },
        { x: 72, y: 623, text: 'Tax revenue' },
        { x: 245, y: 623, text: '40.2' },
        { x: 345, y: 623, text: '42.8' },
        { x: 445, y: 623, text: '+2.6' },
        { x: 72, y: 598, text: 'Notes span all forecast columns and require review.' },
      ],
    },
  ]),
);
await save(
  'pdf/repeated-furniture.pdf',
  layoutPdf([
    {
      lines: [
        { x: 72, y: 765, text: 'CONFIDENTIAL REVENUE REPORT', font: 'F2', size: 9 },
        { x: 72, y: 720, text: 'First reporting section', font: 'F2', size: 16 },
        { x: 72, y: 690, text: 'The first page contains material revenue discussion.' },
        { x: 300, y: 28, text: 'Page 1', size: 9 },
      ],
    },
    {
      lines: [
        { x: 72, y: 765, text: 'CONFIDENTIAL REVENUE REPORT', font: 'F2', size: 9 },
        { x: 72, y: 720, text: 'Second reporting section', font: 'F2', size: 16 },
        { x: 72, y: 690, text: 'The second page contains material expense discussion.' },
        { x: 300, y: 28, text: 'Page 2', size: 9 },
      ],
    },
  ]),
);
await save(
  'pdf/diagram-caption.pdf',
  layoutPdf([
    {
      commands: ['1 w 100 610 130 60 re S', '1 w 380 610 130 60 re S', '1 w 230 640 m 380 640 l S'],
      lines: [
        { y: 730, text: 'Revenue processing flow', font: 'F2', size: 18 },
        { x: 125, y: 638, text: 'Collect' },
        { x: 412, y: 638, text: 'Report' },
        {
          x: 150,
          y: 580,
          text: 'Figure 1. Revenue moves from collection to reporting.',
          font: 'F3',
          size: 10,
        },
      ],
    },
  ]),
);
await save(
  'pdf/aligned-prose-negative.pdf',
  layoutPdf([
    {
      lines: [
        { y: 730, text: 'Aligned prose is not a table', font: 'F2', size: 18 },
        { x: 72, y: 690, text: 'Revenue is collected from several sources.' },
        { x: 72, y: 670, text: 'Revenue is reviewed under the annual policy.' },
        { x: 72, y: 650, text: 'Revenue is reported in the financial statements.' },
      ],
    },
  ]),
);

await save(
  'docx/word-saved.docx',
  docx(
    `${paragraph('Rendered pagination fixture', 'Heading1')}${paragraph('First page from saved layout.')}<w:p><w:r><w:lastRenderedPageBreak/><w:t>Second page begins here.</w:t></w:r></w:p>${paragraph('Final saved-layout paragraph.')}`,
  ),
);
await save(
  'docx/gdocs-export.docx',
  docx(
    `${paragraph('Generated document', 'Title')}${paragraph('No reliable saved page information.')}`,
  ),
);
await save(
  'docx/explicit-breaks.docx',
  docx(
    `${paragraph('Explicit pagination', 'Heading1')}<w:p><w:r><w:t>Before break.</w:t><w:br w:type="page"/><w:t>After break.</w:t></w:r></w:p>`,
  ),
);
const tableImage = await readFile(resolve(formats, 'images/table.png'));
await save(
  'docx/tables-images-footnotes.docx',
  docx(
    `${paragraph('Structured maintenance report', 'Heading1')}
     <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Important</w:t></w:r><w:r><w:t> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>reviewed</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
     <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Inspect pump</w:t></w:r></w:p>
     <w:tbl><w:tr><w:tc>${paragraph('Asset')}</w:tc><w:tc>${paragraph('State')}</w:tc></w:tr><w:tr><w:tc>${paragraph('Pump A')}</w:tc><w:tc>${paragraph('Ready')}</w:tc></w:tr></w:tbl>
     <w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p>`,
    {
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/table.png"/></Relationships>`,
      'word/media/table.png': tableImage,
      'word/footnotes.xml': `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1">${paragraph('Reviewed during the synthetic inspection.')}</w:footnote></w:footnotes>`,
      'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    },
  ),
);

const operations = [
  ['Work order', 'Date', 'Description', 'Amount'],
  [
    'WO-1001',
    { number: 46_027, style: 1 },
    'North entrance inspection',
    { number: 3100, style: 2 },
  ],
  ['WO-1002', { number: 46_034, style: 1 }, 'Replace seals', { number: 6900, style: 2 }],
];
await save(
  'xlsx/multi-region.xlsx',
  xlsx([{ name: 'Operations', rows: [...operations, [], ['Owner', 'Open'], ['Facilities', 3]] }]),
);
await save('xlsx/dates-currency.xlsx', xlsx([{ name: 'Formatted', rows: operations }]));
await save(
  'xlsx/formulas-no-cache.xlsx',
  xlsx([
    {
      name: 'Formula',
      rows: [
        ['Item', 'Total'],
        ['Parts', { formula: 'SUM(1,2)' }],
      ],
    },
  ]),
);
await save(
  'xlsx/merged-cells.xlsx',
  xlsx([
    {
      name: 'Merged',
      rows: [
        ['Region', null, 'Count'],
        ['North', null, 4],
      ],
      merges: ['A1:B1', 'A2:B2'],
    },
  ]),
);
await save(
  'xlsx/wide-90-col.xlsx',
  xlsx([
    {
      name: 'Wide',
      rows: [
        Array.from({ length: 90 }, (_, index) => `Field ${String(index + 1)}`),
        Array.from({ length: 90 }, (_, index) => index + 1),
      ],
    },
  ]),
);
await save(
  'xlsx/tall-5000-row.xlsx',
  xlsx([
    {
      name: 'Tall',
      rows: [
        ['Row', 'Asset', 'State'],
        ...Array.from({ length: 5000 }, (_, index) => [
          index + 1,
          `Asset-${String(index + 1)}`,
          'Ready',
        ]),
      ],
    },
  ]),
);

const catalogEntries = [
  ['txt/sample.txt', 'txt', 'baseline UTF-8 text', 'usable-text'],
  ['txt/utf8.txt', 'txt', 'UTF-8 text with an astral character', 'usable-text'],
  ['txt/utf16-no-bom.txt', 'txt', 'BOM-less UTF-16LE text', 'usable-text-with-detection-warning'],
  ['txt/shift-jis.txt', 'txt', 'Shift-JIS Japanese text', 'usable-low-confidence-legacy-text'],
  ['md/sample.md', 'markdown', 'baseline Markdown', 'usable-markdown'],
  ['md/structure.md', 'markdown', 'headings, list, and table', 'structure-preserved'],
  ['md/nfd-accents.md', 'markdown', 'decomposed Unicode accents', 'nfc-normalized'],
  ['md/astral-rtl.md', 'markdown', 'astral and right-to-left text', 'dual-offset-safe'],
  [
    'pdf/two-column.pdf',
    'pdf',
    'coordinate-based two-column text',
    'left-column-then-right-column',
  ],
  ['pdf/no-tounicode.pdf', 'pdf', 'raster control for unusable text mapping', 'vision-required'],
  ['pdf/scanned.pdf', 'pdf', 'raster-only page', 'vision-required'],
  ['pdf/ligatures.pdf', 'pdf', 'typographic word control', 'usable-text'],
  ['pdf/hyphenated.pdf', 'pdf', 'line-end hyphenation', 'conservative-hyphen-join'],
  ['pdf/layout-headings.pdf', 'pdf', 'title and heading hierarchy', 'layout-golden'],
  ['pdf/legal-lists.pdf', 'pdf', 'legal sections and nested lists', 'layout-golden'],
  ['pdf/three-column.pdf', 'pdf', 'three-column reading order', 'layout-golden'],
  ['pdf/simple-table.pdf', 'pdf', 'bordered simple table', 'layout-golden'],
  ['pdf/complex-table.pdf', 'pdf', 'merged/spanning table control', 'layout-fallback'],
  ['pdf/repeated-furniture.pdf', 'pdf', 'repeated header and page footer', 'layout-golden'],
  ['pdf/diagram-caption.pdf', 'pdf', 'diagram and caption', 'vision-region-candidate'],
  [
    'pdf/aligned-prose-negative.pdf',
    'pdf',
    'aligned prose table-negative control',
    'layout-negative',
  ],
  [
    'pdf/layout-expectations.json',
    'json',
    'hand-reviewed PDF layout expectations',
    'golden-evaluation-contract',
  ],
  ['docx/word-saved.docx', 'docx', 'saved rendered page-break evidence', 'page-basis-rendered'],
  ['docx/gdocs-export.docx', 'docx', 'synthetic generated-export style package', 'page-basis-none'],
  [
    'docx/gdocs-export-synthetic.docx',
    'docx',
    'legacy generated-export control',
    'page-basis-none',
  ],
  ['docx/explicit-breaks.docx', 'docx', 'explicit page break', 'page-basis-explicit'],
  [
    'docx/tables-images-footnotes.docx',
    'docx',
    'table, image, list, emphasis, and footnote',
    'structured-with-pending-image',
  ],
  [
    'xlsx/messy-workbook.xlsx',
    'xlsx',
    'namespace-prefixed compatibility workbook',
    'usable-regions-and-formats',
  ],
  ['xlsx/multi-region.xlsx', 'xlsx', 'two separated nonempty regions', 'two-tables'],
  ['xlsx/dates-currency.xlsx', 'xlsx', 'date and currency display formats', 'displayed-values'],
  ['xlsx/formulas-no-cache.xlsx', 'xlsx', 'formula without cached value', 'explicit-cache-warning'],
  ['xlsx/merged-cells.xlsx', 'xlsx', 'merged labels', 'merged-values-repeated'],
  ['xlsx/wide-90-col.xlsx', 'xlsx', 'ninety-column region', 'record-layout'],
  ['xlsx/tall-5000-row.xlsx', 'xlsx', 'five-thousand-row streaming proxy', 'streaming-reader'],
  ['images/table.png', 'png', 'synthetic table image', 'vision-probe-input'],
];
const catalog = {
  version: 3,
  privacy: 'synthetic non-private fixtures only',
  generator: 'scripts/generate-m06-fixtures.mjs',
  fixtures: await Promise.all(
    catalogEntries.map(async ([path, format, purpose, expectedDisposition]) => {
      const bytes = await readFile(resolve(formats, path));
      return {
        path,
        format,
        sizeBytes: (await stat(resolve(formats, path))).size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        provenance: 'repository-authored synthetic fixture',
        purpose,
        expectedDisposition,
      };
    }),
  ),
  operatorInputsStillRequired: [
    'approved real Google Docs export',
    'licensed no-ToUnicode production sample',
  ],
};
await save('fixture-catalog.json', Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8'));

console.info('M06 synthetic fixture corpus generated.');
