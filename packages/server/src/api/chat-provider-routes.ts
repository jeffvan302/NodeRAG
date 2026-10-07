import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditEvent } from '../application/audit.js';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import {
  OllamaCloudAdminClient,
  OllamaCloudError,
  OLLAMA_CLOUD_SERVICE_ROOT,
  type OllamaCloudCapability,
  type OllamaCloudTestResult,
} from '../chat/ollama-cloud.js';
import type { ChatModelProfile } from '../chat/contract.js';
import type { SecretVault } from '../identity/secrets.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const optionalSecretSchema = z
  .string()
  .max(4_000)
  .transform((value) => (value.trim().length === 0 ? undefined : value.trim()))
  .optional();

const updateOllamaCloudSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    apiKey: optionalSecretSchema,
    clearApiKey: z.boolean().default(false),
    generationModel: z.string().trim().min(1).max(180).nullable().optional(),
    maxParallelCalls: z.number().int().min(1).max(32).optional(),
    requestsPerMinute: z.number().int().min(1).max(60_000).nullable().optional(),
    tokensPerMinute: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  })
  .strict()
  .refine(({ apiKey, clearApiKey }) => apiKey === undefined || !clearApiKey, {
    message: 'A key cannot be replaced and cleared in the same request.',
  });

const testGenerationSchema = z
  .object({
    apiKey: optionalSecretSchema,
    model: z.string().trim().min(1).max(180).optional(),
  })
  .strict();
const testCredentialSchema = z.object({ apiKey: optionalSecretSchema }).strict();

interface ProviderRow {
  readonly id: unknown;
  readonly provider_kind: 'ollama_cloud' | 'openai_oauth';
  readonly label: string;
  readonly service_root: string | null;
  readonly enabled: boolean;
  readonly credential_secret_id: unknown | null;
  readonly generation_model: string | null;
  readonly max_parallel_calls: number;
  readonly requests_per_minute: number | null;
  readonly tokens_per_minute: number | null;
  readonly metadata: Record<string, unknown>;
  readonly fingerprint: string | null;
  readonly updated_at: Date;
}

interface CapabilityRow {
  readonly connection_id: unknown;
  readonly capability: OllamaCloudCapability | 'model_catalog';
  readonly status: 'untested' | 'healthy' | 'failed' | 'disabled';
  readonly latency_ms: number | null;
  readonly safe_error_code: string | null;
  readonly metadata: Record<string, unknown>;
  readonly tested_at: Date | null;
}

interface ModelProfileRow {
  readonly connection_id: unknown;
  readonly model: string;
  readonly display_name: string;
  readonly reasoning_efforts: string[];
  readonly advertised_context_tokens: number | null;
  readonly configured_context_tokens: number | null;
  readonly runtime_context_tokens: number | null;
  readonly maximum_output_tokens: number | null;
  readonly context_provenance: ChatModelProfile['contextProvenance'];
  readonly provenance_note: string | null;
  readonly checked_at: Date | null;
  readonly provider_metadata: Record<string, unknown>;
}

interface WebUsageRow {
  readonly connection_id: unknown;
  readonly current_minute_requests: unknown;
  readonly requests_last_24_hours: unknown;
  readonly active_minutes_last_24_hours: unknown;
  readonly last_request_at: Date | null;
}

class ChatProviderRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ChatProviderRouteError';
  }
}

export interface ChatProviderRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly secretVault?: SecretVault;
  readonly enabled: boolean;
  readonly createOllamaClient?: (apiKey: string) => OllamaCloudAdminClient;
}

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

const requireAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatProviderRoutesOptions,
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
  const value = request.headers['idempotency-key']?.toString();
  if (value === undefined) throw new ChatProviderRouteError(400, 'idempotency_key_required');
  return value;
};

const routeFailure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatProviderRouteError)
    return sendProblem(reply, error.status, error.code, request.id);
  if (error instanceof IdempotencyConflictError)
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.')
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  throw error;
};

const readProviderRows = async (database: SqlClient): Promise<ProviderRow[]> => {
  const result = await database.query<ProviderRow>(
    `SELECT connection.id, connection.provider_kind, connection.label,
            connection.service_root, connection.enabled, connection.credential_secret_id,
            connection.generation_model, connection.max_parallel_calls,
            connection.requests_per_minute, connection.tokens_per_minute,
            connection.metadata, secret.fingerprint, connection.updated_at
     FROM noderag.chat_provider_connection connection
     LEFT JOIN noderag.encrypted_secret secret ON secret.id=connection.credential_secret_id
     ORDER BY connection.provider_kind`,
  );
  return result.rows;
};

const readCapabilityRows = async (database: SqlClient): Promise<CapabilityRow[]> => {
  const result = await database.query<CapabilityRow>(
    `SELECT connection_id, capability, status, latency_ms, safe_error_code, metadata, tested_at
     FROM noderag.chat_provider_capability
     ORDER BY connection_id, capability`,
  );
  return result.rows;
};

const readModelProfileRows = async (database: SqlClient): Promise<ModelProfileRow[]> => {
  const result = await database.query<ModelProfileRow>(
    `SELECT connection_id, model, display_name, reasoning_efforts,
            advertised_context_tokens, configured_context_tokens, runtime_context_tokens,
            maximum_output_tokens, context_provenance, provenance_note,
            provider_metadata, checked_at
     FROM noderag.chat_model_profile
     ORDER BY connection_id, lower(model)`,
  );
  return result.rows;
};

const readWebUsageRows = async (database: SqlClient): Promise<WebUsageRow[]> => {
  const result = await database.query<WebUsageRow>(
    `SELECT connection.id AS connection_id,
            coalesce(sum(usage.request_count) FILTER (
              WHERE usage.minute_start=date_trunc('minute',now())
            ),0)::text AS current_minute_requests,
            coalesce(sum(usage.request_count) FILTER (
              WHERE usage.minute_start >= date_trunc('minute',now()) - interval '24 hours'
            ),0)::text AS requests_last_24_hours,
            count(usage.minute_start) FILTER (
              WHERE usage.minute_start >= date_trunc('minute',now()) - interval '24 hours'
            )::text AS active_minutes_last_24_hours,
            max(usage.updated_at) AS last_request_at
     FROM noderag.chat_provider_connection AS connection
     LEFT JOIN noderag.chat_web_usage_minute AS usage ON usage.connection_id=connection.id
     WHERE connection.provider_kind='ollama_cloud'
     GROUP BY connection.id`,
  );
  return result.rows;
};

const providerResponse = async (database: SqlClient) => {
  // Idempotent mutations pass a single checked-out PostgreSQL client here, so keep
  // these reads sequential instead of attempting overlapping queries on that client.
  const providers = await readProviderRows(database);
  const capabilities = await readCapabilityRows(database);
  const modelProfiles = await readModelProfileRows(database);
  const webUsage = await readWebUsageRows(database);
  return {
    providers: providers.map((provider) => {
      const id = databaseInteger(provider.id, 'chat provider connection id');
      return {
        provider: provider.provider_kind,
        label: provider.label,
        serviceRoot: provider.service_root,
        serviceRootEditable: false,
        enabled: provider.enabled,
        credential: {
          configured: provider.credential_secret_id !== null,
          fingerprint: provider.fingerprint,
        },
        generationModel: provider.generation_model,
        limits: {
          maxParallelCalls: provider.max_parallel_calls,
          requestsPerMinute: provider.requests_per_minute,
          tokensPerMinute: provider.tokens_per_minute,
        },
        webToolUsage:
          provider.provider_kind === 'ollama_cloud'
            ? (() => {
                const usage = webUsage.find(
                  (item) => databaseInteger(item.connection_id, 'connection id') === id,
                );
                return {
                  requestsThisMinute:
                    usage === undefined
                      ? 0
                      : databaseInteger(usage.current_minute_requests, 'current web requests'),
                  requestsLast24Hours:
                    usage === undefined
                      ? 0
                      : databaseInteger(usage.requests_last_24_hours, '24 hour web requests'),
                  activeMinutesLast24Hours:
                    usage === undefined
                      ? 0
                      : databaseInteger(
                          usage.active_minutes_last_24_hours,
                          '24 hour active web minutes',
                        ),
                  lastRequestAt: usage?.last_request_at ?? null,
                };
              })()
            : null,
        metadata: provider.metadata,
        capabilities: capabilities
          .filter((capability) => databaseInteger(capability.connection_id, 'connection id') === id)
          .map((capability) => ({
            capability: capability.capability,
            status: capability.status,
            latencyMs: capability.latency_ms,
            errorCode: capability.safe_error_code,
            metadata: capability.metadata,
            testedAt: capability.tested_at,
          })),
        models: modelProfiles
          .filter((profile) => databaseInteger(profile.connection_id, 'connection id') === id)
          .map((profile) => ({
            model: profile.model,
            displayName: profile.display_name,
            reasoningEfforts: profile.reasoning_efforts,
            advertisedContextTokens: profile.advertised_context_tokens,
            configuredContextTokens: profile.configured_context_tokens,
            runtimeContextTokens: profile.runtime_context_tokens,
            maximumOutputTokens: profile.maximum_output_tokens,
            contextProvenance: profile.context_provenance,
            provenanceNote: profile.provenance_note,
            providerMetadata: profile.provider_metadata,
            checkedAt: profile.checked_at,
          })),
        updatedAt: provider.updated_at,
      };
    }),
  };
};

const ollamaConnection = async (database: SqlClient, lock = false): Promise<ProviderRow> => {
  const result = await database.query<ProviderRow>(
    `SELECT connection.id, connection.provider_kind, connection.label,
            connection.service_root, connection.enabled, connection.credential_secret_id,
            connection.generation_model, connection.max_parallel_calls,
            connection.requests_per_minute, connection.tokens_per_minute,
            connection.metadata, secret.fingerprint, connection.updated_at
     FROM noderag.chat_provider_connection connection
     LEFT JOIN noderag.encrypted_secret secret ON secret.id=connection.credential_secret_id
     WHERE connection.provider_kind='ollama_cloud'
     ${lock ? 'FOR UPDATE OF connection' : ''}`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatProviderRouteError(503, 'chat_provider_unavailable');
  if (row.service_root !== OLLAMA_CLOUD_SERVICE_ROOT) {
    throw new ChatProviderRouteError(503, 'ollama_cloud_service_root_invalid');
  }
  return row;
};

const storedOllamaKey = async (
  database: SqlClient,
  options: ChatProviderRoutesOptions,
): Promise<string> => {
  if (options.secretVault === undefined)
    throw new ChatProviderRouteError(503, 'secret_vault_unavailable');
  const key = await options.secretVault.reveal(database, 'ollama_cloud', 'api-key');
  if (key === null) throw new ChatProviderRouteError(422, 'ollama_cloud_key_required');
  return key;
};

const recordCapability = async (
  database: SqlClient,
  connectionId: number,
  capability: OllamaCloudCapability | 'model_catalog',
  input:
    | { readonly status: 'healthy'; readonly result: OllamaCloudTestResult; readonly key: string }
    | { readonly status: 'failed'; readonly code: string; readonly key: string },
  options: ChatProviderRoutesOptions,
): Promise<void> => {
  const fingerprint = options.secretVault?.fingerprint(input.key) ?? null;
  await database.query(
    `UPDATE noderag.chat_provider_capability
     SET status=$3, latency_ms=$4, safe_error_code=$5, metadata=$6,
         tested_at=now(), updated_at=now()
     WHERE connection_id=$1 AND capability=$2`,
    [
      connectionId,
      capability,
      input.status,
      input.status === 'healthy' ? input.result.latencyMs : null,
      input.status === 'failed' ? input.code : null,
      {
        credentialFingerprint: fingerprint,
        ...(input.status === 'healthy' ? input.result.metadata : {}),
      },
    ],
  );
};

const runTest = async (
  database: SqlClient,
  options: ChatProviderRoutesOptions,
  capability: OllamaCloudCapability,
  apiKey: string | undefined,
  invoke: (client: OllamaCloudAdminClient) => Promise<OllamaCloudTestResult>,
): Promise<
  | { readonly ok: true; readonly result: OllamaCloudTestResult }
  | { readonly ok: false; readonly code: string; readonly retryable: boolean }
> => {
  const connection = await ollamaConnection(database);
  const connectionId = databaseInteger(connection.id, 'chat provider connection id');
  const key = apiKey ?? (await storedOllamaKey(database, options));
  const client = (
    options.createOllamaClient ?? ((value) => new OllamaCloudAdminClient({ apiKey: value }))
  )(key);
  try {
    const result = await invoke(client);
    await recordCapability(
      database,
      connectionId,
      capability,
      { status: 'healthy', result, key },
      options,
    );
    return { ok: true, result };
  } catch (error) {
    const code = error instanceof OllamaCloudError ? error.code : 'ollama_cloud_test_failed';
    const retryable = error instanceof OllamaCloudError && error.retryable;
    await recordCapability(
      database,
      connectionId,
      capability,
      { status: 'failed', code, key },
      options,
    );
    return { ok: false, code, retryable };
  }
};

const replaceModelProfiles = async (
  database: SqlClient,
  connectionId: number,
  profiles: readonly ChatModelProfile[],
  principalId: number,
): Promise<void> => {
  await database.query(
    `UPDATE noderag.chat_model_profile
     SET provider_metadata=provider_metadata || '{"catalogStale":true}'::jsonb,updated_at=now()
     WHERE connection_id=$1`,
    [connectionId],
  );
  const unique = new Map(profiles.map((profile) => [profile.model, profile]));
  for (const profile of unique.values()) {
    await database.query(
      `INSERT INTO noderag.chat_model_profile
         (connection_id, model, display_name, reasoning_efforts,
          advertised_context_tokens, configured_context_tokens, runtime_context_tokens,
          maximum_output_tokens, context_provenance, provenance_note, provider_metadata,
          checked_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{"catalogStale":false}'::jsonb,$11,$12)
       ON CONFLICT (connection_id,model) DO UPDATE SET
         display_name=EXCLUDED.display_name,reasoning_efforts=EXCLUDED.reasoning_efforts,
         advertised_context_tokens=EXCLUDED.advertised_context_tokens,
         configured_context_tokens=EXCLUDED.configured_context_tokens,
         runtime_context_tokens=EXCLUDED.runtime_context_tokens,
         maximum_output_tokens=EXCLUDED.maximum_output_tokens,
         context_provenance=EXCLUDED.context_provenance,
         provider_metadata=EXCLUDED.provider_metadata,checked_at=EXCLUDED.checked_at,
         updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [
        connectionId,
        profile.model,
        profile.displayName,
        profile.reasoningEfforts,
        profile.advertisedContextTokens,
        profile.configuredContextTokens,
        profile.runtimeContextTokens,
        profile.maximumOutputTokens,
        profile.contextProvenance,
        profile.contextProvenance === 'provider_metadata'
          ? 'Ollama Cloud model metadata was queried from /api/show and runtime allocation from /api/ps.'
          : 'Ollama Cloud did not advertise a context window for this model.',
        profile.checkedAt,
        principalId,
      ],
    );
  }
};

export const registerChatProviderRoutes = (
  app: FastifyInstance,
  options: ChatProviderRoutesOptions,
): void => {
  app.get('/v1/admin/chat/providers', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, false);
    if (principal === null) return;
    return reply.send(await providerResponse(options.pool));
  });

  app.put('/v1/admin/chat/providers/ollama-cloud', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const body = updateOllamaCloudSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const fingerprint =
        body.data.apiKey === undefined || options.secretVault === undefined
          ? null
          : options.secretVault.fingerprint(body.data.apiKey);
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-ollama-cloud-update',
          key: idempotencyKey(request),
          request: JSON.stringify({ ...body.data, apiKey: fingerprint }),
        },
        async (database) => {
          const current = await ollamaConnection(database, true);
          let secretId =
            current.credential_secret_id === null
              ? null
              : databaseInteger(current.credential_secret_id, 'chat provider secret id');
          let credentialChanged = false;
          if (body.data.clearApiKey) {
            if (options.secretVault === undefined)
              throw new ChatProviderRouteError(503, 'secret_vault_unavailable');
            await options.secretVault.remove(database, 'ollama_cloud', 'api-key');
            secretId = null;
            credentialChanged = true;
          } else if (body.data.apiKey !== undefined) {
            if (options.secretVault === undefined)
              throw new ChatProviderRouteError(503, 'secret_vault_unavailable');
            await options.secretVault.store(
              database,
              'ollama_cloud',
              'api-key',
              body.data.apiKey,
              principal.principalId,
            );
            const stored = await database.query<{ id: unknown }>(
              `SELECT id FROM noderag.encrypted_secret
               WHERE provider='ollama_cloud' AND name='api-key'`,
            );
            const id = stored.rows[0]?.id;
            if (id === undefined) throw new ChatProviderRouteError(503, 'secret_vault_unavailable');
            secretId = databaseInteger(id, 'chat provider secret id');
            credentialChanged = true;
          }
          const enabled = body.data.enabled ?? current.enabled;
          const model =
            body.data.generationModel === undefined
              ? current.generation_model
              : body.data.generationModel;
          if (enabled && secretId === null)
            throw new ChatProviderRouteError(422, 'ollama_cloud_key_required');
          if (enabled && model === null)
            throw new ChatProviderRouteError(422, 'ollama_cloud_model_required');
          const modelChanged = model !== current.generation_model;
          const enabledChanged = enabled !== current.enabled;
          await database.query(
            `UPDATE noderag.chat_provider_connection
             SET label=COALESCE($2,label), enabled=$3, credential_secret_id=$4,
                 generation_model=$5, max_parallel_calls=COALESCE($6,max_parallel_calls),
                 requests_per_minute=CASE WHEN $7::boolean THEN $8 ELSE requests_per_minute END,
                 tokens_per_minute=CASE WHEN $9::boolean THEN $10 ELSE tokens_per_minute END,
                 updated_at=now(), updated_by=$11
             WHERE id=$1`,
            [
              databaseInteger(current.id, 'chat provider connection id'),
              body.data.label ?? null,
              enabled,
              secretId,
              model,
              body.data.maxParallelCalls ?? null,
              body.data.requestsPerMinute !== undefined,
              body.data.requestsPerMinute ?? null,
              body.data.tokensPerMinute !== undefined,
              body.data.tokensPerMinute ?? null,
              principal.principalId,
            ],
          );
          if (credentialChanged || modelChanged || enabledChanged) {
            await database.query(
              `UPDATE noderag.chat_provider_capability
               SET status=$2, latency_ms=NULL, safe_error_code=NULL, metadata='{}'::jsonb,
                   tested_at=NULL, updated_at=now()
               WHERE connection_id=$1`,
              [
                databaseInteger(current.id, 'chat provider connection id'),
                enabled ? 'untested' : 'disabled',
              ],
            );
          }
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.provider.ollama_cloud.updated',
            result: 'ok',
            requestId: request.id,
            detail: {
              enabled,
              modelConfigured: model !== null,
              credentialConfigured: secretId !== null,
              credentialChanged,
            },
          });
          return { status: 200, headers: {}, body: await providerResponse(database) };
        },
      );
      request.log.info(
        {
          event: 'chat-provider-configuration-updated',
          provider: 'ollama_cloud',
          enabled: body.data.enabled,
          credentialAction: body.data.clearApiKey
            ? 'cleared'
            : body.data.apiKey === undefined
              ? 'retained'
              : 'replaced',
        },
        'Ollama Cloud Chat provider configuration updated',
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/providers/ollama-cloud/disable', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const body = z
      .object({})
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-ollama-cloud-disable',
          key: idempotencyKey(request),
          request: '{}',
        },
        async (database) => {
          const connection = await ollamaConnection(database, true);
          const connectionId = databaseInteger(connection.id, 'chat provider connection id');
          await database.query(
            `UPDATE noderag.chat_provider_connection
             SET enabled=false, updated_at=now(), updated_by=$2
             WHERE id=$1`,
            [connectionId, principal.principalId],
          );
          await database.query(
            `UPDATE noderag.chat_provider_capability
             SET status='disabled', latency_ms=NULL, safe_error_code=NULL,
                 metadata='{}'::jsonb, tested_at=NULL, updated_at=now()
             WHERE connection_id=$1`,
            [connectionId],
          );
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.provider.ollama_cloud.disabled',
            result: 'ok',
            requestId: request.id,
            detail: { credentialRetained: connection.credential_secret_id !== null },
          });
          return { status: 200, headers: {}, body: await providerResponse(database) };
        },
      );
      request.log.info(
        {
          event: 'chat-provider-disabled',
          provider: 'ollama_cloud',
        },
        'Ollama Cloud Chat provider disabled',
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/chat/providers/ollama-cloud/refresh-models', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const body = testCredentialSchema.safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const candidateKey = body.data.apiKey;
      const connection = await ollamaConnection(options.pool);
      const keyForDigest =
        candidateKey === undefined
          ? connection.fingerprint
          : (options.secretVault?.fingerprint(candidateKey) ?? 'candidate');
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-ollama-cloud-refresh-models',
          key: idempotencyKey(request),
          request: JSON.stringify({ credentialFingerprint: keyForDigest }),
        },
        async (database) => {
          const current = await ollamaConnection(database);
          const connectionId = databaseInteger(current.id, 'chat provider connection id');
          const key = candidateKey ?? (await storedOllamaKey(database, options));
          const client = (
            options.createOllamaClient ?? ((value) => new OllamaCloudAdminClient({ apiKey: value }))
          )(key);
          try {
            const started = performance.now();
            const profiles = await client.listModels(new AbortController().signal);
            await replaceModelProfiles(database, connectionId, profiles, principal.principalId);
            const capabilityResult: OllamaCloudTestResult = {
              capability: 'model_catalog',
              latencyMs: Math.max(0, Math.round(performance.now() - started)),
              metadata: { modelCount: profiles.length },
            };
            await recordCapability(
              database,
              connectionId,
              'model_catalog',
              { status: 'healthy', result: capabilityResult, key },
              options,
            );
            await writeAuditEvent(database, {
              principalId: principal.principalId,
              action: 'chat.provider.ollama_cloud.model_catalog.refreshed',
              result: 'ok',
              requestId: request.id,
              detail: { modelCount: profiles.length },
            });
            return {
              status: 200,
              headers: {},
              body: {
                ok: true,
                modelCount: profiles.length,
                ...(await providerResponse(database)),
              },
            };
          } catch (error) {
            const code =
              error instanceof OllamaCloudError ? error.code : 'ollama_cloud_model_catalog_failed';
            const retryable = error instanceof OllamaCloudError && error.retryable;
            await recordCapability(
              database,
              connectionId,
              'model_catalog',
              { status: 'failed', code, key },
              options,
            );
            await writeAuditEvent(database, {
              principalId: principal.principalId,
              action: 'chat.provider.ollama_cloud.model_catalog.refreshed',
              result: 'error',
              requestId: request.id,
              detail: { errorCode: code, retryable },
            });
            return {
              status: 422,
              headers: {},
              body: problem(422, code, request.id),
            };
          }
        },
      );
      const responseBody = result.response.body as Record<string, unknown>;
      const logDetail = {
        event:
          result.response.status < 400
            ? 'chat-provider-model-catalog-refreshed'
            : 'chat-provider-model-catalog-failed',
        provider: 'ollama_cloud',
        capability: 'model_catalog',
        ...(typeof responseBody['modelCount'] === 'number'
          ? { modelCount: responseBody['modelCount'] }
          : {}),
        ...(typeof responseBody['code'] === 'string' ? { code: responseBody['code'] } : {}),
      };
      if (result.response.status < 400) {
        request.log.info(logDetail, 'Ollama Cloud model catalog refreshed');
      } else {
        request.log.warn(logDetail, 'Ollama Cloud model catalog refresh failed');
      }
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  const registerCapabilityTest = (
    path: string,
    operation: string,
    capability: OllamaCloudCapability,
    schema: typeof testCredentialSchema | typeof testGenerationSchema,
    invoke: (
      client: OllamaCloudAdminClient,
      body: { readonly model?: string },
    ) => Promise<OllamaCloudTestResult>,
  ): void => {
    app.post(path, async (request, reply) => {
      const principal = await requireAdmin(request, reply, options, true);
      if (principal === null) return;
      const body = schema.safeParse(request.body ?? {});
      if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
      try {
        const parsedBody = body.data as { readonly apiKey?: string; readonly model?: string };
        const candidateKey = parsedBody.apiKey;
        const connection = await ollamaConnection(options.pool);
        const selectedModel =
          parsedBody.model === undefined ? connection.generation_model : parsedBody.model;
        if (capability === 'generation' && selectedModel === null) {
          throw new ChatProviderRouteError(422, 'ollama_cloud_model_required');
        }
        const keyForDigest =
          candidateKey === undefined
            ? connection.fingerprint
            : (options.secretVault?.fingerprint(candidateKey) ?? 'candidate');
        const result = await executeIdempotent(
          options.pool,
          {
            principalId: principal.principalId,
            operation,
            key: idempotencyKey(request),
            request: JSON.stringify({
              capability,
              model: selectedModel,
              credentialFingerprint: keyForDigest,
            }),
          },
          async (database) => {
            const outcome = await runTest(database, options, capability, candidateKey, (client) =>
              invoke(client, { ...(selectedModel === null ? {} : { model: selectedModel }) }),
            );
            await writeAuditEvent(database, {
              principalId: principal.principalId,
              action: `chat.provider.ollama_cloud.${capability}.tested`,
              result: outcome.ok ? 'ok' : 'error',
              requestId: request.id,
              detail: {
                capability,
                retryable: outcome.ok ? false : outcome.retryable,
                errorCode: outcome.ok ? null : outcome.code,
              },
            });
            return outcome.ok
              ? { status: 200, headers: {}, body: { ok: true, ...outcome.result } }
              : {
                  status: 422,
                  headers: {},
                  body: problem(422, outcome.code, request.id),
                };
          },
        );
        const responseBody = result.response.body as Record<string, unknown>;
        const logDetail = {
          event:
            result.response.status < 400
              ? 'chat-provider-capability-tested'
              : 'chat-provider-capability-failed',
          provider: 'ollama_cloud',
          capability,
          ...(typeof responseBody['latencyMs'] === 'number'
            ? { latencyMs: responseBody['latencyMs'] }
            : {}),
          ...(typeof responseBody['code'] === 'string' ? { code: responseBody['code'] } : {}),
        };
        if (result.response.status < 400) {
          request.log.info(logDetail, 'Ollama Cloud capability test passed');
        } else {
          request.log.warn(logDetail, 'Ollama Cloud capability test failed');
        }
        return reply.code(result.response.status).send(result.response.body);
      } catch (error) {
        return routeFailure(reply, request, error);
      }
    });
  };

  registerCapabilityTest(
    '/v1/admin/chat/providers/ollama-cloud/test-generation',
    'chat-ollama-cloud-test-generation',
    'generation',
    testGenerationSchema,
    (client, body) => {
      if (body.model === undefined)
        throw new ChatProviderRouteError(422, 'ollama_cloud_model_required');
      return client.testGeneration(body.model, new AbortController().signal);
    },
  );
  registerCapabilityTest(
    '/v1/admin/chat/providers/ollama-cloud/test-web-search',
    'chat-ollama-cloud-test-web-search',
    'web_search',
    testCredentialSchema,
    (client) => client.testWebSearch(new AbortController().signal),
  );
  registerCapabilityTest(
    '/v1/admin/chat/providers/ollama-cloud/test-web-fetch',
    'chat-ollama-cloud-test-web-fetch',
    'web_fetch',
    testCredentialSchema,
    (client) => client.testWebFetch(new AbortController().signal),
  );
};
