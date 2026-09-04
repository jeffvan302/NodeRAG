import { describe, expect, it } from 'vitest';
import { actionCapability, searchOnlyAllowedActions, siloActionSchema } from '../src/identity.js';

describe('identity contract', () => {
  it('maps every action to one exact independent capability', () => {
    const actions = siloActionSchema.options;
    expect(Object.keys(actionCapability).sort()).toEqual([...actions].sort());
    expect(actionCapability.upload).toBe('upload');
    expect(actionCapability.delete).toBe('delete');
    expect(actionCapability.read_markdown).toBe('read');
  });

  it('narrows search-only credentials to result and chunk access', () => {
    expect(searchOnlyAllowedActions.has('search')).toBe(true);
    expect(searchOnlyAllowedActions.has('read_chunk')).toBe(true);
    expect(searchOnlyAllowedActions.has('read_markdown')).toBe(false);
    expect(searchOnlyAllowedActions.has('download_original')).toBe(false);
    expect(searchOnlyAllowedActions.has('upload')).toBe(false);
    expect(searchOnlyAllowedActions.has('delete')).toBe(false);
  });
});
