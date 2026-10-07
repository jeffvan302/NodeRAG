import { createHash, randomUUID } from 'node:crypto';
import type { Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import type {
  ChatProvider,
  ChatProviderEvent,
  ChatProviderKind,
  ChatToolExecutionRequest,
  ChatToolExecutionResult,
} from './contract.js';
import { hashChatEvent, safeChatReasoningSummary } from './core.js';
import { synchronizeChatEventLog } from './log-store.js';
import { CHAT_RAG_TOOL_DEFINITIONS, executeChatRagTool } from './rag.js';
import {
  CHAT_RESEARCH_TOOL_DEFINITIONS,
  executeChatResearchTool,
  prepareChatResearchContext,
} from './research.js';
import { CHAT_WEB_TOOL_DEFINITIONS, type ChatWebExecutor } from './web.js';
import { CHAT_ARTIFACT_TOOL_DEFINITIONS, type ChatArtifactExecutor } from './artifacts.js';
import {
  admitToolResultToContext,
  createContextBudget,
  prepareRollingContext,
  type ContextMessage,
} from './context-runtime.js';
import { compressManagedContext, loadManagedSnapshotMessages } from './context-compression.js';
import { writePortableChatManifest } from './reconciliation.js';

const DEFAULT_LEASE_MS = 45_000;

interface ClaimedChatRun {
  readonly id: string;
  readonly conversationId: string;
  readonly ownerPrincipalId: number;
  readonly requestMessageId: string;
  readonly responseMessageId: string;
  readonly provider: ChatProviderKind;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly contextMode: 'rolling' | 'managed';
  readonly rollingTurnLimit: number;
  readonly managedTriggerPercent: number;
  readonly managedKeepRecentTurns: number;
  readonly contextCapacityTokens: number | null;
  readonly inputReserveTokens: number;
  readonly outputReserveTokens: number;
  readonly pinnedInstructionReserveTokens: number;
  readonly toolResultReserveTokens: number;
  readonly maximumOutputTokens: number | null;
  readonly maximumToolCalls: number;
  readonly timeoutMs: number;
  readonly chatRoot: string;
  readonly researchAttachmentRevisionId: string | null;
  readonly ragEnabled: boolean;
  readonly internetEnabled: boolean;
}

export interface ChatRunProcessorOptions {
  readonly pool: Pool;
  readonly leaseOwner: string;
  readonly resolveProvider: (kind: ChatProviderKind) => Promise<ChatProvider>;
  readonly leaseMilliseconds?: number;
  readonly runTimeoutCeilingMilliseconds?: number;
  readonly researchEnabled?: boolean;
  readonly ragEnabled?: boolean;
  readonly webEnabled?: boolean;
  readonly webExecutor?: ChatWebExecutor;
  readonly artifactEnabled?: boolean;
  readonly artifactExecutor?: ChatArtifactExecutor;
  readonly embedder?: Embedder;
  readonly files?: DocumentFileStore;
}

interface MessageRow extends Omit<ContextMessage, 'sequence'> {
  readonly sequence: unknown;
}

const claimChatRun = async (
  pool: Pool,
  leaseOwner: string,
  leaseMilliseconds: number,
): Promise<ClaimedChatRun | null> =>
  withTransaction(pool, async (database) => {
    const result = await database.query<Record<string, unknown>>(
      `WITH candidate AS (
         SELECT run.id
         FROM noderag.chat_run AS run
         WHERE (
           run.status='queued' OR
           (run.status IN ('running','cancelling') AND run.leased_until <= now())
         )
           AND run.attempts < run.maximum_attempts
         ORDER BY run.queued_at,run.id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE noderag.chat_run AS run
       SET status=CASE WHEN run.cancel_requested_at IS NULL THEN 'running' ELSE 'cancelling' END,
           lease_owner=$1,leased_until=now()+($2::bigint*interval '1 millisecond'),
           heartbeat_at=now(),lease_epoch=run.lease_epoch+1,attempts=run.attempts+1,
           started_at=COALESCE(run.started_at,now()),updated_at=now(),status_version=status_version+1
       FROM candidate
       WHERE run.id=candidate.id
       RETURNING run.id,run.conversation_id,run.request_message_id,run.response_message_id,
                  run.provider_kind,run.model,run.reasoning_effort,run.lease_epoch,run.attempts,
                  run.maximum_attempts,run.configuration_revision_id,
                  run.research_attachment_revision_id,run.context_mode,
                  run.context_capacity_tokens,run.context_capacity_source`,
      [leaseOwner, leaseMilliseconds],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const configuration = await database.query<Record<string, unknown>>(
      `SELECT conversation.owner_principal_id,context.rolling_turn_limit,
              context.input_reserve_tokens,context.output_reserve_tokens,
              context.pinned_instruction_reserve_tokens,context.tool_result_reserve_tokens,
              context.managed_trigger_percent,context.managed_keep_recent_turns,
              settings.run_timeout_ms,settings.storage_resolved_path,
              revision.maximum_output_tokens,revision.allow_rag,revision.allow_internet,
              settings.maximum_tool_calls
       FROM noderag.chat_conversation AS conversation
       JOIN noderag.chat_conversation_configuration_revision AS revision
         ON revision.id=$2
       JOIN noderag.chat_context_settings_revision AS context
         ON context.id=revision.context_revision_id
       JOIN noderag.chat_settings_revision AS settings
         ON settings.id=revision.settings_revision_id
       WHERE conversation.id=$1 FOR SHARE`,
      [row['conversation_id'], row['configuration_revision_id']],
    );
    const config = configuration.rows[0];
    if (config === undefined || typeof config['storage_resolved_path'] !== 'string') {
      throw new Error('chat_storage_unavailable');
    }
    if (Number(row['attempts']) > 1) {
      await database.query(
        `UPDATE noderag.chat_message SET content='',reasoning_summary=NULL,state='streaming',
                completed_at=NULL,metadata=metadata || jsonb_build_object('recoveredAt',now())
         WHERE id=$1`,
        [row['response_message_id']],
      );
      await appendChatEvent(database, {
        conversationId: String(row['conversation_id']),
        runId: String(row['id']),
        type: 'run.recovered',
        payload: { attempt: Number(row['attempts']) },
      });
    }
    return {
      id: String(row['id']),
      conversationId: String(row['conversation_id']),
      ownerPrincipalId: databaseInteger(config['owner_principal_id'], 'chat owner principal id'),
      requestMessageId: String(row['request_message_id']),
      responseMessageId: String(row['response_message_id']),
      provider: row['provider_kind'] as ChatProviderKind,
      model: String(row['model']),
      reasoningEffort: String(row['reasoning_effort']),
      leaseOwner,
      leaseEpoch: databaseInteger(row['lease_epoch'], 'chat run lease epoch'),
      attempts: Number(row['attempts']),
      maximumAttempts: Number(row['maximum_attempts']),
      contextMode: row['context_mode'] as 'rolling' | 'managed',
      rollingTurnLimit: Number(config['rolling_turn_limit']),
      managedTriggerPercent: Number(config['managed_trigger_percent']),
      managedKeepRecentTurns: Number(config['managed_keep_recent_turns']),
      contextCapacityTokens:
        row['context_capacity_tokens'] === null ? null : Number(row['context_capacity_tokens']),
      inputReserveTokens: Number(config['input_reserve_tokens']),
      outputReserveTokens: Number(config['output_reserve_tokens']),
      pinnedInstructionReserveTokens: Number(config['pinned_instruction_reserve_tokens']),
      toolResultReserveTokens: Number(config['tool_result_reserve_tokens']),
      maximumOutputTokens:
        config['maximum_output_tokens'] === null ? null : Number(config['maximum_output_tokens']),
      maximumToolCalls: Number(config['maximum_tool_calls']),
      timeoutMs: Number(config['run_timeout_ms']),
      chatRoot: config['storage_resolved_path'],
      researchAttachmentRevisionId:
        row['research_attachment_revision_id'] === null
          ? null
          : String(row['research_attachment_revision_id']),
      ragEnabled: config['allow_rag'] === true,
      internetEnabled: config['allow_internet'] === true,
    };
  });

export interface AppendChatEventInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly type:
    | 'run.queued'
    | 'response.started'
    | 'response.output_text.delta'
    | 'response.reasoning_summary.delta'
    | 'response.tool_call'
    | 'response.usage'
    | 'response.completed'
    | 'response.failed'
    | 'run.heartbeat'
    | 'run.cancel_requested'
    | 'run.recovered';
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

export const appendChatEvent = async (
  database: SqlClient,
  input: AppendChatEventInput,
): Promise<number> => {
  await database.query(`SELECT id FROM noderag.chat_run WHERE id=$1 FOR UPDATE`, [input.runId]);
  const sequenceResult = await database.query<{ sequence: number }>(
    `SELECT COALESCE(max(sequence)+1,0)::integer AS sequence
     FROM noderag.chat_event WHERE run_id=$1`,
    [input.runId],
  );
  const previousResult = await database.query<{ event_sha256: Buffer }>(
    `SELECT event_sha256 FROM noderag.chat_event
     WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1`,
    [input.conversationId],
  );
  const sequence = sequenceResult.rows[0]?.sequence ?? 0;
  const previous = previousResult.rows[0]?.event_sha256 ?? null;
  const eventId = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const payload = input.payload ?? {};
  const digest = hashChatEvent({
    eventId,
    conversationId: input.conversationId,
    runId: input.runId,
    sequence,
    type: input.type,
    payload,
    occurredAt: occurredAt.toISOString(),
    previousSha256: previous?.toString('hex') ?? null,
  });
  const inserted = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.chat_event
       (event_id,conversation_id,run_id,sequence,event_type,payload,
        previous_sha256,event_sha256,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      eventId,
      input.conversationId,
      input.runId,
      sequence,
      input.type,
      payload,
      previous,
      digest,
      occurredAt,
    ],
  );
  return databaseInteger(inserted.rows[0]?.id, 'chat event id');
};

const loadMessages = async (pool: Pool, run: ClaimedChatRun, researchEnabled: boolean) => {
  const request = await pool.query<{ sequence: unknown }>(
    `SELECT sequence FROM noderag.chat_message WHERE id=$1 AND conversation_id=$2`,
    [run.requestMessageId, run.conversationId],
  );
  const requestSequence = databaseInteger(
    request.rows[0]?.sequence,
    'chat request message sequence',
  );
  const messages = await pool.query<MessageRow>(
    `SELECT id,role,content,sequence,state,pinned FROM noderag.chat_message
     WHERE conversation_id=$1 AND sequence <= $2
       AND role IN ('system','user','assistant') AND state='committed'
       AND (context_state='active' OR pinned)
     ORDER BY sequence`,
    [run.conversationId, requestSequence],
  );
  const researchContext =
    researchEnabled && run.researchAttachmentRevisionId !== null
      ? await prepareChatResearchContext(pool, {
          conversationId: run.conversationId,
          principalId: run.ownerPrincipalId,
          responseMessageId: run.responseMessageId,
          revisionId: run.researchAttachmentRevisionId,
        })
      : null;
  return {
    researchContext,
    messages: messages.rows.map((message) => ({
      ...message,
      id: String(message.id),
      sequence: databaseInteger(message.sequence, 'chat message sequence'),
      state: message.state,
      pinned: message.pinned === true,
    })),
  };
};

const ownsLease = async (
  pool: Pool,
  run: ClaimedChatRun,
  leaseMilliseconds: number,
): Promise<boolean> => {
  const result = await pool.query<{ cancel_requested_at: Date | null }>(
    `UPDATE noderag.chat_run SET heartbeat_at=now(),
            leased_until=now()+($4::bigint*interval '1 millisecond'),updated_at=now()
     WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status IN ('running','cancelling')
     RETURNING cancel_requested_at`,
    [run.id, run.leaseOwner, run.leaseEpoch, leaseMilliseconds],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('chat_run_lease_lost');
  return row.cancel_requested_at === null;
};

const persistedToolArguments = (
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  name === 'web.search.v1'
    ? {
        querySha256: createHash('sha256')
          .update(
            String(arguments_['query'] ?? '')
              .normalize('NFC')
              .trim(),
          )
          .digest('hex'),
        ...(arguments_['maxResults'] === undefined ? {} : { maxResults: arguments_['maxResults'] }),
      }
    : arguments_;

const persistProviderEvent = async (
  pool: Pool,
  run: ClaimedChatRun,
  event: ChatProviderEvent,
): Promise<'continue' | 'terminal'> =>
  withTransaction(pool, async (database) => {
    await database.query(`SELECT id FROM noderag.chat_conversation WHERE id=$1 FOR UPDATE`, [
      run.conversationId,
    ]);
    const lease = await database.query<{ cancel_requested_at: Date | null }>(
      `SELECT cancel_requested_at FROM noderag.chat_run
       WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status IN ('running','cancelling')
       FOR UPDATE`,
      [run.id, run.leaseOwner, run.leaseEpoch],
    );
    if (lease.rows[0] === undefined) throw new Error('chat_run_lease_lost');
    const payload: Record<string, unknown> = { providerSequence: event.sequence };
    if (event.type === 'response.started') {
      if (event.providerRequestId !== undefined)
        payload['providerRequestId'] = event.providerRequestId;
      await database.query(`UPDATE noderag.chat_run SET provider_request_id=$2 WHERE id=$1`, [
        run.id,
        event.providerRequestId ?? null,
      ]);
    } else if (event.type === 'response.output_text.delta') {
      payload['text'] = event.text;
      const updated = await database.query(
        `UPDATE noderag.chat_message SET content=content || $2
         WHERE id=$1 AND state='streaming' AND length(content)+length($2) <= 2000000`,
        [run.responseMessageId, event.text],
      );
      if (updated.rowCount !== 1) throw new Error('chat_response_too_large');
    } else if (event.type === 'response.reasoning_summary.delta') {
      const summary = safeChatReasoningSummary(run.provider, event.text);
      if (summary !== null) {
        payload['text'] = summary;
        await database.query(
          `UPDATE noderag.chat_message
           SET reasoning_summary=COALESCE(reasoning_summary,'') || $2
           WHERE id=$1 AND state='streaming'
             AND length(COALESCE(reasoning_summary,''))+length($2) <= 1000000`,
          [run.responseMessageId, summary],
        );
      }
    } else if (event.type === 'response.tool_call') {
      Object.assign(payload, {
        callId: event.callId,
        name: event.name,
        arguments: persistedToolArguments(event.name, event.arguments),
      });
    } else if (event.type === 'response.usage') {
      Object.assign(payload, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens ?? 0,
      });
      await database.query(
        `UPDATE noderag.chat_run SET input_tokens=$2,output_tokens=$3,cached_input_tokens=$4,
            input_usage_source='provider_exact'
         WHERE id=$1`,
        [run.id, event.inputTokens, event.outputTokens, event.cachedInputTokens ?? 0],
      );
    } else if (event.type === 'response.completed') {
      payload['finishReason'] = event.finishReason;
      const cancelled =
        event.finishReason === 'cancelled' || lease.rows[0].cancel_requested_at !== null;
      await database.query(
        `UPDATE noderag.chat_run
         SET status=$4,lease_owner=NULL,leased_until=NULL,heartbeat_at=NULL,
             safe_error_code=NULL,error_retryable=false,
             finished_at=now(),updated_at=now(),status_version=status_version+1
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
        [run.id, run.leaseOwner, run.leaseEpoch, cancelled ? 'cancelled' : 'completed'],
      );
      await database.query(
        `UPDATE noderag.chat_message SET state=$2,completed_at=now() WHERE id=$1`,
        [run.responseMessageId, cancelled ? 'cancelled' : 'committed'],
      );
      await database.query(
        `INSERT INTO noderag.chat_usage_daily
           (principal_id,usage_date,run_count,input_tokens,output_tokens)
         SELECT $1,current_date,1,input_tokens,output_tokens FROM noderag.chat_run WHERE id=$2
         ON CONFLICT (principal_id,usage_date) DO UPDATE SET
           run_count=chat_usage_daily.run_count+1,
           input_tokens=chat_usage_daily.input_tokens+EXCLUDED.input_tokens,
           output_tokens=chat_usage_daily.output_tokens+EXCLUDED.output_tokens`,
        [run.ownerPrincipalId, run.id],
      );
    } else if (event.type === 'response.failed') {
      Object.assign(payload, { code: event.code, retryable: event.retryable });
      const retry = event.retryable && run.attempts < run.maximumAttempts;
      await database.query(
        `UPDATE noderag.chat_run SET status=$4,safe_error_code=$5,error_retryable=$6,
            lease_owner=NULL,leased_until=NULL,heartbeat_at=NULL,
            finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END,
            queued_at=CASE WHEN $4='queued' THEN now() ELSE queued_at END,
            updated_at=now(),status_version=status_version+1
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
        [
          run.id,
          run.leaseOwner,
          run.leaseEpoch,
          retry ? 'queued' : 'failed',
          event.code,
          event.retryable,
        ],
      );
      if (!retry) {
        await database.query(
          `UPDATE noderag.chat_message SET state='failed',completed_at=now(),
                  metadata=metadata || jsonb_build_object('safeErrorCode',$2::text)
           WHERE id=$1`,
          [run.responseMessageId, event.code],
        );
      }
    }
    await appendChatEvent(database, {
      conversationId: run.conversationId,
      runId: run.id,
      type: event.type,
      payload,
      occurredAt: new Date(event.occurredAt),
    });
    await database.query(`UPDATE noderag.chat_conversation SET updated_at=now() WHERE id=$1`, [
      run.conversationId,
    ]);
    return event.type === 'response.completed' || event.type === 'response.failed'
      ? 'terminal'
      : 'continue';
  });

const classifyFailure = (error: unknown): { code: string; retryable: boolean } => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          typeof Reflect.get(error, 'message') === 'string'
        ? String(Reflect.get(error, 'message'))
        : null;
  if (message === 'openai_chat_cancelled' || message === 'chat_run_cancelled') {
    return { code: 'chat_run_cancelled', retryable: false };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code === 'string') {
      return { code: candidate.code.slice(0, 120), retryable: candidate.retryable === true };
    }
  }
  const code = message ?? 'chat_provider_failed';
  return {
    code: /^[a-z][a-z0-9_-]{0,119}$/u.test(code) ? code : 'chat_provider_failed',
    retryable: true,
  };
};

const failClaimedRun = async (pool: Pool, run: ClaimedChatRun, error: unknown): Promise<void> => {
  const failure = classifyFailure(error);
  if (failure.code === 'chat_run_cancelled') {
    await persistProviderEvent(pool, run, {
      type: 'response.completed',
      sequence: 0,
      occurredAt: new Date().toISOString(),
      finishReason: 'cancelled',
    });
    return;
  }
  await persistProviderEvent(pool, run, {
    type: 'response.failed',
    sequence: 0,
    occurredAt: new Date().toISOString(),
    code: failure.code,
    retryable: failure.retryable,
  }).catch(() => undefined);
};

const safeToolFailureCode = (error: unknown): string => {
  if (error instanceof ZodError) return 'chat_tool_arguments_invalid';
  const message = error instanceof Error ? error.message : '';
  if (
    [
      'chat_research_access_revoked',
      'chat_research_source_stale',
      'chat_research_source_not_found',
      'chat_tool_limit_reached',
      'chat_tool_duplicate_call',
      'chat_tool_result_too_large',
      'chat_rag_access_revoked',
      'chat_rag_source_stale',
      'chat_rag_citation_not_found',
      'chat_rag_query_limit_reached',
      'chat_rag_query_duplicate',
      'chat_rag_tool_not_found',
      'chat_web_unavailable',
      'chat_web_credential_required',
      'chat_web_credentials_rejected',
      'chat_web_rate_limited',
      'chat_web_timeout',
      'chat_web_request_rejected',
      'chat_web_response_too_large',
      'chat_web_response_malformed',
      'chat_web_url_unsafe',
      'chat_web_citation_not_found',
      'chat_web_cancelled',
      'chat_web_tool_not_found',
      'chat_web_call_limit_reached',
      'chat_web_request_duplicate',
      'chat_artifact_not_found',
      'chat_artifact_path_invalid',
      'chat_artifact_path_conflict',
      'chat_artifact_parent_missing',
      'chat_artifact_kind_invalid',
      'chat_artifact_content_invalid',
      'chat_artifact_file_too_large',
      'chat_artifact_quota_exceeded',
      'chat_artifact_patch_conflict',
      'chat_artifact_storage_unavailable',
      'chat_artifact_storage_unsafe',
      'chat_artifact_disk_full',
      'chat_artifact_tool_not_found',
      'chat_tool_result_context_exceeded',
    ].includes(message)
  ) {
    return message;
  }
  return 'chat_tool_failed';
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

const executeToolForRun = async (
  options: ChatRunProcessorOptions,
  run: ClaimedChatRun,
  request: ChatToolExecutionRequest,
  signal: AbortSignal,
): Promise<ChatToolExecutionResult> => {
  const researchTool = CHAT_RESEARCH_TOOL_DEFINITIONS.some(({ name }) => name === request.name);
  const ragTool = CHAT_RAG_TOOL_DEFINITIONS.some(({ name }) => name === request.name);
  const webTool = CHAT_WEB_TOOL_DEFINITIONS.some(({ name }) => name === request.name);
  const artifactTool = CHAT_ARTIFACT_TOOL_DEFINITIONS.some(({ name }) => name === request.name);
  const researchAvailable =
    researchTool &&
    options.researchEnabled === true &&
    run.researchAttachmentRevisionId !== null &&
    options.files !== undefined;
  const ragAvailable =
    ragTool &&
    options.ragEnabled === true &&
    run.ragEnabled &&
    options.embedder !== undefined &&
    options.files !== undefined;
  const webAvailable =
    webTool &&
    options.webEnabled === true &&
    run.internetEnabled &&
    options.webExecutor !== undefined;
  const artifactAvailable =
    artifactTool && options.artifactEnabled === true && options.artifactExecutor !== undefined;
  if (
    run.maximumToolCalls < 1 ||
    (!researchAvailable && !ragAvailable && !webAvailable && !artifactAvailable)
  ) {
    return {
      content: JSON.stringify({ error: 'chat_tools_not_available', retryable: false }),
      isError: true,
    };
  }
  const recordId = randomUUID();
  const requestSha256 = createHash('sha256')
    .update(canonicalJson({ name: request.name, arguments: request.arguments }))
    .digest();
  const startedAt = Date.now();
  let recorded = false;
  try {
    await withTransaction(options.pool, async (database) => {
      const lease = await database.query(
        `SELECT id FROM noderag.chat_run
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status IN ('running','cancelling')
         FOR UPDATE`,
        [run.id, run.leaseOwner, run.leaseEpoch],
      );
      if (lease.rows[0] === undefined) throw new Error('chat_run_lease_lost');
      const count = await database.query<{ count: string }>(
        `SELECT count(*) FROM noderag.chat_tool_call WHERE run_id=$1`,
        [run.id],
      );
      if (Number(count.rows[0]?.count) >= run.maximumToolCalls) {
        throw new Error('chat_tool_limit_reached');
      }
      if (request.name === 'rag.search.v1') {
        const searchCount = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM noderag.chat_tool_call
           WHERE run_id=$1 AND tool_name='rag.search.v1'`,
          [run.id],
        );
        if (Number(searchCount.rows[0]?.count) >= Math.min(8, run.maximumToolCalls)) {
          throw new Error('chat_rag_query_limit_reached');
        }
        const duplicate = await database.query(
          `SELECT id FROM noderag.chat_tool_call
           WHERE run_id=$1 AND tool_name='rag.search.v1' AND request_sha256=$2`,
          [run.id, requestSha256],
        );
        if (duplicate.rows[0] !== undefined) throw new Error('chat_rag_query_duplicate');
      }
      if (request.name === 'web.search.v1' || request.name === 'web.fetch.v1') {
        const webCount = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM noderag.chat_tool_call
           WHERE run_id=$1 AND tool_name IN ('web.search.v1','web.fetch.v1')`,
          [run.id],
        );
        if (Number(webCount.rows[0]?.count) >= Math.min(6, run.maximumToolCalls)) {
          throw new Error('chat_web_call_limit_reached');
        }
        const duplicate = await database.query(
          `SELECT id FROM noderag.chat_tool_call
           WHERE run_id=$1 AND tool_name=$2 AND request_sha256=$3`,
          [run.id, request.name, requestSha256],
        );
        if (duplicate.rows[0] !== undefined) throw new Error('chat_web_request_duplicate');
      }
      try {
        await database.query(
          `INSERT INTO noderag.chat_tool_call
             (id,run_id,ordinal,call_id,tool_name,arguments,request_sha256,status)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'running')`,
          [
            recordId,
            run.id,
            Number(count.rows[0]?.count),
            request.callId,
            request.name,
            JSON.stringify(persistedToolArguments(request.name, request.arguments)),
            requestSha256,
          ],
        );
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        ) {
          throw new Error('chat_tool_duplicate_call', { cause: error });
        }
        throw error;
      }
      recorded = true;
    });
    const execution = researchAvailable
      ? {
          content: await executeChatResearchTool(options.pool, options.files as DocumentFileStore, {
            conversationId: run.conversationId,
            principalId: run.ownerPrincipalId,
            revisionId: run.researchAttachmentRevisionId as string,
            name: request.name,
            arguments: request.arguments,
          }),
          resultCount: null,
          resultSummary: { kind: 'research' },
        }
      : ragAvailable
        ? await executeChatRagTool(
            options.pool,
            options.embedder as Embedder,
            options.files as DocumentFileStore,
            {
              runId: run.id,
              conversationId: run.conversationId,
              responseMessageId: run.responseMessageId,
              toolCallId: recordId,
              principalId: run.ownerPrincipalId,
              requestId: `chat:${run.id}:${request.callId}`,
              name: request.name,
              arguments: request.arguments,
            },
          )
        : webAvailable
          ? await (options.webExecutor as ChatWebExecutor).execute({
              runId: run.id,
              conversationId: run.conversationId,
              responseMessageId: run.responseMessageId,
              toolCallId: recordId,
              principalId: run.ownerPrincipalId,
              name: request.name,
              arguments: request.arguments,
              signal,
            })
          : await (options.artifactExecutor as ChatArtifactExecutor).execute({
              runId: run.id,
              conversationId: run.conversationId,
              responseMessageId: run.responseMessageId,
              toolCallId: recordId,
              principalId: run.ownerPrincipalId,
              name: request.name,
              arguments: request.arguments,
            });
    const content = execution.content;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 512 * 1024) throw new Error('chat_tool_result_too_large');
    await options.pool.query(
      `UPDATE noderag.chat_tool_call
       SET status='completed',result_sha256=$2,result_bytes=$3,duration_ms=$4,
           result_count=$5,result_summary=$6::jsonb,finished_at=now()
       WHERE id=$1 AND status='running'`,
      [
        recordId,
        createHash('sha256').update(content).digest(),
        bytes,
        Math.max(0, Date.now() - startedAt),
        execution.resultCount,
        JSON.stringify(execution.resultSummary),
      ],
    );
    return { content, isError: false };
  } catch (error) {
    const code = safeToolFailureCode(error);
    if (recorded) {
      await options.pool
        .query(
          `UPDATE noderag.chat_tool_call
           SET status='failed',safe_error_code=$2,duration_ms=$3,finished_at=now()
           WHERE id=$1 AND status='running'`,
          [recordId, code, Math.max(0, Date.now() - startedAt)],
        )
        .catch(() => undefined);
    }
    const retryable =
      typeof error === 'object' && error !== null && Reflect.get(error, 'retryable') === true;
    return { content: JSON.stringify({ error: code, retryable }), isError: true };
  }
};

export const processOneChatRun = async (options: ChatRunProcessorOptions): Promise<boolean> => {
  const leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MS;
  const run = await claimChatRun(options.pool, options.leaseOwner, leaseMilliseconds);
  if (run === null) return false;
  const controller = new AbortController();
  const timeoutMilliseconds = Math.max(
    1,
    Math.min(run.timeoutMs, options.runTimeoutCeilingMilliseconds ?? run.timeoutMs),
  );
  const timeout = setTimeout(
    () => controller.abort(new Error('chat_provider_timeout')),
    timeoutMilliseconds,
  );
  timeout.unref();
  let heartbeatBusy = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void ownsLease(options.pool, run, leaseMilliseconds)
        .then((continueRun) => {
          if (!continueRun) controller.abort(new Error('chat_run_cancelled'));
        })
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          heartbeatBusy = false;
        });
    },
    Math.max(1_000, Math.floor(leaseMilliseconds / 3)),
  );
  heartbeat.unref();
  try {
    if (!(await ownsLease(options.pool, run, leaseMilliseconds))) {
      controller.abort(new Error('chat_run_cancelled'));
    }
    const provider = await options.resolveProvider(run.provider);
    const researchToolsEnabled =
      options.researchEnabled === true &&
      options.files !== undefined &&
      run.researchAttachmentRevisionId !== null &&
      run.maximumToolCalls > 0;
    const ragToolsEnabled =
      options.ragEnabled === true &&
      options.embedder !== undefined &&
      options.files !== undefined &&
      run.ragEnabled &&
      run.maximumToolCalls > 0;
    const webToolsEnabled =
      options.webEnabled === true &&
      options.webExecutor !== undefined &&
      run.internetEnabled &&
      run.maximumToolCalls > 0 &&
      (await options.webExecutor.isAvailable().catch(() => false));
    const artifactToolsEnabled =
      options.artifactEnabled === true &&
      options.artifactExecutor !== undefined &&
      run.maximumToolCalls > 0;
    const tools = [
      ...(researchToolsEnabled ? CHAT_RESEARCH_TOOL_DEFINITIONS : []),
      ...(ragToolsEnabled ? CHAT_RAG_TOOL_DEFINITIONS : []),
      ...(webToolsEnabled ? CHAT_WEB_TOOL_DEFINITIONS : []),
      ...(artifactToolsEnabled ? CHAT_ARTIFACT_TOOL_DEFINITIONS : []),
    ];
    const loaded = await loadMessages(options.pool, run, options.researchEnabled === true);
    const outputReserveTokens = Math.min(
      run.outputReserveTokens,
      run.maximumOutputTokens ?? run.outputReserveTokens,
    );
    const snapshot =
      run.contextMode === 'managed'
        ? await loadManagedSnapshotMessages(options.pool, run.conversationId)
        : null;
    const injectedSystemMessages = [
      ...(loaded.researchContext === null ? [] : [loaded.researchContext]),
      ...(snapshot?.messages.map(({ content }) => content) ?? []),
    ];
    let prepared = prepareRollingContext({
      provider: run.provider,
      messages: loaded.messages,
      injectedSystemMessages,
      tools,
      capacityTokens: run.contextCapacityTokens,
      inputReserveTokens: run.inputReserveTokens,
      outputReserveTokens,
      pinnedInstructionReserveTokens: run.pinnedInstructionReserveTokens,
      toolResultReserveTokens: run.toolResultReserveTokens,
      rollingTurnLimit:
        run.contextMode === 'managed' ? run.managedKeepRecentTurns : run.rollingTurnLimit,
    });
    if (run.contextMode === 'managed') {
      const budget = createContextBudget({
        capacityTokens: run.contextCapacityTokens,
        inputReserveTokens: run.inputReserveTokens,
        outputReserveTokens,
        pinnedInstructionReserveTokens: run.pinnedInstructionReserveTokens,
        toolResultReserveTokens: run.toolResultReserveTokens,
        triggerPercent: run.managedTriggerPercent,
      });
      const triggerReached =
        prepared.estimatedInputTokens + budget.fixedReserveTokens >= budget.triggerTokens;
      if (prepared.foldedCandidateIds.length > 0 || triggerReached) {
        const compressed = await compressManagedContext({
          pool: options.pool,
          leaseOwner: `${run.leaseOwner}:context`,
          runId: run.id,
          conversationId: run.conversationId,
          chatRoot: run.chatRoot,
          principalId: run.ownerPrincipalId,
          resolveProvider: options.resolveProvider,
          mainProvider: run.provider,
          capacityTokens: run.contextCapacityTokens,
          inputReserveTokens: run.inputReserveTokens,
          outputReserveTokens,
          pinnedInstructionReserveTokens: run.pinnedInstructionReserveTokens,
          toolResultReserveTokens: run.toolResultReserveTokens,
          injectedSystemMessages: loaded.researchContext === null ? [] : [loaded.researchContext],
          tools,
          signal: controller.signal,
        });
        if (compressed.prepared !== null) prepared = compressed.prepared;
      } else if (snapshot !== null) {
        await options.pool.query(
          `UPDATE noderag.chat_run SET context_snapshot_id=$2
           WHERE id=$1 AND lease_owner=$3 AND lease_epoch=$4`,
          [run.id, snapshot.id, run.leaseOwner, run.leaseEpoch],
        );
      }
    }
    await options.pool.query(
      `UPDATE noderag.chat_run
       SET estimated_input_tokens=$2,input_usage_source='conservative_estimate',
           token_estimator_revision=$3
       WHERE id=$1 AND lease_owner=$4 AND lease_epoch=$5`,
      [
        run.id,
        prepared.estimatedInputTokens,
        prepared.estimatorRevision,
        run.leaseOwner,
        run.leaseEpoch,
      ],
    );
    const requestBudget = createContextBudget({
      capacityTokens: run.contextCapacityTokens,
      inputReserveTokens: run.inputReserveTokens,
      outputReserveTokens,
      pinnedInstructionReserveTokens: run.pinnedInstructionReserveTokens,
      toolResultReserveTokens: run.toolResultReserveTokens,
      triggerPercent: run.managedTriggerPercent,
    });
    let admittedToolResults: readonly string[] = [];
    const executeBudgetedTool = async (request: ChatToolExecutionRequest) => {
      const result = await executeToolForRun(options, run, request, controller.signal);
      admittedToolResults = admitToolResultToContext({
        provider: run.provider,
        messages: prepared.messages,
        tools,
        admittedToolResults,
        content: result.content,
        availableInputTokens: requestBudget.availableInputTokens,
        toolResultReserveTokens: run.toolResultReserveTokens,
        outputReserveTokens,
      });
      return result;
    };
    let terminalSeen = false;
    let expectedProviderSequence = 0;
    for await (const event of provider.stream({
      runId: run.id,
      conversationId: run.conversationId,
      model: run.model,
      reasoningEffort: run.reasoningEffort as never,
      messages: [...prepared.messages],
      tools,
      ...(tools.length > 0
        ? {
            executeTool: executeBudgetedTool,
          }
        : {}),
      maximumOutputTokens: outputReserveTokens,
      signal: controller.signal,
    })) {
      if (
        event.sequence !== expectedProviderSequence ||
        (expectedProviderSequence === 0 && event.type !== 'response.started')
      ) {
        throw new Error('chat_provider_invalid_event_order');
      }
      expectedProviderSequence += 1;
      const state = await persistProviderEvent(options.pool, run, event);
      await synchronizeChatEventLog(options.pool, run.chatRoot, run.conversationId);
      if (state === 'terminal') {
        terminalSeen = true;
        break;
      }
    }
    if (!terminalSeen) throw new Error('chat_provider_missing_terminal');
  } catch (error) {
    await failClaimedRun(
      options.pool,
      run,
      controller.signal.aborted ? controller.signal.reason : error,
    );
    await synchronizeChatEventLog(options.pool, run.chatRoot, run.conversationId).catch(
      () => undefined,
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
  await writePortableChatManifest(options.pool, run.chatRoot, run.conversationId).catch(
    () => undefined,
  );
  return true;
};
