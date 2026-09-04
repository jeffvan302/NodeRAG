import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SiloAction, SiloCapability } from '@noderag/shared';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeRoute, loadAuthorizationInventory } from '../src/api/authorization.js';
import { buildApp } from '../src/app.js';
import {
  cleanExpiredAuditEvents,
  hashNormalizedQuery,
  writeAuditEvent,
} from '../src/application/audit.js';
import { executeIdempotent, IdempotencyConflictError } from '../src/application/idempotency.js';
import {
  ApiKeyRateLimiter,
  authenticateApiKey,
  createApiKey,
  revokeApiKey,
} from '../src/identity/api-keys.js';
import { authenticatePassword, changePassword, hashPassword } from '../src/identity/passwords.js';
import { SiloScope } from '../src/identity/scope.js';
import { SecretVault } from '../src/identity/secrets.js';
import {
  browserMutationAllowed,
  createSession,
  revokeSession,
  validateSession,
} from '../src/identity/sessions.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { runMigrations } from '../src/store/migrations.js';
import { databaseInteger } from '../src/store/database.js';
import { claimNextJob } from '../src/store/jobs.js';
import { createSilo, purgeSilo, setSiloCapability } from '../src/store/silos.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';
const administratorPassword = 'M03-admin-password!';
const zeroGrantPassword = 'M03-zero-password!';

interface TestState {
  container: StartedPostgreSqlContainer;
  database: PoolConfig;
  pool: Pool;
  administratorId: number;
  zeroGrantId: number;
  capabilityUserId: number;
  disabledUserId: number;
  defaultSiloId: number;
  uploadSiloId: number;
  deleteSiloId: number;
}

const state = {} as TestState;

const createUser = async (label: string, password: string, disabled = false): Promise<number> => {
  const principal = await state.pool.query<{ id: number }>(
    `INSERT INTO noderag.principal (kind, label, disabled, created_by)
     VALUES ('user', $1, $2, $3) RETURNING id`,
    [label, disabled, state.administratorId],
  );
  const principalId = databaseInteger(principal.rows[0]?.id, 'test principal id');
  await state.pool.query(
    `INSERT INTO noderag.app_user (principal_id, username, password_hash)
     VALUES ($1, $2, $3)`,
    [principalId, label, await hashPassword(password)],
  );
  return principalId;
};

beforeAll(async () => {
  state.container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_identity')
    .withUsername('noderag')
    .withPassword('synthetic-test-only-password')
    .start();
  state.database = {
    host: state.container.getHost(),
    port: state.container.getPort(),
    database: state.container.getDatabase(),
    user: state.container.getUsername(),
    password: state.container.getPassword(),
  };
  await runMigrations(state.database);
  state.pool = new Pool(state.database);

  const setupToken = await issueSetupToken(state.pool);
  const bootstrap = await bootstrapFirstAdministrator(state.pool, {
    setupToken,
    username: 'admin',
    password: administratorPassword,
  });
  state.administratorId = bootstrap.principalId;
  state.defaultSiloId = bootstrap.defaultSilo.id;
  state.uploadSiloId = (
    await createSilo(state.pool, {
      slug: 'uploads',
      displayName: 'Uploads',
      creatingPrincipalId: state.administratorId,
    })
  ).id;
  state.deleteSiloId = (
    await createSilo(state.pool, {
      slug: 'deletions',
      displayName: 'Deletions',
      creatingPrincipalId: state.administratorId,
    })
  ).id;
  state.zeroGrantId = await createUser('zero-grant', zeroGrantPassword);
  state.capabilityUserId = await createUser('capability-user', 'M03-capability-password!');
  state.disabledUserId = await createUser('disabled-user', 'M03-disabled-password!', true);
  await setSiloCapability(
    state.pool,
    state.administratorId,
    state.capabilityUserId,
    state.defaultSiloId,
    'read',
    true,
  );
  await setSiloCapability(
    state.pool,
    state.administratorId,
    state.capabilityUserId,
    state.uploadSiloId,
    'upload',
    true,
  );
  await setSiloCapability(
    state.pool,
    state.administratorId,
    state.capabilityUserId,
    state.deleteSiloId,
    'delete',
    true,
  );
}, 30_000);

afterAll(async () => {
  await state.pool.end();
  await state.container.stop();
});

describe.sequential('M03 identity and authorization foundation', () => {
  it('creates every required schema object at the recorded migration head', async () => {
    const requiredTables = [
      'api_key',
      'app_user',
      'audit_log',
      'build',
      'chunk',
      'document',
      'document_image',
      'document_page',
      'embedding_cache',
      'encrypted_secret',
      'gateway',
      'idempotency_record',
      'job',
      'job_event',
      'model_manifest',
      'principal',
      'session',
      'settings',
      'silo',
      'silo_build_state',
      'silo_grant',
      'source',
      'vision_cache',
    ];
    const tables = await state.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'noderag' ORDER BY tablename`,
    );
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual(
      expect.arrayContaining(requiredTables),
    );
    const head = await state.pool.query<{ name: string }>(
      'SELECT name FROM public.noderag_migrations ORDER BY id DESC LIMIT 1',
    );
    expect(head.rows[0]?.name).toBe('000004_durable_ingestion');
    const cacheType = await state.pool.query<{ formatted: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       WHERE a.attrelid = 'noderag.embedding_cache'::regclass AND a.attname = 'embedding'`,
    );
    const chunkType = await state.pool.query<{ formatted: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       WHERE a.attrelid = 'noderag.chunk'::regclass AND a.attname = 'embedding'`,
    );
    expect(cacheType.rows[0]?.formatted).toBe('halfvec');
    expect(chunkType.rows[0]?.formatted).toBe('halfvec(1024)');
  });

  it('bootstraps exactly once and creates partitioned default access transactionally', async () => {
    const setup = await state.pool.query<{
      state: string;
      setup_token_sha256: Buffer | null;
    }>('SELECT state, setup_token_sha256 FROM noderag.setup_state WHERE id = 1');
    expect(setup.rows[0]).toEqual({ state: 'operational', setup_token_sha256: null });
    const grants = await state.pool.query<{ capability: SiloCapability }>(
      `SELECT capability FROM noderag.silo_grant
       WHERE principal_id = $1 AND silo_id = $2 ORDER BY capability`,
      [state.administratorId, state.defaultSiloId],
    );
    expect(grants.rows.map(({ capability }) => capability)).toEqual(['delete', 'read', 'upload']);
    const partition = await state.pool.query<{ partition_name: string | null }>(
      `SELECT to_regclass($1) AS partition_name`,
      [`noderag.chunk_s${String(state.defaultSiloId)}`],
    );
    expect(partition.rows[0]?.partition_name).toBe(`chunk_s${String(state.defaultSiloId)}`);
    await expect(
      bootstrapFirstAdministrator(state.pool, {
        setupToken: 'setup_consumed_token_value',
        username: 'second-admin',
        password: 'M03-second-password!',
      }),
    ).rejects.toThrow('invalid-or-consumed-setup-token');
  });

  it('resolves read, upload, and delete independently and only narrows scope', async () => {
    const cases: readonly [SiloAction, readonly number[]][] = [
      ['search', [state.defaultSiloId]],
      ['upload', [state.uploadSiloId]],
      ['delete', [state.deleteSiloId]],
      ['list_silos', [state.defaultSiloId, state.uploadSiloId, state.deleteSiloId].sort()],
    ];
    for (const [action, expected] of cases) {
      const scope = await SiloScope.resolve(state.pool, state.capabilityUserId, action);
      expect(scope.siloIds).toEqual(expected);
    }
    const zero = await SiloScope.resolve(state.pool, state.zeroGrantId, 'search');
    expect(zero.siloIds).toEqual([]);

    const gateway = await state.pool.query<{ id: number }>(
      `INSERT INTO noderag.gateway (name, silo_ids, created_by)
       VALUES ('narrow', $1::smallint[], $2) RETURNING id`,
      [[state.defaultSiloId, state.uploadSiloId], state.administratorId],
    );
    const gatewayId = gateway.rows[0]?.id;
    if (gatewayId === undefined) throw new Error('Gateway insertion returned no id.');
    const narrowed = await SiloScope.resolve(state.pool, state.capabilityUserId, 'upload', {
      gatewayId,
      requestedSiloIds: [state.defaultSiloId, state.uploadSiloId],
    });
    expect(narrowed.siloIds).toEqual([state.uploadSiloId]);
    const requestedOutsideGrant = await SiloScope.resolve(
      state.pool,
      state.capabilityUserId,
      'upload',
      { requestedSiloIds: [state.defaultSiloId] },
    );
    expect(requestedOutsideGrant.siloIds).toEqual([]);
  });

  it('passes all eight independent read/upload/delete capability combinations', async () => {
    const capabilities = ['read', 'upload', 'delete'] as const;
    const actionByCapability = {
      read: 'search',
      upload: 'upload',
      delete: 'delete',
    } as const;
    for (let mask = 0; mask < 8; mask += 1) {
      const principal = await state.pool.query<{ id: unknown }>(
        `INSERT INTO noderag.principal (kind, label, created_by)
         VALUES ('user', $1, $2) RETURNING id`,
        [`matrix-${String(mask)}`, state.administratorId],
      );
      const principalId = databaseInteger(principal.rows[0]?.id, 'matrix principal id');
      for (const [index, capability] of capabilities.entries()) {
        if ((mask & (1 << index)) !== 0) {
          await setSiloCapability(
            state.pool,
            state.administratorId,
            principalId,
            state.defaultSiloId,
            capability,
            true,
          );
        }
      }
      for (const [index, capability] of capabilities.entries()) {
        const scope = await SiloScope.resolve(
          state.pool,
          principalId,
          actionByCapability[capability],
        );
        expect(scope.includes(state.defaultSiloId), `${String(mask)}:${capability}`).toBe(
          (mask & (1 << index)) !== 0,
        );
      }
    }
  });

  it('enforces RLS on metadata, child rows, the chunk parent, and direct partitions', async () => {
    const build = await state.pool.query<{ id: number }>(
      `SELECT id FROM noderag.build WHERE state = 'active'`,
    );
    const buildId = build.rows[0]?.id;
    const vector = `[1,${Array.from({ length: 1023 }, () => '0').join(',')}]`;
    for (const siloId of [state.defaultSiloId, state.uploadSiloId]) {
      const source = await state.pool.query<{ id: number }>(
        `INSERT INTO noderag.source (silo_id, uri, health_state)
         VALUES ($1, $2, 'healthy') RETURNING id`,
        [siloId, `/synthetic/${String(siloId)}`],
      );
      const document = await state.pool.query<{ id: number }>(
        `INSERT INTO noderag.document
           (silo_id, source_id, name, extension, byte_count, original_sha256)
         VALUES ($1, $2, $3, 'md', 4, decode(repeat('01', 32), 'hex')) RETURNING id`,
        [siloId, source.rows[0]?.id, `doc-${String(siloId)}`],
      );
      const documentId = document.rows[0]?.id;
      await state.pool.query(
        `INSERT INTO noderag.document_page
           (document_id, silo_id, ordinal, character_start, character_end, byte_start, byte_end)
         VALUES ($1, $2, 0, 0, 4, 0, 4)`,
        [documentId, siloId],
      );
      await state.pool.query(
        `INSERT INTO noderag.document_image
           (document_id, silo_id, page_ordinal, sequence, image_sha256)
         VALUES ($1, $2, 0, 0, decode(repeat('02', 32), 'hex'))`,
        [documentId, siloId],
      );
      await state.pool.query(
        `INSERT INTO noderag.chunk
           (silo_id, document_id, build_id, ordinal, text, character_start,
            character_end, byte_start, byte_end, embedding, token_count, chunk_sha256)
         VALUES ($1, $2, $3, 0, 'test', 0, 4, 0, 4, $4::halfvec, 1,
                 decode(repeat('03', 32), 'hex'))`,
        [siloId, documentId, buildId, vector],
      );
    }
    await state.pool.query('CREATE ROLE noderag_rls_test NOLOGIN');
    await state.pool.query('GRANT USAGE ON SCHEMA noderag TO noderag_rls_test');
    await state.pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA noderag TO noderag_rls_test');
    const client = await state.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE noderag_rls_test');
      await client.query("SELECT set_config('app.silo_ids', $1, true)", [
        `{${String(state.defaultSiloId)}}`,
      ]);
      for (const table of ['source', 'document', 'document_page', 'document_image', 'chunk']) {
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM noderag.${table}`,
        );
        expect(count.rows[0]?.count, table).toBe('1');
      }
      const directOutside = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM noderag.chunk_s${String(state.uploadSiloId)}`,
      );
      expect(directOutside.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('uses Argon2id with durable backoff, lockout, and disabled-user rejection', async () => {
    const first = new Date('2026-09-04T08:00:00Z');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const denied = await authenticatePassword(state.pool, {
        username: 'zero-grant',
        password: 'wrong-password',
        requestId: `wrong-${String(attempt)}`,
        now: first,
      });
      expect(denied).toEqual({ ok: false, code: 'invalid-credentials' });
    }
    const locked = await authenticatePassword(state.pool, {
      username: 'zero-grant',
      password: zeroGrantPassword,
      requestId: 'locked',
      now: new Date(first.getTime() + 1000),
    });
    expect(locked).toEqual({ ok: false, code: 'temporarily-locked' });
    const accepted = await authenticatePassword(state.pool, {
      username: 'zero-grant',
      password: zeroGrantPassword,
      requestId: 'accepted',
      now: new Date(first.getTime() + 6000),
    });
    expect(accepted).toMatchObject({ ok: true, principalId: state.zeroGrantId });
    const disabled = await authenticatePassword(state.pool, {
      username: 'disabled-user',
      password: 'M03-disabled-password!',
      requestId: 'disabled',
    });
    expect(disabled).toEqual({ ok: false, code: 'invalid-credentials' });
    const stored = await state.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM noderag.app_user WHERE principal_id = $1',
      [state.zeroGrantId],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=2,p=1\$/);
    await state.pool.query('UPDATE noderag.settings SET login_enabled = false WHERE id = 1');
    const loginDisabled = await authenticatePassword(state.pool, {
      username: 'zero-grant',
      password: zeroGrantPassword,
      requestId: 'login-disabled',
    });
    expect(loginDisabled).toEqual({ ok: false, code: 'login-disabled' });
    await state.pool.query('UPDATE noderag.settings SET login_enabled = true WHERE id = 1');
  });

  it('changes passwords, rejects the old value, and revokes active sessions immediately', async () => {
    const session = await createSession(state.pool, { principalId: state.capabilityUserId });
    await changePassword(
      state.pool,
      state.capabilityUserId,
      'M03-capability-password!',
      'M03-capability-password-next!',
    );
    expect(await validateSession(state.pool, session.token)).toBeNull();
    expect(
      await authenticatePassword(state.pool, {
        username: 'capability-user',
        password: 'M03-capability-password!',
        requestId: 'old-password',
      }),
    ).toEqual({ ok: false, code: 'invalid-credentials' });
    expect(
      await authenticatePassword(state.pool, {
        username: 'capability-user',
        password: 'M03-capability-password-next!',
        requestId: 'new-password',
      }),
    ).toMatchObject({ ok: true, principalId: state.capabilityUserId });
  });

  it('stores only session hashes and enforces expiry, CSRF, Origin, and revocation', async () => {
    const createdAt = new Date('2026-09-04T09:00:00Z');
    const created = await createSession(state.pool, {
      principalId: state.capabilityUserId,
      now: createdAt,
      slidingMilliseconds: 60_000,
      absoluteMilliseconds: 120_000,
    });
    const rawSearch = await state.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.session
       WHERE token_sha256 = convert_to($1, 'UTF8') OR csrf_sha256 = convert_to($2, 'UTF8')`,
      [created.token, created.csrfToken],
    );
    expect(rawSearch.rows[0]?.count).toBe('0');
    const valid = await validateSession(
      state.pool,
      created.token,
      new Date(createdAt.getTime() + 30_000),
      60_000,
    );
    expect(valid?.principalId).toBe(state.capabilityUserId);
    expect(
      valid === null
        ? false
        : browserMutationAllowed({
            expectedOrigin: 'https://noderag.test',
            origin: 'https://noderag.test',
            csrfToken: created.csrfToken,
            session: valid,
          }),
    ).toBe(true);
    expect(
      valid === null
        ? true
        : browserMutationAllowed({
            expectedOrigin: 'https://noderag.test',
            origin: 'https://evil.test',
            csrfToken: created.csrfToken,
            session: valid,
          }),
    ).toBe(false);
    expect(await revokeSession(state.pool, created.token)).toBe(true);
    expect(await validateSession(state.pool, created.token, createdAt)).toBeNull();
    const expiring = await createSession(state.pool, {
      principalId: state.capabilityUserId,
      now: createdAt,
      slidingMilliseconds: 1000,
      absoluteMilliseconds: 1000,
    });
    expect(
      await validateSession(state.pool, expiring.token, new Date(createdAt.getTime() + 1001)),
    ).toBeNull();
  });

  it('reveals API keys once, enforces CIDR/rate/expiry/revocation, and narrows search-only', async () => {
    const created = await createApiKey(state.pool, {
      label: 'assistant-key',
      createdBy: state.administratorId,
      cidrAllow: ['10.0.0.0/8'],
      ratePerMinute: 2,
    });
    await setSiloCapability(
      state.pool,
      state.administratorId,
      created.principalId,
      state.defaultSiloId,
      'read',
      true,
    );
    await setSiloCapability(
      state.pool,
      state.administratorId,
      created.principalId,
      state.uploadSiloId,
      'upload',
      true,
    );
    const columns = await state.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'noderag' AND table_name = 'api_key'`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).not.toContain('token');
    const limiter = new ApiKeyRateLimiter();
    expect(await authenticateApiKey(state.pool, limiter, created.token, '192.168.1.10')).toEqual({
      ok: false,
      code: 'cidr-denied',
    });
    const now = new Date('2026-09-04T10:00:00Z');
    expect(
      await authenticateApiKey(state.pool, limiter, created.token, '10.1.2.3', now),
    ).toMatchObject({
      ok: true,
      principalId: created.principalId,
      searchOnly: true,
    });
    expect(
      await authenticateApiKey(state.pool, limiter, created.token, '10.1.2.3', now),
    ).toMatchObject({
      ok: true,
    });
    expect(await authenticateApiKey(state.pool, limiter, created.token, '10.1.2.3', now)).toEqual({
      ok: false,
      code: 'rate-limited',
    });
    expect((await SiloScope.resolve(state.pool, created.principalId, 'search')).siloIds).toEqual([
      state.defaultSiloId,
    ]);
    expect(
      (await SiloScope.resolve(state.pool, created.principalId, 'read_markdown')).siloIds,
    ).toEqual([]);
    expect((await SiloScope.resolve(state.pool, created.principalId, 'upload')).siloIds).toEqual(
      [],
    );
    await revokeApiKey(state.pool, created.principalId, state.administratorId);
    expect(
      await authenticateApiKey(state.pool, new ApiKeyRateLimiter(), created.token, '10.1.2.3', now),
    ).toEqual({ ok: false, code: 'invalid-key' });
    const expired = await createApiKey(state.pool, {
      label: 'expired-key',
      createdBy: state.administratorId,
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(
      await authenticateApiKey(state.pool, new ApiKeyRateLimiter(), expired.token, '10.1.2.3', now),
    ).toEqual({ ok: false, code: 'invalid-key' });
  });

  it('encrypts provider tokens with AES-256-GCM and exposes only keyed fingerprints', async () => {
    const vault = new SecretVault(Buffer.alloc(32, 0x42));
    const metadata = await vault.store(
      state.pool,
      'ollama',
      'primary',
      'provider-token-plaintext',
      state.administratorId,
    );
    expect(metadata).toMatchObject({ provider: 'ollama', name: 'primary', exists: true });
    expect(JSON.stringify(metadata)).not.toContain('provider-token-plaintext');
    expect(vault.matchesFingerprint('provider-token-plaintext', metadata.fingerprint)).toBe(true);
    expect(await vault.reveal(state.pool, 'ollama', 'primary')).toBe('provider-token-plaintext');
    const raw = await state.pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM noderag.encrypted_secret
       WHERE provider = 'ollama' AND name = 'primary'`,
    );
    expect(raw.rows[0]?.ciphertext.toString('utf8')).not.toContain('provider-token-plaintext');
  });

  it('replays matching idempotent mutations and conflicts on digest reuse', async () => {
    let executions = 0;
    const input = {
      principalId: state.administratorId,
      operation: 'test.mutation',
      key: 'm03-idempotency-key',
      request: '{"value":1}',
      now: new Date('2026-09-04T11:00:00Z'),
    } as const;
    const first = await executeIdempotent(state.pool, input, async () => {
      executions += 1;
      return { status: 201, headers: { location: '/synthetic/1' }, body: { id: 1 } };
    });
    const replay = await executeIdempotent(state.pool, input, async () => {
      executions += 1;
      return { status: 500, headers: {}, body: {} };
    });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ replayed: true, response: first.response });
    expect(executions).toBe(1);
    await expect(
      executeIdempotent(
        state.pool,
        { ...input, request: '{"value":2}' },
        async () => first.response,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('fails worker claims closed until readiness is operational', async () => {
    await state.pool.query("UPDATE noderag.setup_state SET state = 'maintenance' WHERE id = 1");
    await state.pool.query(
      `INSERT INTO noderag.job (kind, silo_id, payload)
       VALUES ('crawl', $1, '{"synthetic":true}')`,
      [state.defaultSiloId],
    );
    expect(await claimNextJob(state.pool, 'm03-worker')).toBeNull();
    await state.pool.query("UPDATE noderag.setup_state SET state = 'operational' WHERE id = 1");
    const claimed = await claimNextJob(state.pool, 'm03-worker');
    expect(claimed).toMatchObject({ kind: 'crawl', attempts: 1 });
    const event = await state.pool.query<{ event_type: string }>(
      'SELECT event_type FROM noderag.job_event WHERE job_id = $1 ORDER BY sequence',
      [claimed?.id],
    );
    expect(event.rows.map(({ event_type }) => event_type)).toEqual(['leased']);
  });

  it('hashes normalized queries, redacts audit detail, and cleans retention in batches', async () => {
    expect(hashNormalizedQuery('  SECRET   Query ')).toEqual(hashNormalizedQuery('secret query'));
    await writeAuditEvent(state.pool, {
      principalId: state.capabilityUserId,
      action: 'search',
      result: 'ok',
      normalizedQuerySha256: hashNormalizedQuery('private terms'),
      detail: { mode: 'vector', rawQuery: 'private terms', password: 'never' },
      requestId: 'audit-test',
    });
    const stored = await state.pool.query<{
      detail: Record<string, unknown>;
      query_sha256: Buffer;
    }>(`SELECT detail, query_sha256 FROM noderag.audit_log WHERE request_id = 'audit-test'`);
    expect(stored.rows[0]?.detail).toEqual({ mode: 'vector' });
    expect(stored.rows[0]?.query_sha256).toHaveLength(32);
    await state.pool.query(
      `INSERT INTO noderag.audit_log (occurred_at, action, result)
       VALUES (now() - interval '100 days', 'retention.test', 'ok')`,
    );
    expect(await cleanExpiredAuditEvents(state.pool, 1)).toBe(1);
  });

  it('keeps silo purge disabled by default but proves transactional partition drop', async () => {
    const temporary = await createSilo(state.pool, {
      slug: 'purge-test',
      displayName: 'Purge Test',
      creatingPrincipalId: state.administratorId,
    });
    await expect(
      purgeSilo(state.pool, {
        siloId: temporary.id,
        expectedSlug: temporary.slug,
        principalId: state.administratorId,
      }),
    ).rejects.toThrow('silo-purge-disabled-until-m05');
    await purgeSilo(state.pool, {
      siloId: temporary.id,
      expectedSlug: temporary.slug,
      principalId: state.administratorId,
      allowDestructivePurge: true,
    });
    const removed = await state.pool.query<{ silo: string | null; partition: string | null }>(
      `SELECT
         (SELECT slug FROM noderag.silo WHERE id = $1) AS silo,
         to_regclass($2) AS partition`,
      [temporary.id, `noderag.chunk_s${String(temporary.id)}`],
    );
    expect(removed.rows[0]).toEqual({ silo: null, partition: null });
  });

  it('covers every inventoried route for unauthenticated, zero-grant, and search-only callers', async () => {
    const routes = await loadAuthorizationInventory();
    expect(routes.length).toBeGreaterThan(60);
    for (const route of routes) {
      const unauthenticated = authorizeRoute(route, {
        authenticated: false,
        serverAdmin: false,
        searchOnlyCredential: false,
      });
      expect(unauthenticated.allowed, `${route.method} ${route.path}`).toBe(
        route.scope === 'public',
      );
      if (route.scope === 'silo' && route.action !== undefined) {
        const scope = await SiloScope.resolve(state.pool, state.zeroGrantId, route.action);
        const zeroGrant = authorizeRoute(route, {
          authenticated: true,
          serverAdmin: false,
          searchOnlyCredential: false,
          scope,
        });
        if (route.emptyBehavior === 'empty_result') {
          expect(zeroGrant).toEqual({ allowed: true, emptyResult: true });
        } else {
          expect(zeroGrant).toMatchObject({ allowed: false, status: 404 });
        }
      }
      if (!route.searchOnlyAllowed && route.scope !== 'public') {
        const denied = authorizeRoute(route, {
          authenticated: true,
          serverAdmin: false,
          searchOnlyCredential: true,
        });
        expect(denied).toMatchObject({ allowed: false, status: 404 });
      }
    }
    const documentRoute = routes.find(
      (route) => route.method === 'GET' && route.path === '/v1/documents/:id',
    );
    if (documentRoute === undefined || documentRoute.action === undefined) {
      throw new Error('Document authorization inventory entry is missing.');
    }
    const readScope = await SiloScope.resolve(
      state.pool,
      state.capabilityUserId,
      documentRoute.action,
    );
    expect(
      authorizeRoute(documentRoute, {
        authenticated: true,
        serverAdmin: false,
        searchOnlyCredential: false,
        scope: readScope,
        resourceSiloId: state.uploadSiloId,
      }),
    ).toMatchObject({ allowed: false, status: 404 });
  });

  it('exposes minimal setup/auth routes while a zero-grant user receives an empty silo list', async () => {
    const app = buildApp({
      logger: false,
      readiness: async () => ({
        service: 'noderag',
        status: 'ok',
        state: 'operational',
        migrationHead: '000002_identity_foundation',
        expectedMigrationHead: '000002_identity_foundation',
        reasons: [],
      }),
      uiRoot: 'missing-ui',
      identity: {
        pool: state.pool,
        expectedOrigin: 'http://noderag.test',
        secureCookie: false,
      },
    });
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'zero-grant', password: zeroGrantPassword },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const silos = await app.inject({ method: 'GET', url: '/v1/silos', headers: { cookie } });
    expect(silos.statusCode).toBe(200);
    expect(silos.json()).toEqual({ items: [] });
    const openApi = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
      headers: { cookie },
    });
    expect(openApi.statusCode).toBe(200);
    expect(openApi.json()).toMatchObject({ openapi: '3.1.0', info: { version: '0.2.0' } });
    const rejectedOrigin = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: {
        cookie,
        origin: 'http://evil.test',
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
      },
      payload: { currentPassword: zeroGrantPassword, nextPassword: 'M03-not-applied-password!' },
    });
    expect(rejectedOrigin.statusCode).toBe(403);
    const missingIdempotency = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
      },
      payload: { currentPassword: zeroGrantPassword, nextPassword: 'M03-not-applied-password!' },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json()).toMatchObject({ code: 'idempotency_key_required' });
    const changed = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/password',
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
        'idempotency-key': 'identity-route-password-change-1',
      },
      payload: { currentPassword: zeroGrantPassword, nextPassword: 'M03-route-password-next!' },
    });
    expect(changed.statusCode).toBe(204);
    expect(changed.headers['idempotency-replayed']).toBe('false');
    expect(
      await authenticatePassword(state.pool, {
        username: 'zero-grant',
        password: 'M03-route-password-next!',
        requestId: 'route-password-change',
      }),
    ).toMatchObject({ ok: true, principalId: state.zeroGrantId });
    await app.close();
  });
});
