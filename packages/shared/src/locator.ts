export interface DualOffset {
  readonly character: number;
  readonly byte: number;
}

export interface DualRange {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface LocatorMap {
  readonly characterLength: number;
  readonly byteLength: number;
  offsetAt(characterOffset: number): DualOffset;
  range(characterStart: number, characterEnd: number): DualRange;
}

const utf8Width = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
};

export const isUtf16Boundary = (text: string, offset: number): boolean =>
  offset >= 0 &&
  offset <= text.length &&
  !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(text[offset] ?? '')
  );

export const createLocatorMap = (text: string): LocatorMap => {
  const byteOffsets = new Int32Array(text.length + 1);
  const valid = new Uint8Array(text.length + 1);
  let character = 0;
  let byte = 0;
  valid[0] = 1;
  while (character < text.length) {
    const codePoint = text.codePointAt(character);
    if (codePoint === undefined) throw new Error('Unable to read UTF-16 input.');
    const width = codePoint > 0xffff ? 2 : 1;
    byte += utf8Width(codePoint);
    character += width;
    byteOffsets[character] = byte;
    valid[character] = 1;
  }

  const offsetAt = (characterOffset: number): DualOffset => {
    if (
      !Number.isInteger(characterOffset) ||
      characterOffset < 0 ||
      characterOffset > text.length ||
      valid[characterOffset] !== 1
    ) {
      throw new RangeError('Offset is not a valid UTF-16 boundary.');
    }
    return { character: characterOffset, byte: byteOffsets[characterOffset] ?? 0 };
  };

  return {
    characterLength: text.length,
    byteLength: byte,
    offsetAt,
    range: (characterStart, characterEnd) => {
      if (characterEnd <= characterStart) throw new RangeError('Range must be non-empty.');
      const start = offsetAt(characterStart);
      const end = offsetAt(characterEnd);
      return {
        characterStart: start.character,
        characterEnd: end.character,
        byteStart: start.byte,
        byteEnd: end.byte,
      };
    },
  };
};

export const sliceUtf8 = (text: string, byteStart: number, byteEnd: number): string => {
  if (!Number.isInteger(byteStart) || !Number.isInteger(byteEnd) || byteEnd <= byteStart) {
    throw new RangeError('Byte range must be non-empty integers.');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    new TextEncoder().encode(text).slice(byteStart, byteEnd),
  );
};
