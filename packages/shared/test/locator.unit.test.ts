import { describe, expect, it } from 'vitest';
import { createLocatorMap, sliceUtf8 } from '../src/locator.js';

describe('dual-unit locator producer', () => {
  it('maps every valid UTF-16 boundary to the matching UTF-8 slice', () => {
    const text = 'A😀 café e\u0301 中';
    const locator = createLocatorMap(text);
    const ranges = [
      [0, 1],
      [1, 3],
      [3, 9],
      [9, text.length],
    ] as const;
    for (const [start, end] of ranges) {
      const range = locator.range(start, end);
      expect(sliceUtf8(text, range.byteStart, range.byteEnd)).toBe(text.slice(start, end));
    }
    expect(() => locator.offsetAt(2)).toThrow('valid UTF-16 boundary');
  });
});
