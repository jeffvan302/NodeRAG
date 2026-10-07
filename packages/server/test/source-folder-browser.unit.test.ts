import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceCreationFailure } from '../src/api/durability-routes.js';
import { browseSourceFolders, validateSourceRoot } from '../src/ingest/sources.js';

const temporaryPaths: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'noderag-folder-browser-'));
  temporaryPaths.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('source folder browser', () => {
  it('navigates from the filesystem root to allowed folders without exposing siblings or files', async () => {
    const base = await temporaryDirectory();
    const source = join(base, 'source');
    const nested = join(source, 'Policies', 'Current');
    await mkdir(nested, { recursive: true });
    await mkdir(join(source, 'Archive'));
    await writeFile(join(source, 'private.txt'), 'not a directory');
    const canonicalSource = await realpath(source);
    const canonicalNested = await realpath(nested);
    const canonicalBase = await realpath(base);
    const filesystemRoot = await realpath(parse(canonicalSource).root);

    const top = await browseSourceFolders(undefined, [source]);
    const firstSegment = relative(filesystemRoot, canonicalSource).split(sep)[0];
    if (firstSegment === undefined) throw new Error('expected source path below filesystem root');
    expect(top).toEqual({
      currentPath: filesystemRoot,
      parentPath: null,
      selectable: false,
      items: [{ name: firstSegment, path: join(filesystemRoot, firstSegment) }],
    });

    const ancestor = await browseSourceFolders(base, [source]);
    expect(ancestor).toEqual({
      currentPath: canonicalBase,
      parentPath: dirname(canonicalBase),
      selectable: false,
      items: [{ name: 'source', path: canonicalSource }],
    });

    const root = await browseSourceFolders(source, [source]);
    expect(root.currentPath).toBe(canonicalSource);
    expect(root.parentPath).toBe(canonicalBase);
    expect(root.selectable).toBe(true);
    expect(root.items.map((item) => item.name)).toEqual(['Archive', 'Policies']);

    const child = await browseSourceFolders(nested, [source]);
    expect(child.currentPath).toBe(canonicalNested);
    expect(child.parentPath).toBe(join(canonicalSource, 'Policies'));
    expect(child.selectable).toBe(true);
  });

  it('rejects paths outside the configured source roots', async () => {
    const base = await temporaryDirectory();
    const allowed = join(base, 'allowed');
    const outside = join(base, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);

    await expect(browseSourceFolders(outside, [allowed])).rejects.toThrow(
      'source-root-outside-allowlist',
    );
  });

  it('canonicalizes and verifies that a selected source folder can be opened', async () => {
    const base = await temporaryDirectory();
    const source = join(base, 'source', 'documents');
    await mkdir(source, { recursive: true });
    await expect(validateSourceRoot(source, [base])).resolves.toBe(await realpath(source));
  });

  it('maps filesystem and duplicate-registration failures to safe API problems', () => {
    expect(
      sourceCreationFailure(Object.assign(new Error('duplicate detail'), { code: '23505' })),
    ).toEqual({ status: 409, code: 'source-already-connected' });
    expect(
      sourceCreationFailure(Object.assign(new Error('permission detail'), { code: 'EACCES' })),
    ).toEqual({ status: 403, code: 'source-folder-unreadable' });
    expect(sourceCreationFailure(new Error('sensitive database detail'))).toEqual({
      status: 500,
      code: 'source-create-failed',
    });
  });

  it('reports missing source-root configuration clearly', async () => {
    await expect(browseSourceFolders(undefined, [])).rejects.toThrow('source-roots-not-configured');
  });
});
