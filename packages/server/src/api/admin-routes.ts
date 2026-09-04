import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createApiKeyInTransaction, revokeApiKey } from '../identity/api-keys.js';
import { hashPassword } from '../identity/passwords.js';
import { createSiloInTransaction, setSiloCapability } from '../store/silos.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import type { ContentRoutesOptions } from './content-routes.js';
import { RequestAuthenticationError, type AuthenticatedPrincipal } from './authentication.js';
import { sendProblem } from './problem.js';
import { coordinatedEmbedder } from '../store/resources.js';

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
    enabled: z.boolean().default(true),
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
const modelSchema = z
  .object({
    name: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    tokenizerRevision: z.string().min(1).max(200),
    quantization: z.string().min(1).max(40),
    dimensions: z.literal(1024),
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
  })
  .strict();
const buildPatchSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();
const storageSchema = z
  .object({
    name: z.string().min(1).max(120),
    managedPath: z.string().min(1).max(4096),
    purpose: z.enum(['documents', 'backup', 'temporary']),
    enabled: z.boolean().default(true),
  })
  .strict();
const storageProbeSchema = z.object({ managedPath: z.string().min(1).max(4096) }).strict();
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
const backupSchema = z.object({ destinationId: smallIdSchema.optional() }).strict();
const restoreSchema = z
  .object({ backupId: idSchema, sourceManifest: z.record(z.string(), z.unknown()).default({}) })
  .strict();
const evaluationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add_case'),
      externalId: z.string().min(1).max(120),
      siloId: smallIdSchema,
      query: z.string().min(1).max(4000),
      relevant: z
        .array(
          z
            .object({
              document: z.string().min(1).max(1024),
              pages: z.array(z.number().int().min(0)).max(100).optional(),
            })
            .strict(),
        )
        .min(1),
      notes: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('queue_run'),
      mode: z.enum(['vector', 'keyword', 'hybrid']).default('vector'),
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

const probeStorage = async (managedPath: string) => {
  if (!isAbsolute(managedPath)) throw new Error('storage_path_must_be_absolute');
  const target = resolve(managedPath);
  await mkdir(target, { recursive: true });
  const probe = resolve(target, `.noderag-write-probe-${randomUUID()}`);
  const handle = await open(probe, 'wx', 0o600);
  try {
    await handle.writeFile('NodeRag storage probe\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
    await rm(probe, { force: true });
  }
  const capacity = await statfs(target, { bigint: true });
  const availableBytes = capacity.bavail * capacity.bsize;
  const totalBytes = capacity.blocks * capacity.bsize;
  return {
    writable: true,
    availableBytes: availableBytes.toString(),
    totalBytes: totalBytes.toString(),
    lowCapacity: availableBytes < 10n * 1024n * 1024n * 1024n,
  };
};

const calibrationSamples = Array.from({ length: 20 }, (_, index) =>
  `NodeRag calibration passage ${String(index + 1)}. This representative local knowledge text measures embedding throughput without retaining document content. `.repeat(
    12,
  ),
);

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key']?.toString();
  if (value === undefined) throw new Error('idempotency_key_required');
  return value;
};

const stableBody = (value: unknown): string => JSON.stringify(value);

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
    ['build_not_mutable', { status: 409, code: 'build_not_mutable' }],
    ['setup_progress_regression', { status: 409, code: 'setup_progress_regression' }],
    ['server-admin-required', { status: 403, code: 'server_admin_required' }],
  ]).get(message);
  if (known !== undefined) return sendProblem(reply, known.status, known.code, request.id);
  const databaseCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (databaseCode === '23505') return sendProblem(reply, 409, 'conflict', request.id);
  if (databaseCode === '23503') return sendProblem(reply, 400, 'invalid_reference', request.id);
  request.log.error(
    { errorName: error instanceof Error ? error.name : 'unknown', databaseCode },
    'administration mutation failed',
  );
  return sendProblem(reply, 500, 'mutation_failed', request.id);
};

export const registerAdminRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
  gatewayControl?: GatewayControl,
): void => {
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
    const result = await options.pool.query(
      `SELECT target_chars AS "targetChars",overlap_chars AS "overlapChars",max_tokens AS "maxTokens",snap_window::float AS "snapWindow",heading_prefix AS "headingPrefix",embed_threads AS "embedThreads",ingest_threads AS "ingestThreads",throttle_when_busy AS "throttleWhenBusy",default_mode AS "defaultMode",ef_search AS "efSearch",audit_retention_days AS "auditRetentionDays",updated_at AS "updatedAt" FROM noderag.settings WHERE id=1`,
    );
    return reply.send(result.rows[0]);
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
            `UPDATE noderag.settings SET target_chars=COALESCE($1,target_chars),overlap_chars=COALESCE($2,overlap_chars),max_tokens=COALESCE($3,max_tokens),snap_window=COALESCE($4,snap_window),heading_prefix=COALESCE($5,heading_prefix),embed_threads=COALESCE($6,embed_threads),ingest_threads=COALESCE($7,ingest_threads),throttle_when_busy=COALESCE($8,throttle_when_busy),default_mode=COALESCE($9,default_mode),ef_search=COALESCE($10,ef_search),audit_retention_days=COALESCE($11,audit_retention_days),updated_at=now(),updated_by=$12 WHERE id=1 RETURNING *`,
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
      return reply.send(result.response.body);
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
          const row = await database.query(
            `INSERT INTO noderag.model_manifest(name,source_revision,artifact_sha256,tokenizer_revision,quantization,dimensions,maximum_tokens,pooling,normalization,query_prefix,document_prefix,license) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
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

  app.get('/v1/admin/builds', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT b.*,m.name AS model_name,m.source_revision AS model_revision FROM noderag.build b JOIN noderag.model_manifest m ON m.id=b.model_manifest_id ORDER BY b.id DESC`,
    );
    return reply.send({ items: rows.rows });
  });
  app.post('/v1/admin/builds', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = buildSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-build-create',
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.build(state,target_chars,overlap_chars,max_tokens,snap_window,heading_prefix,rules_version,model_manifest_id,query_prefix,reason) SELECT 'building',COALESCE($1,s.target_chars),COALESCE($2,s.overlap_chars),COALESCE($3,s.max_tokens),COALESCE($4,s.snap_window),COALESCE($5,s.heading_prefix),s.rules_version,COALESCE($6,s.model_manifest_id),m.query_prefix,$7 FROM noderag.settings s JOIN noderag.model_manifest m ON m.id=COALESCE($6,s.model_manifest_id) WHERE s.id=1 RETURNING *`,
            [
              body.data.targetChars ?? null,
              body.data.overlapChars ?? null,
              body.data.maxTokens ?? null,
              body.data.snapWindow ?? null,
              body.data.headingPrefix ?? null,
              body.data.modelManifestId ?? null,
              body.data.reason,
            ],
          );
          return { status: 202, body: row.rows[0] };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
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
    const next =
      body.data.action === 'pause'
        ? 'paused'
        : body.data.action === 'resume'
          ? 'building'
          : 'cancelled';
    try {
      const result = await mutate(
        request,
        principal,
        options,
        `admin-build-action:${String(id.data)}`,
        body.data,
        async (database) => {
          const row = await database.query(
            `UPDATE noderag.build SET state=$2 WHERE id=$1 AND state IN ('building','paused') RETURNING *`,
            [id.data, next],
          );
          if (row.rows[0] === undefined) throw new Error('build_not_mutable');
          return { status: 200, body: row.rows[0] };
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
      `SELECT id,name,purpose,enabled,created_at AS "createdAt" FROM noderag.storage_location ORDER BY id`,
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
      return reply.send(await probeStorage(body.data.managedPath));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'storage_probe_failed';
      if (code === 'storage_path_must_be_absolute') {
        return sendProblem(reply, 400, code, request.id);
      }
      request.log.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'storage probe failed',
      );
      return sendProblem(reply, 400, 'storage_probe_failed', request.id);
    }
  });
  app.post('/v1/admin/storage', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = storageSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await mutate(
        request,
        principal,
        options,
        'admin-storage-create',
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.storage_location(name,managed_path,purpose,enabled,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,purpose,enabled,created_at AS "createdAt"`,
            [
              body.data.name,
              body.data.managedPath,
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
  app.post('/v1/admin/calibration/embedding', async (request, reply) => {
    const principal = await requireAdmin(request, options, true);
    if (principal === null) return sendProblem(reply, 401, 'server_admin_required', request.id);
    if (principal === 'csrf') return sendProblem(reply, 403, 'csrf_rejected', request.id);
    const body = calibrationSchema.safeParse(request.body ?? {});
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const model = await options.pool.query<{
      maximum_tokens: number;
      document_prefix: string;
      name: string;
      source_revision: string;
    }>(
      `SELECT m.maximum_tokens, m.document_prefix, m.name, m.source_revision
       FROM noderag.model_manifest m WHERE m.active`,
    );
    const active = model.rows[0];
    if (active === undefined) return sendProblem(reply, 503, 'active_model_missing', request.id);
    const samples = body.data.samples ?? calibrationSamples;
    const characters = samples.reduce((total, value) => total + value.length, 0);
    const started = performance.now();
    await coordinatedEmbedder(options.pool, `ui-calibration:${request.id}`, options.embedder).embed(
      samples.map((value) => `${active.document_prefix}${value.normalize('NFC')}`),
      active.maximum_tokens,
      0,
    );
    const elapsedMs = Math.max(1, performance.now() - started);
    const charactersPerSecond = Math.round((characters * 1000) / elapsedMs);
    return reply.send({
      chunks: samples.length,
      characters,
      elapsedMs: Math.round(elapsedMs),
      charactersPerSecond,
      projectedMinutesPerMillionCharacters: Number(
        (1_000_000 / Math.max(1, charactersPerSecond) / 60).toFixed(1),
      ),
      model: active.name,
      revision: active.source_revision,
    });
  });
  app.get('/v1/admin/backups', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const rows = await options.pool.query(
      `SELECT id,state,destination_id AS "destinationId",manifest,error_code AS "errorCode",requested_at AS "requestedAt",finished_at AS "finishedAt" FROM noderag.backup_operation ORDER BY id DESC`,
    );
    return reply.send({ items: rows.rows });
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
        'admin-backup-create',
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.backup_operation(destination_id,requested_by) VALUES($1,$2) RETURNING id,state,requested_at AS "requestedAt"`,
            [body.data.destinationId ?? null, principal.principalId],
          );
          return { status: 202, body: row.rows[0] };
        },
      );
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
        'admin-restore-create',
        body.data,
        async (database) => {
          const row = await database.query(
            `INSERT INTO noderag.restore_operation(backup_id,source_manifest,requested_by) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM noderag.backup_operation WHERE id=$1) RETURNING id,state,requested_at AS "requestedAt"`,
            [body.data.backupId, body.data.sourceManifest, principal.principalId],
          );
          if (row.rows[0] === undefined) throw new Error('backup_not_found');
          return { status: 202, body: row.rows[0] };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });

  app.get('/v1/admin/evaluation', async (request, reply) => {
    const principal = await requireAdmin(request, options, false);
    if (principal === null || principal === 'csrf')
      return sendProblem(reply, 401, 'server_admin_required', request.id);
    const [cases, runs, diagnostics] = await Promise.all([
      options.pool.query(
        `SELECT id,external_id AS "externalId",silo_id AS "siloId",query,relevant,notes,enabled,created_at AS "createdAt" FROM noderag.evaluation_case ORDER BY id`,
      ),
      options.pool.query(`SELECT * FROM noderag.evaluation_run ORDER BY id DESC LIMIT 50`),
      options.pool.query(`SELECT * FROM noderag.retrieval_diagnostic ORDER BY id DESC LIMIT 50`),
    ]);
    return reply.send({ cases: cases.rows, runs: runs.rows, diagnostics: diagnostics.rows });
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
              `INSERT INTO noderag.evaluation_case(external_id,silo_id,query,relevant,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,external_id AS "externalId",silo_id AS "siloId",relevant`,
              [
                body.data.externalId,
                body.data.siloId,
                body.data.query.normalize('NFC'),
                JSON.stringify(body.data.relevant),
                body.data.notes ?? null,
                principal.principalId,
              ],
            );
            return { status: 201, body: row.rows[0] };
          }
          const row = await database.query(
            `INSERT INTO noderag.evaluation_run(mode,created_by,config) VALUES($1,$2,jsonb_build_object('relevanceUnit','document-page')) RETURNING id,mode,state,created_at AS "createdAt"`,
            [body.data.mode, principal.principalId],
          );
          return { status: 202, body: row.rows[0] };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return mutationFailure(reply, request, error);
    }
  });
};
