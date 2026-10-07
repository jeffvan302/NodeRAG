import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, displayError, postJson, type JsonRecord, type Silo } from './api.js';
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
import { MarkdownSearchViewer } from './markdown-search-viewer.js';
import { MarkdownPreview } from './markdown-viewer.js';
import { PdfViewer, type PdfEvidence } from './pdf-viewer.js';
import { appUrl } from './url.js';
import { ChatArtifactDrawer } from './chat-artifact-drawer.js';

interface ChatSummary {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly provider: 'ollama_cloud' | 'openai_oauth';
  readonly model: string;
  readonly reasoningEffort: string;
  readonly contextMode: string;
  readonly updatedAt: string;
  readonly activeRun: ChatRunSummary | null;
  readonly capabilities: {
    readonly research: boolean;
    readonly rag: boolean;
    readonly internet: boolean;
  };
}

interface ChatRunSummary {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly safeErrorCode: string | null;
}

interface ChatMessage {
  readonly id: string;
  readonly sequence: number;
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly state: string;
  readonly contextState: 'active' | 'folded';
  readonly pinned: boolean;
  readonly pinnedAt: string | null;
  readonly reasoning_summary: string | null;
  readonly createdAt: string;
  readonly toolCalls: readonly ChatToolCall[];
  readonly activities: readonly ChatActivity[];
  readonly citations: readonly ChatCitation[];
}

interface ChatToolCall {
  readonly id: string;
  readonly ordinal: number;
  readonly name: string;
  readonly arguments: JsonRecord;
  readonly status: 'requested' | 'running' | 'completed' | 'failed';
  readonly resultBytes: number | null;
  readonly safeErrorCode: string | null;
  readonly durationMs: number | null;
  readonly resultCount: number | null;
  readonly resultSummary: JsonRecord | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

type ChatActivity =
  | {
      readonly id: string;
      readonly type: 'thinking';
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly type: 'tool';
      readonly sequence: number;
      readonly toolCall: ChatToolCall;
    };

interface ModelOption {
  readonly provider: 'ollama_cloud' | 'openai_oauth';
  readonly model: string;
  readonly displayName: string;
  readonly reasoningEfforts: readonly string[];
}

interface ResearchOption {
  readonly id: number;
  readonly name: string;
  readonly updatedAt: string;
  readonly totalItems: number;
  readonly visibleItems: number;
  readonly visibleDocuments: number;
}

interface ChatCitation {
  readonly sourceKind: 'research' | 'rag' | 'web';
  readonly toolCallId: string | null;
  readonly attachmentRevisionId: string | null;
  readonly attachmentRevision: number | null;
  readonly id: string;
  readonly citationLabel: string;
  readonly researchName: string;
  readonly siloSlug: string;
  readonly documentId: number;
  readonly documentName: string;
  readonly documentTitle: string | null;
  readonly documentFormat: string;
  readonly pageOrdinal: number | null;
  readonly locator: JsonRecord;
  readonly confidence: number | null;
  readonly evidence: readonly JsonRecord[];
  readonly query: string;
  readonly status: 'active' | 'access_revoked' | 'source_stale';
  readonly text: string | null;
  readonly url: string | null;
  readonly hostname: string | null;
  readonly retrievedAt: string | null;
  readonly webSourceKind: 'search_result' | 'fetched_page' | null;
}

interface ChatResearchAttachment {
  readonly id: string;
  readonly revision: number;
  readonly snapshotAt: string;
  readonly itemCount: number;
  readonly hiddenItemCount: number;
  readonly collections: readonly {
    readonly researchId: number | null;
    readonly name: string;
    readonly totalItems: number;
    readonly visibleItems: number;
  }[];
}

const records = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
    : [];

const record = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};

const chatToolCall = (value: unknown): ChatToolCall | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const tool = value as JsonRecord;
  if (typeof tool['id'] !== 'string' || typeof tool['name'] !== 'string') return null;
  const status = tool['status'];
  return {
    id: tool['id'],
    ordinal: Number(tool['ordinal'] ?? 0),
    name: tool['name'],
    arguments: record(tool['arguments']),
    status:
      status === 'requested' || status === 'completed' || status === 'failed' ? status : 'running',
    resultBytes: typeof tool['resultBytes'] === 'number' ? tool['resultBytes'] : null,
    safeErrorCode: typeof tool['safeErrorCode'] === 'string' ? tool['safeErrorCode'] : null,
    durationMs: typeof tool['durationMs'] === 'number' ? tool['durationMs'] : null,
    resultCount: typeof tool['resultCount'] === 'number' ? tool['resultCount'] : null,
    resultSummary: tool['resultSummary'] === null ? null : record(tool['resultSummary']),
    startedAt: typeof tool['startedAt'] === 'string' ? tool['startedAt'] : null,
    finishedAt: typeof tool['finishedAt'] === 'string' ? tool['finishedAt'] : null,
  };
};

const chatActivities = (
  value: unknown,
  reasoningSummary: string | null,
  toolCalls: readonly ChatToolCall[],
): readonly ChatActivity[] => {
  const parsed = records(value).flatMap((activity): ChatActivity[] => {
    if (
      activity['type'] === 'thinking' &&
      typeof activity['id'] === 'string' &&
      typeof activity['text'] === 'string'
    ) {
      return [
        {
          id: activity['id'],
          type: 'thinking',
          sequence: Number(activity['sequence'] ?? 0),
          text: activity['text'],
        },
      ];
    }
    if (activity['type'] === 'tool' && typeof activity['id'] === 'string') {
      const toolCall = chatToolCall(activity['toolCall']);
      if (toolCall !== null) {
        return [
          {
            id: activity['id'],
            type: 'tool',
            sequence: Number(activity['sequence'] ?? 0),
            toolCall,
          },
        ];
      }
    }
    return [];
  });
  if (parsed.length > 0) return parsed;
  return [
    ...(reasoningSummary === null
      ? []
      : [
          {
            id: 'legacy-thinking',
            type: 'thinking' as const,
            sequence: -1,
            text: reasoningSummary,
          },
        ]),
    ...toolCalls.map((toolCall, index) => ({
      id: `legacy-tool-${toolCall.id}`,
      type: 'tool' as const,
      sequence: index,
      toolCall,
    })),
  ];
};

const writeClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard !== undefined && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Synology can be opened over plain HTTP and browser clipboard permission can also be denied.
      // Fall through to the selection-based copy path in either case.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard_unavailable');
};

const CopyBubbleButton = ({ text, label }: { readonly text: string; readonly label: string }) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await writeClipboard(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1800);
  };

  const title = failed ? 'Copy was blocked by the browser' : copied ? 'Copied' : label;
  return (
    <button
      type="button"
      class={`icon-button chat-copy-button${copied ? ' copied' : ''}${failed ? ' failed' : ''}`}
      aria-label={title}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
};

const toolLabels: Readonly<Record<string, string>> = {
  'research.list_sources.v1': 'List research sources',
  'research.read_page.v1': 'Read research page',
  'research.read_document.v1': 'Read research document',
  'rag.search.v1': 'Search knowledge bases',
  'document.read_markdown.v1': 'Read document Markdown',
  'web.search.v1': 'Search the web',
  'web.fetch.v1': 'Open a web page',
  'files.list.v1': 'List chat files',
  'files.read.v1': 'Read a chat file',
  'files.create.v1': 'Create a chat file',
  'files.mkdir.v1': 'Create a folder',
  'files.rename.v1': 'Rename a chat file',
  'files.copy.v1': 'Copy a chat file',
  'files.patch.v1': 'Update a chat file',
};

const toolLabel = (name: string): string => toolLabels[name] ?? name.replaceAll('.', ' ');

const toolCopyText = (tool: ChatToolCall): string =>
  JSON.stringify(
    {
      tool: tool.name,
      status: tool.status,
      arguments: tool.arguments,
      resultSummary: tool.resultSummary,
      resultCount: tool.resultCount,
      resultBytes: tool.resultBytes,
      durationMs: tool.durationMs,
      error: tool.safeErrorCode,
    },
    null,
    2,
  );

const ThinkingActivityBubble = ({
  activity,
  colorScheme,
}: {
  readonly activity: Extract<ChatActivity, { readonly type: 'thinking' }>;
  readonly colorScheme: string;
}) => (
  <details class="chat-detail-bubble chat-thinking-bubble chat-activity-bubble">
    <summary>
      <span class="chat-detail-title">
        <Icon name="activity" /> Thinking
      </span>
      <span class="chat-detail-status">Collapsed</span>
    </summary>
    <div class="chat-detail-content">
      <div class="chat-detail-actions">
        <span>Thinking supplied by the model; it may be partial or incorrect</span>
        <CopyBubbleButton text={activity.text} label="Copy thinking" />
      </div>
      <MarkdownPreview
        markdown={activity.text}
        colorScheme={colorScheme}
        className="chat-detail-markdown"
      />
    </div>
  </details>
);

const CitationButton = ({
  source,
  onOpen,
}: {
  readonly source: ChatCitation;
  readonly onOpen: (source: ChatCitation) => void;
}) => (
  <button
    type="button"
    class={`chat-citation ${source.status}`}
    disabled={source.status !== 'active'}
    title={
      source.status === 'active'
        ? `Open ${source.documentTitle ?? source.documentName}`
        : source.status.replaceAll('_', ' ')
    }
    onClick={() => onOpen(source)}
  >
    [{source.citationLabel}] {source.documentTitle ?? source.documentName}
    {source.pageOrdinal === null ? '' : ` · page ${String(source.pageOrdinal + 1)}`}{' '}
    {source.confidence === null ? '' : ` · ${String(Math.round(source.confidence * 100))}%`}
    {source.status === 'active' ? '' : ` · ${source.status.replaceAll('_', ' ')}`}
  </button>
);

const ToolActivityBubble = ({
  tool,
  citations,
  onOpenCitation,
}: {
  readonly tool: ChatToolCall;
  readonly citations: readonly ChatCitation[];
  readonly onOpenCitation: (source: ChatCitation) => void;
}) => (
  <details class={`chat-detail-bubble chat-tool-bubble chat-activity-bubble ${tool.status}`}>
    <summary>
      <span class="chat-detail-title">
        <Icon name="settings" /> {toolLabel(tool.name)}
      </span>
      <span class={`chat-detail-status ${tool.status}`}>
        {tool.status === 'requested'
          ? 'Requested'
          : tool.status === 'running'
            ? 'Working'
            : tool.status === 'completed'
              ? 'Completed'
              : 'Failed'}
      </span>
    </summary>
    <div class="chat-detail-content">
      <div class="chat-detail-actions">
        <code>{tool.name}</code>
        <CopyBubbleButton text={toolCopyText(tool)} label="Copy tool details" />
      </div>
      <dl class="chat-tool-metrics">
        {tool.durationMs === null ? null : (
          <>
            <dt>Duration</dt>
            <dd>{(tool.durationMs / 1000).toFixed(2)} seconds</dd>
          </>
        )}
        {tool.resultCount === null ? null : (
          <>
            <dt>Results</dt>
            <dd>{String(tool.resultCount)}</dd>
          </>
        )}
        {tool.resultBytes === null ? null : (
          <>
            <dt>Returned</dt>
            <dd>{String(tool.resultBytes.toLocaleString())} bytes</dd>
          </>
        )}
        {tool.safeErrorCode === null ? null : (
          <>
            <dt>Error</dt>
            <dd>{tool.safeErrorCode.replaceAll('_', ' ')}</dd>
          </>
        )}
      </dl>
      {Object.keys(tool.arguments).length === 0 ? null : (
        <section class="chat-tool-data">
          <strong>Inputs</strong>
          <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
        </section>
      )}
      {tool.resultSummary === null || Object.keys(tool.resultSummary).length === 0 ? null : (
        <section class="chat-tool-data">
          <strong>Result summary</strong>
          <pre>{JSON.stringify(tool.resultSummary, null, 2)}</pre>
        </section>
      )}
      {citations.length === 0 ? null : (
        <section class="chat-citations chat-tool-citations" aria-label="Search results">
          <strong>Search results</strong>
          <div>
            {citations.map((source) => (
              <CitationButton key={source.id} source={source} onOpen={onOpenCitation} />
            ))}
          </div>
        </section>
      )}
    </div>
  </details>
);

const safeWebHref = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

const chatSummary = (value: unknown): ChatSummary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (typeof row['id'] !== 'string' || typeof row['name'] !== 'string') return null;
  const active = row['activeRun'];
  const capabilities =
    typeof row['capabilities'] === 'object' && row['capabilities'] !== null
      ? (row['capabilities'] as JsonRecord)
      : {};
  return {
    id: row['id'],
    name: row['name'],
    archived: row['archived'] === true,
    provider: row['provider'] === 'openai_oauth' ? 'openai_oauth' : 'ollama_cloud',
    model: String(row['model'] ?? ''),
    reasoningEffort: String(row['reasoningEffort'] ?? 'default'),
    contextMode: String(row['contextMode'] ?? 'rolling'),
    updatedAt: String(row['updatedAt'] ?? ''),
    capabilities: {
      research: capabilities['research'] === true,
      rag: capabilities['rag'] === true,
      internet: capabilities['internet'] === true,
    },
    activeRun:
      typeof active === 'object' && active !== null
        ? {
            id: String((active as JsonRecord)['id']),
            status: String((active as JsonRecord)['status']),
            attempts: Number((active as JsonRecord)['attempts'] ?? 0),
            maximumAttempts: Number((active as JsonRecord)['maximumAttempts'] ?? 0),
            safeErrorCode:
              typeof (active as JsonRecord)['safeErrorCode'] === 'string'
                ? String((active as JsonRecord)['safeErrorCode'])
                : null,
          }
        : null,
  };
};

const modelOptions = (value: unknown): readonly ModelOption[] =>
  records(value).flatMap((row) => {
    const provider = row['provider'];
    const model = row['model'];
    if ((provider !== 'ollama_cloud' && provider !== 'openai_oauth') || typeof model !== 'string') {
      return [];
    }
    return [
      {
        provider,
        model,
        displayName: String(row['displayName'] ?? model),
        reasoningEfforts: Array.isArray(row['reasoningEfforts'])
          ? row['reasoningEfforts'].map(String)
          : ['default'],
      },
    ];
  });

const researchOptions = (value: unknown): readonly ResearchOption[] =>
  records(value).flatMap((row) =>
    typeof row['id'] !== 'number' || typeof row['name'] !== 'string'
      ? []
      : [
          {
            id: row['id'],
            name: row['name'],
            updatedAt: String(row['updatedAt'] ?? ''),
            totalItems: Number(row['totalItems'] ?? 0),
            visibleItems: Number(row['visibleItems'] ?? 0),
            visibleDocuments: Number(row['visibleDocuments'] ?? 0),
          },
        ],
  );

const citation = (value: unknown): ChatCitation | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  const status = row['status'];
  const sourceKind =
    row['sourceKind'] === 'rag' ? 'rag' : row['sourceKind'] === 'web' ? 'web' : 'research';
  if (
    (sourceKind === 'research' && typeof row['attachmentRevisionId'] !== 'string') ||
    typeof row['id'] !== 'string' ||
    typeof row['citationLabel'] !== 'string' ||
    !['active', 'access_revoked', 'source_stale'].includes(String(status))
  ) {
    return null;
  }
  return {
    sourceKind,
    toolCallId: typeof row['toolCallId'] === 'string' ? row['toolCallId'] : null,
    attachmentRevisionId:
      typeof row['attachmentRevisionId'] === 'string' ? row['attachmentRevisionId'] : null,
    attachmentRevision:
      typeof row['attachmentRevision'] === 'number' ? row['attachmentRevision'] : null,
    id: row['id'],
    citationLabel: row['citationLabel'],
    researchName: String(row['researchName'] ?? 'Research'),
    siloSlug: String(row['siloSlug'] ?? ''),
    documentId: Number(row['documentId']),
    documentName: String(row['documentName'] ?? 'Document'),
    documentTitle: typeof row['documentTitle'] === 'string' ? row['documentTitle'] : null,
    documentFormat: String(row['documentFormat'] ?? ''),
    pageOrdinal: typeof row['pageOrdinal'] === 'number' ? row['pageOrdinal'] : null,
    locator:
      typeof row['locator'] === 'object' && row['locator'] !== null
        ? (row['locator'] as JsonRecord)
        : {},
    confidence: typeof row['confidence'] === 'number' ? row['confidence'] : null,
    evidence: records(row['evidence']),
    query: String(row['query'] ?? ''),
    status: status as ChatCitation['status'],
    text: typeof row['text'] === 'string' ? row['text'] : null,
    url: safeWebHref(row['url']),
    hostname: typeof row['hostname'] === 'string' ? row['hostname'] : null,
    retrievedAt: typeof row['retrievedAt'] === 'string' ? row['retrievedAt'] : null,
    webSourceKind:
      row['webSourceKind'] === 'search_result' || row['webSourceKind'] === 'fetched_page'
        ? row['webSourceKind']
        : null,
  };
};

const attachment = (value: unknown): ChatResearchAttachment | null => {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as JsonRecord;
  if (typeof row['id'] !== 'string') return null;
  return {
    id: row['id'],
    revision: Number(row['revision']),
    snapshotAt: String(row['snapshotAt'] ?? ''),
    itemCount: Number(row['itemCount'] ?? 0),
    hiddenItemCount: Number(row['hiddenItemCount'] ?? 0),
    collections: records(row['collections']).map((collection) => ({
      researchId: typeof collection['researchId'] === 'number' ? collection['researchId'] : null,
      name: String(collection['name'] ?? 'Research'),
      totalItems: Number(collection['totalItems'] ?? 0),
      visibleItems: Number(collection['visibleItems'] ?? 0),
    })),
  };
};

const providerLabel = (provider: ChatSummary['provider']): string =>
  provider === 'ollama_cloud' ? 'Ollama Cloud' : 'OpenAI';

export const ChatView = ({
  colorScheme,
  silos,
}: {
  readonly colorScheme: string;
  readonly silos: readonly Silo[];
}) => {
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [availableResearch, setAvailableResearch] = useState<readonly ResearchOption[]>([]);
  const [selectedResearchIds, setSelectedResearchIds] = useState<readonly number[]>([]);
  const [researchAttachment, setResearchAttachment] = useState<ChatResearchAttachment | null>(null);
  const [researchSources, setResearchSources] = useState<readonly ChatCitation[]>([]);
  const [defaults, setDefaults] = useState<JsonRecord>({});
  const [contextModes, setContextModes] = useState<readonly ('rolling' | 'managed')[]>(['rolling']);
  const [contextInfo, setContextInfo] = useState<JsonRecord | null>(null);
  const [contextPreview, setContextPreview] = useState<JsonRecord | null>(null);
  const [artifactsEnabled, setArtifactsEnabled] = useState(false);
  const [exportsEnabled, setExportsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newModelKey, setNewModelKey] = useState('');
  const [newEffort, setNewEffort] = useState('default');
  const [newContextMode, setNewContextMode] = useState<'rolling' | 'managed'>('rolling');
  const [newAllowRag, setNewAllowRag] = useState(false);
  const [newAllowInternet, setNewAllowInternet] = useState(false);
  const [viewerCitation, setViewerCitation] = useState<ChatCitation | null>(null);
  const [viewerMode, setViewerMode] = useState<'source' | 'pdf' | 'markdown'>('source');
  const [viewerMarkdown, setViewerMarkdown] = useState('');
  const [viewerMarkdownBase, setViewerMarkdownBase] = useState(0);
  const [viewerMarkdownLoading, setViewerMarkdownLoading] = useState(false);
  const [viewerMarkdownError, setViewerMarkdownError] = useState('');
  const [pdfHighlightsEnabled, setPdfHighlightsEnabled] = useState(true);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const nextBeforeRef = useRef<number | null>(null);
  const eventSource = useRef<EventSource | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageLog = useRef<HTMLDivElement | null>(null);
  const followLatestMessage = useRef(true);
  const pendingScrollRestore = useRef<{ readonly height: number; readonly top: number } | null>(
    null,
  );
  const renderedMessageTail = useRef<{ readonly count: number; readonly id: string | null }>({
    count: 0,
    id: null,
  });
  const researchAvailable = useRef(false);
  const ragAvailable = useRef(false);
  const internetAvailable = useRef(false);

  const loadChats = useCallback(async (preferId?: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await api<JsonRecord>('/v1/chats?limit=100');
      const loaded = records(response['items']).flatMap((item) => {
        const parsed = chatSummary(item);
        return parsed === null ? [] : [parsed];
      });
      const options = (response['createOptions'] as JsonRecord | undefined) ?? {};
      const availableModels = modelOptions(options['models']);
      const research = researchOptions(options['researchCollections']);
      setChats(loaded);
      setModels(availableModels);
      setAvailableResearch(research);
      researchAvailable.current = response['researchEnabled'] === true;
      ragAvailable.current = response['ragEnabled'] === true;
      internetAvailable.current = response['internetEnabled'] === true;
      setArtifactsEnabled(response['artifactsEnabled'] === true);
      setExportsEnabled(response['exportsEnabled'] === true);
      setDefaults((options['default'] as JsonRecord | undefined) ?? {});
      const availableContextModes: ('rolling' | 'managed')[] = Array.isArray(
        options['contextModes'],
      )
        ? options['contextModes'].filter(
            (mode): mode is 'rolling' | 'managed' => mode === 'rolling' || mode === 'managed',
          )
        : ['rolling'];
      setContextModes(availableContextModes);
      setNewContextMode(
        (options['default'] as JsonRecord | undefined)?.['contextMode'] === 'managed' &&
          availableContextModes.includes('managed')
          ? 'managed'
          : 'rolling',
      );
      const defaultKey = `${String((options['default'] as JsonRecord | undefined)?.['provider'] ?? '')}:${String(
        (options['default'] as JsonRecord | undefined)?.['model'] ?? '',
      )}`;
      setNewModelKey((current) =>
        availableModels.some(({ provider, model }) => `${provider}:${model}` === current)
          ? current
          : defaultKey,
      );
      setSelectedId((current) => {
        const preferred = preferId ?? current;
        return preferred !== null && loaded.some(({ id }) => id === preferred)
          ? preferred
          : (loaded[0]?.id ?? null);
      });
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConversation = useCallback(async (chatId: string, older = false, background = true) => {
    const foreground = !older && !background;
    if (foreground) setMessageLoading(true);
    if (older) {
      const log = messageLog.current;
      if (log !== null) {
        pendingScrollRestore.current = { height: log.scrollHeight, top: log.scrollTop };
      }
      followLatestMessage.current = false;
    }
    try {
      const olderCursor = older ? nextBeforeRef.current : null;
      const [detail, history] = await Promise.all([
        api<JsonRecord>(`/v1/chats/${chatId}`),
        api<JsonRecord>(
          `/v1/chats/${chatId}/messages?limit=60${olderCursor === null ? '' : `&before=${String(olderCursor)}`}`,
        ),
      ]);
      const research = researchAvailable.current
        ? await api<JsonRecord>(`/v1/chats/${chatId}/research`)
        : null;
      const context = await api<JsonRecord>(`/v1/chats/${chatId}/context`).catch(() => null);
      const loadedChat = chatSummary(detail);
      if (loadedChat !== null) setSelected(loadedChat);
      setResearchAttachment(attachment(research?.['attachment']));
      setContextInfo(context);
      setResearchSources(
        records(research?.['sources']).flatMap((source) => {
          const parsed = citation(source);
          return parsed === null ? [] : [parsed];
        }),
      );
      const loadedMessages = records(history['items']).map((message) => {
        const reasoningSummary =
          typeof message['reasoning_summary'] === 'string' ? message['reasoning_summary'] : null;
        const toolCalls = records(message['toolCalls']).flatMap((tool) => {
          const parsed = chatToolCall(tool);
          return parsed === null ? [] : [parsed];
        });
        return {
          id: String(message['id']),
          sequence: Number(message['sequence']),
          role: message['role'] as ChatMessage['role'],
          content: String(message['content'] ?? ''),
          state: String(message['state'] ?? 'committed'),
          contextState: message['contextState'] === 'folded' ? 'folded' : 'active',
          pinned: message['pinned'] === true,
          pinnedAt: typeof message['pinnedAt'] === 'string' ? message['pinnedAt'] : null,
          reasoning_summary: reasoningSummary,
          createdAt: String(message['createdAt'] ?? ''),
          toolCalls,
          activities: chatActivities(message['activities'], reasoningSummary, toolCalls),
          citations: records(message['citations']).flatMap((source) => {
            const parsed = citation(source);
            return parsed === null ? [] : [parsed];
          }),
        } satisfies ChatMessage;
      });
      setMessages((current) => (older ? [...loadedMessages, ...current] : loadedMessages));
      const cursor = typeof history['nextBefore'] === 'number' ? history['nextBefore'] : null;
      nextBeforeRef.current = cursor;
      setNextBefore(cursor);
    } catch (reason) {
      if (older) pendingScrollRestore.current = null;
      setError(displayError(reason));
    } finally {
      if (foreground) setMessageLoading(false);
    }
  }, []);

  useEffect(() => void loadChats(), [loadChats]);

  useEffect(() => {
    eventSource.current?.close();
    eventSource.current = null;
    setSelected(null);
    setMessages([]);
    setResearchAttachment(null);
    setResearchSources([]);
    setContextInfo(null);
    setContextPreview(null);
    nextBeforeRef.current = null;
    setNextBefore(null);
    followLatestMessage.current = true;
    pendingScrollRestore.current = null;
    renderedMessageTail.current = { count: 0, id: null };
    if (selectedId === null) return;
    void loadConversation(selectedId, false, false);
    const source = new EventSource(appUrl(`/v1/chats/${selectedId}/events`), {
      withCredentials: true,
    });
    const refresh = () => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void loadConversation(selectedId);
      }, 100);
    };
    for (const event of [
      'run.queued',
      'response.output_text.delta',
      'response.reasoning_summary.delta',
      'response.tool_call',
      'response.completed',
      'response.failed',
      'run.cancel_requested',
    ]) {
      source.addEventListener(event, refresh);
    }
    eventSource.current = source;
    return () => {
      source.close();
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [loadConversation, selectedId]);

  const contextJob = (contextInfo?.['job'] as JsonRecord | null | undefined) ?? null;
  const contextJobActive = ['queued', 'running', 'cancelling'].includes(
    String(contextJob?.['state'] ?? ''),
  );

  useEffect(() => {
    if (selectedId === null || !contextJobActive) return;
    const timer = setInterval(() => void loadConversation(selectedId), 1000);
    return () => clearInterval(timer);
  }, [contextJobActive, loadConversation, selectedId]);

  useEffect(() => {
    const log = messageLog.current;
    if (log === null) return;
    const restore = pendingScrollRestore.current;
    if (restore !== null) {
      pendingScrollRestore.current = null;
      window.requestAnimationFrame(() => {
        const current = messageLog.current;
        if (current !== null)
          current.scrollTop = restore.top + (current.scrollHeight - restore.height);
      });
      return;
    }
    const last = messages.at(-1);
    const previous = renderedMessageTail.current;
    renderedMessageTail.current = { count: messages.length, id: last?.id ?? null };
    if (messages.length === 0 || !followLatestMessage.current) return;
    const newBubble =
      previous.count > 0 && (previous.count !== messages.length || previous.id !== last?.id);
    window.requestAnimationFrame(() => {
      const current = messageLog.current;
      if (current === null) return;
      current.scrollTo({
        top: current.scrollHeight,
        behavior: newBubble ? 'smooth' : 'auto',
      });
    });
  }, [messages]);

  const selectedModel = useMemo(
    () => models.find(({ provider, model }) => `${provider}:${model}` === newModelKey) ?? models[0],
    [models, newModelKey],
  );

  useEffect(() => {
    if (selectedModel === undefined) return;
    const preferred = String(defaults['reasoningEffort'] ?? 'default');
    setNewEffort(
      selectedModel.reasoningEfforts.includes(preferred)
        ? preferred
        : (selectedModel.reasoningEfforts[0] ?? 'default'),
    );
  }, [defaults, selectedModel]);

  const allCitations = useMemo(() => messages.flatMap((message) => message.citations), [messages]);

  const openCitation = useCallback((source: ChatCitation) => {
    if (source.status !== 'active') {
      setError(
        source.status === 'access_revoked'
          ? 'This source is no longer available because your knowledge-space access was revoked.'
          : 'This source changed after the Research snapshot. Refresh Research to create a new revision.',
      );
      return;
    }
    setError('');
    setViewerCitation(source);
    setViewerMode(
      source.sourceKind === 'web' ? 'source' : source.documentFormat === 'pdf' ? 'pdf' : 'markdown',
    );
  }, []);

  const navigateCitation = useCallback(
    (direction: -1 | 1) => {
      if (viewerCitation === null) return;
      const index = allCitations.findIndex(
        (source) =>
          source.id === viewerCitation.id && source.citationLabel === viewerCitation.citationLabel,
      );
      const next = allCitations[index + direction];
      if (next !== undefined) openCitation(next);
    },
    [allCitations, openCitation, viewerCitation],
  );

  const citationIndex =
    viewerCitation === null
      ? -1
      : allCitations.findIndex(
          (source) =>
            source.id === viewerCitation.id &&
            source.citationLabel === viewerCitation.citationLabel,
        );

  useEffect(() => {
    if (viewerCitation === null || viewerMode !== 'markdown') return;
    let active = true;
    setViewerMarkdown('');
    setViewerMarkdownBase(0);
    setViewerMarkdownError('');
    setViewerMarkdownLoading(true);
    const sourcePath = `/v1/chats/${String(selectedId)}/research/sources/${viewerCitation.id}`;
    const pagePath =
      viewerCitation.sourceKind === 'research'
        ? `${sourcePath}/page?revisionId=${encodeURIComponent(String(viewerCitation.attachmentRevisionId))}`
        : `/v1/chats/${String(selectedId)}/citations/${viewerCitation.id}/page`;
    void api<JsonRecord>(pagePath)
      .then((page) => {
        if (!active) return;
        setViewerMarkdown(String(page['markdown'] ?? ''));
        setViewerMarkdownBase(Number(page['characterStart'] ?? 0));
      })
      .catch((reason: unknown) => {
        if (active)
          setViewerMarkdownError(
            `The extracted Markdown could not be opened: ${displayError(reason)}`,
          );
      })
      .finally(() => active && setViewerMarkdownLoading(false));
    return () => {
      active = false;
    };
  }, [selectedId, viewerCitation, viewerMode]);

  const pdfEvidence = useMemo<readonly PdfEvidence[]>(
    () =>
      viewerCitation?.evidence.flatMap((item) => {
        const kind = item['kind'];
        const text = item['text'];
        if ((kind !== 'exact' && kind !== 'semantic') || typeof text !== 'string') return [];
        return [
          {
            kind,
            text,
            confidence: Number(item['confidence'] ?? viewerCitation.confidence ?? 0),
          },
        ];
      }) ?? [],
    [viewerCitation],
  );

  const refreshResearch = async () => {
    if (
      selectedId === null ||
      researchAttachment === null ||
      !window.confirm(
        'Refresh the attached Research snapshot? Existing answers keep their original citation revision.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${selectedId}/research/refresh`,
        { confirmation: 'REFRESH RESEARCH' },
        { idempotent: true },
      );
      setNotice('Research refreshed as a new immutable snapshot revision.');
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    if (selectedModel === undefined) return;
    setBusy(true);
    setError('');
    try {
      const created = await postJson<JsonRecord>(
        '/v1/chats',
        {
          name: newName,
          provider: selectedModel.provider,
          model: selectedModel.model,
          reasoningEffort: newEffort,
          contextMode: newContextMode,
          researchIds: selectedResearchIds,
          allowRag: newAllowRag,
          allowInternet: newAllowInternet,
        },
        { idempotent: true },
      );
      const id = String(created['id']);
      setNewName('');
      setSelectedResearchIds([]);
      setNewAllowRag(false);
      setNewAllowInternet(false);
      setNewOpen(false);
      setNotice(
        `Chat created${selectedResearchIds.length === 0 ? ' without attached Research' : ' with an immutable Research snapshot'}. Broader RAG is ${newAllowRag ? 'on' : 'off'}; Ollama Cloud internet is ${newAllowInternet ? 'on' : 'off'}.`,
      );
      await loadChats(id);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const previewContextCompression = async () => {
    if (selectedId === null) return;
    setBusy(true);
    setError('');
    try {
      setContextPreview(
        await api<JsonRecord>(`/v1/chats/${selectedId}/context/compression-preview`),
      );
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const queueContextCompression = async () => {
    if (selectedId === null) return;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${selectedId}/context/compressions`,
        { confirmation: 'COMPRESS CONTEXT' },
        { idempotent: true },
      );
      setContextPreview(null);
      setNotice('Context compression queued. Original messages remain available in older logs.');
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelCompression = async () => {
    if (selectedId === null || typeof contextJob?.['id'] !== 'string') return;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${selectedId}/context/compressions/${contextJob['id']}/cancel`,
        {},
        { idempotent: true },
      );
      setNotice('Context compression cancellation requested.');
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    if (selectedId === null || composer.trim().length === 0) return;
    followLatestMessage.current = true;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${selectedId}/messages`,
        { content: composer },
        { idempotent: true },
      );
      setComposer('');
      await loadConversation(selectedId);
      await loadChats(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (message: ChatMessage) => {
    if (selectedId === null) return;
    setBusy(true);
    setError('');
    try {
      await postJson(
        `/v1/chats/${selectedId}/messages/${message.id}/pin`,
        { pinned: !message.pinned },
        { idempotent: true },
      );
      setNotice(
        message.pinned
          ? 'Message removed from exact managed-context pins. Its original history is unchanged.'
          : 'Message pinned exactly. It will remain in model context within the configured pin limit.',
      );
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (selectedId === null || selected?.activeRun === null || selected?.activeRun === undefined)
      return;
    setBusy(true);
    try {
      await postJson(
        `/v1/chats/${selectedId}/runs/${selected.activeRun.id}/stop`,
        {},
        { idempotent: true },
      );
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (selectedId === null || selected?.activeRun === null || selected?.activeRun === undefined)
      return;
    followLatestMessage.current = true;
    setBusy(true);
    try {
      await postJson(
        `/v1/chats/${selectedId}/runs/${selected.activeRun.id}/retry`,
        {},
        { idempotent: true },
      );
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (selectedId === null || selected === null) return;
    const name = window.prompt('Chat name', selected.name)?.trim();
    if (name === undefined || name.length === 0 || name === selected.name) return;
    setBusy(true);
    try {
      await postJson(`/v1/chats/${selectedId}`, { name }, { method: 'PATCH', idempotent: true });
      await loadChats(selectedId);
      await loadConversation(selectedId);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (selectedId === null || selected === null || !window.confirm(`Archive “${selected.name}”?`))
      return;
    setBusy(true);
    try {
      await postJson(
        `/v1/chats/${selectedId}`,
        { archived: true },
        { method: 'PATCH', idempotent: true },
      );
      setNotice(
        'Chat archived. Its durable history remains available through the archived list API.',
      );
      await loadChats();
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  };

  const running = ['queued', 'running', 'cancelling'].includes(selected?.activeRun?.status ?? '');
  const retryable = ['failed', 'cancelled'].includes(selected?.activeRun?.status ?? '');
  const revokedSources = researchSources.filter(({ status }) => status === 'access_revoked').length;
  const staleSources = researchSources.filter(({ status }) => status === 'source_stale').length;
  const contextCounts = (contextInfo?.['counts'] as JsonRecord | null | undefined) ?? null;
  const contextSnapshot = (contextInfo?.['snapshot'] as JsonRecord | null | undefined) ?? null;

  return (
    <section class="page chat-page" aria-labelledby="chat-heading">
      <header class="page-header chat-page-header">
        <div>
          <p class="eyebrow">Provider-backed workspace</p>
          <h1 id="chat-heading">Chat</h1>
          <p>
            Durable conversations with Ollama Cloud or OpenAI. Optional internet search and page
            retrieval always run through Ollama Cloud's hosted web APIs, independently of the model
            that writes the answer.
          </p>
        </div>
        <button
          class="primary"
          type="button"
          onClick={() => {
            setSelectedResearchIds([]);
            setNewOpen(true);
          }}
          disabled={models.length === 0}
        >
          <Icon name="plus" /> New chat
        </button>
      </header>
      {error.length > 0 ? <Notice kind="danger">{error}</Notice> : null}
      {notice.length > 0 ? <Notice kind="success">{notice}</Notice> : null}
      <div class="chat-workspace">
        <aside class="chat-list-panel" aria-label="Conversations">
          <div class="chat-list-heading">
            <h2>Conversations</h2>
            <StatusPill value={`${String(chats.length)} active`} />
          </div>
          {loading ? (
            <SkeletonRows count={5} />
          ) : chats.length === 0 ? (
            <EmptyState
              title="No chats yet"
              detail="Create a named chat to begin. Its messages and provider choices are stored durably."
            />
          ) : (
            <div class="chat-list" role="list">
              {chats.map((chat) => (
                <div role="listitem">
                  <button
                    class={selectedId === chat.id ? 'chat-list-item active' : 'chat-list-item'}
                    type="button"
                    aria-current={selectedId === chat.id ? 'true' : undefined}
                    onClick={() => setSelectedId(chat.id)}
                  >
                    <b>{chat.name}</b>
                    <span>
                      {providerLabel(chat.provider)} · {chat.model}
                    </span>
                    <small>{new Date(chat.updatedAt).toLocaleString()}</small>
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
        <article class="chat-conversation-panel" aria-live="polite">
          {selectedId === null ? (
            <EmptyState
              title="Select a chat"
              detail="Choose a conversation from the left, or create a new one."
            />
          ) : selected === null || messageLoading ? (
            <SkeletonRows count={5} />
          ) : (
            <>
              <header class="chat-conversation-header">
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {providerLabel(selected.provider)} · {selected.model} ·{' '}
                    {selected.reasoningEffort}
                  </p>
                </div>
                <div class="button-row">
                  <ChatArtifactDrawer
                    chatId={selectedId}
                    colorScheme={colorScheme}
                    enabled={artifactsEnabled}
                    exportsEnabled={exportsEnabled}
                    silos={silos}
                  />
                  <button
                    type="button"
                    class="secondary"
                    onClick={() => void rename()}
                    disabled={busy}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    onClick={() => void archive()}
                    disabled={busy || running}
                  >
                    Archive
                  </button>
                </div>
              </header>
              <div class="chat-capability-strip" aria-label="Chat capabilities">
                <StatusPill value="Text chat ready" />
                <span>Context {selected.contextMode}</span>
                <span>
                  {researchAttachment === null
                    ? 'Research off'
                    : `Research snapshot r${String(researchAttachment.revision)}`}
                </span>
                <span>RAG {selected.capabilities.rag ? 'on · current permissions' : 'off'}</span>
                <span>
                  {selected.capabilities.internet
                    ? internetAvailable.current
                      ? 'Internet on · Ollama Cloud only'
                      : 'Internet unavailable · check Ollama Cloud health'
                    : 'Internet off · Ollama Cloud only'}
                </span>
              </div>
              {selected.contextMode !== 'managed' ? null : (
                <section class="chat-context-status" aria-label="Managed context status">
                  <div>
                    <strong>Managed context</strong>
                    <span>
                      {String(contextCounts?.['active_messages'] ?? 0)} active ·{' '}
                      {String(contextCounts?.['folded_messages'] ?? 0)} in older logs ·{' '}
                      {String(contextCounts?.['pinned_messages'] ?? 0)} exact pins
                    </span>
                    <small>
                      {contextSnapshot === null
                        ? 'No compression snapshot yet.'
                        : `Snapshot ${String(contextSnapshot['schema_revision'])} · ${String(
                            contextSnapshot['context_tokens'] ?? 0,
                          )} estimated input tokens`}
                      {contextJob === null
                        ? ''
                        : ` · Last job ${String(contextJob['state'])}${
                            contextJob['current_layer'] === null ||
                            contextJob['current_layer'] === undefined
                              ? ''
                              : ` (${String(contextJob['current_layer'])})`
                          }`}
                    </small>
                  </div>
                  <div class="button-row">
                    <button
                      type="button"
                      class="secondary"
                      onClick={() => void previewContextCompression()}
                      disabled={busy || running || contextJobActive}
                    >
                      Preview compression
                    </button>
                    {contextJobActive ? (
                      <button
                        type="button"
                        class="danger-button"
                        onClick={() => void cancelCompression()}
                        disabled={busy}
                      >
                        Cancel compression
                      </button>
                    ) : null}
                  </div>
                </section>
              )}
              {researchAttachment === null ? null : (
                <section class="chat-research-context" aria-label="Attached Research snapshot">
                  <div>
                    <strong>
                      {researchAttachment.collections.map(({ name }) => name).join(' · ')}
                    </strong>
                    <span>
                      Snapshot {new Date(researchAttachment.snapshotAt).toLocaleString()} ·{' '}
                      {String(researchAttachment.itemCount)} saved sources
                    </span>
                    {researchAttachment.hiddenItemCount > 0 ||
                    revokedSources > 0 ||
                    staleSources > 0 ? (
                      <small>
                        {String(researchAttachment.hiddenItemCount)} hidden at capture ·{' '}
                        {String(revokedSources)} access revoked · {String(staleSources)} changed
                      </small>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    class="secondary"
                    onClick={() => void refreshResearch()}
                    disabled={busy || running}
                  >
                    Refresh Research
                  </button>
                </section>
              )}
              <div
                ref={messageLog}
                class="chat-message-log"
                role="log"
                aria-label="Chat messages"
                onScroll={(event) => {
                  const log = event.currentTarget;
                  followLatestMessage.current =
                    log.scrollHeight - log.scrollTop - log.clientHeight <= 96;
                }}
              >
                {nextBefore === null ? null : (
                  <button
                    class="secondary view-older"
                    type="button"
                    onClick={() => void loadConversation(selectedId, true)}
                  >
                    View older logs
                  </button>
                )}
                {messages.length === 0 ? (
                  <EmptyState
                    title="Start the conversation"
                    detail={
                      researchAttachment === null
                        ? selected.capabilities.rag || selected.capabilities.internet
                          ? 'Write a message below. Enabled tools remain bounded by current permissions and provider health.'
                          : 'Write a message below. This chat has no Research, RAG, or internet context.'
                        : 'Write a message below. NodeRag can use the attached Research snapshot and only the other capabilities shown above.'
                    }
                  />
                ) : (
                  messages.map((message) => {
                    if (message.role !== 'assistant') {
                      return (
                        <section
                          key={message.id}
                          class={`chat-bubble ${message.role} ${message.state}`}
                          aria-label={`${message.role} message`}
                        >
                          <header>
                            <b>{message.role === 'user' ? 'You' : 'Instruction'}</b>
                            <span>{message.state}</span>
                            {message.contextState === 'folded' ? (
                              <span>Archived from context</span>
                            ) : null}
                            {message.state === 'committed' ? (
                              <button
                                type="button"
                                class="secondary chat-pin-button"
                                aria-pressed={message.pinned}
                                title={
                                  message.pinned
                                    ? 'Remove this exact message from managed-context pins'
                                    : 'Keep this exact message in managed context'
                                }
                                disabled={busy}
                                onClick={() => void togglePin(message)}
                              >
                                {message.pinned ? 'Pinned' : 'Pin'}
                              </button>
                            ) : null}
                            <CopyBubbleButton text={message.content} label="Copy message" />
                          </header>
                          <div class="chat-message-content">{message.content}</div>
                        </section>
                      );
                    }
                    const finalCitations = message.citations.filter(
                      (source) => source.sourceKind !== 'web' || source.toolCallId === null,
                    );
                    return (
                      <div
                        key={message.id}
                        class="chat-assistant-turn"
                        role="group"
                        aria-label="NodeRag response sequence"
                      >
                        {message.activities.map((activity) =>
                          activity.type === 'thinking' ? (
                            <ThinkingActivityBubble
                              key={activity.id}
                              activity={activity}
                              colorScheme={colorScheme}
                            />
                          ) : (
                            <ToolActivityBubble
                              key={activity.id}
                              tool={activity.toolCall}
                              citations={message.citations.filter(
                                (source) => source.toolCallId === activity.toolCall.id,
                              )}
                              onOpenCitation={openCitation}
                            />
                          ),
                        )}
                        <section
                          class={`chat-bubble assistant chat-final-answer ${message.state}`}
                          aria-label="assistant final answer"
                        >
                          <header>
                            <b>NodeRag</b>
                            <span>
                              {message.state === 'committed' ? 'Final answer' : message.state}
                            </span>
                            {message.contextState === 'folded' ? (
                              <span>Archived from context</span>
                            ) : null}
                            {message.state === 'committed' ? (
                              <button
                                type="button"
                                class="secondary chat-pin-button"
                                aria-pressed={message.pinned}
                                title={
                                  message.pinned
                                    ? 'Remove this exact message from managed-context pins'
                                    : 'Keep this exact message in managed context'
                                }
                                disabled={busy}
                                onClick={() => void togglePin(message)}
                              >
                                {message.pinned ? 'Pinned' : 'Pin'}
                              </button>
                            ) : null}
                            <CopyBubbleButton text={message.content} label="Copy final answer" />
                          </header>
                          <div class="chat-message-content">
                            {message.content.length === 0 && message.state === 'streaming' ? (
                              <>
                                <Spinner /> Waiting for the provider…
                              </>
                            ) : (
                              <MarkdownPreview
                                markdown={message.content}
                                colorScheme={colorScheme}
                                className="chat-markdown-content"
                              />
                            )}
                          </div>
                          {finalCitations.length === 0 ? null : (
                            <div
                              class="chat-citations"
                              aria-label="Sources provided for this answer"
                            >
                              <strong>Sources provided for this answer</strong>
                              <div>
                                {finalCitations.map((source) => (
                                  <CitationButton
                                    key={source.id}
                                    source={source}
                                    onOpen={openCitation}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </section>
                      </div>
                    );
                  })
                )}
              </div>
              {selected.activeRun?.status !== 'failed' ||
              selected.activeRun.safeErrorCode === null ? null : (
                <Notice kind="danger">
                  The provider stopped safely:{' '}
                  {selected.activeRun.safeErrorCode.replaceAll('_', ' ')}.
                </Notice>
              )}
              <form class="chat-composer" onSubmit={(event) => void send(event)}>
                <label for="chat-message">Message</label>
                <textarea
                  id="chat-message"
                  value={composer}
                  onInput={(event) => setComposer(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={3}
                  maxLength={200000}
                  placeholder="Ask a question or continue this conversation…"
                  disabled={busy || running}
                />
                <div class="chat-composer-actions">
                  <small>Enter sends · Shift+Enter adds a line</small>
                  {running ? (
                    <button
                      class="danger-button"
                      type="button"
                      onClick={() => void stop()}
                      disabled={busy}
                    >
                      Stop
                    </button>
                  ) : retryable ? (
                    <button
                      class="secondary"
                      type="button"
                      onClick={() => void retry()}
                      disabled={busy}
                    >
                      Retry last response
                    </button>
                  ) : null}
                  <button
                    class="primary"
                    type="submit"
                    disabled={busy || running || composer.trim().length === 0}
                  >
                    {busy ? <Spinner /> : null} Send
                  </button>
                </div>
              </form>
            </>
          )}
        </article>
      </div>
      {contextPreview === null ? null : (
        <Modal title="Compression preview" close={() => !busy && setContextPreview(null)}>
          <div class="admin-control-stack">
            <Notice>
              This is a dry run. It does not call a model or change the conversation. Original
              messages are never deleted by compression.
            </Notice>
            <dl class="chat-context-preview">
              <div>
                <dt>Complete turns found</dt>
                <dd>{String(contextPreview['completeTurns'] ?? 0)}</dd>
              </div>
              <div>
                <dt>Messages to move from active context</dt>
                <dd>
                  {String(
                    Array.isArray(contextPreview['foldMessageIds'])
                      ? contextPreview['foldMessageIds'].length
                      : 0,
                  )}
                </dd>
              </div>
              <div>
                <dt>Recent turns kept exact</dt>
                <dd>{String(contextPreview['keepRecentTurns'] ?? 0)}</dd>
              </div>
              <div>
                <dt>Exact pins retained</dt>
                <dd>
                  {String(
                    Array.isArray(contextPreview['pinnedMessageIds'])
                      ? contextPreview['pinnedMessageIds'].length
                      : 0,
                  )}
                </dd>
              </div>
              <div>
                <dt>Layer scheduling</dt>
                <dd>{String(contextPreview['scheduling'] ?? 'sequential')}</dd>
              </div>
              <div>
                <dt>Estimated source tokens</dt>
                <dd>{String(contextPreview['estimatedSourceTokens'] ?? 0)}</dd>
              </div>
            </dl>
            <div class="button-row end">
              <button
                type="button"
                class="secondary"
                onClick={() => setContextPreview(null)}
                disabled={busy}
              >
                Close dry run
              </button>
              <button
                type="button"
                class="primary"
                onClick={() => void queueContextCompression()}
                disabled={
                  busy ||
                  !Array.isArray(contextPreview['foldMessageIds']) ||
                  contextPreview['foldMessageIds'].length === 0
                }
              >
                {busy ? <Spinner /> : null} Compress context
              </button>
            </div>
          </div>
        </Modal>
      )}
      {newOpen ? (
        <Modal title="Create a chat" close={() => !busy && setNewOpen(false)}>
          <form class="admin-control-stack" onSubmit={(event) => void create(event)}>
            <Field
              label="Chat name"
              hint="Use a name that will still make sense in the conversation list later."
            >
              <input
                value={newName}
                onInput={(event) => setNewName(event.currentTarget.value)}
                maxLength={200}
                required
                autoFocus
              />
            </Field>
            <Field
              label="Response model"
              hint="Ollama means Ollama Cloud. Local or custom Ollama addresses are never offered here."
            >
              <select
                value={newModelKey}
                onChange={(event) => setNewModelKey(event.currentTarget.value)}
                required
              >
                {models.map((model) => (
                  <option value={`${model.provider}:${model.model}`}>
                    {providerLabel(model.provider)} · {model.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Reasoning effort"
              hint="Only efforts reported by the selected provider model are offered."
            >
              <select
                value={newEffort}
                onChange={(event) => setNewEffort(event.currentTarget.value)}
              >
                {(selectedModel?.reasoningEfforts ?? ['default']).map((effort) => (
                  <option value={effort}>{effort}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Context handling"
              hint="Rolling keeps recent complete turns. Managed also preserves exact pins and creates bounded summary/state snapshots."
            >
              <select
                value={newContextMode}
                onChange={(event) =>
                  setNewContextMode(event.currentTarget.value === 'managed' ? 'managed' : 'rolling')
                }
              >
                {contextModes.map((mode) => (
                  <option value={mode}>
                    {mode === 'managed' ? 'Managed context' : 'Rolling context'}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset class="chat-research-picker">
              <legend>Attach Research (optional)</legend>
              <p>
                NodeRag captures a fixed snapshot of the references you can read now. It does not
                copy whole documents, search other knowledge bases, or use the internet.
              </p>
              {availableResearch.length === 0 ? (
                <span class="muted">No personal Research collections are available.</span>
              ) : (
                availableResearch.map((research) => (
                  <label class="checkbox chat-research-choice">
                    <input
                      type="checkbox"
                      checked={selectedResearchIds.includes(research.id)}
                      disabled={research.visibleItems === 0}
                      onChange={(event) =>
                        setSelectedResearchIds((current) =>
                          event.currentTarget.checked
                            ? [...current, research.id]
                            : current.filter((id) => id !== research.id),
                        )
                      }
                    />
                    <span>
                      <b>{research.name}</b>
                      <small>
                        {String(research.visibleItems)} readable references across{' '}
                        {String(research.visibleDocuments)} documents
                        {research.totalItems === research.visibleItems
                          ? ''
                          : ` · ${String(research.totalItems - research.visibleItems)} currently hidden`}
                      </small>
                    </span>
                  </label>
                ))
              )}
            </fieldset>
            <label class="checkbox chat-research-choice">
              <input
                type="checkbox"
                checked={newAllowRag}
                disabled={!ragAvailable.current}
                onChange={(event) => setNewAllowRag(event.currentTarget.checked)}
              />
              <span>
                <b>Allow broader knowledge-base search</b>
                <small>
                  The model may search only knowledge spaces you can currently read. Permission is
                  checked again for every search and document read.
                </small>
              </span>
            </label>
            <label class="checkbox chat-research-choice">
              <input
                type="checkbox"
                checked={newAllowInternet}
                disabled={!internetAvailable.current}
                onChange={(event) => setNewAllowInternet(event.currentTarget.checked)}
              />
              <span>
                <b>Allow Ollama Cloud internet search</b>
                <small>
                  The model may search and fetch public web evidence only through Ollama Cloud's
                  hosted APIs. Results are bounded, stored as citations, and treated as untrusted.
                </small>
              </span>
            </label>
            <Notice>
              Research, knowledge-base search, and internet access are independent. Chat internet
              always calls Ollama Cloud web search/fetch—even when OpenAI writes the answer. Local,
              self-hosted, and custom Ollama endpoints are never used by Chat.
            </Notice>
            <div class="button-row end">
              <button
                type="button"
                class="secondary"
                onClick={() => setNewOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="primary"
                disabled={busy || newName.trim().length === 0 || selectedModel === undefined}
              >
                {busy ? <Spinner /> : null} Create chat
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
      {viewerCitation === null ? null : viewerMode === 'pdf' ? (
        <PdfViewer
          documentId={viewerCitation.documentId}
          sourceUrl={appUrl(
            viewerCitation.sourceKind === 'research'
              ? `/v1/chats/${String(selectedId)}/research/sources/${viewerCitation.id}/original?revisionId=${encodeURIComponent(String(viewerCitation.attachmentRevisionId))}`
              : `/v1/chats/${String(selectedId)}/citations/${viewerCitation.id}/original`,
          )}
          title={viewerCitation.documentTitle ?? viewerCitation.documentName}
          initialPage={Math.max(
            1,
            viewerCitation.pageOrdinal === null
              ? Number(viewerCitation.locator['pageStart'] ?? 1)
              : viewerCitation.pageOrdinal + 1,
          )}
          citationPageEnd={Math.max(
            1,
            Number(
              viewerCitation.locator['pageEnd'] ??
                viewerCitation.locator['pageStart'] ??
                (viewerCitation.pageOrdinal ?? 0) + 1,
            ),
          )}
          citationKey={`${viewerCitation.sourceKind}:${String(viewerCitation.attachmentRevisionId ?? 'current')}:${viewerCitation.id}:${viewerCitation.citationLabel}`}
          confidence={viewerCitation.confidence ?? 0}
          evidence={pdfEvidence}
          semanticEvidenceStatus={
            pdfEvidence.some(({ kind }) => kind === 'semantic') ? 'ready' : 'not-requested'
          }
          highlightsEnabled={pdfHighlightsEnabled}
          onHighlightsChange={setPdfHighlightsEnabled}
          searchNavigation={{
            previous: citationIndex <= 0 ? null : () => navigateCitation(-1),
            next:
              citationIndex < 0 || citationIndex >= allCitations.length - 1
                ? null
                : () => navigateCitation(1),
          }}
          navigationLabel="answer sources"
          showSourcePassage={() => setViewerMode('source')}
          close={() => setViewerCitation(null)}
        />
      ) : viewerMode === 'markdown' ? (
        <MarkdownSearchViewer
          documentId={viewerCitation.documentId}
          title={viewerCitation.documentTitle ?? viewerCitation.documentName}
          format={viewerCitation.documentFormat}
          markdown={viewerMarkdown}
          loading={viewerMarkdownLoading}
          error={viewerMarkdownError}
          colorScheme={colorScheme}
          confidence={viewerCitation.confidence ?? 0}
          citationKey={`${viewerCitation.sourceKind}:${String(viewerCitation.attachmentRevisionId ?? 'current')}:${viewerCitation.id}:${viewerCitation.citationLabel}`}
          citationText={viewerCitation.text ?? viewerCitation.query}
          citationCharacterStart={Math.max(
            0,
            Number(viewerCitation.locator['characterStart'] ?? 0) - viewerMarkdownBase,
          )}
          searchNavigation={{
            previous: citationIndex <= 0 ? null : () => navigateCitation(-1),
            next:
              citationIndex < 0 || citationIndex >= allCitations.length - 1
                ? null
                : () => navigateCitation(1),
          }}
          navigationLabel="answer sources"
          showSourcePassage={() => setViewerMode('source')}
          close={() => setViewerCitation(null)}
        />
      ) : (
        <Modal
          title={`${viewerCitation.citationLabel} · ${viewerCitation.documentTitle ?? viewerCitation.documentName}`}
          wide
          close={() => setViewerCitation(null)}
        >
          <div class="chat-citation-preview">
            <div class="preview-toolbar">
              {viewerCitation.sourceKind === 'web' ? (
                viewerCitation.url === null ? null : (
                  <a
                    class="primary button-link"
                    href={viewerCitation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open original website
                  </a>
                )
              ) : (
                <button
                  type="button"
                  class="primary"
                  onClick={() =>
                    setViewerMode(viewerCitation.documentFormat === 'pdf' ? 'pdf' : 'markdown')
                  }
                >
                  {viewerCitation.documentFormat === 'pdf'
                    ? 'View PDF at cited page'
                    : 'Open Markdown reader'}
                </button>
              )}
              <button
                type="button"
                class="secondary"
                disabled={citationIndex <= 0}
                onClick={() => navigateCitation(-1)}
              >
                Previous source
              </button>
              <button
                type="button"
                class="secondary"
                disabled={citationIndex < 0 || citationIndex >= allCitations.length - 1}
                onClick={() => navigateCitation(1)}
              >
                Next source
              </button>
            </div>
            <p>
              <b>{viewerCitation.researchName}</b> · {viewerCitation.siloSlug}
              {viewerCitation.confidence === null
                ? ''
                : ` · Confidence ${String(Math.round(viewerCitation.confidence * 100))}%`}
            </p>
            {viewerCitation.sourceKind !== 'web' ? null : (
              <p>
                {viewerCitation.hostname ?? 'Public web'}
                {viewerCitation.retrievedAt === null
                  ? ''
                  : ` · Retrieved ${new Date(viewerCitation.retrievedAt).toLocaleString()}`}
              </p>
            )}
            <pre dir="auto">
              {viewerCitation.text ?? 'The source passage is no longer available.'}
            </pre>
          </div>
        </Modal>
      )}
    </section>
  );
};
