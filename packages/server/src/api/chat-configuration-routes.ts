import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { writeAuditEvent } from '../application/audit.js';
import {
  calculateUsableContextTokens,
  chatContextSettingsInputSchema,
  chatSettingsInputSchema,
  modelCapacityOverrideSchema,
  resolveModelCapacity,
  syntheticCompressionPreview,
} from '../chat/configuration.js';
import { probeChatStorage, type ChatStorageProbeOptions } from '../chat/storage.js';
import {
  getChatReconciliationStatus,
  previewChatStorageReconciliation,
  reconcileChatStorage,
} from '../chat/reconciliation.js';
import { loadChatHealth } from '../chat/health.js';
import { storageProbeProblemCode } from '../storage/probe.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const profileIdSchema = z.coerce.number().int().positive().safe();
const storageProbeSchema = z.object({ storagePath: z.string().trim().min(1).max(4096) }).strict();
const previewSchema = z
  .object({
    turnCount: z.number().int().min(1).max(500).default(24),
    averageCharactersPerMessage: z.number().int().min(40).max(20_000).default(1_200),
    pinnedCharacters: z.number().int().min(0).max(200_000).default(1_000),
  })
  .strict();
const reconciliationSchema = z
  .object({
    ownerMap: z.record(z.string().regex(/^\d+$/u), z.number().int().positive().safe()).default({}),
  })
  .strict();

class ChatConfigurationRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503 | 507,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ChatConfigurationRouteError';
  }
}

export interface ChatConfigurationRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly enabled: boolean;
  readonly importEnabled?: boolean;
  readonly storageProbeOptions?: () => ChatStorageProbeOptions;
}

const defaultStorageProbeOptions = (): ChatStorageProbeOptions => {
  const splitRoots = (name: string): readonly string[] =>
    (process.env[name] ?? '')
      .split(delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    policy: process.env['NODERAG_STORAGE_POLICY'] === 'dsm' ? 'dsm' : 'testbed',
    projectedBytes: BigInt(process.env['NODERAG_CHAT_STORAGE_PROJECTED_BYTES'] ?? '0'),
    rebuildReserveBytes: BigInt(
      process.env['NODERAG_CHAT_STORAGE_RESERVE_BYTES'] ?? String(1024 ** 3),
    ),
    encryptedRoots: splitRoots('NODERAG_ENCRYPTED_ROOTS'),
    requireEncrypted: process.env['NODERAG_REQUIRE_ENCRYPTED_STORAGE'] === '1',
    syncRoots: splitRoots('NODERAG_SYNC_ROOTS'),
    indexingRoots: splitRoots('NODERAG_INDEXING_ROOTS'),
  };
};

const requireAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatConfigurationRoutesOptions,
  mutation: boolean,
): Promise<AuthenticatedPrincipal | null> => {
  const principal = await options.authenticate(request);
  if (principal === null) {
    sendProblem(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (principal.searchOnly) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  if (!principal.serverAdmin) {
    sendProblem(reply, 403, 'server_admin_required', request.id);
    return null;
  }
  if (!options.enabled) {
    sendProblem(reply, 404, 'not_found', request.id);
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

const idempotencyKey = (request: FastifyRequest): string => {
  const key = request.headers['idempotency-key']?.toString();
  if (key === undefined) throw new ChatConfigurationRouteError(400, 'idempotency_key_required');
  return key;
};

const routeFailure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatConfigurationRouteError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof IdempotencyConflictError) {
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  }
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  }
  const code = error instanceof Error ? error.message : '';
  if (code.startsWith('storage_') || code.startsWith('chat_storage_')) {
    const status = code.includes('capacity') ? 507 : 422;
    return sendProblem(reply, status, code, request.id);
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'ENOSPC', 'EEXIST', 'ENOTDIR'].includes(error.code)
  ) {
    const storageCode = storageProbeProblemCode(error);
    const status = storageCode.includes('capacity') ? 507 : 422;
    return sendProblem(reply, status, storageCode, request.id);
  }
  if (error instanceof z.ZodError) {
    return sendProblem(reply, 422, 'chat_configuration_invalid', request.id);
  }
  if (error instanceof Error && error.message.startsWith('chat_import_')) {
    return sendProblem(reply, 422, error.message, request.id);
  }
  throw error;
};

const currentChatRoot = async (database: SqlClient): Promise<string> => {
  const result = await database.query<{ storage_resolved_path: string | null }>(
    `SELECT settings.storage_resolved_path
     FROM noderag.chat_configuration_current AS current
     JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
     WHERE current.singleton=true`,
  );
  const root = result.rows[0]?.storage_resolved_path;
  if (root === null || root === undefined) {
    throw new ChatConfigurationRouteError(503, 'chat_storage_unavailable');
  }
  return root;
};

const loadModel = async (
  database: SqlClient,
  provider: 'ollama_cloud' | 'openai_oauth',
  model: string,
  reasoningEffort: string,
  requireHealthy: boolean,
) => {
  const result = await database.query<{
    profile_id: unknown;
    connection_id: unknown;
    enabled: boolean;
    reasoning_efforts: string[];
    generation_status: string;
    provider_metadata: Record<string, unknown>;
    administrator_context_tokens: unknown | null;
    runtime_context_tokens: unknown | null;
    configured_context_tokens: unknown | null;
    advertised_context_tokens: unknown | null;
    known_context_tokens: unknown | null;
    administrator_output_tokens: unknown | null;
    maximum_output_tokens: unknown | null;
    known_output_tokens: unknown | null;
  }>(
    `SELECT profile.id AS profile_id, connection.id AS connection_id, connection.enabled,
            profile.reasoning_efforts, profile.provider_metadata,
            profile.administrator_context_tokens,profile.runtime_context_tokens,
            profile.configured_context_tokens,profile.advertised_context_tokens,
            known.context_tokens AS known_context_tokens,profile.administrator_output_tokens,
            profile.maximum_output_tokens,known.maximum_output_tokens AS known_output_tokens,
            capability.status AS generation_status
     FROM noderag.chat_provider_connection AS connection
     JOIN noderag.chat_model_profile AS profile ON profile.connection_id=connection.id
     LEFT JOIN LATERAL (
       SELECT context_tokens,maximum_output_tokens
       FROM noderag.chat_known_model_capacity
       WHERE provider_kind=connection.provider_kind AND model_pattern=profile.model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS known ON true
     JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id AND capability.capability='generation'
     WHERE connection.provider_kind=$1 AND profile.model=$2`,
    [provider, model],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatConfigurationRouteError(422, 'chat_model_not_available');
  if (row.provider_metadata['catalogStale'] === true) {
    throw new ChatConfigurationRouteError(422, 'chat_model_catalog_stale');
  }
  if (!row.reasoning_efforts.includes(reasoningEffort)) {
    throw new ChatConfigurationRouteError(422, 'chat_reasoning_effort_not_available');
  }
  if (requireHealthy && (!row.enabled || row.generation_status !== 'healthy')) {
    throw new ChatConfigurationRouteError(422, 'chat_generation_provider_not_ready');
  }
  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    profileId: databaseInteger(row.profile_id, 'chat model profile id'),
    connectionId: databaseInteger(row.connection_id, 'chat provider connection id'),
    ready: row.enabled && row.generation_status === 'healthy',
    capacity: resolveModelCapacity({
      administratorContextTokens: nullableNumber(row.administrator_context_tokens),
      runtimeContextTokens: nullableNumber(row.runtime_context_tokens),
      configuredContextTokens: nullableNumber(row.configured_context_tokens),
      advertisedContextTokens: nullableNumber(row.advertised_context_tokens),
      knownContextTokens: nullableNumber(row.known_context_tokens),
      administratorOutputTokens: nullableNumber(row.administrator_output_tokens),
      maximumOutputTokens: nullableNumber(row.maximum_output_tokens),
      knownOutputTokens: nullableNumber(row.known_output_tokens),
    }),
  };
};

const loadConfiguration = async (database: SqlClient) => {
  const current = await database.query<Record<string, unknown>>(
    `SELECT
       context.id AS context_id, context.revision_id AS context_revision,
       context.rolling_turn_limit, context.input_reserve_tokens,
       context.output_reserve_tokens, context.pinned_instruction_reserve_tokens,
       context.tool_result_reserve_tokens, context.managed_enabled,
       context.managed_trigger_percent, context.managed_keep_recent_turns,
       context.l1_pin_limit_tokens,
       l2.provider_kind AS l2_provider, context.l2_model, context.l2_reasoning_effort,
       context.l2_instructions, context.l2_output_target_tokens,
       l3.provider_kind AS l3_provider, context.l3_model, context.l3_reasoning_effort,
       context.l3_instructions, context.l3_output_target_tokens, context.l3_state_schema,
       settings.id AS settings_id, settings.revision_id AS settings_revision,
       defaults.provider_kind AS default_provider, settings.default_model,
       settings.default_reasoning_effort, settings.default_context_mode,
       settings.default_allow_research, settings.default_allow_rag,
       settings.default_allow_internet, settings.markdown_only, settings.run_timeout_ms,
       settings.maximum_tool_calls, settings.maximum_parallel_runs_per_user,
       settings.daily_run_quota, settings.daily_input_token_quota,
       settings.daily_output_token_quota, settings.retention_days,
       settings.archive_after_days, settings.artifact_max_file_bytes,
       settings.artifact_chat_quota_bytes, settings.markdown_external_images,
       settings.log_segment_max_bytes, settings.log_segment_max_age_minutes,
       settings.export_max_output_bytes, settings.export_timeout_ms,
       settings.export_maximum_attempts,
       settings.storage_requested_path,
       settings.storage_resolved_path, settings.storage_manifest_id,
       current.updated_at
     FROM noderag.chat_configuration_current AS current
     JOIN noderag.chat_context_settings_revision AS context
       ON context.id=current.context_revision_id
     JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
     LEFT JOIN noderag.chat_provider_connection AS l2 ON l2.id=context.l2_connection_id
     LEFT JOIN noderag.chat_provider_connection AS l3 ON l3.id=context.l3_connection_id
     LEFT JOIN noderag.chat_provider_connection AS defaults
       ON defaults.id=settings.default_connection_id
     WHERE current.singleton=true`,
  );
  const row = current.rows[0];
  if (row === undefined) throw new ChatConfigurationRouteError(503, 'chat_configuration_missing');
  const tests = await database.query<Record<string, unknown>>(
    `SELECT layer,status,safe_error_code,metadata,tested_at
     FROM noderag.chat_context_component_test WHERE context_revision_id=$1 ORDER BY layer`,
    [databaseInteger(row['context_id'], 'chat context revision id')],
  );
  const models = await database.query<Record<string, unknown>>(
    `SELECT profile.id, connection.provider_kind, connection.enabled, profile.model,
            profile.display_name, profile.reasoning_efforts,
            profile.administrator_context_tokens, profile.runtime_context_tokens,
            profile.configured_context_tokens, profile.advertised_context_tokens,
            known.context_tokens AS known_context_tokens, profile.administrator_output_tokens,
            profile.maximum_output_tokens,
            known.maximum_output_tokens AS known_output_tokens,
            profile.administrator_note, known.revision AS known_model_revision,
            profile.provider_metadata, capability.status AS generation_status
     FROM noderag.chat_model_profile AS profile
     JOIN noderag.chat_provider_connection AS connection ON connection.id=profile.connection_id
     LEFT JOIN LATERAL (
       SELECT context_tokens,maximum_output_tokens,revision
       FROM noderag.chat_known_model_capacity
       WHERE provider_kind=connection.provider_kind AND model_pattern=profile.model
       ORDER BY created_at DESC,revision DESC LIMIT 1
     ) AS known ON true
     JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id AND capability.capability='generation'
     ORDER BY connection.provider_kind, lower(profile.display_name), lower(profile.model)`,
  );
  const internetCapabilities = await database.query<Record<string, unknown>>(
    `SELECT capability.status,capability.capability,capability.tested_at
     FROM noderag.chat_provider_connection AS connection
     JOIN noderag.chat_provider_capability AS capability ON capability.connection_id=connection.id
     WHERE connection.provider_kind='ollama_cloud' AND connection.enabled
       AND capability.capability IN ('web_search','web_fetch')
     ORDER BY capability.capability`,
  );
  const executionEnabled = models.rows.some(
    (model) =>
      model['provider_kind'] === row['default_provider'] &&
      model['model'] === row['default_model'] &&
      model['enabled'] === true &&
      model['generation_status'] === 'healthy' &&
      !(
        typeof model['provider_metadata'] === 'object' &&
        model['provider_metadata'] !== null &&
        (model['provider_metadata'] as Record<string, unknown>)['catalogStale'] === true
      ),
  );
  return {
    contract: 'chat-settings.v1',
    executionEnabled,
    internetProvider: 'ollama_cloud',
    internet: {
      provider: 'ollama_cloud',
      ready:
        internetCapabilities.rows.length === 2 &&
        internetCapabilities.rows.every((capability) => capability['status'] === 'healthy'),
      capabilities: internetCapabilities.rows.map((capability) => ({
        capability: capability['capability'],
        status: capability['status'],
        testedAt:
          capability['tested_at'] instanceof Date
            ? capability['tested_at'].toISOString()
            : capability['tested_at'],
      })),
    },
    context: {
      revisionId: String(row['context_revision']),
      rollingTurnLimit: Number(row['rolling_turn_limit']),
      reserves: {
        inputTokens: Number(row['input_reserve_tokens']),
        outputTokens: Number(row['output_reserve_tokens']),
        pinnedInstructionTokens: Number(row['pinned_instruction_reserve_tokens']),
        toolResultTokens: Number(row['tool_result_reserve_tokens']),
      },
      managed: {
        enabled: Boolean(row['managed_enabled']),
        triggerPercent: Number(row['managed_trigger_percent']),
        keepRecentTurns: Number(row['managed_keep_recent_turns']),
        l1PinLimitTokens: Number(row['l1_pin_limit_tokens']),
        l2:
          row['l2_provider'] === null
            ? null
            : {
                provider: row['l2_provider'],
                model: row['l2_model'],
                reasoningEffort: row['l2_reasoning_effort'],
                instructions: row['l2_instructions'],
                outputTargetTokens: Number(row['l2_output_target_tokens']),
              },
        l3:
          row['l3_provider'] === null
            ? null
            : {
                provider: row['l3_provider'],
                model: row['l3_model'],
                reasoningEffort: row['l3_reasoning_effort'],
                instructions: row['l3_instructions'],
                outputTargetTokens: Number(row['l3_output_target_tokens']),
                stateSchema: row['l3_state_schema'],
              },
        tests: tests.rows.map((test) => ({
          layer: test['layer'],
          status: test['status'],
          safeErrorCode: test['safe_error_code'],
          metadata: test['metadata'],
          testedAt:
            test['tested_at'] instanceof Date ? test['tested_at'].toISOString() : test['tested_at'],
        })),
      },
    },
    settings: {
      revisionId: String(row['settings_revision']),
      defaultProvider: row['default_provider'],
      defaultModel: row['default_model'],
      defaultReasoningEffort: row['default_reasoning_effort'],
      defaultContextMode: row['default_context_mode'],
      defaults: {
        allowResearch: Boolean(row['default_allow_research']),
        allowRag: Boolean(row['default_allow_rag']),
        allowInternet: Boolean(row['default_allow_internet']),
      },
      markdownOnly: Boolean(row['markdown_only']),
      limits: {
        runTimeoutMs: Number(row['run_timeout_ms']),
        maximumToolCalls: Number(row['maximum_tool_calls']),
        maximumParallelRunsPerUser: Number(row['maximum_parallel_runs_per_user']),
        dailyRunQuota: row['daily_run_quota'] === null ? null : Number(row['daily_run_quota']),
        dailyInputTokenQuota:
          row['daily_input_token_quota'] === null ? null : Number(row['daily_input_token_quota']),
        dailyOutputTokenQuota:
          row['daily_output_token_quota'] === null ? null : Number(row['daily_output_token_quota']),
      },
      retention: {
        retentionDays: Number(row['retention_days']),
        archiveAfterDays: Number(row['archive_after_days']),
      },
      artifacts: {
        maximumFileBytes: Number(row['artifact_max_file_bytes']),
        chatQuotaBytes: Number(row['artifact_chat_quota_bytes']),
        markdownExternalImages: Boolean(row['markdown_external_images']),
      },
      logs: {
        segmentMaximumBytes: Number(row['log_segment_max_bytes']),
        segmentMaximumAgeMinutes: Number(row['log_segment_max_age_minutes']),
      },
      exports: {
        maximumOutputBytes: Number(row['export_max_output_bytes']),
        timeoutMilliseconds: Number(row['export_timeout_ms']),
        maximumAttempts: Number(row['export_maximum_attempts']),
      },
      storage:
        row['storage_manifest_id'] === null
          ? null
          : {
              requestedPath: row['storage_requested_path'],
              resolvedPath: row['storage_resolved_path'],
              manifestId: String(row['storage_manifest_id']),
            },
    },
    models: models.rows.map((model) => {
      const capacity = resolveModelCapacity({
        administratorContextTokens:
          model['administrator_context_tokens'] === null
            ? null
            : Number(model['administrator_context_tokens']),
        runtimeContextTokens:
          model['runtime_context_tokens'] === null ? null : Number(model['runtime_context_tokens']),
        configuredContextTokens:
          model['configured_context_tokens'] === null
            ? null
            : Number(model['configured_context_tokens']),
        advertisedContextTokens:
          model['advertised_context_tokens'] === null
            ? null
            : Number(model['advertised_context_tokens']),
        knownContextTokens:
          model['known_context_tokens'] === null ? null : Number(model['known_context_tokens']),
        administratorOutputTokens:
          model['administrator_output_tokens'] === null
            ? null
            : Number(model['administrator_output_tokens']),
        maximumOutputTokens:
          model['maximum_output_tokens'] === null ? null : Number(model['maximum_output_tokens']),
        knownOutputTokens:
          model['known_output_tokens'] === null ? null : Number(model['known_output_tokens']),
      });
      return {
        id: databaseInteger(model['id'], 'chat model profile id'),
        provider: model['provider_kind'],
        model: model['model'],
        displayName: model['display_name'],
        reasoningEfforts: model['reasoning_efforts'],
        enabled: model['enabled'],
        generationStatus: model['generation_status'],
        administratorContextTokens: model['administrator_context_tokens'],
        administratorOutputTokens: model['administrator_output_tokens'],
        note: model['administrator_note'],
        knownModelRevision: model['known_model_revision'],
        catalogStale:
          typeof model['provider_metadata'] === 'object' &&
          model['provider_metadata'] !== null &&
          (model['provider_metadata'] as Record<string, unknown>)['catalogStale'] === true,
        capacity,
        capacityEvidence: {
          administratorContextTokens: model['administrator_context_tokens'],
          runtimeContextTokens: model['runtime_context_tokens'],
          configuredContextTokens: model['configured_context_tokens'],
          advertisedContextTokens: model['advertised_context_tokens'],
          knownContextTokens: model['known_context_tokens'],
          administratorOutputTokens: model['administrator_output_tokens'],
          providerOutputTokens: model['maximum_output_tokens'],
          knownOutputTokens: model['known_output_tokens'],
        },
      };
    }),
    updatedAt:
      row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : row['updated_at'],
  };
};

const configurationId = async (database: SqlClient, column: 'context' | 'settings') => {
  const result = await database.query<Record<string, unknown>>(
    `SELECT ${column}_revision_id AS id FROM noderag.chat_configuration_current
     WHERE singleton=true FOR UPDATE`,
  );
  const id = result.rows[0]?.['id'];
  if (id === undefined) throw new ChatConfigurationRouteError(503, 'chat_configuration_missing');
  return databaseInteger(id, `chat ${column} revision id`);
};

const runMutation = async (
  request: FastifyRequest,
  options: ChatConfigurationRoutesOptions,
  principal: AuthenticatedPrincipal,
  operation: string,
  body: unknown,
  action: string,
  execute: (database: SqlClient) => Promise<unknown>,
) =>
  executeIdempotent(
    options.pool,
    {
      principalId: principal.principalId,
      operation,
      key: idempotencyKey(request),
      request: JSON.stringify(body),
    },
    async (database) => {
      const result = await execute(database);
      await writeAuditEvent(database, {
        principalId: principal.principalId,
        action,
        result: 'ok',
        requestId: request.id,
      });
      return { status: 200, headers: {}, body: result };
    },
  );

const layerReadiness = async (database: SqlClient, contextId: number, layer: 'l2' | 'l3') => {
  const result = await database.query<{
    enabled: boolean | null;
    generation_status: string | null;
    model_found: boolean;
  }>(
    `SELECT connection.enabled, capability.status AS generation_status,
            profile.id IS NOT NULL AS model_found
     FROM noderag.chat_context_settings_revision AS context
     LEFT JOIN noderag.chat_provider_connection AS connection
       ON connection.id=context.${layer}_connection_id
     LEFT JOIN noderag.chat_provider_capability AS capability
       ON capability.connection_id=connection.id AND capability.capability='generation'
     LEFT JOIN noderag.chat_model_profile AS profile
       ON profile.connection_id=connection.id AND profile.model=context.${layer}_model
     WHERE context.id=$1`,
    [contextId],
  );
  const row = result.rows[0];
  return row?.enabled === true && row.generation_status === 'healthy' && row.model_found;
};

export const registerChatConfigurationRoutes = (
  app: FastifyInstance,
  options: ChatConfigurationRoutesOptions,
): void => {
  app.get('/v1/admin/chat/health', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, false);
    if (principal === null) return;
    try {
      return reply.send(await loadChatHealth(options.pool));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/chat/configuration', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, false);
    if (principal === null) return;
    try {
      return reply.send(await loadConfiguration(options.pool));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.put('/v1/admin/chat/context', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const parsed = chatContextSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await runMutation(
        request,
        options,
        principal,
        'chat-context-settings-update',
        parsed.data,
        'chat.context.updated',
        async (database) => {
          const managed = parsed.data.managed;
          const l2 = managed.enabled
            ? await loadModel(
                database,
                managed.l2.provider,
                managed.l2.model,
                managed.l2.reasoningEffort,
                false,
              )
            : null;
          const l3 = managed.enabled
            ? await loadModel(
                database,
                managed.l3.provider,
                managed.l3.model,
                managed.l3.reasoningEffort,
                false,
              )
            : null;
          if (managed.enabled) {
            if (
              l2 === null ||
              l3 === null ||
              l2.capacity.contextTokens === null ||
              l3.capacity.contextTokens === null
            ) {
              throw new ChatConfigurationRouteError(422, 'chat_model_capacity_unknown');
            }
            if (
              l2.capacity.maximumOutputTokens !== null &&
              managed.l2.outputTargetTokens > l2.capacity.maximumOutputTokens
            ) {
              throw new ChatConfigurationRouteError(422, 'l2_output_target_exceeds_model_limit');
            }
            if (
              l3.capacity.maximumOutputTokens !== null &&
              managed.l3.outputTargetTokens > l3.capacity.maximumOutputTokens
            ) {
              throw new ChatConfigurationRouteError(422, 'l3_output_target_exceeds_model_limit');
            }
          }
          const inserted = await database.query<{ id: unknown; revision_id: string }>(
            `INSERT INTO noderag.chat_context_settings_revision (
               revision_id,rolling_turn_limit,input_reserve_tokens,output_reserve_tokens,
               pinned_instruction_reserve_tokens,tool_result_reserve_tokens,managed_enabled,
               managed_trigger_percent,managed_keep_recent_turns,l1_pin_limit_tokens,
               l2_connection_id,l2_model,l2_reasoning_effort,l2_instructions,l2_output_target_tokens,
               l3_connection_id,l3_model,l3_reasoning_effort,l3_instructions,l3_output_target_tokens,
               l3_state_schema,created_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
             ) RETURNING id,revision_id`,
            [
              randomUUID(),
              parsed.data.rollingTurnLimit,
              parsed.data.inputReserveTokens,
              parsed.data.outputReserveTokens,
              parsed.data.pinnedInstructionReserveTokens,
              parsed.data.toolResultReserveTokens,
              managed.enabled,
              managed.triggerPercent,
              managed.keepRecentTurns,
              managed.l1PinLimitTokens,
              l2?.connectionId ?? null,
              managed.enabled ? managed.l2.model : null,
              managed.enabled ? managed.l2.reasoningEffort : null,
              managed.enabled ? managed.l2.instructions : null,
              managed.enabled ? managed.l2.outputTargetTokens : null,
              l3?.connectionId ?? null,
              managed.enabled ? managed.l3.model : null,
              managed.enabled ? managed.l3.reasoningEffort : null,
              managed.enabled ? managed.l3.instructions : null,
              managed.enabled ? managed.l3.outputTargetTokens : null,
              managed.enabled ? managed.l3.stateSchema : {},
              principal.principalId,
            ],
          );
          const contextId = databaseInteger(inserted.rows[0]?.id, 'new chat context revision id');
          if (managed.enabled) {
            await database.query(
              `INSERT INTO noderag.chat_context_component_test
                 (context_revision_id,layer,status) VALUES ($1,'l2','untested'),($1,'l3','untested')`,
              [contextId],
            );
          }
          const previousSettingsId = await configurationId(database, 'settings');
          const settings = await database.query<{ id: unknown; revision_id: string }>(
            `INSERT INTO noderag.chat_settings_revision (
               revision_id,context_revision_id,default_connection_id,default_model,
               default_reasoning_effort,default_context_mode,default_allow_research,
               default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
               maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
               daily_input_token_quota,daily_output_token_quota,retention_days,
               archive_after_days,artifact_max_file_bytes,artifact_chat_quota_bytes,
               markdown_external_images,log_segment_max_bytes,log_segment_max_age_minutes,
               export_max_output_bytes,export_timeout_ms,export_maximum_attempts,
               storage_requested_path,storage_resolved_path,
               storage_manifest_id,created_by
             ) SELECT
               $1,$2,default_connection_id,default_model,default_reasoning_effort,
               'rolling',
               default_allow_research,default_allow_rag,default_allow_internet,markdown_only,
               run_timeout_ms,maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
               daily_input_token_quota,daily_output_token_quota,retention_days,archive_after_days,
               artifact_max_file_bytes,artifact_chat_quota_bytes,markdown_external_images,
               log_segment_max_bytes,log_segment_max_age_minutes,
               export_max_output_bytes,export_timeout_ms,export_maximum_attempts,
               storage_requested_path,storage_resolved_path,storage_manifest_id,$3
             FROM noderag.chat_settings_revision WHERE id=$4
             RETURNING id,revision_id`,
            [randomUUID(), contextId, principal.principalId, previousSettingsId],
          );
          const settingsId = databaseInteger(settings.rows[0]?.id, 'new chat settings revision id');
          await database.query(
            `UPDATE noderag.chat_configuration_current
             SET context_revision_id=$1,settings_revision_id=$2,updated_at=now(),updated_by=$3
             WHERE singleton=true`,
            [contextId, settingsId, principal.principalId],
          );
          return {
            ok: true,
            revisionId: inserted.rows[0]?.revision_id,
            settingsRevisionId: settings.rows[0]?.revision_id,
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/context/preview', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const parsed = previewSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await runMutation(
        request,
        options,
        principal,
        'chat-context-preview',
        parsed.data,
        'chat.context.previewed',
        async (database) => {
          const contextId = await configurationId(database, 'context');
          const current = await database.query<{
            managed_enabled: boolean;
            managed_keep_recent_turns: number;
          }>(
            `SELECT managed_enabled,managed_keep_recent_turns
             FROM noderag.chat_context_settings_revision WHERE id=$1`,
            [contextId],
          );
          const row = current.rows[0];
          if (row === undefined)
            throw new ChatConfigurationRouteError(503, 'chat_configuration_missing');
          const l2Ready = row.managed_enabled && (await layerReadiness(database, contextId, 'l2'));
          const l3Ready = row.managed_enabled && (await layerReadiness(database, contextId, 'l3'));
          if (row.managed_enabled) {
            for (const [layer, ready] of [
              ['l2', l2Ready],
              ['l3', l3Ready],
            ] as const) {
              await database.query(
                `UPDATE noderag.chat_context_component_test
                 SET status=$3,safe_error_code=$4,metadata=$5,tested_at=now()
                 WHERE context_revision_id=$1 AND layer=$2`,
                [
                  contextId,
                  layer,
                  ready ? 'healthy' : 'failed',
                  ready ? null : `${layer}_provider_not_ready`,
                  { syntheticInput: true, providerContentSent: false },
                ],
              );
            }
          }
          return syntheticCompressionPreview({
            ...parsed.data,
            keepRecentTurns: row.managed_keep_recent_turns,
            managedEnabled: row.managed_enabled,
            l2Ready,
            l3Ready,
          });
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.put('/v1/admin/chat/settings', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const parsed = chatSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await runMutation(
        request,
        options,
        principal,
        'chat-settings-update',
        parsed.data,
        'chat.settings.updated',
        async (database) => {
          const storage =
            parsed.data.storagePath === null
              ? null
              : await probeChatStorage(
                  parsed.data.storagePath,
                  (options.storageProbeOptions ?? defaultStorageProbeOptions)(),
                );
          const contextId = await configurationId(database, 'context');
          let defaultConnectionId: number | null = null;
          let defaultCapacity: ReturnType<typeof resolveModelCapacity> | null = null;
          if (parsed.data.defaultProvider !== null && parsed.data.defaultModel !== null) {
            const selected = await loadModel(
              database,
              parsed.data.defaultProvider,
              parsed.data.defaultModel,
              parsed.data.defaultReasoningEffort,
              true,
            );
            defaultConnectionId = selected.connectionId;
            defaultCapacity = selected.capacity;
          }
          const reserves = await database.query<{
            input_reserve_tokens: number;
            output_reserve_tokens: number;
            pinned_instruction_reserve_tokens: number;
            tool_result_reserve_tokens: number;
          }>(
            `SELECT input_reserve_tokens,output_reserve_tokens,
                    pinned_instruction_reserve_tokens,tool_result_reserve_tokens
             FROM noderag.chat_context_settings_revision WHERE id=$1`,
            [contextId],
          );
          const reserve = reserves.rows[0];
          if (reserve === undefined)
            throw new ChatConfigurationRouteError(503, 'chat_configuration_missing');
          if (
            defaultCapacity?.maximumOutputTokens !== null &&
            defaultCapacity?.maximumOutputTokens !== undefined &&
            reserve.output_reserve_tokens > defaultCapacity.maximumOutputTokens
          ) {
            throw new ChatConfigurationRouteError(422, 'chat_output_reserve_exceeds_model_limit');
          }
          if (
            defaultCapacity?.contextTokens !== null &&
            defaultCapacity?.contextTokens !== undefined
          ) {
            try {
              calculateUsableContextTokens({
                contextTokens: defaultCapacity.contextTokens,
                inputReserveTokens: reserve.input_reserve_tokens,
                outputReserveTokens: reserve.output_reserve_tokens,
                pinnedInstructionReserveTokens: reserve.pinned_instruction_reserve_tokens,
                toolResultReserveTokens: reserve.tool_result_reserve_tokens,
              });
            } catch {
              throw new ChatConfigurationRouteError(422, 'chat_reserves_exceed_model_capacity');
            }
          } else if (defaultCapacity !== null && parsed.data.defaultContextMode === 'managed') {
            throw new ChatConfigurationRouteError(422, 'chat_model_capacity_unknown');
          }
          if (parsed.data.defaultContextMode === 'managed') {
            const readiness = await database.query<{ ready: boolean }>(
              `SELECT context.managed_enabled AND count(test.*)=2 AND
                      bool_and(test.status='healthy') AS ready
               FROM noderag.chat_context_settings_revision AS context
               LEFT JOIN noderag.chat_context_component_test AS test
                 ON test.context_revision_id=context.id
               WHERE context.id=$1 GROUP BY context.managed_enabled`,
              [contextId],
            );
            if (readiness.rows[0]?.ready !== true) {
              throw new ChatConfigurationRouteError(422, 'managed_context_not_ready');
            }
          }
          if (parsed.data.defaultAllowInternet) {
            const internet = await database.query<{ ready: boolean }>(
              `SELECT count(*)=2 AND bool_and(capability.status='healthy') AS ready
               FROM noderag.chat_provider_connection AS connection
               JOIN noderag.chat_provider_capability AS capability
                 ON capability.connection_id=connection.id
               WHERE connection.provider_kind='ollama_cloud' AND connection.enabled
                 AND capability.capability IN ('web_search','web_fetch')`,
            );
            if (internet.rows[0]?.ready !== true) {
              throw new ChatConfigurationRouteError(422, 'ollama_cloud_internet_not_ready');
            }
          }
          const inserted = await database.query<{ id: unknown; revision_id: string }>(
            `INSERT INTO noderag.chat_settings_revision (
               revision_id,context_revision_id,default_connection_id,default_model,
               default_reasoning_effort,default_context_mode,default_allow_research,
               default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
               maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
               daily_input_token_quota,daily_output_token_quota,retention_days,
               archive_after_days,artifact_max_file_bytes,artifact_chat_quota_bytes,
               markdown_external_images,log_segment_max_bytes,log_segment_max_age_minutes,
               export_max_output_bytes,export_timeout_ms,export_maximum_attempts,
               storage_requested_path,storage_resolved_path,
               storage_manifest_id,created_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               $23,$24,$25,$26,$27,$28,$29,$30
             ) RETURNING id,revision_id`,
            [
              randomUUID(),
              contextId,
              defaultConnectionId,
              parsed.data.defaultModel,
              parsed.data.defaultReasoningEffort,
              parsed.data.defaultContextMode,
              parsed.data.defaultAllowResearch,
              parsed.data.defaultAllowRag,
              parsed.data.defaultAllowInternet,
              parsed.data.markdownOnly,
              parsed.data.runTimeoutMs,
              parsed.data.maximumToolCalls,
              parsed.data.maximumParallelRunsPerUser,
              parsed.data.dailyRunQuota,
              parsed.data.dailyInputTokenQuota,
              parsed.data.dailyOutputTokenQuota,
              parsed.data.retentionDays,
              parsed.data.archiveAfterDays,
              parsed.data.artifactMaxFileBytes,
              parsed.data.artifactChatQuotaBytes,
              parsed.data.markdownExternalImages,
              parsed.data.logSegmentMaxBytes,
              parsed.data.logSegmentMaxAgeMinutes,
              parsed.data.exportMaxOutputBytes,
              parsed.data.exportTimeoutMs,
              parsed.data.exportMaximumAttempts,
              storage?.requestedPath ?? null,
              storage?.chatRoot ?? null,
              storage?.manifest.manifestId ?? null,
              principal.principalId,
            ],
          );
          const settingsId = databaseInteger(inserted.rows[0]?.id, 'new chat settings revision id');
          await database.query(
            `UPDATE noderag.chat_configuration_current
             SET settings_revision_id=$1,updated_at=now(),updated_by=$2 WHERE singleton=true`,
            [settingsId, principal.principalId],
          );
          return { ok: true, revisionId: inserted.rows[0]?.revision_id };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.patch('/v1/admin/chat/models/:profileId', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const profileId = profileIdSchema.safeParse(
      (request.params as { profileId?: unknown }).profileId,
    );
    const parsed = modelCapacityOverrideSchema.safeParse(request.body);
    if (!profileId.success || !parsed.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    try {
      const result = await runMutation(
        request,
        options,
        principal,
        `chat-model-capacity:${String(profileId.data)}`,
        parsed.data,
        'chat.model.capacity.updated',
        async (database) => {
          const updated = await database.query(
            `UPDATE noderag.chat_model_profile
             SET administrator_context_tokens=$2,administrator_output_tokens=$3,
                 administrator_note=$4,updated_at=now(),updated_by=$5
             WHERE id=$1`,
            [
              profileId.data,
              parsed.data.administratorContextTokens,
              parsed.data.administratorOutputTokens,
              parsed.data.note,
              principal.principalId,
            ],
          );
          if (updated.rowCount !== 1)
            throw new ChatConfigurationRouteError(404, 'chat_model_not_found');
          return { ok: true };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/storage/probe', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const parsed = storageProbeSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await runMutation(
        request,
        options,
        principal,
        'chat-storage-probe',
        parsed.data,
        'chat.storage.probed',
        async () => {
          const probe = await probeChatStorage(
            parsed.data.storagePath,
            (options.storageProbeOptions ?? defaultStorageProbeOptions)(),
          );
          return {
            ok: true,
            requestedPath: probe.requestedPath,
            resolvedPath: probe.chatRoot,
            manifestId: probe.manifest.manifestId,
            initialized: probe.initialized,
            filesystem: probe.filesystem,
            availableBytes: probe.availableBytes,
            warnings: probe.warnings,
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/storage/reconcile/preview', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    if (options.importEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = reconciliationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const response = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-storage-reconcile-preview',
          key: idempotencyKey(request),
          request: JSON.stringify(parsed.data),
        },
        async (database) => {
          const preview = await previewChatStorageReconciliation(
            options.pool,
            await currentChatRoot(options.pool),
            parsed.data.ownerMap,
          );
          const safePreview = {
            contract: preview.contract,
            sourceManifestSha256: preview.sourceManifestSha256,
            rootManifestId: preview.rootManifestId,
            candidates: preview.candidates,
            destinationPrincipals: preview.destinationPrincipals,
            conflicts: preview.conflicts,
            canReconcile: preview.canReconcile,
          };
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.storage.reconcile_previewed',
            result: 'ok',
            requestId: request.id,
            detail: {
              sourceManifestSha256: preview.sourceManifestSha256,
              candidateCount: preview.candidates.length,
              conflictCount: preview.conflicts.length,
            },
          });
          return { status: 200, headers: {}, body: safePreview };
        },
      );
      return reply.code(response.response.status).send(response.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/storage/reconcile', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    if (options.importEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = reconciliationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const root = await currentChatRoot(options.pool);
      const response = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-storage-reconcile',
          key: idempotencyKey(request),
          request: JSON.stringify(parsed.data),
        },
        async (database) => {
          const body = await reconcileChatStorage(options.pool, {
            chatRoot: root,
            requestedBy: principal.principalId,
            ownerMap: parsed.data.ownerMap,
          });
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.storage.reconciled',
            result: String(body['state']) === 'completed' ? 'ok' : 'denied',
            requestId: request.id,
            detail: {
              operationId: body['operationId'],
              state: body['state'],
              importedChats: body['importedChats'] ?? 0,
            },
          });
          return { status: 200, headers: {}, body };
        },
      );
      return reply.code(response.response.status).send(response.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/chat/storage/reconcile/:operationId', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, false);
    if (principal === null) return;
    if (options.importEnabled !== true) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = z.object({ operationId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return sendProblem(reply, 404, 'chat_import_not_found', request.id);
    const status = await getChatReconciliationStatus(options.pool, parsed.data.operationId);
    if (status === null) return sendProblem(reply, 404, 'chat_import_not_found', request.id);
    return reply.send(status);
  });
};
