import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import type { ChatProvider, ChatProviderKind, ChatProviderMessage } from './contract.js';
import { sealChatEventLog } from './log-store.js';
import {
  CHAT_CONTEXT_SNAPSHOT_REVISION,
  CHAT_TOKEN_ESTIMATOR_REVISION,
  acceptBoundedLayerText,
  contextLayerSha256,
  createContextBudget,
  estimateChatRequestTokens,
  groupContextTurns,
  managedSnapshotMessages,
  parseManagedContextState,
  prepareRollingContext,
  type ContextMessage,
  type ManagedContextState,
  type PreparedContextWindow,
} from './context-runtime.js';

const COMPRESSION_LEASE_MS = 45_000;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

interface LayerSettings {
  readonly provider: ChatProviderKind;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly instructions: string;
  readonly outputTargetTokens: number;
  readonly capacityTokens: number | null;
}

interface CompressionSettings {
  readonly contextRevisionId: number;
  readonly keepRecentTurns: number;
  readonly l1PinLimitTokens: number;
  readonly l2: LayerSettings;
  readonly l3: LayerSettings;
  readonly maximumParallelRunsPerUser: number;
  readonly timeoutMilliseconds: number;
}

interface PriorSnapshot {
  readonly id: string;
  readonly summary: string;
  readonly state: ManagedContextState;
}

interface CompressionJob {
  readonly id: string;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
}

export interface ManagedCompressionOptions {
  readonly pool: Pool;
  readonly leaseOwner: string;
  readonly runId: string | null;
  readonly conversationId: string;
  readonly chatRoot: string;
  readonly principalId: number;
  readonly resolveProvider: (kind: ChatProviderKind) => Promise<ChatProvider>;
  readonly mainProvider: ChatProviderKind;
  readonly capacityTokens: number | null;
  readonly inputReserveTokens: number;
  readonly outputReserveTokens: number;
  readonly pinnedInstructionReserveTokens: number;
  readonly toolResultReserveTokens: number;
  readonly injectedSystemMessages: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
  }[];
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds?: number;
}

export interface ManagedCompressionResult {
  readonly snapshotId: string | null;
  readonly prepared: PreparedContextWindow | null;
  readonly compressed: boolean;
  readonly scheduling: 'concurrent' | 'sequential';
  readonly retainedPriorLayers: readonly ('l2' | 'l3')[];
}

export const compressionLayerScheduling = (input: {
  readonly maximumParallelRunsPerUser: number;
  readonly l2Provider: ChatProviderKind;
  readonly l3Provider: ChatProviderKind;
}): 'concurrent' | 'sequential' =>
  input.maximumParallelRunsPerUser >= 2 && input.l2Provider !== input.l3Provider
    ? 'concurrent'
    : 'sequential';

const compressionDigest = (input: {
  readonly eventId: string;
  readonly jobId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly previousSha256: string | null;
}): Buffer => createHash('sha256').update(canonicalJson(input)).digest();

const appendCompressionEvent = async (
  database: SqlClient,
  input: {
    readonly jobId: string;
    readonly type:
      | 'compression.queued'
      | 'compression.started'
      | 'compression.progress'
      | 'compression.cancel_requested'
      | 'compression.recovered'
      | 'compression.completed'
      | 'compression.failed'
      | 'compression.cancelled';
    readonly payload?: Readonly<Record<string, unknown>>;
  },
): Promise<void> => {
  await database.query(
    `SELECT id FROM noderag.chat_context_compression_job WHERE id=$1 FOR UPDATE`,
    [input.jobId],
  );
  const prior = await database.query<{ sequence: number; event_sha256: Buffer }>(
    `SELECT sequence,event_sha256 FROM noderag.chat_context_compression_event
     WHERE job_id=$1 ORDER BY sequence DESC LIMIT 1`,
    [input.jobId],
  );
  const sequence = (prior.rows[0]?.sequence ?? -1) + 1;
  const previous = prior.rows[0]?.event_sha256 ?? null;
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const payload = input.payload ?? {};
  const digest = compressionDigest({
    eventId,
    jobId: input.jobId,
    sequence,
    type: input.type,
    payload,
    occurredAt,
    previousSha256: previous?.toString('hex') ?? null,
  });
  await database.query(
    `INSERT INTO noderag.chat_context_compression_event
       (event_id,job_id,sequence,event_type,payload,previous_sha256,event_sha256,occurred_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [
      eventId,
      input.jobId,
      sequence,
      input.type,
      JSON.stringify(payload),
      previous,
      digest,
      occurredAt,
    ],
  );
};

const loadSettings = async (
  pool: SqlClient,
  conversationId: string,
): Promise<CompressionSettings> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT context.id AS context_revision_id,context.managed_enabled,
            context.managed_keep_recent_turns,context.l1_pin_limit_tokens,
            l2_connection.provider_kind AS l2_provider,context.l2_model,
            context.l2_reasoning_effort,context.l2_instructions,context.l2_output_target_tokens,
            COALESCE(l2_profile.runtime_context_tokens,l2_profile.configured_context_tokens,
              l2_profile.advertised_context_tokens,l2_profile.administrator_context_tokens,
              l2_known.context_tokens) AS l2_capacity_tokens,
            l3_connection.provider_kind AS l3_provider,context.l3_model,
            context.l3_reasoning_effort,context.l3_instructions,context.l3_output_target_tokens,
            COALESCE(l3_profile.runtime_context_tokens,l3_profile.configured_context_tokens,
              l3_profile.advertised_context_tokens,l3_profile.administrator_context_tokens,
              l3_known.context_tokens) AS l3_capacity_tokens,
            settings.maximum_parallel_runs_per_user,settings.run_timeout_ms
     FROM noderag.chat_conversation AS conversation
     JOIN noderag.chat_conversation_configuration_revision AS revision
       ON revision.id=conversation.configuration_revision_id
     JOIN noderag.chat_context_settings_revision AS context
       ON context.id=revision.context_revision_id
     JOIN noderag.chat_settings_revision AS settings ON settings.id=revision.settings_revision_id
     LEFT JOIN noderag.chat_provider_connection AS l2_connection
       ON l2_connection.id=context.l2_connection_id
     LEFT JOIN noderag.chat_provider_connection AS l3_connection
       ON l3_connection.id=context.l3_connection_id
     LEFT JOIN noderag.chat_model_profile AS l2_profile
       ON l2_profile.connection_id=context.l2_connection_id AND l2_profile.model=context.l2_model
     LEFT JOIN noderag.chat_model_profile AS l3_profile
       ON l3_profile.connection_id=context.l3_connection_id AND l3_profile.model=context.l3_model
     LEFT JOIN LATERAL (
       SELECT context_tokens FROM noderag.chat_known_model_capacity
       WHERE provider_kind=l2_connection.provider_kind AND model_pattern=context.l2_model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS l2_known ON true
     LEFT JOIN LATERAL (
       SELECT context_tokens FROM noderag.chat_known_model_capacity
       WHERE provider_kind=l3_connection.provider_kind AND model_pattern=context.l3_model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS l3_known ON true
     WHERE conversation.id=$1`,
    [conversationId],
  );
  const row = result.rows[0];
  if (row === undefined || row['managed_enabled'] !== true) {
    throw new Error('chat_managed_context_not_available');
  }
  const layer = (prefix: 'l2' | 'l3'): LayerSettings => {
    const provider = row[`${prefix}_provider`];
    if (provider !== 'ollama_cloud' && provider !== 'openai_oauth') {
      throw new Error(`chat_context_${prefix}_unavailable`);
    }
    return {
      provider,
      model: String(row[`${prefix}_model`]),
      reasoningEffort: String(row[`${prefix}_reasoning_effort`]),
      instructions: String(row[`${prefix}_instructions`]),
      outputTargetTokens: Number(row[`${prefix}_output_target_tokens`]),
      capacityTokens:
        row[`${prefix}_capacity_tokens`] === null ? null : Number(row[`${prefix}_capacity_tokens`]),
    };
  };
  return {
    contextRevisionId: databaseInteger(row['context_revision_id'], 'chat context revision id'),
    keepRecentTurns: Number(row['managed_keep_recent_turns']),
    l1PinLimitTokens: Number(row['l1_pin_limit_tokens']),
    l2: layer('l2'),
    l3: layer('l3'),
    maximumParallelRunsPerUser: Number(row['maximum_parallel_runs_per_user']),
    timeoutMilliseconds: Number(row['run_timeout_ms']),
  };
};

interface CompressionMessage extends ContextMessage {
  readonly contextState: 'active' | 'folded';
}

const loadMessages = async (
  pool: SqlClient,
  conversationId: string,
): Promise<readonly CompressionMessage[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id,sequence,role,content,state,pinned,context_state FROM noderag.chat_message
     WHERE conversation_id=$1 AND state='committed' AND (context_state='active' OR pinned)
       AND role IN ('system','user','assistant') ORDER BY sequence`,
    [conversationId],
  );
  return result.rows.map((row) => ({
    id: String(row['id']),
    sequence: databaseInteger(row['sequence'], 'chat message sequence'),
    role: row['role'] as 'system' | 'user' | 'assistant',
    content: String(row['content']),
    state: 'committed',
    pinned: row['pinned'] === true,
    contextState: row['context_state'] as 'active' | 'folded',
  }));
};

const loadPriorSnapshot = async (
  pool: SqlClient,
  conversationId: string,
): Promise<PriorSnapshot | null> => {
  const result = await pool.query<{ id: string; l2_summary: string; l3_state: unknown }>(
    `SELECT id,l2_summary,l3_state FROM noderag.chat_context_snapshot
     WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [conversationId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { id: row.id, summary: row.l2_summary, state: parseManagedContextState(row.l3_state) };
};

const queueAndClaimJob = async (
  pool: Pool,
  input: {
    readonly conversationId: string;
    readonly runId: string | null;
    readonly leaseOwner: string;
    readonly contextRevisionId: number;
    readonly priorSnapshotId: string | null;
    readonly sourceLastSequence: number;
    readonly settings: CompressionSettings;
  },
): Promise<CompressionJob> =>
  withTransaction(pool, async (database) => {
    const existing = await database.query<{ id: string }>(
      `SELECT id FROM noderag.chat_context_compression_job
       WHERE conversation_id=$1 AND state IN ('queued','running','cancelling')
       ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [input.conversationId],
    );
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (existing.rows[0] === undefined) {
      await database.query(
        `INSERT INTO noderag.chat_context_compression_job
           (id,conversation_id,trigger_run_id,mode,context_revision_id,
            source_last_message_sequence,prior_snapshot_id,settings_snapshot)
         VALUES($1,$2,$3,'automatic',$4,$5,$6,$7::jsonb)`,
        [
          jobId,
          input.conversationId,
          input.runId,
          input.contextRevisionId,
          input.sourceLastSequence,
          input.priorSnapshotId,
          JSON.stringify({
            estimatorRevision: CHAT_TOKEN_ESTIMATOR_REVISION,
            keepRecentTurns: input.settings.keepRecentTurns,
            l1PinLimitTokens: input.settings.l1PinLimitTokens,
            l2: input.settings.l2,
            l3: input.settings.l3,
          }),
        ],
      );
      await appendCompressionEvent(database, {
        jobId,
        type: 'compression.queued',
        payload: { mode: 'automatic', sourceLastSequence: input.sourceLastSequence },
      });
    }
    const claimed = await database.query<Record<string, unknown>>(
      `UPDATE noderag.chat_context_compression_job
       SET state=CASE WHEN cancel_requested_at IS NULL THEN 'running' ELSE 'cancelling' END,
           lease_owner=$2,lease_epoch=lease_epoch+1,
           leased_until=now()+($3::bigint*interval '1 millisecond'),heartbeat_at=now(),
           attempts=attempts+1,started_at=COALESCE(started_at,now()),
           current_layer='prepare',progress_percent=5,updated_at=now(),status_version=status_version+1
       WHERE id=$1 AND attempts<maximum_attempts
         AND (state='queued' OR (state IN ('running','cancelling') AND leased_until<=now()))
       RETURNING id,attempts,maximum_attempts,lease_epoch`,
      [jobId, input.leaseOwner, COMPRESSION_LEASE_MS],
    );
    const row = claimed.rows[0];
    if (row === undefined) throw new Error('chat_context_compression_busy');
    await appendCompressionEvent(database, {
      jobId,
      type: Number(row['attempts']) > 1 ? 'compression.recovered' : 'compression.started',
      payload: { attempt: Number(row['attempts']) },
    });
    return {
      id: String(row['id']),
      attempts: Number(row['attempts']),
      maximumAttempts: Number(row['maximum_attempts']),
      leaseOwner: input.leaseOwner,
      leaseEpoch: databaseInteger(row['lease_epoch'], 'compression lease epoch'),
    };
  });

const heartbeat = async (
  pool: Pool,
  job: CompressionJob,
  layer: 'prepare' | 'l2' | 'l3' | 'commit',
  progress: number,
): Promise<void> => {
  const updated = await pool.query(
    `UPDATE noderag.chat_context_compression_job
     SET current_layer=$4,progress_percent=$5,
         heartbeat_at=now(),leased_until=now()+($6::bigint*interval '1 millisecond'),updated_at=now()
     WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3
       AND state IN ('running','cancelling') AND cancel_requested_at IS NULL`,
    [job.id, job.leaseOwner, job.leaseEpoch, layer, progress, COMPRESSION_LEASE_MS],
  );
  if (updated.rowCount !== 1) throw new Error('chat_context_compression_cancelled');
};

const callLayer = async (
  provider: ChatProvider,
  settings: LayerSettings,
  conversationId: string,
  source: string,
  signal: AbortSignal,
): Promise<string> => {
  const estimate = estimateManagedLayerRequest({
    provider: settings.provider,
    instructions: settings.instructions,
    source,
    outputTargetTokens: settings.outputTargetTokens,
  });
  const budget = createContextBudget({
    capacityTokens: settings.capacityTokens,
    inputReserveTokens: 256,
    outputReserveTokens: settings.outputTargetTokens,
    pinnedInstructionReserveTokens: 0,
    toolResultReserveTokens: 0,
  });
  if (estimate.inputTokens > budget.availableInputTokens) {
    throw new Error('chat_context_layer_request_too_large');
  }
  let output = '';
  let terminal = false;
  const stream = provider.stream({
    runId: randomUUID(),
    conversationId,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort as never,
    messages: [
      { role: 'system', content: settings.instructions },
      { role: 'user', content: source },
    ],
    tools: [],
    maximumOutputTokens: settings.outputTargetTokens,
    signal,
  });
  const iterator = stream[Symbol.asyncIterator]();
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason ?? new Error('chat_context_compression_cancelled'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      const event = next.value;
      if (event.type === 'response.output_text.delta') output += event.text;
      if (event.type === 'response.failed') {
        const failure = new Error(event.code) as Error & { retryable?: boolean };
        failure.retryable = event.retryable;
        throw failure;
      }
      if (event.type === 'response.tool_call') throw new Error('chat_context_layer_tool_forbidden');
      if (event.type === 'response.completed') terminal = true;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    const returned = iterator.return?.();
    if (signal.aborted) void returned?.catch(() => undefined);
    else await returned?.catch(() => undefined);
  }
  if (!terminal) throw new Error('chat_context_layer_missing_terminal');
  return output;
};

const safeCompressionCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_-]{0,119}$/u.test(message) ? message : 'chat_context_compression_failed';
};

export const compressManagedContext = async (
  options: ManagedCompressionOptions,
): Promise<ManagedCompressionResult> => {
  const settings = await loadSettings(options.pool, options.conversationId);
  const sourceMessages = await loadMessages(options.pool, options.conversationId);
  const turns = groupContextTurns(
    sourceMessages.filter(({ contextState }) => contextState === 'active'),
  );
  const complete = turns.filter(({ complete }) => complete);
  const foldTurns = complete.slice(0, Math.max(0, complete.length - settings.keepRecentTurns));
  const foldMessages = foldTurns.flatMap(({ messages }) => messages);
  const prior = await loadPriorSnapshot(options.pool, options.conversationId);
  const scheduling = compressionLayerScheduling({
    maximumParallelRunsPerUser: settings.maximumParallelRunsPerUser,
    l2Provider: settings.l2.provider,
    l3Provider: settings.l3.provider,
  });
  if (foldMessages.length === 0) {
    return {
      snapshotId: prior?.id ?? null,
      prepared: null,
      compressed: false,
      scheduling,
      retainedPriorLayers: [],
    };
  }
  const sourceLastSequence = Math.max(...sourceMessages.map(({ sequence }) => sequence));
  const job = await queueAndClaimJob(options.pool, {
    conversationId: options.conversationId,
    runId: options.runId,
    leaseOwner: options.leaseOwner,
    contextRevisionId: settings.contextRevisionId,
    priorSnapshotId: prior?.id ?? null,
    sourceLastSequence,
    settings,
  });
  const compressionController = new AbortController();
  const relayAbort = () =>
    compressionController.abort(
      options.signal.reason ?? new Error('chat_context_compression_cancelled'),
    );
  if (options.signal.aborted) relayAbort();
  else options.signal.addEventListener('abort', relayAbort, { once: true });
  const deadline = setTimeout(
    () => compressionController.abort(new Error('chat_context_compression_timeout')),
    options.timeoutMilliseconds ?? settings.timeoutMilliseconds,
  );
  deadline.unref();
  let heartbeatBusy = false;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  const leaseHeartbeat = setInterval(
    () => {
      if (heartbeatBusy || compressionController.signal.aborted) return;
      heartbeatBusy = true;
      heartbeatInFlight = heartbeat(options.pool, job, 'prepare', 10)
        .catch((error: unknown) => compressionController.abort(error))
        .finally(() => {
          heartbeatBusy = false;
        });
    },
    Math.max(1_000, Math.floor(COMPRESSION_LEASE_MS / 3)),
  );
  leaseHeartbeat.unref();
  try {
    await heartbeat(options.pool, job, 'prepare', 10);
    const source = canonicalJson({
      contract: 'chat-compression-source.v1',
      prior: prior === null ? null : { summary: prior.summary, structuredState: prior.state },
      messages: foldMessages.map(({ id, sequence, role, content, pinned }) => ({
        id,
        sequence,
        role,
        content,
        pinned,
      })),
    });
    const [l2Provider, l3Provider] = await Promise.all([
      options.resolveProvider(settings.l2.provider),
      options.resolveProvider(settings.l3.provider),
    ]);
    const invokeL2 = async () => {
      return acceptBoundedLayerText(
        await callLayer(
          l2Provider,
          settings.l2,
          options.conversationId,
          source,
          compressionController.signal,
        ),
        settings.l2.outputTargetTokens,
      );
    };
    const invokeL3 = async () => {
      const output = await callLayer(
        l3Provider,
        settings.l3,
        options.conversationId,
        source,
        compressionController.signal,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch (error) {
        throw new Error('chat_context_l3_invalid', { cause: error });
      }
      return parseManagedContextState(parsed);
    };
    let summary: string;
    let state: ManagedContextState;
    const retained: ('l2' | 'l3')[] = [];
    if (scheduling === 'concurrent') {
      await heartbeat(options.pool, job, 'l2', 25);
      const [l2, l3] = await Promise.allSettled([invokeL2(), invokeL3()]);
      if (l2.status === 'fulfilled') summary = l2.value;
      else if (prior !== null) {
        summary = prior.summary;
        retained.push('l2');
      } else throw l2.reason;
      if (l3.status === 'fulfilled') state = l3.value;
      else if (prior !== null) {
        state = prior.state;
        retained.push('l3');
      } else throw l3.reason;
    } else {
      try {
        await heartbeat(options.pool, job, 'l2', 25);
        summary = await invokeL2();
      } catch (error) {
        if (prior === null) throw error;
        summary = prior.summary;
        retained.push('l2');
      }
      try {
        await heartbeat(options.pool, job, 'l3', 50);
        state = await invokeL3();
      } catch (error) {
        if (prior === null) throw error;
        state = prior.state;
        retained.push('l3');
      }
    }
    await heartbeat(options.pool, job, 'commit', 85);
    const foldedIds = new Set(foldMessages.map(({ id }) => id));
    const remaining = sourceMessages.filter(({ id, pinned }) => !foldedIds.has(id) || pinned);
    const managedMessages = managedSnapshotMessages({ summary, state });
    const prepared = prepareRollingContext({
      provider: options.mainProvider,
      messages: remaining,
      injectedSystemMessages: [
        ...options.injectedSystemMessages,
        ...managedMessages.map(({ content }) => content),
      ],
      tools: options.tools,
      capacityTokens: options.capacityTokens,
      inputReserveTokens: options.inputReserveTokens,
      outputReserveTokens: options.outputReserveTokens,
      pinnedInstructionReserveTokens: options.pinnedInstructionReserveTokens,
      toolResultReserveTokens: options.toolResultReserveTokens,
      rollingTurnLimit: settings.keepRecentTurns,
    });
    if (prepared.foldedCandidateIds.length > 0) {
      throw new Error('chat_context_minimum_integrity_failed');
    }
    const sourceSha = contextLayerSha256(
      foldMessages.map(({ id, sequence, role, content }) => ({ id, sequence, role, content })),
    );
    const l1Ids = sourceMessages.filter(({ pinned }) => pinned).map(({ id }) => id);
    const l1Sha = contextLayerSha256(l1Ids);
    const l2Sha = contextLayerSha256(summary);
    const l3Sha = contextLayerSha256(state);
    const snapshotId = randomUUID();
    const foldThrough = Math.max(...foldMessages.map(({ sequence }) => sequence));
    const sourceFirst = Math.min(...foldMessages.map(({ sequence }) => sequence));
    const activeRemaining = remaining.filter(({ contextState }) => contextState === 'active');
    const recentFrom = Math.min(...activeRemaining.map(({ sequence }) => sequence));
    const snapshotSha = contextLayerSha256({
      contract: CHAT_CONTEXT_SNAPSHOT_REVISION,
      priorSnapshotId: prior?.id ?? null,
      sourceFirst,
      sourceLast: sourceLastSequence,
      foldThrough,
      recentFrom,
      l1Ids,
      l1Sha256: l1Sha.toString('hex'),
      summary,
      l2Sha256: l2Sha.toString('hex'),
      state,
      l3Sha256: l3Sha.toString('hex'),
      sourceSha256: sourceSha.toString('hex'),
    });
    const sealedSegment = await sealChatEventLog(
      options.pool,
      options.chatRoot,
      options.conversationId,
    );
    await withTransaction(options.pool, async (database) => {
      const lease = await database.query(
        `SELECT id FROM noderag.chat_context_compression_job
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='running'
           AND cancel_requested_at IS NULL FOR UPDATE`,
        [job.id, job.leaseOwner, job.leaseEpoch],
      );
      if (lease.rows[0] === undefined) throw new Error('chat_context_compression_cancelled');
      await database.query(`SELECT id FROM noderag.chat_conversation WHERE id=$1 FOR UPDATE`, [
        options.conversationId,
      ]);
      const unchanged = await database.query<{ content: string; sequence: unknown }>(
        `SELECT content,sequence FROM noderag.chat_message
         WHERE conversation_id=$1 AND id=ANY($2::uuid[]) ORDER BY sequence`,
        [options.conversationId, foldMessages.map(({ id }) => id)],
      );
      if (
        unchanged.rows.length !== foldMessages.length ||
        contextLayerSha256(
          unchanged.rows.map((row, index) => ({
            id: foldMessages[index]?.id,
            sequence: databaseInteger(row.sequence, 'chat message sequence'),
            role: foldMessages[index]?.role,
            content: row.content,
          })),
        ).toString('hex') !== sourceSha.toString('hex')
      ) {
        throw new Error('chat_context_source_changed');
      }
      await database.query(
        `INSERT INTO noderag.chat_context_snapshot
           (id,conversation_id,job_id,log_segment_id,prior_snapshot_id,schema_revision,estimator_revision,
            source_first_sequence,source_last_sequence,fold_through_sequence,recent_from_sequence,
            l1_message_ids,l1_sha256,l2_summary,l2_sha256,l3_state,l3_sha256,source_sha256,
            snapshot_sha256,context_tokens,minimum_integrity_passed)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid[],$13,$14,$15,$16::jsonb,$17,$18,$19,$20,true)`,
        [
          snapshotId,
          options.conversationId,
          job.id,
          sealedSegment?.id ?? null,
          prior?.id ?? null,
          CHAT_CONTEXT_SNAPSHOT_REVISION,
          CHAT_TOKEN_ESTIMATOR_REVISION,
          sourceFirst,
          sourceLastSequence,
          foldThrough,
          recentFrom,
          l1Ids,
          l1Sha,
          summary,
          l2Sha,
          JSON.stringify(state),
          l3Sha,
          sourceSha,
          snapshotSha,
          prepared.estimatedInputTokens,
        ],
      );
      await database.query(
        `UPDATE noderag.chat_message
         SET context_state='folded',archived_segment_id=$3
         WHERE conversation_id=$1 AND id=ANY($2::uuid[])`,
        [options.conversationId, foldMessages.map(({ id }) => id), sealedSegment?.id ?? null],
      );
      if (options.runId !== null) {
        await database.query(`UPDATE noderag.chat_run SET context_snapshot_id=$2 WHERE id=$1`, [
          options.runId,
          snapshotId,
        ]);
      }
      await database.query(
        `UPDATE noderag.chat_context_compression_job
         SET state='completed',fold_through_sequence=$4,progress_percent=100,current_layer=NULL,
             lease_owner=NULL,leased_until=NULL,heartbeat_at=NULL,finished_at=now(),updated_at=now(),
             status_version=status_version+1
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
        [job.id, job.leaseOwner, job.leaseEpoch, foldThrough],
      );
      await appendCompressionEvent(database, {
        jobId: job.id,
        type: 'compression.completed',
        payload: {
          snapshotId,
          foldThroughSequence: foldThrough,
          scheduling,
          retainedPriorLayers: retained,
        },
      });
    });
    return {
      snapshotId,
      prepared,
      compressed: true,
      scheduling,
      retainedPriorLayers: retained,
    };
  } catch (error) {
    const failure = compressionController.signal.aborted
      ? compressionController.signal.reason
      : error;
    const code = safeCompressionCode(failure);
    const cancelled = code === 'chat_context_compression_cancelled';
    const retryable =
      !cancelled &&
      code !== 'chat_context_l3_invalid' &&
      code !== 'chat_context_l3_too_large' &&
      code !== 'chat_context_l2_too_large' &&
      code !== 'chat_context_minimum_integrity_failed';
    await withTransaction(options.pool, async (database) => {
      const retry = retryable && job.attempts < job.maximumAttempts;
      const state = cancelled ? 'cancelled' : retry ? 'queued' : 'failed';
      await database.query(
        `UPDATE noderag.chat_context_compression_job
         SET state=$4,safe_error_code=$5,error_retryable=$6,
             lease_owner=NULL,leased_until=NULL,heartbeat_at=NULL,current_layer=NULL,
             finished_at=CASE WHEN $4 IN ('failed','cancelled') THEN now() ELSE NULL END,
             updated_at=now(),status_version=status_version+1
         WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
        [job.id, job.leaseOwner, job.leaseEpoch, state, code, retryable],
      );
      await appendCompressionEvent(database, {
        jobId: job.id,
        type: cancelled ? 'compression.cancelled' : 'compression.failed',
        payload: { code, retryable, willRetry: retry },
      });
    }).catch(() => undefined);
    throw failure;
  } finally {
    clearTimeout(deadline);
    clearInterval(leaseHeartbeat);
    options.signal.removeEventListener('abort', relayAbort);
    await heartbeatInFlight.catch(() => undefined);
  }
};

export const loadManagedSnapshotMessages = async (
  pool: Pool,
  conversationId: string,
): Promise<{ readonly id: string; readonly messages: readonly ChatProviderMessage[] } | null> => {
  const prior = await loadPriorSnapshot(pool, conversationId);
  return prior === null
    ? null
    : {
        id: prior.id,
        messages: managedSnapshotMessages({ summary: prior.summary, state: prior.state }),
      };
};

export const estimateManagedLayerRequest = (input: {
  readonly provider: ChatProviderKind;
  readonly instructions: string;
  readonly source: string;
  readonly outputTargetTokens: number;
}) =>
  estimateChatRequestTokens({
    provider: input.provider,
    messages: [
      { role: 'system', content: input.instructions },
      { role: 'user', content: input.source },
    ],
    tools: [],
    outputReserveTokens: input.outputTargetTokens,
  });

export interface ManagedCompressionPreview {
  readonly mode: 'dry_run';
  readonly conversationId: string;
  readonly activeMessages: number;
  readonly completeTurns: number;
  readonly keepRecentTurns: number;
  readonly foldMessageIds: readonly string[];
  readonly sourceLastSequence: number | null;
  readonly foldThroughSequence: number | null;
  readonly pinnedMessageIds: readonly string[];
  readonly estimatedSourceTokens: number;
  readonly projectedProviderCalls: 0 | 2;
  readonly scheduling: 'concurrent' | 'sequential';
  readonly priorSnapshotId: string | null;
}

export const previewManagedCompression = async (
  pool: SqlClient,
  conversationId: string,
): Promise<ManagedCompressionPreview> => {
  const settings = await loadSettings(pool, conversationId);
  const messages = await loadMessages(pool, conversationId);
  const active = messages.filter(({ contextState }) => contextState === 'active');
  const complete = groupContextTurns(active).filter(({ complete }) => complete);
  const fold = complete
    .slice(0, Math.max(0, complete.length - settings.keepRecentTurns))
    .flatMap(({ messages: turnMessages }) => turnMessages);
  const prior = await loadPriorSnapshot(pool, conversationId);
  const source = canonicalJson({
    contract: 'chat-compression-source.v1',
    prior: prior === null ? null : { summary: prior.summary, structuredState: prior.state },
    messages: fold.map(({ id, sequence, role, content, pinned }) => ({
      id,
      sequence,
      role,
      content,
      pinned,
    })),
  });
  return {
    mode: 'dry_run',
    conversationId,
    activeMessages: active.length,
    completeTurns: complete.length,
    keepRecentTurns: settings.keepRecentTurns,
    foldMessageIds: fold.map(({ id }) => id),
    sourceLastSequence:
      active.length === 0 ? null : Math.max(...active.map(({ sequence }) => sequence)),
    foldThroughSequence:
      fold.length === 0 ? null : Math.max(...fold.map(({ sequence }) => sequence)),
    pinnedMessageIds: messages.filter(({ pinned }) => pinned).map(({ id }) => id),
    estimatedSourceTokens: estimateManagedLayerRequest({
      provider: settings.l2.provider,
      instructions: settings.l2.instructions,
      source,
      outputTargetTokens: settings.l2.outputTargetTokens,
    }).inputTokens,
    projectedProviderCalls: fold.length === 0 ? 0 : 2,
    scheduling: compressionLayerScheduling({
      maximumParallelRunsPerUser: settings.maximumParallelRunsPerUser,
      l2Provider: settings.l2.provider,
      l3Provider: settings.l3.provider,
    }),
    priorSnapshotId: prior?.id ?? null,
  };
};

export const queueManualContextCompression = async (
  database: SqlClient,
  input: { readonly conversationId: string; readonly principalId: number },
): Promise<{ readonly id: string; readonly state: 'queued' }> => {
  const settings = await loadSettings(database, input.conversationId);
  const preview = await previewManagedCompression(database, input.conversationId);
  if (preview.foldMessageIds.length === 0) throw new Error('chat_context_nothing_to_compress');
  const owned = await database.query(
    `SELECT id FROM noderag.chat_conversation
       WHERE id=$1 AND owner_principal_id=$2 AND state='active' FOR UPDATE`,
    [input.conversationId, input.principalId],
  );
  if (owned.rows[0] === undefined) throw new Error('chat_not_found');
  const activeRun = await database.query(
    `SELECT id FROM noderag.chat_run
       WHERE conversation_id=$1 AND status IN ('queued','running','cancelling')`,
    [input.conversationId],
  );
  if (activeRun.rows[0] !== undefined) throw new Error('chat_run_active');
  const existing = await database.query(
    `SELECT id FROM noderag.chat_context_compression_job
       WHERE conversation_id=$1 AND state IN ('queued','running','cancelling')`,
    [input.conversationId],
  );
  if (existing.rows[0] !== undefined) throw new Error('chat_context_compression_busy');
  const id = randomUUID();
  await database.query(
    `INSERT INTO noderag.chat_context_compression_job
         (id,conversation_id,mode,context_revision_id,source_last_message_sequence,
          prior_snapshot_id,settings_snapshot)
       VALUES($1,$2,'manual',$3,$4,$5,$6::jsonb)`,
    [
      id,
      input.conversationId,
      settings.contextRevisionId,
      preview.sourceLastSequence,
      preview.priorSnapshotId,
      JSON.stringify({
        estimatorRevision: CHAT_TOKEN_ESTIMATOR_REVISION,
        keepRecentTurns: settings.keepRecentTurns,
        l1PinLimitTokens: settings.l1PinLimitTokens,
        l2: settings.l2,
        l3: settings.l3,
      }),
    ],
  );
  await appendCompressionEvent(database, {
    jobId: id,
    type: 'compression.queued',
    payload: { mode: 'manual', sourceLastSequence: preview.sourceLastSequence },
  });
  return { id, state: 'queued' as const };
};

export const cancelContextCompression = async (
  database: SqlClient,
  input: { readonly conversationId: string; readonly jobId: string; readonly principalId: number },
): Promise<{ readonly id: string; readonly state: string }> => {
  const owned = await database.query(
    `SELECT id FROM noderag.chat_conversation WHERE id=$1 AND owner_principal_id=$2 FOR UPDATE`,
    [input.conversationId, input.principalId],
  );
  if (owned.rows[0] === undefined) throw new Error('chat_not_found');
  const updated = await database.query<{ state: string }>(
    `UPDATE noderag.chat_context_compression_job
       SET cancel_requested_at=COALESCE(cancel_requested_at,now()),
           state=CASE WHEN state='queued' THEN 'cancelled'
                      WHEN state='running' THEN 'cancelling' ELSE state END,
           finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END,
           updated_at=now(),status_version=status_version+1
       WHERE id=$1 AND conversation_id=$2
       RETURNING state`,
    [input.jobId, input.conversationId],
  );
  const state = updated.rows[0]?.state;
  if (state === undefined) throw new Error('chat_context_compression_not_found');
  await appendCompressionEvent(database, {
    jobId: input.jobId,
    type: state === 'cancelled' ? 'compression.cancelled' : 'compression.cancel_requested',
    payload: {},
  });
  return { id: input.jobId, state };
};

export const processOneManualContextCompression = async (options: {
  readonly pool: Pool;
  readonly leaseOwner: string;
  readonly resolveProvider: (kind: ChatProviderKind) => Promise<ChatProvider>;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
}): Promise<boolean> => {
  const selected = await options.pool.query<Record<string, unknown>>(
    `SELECT job.id,job.conversation_id,conversation.owner_principal_id,
            revision.provider_kind,
            COALESCE(profile.runtime_context_tokens,profile.configured_context_tokens,
              profile.advertised_context_tokens,profile.administrator_context_tokens,
              known.context_tokens) AS context_capacity_tokens,
            settings.storage_resolved_path,context.input_reserve_tokens,context.output_reserve_tokens,
            context.pinned_instruction_reserve_tokens,context.tool_result_reserve_tokens
     FROM noderag.chat_context_compression_job AS job
     JOIN noderag.chat_conversation AS conversation ON conversation.id=job.conversation_id
     JOIN noderag.chat_conversation_configuration_revision AS revision
       ON revision.id=conversation.configuration_revision_id
     JOIN noderag.chat_context_settings_revision AS context
       ON context.id=revision.context_revision_id
     JOIN noderag.chat_settings_revision AS settings ON settings.id=revision.settings_revision_id
     JOIN noderag.chat_model_profile AS profile
       ON profile.connection_id=revision.provider_connection_id AND profile.model=revision.model
     LEFT JOIN LATERAL (
       SELECT context_tokens FROM noderag.chat_known_model_capacity
       WHERE provider_kind=revision.provider_kind AND model_pattern=revision.model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS known ON true
     WHERE job.trigger_run_id IS NULL AND job.mode='manual'
       AND (job.state='queued' OR (job.state IN ('running','cancelling') AND job.leased_until<=now()))
     ORDER BY job.created_at,job.id LIMIT 1`,
  );
  const row = selected.rows[0];
  if (row === undefined) return false;
  await compressManagedContext({
    pool: options.pool,
    leaseOwner: options.leaseOwner,
    runId: null,
    conversationId: String(row['conversation_id']),
    chatRoot: String(row['storage_resolved_path']),
    principalId: databaseInteger(row['owner_principal_id'], 'chat owner principal id'),
    resolveProvider: options.resolveProvider,
    mainProvider: row['provider_kind'] as ChatProviderKind,
    capacityTokens:
      row['context_capacity_tokens'] === null ? null : Number(row['context_capacity_tokens']),
    inputReserveTokens: Number(row['input_reserve_tokens']),
    outputReserveTokens: Number(row['output_reserve_tokens']),
    pinnedInstructionReserveTokens: Number(row['pinned_instruction_reserve_tokens']),
    toolResultReserveTokens: Number(row['tool_result_reserve_tokens']),
    injectedSystemMessages: [],
    tools: [],
    signal: options.signal ?? new AbortController().signal,
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  }).catch(() => undefined);
  return true;
};

export const getManagedContextStatus = async (
  pool: Pool,
  conversationId: string,
): Promise<Readonly<Record<string, unknown>>> => {
  const [snapshot, job, counts] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT id,schema_revision,source_first_sequence,source_last_sequence,
              fold_through_sequence,recent_from_sequence,l1_message_ids,context_tokens,
              snapshot_sha256,created_at
       FROM noderag.chat_context_snapshot WHERE conversation_id=$1
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [conversationId],
    ),
    pool.query<Record<string, unknown>>(
      `SELECT id,mode,state,attempts,maximum_attempts,progress_percent,current_layer,
              safe_error_code,created_at,updated_at,finished_at
       FROM noderag.chat_context_compression_job WHERE conversation_id=$1
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [conversationId],
    ),
    pool.query<Record<string, unknown>>(
      `SELECT count(*) FILTER (WHERE context_state='active') AS active_messages,
              count(*) FILTER (WHERE context_state='folded') AS folded_messages,
              count(*) FILTER (WHERE pinned) AS pinned_messages
       FROM noderag.chat_message WHERE conversation_id=$1`,
      [conversationId],
    ),
  ]);
  const serialize = (row: Record<string, unknown> | undefined) =>
    row === undefined
      ? null
      : Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Date
              ? value.toISOString()
              : Buffer.isBuffer(value)
                ? value.toString('hex')
                : value,
          ]),
        );
  return {
    snapshot: serialize(snapshot.rows[0]),
    job: serialize(job.rows[0]),
    counts: counts.rows[0],
  };
};
