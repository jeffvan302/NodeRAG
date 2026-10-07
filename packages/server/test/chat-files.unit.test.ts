import { describe, expect, it } from 'vitest';
import { normalizeChatFileMetadata } from '../src/chat/chat-files.js';
import type { ChatFileError } from '../src/chat/chat-files.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600', 'hex');

describe('Chat website file validation', () => {
  it('canonicalizes JPEG while preserving the display filename', () => {
    expect(normalizeChatFileMetadata('Chart.JPEG', 'image/jpeg', jpeg)).toEqual({
      originalFilename: 'Chart.JPEG',
      extension: 'jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('accepts a PNG with matching extension, MIME type, and signature', () => {
    expect(normalizeChatFileMetadata('diagram.png', 'image/png', png)).toMatchObject({
      extension: 'png',
      mimeType: 'image/png',
    });
  });

  it.each([
    ['../diagram.png', 'image/png', png, 'chat_file_name_invalid'],
    ['diagram.svg', 'image/svg+xml', Buffer.from('<svg/>'), 'chat_file_type_unsupported'],
    ['diagram.png', 'image/jpeg', png, 'chat_file_type_unsupported'],
    ['diagram.png', 'image/png', Buffer.from('not-a-png'), 'chat_file_signature_invalid'],
    ['diagram.png', 'image/png', Buffer.alloc(0), 'chat_file_empty'],
  ])('rejects unsafe or malformed upload %s', (filename, mimeType, bytes, code) => {
    try {
      normalizeChatFileMetadata(filename, mimeType, bytes);
      throw new Error('Expected the file to be rejected.');
    } catch (error) {
      expect((error as ChatFileError).code).toBe(code);
    }
  });
});
