import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const secret = randomBytes(32);

export class CursorError extends Error {
  constructor() {
    super('invalid_cursor');
  }
}

export const encodeCursor = (value: Readonly<Record<string, unknown>>): string => {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

export const decodeCursor = <T>(cursor: string): T => {
  const [payload, signature, extra] = cursor.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined)
    throw new CursorError();
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    throw new CursorError();
  }
  if (actual.toString('base64url') !== signature) throw new CursorError();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new CursorError();
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    throw new CursorError();
  }
};
