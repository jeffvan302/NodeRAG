import { deflateSync } from 'node:zlib';

const width = 480;
const height = 270;
const channels = 3;
type Rgb = readonly [red: number, green: number, blue: number];

const glyphs: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

const fill = (pixels: Buffer, x: number, y: number, w: number, h: number, color: Rgb): void => {
  for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + w); column += 1) {
      const offset = (row * width + column) * channels;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
};

const text = (
  pixels: Buffer,
  value: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void => {
  let cursor = x;
  for (const character of value.toUpperCase()) {
    const glyph = glyphs[character];
    if (glyph !== undefined) {
      glyph.forEach((row, rowIndex) => {
        for (let column = 0; column < row.length; column += 1) {
          if (row[column] === '1') {
            fill(pixels, cursor + column * scale, y + rowIndex * scale, scale, scale, color);
          }
        }
      });
    }
    cursor += 6 * scale;
  }
};

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
};

const pngChunk = (name: string, data: Buffer): Buffer => {
  const type = Buffer.from(name, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  type.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return output;
};

const buildActivationSample = (): Buffer => {
  const pixels = Buffer.alloc(width * height * channels, 0xff);
  const green: Rgb = [17, 55, 44];
  const border: Rgb = [47, 102, 85];
  const mint: Rgb = [223, 243, 233];
  const ink: Rgb = [23, 34, 31];
  const white: Rgb = [255, 255, 255];

  fill(pixels, 0, 0, width, 58, green);
  text(pixels, 'NODERAG PROVIDER CHECK', 24, 18, 3, white);

  const left = 24;
  const top = 82;
  const rowHeight = 48;
  const middle = 294;
  const right = 456;
  fill(pixels, left, top, right - left, rowHeight, mint);
  for (let row = 0; row <= 3; row += 1) {
    fill(pixels, left, top + row * rowHeight, right - left, 2, border);
  }
  for (const column of [left, middle, right]) {
    fill(pixels, column, top, 2, rowHeight * 3, border);
  }
  text(pixels, 'COMPONENT', left + 14, top + 14, 2, ink);
  text(pixels, 'STATE', middle + 14, top + 14, 2, ink);
  text(pixels, 'SEARCH', left + 14, top + rowHeight + 14, 2, ink);
  text(pixels, 'READY', middle + 14, top + rowHeight + 14, 2, ink);
  text(pixels, 'VISION', left + 14, top + rowHeight * 2 + 14, 2, ink);
  text(pixels, 'READY', middle + 14, top + rowHeight * 2 + 14, 2, ink);

  const scanlines = Buffer.alloc((width * channels + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * channels + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, row * width * channels, (row + 1) * width * channels);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const embeddedActivationSample = buildActivationSample();

export const visionActivationSample = (): Buffer => Buffer.from(embeddedActivationSample);
