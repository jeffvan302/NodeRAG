import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  displayError,
  formatBytes,
  postJson,
  signOut,
  truncateGraphemes,
  type JsonRecord,
  type Principal,
  type Silo,
} from './api.js';
import {
  EmptyState,
  Field,
  Icon,
  Modal,
  Notice,
  SkeletonRows,
  Spinner,
  StatusPill,
} from './components.js';

type Page = 'search' | 'documents' | 'ingest' | 'activity' | 'admin';

const asText = (value: unknown, fallback = '—') =>
  typeof value === 'string' && value.length > 0 ? value : fallback;
const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const list = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
    : [];

const useLoad = (path: string | null, refresh = 0) => {
  const [data, setData] = useState<JsonRecord | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (path === null) return;
    let current = true;
    setError('');
    void api<JsonRecord>(path)
      .then((value) => current && setData(value))
      .catch((reason) => current && setError(displayError(reason)));
    return () => {
      current = false;
    };
  }, [path, refresh]);
  return { data, error };
};

const PageHeading = ({
  eyebrow,
  title,
  detail,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly action?: preact.ComponentChildren;
}) => (
  <header class="page-heading">
    <div>
      <p class="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
    {action}
  </header>
);

const SearchView = ({ silos }: { readonly silos: readonly Silo[] }) => {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('vector');
  const [selectedSilos, setSelectedSilos] = useState<number[]>(silos.map((silo) => silo.id));
  const [results, setResults] = useState<JsonRecord[] | null>(null);
  const [meta, setMeta] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<JsonRecord | null>(null);
  const [context, setContext] = useState<JsonRecord | null>(null);

  const search = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setPreview(null);
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const filters: JsonRecord = {};
    const pathPrefix = String(form.get('pathPrefix') ?? '');
    const format = String(form.get('format') ?? '');
    if (pathPrefix) filters['pathPrefix'] = pathPrefix;
    if (format) filters['formats'] = [format];
    const sourceIds = String(form.get('sourceIds') ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    if (sourceIds.length > 0) filters['sourceIds'] = sourceIds;
    for (const field of ['createdFrom', 'createdTo', 'modifiedFrom', 'modifiedTo'] as const) {
      const value = String(form.get(field) ?? '');
      if (value) filters[field] = new Date(value).toISOString();
    }
    for (const field of ['pageFrom', 'pageTo'] as const) {
      const value = String(form.get(field) ?? '');
      if (value) filters[field] = Math.max(0, Number(value) - 1);
    }
    if (form.get('hasImages') === 'on') filters['hasImages'] = true;
    if (form.get('hasTables') === 'on') filters['hasTables'] = true;
    try {
      const response = await postJson<JsonRecord>('/v1/search', {
        query,
        mode,
        silos: selectedSilos,
        filters,
        limit: 20,
        rerank: false,
      });
      setResults(list(response['items']));
      setMeta(
        `${String(response['elapsedMs'] ?? 0)} ms · ${list(response['items']).length} passages`,
      );
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (hit: JsonRecord) => {
    setPreview(hit);
    setContext(null);
    try {
      setContext(
        await api<JsonRecord>(`/v1/chunks/${String(hit['chunkId'])}/context?before=1&after=1`),
      );
    } catch (reason) {
      setContext({ error: displayError(reason) });
    }
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, JsonRecord[]>();
    for (const item of results ?? []) {
      const key = String(item['documentId']);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()];
  }, [results]);

  return (
    <div class="page search-page">
      <PageHeading
        eyebrow="Knowledge search"
        title="Ask your documents"
        detail="Every result links back to its exact source and surrounding passage."
      />
      <form class="search-form" onSubmit={search}>
        <div class="search-box">
          <Icon name="search" />
          <input
            aria-label="Search your knowledge"
            placeholder="What do you want to find?"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            required
            autoFocus
          />
          <button class="primary" disabled={busy || query.trim() === ''}>
            {busy ? <Spinner /> : 'Search'}
          </button>
        </div>
        <div class="search-options">
          <div class="segmented" aria-label="Search method">
            {(
              [
                ['vector', 'Meaning'],
                ['keyword', 'Keyword'],
                ['hybrid', 'Both'],
              ] as const
            ).map(([value, label]) => (
              <button
                class={mode === value ? 'selected' : ''}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div class="chip-row" aria-label="Knowledge spaces">
            {silos.map((silo) => (
              <button
                class={selectedSilos.includes(silo.id) ? 'chip selected' : 'chip'}
                type="button"
                aria-pressed={selectedSilos.includes(silo.id)}
                onClick={() =>
                  setSelectedSilos((current) =>
                    current.includes(silo.id)
                      ? current.filter((id) => id !== silo.id)
                      : [...current, silo.id],
                  )
                }
              >
                {silo.displayName}
              </button>
            ))}
          </div>
          <details class="filters">
            <summary>Filters</summary>
            <div class="filter-grid">
              <Field label="Path begins with">
                <input name="pathPrefix" placeholder="policies/" />
              </Field>
              <Field label="Source IDs">
                <input name="sourceIds" inputMode="numeric" placeholder="2, 7" />
              </Field>
              <Field label="File type">
                <select name="format">
                  <option value="">Any type</option>
                  <option>pdf</option>
                  <option>docx</option>
                  <option>xlsx</option>
                  <option>md</option>
                  <option>txt</option>
                </select>
              </Field>
              <Field label="Created after">
                <input name="createdFrom" type="datetime-local" />
              </Field>
              <Field label="Created before">
                <input name="createdTo" type="datetime-local" />
              </Field>
              <Field label="Modified after">
                <input name="modifiedFrom" type="datetime-local" />
              </Field>
              <Field label="Modified before">
                <input name="modifiedTo" type="datetime-local" />
              </Field>
              <Field label="Page from">
                <input name="pageFrom" type="number" min="1" />
              </Field>
              <Field label="Page to">
                <input name="pageTo" type="number" min="1" />
              </Field>
              <label class="checkbox">
                <input name="hasImages" type="checkbox" />
                Contains images
              </label>
              <label class="checkbox">
                <input name="hasTables" type="checkbox" />
                Contains tables
              </label>
            </div>
          </details>
        </div>
      </form>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {results === null ? (
        <div class="search-intro">
          <div>
            <span>01</span>
            <b>Choose a search method</b>
            <p>Meaning finds related ideas. Keyword finds exact wording. Both combines them.</p>
          </div>
          <div>
            <span>02</span>
            <b>Trace every answer</b>
            <p>Open a result to inspect surrounding text, pages, and the original file.</p>
          </div>
          <div>
            <span>03</span>
            <b>Keep boundaries intact</b>
            <p>You only search knowledge spaces your account can access.</p>
          </div>
        </div>
      ) : results.length === 0 ? (
        <EmptyState
          title="No passages found"
          detail="Try fewer filters, another knowledge space, or different wording."
        />
      ) : (
        <section class="results">
          <div class="results-meta">
            <b>Results</b>
            <span>{meta}</span>
          </div>
          {grouped.map((group) => {
            const first = group[0] ?? {};
            const document = (
              typeof first['document'] === 'object' && first['document'] !== null
                ? first['document']
                : {}
            ) as JsonRecord;
            return (
              <article class="result-group">
                <header>
                  <div>
                    <span class="file-badge">
                      {asText(document['format'], 'DOC').toUpperCase()}
                    </span>
                    <div>
                      <h2>
                        {asText(document['title'], asText(document['name'], 'Untitled document'))}
                      </h2>
                      <p dir="auto">{asText(document['path'])}</p>
                    </div>
                  </div>
                  <span>
                    {group.length} {group.length === 1 ? 'passage' : 'passages'}
                  </span>
                </header>
                {group.map((hit) => {
                  const locator = (
                    typeof hit['locator'] === 'object' && hit['locator'] !== null
                      ? hit['locator']
                      : {}
                  ) as JsonRecord;
                  const pageLabel = asText(locator['pageLabel'], '');
                  return (
                    <button class="passage" type="button" onClick={() => void openPreview(hit)}>
                      <span class="passage-meta">
                        {Array.isArray(hit['headingPath'])
                          ? hit['headingPath'].join(' › ')
                          : 'Document'}
                        {pageLabel === '' ? ' · No page label' : ` · ${pageLabel}`}
                      </span>
                      <span class="passage-text" dir="auto">
                        {truncateGraphemes(asText(hit['text'], ''), 420)}
                      </span>
                      <span class="score">{Math.round(asNumber(hit['score']) * 100)}%</span>
                    </button>
                  );
                })}
              </article>
            );
          })}
        </section>
      )}
      {preview === null ? null : (
        <Modal title="Source passage" wide close={() => setPreview(null)}>
          <div class="preview-toolbar">
            <button
              class="secondary"
              onClick={() => {
                const document =
                  typeof preview['document'] === 'object' && preview['document'] !== null
                    ? (preview['document'] as JsonRecord)
                    : {};
                const locator =
                  typeof preview['locator'] === 'object' && preview['locator'] !== null
                    ? (preview['locator'] as JsonRecord)
                    : {};
                const citation = `${asText(document['title'], asText(document['name'], 'Document'))} — ${asText(locator['pageLabel'], 'location not paginated')}\n${asText(preview['text'], '')}\nNodeRag document ${String(preview['documentId'])}, passage ${String(preview['chunkId'])}`;
                void navigator.clipboard.writeText(citation);
              }}
            >
              <Icon name="copy" />
              Copy citation
            </button>
            <a
              class="secondary button-link"
              href={`/v1/documents/${String(preview['documentId'])}/original`}
            >
              <Icon name="documents" />
              Open original
            </a>
          </div>
          {context === null ? (
            <SkeletonRows />
          ) : context['error'] ? (
            <Notice kind="danger">{String(context['error'])}</Notice>
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

const DocumentsView = ({ silos }: { readonly silos: readonly Silo[] }) => {
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<JsonRecord | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const loaded = useLoad(`/v1/documents?limit=100${filter ? `&state=${filter}` : ''}`, refresh);
  const docs = list(loaded.data?.['items']);
  const open = async (document: JsonRecord) => {
    setSelected(document);
    setMarkdown('');
    try {
      setMarkdown(await api<string>(`/v1/documents/${String(document['id'])}/markdown`));
    } catch (reason) {
      setMarkdown(`Unable to open extracted text: ${displayError(reason)}`);
    }
  };
  const action = async (kind: 'reindex' | 'delete' | 'review') => {
    if (selected === null) return;
    if (
      kind === 'delete' &&
      window.prompt(`Type document ${String(selected['id'])} to confirm permanent purge`) !==
        `document ${String(selected['id'])}`
    )
      return;
    const reviewNote =
      kind === 'review' ? window.prompt('Add an operator note for this missing source') : null;
    if (
      kind === 'review' &&
      (reviewNote === null || reviewNote.trim() === '' || selected['sourceId'] === null)
    )
      return;
    setError('');
    try {
      if (kind === 'review') {
        await postJson(
          `/v1/sources/${String(selected['sourceId'])}/review-missing`,
          {
            siloId: selected['siloId'],
            documentId: selected['id'],
            operatorNote: reviewNote,
          },
          { idempotent: true },
        );
        setSelected({ ...selected, missingReviewed: true });
        return;
      }
      const path = `/v1/documents/${String(selected['id'])}${kind === 'reindex' ? '/reindex' : ''}`;
      await api(path, {
        method: kind === 'delete' ? 'DELETE' : 'POST',
        body: JSON.stringify({
          siloId: selected['siloId'],
          ...(kind === 'delete' ? { confirmDocumentId: selected['id'] } : {}),
        }),
        idempotent: true,
      });
      setSelected(null);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  return (
    <div class="page">
      <PageHeading
        eyebrow="Library"
        title="Documents"
        detail="Review indexed files, extraction status, pages, images, and missing sources."
        action={
          <select
            aria-label="Filter document state"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            <option value="">All states</option>
            <option value="ready">Ready</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="source_missing">Source missing</option>
          </select>
        }
      />
      {loaded.error || error ? <Notice kind="danger">{loaded.error || error}</Notice> : null}
      {loaded.data === null ? (
        <SkeletonRows count={5} />
      ) : docs.length === 0 ? (
        <EmptyState
          title="No documents yet"
          detail="Upload a file or connect a source folder from Ingest."
        />
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Space</th>
                <th>Status</th>
                <th>Size</th>
                <th>Pages</th>
                <th>Images</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr
                  tabIndex={0}
                  onClick={() => void open(doc)}
                  onKeyDown={(event) => event.key === 'Enter' && void open(doc)}
                >
                  <td>
                    <b>{asText(doc['title'], asText(doc['name']))}</b>
                    <small dir="auto">{asText(doc['path'])}</small>
                  </td>
                  <td>
                    {silos.find((silo) => silo.id === asNumber(doc['siloId']))?.displayName ??
                      String(doc['siloId'])}
                  </td>
                  <td>
                    <StatusPill value={asText(doc['state'])} />
                  </td>
                  <td>{formatBytes(doc['bytes'])}</td>
                  <td>{String(doc['pages'] ?? '—')}</td>
                  <td>{String(doc['imageCount'] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected === null ? null : (
        <Modal
          title={asText(selected['title'], asText(selected['name']))}
          wide
          close={() => setSelected(null)}
        >
          <div class="document-summary">
            <StatusPill value={asText(selected['state'])} />
            <span>{asText(selected['format']).toUpperCase()}</span>
            <span>{formatBytes(selected['bytes'])}</span>
            <span>{String(selected['pages'] ?? 'No')} pages</span>
            <span>{asText(selected['pageBasis'], 'no page basis').replaceAll('_', ' ')}</span>
            <span>{String(selected['imageCount'] ?? 0)} images</span>
          </div>
          {selected['offsetsMatchOriginal'] === false ? (
            <Notice kind="info">
              Locators refer to NodeRag's canonical extraction; source-file text offsets may differ.
            </Notice>
          ) : null}
          {selected['sourceState'] === 'missing' ? (
            <Notice kind="warning">
              The source file is missing. Extracted text remains searchable until you purge it.
              {selected['missingReviewed'] ? <b> Review recorded.</b> : null}
            </Notice>
          ) : null}
          <pre class="markdown-preview" dir="auto">
            {markdown || 'Loading extracted text…'}
          </pre>
          <div class="button-row">
            <a
              class="primary button-link"
              href={`/v1/documents/${String(selected['id'])}/original`}
            >
              Open original
            </a>
            {selected['sourceState'] === 'missing' && selected['sourceId'] !== null ? (
              <button class="secondary" onClick={() => void action('review')}>
                Record review
              </button>
            ) : null}
            <button class="secondary" onClick={() => void action('reindex')}>
              Re-index
            </button>
            <button class="danger-button" onClick={() => void action('delete')}>
              Purge document
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

const IngestView = ({ silos }: { readonly silos: readonly Silo[] }) => {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const sources = useLoad('/v1/sources', refresh);
  const jobs = useLoad('/v1/jobs', refresh);
  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 8000);
    return () => window.clearInterval(timer);
  }, []);
  const upload = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const siloId = String(form.get('siloId'));
    const file = form.get('file');
    if (!(file instanceof File)) return;
    const body = new FormData();
    body.append('file', file);
    setBusy(true);
    setError('');
    try {
      await api(`/v1/documents?siloId=${siloId}`, { method: 'POST', body, idempotent: true });
      setMessage(`${file.name} was added to the queue.`);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  const addSource = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setBusy(true);
    setError('');
    try {
      await postJson(
        '/v1/sources',
        {
          siloId: Number(form.get('siloId')),
          uri: String(form.get('uri')),
          includeGlobs: String(form.get('include'))
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          excludeGlobs: String(form.get('exclude'))
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          scheduleIntervalMinutes: Number(form.get('schedule')) || null,
        },
        { idempotent: true },
      );
      setMessage('Source mapping saved.');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  const jobAction = async (job: JsonRecord, action: string) => {
    setError('');
    try {
      await postJson(
        `/v1/jobs/${String(job['id'])}/${action}`,
        { siloId: job['siloId'] },
        { idempotent: true },
      );
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  return (
    <div class="page">
      <PageHeading
        eyebrow="Bring knowledge in"
        title="Ingest"
        detail="Upload individual files, map shared folders, and watch every durable job."
      />
      {message ? <Notice kind="success">{message}</Notice> : null}
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <div class="card-grid two">
        <section class="panel">
          <h2>Upload a file</h2>
          <p>PDF, Word, Excel, Markdown, or text up to the server limit.</p>
          <form onSubmit={upload}>
            <Field label="Knowledge space">
              <select name="siloId">
                {silos.map((silo) => (
                  <option value={silo.id}>{silo.displayName}</option>
                ))}
              </select>
            </Field>
            <Field label="Choose file">
              <input name="file" type="file" accept=".pdf,.docx,.xlsx,.md,.txt" required />
            </Field>
            <button class="primary" disabled={busy}>
              {busy ? <Spinner /> : null}Add to queue
            </button>
          </form>
        </section>
        <section class="panel">
          <h2>Connect an input folder</h2>
          <p>
            This is a source folder that NodeRag reads and watches for new or changed files. It is
            not NodeRag's managed storage, and NodeRag does not modify the source files.
          </p>
          <form onSubmit={addSource}>
            <Field label="Knowledge space">
              <select name="siloId">
                {silos.map((silo) => (
                  <option value={silo.id}>{silo.displayName}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Source folder path"
              hint="The folder must already be shared with the NodeRag service account. Each supported file is copied into protected managed storage before processing."
            >
              <input name="uri" placeholder="/data/handbooks" required />
            </Field>
            <div class="field-grid">
              <Field label="Include patterns">
                <input name="include" defaultValue="**/*.md, **/*.pdf" />
              </Field>
              <Field label="Exclude patterns">
                <input name="exclude" defaultValue="**/.git/**, **/~$*" />
              </Field>
            </div>
            <Field label="Repeat every (minutes)">
              <input name="schedule" type="number" min="1" placeholder="Manual only" />
            </Field>
            <button class="primary" disabled={busy}>
              Verify and connect
            </button>
          </form>
        </section>
      </div>
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Live queue</h2>
            <p>Refreshes every eight seconds. Work resumes safely after a restart.</p>
          </div>
          <button class="secondary" onClick={() => setRefresh((v) => v + 1)}>
            Refresh
          </button>
        </div>
        {jobs.data === null ? (
          <SkeletonRows />
        ) : list(jobs.data['items']).length === 0 ? (
          <EmptyState
            title="The queue is clear"
            detail="New uploads and source crawls appear here."
          />
        ) : (
          <div class="job-list">
            {list(jobs.data['items']).map((job) => (
              <article class="job">
                <div>
                  <StatusPill value={asText(job['state'])} />
                  <b>
                    {asText(job['kind'])} #{String(job['id'])}
                  </b>
                  <small>
                    Attempt {String(job['logicalAttempt'] ?? 0)} of{' '}
                    {String(job['maximumAttempts'] ?? 0)}
                  </small>
                </div>
                <progress
                  max="100"
                  value={asNumber((job['progress'] as JsonRecord | undefined)?.['percent'] ?? 0)}
                />
                <div class="job-actions">
                  {job['state'] === 'running' ? (
                    <button onClick={() => void jobAction(job, 'pause')}>Pause</button>
                  ) : null}
                  {job['state'] === 'paused' ? (
                    <button onClick={() => void jobAction(job, 'resume')}>Resume</button>
                  ) : null}
                  {job['state'] === 'failed' ? (
                    <button onClick={() => void jobAction(job, 'retry')}>Retry</button>
                  ) : null}
                  {['queued', 'running', 'paused'].includes(asText(job['state'], '')) ? (
                    <button onClick={() => void jobAction(job, 'cancel')}>Cancel</button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section class="panel">
        <h2>Connected input folders</h2>
        {sources.data === null ? (
          <SkeletonRows />
        ) : list(sources.data['items']).length === 0 ? (
          <p class="muted">No folders connected.</p>
        ) : (
          <div class="compact-list">
            {list(sources.data['items']).map((source) => (
              <div>
                <b dir="auto">{asText(source['uri'])}</b>
                <StatusPill value={asText(source['healthState'])} />
                <small>
                  {source['scheduleEnabled']
                    ? `Every ${String(source['scheduleIntervalMinutes'])} minutes`
                    : 'Manual crawl'}
                </small>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const ActivityView = () => {
  const [refresh, setRefresh] = useState(0);
  const health = useLoad('/v1/admin/health', refresh);
  const ready = useLoad('/ready', refresh);
  const jobs = useLoad('/v1/jobs', refresh);
  return (
    <div class="page">
      <PageHeading
        eyebrow="System activity"
        title="Operations"
        detail="Readiness, queue pressure, failures, and actionable recovery in one place."
        action={
          <button class="secondary" onClick={() => setRefresh((v) => v + 1)}>
            Refresh
          </button>
        }
      />
      {health.error ? <Notice kind="danger">{health.error}</Notice> : null}
      <div class="metric-grid">
        <article>
          <span>Service</span>
          <strong>{asText(ready.data?.['status'], 'Checking…')}</strong>
          <StatusPill value={asText(ready.data?.['state'], 'loading')} />
        </article>
        <article>
          <span>Queue</span>
          <strong>
            {
              list(jobs.data?.['items']).filter((job) =>
                ['queued', 'running'].includes(asText(job['state'], '')),
              ).length
            }
          </strong>
          <small>active jobs</small>
        </article>
        <article>
          <span>Failures</span>
          <strong>
            {list(jobs.data?.['items']).filter((job) => job['state'] === 'failed').length}
          </strong>
          <small>need attention</small>
        </article>
        <article>
          <span>Migration</span>
          <strong>{asText(ready.data?.['migrationHead'])}</strong>
          <small>database head</small>
        </article>
      </div>
      <section class="panel">
        <h2>Readiness details</h2>
        {ready.data === null ? (
          <SkeletonRows />
        ) : (
          <pre class="json-summary">{JSON.stringify(ready.data, null, 2)}</pre>
        )}
      </section>
      <section class="panel">
        <h2>Health signals</h2>
        {health.data === null ? (
          <SkeletonRows />
        ) : (
          <pre class="json-summary">{JSON.stringify(health.data, null, 2)}</pre>
        )}
      </section>
    </div>
  );
};

const EvaluationPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: (message: string, error?: boolean) => void;
}) => {
  const cases = list(data['cases']);
  const runs = list(data['runs']);
  const baselines = list(data['baselines']);
  const alerts = list(data['alerts']);
  const mutateEvaluation = async (body: JsonRecord, success: string) => {
    try {
      await postJson('/v1/admin/evaluation', body, { idempotent: true });
      report(success);
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  const addCase = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const pages = String(form.get('pages') ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const sheets = String(form.get('sheets') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const relevance: JsonRecord = {
      document: String(form.get('document')),
      ...(String(form.get('sha256') ?? '') === '' ? {} : { sha256: String(form.get('sha256')) }),
      ...(pages.length === 0 ? {} : { pages }),
      ...(sheets.length === 0 ? {} : { sheets }),
    };
    await mutateEvaluation(
      {
        action: 'add_case',
        externalId: String(form.get('externalId')),
        siloId: Number(form.get('siloId')),
        query: String(form.get('query')),
        queryClass: String(form.get('queryClass')),
        expectedFormat: String(form.get('expectedFormat')),
        answerable: true,
        relevant: [relevance],
      },
      'Draft evaluation case added.',
    );
  };
  const queue = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const modes = ['vector', 'keyword', 'hybrid'].filter((mode) => form.get(mode) === 'on');
    await mutateEvaluation(
      {
        action: 'queue_run',
        modes,
        workload: String(form.get('workload')),
        environment: { initiatedFrom: 'operator-ui' },
      },
      'Pinned evaluation runs queued.',
    );
  };
  const latest = runs[0];
  const latestMetrics =
    typeof latest?.['metrics'] === 'object' && latest['metrics'] !== null
      ? (latest['metrics'] as JsonRecord)
      : {};
  return (
    <div class="evaluation-console">
      <div class="metric-grid">
        <article>
          <span>Approved cases</span>
          <strong>{cases.filter((item) => item['curationState'] === 'approved').length}</strong>
          <small>{cases.length} total curated records</small>
        </article>
        <article>
          <span>Recall at 10</span>
          <strong>{Math.round(asNumber(latestMetrics['recallAt10']) * 100)}%</strong>
          <small>release gate: at least 85%</small>
        </article>
        <article>
          <span>p95 latency</span>
          <strong>
            {asNumber((latestMetrics['latencyMs'] as JsonRecord | undefined)?.['p95'])} ms
          </strong>
          <small>idle gate: at most 3,000 ms</small>
        </article>
        <article>
          <span>Open alerts</span>
          <strong>{alerts.length}</strong>
          <small>leakage and locator errors block release</small>
        </article>
      </div>
      <section class="evaluation-card">
        <h3>Queue a pinned comparison</h3>
        <p>Every run freezes the commit, migration, model, build, settings, and approved corpus.</p>
        <form class="inline-form" onSubmit={queue}>
          <label class="checkbox">
            <input name="vector" type="checkbox" defaultChecked />
            Meaning
          </label>
          <label class="checkbox">
            <input name="keyword" type="checkbox" defaultChecked />
            Keyword
          </label>
          <label class="checkbox">
            <input name="hybrid" type="checkbox" defaultChecked />
            Both
          </label>
          <Field label="Workload">
            <select name="workload">
              <option value="idle">Idle</option>
              <option value="ingest">During ingest</option>
            </select>
          </Field>
          <button class="primary">Queue comparison</button>
        </form>
      </section>
      <section class="evaluation-card">
        <h3>Add a curation draft</h3>
        <form class="evaluation-form" onSubmit={addCase}>
          <Field label="Case ID">
            <input name="externalId" required />
          </Field>
          <Field label="Knowledge space ID">
            <input name="siloId" type="number" min="1" required />
          </Field>
          <Field label="Question">
            <input name="query" required />
          </Field>
          <Field label="Question type">
            <select name="queryClass">
              <option value="semantic">Meaning</option>
              <option value="exact_identifier">Exact identifier</option>
              <option value="exact_name">Exact name</option>
              <option value="error_code">Error code</option>
              <option value="quoted_phrase">Quoted phrase</option>
              <option value="cross_page">Across pages</option>
              <option value="table">Table</option>
              <option value="vision">Image/scan</option>
              <option value="multilingual">Multilingual</option>
              <option value="unicode">Unicode</option>
            </select>
          </Field>
          <Field label="File type">
            <select name="expectedFormat">
              {['pdf', 'docx', 'xlsx', 'txt', 'md'].map((format) => (
                <option>{format}</option>
              ))}
            </select>
          </Field>
          <Field label="Document path">
            <input name="document" required />
          </Field>
          <Field label="Document SHA-256">
            <input name="sha256" pattern="[a-f0-9]{64}" />
          </Field>
          <Field label="Pages (comma separated)">
            <input name="pages" placeholder="3, 4" />
          </Field>
          <Field label="Sheets (comma separated)">
            <input name="sheets" placeholder="Quality Thresholds" />
          </Field>
          <button class="secondary">Add draft</button>
        </form>
      </section>
      <section class="evaluation-card">
        <h3>Curated cases</h3>
        {cases.length === 0 ? (
          <p class="muted">No cases have been curated.</p>
        ) : (
          <div class="record-list">
            {cases.map((item) => (
              <article>
                <div>
                  <b>{asText(item['externalId'])}</b>
                  <small>
                    {asText(item['query'])} · {asText(item['queryClass'])} ·{' '}
                    {asText(item['curationState'])}
                  </small>
                </div>
                <div class="compact-buttons">
                  <button
                    onClick={() =>
                      void mutateEvaluation(
                        { action: 'set_case_state', caseId: item['id'], state: 'approved' },
                        'Case approved.',
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    onClick={() =>
                      void mutateEvaluation(
                        { action: 'set_case_state', caseId: item['id'], state: 'rejected' },
                        'Case rejected.',
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section class="evaluation-card">
        <h3>Runs and accepted baselines</h3>
        <p>
          {baselines.length} active baseline{baselines.length === 1 ? '' : 's'}.
        </p>
        <div class="record-list">
          {runs.map((run) => {
            const metrics =
              typeof run['metrics'] === 'object' && run['metrics'] !== null
                ? (run['metrics'] as JsonRecord)
                : {};
            const gate =
              typeof metrics['gate'] === 'object' && metrics['gate'] !== null
                ? (metrics['gate'] as JsonRecord)
                : {};
            return (
              <article>
                <div>
                  <b>
                    Run {String(run['id'])} · {asText(run['mode'])}
                  </b>
                  <small>
                    {asText(run['state'])} · {String(run['caseCount'] ?? 0)} cases · recall{' '}
                    {Math.round(asNumber(metrics['recallAt10']) * 100)}%
                  </small>
                </div>
                {run['state'] === 'succeeded' && gate['passed'] === true ? (
                  <button
                    onClick={() =>
                      void mutateEvaluation(
                        { action: 'accept_baseline', runId: run['id'] },
                        'Baseline accepted.',
                      )
                    }
                  >
                    Accept baseline
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

type AdminReport = (message: string, error?: boolean) => void;

const KnowledgeSpacesPanel = ({
  items,
  refresh,
  refreshWorkspaceSilos,
  purge,
  report,
}: {
  readonly items: readonly JsonRecord[];
  readonly refresh: () => void;
  readonly refreshWorkspaceSilos: () => Promise<void>;
  readonly purge: (item: JsonRecord) => Promise<void>;
  readonly report: AdminReport;
}) => {
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    try {
      await postJson(
        '/v1/admin/silos',
        {
          slug: String(form.get('slug')),
          displayName: String(form.get('displayName')),
          description: String(form.get('description') ?? ''),
        },
        { idempotent: true },
      );
      formElement.reset();
      await refreshWorkspaceSilos();
      report('Knowledge space created. You can now grant access or ingest documents into it.');
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  const update = async (event: SubmitEvent, item: JsonRecord) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      await postJson(
        `/v1/admin/silos/${String(item['id'])}`,
        {
          displayName: String(form.get('displayName')),
          description: String(form.get('description') ?? ''),
        },
        { method: 'PATCH', idempotent: true },
      );
      await refreshWorkspaceSilos();
      report('Knowledge space details saved.');
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  return (
    <div class="admin-control-stack">
      <section class="admin-control-card">
        <h3>Add a knowledge space</h3>
        <p>
          A knowledge space is an isolated library. Its documents, search results, and access grants
          stay separate from every other space.
        </p>
        <form class="admin-form-grid" onSubmit={create}>
          <Field label="Name" hint="The friendly name people see in Search and Ingest.">
            <input name="displayName" maxLength={120} required />
          </Field>
          <Field
            label="Slug"
            hint="Permanent lowercase identifier, such as company-policies. It cannot be edited later."
          >
            <input name="slug" pattern="[a-z][a-z0-9-]{1,62}" required />
          </Field>
          <Field label="Description" hint="Explain what belongs in this library.">
            <textarea name="description" maxLength={2000} rows={3} />
          </Field>
          <button class="primary">Add knowledge space</button>
        </form>
      </section>
      <section>
        <h3>Existing knowledge spaces</h3>
        {items.length === 0 ? (
          <EmptyState title="No knowledge spaces" detail="Add the first isolated library above." />
        ) : (
          <div class="editable-record-list">
            {items.map((item) => {
              const name = asText(item['displayName'], asText(item['display_name'], 'Untitled'));
              return (
                <article class="editable-record" key={String(item['id'])}>
                  <div class="editable-record-heading">
                    <div>
                      <b>{name}</b>
                      <small>
                        {asText(item['slug'])} · {String(item['document_count'] ?? 0)} documents ·{' '}
                        {String(item['principal_count'] ?? 0)} assigned principals
                      </small>
                    </div>
                    <StatusPill value="isolated" />
                  </div>
                  <form class="admin-form-grid" onSubmit={(event) => void update(event, item)}>
                    <Field label="Name">
                      <input name="displayName" defaultValue={name} maxLength={120} required />
                    </Field>
                    <Field label="Description">
                      <textarea
                        name="description"
                        defaultValue={asText(item['description'], '')}
                        maxLength={2000}
                        rows={2}
                      />
                    </Field>
                    <div class="button-row compact-buttons">
                      <button class="secondary">Save changes</button>
                      <button class="danger-button" type="button" onClick={() => void purge(item)}>
                        Permanently purge
                      </button>
                    </div>
                  </form>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

const SettingsPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    try {
      await postJson(
        '/v1/admin/settings',
        {
          targetChars: Number(form.get('targetChars')),
          overlapChars: Number(form.get('overlapChars')),
          maxTokens: Number(form.get('maxTokens')),
          snapWindow: Number(form.get('snapWindow')),
          headingPrefix: form.get('headingPrefix') === 'on',
          embedThreads: Number(form.get('embedThreads')),
          ingestThreads: Number(form.get('ingestThreads')),
          throttleWhenBusy: form.get('throttleWhenBusy') === 'on',
          defaultMode: String(form.get('defaultMode')),
          efSearch: Number(form.get('efSearch')),
          auditRetentionDays: Number(form.get('auditRetentionDays')),
        },
        { method: 'PUT', idempotent: true },
      );
      report(
        'System settings saved. Chunking changes apply when documents are newly ingested or rebuilt.',
      );
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  return (
    <form
      class="admin-control-card admin-settings-form"
      key={asText(data['updatedAt'], 'settings')}
      onSubmit={save}
    >
      <h3>Indexing and runtime defaults</h3>
      <p>
        These defaults control how documents are divided, how much work runs concurrently, and how
        search and audit history behave. Existing chunks are unchanged until a rebuild.
      </p>
      <div class="admin-form-grid three">
        <Field label="Target characters" hint="Preferred chunk size. Allowed: 200–8,000.">
          <input
            name="targetChars"
            type="number"
            min="200"
            max="8000"
            defaultValue={asNumber(data['targetChars'])}
            required
          />
        </Field>
        <Field
          label="Overlap characters"
          hint="Context repeated between chunks; no more than half the target size."
        >
          <input
            name="overlapChars"
            type="number"
            min="0"
            max="4000"
            defaultValue={asNumber(data['overlapChars'])}
            required
          />
        </Field>
        <Field label="Maximum tokens" hint="Hard token limit for each embedding input.">
          <input
            name="maxTokens"
            type="number"
            min="128"
            max="2048"
            defaultValue={asNumber(data['maxTokens'])}
            required
          />
        </Field>
        <Field
          label="Snap window"
          hint="How far a boundary may move to preserve structure (0–0.5)."
        >
          <input
            name="snapWindow"
            type="number"
            min="0"
            max="0.5"
            step="0.01"
            defaultValue={asNumber(data['snapWindow'])}
            required
          />
        </Field>
        <Field label="Embedding workers" hint="Parallel embedding requests. Allowed: 1–32.">
          <input
            name="embedThreads"
            type="number"
            min="1"
            max="32"
            defaultValue={asNumber(data['embedThreads'])}
            required
          />
        </Field>
        <Field label="Ingest workers" hint="Documents processed concurrently. Allowed: 1–16.">
          <input
            name="ingestThreads"
            type="number"
            min="1"
            max="16"
            defaultValue={asNumber(data['ingestThreads'])}
            required
          />
        </Field>
        <Field label="Default search" hint="Initial search mode shown to users.">
          <select name="defaultMode">
            <option value="vector" selected={data['defaultMode'] === 'vector'}>
              Meaning
            </option>
            <option value="keyword" selected={data['defaultMode'] === 'keyword'}>
              Keyword
            </option>
            <option value="hybrid" selected={data['defaultMode'] === 'hybrid'}>
              Both
            </option>
          </select>
        </Field>
        <Field
          label="Vector search breadth"
          hint="Higher values may improve recall but use more CPU."
        >
          <input
            name="efSearch"
            type="number"
            min="1"
            max="2000"
            defaultValue={asNumber(data['efSearch'])}
            required
          />
        </Field>
        <Field
          label="Audit retention (days)"
          hint="How long administrative and access events remain."
        >
          <input
            name="auditRetentionDays"
            type="number"
            min="1"
            max="3650"
            defaultValue={asNumber(data['auditRetentionDays'])}
            required
          />
        </Field>
      </div>
      <div class="setting-toggle-grid">
        <label class="setting-toggle">
          <input
            name="headingPrefix"
            type="checkbox"
            defaultChecked={data['headingPrefix'] === true}
          />
          <span>
            <b>Include headings in embeddings</b>
            <small>Improves context for structured documents but uses more tokens.</small>
          </span>
        </label>
        <label class="setting-toggle">
          <input
            name="throttleWhenBusy"
            type="checkbox"
            defaultChecked={data['throttleWhenBusy'] === true}
          />
          <span>
            <b>Protect interactive searches under load</b>
            <small>Slows background ingest when the system is busy.</small>
          </span>
        </label>
      </div>
      <button class="primary">Save system settings</button>
    </form>
  );
};

const StoragePanel = ({
  items,
  refresh,
  report,
}: {
  readonly items: readonly JsonRecord[];
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const probe = async (managedPath: string) =>
    postJson<JsonRecord>('/v1/admin/storage/probe', { managedPath });
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    const managedPath = String(form.get('managedPath'));
    try {
      const result = await probe(managedPath);
      await postJson(
        '/v1/admin/storage',
        {
          name: String(form.get('name')),
          managedPath,
          purpose: String(form.get('purpose')),
          enabled: form.get('enabled') === 'on',
        },
        { idempotent: true },
      );
      formElement.reset();
      report(
        `Storage location added. ${formatBytes(result['availableBytes'])} is currently available.`,
      );
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  const update = async (event: SubmitEvent, item: JsonRecord) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const managedPath = String(form.get('managedPath'));
    try {
      const pathChanged = managedPath !== asText(item['managedPath'], '');
      if (pathChanged) await probe(managedPath);
      await postJson(
        `/v1/admin/storage/${String(item['id'])}`,
        {
          name: String(form.get('name')),
          managedPath,
          purpose: String(form.get('purpose')),
          enabled: form.get('enabled') === 'on',
        },
        { method: 'PATCH', idempotent: true },
      );
      report(
        pathChanged
          ? 'Storage location saved and its new path probe passed.'
          : 'Storage location saved.',
      );
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  return (
    <div class="admin-control-stack">
      <Notice kind="info">
        These are NodeRag-managed destinations for protected document copies, backups, or temporary
        work. They are different from the read-only input folders connected on the Ingest page.
      </Notice>
      <section class="admin-control-card">
        <h3>Add a storage location</h3>
        <p>
          NodeRag verifies write access, durable writes, filesystem support, and free capacity
          first.
        </p>
        <form class="admin-form-grid" onSubmit={create}>
          <Field label="Name" hint="A recognizable administrative label.">
            <input name="name" maxLength={120} required />
          </Field>
          <Field label="Managed path" hint="An absolute path available to the NodeRag service.">
            <input name="managedPath" maxLength={4096} placeholder="/data/noderag" required />
          </Field>
          <Field label="Purpose">
            <select name="purpose">
              <option value="documents">Managed document copies</option>
              <option value="backup">Encrypted backups</option>
              <option value="temporary">Temporary work</option>
            </select>
          </Field>
          <label class="setting-toggle compact-toggle">
            <input name="enabled" type="checkbox" defaultChecked />
            <span>
              <b>Enabled</b>
              <small>Allow new work to use this location.</small>
            </span>
          </label>
          <button class="primary">Verify and add</button>
        </form>
      </section>
      <section>
        <h3>Configured storage</h3>
        {items.length === 0 ? (
          <EmptyState
            title="No storage locations"
            detail="Add and verify a managed destination above."
          />
        ) : (
          <div class="editable-record-list">
            {items.map((item) => (
              <article class="editable-record" key={String(item['id'])}>
                <div class="editable-record-heading">
                  <div>
                    <b>{asText(item['name'])}</b>
                    <small>Location #{String(item['id'])}</small>
                  </div>
                  <StatusPill value={item['enabled'] === true ? 'enabled' : 'disabled'} />
                </div>
                <form class="admin-form-grid" onSubmit={(event) => void update(event, item)}>
                  <Field label="Name">
                    <input
                      name="name"
                      defaultValue={asText(item['name'], '')}
                      maxLength={120}
                      required
                    />
                  </Field>
                  <Field
                    label="Managed path"
                    hint="A path or purpose cannot change after backups, schedules, or relocations refer to it; add a new location instead."
                  >
                    <input
                      name="managedPath"
                      defaultValue={asText(item['managedPath'], '')}
                      maxLength={4096}
                      required
                    />
                  </Field>
                  <Field label="Purpose">
                    <select name="purpose">
                      <option value="documents" selected={item['purpose'] === 'documents'}>
                        Managed document copies
                      </option>
                      <option value="backup" selected={item['purpose'] === 'backup'}>
                        Encrypted backups
                      </option>
                      <option value="temporary" selected={item['purpose'] === 'temporary'}>
                        Temporary work
                      </option>
                    </select>
                  </Field>
                  <label class="setting-toggle compact-toggle">
                    <input
                      name="enabled"
                      type="checkbox"
                      defaultChecked={item['enabled'] === true}
                    />
                    <span>
                      <b>Enabled</b>
                      <small>Disable to stop assigning new work.</small>
                    </span>
                  </label>
                  <button class="secondary">Verify and save</button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const VisionPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const settings =
    typeof data['settings'] === 'object' && data['settings'] !== null
      ? (data['settings'] as JsonRecord)
      : {};
  const counts =
    typeof data['counts'] === 'object' && data['counts'] !== null
      ? (data['counts'] as JsonRecord)
      : {};
  const estimate =
    typeof data['estimate'] === 'object' && data['estimate'] !== null
      ? (data['estimate'] as JsonRecord)
      : {};
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    const bearerToken = String(form.get('bearerToken') ?? '').trim();
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/vision/test',
        {
          baseUrl: String(form.get('baseUrl')),
          model: String(form.get('model')),
          ...(bearerToken === '' ? {} : { bearerToken }),
          maximumParallel: Number(form.get('maximumParallel')),
          timeoutMs: Number(form.get('timeoutMs')),
          maximumAttempts: Number(form.get('maximumAttempts')),
          maximumImageDimension: Number(form.get('maximumImageDimension')),
        },
        { idempotent: true },
      );
      report(`Vision connection tested and saved in ${String(result['elapsedMs'] ?? 0)} ms.`);
      formElement.reset();
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    }
  };
  return (
    <div class="admin-control-stack">
      <Notice kind="warning">
        When this address is outside your local network, document images are sent to that provider
        for analysis. Use only a provider and account approved for the documents you ingest.
      </Notice>
      <div class="metric-grid vision-metrics">
        <article>
          <span>Pending images</span>
          <strong>{asNumber(counts['pending'])}</strong>
          <small>waiting for analysis</small>
        </article>
        <article>
          <span>Analysed</span>
          <strong>{asNumber(counts['analysed'])}</strong>
          <small>cached results available</small>
        </article>
        <article>
          <span>Failed</span>
          <strong>{asNumber(counts['failed'])}</strong>
          <small>eligible for retry</small>
        </article>
        <article>
          <span>Projected calls</span>
          <strong>{asNumber(estimate['projectedCalls'])}</strong>
          <small>for the current pending set</small>
        </article>
      </div>
      <form
        class="admin-control-card"
        key={asText(settings['activatedAt'], 'vision-settings')}
        onSubmit={save}
      >
        <div class="editable-record-heading">
          <div>
            <h3>Ollama-compatible image understanding</h3>
            <p>Saving performs a live model and structured-response test before activation.</p>
          </div>
          <StatusPill value={settings['enabled'] === true ? 'enabled' : 'disabled'} />
        </div>
        <div class="admin-form-grid three">
          <Field
            label="Ollama address"
            hint="A host root, /api root, or complete /api/chat URL is accepted."
          >
            <input
              name="baseUrl"
              type="url"
              defaultValue={asText(settings['baseUrl'], 'https://ollama.com/api/chat')}
              required
            />
          </Field>
          <Field label="Vision model" hint="The exact model name exposed by the provider.">
            <input name="model" defaultValue={asText(settings['model'], 'qwen2.5vl:7b')} required />
          </Field>
          <Field
            label="Ollama API key"
            hint={
              settings['credentialConfigured'] === true
                ? 'A protected key is saved. Leave this blank to keep it, or enter a replacement.'
                : 'Optional for local Ollama; required for Ollama Cloud. It is encrypted at rest.'
            }
          >
            <input name="bearerToken" type="password" autoComplete="off" />
          </Field>
          <Field
            label="Parallel vision calls"
            hint="Maximum simultaneous cloud or local calls. Match your provider limit (1–16)."
          >
            <input
              name="maximumParallel"
              type="number"
              min="1"
              max="16"
              defaultValue={asNumber(settings['maximumParallel']) || 2}
              required
            />
          </Field>
          <Field label="Call timeout (ms)" hint="Time allowed for one provider call.">
            <input
              name="timeoutMs"
              type="number"
              min="1000"
              max="600000"
              defaultValue={asNumber(settings['timeoutMs']) || 120000}
              required
            />
          </Field>
          <Field label="Maximum attempts" hint="Retries for a transient image-analysis failure.">
            <input
              name="maximumAttempts"
              type="number"
              min="1"
              max="10"
              defaultValue={asNumber(settings['maximumAttempts']) || 3}
              required
            />
          </Field>
          <Field
            label="Maximum image dimension"
            hint="Larger images are scaled down to this many pixels on their longest edge."
          >
            <input
              name="maximumImageDimension"
              type="number"
              min="256"
              max="8192"
              defaultValue={asNumber(settings['maximumImageDimension']) || 2048}
              required
            />
          </Field>
        </div>
        <button class="primary">Test and save vision settings</button>
      </form>
    </div>
  );
};

const adminSections = [
  [
    'silos',
    'Knowledge spaces',
    '/v1/admin/silos',
    'Create isolated document libraries, rename them, explain their purpose, or permanently purge one.',
  ],
  [
    'principals',
    'Users',
    '/v1/admin/principals',
    'Create people and search-only API keys, then review their account state.',
  ],
  [
    'grants',
    'Capabilities',
    '/v1/admin/grants',
    'Control who can read, upload to, or delete from each knowledge space.',
  ],
  [
    'gateways',
    'Gateways',
    '/v1/admin/gateways',
    'Review narrowed network listeners that expose only explicitly assigned knowledge spaces.',
  ],
  [
    'audit',
    'Audit',
    '/v1/admin/audit',
    'Review security and administrative activity without storing raw search text.',
  ],
  [
    'settings',
    'Settings',
    '/v1/admin/settings',
    'Tune chunking, worker concurrency, search behavior, and audit retention.',
  ],
  [
    'models',
    'Models',
    '/v1/admin/models',
    'Review registered embedding models and the immutable revisions used to build indexes.',
  ],
  [
    'builds',
    'Builds',
    '/v1/admin/builds',
    'Track index rebuilds, checkpoints, validation, and activation state.',
  ],
  [
    'storage',
    'Storage',
    '/v1/admin/storage',
    'Add and manage NodeRag-owned destinations for document copies, backups, and temporary work.',
  ],
  [
    'backups',
    'Backups',
    '/v1/admin/backups',
    'Review encrypted recovery archives and their verification status.',
  ],
  [
    'restores',
    'Restore',
    '/v1/admin/restores',
    'Review staged restore operations before any recovered data is activated.',
  ],
  [
    'evaluation',
    'Evaluation',
    '/v1/admin/evaluation',
    'Curate known-answer tests, compare search modes, and protect approved quality baselines.',
  ],
  [
    'vision',
    'Image understanding',
    '/v1/admin/vision/status',
    'Configure the Ollama-compatible provider used to understand scans, diagrams, and embedded images.',
  ],
  [
    'api',
    'API contract',
    '/v1/openapi.json',
    'Inspect the machine-readable contract for administrators and external integrations.',
  ],
] as const;

const AdminView = ({
  refreshWorkspaceSilos,
}: {
  readonly refreshWorkspaceSilos: () => Promise<void>;
}) => {
  const [section, setSection] = useState('silos');
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selected = adminSections.find(([id]) => id === section) ?? adminSections[0];
  const loaded = useLoad(selected[2], refresh);
  const createUser = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      await postJson(
        '/v1/admin/principals',
        {
          username: String(form.get('username')),
          password: String(form.get('password')),
          serverAdmin: form.get('admin') === 'on',
          mustChange: true,
        },
        { idempotent: true },
      );
      setMessage('User created.');
      setRefresh((v) => v + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const createKey = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/api-keys',
        { label: String(form.get('label')), searchOnly: true },
        { idempotent: true },
      );
      setMessage(`Save this API key now: ${asText(result['token'])}`);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const changeGrant = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const enabled = submitter?.value !== 'revoke';
    const path = `/v1/admin/grants/${String(form.get('principalId'))}/${String(form.get('siloId'))}/${String(form.get('capability'))}`;
    try {
      await api(path, {
        method: enabled ? 'PUT' : 'DELETE',
        body: JSON.stringify({}),
        idempotent: true,
      });
      setMessage(enabled ? 'Capability granted.' : 'Capability revoked.');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const purgeSilo = async (item: JsonRecord) => {
    const slug = asText(item['slug'], '');
    if (window.prompt(`Type ${slug} to permanently purge this knowledge space`) !== slug) return;
    try {
      await api(`/v1/admin/silos/${String(item['id'])}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmSlug: slug }),
        idempotent: true,
      });
      await refreshWorkspaceSilos();
      setMessage('Knowledge space permanently purged.');
      setRefresh((v) => v + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const items = list(loaded.data?.['items'] ?? (Array.isArray(loaded.data) ? loaded.data : []));
  return (
    <div class="page admin-page">
      <PageHeading
        eyebrow="Administration"
        title="Control center"
        detail="Every action here uses the same documented API available to external administrators."
      />
      <div class="admin-layout">
        <nav class="admin-nav" aria-label="Administration sections">
          {adminSections.map(([id, label]) => (
            <button
              class={section === id ? 'active' : ''}
              onClick={() => {
                setSection(id);
                setMessage('');
                setError('');
              }}
            >
              {label}
              <Icon name="arrow" />
            </button>
          ))}
        </nav>
        <section class="admin-content">
          <div class="section-heading">
            <div>
              <h2>{selected[1]}</h2>
              <p>{selected[3]}</p>
            </div>
            <button class="secondary" onClick={() => setRefresh((v) => v + 1)}>
              Refresh
            </button>
          </div>
          {message ? (
            <Notice kind="success">
              <span dir="auto">{message}</span>
            </Notice>
          ) : null}
          {error || loaded.error ? <Notice kind="danger">{error || loaded.error}</Notice> : null}
          {section === 'principals' ? (
            <form class="inline-form" onSubmit={createUser}>
              <Field label="Username">
                <input name="username" required />
              </Field>
              <Field label="Temporary password">
                <input name="password" type="password" minLength={12} required />
              </Field>
              <label class="checkbox">
                <input name="admin" type="checkbox" />
                Server administrator
              </label>
              <button class="primary">Create user</button>
            </form>
          ) : null}
          {section === 'grants' ? (
            <form class="inline-form" onSubmit={changeGrant}>
              <Field label="User or key ID">
                <input name="principalId" type="number" min="1" required />
              </Field>
              <Field label="Knowledge space ID">
                <input name="siloId" type="number" min="1" required />
              </Field>
              <Field label="Capability">
                <select name="capability">
                  <option value="read">Read and search</option>
                  <option value="upload">Upload and sources</option>
                  <option value="delete">Delete and re-index</option>
                </select>
              </Field>
              <div class="button-row compact-buttons">
                <button class="primary" name="grantAction" value="grant">
                  Grant capability
                </button>
                <button class="danger-button" name="grantAction" value="revoke">
                  Revoke capability
                </button>
              </div>
            </form>
          ) : null}
          {section === 'principals' ? (
            <form class="inline-form" onSubmit={createKey}>
              <Field label="API key label">
                <input name="label" required />
              </Field>
              <button class="secondary">Create search-only key</button>
            </form>
          ) : null}
          {(() => {
            const report: AdminReport = (value, failed = false) => {
              if (failed) {
                setError(value);
                setMessage('');
              } else {
                setMessage(value);
                setError('');
              }
            };
            if (loaded.data === null) return <SkeletonRows />;
            if (section === 'silos')
              return (
                <KnowledgeSpacesPanel
                  items={items}
                  refresh={() => setRefresh((value) => value + 1)}
                  refreshWorkspaceSilos={refreshWorkspaceSilos}
                  purge={purgeSilo}
                  report={report}
                />
              );
            if (section === 'settings')
              return (
                <SettingsPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'storage')
              return (
                <StoragePanel
                  items={items}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'vision')
              return (
                <VisionPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'evaluation')
              return (
                <EvaluationPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (items.length > 0)
              return (
                <div class="record-list">
                  {items.map((item) => (
                    <article>
                      <div>
                        <b>
                          {asText(
                            item['displayName'],
                            asText(
                              item['username'],
                              asText(
                                item['name'],
                                asText(item['action'], `Record ${String(item['id'] ?? '')}`),
                              ),
                            ),
                          )}
                        </b>
                        <small>
                          {Object.entries(item)
                            .slice(0, 6)
                            .map(
                              ([key, value]) =>
                                `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}`,
                            )
                            .join(' · ')}
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
              );
            return <pre class="json-summary">{JSON.stringify(loaded.data, null, 2)}</pre>;
          })()}
          <p class="security-footnote">
            <Icon name="check" />
            Sensitive actions remain administrator-only and use the documented API. Storage paths
            are shown only on this administrator screen.
          </p>
        </section>
      </div>
    </div>
  );
};

export const Workspace = ({
  principal,
  silos,
  logout,
}: {
  readonly principal: Principal;
  readonly silos: readonly Silo[];
  readonly logout: () => void;
}) => {
  const currentHash = () =>
    (['search', 'documents', 'ingest', 'activity', 'admin'].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : 'search') as Page;
  const [page, setPage] = useState<Page>(currentHash);
  const [menu, setMenu] = useState(false);
  const [workspaceSilos, setWorkspaceSilos] = useState<readonly Silo[]>(silos);
  useEffect(() => setWorkspaceSilos(silos), [silos]);
  const refreshWorkspaceSilos = useCallback(async () => {
    const response = await api<{ readonly items: readonly Silo[] }>('/v1/silos');
    setWorkspaceSilos(response.items);
  }, []);
  useEffect(() => {
    const handler = () => setPage(currentHash());
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  const navigate = useCallback((next: Page) => {
    location.hash = next;
    setPage(next);
    setMenu(false);
  }, []);
  const leave = async () => {
    try {
      await signOut();
    } finally {
      logout();
    }
  };
  return (
    <div class="app-shell">
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside class={menu ? 'sidebar open' : 'sidebar'}>
        <div class="sidebar-top">
          <a class="brand" href="#search" onClick={() => navigate('search')}>
            <span>N</span>NodeRag
          </a>
          <button
            class="icon-button mobile-only"
            onClick={() => setMenu(false)}
            aria-label="Close navigation"
          >
            <Icon name="close" />
          </button>
        </div>
        <nav>
          {(
            [
              ['search', 'search', 'Search'],
              ['documents', 'documents', 'Documents'],
              ['ingest', 'ingest', 'Ingest'],
              ['activity', 'activity', 'Operations'],
              ['admin', 'settings', 'Administration'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              class={page === id ? 'active' : ''}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <div class="sidebar-foot">
          <div class="user-chip">
            <span>{(principal.username ?? 'U').slice(0, 1).toUpperCase()}</span>
            <div>
              <b>{principal.username ?? 'User'}</b>
              <small>{principal.serverAdmin ? 'Administrator' : 'Member'}</small>
            </div>
          </div>
          <button class="logout" onClick={() => void leave()}>
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      </aside>
      <div class="main-column">
        <header class="mobile-header">
          <button class="icon-button" onClick={() => setMenu(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <a class="brand" href="#search">
            <span>N</span>NodeRag
          </a>
          <StatusPill value="Local" />
        </header>
        <main id="main-content">
          {page === 'search' ? (
            <SearchView silos={workspaceSilos} />
          ) : page === 'documents' ? (
            <DocumentsView silos={workspaceSilos} />
          ) : page === 'ingest' ? (
            <IngestView silos={workspaceSilos} />
          ) : page === 'activity' ? (
            <ActivityView />
          ) : (
            <AdminView refreshWorkspaceSilos={refreshWorkspaceSilos} />
          )}
        </main>
      </div>
    </div>
  );
};
