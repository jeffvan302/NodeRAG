import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  displayError,
  postJson,
  truncateGraphemes,
  type JsonRecord,
  type Silo,
} from './api.js';
import { EmptyState, Field, Icon, Modal, Notice, SkeletonRows, Spinner } from './components.js';
import { MarkdownSearchViewer } from './markdown-search-viewer.js';
import { PdfViewer, type PdfEvidence } from './pdf-viewer.js';
import { appUrl } from './url.js';

type ColorScheme = 'light' | 'dark' | 'green' | 'blue' | 'red';

interface ResearchCollection {
  readonly id: number;
  readonly name: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const asText = (value: unknown, fallback = '—') =>
  typeof value === 'string' && value.length > 0 ? value : fallback;
const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const list = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
    : [];
const asCollections = (value: unknown): readonly ResearchCollection[] =>
  list(value).flatMap((item) => {
    const id = asNumber(item['id']);
    const name = item['name'];
    return Number.isSafeInteger(id) && id > 0 && typeof name === 'string'
      ? [
          {
            id,
            name,
            itemCount: asNumber(item['itemCount']),
            createdAt: asText(item['createdAt'], ''),
            updatedAt: asText(item['updatedAt'], ''),
          },
        ]
      : [];
  });
const asPdfEvidence = (value: unknown): readonly PdfEvidence[] =>
  list(value).flatMap((item) => {
    const kind = item['kind'];
    const text = item['text'];
    const confidence = Number(item['confidence']);
    return (kind === 'exact' || kind === 'semantic') &&
      typeof text === 'string' &&
      text.length > 0 &&
      Number.isFinite(confidence)
      ? [{ kind, text, confidence }]
      : [];
  });

const ReferenceLocation = ({ reference }: { readonly reference: JsonRecord }) => {
  const locator = (reference['locator'] as JsonRecord | undefined) ?? {};
  const silo = asText(reference['silo'], 'knowledge space');
  const page = asText(locator['pageLabel'], 'No page label');
  return (
    <span class="research-reference-location">
      {silo} · {page} · Confidence {String(Math.round(asNumber(reference['confidence']) * 100))}%
    </span>
  );
};

export const ResearchView = ({
  silos,
  colorScheme,
}: {
  readonly silos: readonly Silo[];
  readonly colorScheme: ColorScheme;
}) => {
  const [collections, setCollections] = useState<readonly ResearchCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [collectionsError, setCollectionsError] = useState('');
  const [selectedResearchId, setSelectedResearchId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState<readonly JsonRecord[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState('');
  const [hiddenItems, setHiddenItems] = useState(0);
  const [preview, setPreview] = useState<JsonRecord | null>(null);
  const [context, setContext] = useState<JsonRecord | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [markdownError, setMarkdownError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [researchBusyPage, setResearchBusyPage] = useState<number | null>(null);
  const [viewerFeedback, setViewerFeedback] = useState<
    { readonly kind: 'success' | 'danger'; readonly text: string } | undefined
  >();
  const markdownCache = useRef(new Map<number, string>());
  const previewRequest = useRef(0);

  const loadCollections = useCallback(async (preferId?: number) => {
    setCollectionsLoading(true);
    setCollectionsError('');
    try {
      const response = await api<JsonRecord>('/v1/research');
      const loaded = asCollections(response['items']);
      setCollections(loaded);
      setSelectedResearchId((current) => {
        const preferred = preferId ?? current;
        return preferred !== null && loaded.some(({ id }) => id === preferred)
          ? preferred
          : (loaded[0]?.id ?? null);
      });
    } catch (reason) {
      setCollectionsError(displayError(reason));
    } finally {
      setCollectionsLoading(false);
    }
  }, []);

  useEffect(() => void loadCollections(), [loadCollections]);

  useEffect(() => {
    if (selectedResearchId === null) {
      setItems([]);
      setHiddenItems(0);
      return;
    }
    let current = true;
    setItemsLoading(true);
    setItemsError('');
    setPreview(null);
    void api<JsonRecord>(`/v1/research/${String(selectedResearchId)}/items`)
      .then((response) => {
        if (!current) return;
        setItems(list(response['items']));
        setHiddenItems(asNumber(response['hidden']));
      })
      .catch((reason: unknown) => current && setItemsError(displayError(reason)))
      .finally(() => current && setItemsLoading(false));
    return () => {
      current = false;
    };
  }, [selectedResearchId]);

  const selectedResearch = collections.find(({ id }) => id === selectedResearchId) ?? null;

  const createResearch = async (event: SubmitEvent) => {
    event.preventDefault();
    setCreating(true);
    setCollectionsError('');
    setNotice('');
    try {
      const created = await postJson<ResearchCollection>(
        '/v1/research',
        { name: newName },
        { idempotent: true },
      );
      setNewName('');
      setNotice(`Created ${created.name}. You can now select passages for it from Search.`);
      await loadCollections(created.id);
    } catch (reason) {
      setCollectionsError(displayError(reason));
    } finally {
      setCreating(false);
    }
  };

  const openReference = async (reference: JsonRecord) => {
    const requestId = previewRequest.current + 1;
    previewRequest.current = requestId;
    const document = (reference['document'] as JsonRecord | undefined) ?? {};
    const documentId = asNumber(reference['documentId']);
    const isPdf = asText(document['format'], '').toLowerCase() === 'pdf';
    setPreview(reference);
    setContext(null);
    setPdfOpen(isPdf);
    setMarkdownOpen(!isPdf);
    setViewerFeedback(undefined);
    setMarkdownError('');
    const cached = markdownCache.current.get(documentId);
    if (isPdf) {
      setMarkdown('');
      setMarkdownLoading(false);
    } else {
      setMarkdown(cached ?? '');
      setMarkdownLoading(cached === undefined);
      if (cached === undefined) {
        void api<string>(`/v1/documents/${String(documentId)}/markdown`)
          .then((value) => {
            markdownCache.current.set(documentId, value);
            if (previewRequest.current !== requestId) return;
            setMarkdown(value);
            setMarkdownLoading(false);
          })
          .catch((reason: unknown) => {
            if (previewRequest.current !== requestId) return;
            setMarkdownError(`The extracted Markdown could not be opened: ${displayError(reason)}`);
            setMarkdownLoading(false);
          });
      }
    }
    void api<JsonRecord>(`/v1/chunks/${String(reference['chunkId'])}/context?before=1&after=1`)
      .then((value) => previewRequest.current === requestId && setContext(value))
      .catch(
        (reason: unknown) =>
          previewRequest.current === requestId && setContext({ error: displayError(reason) }),
      );
  };

  const removeReference = async (reference: JsonRecord) => {
    if (selectedResearch === null || removing) return;
    const document = (reference['document'] as JsonRecord | undefined) ?? {};
    const title = asText(document['title'], asText(reference['documentName'], 'this document'));
    const isPageReference = reference['referenceKind'] === 'page';
    const locator = (reference['locator'] as JsonRecord | undefined) ?? {};
    const pageNumber = Math.max(1, Math.trunc(asNumber(locator['pageStart'] ?? 1)));
    const referenceLabel = isPageReference ? `page ${String(pageNumber)}` : 'saved passage';
    if (
      !confirm(
        `Remove ${referenceLabel} from “${selectedResearch.name}”?\n\n${title}\n\nThe source document will not be deleted.`,
      )
    )
      return;
    setRemoving(true);
    setViewerFeedback(undefined);
    try {
      await api<JsonRecord>(
        `/v1/research/${String(selectedResearch.id)}/items/${String(reference['researchItemId'])}`,
        { method: 'DELETE', idempotent: true },
      );
      setItems((current) =>
        current.filter((item) => item['researchItemId'] !== reference['researchItemId']),
      );
      setPreview(null);
      setPdfOpen(false);
      setMarkdownOpen(false);
      setNotice(
        `Removed ${isPageReference ? `page ${String(pageNumber)}` : 'the passage'} from ${selectedResearch.name}.`,
      );
      await loadCollections(selectedResearch.id);
    } catch (reason) {
      setViewerFeedback({ kind: 'danger', text: displayError(reason) });
    } finally {
      setRemoving(false);
    }
  };

  const toggleResearchPage = async (reference: JsonRecord, pageNumber: number) => {
    if (selectedResearch === null || researchBusyPage !== null) return;
    const documentId = asNumber(reference['documentId']);
    const normalizedPage = Math.max(1, Math.trunc(pageNumber));
    const existing = items.find((item) => {
      if (asNumber(item['documentId']) !== documentId || item['referenceKind'] !== 'page')
        return false;
      const locator = (item['locator'] as JsonRecord | undefined) ?? {};
      return asNumber(locator['pageStart']) === normalizedPage;
    });
    if (
      existing !== undefined &&
      !confirm(
        `Remove page ${String(normalizedPage)} from “${selectedResearch.name}”?\n\nThe source document will not be deleted.`,
      )
    )
      return;
    setResearchBusyPage(normalizedPage);
    setViewerFeedback(undefined);
    try {
      if (existing !== undefined) {
        await api<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/items/${String(existing['researchItemId'])}`,
          { method: 'DELETE', idempotent: true },
        );
        setItems((current) =>
          current.filter((item) => item['researchItemId'] !== existing['researchItemId']),
        );
        setViewerFeedback({
          kind: 'success',
          text: `Removed page ${String(normalizedPage)} from ${selectedResearch.name}.`,
        });
      } else {
        const saved = await postJson<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/pages`,
          {
            siloId: asNumber(reference['siloId']),
            documentId,
            anchorChunkId: asNumber(reference['chunkId']),
            pageOrdinal: normalizedPage - 1,
            confidence: Math.min(1, Math.max(0, asNumber(reference['confidence']))),
            evidence: asPdfEvidence(reference['evidence']),
            query: asText(reference['query'], 'Saved research page'),
            mode: asText(reference['mode'], 'hybrid'),
          },
          { idempotent: true },
        );
        setItems((current) => [
          ...current.filter(
            (item) =>
              !(
                asNumber(item['documentId']) === documentId &&
                item['referenceKind'] === 'page' &&
                asNumber((item['locator'] as JsonRecord | undefined)?.['pageStart']) ===
                  normalizedPage
              ),
          ),
          saved,
        ]);
        setViewerFeedback({
          kind: 'success',
          text: `Saved page ${String(normalizedPage)} in ${selectedResearch.name}.`,
        });
      }
      await loadCollections(selectedResearch.id);
    } catch (reason) {
      setViewerFeedback({ kind: 'danger', text: displayError(reason) });
    } finally {
      setResearchBusyPage(null);
    }
  };

  const previewIndex =
    preview === null
      ? -1
      : items.findIndex((item) => item['researchItemId'] === preview['researchItemId']);
  const previousReference = previewIndex > 0 ? items[previewIndex - 1] : undefined;
  const nextReference =
    previewIndex >= 0 && previewIndex < items.length - 1 ? items[previewIndex + 1] : undefined;
  const navigation = useMemo(
    () => ({
      previous:
        previousReference === undefined ? null : () => void openReference(previousReference),
      next: nextReference === undefined ? null : () => void openReference(nextReference),
    }),
    [nextReference, previousReference],
  );
  const researchAction =
    preview === null || selectedResearch === null
      ? undefined
      : {
          researchName: selectedResearch.name,
          saved: true,
          busy: removing,
          ...(viewerFeedback === undefined ? {} : { feedback: viewerFeedback }),
          toggle: () => void removeReference(preview),
          page: {
            savedPages: new Set(
              items.flatMap((item) => {
                if (
                  item['referenceKind'] !== 'page' ||
                  asNumber(item['documentId']) !== asNumber(preview['documentId'])
                )
                  return [];
                const locator = (item['locator'] as JsonRecord | undefined) ?? {};
                const pageNumber = asNumber(locator['pageStart']);
                return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? [pageNumber] : [];
              }),
            ),
            busyPage: researchBusyPage,
            toggle: (pageNumber: number) => void toggleResearchPage(preview, pageNumber),
          },
        };

  useEffect(() => {
    if (preview === null || pdfOpen || markdownOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== '0' ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, select, textarea, [contenteditable="true"]') !== null
      )
        return;
      event.preventDefault();
      void removeReference(preview);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [markdownOpen, pdfOpen, preview, removing, selectedResearch]);

  return (
    <div class="page research-page">
      <header class="page-heading">
        <div>
          <p class="eyebrow">Saved source work</p>
          <h1>Research</h1>
          <p>Collect exact source passages across knowledge spaces and revisit them in order.</p>
        </div>
      </header>

      <section class="panel research-create-panel">
        <div>
          <h2>Create research</h2>
          <p>Use a clear project name, such as Legal Notes, Contract Review, or Tax Research.</p>
        </div>
        <form class="research-create-form" onSubmit={createResearch}>
          <Field label="Research name">
            <input
              aria-label="Research name"
              value={newName}
              maxLength={120}
              placeholder="Legal Notes"
              onInput={(event) => setNewName(event.currentTarget.value)}
              required
            />
          </Field>
          <button class="primary" disabled={creating || newName.trim() === ''}>
            {creating ? <Spinner /> : 'Create research'}
          </button>
        </form>
      </section>

      {collectionsError ? <Notice kind="danger">{collectionsError}</Notice> : null}
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {collectionsLoading ? (
        <SkeletonRows />
      ) : collections.length === 0 ? (
        <EmptyState
          title="No research yet"
          detail="Create your first research collection, then choose it at the top of Search before saving passages."
        />
      ) : (
        <>
          <section class="research-selector panel">
            <Field
              label="Open research"
              hint="Collections can contain references from several knowledge spaces."
            >
              <select
                aria-label="Open research"
                value={selectedResearchId ?? ''}
                onChange={(event) => setSelectedResearchId(Number(event.currentTarget.value))}
              >
                {collections.map((research) => (
                  <option value={research.id}>
                    {research.name} ({String(research.itemCount)})
                  </option>
                ))}
              </select>
            </Field>
            <p>
              Open a reference below. Use <kbd>↑</kbd>/<kbd>↓</kbd> for the previous or next saved
              passage, <kbd>←</kbd>/<kbd>→</kbd> inside the document, and <kbd>0</kbd> to save or
              remove the page currently shown in the PDF viewer.
            </p>
          </section>
          {hiddenItems > 0 ? (
            <Notice kind="warning">
              {String(hiddenItems)} saved {hiddenItems === 1 ? 'reference is' : 'references are'}
              hidden because your account no longer has access to the related knowledge space.
            </Notice>
          ) : null}
          {itemsError ? <Notice kind="danger">{itemsError}</Notice> : null}
          {itemsLoading ? (
            <SkeletonRows count={4} />
          ) : items.length === 0 ? (
            <EmptyState
              title={`Nothing saved in ${selectedResearch?.name ?? 'this research'}`}
              detail="Open Search, choose this research collection, then press 0 while viewing a useful passage."
            />
          ) : (
            <section class="research-reference-list" aria-label="Saved research references">
              {items.map((reference, index) => {
                const document = (reference['document'] as JsonRecord | undefined) ?? {};
                const siloName =
                  silos.find(({ id }) => id === asNumber(reference['siloId']))?.displayName ??
                  asText(reference['silo'], 'Knowledge space');
                return (
                  <article class="research-reference-card">
                    <button type="button" onClick={() => void openReference(reference)}>
                      <span class="research-reference-order">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span class="file-badge">
                        {asText(document['format'], 'DOC').toUpperCase()}
                      </span>
                      <span class="research-reference-content">
                        <b>
                          {asText(document['title'], asText(reference['documentName'], 'Document'))}
                        </b>
                        <small>
                          Saved in {selectedResearch?.name} · {siloName}
                        </small>
                        <span>{truncateGraphemes(asText(reference['text'], ''), 420)}</span>
                        <ReferenceLocation reference={{ ...reference, silo: siloName }} />
                      </span>
                    </button>
                    <button
                      class="secondary danger-action"
                      type="button"
                      disabled={removing}
                      onClick={() => void removeReference(reference)}
                    >
                      Remove
                    </button>
                  </article>
                );
              })}
            </section>
          )}
        </>
      )}

      {preview === null ? null : pdfOpen ? (
        <PdfViewer
          documentId={asNumber(preview['documentId'])}
          title={asText((preview['document'] as JsonRecord | undefined)?.['title'], 'Document')}
          initialPage={Math.max(
            1,
            Math.trunc(
              asNumber((preview['locator'] as JsonRecord | undefined)?.['pageStart'] ?? 1),
            ),
          )}
          citationKey={String(preview['researchItemId'])}
          confidence={asNumber(preview['confidence'])}
          citationPageEnd={Math.max(
            1,
            Math.trunc(
              asNumber(
                (preview['locator'] as JsonRecord | undefined)?.['pageEnd'] ??
                  (preview['locator'] as JsonRecord | undefined)?.['pageStart'] ??
                  1,
              ),
            ),
          )}
          evidence={asPdfEvidence(preview['evidence'])}
          searchNavigation={navigation}
          navigationLabel="research references"
          {...(researchAction === undefined ? {} : { researchAction })}
          showSourcePassage={() => setPdfOpen(false)}
          close={() => {
            setPdfOpen(false);
            setPreview(null);
          }}
        />
      ) : markdownOpen ? (
        <MarkdownSearchViewer
          documentId={asNumber(preview['documentId'])}
          title={asText((preview['document'] as JsonRecord | undefined)?.['title'], 'Document')}
          format={asText((preview['document'] as JsonRecord | undefined)?.['format'], 'document')}
          markdown={markdown}
          loading={markdownLoading}
          error={markdownError}
          colorScheme={colorScheme}
          confidence={asNumber(preview['confidence'])}
          citationKey={String(preview['researchItemId'])}
          citationText={asText(preview['text'], '')}
          citationCharacterStart={asNumber(
            (preview['locator'] as JsonRecord | undefined)?.['characterStart'],
          )}
          searchNavigation={navigation}
          navigationLabel="research references"
          {...(researchAction === undefined ? {} : { researchAction })}
          showSourcePassage={() => setMarkdownOpen(false)}
          close={() => {
            setMarkdownOpen(false);
            setPreview(null);
          }}
        />
      ) : (
        <Modal title="Saved source passage" wide close={() => setPreview(null)}>
          <div class="preview-toolbar">
            <button
              class="secondary danger-action"
              type="button"
              disabled={removing}
              onClick={() => void removeReference(preview)}
            >
              Remove from {selectedResearch?.name ?? 'research'} <kbd>0</kbd>
            </button>
            {asText(
              (preview['document'] as JsonRecord | undefined)?.['format'],
              '',
            ).toLowerCase() === 'pdf' ? (
              <button class="primary" type="button" onClick={() => setPdfOpen(true)}>
                <Icon name="documents" /> View PDF at cited page
              </button>
            ) : (
              <button class="primary" type="button" onClick={() => setMarkdownOpen(true)}>
                <Icon name="documents" /> View Markdown at cited passage
              </button>
            )}
            <a
              class="secondary button-link"
              href={appUrl(`/v1/documents/${String(preview['documentId'])}/original`)}
            >
              <Icon name="documents" /> Open original
            </a>
          </div>
          {viewerFeedback === undefined ? null : (
            <Notice kind={viewerFeedback.kind}>{viewerFeedback.text}</Notice>
          )}
          <p class="research-saved-query">
            Saved from {asText(preview['mode'], 'search')} search: “{asText(preview['query'], '')}”
          </p>
          {context === null ? (
            <SkeletonRows />
          ) : context['error'] ? (
            <Notice kind="warning">
              The live surrounding passages are no longer available. The saved passage remains
              below.
            </Notice>
          ) : (
            <div class="context-stack">
              {list(context['items']).map((item) => (
                <section
                  class={
                    item['chunkId'] === preview['chunkId'] ? 'context-item match' : 'context-item'
                  }
                >
                  <small>Passage {String(asNumber(item['ordinal']) + 1)}</small>
                  <p dir="auto">{asText(item['text'])}</p>
                </section>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};
