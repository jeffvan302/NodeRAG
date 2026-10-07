import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { writeAuditEvent } from '../application/audit.js';
import {
  CHAT_CORE_CONTRACT_VERSION,
  chatIdSchema,
  createChatSchema,
  decodeChatCursor,
  encodeChatCursor,
  listChatEventsQuerySchema,
  listChatMessagesQuerySchema,
  listChatQuerySchema,
  retryChatRunSchema,
  sendChatMessageSchema,
  updateChatSchema,
} from '../chat/core.js';
import { appendChatEvent } from '../chat/runner.js';
import { estimateTextTokens } from '../chat/context-runtime.js';
import { readSealedChatEventLog } from '../chat/log-store.js';
import {
  cancelContextCompression,
  getManagedContextStatus,
  previewManagedCompression,
  queueManualContextCompression,
} from '../chat/context-compression.js';
import {
  listChatRagCitations,
  readChatRagDocument,
  readChatRagPage,
  resolveChatRagOriginal,
} from '../chat/rag.js';
import {
  createChatResearchSnapshot,
  getChatResearchAttachment,
  listChatResearchSources,
  listResearchOptions,
  readChatResearchDocument,
  readChatResearchPage,
  resolveChatResearchOriginal,
} from '../chat/research.js';
import { ChatWebError, listChatWebCitations, readChatWebCitation } from '../chat/web.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

class ChatRouteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ChatRouteError';
  }
}

export interface ChatRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly enabled: boolean;
  readonly researchEnabled?: boolean;
  readonly ragEnabled?: boolean;
  readonly webEnabled?: boolean;
  readonly artifactsEnabled?: boolean;
  readonly exportsEnabled?: boolean;
  readonly files?: DocumentFileStore;
}

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

const digestFile = async (path: string): Promise<Buffer> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
};

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key']?.toString();
  if (value === undefined) throw new ChatRouteError(400, 'idempotency_key_required');
  return value;
};

const requireChatUser = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatRoutesOptions,
  mutation: boolean,
): Promise<AuthenticatedPrincipal | null> => {
  const principal = await options.authenticate(request);
  if (principal === null) {
    sendProblem(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!options.enabled || principal.searchOnly || principal.sessionToken === null) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  const entitlement = await options.pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM noderag.chat_entitlement WHERE principal_id=$1`,
    [principal.principalId],
  );
  if (entitlement.rows[0]?.enabled !== true) {
    sendProblem(reply, 403, 'chat_access_disabled', request.id);
    return null;
  }
  if (
    mutation &&
    !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
  ) {
    sendProblem(reply, 403, 'csrf_rejected', request.id);
    return null;
  }
  return principal;
};

const ownedChat = async (
  database: SqlClient,
  chatId: string,
  principalId: number,
  lock = false,
) => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT conversation.id,conversation.name,conversation.state,
            conversation.configuration_revision_id,
            conversation.current_research_attachment_revision_id,conversation.created_at,
            conversation.updated_at,conversation.archived_at,
            revision.provider_kind,revision.model,revision.reasoning_effort,
            revision.context_mode,revision.allow_research,revision.allow_rag,
            revision.allow_internet,revision.revision_id AS configuration_revision,
            settings.storage_resolved_path
     FROM noderag.chat_conversation AS conversation
     JOIN noderag.chat_conversation_configuration_revision AS revision
       ON revision.id=conversation.configuration_revision_id
     JOIN noderag.chat_settings_revision AS settings ON settings.id=revision.settings_revision_id
     WHERE conversation.id=$1 AND conversation.owner_principal_id=$2${lock ? ' FOR UPDATE OF conversation' : ''}`,
    [chatId, principalId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatRouteError(404, 'chat_not_found');
  return row;
};

const serializeChat = (
  row: Record<string, unknown>,
  activeRun?: Record<string, unknown> | null,
) => ({
  id: row['id'],
  name: row['name'],
  archived: row['state'] === 'archived',
  provider: row['provider_kind'],
  model: row['model'],
  reasoningEffort: row['reasoning_effort'],
  contextMode: row['context_mode'],
  capabilities: {
    research: row['allow_research'],
    rag: row['allow_rag'],
    internet: row['allow_internet'],
  },
  configurationRevision: row['configuration_revision'],
  activeRun:
    activeRun === undefined || activeRun === null
      ? null
      : {
          id: activeRun['id'],
          status: activeRun['status'],
          attempts: activeRun['attempts'],
          maximumAttempts: activeRun['maximum_attempts'],
          safeErrorCode: activeRun['safe_error_code'],
          updatedAt:
            activeRun['updated_at'] instanceof Date
              ? activeRun['updated_at'].toISOString()
              : activeRun['updated_at'],
        },
  createdAt:
    row['created_at'] instanceof Date ? row['created_at'].toISOString() : row['created_at'],
  updatedAt:
    row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : row['updated_at'],
});

const selectModel = async (
  database: SqlClient,
  input: {
    readonly provider?: 'ollama_cloud' | 'openai_oauth' | undefined;
    readonly model?: string | undefined;
    readonly reasoningEffort?: string | undefined;
    readonly contextMode?: 'rolling' | 'managed' | undefined;
  },
) => {
  const configuration = await database.query<Record<string, unknown>>(
    `SELECT settings.id AS settings_id,settings.revision_id AS settings_revision,
            settings.default_connection_id,settings.default_model,
            settings.default_reasoning_effort,settings.default_context_mode,
            settings.default_allow_research,settings.default_allow_rag,
            settings.default_allow_internet,settings.storage_resolved_path,
            context.id AS context_id,context.revision_id AS context_revision,
            context.managed_enabled
     FROM noderag.chat_configuration_current AS current
     JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
     JOIN noderag.chat_context_settings_revision AS context ON context.id=current.context_revision_id
     WHERE current.singleton=true FOR SHARE`,
  );
  const config = configuration.rows[0];
  if (config === undefined) throw new ChatRouteError(503, 'chat_provider_unavailable');
  if (typeof config['storage_resolved_path'] !== 'string') {
    throw new ChatRouteError(503, 'chat_storage_unavailable');
  }
  const provider = input.provider;
  const model = input.model ?? config['default_model'];
  const query = await database.query<Record<string, unknown>>(
    `SELECT connection.id AS connection_id,connection.provider_kind,connection.enabled,
            profile.reasoning_efforts,profile.provider_metadata,
            COALESCE(profile.maximum_output_tokens,profile.administrator_output_tokens,
              known.maximum_output_tokens) AS maximum_output_tokens,
            capability.status AS generation_status
     FROM noderag.chat_provider_connection AS connection
     JOIN noderag.chat_model_profile AS profile ON profile.connection_id=connection.id
     JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id AND capability.capability='generation'
     LEFT JOIN LATERAL (
       SELECT maximum_output_tokens FROM noderag.chat_known_model_capacity
       WHERE provider_kind=connection.provider_kind AND model_pattern=profile.model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS known ON true
     WHERE connection.provider_kind=COALESCE($1::text,(
       SELECT provider_kind FROM noderag.chat_provider_connection
       WHERE id=$2
     )) AND profile.model=$3`,
    [provider ?? null, config['default_connection_id'], model],
  );
  const selected = query.rows[0];
  if (
    selected === undefined ||
    selected['enabled'] !== true ||
    selected['generation_status'] !== 'healthy' ||
    (selected['provider_metadata'] as Record<string, unknown>)['catalogStale'] === true
  ) {
    throw new ChatRouteError(503, 'chat_provider_unavailable');
  }
  const effort = input.reasoningEffort ?? String(config['default_reasoning_effort']);
  if (!(selected['reasoning_efforts'] as string[]).includes(effort)) {
    throw new ChatRouteError(422, 'chat_reasoning_effort_not_available');
  }
  const contextMode =
    input.contextMode ?? (config['default_context_mode'] as 'rolling' | 'managed');
  if (contextMode === 'managed' && config['managed_enabled'] !== true) {
    throw new ChatRouteError(422, 'chat_managed_context_not_available');
  }
  return {
    settingsId: databaseInteger(config['settings_id'], 'chat settings revision id'),
    contextId: databaseInteger(config['context_id'], 'chat context revision id'),
    connectionId: databaseInteger(selected['connection_id'], 'chat provider connection id'),
    provider: selected['provider_kind'] as 'ollama_cloud' | 'openai_oauth',
    model: String(model),
    reasoningEffort: effort,
    contextMode,
    maximumOutputTokens:
      selected['maximum_output_tokens'] === null ? null : Number(selected['maximum_output_tokens']),
  };
};

const quotaCheck = async (database: SqlClient, principalId: number): Promise<void> => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT settings.maximum_parallel_runs_per_user,settings.daily_run_quota,
            settings.daily_input_token_quota,settings.daily_output_token_quota,
            COALESCE(usage.run_count,0) AS run_count,
            COALESCE(usage.input_tokens,0) AS input_tokens,
            COALESCE(usage.output_tokens,0) AS output_tokens,
            (SELECT count(*) FROM noderag.chat_run AS active
             JOIN noderag.chat_conversation AS owned ON owned.id=active.conversation_id
             WHERE owned.owner_principal_id=$1
               AND active.status IN ('queued','running','cancelling')) AS active_runs
     FROM noderag.chat_configuration_current AS current
     JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
     LEFT JOIN noderag.chat_usage_daily AS usage
       ON usage.principal_id=$1 AND usage.usage_date=current_date
     WHERE current.singleton=true`,
    [principalId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatRouteError(503, 'chat_provider_unavailable');
  if (Number(row['active_runs']) >= Number(row['maximum_parallel_runs_per_user'])) {
    throw new ChatRouteError(429, 'chat_parallel_limit_reached');
  }
  if (
    row['daily_run_quota'] !== null &&
    Number(row['run_count']) >= Number(row['daily_run_quota'])
  ) {
    throw new ChatRouteError(429, 'chat_daily_run_quota_reached');
  }
  if (
    row['daily_input_token_quota'] !== null &&
    Number(row['input_tokens']) >= Number(row['daily_input_token_quota'])
  ) {
    throw new ChatRouteError(429, 'chat_daily_input_quota_reached');
  }
  if (
    row['daily_output_token_quota'] !== null &&
    Number(row['output_tokens']) >= Number(row['daily_output_token_quota'])
  ) {
    throw new ChatRouteError(429, 'chat_daily_output_quota_reached');
  }
};

const queueRun = async (
  database: SqlClient,
  input: {
    readonly conversationId: string;
    readonly configurationRevisionId: number;
    readonly provider: 'ollama_cloud' | 'openai_oauth';
    readonly model: string;
    readonly reasoningEffort: string;
    readonly contextMode: 'rolling' | 'managed';
    readonly requestMessageId: string;
    readonly responseMessageId: string;
    readonly retryOfRunId?: string;
    readonly researchAttachmentRevisionId?: string | null;
    readonly ragEnabled: boolean;
    readonly internetEnabled: boolean;
  },
) => {
  const runId = randomUUID();
  const capacity = await database.query<Record<string, unknown>>(
    `SELECT
       COALESCE(profile.runtime_context_tokens,profile.configured_context_tokens,
         profile.advertised_context_tokens,profile.administrator_context_tokens,
         known.context_tokens) AS context_capacity_tokens,
       CASE
         WHEN profile.runtime_context_tokens IS NOT NULL THEN 'provider_runtime'
         WHEN profile.configured_context_tokens IS NOT NULL THEN 'provider_configured'
         WHEN profile.advertised_context_tokens IS NOT NULL THEN 'provider_advertised'
         WHEN profile.administrator_context_tokens IS NOT NULL THEN 'administrator_override'
         WHEN known.context_tokens IS NOT NULL THEN 'known_model_table'
         ELSE 'unknown'
       END AS context_capacity_source
     FROM noderag.chat_conversation_configuration_revision AS revision
     JOIN noderag.chat_model_profile AS profile
       ON profile.connection_id=revision.provider_connection_id AND profile.model=revision.model
     LEFT JOIN LATERAL (
       SELECT context_tokens FROM noderag.chat_known_model_capacity
       WHERE provider_kind=revision.provider_kind AND model_pattern=revision.model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS known ON true
     WHERE revision.id=$1`,
    [input.configurationRevisionId],
  );
  const selectedCapacity = capacity.rows[0];
  if (selectedCapacity === undefined) throw new ChatRouteError(503, 'chat_provider_unavailable');
  await database.query(
    `INSERT INTO noderag.chat_run
       (id,conversation_id,request_message_id,response_message_id,retry_of_run_id,
         provider_kind,model,reasoning_effort,context_mode,configuration_revision_id,
         research_attachment_revision_id,context_capacity_tokens,context_capacity_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      runId,
      input.conversationId,
      input.requestMessageId,
      input.responseMessageId,
      input.retryOfRunId ?? null,
      input.provider,
      input.model,
      input.reasoningEffort,
      input.contextMode,
      input.configurationRevisionId,
      input.researchAttachmentRevisionId ?? null,
      selectedCapacity['context_capacity_tokens'],
      selectedCapacity['context_capacity_source'],
    ],
  );
  await appendChatEvent(database, {
    conversationId: input.conversationId,
    runId,
    type: 'run.queued',
    payload: {
      tools: [
        ...(input.researchAttachmentRevisionId === undefined ||
        input.researchAttachmentRevisionId === null
          ? []
          : ['research.context.v1']),
        ...(input.ragEnabled ? ['rag.search.v1', 'document.read_markdown.v1'] : []),
        ...(input.internetEnabled ? ['web.search.v1', 'web.fetch.v1'] : []),
      ],
      researchEnabled:
        input.researchAttachmentRevisionId !== undefined &&
        input.researchAttachmentRevisionId !== null,
      ragEnabled: input.ragEnabled,
      internetProvider: 'ollama_cloud',
      internetEnabled: input.internetEnabled,
    },
  });
  return runId;
};

const routeFailure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatRouteError)
    return sendProblem(reply, error.status, error.code, request.id);
  if (error instanceof IdempotencyConflictError)
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  if (error instanceof ChatWebError)
    return sendProblem(
      reply,
      error.code === 'chat_web_citation_not_found' ? 404 : 503,
      error.code,
      request.id,
    );
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.')
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  if (error instanceof Error && error.message === 'chat_cursor_invalid')
    return sendProblem(reply, 400, 'chat_cursor_invalid', request.id);
  if (error instanceof Error && error.message === 'chat_research_not_found')
    return sendProblem(reply, 404, 'chat_research_not_found', request.id);
  if (error instanceof Error && error.message === 'chat_research_access_revoked')
    return sendProblem(reply, 403, 'chat_research_access_revoked', request.id);
  if (error instanceof Error && error.message === 'chat_research_source_stale')
    return sendProblem(reply, 409, 'chat_research_source_stale', request.id);
  if (error instanceof Error && error.message === 'chat_research_source_not_found')
    return sendProblem(reply, 404, 'chat_research_source_not_found', request.id);
  if (error instanceof Error && error.message === 'chat_rag_access_revoked')
    return sendProblem(reply, 403, 'chat_rag_access_revoked', request.id);
  if (error instanceof Error && error.message === 'chat_rag_source_stale')
    return sendProblem(reply, 409, 'chat_rag_source_stale', request.id);
  if (error instanceof Error && error.message === 'chat_rag_citation_not_found')
    return sendProblem(reply, 404, 'chat_rag_citation_not_found', request.id);
  if (error instanceof Error && error.message === 'chat_managed_context_not_available')
    return sendProblem(reply, 422, error.message, request.id);
  if (
    error instanceof Error &&
    [
      'chat_context_nothing_to_compress',
      'chat_context_compression_busy',
      'chat_run_active',
    ].includes(error.message)
  ) {
    return sendProblem(reply, 409, error.message, request.id);
  }
  if (
    error instanceof Error &&
    ['chat_context_compression_not_found', 'chat_not_found'].includes(error.message)
  ) {
    return sendProblem(reply, 404, error.message, request.id);
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    return sendProblem(reply, 409, 'chat_run_active', request.id);
  }
  throw error;
};

const activeRun = async (database: SqlClient, chatId: string) => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT id,status,attempts,maximum_attempts,safe_error_code,updated_at
     FROM noderag.chat_run WHERE conversation_id=$1
       AND status IN ('queued','running','cancelling') ORDER BY queued_at DESC LIMIT 1`,
    [chatId],
  );
  return result.rows[0] ?? null;
};

const latestRun = async (database: SqlClient, chatId: string) => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT id,status,attempts,maximum_attempts,safe_error_code,updated_at
     FROM noderag.chat_run WHERE conversation_id=$1 ORDER BY queued_at DESC,id DESC LIMIT 1`,
    [chatId],
  );
  return result.rows[0] ?? null;
};

const createOptions = async (database: SqlClient) => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT connection.provider_kind,profile.model,profile.display_name,
            profile.reasoning_efforts,settings.default_model,
            defaults.provider_kind AS default_provider,settings.default_reasoning_effort,
            settings.default_context_mode,context.managed_enabled
     FROM noderag.chat_model_profile AS profile
     JOIN noderag.chat_provider_connection AS connection ON connection.id=profile.connection_id
     JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id AND capability.capability='generation'
     CROSS JOIN noderag.chat_configuration_current AS current
     JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
     JOIN noderag.chat_context_settings_revision AS context ON context.id=current.context_revision_id
     LEFT JOIN noderag.chat_provider_connection AS defaults
       ON defaults.id=settings.default_connection_id
     WHERE connection.enabled AND capability.status='healthy'
       AND COALESCE((profile.provider_metadata->>'catalogStale')::boolean,false)=false
     ORDER BY connection.provider_kind,lower(profile.display_name)`,
  );
  const first = result.rows[0];
  return {
    ready: result.rows.some(
      (row) =>
        row['provider_kind'] === row['default_provider'] && row['model'] === row['default_model'],
    ),
    default:
      first === undefined
        ? null
        : {
            provider: first['default_provider'],
            model: first['default_model'],
            reasoningEffort: first['default_reasoning_effort'],
            contextMode:
              first['default_context_mode'] === 'managed' && first['managed_enabled'] === true
                ? 'managed'
                : 'rolling',
          },
    contextModes: [
      'rolling',
      ...(result.rows.some(({ managed_enabled: enabled }) => enabled === true) ? ['managed'] : []),
    ],
    models: result.rows.map((row) => ({
      provider: row['provider_kind'],
      model: row['model'],
      displayName: row['display_name'],
      reasoningEfforts: row['reasoning_efforts'],
    })),
  };
};

const webAvailable = async (database: SqlClient): Promise<boolean> => {
  const result = await database.query<{ available: boolean }>(
    `SELECT connection.enabled AND connection.service_root='https://ollama.com'
            AND connection.credential_secret_id IS NOT NULL
            AND count(*)=2 AND bool_and(capability.status='healthy') AS available
     FROM noderag.chat_provider_connection AS connection
     JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id
      AND capability.capability IN ('web_search','web_fetch')
     WHERE connection.provider_kind='ollama_cloud'
     GROUP BY connection.id`,
  );
  return result.rows[0]?.available === true;
};

export const registerChatRoutes = (app: FastifyInstance, options: ChatRoutesOptions): void => {
  app.get('/v1/chats', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const parsed = listChatQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const cursor = decodeChatCursor(parsed.data.cursor);
      const result = await options.pool.query<Record<string, unknown>>(
        `SELECT conversation.id,conversation.name,conversation.state,conversation.created_at,
                conversation.updated_at,revision.provider_kind,revision.model,
                revision.reasoning_effort,revision.context_mode,revision.allow_research,
                revision.allow_rag,revision.allow_internet,
                revision.revision_id AS configuration_revision
         FROM noderag.chat_conversation AS conversation
         JOIN noderag.chat_conversation_configuration_revision AS revision
           ON revision.id=conversation.configuration_revision_id
         WHERE conversation.owner_principal_id=$1 AND conversation.state=$2
           AND ($3::timestamptz IS NULL OR (conversation.updated_at,conversation.id) < ($3,$4::uuid))
         ORDER BY conversation.updated_at DESC,conversation.id DESC LIMIT $5`,
        [
          principal.principalId,
          parsed.data.archived ? 'archived' : 'active',
          cursor?.updatedAt ?? null,
          cursor?.id ?? null,
          parsed.data.limit + 1,
        ],
      );
      const hasMore = result.rows.length > parsed.data.limit;
      const rows = result.rows.slice(0, parsed.data.limit);
      const last = rows.at(-1);
      return reply.send({
        contract: CHAT_CORE_CONTRACT_VERSION,
        internetProvider: 'ollama_cloud',
        providerToolsEnabled:
          options.researchEnabled === true ||
          options.ragEnabled === true ||
          options.webEnabled === true,
        researchEnabled: options.researchEnabled === true,
        ragEnabled: options.ragEnabled === true,
        internetEnabled: options.webEnabled === true && (await webAvailable(options.pool)),
        artifactsEnabled: options.artifactsEnabled === true,
        exportsEnabled: options.exportsEnabled === true,
        createOptions: {
          ...(await createOptions(options.pool)),
          researchCollections:
            options.researchEnabled === true
              ? await listResearchOptions(options.pool, principal.principalId)
              : [],
        },
        items: rows.map((row) => serializeChat(row)),
        nextCursor:
          hasMore && last !== undefined
            ? encodeChatCursor({
                updatedAt: (last['updated_at'] as Date).toISOString(),
                id: String(last['id']),
              })
            : null,
      });
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const parsed = createChatSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (parsed.data.researchIds.length > 0 && options.researchEnabled !== true) {
      return sendProblem(reply, 422, 'chat_research_not_available', request.id);
    }
    if (parsed.data.allowRag && options.ragEnabled !== true) {
      return sendProblem(reply, 422, 'chat_rag_not_available', request.id);
    }
    if (
      parsed.data.allowInternet &&
      (options.webEnabled !== true || !(await webAvailable(options.pool)))
    ) {
      return sendProblem(reply, 422, 'chat_web_not_available', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-create',
          key: idempotencyKey(request),
          request: JSON.stringify(parsed.data),
        },
        async (database) => {
          const selected = await selectModel(database, parsed.data);
          const revisionId = randomUUID();
          const researchSelected = parsed.data.researchIds.length > 0;
          const revision = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.chat_conversation_configuration_revision
               (revision_id,settings_revision_id,context_revision_id,provider_connection_id,
                provider_kind,model,reasoning_effort,context_mode,
                allow_research,allow_rag,allow_internet,tool_policy,maximum_output_tokens,created_by)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$11,$12,$13,
                jsonb_build_object('research',$11::boolean,'rag',$12::boolean,'internet',$13::boolean),$9,$10)
             RETURNING id`,
            [
              revisionId,
              selected.settingsId,
              selected.contextId,
              selected.connectionId,
              selected.provider,
              selected.model,
              selected.reasoningEffort,
              selected.contextMode,
              selected.maximumOutputTokens,
              principal.principalId,
              researchSelected,
              parsed.data.allowRag,
              parsed.data.allowInternet,
            ],
          );
          const chatId = randomUUID();
          await database.query(
            `INSERT INTO noderag.chat_conversation
               (id,owner_principal_id,name,configuration_revision_id)
             VALUES($1,$2,$3,$4)`,
            [
              chatId,
              principal.principalId,
              parsed.data.name,
              databaseInteger(revision.rows[0]?.id, 'chat configuration revision id'),
            ],
          );
          if (researchSelected) {
            await createChatResearchSnapshot(database, {
              conversationId: chatId,
              principalId: principal.principalId,
              researchIds: parsed.data.researchIds,
            });
          }
          const chat = await ownedChat(database, chatId, principal.principalId);
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.conversation.created',
            result: 'ok',
            requestId: request.id,
            detail: {
              chatId,
              provider: selected.provider,
              tools: [
                ...(researchSelected ? ['research.context.v1'] : []),
                ...(parsed.data.allowRag ? ['rag.search.v1', 'document.read_markdown.v1'] : []),
                ...(parsed.data.allowInternet ? ['web.search.v1', 'web.fetch.v1'] : []),
              ],
              ragEnabled: parsed.data.allowRag,
              internetEnabled: parsed.data.allowInternet,
              internetProvider: 'ollama_cloud',
            },
          });
          return { status: 201, headers: {}, body: serializeChat(chat) };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const parsed = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!parsed.success) return sendProblem(reply, 404, 'chat_not_found', request.id);
    try {
      const chat = await ownedChat(options.pool, parsed.data.chatId, principal.principalId);
      return reply.send(serializeChat(chat, await latestRun(options.pool, parsed.data.chatId)));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.patch('/v1/chats/:chatId', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = updateChatSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-update:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          await ownedChat(database, params.data.chatId, principal.principalId, true);
          await database.query(
            `UPDATE noderag.chat_conversation SET
               name=COALESCE($3,name),
               state=CASE WHEN $4::boolean IS NULL THEN state
                    WHEN $4 THEN 'archived' ELSE 'active' END,
               archived_at=CASE WHEN $4::boolean IS NULL THEN archived_at
                    WHEN $4 THEN now() ELSE NULL END,
               updated_at=now()
             WHERE id=$1 AND owner_principal_id=$2`,
            [
              params.data.chatId,
              principal.principalId,
              body.data.name ?? null,
              body.data.archived ?? null,
            ],
          );
          const chat = await ownedChat(database, params.data.chatId, principal.principalId);
          return { status: 200, headers: {}, body: serializeChat(chat) };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.delete('/v1/chats/:chatId', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = z
      .object({ confirmation: z.literal('PURGE') })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'chat_purge_confirmation_required', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-purge:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: 'PURGE',
        },
        async (database) => {
          await ownedChat(database, params.data.chatId, principal.principalId, true);
          if ((await activeRun(database, params.data.chatId)) !== null) {
            throw new ChatRouteError(409, 'chat_run_active');
          }
          await database.query(
            `DELETE FROM noderag.chat_conversation WHERE id=$1 AND owner_principal_id=$2`,
            [params.data.chatId, principal.principalId],
          );
          return { status: 200, headers: {}, body: { purged: true } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/messages', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const query = listChatMessagesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const chat = await ownedChat(options.pool, params.data.chatId, principal.principalId);
      const result = await options.pool.query<Record<string, unknown>>(
        `SELECT message.id,message.sequence,message.role,message.content,message.state,
                message.reasoning_summary,message.metadata,message.context_state,message.pinned,
                message.pinned_at,message.created_at,message.completed_at,
                segment.segment_number AS archive_segment_number,
                segment.storage_encoding AS archive_storage_encoding,
                segment.manifest_revision_id AS archive_manifest_revision_id
         FROM noderag.chat_message AS message
         LEFT JOIN noderag.chat_log_segment AS segment ON segment.id=message.archived_segment_id
         WHERE message.conversation_id=$1
           AND ($2::bigint IS NULL OR message.sequence<$2)
         ORDER BY message.sequence DESC LIMIT $3`,
        [params.data.chatId, query.data.before ?? null, query.data.limit + 1],
      );
      const hasMore = result.rows.length > query.data.limit;
      const rows = result.rows.slice(0, query.data.limit).reverse();
      const archivedSegments = [
        ...new Set(
          rows.flatMap((row) =>
            row['archive_segment_number'] === null ? [] : [Number(row['archive_segment_number'])],
          ),
        ),
      ];
      if (archivedSegments.length > 0) {
        if (typeof chat['storage_resolved_path'] !== 'string') {
          throw new Error('chat_storage_unavailable');
        }
        await Promise.all(
          archivedSegments.map((segmentNumber) =>
            readSealedChatEventLog(
              options.pool,
              chat['storage_resolved_path'] as string,
              params.data.chatId,
              segmentNumber,
            ),
          ),
        );
      }
      const citationRows =
        rows.length === 0
          ? { rows: [] as Record<string, unknown>[] }
          : await options.pool.query<Record<string, unknown>>(
              `SELECT message_id,snapshot_item_id,citation_label,attachment_revision_id
               FROM noderag.chat_citation WHERE message_id=ANY($1::uuid[])
               ORDER BY citation_label`,
              [rows.map((row) => row['id'])],
            );
      const toolCallRows =
        rows.length === 0
          ? { rows: [] as Record<string, unknown>[] }
          : await options.pool.query<Record<string, unknown>>(
              `SELECT run.response_message_id AS message_id,
                      tool.id,tool.ordinal,tool.call_id,tool.tool_name,tool.arguments,tool.status,
                      tool.result_bytes,tool.safe_error_code,tool.duration_ms,
                      tool.result_count,tool.result_summary,tool.started_at,tool.finished_at
               FROM noderag.chat_run AS run
               JOIN noderag.chat_tool_call AS tool ON tool.run_id=run.id
               WHERE run.conversation_id=$1
                 AND run.response_message_id=ANY($2::uuid[])
               ORDER BY run.response_message_id,tool.ordinal,tool.started_at,tool.id`,
              [params.data.chatId, rows.map((row) => row['id'])],
            );
      const activityEventRows =
        rows.length === 0
          ? { rows: [] as Record<string, unknown>[] }
          : await options.pool.query<Record<string, unknown>>(
              `SELECT run.response_message_id AS message_id,event.id,event.sequence,
                      event.event_type,event.payload,event.occurred_at
               FROM noderag.chat_run AS run
               JOIN noderag.chat_event AS event ON event.run_id=run.id
               WHERE run.conversation_id=$1
                 AND run.response_message_id=ANY($2::uuid[])
                 AND event.event_type IN ('response.reasoning_summary.delta','response.tool_call')
               ORDER BY run.response_message_id,event.sequence,event.id`,
              [params.data.chatId, rows.map((row) => row['id'])],
            );
      const citationRevisionIds = [
        ...new Set(citationRows.rows.map((citation) => String(citation['attachment_revision_id']))),
      ];
      const sources = (
        await Promise.all(
          options.researchEnabled === true
            ? citationRevisionIds.map((revisionId) =>
                listChatResearchSources(options.pool, {
                  conversationId: params.data.chatId,
                  principalId: principal.principalId,
                  revisionId,
                }),
              )
            : [],
        )
      ).flat();
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const ragCitations =
        options.ragEnabled === true
          ? await listChatRagCitations(options.pool, {
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              messageIds: rows.map((row) => String(row['id'])),
            })
          : [];
      const webCitations =
        options.webEnabled === true
          ? await listChatWebCitations(options.pool, {
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              messageIds: rows.map((row) => String(row['id'])),
            })
          : [];
      return reply.send({
        items: rows.map((row) => {
          const createdAt = row['created_at'];
          const completedAt = row['completed_at'];
          const researchCitations = citationRows.rows
            .filter(({ message_id: messageId }) => messageId === row['id'])
            .flatMap((citation) => {
              const source = sourceById.get(String(citation['snapshot_item_id']));
              return source === undefined ? [] : [{ sourceKind: 'research' as const, ...source }];
            });
          const messageRagCitations = ragCitations.filter(
            ({ messageId }) => messageId === row['id'],
          );
          const messageWebCitations = webCitations.filter(
            ({ messageId }) => messageId === row['id'],
          );
          const rawMessageToolCalls = toolCallRows.rows.filter(
            ({ message_id: messageId }) => messageId === row['id'],
          );
          const serializeToolCall = (tool: Record<string, unknown>) => ({
            id: tool['id'],
            ordinal: Number(tool['ordinal']),
            name: tool['tool_name'],
            arguments: tool['arguments'],
            status: tool['status'],
            resultBytes: tool['result_bytes'] === null ? null : Number(tool['result_bytes']),
            safeErrorCode: tool['safe_error_code'],
            durationMs: tool['duration_ms'] === null ? null : Number(tool['duration_ms']),
            resultCount: tool['result_count'] === null ? null : Number(tool['result_count']),
            resultSummary: tool['result_summary'],
            startedAt: tool['started_at'] instanceof Date ? tool['started_at'].toISOString() : null,
            finishedAt:
              tool['finished_at'] instanceof Date ? tool['finished_at'].toISOString() : null,
          });
          const messageToolCalls = rawMessageToolCalls.map(serializeToolCall);
          const representedToolIds = new Set<string>();
          const activities: Record<string, unknown>[] = [];
          for (const event of activityEventRows.rows.filter(
            ({ message_id: messageId }) => messageId === row['id'],
          )) {
            const payload =
              typeof event['payload'] === 'object' &&
              event['payload'] !== null &&
              !Array.isArray(event['payload'])
                ? (event['payload'] as Record<string, unknown>)
                : {};
            if (event['event_type'] === 'response.reasoning_summary.delta') {
              const text = typeof payload['text'] === 'string' ? payload['text'] : '';
              if (text.length === 0) continue;
              const previous = activities.at(-1);
              if (previous?.['type'] === 'thinking') {
                previous['text'] = `${String(previous['text'] ?? '')}${text}`;
              } else {
                activities.push({
                  id: `thinking-${String(event['id'])}`,
                  type: 'thinking',
                  sequence: Number(event['sequence']),
                  text,
                  occurredAt:
                    event['occurred_at'] instanceof Date
                      ? event['occurred_at'].toISOString()
                      : null,
                });
              }
              continue;
            }
            const callId = typeof payload['callId'] === 'string' ? payload['callId'] : null;
            const recordedTool = rawMessageToolCalls.find((tool) => tool['call_id'] === callId);
            if (recordedTool !== undefined) representedToolIds.add(String(recordedTool['id']));
            activities.push({
              id:
                recordedTool === undefined
                  ? `tool-event-${String(event['id'])}`
                  : `tool-${String(recordedTool['id'])}`,
              type: 'tool',
              sequence: Number(event['sequence']),
              toolCall:
                recordedTool === undefined
                  ? {
                      id: `event-${String(event['id'])}`,
                      ordinal: Number(event['sequence']),
                      name: payload['name'],
                      arguments:
                        typeof payload['arguments'] === 'object' &&
                        payload['arguments'] !== null &&
                        !Array.isArray(payload['arguments'])
                          ? payload['arguments']
                          : {},
                      status: 'requested',
                      resultBytes: null,
                      safeErrorCode: null,
                      durationMs: null,
                      resultCount: null,
                      resultSummary: null,
                      startedAt: null,
                      finishedAt: null,
                    }
                  : serializeToolCall(recordedTool),
            });
          }
          if (
            typeof row['reasoning_summary'] === 'string' &&
            row['reasoning_summary'].length > 0 &&
            !activities.some(({ type }) => type === 'thinking')
          ) {
            activities.unshift({
              id: `thinking-${String(row['id'])}`,
              type: 'thinking',
              sequence: -1,
              text: row['reasoning_summary'],
              occurredAt: null,
            });
          }
          const fallbackToolSequence =
            activities.reduce(
              (highest, activity) => Math.max(highest, Number(activity['sequence'] ?? -1)),
              -1,
            ) + 1;
          for (const [index, tool] of rawMessageToolCalls.entries()) {
            if (representedToolIds.has(String(tool['id']))) continue;
            activities.push({
              id: `tool-${String(tool['id'])}`,
              type: 'tool',
              sequence: fallbackToolSequence + index,
              toolCall: serializeToolCall(tool),
            });
          }
          return {
            id: row['id'],
            sequence: Number(row['sequence']),
            role: row['role'],
            content: row['content'],
            state: row['state'],
            reasoning_summary: row['reasoning_summary'],
            metadata: row['metadata'],
            contextState: row['context_state'],
            pinned: row['pinned'] === true,
            pinnedAt: row['pinned_at'] instanceof Date ? row['pinned_at'].toISOString() : null,
            archive:
              row['archive_segment_number'] === null
                ? null
                : {
                    segmentNumber: Number(row['archive_segment_number']),
                    encoding: row['archive_storage_encoding'],
                    manifestRevisionId: row['archive_manifest_revision_id'],
                    integrity: 'verified',
                  },
            createdAt: (createdAt as Date).toISOString(),
            completedAt: completedAt instanceof Date ? completedAt.toISOString() : null,
            toolCalls: messageToolCalls,
            activities,
            citations: [...researchCitations, ...messageRagCitations, ...messageWebCitations].sort(
              (left, right) => left.citationLabel.localeCompare(right.citationLabel),
            ),
          };
        }),
        nextBefore: hasMore ? Number(rows[0]?.['sequence']) : null,
        historySources: archivedSegments.length > 0 ? ['database', 'sealed_archive'] : ['database'],
      });
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/messages/:messageId/pin', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, messageId: z.string().uuid() })
      .strict()
      .safeParse(request.params);
    const body = z.object({ pinned: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-message-pin:${params.data.messageId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          const chat = await ownedChat(database, params.data.chatId, principal.principalId, true);
          const selected = await database.query<{ content: string; state: string }>(
            `SELECT content,state FROM noderag.chat_message
             WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
            [params.data.messageId, params.data.chatId],
          );
          const message = selected.rows[0];
          if (message === undefined) throw new ChatRouteError(404, 'chat_message_not_found');
          if (message.state !== 'committed') {
            throw new ChatRouteError(409, 'chat_message_not_committed');
          }
          if (body.data.pinned) {
            const settings = await database.query<{ l1_pin_limit_tokens: number }>(
              `SELECT context.l1_pin_limit_tokens
               FROM noderag.chat_conversation_configuration_revision AS revision
               JOIN noderag.chat_context_settings_revision AS context
                 ON context.id=revision.context_revision_id
               WHERE revision.id=$1`,
              [chat['configuration_revision_id']],
            );
            const pinned = await database.query<{ content: string }>(
              `SELECT content FROM noderag.chat_message
               WHERE conversation_id=$1 AND pinned AND id<>$2`,
              [params.data.chatId, params.data.messageId],
            );
            const tokens = [message, ...pinned.rows].reduce(
              (total, row) => total + estimateTextTokens(row.content),
              0,
            );
            if (tokens > Number(settings.rows[0]?.l1_pin_limit_tokens ?? 0)) {
              throw new ChatRouteError(422, 'chat_context_pin_limit_exceeded');
            }
          }
          await database.query(
            `UPDATE noderag.chat_message
             SET pinned=$3::boolean,pinned_at=CASE WHEN $3::boolean THEN now() ELSE NULL END,
                 pinned_by=CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END
             WHERE id=$1 AND conversation_id=$2`,
            [params.data.messageId, params.data.chatId, body.data.pinned, principal.principalId],
          );
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: body.data.pinned ? 'chat.message.pin' : 'chat.message.unpin',
            result: 'ok',
            requestId: request.id,
            detail: { chatId: params.data.chatId, messageId: params.data.messageId },
          });
          return {
            status: 200,
            headers: {},
            body: { id: params.data.messageId, pinned: body.data.pinned },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/context', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).strict().safeParse(request.params);
    if (!params.success) return sendProblem(reply, 404, 'chat_not_found', request.id);
    try {
      const chat = await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send({
        mode: chat['context_mode'],
        ...(await getManagedContextStatus(options.pool, params.data.chatId)),
      });
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/context/compression-preview', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).strict().safeParse(request.params);
    if (!params.success) return sendProblem(reply, 404, 'chat_not_found', request.id);
    try {
      const chat = await ownedChat(options.pool, params.data.chatId, principal.principalId);
      if (chat['context_mode'] !== 'managed') {
        throw new ChatRouteError(422, 'chat_managed_context_not_available');
      }
      return reply.send(await previewManagedCompression(options.pool, params.data.chatId));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/context/compressions', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).strict().safeParse(request.params);
    const body = z
      .object({ confirmation: z.literal('COMPRESS CONTEXT') })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'chat_context_compression_confirmation_required', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-context-compress:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: body.data.confirmation,
        },
        async (database) => {
          const queued = await queueManualContextCompression(database, {
            conversationId: params.data.chatId,
            principalId: principal.principalId,
          });
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.context.compress',
            result: 'ok',
            requestId: request.id,
            detail: { chatId: params.data.chatId, jobId: queued.id },
          });
          return { status: 202, headers: {}, body: queued };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/context/compressions/:jobId/cancel', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, jobId: z.string().uuid() })
      .strict()
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-context-cancel:${params.data.jobId}`,
          key: idempotencyKey(request),
          request: '{}',
        },
        async (database) => ({
          status: 200,
          headers: {},
          body: await cancelContextCompression(database, {
            conversationId: params.data.chatId,
            jobId: params.data.jobId,
            principalId: principal.principalId,
          }),
        }),
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/research', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!params.success) return sendProblem(reply, 404, 'chat_not_found', request.id);
    if (options.researchEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send({
        attachment: await getChatResearchAttachment(options.pool, params.data.chatId),
        sources: (
          await listChatResearchSources(options.pool, {
            conversationId: params.data.chatId,
            principalId: principal.principalId,
          })
        ).map((source) => ({ sourceKind: 'research', ...source })),
      });
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/research/refresh', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = z
      .object({ confirmation: z.literal('REFRESH RESEARCH') })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'chat_research_refresh_confirmation_required', request.id);
    if (options.researchEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-research-refresh:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: 'REFRESH RESEARCH',
        },
        async (database) => {
          const chat = await ownedChat(database, params.data.chatId, principal.principalId, true);
          if (chat['state'] !== 'active') throw new ChatRouteError(409, 'chat_archived');
          if ((await activeRun(database, params.data.chatId)) !== null)
            throw new ChatRouteError(409, 'chat_run_active');
          const previous = chat['current_research_attachment_revision_id'];
          if (previous === null) throw new ChatRouteError(409, 'chat_research_not_attached');
          const collections = await database.query<{ source_research_id: unknown }>(
            `SELECT source_research_id FROM noderag.chat_research_attachment_collection
             WHERE attachment_revision_id=$1 ORDER BY ordinal`,
            [previous],
          );
          if (collections.rows.some(({ source_research_id: id }) => id === null)) {
            throw new ChatRouteError(409, 'chat_research_source_stale');
          }
          const revisionId = await createChatResearchSnapshot(database, {
            conversationId: params.data.chatId,
            principalId: principal.principalId,
            researchIds: collections.rows.map(({ source_research_id: id }) => Number(id)),
            previousRevisionId: String(previous),
          });
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.research.refresh',
            result: 'ok',
            requestId: request.id,
            detail: { chatId: params.data.chatId, revisionId },
          });
          return {
            status: 201,
            headers: {},
            body: {
              attachment: await getChatResearchAttachment(database, params.data.chatId),
            },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/research/sources/:sourceId/page', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, sourceId: z.string().uuid() })
      .safeParse(request.params);
    const query = z
      .object({ revisionId: z.string().uuid().optional() })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.researchEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send(
        await readChatResearchPage(options.pool, options.files, {
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          snapshotItemId: params.data.sourceId,
          ...(query.data.revisionId === undefined ? {} : { revisionId: query.data.revisionId }),
        }),
      );
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/research/sources/:sourceId/document', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, sourceId: z.string().uuid() })
      .safeParse(request.params);
    const query = z
      .object({
        offset: z.coerce.number().int().nonnegative().default(0),
        revisionId: z.string().uuid().optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.researchEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send(
        await readChatResearchDocument(options.pool, options.files, {
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          snapshotItemId: params.data.sourceId,
          offset: query.data.offset,
          ...(query.data.revisionId === undefined ? {} : { revisionId: query.data.revisionId }),
        }),
      );
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/research/sources/:sourceId/original', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, sourceId: z.string().uuid() })
      .safeParse(request.params);
    const query = z
      .object({ revisionId: z.string().uuid().optional() })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.researchEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      const resolved = await resolveChatResearchOriginal(options.pool, options.files, {
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        snapshotItemId: params.data.sourceId,
        ...(query.data.revisionId === undefined ? {} : { revisionId: query.data.revisionId }),
      });
      let digest: Buffer;
      try {
        digest = await digestFile(resolved.path);
      } catch {
        throw new Error('chat_research_source_stale');
      }
      if (digest.toString('hex') !== resolved.source.originalSha256) {
        throw new Error('chat_research_source_stale');
      }
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(resolved.source.documentName)}`,
      );
      return reply
        .type(
          resolved.source.documentFormat === 'pdf' ? 'application/pdf' : 'application/octet-stream',
        )
        .send(createReadStream(resolved.path));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/citations/:citationId/page', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, citationId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.ragEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send(
        await readChatRagPage(options.pool, options.files, {
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          citationId: params.data.citationId,
        }),
      );
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/web-citations/:citationId', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, citationId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.webEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send(
        await readChatWebCitation(options.pool, {
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          citationId: params.data.citationId,
        }),
      );
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/citations/:citationId/document', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, citationId: z.string().uuid() })
      .safeParse(request.params);
    const query = z
      .object({ offset: z.coerce.number().int().nonnegative().default(0) })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.ragEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      return reply.send(
        await readChatRagDocument(options.pool, options.files, {
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          citationId: params.data.citationId,
          offset: query.data.offset,
        }),
      );
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/citations/:citationId/original', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, citationId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (options.ragEnabled !== true || options.files === undefined)
      return sendProblem(reply, 404, 'not_found', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      const resolved = await resolveChatRagOriginal(options.pool, options.files, {
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        citationId: params.data.citationId,
      });
      let digest: Buffer;
      try {
        digest = await digestFile(resolved.path);
      } catch {
        throw new Error('chat_rag_source_stale');
      }
      if (digest.toString('hex') !== resolved.citation.originalSha256) {
        throw new Error('chat_rag_source_stale');
      }
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(resolved.citation.documentName)}`,
      );
      return reply
        .type(
          resolved.citation.documentFormat === 'pdf'
            ? 'application/pdf'
            : 'application/octet-stream',
        )
        .send(createReadStream(resolved.path));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/messages', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = sendChatMessageSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-send:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: body.data.content,
        },
        async (database) => {
          const chat = await ownedChat(database, params.data.chatId, principal.principalId, true);
          if (chat['state'] !== 'active') throw new ChatRouteError(409, 'chat_archived');
          if ((await activeRun(database, params.data.chatId)) !== null) {
            throw new ChatRouteError(409, 'chat_run_active');
          }
          const compression = await database.query(
            `SELECT id FROM noderag.chat_context_compression_job
             WHERE conversation_id=$1 AND state IN ('queued','running','cancelling')`,
            [params.data.chatId],
          );
          if (compression.rows[0] !== undefined) {
            throw new ChatRouteError(409, 'chat_context_compression_busy');
          }
          await quotaCheck(database, principal.principalId);
          const next = await database.query<{ sequence: unknown }>(
            `SELECT COALESCE(max(sequence)+1,0) AS sequence
             FROM noderag.chat_message WHERE conversation_id=$1`,
            [params.data.chatId],
          );
          const sequence = databaseInteger(next.rows[0]?.sequence, 'chat message sequence');
          const requestMessageId = randomUUID();
          const responseMessageId = randomUUID();
          await database.query(
            `INSERT INTO noderag.chat_message
               (id,conversation_id,sequence,role,content,state,completed_at)
             VALUES($1,$3,$4,'user',$5,'committed',now()),
                   ($2,$3,$6,'assistant','','streaming',NULL)`,
            [
              requestMessageId,
              responseMessageId,
              params.data.chatId,
              sequence,
              body.data.content,
              sequence + 1,
            ],
          );
          const runId = await queueRun(database, {
            conversationId: params.data.chatId,
            configurationRevisionId: databaseInteger(
              chat['configuration_revision_id'],
              'chat configuration revision id',
            ),
            provider: chat['provider_kind'] as 'ollama_cloud' | 'openai_oauth',
            model: String(chat['model']),
            reasoningEffort: String(chat['reasoning_effort']),
            contextMode: chat['context_mode'] as 'rolling' | 'managed',
            requestMessageId,
            responseMessageId,
            researchAttachmentRevisionId:
              chat['current_research_attachment_revision_id'] === null
                ? null
                : String(chat['current_research_attachment_revision_id']),
            ragEnabled: chat['allow_rag'] === true,
            internetEnabled: chat['allow_internet'] === true,
          });
          await database.query(
            `UPDATE noderag.chat_conversation SET updated_at=now() WHERE id=$1`,
            [params.data.chatId],
          );
          return {
            status: 202,
            headers: {},
            body: { runId, requestMessageId, responseMessageId, status: 'queued' },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/runs/:runId/stop', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, runId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 404, 'chat_run_not_found', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-stop:${params.data.runId}`,
          key: idempotencyKey(request),
          request: '{}',
        },
        async (database) => {
          await ownedChat(database, params.data.chatId, principal.principalId, true);
          const stopped = await database.query<Record<string, unknown>>(
            `UPDATE noderag.chat_run SET
               cancel_requested_at=COALESCE(cancel_requested_at,now()),
               status=CASE WHEN status='running' THEN 'cancelling'
                      WHEN status='queued' THEN 'cancelled' ELSE status END,
               finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
               updated_at=now(),status_version=status_version+1
             WHERE id=$1 AND conversation_id=$2
               AND status IN ('queued','running','cancelling')
             RETURNING id,status,response_message_id`,
            [params.data.runId, params.data.chatId],
          );
          const run = stopped.rows[0];
          if (run === undefined) throw new ChatRouteError(404, 'chat_run_not_found');
          if (run['status'] === 'cancelled') {
            await database.query(
              `UPDATE noderag.chat_message SET state='cancelled',completed_at=now() WHERE id=$1`,
              [run['response_message_id']],
            );
          }
          await appendChatEvent(database, {
            conversationId: params.data.chatId,
            runId: params.data.runId,
            type: 'run.cancel_requested',
          });
          return {
            status: 202,
            headers: {},
            body: { runId: params.data.runId, status: run['status'] },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/runs/:runId/retry', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, runId: z.string().uuid() })
      .safeParse(request.params);
    const body = retryChatRunSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-retry:${params.data.runId}`,
          key: idempotencyKey(request),
          request: '{}',
        },
        async (database) => {
          const chat = await ownedChat(database, params.data.chatId, principal.principalId, true);
          if ((await activeRun(database, params.data.chatId)) !== null)
            throw new ChatRouteError(409, 'chat_run_active');
          await quotaCheck(database, principal.principalId);
          const prior = await database.query<Record<string, unknown>>(
            `SELECT request_message_id,status,research_attachment_revision_id FROM noderag.chat_run
             WHERE id=$1 AND conversation_id=$2`,
            [params.data.runId, params.data.chatId],
          );
          const old = prior.rows[0];
          if (old === undefined || !['failed', 'cancelled'].includes(String(old['status']))) {
            throw new ChatRouteError(409, 'chat_run_not_retryable');
          }
          const next = await database.query<{ sequence: unknown }>(
            `SELECT COALESCE(max(sequence)+1,0) AS sequence FROM noderag.chat_message
             WHERE conversation_id=$1`,
            [params.data.chatId],
          );
          const responseMessageId = randomUUID();
          await database.query(
            `INSERT INTO noderag.chat_message
               (id,conversation_id,sequence,role,content,state)
             VALUES($1,$2,$3,'assistant','','streaming')`,
            [
              responseMessageId,
              params.data.chatId,
              databaseInteger(next.rows[0]?.sequence, 'chat message sequence'),
            ],
          );
          const runId = await queueRun(database, {
            conversationId: params.data.chatId,
            configurationRevisionId: databaseInteger(
              chat['configuration_revision_id'],
              'chat configuration revision id',
            ),
            provider: chat['provider_kind'] as 'ollama_cloud' | 'openai_oauth',
            model: String(chat['model']),
            reasoningEffort: String(chat['reasoning_effort']),
            contextMode: chat['context_mode'] as 'rolling' | 'managed',
            requestMessageId: String(old['request_message_id']),
            responseMessageId,
            retryOfRunId: params.data.runId,
            researchAttachmentRevisionId:
              old['research_attachment_revision_id'] === null
                ? null
                : String(old['research_attachment_revision_id']),
            ragEnabled: chat['allow_rag'] === true,
            internetEnabled: chat['allow_internet'] === true,
          });
          return { status: 202, headers: {}, body: { runId, responseMessageId, status: 'queued' } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/events', async (request, reply) => {
    const principal = await requireChatUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const query = listChatEventsQuerySchema
      .extend({
        once: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      })
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      await ownedChat(options.pool, params.data.chatId, principal.principalId);
      const header = Number(request.headers['last-event-id'] ?? 0);
      let after = Math.max(query.data.after, Number.isSafeInteger(header) ? header : 0);
      const earliest = await options.pool.query<{ id: unknown }>(
        `SELECT id FROM noderag.chat_event WHERE conversation_id=$1 ORDER BY id LIMIT 1`,
        [params.data.chatId],
      );
      if (after > 0 && earliest.rows[0] !== undefined && after < Number(earliest.rows[0].id) - 1) {
        throw new ChatRouteError(409, 'chat_event_replay_expired');
      }
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      const writeAvailable = async (): Promise<number> => {
        const events = await options.pool.query<Record<string, unknown>>(
          `SELECT id,event_type,payload,occurred_at FROM noderag.chat_event
           WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT 1000`,
          [params.data.chatId, after],
        );
        for (const event of events.rows) {
          after = Number(event['id']);
          reply.raw.write(
            `id: ${String(after)}\nevent: ${String(event['event_type'])}\ndata: ${JSON.stringify({
              id: after,
              type: event['event_type'],
              payload: event['payload'],
              occurredAt: (event['occurred_at'] as Date).toISOString(),
            })}\n\n`,
          );
        }
        return events.rows.length;
      };
      await writeAvailable();
      if (query.data.once) {
        reply.raw.end();
        return;
      }
      const keepAlive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
      keepAlive.unref();
      const poll = setInterval(() => void writeAvailable().catch(() => reply.raw.end()), 500);
      poll.unref();
      request.raw.once('close', () => {
        clearInterval(keepAlive);
        clearInterval(poll);
      });
    } catch (error) {
      if (reply.sent) return;
      return routeFailure(reply, request, error);
    }
  });

  app.put('/v1/admin/chat/entitlements/:principalId', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!options.enabled || principal.searchOnly)
      return reply.code(404).send(problem(404, 'not_found', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    if (
      !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
    ) {
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    }
    const params = z
      .object({ principalId: z.coerce.number().int().positive() })
      .safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-entitlement:${String(params.data.principalId)}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          const target = await database.query(`SELECT id FROM noderag.principal WHERE id=$1`, [
            params.data.principalId,
          ]);
          if (target.rows[0] === undefined) throw new ChatRouteError(404, 'principal_not_found');
          await database.query(
            `INSERT INTO noderag.chat_entitlement(principal_id,enabled,updated_at,updated_by)
             VALUES($1,$2,now(),$3)
             ON CONFLICT (principal_id) DO UPDATE SET
               enabled=EXCLUDED.enabled,updated_at=now(),updated_by=EXCLUDED.updated_by`,
            [params.data.principalId, body.data.enabled, principal.principalId],
          );
          return {
            status: 200,
            headers: {},
            body: { principalId: params.data.principalId, enabled: body.data.enabled },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });
};
