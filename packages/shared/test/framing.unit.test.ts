import { describe, expect, it } from 'vitest';
import { encodeJsonFrame, JsonFrameDecoder } from '../src/framing.js';

describe('private embedder framing', () => {
  it('handles fragmented and coalesced frames', () => {
    const first = encodeJsonFrame({ id: 1, text: '😀' });
    const second = encodeJsonFrame({ id: 2 });
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first);
    joined.set(second, first.length);
    const decoder = new JsonFrameDecoder();
    expect(decoder.push(joined.slice(0, 3))).toEqual([]);
    expect(decoder.push(joined.slice(3))).toEqual([{ id: 1, text: '😀' }, { id: 2 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('rejects an incomplete frame at connection end', () => {
    const decoder = new JsonFrameDecoder();
    decoder.push(encodeJsonFrame({ ok: true }).slice(0, 5));
    expect(() => decoder.finish()).toThrow('incomplete frame');
  });
});
