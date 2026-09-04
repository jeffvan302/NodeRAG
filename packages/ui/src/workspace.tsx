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
          <h2>Connect a folder</h2>
          <p>The folder must already be shared with the NodeRag service account.</p>
          <form onSubmit={addSource}>
            <Field label="Knowledge space">
              <select name="siloId">
                {silos.map((silo) => (
                  <option value={silo.id}>{silo.displayName}</option>
                ))}
              </select>
            </Field>
            <Field label="Folder path">
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
        <h2>Connected sources</h2>
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

const adminSections = [
  ['silos', 'Knowledge spaces', '/v1/admin/silos'],
  ['principals', 'Users', '/v1/admin/principals'],
  ['grants', 'Capabilities', '/v1/admin/grants'],
  ['gateways', 'Gateways', '/v1/admin/gateways'],
  ['audit', 'Audit', '/v1/admin/audit'],
  ['settings', 'Settings', '/v1/admin/settings'],
  ['models', 'Models', '/v1/admin/models'],
  ['builds', 'Builds', '/v1/admin/builds'],
  ['storage', 'Storage', '/v1/admin/storage'],
  ['backups', 'Backups', '/v1/admin/backups'],
  ['restores', 'Restore', '/v1/admin/restores'],
  ['evaluation', 'Evaluation', '/v1/admin/evaluation'],
  ['vision', 'Image understanding', '/v1/admin/vision/status'],
  ['api', 'API contract', '/v1/openapi.json'],
] as const;

const AdminView = () => {
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
              <p>{selected[2]}</p>
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
          {section === 'evaluation' && loaded.data !== null ? (
            <EvaluationPanel
              data={loaded.data}
              refresh={() => setRefresh((value) => value + 1)}
              report={(value, failed = false) => {
                if (failed) {
                  setError(value);
                  setMessage('');
                } else {
                  setMessage(value);
                  setError('');
                }
              }}
            />
          ) : null}
          {loaded.data === null ? (
            <SkeletonRows />
          ) : section === 'evaluation' ? null : items.length > 0 ? (
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
                  {section === 'silos' ? (
                    <button class="danger-button" onClick={() => void purgeSilo(item)}>
                      Purge
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <pre class="json-summary">{JSON.stringify(loaded.data, null, 2)}</pre>
          )}
          <p class="security-footnote">
            <Icon name="check" />
            No private file path or hidden browser-only operation is used by this screen.
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
            <SearchView silos={silos} />
          ) : page === 'documents' ? (
            <DocumentsView silos={silos} />
          ) : page === 'ingest' ? (
            <IngestView silos={silos} />
          ) : page === 'activity' ? (
            <ActivityView />
          ) : (
            <AdminView />
          )}
        </main>
      </div>
    </div>
  );
};
