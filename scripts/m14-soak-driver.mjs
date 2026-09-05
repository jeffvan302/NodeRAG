import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base = 'http://127.0.0.1:8787';
const gatewayBase = 'http://127.0.0.1:5301';
const packageVar = process.env.SYNOPKG_PKGVAR;
const evidenceRoot = process.env.NODERAG_M14_EVIDENCE_ROOT ?? '/evidence';
const durationSeconds = Number(process.env.NODERAG_M14_DURATION_SECONDS ?? '86400');
const intervalSeconds = Number(process.env.NODERAG_M14_INTERVAL_SECONDS ?? '60');
const allowShort = process.env.NODERAG_M14_ALLOW_SHORT === '1';
if (!packageVar) throw new Error('SYNOPKG_PKGVAR is required');
if (!Number.isInteger(durationSeconds) || durationSeconds < 1)
  throw new Error('invalid-soak-duration');
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1)
  throw new Error('invalid-soak-interval');
if (durationSeconds < 86_400 && !allowShort) throw new Error('m14-soak-must-run-at-least-24-hours');

await mkdir(evidenceRoot, { recursive: true });
const startedAt = new Date();
const proof = {
  schemaVersion: 1,
  milestone: 'M14',
  candidate: '1.0.0-rc.1',
  artifactSha256: process.env.NODERAG_M14_ARTIFACT_SHA256 ?? 'unknown',
  startedAt: startedAt.toISOString(),
  requestedDurationSeconds: durationSeconds,
  minimumDurationSatisfied: durationSeconds >= 86_400,
  validationMode: allowShort,
  workload: {
    scheduledCrawl: false,
    backgroundIngest: 0,
    searchRequests: 0,
    mcpRequests: 0,
    gatewayRequests: 0,
    locatorChecks: 0,
    crossSiloChecks: 0,
    ollamaInterruptions: 0,
    ollamaRecoveries: 0,
    backupsVerified: 0,
    scheduledBackupsVerified: 0,
    processRestarts: 0,
    logRotationVerified: false,
    competingIoChecks: 0,
    sourceMissingRecovered: false,
    reindexVerified: false,
    rebuildVerified: false,
  },
  samples: [],
  failures: [],
  passed: false,
};

const atomicWrite = async (name, value) => {
  const target = join(evidenceRoot, name);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
};
const live = () => atomicWrite('m14-soak-live.json', proof);
const key = (prefix) => `${prefix}-${crypto.randomUUID()}`;

let cookie = '';
let csrf = '';
const request = async (method, path, body, options = {}) => {
  const response = await fetch(`${options.base ?? base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.mutation
        ? {
            origin: base,
            'x-csrf-token': csrf,
            'idempotency-key': options.idempotencyKey ?? key('m14'),
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!options.accept?.includes(response.status) && !response.ok) {
    throw new Error(`${method} ${path} failed: ${String(response.status)} ${text.slice(0, 500)}`);
  }
  return { status: response.status, body: parsed, headers: response.headers };
};
const login = async (username, password) => {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`login-failed:${String(response.status)}`);
  const body = await response.json();
  return {
    cookie: (response.headers.get('set-cookie') ?? '').split(';', 1)[0],
    csrf: body.csrfToken,
  };
};
const waitFor = async (description, action, maximumSeconds = 120) => {
  const deadline = Date.now() + maximumSeconds * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await action();
      if (last) return last;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('fatal:')) throw error;
      last = error;
    }
    await delay(1000);
  }
  throw new Error(
    `${description}-timeout:${last instanceof Error ? last.message : JSON.stringify(last)}`,
  );
};
const uploadMarkdown = async (siloId, name, content, idempotencyKey) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), name);
  const response = await fetch(`${base}/v1/documents?siloId=${String(siloId)}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'x-csrf-token': csrf,
      'idempotency-key': idempotencyKey,
    },
    body: form,
  });
  if (response.status !== 202)
    throw new Error(`upload-failed:${name}:${String(response.status)}:${await response.text()}`);
  return response.json();
};
const search = async (query, silos, mode = 'hybrid', options = {}) => {
  const found = await request('POST', '/v1/search', { query, mode, silos, limit: 10 }, options);
  proof.workload.searchRequests += 1;
  return found.body;
};
const waitForHit = (query, silos, expected, mode = 'hybrid') =>
  waitFor('search-hit', async () => {
    const found = await search(query, silos, mode);
    return found.items?.find((item) => item.text.includes(expected));
  });
const verifyLocator = async (hit) => {
  const bucket = String(Math.floor(hit.documentId / 1000)).padStart(6, '0');
  const markdown = await readFile(
    join(packageVar, 'data', 'documents', bucket, String(hit.documentId), 'canonical.md'),
    'utf8',
  );
  const characters = markdown.slice(hit.locator.characterStart, hit.locator.characterEnd);
  const bytes = Buffer.from(markdown, 'utf8')
    .subarray(hit.locator.byteStart, hit.locator.byteEnd)
    .toString('utf8');
  if (characters !== hit.text || bytes !== hit.text) throw new Error('locator-mismatch');
  proof.workload.locatorChecks += 1;
};
const directoryBytes = async (root) => {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
};
const rssKiB = async (pidFile) => {
  const pid = (await readFile(pidFile, 'utf8')).trim();
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  return Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? '0');
};
const recordResources = async (cycle) => {
  const sample = {
    cycle,
    at: new Date().toISOString(),
    packageVarBytes: await directoryBytes(packageVar),
    rssKiB: {
      server: await rssKiB(join(packageVar, 'run', 'noderag.pid')),
      worker: await rssKiB(join(packageVar, 'run', 'worker.pid')),
      embedder: await rssKiB(join(packageVar, 'run', 'embedder.pid')),
    },
  };
  if (sample.packageVarBytes > 2 * 1024 ** 3) throw new Error('unbounded-package-data-growth');
  if (Object.values(sample.rssKiB).some((value) => value > 1_500_000))
    throw new Error('unbounded-process-memory-growth');
  proof.samples.push(sample);
};

let ollama;
const startOllama = async () => {
  ollama = spawn(process.execPath, ['/simulator/m14-ollama-mock.mjs'], { stdio: 'inherit' });
  await waitFor(
    'ollama-start',
    async () => {
      const response = await fetch('http://127.0.0.1:11434/api/tags').catch(() => null);
      return response?.ok;
    },
    30,
  );
};
const stopOllama = async () => {
  if (!ollama || ollama.exitCode !== null) return;
  ollama.kill('SIGTERM');
  await waitFor('ollama-stop', async () => ollama.exitCode !== null, 20);
};
const activateVision = async (suffix, expectedStatus = 200) => {
  const result = await request(
    'POST',
    '/v1/admin/vision/test',
    {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'noderag-soak-vision:latest',
      maximumParallel: 1,
      timeoutMs: 3000,
      maximumAttempts: 2,
      maximumImageDimension: 1600,
    },
    { mutation: true, idempotencyKey: `m14-vision-${suffix}`, accept: [expectedStatus] },
  );
  if (result.status !== expectedStatus)
    throw new Error(`vision-status-mismatch:${String(result.status)}`);
};
const restartPackage = async () => {
  await appendFile(join(packageVar, 'log', 'noderag.log'), randomBytes(96 * 1024));
  execFileSync('/work/outer/scripts/start-stop-status', ['restart'], {
    stdio: 'inherit',
    env: process.env,
  });
  await waitFor(
    'package-restart',
    async () => (await fetch(`${base}/health`).catch(() => null))?.ok,
    90,
  );
  if ((await stat(join(packageVar, 'log', 'noderag.log.1')).catch(() => null)) === null)
    throw new Error('log-rotation-not-observed');
  proof.workload.logRotationVerified = true;
  proof.workload.processRestarts += 1;
};

try {
  const health = await request('GET', '/health');
  if (health.body.version !== '1.0.0-rc.1') throw new Error('candidate-health-version-mismatch');
  const setupToken = (await readFile(join(packageVar, 'secrets', 'setup.token'), 'utf8')).trim();
  const configured = await request('POST', '/v1/setup/configure', {
    setupToken,
    username: 'm14-admin',
    password: 'M14-release-candidate-admin!',
    defaultSiloName: 'M14 Primary',
  });
  const defaultSilo = configured.body.defaultSilo.id;
  ({ cookie, csrf } = await login('m14-admin', 'M14-release-candidate-admin!'));

  const ui = await fetch(`${base}/`);
  if (!ui.ok || !(await ui.text()).includes('NodeRag'))
    throw new Error('production-ui-unavailable');
  const ready = await request('GET', '/ready');
  if (ready.body.status !== 'ok' || ready.body.migrationHead !== '000011_recovery_hardening')
    throw new Error('candidate-readiness-identity-mismatch');

  const secretSilo = (
    await request(
      'POST',
      '/v1/admin/silos',
      { slug: 'm14-secret', displayName: 'M14 Isolation Silo' },
      { mutation: true, idempotencyKey: 'm14-secret-silo' },
    )
  ).body.id;
  await uploadMarkdown(
    secretSilo,
    'isolation.md',
    '# Isolation\n\nORCHID-NEBULA-PRIVATE must never cross a silo boundary.\n',
    'm14-secret-upload',
  );
  await waitForHit('ORCHID-NEBULA-PRIVATE', [secretSilo], 'ORCHID-NEBULA-PRIVATE', 'keyword');
  const readerId = (
    await request(
      'POST',
      '/v1/admin/principals',
      {
        username: 'm14-reader',
        password: 'M14-release-candidate-reader!',
        serverAdmin: false,
        mustChange: false,
      },
      { mutation: true, idempotencyKey: 'm14-reader' },
    )
  ).body.id;
  await request(
    'PUT',
    `/v1/admin/grants/${String(readerId)}/${String(defaultSilo)}/read`,
    undefined,
    {
      mutation: true,
      idempotencyKey: 'm14-reader-default-read',
    },
  );

  const primaryUpload = await uploadMarkdown(
    defaultSilo,
    'unicode.md',
    '\uFEFF# M14 Unicode\r\n\r\nThe cobalt résumé 漢字 🚀 locator remains exact after every restart.\r\n',
    'm14-primary-upload',
  );
  const primaryHit = await waitForHit(
    'cobalt résumé locator',
    [defaultSilo],
    'cobalt résumé',
    'hybrid',
  );
  await verifyLocator(primaryHit);
  await request(
    'POST',
    `/v1/documents/${String(primaryUpload.documentId)}/reindex`,
    { siloId: defaultSilo },
    { mutation: true, idempotencyKey: 'm14-primary-reindex' },
  );
  await waitForHit('cobalt résumé locator', [defaultSilo], 'cobalt résumé', 'hybrid');
  proof.workload.reindexVerified = true;

  const watchedPath = '/work/watch-base/watch/source.md';
  await mkdir('/work/watch-base/watch', { recursive: true });
  await writeFile(
    watchedPath,
    '# Scheduled source\n\nThe cerulean scheduled crawler is healthy.\n',
  );
  const source = (
    await request(
      'POST',
      '/v1/sources',
      {
        siloId: defaultSilo,
        uri: '/work/watch-base/watch',
        includeGlobs: ['**/*.md'],
        scheduleIntervalMinutes: 1,
      },
      { mutation: true, idempotencyKey: 'm14-source' },
    )
  ).body;
  await request(
    'PATCH',
    `/v1/sources/${String(source.id)}`,
    { siloId: defaultSilo, scheduleEnabled: true },
    { mutation: true, idempotencyKey: 'm14-source-enable' },
  );
  await request(
    'POST',
    `/v1/sources/${String(source.id)}/crawl`,
    { siloId: defaultSilo },
    { mutation: true, idempotencyKey: 'm14-source-first-crawl' },
  );
  await waitForHit(
    'cerulean scheduled crawler',
    [defaultSilo],
    'cerulean scheduled crawler',
    'keyword',
  );
  proof.workload.scheduledCrawl = true;

  await request(
    'POST',
    '/v1/admin/gateways',
    { name: 'M14Gateway', port: 5301, siloIds: [defaultSilo], requireAuth: true, enabled: true },
    { mutation: true, idempotencyKey: 'm14-gateway' },
  );
  await waitFor(
    'gateway-bind',
    async () => (await fetch(`${gatewayBase}/health`).catch(() => null))?.ok,
    30,
  );

  const rebuildProposal = (
    await request(
      'POST',
      '/v1/admin/builds',
      { reason: 'M14 exact-package rebuild acceptance', siloIds: [defaultSilo] },
      { mutation: true, idempotencyKey: 'm14-rebuild-proposal' },
    )
  ).body;
  const rebuilt = (
    await request(
      'POST',
      `/v1/admin/build-proposals/${String(rebuildProposal.id)}/confirm`,
      { confirm: true },
      { mutation: true, idempotencyKey: 'm14-rebuild-confirm' },
    )
  ).body;
  await waitFor(
    'rebuild-stage',
    async () => {
      const state = (await request('GET', '/v1/admin/builds')).body;
      const build = state.items.find((item) => Number(item.id) === Number(rebuilt.buildId));
      return build?.silos?.every(
        (silo) => Number(silo.completedDocuments) === Number(silo.totalDocuments),
      );
    },
    300,
  );
  await request(
    'POST',
    `/v1/admin/builds/${String(rebuilt.buildId)}/verify`,
    { siloId: defaultSilo },
    { mutation: true, idempotencyKey: 'm14-rebuild-verify' },
  );
  await request(
    'POST',
    `/v1/admin/builds/${String(rebuilt.buildId)}/activate`,
    { siloIds: [defaultSilo] },
    { mutation: true, idempotencyKey: 'm14-rebuild-activate' },
  );
  await waitForHit('cobalt résumé locator', [defaultSilo], 'cobalt résumé', 'hybrid');
  proof.workload.rebuildVerified = true;

  await mkdir('/volume1/NodeRag/soak-backups', { recursive: true });
  const storage = (
    await request(
      'POST',
      '/v1/admin/storage',
      {
        name: 'M14 soak backups',
        managedPath: '/volume1/NodeRag/soak-backups',
        purpose: 'backup',
        enabled: true,
      },
      { mutation: true, idempotencyKey: 'm14-backup-storage' },
    )
  ).body;
  const backup = (
    await request(
      'POST',
      '/v1/admin/backups',
      {
        action: 'run',
        destinationId: storage.id,
        product: 'full',
        passphrase: 'M14 synthetic soak backup passphrase',
        includeModels: false,
      },
      { mutation: true, idempotencyKey: 'm14-backup-run' },
    )
  ).body;
  await waitFor(
    'verified-backup',
    async () => {
      const backups = (await request('GET', '/v1/admin/backups')).body.items;
      const found = backups.find((item) => Number(item.id) === Number(backup.id));
      if (found?.state === 'failed') throw new Error(`fatal:backup-failed:${found.errorCode}`);
      return found?.state === 'succeeded' && found.verificationState === 'verified';
    },
    300,
  );
  proof.workload.backupsVerified += 1;
  const next = new Date(Date.now() + 2 * 60 * 1000);
  await request(
    'POST',
    '/v1/admin/backups',
    {
      action: 'schedule',
      name: 'm14-soak-daily',
      destinationId: storage.id,
      product: 'full',
      passphrase: 'M14 synthetic scheduled backup passphrase',
      cadence: 'daily',
      utcHour: next.getUTCHours(),
      utcMinute: next.getUTCMinutes(),
      utcWeekday: null,
      retainCount: 2,
      enabled: true,
    },
    { mutation: true, idempotencyKey: 'm14-backup-schedule' },
  );

  await startOllama();
  await activateVision('initial');
  await stopOllama();
  proof.workload.ollamaInterruptions += 1;
  await activateVision('outage', 422);
  await startOllama();
  await activateVision('recovered');
  proof.workload.ollamaRecoveries += 1;

  await restartPackage();
  const soakStart = Date.now();
  const soakDeadline = soakStart + durationSeconds * 1000;
  let nextRestart = soakStart + 6 * 60 * 60 * 1000;
  let cycle = 0;
  let missingExerciseDone = false;
  while (Date.now() < soakDeadline) {
    cycle += 1;
    const currentHealth = await request('GET', '/health');
    if (currentHealth.body.version !== '1.0.0-rc.1') throw new Error('health-identity-drift');
    const integrity = await request('GET', '/v1/admin/health');
    if (integrity.body.status !== 'ok') throw new Error('critical-health-alarm');

    for (const mode of ['vector', 'keyword', 'hybrid']) {
      const hit = await waitForHit('cobalt résumé locator', [defaultSilo], 'cobalt résumé', mode);
      await verifyLocator(hit);
    }
    const mcp = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: cycle,
      method: 'tools/call',
      params: {
        name: 'search_documents',
        arguments: {
          query: 'cobalt résumé locator',
          mode: 'hybrid',
          siloIds: [defaultSilo],
          limit: 10,
        },
      },
    });
    const mcpItems = mcp.body.result?.structuredContent?.result?.items ?? [];
    if (!mcpItems.some((item) => item.text.includes('cobalt résumé')))
      throw new Error('mcp-search-drift');
    proof.workload.mcpRequests += 1;
    const gateway = await search('cobalt résumé locator', [defaultSilo, secretSilo], 'hybrid', {
      base: gatewayBase,
    });
    if (!gateway.items.some((item) => item.text.includes('cobalt résumé')))
      throw new Error('gateway-search-drift');
    if (gateway.items.some((item) => item.text.includes('ORCHID-NEBULA-PRIVATE')))
      throw new Error('gateway-cross-silo-exposure');
    proof.workload.gatewayRequests += 1;

    const adminSession = { cookie, csrf };
    ({ cookie, csrf } = await login('m14-reader', 'M14-release-candidate-reader!'));
    const isolated = await search('ORCHID-NEBULA-PRIVATE', [defaultSilo, secretSilo], 'keyword');
    if (isolated.items.length !== 0) throw new Error('principal-cross-silo-exposure');
    proof.workload.crossSiloChecks += 1;
    ({ cookie, csrf } = adminSession);

    const jobs = (await request('GET', '/v1/jobs')).body.items;
    const stale = jobs.find(
      (job) => job.state === 'leased' && Date.now() - Date.parse(job.updatedAt) > 5 * 60 * 1000,
    );
    if (stale) throw new Error(`unrecovered-lease:${String(stale.id)}`);
    const terminalFailure = jobs.find((job) => job.state === 'failed');
    if (terminalFailure) throw new Error(`terminal-work-failed:${String(terminalFailure.id)}`);

    if (cycle % 5 === 0) {
      await writeFile(
        watchedPath,
        `# Scheduled source\n\nThe cerulean scheduled crawler is healthy at cycle ${String(cycle)}.\n`,
      );
    }
    if (cycle % 10 === 0) {
      const token = `SOAK-CYCLE-${String(cycle).padStart(6, '0')}`;
      await uploadMarkdown(
        defaultSilo,
        `soak-${String(cycle)}.md`,
        `# Background ingest\n\n${token} was indexed under sustained load.\n`,
        `m14-soak-upload-${String(cycle)}`,
      );
      await waitForHit(token, [defaultSilo], token, 'keyword');
      proof.workload.backgroundIngest += 1;
    }
    if (
      !missingExerciseDone &&
      (allowShort ? cycle >= 2 : Date.now() - soakStart >= 2 * 60 * 60 * 1000)
    ) {
      await writeFile(watchedPath, '');
      await import('node:fs/promises').then(({ unlink }) => unlink(watchedPath));
      await request(
        'POST',
        `/v1/sources/${String(source.id)}/crawl`,
        { siloId: defaultSilo },
        { mutation: true },
      );
      await waitFor('source-missing-state', async () => {
        const documents = (
          await request(
            'GET',
            `/v1/documents?siloId=${String(defaultSilo)}&state=source_missing&limit=100`,
          )
        ).body.items;
        return documents.some((document) => Number(document.sourceId) === Number(source.id));
      });
      await waitForHit(
        'cerulean scheduled crawler',
        [defaultSilo],
        'cerulean scheduled crawler',
        'keyword',
      );
      await writeFile(
        watchedPath,
        '# Scheduled source\n\nThe cerulean scheduled crawler recovered after a missing-source interval.\n',
      );
      await request(
        'POST',
        `/v1/sources/${String(source.id)}/crawl`,
        { siloId: defaultSilo },
        { mutation: true },
      );
      await waitForHit(
        'cerulean scheduled crawler recovered',
        [defaultSilo],
        'cerulean scheduled crawler recovered',
        'keyword',
      );
      proof.workload.sourceMissingRecovered = true;
      missingExerciseDone = true;
    }
    if (Date.now() >= nextRestart) {
      await stopOllama();
      proof.workload.ollamaInterruptions += 1;
      await restartPackage();
      await startOllama();
      await activateVision(`recovery-${String(cycle)}`);
      proof.workload.ollamaRecoveries += 1;
      nextRestart += 6 * 60 * 60 * 1000;
    }

    const ioPath = '/volume1/NodeRag/competing-io.bin';
    const io = randomBytes(8 * 1024 * 1024);
    await writeFile(ioPath, io);
    const reread = await readFile(ioPath);
    if (
      createHash('sha256').update(io).digest('hex') !==
      createHash('sha256').update(reread).digest('hex')
    )
      throw new Error('competing-io-integrity-failed');
    proof.workload.competingIoChecks += 1;
    await recordResources(cycle);

    const backupState = await request('GET', '/v1/admin/backups');
    const schedule = backupState.body.schedules.find((item) => item.name === 'm14-soak-daily');
    if (schedule?.lastResult === 'failed') throw new Error('scheduled-backup-failed');
    if (schedule?.lastResult === 'succeeded') proof.workload.scheduledBackupsVerified = 1;
    await live();
    const remaining = soakDeadline - Date.now();
    if (remaining > 0) await delay(Math.min(intervalSeconds * 1000, remaining));
  }

  if (!proof.workload.sourceMissingRecovered)
    throw new Error('source-missing-recovery-not-exercised');
  if (proof.workload.scheduledBackupsVerified < 1 && !allowShort)
    throw new Error('scheduled-backup-not-verified');
  const sources = (await request('GET', `/v1/sources?siloIds=${String(defaultSilo)}`)).body.items;
  const finalSource = sources.find((item) => Number(item.id) === Number(source.id));
  if (!finalSource?.lastCrawlAt) throw new Error('scheduled-crawl-not-observed');
  const audit = await request('GET', '/v1/admin/audit?limit=100');
  if (!audit.body.items?.some((entry) => entry.action === 'search'))
    throw new Error('search-audit-missing');
  proof.completedAt = new Date().toISOString();
  proof.actualDurationSeconds = Math.floor((Date.now() - soakStart) / 1000);
  proof.passed = allowShort || proof.actualDurationSeconds >= 86_400;
  if (!proof.passed) throw new Error('minimum-soak-duration-not-reached');
} catch (error) {
  proof.failures.push({
    at: new Date().toISOString(),
    code: error instanceof Error ? error.message.split(':', 1)[0] : 'unknown',
    errorName: error instanceof Error ? error.name : 'unknown',
  });
  proof.completedAt = new Date().toISOString();
  proof.passed = false;
  await live().catch(() => undefined);
  await atomicWrite('m14-soak-proof.json', proof).catch(() => undefined);
  await stopOllama().catch(() => undefined);
  throw error;
}

await stopOllama();
await live();
await atomicWrite('m14-soak-proof.json', proof);
process.stdout.write(`M14 soak passed after ${String(proof.actualDurationSeconds)} seconds.\n`);
