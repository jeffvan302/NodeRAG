import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isManagedChatFileUrl } from './markdown-viewer.js';

const originalLocation = globalThis.location;

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://vanweb.synology.me/noderag/chat'),
  });
});

afterAll(() => {
  if (originalLocation === undefined) {
    Reflect.deleteProperty(globalThis, 'location');
  } else {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  }
});

describe('managed Chat file URLs', () => {
  const chatId = '0f3b45a6-dac0-4a02-9baa-55b68551f85e';
  const fileId = '130ea00d-1856-499a-bc72-d856e6d7406f';

  it('accepts relative and absolute same-origin URLs below a reverse-proxy mount', () => {
    expect(isManagedChatFileUrl(`/noderag/chat/${chatId}/file/${fileId}.png`)).toBe(true);
    expect(
      isManagedChatFileUrl(`https://vanweb.synology.me/noderag/chat/${chatId}/file/${fileId}.jpg`),
    ).toBe(true);
  });

  it.each([
    `https://example.test/noderag/chat/${chatId}/file/${fileId}.png`,
    `/noderag/chat/${chatId}/file/original-name.png`,
    `/noderag/chat/${chatId}/file/${fileId}.svg`,
    '/noderag/chat/not-a-uuid/file/not-a-uuid.png',
  ])('rejects unmanaged file URL %s', (href) => {
    expect(isManagedChatFileUrl(href)).toBe(false);
  });
});
