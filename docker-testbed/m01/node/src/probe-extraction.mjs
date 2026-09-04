import fs from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const fixtureRoot = process.env.NODERAG_M01_FIXTURE_ROOT ?? "/workspace/fixtures/formats";

async function extractPdf(filePath) {
  const data = new Uint8Array(await fs.readFile(filePath));
  const document = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).filter(Boolean).join(" "));
  }
  return pages;
}

async function extractDocx(filePath) {
  const raw = await mammoth.extractRawText({ path: filePath });
  const html = await mammoth.convertToHtml({ path: filePath });
  return { text: raw.value.trim(), html: html.value, messages: [...raw.messages, ...html.messages] };
}

async function extractWorkbookWithExcelJs(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const cells = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cells.push({ sheet: sheet.name, address: cell.address, value: cell.text });
      });
    });
  });
  return { cells, engine: "exceljs", compatibilityFallback: false };
}

function elementsByLocalName(node, localName) {
  return Array.from(node.getElementsByTagNameNS("*", localName));
}

function firstText(node, localName) {
  return elementsByLocalName(node, localName)[0]?.textContent ?? "";
}

async function extractWorkbookNamespaceAware(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const readXml = async (name) => {
    const entry = zip.file(name);
    if (!entry) throw new Error(`Missing OOXML part: ${name}`);
    return new DOMParser().parseFromString(await entry.async("text"), "application/xml");
  };
  const workbook = await readXml("xl/workbook.xml");
  const relationships = await readXml("xl/_rels/workbook.xml.rels");
  const relationshipTargets = new Map(
    elementsByLocalName(relationships, "Relationship").map((relationship) => [
      relationship.getAttribute("Id"),
      relationship.getAttribute("Target").replace(/^\//, ""),
    ]),
  );
  const sharedStrings = zip.file("xl/sharedStrings.xml")
    ? elementsByLocalName(await readXml("xl/sharedStrings.xml"), "si").map((item) =>
        elementsByLocalName(item, "t").map((text) => text.textContent).join(""),
      )
    : [];
  const cells = [];
  for (const sheet of elementsByLocalName(workbook, "sheet")) {
    const relationshipId = sheet.getAttribute("r:id") || sheet.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    );
    const target = relationshipTargets.get(relationshipId);
    if (!target) throw new Error(`Missing worksheet relationship: ${relationshipId}`);
    const worksheet = await readXml(target);
    for (const cell of elementsByLocalName(worksheet, "c")) {
      const type = cell.getAttribute("t");
      const raw = firstText(cell, "v") || firstText(cell, "t");
      const value = type === "s" ? (sharedStrings[Number(raw)] ?? "") : raw;
      if (value || firstText(cell, "f")) {
        cells.push({
          sheet: sheet.getAttribute("name"),
          address: cell.getAttribute("r"),
          value,
          formula: firstText(cell, "f") || null,
        });
      }
    }
  }
  return { cells, engine: "namespace-aware-ooxml", compatibilityFallback: true };
}

async function extractWorkbook(filePath) {
  try {
    return await extractWorkbookWithExcelJs(filePath);
  } catch (error) {
    const fallback = await extractWorkbookNamespaceAware(filePath);
    return { ...fallback, excelJsError: error.message };
  }
}

const txt = await fs.readFile(path.join(fixtureRoot, "txt", "sample.txt"), "utf8");
const markdown = await fs.readFile(path.join(fixtureRoot, "md", "sample.md"), "utf8");
const twoColumn = await extractPdf(path.join(fixtureRoot, "pdf", "two-column.pdf"));
const scanned = await extractPdf(path.join(fixtureRoot, "pdf", "scanned.pdf"));
const word = await extractDocx(path.join(fixtureRoot, "docx", "word-saved.docx"));
const exportStyle = await extractDocx(path.join(fixtureRoot, "docx", "gdocs-export-synthetic.docx"));
const workbook = await extractWorkbook(path.join(fixtureRoot, "xlsx", "messy-workbook.xlsx"));
const workbookCells = workbook.cells;

const twoColumnText = twoColumn.join("\n");
const left1 = twoColumnText.indexOf("LEFT COLUMN 1");
const left2 = twoColumnText.indexOf("LEFT COLUMN 2");
const right1 = twoColumnText.indexOf("RIGHT COLUMN 1");
const right2 = twoColumnText.indexOf("RIGHT COLUMN 2");
const result = {
  txt: { bytes: Buffer.byteLength(txt), usable: txt.includes("NodeRag text fixture") },
  markdown: { bytes: Buffer.byteLength(markdown), usable: markdown.includes("| Quarter |") },
  twoColumnPdf: {
    pages: twoColumn.length,
    characters: twoColumnText.length,
    readingOrderPreserved: left1 >= 0 && left1 < left2 && left2 < right1 && right1 < right2,
  },
  scannedPdf: {
    pages: scanned.length,
    extractedCharacters: scanned.join("").trim().length,
    disposition: scanned.join("").trim().length === 0 ? "vision-required" : "unexpected-text-layer",
  },
  wordDocx: {
    characters: word.text.length,
    hasTable: /<table[\s>]/i.test(word.html),
    hasExplicitSecondPageText: word.text.includes("Second page findings"),
  },
  googleExportStyleDocx: {
    characters: exportStyle.text.length,
    hasTable: /<table[\s>]/i.test(exportStyle.html),
    provenance: "synthetic export-style fixture; an approved real Google Docs export remains an operator input",
    pageBasis: "none",
  },
  workbook: {
    engine: workbook.engine,
    compatibilityFallback: workbook.compatibilityFallback,
    excelJsError: workbook.excelJsError ?? null,
    worksheets: [...new Set(workbookCells.map((cell) => cell.sheet))],
    populatedCells: workbookCells.length,
    hasFormulaResults: workbookCells.some(
      (cell) => cell.address === "E8" && cell.formula === "SUM(E5:E7)" && cell.value === "23100",
    ),
    hasSecondRegion: workbookCells.some((cell) => cell.value === "North entrance"),
  },
};
result.passed =
  result.txt.usable &&
  result.markdown.usable &&
  result.twoColumnPdf.readingOrderPreserved &&
  result.scannedPdf.disposition === "vision-required" &&
  result.wordDocx.hasTable &&
  result.wordDocx.hasExplicitSecondPageText &&
  result.googleExportStyleDocx.hasTable &&
  result.workbook.hasFormulaResults &&
  result.workbook.hasSecondRegion;

console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}
