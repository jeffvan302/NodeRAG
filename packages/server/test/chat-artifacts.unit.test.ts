import { describe, expect, it } from 'vitest';
import {
  CHAT_ARTIFACT_TOOL_DEFINITIONS,
  classifyArtifactStorageFailure,
  normalizeArtifactPath,
} from '../src/chat/artifacts.js';

describe('C08 chat artifact path and tool boundary', () => {
  it('normalizes portable relative paths and a case-insensitive collision key', () => {
    expect(normalizeArtifactPath('Legal Notes/Revenue.md')).toEqual({
      relativePath: 'Legal Notes/Revenue.md',
      pathKey: 'legal notes/revenue.md',
      segments: ['Legal Notes', 'Revenue.md'],
    });
    expect(normalizeArtifactPath('Résumé/Évidence.md').relativePath).toBe('Résumé/Évidence.md');
  });

  it('rejects traversal, absolute/device paths, hidden internals, control characters, and aliases', () => {
    for (const path of [
      '../outside.md',
      'folder/../../outside.md',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      'folder\\file.md',
      '.noderag-revisions/file.md',
      'folder/.hidden.md',
      'folder/file.md.',
      'folder/file.md ',
      'folder/file.md:stream',
      'folder/con.md',
      'folder/nu\u0000ll.md',
      'folder/new\nline.md',
    ]) {
      expect(() => normalizeArtifactPath(path), path).toThrowError(
        expect.objectContaining({ code: 'chat_artifact_path_invalid' }),
      );
    }
  });

  it('exposes only narrow file operations and never a shell or delete tool to a model', () => {
    expect(CHAT_ARTIFACT_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'files.list.v1',
      'files.read.v1',
      'files.create.v1',
      'files.mkdir.v1',
      'files.rename.v1',
      'files.copy.v1',
      'files.patch.v1',
    ]);
    expect(JSON.stringify(CHAT_ARTIFACT_TOOL_DEFINITIONS)).not.toMatch(/shell|command|delete/iu);
  });

  it('maps a full filesystem to a stable capacity error without exposing its message', () => {
    const failure = classifyArtifactStorageFailure(
      Object.assign(new Error('sensitive mount detail'), { code: 'ENOSPC' }),
    );
    expect(failure).toMatchObject({ code: 'chat_artifact_disk_full', status: 507 });
  });
});
