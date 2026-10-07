import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, displayError } from './api.js';
import { Icon, Modal, Notice, Spinner } from './components.js';

interface FolderEntry {
  readonly name: string;
  readonly path: string;
}

interface FolderListing {
  readonly currentPath: string | null;
  readonly parentPath: string | null;
  readonly selectable: boolean;
  readonly items: readonly FolderEntry[];
}

export const FolderBrowser = ({
  siloId,
  initialPath,
  choose,
  close,
}: {
  readonly siloId: number;
  readonly initialPath: string;
  readonly choose: (path: string) => void;
  readonly close: () => void;
}) => {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const browse = useCallback(
    async (path?: string) => {
      setBusy(true);
      setError('');
      const query = new URLSearchParams({ siloId: String(siloId) });
      if (path !== undefined && path.trim() !== '') query.set('path', path);
      try {
        setListing(await api<FolderListing>(`/v1/source-folders?${query.toString()}`));
      } catch (reason) {
        setError(displayError(reason));
      } finally {
        setBusy(false);
      }
    },
    [siloId],
  );

  useEffect(() => {
    void browse(initialPath.trim() === '' ? undefined : initialPath);
  }, [browse, initialPath]);

  return (
    <Modal title="Choose an input folder" wide close={close}>
      <p class="folder-browser-help">
        Start at the server's filesystem root and follow the visible folders to an allowed input
        location. Folders outside the configured source locations stay hidden and cannot be
        selected.
      </p>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {error ? (
        <button class="secondary" type="button" disabled={busy} onClick={() => void browse()}>
          Show allowed locations
        </button>
      ) : null}
      <div class="folder-browser-location">
        <div>
          <small>
            {listing?.currentPath === null
              ? 'Server filesystems'
              : listing?.selectable
                ? 'Selectable input folder'
                : 'Browse toward an allowed input folder'}
          </small>
          <code dir="auto">{listing?.currentPath ?? 'Choose a filesystem'}</code>
        </div>
        {listing?.parentPath === null || listing?.parentPath === undefined ? null : (
          <button
            class="secondary"
            type="button"
            disabled={busy}
            onClick={() => void browse(listing.parentPath ?? undefined)}
          >
            Up one folder
          </button>
        )}
      </div>
      <div class="folder-list" aria-busy={busy}>
        {busy && listing === null ? (
          <div class="folder-browser-loading">
            <Spinner />
            <span>Reading folders…</span>
          </div>
        ) : listing !== null && listing.items.length === 0 ? (
          <p class="muted">This folder has no subfolders.</p>
        ) : (
          listing?.items.map((item) => (
            <button
              class="folder-entry"
              type="button"
              disabled={busy}
              onClick={() => void browse(item.path)}
              aria-label={`Open folder ${item.name}`}
            >
              <Icon name="folder" />
              <span>
                <b>{item.name}</b>
                <small dir="auto">{item.path}</small>
              </span>
              <Icon name="arrow" />
            </button>
          ))
        )}
      </div>
      <div class="folder-browser-actions">
        <button class="secondary" type="button" onClick={close}>
          Cancel
        </button>
        <button
          class="primary"
          type="button"
          disabled={!listing?.selectable || busy}
          onClick={() => {
            if (listing?.selectable && listing.currentPath !== null) {
              choose(listing.currentPath);
            }
          }}
        >
          Use this folder
        </button>
      </div>
    </Modal>
  );
};
