interface BrowserCryptoSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (values: Uint8Array) => Uint8Array;
}

let fallbackSequence = 0;

const formatUuidV4 = (bytes: Uint8Array): string => {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Generates a request key even when NodeRag is opened from a plain HTTP NAS address.
 * Browser randomUUID is restricted to secure contexts, while getRandomValues remains
 * available there. The final branch is only a uniqueness fallback; this key is not a secret.
 */
export const createIdempotencyKey = (
  source: BrowserCryptoSource | null = (globalThis.crypto as BrowserCryptoSource | undefined) ??
    null,
): string => {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    fallbackSequence = (fallbackSequence + 1) >>> 0;
    const timestamp = Date.now();
    for (let index = 0; index < bytes.length; index += 1) {
      const timeByte = Math.floor(timestamp / 2 ** ((index % 6) * 8)) & 0xff;
      const sequenceByte = (fallbackSequence >>> ((index % 4) * 8)) & 0xff;
      bytes[index] = timeByte ^ sequenceByte ^ Math.floor(Math.random() * 256);
    }
  }
  return formatUuidV4(bytes);
};
