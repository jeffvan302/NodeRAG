import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, displayError, postJson, type JsonRecord, type Silo } from './api.js';
import { EmptyState, Field, Icon, Modal, Notice, Spinner } from './components.js';
import { MarkdownViewer } from './markdown-viewer.js';
import { appUrl } from './url.js';

interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly revision: number;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly updatedAt: string;
}

interface ArtifactQuota {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly availableBytes: number;
  readonly maximumFileBytes: number;
  readonly fileCount: number;
  readonly externalImages: boolean;
}

interface ManagedChatFile {
  readonly id: string;
  readonly originalFilename: string;
  readonly extension: 'png' | 'jpg' | 'gif' | 'webp';
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly websitePath: string;
  readonly createdAt: string;
}

interface ArtifactRevision {
  readonly id: string;
  readonly revision: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly createdByKind: string;
  readonly sourceCitations: readonly string[];
  readonly createdAt: string;
}

interface ArtifactExport {
  readonly id: string;
  readonly artifactId: string;
  readonly sourceRevision: number;
  readonly sourceSha256: string;
  readonly format: 'docx' | 'pdf';
  readonly state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';
  readonly phase: string;
  readonly progressPercent: number;
  readonly outputSha256: string | null;
  readonly outputBytes: number | null;
  readonly filename: string | null;
  readonly errorCode: string | null;
  readonly canCancel: boolean;
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

const objects = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
    : [];

const artifact = (value: unknown): Artifact | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['path'] !== 'string' ||
    typeof row['name'] !== 'string' ||
    (row['kind'] !== 'file' && row['kind'] !== 'directory')
  ) {
    return null;
  }
  return {
    id: row['id'],
    path: row['path'],
    name: row['name'],
    kind: row['kind'],
    revision: Number(row['revision'] ?? 0),
    sha256: typeof row['sha256'] === 'string' ? row['sha256'] : null,
    bytes: Number(row['bytes'] ?? 0),
    updatedAt: String(row['updatedAt'] ?? ''),
  };
};

const revision = (value: unknown): ArtifactRevision | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (typeof row['id'] !== 'string' || typeof row['sha256'] !== 'string') return null;
  return {
    id: row['id'],
    revision: Number(row['revision']),
    sha256: row['sha256'],
    bytes: Number(row['bytes'] ?? 0),
    createdByKind: String(row['createdByKind'] ?? 'unknown'),
    sourceCitations: Array.isArray(row['sourceCitations'])
      ? row['sourceCitations'].map(String)
      : [],
    createdAt: String(row['createdAt'] ?? ''),
  };
};

const artifactExport = (value: unknown): ArtifactExport | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['artifactId'] !== 'string' ||
    (row['format'] !== 'docx' && row['format'] !== 'pdf')
  ) {
    return null;
  }
  return {
    id: row['id'],
    artifactId: row['artifactId'],
    sourceRevision: Number(row['sourceRevision']),
    sourceSha256: String(row['sourceSha256'] ?? ''),
    format: row['format'],
    state: String(row['state']) as ArtifactExport['state'],
    phase: String(row['phase'] ?? 'queued'),
    progressPercent: Number(row['progressPercent'] ?? 0),
    outputSha256: typeof row['outputSha256'] === 'string' ? row['outputSha256'] : null,
    outputBytes: typeof row['outputBytes'] === 'number' ? row['outputBytes'] : null,
    filename: typeof row['filename'] === 'string' ? row['filename'] : null,
    errorCode: typeof row['errorCode'] === 'string' ? row['errorCode'] : null,
    canCancel: row['canCancel'] === true,
    warnings: Array.isArray(row['warnings']) ? row['warnings'].map(String) : [],
    createdAt: String(row['createdAt'] ?? ''),
  };
};

const managedChatFile = (value: unknown): ManagedChatFile | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['originalFilename'] !== 'string' ||
    typeof row['websitePath'] !== 'string' ||
    typeof row['sha256'] !== 'string' ||
    !['png', 'jpg', 'gif', 'webp'].includes(String(row['extension']))
  ) {
    return null;
  }
  return {
    id: row['id'],
    originalFilename: row['originalFilename'],
    extension: String(row['extension']) as ManagedChatFile['extension'],
    mimeType: String(row['mimeType'] ?? ''),
    sha256: row['sha256'],
    bytes: Number(row['bytes'] ?? 0),
    websitePath: row['websitePath'],
    createdAt: String(row['createdAt'] ?? ''),
  };
};

const formatBytes = (value: number): string => {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};

const parentDirectory = (directory: string): string =>
  directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '';

const joinPath = (directory: string, name: string): string =>
  directory === '' ? name : `${directory}/${name}`;

const readContent = async (
  chatId: string,
  item: Artifact,
  selectedRevision?: number,
): Promise<string> => {
  let offset = 0;
  let output = '';
  for (;;) {
    const response = await api<JsonRecord>(
      `/v1/chats/${chatId}/artifacts/${item.id}/content?offset=${String(offset)}&limit=64000${selectedRevision === undefined ? '' : `&revision=${String(selectedRevision)}`}`,
    );
    output += String(response['content'] ?? '');
    const nextOffset = response['nextOffset'];
    if (typeof nextOffset !== 'number') return output;
    if (nextOffset <= offset)
      throw new Error('The artifact reader stopped at an invalid position.');
    offset = nextOffset;
  }
};

const linePatch = (before: string, after: string) => {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const expectedLines = oldLines.slice(prefix, oldLines.length - suffix);
  const replacementLines = newLines.slice(prefix, newLines.length - suffix);
  if (expectedLines.length > 10_000 || replacementLines.length > 10_000) {
    throw new Error('This edit is too large for one safe revision. Make a smaller edit and retry.');
  }
  return {
    startLine: prefix + 1,
    deleteCount: expectedLines.length,
    expectedLines,
    replacementLines,
  };
};

export const ChatArtifactDrawer = ({
  chatId,
  colorScheme,
  enabled,
  exportsEnabled,
  silos,
}: {
  readonly chatId: string;
  readonly colorScheme: string;
  readonly enabled: boolean;
  readonly exportsEnabled: boolean;
  readonly silos: readonly Silo[];
}) => {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [items, setItems] = useState<readonly Artifact[]>([]);
  const [files, setFiles] = useState<readonly ManagedChatFile[]>([]);
  const [quota, setQuota] = useState<ArtifactQuota | null>(null);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<readonly ArtifactRevision[]>([]);
  const [exports, setExports] = useState<readonly ArtifactExport[]>([]);
  const [previewExportId, setPreviewExportId] = useState<string | null>(null);
  const [ingestSiloId, setIngestSiloId] = useState<number | null>(silos[0]?.id ?? null);
  const [ingestSource, setIngestSource] = useState('markdown');
  const [comparison, setComparison] = useState<{ revision: number; content: string } | null>(null);
  const [creating, setCreating] = useState<'file' | 'directory' | null>(null);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('# New document\n\n');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const listRoot = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const loadDirectory = useCallback(
    async (nextDirectory: string) => {
      setLoading(true);
      setError('');
      try {
        const response = await api<JsonRecord>(
          `/v1/chats/${chatId}/artifacts?directory=${encodeURIComponent(nextDirectory)}`,
        );
        setDirectory(String(response['directory'] ?? ''));
        setItems(
          objects(response['items']).flatMap((row) => {
            const parsed = artifact(row);
            return parsed === null ? [] : [parsed];
          }),
        );
        const value = (response['quota'] as JsonRecord | undefined) ?? {};
        setQuota({
          usedBytes: Number(value['usedBytes'] ?? 0),
          quotaBytes: Number(value['quotaBytes'] ?? 0),
          availableBytes: Number(value['availableBytes'] ?? 0),
          maximumFileBytes: Number(value['maximumFileBytes'] ?? 0),
          fileCount: Number(value['fileCount'] ?? 0),
          externalImages: value['externalImages'] === true,
        });
      } catch (reason) {
        setError(displayError(reason));
      } finally {
        setLoading(false);
      }
    },
    [chatId],
  );

  const loadFiles = useCallback(async () => {
    try {
      const response = await api<JsonRecord>(`/v1/chats/${chatId}/files`);
      setFiles(
        objects(response['items']).flatMap((row) => {
          const parsed = managedChatFile(row);
          return parsed === null ? [] : [parsed];
        }),
      );
    } catch (reason) {
      setError(displayError(reason));
    }
  }, [chatId]);

  const loadExports = useCallback(
    async (artifactId: string) => {
      if (!exportsEnabled) {
        setExports([]);
        return;
      }
      const response = await api<JsonRecord>(`/v1/chats/${chatId}/exports`);
      setExports(
        objects(response['items']).flatMap((row) => {
          const parsed = artifactExport(row);
          return parsed !== null && parsed.artifactId === artifactId ? [parsed] : [];
        }),
      );
    },
    [chatId, exportsEnabled],
  );

  useEffect(() => {
    setOpen(false);
    setDirectory('');
    setItems([]);
    setFiles([]);
    setQuota(null);
    setSelected(null);
    setCreating(null);
    setExports([]);
    setPreviewExportId(null);
  }, [chatId]);

  useEffect(() => {
    setIngestSiloId((current) =>
      current !== null && silos.some(({ id }) => id === current) ? current : (silos[0]?.id ?? null),
    );
  }, [silos]);

  useEffect(() => {
    if (open) void Promise.all([loadDirectory(directory), loadFiles()]);
  }, [open]);

  useEffect(() => {
    if (
      selected === null ||
      !exports.some(({ state }) => ['queued', 'running', 'retry_wait'].includes(state))
    ) {
      return;
    }
    const timer = window.setInterval(() => void loadExports(selected.id), 1_500);
    return () => window.clearInterval(timer);
  }, [exports, loadExports, selected]);

  useEffect(() => {
    if (!open || selected !== null || creating !== null) return;
    const keys = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input,textarea,select') !== null) return;
      const controls = [
        ...(listRoot.current?.querySelectorAll<HTMLButtonElement>('[data-artifact-item]') ?? []),
      ];
      const focused = controls.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' && controls.length > 0) {
        event.preventDefault();
        controls[Math.min(controls.length - 1, focused + 1)]?.focus();
      } else if (event.key === 'ArrowUp' && controls.length > 0) {
        event.preventDefault();
        controls[Math.max(0, focused < 0 ? 0 : focused - 1)]?.focus();
      } else if (event.key === 'ArrowLeft' && directory !== '') {
        event.preventDefault();
        void loadDirectory(parentDirectory(directory));
      } else if (event.key === 'ArrowRight' && focused >= 0) {
        event.preventDefault();
        controls[focused]?.click();
      }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [creating, directory, loadDirectory, open, selected]);

  const openArtifact = async (item: Artifact) => {
    if (item.kind === 'directory') {
      await loadDirectory(item.path);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [markdown, revisions] = await Promise.all([
        readContent(chatId, item),
        api<JsonRecord>(`/v1/chats/${chatId}/artifacts/${item.id}/history`),
      ]);
      setSelected(item);
      setContent(markdown);
      setDraft(markdown);
      setHistory(
        objects(revisions['items']).flatMap((row) => {
          const parsed = revision(row);
          return parsed === null ? [] : [parsed];
        }),
      );
      await loadExports(item.id);
      setComparison(null);
      setPreviewExportId(null);
      setIngestSource('markdown');
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setLoading(false);
    }
  };

  const createItem = async (event: SubmitEvent) => {
    event.preventDefault();
    if (creating === null) return;
    setBusy(true);
    setError('');
    try {
      const path = joinPath(directory, newName.trim());
      if (creating === 'directory') {
        await postJson(`/v1/chats/${chatId}/artifacts/directories`, { path }, { idempotent: true });
      } else {
        await postJson(
          `/v1/chats/${chatId}/artifacts`,
          { path, content: newContent },
          { idempotent: true },
        );
      }
      setCreating(null);
      setNewName('');
      setNewContent('# New document\n\n');
      setNotice(creating === 'directory' ? 'Folder created.' : 'Markdown file created.');
      await loadDirectory(directory);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (selected?.sha256 === null || selected === null || draft === content) return;
    setBusy(true);
    setError('');
    try {
      const response = await postJson<JsonRecord>(
        `/v1/chats/${chatId}/artifacts/${selected.id}/content`,
        { expectedSha256: selected.sha256, patches: [linePatch(content, draft)] },
        { method: 'PATCH', idempotent: true },
      );
      const updated = artifact(response['artifact']);
      if (updated === null) throw new Error('The saved artifact response was incomplete.');
      setSelected(updated);
      setContent(String(response['content'] ?? draft));
      setDraft(String(response['content'] ?? draft));
      setNotice(`Saved revision ${String(updated.revision)}.`);
      const revisions = await api<JsonRecord>(
        `/v1/chats/${chatId}/artifacts/${updated.id}/history`,
      );
      setHistory(
        objects(revisions['items']).flatMap((row) => {
          const parsed = revision(row);
          return parsed === null ? [] : [parsed];
        }),
      );
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const moveOrCopy = async (operation: 'rename' | 'copy') => {
    if (selected === null) return;
    const destination = window.prompt(
      operation === 'rename'
        ? 'Move or rename to this workspace path'
        : 'Copy to this workspace path',
      selected.path,
    );
    if (destination === null || destination.trim() === '' || destination === selected.path) return;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${chatId}/artifacts/${selected.id}/${operation}`,
        { destination: destination.trim() },
        { idempotent: true },
      );
      setNotice(operation === 'rename' ? 'Artifact renamed.' : 'Artifact copied.');
      setSelected(null);
      await loadDirectory(directory);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      selected === null ||
      !window.confirm(
        `Delete “${selected.path}”? Revision history is retained according to Chat policy.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/v1/chats/${chatId}/artifacts/${selected.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'DELETE' }),
        idempotent: true,
      });
      setSelected(null);
      setNotice('Artifact deleted.');
      await loadDirectory(directory);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const compareRevision = async (number: number) => {
    if (selected === null) return;
    setBusy(true);
    try {
      setComparison({ revision: number, content: await readContent(chatId, selected, number) });
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const queueExport = async (format: 'docx' | 'pdf') => {
    if (selected === null) return;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${chatId}/artifacts/${selected.id}/exports`,
        { format, revision: selected.revision },
        { idempotent: true },
      );
      setNotice(`${format.toUpperCase()} export queued for revision ${String(selected.revision)}.`);
      await loadExports(selected.id);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelExport = async (item: ArtifactExport) => {
    if (selected === null || !window.confirm(`Cancel this ${item.format.toUpperCase()} export?`))
      return;
    setBusy(true);
    setError('');
    try {
      await postJson(`/v1/chats/${chatId}/exports/${item.id}/cancel`, {}, { idempotent: true });
      setNotice('Export cancellation requested.');
      await loadExports(selected.id);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const uploadToKnowledgeBase = async () => {
    if (selected === null || selected.sha256 === null || ingestSiloId === null) return;
    const exported =
      ingestSource === 'markdown' ? null : exports.find(({ id }) => id === ingestSource);
    if (
      exported !== null &&
      (exported === undefined || exported.state !== 'succeeded' || exported.outputSha256 === null)
    ) {
      setError('Choose a completed export or the current Markdown revision.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await postJson<JsonRecord>(
        `/v1/chats/${chatId}/artifacts/${selected.id}/ingestions`,
        {
          siloId: ingestSiloId,
          revision: selected.revision,
          sourceFormat: exported?.format ?? 'markdown',
          ...(exported === null ? {} : { exportId: exported.id }),
          expectedSha256: exported?.outputSha256 ?? selected.sha256,
        },
        { idempotent: true },
      );
      setNotice(
        `Immutable revision ${String(selected.revision)} was queued as document ${String(result['documentId'])}.`,
      );
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const uploadChatFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const uploaded = await api<ManagedChatFile>(`/v1/chats/${chatId}/files`, {
        method: 'POST',
        body,
        idempotent: true,
      });
      setNotice(`Uploaded ${uploaded.originalFilename}. Its ID-based website link is ready.`);
      await Promise.all([loadFiles(), loadDirectory(directory)]);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      input.value = '';
      setBusy(false);
    }
  };

  const copyFileReference = async (file: ManagedChatFile, markdown: boolean) => {
    const url = appUrl(file.websitePath);
    try {
      await navigator.clipboard.writeText(
        markdown ? `![${file.originalFilename.replaceAll(']', '\\]')}](${url})` : url,
      );
      setNotice(markdown ? 'Markdown image reference copied.' : 'Website file URL copied.');
    } catch {
      setError('Clipboard access is unavailable. Open the file link and copy its address instead.');
    }
  };

  const deleteChatFile = async (file: ManagedChatFile) => {
    if (!window.confirm(`Delete “${file.originalFilename}” from this chat?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/v1/chats/${chatId}/files/${file.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'DELETE' }),
        idempotent: true,
      });
      setNotice('Chat file deleted. Existing links to it will stop working.');
      await Promise.all([loadFiles(), loadDirectory(directory)]);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const breadcrumbs = useMemo(() => directory.split('/').filter(Boolean), [directory]);
  let breadcrumbPath = '';

  if (!enabled) return null;
  return (
    <>
      <button class="secondary" type="button" onClick={() => setOpen(true)}>
        <Icon name="documents" /> Artifacts
      </button>
      {open ? (
        <Modal
          title="Chat artifacts"
          wide
          className="chat-artifact-modal"
          close={() => !busy && setOpen(false)}
        >
          {error === '' ? null : <Notice kind="danger">{error}</Notice>}
          {notice === '' ? null : <Notice kind="success">{notice}</Notice>}
          {selected === null ? (
            <div class="chat-artifact-browser">
              <header class="chat-artifact-toolbar">
                <nav aria-label="Artifact folder">
                  <button type="button" class="text-button" onClick={() => void loadDirectory('')}>
                    Artifacts
                  </button>
                  {breadcrumbs.map((part) => {
                    breadcrumbPath = joinPath(breadcrumbPath, part);
                    const target = breadcrumbPath;
                    return (
                      <span>
                        {' / '}
                        <button
                          type="button"
                          class="text-button"
                          onClick={() => void loadDirectory(target)}
                        >
                          {part}
                        </button>
                      </span>
                    );
                  })}
                </nav>
                <div class="button-row">
                  <input
                    ref={uploadInput}
                    class="visually-hidden"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={(event) => void uploadChatFile(event)}
                  />
                  <button
                    type="button"
                    class="secondary"
                    disabled={busy}
                    onClick={() => uploadInput.current?.click()}
                  >
                    Upload image
                  </button>
                  <button type="button" class="secondary" onClick={() => setCreating('directory')}>
                    New folder
                  </button>
                  <button type="button" class="primary" onClick={() => setCreating('file')}>
                    <Icon name="plus" /> New Markdown
                  </button>
                </div>
              </header>
              {quota === null ? null : (
                <div class="chat-artifact-quota" aria-label="Artifact storage quota">
                  <span>
                    {formatBytes(quota.usedBytes)} of {formatBytes(quota.quotaBytes)} used ·{' '}
                    {String(quota.fileCount)} files
                  </span>
                  <progress max={Math.max(1, quota.quotaBytes)} value={quota.usedBytes} />
                  <small>Maximum single file: {formatBytes(quota.maximumFileBytes)}</small>
                </div>
              )}
              {creating === null ? null : (
                <form class="chat-artifact-create" onSubmit={(event) => void createItem(event)}>
                  <Field
                    label={creating === 'file' ? 'Markdown filename' : 'Folder name'}
                    {...(creating === 'file' ? { hint: 'Use a .md or .markdown filename.' } : {})}
                  >
                    <input
                      value={newName}
                      onInput={(event) => setNewName(event.currentTarget.value)}
                      placeholder={creating === 'file' ? 'notes.md' : 'folder'}
                      autoFocus
                      required
                    />
                  </Field>
                  {creating === 'file' ? (
                    <Field label="Starting Markdown">
                      <textarea
                        rows={6}
                        value={newContent}
                        onInput={(event) => setNewContent(event.currentTarget.value)}
                      />
                    </Field>
                  ) : null}
                  <div class="button-row end">
                    <button type="button" class="secondary" onClick={() => setCreating(null)}>
                      Cancel
                    </button>
                    <button class="primary" disabled={busy || newName.trim() === ''}>
                      {busy ? <Spinner /> : null} Create
                    </button>
                  </div>
                </form>
              )}
              {loading ? (
                <p>
                  <Spinner /> Loading artifacts…
                </p>
              ) : items.length === 0 ? (
                <EmptyState
                  title="This folder is empty"
                  detail="Create a Markdown file or folder here. The model can use the same safe workspace tools."
                />
              ) : (
                <div class="chat-artifact-list" ref={listRoot} role="list">
                  {items.map((item) => (
                    <div role="listitem">
                      <button
                        type="button"
                        data-artifact-item
                        class="chat-artifact-row"
                        onClick={() => void openArtifact(item)}
                      >
                        <Icon name="documents" />
                        <span>
                          <b>{item.name}</b>
                          <small>
                            {item.kind === 'directory'
                              ? 'Folder'
                              : `${formatBytes(item.bytes)} · revision ${String(item.revision)}`}
                          </small>
                        </span>
                        <span aria-hidden="true">›</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {directory === '' ? (
                <section class="chat-managed-files" aria-label="Chat files">
                  <header>
                    <div>
                      <h3>Chat files</h3>
                      <p>
                        These owner-only website links use the chat ID and file ID, so duplicate
                        filenames never collide. Copy a URL or a ready-to-paste Markdown image.
                      </p>
                    </div>
                  </header>
                  {files.length === 0 ? (
                    <small class="muted">No image files have been uploaded to this chat.</small>
                  ) : (
                    <div class="chat-managed-file-list">
                      {files.map((file) => (
                        <article class="chat-managed-file-row">
                          <img
                            src={appUrl(file.websitePath)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                          <div>
                            <b>{file.originalFilename}</b>
                            <small>
                              {formatBytes(file.bytes)} · ID {file.id}
                            </small>
                            <code>{appUrl(file.websitePath)}</code>
                          </div>
                          <div class="button-row">
                            <button
                              type="button"
                              class="secondary"
                              onClick={() => void copyFileReference(file, false)}
                            >
                              Copy URL
                            </button>
                            <button
                              type="button"
                              class="secondary"
                              onClick={() => void copyFileReference(file, true)}
                            >
                              Copy Markdown
                            </button>
                            <a
                              class="secondary button-link"
                              href={appUrl(file.websitePath)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Open
                            </a>
                            <button
                              type="button"
                              class="danger-button"
                              disabled={busy}
                              onClick={() => void deleteChatFile(file)}
                            >
                              Delete
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              ) : null}
              <small class="muted">Keyboard: ↑/↓ select · → open · ← parent folder</small>
            </div>
          ) : (
            <div class="chat-artifact-editor">
              <header class="chat-artifact-toolbar">
                <div>
                  <button type="button" class="text-button" onClick={() => setSelected(null)}>
                    ← Back to {directory === '' ? 'artifacts' : directory}
                  </button>
                  <h3>{selected.path}</h3>
                  <small>
                    Revision {String(selected.revision)} · {formatBytes(selected.bytes)}
                  </small>
                </div>
                <div class="button-row">
                  <a
                    class="secondary button-link"
                    href={appUrl(`/v1/chats/${chatId}/artifacts/${selected.id}/download`)}
                  >
                    Download
                  </a>
                  <button type="button" class="secondary" onClick={() => void moveOrCopy('copy')}>
                    Copy file
                  </button>
                  <button type="button" class="secondary" onClick={() => void moveOrCopy('rename')}>
                    Rename
                  </button>
                  <button type="button" class="danger-button" onClick={() => void remove()}>
                    Delete
                  </button>
                </div>
              </header>
              <div class="chat-artifact-edit-grid">
                <section>
                  <h4>Preview</h4>
                  <MarkdownViewer
                    markdown={draft}
                    colorScheme={colorScheme}
                    allowExternalImages={quota?.externalImages === true}
                  />
                </section>
                <section>
                  <h4>Edit Markdown</h4>
                  <textarea
                    class="chat-artifact-source-editor"
                    value={draft}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    spellcheck
                    aria-label="Edit Markdown"
                  />
                  <div class="button-row end">
                    <button
                      type="button"
                      class="secondary"
                      disabled={draft === content || busy}
                      onClick={() => setDraft(content)}
                    >
                      Discard edits
                    </button>
                    <button
                      type="button"
                      class="primary"
                      disabled={draft === content || busy}
                      onClick={() => void save()}
                    >
                      {busy ? <Spinner /> : null} Save new revision
                    </button>
                  </div>
                </section>
              </div>
              {exportsEnabled ? (
                <section class="chat-artifact-exports" aria-label="Document exports and ingestion">
                  <header>
                    <div>
                      <h4>DOCX and PDF exports</h4>
                      <p>
                        Exports use this exact immutable revision. They contain no macros, active
                        content, external relationships, or network-fetched images.
                      </p>
                    </div>
                    <div class="button-row">
                      <button
                        type="button"
                        class="secondary"
                        disabled={busy}
                        onClick={() => void queueExport('docx')}
                      >
                        Export DOCX
                      </button>
                      <button
                        type="button"
                        class="secondary"
                        disabled={busy}
                        onClick={() => void queueExport('pdf')}
                      >
                        Export PDF
                      </button>
                    </div>
                  </header>
                  {exports.length === 0 ? (
                    <small class="muted">No exports have been requested for this artifact.</small>
                  ) : (
                    <div class="chat-artifact-export-list">
                      {exports.map((item) => (
                        <article>
                          <div>
                            <b>
                              {item.format.toUpperCase()} · revision {String(item.sourceRevision)}
                            </b>
                            <small>
                              {item.state === 'succeeded'
                                ? `${formatBytes(item.outputBytes ?? 0)} · complete`
                                : item.state === 'failed'
                                  ? `Failed safely · ${item.errorCode ?? 'export failed'}`
                                  : item.state === 'cancelled'
                                    ? 'Cancelled'
                                    : `${item.phase} · ${String(item.progressPercent)}%`}
                            </small>
                            {['queued', 'running', 'retry_wait'].includes(item.state) ? (
                              <progress max={100} value={item.progressPercent} />
                            ) : null}
                            {item.warnings.length === 0 ? null : (
                              <small>{String(item.warnings.length)} visible export notes</small>
                            )}
                          </div>
                          <div class="button-row">
                            {item.state === 'succeeded' ? (
                              <>
                                {item.format === 'pdf' ? (
                                  <button
                                    type="button"
                                    class="secondary"
                                    onClick={() =>
                                      setPreviewExportId((current) =>
                                        current === item.id ? null : item.id,
                                      )
                                    }
                                  >
                                    {previewExportId === item.id ? 'Close preview' : 'Preview PDF'}
                                  </button>
                                ) : null}
                                <a
                                  class="secondary button-link"
                                  href={appUrl(`/v1/chats/${chatId}/exports/${item.id}/download`)}
                                >
                                  Download {item.format.toUpperCase()}
                                </a>
                              </>
                            ) : item.canCancel ? (
                              <button
                                type="button"
                                class="danger-button"
                                disabled={busy}
                                onClick={() => void cancelExport(item)}
                              >
                                Cancel
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {previewExportId === null ? null : (
                    <iframe
                      class="chat-artifact-pdf-preview"
                      title="Generated PDF preview"
                      src={appUrl(
                        `/v1/chats/${chatId}/exports/${previewExportId}/download?disposition=inline`,
                      )}
                    />
                  )}
                  <div class="chat-artifact-ingestion">
                    <div>
                      <h4>Upload to the RAG database</h4>
                      <p>
                        NodeRag snapshots this exact revision. Later edits do not change the queued
                        document, and deleting either copy does not purge the other.
                      </p>
                    </div>
                    <Field label="Knowledge base">
                      <select
                        value={ingestSiloId ?? ''}
                        onChange={(event) => setIngestSiloId(Number(event.currentTarget.value))}
                        disabled={silos.length === 0}
                      >
                        {silos.length === 0 ? (
                          <option value="">No assigned knowledge base</option>
                        ) : null}
                        {silos.map((silo) => (
                          <option value={silo.id}>{silo.displayName}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Snapshot format">
                      <select
                        value={ingestSource}
                        onChange={(event) => setIngestSource(event.currentTarget.value)}
                      >
                        <option value="markdown">
                          Markdown · revision {String(selected.revision)}
                        </option>
                        {exports
                          .filter(
                            (item) =>
                              item.state === 'succeeded' &&
                              item.sourceRevision === selected.revision &&
                              item.sourceSha256 === selected.sha256,
                          )
                          .map((item) => (
                            <option value={item.id}>
                              {item.format.toUpperCase()} · {item.filename ?? item.id}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <button
                      type="button"
                      class="primary"
                      disabled={busy || ingestSiloId === null || silos.length === 0}
                      onClick={() => void uploadToKnowledgeBase()}
                    >
                      Upload exact revision
                    </button>
                  </div>
                </section>
              ) : null}
              <details class="chat-artifact-history">
                <summary>Revision history ({String(history.length)})</summary>
                {history.map((item) => (
                  <div class="chat-artifact-revision">
                    <span>
                      <b>Revision {String(item.revision)}</b> · {formatBytes(item.bytes)} ·{' '}
                      {item.createdByKind} · {new Date(item.createdAt).toLocaleString()}
                      {item.sourceCitations.length === 0
                        ? ''
                        : ` · sources ${item.sourceCitations.join(', ')}`}
                    </span>
                    <button
                      type="button"
                      class="secondary"
                      disabled={item.revision === selected.revision || busy}
                      onClick={() => void compareRevision(item.revision)}
                    >
                      Compare with current
                    </button>
                  </div>
                ))}
              </details>
              {comparison === null ? null : (
                <section class="chat-artifact-comparison" aria-label="Revision comparison">
                  <header>
                    <h4>Revision {String(comparison.revision)} compared with current</h4>
                    <button type="button" class="secondary" onClick={() => setComparison(null)}>
                      Close comparison
                    </button>
                  </header>
                  <div>
                    <section>
                      <h5>Revision {String(comparison.revision)}</h5>
                      <pre>{comparison.content}</pre>
                    </section>
                    <section>
                      <h5>Current revision {String(selected.revision)}</h5>
                      <pre>{content}</pre>
                    </section>
                  </div>
                </section>
              )}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
};
