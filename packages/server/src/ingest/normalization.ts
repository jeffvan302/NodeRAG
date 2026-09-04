export interface NormalizedMarkdown {
  readonly markdown: string;
  readonly encoding: 'utf-8';
  readonly normalization: 'nfc';
  readonly normalizationVersion: 1;
  readonly bomRemoved: boolean;
  readonly lineEndingsChanged: boolean;
  readonly unicodeChanged: boolean;
  readonly offsetsMatchOriginal: boolean;
}

export const normalizeMarkdown = (original: Uint8Array): NormalizedMarkdown => {
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
  const bomRemoved = decoded.startsWith('\uFEFF');
  const withoutBom = bomRemoved ? decoded.slice(1) : decoded;
  const lineEndings = withoutBom.replace(/\r\n?/gu, '\n');
  const lineEndingsChanged = lineEndings !== withoutBom;
  const markdown = lineEndings.normalize('NFC');
  const unicodeChanged = markdown !== lineEndings;
  return {
    markdown,
    encoding: 'utf-8',
    normalization: 'nfc',
    normalizationVersion: 1,
    bomRemoved,
    lineEndingsChanged,
    unicodeChanged,
    offsetsMatchOriginal:
      !bomRemoved &&
      !lineEndingsChanged &&
      !unicodeChanged &&
      Buffer.from(markdown, 'utf8').equals(Buffer.from(original)),
  };
};
