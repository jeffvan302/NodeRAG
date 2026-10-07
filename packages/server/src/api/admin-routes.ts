import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EmbedderRuntimeStatus } from '@noderag/shared';
import { z } from 'zod';
import { createApiKeyInTransaction, revokeApiKey } from '../identity/api-keys.js';
import { hashPassword } from '../identity/passwords.js';
import { createSiloInTransaction, setSiloCapability } from '../store/silos.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import type { ContentRoutesOptions } from './content-routes.js';
import { RequestAuthenticationError, type AuthenticatedPrincipal } from './authentication.js';
import { CalibrationJobRegistry, type CalibrationJobPhase } from './calibration-jobs.js';
import { sendProblem } from './problem.js';
import { coordinatedEmbedder } from '../store/resources.js';
import { CURRENT_SCHEMA_REVISION } from '../store/schema-revision.js';
import { probeStorage, storageProbeProblemCode } from '../storage/probe.js';
import { downloadModelArtifact, importModelArtifact } from '../storage/model-artifacts.js';
import { DefaultModelInstaller } from '../storage/default-model.js';
import {
  activateVerifiedBuild,
  authorizeBuildCleanup,
  changeBuildState,
  confirmRebuildProposal,
  createRebuildProposal,
  discardBuildCheckpoints,
  rollbackBuildActivation,
  runAuthorizedBuildCleanup,
  verifyStagedSilo,
} from '../store/rebuilds.js';
import { nextBackupScheduleAt } from '../recovery/schedule.js';

const idSchema = z.coerce.number().int().positive().safe();
const smallIdSchema = z.coerce.number().int().min(1).max(32_767);
const cursorQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const siloCreateSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    displayName: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  })
  .strict();
const siloPatchSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const principalCreateSchema = z
  .object({
    username: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
    password: z.string().min(12).max(1024),
    email: z.string().email().optional(),
    label: z.string().min(1).max(160).optional(),
    serverAdmin: z.boolean().default(false),
    mustChange: z.boolean().default(true),
  })
  .strict();
const principalPatchSchema = z
  .object({
    label: z.string().min(1).max(160).optional(),
    email: z.string().email().nullable().optional(),
    disabled: z.boolean().optional(),
    serverAdmin: z.boolean().optional(),
    mustChange: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const apiKeySchema = z
  .object({
    label: z.string().min(1).max(160),
    searchOnly: z.boolean().default(true),
    expiresAt: z.coerce.date().optional(),
    cidrAllow: z.array(z.string().min(1).max(80)).max(64).optional(),
    ratePerMinute: z.number().int().min(1).max(60_000).optional(),
  })
  .strict();
const gatewaySchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,63}$/),
    port: z.number().int().min(5300).max(5319).nullable().default(null),
    siloIds: z.array(smallIdSchema).max(64).default([]),
    requireAuth: z.literal(true).default(true),
    enabled: z.boolean().default(false),
  })
  .strict();
const gatewayPatchSchema = gatewaySchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const settingsSchema = z
  .object({
    targetChars: z.number().int().min(200).max(8000).optional(),
    overlapChars: z.number().int().min(0).max(4000).optional(),
    maxTokens: z.number().int().min(128).max(2048).optional(),
    snapWindow: z.number().min(0).max(0.5).optional(),
    headingPrefix: z.boolean().optional(),
    embedThreads: z.number().int().min(1).max(32).optional(),
    ingestThreads: z.number().int().min(1).max(16).optional(),
    throttleWhenBusy: z.boolean().optional(),
    defaultMode: z.enum(['vector', 'keyword', 'hybrid']).optional(),
    efSearch: z.number().int().min(1).max(2000).optional(),
    auditRetentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

interface RuntimeControllableEmbedder {
  runtimeStatus(): Promise<EmbedderRuntimeStatus>;
  configureThreads(threads: number): Promise<EmbedderRuntimeStatus>;
}

const runtimeController = (
  embedder: ContentRoutesOptions['embedder'],
): Partial<RuntimeControllableEmbedder> => embedder as Partial<RuntimeControllableEmbedder>;

const localProcessorLimit = (): number => Math.min(32, Math.max(1, availableParallelism()));

const fallbackEmbeddingThreads = (): number => {
  const configured = Number(process.env['NODERAG_EMBED_THREADS'] ?? '4');
  return Number.isSafeInteger(configured)
    ? Math.min(localProcessorLimit(), Math.max(1, configured))
    : Math.min(localProcessorLimit(), 4);
};

const currentRuntimeStatus = async (
  embedder: ContentRoutesOptions['embedder'],
): Promise<EmbedderRuntimeStatus | null> => {
  const operation = runtimeController(embedder).runtimeStatus?.();
  if (operation === undefined) return null;
  try {
    return await operation;
  } catch {
    return null;
  }
};

const settingsRuntime = (
  configuredThreads: number,
  status: EmbedderRuntimeStatus | null,
  applyStatus: 'active' | 'reloaded' | 'pending' = 'active',
) => {
  const availableProcessors = status?.availableProcessors ?? availableParallelism();
  const activeEmbeddingThreads = status?.threads ?? fallbackEmbeddingThreads();
  return {
    availableProcessors,
    maximumEmbeddingThreads: Math.min(32, availableProcessors),
    activeEmbeddingThreads,
    configuredEmbeddingThreads: configuredThreads,
    pendingRestart: activeEmbeddingThreads !== configuredThreads,
    generation: status?.generation ?? 0,
    controlAvailable: status !== null,
    applyStatus,
  };
};
const modelSchema = z
  .object({
    name: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    tokenizerRevision: z.string().min(1).max(200),
    quantization: z.string().min(1).max(40),
    dimensions: z.number().int().min(1).max(16_000),
    maximumTokens: z.number().int().min(128).max(32768),
    pooling: z.literal('last_token'),
    normalization: z.literal('l2'),
    queryPrefix: z.string().max(4000),
    documentPrefix: z.literal('').default(''),
    license: z.string().min(1).max(200),
  })
  .strict();
const buildSchema = z
  .object({
    modelManifestId: smallIdSchema.optional(),
    reason: z.string().min(1).max(1000),
    targetChars: z.number().int().min(200).max(8000).optional(),
    overlapChars: z.number().int().min(0).max(4000).optional(),
    maxTokens: z.number().int().min(128).max(2048).optional(),
    snapWindow: z.number().min(0).max(0.5).optional(),
    headingPrefix: z.boolean().optional(),
    siloIds: z.array(smallIdSchema).min(1).max(64).optional(),
    embeddingCharactersPerSecond: z.number().positive().max(10_000_000).default(1500),
  })
  .strict();
const buildPatchSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();
const buildConfirmSchema = z.object({ confirm: z.literal(true) }).strict();
const buildVerifySchema = z.object({ siloId: smallIdSchema }).strict();
const buildActivateSchema = z.object({ siloIds: z.array(smallIdSchema).min(1).max(64) }).strict();
const destructiveConfirmationSchema = z
  .object({ confirmation: z.string().min(1).max(200) })
  .strict();
const storageSchema = z
  .object({
    name: z.string().min(1).max(120),
    managedPath: z.string().min(1).max(4096),
    purpose: z.enum(['documents', 'backup', 'temporary']),
    enabled: z.boolean().default(true),
  })
  .strict();
const storagePatchSchema = storageSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const storageProbeSchema = z.object({ managedPath: z.string().min(1).max(4096) }).strict();
const modelDownloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    urls: z.array(z.string().url()).min(1).max(4),
  })
  .strict();
const modelImportSchema = z
  .object({
    name: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePath: z.string().min(1).max(4096),
  })
  .strict();
const calibrationSchema = z
  .object({
    samples: z.array(z.string().min(20).max(8000)).length(20).optional(),
  })
  .strict();
const setupProgressSchema = z
  .object({
    step: z.enum(['storage', 'model', 'calibration', 'vision', 'sources', 'complete']),
    progress: z.number().int().min(30).max(100),
  })
  .strict();
const backupSchema = z.union([
  z
    .object({
      action: z.literal('run').default('run'),
      destinationId: smallIdSchema,
      product: z.enum(['full', 'portable']).default('full'),
      passphrase: z.string().min(12).max(1024),
      includeModels: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal('schedule'),
      name: z.string().min(1).max(120),
      destinationId: smallIdSchema,
      product: z.enum(['full', 'portable']).default('full'),
      passphrase: z.string().min(12).max(1024),
      cadence: z.enum(['daily', 'weekly']),
      utcHour: z.number().int().min(0).max(23),
      utcMinute: z.number().int().min(0).max(59),
      utcWeekday: z.number().int().min(0).max(6).nullable().default(null),
      retainCount: z.number().int().min(1).max(365).default(7),
      enabled: z.boolean().default(false),
    })
    .strict()
    .refine(
      (value) =>
        (value.cadence === 'daily' && value.utcWeekday === null) ||
        (value.cadence === 'weekly' && value.utcWeekday !== null),
      { message: 'backup_schedule_weekday_invalid' },
    ),
]);
const restoreSchema = z.union([
  z
    .object({
      action: z.literal('restore_full').default('restore_full'),
      backupId: idSchema,
      passphrase: z.string().min(12).max(1024),
      confirmation: z.literal('RESTORE THIS INSTALLATION'),
    })
    .strict(),
  z
    .object({
      action: z.literal('import_portable'),
      backupId: idSchema,
      destinationSiloId: smallIdSchema,
      passphrase: z.string().min(12).max(1024),
      confirmation: z.literal('IMPORT PORTABLE CORPUS'),
    })
    .strict(),
]);
const evaluationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add_case'),
      externalId: z.string().min(1).max(120),
      siloId: smallIdSchema,
      query: z.string().min(1).max(4000),
      queryClass: z
        .enum([
          'semantic',
          'exact_identifier',
          'exact_name',
          'error_code',
          'quoted_phrase',
          'cross_page',
          'table',
          'vision',
          'multilingual',
          'unicode',
        ])
        .default('semantic'),
      expectedFormat: z.enum(['pdf', 'docx', 'xlsx', 'txt', 'md']).optional(),
      answerable: z.boolean().default(true),
      relevant: z
        .array(
          z
            .object({
              document: z.string().min(1).max(1024),
              sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              pages: z.array(z.number().int().min(1)).min(1).max(100).optional(),
              sheets: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
            })
            .strict()
            .refine((value) => value.pages === undefined || value.sheets === undefined),
        )
        .min(1),
      notes: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('queue_run'),
      modes: z
        .array(z.enum(['vector', 'keyword', 'hybrid']))
        .min(1)
        .max(3)
        .default(['vector', 'keyword', 'hybrid']),
      workload: z.enum(['idle', 'ingest']).default('idle'),
      environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_case_state'),
      caseId: idSchema,
      state: z.enum(['draft', 'approved', 'rejected']),
    })
    .strict(),
  z
    .object({
      action: z.literal('accept_baseline'),
      runId: idSchema,
    })
    .strict(),
]);

export interface GatewayControl {
  reconcile(): Promise<
    readonly {
      readonly id: number;
      readonly port: number;
      readonly status: 'bound' | 'conflict' | 'error';
      readonly error?: string;
    }[]
  >;
}

const mutationAllowed = (principal: AuthenticatedPrincipal, request: FastifyRequest): boolean =>
  principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin);

const requireAdmin = async (
  request: FastifyRequest,
  options: ContentRoutesOptions,
  mutation: boolean,
): Promise<AuthenticatedPrincipal | 'csrf' | null> => {
  const principal = await options.authenticate(request);
  if (principal === null) return null;
  if (!principal.serverAdmin) throw new RequestAuthenticationError(403, 'server_admin_required');
  if (mutation && !mutationAllowed(principal, request)) return 'csrf';
  return principal;
};

const probePort = async (port: number, host = '0.0.0.0'): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });

const calibrationSamples = Array.from({ length: 20 }, (_, index) =>
  `NodeRag calibration passage ${String(index + 1)}. This representative local knowledge text measures embedding throughput without retaining document content. `.repeat(
    12,
  ),
);

interface ActiveCalibrationModel {
  readonly maximum_tokens: number;
  readonly document_prefix: string;
  readonly name: string;
  readonly source_revision: string;
  readonly manifest_digest: string;
  readonly dimensions: number;
}

interface EmbeddingCalibrationResult {
  readonly chunks: number;
  readonly characters: number;
  readonly elapsedMs: number;
  readonly charactersPerSecond: number;
  readonly projectedMinutesPerMillionCharacters: number;
  readonly model: string;
  readonly revision: string;
}

const measureEmbeddingThroughput = async (
  options: ContentRoutesOptions,
  owner: string,
  active: ActiveCalibrationModel,
  samples: readonly string[],
  report: (phase: CalibrationJobPhase, progress: number) => void = () => undefined,
): Promise<EmbeddingCalibrationResult> => {
  const texts = samples.map((value) => `${active.document_prefix}${value.normalize('NFC')}`);
  const model = { manifestDigest: active.manifest_digest, dimensions: active.dimensions };
  const embedder = coordinatedEmbedder(options.pool, owner, options.embedder);

  report('loading-model', 5);
  await embedder.embed(
    [texts[0] ?? 'NodeRag embedding calibration warm-up.'],
    active.maximum_tokens,
    0,
    model,
  );

  const characters = samples.reduce((total, value) => total + value.length, 0);
  const started = performance.now();
  report('measuring', 10);
  const batchSize = 4;
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    await embedder.embed(texts.slice(offset, offset + batchSize), active.maximum_tokens, 0, model);
    report('measuring', 10 + (Math.min(texts.length, offset + batchSize) / texts.length) * 80);
  }
  report('finalizing', 95);
  const elapsedMs = Math.max(1, performance.now() - started);
  const charactersPerSecond = Math.round((characters * 1000) / elapsedMs);
  return {
    chunks: samples.length,
    characters,
    elapsedMs: Math.round(elapsedMs),
    charactersPerSecond,
    projectedMinutesPerMillionCharacters: Number(
      (1_000_000 / Math.max(1, charactersPerSecond) / 60).toFixed(1),
    ),
    model: active.name,
    revision: active.source_revision,
  };
};

const storageProbeOptions = () => {
  const splitRoots = (name: string): readonly string[] =>
    (process.env[name] ?? '')
      .split(process.platform === 'win32' ? ';' : ':')
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    policy:
      process.env['NODERAG_STORAGE_POLICY'] === 'dsm' ? ('dsm' as const) : ('testbed' as const),
    projectedBytes: BigInt(process.env['NODERAG_STORAGE_PROJECTED_BYTES'] ?? '0'),
    rebuildReserveBytes: BigInt(
      process.env['NODERAG_STORAGE_REBUILD_RESERVE_BYTES'] ?? String(10 * 1024 ** 3),
    ),
    encryptedRoots: splitRoots('NODERAG_ENCRYPTED_ROOTS'),
    requireEncrypted: process.env['NODERAG_REQUIRE_ENCRYPTED_STORAGE'] === '1',
    syncRoots: splitRoots('NODERAG_SYNC_ROOTS'),
    indexingRoots: splitRoots('NODERAG_INDEXING_ROOTS'),
  };
};

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key']?.toString();
  if (value === undefined) throw new Error('idempotency_key_required');
  return value;
};

const stableBody = (value: unknown): string => JSON.stringify(value);
const digestJson = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const mutate = async (
  request: FastifyRequest,
  principal: AuthenticatedPrincipal,
  options: ContentRoutesOptions,
  operation: string,
  body: unknown,
  work: (database: SqlClient) => Promise<{ readonly status: number; readonly body: unknown }>,
) =>
  executeIdempotent(
    options.pool,
    {
      principalId: principal.principalId,
      operation,
      key: idempotencyKey(request),
      request: stableBody(body),
    },
    async (database) => {
      const response = await work(database);
      return { status: response.status, headers: {}, body: response.body };
    },
  );

const mutationFailure = (
  reply: Parameters<typeof sendProblem>[0],
  request: FastifyRequest,
  error: unknown,
) => {
  if (error instanceof IdempotencyConflictError)
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  const message = error instanceof Error ? error.message : '';
  const known = new Map<string, { status: number; code: string }>([
    ['idempotency_key_required', { status: 400, code: 'idempotency_key_required' }],
    ['Invalid Idempotency-Key.', { status: 400, code: 'invalid_idempotency_key' }],
    ['Invalid silo partition id.', { status: 400, code: 'invalid_silo' }],
    ['unknown_silo', { status: 400, code: 'unknown_silo' }],
    ['overlap_exceeds_half_target', { status: 400, code: 'invalid_chunk_overlap' }],
    ['not_found', { status: 404, code: 'not_found' }],
    ['backup_not_found', { status: 404, code: 'backup_not_found' }],
    ['backup_destination_not_found', { status: 404, code: 'backup_destination_not_found' }],
    [
      'approved_evaluation_cases_missing',
      { status: 409, code: 'approved_evaluation_cases_missing' },
    ],
    ['evaluation_run_not_acceptable', { status: 409, code: 'evaluation_run_not_acceptable' }],
    ['build_not_mutable', { status: 409, code: 'build_not_mutable' }],
    ['storage_location_in_use', { status: 409, code: 'storage_location_in_use' }],
    ['setup_progress_regression', { status: 409, code: 'setup_progress_regression' }],
    ['server-admin-required', { status: 403, code: 'server_admin_required' }],
  ]).get(message);
  if (known !== undefined) return sendProblem(reply, known.status, known.code, request.id);
  const databaseCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const databaseConstraint =
    error instanceof Error && 'constraint' in error && typeof error.constraint === 'string'
      ? error.constraint
      : undefined;
  if (databaseCode === '23505') return sendProblem(reply, 409, 'conflict', request.id);
  if (databaseCode === '23503') return sendProblem(reply, 400, 'invalid_reference', request.id);
  request.log.error(
    {
      errorName: error instanceof Error ? error.name : 'unknown',
      databaseCode,
      databaseConstraint,
    },
    'administration mutation failed',
  );
  return sendProblem(reply, 500, 'mutation_failed', request.id);
};

const calibrationFailure = (error: unknown): { readonly status: number; readonly code: string } => {
  const message = error instanceof Error ? error.message : '';
  const operatingSystemCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (message === 'EMBEDDER_MODEL_FILES_MISSING')
    return { status: 409, code: 'embedding_model_not_installed' };
  if (message === 'EMBEDDER_MODEL_UNAVAILABLE')
    return { status: 409, code: 'embedding_model_restart_required' };
  if (message === 'TOKEN_LIMIT') return { status: 400, code: 'embedding_calibration_token_limit' };
  if (message === 'EMBEDDER_MODEL_LOAD_FAILED' || message === 'EMBEDDER_INVALID_OUTPUT')
    return { status: 503, code: 'embedding_model_load_failed' };
  if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(operatingSystemCode ?? ''))
    return { status: 503, code: 'embedding_worker_unavailable' };
  return { status: 503, code: 'embedding_calibration_failed' };
};

export const registerAdminRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
  gatewayControl?: GatewayControl,
): void => {
  const defaultModelInstaller = new DefaultModelInstaller({
    root: resolve(process.env['NODERAG_MODEL_ROOT'] ?? 'runtime-data/models'),
    allowedHosts: (
      process.env['NODERAG_MODEL_DOWNLOAD_HOSTS'] ??
      'huggingface.co,cdn-lfs.huggingface.co,cdn-lfs-us-1.hf.co,cas-bridge.xethub.hf.co,.aws.cdn.hf.co'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const calibrationJobs = new CalibrationJobRegistry<EmbeddingCalibrationResult>(
    (error) => calibrationFailure(error).code,
  );
  app.get('/v1/admin/silos', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(
        reply,
        principal === null ? 401 : 403,
        principal === null ? 'server_admin_required' : 'csrf_rejected',
        request.id,
      );
    const rows = await options.pool.query(
      `SELECT s.*, count(DISTINCT g.principal_id)::integer AS principal_count, count(DISTINCT d.id)::integer AS document_count FROM noderag.silo s LEFT JOIN noderag.silo_grant g ON g.silo_id=s.id LEFT JOIN noderag.document d ON d.silo_id=s.id GROUP BY s.id ORDER BY s.id`,
    );
    return reply.send({ items: rows.rows });
  });

  app.post('/v1/admin/silos', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const parsed = siloCreateSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-silo-create',
        parsed.data,
        async (database) => ({
          status: 201,
          body: await createSiloInTransaction(database, {
            slug: parsed.data.slug,
            displayName: parsed.data.displayName,
            ...(parsed.data.description === undefined
              ? {}
              : { description: parsed.data.description }),
            creatingPrincipalId: principal.principalId,
          }),
        }),
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.patch('/v1/admin/silos/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = siloPatchSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-silo-update:${String(id.data)}`,
        body.data,
        async (database) => {
          const updated = await database.query(
            `UPDATE noderag.silo SET display_name=COALESCE($2,display_name), description=CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id=$1 RETURNING id,slug,display_name AS "displayName",description`,
            [
              id.data,
              body.data.displayName ?? null,
              'description' in body.data,
              body.data.description ?? null,
            ],
          );
          if (updated.rows[0] === undefined) throw new Error('not_found');
          return { status: 200, body: updated.rows[0] };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/principals', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT p.id,p.kind,p.label,p.disabled,p.created_at AS "createdAt",p.deleted_at AS "deletedAt",u.username,u.email,u.server_admin AS "serverAdmin",u.must_change AS "mustChange",k.prefix,k.search_only AS "searchOnly",k.expires_at AS "expiresAt",k.rate_per_min AS "ratePerMinute",k.last_used_at AS "lastUsedAt",k.revoked_at AS "revokedAt" FROM noderag.principal p LEFT JOIN noderag.app_user u ON u.principal_id=p.id LEFT JOIN noderag.api_key k ON k.principal_id=p.id ORDER BY p.id`,
    );
    return reply.send({ items: rows.rows });
  });

  app.post('/v1/admin/principals', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = principalCreateSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const passwordHash = await hashPassword(body.data.password);
      const result = await mutate(
        request,
        principal,
        options,
        'admin-principal-create',
        body.data,
        async (database) => {
          const created = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.principal(kind,label,created_by) VALUES('user',$1,$2) RETURNING id`,
            [body.data.label ?? body.data.username, principal.principalId],
          );
          const id = databaseInteger(created.rows[0]?.id, 'principal id');
          await database.query(
            `INSERT INTO noderag.app_user(principal_id,username,email,password_hash,server_admin,must_change) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              id,
              body.data.username,
              body.data.email ?? null,
              passwordHash,
              body.data.serverAdmin,
              body.data.mustChange,
            ],
          );
          return { status: 201, body: { id, username: body.data.username } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.patch('/v1/admin/principals/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = principalPatchSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (id.data === principal.principalId && body.data.disabled === true)
      return sendProblem(reply, 409, 'cannot_disable_current_principal', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-principal-update:${String(id.data)}`,
        body.data,
        async (database) => {
          const updated = await database.query(
            `UPDATE noderag.principal SET label=COALESCE($2,label),disabled=COALESCE($3,disabled) WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
            [id.data, body.data.label ?? null, body.data.disabled ?? null],
          );
          if (updated.rows[0] === undefined) throw new Error('not_found');
          await database.query(
            `UPDATE noderag.app_user SET email=CASE WHEN $2::boolean THEN $3 ELSE email END,server_admin=COALESCE($4,server_admin),must_change=COALESCE($5,must_change) WHERE principal_id=$1`,
            [
              id.data,
              'email' in body.data,
              body.data.email ?? null,
              body.data.serverAdmin ?? null,
              body.data.mustChange ?? null,
            ],
          );
          if (body.data.disabled === true)
            await database.query(
              `UPDATE noderag.session SET revoked_at=now() WHERE principal_id=$1 AND revoked_at IS NULL`,
              [id.data],
            );
          return { status: 200, body: { id: id.data, updated: true } };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/api-keys', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = apiKeySchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-api-key-create',
        body.data,
        async (database) => ({
          status: 201,
          body: await createApiKeyInTransaction(database, {
            label: body.data.label,
            searchOnly: body.data.searchOnly,
            ...(body.data.expiresAt === undefined ? {} : { expiresAt: body.data.expiresAt }),
            ...(body.data.cidrAllow === undefined ? {} : { cidrAllow: body.data.cidrAllow }),
            ...(body.data.ratePerMinute === undefined
              ? {}
              : { ratePerMinute: body.data.ratePerMinute }),
            createdBy: principal.principalId,
          }),
        }),
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.delete('/v1/admin/api-keys/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-api-key-revoke:${String(id.data)}`,
        { id: id.data },
        async (database) => {
          await revokeApiKey(database, id.data, principal.principalId);
          return { status: 204, body: null };
        },
      );
      return reply.code(result.response.status).send();
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/grants', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT principal_id AS "principalId",silo_id AS "siloId",capability,granted_at AS "grantedAt",granted_by AS "grantedBy" FROM noderag.silo_grant ORDER BY principal_id,silo_id,capability`,
    );
    return reply.send({ items: rows.rows });
  });

  const grantMutation =
    (enabled: boolean) =>
    async (request: FastifyRequest, reply: Parameters<typeof sendProblem>[0]) => {
      const principal = await requireAdmin(request, options, true);
      if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
      if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
      const params = request.params as Record<string, unknown>;
      const principalId = idSchema.safeParse(params['principalId']);
      const siloId = smallIdSchema.safeParse(params['siloId']);
      const capability = z.enum(['read', 'upload', 'delete']).safeParse(params['capability']);
      if (!principalId.success || !siloId.success || !capability.success)
        return sendProblem(reply, 400, 'invalid_request', request.id);
      const digest = {
        principalId: principalId.data,
        siloId: siloId.data,
        capability: capability.data,
        enabled,
      };
      try {
        const result = await mutate(
          request,
          principal,
          options,
          `admin-grant:${String(principalId.data)}:${String(siloId.data)}:${capability.data}`,
          digest,
          async (database) => {
            await setSiloCapability(
              database,
              principal.principalId,
              principalId.data,
              siloId.data,
              capability.data,
              enabled,
            );
            return { status: enabled ? 200 : 204, body: enabled ? digest : null };
          },
        );
        return reply.code(result.response.status).send(result.response.body);
      } catch (error) {
        return mutationFailure(reply, request, error);
      }
    };
  app.put('/v1/admin/grants/:principalId/:siloId/:capability', grantMutation(true));
  app.delete('/v1/admin/grants/:principalId/:siloId/:capability', grantMutation(false));

  app.get('/v1/admin/gateways', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT id,name,port,silo_ids AS "siloIds",require_auth AS "requireAuth",enabled,created_at AS "createdAt",last_bind_error AS "lastBindError",bound_at AS "boundAt" FROM noderag.gateway ORDER BY id`,
    );
    return reply.send({ items: rows.rows });
  });

  app.post('/v1/admin/gateways', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = gatewaySchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (body.data.port !== null && body.data.enabled && !(await probePort(body.data.port)))
      return sendProblem(reply, 409, 'gateway_port_conflict', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-gateway-create',
        body.data,
        async (database) => {
          const silos = await database.query(
            `SELECT id FROM noderag.silo WHERE id=ANY($1::smallint[]) AND lifecycle_state='active'`,
            [body.data.siloIds],
          );
          if ((silos.rowCount ?? 0) !== body.data.siloIds.length) throw new Error('unknown_silo');
          const inserted = await database.query(
            `INSERT INTO noderag.gateway(name,port,silo_ids,require_auth,enabled,created_by) VALUES($1,$2,$3,true,$4,$5) RETURNING id,name,port,silo_ids AS "siloIds",enabled`,
            [
              body.data.name,
              body.data.port,
              body.data.siloIds,
              body.data.enabled,
              principal.principalId,
            ],
          );
          return { status: 201, body: inserted.rows[0] };
        },
      );
      await gatewayControl?.reconcile();
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.patch('/v1/admin/gateways/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = gatewayPatchSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const current = await options.pool.query<{ port: number | null; enabled: boolean }>(
      `SELECT port,enabled FROM noderag.gateway WHERE id=$1`,
      [id.data],
    );
    const existing = current.rows[0];
    if (existing === undefined) return sendProblem(reply, 404, 'not_found', request.id);
    const desiredPort = body.data.port === undefined ? existing.port : body.data.port;
    const desiredEnabled = body.data.enabled ?? existing.enabled;
    const listenerMustChange =
      (body.data.port !== undefined && body.data.port !== existing.port) ||
      (!existing.enabled && desiredEnabled);
    if (
      listenerMustChange &&
      desiredPort !== null &&
      desiredEnabled &&
      !(await probePort(desiredPort))
    )
      return sendProblem(reply, 409, 'gateway_port_conflict', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-gateway-update:${String(id.data)}`,
        body.data,
        async (database) => {
          const updated = await database.query(
            `UPDATE noderag.gateway SET name=COALESCE($2,name),port=CASE WHEN $3::boolean THEN $4 ELSE port END,silo_ids=COALESCE($5,silo_ids),enabled=COALESCE($6,enabled),last_bind_error=NULL WHERE id=$1 RETURNING id,name,port,silo_ids AS "siloIds",enabled`,
            [
              id.data,
              body.data.name ?? null,
              'port' in body.data,
              body.data.port ?? null,
              body.data.siloIds ?? null,
              body.data.enabled ?? null,
            ],
          );
          if (updated.rows[0] === undefined) throw new Error('not_found');
          return { status: 200, body: updated.rows[0] };
        },
      );
      await gatewayControl?.reconcile();
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.delete('/v1/admin/gateways/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-gateway-delete:${String(id.data)}`,
        { id: id.data },
        async (database) => {
          const deleted = await database.query(`DELETE FROM noderag.gateway WHERE id=$1`, [
            id.data,
          ]);
          if (deleted.rowCount !== 1) throw new Error('not_found');
          return { status: 204, body: null };
        },
      );
      await gatewayControl?.reconcile();
      return reply.code(result.response.status).send();
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/audit', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const query = cursorQuerySchema.safeParse(request.query);
    if (!query.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const rows = await options.pool.query(
      `SELECT id,occurred_at AS "occurredAt",principal_id AS "principalId",gateway_id AS "gatewayId",silo_id AS "siloId",action,result,encode(query_sha256,'hex') AS "querySha256",row_count AS "rowCount",detail,source_ip AS "sourceIp",request_id AS "requestId" FROM noderag.audit_log ORDER BY id DESC LIMIT $1`,
      [query.data.limit],
    );
    return reply.send({ items: rows.rows });
  });

  app.get('/v1/admin/settings', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const result = await options.pool.query<{
      embedThreads: number;
      [key: string]: unknown;
    }>(
      `SELECT target_chars AS "targetChars",overlap_chars AS "overlapChars",max_tokens AS "maxTokens",snap_window::float AS "snapWindow",heading_prefix AS "headingPrefix",embed_threads AS "embedThreads",ingest_threads AS "ingestThreads",throttle_when_busy AS "throttleWhenBusy",default_mode AS "defaultMode",ef_search AS "efSearch",audit_retention_days AS "auditRetentionDays",updated_at AS "updatedAt" FROM noderag.settings WHERE id=1`,
    );
    const settings = result.rows[0];
    if (settings === undefined) return sendProblem(reply, 503, 'settings_unavailable', request.id);
    return reply.send({
      ...settings,
      runtime: settingsRuntime(settings.embedThreads, await currentRuntimeStatus(options.embedder)),
    });
  });

  app.put('/v1/admin/setup/progress', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = setupProgressSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-setup-progress',
        body.data,
        async (database) => {
          const updated = await database.query(
            `UPDATE noderag.setup_state
             SET setup_step = $1, setup_progress = $2
             WHERE id = 1 AND state = 'operational'
               AND $2 >= setup_progress
               AND CASE $1
                     WHEN 'storage' THEN 1 WHEN 'model' THEN 2
                     WHEN 'calibration' THEN 3 WHEN 'vision' THEN 4
                     WHEN 'sources' THEN 5 WHEN 'complete' THEN 6
                   END >= CASE setup_step
                     WHEN 'verify-token' THEN 0 WHEN 'administrator' THEN 0
                     WHEN 'sign-in' THEN 0 WHEN 'storage' THEN 1
                     WHEN 'model' THEN 2 WHEN 'calibration' THEN 3
                     WHEN 'vision' THEN 4 WHEN 'sources' THEN 5
                     WHEN 'complete' THEN 6
                   END
             RETURNING setup_step AS step, setup_progress AS progress`,
            [body.data.step, body.data.progress],
          );
          if (updated.rows[0] === undefined) throw new Error('setup_progress_regression');
          await database.query(
            `INSERT INTO noderag.setup_event (event_type, step, progress, detail)
             VALUES ($1, $2, $3, jsonb_build_object('principalId', $4::bigint))`,
            [
              body.data.step === 'complete' ? 'setup-complete' : 'step-completed',
              body.data.step,
              body.data.progress,
              principal.principalId,
            ],
          );
          return { status: 200, body: updated.rows[0] };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.put('/v1/admin/settings', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = settingsSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (body.data.embedThreads !== undefined && body.data.embedThreads > localProcessorLimit()) {
      return sendProblem(reply, 400, 'embedding_threads_exceed_available_processors', request.id);
    }
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-settings-update',
        body.data,
        async (database) => {
          const current = await database.query<{ target_chars: number; overlap_chars: number }>(
            `SELECT target_chars,overlap_chars FROM noderag.settings WHERE id=1 FOR UPDATE`,
          );
          const target = body.data.targetChars ?? current.rows[0]?.target_chars ?? 2000;
          const overlap = body.data.overlapChars ?? current.rows[0]?.overlap_chars ?? 300;
          if (overlap > target / 2) throw new Error('overlap_exceeds_half_target');
          const updated = await database.query(
            `UPDATE noderag.settings SET target_chars=COALESCE($1,target_chars),overlap_chars=COALESCE($2,overlap_chars),max_tokens=COALESCE($3,max_tokens),snap_window=COALESCE($4,snap_window),heading_prefix=COALESCE($5,heading_prefix),embed_threads=COALESCE($6,embed_threads),ingest_threads=COALESCE($7,ingest_threads),throttle_when_busy=COALESCE($8,throttle_when_busy),default_mode=COALESCE($9,default_mode),ef_search=COALESCE($10,ef_search),audit_retention_days=COALESCE($11,audit_retention_days),updated_at=now(),updated_by=$12 WHERE id=1
             RETURNING target_chars AS "targetChars",overlap_chars AS "overlapChars",
                       max_tokens AS "maxTokens",snap_window::float AS "snapWindow",
                       heading_prefix AS "headingPrefix",embed_threads AS "embedThreads",
                       ingest_threads AS "ingestThreads",throttle_when_busy AS "throttleWhenBusy",
                       default_mode AS "defaultMode",ef_search AS "efSearch",
                       audit_retention_days AS "auditRetentionDays",updated_at AS "updatedAt"`,
            [
              body.data.targetChars ?? null,
              body.data.overlapChars ?? null,
              body.data.maxTokens ?? null,
              body.data.snapWindow ?? null,
              body.data.headingPrefix ?? null,
              body.data.embedThreads ?? null,
              body.data.ingestThreads ?? null,
              body.data.throttleWhenBusy ?? null,
              body.data.defaultMode ?? null,
              body.data.efSearch ?? null,
              body.data.auditRetentionDays ?? null,
              principal.principalId,
            ],
          );
          return { status: 200, body: updated.rows[0] };
        },
      );
      const responseBody = result.response.body as { embedThreads?: unknown };
      const configuredThreads = Number(responseBody.embedThreads ?? body.data.embedThreads ?? 4);
      let status = await currentRuntimeStatus(options.embedder);
      let applyStatus: 'active' | 'reloaded' | 'pending' = 'active';
      if (body.data.embedThreads !== undefined && status?.threads !== body.data.embedThreads) {
        const configure = runtimeController(options.embedder).configureThreads;
        if (configure === undefined) {
          applyStatus = 'pending';
        } else {
          try {
            status = await configure.call(options.embedder, body.data.embedThreads);
            applyStatus = 'reloaded';
          } catch {
            applyStatus = 'pending';
          }
        }
      }
      return reply.send({
        ...(responseBody as Record<string, unknown>),
        runtime: settingsRuntime(configuredThreads, status, applyStatus),
      });
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/models', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(`SELECT * FROM noderag.model_manifest ORDER BY id`);
    return reply.send({ items: rows.rows });
  });

  app.get('/v1/admin/models/default/status', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    return reply.send(await defaultModelInstaller.status());
  });

  app.post('/v1/admin/models/default/install', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-default-model-install',
        {},
        async () => {
          defaultModelInstaller.start(async (artifact) => {
            await options.pool.query(
              `INSERT INTO noderag.model_artifact(artifact_name,sha256,bytes,acquisition)
               VALUES($1,decode($2,'hex'),$3,'download')
               ON CONFLICT (artifact_name,sha256) DO NOTHING`,
              [artifact.name, artifact.sha256, artifact.bytes],
            );
          });
          return { status: 202, body: await defaultModelInstaller.status() };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/models', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = modelSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-model-create',
        body.data,
        async (database) => {
          const manifestDigest = createHash('sha256')
            .update(
              [
                body.data.name,
                body.data.sourceRevision,
                body.data.artifactSha256,
                body.data.tokenizerRevision,
                body.data.quantization,
                body.data.dimensions,
                body.data.maximumTokens,
                body.data.pooling,
                body.data.normalization,
                body.data.queryPrefix,
                body.data.documentPrefix,
                body.data.license,
              ].join('\n'),
              'utf8',
            )
            .digest('hex');
          const row = await database.query(
            `INSERT INTO noderag.model_manifest
               (name,source_revision,artifact_sha256,tokenizer_revision,quantization,
                dimensions,maximum_tokens,pooling,normalization,query_prefix,
                document_prefix,license,manifest_digest)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [
              body.data.name,
              body.data.sourceRevision,
              body.data.artifactSha256,
              body.data.tokenizerRevision,
              body.data.quantization,
              body.data.dimensions,
              body.data.maximumTokens,
              body.data.pooling,
              body.data.normalization,
              body.data.queryPrefix,
              body.data.documentPrefix,
              body.data.license,
              manifestDigest,
            ],
          );
          return { status: 201, body: row.rows[0] };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/models/download', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = modelDownloadSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-model-download',
        body.data,
        async (database) => {
          const allowedHosts = (process.env['NODERAG_MODEL_DOWNLOAD_HOSTS'] ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
          const artifact = await downloadModelArtifact({
            name: body.data.name,
            urls: body.data.urls,
            expectedSha256: body.data.sha256,
            allowedHosts,
            destinationRoot: resolve(process.env['NODERAG_MODEL_ROOT'] ?? 'runtime-data/models'),
          });
          await database.query(
            `INSERT INTO noderag.model_artifact(artifact_name,sha256,bytes,acquisition)
             VALUES($1,decode($2,'hex'),$3,'download') ON CONFLICT (artifact_name,sha256) DO NOTHING`,
            [artifact.name, artifact.sha256, artifact.bytes],
          );
          return { status: 201, body: artifact };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      request.log.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'model download failed',
      );
      return sendProblem(
        reply,
        400,
        error instanceof Error ? error.message : 'model_download_failed',
        request.id,
      );
    }
  });

  app.post('/v1/admin/models/import', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = modelImportSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-model-import',
        body.data,
        async (database) => {
          const allowedRoots = (process.env['NODERAG_MODEL_IMPORT_ROOTS'] ?? '')
            .split(process.platform === 'win32' ? ';' : ':')
            .map((value) => value.trim())
            .filter(Boolean);
          const artifact = await importModelArtifact({
            name: body.data.name,
            sourcePath: body.data.sourcePath,
            expectedSha256: body.data.sha256,
            allowedRoots,
            destinationRoot: resolve(process.env['NODERAG_MODEL_ROOT'] ?? 'runtime-data/models'),
          });
          await database.query(
            `INSERT INTO noderag.model_artifact(artifact_name,sha256,bytes,acquisition)
             VALUES($1,decode($2,'hex'),$3,'manual_import') ON CONFLICT (artifact_name,sha256) DO NOTHING`,
            [artifact.name, artifact.sha256, artifact.bytes],
          );
          return { status: 201, body: artifact };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      request.log.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'model import failed',
      );
      return sendProblem(
        reply,
        400,
        error instanceof Error ? error.message : 'model_import_failed',
        request.id,
      );
    }
  });

  app.get('/v1/admin/builds', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const [builds, siloStates, proposals, activations, cleanups] = await Promise.all([
      options.pool.query(
        `SELECT b.*,m.name AS model_name,m.source_revision AS model_revision
         FROM noderag.build b
         JOIN noderag.model_manifest m ON m.id=b.model_manifest_id
         ORDER BY b.id DESC`,
      ),
      options.pool.query<{
        build_id: unknown;
        silo_id: number;
        state: string;
        processed_documents: unknown;
        total_documents: unknown;
        checkpoint_documents: unknown;
        verification_id: unknown;
        last_error: string | null;
      }>(
        `SELECT build_id,silo_id,state,processed_documents,total_documents,
                checkpoint_documents,verification_id,last_error
         FROM noderag.silo_build_state ORDER BY build_id DESC,silo_id`,
      ),
      options.pool.query(
        `SELECT id,state,model_manifest_id AS "modelManifestId",silo_ids AS "siloIds",
                source_characters AS "sourceCharacters",expected_chunks AS "expectedChunks",
                estimated_embedding_seconds AS "estimatedEmbeddingSeconds",
                estimated_vision_reuse AS "estimatedVisionReuse",
                temporary_bytes AS "temporaryBytes",required_free_bytes AS "requiredFreeBytes",
                available_bytes AS "availableBytes",reason,expires_at AS "expiresAt",
                created_at AS "createdAt",confirmed_at AS "confirmedAt"
         FROM noderag.rebuild_proposal ORDER BY id DESC LIMIT 100`,
      ),
      options.pool.query(
        `SELECT id,build_id AS "buildId",activation_kind AS "activationKind",
                activated_silos AS "activatedSilos",state,activated_at AS "activatedAt",
                rolled_back_at AS "rolledBackAt",cleanup_authorized_at AS "cleanupAuthorizedAt",
                cleaned_at AS "cleanedAt"
         FROM noderag.build_activation_history ORDER BY id DESC LIMIT 100`,
      ),
      options.pool.query(
        `SELECT id,activation_id AS "activationId",state,checkpoint,
                requested_at AS "requestedAt",completed_at AS "completedAt"
         FROM noderag.build_cleanup ORDER BY id DESC LIMIT 100`,
      ),
    ]);
    const statesByBuild = new Map<number, unknown[]>();
    for (const state of siloStates.rows) {
      const buildId = databaseInteger(state.build_id, 'build id');
      const existing = statesByBuild.get(buildId) ?? [];
      existing.push({
        siloId: state.silo_id,
        state: state.state,
        completedDocuments: state.processed_documents,
        totalDocuments: state.total_documents,
        checkpointDocuments: state.checkpoint_documents,
        verificationId: state.verification_id,
        lastError: state.last_error,
      });
      statesByBuild.set(buildId, existing);
    }
    return reply.send({
      items: builds.rows.map((build) => ({
        ...build,
        silos: statesByBuild.get(databaseInteger(build['id'], 'build id')) ?? [],
      })),
      proposals: proposals.rows,
      activations: activations.rows,
      cleanups: cleanups.rows,
    });
  });
  app.post('/v1/admin/builds', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = buildSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const filesystem = await statfs(options.files.root, { bigint: true });
      const availableBytes = filesystem.bavail * filesystem.bsize;
      const result = await mutate(
        request,
        principal,
        options,
        'admin-build-create',
        body.data,
        async (database) => {
          const defaults = await database.query<{
            target_chars: number;
            overlap_chars: number;
            max_tokens: number;
            snap_window: string | number;
            heading_prefix: boolean;
            rules_version: number;
            model_manifest_id: number;
          }>('SELECT * FROM noderag.settings WHERE id=1');
          const settings = defaults.rows[0];
          if (settings === undefined) throw new Error('settings-not-found');
          const silos =
            body.data.siloIds ??
            (
              await database.query<{ id: number }>(
                "SELECT id FROM noderag.silo WHERE lifecycle_state='active' ORDER BY id",
              )
            ).rows.map((row) => row.id);
          const proposal = await createRebuildProposal(database, {
            modelManifestId: body.data.modelManifestId ?? settings.model_manifest_id,
            targetChars: body.data.targetChars ?? settings.target_chars,
            overlapChars: body.data.overlapChars ?? settings.overlap_chars,
            maxTokens: body.data.maxTokens ?? settings.max_tokens,
            snapWindow: body.data.snapWindow ?? Number(settings.snap_window),
            headingPrefix: body.data.headingPrefix ?? settings.heading_prefix,
            rulesVersion: settings.rules_version,
            siloIds: silos,
            reason: body.data.reason,
            createdBy: principal.principalId,
            embeddingCharactersPerSecond: body.data.embeddingCharactersPerSecond,
            availableBytes,
            freeSpaceReserveBytes: 10n * 1024n * 1024n * 1024n,
          });
          return { status: 202, body: { kind: 'rebuild_proposal', ...proposal } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/build-proposals/:id/confirm', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildConfirmSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-proposal-confirm:${String(id.data)}`,
        body.data,
        async (database) => {
          const build = await confirmRebuildProposal(database, id.data, principal.principalId);
          return { status: 202, body: build };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/builds/:id/verify', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildVerifySchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-verify:${String(id.data)}:${String(body.data.siloId)}`,
        body.data,
        async () => ({
          status: 200,
          body: await verifyStagedSilo(
            options.pool,
            id.data,
            body.data.siloId,
            principal.principalId,
          ),
        }),
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/builds/:id/activate', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildActivateSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-activate:${String(id.data)}`,
        body.data,
        async () => ({
          status: 200,
          body: {
            activationId: await activateVerifiedBuild(
              options.pool,
              id.data,
              body.data.siloIds,
              principal.principalId,
            ),
          },
        }),
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/build-activations/:id/rollback', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildConfirmSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-rollback:${String(id.data)}`,
        body.data,
        async () => {
          await rollbackBuildActivation(options.pool, id.data, principal.principalId);
          return { status: 200, body: { activationId: id.data, state: 'rolled_back' } };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/build-activations/:id/cleanup-authorizations', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = destructiveConfirmationSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-cleanup-authorize:${String(id.data)}`,
        body.data,
        async (database) => ({
          status: 201,
          body: {
            cleanupId: await authorizeBuildCleanup(
              database,
              id.data,
              body.data.confirmation,
              principal.principalId,
            ),
          },
        }),
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.post('/v1/admin/build-cleanups/:id/run', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildConfirmSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-cleanup-run:${String(id.data)}`,
        body.data,
        async () => {
          await runAuthorizedBuildCleanup(options.pool, id.data, principal.principalId);
          return { status: 200, body: { cleanupId: id.data, state: 'completed' } };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.delete('/v1/admin/builds/:id/checkpoints', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = destructiveConfirmationSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-checkpoints-discard:${String(id.data)}`,
        body.data,
        async (database) => ({
          status: 200,
          body: {
            removed: await discardBuildCheckpoints(
              database,
              id.data,
              body.data.confirmation,
              principal.principalId,
            ),
          },
        }),
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
  app.patch('/v1/admin/builds/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = buildPatchSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-action:${String(id.data)}`,
        body.data,
        async (database) => {
          await changeBuildState(database, id.data, body.data.action, principal.principalId);
          return { status: 200, body: { id: id.data, state: body.data.action } };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/storage', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT id,name,managed_path AS "managedPath",purpose,enabled,
              created_at AS "createdAt"
       FROM noderag.storage_location ORDER BY id`,
    );
    return reply.send({ items: rows.rows });
  });
  app.post('/v1/admin/storage/probe', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = storageProbeSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(await probeStorage(body.data.managedPath, storageProbeOptions()));
    } catch (error) {
      const code = storageProbeProblemCode(error);
      request.log.warn(
        { code, errorName: error instanceof Error ? error.name : 'unknown' },
        'storage probe failed',
      );
      return sendProblem(reply, 400, code, request.id);
    }
  });
  app.post('/v1/admin/storage', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = storageSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    let storageProbe: Awaited<ReturnType<typeof probeStorage>>;
    try {
      storageProbe = await probeStorage(body.data.managedPath, storageProbeOptions());
    } catch (error) {
      const code = storageProbeProblemCode(error);
      request.log.warn(
        { code, errorName: error instanceof Error ? error.name : 'unknown' },
        'storage creation probe failed',
      );
      return sendProblem(reply, 400, code, request.id);
    }
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-storage-create',
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.storage_location(name,managed_path,purpose,enabled,created_by)
             VALUES($1,$2,$3,$4,$5)
             RETURNING id,name,managed_path AS "managedPath",purpose,enabled,
                       created_at AS "createdAt"`,
            [
              body.data.name,
              storageProbe.managedPath,
              body.data.purpose,
              body.data.enabled,
              principal.principalId,
            ],
          );
          return { status: 201, body: row.rows[0] };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
  app.patch('/v1/admin/storage/:id', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const id = smallIdSchema.safeParse((request.params as { id?: unknown }).id);
    const body = storagePatchSchema.safeParse(request.body);
    if (!id.success || !body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    let verifiedManagedPath = body.success ? body.data.managedPath : undefined;
    if (body.data.managedPath !== undefined) {
      const current = await options.pool.query<{ managed_path: string; in_use: boolean }>(
        `SELECT location.managed_path,
                EXISTS(
                  SELECT 1 FROM noderag.backup_operation WHERE destination_id=location.id
                  UNION ALL
                  SELECT 1 FROM noderag.backup_schedule WHERE destination_id=location.id
                  UNION ALL
                  SELECT 1 FROM noderag.storage_relocation_operation
                  WHERE source_location_id=location.id OR destination_location_id=location.id
                ) AS in_use
         FROM noderag.storage_location location WHERE location.id=$1`,
        [id.data],
      );
      if (current.rows[0] !== undefined && current.rows[0].managed_path !== body.data.managedPath) {
        if (current.rows[0].in_use) {
          return sendProblem(reply, 409, 'storage_location_in_use', request.id);
        }
        try {
          verifiedManagedPath = (await probeStorage(body.data.managedPath, storageProbeOptions()))
            .managedPath;
        } catch (error) {
          const code = storageProbeProblemCode(error);
          request.log.warn(
            { code, errorName: error instanceof Error ? error.name : 'unknown' },
            'storage update probe failed',
          );
          return sendProblem(reply, 400, code, request.id);
        }
      }
    }
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-storage-update:${String(id.data)}`,
        body.data,
        async (database) => {
          const current = await database.query<{ managed_path: string; purpose: string }>(
            `SELECT managed_path,purpose FROM noderag.storage_location WHERE id=$1 FOR UPDATE`,
            [id.data],
          );
          const existing = current.rows[0];
          if (existing === undefined) throw new Error('not_found');
          const pathOrPurposeChanged =
            (body.data.managedPath !== undefined &&
              verifiedManagedPath !== existing.managed_path) ||
            (body.data.purpose !== undefined && body.data.purpose !== existing.purpose);
          if (pathOrPurposeChanged) {
            const references = await database.query<{ in_use: boolean }>(
              `SELECT EXISTS(
                 SELECT 1 FROM noderag.backup_operation WHERE destination_id=$1
                 UNION ALL
                 SELECT 1 FROM noderag.backup_schedule WHERE destination_id=$1
                 UNION ALL
                 SELECT 1 FROM noderag.storage_relocation_operation
                 WHERE source_location_id=$1 OR destination_location_id=$1
               ) AS in_use`,
              [id.data],
            );
            if (references.rows[0]?.in_use === true) throw new Error('storage_location_in_use');
          }
          const updated = await database.query(
            `UPDATE noderag.storage_location
             SET name=COALESCE($2,name),managed_path=COALESCE($3,managed_path),
                 purpose=COALESCE($4,purpose),enabled=COALESCE($5,enabled)
             WHERE id=$1
             RETURNING id,name,managed_path AS "managedPath",purpose,enabled,
                       created_at AS "createdAt"`,
            [
              id.data,
              body.data.name ?? null,
              verifiedManagedPath ?? null,
              body.data.purpose ?? null,
              body.data.enabled ?? null,
            ],
          );
          return { status: 200, body: updated.rows[0] };
        },
      );
      return reply.send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
  app.get('/v1/admin/calibration/embedding/status', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const job = calibrationJobs.status(principal.principalId);
    return reply.send(
      job ?? {
        id: null,
        state: 'idle',
        phase: null,
        progress: 0,
        startedAt: null,
        finishedAt: null,
        result: null,
        errorCode: null,
      },
    );
  });

  app.post('/v1/admin/calibration/embedding/start', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = calibrationSchema.safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const model = await options.pool.query<ActiveCalibrationModel>(
      `SELECT m.maximum_tokens, m.document_prefix, m.name, m.source_revision,
              m.manifest_digest, m.dimensions
       FROM noderag.model_manifest m WHERE m.active`,
    );
    const active = model.rows[0];
    if (active === undefined) return sendProblem(reply, 503, 'active_model_missing', request.id);
    const samples = body.data.samples ?? calibrationSamples;
    const job = calibrationJobs.start(principal.principalId, async (report) => {
      try {
        return await measureEmbeddingThroughput(
          options,
          `ui-calibration-job:${principal.principalId}:${request.id}`,
          active,
          samples,
          report,
        );
      } catch (error) {
        const failure = calibrationFailure(error);
        request.log.error(
          { errorName: error instanceof Error ? error.name : 'unknown', code: failure.code },
          'background embedding calibration failed',
        );
        throw error;
      }
    });
    return reply.code(202).send(job);
  });

  app.post('/v1/admin/calibration/embedding', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = calibrationSchema.safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const model = await options.pool.query<ActiveCalibrationModel>(
      `SELECT m.maximum_tokens, m.document_prefix, m.name, m.source_revision,
              m.manifest_digest, m.dimensions
       FROM noderag.model_manifest m WHERE m.active`,
    );
    const active = model.rows[0];
    if (active === undefined) return sendProblem(reply, 503, 'active_model_missing', request.id);
    const samples = body.data.samples ?? calibrationSamples;
    try {
      return reply.send(
        await measureEmbeddingThroughput(options, `ui-calibration:${request.id}`, active, samples),
      );
    } catch (error) {
      const failure = calibrationFailure(error);
      request.log.error(
        { errorName: error instanceof Error ? error.name : 'unknown', code: failure.code },
        'embedding calibration failed',
      );
      return sendProblem(reply, failure.status, failure.code, request.id);
    }
  });
  app.get('/v1/admin/backups', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const [rows, schedules] = await Promise.all([
      options.pool.query(
        `SELECT id,state,product,destination_id AS "destinationId",archive_version AS "archiveVersion",
              sidecar_path AS "sidecarPath",archive_sha256 AS "archiveSha256",
              archive_bytes AS "archiveBytes",volume_count AS "volumeCount",
              verification_state AS "verificationState",include_models AS "includeModels",
              manifest,error_code AS "errorCode",requested_at AS "requestedAt",
              started_at AS "startedAt",verified_at AS "verifiedAt",finished_at AS "finishedAt"
       FROM noderag.backup_operation ORDER BY id DESC`,
      ),
      options.pool.query(
        `SELECT id,name,product,destination_id AS "destinationId",cadence,
                utc_hour AS "utcHour",utc_minute AS "utcMinute",utc_weekday AS "utcWeekday",
                enabled,secret_fingerprint AS "secretFingerprint",retain_count AS "retainCount",
                next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",
                last_backup_id AS "lastBackupId",last_result AS "lastResult",
                created_at AS "createdAt",updated_at AS "updatedAt"
         FROM noderag.backup_schedule ORDER BY id`,
      ),
    ]);
    return reply.send({ items: rows.rows, schedules: schedules.rows });
  });
  app.post('/v1/admin/backups', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = backupSchema.safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-backup-${body.data.action}`,
        body.data,
        async (database) => {
          if (body.data.action === 'schedule') {
            if (options.secretVault === undefined) throw new Error('secret_vault_unavailable');
            const databaseClock = await database.query<{ now: Date }>(
              `SELECT clock_timestamp() AS now`,
            );
            const now = databaseClock.rows[0]?.now;
            if (now === undefined) throw new Error('database_clock_unavailable');
            const secretName = `schedule:${body.data.name}`;
            const secret = await options.secretVault.store(
              database,
              'backup-schedule',
              secretName,
              body.data.passphrase,
              principal.principalId,
            );
            const nextRunAt = nextBackupScheduleAt(
              body.data.cadence,
              body.data.utcHour,
              body.data.utcMinute,
              body.data.utcWeekday,
              now,
            );
            const row = await database.query(
              `INSERT INTO noderag.backup_schedule
                 (name,product,destination_id,cadence,utc_hour,utc_minute,utc_weekday,
                  enabled,secret_name,secret_fingerprint,retain_count,next_run_at,created_by)
               SELECT $2,$3,location.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
               FROM noderag.storage_location location
               WHERE location.id=$1 AND location.enabled AND location.purpose='backup'
               RETURNING id,name,product,enabled,secret_fingerprint AS "secretFingerprint",
                         next_run_at AS "nextRunAt"`,
              [
                body.data.destinationId,
                body.data.name,
                body.data.product,
                body.data.cadence,
                body.data.utcHour,
                body.data.utcMinute,
                body.data.utcWeekday,
                body.data.enabled,
                secretName,
                secret.fingerprint,
                body.data.retainCount,
                nextRunAt,
                principal.principalId,
              ],
            );
            if (row.rows[0] === undefined) throw new Error('backup_destination_not_found');
            return { status: 201, body: row.rows[0] };
          }
          const row = await database.query(
            `INSERT INTO noderag.backup_operation
               (destination_id,requested_by,product,include_models)
             SELECT id,$2,$3,$4 FROM noderag.storage_location
             WHERE id=$1 AND enabled AND purpose='backup'
             RETURNING id,state,product,include_models AS "includeModels",
                       requested_at AS "requestedAt"`,
            [
              body.data.destinationId,
              principal.principalId,
              body.data.product,
              body.data.includeModels,
            ],
          );
          if (row.rows[0] === undefined) throw new Error('backup_destination_not_found');
          return { status: 202, body: row.rows[0] };
        },
      );
      const operationId = Number((result.response.body as { id?: unknown }).id);
      if (
        !result.replayed &&
        body.data.action === 'run' &&
        options.recovery !== undefined &&
        Number.isSafeInteger(operationId)
      ) {
        void options.recovery
          .startBackup({
            operationId,
            product: body.data.product,
            passphrase: body.data.passphrase,
            includeModels: body.data.includeModels,
          })
          .catch((error: unknown) =>
            request.log.error(
              { errorName: error instanceof Error ? error.name : 'unknown', operationId },
              'backup operation failed',
            ),
          );
      }
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
  app.get('/v1/admin/restores', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT id,state,backup_id AS "backupId",source_manifest AS "sourceManifest",error_code AS "errorCode",requested_at AS "requestedAt",finished_at AS "finishedAt" FROM noderag.restore_operation ORDER BY id DESC`,
    );
    return reply.send({ items: rows.rows });
  });
  app.post('/v1/admin/restores', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = restoreSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-restore-${body.data.action}`,
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.restore_operation(backup_id,source_manifest,requested_by)
             SELECT backup.id,backup.manifest,$2
             FROM noderag.backup_operation backup
             WHERE backup.id=$1 AND backup.state='succeeded'
               AND backup.verification_state='verified' AND backup.product=$3
               AND backup.sidecar_path IS NOT NULL
             RETURNING id,state,requested_at AS "requestedAt"`,
            [
              body.data.backupId,
              principal.principalId,
              body.data.action === 'restore_full' ? 'full' : 'portable',
            ],
          );
          if (row.rows[0] === undefined) throw new Error('backup_not_found');
          return { status: 202, body: row.rows[0] };
        },
      );
      const operationId = Number((result.response.body as { id?: unknown }).id);
      if (!result.replayed && options.recovery !== undefined && Number.isSafeInteger(operationId)) {
        void options.recovery
          .startRestore({
            operationId,
            passphrase: body.data.passphrase,
            confirmation: body.data.confirmation,
            mode: body.data.action === 'restore_full' ? 'full' : 'portable',
            ...(body.data.action === 'import_portable'
              ? {
                  destinationSiloId: body.data.destinationSiloId,
                  ownerPrincipalId: principal.principalId,
                }
              : {}),
          })
          .catch((error: unknown) =>
            request.log.error(
              { errorName: error instanceof Error ? error.name : 'unknown', operationId },
              'restore operation failed',
            ),
          );
      }
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/evaluation', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const [cases, runs, diagnostics, baselines, alerts] = await Promise.all([
      options.pool.query(
        `SELECT id,external_id AS "externalId",silo_id AS "siloId",query,
                query_class AS "queryClass",expected_format AS "expectedFormat",answerable,
                relevant,notes,enabled,curation_state AS "curationState",
                reviewed_at AS "reviewedAt",created_at AS "createdAt"
           FROM noderag.evaluation_case ORDER BY id`,
      ),
      options.pool.query(
        `SELECT id,mode,workload,state,config,metrics,case_count AS "caseCount",
                commit_sha AS "commitSha",migration_head AS "migrationHead",
                build_snapshot AS "buildSnapshot",model_snapshot AS "modelSnapshot",
                failure_code AS "failureCode",started_at AS "startedAt",
                finished_at AS "finishedAt",created_at AS "createdAt"
           FROM noderag.evaluation_run ORDER BY id DESC LIMIT 50`,
      ),
      options.pool.query(`SELECT * FROM noderag.retrieval_diagnostic ORDER BY id DESC LIMIT 50`),
      options.pool.query(
        `SELECT baseline.id,baseline.mode,baseline.workload,baseline.run_id AS "runId",
                baseline.metrics_digest AS "metricsDigest",baseline.accepted_at AS "acceptedAt"
           FROM noderag.evaluation_baseline baseline
          WHERE baseline.active ORDER BY baseline.mode,baseline.workload`,
      ),
      options.pool.query(
        `SELECT id,run_id AS "runId",baseline_id AS "baselineId",severity,code,detail,
                created_at AS "createdAt"
           FROM noderag.evaluation_alert
          WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 100`,
      ),
    ]);
    return reply.send({
      cases: cases.rows,
      runs: runs.rows,
      diagnostics: diagnostics.rows,
      baselines: baselines.rows,
      alerts: alerts.rows,
    });
  });
  app.post('/v1/admin/evaluation', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = evaluationSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-evaluation:${body.data.action}`,
        body.data,
        async (database) => {
          if (body.data.action === 'add_case') {
            const row = await database.query(
              `INSERT INTO noderag.evaluation_case
                 (external_id,silo_id,query,query_class,expected_format,answerable,
                  relevant,notes,created_by,updated_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
               RETURNING id,external_id AS "externalId",silo_id AS "siloId",
                         query_class AS "queryClass",expected_format AS "expectedFormat",
                         answerable,relevant,curation_state AS "curationState"`,
              [
                body.data.externalId,
                body.data.siloId,
                body.data.query.normalize('NFC'),
                body.data.queryClass,
                body.data.expectedFormat ?? null,
                body.data.answerable,
                JSON.stringify(body.data.relevant),
                body.data.notes ?? null,
                principal.principalId,
              ],
            );
            return { status: 201, body: row.rows[0] };
          }
          if (body.data.action === 'set_case_state') {
            const row = await database.query(
              `UPDATE noderag.evaluation_case
                  SET curation_state=$2::text,
                      reviewed_at=CASE WHEN $2::text='draft' THEN NULL::timestamptz ELSE now() END,
                      reviewed_by=CASE WHEN $2::text='draft' THEN NULL::bigint ELSE $3::bigint END,
                      updated_at=now(),updated_by=$3
                WHERE id=$1
               RETURNING id,external_id AS "externalId",curation_state AS "curationState",
                         reviewed_at AS "reviewedAt"`,
              [body.data.caseId, body.data.state, principal.principalId],
            );
            if (row.rows[0] === undefined) throw new Error('not_found');
            return { status: 200, body: row.rows[0] };
          }
          if (body.data.action === 'accept_baseline') {
            const accepted = await database.query<{
              mode: string;
              workload: string;
              metrics: unknown;
              settings_revision_id: unknown;
            }>(
              `SELECT mode,workload,metrics,settings_revision_id
                 FROM noderag.evaluation_run
                WHERE id=$1 AND state='succeeded'
                  AND COALESCE((metrics #>> '{gate,passed}')::boolean,false)`,
              [body.data.runId],
            );
            const run = accepted.rows[0];
            if (run === undefined) throw new Error('evaluation_run_not_acceptable');
            await database.query(
              `UPDATE noderag.evaluation_baseline SET active=false
                WHERE mode=$1 AND workload=$2 AND active`,
              [run.mode, run.workload],
            );
            const baseline = await database.query(
              `INSERT INTO noderag.evaluation_baseline
                 (mode,workload,run_id,metrics_digest,accepted_by)
               VALUES($1,$2,$3,$4,$5)
               RETURNING id,mode,workload,run_id AS "runId",
                         metrics_digest AS "metricsDigest",accepted_at AS "acceptedAt"`,
              [
                run.mode,
                run.workload,
                body.data.runId,
                digestJson(run.metrics),
                principal.principalId,
              ],
            );
            if (run.settings_revision_id !== null) {
              await database.query(
                `UPDATE noderag.evaluation_settings_revision SET accepted=true WHERE id=$1`,
                [run.settings_revision_id],
              );
            }
            return { status: 201, body: baseline.rows[0] };
          }

          const approved = await database.query(
            `SELECT evaluation.external_id AS "externalId",silo.slug AS silo,
                    evaluation.query,evaluation.query_class AS "queryClass",
                    evaluation.expected_format AS "expectedFormat",evaluation.answerable,
                    evaluation.relevant
               FROM noderag.evaluation_case evaluation
               JOIN noderag.silo silo ON silo.id=evaluation.silo_id
              WHERE evaluation.enabled AND evaluation.curation_state='approved'
              ORDER BY evaluation.external_id`,
          );
          if (approved.rows.length === 0) throw new Error('approved_evaluation_cases_missing');
          const corpusManifest = {
            relevanceUnit: 'document-page-sheet-sha256',
            cases: approved.rows,
          };
          const corpusDigest = digestJson(corpusManifest);
          const corpus = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.evaluation_corpus_snapshot
               (corpus_id,manifest_digest,manifest,document_count,case_count,frozen_by)
             VALUES('database-approved-v1',$1,$2,$3,$4,$5)
             ON CONFLICT(manifest_digest) DO UPDATE SET corpus_id=EXCLUDED.corpus_id
             RETURNING id`,
            [
              corpusDigest,
              JSON.stringify(corpusManifest),
              new Set(
                approved.rows.flatMap((item) =>
                  Array.isArray((item as { relevant?: unknown }).relevant)
                    ? (item as { relevant: { document?: unknown }[] }).relevant
                        .map(({ document }) => document)
                        .filter((value): value is string => typeof value === 'string')
                    : [],
                ),
              ).size,
              approved.rows.length,
              principal.principalId,
            ],
          );
          const settings = await database.query(
            `SELECT target_chars AS "targetChars",overlap_chars AS "overlapChars",
                    max_tokens AS "maxTokens",snap_window AS "snapWindow",
                    heading_prefix AS "headingPrefix",embed_threads AS "embedThreads",
                    ingest_threads AS "ingestThreads",throttle_when_busy AS "throttleWhenBusy",
                    default_mode AS "defaultMode",ef_search AS "efSearch",
                    rules_version AS "rulesVersion",updated_at AS "updatedAt"
               FROM noderag.settings WHERE id=1`,
          );
          const settingsPayload = {
            settings: settings.rows[0] ?? {},
            environment: body.data.environment,
          };
          const settingsDigest = digestJson(settingsPayload);
          const revision = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.evaluation_settings_revision
               (settings_digest,settings,environment,created_by)
             VALUES($1,$2,$3,$4)
             ON CONFLICT(settings_digest) DO UPDATE SET settings=EXCLUDED.settings
             RETURNING id`,
            [
              settingsDigest,
              JSON.stringify(settingsPayload.settings),
              JSON.stringify(settingsPayload.environment),
              principal.principalId,
            ],
          );
          const builds = await database.query(
            `SELECT state.silo_id AS "siloId",state.build_id AS "buildId",
                    build.target_chars AS "targetChars",build.overlap_chars AS "overlapChars",
                    build.max_tokens AS "maxTokens",build.heading_prefix AS "headingPrefix"
               FROM noderag.silo_build_state state
               JOIN noderag.build build ON build.id=state.build_id
              WHERE state.state='active' ORDER BY state.silo_id`,
          );
          const models = await database.query(
            `SELECT model.id,model.name,model.source_revision AS "sourceRevision",
                    model.artifact_sha256 AS "artifactSha256",
                    model.tokenizer_revision AS "tokenizerRevision",model.quantization,
                    model.dimensions,model.pooling,model.normalization
               FROM noderag.model_manifest model
              WHERE model.active ORDER BY model.id`,
          );
          const commitSha = process.env['NODERAG_COMMIT_SHA'];
          const pinnedCommit = /^[a-f0-9]{40}$/u.test(commitSha ?? '') ? commitSha : null;
          const queued = [];
          for (const mode of [...new Set(body.data.modes)]) {
            const row = await database.query(
              `INSERT INTO noderag.evaluation_run
                 (mode,workload,created_by,config,corpus_snapshot_id,settings_revision_id,
                  commit_sha,migration_head,build_snapshot,model_snapshot,thresholds)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id,mode,workload,state,created_at AS "createdAt"`,
              [
                mode,
                body.data.workload,
                principal.principalId,
                JSON.stringify({
                  relevanceUnit: 'document-page-sheet-sha256',
                  corpusDigest,
                  settingsDigest,
                }),
                corpus.rows[0]?.id,
                revision.rows[0]?.id,
                pinnedCommit,
                CURRENT_SCHEMA_REVISION,
                JSON.stringify({ items: builds.rows }),
                JSON.stringify({ active: models.rows }),
                JSON.stringify({
                  minimumRecallAt10: 0.85,
                  minimumPerFormatRecallAt10: 0.8,
                  maximumZeroResultRate: 0.05,
                  maximumIdleP95Ms: 3000,
                  maximumIngestP95Ms: 5000,
                  maximumLeakageCount: 0,
                  maximumLocatorMismatchCount: 0,
                }),
              ],
            );
            queued.push(row.rows[0]);
          }
          return { status: 202, body: { runs: queued, corpusDigest, settingsDigest } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
};
