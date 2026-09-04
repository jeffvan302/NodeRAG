const maximumFrameBytes = 16 * 1024 * 1024;

export const encodeJsonFrame = (value: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > maximumFrameBytes) throw new RangeError('Frame exceeds the maximum size.');
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
};

export class JsonFrameDecoder {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): readonly unknown[] {
    const combined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    combined.set(this.buffered);
    combined.set(chunk, this.buffered.byteLength);
    this.buffered = combined;
    const values: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      ).getUint32(0, false);
      if (length > maximumFrameBytes) throw new RangeError('Frame exceeds the maximum size.');
      if (this.buffered.byteLength < length + 4) break;
      const body = this.buffered.slice(4, length + 4);
      values.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
      this.buffered = this.buffered.slice(length + 4);
    }
    return values;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0)
      throw new Error('Connection ended with an incomplete frame.');
  }
}
