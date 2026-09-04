import chardet from 'chardet';
import iconv from 'iconv-lite';
import type { DocumentFormat, ExtractedDocument } from './contract.js';

interface DecodedText {
  readonly text: string;
  readonly encoding: string;
  readonly confidence: number;
  readonly bomRemoved: boolean;
  readonly warnings: readonly string[];
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

const decodeFatal = (bytes: Uint8Array, encoding: string): string =>
  new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);

const utf16Pattern = (bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null => {
  const sample = bytes.subarray(0, Math.min(bytes.length - (bytes.length % 2), 4096));
  if (sample.length < 8) return null;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sample.length; index += 2) {
    if (sample[index] === 0) evenNulls += 1;
    if (sample[index + 1] === 0) oddNulls += 1;
  }
  const pairs = sample.length / 2;
  if (oddNulls / pairs >= 0.3 && evenNulls / pairs <= 0.05) return 'utf-16le';
  if (evenNulls / pairs >= 0.3 && oddNulls / pairs <= 0.05) return 'utf-16be';
  return null;
};

export const decodeTextBytes = (bytes: Uint8Array): DecodedText => {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: decodeFatal(bytes.subarray(3), 'utf-8'),
      encoding: 'utf-8',
      confidence: 1,
      bomRemoved: true,
      warnings: [],
    };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: decodeFatal(bytes.subarray(2), 'utf-16le'),
      encoding: 'utf-16le',
      confidence: 1,
      bomRemoved: true,
      warnings: [],
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: decodeFatal(bytes.subarray(2), 'utf-16be'),
      encoding: 'utf-16be',
      confidence: 1,
      bomRemoved: true,
      warnings: [],
    };
  }
  const patterned = utf16Pattern(bytes);
  if (patterned !== null) {
    return {
      text: decodeFatal(bytes, patterned),
      encoding: patterned,
      confidence: 0.95,
      bomRemoved: false,
      warnings: ['bomless-utf16-detected'],
    };
  }
  try {
    return {
      text: decodeFatal(bytes, 'utf-8'),
      encoding: 'utf-8',
      confidence: 1,
      bomRemoved: false,
      warnings: [],
    };
  } catch {
    const analysed = chardet.analyse(bytes);
    const detected = analysed
      .filter(
        (candidate) =>
          candidate.name.toLowerCase() !== 'ascii' &&
          candidate.confidence > 0 &&
          iconv.encodingExists(candidate.name),
      )
      .map((candidate, order) => {
        const text = iconv.decode(Buffer.from(bytes), candidate.name);
        const replacements = [...text].filter((character) => character === '\uFFFD').length;
        return { ...candidate, text, replacements, order };
      })
      .sort(
        (left, right) =>
          left.replacements - right.replacements ||
          right.confidence - left.confidence ||
          left.order - right.order,
      )[0];
    const hasHighBytes = bytes.some((value) => value >= 0x80);
    const match =
      detected ??
      (hasHighBytes ? { name: 'windows-1252', confidence: 25, lang: undefined } : analysed[0]);
    if (match === undefined || !iconv.encodingExists(match.name)) {
      throw new Error('text-encoding-undetected');
    }
    const confidence = Math.max(0, Math.min(1, match.confidence / 100));
    const warnings = ['legacy-encoding-detected'];
    if (confidence < 0.8) warnings.push('low-encoding-confidence');
    return {
      text:
        'text' in match && typeof match.text === 'string'
          ? match.text
          : iconv.decode(Buffer.from(bytes), match.name),
      encoding: match.name.toLowerCase(),
      confidence,
      bomRemoved: false,
      warnings,
    };
  }
};

export const extractTextDocument = async (
  bytes: Uint8Array,
  format: Extract<DocumentFormat, 'md' | 'txt'>,
): Promise<ExtractedDocument> => {
  const decoded = decodeTextBytes(bytes);
  const lineEndings = decoded.text.replace(/\r\n?/gu, '\n');
  const markdown = lineEndings.normalize('NFC');
  const lineEndingsChanged = lineEndings !== decoded.text;
  const unicodeChanged = markdown !== lineEndings;
  const offsetsMatchOriginal =
    decoded.encoding === 'utf-8' &&
    !decoded.bomRemoved &&
    !lineEndingsChanged &&
    !unicodeChanged &&
    Buffer.from(markdown, 'utf8').equals(Buffer.from(bytes));
  return {
    format,
    pageBasis: 'none',
    encoding: decoded.encoding,
    encodingConfidence: decoded.confidence,
    offsetsMatchOriginal,
    warnings: decoded.warnings,
    metadata: {
      bomRemoved: decoded.bomRemoved,
      lineEndingsChanged,
      unicodeChanged,
      paragraphPolicy: format === 'txt' ? 'blank-lines-only' : 'preserve-markdown',
    },
    pages: [
      {
        ordinal: 0,
        pageNumber: null,
        label: null,
        body: markdown,
        extraction: 'text',
        confidence: decoded.confidence,
        warnings: decoded.warnings,
        images: [],
        metadata: {},
      },
    ],
  };
};
