import { createLocatorMap } from '@noderag/shared';
import type { AssembledDocument, AssembledPage, ExtractedDocument } from './contract.js';

const normalizedPageBody = (body: string): string => body.replace(/\r\n?/gu, '\n').normalize('NFC');

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
    pages.push({
      ...page,
      body,
      characterStart,
      characterEnd,
      byteStart: range.byteStart,
      byteEnd: range.byteEnd,
    });
    characterStart = characterEnd + (index + 1 < document.pages.length ? 2 : 0);
  }
  return { ...document, markdown, pages };
};
