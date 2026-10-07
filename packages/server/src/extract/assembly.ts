import { createLocatorMap } from '@noderag/shared';
import type {
  AssembledBlock,
  AssembledDocument,
  AssembledPage,
  ExtractedBlock,
  ExtractedDocument,
  ExtractedPage,
  NormalizedBoundingBox,
} from './contract.js';

const normalizedPageBody = (body: string): string => body.replace(/\r\n?/gu, '\n').normalize('NFC');

const databaseSafeBounds = (bounds: NormalizedBoundingBox | null): NormalizedBoundingBox | null => {
  if (bounds === null) return null;
  const finite = (value: number): number => (Number.isFinite(value) ? value : 0);
  const clamp = (value: number): number => Math.max(0, Math.min(1, finite(value)));
  const left = clamp(Math.min(finite(bounds.x), finite(bounds.x) + finite(bounds.width)));
  const right = clamp(Math.max(finite(bounds.x), finite(bounds.x) + finite(bounds.width)));
  const top = clamp(Math.min(finite(bounds.y), finite(bounds.y) + finite(bounds.height)));
  const bottom = clamp(Math.max(finite(bounds.y), finite(bounds.y) + finite(bounds.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const metadataRevision = (document: ExtractedDocument, key: string, fallback: string): string => {
  const value = document.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

const compatibilityBlock = (
  document: ExtractedDocument,
  page: ExtractedPage,
  body: string,
): readonly ExtractedBlock[] =>
  body.length === 0
    ? []
    : [
        {
          ordinal: 0,
          kind: 'unknown',
          source: page.extraction,
          text: body,
          markdown: body,
          bounds: document.format === 'pdf' ? { x: 0, y: 0, width: 1, height: 1 } : null,
          readingOrder: 0,
          confidence: {
            text: page.confidence,
            readingOrder: page.confidence,
            structure: 0,
            combined: page.confidence,
          },
          warnings: ['layout-shadow-compatibility-block', ...page.warnings],
          revisions: {
            parser: metadataRevision(document, 'parserRevision', `${document.format}-extractor.v1`),
            layout: metadataRevision(document, 'layoutPolicyRevision', 'page-shadow.v1'),
            confidence: metadataRevision(
              document,
              'confidencePolicyRevision',
              'page-confidence.v1',
            ),
          },
        },
      ];

const normalizedBlocks = (
  document: ExtractedDocument,
  page: ExtractedPage,
  body: string,
): readonly ExtractedBlock[] => {
  const blocks =
    page.blocks === undefined
      ? compatibilityBlock(document, page, body)
      : page.blocks.map((block) => ({
          ...block,
          text: normalizedPageBody(block.text),
          markdown: normalizedPageBody(block.markdown),
          bounds: databaseSafeBounds(block.bounds),
        }));
  const ordered = [...blocks].sort(
    (left, right) => left.readingOrder - right.readingOrder || left.ordinal - right.ordinal,
  );
  if (new Set(ordered.map(({ ordinal }) => ordinal)).size !== ordered.length) {
    throw new Error('extraction-block-ordinal-duplicate');
  }
  if (
    ordered.some(({ confidence }) =>
      [confidence.text, confidence.readingOrder, confidence.structure, confidence.combined].some(
        (value) => !Number.isFinite(value) || value < 0 || value > 1,
      ),
    ) ||
    ordered.some(({ confidence }) =>
      Object.values(confidence.components ?? {}).some(
        (value) => !Number.isFinite(value) || value < 0 || value > 1,
      ),
    )
  ) {
    throw new Error('extraction-block-confidence-invalid');
  }
  if (
    ordered
      .map(({ markdown }) => markdown)
      .filter((markdown) => markdown.length > 0)
      .join('\n\n') !== body
  ) {
    throw new Error('extraction-block-markdown-mismatch');
  }
  return ordered;
};

export const assembleExtractedDocument = (document: ExtractedDocument): AssembledDocument => {
  const bodies = document.pages.map(({ body }) => {
    const normalized = normalizedPageBody(body);
    return document.pages.length > 1 ? normalized.replace(/^\n+|\n+$/gu, '') : normalized;
  });
  const markdown = bodies.join('\n\n');
  const locator = createLocatorMap(markdown);
  const pages: AssembledPage[] = [];
  let characterStart = 0;
  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index];
    if (page === undefined) continue;
    const body = bodies[index] ?? '';
    const characterEnd = characterStart + body.length;
    const range =
      characterEnd === characterStart
        ? {
            byteStart: locator.offsetAt(characterStart).byte,
            byteEnd: locator.offsetAt(characterEnd).byte,
          }
        : locator.range(characterStart, characterEnd);
    let blockCharacterStart = characterStart;
    const normalized = normalizedBlocks(document, page, body);
    const emittedBlockIndexes = normalized
      .map((block, blockIndex) => (block.markdown.length > 0 ? blockIndex : -1))
      .filter((blockIndex) => blockIndex >= 0);
    const blocks: AssembledBlock[] = normalized.map((block, blockIndex) => {
      const blockCharacterEnd = blockCharacterStart + block.markdown.length;
      const blockRange =
        blockCharacterEnd === blockCharacterStart
          ? {
              byteStart: locator.offsetAt(blockCharacterStart).byte,
              byteEnd: locator.offsetAt(blockCharacterEnd).byte,
            }
          : locator.range(blockCharacterStart, blockCharacterEnd);
      const assembled = {
        ...block,
        characterStart: blockCharacterStart,
        characterEnd: blockCharacterEnd,
        byteStart: blockRange.byteStart,
        byteEnd: blockRange.byteEnd,
      };
      const emittedPosition = emittedBlockIndexes.indexOf(blockIndex);
      const hasFollowingEmittedBlock =
        block.markdown.length > 0 && emittedPosition < emittedBlockIndexes.length - 1;
      blockCharacterStart = blockCharacterEnd + (hasFollowingEmittedBlock ? 2 : 0);
      return assembled;
    });
    pages.push({
      ...page,
      body,
      blocks,
      characterStart,
      characterEnd,
      byteStart: range.byteStart,
      byteEnd: range.byteEnd,
    });
    characterStart = characterEnd + (index + 1 < document.pages.length ? 2 : 0);
  }
  return { ...document, markdown, pages };
};
