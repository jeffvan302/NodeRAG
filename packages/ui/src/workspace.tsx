import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
import { FolderBrowser } from './folder-browser.js';
import { MarkdownSearchViewer } from './markdown-search-viewer.js';
import { MarkdownViewer } from './markdown-viewer.js';
import { immediateExactPdfEvidence, mergePdfEvidence } from './pdf-evidence.js';
import { PdfViewer, type PdfEvidence } from './pdf-viewer.js';
import { ResearchView } from './research-view.js';
import { ChatView } from './chat-view.js';
import { appUrl } from './url.js';

type Page = 'search' | 'research' | 'chat' | 'documents' | 'ingest' | 'activity' | 'admin';
type ColorScheme = 'light' | 'dark' | 'green' | 'blue' | 'red';
type SearchMode = 'vector' | 'semantic' | 'keyword' | 'hybrid';

const colorSchemes: ReadonlyArray<{
  readonly id: ColorScheme;
  readonly name: string;
  readonly description: string;
  readonly themeColor: string;
}> = [
  {
    id: 'light',
    name: 'Light',
    description: 'Warm white panels, dark text, and subtle green accents.',
    themeColor: '#f3f6f3',
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Neutral charcoal panels with crisp light text.',
    themeColor: '#171b1d',
  },
  {
    id: 'green',
    name: 'Forest green',
    description: 'The current dark-green look with white text and lighter green borders.',
    themeColor: '#102019',
  },
  {
    id: 'blue',
    name: 'Midnight blue',
    description: 'Deep navy panels with pale blue borders and accents.',
    themeColor: '#101b2d',
  },
  {
    id: 'red',
    name: 'Deep red',
    description: 'Dark burgundy panels with warm rose borders and accents.',
    themeColor: '#271417',
  },
];

const savedColorScheme = (key: string): ColorScheme => {
  const value = localStorage.getItem(key);
  if (
    value === 'light' ||
    value === 'dark' ||
    value === 'green' ||
    value === 'blue' ||
    value === 'red'
  ) {
    return value;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'green' : 'light';
};

const asText = (value: unknown, fallback = '—') =>
  typeof value === 'string' && value.length > 0 ? value : fallback;
const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const record = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
const list = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
    : [];
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const numberList = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isSafeInteger(item) && item > 0)
    : [];

interface ResearchSummary {
  readonly id: number;
  readonly name: string;
  readonly itemCount: number;
}

interface ResearchMembership {
  readonly chunkId: number;
  readonly researchId: number;
  readonly researchName: string;
  readonly researchItemId: number;
}

interface ResearchPageMembership {
  readonly researchItemId: number;
  readonly pageOrdinal: number;
  readonly pageNumber: number;
}

const researchSummaries = (value: unknown): readonly ResearchSummary[] =>
  list(value).flatMap((item) => {
    const id = asNumber(item['id']);
    const name = item['name'];
    return Number.isSafeInteger(id) && id > 0 && typeof name === 'string'
      ? [{ id, name, itemCount: asNumber(item['itemCount']) }]
      : [];
  });

const researchMemberships = (value: unknown): readonly ResearchMembership[] =>
  list(value).flatMap((item) => {
    const chunkId = asNumber(item['chunkId']);
    const researchId = asNumber(item['researchId']);
    const researchItemId = asNumber(item['researchItemId']);
    const researchName = item['researchName'];
    return Number.isSafeInteger(chunkId) &&
      chunkId > 0 &&
      Number.isSafeInteger(researchId) &&
      researchId > 0 &&
      Number.isSafeInteger(researchItemId) &&
      researchItemId > 0 &&
      typeof researchName === 'string'
      ? [{ chunkId, researchId, researchName, researchItemId }]
      : [];
  });

const researchPageMemberships = (value: unknown): readonly ResearchPageMembership[] =>
  list(value).flatMap((item) => {
    const researchItemId = asNumber(item['researchItemId']);
    const pageOrdinal = asNumber(item['pageOrdinal']);
    const pageNumber = asNumber(item['pageNumber']);
    return Number.isSafeInteger(researchItemId) &&
      researchItemId > 0 &&
      Number.isSafeInteger(pageOrdinal) &&
      pageOrdinal >= 0 &&
      Number.isSafeInteger(pageNumber) &&
      pageNumber > 0
      ? [{ researchItemId, pageOrdinal, pageNumber }]
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

type PdfSemanticEvidenceStatus = 'not-requested' | 'loading' | 'ready' | 'unavailable';

const clampPercent = (value: unknown): number =>
  Math.max(0, Math.min(100, Math.round(asNumber(value))));

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
};

const friendlyJobState = (state: string): string =>
  state === 'pending'
    ? 'queued'
    : state === 'leased'
      ? 'running'
      : state === 'retry_wait'
        ? 'waiting to retry'
        : state;

const activeJobStates = new Set(['pending', 'leased', 'retry_wait', 'paused']);

interface DocumentWorkflow {
  readonly key: string;
  readonly job: JsonRecord;
  readonly jobs: readonly JsonRecord[];
}

const jobTimestamp = (job: JsonRecord): number => {
  const timestamp = Date.parse(
    asText(job['updatedAt'], asText(job['createdAt'], '1970-01-01T00:00:00.000Z')),
  );
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const workflowStep = (job: JsonRecord): 1 | 2 | 3 => {
  const kind = asText(job['kind'], '');
  if (kind === 'extract' || kind === 'vision') return 1;
  if (kind !== 'embed') return 1;
  const stage = asText((job['progress'] as JsonRecord | undefined)?.['stage'], '');
  return stage === '' || stage === 'prepare-embedding' || stage === 'chunking' ? 2 : 3;
};

const workflowStageLabel = (job: JsonRecord): string => {
  const step = workflowStep(job);
  if (step === 1)
    return asText(job['kind'], '') === 'vision'
      ? '1/3 Ingesting to Markdown — image analysis'
      : '1/3 Ingesting to Markdown';
  return step === 2 ? '2/3 Chunking' : '3/3 Embedding';
};

const workflowTaskDetail = (job: JsonRecord): string => {
  if (['succeeded', 'cancelled'].includes(asText(job['state'], ''))) return '';
  const progress = (job['progress'] as JsonRecord | undefined) ?? {};
  const rawTask = asText(progress['operation'], asText(progress['stage'], ''));
  if (rawTask === '' || ['chunking', 'embedding', 'complete'].includes(rawTask)) return '';
  const names: Readonly<Record<string, string>> = {
    'read-original': 'Reading the original file',
    'validating-original': 'Checking the original file',
    'extracting-pages': 'Converting pages to Markdown',
    'assembling-document': 'Assembling the Markdown document',
    'saving-extraction': 'Saving the Markdown document',
    'reading-canonical-markdown': 'Reading the Markdown document',
    'forming-passages': 'Forming searchable passages',
    'passages-ready': 'Searchable passages are ready',
    'checking-embedding-cache': 'Checking for reusable embeddings',
    'using-cached-embeddings': 'Reusing existing embeddings',
    'generating-embeddings': 'Creating embeddings',
    'saving-search-index': 'Saving the search index',
  };
  return names[rawTask] ?? rawTask.replaceAll('-', ' ').replaceAll('_', ' ');
};

const currentWorkflowJob = (jobs: readonly JsonRecord[]): JsonRecord => {
  const active = jobs.filter((job) => activeJobStates.has(asText(job['state'], '')));
  if (active.length > 0) {
    return [...active].sort((left, right) => {
      const stepDifference = workflowStep(left) - workflowStep(right);
      if (stepDifference !== 0) return stepDifference;
      const stateOrder = (job: JsonRecord) => {
        const state = asText(job['state'], '');
        return state === 'leased' ? 0 : state === 'retry_wait' ? 1 : state === 'pending' ? 2 : 3;
      };
      return stateOrder(left) - stateOrder(right) || jobTimestamp(right) - jobTimestamp(left);
    })[0] as JsonRecord;
  }
  return [...jobs].sort(
    (left, right) =>
      jobTimestamp(right) - jobTimestamp(left) || asNumber(right['id']) - asNumber(left['id']),
  )[0] as JsonRecord;
};

const groupDocumentWorkflows = (jobs: readonly JsonRecord[]): readonly DocumentWorkflow[] => {
  const grouped = new Map<string, JsonRecord[]>();
  for (const job of jobs) {
    if (job['documentId'] === null || job['documentId'] === undefined) continue;
    const key = `${String(job['siloId'])}:${String(job['documentId'])}`;
    const existing = grouped.get(key) ?? [];
    existing.push(job);
    grouped.set(key, existing);
  }
  return [...grouped.entries()]
    .map(([key, groupedJobs]) => ({ key, jobs: groupedJobs, job: currentWorkflowJob(groupedJobs) }))
    .sort((left, right) => jobTimestamp(right.job) - jobTimestamp(left.job));
};

const groupLatestJobs = (jobs: readonly JsonRecord[], field: string): readonly JsonRecord[] => {
  const grouped = new Map<string, JsonRecord[]>();
  for (const job of jobs) {
    if (job[field] === null || job[field] === undefined) continue;
    const key = `${String(job['siloId'])}:${String(job[field])}`;
    const existing = grouped.get(key) ?? [];
    existing.push(job);
    grouped.set(key, existing);
  }
  return [...grouped.values()]
    .map((group) => currentWorkflowJob(group))
    .sort((left, right) => jobTimestamp(right) - jobTimestamp(left));
};

const jobActivityDetails = (job: JsonRecord, now: number): readonly string[] => {
  const state = asText(job['state'], 'pending');
  const logicalAttempt = asNumber(job['logicalAttempt']);
  const maximumAttempts = Math.max(1, asNumber(job['maximumAttempts']));
  const error = (job['error'] as JsonRecord | undefined) ?? {};
  const errorCode = asText(error['code'], '');
  const details: string[] = [];
  const progress = (job['progress'] as JsonRecord | undefined) ?? {};
  const activityAt = Date.parse(asText(job['heartbeatAt'], asText(job['updatedAt'], '')));
  const activityAge = Number.isFinite(activityAt) ? Math.max(0, now - activityAt) : null;
  const reportedHeartbeatWindow = asNumber(progress['expectedHeartbeatMs']);
  const staleAfter = Math.max(
    90_000,
    Math.min(600_000, reportedHeartbeatWindow > 0 ? reportedHeartbeatWindow : 90_000),
  );

  if (state === 'leased') {
    if (activityAge !== null && activityAge > staleAfter) {
      details.push(
        `No progress update for ${formatDuration(activityAge)}. NodeRag will recover this stage automatically if its worker stopped.`,
      );
    } else {
      details.push(
        activityAge === null
          ? 'Working now.'
          : `Working now · last update ${formatDuration(activityAge)} ago.`,
      );
    }
    if (logicalAttempt > 1)
      details.push(`Retry ${String(logicalAttempt)} of ${String(maximumAttempts)} is running.`);
  } else if (state === 'retry_wait') {
    const nextAttempt = Math.min(maximumAttempts, logicalAttempt + 1);
    const retryAt = Date.parse(asText(job['retryAt'], ''));
    details.push(
      `A temporary error occurred${errorCode ? ` (${errorCode})` : ''}. Try ${String(nextAttempt)} of ${String(maximumAttempts)} will start automatically${Number.isFinite(retryAt) ? ` at ${new Date(retryAt).toLocaleTimeString()}` : ''}.`,
    );
  } else if (state === 'pending') {
    details.push('Waiting for a worker.');
  } else if (state === 'paused') {
    details.push('Paused by an administrator.');
  } else if (state === 'failed') {
    details.push(
      `This stage stopped after ${String(logicalAttempt)} ${logicalAttempt === 1 ? 'try' : 'tries'}${errorCode ? ` (${errorCode})` : ''}. Review the error, then retry it.`,
    );
  } else if (state === 'succeeded') {
    details.push('All three document stages finished.');
  } else if (state === 'cancelled') {
    details.push('Document processing was cancelled.');
  }
  return details;
};

const jobPercent = (job: JsonRecord): number => {
  if (job['state'] === 'succeeded') return 100;
  return clampPercent((job['progress'] as JsonRecord | undefined)?.['percent'] ?? 0);
};

const documentIngestionPercent = (document: JsonRecord, job: JsonRecord): number => {
  if (document['state'] === 'ready' || document['state'] === 'source_missing') return 100;
  const percent = jobPercent(job);
  const kind = asText(job['kind'], '');
  if (kind === 'extract') return Math.round(percent * 0.6);
  if (kind === 'vision') return Math.round(60 + percent * 0.15);
  if (kind === 'embed') return Math.round(75 + percent * 0.25);
  return percent;
};

const JobProgress = ({
  job,
  now,
  document,
  startedAt,
  finishedAt,
  displayStage,
  displayPercent,
}: {
  readonly job: JsonRecord;
  readonly now: number;
  readonly document?: JsonRecord;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly displayStage?: string;
  readonly displayPercent?: number;
}) => {
  const progress = (job['progress'] as JsonRecord | undefined) ?? {};
  const rawPercent = jobPercent(job);
  const percent =
    displayPercent ??
    (document === undefined ? rawPercent : documentIngestionPercent(document, job));
  const state = asText(job['state'], 'queued');
  const stage = (
    displayStage ??
    (state === 'succeeded' ? 'complete' : asText(progress['stage'], friendlyJobState(state)))
  )
    .replaceAll('-', ' ')
    .replaceAll('_', ' ');
  const stageStartedAt = Date.parse(asText(progress['stageStartedAt'], ''));
  const createdAt =
    startedAt ??
    (Number.isFinite(stageStartedAt) ? stageStartedAt : Date.parse(asText(job['createdAt'], '')));
  const completedAt = finishedAt ?? Date.parse(asText(job['finishedAt'], ''));
  const elapsed = Number.isFinite(createdAt)
    ? Math.max(0, (Number.isFinite(completedAt) ? completedAt : now) - createdAt)
    : 0;
  const estimatePercent = document === undefined ? rawPercent : percent;
  const operation = asText(progress['operation'], '');
  const progressStage = asText(progress['stage'], '');
  const isEmbedding =
    asText(job['kind'], '') === 'embed' && asText(progress['stage'], '') === 'embedding';
  const pagesCompleted = asNumber(progress['pagesCompleted']);
  const pagesTotal = asNumber(progress['pagesTotal']);
  const reportedRemaining = progress['estimatedRemainingMs'];
  const hasReportedRemaining =
    typeof reportedRemaining === 'number' &&
    Number.isFinite(reportedRemaining) &&
    reportedRemaining >= 0;
  const estimatedRemaining = hasReportedRemaining
    ? reportedRemaining
    : progressStage === 'extracting-pages' && pagesTotal > 0 && pagesCompleted > 0
      ? (elapsed * Math.max(0, pagesTotal - pagesCompleted)) / pagesCompleted
      : !isEmbedding &&
          activeJobStates.has(asText(job['state'], '')) &&
          estimatePercent >= 5 &&
          estimatePercent < 100
        ? (elapsed * (100 - estimatePercent)) / estimatePercent
        : null;
  const chunksCompleted = asNumber(progress['chunksCompleted']);
  const chunksTotal = asNumber(progress['chunksTotal']);
  const cacheChecked = asNumber(progress['cacheChecked']);
  const cacheTotal = asNumber(progress['cacheTotal']);
  const embedded = asNumber(progress['embedded']);
  const cached = asNumber(progress['cached']);
  const completed = asNumber(progress['completed']);
  const remainingPassages = asNumber(progress['remaining']);
  const total = asNumber(progress['total']);
  const currentBatchStart = asNumber(progress['currentBatchStart']);
  const currentBatchEnd = asNumber(progress['currentBatchEnd']);
  const currentBatchTotal = asNumber(progress['currentBatchTotal']);
  const batchSize = asNumber(progress['batchSize']);
  const passagesPerMinute = asNumber(progress['passagesPerMinute']);
  const suspectedNoisyPassages = asNumber(progress['suspectedNoisyPassages']);
  const qualityWarningCodes = stringList(progress['qualityWarningCodes']);
  const passageProgress =
    operation === 'checking-embedding-cache' && cacheTotal > 0
      ? `${String(cacheChecked)} of ${String(cacheTotal)} passages checked · `
      : isEmbedding && total > 0
        ? `${String(completed)} of ${String(total)} passages complete · `
        : chunksTotal > 0
          ? `${String(chunksCompleted)} of ${String(chunksTotal)} passages · `
          : '';
  return (
    <div class="job-progress">
      <div>
        <b>{stage}</b>
        <span>{String(percent)}%</span>
      </div>
      <progress max="100" value={percent} aria-label={`${stage} progress`} />
      <small>
        {pagesTotal > 0
          ? `${String(pagesCompleted)} of ${String(pagesTotal)} pages · `
          : passageProgress}
        {elapsed > 0 ? `${formatDuration(elapsed)} elapsed` : 'Waiting to start'}
        {estimatedRemaining === null
          ? ''
          : estimatedRemaining === 0
            ? ' · finishing now'
            : ` · about ${formatDuration(estimatedRemaining)} remaining`}
      </small>
      {isEmbedding && total > 0 ? (
        <small>
          {String(embedded)} newly embedded · {String(cached)} reused · {String(remainingPassages)}{' '}
          remaining
          {passagesPerMinute > 0 ? ` · ${String(passagesPerMinute)} passages per minute` : ''}
        </small>
      ) : null}
      {operation === 'generating-embeddings' && currentBatchStart > 0 ? (
        <small>
          Processing new passages {String(currentBatchStart)}–{String(currentBatchEnd)} of{' '}
          {String(currentBatchTotal)} · adaptive group size {String(batchSize)}
        </small>
      ) : null}
      {qualityWarningCodes.length > 0 || suspectedNoisyPassages > 0 ? (
        <small class="quality-note">
          Possible extraction noise detected
          {suspectedNoisyPassages > 0
            ? ` in ${String(suspectedNoisyPassages)} ${suspectedNoisyPassages === 1 ? 'passage' : 'passages'}`
            : ''}
          . Content was retained; review the extracted Markdown.
        </small>
      ) : null}
    </div>
  );
};

const useLoad = (path: string | null, refresh = 0) => {
  const requestKey = `${path ?? 'none'}:${String(refresh)}`;
  const [loaded, setLoaded] = useState<{
    readonly requestKey: string;
    readonly data: JsonRecord | null;
    readonly error: string;
  }>({ requestKey: '', data: null, error: '' });
  useEffect(() => {
    if (path === null) {
      setLoaded({ requestKey, data: null, error: '' });
      return;
    }
    let current = true;
    setLoaded({ requestKey, data: null, error: '' });
    void api<JsonRecord>(path)
      .then((value) => current && setLoaded({ requestKey, data: value, error: '' }))
      .catch(
        (reason) => current && setLoaded({ requestKey, data: null, error: displayError(reason) }),
      );
    return () => {
      current = false;
    };
  }, [path, refresh, requestKey]);
  return loaded.requestKey === requestKey
    ? { data: loaded.data, error: loaded.error }
    : { data: null, error: '' };
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

const SearchView = ({
  silos,
  colorScheme,
}: {
  readonly silos: readonly Silo[];
  readonly colorScheme: ColorScheme;
}) => {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [selectedSilos, setSelectedSilos] = useState<number[]>(silos.map((silo) => silo.id));
  const [results, setResults] = useState<JsonRecord[] | null>(null);
  const [meta, setMeta] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<JsonRecord | null>(null);
  const [context, setContext] = useState<JsonRecord | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [searchMarkdown, setSearchMarkdown] = useState('');
  const [searchMarkdownLoading, setSearchMarkdownLoading] = useState(false);
  const [searchMarkdownError, setSearchMarkdownError] = useState('');
  const [pdfEvidence, setPdfEvidence] = useState<readonly PdfEvidence[]>([]);
  const [pdfEvidenceLoading, setPdfEvidenceLoading] = useState(false);
  const [pdfSemanticEvidenceStatus, setPdfSemanticEvidenceStatus] =
    useState<PdfSemanticEvidenceStatus>('not-requested');
  const [pdfHighlightsEnabled, setPdfHighlightsEnabled] = useState(true);
  const [executedSearch, setExecutedSearch] = useState<{
    readonly query: string;
    readonly mode: SearchMode;
  }>({ query: '', mode: 'hybrid' });
  const [minimumConfidence, setMinimumConfidence] = useState(0.3);
  const [researches, setResearches] = useState<readonly ResearchSummary[]>([]);
  const [selectedResearchId, setSelectedResearchId] = useState<number | null>(null);
  const [memberships, setMemberships] = useState<readonly ResearchMembership[]>([]);
  const [researchBusyChunkId, setResearchBusyChunkId] = useState<number | null>(null);
  const [pageMemberships, setPageMemberships] = useState<readonly ResearchPageMembership[]>([]);
  const [researchBusyPage, setResearchBusyPage] = useState<number | null>(null);
  const [researchFeedback, setResearchFeedback] = useState<
    { readonly kind: 'success' | 'danger'; readonly text: string } | undefined
  >();
  const filtersPanel = useRef<HTMLDetailsElement>(null);
  const previewRequest = useRef(0);
  const markdownCache = useRef(new Map<number, string>());

  useEffect(() => {
    let current = true;
    void api<JsonRecord>('/v1/research')
      .then((response) => current && setResearches(researchSummaries(response['items'])))
      .catch(() => current && setResearches([]));
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const document = (preview?.['document'] as JsonRecord | undefined) ?? {};
    const isPdf = asText(document['format'], '').toLowerCase() === 'pdf';
    const documentId = asNumber(preview?.['documentId']);
    if (selectedResearchId === null || !isPdf || documentId < 1) {
      setPageMemberships([]);
      return;
    }
    let current = true;
    void api<JsonRecord>(
      `/v1/research/${String(selectedResearchId)}/page-memberships?documentId=${String(documentId)}`,
    )
      .then((response) => current && setPageMemberships(researchPageMemberships(response['items'])))
      .catch(() => current && setPageMemberships([]));
    return () => {
      current = false;
    };
  }, [preview, selectedResearchId]);

  const loadMemberships = async (hits: readonly JsonRecord[]) => {
    const chunkIds = [...new Set(hits.map((hit) => asNumber(hit['chunkId'])))].filter(
      (id) => Number.isSafeInteger(id) && id > 0,
    );
    if (chunkIds.length === 0) {
      setMemberships([]);
      return;
    }
    try {
      const response = await api<JsonRecord>(
        `/v1/research/memberships?chunkIds=${encodeURIComponent(chunkIds.join(','))}`,
      );
      setMemberships(researchMemberships(response['items']));
    } catch {
      setMemberships([]);
    }
  };

  const search = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    previewRequest.current += 1;
    setPreview(null);
    setPdfOpen(false);
    setMarkdownOpen(false);
    setSearchMarkdown('');
    setSearchMarkdownLoading(false);
    setSearchMarkdownError('');
    markdownCache.current.clear();
    setPdfEvidence([]);
    setPdfEvidenceLoading(false);
    setPdfSemanticEvidenceStatus('not-requested');
    setMemberships([]);
    setPageMemberships([]);
    setResearchFeedback(undefined);
    if (filtersPanel.current !== null) filtersPanel.current.open = false;
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
    filters['minimumConfidence'] = minimumConfidence;
    try {
      const response = await postJson<JsonRecord>('/v1/search', {
        query,
        mode,
        silos: selectedSilos,
        filters,
        limit: 20,
        rerank: false,
      });
      const found = list(response['items']);
      setResults(found);
      void loadMemberships(found);
      setExecutedSearch({
        query: asText(response['normalizedQuery'], query.normalize('NFC').trim()),
        mode,
      });
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
    const requestId = previewRequest.current + 1;
    previewRequest.current = requestId;
    const documentId = asNumber(hit['documentId']);
    const isPdf =
      asText((hit['document'] as JsonRecord | undefined)?.['format'], '').toLowerCase() === 'pdf';
    const rankedEvidence = asPdfEvidence(hit['evidence']);
    const immediateEvidence = isPdf
      ? mergePdfEvidence(immediateExactPdfEvidence(executedSearch.query), rankedEvidence)
      : rankedEvidence;
    // Ranked semantic evidence is useful immediately, but it is not guaranteed to
    // be locatable on the cited PDF page after overlapping hits are collapsed.
    // Always ask for page-passage evidence in non-keyword PDF modes. The server
    // cache makes repeated requests inexpensive.
    const needsSemanticEvidence = isPdf && executedSearch.mode !== 'keyword';
    setPreview(hit);
    setPdfOpen(isPdf);
    setMarkdownOpen(!isPdf);
    setContext(null);
    setPdfEvidence(immediateEvidence);
    setPdfEvidenceLoading(needsSemanticEvidence);
    setPdfSemanticEvidenceStatus(needsSemanticEvidence ? 'loading' : 'not-requested');
    setSearchMarkdownError('');
    setResearchFeedback(undefined);
    const cachedMarkdown = markdownCache.current.get(documentId);
    if (isPdf) {
      setSearchMarkdown('');
      setSearchMarkdownLoading(false);
    } else {
      setSearchMarkdown(cachedMarkdown ?? '');
      setSearchMarkdownLoading(cachedMarkdown === undefined);
      if (cachedMarkdown === undefined) {
        void api<string>(`/v1/documents/${String(documentId)}/markdown`)
          .then((value) => {
            markdownCache.current.set(documentId, value);
            if (previewRequest.current !== requestId) return;
            setSearchMarkdown(value);
            setSearchMarkdownLoading(false);
          })
          .catch((reason: unknown) => {
            if (previewRequest.current !== requestId) return;
            setSearchMarkdownError(
              `The extracted Markdown could not be opened: ${displayError(reason)}`,
            );
            setSearchMarkdownLoading(false);
          });
      }
    }
    const chunkIds = numberList(hit['chunkIds']);
    if (chunkIds.length === 0) chunkIds.push(asNumber(hit['chunkId']));
    const [loadedContext, loadedEvidence] = await Promise.allSettled([
      api<JsonRecord>(`/v1/chunks/${String(hit['chunkId'])}/context?before=1&after=1`),
      needsSemanticEvidence
        ? postJson<{
            readonly items: readonly PdfEvidence[];
            readonly semanticStatus: 'ready' | 'unavailable' | 'not-requested';
          }>('/v1/search/evidence', {
            query: executedSearch.query,
            mode: executedSearch.mode,
            chunkIds,
          })
        : Promise.resolve({
            items: [] as readonly PdfEvidence[],
            semanticStatus: 'not-requested' as const,
          }),
    ]);
    if (previewRequest.current !== requestId) return;
    setContext(
      loadedContext.status === 'fulfilled'
        ? loadedContext.value
        : { error: displayError(loadedContext.reason) },
    );
    setPdfEvidence(
      loadedEvidence.status === 'fulfilled'
        ? mergePdfEvidence(immediateEvidence, loadedEvidence.value.items)
        : immediateEvidence,
    );
    setPdfEvidenceLoading(false);
    setPdfSemanticEvidenceStatus(
      !needsSemanticEvidence
        ? 'not-requested'
        : loadedEvidence.status === 'fulfilled' &&
            loadedEvidence.value.semanticStatus !== 'unavailable'
          ? 'ready'
          : 'unavailable',
    );
  };

  const selectedResearch = researches.find(({ id }) => id === selectedResearchId) ?? null;
  const membershipFor = (hit: JsonRecord): ResearchMembership | undefined =>
    selectedResearchId === null
      ? undefined
      : memberships.find(
          (membership) =>
            membership.chunkId === asNumber(hit['chunkId']) &&
            membership.researchId === selectedResearchId,
        );

  const toggleResearch = async (hit: JsonRecord) => {
    if (selectedResearch === null) {
      setResearchFeedback({
        kind: 'danger',
        text: 'Select a research collection at the top of Search before saving this passage.',
      });
      return;
    }
    const chunkId = asNumber(hit['chunkId']);
    if (researchBusyChunkId !== null) return;
    const existing = membershipFor(hit);
    if (
      existing !== undefined &&
      !confirm(
        `Remove this saved passage from “${selectedResearch.name}”?\n\nThe source document will not be deleted.`,
      )
    )
      return;
    setResearchBusyChunkId(chunkId);
    setResearchFeedback(undefined);
    try {
      if (existing !== undefined) {
        await api<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/items/${String(existing.researchItemId)}`,
          { method: 'DELETE', idempotent: true },
        );
        setMemberships((current) =>
          current.filter((membership) => membership.researchItemId !== existing.researchItemId),
        );
        setResearchFeedback({
          kind: 'success',
          text: `Removed this passage from ${selectedResearch.name}.`,
        });
      } else {
        const rawLocator = (hit['locator'] as JsonRecord | undefined) ?? {};
        const chunkIds = numberList(hit['chunkIds']);
        if (!chunkIds.includes(chunkId)) chunkIds.unshift(chunkId);
        const saved = await postJson<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/items`,
          {
            siloId: asNumber(hit['siloId']),
            documentId: asNumber(hit['documentId']),
            chunkId,
            chunkIds: chunkIds.slice(0, 8),
            text: asText(hit['text'], ''),
            headingPath: stringList(hit['headingPath']),
            locator: {
              pageStart:
                rawLocator['pageStart'] === null || rawLocator['pageStart'] === undefined
                  ? null
                  : asNumber(rawLocator['pageStart']),
              pageEnd:
                rawLocator['pageEnd'] === null || rawLocator['pageEnd'] === undefined
                  ? null
                  : asNumber(rawLocator['pageEnd']),
              pageLabel: asText(rawLocator['pageLabel'], ''),
              pageBasis: asText(rawLocator['pageBasis'], 'none'),
              characterStart: asNumber(rawLocator['characterStart']),
              characterEnd: asNumber(rawLocator['characterEnd']),
              characterUnit: 'utf16',
              byteStart: asNumber(rawLocator['byteStart']),
              byteEnd: asNumber(rawLocator['byteEnd']),
              byteUnit: 'utf8',
              offsetsMatchOriginal: rawLocator['offsetsMatchOriginal'] === true,
              pageLabels: stringList(rawLocator['pageLabels']),
            },
            confidence: Math.min(1, Math.max(0, asNumber(hit['confidence']))),
            evidence: asPdfEvidence(hit['evidence']),
            query: executedSearch.query,
            mode: executedSearch.mode,
          },
          { idempotent: true },
        );
        setMemberships((current) => [
          ...current.filter(
            (membership) =>
              !(membership.chunkId === chunkId && membership.researchId === selectedResearch.id),
          ),
          {
            chunkId,
            researchId: selectedResearch.id,
            researchName: selectedResearch.name,
            researchItemId: asNumber(saved['researchItemId']),
          },
        ]);
        setResearchFeedback({
          kind: 'success',
          text: `Saved this passage in ${selectedResearch.name}.`,
        });
      }
    } catch (reason) {
      setResearchFeedback({ kind: 'danger', text: displayError(reason) });
    } finally {
      setResearchBusyChunkId(null);
    }
  };

  const toggleResearchPage = async (hit: JsonRecord, pageNumber: number) => {
    if (selectedResearch === null) {
      setResearchFeedback({
        kind: 'danger',
        text: 'Select a research collection at the top of Search before saving this page.',
      });
      return;
    }
    if (researchBusyPage !== null) return;
    const normalizedPage = Math.max(1, Math.trunc(pageNumber));
    const existing = pageMemberships.find((membership) => membership.pageNumber === normalizedPage);
    if (
      existing !== undefined &&
      !confirm(
        `Remove page ${String(normalizedPage)} from “${selectedResearch.name}”?\n\nThe source document will not be deleted.`,
      )
    )
      return;
    setResearchBusyPage(normalizedPage);
    setResearchFeedback(undefined);
    try {
      if (existing !== undefined) {
        await api<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/items/${String(existing.researchItemId)}`,
          { method: 'DELETE', idempotent: true },
        );
        setPageMemberships((current) =>
          current.filter((membership) => membership.researchItemId !== existing.researchItemId),
        );
        setResearchFeedback({
          kind: 'success',
          text: `Removed page ${String(normalizedPage)} from ${selectedResearch.name}.`,
        });
      } else {
        const saved = await postJson<JsonRecord>(
          `/v1/research/${String(selectedResearch.id)}/pages`,
          {
            siloId: asNumber(hit['siloId']),
            documentId: asNumber(hit['documentId']),
            anchorChunkId: asNumber(hit['chunkId']),
            pageOrdinal: normalizedPage - 1,
            confidence: Math.min(1, Math.max(0, asNumber(hit['confidence']))),
            evidence: pdfEvidence,
            query: executedSearch.query,
            mode: executedSearch.mode,
          },
          { idempotent: true },
        );
        setPageMemberships((current) => [
          ...current.filter((membership) => membership.pageNumber !== normalizedPage),
          {
            researchItemId: asNumber(saved['researchItemId']),
            pageOrdinal: asNumber(saved['pageOrdinal']),
            pageNumber: normalizedPage,
          },
        ]);
        setResearchFeedback({
          kind: 'success',
          text: `Saved page ${String(normalizedPage)} in ${selectedResearch.name}.`,
        });
      }
    } catch (reason) {
      setResearchFeedback({ kind: 'danger', text: displayError(reason) });
    } finally {
      setResearchBusyPage(null);
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
  const viewerResults = useMemo(() => grouped.flat(), [grouped]);
  const previewResultIndex =
    preview === null
      ? -1
      : viewerResults.findIndex(
          (hit) =>
            asNumber(hit['documentId']) === asNumber(preview['documentId']) &&
            asNumber(hit['chunkId']) === asNumber(preview['chunkId']),
        );
  const previousViewerResult =
    previewResultIndex > 0 ? viewerResults[previewResultIndex - 1] : undefined;
  const nextViewerResult =
    previewResultIndex >= 0 && previewResultIndex < viewerResults.length - 1
      ? viewerResults[previewResultIndex + 1]
      : undefined;
  const currentResearchMembership = preview === null ? undefined : membershipFor(preview);
  const viewerResearchAction =
    preview === null
      ? undefined
      : {
          researchName: selectedResearch?.name ?? null,
          saved: currentResearchMembership !== undefined,
          busy: researchBusyChunkId === asNumber(preview['chunkId']),
          ...(researchFeedback === undefined ? {} : { feedback: researchFeedback }),
          toggle: () => void toggleResearch(preview),
          page: {
            savedPages: new Set(pageMemberships.map(({ pageNumber }) => pageNumber)),
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
      void toggleResearch(preview);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [markdownOpen, pdfOpen, preview, researchBusyChunkId, selectedResearchId, memberships]);

  return (
    <div class="page search-page">
      <PageHeading
        eyebrow="Knowledge search"
        title="Ask your documents"
        detail="Every result links back to its exact source and surrounding passage."
        action={
          <label class="research-search-target">
            <span>Save passages to research</span>
            <select
              aria-label="Research collection"
              value={selectedResearchId ?? ''}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                setSelectedResearchId(Number.isSafeInteger(value) && value > 0 ? value : null);
                setResearchFeedback(undefined);
              }}
            >
              <option value="">No research selected</option>
              {researches.map((research) => (
                <option value={research.id}>
                  {research.name} ({String(research.itemCount)})
                </option>
              ))}
            </select>
            <small>
              {researches.length === 0
                ? 'Create a collection from Research first.'
                : 'Press 0 in a document viewer to save or remove a passage.'}
            </small>
          </label>
        }
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
                ['semantic', 'Semantic'],
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
          <details class="filters" ref={filtersPanel}>
            <summary>Filters</summary>
            <div class="filter-grid">
              <label class="field confidence-filter">
                <span>
                  Minimum confidence <output>{Math.round(minimumConfidence * 100)}%</output>
                </span>
                <input
                  aria-label="Minimum confidence"
                  name="minimumConfidence"
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.05"
                  value={minimumConfidence}
                  onInput={(event) => setMinimumConfidence(Number(event.currentTarget.value))}
                />
                <small>
                  Lower this to include broader matches; raise it to show only stronger matches.
                </small>
              </label>
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
            <p>
              Meaning finds related passages. Semantic confirms matching sentences. Keyword finds
              exact wording. Both combines meaning and keywords.
            </p>
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
                  const savedIn = memberships.filter(
                    (membership) => membership.chunkId === asNumber(hit['chunkId']),
                  );
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
                      <span
                        class="score"
                        title="Estimated strength of this retrieval match; it is not answer certainty."
                      >
                        Confidence {Math.round(asNumber(hit['confidence']) * 100)}%
                      </span>
                      {savedIn.length === 0 ? null : (
                        <span class="research-flags">
                          {savedIn.map((membership) => (
                            <span>Saved in {membership.researchName}</span>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </article>
            );
          })}
        </section>
      )}
      {preview === null ? null : pdfOpen ? (
        <PdfViewer
          documentId={asNumber(preview['documentId'])}
          title={asText(
            (preview['document'] as JsonRecord | undefined)?.['title'],
            asText((preview['document'] as JsonRecord | undefined)?.['name'], 'Document'),
          )}
          initialPage={Math.max(
            1,
            Math.trunc(
              asNumber((preview['locator'] as JsonRecord | undefined)?.['pageStart'] ?? 1),
            ),
          )}
          citationKey={String(preview['chunkId'])}
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
          evidence={pdfEvidence}
          evidenceLoading={pdfEvidenceLoading}
          semanticEvidenceStatus={pdfSemanticEvidenceStatus}
          highlightsEnabled={pdfHighlightsEnabled}
          onHighlightsChange={setPdfHighlightsEnabled}
          searchNavigation={{
            previous:
              previousViewerResult === undefined
                ? null
                : () => void openPreview(previousViewerResult),
            next: nextViewerResult === undefined ? null : () => void openPreview(nextViewerResult),
          }}
          {...(viewerResearchAction === undefined ? {} : { researchAction: viewerResearchAction })}
          showSourcePassage={() => setPdfOpen(false)}
          close={() => {
            setPdfOpen(false);
            setPreview(null);
          }}
        />
      ) : markdownOpen ? (
        <MarkdownSearchViewer
          documentId={asNumber(preview['documentId'])}
          title={asText(
            (preview['document'] as JsonRecord | undefined)?.['title'],
            asText((preview['document'] as JsonRecord | undefined)?.['name'], 'Document'),
          )}
          format={asText((preview['document'] as JsonRecord | undefined)?.['format'], 'document')}
          markdown={searchMarkdown}
          loading={searchMarkdownLoading}
          error={searchMarkdownError}
          colorScheme={colorScheme}
          confidence={asNumber(preview['confidence'])}
          citationKey={String(preview['chunkId'])}
          citationText={asText(preview['text'])}
          citationCharacterStart={asNumber(
            (preview['locator'] as JsonRecord | undefined)?.['characterStart'],
          )}
          searchNavigation={{
            previous:
              previousViewerResult === undefined
                ? null
                : () => void openPreview(previousViewerResult),
            next: nextViewerResult === undefined ? null : () => void openPreview(nextViewerResult),
          }}
          {...(viewerResearchAction === undefined ? {} : { researchAction: viewerResearchAction })}
          showSourcePassage={() => setMarkdownOpen(false)}
          close={() => {
            setMarkdownOpen(false);
            setPreview(null);
          }}
        />
      ) : (
        <Modal title="Source passage" wide close={() => setPreview(null)}>
          <div class="preview-toolbar">
            <button
              class={
                currentResearchMembership === undefined
                  ? 'secondary research-toggle'
                  : 'secondary research-toggle saved'
              }
              type="button"
              aria-keyshortcuts="0"
              aria-pressed={currentResearchMembership !== undefined}
              disabled={researchBusyChunkId === asNumber(preview['chunkId'])}
              onClick={() => void toggleResearch(preview)}
            >
              {currentResearchMembership === undefined
                ? `Save to ${selectedResearch?.name ?? 'research'}`
                : `Remove from ${selectedResearch?.name ?? 'research'}`}{' '}
              <kbd>0</kbd>
            </button>
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
            {asText(
              (preview['document'] as JsonRecord | undefined)?.['format'],
              '',
            ).toLowerCase() === 'pdf' ? (
              <button class="primary" type="button" onClick={() => setPdfOpen(true)}>
                <Icon name="documents" />
                View PDF at cited page
              </button>
            ) : (
              <button class="primary" type="button" onClick={() => setMarkdownOpen(true)}>
                <Icon name="documents" />
                View Markdown at cited passage
              </button>
            )}
            <a
              class="secondary button-link"
              href={appUrl(`/v1/documents/${String(preview['documentId'])}/original`)}
            >
              <Icon name="documents" />
              Open original
            </a>
          </div>
          {researchFeedback === undefined ? null : (
            <Notice kind={researchFeedback.kind}>{researchFeedback.text}</Notice>
          )}
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

const DocumentsView = ({
  silos,
  colorScheme,
  serverAdmin,
  refreshWorkspaceSilos,
}: {
  readonly silos: readonly Silo[];
  readonly colorScheme: ColorScheme;
  readonly serverAdmin: boolean;
  readonly refreshWorkspaceSilos: () => Promise<void>;
}) => {
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  const [selectedSiloId, setSelectedSiloId] = useState(silos[0]?.id ?? 0);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [knowledgeBaseEditor, setKnowledgeBaseEditor] = useState<
    { readonly kind: 'create' } | { readonly kind: 'edit'; readonly item: JsonRecord } | null
  >(null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<JsonRecord | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const selectedSilo = silos.find((silo) => silo.id === selectedSiloId) ?? null;
  const loaded = useLoad(
    selectedSiloId > 0
      ? `/v1/documents?siloId=${String(selectedSiloId)}&limit=100${filter ? `&state=${filter}` : ''}`
      : null,
    refresh,
  );
  const extractionDiagnostics = useLoad(
    selected !== null && asText(selected['format'], '').toLowerCase() === 'pdf'
      ? `/v1/documents/${String(selected['id'])}/extraction-diagnostics`
      : null,
    refresh,
  );
  const docs = list(loaded.data?.['items']);
  const selectedJobs = list(selected?.['ingestionJobs']);
  const currentJob =
    selectedJobs.find((job) => activeJobStates.has(asText(job['state'], ''))) ?? selectedJobs[0];
  const ingestionStartTimes = selectedJobs
    .map((job) => Date.parse(asText(job['createdAt'], '')))
    .filter(Number.isFinite);
  const ingestionFinishTimes = selectedJobs
    .map((job) => Date.parse(asText(job['finishedAt'], '')))
    .filter(Number.isFinite);
  const ingestionStartedAt =
    ingestionStartTimes.length === 0 ? undefined : Math.min(...ingestionStartTimes);
  const ingestionFinishedAt =
    selectedJobs.some((job) => activeJobStates.has(asText(job['state'], ''))) ||
    ingestionFinishTimes.length === 0
      ? undefined
      : Math.max(...ingestionFinishTimes);
  useEffect(() => {
    if (silos.some((silo) => silo.id === selectedSiloId)) return;
    setSelectedSiloId(silos[0]?.id ?? 0);
  }, [silos, selectedSiloId]);
  useEffect(() => {
    setSelected(null);
    setPdfOpen(false);
  }, [selectedSiloId]);
  useEffect(() => {
    if (selected === null) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setRefresh((value) => value + 1);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [selected === null ? null : selected['id']]);
  useEffect(() => {
    if (selected === null) return;
    const updated = list(loaded.data?.['items']).find(
      (document) => asNumber(document['id']) === asNumber(selected['id']),
    );
    if (updated !== undefined) setSelected(updated);
  }, [loaded.data]);
  const open = async (document: JsonRecord) => {
    setSelected(document);
    setPdfOpen(false);
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
      if (kind === 'reindex' && asText(selected['format'], '').toLowerCase() === 'pdf') {
        const estimate = await api<JsonRecord>(
          `/v1/documents/${String(selected['id'])}/enhanced-reindex-estimate`,
        );
        const candidates = asNumber(estimate['estimatedImages']);
        const batches = asNumber(estimate['estimatedBatches']);
        const proceed = window.confirm(
          `Re-index this PDF from the retained original?\n\n${String(asNumber(estimate['pageCount']))} pages; ${String(candidates)} provisional vision candidate${candidates === 1 ? '' : 's'} in about ${String(batches)} batch${batches === 1 ? '' : 'es'}. Markdown, passages, and embeddings will be rebuilt.`,
        );
        if (!proceed) return;
      }
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
          ...(kind === 'reindex' && asText(selected['format'], '').toLowerCase() === 'pdf'
            ? { enhanced: true }
            : {}),
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
  const openKnowledgeBaseEditor = async () => {
    if (!serverAdmin || selectedSilo === null) return;
    setError('');
    try {
      const response = await api<JsonRecord>('/v1/admin/silos');
      const item = list(response['items']).find(
        (candidate) => asNumber(candidate['id']) === selectedSilo.id,
      );
      setKnowledgeBaseEditor({
        kind: 'edit',
        item: item ?? {
          id: selectedSilo.id,
          slug: selectedSilo.slug,
          displayName: selectedSilo.displayName,
          description: '',
        },
      });
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const saveKnowledgeBase = async (event: SubmitEvent) => {
    event.preventDefault();
    if (knowledgeBaseEditor === null) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setError('');
    try {
      if (knowledgeBaseEditor.kind === 'create') {
        const created = await postJson<{ readonly id: number }>(
          '/v1/admin/silos',
          {
            slug: String(form.get('slug')),
            displayName: String(form.get('displayName')),
            description: String(form.get('description') ?? ''),
          },
          { idempotent: true },
        );
        setMessage(
          'Knowledge base created. Its document list is ready for uploads or input folders.',
        );
        await refreshWorkspaceSilos();
        setSelectedSiloId(created.id);
      } else {
        await postJson(
          `/v1/admin/silos/${String(knowledgeBaseEditor.item['id'])}`,
          {
            displayName: String(form.get('displayName')),
            description: String(form.get('description') ?? ''),
          },
          { method: 'PATCH', idempotent: true },
        );
        setMessage('Knowledge base details saved.');
        await refreshWorkspaceSilos();
      }
      setKnowledgeBaseEditor(null);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  const purgeKnowledgeBase = async () => {
    if (knowledgeBaseEditor?.kind !== 'edit') return;
    const slug = asText(knowledgeBaseEditor.item['slug'], '');
    if (window.prompt(`Type ${slug} to permanently purge this knowledge base`) !== slug) return;
    setError('');
    try {
      await api(`/v1/admin/silos/${String(knowledgeBaseEditor.item['id'])}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmSlug: slug }),
        idempotent: true,
      });
      setKnowledgeBaseEditor(null);
      setSelectedSiloId(0);
      setMessage('Knowledge base permanently purged.');
      await refreshWorkspaceSilos();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    }
  };
  return (
    <div class="page">
      <PageHeading
        eyebrow="Document libraries"
        title="Knowledge Bases"
        detail="Choose a knowledge base first, then review and manage every document that belongs to it."
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
      <section class="knowledge-workspace-toolbar" aria-label="Knowledge base controls">
        <div class="knowledge-switcher">
          <button
            class="knowledge-switcher-button"
            type="button"
            aria-label="Choose knowledge base"
            aria-expanded={switcherOpen}
            aria-controls="knowledge-base-menu"
            onClick={() => setSwitcherOpen((value) => !value)}
          >
            <Icon name="menu" />
            <span>
              <small>Knowledge base</small>
              <b>{selectedSilo?.displayName ?? 'Choose a knowledge base'}</b>
            </span>
            <Icon name="arrow" />
          </button>
          {switcherOpen ? (
            <div class="knowledge-switcher-menu" id="knowledge-base-menu" role="menu">
              {silos.length === 0 ? (
                <p>No knowledge bases are assigned to your account.</p>
              ) : (
                silos.map((silo) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={silo.id === selectedSiloId}
                    onClick={() => {
                      setSelectedSiloId(silo.id);
                      setSwitcherOpen(false);
                    }}
                  >
                    <span>
                      <b>{silo.displayName}</b>
                      <small>{silo.slug}</small>
                    </span>
                    {silo.id === selectedSiloId ? <Icon name="check" /> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        {serverAdmin ? (
          <div class="knowledge-workspace-actions">
            <button
              class="primary"
              type="button"
              onClick={() => setKnowledgeBaseEditor({ kind: 'create' })}
            >
              <Icon name="plus" />
              Add knowledge base
            </button>
            <button
              class="secondary"
              type="button"
              disabled={selectedSilo === null}
              onClick={() => void openKnowledgeBaseEditor()}
            >
              <Icon name="edit" />
              Edit selected
            </button>
          </div>
        ) : null}
      </section>
      {selectedSilo === null ? null : (
        <div class="selected-knowledge-base-summary">
          <div>
            <b>{selectedSilo.displayName}</b>
            <small>{selectedSilo.slug}</small>
          </div>
          <span>
            {String(docs.length)} {docs.length === 1 ? 'document' : 'documents'} shown
          </span>
        </div>
      )}
      {message ? <Notice kind="success">{message}</Notice> : null}
      {loaded.error || error ? <Notice kind="danger">{loaded.error || error}</Notice> : null}
      {selectedSilo === null ? (
        <EmptyState
          title="Choose a knowledge base"
          detail="Select a knowledge base above to see its documents."
          action={
            serverAdmin ? (
              <button class="primary" onClick={() => setKnowledgeBaseEditor({ kind: 'create' })}>
                Add the first knowledge base
              </button>
            ) : undefined
          }
        />
      ) : loaded.data === null ? (
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
      {selected === null ? null : pdfOpen ? (
        <PdfViewer
          documentId={asNumber(selected['id'])}
          title={asText(selected['title'], asText(selected['name'], 'Document'))}
          initialPage={1}
          close={() => setPdfOpen(false)}
        />
      ) : (
        <Modal
          title={asText(selected['title'], asText(selected['name']))}
          wide
          className="document-modal"
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
          {currentJob === undefined ? null : (
            <section class="document-ingestion" aria-live="polite">
              <div class="section-heading compact">
                <div>
                  <h3>Ingestion progress</h3>
                  <p>Live extraction, image-analysis, and embedding status for this document.</p>
                </div>
                <StatusPill value={friendlyJobState(asText(currentJob['state'], 'queued'))} />
              </div>
              <JobProgress
                job={currentJob}
                now={now}
                document={selected}
                {...(ingestionStartedAt === undefined ? {} : { startedAt: ingestionStartedAt })}
                {...(ingestionFinishedAt === undefined ? {} : { finishedAt: ingestionFinishedAt })}
              />
            </section>
          )}
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
          {asText(selected['format'], '').toLowerCase() !== 'pdf' ? null : (
            <section class="document-ingestion extraction-diagnostics" aria-live="polite">
              <div class="section-heading compact">
                <div>
                  <h3>PDF extraction diagnostics</h3>
                  <p>
                    Extraction confidence measures text and layout reliability. It is separate from
                    search-result confidence.
                  </p>
                </div>
              </div>
              {extractionDiagnostics.data === null ? (
                extractionDiagnostics.error ? (
                  <Notice kind="warning">{extractionDiagnostics.error}</Notice>
                ) : (
                  <SkeletonRows count={2} />
                )
              ) : (
                <>
                  <div class="document-summary">
                    <span>
                      Version{' '}
                      {asText(
                        record(extractionDiagnostics.data['revisions'])['pdfExtractionVersion'],
                        'legacy',
                      )}
                    </span>
                    <span>
                      {String(asNumber(record(extractionDiagnostics.data['blockCounts'])['total']))}{' '}
                      blocks
                    </span>
                    <span>
                      {String(
                        asNumber(record(extractionDiagnostics.data['blockCounts'])['nativeSafe']),
                      )}{' '}
                      native-safe
                    </span>
                    <span>
                      {String(
                        asNumber(
                          record(extractionDiagnostics.data['blockCounts'])['regionalVision'],
                        ),
                      )}{' '}
                      regional candidates
                    </span>
                    <span>
                      {String(
                        asNumber(
                          record(extractionDiagnostics.data['blockCounts'])['lowConfidence'],
                        ),
                      )}{' '}
                      below the native threshold
                    </span>
                    <span>
                      {String(
                        asNumber(record(extractionDiagnostics.data['vision'])['providerCalls']),
                      )}{' '}
                      provider calls
                    </span>
                    <span>
                      {String(asNumber(record(extractionDiagnostics.data['vision'])['cacheHits']))}{' '}
                      cache hits
                    </span>
                    <span>
                      {Math.round(
                        asNumber(record(extractionDiagnostics.data['vision'])['cacheHitRate']) *
                          100,
                      )}
                      % cache hit rate
                    </span>
                    <span>
                      {formatDuration(asNumber(extractionDiagnostics.data['extractionElapsedMs']))}{' '}
                      extraction time
                    </span>
                  </div>
                  {stringList(extractionDiagnostics.data['warnings']).length === 0 ? null : (
                    <Notice kind="warning">
                      {stringList(extractionDiagnostics.data['warnings']).join(', ')}
                    </Notice>
                  )}
                </>
              )}
            </section>
          )}
          <MarkdownViewer markdown={markdown} colorScheme={colorScheme} />
          <div class="button-row">
            {asText(selected['format'], '').toLowerCase() === 'pdf' ? (
              <button class="primary" type="button" onClick={() => setPdfOpen(true)}>
                View PDF
              </button>
            ) : null}
            <a
              class="secondary button-link"
              href={appUrl(`/v1/documents/${String(selected['id'])}/original`)}
            >
              Download original
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
      {knowledgeBaseEditor === null ? null : (
        <Modal
          title={
            knowledgeBaseEditor.kind === 'create' ? 'Add a knowledge base' : 'Edit knowledge base'
          }
          close={() => setKnowledgeBaseEditor(null)}
        >
          <p class="modal-introduction">
            A knowledge base is an isolated document library. Search access and ingestion remain
            scoped to the selected library.
          </p>
          <form class="knowledge-base-form" onSubmit={(event) => void saveKnowledgeBase(event)}>
            <Field label="Name" hint="The friendly name people see throughout NodeRag.">
              <input
                name="displayName"
                defaultValue={
                  knowledgeBaseEditor.kind === 'edit'
                    ? asText(
                        knowledgeBaseEditor.item['displayName'],
                        asText(knowledgeBaseEditor.item['display_name'], ''),
                      )
                    : ''
                }
                maxLength={120}
                required
                autoFocus
              />
            </Field>
            <Field
              label="Slug"
              hint={
                knowledgeBaseEditor.kind === 'edit'
                  ? 'The slug is a permanent identifier and cannot be changed after creation.'
                  : 'Permanent lowercase identifier, such as company-policies.'
              }
            >
              <input
                name="slug"
                defaultValue={
                  knowledgeBaseEditor.kind === 'edit'
                    ? asText(knowledgeBaseEditor.item['slug'], '')
                    : ''
                }
                pattern="[a-z][a-z0-9-]{1,62}"
                readOnly={knowledgeBaseEditor.kind === 'edit'}
                required
              />
            </Field>
            <Field label="Description" hint="Explain what belongs in this library.">
              <textarea
                name="description"
                defaultValue={
                  knowledgeBaseEditor.kind === 'edit'
                    ? asText(knowledgeBaseEditor.item['description'], '')
                    : ''
                }
                maxLength={2000}
                rows={4}
              />
            </Field>
            <div class="button-row knowledge-base-form-actions">
              <button class="primary">
                {knowledgeBaseEditor.kind === 'create' ? 'Create knowledge base' : 'Save changes'}
              </button>
              <button class="secondary" type="button" onClick={() => setKnowledgeBaseEditor(null)}>
                Cancel
              </button>
              {knowledgeBaseEditor.kind === 'edit' ? (
                <button
                  class="danger-button knowledge-base-purge"
                  type="button"
                  onClick={() => void purgeKnowledgeBase()}
                >
                  Permanently purge
                </button>
              ) : null}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

const IngestView = ({ silos }: { readonly silos: readonly Silo[] }) => {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sourceSiloId, setSourceSiloId] = useState(silos[0]?.id ?? 0);
  const [sourcePath, setSourcePath] = useState('');
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [sourceToDisconnect, setSourceToDisconnect] = useState<JsonRecord | null>(null);
  const sources = useLoad('/v1/sources', refresh);
  const jobs = useLoad('/v1/jobs', refresh);
  const allJobs = useMemo(() => list(jobs.data?.['items']), [jobs.data]);
  const documentWorkflows = useMemo(() => groupDocumentWorkflows(allJobs), [allJobs]);
  const folderScans = useMemo(
    () =>
      groupLatestJobs(
        allJobs.filter((job) => asText(job['kind'], '') === 'crawl'),
        'sourceId',
      ),
    [allJobs],
  );
  const visibleDocumentWorkflows = documentWorkflows.filter(
    (workflow) =>
      showFinished || !['succeeded', 'cancelled'].includes(asText(workflow.job['state'], '')),
  );
  const visibleFolderScans = folderScans.filter(
    (job) => showFinished || !['succeeded', 'cancelled'].includes(asText(job['state'], '')),
  );
  const hiddenFinishedCount =
    documentWorkflows.length -
    visibleDocumentWorkflows.length +
    (folderScans.length - visibleFolderScans.length);
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
  const crawlSource = async (source: JsonRecord) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const queued = await postJson<JsonRecord>(
        `/v1/sources/${String(source['id'])}/crawl`,
        { siloId: Number(source['siloId']) },
        { idempotent: true },
      );
      setMessage(`Crawl queued as job #${String(queued['jobId'])}.`);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  const updateSource = async (event: SubmitEvent, source: JsonRecord) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const schedule = String(form.get('schedule') ?? '').trim();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await postJson(
        `/v1/sources/${String(source['id'])}`,
        {
          siloId: Number(source['siloId']),
          includeGlobs: String(form.get('include'))
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          excludeGlobs: String(form.get('exclude'))
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          scheduleIntervalMinutes: schedule === '' ? null : Number(schedule),
          scheduleEnabled: schedule !== '',
        },
        { method: 'PATCH', idempotent: true },
      );
      setMessage('Input-folder settings saved.');
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };
  const disconnectSource = async () => {
    const source = sourceToDisconnect;
    if (source === null) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/v1/sources/${String(source['id'])}`, {
        method: 'DELETE',
        body: JSON.stringify({ siloId: Number(source['siloId']) }),
        idempotent: true,
      });
      setSourceToDisconnect(null);
      setMessage('Input folder disconnected. Previously ingested documents were retained.');
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
  const workflowAction = async (workflow: DocumentWorkflow, action: string) => {
    const eligibleStates =
      action === 'pause'
        ? new Set(['pending', 'retry_wait'])
        : action === 'resume'
          ? new Set(['paused'])
          : action === 'cancel'
            ? activeJobStates
            : new Set(['failed']);
    const targets = workflow.jobs.filter((job) => eligibleStates.has(asText(job['state'], '')));
    await Promise.all(targets.map(async (job) => jobAction(job, action)));
  };
  return (
    <div class="page">
      <PageHeading
        eyebrow="Bring knowledge in"
        title="Ingest"
        detail="Upload individual files, map shared folders, and watch each document move through processing."
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
              <select
                name="siloId"
                value={sourceSiloId}
                onChange={(event) => {
                  setSourceSiloId(Number(event.currentTarget.value));
                  setFolderBrowserOpen(false);
                }}
              >
                {silos.map((silo) => (
                  <option value={silo.id}>{silo.displayName}</option>
                ))}
              </select>
            </Field>
            <div class="field">
              <label for="source-folder-path">Source folder path</label>
              <div class="path-browser-field">
                <input
                  id="source-folder-path"
                  name="uri"
                  placeholder="/data/handbooks"
                  value={sourcePath}
                  onInput={(event) => setSourcePath(event.currentTarget.value)}
                  required
                />
                <button
                  class="secondary"
                  type="button"
                  disabled={sourceSiloId < 1}
                  onClick={() => setFolderBrowserOpen(true)}
                >
                  <Icon name="folder" />
                  Browse
                </button>
              </div>
              <small>
                Browse folders visible to the NodeRag server, or enter an absolute Linux/Synology
                path. Each supported file is copied into protected managed storage before
                processing.
              </small>
            </div>
            <div class="field-grid">
              <Field label="Include patterns">
                <input
                  name="include"
                  defaultValue="**/*.pdf, **/*.docx, **/*.xlsx, **/*.md, **/*.txt"
                />
                <small>
                  Separate patterns with commas. For example, **/*.pdf includes PDFs in this folder
                  and all folders below it.
                </small>
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
            <h2>Document processing</h2>
            <p>
              One row is shown per document. Each row moves through Markdown, chunking, and
              embedding, and refreshes every eight seconds.
            </p>
          </div>
          <div class="button-row queue-heading-actions">
            {hiddenFinishedCount > 0 || showFinished ? (
              <button class="secondary" onClick={() => setShowFinished((value) => !value)}>
                {showFinished ? 'Hide finished' : `Show finished (${String(hiddenFinishedCount)})`}
              </button>
            ) : null}
            <button class="secondary" onClick={() => setRefresh((v) => v + 1)}>
              Refresh
            </button>
          </div>
        </div>
        {jobs.error ? <Notice kind="danger">{jobs.error}</Notice> : null}
        {jobs.data === null ? (
          <SkeletonRows />
        ) : visibleDocumentWorkflows.length === 0 ? (
          <EmptyState
            title="No documents are processing"
            detail={
              documentWorkflows.length > 0
                ? 'Finished documents are hidden. Use Show finished to review them.'
                : 'New uploads and files found by a folder scan appear here.'
            }
          />
        ) : (
          <div class="job-list">
            {visibleDocumentWorkflows.map((workflow) => {
              const job = workflow.job;
              const state = asText(job['state'], '');
              const documentName = asText(job['documentName'], '');
              const documentPath = asText(job['documentPath'], '');
              const step = workflowStep(job);
              const currentTask = workflowTaskDetail(job);
              const now = Date.now();
              return (
                <article class="job document-workflow" key={workflow.key}>
                  <div class="workflow-identity">
                    <StatusPill value={friendlyJobState(state)} />
                    <b class="job-work-item" title={documentPath || documentName}>
                      {documentName || documentPath || `Document ${String(job['documentId'])}`}
                    </b>
                    {documentName && documentPath && documentName !== documentPath ? (
                      <small title={documentPath}>{documentPath}</small>
                    ) : null}
                    {asText(job['kind'], '') === 'vision' ? (
                      <small>Analysing the document's images before finalising its Markdown.</small>
                    ) : null}
                  </div>
                  <div class="workflow-progress">
                    <div class="workflow-steps" aria-label={`Step ${String(step)} of 3`}>
                      {['Markdown', 'Chunking', 'Embedding'].map((label, index) => {
                        const number = index + 1;
                        return (
                          <span
                            class={
                              state === 'succeeded' || number < step
                                ? 'complete'
                                : number === step
                                  ? 'current'
                                  : 'future'
                            }
                          >
                            {String(number)}/3 {label}
                          </span>
                        );
                      })}
                    </div>
                    <JobProgress
                      job={job}
                      now={now}
                      displayStage={workflowStageLabel(job)}
                      displayPercent={jobPercent(job)}
                    />
                    {currentTask ? <small>Current task: {currentTask}.</small> : null}
                    {jobActivityDetails(job, now).map((detail) => (
                      <small class={detail.startsWith('No progress update') ? 'stalled-note' : ''}>
                        {detail}
                      </small>
                    ))}
                  </div>
                  <div class="job-actions">
                    {['pending', 'retry_wait', 'queued'].includes(state) ? (
                      <button
                        class="job-action"
                        type="button"
                        onClick={() => void workflowAction(workflow, 'pause')}
                      >
                        Pause
                      </button>
                    ) : null}
                    {state === 'paused' ? (
                      <button
                        class="job-action"
                        type="button"
                        onClick={() => void workflowAction(workflow, 'resume')}
                      >
                        Resume
                      </button>
                    ) : null}
                    {state === 'failed' ? (
                      <button
                        class="job-action"
                        type="button"
                        onClick={() => void workflowAction(workflow, 'retry')}
                      >
                        Retry
                      </button>
                    ) : null}
                    {['pending', 'leased', 'retry_wait', 'queued', 'running', 'paused'].includes(
                      state,
                    ) ? (
                      <button
                        class="job-action danger-button"
                        type="button"
                        onClick={() => void workflowAction(workflow, 'cancel')}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {folderScans.length > 0 ? (
          <div class="folder-scan-section">
            <h3>Input-folder scans</h3>
            <p class="muted">
              A scan only looks for new, changed, or missing files. Documents it finds appear once
              in the document processing list above.
            </p>
            {visibleFolderScans.length === 0 ? (
              <p class="muted">Finished folder scans are hidden.</p>
            ) : (
              <div class="job-list compact-job-list">
                {visibleFolderScans.map((job) => {
                  const state = asText(job['state'], '');
                  return (
                    <article class="job folder-scan" key={String(job['id'])}>
                      <div>
                        <StatusPill value={friendlyJobState(state)} />
                        <b>Scanning input folder</b>
                        <small class="job-work-item" title={asText(job['sourceUri'], '')}>
                          {asText(job['sourceUri'], 'Folder path unavailable')}
                        </small>
                      </div>
                      <JobProgress job={job} now={Date.now()} />
                      <div class="job-actions">
                        {['pending', 'retry_wait'].includes(state) ? (
                          <button
                            class="job-action"
                            type="button"
                            onClick={() => void jobAction(job, 'pause')}
                          >
                            Pause
                          </button>
                        ) : null}
                        {state === 'paused' ? (
                          <button
                            class="job-action"
                            type="button"
                            onClick={() => void jobAction(job, 'resume')}
                          >
                            Resume
                          </button>
                        ) : null}
                        {state === 'failed' ? (
                          <button
                            class="job-action"
                            type="button"
                            onClick={() => void jobAction(job, 'retry')}
                          >
                            Retry
                          </button>
                        ) : null}
                        {activeJobStates.has(state) ? (
                          <button
                            class="job-action danger-button"
                            type="button"
                            onClick={() => void jobAction(job, 'cancel')}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </section>
      <section class="panel">
        <h2>Connected input folders</h2>
        {sources.data === null ? (
          <SkeletonRows />
        ) : list(sources.data['items']).length === 0 ? (
          <p class="muted">No folders connected.</p>
        ) : (
          <div class="editable-record-list">
            {list(sources.data['items']).map((source) => (
              <article class="editable-record" key={String(source['id'])}>
                <div class="editable-record-heading">
                  <div>
                    <h3 dir="auto">{asText(source['uri'])}</h3>
                    <small>
                      {source['scheduleEnabled']
                        ? `Automatic crawl every ${String(source['scheduleIntervalMinutes'])} ${Number(source['scheduleIntervalMinutes']) === 1 ? 'minute' : 'minutes'}`
                        : 'Manual crawl only'}
                    </small>
                    {source['lastCrawlAt'] ? (
                      <small>
                        Last crawl: {new Date(String(source['lastCrawlAt'])).toLocaleString()}
                      </small>
                    ) : (
                      <small>This folder has not been crawled yet.</small>
                    )}
                  </div>
                  <StatusPill value={asText(source['healthState'])} />
                </div>
                <div class="button-row">
                  <button
                    class="primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void crawlSource(source)}
                  >
                    Crawl now
                  </button>
                  <button
                    class="danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => setSourceToDisconnect(source)}
                  >
                    Disconnect folder
                  </button>
                </div>
                <details>
                  <summary>Edit schedule and patterns</summary>
                  <form onSubmit={(event) => void updateSource(event, source)}>
                    <div class="field-grid">
                      <Field label="Include patterns">
                        <input
                          name="include"
                          defaultValue={stringList(source['includeGlobs']).join(', ')}
                        />
                      </Field>
                      <Field label="Exclude patterns">
                        <input
                          name="exclude"
                          defaultValue={stringList(source['excludeGlobs']).join(', ')}
                        />
                      </Field>
                    </div>
                    <Field label="Repeat every (minutes; blank for manual)">
                      <input
                        name="schedule"
                        type="number"
                        min="1"
                        defaultValue={
                          source['scheduleEnabled']
                            ? String(source['scheduleIntervalMinutes'] ?? '')
                            : ''
                        }
                        placeholder="Manual only"
                      />
                    </Field>
                    <button class="secondary" disabled={busy}>
                      Save folder settings
                    </button>
                  </form>
                </details>
              </article>
            ))}
          </div>
        )}
      </section>
      {folderBrowserOpen ? (
        <FolderBrowser
          siloId={sourceSiloId}
          initialPath={sourcePath}
          choose={(path) => {
            setSourcePath(path);
            setFolderBrowserOpen(false);
          }}
          close={() => setFolderBrowserOpen(false)}
        />
      ) : null}
      {sourceToDisconnect ? (
        <Modal title="Disconnect input folder?" close={() => setSourceToDisconnect(null)}>
          <p>
            NodeRag will stop watching <b dir="auto">{asText(sourceToDisconnect['uri'])}</b>. It
            will not modify or delete files in that folder.
          </p>
          <Notice kind="warning">
            Previously ingested managed copies will remain searchable and will be marked as detached
            from this folder.
          </Notice>
          <div class="button-row">
            <button class="secondary" type="button" onClick={() => setSourceToDisconnect(null)}>
              Keep connection
            </button>
            <button
              class="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void disconnectSource()}
            >
              Disconnect folder
            </button>
          </div>
        </Modal>
      ) : null}
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

const SettingsPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const runtime = record(data['runtime']);
  const availableProcessors = Math.max(1, asNumber(runtime['availableProcessors']) || 1);
  const maximumEmbeddingThreads = Math.max(
    1,
    asNumber(runtime['maximumEmbeddingThreads']) || Math.min(32, availableProcessors),
  );
  const [embeddingThreads, setEmbeddingThreads] = useState(
    Math.max(1, asNumber(data['embedThreads']) || 1),
  );
  const [ingestThreads, setIngestThreads] = useState(
    Math.min(16, availableProcessors, Math.max(1, asNumber(data['ingestThreads']) || 1)),
  );
  const [prioritizeInteractive, setPrioritizeInteractive] = useState(
    data['throttleWhenBusy'] === true,
  );
  const responsiveThreads = Math.max(1, Math.floor(maximumEmbeddingThreads / 2));
  const balancedThreads = Math.max(1, maximumEmbeddingThreads - 1);
  const chooseProfile = (profile: 'responsive' | 'balanced' | 'fastest') => {
    setEmbeddingThreads(
      profile === 'responsive'
        ? responsiveThreads
        : profile === 'balanced'
          ? balancedThreads
          : maximumEmbeddingThreads,
    );
    setIngestThreads(
      profile === 'responsive' ? 1 : profile === 'balanced' ? Math.min(2, availableProcessors) : 1,
    );
    setPrioritizeInteractive(true);
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    try {
      const saved = await postJson<JsonRecord>(
        '/v1/admin/settings',
        {
          targetChars: Number(form.get('targetChars')),
          overlapChars: Number(form.get('overlapChars')),
          maxTokens: Number(form.get('maxTokens')),
          snapWindow: Number(form.get('snapWindow')),
          headingPrefix: form.get('headingPrefix') === 'on',
          embedThreads: embeddingThreads,
          ingestThreads,
          throttleWhenBusy: prioritizeInteractive,
          defaultMode: String(form.get('defaultMode')),
          efSearch: Number(form.get('efSearch')),
          auditRetentionDays: Number(form.get('auditRetentionDays')),
        },
        { method: 'PUT', idempotent: true },
      );
      const savedRuntime = record(saved['runtime']);
      const activeThreads = asNumber(savedRuntime['activeEmbeddingThreads']);
      report(
        savedRuntime['applyStatus'] === 'pending'
          ? 'Settings saved. Restart NodeRag from Package Center to apply the CPU thread change.'
          : `Settings saved. The embedding engine now uses ${String(activeThreads || embeddingThreads)} CPU thread${(activeThreads || embeddingThreads) === 1 ? '' : 's'}.`,
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
      <h3>Processing resources</h3>
      <p>
        Assign processor time to semantic search, PDF highlights, and background ingestion. NodeRag
        cannot create additional processor capacity; it can only use the processors detected on this
        device.
      </p>
      <div class="metric-grid processing-resource-metrics">
        <article>
          <span>Detected processors</span>
          <strong>{String(availableProcessors)}</strong>
          <small>logical CPU threads available to NodeRag</small>
        </article>
        <article>
          <span>Currently active</span>
          <strong>{String(asNumber(runtime['activeEmbeddingThreads']) || embeddingThreads)}</strong>
          <small>embedding CPU threads</small>
        </article>
        <article>
          <span>Selected</span>
          <strong>{String(embeddingThreads)}</strong>
          <small>
            {runtime['pendingRestart'] === true ? 'waiting for engine restart' : 'ready to apply'}
          </small>
        </article>
      </div>
      <div class="resource-profile-picker" aria-label="Processing profile">
        <button type="button" class="secondary" onClick={() => chooseProfile('responsive')}>
          Responsive
          <small>Keep the NAS responsive</small>
        </button>
        <button type="button" class="secondary" onClick={() => chooseProfile('balanced')}>
          Balanced
          <small>Recommended</small>
        </button>
        <button type="button" class="secondary" onClick={() => chooseProfile('fastest')}>
          Fastest highlights
          <small>Use all CPUs and reduce background work</small>
        </button>
      </div>
      <div class="admin-form-grid two processing-resource-controls">
        <Field
          label="Embedding CPU threads"
          hint={`Controls local model calculations used by meaning search and green PDF highlights. Allowed: 1–${String(maximumEmbeddingThreads)}.`}
        >
          <div class="resource-slider">
            <input
              name="embedThreads"
              type="range"
              min="1"
              max={maximumEmbeddingThreads}
              value={embeddingThreads}
              onInput={(event) => setEmbeddingThreads(Number(event.currentTarget.value))}
              required
            />
            <output>{String(embeddingThreads)}</output>
          </div>
        </Field>
        <Field
          label="Ingest workers"
          hint={`Documents allowed to progress concurrently in the background. Allowed here: 1–${String(Math.min(16, availableProcessors))}.`}
        >
          <div class="resource-slider">
            <input
              name="ingestThreads"
              type="range"
              min="1"
              max={Math.min(16, availableProcessors)}
              value={ingestThreads}
              onInput={(event) => setIngestThreads(Number(event.currentTarget.value))}
              required
            />
            <output>{String(ingestThreads)}</output>
          </div>
        </Field>
      </div>
      <label class="setting-toggle resource-priority-toggle">
        <input
          name="throttleWhenBusy"
          type="checkbox"
          checked={prioritizeInteractive}
          onChange={(event) => setPrioritizeInteractive(event.currentTarget.checked)}
        />
        <span>
          <b>Prioritize searches and highlights</b>
          <small>
            Reserves an interactive CPU slot and lets search and green-highlight work move ahead of
            queued background ingestion.
          </small>
        </span>
      </label>
      <hr class="settings-divider" />
      <h3>Indexing and search defaults</h3>
      <p>
        Chunking changes apply when documents are newly ingested or rebuilt. Search and audit
        settings apply immediately.
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
      </div>
      <button class="primary">Apply settings and restart embedding engine</button>
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
      const verifiedPath = asText(result['managedPath'], managedPath);
      await postJson(
        '/v1/admin/storage',
        {
          name: String(form.get('name')),
          managedPath: verifiedPath,
          purpose: String(form.get('purpose')),
          enabled: form.get('enabled') === 'on',
        },
        { idempotent: true },
      );
      formElement.reset();
      report(
        `${result['managedSubdirectory'] === true ? `NodeRag will use ${verifiedPath}. ` : ''}Storage location added. ${formatBytes(result['availableBytes'])} is currently available.`,
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
      const probeResult = pathChanged ? await probe(managedPath) : null;
      const verifiedPath =
        probeResult === null ? managedPath : asText(probeResult['managedPath'], managedPath);
      await postJson(
        `/v1/admin/storage/${String(item['id'])}`,
        {
          name: String(form.get('name')),
          managedPath: verifiedPath,
          purpose: String(form.get('purpose')),
          enabled: form.get('enabled') === 'on',
        },
        { method: 'PATCH', idempotent: true },
      );
      report(
        pathChanged
          ? probeResult?.['managedSubdirectory'] === true
            ? `Storage location saved in NodeRag's managed subfolder at ${verifiedPath}.`
            : 'Storage location saved and its new path probe passed.'
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
          first. Existing Synology ACLs are preserved.
        </p>
        <form class="admin-form-grid" onSubmit={create}>
          <Field label="Name" hint="A recognizable administrative label.">
            <input name="name" maxLength={120} required />
          </Field>
          <Field label="Managed path" hint="An absolute path available to the NodeRag service.">
            <input
              name="managedPath"
              maxLength={4096}
              placeholder="/var/packages/noderag/var/data/documents"
              required
            />
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
          maximumImagesPerCall: Number(form.get('maximumImagesPerCall')),
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
            <input
              name="model"
              defaultValue={asText(settings['model'], 'minimax-m3:cloud')}
              required
            />
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
          <Field
            label="Images per call"
            hint="Images grouped into one provider request. Three is the default; lower this if the provider times out or the model runs out of memory."
          >
            <input
              name="maximumImagesPerCall"
              type="number"
              min="1"
              max="16"
              defaultValue={asNumber(settings['maximumImagesPerCall']) || 3}
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
              defaultValue={asNumber(settings['maximumImageDimension']) || 1650}
              required
            />
          </Field>
        </div>
        <button class="primary">Test and save vision settings</button>
      </form>
    </div>
  );
};

const capabilityPresentation: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  model_catalog: {
    label: 'Cloud model list',
    description:
      'Reads available models plus their reasoning capabilities, context windows, and reported output limits.',
  },
  generation: {
    label: 'Chat generation',
    description: 'Sends a short synthetic prompt to the selected Cloud model.',
  },
  web_search: {
    label: 'Internet search',
    description: 'Tests Ollama Cloud hosted public-internet search for Chat.',
  },
  web_fetch: {
    label: 'Web-page fetch',
    description: 'Tests Ollama Cloud hosted retrieval of a public documentation page.',
  },
};

const OllamaCloudProviderPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const formRef = useRef<HTMLFormElement>(null);
  const [replacementKey, setReplacementKey] = useState('');
  const [busy, setBusy] = useState('');
  const provider = list(data['providers']).find((item) => item['provider'] === 'ollama_cloud');
  if (provider === undefined) {
    return (
      <EmptyState
        title="Ollama Cloud is not available"
        detail="Enable the Chat provider foundation feature for this testbed, then refresh this page."
      />
    );
  }
  const credential = record(provider['credential']);
  const limits = record(provider['limits']);
  const webToolUsage = record(provider['webToolUsage']);
  const models = list(provider['models']);
  const capabilities = list(provider['capabilities']);
  const formValues = () => {
    const form = formRef.current;
    if (form === null) throw new Error('Provider form is unavailable.');
    return new FormData(form);
  };
  const perform = async (
    action: string,
    path: string,
    body: (form: FormData) => JsonRecord,
    success: (result: JsonRecord) => string,
    method: 'POST' | 'PUT' = 'POST',
  ) => {
    setBusy(action);
    try {
      const result = await postJson<JsonRecord>(path, body(formValues()), {
        idempotent: true,
        method,
      });
      report(success(result));
      setReplacementKey('');
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    } finally {
      setBusy('');
    }
  };
  const candidateCredential = (form: FormData): JsonRecord => {
    const apiKey = String(form.get('apiKey') ?? '').trim();
    return apiKey === '' ? {} : { apiKey };
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    await perform(
      'save',
      '/v1/admin/chat/providers/ollama-cloud',
      (form) => {
        const requestsPerMinute = String(form.get('requestsPerMinute') ?? '').trim();
        const tokensPerMinute = String(form.get('tokensPerMinute') ?? '').trim();
        return {
          label: String(form.get('label')),
          enabled: form.get('enabled') === 'on',
          apiKey: String(form.get('apiKey') ?? ''),
          generationModel: String(form.get('generationModel')).trim() || null,
          maxParallelCalls: Number(form.get('maxParallelCalls')),
          requestsPerMinute: requestsPerMinute === '' ? null : Number(requestsPerMinute),
          tokensPerMinute: tokensPerMinute === '' ? null : Number(tokensPerMinute),
        };
      },
      () =>
        replacementKey === ''
          ? 'Ollama Cloud settings saved. The protected API key was retained.'
          : 'Ollama Cloud settings and replacement API key saved.',
      'PUT',
    );
  };
  const test = async (capability: string) => {
    const config = capabilityPresentation[capability];
    if (config === undefined) return;
    const endpoint =
      capability === 'model_catalog'
        ? 'refresh-models'
        : capability === 'generation'
          ? 'test-generation'
          : capability === 'web_search'
            ? 'test-web-search'
            : 'test-web-fetch';
    await perform(
      capability,
      `/v1/admin/chat/providers/ollama-cloud/${endpoint}`,
      (form) => ({
        ...candidateCredential(form),
        ...(capability === 'generation'
          ? { model: String(form.get('generationModel')).trim() }
          : {}),
      }),
      (result) =>
        capability === 'model_catalog'
          ? `Ollama Cloud model list refreshed (${String(result['modelCount'] ?? 0)} models).`
          : `${config.label} test passed in ${String(result['latencyMs'] ?? 0)} ms.`,
    );
  };
  const clearKey = async () => {
    if (
      !window.confirm(
        'Disable the Ollama Cloud connection and permanently clear its saved API key?',
      )
    ) {
      return;
    }
    setBusy('clear');
    try {
      await postJson(
        '/v1/admin/chat/providers/ollama-cloud',
        {
          enabled: false,
          clearApiKey: true,
        },
        { idempotent: true, method: 'PUT' },
      );
      report('Ollama Cloud was disabled and its saved API key was cleared.');
      setReplacementKey('');
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    } finally {
      setBusy('');
    }
  };
  const disableProvider = async () => {
    setBusy('disable');
    try {
      await postJson('/v1/admin/chat/providers/ollama-cloud/disable', {}, { idempotent: true });
      report('Ollama Cloud was disabled. The protected API key was retained.');
      setReplacementKey('');
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    } finally {
      setBusy('');
    }
  };
  return (
    <div class="admin-control-stack">
      <Notice kind="warning">
        This is Ollama Cloud, not a local Ollama installation. Chat prompts sent for generation and
        public queries sent for internet search leave this NodeRag server and are processed by
        Ollama Cloud. NodeRag never accepts a custom, local, or private Ollama address here.
      </Notice>
      <form
        ref={formRef}
        class="admin-control-card admin-settings-form ollama-cloud-provider"
        key={asText(provider['updatedAt'], 'ollama-cloud-provider')}
        onSubmit={save}
      >
        <div class="editable-record-heading">
          <div>
            <h3>Ollama Cloud</h3>
            <p>
              One protected Cloud key is shared by Chat generation, internet search, and web-page
              fetch. Each capability keeps its own health result.
            </p>
          </div>
          <StatusPill value={provider['enabled'] === true ? 'enabled' : 'disabled'} />
        </div>
        <div class="admin-form-grid three">
          <Field label="Connection name" hint="The administrator-facing label for this connection.">
            <input name="label" defaultValue={asText(provider['label'], 'Ollama Cloud')} required />
          </Field>
          <Field
            label="Ollama Cloud service address"
            hint="Fixed by NodeRag. Local and self-hosted Ollama addresses are not accepted."
          >
            <input
              class="provider-service-root"
              value={asText(provider['serviceRoot'], 'https://ollama.com')}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field
            label="Ollama Cloud API key"
            hint={
              credential['configured'] === true
                ? `A protected key is saved${asText(credential['fingerprint'], '') === '' ? '.' : ` (fingerprint ${asText(credential['fingerprint'], '')}).`} Leave blank to retain it, or enter a replacement.`
                : 'Required for Cloud models and Ollama Cloud internet search. The key is encrypted at rest.'
            }
          >
            <input
              name="apiKey"
              type="password"
              value={replacementKey}
              onInput={(event) => setReplacementKey(event.currentTarget.value)}
              autoComplete="new-password"
              placeholder={
                credential['configured'] === true ? 'Protected key saved' : 'Enter Cloud key'
              }
            />
          </Field>
          <Field
            label="Chat model"
            hint="Choose a discovered Cloud model or enter its exact Ollama Cloud model name."
          >
            <input
              name="generationModel"
              list="ollama-cloud-models"
              defaultValue={asText(provider['generationModel'], '')}
              placeholder="For example, minimax-m3:cloud"
              required={provider['enabled'] === true}
            />
            <datalist id="ollama-cloud-models">
              {models.map((model) => (
                <option value={asText(model['model'], '')}>
                  {asText(model['displayName'], '')}
                </option>
              ))}
            </datalist>
          </Field>
          <Field
            label="Parallel Cloud calls"
            hint="Maximum simultaneous Cloud calls (1–32), including the dedicated Chat web-tool scheduler."
          >
            <input
              name="maxParallelCalls"
              type="number"
              min="1"
              max="32"
              defaultValue={asNumber(limits['maxParallelCalls']) || 2}
              required
            />
          </Field>
          <Field
            label="Requests per minute"
            hint="Optional shared account limit enforced by Chat's Ollama Cloud web tools."
          >
            <input
              name="requestsPerMinute"
              type="number"
              min="1"
              max="60000"
              defaultValue={
                limits['requestsPerMinute'] == null ? '' : asNumber(limits['requestsPerMinute'])
              }
            />
          </Field>
          <Field
            label="Tokens per minute"
            hint="Optional shared generation-token limit for the Chat scheduler."
          >
            <input
              name="tokensPerMinute"
              type="number"
              min="1"
              max="1000000000"
              defaultValue={
                limits['tokensPerMinute'] == null ? '' : asNumber(limits['tokensPerMinute'])
              }
            />
          </Field>
        </div>
        <label class="checkbox provider-enabled-toggle">
          <input name="enabled" type="checkbox" defaultChecked={provider['enabled'] === true} />
          <span>
            <b>Enable Ollama Cloud for Chat</b>
            <small>This does not create the Chat page or grant any user Chat access yet.</small>
          </span>
        </label>
        <div class="button-row">
          <button class="primary" disabled={busy !== ''}>
            {replacementKey === '' ? 'Save connection' : 'Save connection and replace key'}
          </button>
          <button
            class="secondary"
            type="button"
            disabled={busy !== '' || provider['enabled'] !== true}
            onClick={() => void disableProvider()}
          >
            Disable connection
          </button>
          <button
            class="danger-button"
            type="button"
            disabled={busy !== '' || credential['configured'] !== true}
            onClick={() => void clearKey()}
          >
            Clear saved key
          </button>
        </div>
      </form>
      <section class="admin-control-card" aria-label="Ollama Cloud web-tool usage">
        <div class="editable-record-heading">
          <div>
            <h3>Hosted web-tool usage</h3>
            <p>
              Safe counters for Ollama Cloud search and fetch. Private search text and fetched page
              content are never included in these diagnostics.
            </p>
          </div>
          <StatusPill
            value={`${String(asNumber(webToolUsage['requestsThisMinute']))} this minute`}
          />
        </div>
        <div class="metric-grid">
          <article>
            <span>Requests this minute</span>
            <strong>{String(asNumber(webToolUsage['requestsThisMinute']))}</strong>
            <small>
              Limit:{' '}
              {limits['requestsPerMinute'] == null
                ? 'NodeRag safe default'
                : String(asNumber(limits['requestsPerMinute']))}
            </small>
          </article>
          <article>
            <span>Requests in the last 24 hours</span>
            <strong>{String(asNumber(webToolUsage['requestsLast24Hours']))}</strong>
            <small>
              Across {String(asNumber(webToolUsage['activeMinutesLast24Hours']))} active minutes
            </small>
          </article>
          <article>
            <span>Dedicated web capacity</span>
            <strong>{String(asNumber(limits['maxParallelCalls']) || 2)}</strong>
            <small>Maximum simultaneous hosted search/fetch calls in this process</small>
          </article>
          <article>
            <span>Last hosted web request</span>
            <strong>
              {webToolUsage['lastRequestAt'] == null
                ? 'No requests recorded'
                : new Date(String(webToolUsage['lastRequestAt'])).toLocaleString()}
            </strong>
            <small>Counters older than 48 hours are removed automatically</small>
          </article>
        </div>
      </section>
      <section class="admin-control-card">
        <div class="editable-record-heading">
          <div>
            <h3>Independent Cloud capability checks</h3>
            <p>
              A green generation test does not automatically enable internet search. Test the model
              list, generation, hosted search, and hosted fetch independently.
            </p>
          </div>
        </div>
        <div class="provider-capability-grid">
          {['model_catalog', 'generation', 'web_search', 'web_fetch'].map((capability) => {
            const state = capabilities.find((item) => item['capability'] === capability) ?? {};
            const presentation = capabilityPresentation[capability];
            if (presentation === undefined) return null;
            return (
              <article>
                <div class="editable-record-heading">
                  <div>
                    <h4>{presentation.label}</h4>
                    <p>{presentation.description}</p>
                  </div>
                  <StatusPill value={asText(state['status'], 'untested')} />
                </div>
                <small>
                  {state['testedAt'] == null
                    ? 'Not tested with the current saved key.'
                    : `Last tested ${new Date(String(state['testedAt'])).toLocaleString()}${state['latencyMs'] == null ? '' : ` · ${String(state['latencyMs'])} ms`}`}
                </small>
                {asText(state['errorCode'], '') === '' ? null : (
                  <small class="provider-capability-error">
                    Last safe error: {asText(state['errorCode'], '')}
                  </small>
                )}
                <button
                  class="secondary"
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => void test(capability)}
                >
                  {capability === 'model_catalog'
                    ? 'Refresh Cloud models'
                    : `Test ${presentation.label}`}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

const OpenAiOAuthProviderPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const provider = list(data['providers']).find((item) => item['provider'] === 'openai_oauth');
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState('');
  const providerModel = asText(provider?.['generationModel'], '');
  const [modelChoice, setModelChoice] = useState(providerModel);
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<JsonRecord>('/v1/admin/chat/providers/openai-oauth/status'));
      setStatusError('');
    } catch (reason) {
      setStatusError(displayError(reason));
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  const login = record(status?.['login']);
  useEffect(() => {
    if (asText(login['state'], '') !== 'pending') return;
    const timer = window.setInterval(() => void loadStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadStatus, login['state']]);
  useEffect(() => setModelChoice(providerModel), [providerModel]);
  const account = record(status?.['account']);
  const connected = account['connected'] === true;
  const credential = record(provider?.['credential']);
  useEffect(() => {
    if (connected && credential['configured'] !== true) refresh();
  }, [connected, credential['configured'], refresh]);
  if (provider === undefined) {
    return (
      <EmptyState
        title="OpenAI OAuth is not available"
        detail="The OpenAI provider foundation record is missing. Apply the current migrations and refresh."
      />
    );
  }
  const limits = record(provider['limits']);
  const models = list(provider['models']);
  const capabilities = list(provider['capabilities']);
  const selectedModel = models.find((item) => item['model'] === modelChoice);
  const selectedMetadata = record(selectedModel?.['providerMetadata']);
  const rateBuckets = list(record(status?.['rateLimits'])['buckets']);
  const perform = async (
    action: string,
    path: string,
    body: JsonRecord,
    success: (result: JsonRecord) => string,
    method: 'POST' | 'PUT' = 'POST',
  ) => {
    setBusy(action);
    try {
      const result = await postJson<JsonRecord>(path, body, { idempotent: true, method });
      report(success(result));
      await loadStatus();
      refresh();
    } catch (reason) {
      report(displayError(reason), true);
    } finally {
      setBusy('');
    }
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const requestsPerMinute = String(form.get('requestsPerMinute') ?? '').trim();
    const tokensPerMinute = String(form.get('tokensPerMinute') ?? '').trim();
    await perform(
      'save',
      '/v1/admin/chat/providers/openai-oauth',
      {
        label: String(form.get('label')),
        enabled: form.get('enabled') === 'on',
        generationModel: String(form.get('generationModel')).trim() || null,
        maxParallelCalls: Number(form.get('maxParallelCalls')),
        requestsPerMinute: requestsPerMinute === '' ? null : Number(requestsPerMinute),
        tokensPerMinute: tokensPerMinute === '' ? null : Number(tokensPerMinute),
      },
      () => 'OpenAI OAuth connection settings saved.',
      'PUT',
    );
  };
  const challengeState = asText(login['state'], '');
  return (
    <div class="admin-control-stack openai-oauth-provider">
      <Notice kind="warning">
        This is one server-wide ChatGPT/OpenAI OAuth connection. Every authorized NodeRag Chat user
        will consume the connected account's capacity and may affect its billing or usage limits.
        OpenAI is used for response generation only. All Chat internet searches and web-page fetches
        continue to use the separately configured Ollama Cloud connection.
      </Notice>
      <section class="admin-control-card">
        <div class="editable-record-heading">
          <div>
            <h3>OpenAI OAuth</h3>
            <p>
              Sign in with OpenAI's device-code page. NodeRag never asks you to paste an access
              token, refresh token, API key, or browser cookie.
            </p>
          </div>
          <StatusPill value={connected ? 'connected' : challengeState || 'disconnected'} />
        </div>
        {statusError ? <Notice kind="danger">{statusError}</Notice> : null}
        {connected ? (
          <div class="provider-account-summary">
            <div>
              <small>Connected account</small>
              <b>{asText(account['email'], 'Email not supplied')}</b>
            </div>
            <div>
              <small>Plan</small>
              <b>{asText(account['planType'], 'Unknown')}</b>
            </div>
            <div>
              <small>Credential storage</small>
              <b>Encrypted by NodeRag</b>
            </div>
          </div>
        ) : null}
        {challengeState === 'pending' ? (
          <div class="device-code-panel" role="status" aria-live="polite">
            <div>
              <small>One-time code</small>
              <strong>{asText(login['userCode'], '')}</strong>
              <small>Expires {new Date(asText(login['expiresAt'])).toLocaleString()}</small>
            </div>
            <div class="button-row">
              <button
                class="secondary"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(asText(login['userCode'], ''))
                    .then(() => report('The one-time OpenAI code was copied.'))
                    .catch((reason) => report(displayError(reason), true));
                }}
              >
                Copy code
              </button>
              <a
                class="button-link primary"
                href={asText(login['verificationUrl'], '#')}
                target="_blank"
                rel="noreferrer"
              >
                Open OpenAI sign-in
              </a>
              <button
                class="secondary"
                type="button"
                disabled={busy !== ''}
                onClick={() =>
                  void perform(
                    'cancel',
                    '/v1/admin/chat/providers/openai-oauth/login/cancel',
                    {},
                    () => 'OpenAI sign-in was cancelled.',
                  )
                }
              >
                Cancel sign-in
              </button>
            </div>
          </div>
        ) : challengeState === 'denied' || challengeState === 'expired' ? (
          <Notice kind="danger">
            {challengeState === 'expired'
              ? 'The one-time code expired. Start a new OpenAI sign-in.'
              : `OpenAI sign-in did not complete (${asText(login['safeErrorCode'], 'openai_login_denied')}).`}
          </Notice>
        ) : null}
        {!connected && challengeState !== 'pending' ? (
          <button
            class="primary"
            type="button"
            disabled={busy !== ''}
            onClick={() =>
              void perform(
                'login',
                '/v1/admin/chat/providers/openai-oauth/login',
                {},
                () => 'OpenAI sign-in started. Copy the one-time code and complete sign-in.',
              )
            }
          >
            Connect OpenAI account
          </button>
        ) : null}
      </section>
      <form
        class="admin-control-card admin-settings-form ollama-cloud-provider"
        key={asText(provider['updatedAt'], 'openai-oauth-provider')}
        onSubmit={save}
      >
        <div class="editable-record-heading">
          <div>
            <h3>OpenAI model settings</h3>
            <p>
              Available models and reasoning choices come from the connected account's live model
              catalog. Context and output limits remain Unknown unless an administrator later adds a
              documented profile.
            </p>
          </div>
          <StatusPill value={provider['enabled'] === true ? 'enabled' : 'disabled'} />
        </div>
        <div class="admin-form-grid three">
          <Field label="Connection name" hint="The administrator-facing label.">
            <input name="label" defaultValue={asText(provider['label'], 'OpenAI OAuth')} required />
          </Field>
          <Field label="Generation model" hint="Discovered from the connected OpenAI account.">
            <select
              name="generationModel"
              value={modelChoice}
              onChange={(event) => setModelChoice(event.currentTarget.value)}
              required={provider['enabled'] === true}
            >
              <option value="">Select a model</option>
              {models.map((item) => (
                <option value={asText(item['model'], '')}>
                  {asText(item['displayName'], asText(item['model'], ''))}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Parallel OpenAI calls" hint="Maximum simultaneous generation calls (1–32).">
            <input
              name="maxParallelCalls"
              type="number"
              min="1"
              max="32"
              defaultValue={asNumber(limits['maxParallelCalls']) || 2}
              required
            />
          </Field>
          <Field
            label="Requests per minute"
            hint="Optional scheduling limit for the shared account."
          >
            <input
              name="requestsPerMinute"
              type="number"
              min="1"
              max="60000"
              defaultValue={
                limits['requestsPerMinute'] == null ? '' : asNumber(limits['requestsPerMinute'])
              }
            />
          </Field>
          <Field label="Tokens per minute" hint="Optional scheduling limit for the shared account.">
            <input
              name="tokensPerMinute"
              type="number"
              min="1"
              max="1000000000"
              defaultValue={
                limits['tokensPerMinute'] == null ? '' : asNumber(limits['tokensPerMinute'])
              }
            />
          </Field>
        </div>
        {selectedModel === undefined ? null : (
          <div class="provider-model-detail">
            <span>
              <b>Reasoning:</b>{' '}
              {stringList(selectedModel['reasoningEfforts'])
                .map((value) => String(value))
                .join(', ') || 'Not advertised'}
            </span>
            <span>
              <b>Inputs:</b>{' '}
              {stringList(selectedMetadata['inputModalities'])
                .map((value) => String(value))
                .join(', ') || 'text, image (compatibility default)'}
            </span>
            <span>
              <b>Context limit:</b> Unknown
            </span>
          </div>
        )}
        <label class="checkbox provider-enabled-toggle">
          <input name="enabled" type="checkbox" defaultChecked={provider['enabled'] === true} />
          <span>
            <b>Enable OpenAI OAuth for Chat generation</b>
            <small>
              This does not enable OpenAI browsing and does not expose the Chat page yet.
            </small>
          </span>
        </label>
        <div class="button-row">
          <button class="primary" disabled={busy !== '' || !connected}>
            Save OpenAI settings
          </button>
          <button
            class="secondary"
            type="button"
            disabled={busy !== '' || !connected}
            onClick={() =>
              void perform(
                'models',
                '/v1/admin/chat/providers/openai-oauth/refresh-models',
                {},
                (result) =>
                  `OpenAI model list refreshed (${String(result['modelCount'] ?? 0)} models).`,
              )
            }
          >
            Refresh models
          </button>
          <button
            class="secondary"
            type="button"
            disabled={busy !== '' || !connected}
            onClick={() =>
              void perform(
                'test',
                '/v1/admin/chat/providers/openai-oauth/test',
                {},
                (result) =>
                  `OpenAI account and model catalog passed (${String(result['modelCount'] ?? 0)} models).`,
              )
            }
          >
            Test account and catalog
          </button>
          <button
            class="danger-button"
            type="button"
            disabled={busy !== '' || !connected}
            onClick={() => {
              if (
                !window.confirm(
                  'Disconnect the shared OpenAI account and permanently remove its saved OAuth credential from NodeRag?',
                )
              ) {
                return;
              }
              void perform(
                'disconnect',
                '/v1/admin/chat/providers/openai-oauth/disconnect',
                { confirmation: 'DISCONNECT' },
                () => 'The OpenAI account was disconnected and its saved credential was removed.',
              );
            }}
          >
            Disconnect account
          </button>
        </div>
      </form>
      <section class="admin-control-card">
        <div class="editable-record-heading">
          <div>
            <h3>OpenAI connection health</h3>
            <p>
              Authentication and catalog discovery are tested without sending document content. A
              real synthetic generation test remains an optional controlled test for this stage.
            </p>
          </div>
        </div>
        <div class="provider-capability-grid">
          {['model_catalog', 'generation'].map((capability) => {
            const capabilityState =
              capabilities.find((item) => item['capability'] === capability) ?? {};
            return (
              <article>
                <h4>{capability === 'model_catalog' ? 'Model catalog' : 'Chat generation'}</h4>
                <StatusPill value={asText(capabilityState['status'], 'untested')} />
                <small>
                  {capability === 'model_catalog'
                    ? 'Validated when the authenticated catalog refresh succeeds.'
                    : 'Not inferred from authentication. Generation is tested separately in a later run stage.'}
                </small>
              </article>
            );
          })}
        </div>
        {rateBuckets.length === 0 ? (
          <p>Live rate-limit status is unavailable for this account.</p>
        ) : (
          <div class="provider-rate-limits">
            {rateBuckets.map((bucket) => {
              const primary = record(bucket['primary']);
              return (
                <div>
                  <b>{asText(bucket['name'], asText(bucket['id'], 'Account capacity'))}</b>
                  <span>
                    {primary['usedPercent'] == null
                      ? 'Usage percentage unavailable'
                      : `${String(primary['usedPercent'])}% used`}
                  </span>
                  <small>
                    {primary['resetsAt'] == null
                      ? 'Reset time unavailable'
                      : `Resets ${new Date(asNumber(primary['resetsAt']) * 1_000).toLocaleString()}`}
                  </small>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

const ChatProvidersPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => (
  <div class="chat-provider-panels">
    <OpenAiOAuthProviderPanel data={data} refresh={refresh} report={report} />
    <OllamaCloudProviderPanel data={data} refresh={refresh} report={report} />
  </div>
);

const chatModelKey = (model: JsonRecord): string =>
  `${asText(model['provider'], '')}|${asText(model['model'], '')}`;

const ModelCapacityEditor = ({
  model,
  refresh,
  report,
}: {
  readonly model: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const capacity = record(model['capacity']);
  const evidence = record(model['capacityEvidence']);
  const evidenceValue = (name: string): string =>
    evidence[name] == null ? 'not reported' : Number(evidence[name]).toLocaleString();
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const nullableNumber = (name: string): number | null => {
      const value = String(form.get(name) ?? '').trim();
      return value === '' ? null : Number(value);
    };
    try {
      await postJson(
        `/v1/admin/chat/models/${String(asNumber(model['id']))}`,
        {
          administratorContextTokens: nullableNumber('contextTokens'),
          administratorOutputTokens: nullableNumber('outputTokens'),
          note: String(form.get('note') ?? '').trim() || null,
        },
        { method: 'PATCH', idempotent: true },
      );
      report(`Capacity override saved for ${asText(model['displayName'], 'the model')}.`);
      refresh();
    } catch (error) {
      report(displayError(error), true);
    }
  };
  return (
    <form class="model-capacity-card" onSubmit={save}>
      <header>
        <div>
          <b>{asText(model['displayName'], asText(model['model']))}</b>
          <small>
            {model['provider'] === 'ollama_cloud' ? 'Ollama Cloud' : 'OpenAI OAuth'} ·{' '}
            {asText(model['model'])}
          </small>
        </div>
        <StatusPill
          value={
            model['catalogStale'] === true ? 'stale catalog' : asText(model['generationStatus'])
          }
        />
      </header>
      <p>
        Effective context:{' '}
        <b>
          {capacity['contextTokens'] == null
            ? 'Unknown'
            : Number(capacity['contextTokens']).toLocaleString()}
        </b>{' '}
        · source {asText(capacity['contextSource'], 'unknown').replaceAll('_', ' ')}. Maximum
        output:{' '}
        <b>
          {capacity['maximumOutputTokens'] == null
            ? 'Unknown'
            : Number(capacity['maximumOutputTokens']).toLocaleString()}
        </b>
      </p>
      <small>
        Provider evidence — active allocation: {evidenceValue('runtimeContextTokens')} · configured
        context: {evidenceValue('configuredContextTokens')} · model maximum:{' '}
        {evidenceValue('advertisedContextTokens')} · output ceiling:{' '}
        {evidenceValue('providerOutputTokens')}.
      </small>
      {capacity['contextTokens'] == null ? (
        <Notice kind="warning">
          Refresh the provider catalog first. If the provider still reports no capacity, enter a
          verified fallback or keep rolling context conservative.
        </Notice>
      ) : null}
      <div class="configuration-field-grid">
        <Field
          label="Fallback context tokens"
          hint="Used only when the provider reports no runtime, configured, or advertised capacity."
        >
          <input
            name="contextTokens"
            type="number"
            min="1024"
            max="10000000"
            defaultValue={
              model['administratorContextTokens'] == null
                ? ''
                : String(model['administratorContextTokens'])
            }
          />
        </Field>
        <Field
          label="Fallback maximum output tokens"
          hint="Used only when provider output capacity is unavailable; this remains a planning value."
        >
          <input
            name="outputTokens"
            type="number"
            min="128"
            max="1000000"
            defaultValue={
              model['administratorOutputTokens'] == null
                ? ''
                : String(model['administratorOutputTokens'])
            }
          />
        </Field>
        <Field label="Fallback evidence note" hint="Record where the fallback was verified.">
          <input name="note" maxLength={500} defaultValue={asText(model['note'], '')} />
        </Field>
      </div>
      <button class="secondary">Save model capacity</button>
    </form>
  );
};

const ManagedLayerFields = ({
  label,
  prefix,
  models,
  selection,
  select,
  current,
  stateSchema,
}: {
  readonly label: string;
  readonly prefix: 'l2' | 'l3';
  readonly models: readonly JsonRecord[];
  readonly selection: string;
  readonly select: (value: string) => void;
  readonly current: JsonRecord;
  readonly stateSchema?: boolean;
}) => {
  const selected = models.find((model) => chatModelKey(model) === selection) ?? models[0];
  const efforts = stringList(selected?.['reasoningEfforts']);
  return (
    <fieldset class="managed-layer-fields">
      <legend>{label}</legend>
      <Field label="Provider and model">
        <select
          name={`${prefix}Model`}
          value={selection}
          onChange={(event) => select(event.currentTarget.value)}
          required
        >
          {models.map((model) => (
            <option value={chatModelKey(model)}>
              {model['provider'] === 'ollama_cloud' ? 'Ollama Cloud' : 'OpenAI OAuth'} ·{' '}
              {asText(model['displayName'], asText(model['model']))}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reasoning effort" hint="Choices come from this model's live catalog.">
        <select
          key={`${selection}-${prefix}-effort`}
          name={`${prefix}Effort`}
          defaultValue={
            efforts.includes(asText(current['reasoningEffort'], ''))
              ? asText(current['reasoningEffort'])
              : efforts[0]
          }
          required
        >
          {efforts.map((effort) => (
            <option value={effort}>{effort}</option>
          ))}
        </select>
      </Field>
      <Field
        label="Output target tokens"
        hint="A bounded target reserved for this managed-context layer."
      >
        <input
          name={`${prefix}Output`}
          type="number"
          min="128"
          max="1000000"
          defaultValue={String(
            asNumber(current['outputTargetTokens']) || (prefix === 'l2' ? 1024 : 512),
          )}
          required
        />
      </Field>
      <Field label="Instructions" hint="Only synthetic text is used by the Administration preview.">
        <textarea
          name={`${prefix}Instructions`}
          maxLength={20_000}
          defaultValue={asText(
            current['instructions'],
            prefix === 'l2'
              ? 'Summarize durable facts, decisions, and unresolved questions.'
              : 'Return a compact structured state that conforms to the configured schema.',
          )}
          required
        />
      </Field>
      {stateSchema ? (
        <Field
          label="Structured-state JSON schema"
          hint="The L3 response must validate against this JSON object schema."
        >
          <textarea
            name="l3Schema"
            defaultValue={JSON.stringify(record(current['stateSchema']), null, 2)}
            required
          />
        </Field>
      ) : null}
    </fieldset>
  );
};

const ChatContextPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const context = record(data['context']);
  const managed = record(context['managed']);
  const reserves = record(context['reserves']);
  const models = list(data['models']).filter(
    (model) => model['catalogStale'] !== true && stringList(model['reasoningEfforts']).length > 0,
  );
  const l2 = record(managed['l2']);
  const l3 = record(managed['l3']);
  const initialKey = (layer: JsonRecord) =>
    models.find(
      (model) =>
        model['provider'] === layer['provider'] && asText(model['model'], '') === layer['model'],
    ) === undefined
      ? chatModelKey(models[0] ?? {})
      : `${asText(layer['provider'], '')}|${asText(layer['model'], '')}`;
  const [managedEnabled, setManagedEnabled] = useState(Boolean(managed['enabled']));
  const [l2Selection, setL2Selection] = useState(initialKey(l2));
  const [l3Selection, setL3Selection] = useState(initialKey(l3));
  const [preview, setPreview] = useState<JsonRecord | null>(null);
  useEffect(() => {
    setManagedEnabled(Boolean(managed['enabled']));
    setL2Selection(initialKey(l2));
    setL3Selection(initialKey(l3));
    setPreview(null);
  }, [context['revisionId']]);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const layer = (prefix: 'l2' | 'l3', selection: string) => {
      const selected = models.find((model) => chatModelKey(model) === selection);
      if (selected === undefined)
        throw new Error('Select a healthy provider model for each layer.');
      return {
        provider: selected['provider'],
        model: selected['model'],
        reasoningEffort: String(form.get(`${prefix}Effort`) ?? ''),
        instructions: String(form.get(`${prefix}Instructions`) ?? ''),
        outputTargetTokens: Number(form.get(`${prefix}Output`)),
      };
    };
    try {
      const l2Value = managedEnabled ? layer('l2', l2Selection) : null;
      const l3Value = managedEnabled ? layer('l3', l3Selection) : null;
      await postJson(
        '/v1/admin/chat/context',
        {
          rollingTurnLimit: Number(form.get('rollingTurnLimit')),
          inputReserveTokens: Number(form.get('inputReserveTokens')),
          outputReserveTokens: Number(form.get('outputReserveTokens')),
          pinnedInstructionReserveTokens: Number(form.get('pinnedInstructionReserveTokens')),
          toolResultReserveTokens: Number(form.get('toolResultReserveTokens')),
          managed: managedEnabled
            ? {
                enabled: true,
                triggerPercent: Number(form.get('triggerPercent')),
                keepRecentTurns: Number(form.get('keepRecentTurns')),
                l1PinLimitTokens: Number(form.get('l1PinLimitTokens')),
                l2: l2Value,
                l3: {
                  ...l3Value,
                  stateSchema: JSON.parse(String(form.get('l3Schema') ?? '{}')),
                },
              }
            : {
                enabled: false,
                triggerPercent: Number(form.get('triggerPercent')),
                keepRecentTurns: Number(form.get('keepRecentTurns')),
                l1PinLimitTokens: Number(form.get('l1PinLimitTokens')),
              },
        },
        { method: 'PUT', idempotent: true },
      );
      report(
        'A new immutable context-settings revision was saved. Managed mode must be previewed again.',
      );
      refresh();
    } catch (error) {
      report(displayError(error), true);
    }
  };
  const runPreview = async () => {
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/chat/context/preview',
        { turnCount: 24, averageCharactersPerMessage: 1200, pinnedCharacters: 1000 },
        { idempotent: true },
      );
      setPreview(result);
      report(
        stringList(result['layerErrors']).length === 0
          ? 'Synthetic L2/L3 readiness preview passed.'
          : 'The preview completed with a layer that is not ready.',
        stringList(result['layerErrors']).length > 0,
      );
    } catch (error) {
      report(displayError(error), true);
    }
  };
  return (
    <div class="admin-control-stack chat-configuration-panel">
      <Notice kind="info">
        Rolling context keeps complete recent turns. Managed context adds L1 pins, an L2 narrative
        summary, L3 structured state, and complete recent L4 turns. Original chat history is never
        deleted by compression.
      </Notice>
      <form class="admin-control-card" onSubmit={save}>
        <header class="configuration-card-header">
          <div>
            <h3>Context window policy</h3>
            <small>Revision {asText(context['revisionId'])}</small>
          </div>
          <StatusPill value={managedEnabled ? 'managed configured' : 'rolling only'} />
        </header>
        <div class="configuration-field-grid">
          <Field
            label="Rolling complete turns"
            hint="A turn is one user request and its assistant/tool sequence."
          >
            <input
              name="rollingTurnLimit"
              type="number"
              min="1"
              max="500"
              defaultValue={String(asNumber(context['rollingTurnLimit']))}
              required
            />
          </Field>
          <Field
            label="Input reserve"
            hint="Planning headroom; it is not a provider-enforced limit."
          >
            <input
              name="inputReserveTokens"
              type="number"
              min="0"
              max="1000000"
              defaultValue={String(asNumber(reserves['inputTokens']))}
              required
            />
          </Field>
          <Field label="Output reserve">
            <input
              name="outputReserveTokens"
              type="number"
              min="128"
              max="1000000"
              defaultValue={String(asNumber(reserves['outputTokens']))}
              required
            />
          </Field>
          <Field label="Pinned-instruction reserve">
            <input
              name="pinnedInstructionReserveTokens"
              type="number"
              min="0"
              max="1000000"
              defaultValue={String(asNumber(reserves['pinnedInstructionTokens']))}
              required
            />
          </Field>
          <Field label="Tool-result reserve">
            <input
              name="toolResultReserveTokens"
              type="number"
              min="0"
              max="1000000"
              defaultValue={String(asNumber(reserves['toolResultTokens']))}
              required
            />
          </Field>
          <Field label="Compression trigger percent">
            <input
              name="triggerPercent"
              type="number"
              min="25"
              max="95"
              step="0.1"
              defaultValue={String(asNumber(managed['triggerPercent']))}
              required
            />
          </Field>
          <Field label="Recent L4 turns">
            <input
              name="keepRecentTurns"
              type="number"
              min="1"
              max="100"
              defaultValue={String(asNumber(managed['keepRecentTurns']))}
              required
            />
          </Field>
          <Field label="L1 pin limit tokens">
            <input
              name="l1PinLimitTokens"
              type="number"
              min="0"
              max="1000000"
              defaultValue={String(asNumber(managed['l1PinLimitTokens']))}
              required
            />
          </Field>
        </div>
        <label class="checkbox">
          <input
            type="checkbox"
            checked={managedEnabled}
            onChange={(event) => setManagedEnabled(event.currentTarget.checked)}
          />
          <span>
            <b>Configure managed context</b>
            <small>
              Chat will continue to default to rolling mode until both synthetic layer checks pass.
            </small>
          </span>
        </label>
        {managedEnabled ? (
          models.length === 0 ? (
            <Notice kind="warning">Test and refresh at least one Chat provider model first.</Notice>
          ) : (
            <div class="managed-layer-grid">
              <ManagedLayerFields
                label="L2 · Narrative summary"
                prefix="l2"
                models={models}
                selection={l2Selection}
                select={setL2Selection}
                current={l2}
              />
              <ManagedLayerFields
                label="L3 · Structured state"
                prefix="l3"
                models={models}
                selection={l3Selection}
                select={setL3Selection}
                current={l3}
                stateSchema
              />
            </div>
          )
        ) : null}
        <div class="button-row">
          <button class="primary" disabled={managedEnabled && models.length === 0}>
            Save context revision
          </button>
          <button
            class="secondary"
            type="button"
            onClick={() => void runPreview()}
            disabled={managed['enabled'] !== true}
          >
            Run synthetic preview
          </button>
        </div>
        {preview ? (
          <div class="preview-result" role="status">
            <b>
              Estimated {Number(preview['beforeTokens']).toLocaleString()} →{' '}
              {Number(preview['afterTokens']).toLocaleString()} tokens
            </b>
            <span>
              {String(asNumber(preview['projectedProviderCalls']))} projected provider calls ·
              synthetic content only
            </span>
            {stringList(preview['layerErrors']).length > 0 ? (
              <small>{stringList(preview['layerErrors']).join(', ')}</small>
            ) : null}
          </div>
        ) : null}
      </form>
      <section class="admin-control-card">
        <h3>Model capacity evidence</h3>
        <p>
          Provider runtime, configured, and advertised values take precedence. Administrator values
          are fallbacks, followed by the versioned known-model table. Unknown stays Unknown.
        </p>
        <div class="model-capacity-list">
          {list(data['models']).map((model) => (
            <ModelCapacityEditor model={model} refresh={refresh} report={report} />
          ))}
        </div>
      </section>
    </div>
  );
};

const ChatSettingsPanel = ({
  data,
  refresh,
  report,
}: {
  readonly data: JsonRecord;
  readonly refresh: () => void;
  readonly report: AdminReport;
}) => {
  const settings = record(data['settings']);
  const defaults = record(settings['defaults']);
  const limits = record(settings['limits']);
  const retention = record(settings['retention']);
  const artifacts = record(settings['artifacts']);
  const logs = record(settings['logs']);
  const exportSettings = record(settings['exports']);
  const exportCapabilities = useLoad('/v1/admin/chat/exports/capabilities');
  const exportCapabilityData = record(exportCapabilities.data);
  const storage = record(settings['storage']);
  const managed = record(record(data['context'])['managed']);
  const managedReady =
    Boolean(managed['enabled']) &&
    list(managed['tests']).length === 2 &&
    list(managed['tests']).every((test) => test['status'] === 'healthy');
  const internet = record(data['internet']);
  const models = list(data['models']).filter(
    (model) =>
      model['catalogStale'] !== true &&
      model['enabled'] === true &&
      model['generationStatus'] === 'healthy',
  );
  const initialSelection =
    models.find(
      (model) =>
        model['provider'] === settings['defaultProvider'] &&
        model['model'] === settings['defaultModel'],
    ) ?? models[0];
  const [modelSelection, setModelSelection] = useState(
    initialSelection === undefined ? '' : chatModelKey(initialSelection),
  );
  const [contextMode, setContextMode] = useState(asText(settings['defaultContextMode'], 'rolling'));
  const [storagePath, setStoragePath] = useState(asText(storage['requestedPath'], ''));
  const [storageProbe, setStorageProbe] = useState<JsonRecord | null>(null);
  const [reconciliationPreview, setReconciliationPreview] = useState<JsonRecord | null>(null);
  const [ownerMap, setOwnerMap] = useState<Record<string, number>>({});
  const [reconciliationBusy, setReconciliationBusy] = useState(false);
  useEffect(() => {
    setModelSelection(initialSelection === undefined ? '' : chatModelKey(initialSelection));
    setContextMode(asText(settings['defaultContextMode'], 'rolling'));
    setStoragePath(asText(storage['requestedPath'], ''));
    setStorageProbe(null);
    setReconciliationPreview(null);
    setOwnerMap({});
  }, [settings['revisionId']]);
  const selectedModel = models.find((model) => chatModelKey(model) === modelSelection);
  const efforts = stringList(selectedModel?.['reasoningEfforts']);
  const probe = async () => {
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/chat/storage/probe',
        { storagePath },
        { idempotent: true },
      );
      setStorageProbe(result);
      report(`Chat storage is writable at ${asText(result['resolvedPath'])}.`);
    } catch (error) {
      report(displayError(error), true);
    }
  };
  const inspectExistingChats = async () => {
    setReconciliationBusy(true);
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/chat/storage/reconcile/preview',
        { ownerMap },
        { idempotent: true },
      );
      setReconciliationPreview(result);
      const suggested = { ...ownerMap };
      for (const candidate of list(result['candidates'])) {
        const sourceOwnerId = String(candidate['sourceOwnerId'] ?? '');
        const destination = candidate['suggestedDestinationPrincipalId'];
        if (
          sourceOwnerId !== '' &&
          typeof destination === 'number' &&
          suggested[sourceOwnerId] === undefined
        ) {
          suggested[sourceOwnerId] = destination;
        }
      }
      setOwnerMap(suggested);
      report(
        `Storage inspection found ${String(list(result['candidates']).length)} recoverable chat folder(s) and ${String(list(result['conflicts']).length)} item(s) requiring attention.`,
      );
    } catch (error) {
      report(displayError(error), true);
    } finally {
      setReconciliationBusy(false);
    }
  };
  const reconcileExistingChats = async () => {
    setReconciliationBusy(true);
    try {
      const result = await postJson<JsonRecord>(
        '/v1/admin/chat/storage/reconcile',
        { ownerMap },
        { idempotent: true },
      );
      report(
        result['state'] === 'completed'
          ? `Chat reconciliation completed. ${String(result['importedChats'] ?? 0)} chat(s) were restored.`
          : 'Chat reconciliation was quarantined. Review the listed conflicts before trying again.',
        result['state'] !== 'completed',
      );
      await inspectExistingChats();
      refresh();
    } catch (error) {
      report(displayError(error), true);
    } finally {
      setReconciliationBusy(false);
    }
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const nullableNumber = (name: string): number | null => {
      const value = String(form.get(name) ?? '').trim();
      return value === '' ? null : Number(value);
    };
    try {
      await postJson(
        '/v1/admin/chat/settings',
        {
          defaultProvider: selectedModel?.['provider'] ?? null,
          defaultModel: selectedModel?.['model'] ?? null,
          defaultReasoningEffort: String(form.get('defaultReasoningEffort') ?? 'default'),
          defaultContextMode: contextMode,
          defaultAllowResearch: form.get('defaultAllowResearch') === 'on',
          defaultAllowRag: form.get('defaultAllowRag') === 'on',
          defaultAllowInternet: form.get('defaultAllowInternet') === 'on',
          markdownOnly: true,
          runTimeoutMs: Number(form.get('runTimeoutMs')),
          maximumToolCalls: Number(form.get('maximumToolCalls')),
          maximumParallelRunsPerUser: Number(form.get('maximumParallelRunsPerUser')),
          dailyRunQuota: nullableNumber('dailyRunQuota'),
          dailyInputTokenQuota: nullableNumber('dailyInputTokenQuota'),
          dailyOutputTokenQuota: nullableNumber('dailyOutputTokenQuota'),
          retentionDays: Number(form.get('retentionDays')),
          archiveAfterDays: Number(form.get('archiveAfterDays')),
          artifactMaxFileBytes: Number(form.get('artifactMaxFileMiB')) * 1024 * 1024,
          artifactChatQuotaBytes: Number(form.get('artifactChatQuotaMiB')) * 1024 * 1024,
          markdownExternalImages: form.get('markdownExternalImages') === 'on',
          logSegmentMaxBytes: Number(form.get('logSegmentMaxMiB')) * 1024 * 1024,
          logSegmentMaxAgeMinutes: Number(form.get('logSegmentMaxAgeMinutes')),
          exportMaxOutputBytes: Number(form.get('exportMaxOutputMiB')) * 1024 * 1024,
          exportTimeoutMs: Number(form.get('exportTimeoutMs')),
          exportMaximumAttempts: Number(form.get('exportMaximumAttempts')),
          storagePath: storagePath.trim() || null,
        },
        { method: 'PUT', idempotent: true },
      );
      report('A new immutable Chat-settings revision was saved.');
      refresh();
    } catch (error) {
      report(displayError(error), true);
    }
  };
  return (
    <form class="admin-control-stack chat-configuration-panel" onSubmit={save}>
      <Notice kind="info">
        These defaults are snapshotted into each new chat. Internet means Ollama Cloud hosted web
        search and fetch only—even when OpenAI generates the response.
      </Notice>
      <section class="admin-control-card">
        <header class="configuration-card-header">
          <div>
            <h3>Default model and context</h3>
            <small>Revision {asText(settings['revisionId'])}</small>
          </div>
          <StatusPill
            value={data['executionEnabled'] === true ? 'chat ready' : 'chat setup required'}
          />
        </header>
        <div class="configuration-field-grid">
          <Field
            label="Default response model"
            hint="Only enabled models with a healthy generation test appear."
          >
            <select
              value={modelSelection}
              onChange={(event) => setModelSelection(event.currentTarget.value)}
            >
              {models.length === 0 ? <option value="">No healthy model available</option> : null}
              {models.map((model) => (
                <option value={chatModelKey(model)}>
                  {model['provider'] === 'ollama_cloud' ? 'Ollama Cloud' : 'OpenAI OAuth'} ·{' '}
                  {asText(model['displayName'], asText(model['model']))}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Default reasoning effort"
            hint="Values are limited to the selected model's catalog."
          >
            <select
              key={`${modelSelection}-default-effort`}
              name="defaultReasoningEffort"
              defaultValue={
                efforts.includes(asText(settings['defaultReasoningEffort'], ''))
                  ? asText(settings['defaultReasoningEffort'])
                  : (efforts[0] ?? 'default')
              }
            >
              {efforts.length === 0 ? <option value="default">default</option> : null}
              {efforts.map((effort) => (
                <option value={effort}>{effort}</option>
              ))}
            </select>
          </Field>
          <Field label="Default context mode">
            <select
              name="defaultContextMode"
              value={contextMode}
              onChange={(event) => setContextMode(event.currentTarget.value)}
            >
              <option value="rolling">Rolling complete turns</option>
              <option value="managed" disabled={!managedReady}>
                Managed L1–L4 {!managedReady ? '(preview required)' : ''}
              </option>
            </select>
          </Field>
        </div>
        {selectedModel !== undefined &&
        record(selectedModel['capacity'])['contextTokens'] == null ? (
          <Notice kind="warning">
            The selected model's context window is Unknown. NodeRag will use conservative rolling
            context and will not describe authentication as a capacity measurement.
          </Notice>
        ) : null}
      </section>
      <section class="admin-control-card">
        <header class="configuration-card-header">
          <div>
            <h3>Chat artifacts, exports, and active logs</h3>
            <small>Passive DOCX and PDF generation runs without shell or network conversion.</small>
          </div>
          <StatusPill
            value={
              exportCapabilities.data === null && exportCapabilities.error === ''
                ? 'checking'
                : exportCapabilityData['status'] === 'healthy'
                  ? 'healthy'
                  : 'unavailable'
            }
          />
        </header>
        <p>
          Chat-created files are Markdown only, revisioned, and contained inside the selected Chat
          storage. External Markdown images stay blocked unless an administrator explicitly allows
          them.
        </p>
        {exportCapabilities.error ? (
          <Notice kind="warning">
            Export capability self-test is unavailable: {exportCapabilities.error}
          </Notice>
        ) : exportCapabilityData['status'] === 'healthy' ? (
          <Notice kind="success">
            DOCX and PDF self-tests passed. Fonts are embedded in PDF output; active content,
            macros, external relationships, shell conversion, and network conversion are blocked.
          </Notice>
        ) : null}
        <div class="configuration-field-grid">
          <Field label="Maximum artifact file (MiB)">
            <input
              name="artifactMaxFileMiB"
              type="number"
              min="1"
              max="100"
              defaultValue={String(asNumber(artifacts['maximumFileBytes']) / 1024 / 1024)}
              required
            />
          </Field>
          <Field label="Artifact quota per chat (MiB)">
            <input
              name="artifactChatQuotaMiB"
              type="number"
              min="1"
              max="10240"
              defaultValue={String(asNumber(artifacts['chatQuotaBytes']) / 1024 / 1024)}
              required
            />
          </Field>
          <Field label="Active log segment size (MiB)">
            <input
              name="logSegmentMaxMiB"
              type="number"
              min="1"
              max="64"
              defaultValue={String(asNumber(logs['segmentMaximumBytes']) / 1024 / 1024)}
              required
            />
          </Field>
          <Field label="Active log segment age (minutes)">
            <input
              name="logSegmentMaxAgeMinutes"
              type="number"
              min="5"
              max="10080"
              defaultValue={String(asNumber(logs['segmentMaximumAgeMinutes']))}
              required
            />
          </Field>
          <Field
            label="Maximum export file (MiB)"
            hint="Applies independently to DOCX and PDF output."
          >
            <input
              name="exportMaxOutputMiB"
              type="number"
              min="1"
              max="512"
              defaultValue={String(asNumber(exportSettings['maximumOutputBytes']) / 1024 / 1024)}
              required
            />
          </Field>
          <Field
            label="Export timeout (milliseconds)"
            hint="A timed-out result is never published."
          >
            <input
              name="exportTimeoutMs"
              type="number"
              min="10000"
              max="900000"
              step="1000"
              defaultValue={String(asNumber(exportSettings['timeoutMilliseconds']))}
              required
            />
          </Field>
          <Field label="Export attempts" hint="Includes a reclaimed job after a worker restart.">
            <input
              name="exportMaximumAttempts"
              type="number"
              min="1"
              max="5"
              defaultValue={String(asNumber(exportSettings['maximumAttempts']))}
              required
            />
          </Field>
        </div>
        <label class="checkbox">
          <input
            name="markdownExternalImages"
            type="checkbox"
            defaultChecked={Boolean(artifacts['markdownExternalImages'])}
          />
          <span>
            <b>Allow external images in Chat Markdown</b>
            <small>
              Off by default. Turning this on allows a reader's browser to contact image hosts named
              in Markdown files.
            </small>
          </span>
        </label>
      </section>
      <section class="admin-control-card">
        <h3>New-chat capability defaults</h3>
        <p>
          These switches remain independent. Users still need current knowledge-space permission at
          every tool call.
        </p>
        <div class="configuration-toggle-list">
          <label class="checkbox">
            <input
              name="defaultAllowResearch"
              type="checkbox"
              defaultChecked={Boolean(defaults['allowResearch'])}
            />
            <span>
              <b>Attached Research</b>
              <small>Allow explicitly attached personal Research references.</small>
            </span>
          </label>
          <label class="checkbox">
            <input
              name="defaultAllowRag"
              type="checkbox"
              defaultChecked={Boolean(defaults['allowRag'])}
            />
            <span>
              <b>Broader RAG search</b>
              <small>Search only knowledge spaces the current user can read.</small>
            </span>
          </label>
          <label class="checkbox">
            <input
              name="defaultAllowInternet"
              type="checkbox"
              defaultChecked={Boolean(defaults['allowInternet'])}
              disabled={internet['ready'] !== true}
            />
            <span>
              <b>Ollama Cloud internet search</b>
              <small>
                {internet['ready'] === true
                  ? 'Cloud web search and fetch tests are healthy.'
                  : 'Disabled until both Ollama Cloud web capabilities test healthy.'}
              </small>
            </span>
          </label>
        </div>
      </section>
      <section class="admin-control-card">
        <h3>Run limits, quotas, and retention</h3>
        <div class="configuration-field-grid">
          <Field label="Run timeout (milliseconds)">
            <input
              name="runTimeoutMs"
              type="number"
              min="10000"
              max="1800000"
              defaultValue={String(asNumber(limits['runTimeoutMs']))}
              required
            />
          </Field>
          <Field label="Maximum tool calls">
            <input
              name="maximumToolCalls"
              type="number"
              min="0"
              max="100"
              defaultValue={String(asNumber(limits['maximumToolCalls']))}
              required
            />
          </Field>
          <Field label="Parallel runs per user">
            <input
              name="maximumParallelRunsPerUser"
              type="number"
              min="1"
              max="32"
              defaultValue={String(asNumber(limits['maximumParallelRunsPerUser']))}
              required
            />
          </Field>
          <Field label="Daily run quota">
            <input
              name="dailyRunQuota"
              type="number"
              min="1"
              defaultValue={limits['dailyRunQuota'] == null ? '' : String(limits['dailyRunQuota'])}
            />
          </Field>
          <Field label="Daily input-token quota">
            <input
              name="dailyInputTokenQuota"
              type="number"
              min="1000"
              defaultValue={
                limits['dailyInputTokenQuota'] == null ? '' : String(limits['dailyInputTokenQuota'])
              }
            />
          </Field>
          <Field label="Daily output-token quota">
            <input
              name="dailyOutputTokenQuota"
              type="number"
              min="1000"
              defaultValue={
                limits['dailyOutputTokenQuota'] == null
                  ? ''
                  : String(limits['dailyOutputTokenQuota'])
              }
            />
          </Field>
          <Field label="Retain chats (days)">
            <input
              name="retentionDays"
              type="number"
              min="1"
              max="3650"
              defaultValue={String(asNumber(retention['retentionDays']))}
              required
            />
          </Field>
          <Field label="Archive older logs after (days)">
            <input
              name="archiveAfterDays"
              type="number"
              min="1"
              max="3650"
              defaultValue={String(asNumber(retention['archiveAfterDays']))}
              required
            />
          </Field>
        </div>
      </section>
      <section class="admin-control-card">
        <h3>Chat file storage</h3>
        <p>
          Choose a server-side Linux or Synology folder. NodeRag creates and owns a contained{' '}
          <code>.noderag-chat</code> child and never treats the browser's local folders as server
          storage.
        </p>
        <div class="storage-probe-row">
          <Field
            label="Storage root path"
            hint="On DSM, grant the NodeRag package user Read/Write access at the shared-folder level."
          >
            <input
              value={storagePath}
              onInput={(event) => {
                setStoragePath(event.currentTarget.value);
                setStorageProbe(null);
              }}
              placeholder="/volume1/Data/RAG/chat"
            />
          </Field>
          <button
            class="secondary"
            type="button"
            onClick={() => void probe()}
            disabled={storagePath.trim() === ''}
          >
            Verify and initialize
          </button>
        </div>
        {storageProbe ? (
          <Notice kind="success">
            Writable Chat storage: {asText(storageProbe['resolvedPath'])} · manifest{' '}
            {asText(storageProbe['manifestId'])}
          </Notice>
        ) : null}
        <div class="chat-reconciliation-panel">
          <h4>Recover chats already in this folder</h4>
          <p>
            NodeRag first performs a read-only checksum inspection. Nothing is imported until every
            source owner has been mapped and no corrupt, partial, conflicting, or future-format item
            remains.
          </p>
          <div class="button-row">
            <button
              class="secondary"
              type="button"
              disabled={storage['resolvedPath'] == null || reconciliationBusy}
              onClick={() => void inspectExistingChats()}
            >
              {reconciliationBusy ? 'Inspecting…' : 'Inspect existing chats'}
            </button>
            {reconciliationPreview !== null ? (
              <button
                class="secondary"
                type="button"
                disabled={reconciliationBusy}
                onClick={() => void inspectExistingChats()}
              >
                Re-check ownership and checksums
              </button>
            ) : null}
          </div>
          {reconciliationPreview !== null ? (
            <div class="chat-reconciliation-results" role="status">
              {list(reconciliationPreview['candidates']).length === 0 ? (
                <Notice kind="info">No portable Chat backups were found in this folder.</Notice>
              ) : (
                list(reconciliationPreview['candidates']).map((candidate) => {
                  const sourceOwnerId = String(candidate['sourceOwnerId']);
                  return (
                    <article class="chat-reconciliation-item">
                      <div>
                        <b>{asText(candidate['name'], 'Recovered chat')}</b>
                        <small>
                          {String(candidate['messages'] ?? 0)} messages ·{' '}
                          {String(candidate['events'] ?? 0)} verified events ·{' '}
                          {asText(candidate['action'], 'inspect').replaceAll('_', ' ')}
                        </small>
                      </div>
                      <Field
                        label={`Owner for ${asText(candidate['sourceOwnerLabel'], `source ${sourceOwnerId}`)}`}
                        hint="Select the local NodeRag account that should own this restored chat."
                      >
                        <select
                          value={String(ownerMap[sourceOwnerId] ?? '')}
                          onChange={(event) => {
                            const selected = Number(event.currentTarget.value);
                            setOwnerMap((current) => ({
                              ...current,
                              ...(Number.isInteger(selected) && selected > 0
                                ? { [sourceOwnerId]: selected }
                                : {}),
                            }));
                          }}
                        >
                          <option value="">Choose an owner</option>
                          {list(reconciliationPreview['destinationPrincipals']).map((principal) => (
                            <option value={String(principal['id'])}>
                              {asText(principal['label'], `Account ${String(principal['id'])}`)}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </article>
                  );
                })
              )}
              {list(reconciliationPreview['conflicts']).length > 0 ? (
                <Notice kind="warning">
                  {String(list(reconciliationPreview['conflicts']).length)} conflict(s) are safely
                  quarantined from import. Assign the suggested owners and re-check; checksum,
                  partial-file, path, duplicate, and future-format conflicts must be corrected at
                  their source.
                </Notice>
              ) : null}
              <button
                class="primary"
                type="button"
                disabled={reconciliationPreview['canReconcile'] !== true || reconciliationBusy}
                onClick={() => void reconcileExistingChats()}
              >
                Reconcile verified chats
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <button class="primary" disabled={models.length === 0}>
        Apply Chat settings
      </button>
    </form>
  );
};

const AppearancePanel = ({
  value,
  select,
}: {
  readonly value: ColorScheme;
  readonly select: (value: ColorScheme) => void;
}) => (
  <div class="admin-control-stack">
    <section class="admin-control-card">
      <h3>Choose your color scheme</h3>
      <p>
        This preference applies to your account in this browser and takes effect immediately. It
        does not change another user's view.
      </p>
      <div class="theme-grid" role="group" aria-label="Available color schemes">
        {colorSchemes.map((scheme) => (
          <button
            class={`theme-choice ${value === scheme.id ? 'selected' : ''}`}
            data-scheme={scheme.id}
            type="button"
            aria-pressed={value === scheme.id}
            onClick={() => select(scheme.id)}
          >
            <span class="theme-swatch" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              <b>{scheme.name}</b>
              <small>{scheme.description}</small>
            </span>
            {value === scheme.id ? <span class="theme-selected">Selected</span> : null}
          </button>
        ))}
      </div>
    </section>
  </div>
);

const ingestionEventSeverity = (event: JsonRecord): 'error' | 'warning' | 'success' | 'info' => {
  const type = asText(event['eventType'], '');
  if (type === 'failed') return 'error';
  if (['retry_scheduled', 'lease_reclaimed', 'cancelled'].includes(type)) return 'warning';
  if (type === 'succeeded') return 'success';
  return 'info';
};

const ChatHealthPanel = ({ data }: { readonly data: JsonRecord }) => {
  const runs = record(data['runs']);
  const runCounts = record(runs['counts']);
  const capacity = record(data['capacity']);
  const context = record(data['context']);
  const storage = record(data['storage']);
  const archives = record(data['archives']);
  const archiveSegments = record(archives['segments']);
  const reconciliation = record(data['reconciliation']);
  const performance = record(data['performance']);
  const quotas = record(data['quotas']);
  const activeRuns = list(runs['active']);
  const errors = list(data['errorsLast24Hours']);
  const providers = list(data['providers']);
  const archiveFailures = asNumber(archives['failedSample']);
  const staleLeases = asNumber(context['staleLeases']);
  const metricText = (group: JsonRecord, key: string, suffix: string): string => {
    if (group[key] === null || group[key] === undefined) return 'No samples';
    const value = Number(group[key]);
    return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : 'No samples';
  };
  return (
    <div class="admin-control-stack chat-health-panel">
      <Notice>
        This page contains operational counts and safe error codes only. Chat prompts, document
        text, credentials, and hidden model reasoning are not included.
      </Notice>
      <div class="metric-grid">
        <article>
          <span>Active runs</span>
          <strong>{String(activeRuns.length)}</strong>
          <small>{String(asNumber(runs['failedLast24Hours']))} failed in the last 24 hours</small>
        </article>
        <article>
          <span>Known model capacities</span>
          <strong>
            {String(asNumber(capacity['known']))}/{String(asNumber(capacity['profiles']))}
          </strong>
          <small>
            {String(asNumber(capacity['unknown']))} unknown · {String(asNumber(capacity['stale']))}{' '}
            stale
          </small>
        </article>
        <article>
          <span>Managed context</span>
          <strong>{String(asNumber(context['snapshots']))} snapshots</strong>
          <small>
            {String(asNumber(context['foldedMessages']))} folded ·{' '}
            {String(asNumber(context['exactPins']))} exact pins
          </small>
        </article>
        <article>
          <span>Chat storage</span>
          <strong>{storage['state'] === 'healthy' ? 'Healthy' : 'Unavailable'}</strong>
          <small>
            {storage['freeBytes'] == null
              ? 'Free space unavailable'
              : `${formatBytes(storage['freeBytes'])} free`}{' '}
            · {formatBytes(storage['recordedBytes'])} recorded
          </small>
        </article>
      </div>
      <section class="admin-control-card">
        <h3>Provider capability health</h3>
        <div class="provider-capability-grid">
          {providers.map((provider) => (
            <article>
              <h4>
                {asText(provider['provider']) === 'ollama_cloud' ? 'Ollama Cloud' : 'OpenAI OAuth'}
              </h4>
              <StatusPill value={provider['enabled'] === true ? 'enabled' : 'disabled'} />
              <p>{asText(provider['generationModel'], 'No generation model selected')}</p>
              <small>
                {Object.entries(record(provider['capabilities']))
                  .map(
                    ([capability, status]) =>
                      `${capability.replaceAll('_', ' ')}: ${String(status)}`,
                  )
                  .join(' · ') || 'No capability results'}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section class="admin-control-card">
        <h3>Runs and context workers</h3>
        <p>
          Run states:{' '}
          {Object.entries(runCounts)
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(' · ') || 'none'}
        </p>
        <p>
          Compression states:{' '}
          {Object.entries(record(context['jobs']))
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(' · ') || 'none'}
        </p>
        {staleLeases === 0 ? null : (
          <Notice kind="warning">
            {String(staleLeases)} compression lease(s) are ready for recovery.
          </Notice>
        )}
        {activeRuns.length === 0 ? (
          <p>No queued or running Chat work.</p>
        ) : (
          <div class="record-list">
            {activeRuns.map((run) => (
              <article>
                <div>
                  <b>{asText(run['chat'], 'Chat')}</b>
                  <small>
                    {asText(run['status'])} · {asText(run['provider'])} · {asText(run['model'])} ·
                    attempt {String(asNumber(run['attempts']))} of{' '}
                    {String(asNumber(run['maximumAttempts']))} · owner {asText(run['owner'])}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section class="admin-control-card">
        <h3>Archive and recovery health</h3>
        <p>
          Segments:{' '}
          {Object.entries(archiveSegments)
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(' · ') || 'none'}
        </p>
        <p>
          Latest sample: {String(asNumber(archives['verifiedSample']))} verified ·{' '}
          {String(archiveFailures)} failed · limit {String(asNumber(archives['sampleLimit']))}
        </p>
        <p>
          Unlinked folded messages: {String(asNumber(archives['unlinkedFoldedMessages']))} ·
          unlinked snapshots: {String(asNumber(archives['unlinkedSnapshots']))}
        </p>
        <p>
          Reconciliation operations:{' '}
          {Object.entries(record(reconciliation['operations']))
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(' · ') || 'none'}
          {' · '}
          conflicts {String(asNumber(reconciliation['quarantinedConflicts']))}
        </p>
        {archiveFailures === 0 ? null : (
          <Notice kind="danger">
            One or more sampled archive segments failed verification. Preserve the folder and
            restore it from a verified backup; do not repair it by hand.
          </Notice>
        )}
      </section>
      <section class="admin-control-card">
        <h3>Recent Chat performance</h3>
        <p>
          These measurements come from up to {String(asNumber(performance['sampleLimit']))} recent
          durable records. They contain timing and size totals, not message text.
        </p>
        <div class="metric-grid">
          <article>
            <span>Time to first token</span>
            <strong>{metricText(record(performance['timeToFirstTokenMs']), 'p50', ' ms')}</strong>
            <small>p95 {metricText(record(performance['timeToFirstTokenMs']), 'p95', ' ms')}</small>
          </article>
          <article>
            <span>Event commit latency</span>
            <strong>{metricText(record(performance['eventCommitLatencyMs']), 'p50', ' ms')}</strong>
            <small>
              p95 {metricText(record(performance['eventCommitLatencyMs']), 'p95', ' ms')}
            </small>
          </article>
          <article>
            <span>Tool-call latency</span>
            <strong>{metricText(record(performance['toolCallLatencyMs']), 'p50', ' ms')}</strong>
            <small>p95 {metricText(record(performance['toolCallLatencyMs']), 'p95', ' ms')}</small>
          </article>
          <article>
            <span>Context input</span>
            <strong>
              {metricText(record(performance['contextInputTokens']), 'average', ' tokens avg')}
            </strong>
            <small>
              Maximum {metricText(record(performance['contextInputTokens']), 'maximum', ' tokens')}
            </small>
          </article>
          <article>
            <span>Compression ratio</span>
            <strong>
              {metricText(record(performance['compressionRatio']), 'average', ' × source')}
            </strong>
            <small>Estimated compressed tokens divided by source tokens</small>
          </article>
          <article>
            <span>Server memory</span>
            <strong>{formatBytes(record(performance['runtimeMemory'])['rssBytes'])}</strong>
            <small>
              {formatBytes(record(performance['runtimeMemory'])['heapUsedBytes'])} JavaScript heap
            </small>
          </article>
        </div>
      </section>
      <section class="admin-control-card">
        <h3>Current limits and daily use</h3>
        <div class="metric-grid">
          <article>
            <span>Runs today</span>
            <strong>{String(asNumber(quotas['runsToday']))}</strong>
            <small>Limit {String(quotas['dailyRunLimit'] ?? 'unlimited')}</small>
          </article>
          <article>
            <span>Input tokens today</span>
            <strong>{String(quotas['inputTokensToday'] ?? '0')}</strong>
            <small>Limit {String(quotas['dailyInputTokenLimit'] ?? 'unlimited')}</small>
          </article>
          <article>
            <span>Output tokens today</span>
            <strong>{String(quotas['outputTokensToday'] ?? '0')}</strong>
            <small>Limit {String(quotas['dailyOutputTokenLimit'] ?? 'unlimited')}</small>
          </article>
          <article>
            <span>Per-Chat artifact limit</span>
            <strong>{formatBytes(quotas['artifactBytesPerChat'])}</strong>
            <small>
              Archive after {String(asNumber(quotas['archiveAfterDays']))} days · retain{' '}
              {String(asNumber(quotas['retentionDays']))} days
            </small>
          </article>
        </div>
      </section>
      <section class="admin-control-card">
        <h3>Safe errors from the last 24 hours</h3>
        {errors.length === 0 ? (
          <p>No Chat errors were recorded in the last 24 hours.</p>
        ) : (
          <div class="record-list">
            {errors.map((error) => (
              <article>
                <div>
                  <b>{asText(error['code'], 'chat_failure')}</b>
                  <small>
                    {asText(error['source'])} · {String(asNumber(error['count']))} occurrence(s) ·
                    last seen {new Date(asText(error['lastSeenAt'])).toLocaleString()}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const ingestionEventLabel = (value: string): string => {
  const labels: Readonly<Record<string, string>> = {
    leased: 'Work started',
    lease_reclaimed: 'Worker work recovered',
    progress: 'Progress updated',
    retry_scheduled: 'Retry scheduled',
    failed: 'Stage failed',
    succeeded: 'Stage completed',
    cancelled: 'Stage cancelled',
    paused: 'Stage paused',
    resumed: 'Stage resumed',
    manual_retry: 'Manual retry requested',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
};

const LogsPanel = ({ data }: { readonly data: JsonRecord }) => {
  const [severity, setSeverity] = useState('all');
  const entries = list(data['items']);
  const itemCount = Math.max(entries.length, asNumber(data['itemCount']));
  const visible = entries.filter(
    (entry) => severity === 'all' || ingestionEventSeverity(entry) === severity,
  );
  const failures = entries.filter((entry) => ingestionEventSeverity(entry) === 'error').length;
  const warnings = entries.filter((entry) => ingestionEventSeverity(entry) === 'warning').length;
  return (
    <div class="admin-control-stack ingestion-logs-panel">
      <section class="admin-control-card ingestion-log-summary">
        <div>
          <b>{String(itemCount)} events</b>
          <small>
            Rolling 24-hour ingestion history
            {data['truncated'] === true ? ` · showing newest ${String(entries.length)}` : ''}
          </small>
        </div>
        <div>
          <b>{String(failures)}</b>
          <small>Failures</small>
        </div>
        <div>
          <b>{String(warnings)}</b>
          <small>Warnings and retries</small>
        </div>
        <Field label="Show">
          <select value={severity} onChange={(event) => setSeverity(event.currentTarget.value)}>
            <option value="all">All activity</option>
            <option value="error">Failures</option>
            <option value="warning">Warnings and retries</option>
            <option value="success">Completed stages</option>
            <option value="info">Progress and starts</option>
          </select>
        </Field>
      </section>
      {visible.length === 0 ? (
        <EmptyState
          title="No matching ingestion activity"
          detail="No events matching this filter were recorded during the last 24 hours."
        />
      ) : (
        <div class="ingestion-log-list">
          {visible.map((entry) => {
            const eventType = asText(entry['eventType'], 'activity');
            const eventDetail = (entry['detail'] as JsonRecord | undefined) ?? {};
            const error = (entry['error'] as JsonRecord | undefined) ?? {};
            const diagnostic =
              (error['detail'] as JsonRecord | undefined) ??
              (eventDetail['detail'] as JsonRecord | undefined) ??
              {};
            const code = asText(error['code'], asText(eventDetail['code'], ''));
            const message = asText(error['message'], asText(eventDetail['message'], ''));
            const stage = asText(
              eventDetail['operation'],
              asText(
                eventDetail['stage'],
                asText((entry['progress'] as JsonRecord)?.['stage'], ''),
              ),
            );
            const pagesCompleted = asNumber(eventDetail['pagesCompleted']);
            const pagesTotal = asNumber(eventDetail['pagesTotal']);
            const severityValue = ingestionEventSeverity(entry);
            return (
              <article class={`ingestion-log-entry ${severityValue}`} key={String(entry['id'])}>
                <header>
                  <span class={`log-severity ${severityValue}`}>{severityValue}</span>
                  <div>
                    <b>
                      {asText(
                        entry['documentName'],
                        asText(
                          entry['documentPath'],
                          asText(entry['siloName'], 'Ingestion worker'),
                        ),
                      )}
                    </b>
                    <small>
                      {new Date(asText(entry['createdAt'])).toLocaleString()} ·{' '}
                      {ingestionEventLabel(eventType)}
                    </small>
                  </div>
                </header>
                <p>
                  {asText(entry['kind'], 'job')} job #{String(entry['jobId'])} · attempt{' '}
                  {String(asNumber(eventDetail['attempt']) || asNumber(entry['logicalAttempt']))} of{' '}
                  {String(Math.max(1, asNumber(entry['maximumAttempts'])))} ·{' '}
                  {asText(entry['state'], 'unknown')}
                </p>
                {stage ? (
                  <small>
                    Stage: {stage.replaceAll('-', ' ')}
                    {pagesTotal > 0
                      ? ` · ${String(pagesCompleted)} of ${String(pagesTotal)} pages`
                      : ''}
                  </small>
                ) : null}
                {code || message ? (
                  <div class="ingestion-log-error">
                    {code ? <b>Error {code}</b> : null}
                    {message ? <span>{message}</span> : null}
                    {asText(diagnostic['table']) ? (
                      <small>
                        Database table: {asText(diagnostic['table'])}
                        {asText(diagnostic['constraint'])
                          ? ` · constraint: ${asText(diagnostic['constraint'])}`
                          : ''}
                      </small>
                    ) : null}
                  </div>
                ) : null}
                <details>
                  <summary>Technical details</summary>
                  <pre>{JSON.stringify({ event: eventDetail, error }, null, 2)}</pre>
                </details>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

const appearanceSection = [
  'appearance',
  'Color schemes',
  null,
  'Choose a personal light, dark, green, blue, or red color scheme for this browser.',
] as const;

const adminSections = [
  [
    'providers',
    'Chat providers',
    '/v1/admin/chat/providers',
    'Configure Ollama Cloud generation and the Ollama Cloud internet-search capabilities used by Chat.',
  ],
  [
    'context-window',
    'Context window',
    '/v1/admin/chat/configuration',
    'Set rolling complete-turn limits, managed L1–L4 compression, reserves, and verified model capacities.',
  ],
  [
    'chat-settings',
    'Chat settings',
    '/v1/admin/chat/configuration',
    'Choose Chat defaults, quotas, retention, tool policies, and the contained server-side Chat folder.',
  ],
  [
    'chat-health',
    'Chat health',
    '/v1/admin/chat/health',
    'Review provider health, active runs, capacity, context, storage, archives, quotas, and safe recent errors.',
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
    'logs',
    'Logs',
    '/v1/admin/logs',
    'Review document ingestion, retries, failures, and diagnostic details from the last 24 hours.',
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
  appearanceSection,
  [
    'api',
    'API contract',
    '/v1/openapi.json',
    'Inspect the machine-readable contract for administrators and external integrations.',
  ],
] as const;

const AdminView = ({
  colorScheme,
  setColorScheme,
  serverAdmin,
}: {
  readonly colorScheme: ColorScheme;
  readonly setColorScheme: (value: ColorScheme) => void;
  readonly serverAdmin: boolean;
}) => {
  const [section, setSection] = useState(serverAdmin ? 'principals' : 'appearance');
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [providerAdministrationAvailable, setProviderAdministrationAvailable] = useState(false);
  const [chatConfigurationAvailable, setChatConfigurationAvailable] = useState(false);
  useEffect(() => {
    if (!serverAdmin) return;
    let current = true;
    void api<JsonRecord>('/v1/admin/chat/providers')
      .then((value) => {
        if (current) setProviderAdministrationAvailable(Array.isArray(value['providers']));
      })
      .catch(() => {
        if (current) setProviderAdministrationAvailable(false);
      });
    return () => {
      current = false;
    };
  }, [serverAdmin]);
  useEffect(() => {
    if (!serverAdmin) return;
    let current = true;
    void api<JsonRecord>('/v1/admin/chat/configuration')
      .then((value) => {
        if (current) setChatConfigurationAvailable(value['contract'] === 'chat-settings.v1');
      })
      .catch(() => {
        if (current) setChatConfigurationAvailable(false);
      });
    return () => {
      current = false;
    };
  }, [serverAdmin]);
  const visibleSections = serverAdmin
    ? adminSections.filter(
        ([id]) =>
          (id !== 'providers' || providerAdministrationAvailable) &&
          (!['context-window', 'chat-settings', 'chat-health'].includes(id) ||
            chatConfigurationAvailable),
      )
    : adminSections.filter(([id]) => id === 'appearance');
  const selected = visibleSections.find(([id]) => id === section) ?? appearanceSection;
  const loaded = useLoad(selected[2], refresh);
  useEffect(() => {
    if (section !== 'logs') return;
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 8_000);
    return () => window.clearInterval(timer);
  }, [section]);
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
          {visibleSections.map(([id, label]) => (
            <button
              class={section === id ? 'active' : ''}
              onClick={() => {
                setSection(id);
                setRefresh((value) => value + 1);
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
            {section === 'appearance' ? null : (
              <button class="secondary" onClick={() => setRefresh((v) => v + 1)}>
                Refresh
              </button>
            )}
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
            if (section === 'appearance')
              return <AppearancePanel value={colorScheme} select={setColorScheme} />;
            if (loaded.data === null) return <SkeletonRows />;
            if (section === 'settings')
              return (
                <SettingsPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'providers')
              return (
                <ChatProvidersPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'context-window')
              return (
                <ChatContextPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'chat-settings')
              return (
                <ChatSettingsPanel
                  data={loaded.data}
                  refresh={() => setRefresh((value) => value + 1)}
                  report={report}
                />
              );
            if (section === 'chat-health') return <ChatHealthPanel data={loaded.data} />;
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
            if (section === 'logs') return <LogsPanel data={loaded.data} />;
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
  const currentHash = (): Page => {
    const requested = location.hash.slice(1);
    if (requested === 'knowledge-bases') return 'documents';
    const validPages: readonly Page[] = [
      'search',
      'research',
      'chat',
      'documents',
      'ingest',
      'activity',
      'admin',
    ];
    return validPages.includes(requested as Page) ? (requested as Page) : 'search';
  };
  const [page, setPage] = useState<Page>(currentHash);
  const [menu, setMenu] = useState(false);
  const [workspaceSilos, setWorkspaceSilos] = useState<readonly Silo[]>(silos);
  const [chatAvailable, setChatAvailable] = useState(false);
  const [chatAvailabilityChecked, setChatAvailabilityChecked] = useState(false);
  const colorSchemeKey = `noderag.color-scheme.${String(principal.principalId)}`;
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>(() =>
    savedColorScheme(colorSchemeKey),
  );
  useEffect(() => setWorkspaceSilos(silos), [silos]);
  useEffect(() => {
    let current = true;
    void api<JsonRecord>('/v1/chats?limit=1')
      .then((response) => {
        const options = response['createOptions'];
        if (current) {
          setChatAvailable(
            typeof options === 'object' &&
              options !== null &&
              (options as JsonRecord)['ready'] === true,
          );
          setChatAvailabilityChecked(true);
        }
      })
      .catch(() => {
        if (current) {
          setChatAvailable(false);
          setChatAvailabilityChecked(true);
        }
      });
    return () => {
      current = false;
    };
  }, [principal.principalId]);
  useEffect(() => {
    if (chatAvailabilityChecked && !chatAvailable && page === 'chat') {
      location.hash = 'search';
      setPage('search');
    }
  }, [chatAvailabilityChecked, chatAvailable, page]);
  useEffect(() => {
    localStorage.setItem(colorSchemeKey, colorScheme);
    const themeColor = colorSchemes.find((scheme) => scheme.id === colorScheme)?.themeColor;
    if (themeColor !== undefined) {
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
    }
  }, [colorScheme, colorSchemeKey]);
  const selectColorScheme = useCallback((value: ColorScheme) => {
    setColorSchemeState(value);
  }, []);
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
  const navigationItems: ReadonlyArray<readonly [Page, string, string]> = [
    ['search', 'search', 'Search'],
    ['research', 'research', 'Research'],
    ...(chatAvailable ? ([['chat', 'chat', 'Chat']] as const) : []),
    ['documents', 'knowledge', 'Knowledge Bases'],
    ['ingest', 'ingest', 'Ingest'],
    ['activity', 'activity', 'Operations'],
    ['admin', 'settings', 'Administration'],
  ];
  return (
    <div class="app-shell" data-theme={colorScheme}>
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
          {navigationItems.map(([id, icon, label]) => (
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
            <SearchView silos={workspaceSilos} colorScheme={colorScheme} />
          ) : page === 'research' ? (
            <ResearchView silos={workspaceSilos} colorScheme={colorScheme} />
          ) : page === 'chat' ? (
            chatAvailable ? (
              <ChatView colorScheme={colorScheme} silos={workspaceSilos} />
            ) : (
              <SearchView silos={workspaceSilos} colorScheme={colorScheme} />
            )
          ) : page === 'documents' ? (
            <DocumentsView
              silos={workspaceSilos}
              colorScheme={colorScheme}
              serverAdmin={principal.serverAdmin}
              refreshWorkspaceSilos={refreshWorkspaceSilos}
            />
          ) : page === 'ingest' ? (
            <IngestView silos={workspaceSilos} />
          ) : page === 'activity' ? (
            <ActivityView />
          ) : (
            <AdminView
              colorScheme={colorScheme}
              setColorScheme={selectColorScheme}
              serverAdmin={principal.serverAdmin}
            />
          )}
        </main>
      </div>
    </div>
  );
};
