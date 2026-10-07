import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { resolve } from 'node:path';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const operational = async (
  page: Page,
  account = { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false },
) => {
  let signedIn = false;
  await page.route('**/ready', (route) =>
    json(route, {
      service: 'noderag',
      status: 'ok',
      state: 'operational',
      migrationHead: '000007_operator_ui',
      expectedMigrationHead: '000007_operator_ui',
      reasons: [],
    }),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(route, {
      state: 'operational',
      tokenIssued: false,
      tokenExpiresAt: null,
      step: 'complete',
      progress: 100,
    }),
  );
  await page.route('**/v1/auth/me', (route) =>
    signedIn
      ? json(route, account)
      : json(route, { status: 401, code: 'authentication_required' }, 401),
  );
  await page.route('**/v1/auth/login', (route) => {
    signedIn = true;
    return json(route, {
      principalId: account.principalId,
      serverAdmin: account.serverAdmin,
      csrfToken: 'test-csrf',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/research', (route) => json(route, { items: [] }));
  await page.route('**/v1/research/memberships?**', (route) => json(route, { items: [] }));
};

const signIn = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('A-long-test-password!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Ask your documents' })).toBeVisible();
};

test('completes protected setup and presents a complete copyable recovery code', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const recoveryCode = 'recovery_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
  let configured = false;
  await page.route('**/ready', (route) =>
    json(route, { status: 'unavailable', state: 'unconfigured' }, 503),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(
      route,
      configured
        ? {
            state: 'operational',
            tokenIssued: false,
            tokenExpiresAt: null,
            step: 'sign-in',
            progress: 30,
          }
        : {
            state: 'unconfigured',
            tokenIssued: true,
            tokenExpiresAt: '2030-01-01T00:00:00Z',
            step: 'verify-token',
            progress: 0,
          },
    ),
  );
  await page.route('**/v1/setup/verify-token', (route) => json(route, { valid: true }));
  await page.route('**/v1/setup/configure', (route) => {
    configured = true;
    return json(route, { principalId: 1, defaultSilo: { id: 1 }, recoveryCode }, 201);
  });
  await page.route('**/v1/auth/me', (route) =>
    json(route, { status: 401, code: 'authentication_required' }, 401),
  );
  await page.goto('/');
  await page.getByLabel('Setup key').fill('setup_test-only-valid-key');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Default knowledge space').fill('Policies');
  await page.getByLabel(/^Password/).fill('A-long-test-password!');
  await page.getByLabel('Confirm password').fill('A-long-test-password!');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  const recoveryField = page.getByLabel('Complete recovery code');
  await expect(recoveryField).toBeVisible();
  await expect(recoveryField).toHaveValue(recoveryCode);
  await expect(page.getByText('Start of code')).toBeVisible();
  await expect(page.getByText('End of code')).toBeVisible();
  await page.getByRole('button', { name: 'Copy full recovery code' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'The full recovery code is on your clipboard.' }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(recoveryCode);
  await page.getByRole('button', { name: /I saved it/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to NodeRag' })).toBeVisible();
});

test('recovers the durable first-run stage after a browser refresh', async ({ page }) => {
  await page.route('**/ready', (route) =>
    json(route, { service: 'noderag', status: 'ok', state: 'operational' }),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(route, {
      state: 'operational',
      tokenIssued: false,
      tokenExpiresAt: null,
      step: 'calibration',
      progress: 55,
    }),
  );
  await page.route('**/v1/setup/events', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: setup-status\ndata: {"state":"operational","tokenIssued":false,"tokenExpiresAt":null,"step":"calibration","progress":55}\n\n',
    }),
  );
  await page.route('**/v1/auth/me', (route) =>
    json(route, { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false }),
  );
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Measure this machine' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Measure this machine' })).toBeVisible();
});

test('installs a missing local model before running first-start calibration', async ({ page }) => {
  let installStarted = false;
  let statusPolls = 0;
  let calibrationCalled = false;
  let calibrationStatusPolls = 0;
  await page.route('**/ready', (route) =>
    json(route, { service: 'noderag', status: 'ok', state: 'operational' }),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(route, {
      state: 'operational',
      tokenIssued: false,
      tokenExpiresAt: null,
      step: 'calibration',
      progress: 55,
    }),
  );
  await page.route('**/v1/setup/events', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: setup-status\ndata: {"state":"operational","tokenIssued":false,"tokenExpiresAt":null,"step":"calibration","progress":55}\n\n',
    }),
  );
  await page.route('**/v1/auth/me', (route) =>
    json(route, { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false }),
  );
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/admin/models/default/status', (route) => {
    const ready = installStarted && statusPolls >= 1;
    if (installStarted) statusPolls += 1;
    return json(route, {
      state: ready ? 'ready' : installStarted ? 'downloading' : 'missing',
      downloadedBytes: ready ? 611561199 : installStarted ? 305780599 : 0,
      totalBytes: 611561199,
      progress: ready ? 100 : installStarted ? 50 : 0,
      currentFile: ready ? null : 'model.onnx',
      errorCode: null,
    });
  });
  await page.route('**/v1/admin/models/default/install', (route) => {
    installStarted = true;
    return json(
      route,
      {
        state: 'downloading',
        downloadedBytes: 0,
        totalBytes: 611561199,
        progress: 0,
        currentFile: 'model.onnx',
        errorCode: null,
      },
      202,
    );
  });
  const calibrationResult = {
    chunks: 20,
    characters: 32000,
    elapsedMs: 1000,
    charactersPerSecond: 32000,
    projectedMinutesPerMillionCharacters: 0.5,
    model: 'Qwen3-Embedding-0.6B',
    revision: 'test-revision',
  };
  await page.route('**/v1/admin/calibration/embedding/start', (route) => {
    calibrationCalled = true;
    return json(
      route,
      {
        id: 'calibration-test-job',
        state: 'running',
        phase: 'loading-model',
        progress: 5,
        result: null,
        errorCode: null,
      },
      202,
    );
  });
  await page.route('**/v1/admin/calibration/embedding/status', (route) => {
    calibrationStatusPolls += 1;
    return json(route, {
      id: 'calibration-test-job',
      state: 'succeeded',
      phase: 'finalizing',
      progress: 100,
      result: calibrationResult,
      errorCode: null,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Run calibration' }).click();
  await expect(page.getByText(/Installing the required local model: 50%/)).toBeVisible();
  await expect(page.getByText(/Loading the local model for the first time/)).toBeVisible();
  await expect(page.getByText('32000 characters/second')).toBeVisible();
  expect(calibrationCalled).toBe(true);
  expect(calibrationStatusPolls).toBeGreaterThan(0);
});

test('uses DSM package storage and saves a managed child for an existing shared folder', async ({
  page,
}) => {
  let probedPath = '';
  let idempotencyKey = '';
  let savedStorage: Record<string, unknown> | null = null;
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });
  await page.route('**/ready', (route) =>
    json(route, { service: 'noderag', status: 'ok', state: 'operational' }),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(route, {
      state: 'operational',
      tokenIssued: false,
      tokenExpiresAt: null,
      step: 'storage',
      progress: 40,
    }),
  );
  await page.route('**/v1/setup/events', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: setup-status\ndata: {"state":"operational","tokenIssued":false,"tokenExpiresAt":null,"step":"storage","progress":40}\n\n',
    }),
  );
  await page.route('**/v1/auth/me', (route) =>
    json(route, { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false }),
  );
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/admin/storage/probe', (route) => {
    probedPath = (route.request().postDataJSON() as { managedPath: string }).managedPath;
    return json(route, {
      managedPath: '/volume1/Data/RAG/docs/.noderag-managed',
      managedSubdirectory: true,
      writable: true,
      fsyncVerified: true,
      availableBytes: String(50 * 1024 ** 3),
    });
  });
  await page.route('**/v1/admin/storage', (route) => {
    idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    savedStorage = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { id: 1, ...savedStorage }, 201);
  });
  await page.route('**/v1/admin/setup/progress', (route) =>
    json(route, { step: 'model', progress: 45 }),
  );

  await page.goto('/');
  const storagePath = page.getByLabel('Managed storage path');
  await expect(storagePath).toHaveValue('/var/packages/noderag/var/data/documents');
  await storagePath.fill('/volume1/Data/RAG/docs');
  await page.getByRole('button', { name: 'Test and save storage' }).click();
  await expect(page.getByRole('heading', { name: 'Embedding model' })).toBeVisible();
  expect(probedPath).toBe('/volume1/Data/RAG/docs');
  expect(idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await expect
    .poll(() => savedStorage)
    .toMatchObject({ managedPath: '/volume1/Data/RAG/docs/.noderag-managed' });
});

test('configures Ollama Cloud with a protected API key and full chat endpoint', async ({
  page,
}) => {
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/ready', (route) =>
    json(route, { service: 'noderag', status: 'ok', state: 'operational' }),
  );
  await page.route('**/v1/setup/status', (route) =>
    json(route, {
      state: 'operational',
      tokenIssued: false,
      tokenExpiresAt: null,
      step: 'vision',
      progress: 70,
    }),
  );
  await page.route('**/v1/setup/events', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: setup-status\ndata: {"state":"operational","tokenIssued":false,"tokenExpiresAt":null,"step":"vision","progress":70}\n\n',
    }),
  );
  await page.route('**/v1/auth/me', (route) =>
    json(route, { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false }),
  );
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/admin/vision/test', (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { elapsedMs: 42, bearerTokenPersisted: true });
  });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Connect optional image understanding' }),
  ).toBeVisible();
  await expect(page.getByLabel('Ollama address')).toHaveValue('https://ollama.com/api/chat');
  await expect(page.getByLabel('Ollama API key')).toHaveAttribute('type', 'password');
  await page.getByLabel('Ollama API key').fill('ollama-test-cloud-key');
  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByText('The API key was encrypted and saved.')).toBeVisible();
  await expect
    .poll(() => submitted)
    .toMatchObject({
      baseUrl: 'https://ollama.com/api/chat',
      model: 'minimax-m3:cloud',
      bearerToken: 'ollama-test-cloud-key',
      maximumParallel: 2,
      maximumImagesPerCall: 3,
      timeoutMs: 120000,
      maximumAttempts: 3,
      maximumImageDimension: 1650,
    });
});

test('signs in, searches all modes, and opens source context', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  await operational(page);
  let submittedSearch: Record<string, unknown> | null = null;
  let releaseSemanticHighlights = (): void => undefined;
  let semanticEvidenceRequested = false;
  const semanticEvidenceGate = new Promise<void>((resolve) => {
    releaseSemanticHighlights = resolve;
  });
  await page.route('**/v1/search', (route) => {
    submittedSearch = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, {
      mode: 'hybrid',
      elapsedMs: 18,
      nextCursor: null,
      items: [
        {
          chunkId: 41,
          documentId: 7,
          siloId: 1,
          score: 0.91,
          confidence: 0.94,
          text: 'Keep every recovery code in a protected password manager.',
          evidence: [
            {
              kind: 'semantic',
              text: 'Ranked evidence that cannot be aligned with the cited PDF page.',
              confidence: 0.9,
            },
          ],
          headingPath: ['Security', 'Recovery'],
          locator: { pageStart: 2, pageEnd: 2, pageLabel: 'p. 2', pageBasis: 'exact' },
          document: {
            name: 'handbook.pdf',
            title: 'Security handbook',
            format: 'pdf',
            path: 'policies/handbook.pdf',
            originalAvailable: true,
          },
        },
        {
          chunkId: 42,
          documentId: 7,
          siloId: 1,
          score: 0.82,
          confidence: 0.81,
          text: 'A second cited passage in the same PDF.',
          headingPath: ['Security', 'Storage'],
          locator: { pageStart: 3, pageEnd: 3, pageLabel: 'p. 3', pageBasis: 'exact' },
          document: {
            name: 'handbook.pdf',
            title: 'Security handbook',
            format: 'pdf',
            path: 'policies/handbook.pdf',
            originalAvailable: true,
          },
        },
      ],
    });
  });
  await page.route('**/v1/chunks/41/context**', (route) =>
    json(route, {
      target: {},
      items: [
        { chunkId: 40, ordinal: 4, text: 'Previous context.' },
        {
          chunkId: 41,
          ordinal: 5,
          text: 'Keep every recovery code in a protected password manager.',
        },
      ],
    }),
  );
  await page.route('**/v1/chunks/42/context**', (route) =>
    json(route, {
      target: {},
      items: [
        {
          chunkId: 42,
          ordinal: 6,
          text: 'A second cited passage in the same PDF.',
        },
      ],
    }),
  );
  await page.route('**/v1/search/evidence', async (route) => {
    semanticEvidenceRequested = true;
    await semanticEvidenceGate;
    return json(route, {
      semanticStatus: 'ready',
      semanticCache: 'miss',
      items: [
        { kind: 'exact', text: 'Documents', confidence: 1 },
        {
          kind: 'semantic',
          text: 'Documents are normalized to NFC before offsets and hashes are computed.',
          confidence: 0.88,
        },
      ],
    });
  });
  await page.route('**/v1/documents/7/original', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      path: resolve(
        import.meta.dirname,
        '../../../fixtures/evaluation/m12/corpus/architecture-evidence.pdf',
      ),
    }),
  );
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Both' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Semantic' })).toBeVisible();
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('slider', { name: 'Minimum confidence' }).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '0.55';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByText('55%', { exact: true })).toBeVisible();
  await page.getByLabel('Search your knowledge').fill('Documents recovery code');
  await page.locator('#main-content').getByRole('button', { name: 'Search', exact: true }).click();
  await expect
    .poll(() => submittedSearch)
    .toMatchObject({
      filters: { minimumConfidence: 0.55 },
    });
  await expect(page.getByRole('heading', { name: 'Security handbook' })).toBeVisible();
  await expect(page.getByText('Confidence 94%')).toBeVisible();
  await page.getByText('Keep every recovery code').click();
  const pdfDialog = page.getByRole('dialog', { name: 'Security handbook · PDF' });
  await expect(pdfDialog).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'PDF zoom' })).toHaveValue('fit');
  await expect(pdfDialog.getByRole('status')).toContainText(
    'Opened at cited page 2. Confidence 94%.',
  );
  await expect(pdfDialog.getByRole('button', { name: /Save page 2 to research/ })).toBeEnabled();
  await page.keyboard.press('0');
  await expect(pdfDialog.getByRole('alert')).toContainText('Select a research collection');
  await expect.poll(() => semanticEvidenceRequested).toBe(true);
  await expect(page.locator('.pdf-highlight.exact').first()).toBeVisible();
  await expect(page.getByText('Finding semantic highlights…')).toBeVisible();
  await expect(page.locator('.pdf-highlight.semantic')).toHaveCount(0);
  releaseSemanticHighlights();
  await expect(page.locator('.pdf-highlight.semantic').first()).toBeVisible();
  await page.getByRole('button', { name: 'Highlights on' }).click();
  await expect(page.getByRole('button', { name: 'Highlights off' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.locator('.pdf-highlight.exact').first()).not.toBeVisible();
  await page.getByRole('button', { name: 'Highlights off' }).click();
  await expect(page.locator('.pdf-highlight.exact').first()).toBeVisible();
  await expect.poll(async () => (await pdfDialog.boundingBox())?.width ?? 0).toBeGreaterThan(3_700);
  await expect
    .poll(async () =>
      page.getByLabel('PDF page 2').evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(1_400);
  await page.getByRole('button', { name: 'Source passage' }).click();
  await expect(page.getByRole('dialog', { name: 'Source passage' })).toContainText(
    'Previous context',
  );
  await expect(pdfDialog).not.toBeVisible();
  await page.getByRole('button', { name: 'View PDF at cited page' }).click();
  await expect(pdfDialog).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2');
  await expect(page.getByLabel('PDF page 2')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3');
  await expect(page.getByLabel('PDF page 3')).toBeVisible();
  await expect(pdfDialog.getByRole('status')).toContainText(
    'Viewing page 3. Opened from cited page 2. Confidence 94%.',
  );
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3');
  await expect(pdfDialog.getByRole('status')).toContainText(
    'Opened at cited page 3. Confidence 81%.',
  );
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2');
  await expect(pdfDialog.getByRole('status')).toContainText(
    'Opened at cited page 2. Confidence 94%.',
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(pdfDialog).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Source passage' })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Security handbook' })).toBeVisible();
});

test('saves separate PDF pages to research after moving away from the cited page', async ({
  page,
}) => {
  await operational(page);
  await page.unroute('**/v1/research');
  await page.unroute('**/v1/research/memberships?**');
  const savedPages: Array<{ researchItemId: number; pageOrdinal: number; pageNumber: number }> = [];
  await page.route('**/v1/research', (route) =>
    json(route, {
      items: [
        {
          id: 5,
          name: 'Legal Notes',
          itemCount: savedPages.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await page.route('**/v1/research/memberships?**', (route) => json(route, { items: [] }));
  await page.route('**/v1/research/5/page-memberships?**', (route) =>
    json(route, { items: savedPages }),
  );
  await page.route('**/v1/research/5/pages', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const pageOrdinal = Number(body['pageOrdinal']);
    const saved = {
      researchItemId: 700 + pageOrdinal,
      researchId: 5,
      referenceKind: 'page',
      pageOrdinal,
      chunkId: 41,
      chunkIds: [41],
      siloId: 1,
      documentId: 7,
      text: `Saved PDF page ${String(pageOrdinal + 1)}`,
      confidence: 0.94,
      evidence: [],
      query: 'recovery code',
      mode: 'hybrid',
      locator: {
        pageStart: pageOrdinal + 1,
        pageEnd: pageOrdinal + 1,
        pageLabel: `p. ${String(pageOrdinal + 1)}`,
      },
      document: { title: 'Security handbook', format: 'pdf' },
    };
    savedPages.push({
      researchItemId: saved.researchItemId,
      pageOrdinal,
      pageNumber: pageOrdinal + 1,
    });
    return json(route, saved, 201);
  });
  await page.route('**/v1/search', (route) =>
    json(route, {
      mode: 'hybrid',
      normalizedQuery: 'recovery code',
      elapsedMs: 9,
      nextCursor: null,
      items: [
        {
          chunkId: 41,
          chunkIds: [41],
          documentId: 7,
          siloId: 1,
          confidence: 0.94,
          text: 'Documents are normalized to NFC before offsets and hashes are computed.',
          headingPath: ['Architecture'],
          locator: { pageStart: 2, pageEnd: 2, pageLabel: 'p. 2', pageBasis: 'exact' },
          document: {
            name: 'handbook.pdf',
            title: 'Security handbook',
            format: 'pdf',
            path: 'policies/handbook.pdf',
            originalAvailable: true,
          },
        },
      ],
    }),
  );
  await page.route('**/v1/search/evidence', (route) =>
    json(route, {
      semanticStatus: 'ready',
      items: [
        { kind: 'exact', text: 'Documents', confidence: 1 },
        {
          kind: 'semantic',
          text: 'Documents are normalized to NFC before offsets and hashes are computed.',
          confidence: 0.88,
        },
      ],
    }),
  );
  await page.route('**/v1/chunks/41/context**', (route) =>
    json(route, { target: {}, items: [{ chunkId: 41, ordinal: 0, text: 'Context.' }] }),
  );
  await page.route('**/v1/documents/7/original', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      path: resolve(
        import.meta.dirname,
        '../../../fixtures/evaluation/m12/corpus/architecture-evidence.pdf',
      ),
    }),
  );

  await signIn(page);
  await page.getByLabel('Research collection').selectOption('5');
  await page.getByLabel('Search your knowledge').fill('recovery code');
  await page.locator('#main-content').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('Documents are normalized').click();
  const pdfDialog = page.getByRole('dialog', { name: 'Security handbook · PDF' });
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2');
  await expect(pdfDialog.getByRole('button', { name: /Save page 2 to Legal Notes/ })).toBeEnabled();
  await page.keyboard.press('0');
  await expect(pdfDialog.getByRole('status').filter({ hasText: 'Saved page 2' })).toContainText(
    'Legal Notes',
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3');
  await expect(pdfDialog.getByRole('button', { name: /Save page 3 to Legal Notes/ })).toBeVisible();
  await page.keyboard.press('0');
  await expect(pdfDialog.getByRole('status').filter({ hasText: 'Saved page 3' })).toContainText(
    'Legal Notes',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(
    pdfDialog.getByRole('button', { name: /Remove page 2 from Legal Notes/ }),
  ).toBeVisible();
  expect(savedPages.map(({ pageOrdinal }) => pageOrdinal)).toEqual([1, 2]);
});

test('opens search results in the Markdown reader and navigates with arrow keys', async ({
  page,
}) => {
  await operational(page);
  const firstPassage =
    'The recovery procedure begins by checking the verified backup and recording its checksum.';
  const secondPassage =
    'Rotate the emergency recovery tokens only after the restored service passes its health checks.';
  const filler = Array.from(
    { length: 28 },
    (_, index) =>
      `## Operational note ${String(index + 1)}\n\nConfirm service ownership, storage health, and audit continuity before continuing with operational note ${String(index + 1)}.`,
  ).join('\n\n');
  const markdown = `# Recovery runbook\n\n${firstPassage}\n\n${filler}\n\n## Token rotation\n\n${secondPassage}`;
  let markdownRequests = 0;
  await page.route('**/v1/search', (route) =>
    json(route, {
      mode: 'hybrid',
      normalizedQuery: 'recovery procedure',
      elapsedMs: 12,
      nextCursor: null,
      items: [
        {
          chunkId: 71,
          documentId: 21,
          siloId: 1,
          score: 0.93,
          confidence: 0.92,
          text: firstPassage,
          headingPath: ['Recovery runbook'],
          locator: {
            characterStart: markdown.indexOf(firstPassage),
            characterEnd: markdown.indexOf(firstPassage) + firstPassage.length,
            pageLabel: 'near 0%',
            pageBasis: 'none',
          },
          document: {
            name: 'recovery-runbook.md',
            title: 'Recovery runbook',
            format: 'md',
            path: 'operations/recovery-runbook.md',
            originalAvailable: true,
          },
        },
        {
          chunkId: 72,
          documentId: 21,
          siloId: 1,
          score: 0.84,
          confidence: 0.83,
          text: secondPassage,
          headingPath: ['Recovery runbook', 'Token rotation'],
          locator: {
            characterStart: markdown.indexOf(secondPassage),
            characterEnd: markdown.indexOf(secondPassage) + secondPassage.length,
            pageLabel: 'near 100%',
            pageBasis: 'none',
          },
          document: {
            name: 'recovery-runbook.md',
            title: 'Recovery runbook',
            format: 'md',
            path: 'operations/recovery-runbook.md',
            originalAvailable: true,
          },
        },
        {
          chunkId: 73,
          documentId: 22,
          siloId: 1,
          score: 0.79,
          confidence: 0.78,
          text: 'The architecture appendix describes recovery boundaries.',
          headingPath: ['Architecture appendix'],
          locator: { pageStart: 1, pageEnd: 1, pageLabel: 'p. 1', pageBasis: 'exact' },
          evidence: [{ kind: 'exact', text: 'Architecture', confidence: 1 }],
          document: {
            name: 'architecture-evidence.pdf',
            title: 'Architecture appendix',
            format: 'pdf',
            path: 'operations/architecture-evidence.pdf',
            originalAvailable: true,
          },
        },
      ],
    }),
  );
  await page.route('**/v1/documents/21/markdown', (route) => {
    markdownRequests += 1;
    return route.fulfill({ status: 200, contentType: 'text/markdown', body: markdown });
  });
  await page.route('**/v1/chunks/71/context**', (route) =>
    json(route, {
      target: {},
      items: [{ chunkId: 71, ordinal: 0, text: firstPassage }],
    }),
  );
  await page.route('**/v1/chunks/72/context**', (route) =>
    json(route, {
      target: {},
      items: [{ chunkId: 72, ordinal: 29, text: secondPassage }],
    }),
  );
  await page.route('**/v1/chunks/73/context**', (route) =>
    json(route, {
      target: {},
      items: [
        {
          chunkId: 73,
          ordinal: 0,
          text: 'The architecture appendix describes recovery boundaries.',
        },
      ],
    }),
  );
  await page.route('**/v1/documents/22/original', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      path: resolve(
        import.meta.dirname,
        '../../../fixtures/evaluation/m12/corpus/architecture-evidence.pdf',
      ),
    }),
  );

  await signIn(page);
  await page.getByLabel('Search your knowledge').fill('recovery procedure');
  await page.locator('#main-content').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(firstPassage).click();

  const markdownDialog = page.getByRole('dialog', { name: 'Recovery runbook · Markdown' });
  const reader = markdownDialog.locator('.markdown-document');
  await expect(markdownDialog).toBeVisible();
  await expect(markdownDialog.getByRole('status')).toContainText(
    'Opened at cited passage from Markdown. Confidence 92%.',
  );
  await expect(reader.locator('h1')).toHaveText('Recovery runbook');
  await expect(reader.locator('.markdown-citation-target')).toContainText(firstPassage);

  const startingScroll = await reader.evaluate((element) => element.scrollTop);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => reader.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(startingScroll);
  const advancedScroll = await reader.evaluate((element) => element.scrollTop);
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(() => reader.evaluate((element) => element.scrollTop))
    .toBeLessThan(advancedScroll);

  await page.keyboard.press('ArrowUp');
  await expect(markdownDialog.getByRole('status')).toContainText('Confidence 92%.');
  await page.keyboard.press('ArrowDown');
  await expect(markdownDialog.getByRole('status')).toContainText('Confidence 83%.');
  await expect(reader.locator('.markdown-citation-target')).toContainText(secondPassage);
  expect(markdownRequests).toBe(1);
  await page.keyboard.press('ArrowDown');
  const pdfDialog = page.getByRole('dialog', { name: 'Architecture appendix · PDF' });
  await expect(pdfDialog.getByRole('status')).toContainText('Confidence 78%.');
  await page.keyboard.press('ArrowUp');
  await expect(markdownDialog.getByRole('status')).toContainText('Confidence 83%.');
  await expect(reader.locator('.markdown-citation-target')).toContainText(secondPassage);
  await page.keyboard.press('ArrowUp');
  await expect(markdownDialog.getByRole('status')).toContainText('Confidence 92%.');
  await expect(reader.locator('.markdown-citation-target')).toContainText(firstPassage);

  await markdownDialog.getByRole('button', { name: 'Source passage' }).click();
  const sourceDialog = page.getByRole('dialog', { name: 'Source passage' });
  await expect(sourceDialog).toContainText(firstPassage);
  await sourceDialog.getByRole('button', { name: 'View Markdown at cited passage' }).click();
  await expect(markdownDialog).toBeVisible();
  await expect(reader.locator('.markdown-citation-target')).toContainText(firstPassage);
  await markdownDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(markdownDialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recovery runbook' })).toBeVisible();
});

test('creates cross-space research and toggles saved passages with the 0 key', async ({ page }) => {
  await operational(page);
  await page.unroute('**/v1/research');
  await page.unroute('**/v1/research/memberships?**');
  let created = false;
  let nextItemId = 801;
  const saved: Array<Record<string, unknown>> = [];
  const collections = () =>
    created
      ? [{ id: 5, name: 'Legal Notes', itemCount: saved.length, createdAt: '', updatedAt: '' }]
      : [];
  await page.route('**/v1/research', async (route) => {
    if (route.request().method() === 'POST') {
      created = true;
      return json(route, collections()[0], 201);
    }
    return json(route, { items: collections() });
  });
  await page.route('**/v1/research/memberships?**', (route) =>
    json(route, {
      items: saved.map((item) => ({
        chunkId: item['chunkId'],
        researchId: 5,
        researchName: 'Legal Notes',
        researchItemId: item['researchItemId'],
      })),
    }),
  );
  await page.route('**/v1/research/5/items', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const document =
        Number(body['documentId']) === 31
          ? {
              id: 31,
              title: 'Cross-space legal register',
              format: 'md',
              path: 'legal/register.md',
              originalAvailable: true,
            }
          : {
              id: 32,
              title: 'Tax authority handbook',
              format: 'md',
              path: 'tax/handbook.md',
              originalAvailable: true,
            };
      const item = {
        ...body,
        researchItemId: nextItemId,
        researchId: 5,
        selectedAt: new Date().toISOString(),
        silo: Number(body['siloId']) === 1 ? 'legal' : 'tax',
        document,
      };
      nextItemId += 1;
      saved.push(item);
      return json(route, item, 201);
    }
    return json(route, { items: saved, total: saved.length, hidden: 0 });
  });
  await page.route('**/v1/research/5/items/*', (route) => {
    const itemId = Number(route.request().url().split('/').at(-1));
    const index = saved.findIndex((item) => Number(item['researchItemId']) === itemId);
    if (index >= 0) saved.splice(index, 1);
    return json(route, { removed: true, researchItemId: itemId });
  });

  const firstPassage = 'The statutory notice period is thirty calendar days after service.';
  const secondPassage = 'Revenue assessments must identify each taxable source and filing period.';
  const markdownByDocument: Record<number, string> = {
    31: `# Cross-space legal register\n\n${firstPassage}`,
    32: `# Tax authority handbook\n\n${secondPassage}`,
  };
  const locator = (documentId: number, passage: string) => ({
    pageStart: null,
    pageEnd: null,
    pageLabel: 'near 50%',
    pageBasis: 'none',
    characterStart: markdownByDocument[documentId]?.indexOf(passage) ?? 0,
    characterEnd: (markdownByDocument[documentId]?.indexOf(passage) ?? 0) + passage.length,
    characterUnit: 'utf16',
    byteStart: 0,
    byteEnd: passage.length,
    byteUnit: 'utf8',
    offsetsMatchOriginal: false,
    pageLabels: [],
  });
  await page.route('**/v1/search', (route) =>
    json(route, {
      mode: 'hybrid',
      normalizedQuery: 'statutory revenue source',
      elapsedMs: 8,
      nextCursor: null,
      items: [
        {
          chunkId: 91,
          chunkIds: [91],
          siloId: 1,
          documentId: 31,
          confidence: 0.91,
          text: firstPassage,
          headingPath: ['Cross-space legal register'],
          locator: locator(31, firstPassage),
          evidence: [{ kind: 'exact', text: 'statutory', confidence: 1 }],
          document: {
            name: 'register.md',
            title: 'Cross-space legal register',
            format: 'md',
            path: 'legal/register.md',
            originalAvailable: true,
          },
        },
        {
          chunkId: 92,
          chunkIds: [92],
          siloId: 2,
          documentId: 32,
          confidence: 0.86,
          text: secondPassage,
          headingPath: ['Tax authority handbook'],
          locator: locator(32, secondPassage),
          evidence: [{ kind: 'semantic', text: secondPassage, confidence: 0.86 }],
          document: {
            name: 'handbook.md',
            title: 'Tax authority handbook',
            format: 'md',
            path: 'tax/handbook.md',
            originalAvailable: true,
          },
        },
      ],
    }),
  );
  for (const documentId of [31, 32]) {
    await page.route(`**/v1/documents/${String(documentId)}/markdown`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/markdown',
        body: markdownByDocument[documentId],
      }),
    );
  }
  await page.route('**/v1/chunks/91/context**', (route) =>
    json(route, { items: [{ chunkId: 91, ordinal: 0, text: firstPassage }] }),
  );
  await page.route('**/v1/chunks/92/context**', (route) =>
    json(route, { items: [{ chunkId: 92, ordinal: 0, text: secondPassage }] }),
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.getByLabel('Research name').fill('Legal Notes');
  await page.getByRole('button', { name: 'Create research' }).click();
  await expect(page.getByText('Created Legal Notes.')).toBeVisible();

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search your knowledge').fill('statutory revenue source');
  await page.locator('#main-content').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(firstPassage).click();
  const firstViewer = page.getByRole('dialog', { name: 'Cross-space legal register · Markdown' });
  await page.keyboard.press('0');
  await expect(firstViewer.getByRole('alert')).toContainText('Select a research collection');
  await firstViewer.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByLabel('Research collection').selectOption('5');
  await page.getByText(firstPassage).click();
  await expect(firstViewer.getByRole('button', { name: /Save to Legal Notes/ })).toBeVisible();
  await page.keyboard.press('0');
  await expect(
    firstViewer.getByRole('status').filter({ hasText: 'Saved this passage' }),
  ).toContainText('Legal Notes');
  await page.keyboard.press('ArrowDown');
  const secondViewer = page.getByRole('dialog', { name: 'Tax authority handbook · Markdown' });
  await expect(secondViewer.getByRole('status')).toContainText('Confidence 86%.');
  await page.keyboard.press('0');
  await expect(
    secondViewer.getByRole('status').filter({ hasText: 'Saved this passage' }),
  ).toContainText('Legal Notes');

  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('0');
  await expect(
    secondViewer.getByRole('status').filter({ hasText: 'Removed this passage' }),
  ).toContainText('Legal Notes');
  await page.keyboard.press('0');
  await expect(
    secondViewer.getByRole('status').filter({ hasText: 'Saved this passage' }),
  ).toContainText('Legal Notes');
  await secondViewer.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Saved in Legal Notes')).toHaveCount(2);

  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(page.getByLabel('Open research')).toContainText('Legal Notes (2)');
  const savedList = page.locator('section.research-reference-list');
  await expect(savedList.getByText(firstPassage)).toBeVisible();
  await expect(savedList.getByText(secondPassage)).toBeVisible();
  await savedList.getByText(firstPassage).click();
  await page.keyboard.press('ArrowDown');
  await expect(secondViewer).toBeVisible();
  await expect(secondViewer.getByText('↑/↓ research references')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('0');
  await expect(secondViewer).not.toBeVisible();
  await expect(savedList.getByText(secondPassage)).not.toBeVisible();
  await expect(savedList.getByText(firstPassage)).toBeVisible();
});

test('shows source-missing documents and submits typed purge through the API', async ({ page }) => {
  await operational(page);
  let purged = false;
  await page.route('**/v1/documents?**', (route) =>
    json(route, {
      items: purged
        ? []
        : [
            {
              id: 9,
              siloId: 1,
              name: 'departed.pdf',
              title: 'Departed source',
              path: 'old/departed.pdf',
              state: 'source_missing',
              sourceState: 'missing',
              sourceId: 4,
              format: 'pdf',
              bytes: 2048,
              pages: 2,
              imageCount: 0,
            },
          ],
      nextCursor: null,
    }),
  );
  await page.route('**/v1/documents/9/markdown', (route) =>
    route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Retained extraction' }),
  );
  await page.route('**/v1/documents/9', (route) => {
    purged = true;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/v1/sources/4/review-missing', (route) => json(route, { reviewed: true }));
  await signIn(page);
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await page.getByText('Departed source').click();
  await expect(page.getByText('The source file is missing')).toBeVisible();
  page.once('dialog', (dialog) =>
    dialog.accept('Confirmed that the source share was intentionally retired.'),
  );
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.getByText('Review recorded.')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('document 9'));
  await page.getByRole('button', { name: 'Purge document' }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('switches knowledge bases, scopes documents, and edits the selected library', async ({
  page,
}) => {
  await operational(page);
  const silos: Record<string, unknown>[] = [
    { id: 1, slug: 'policies', displayName: 'Policies', description: 'Company policies' },
    { id: 2, slug: 'engineering', displayName: 'Engineering', description: 'Technical notes' },
  ];
  const requestedSiloIds: string[] = [];
  let updateRequest: Record<string, unknown> | null = null;
  await page.route('**/v1/silos', (route) =>
    json(route, {
      items: silos.map(({ id, slug, displayName }) => ({ id, slug, displayName })),
    }),
  );
  await page.route('**/v1/documents?**', (route) => {
    const siloId = new URL(route.request().url()).searchParams.get('siloId') ?? '';
    requestedSiloIds.push(siloId);
    const id = siloId === '2' ? 22 : 11;
    const title = siloId === '2' ? 'Engineering handbook' : 'Employee policy';
    return json(route, {
      items: [
        {
          id,
          siloId: Number(siloId),
          name: `${title}.pdf`,
          title,
          path: `${siloId}/${title}.pdf`,
          state: 'ready',
          sourceState: 'present',
          format: 'pdf',
          bytes: 4096,
          pages: 5,
          imageCount: 0,
        },
      ],
      nextCursor: null,
    });
  });
  await page.route('**/v1/admin/silos**', (route) => {
    if (route.request().method() === 'PATCH') {
      updateRequest = route.request().postDataJSON() as Record<string, unknown>;
      Object.assign(silos[1] ?? {}, updateRequest);
      return json(route, { id: 2, slug: 'engineering', ...updateRequest });
    }
    return json(route, { items: silos });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await expect(page.getByText('Employee policy', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose knowledge base' }).click();
  await page.getByRole('menuitemradio', { name: /Engineering/ }).click();
  await expect(page.getByText('Engineering handbook', { exact: true })).toBeVisible();
  await expect(page.getByText('Employee policy', { exact: true })).not.toBeVisible();
  expect(requestedSiloIds).toContain('1');
  expect(requestedSiloIds).toContain('2');

  await page.getByRole('button', { name: 'Edit selected' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit knowledge base' });
  await expect(editor.getByLabel('Name')).toHaveValue('Engineering');
  await expect(editor.getByLabel('Slug')).toHaveValue('engineering');
  await expect(editor.getByLabel('Slug')).toHaveAttribute('readonly', '');
  await expect(editor.getByLabel('Description')).toHaveValue('Technical notes');
  await editor.getByLabel('Name').fill('Engineering Library');
  await editor.getByLabel('Description').fill('Approved technical reference material');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Knowledge base details saved.')).toBeVisible();
  await expect(
    page.locator('.selected-knowledge-base-summary').getByText('Engineering Library', {
      exact: true,
    }),
  ).toBeVisible();
  expect(updateRequest).toEqual({
    displayName: 'Engineering Library',
    description: 'Approved technical reference material',
  });
});

test('uploads, exposes durable job controls, and lists capability grants', async ({ page }) => {
  await operational(page);
  await page.route('**/v1/sources', (route) => json(route, { items: [] }));
  await page.route('**/v1/jobs', (route) =>
    json(route, {
      items: [
        {
          id: 22,
          documentId: 12,
          siloId: 1,
          kind: 'extract',
          documentName: 'Annual report.pdf',
          documentPath: 'finance/Annual report.pdf',
          state: 'pending',
          logicalAttempt: 1,
          maximumAttempts: 3,
          progress: { percent: 35 },
        },
      ],
    }),
  );
  await page.route('**/v1/documents?siloId=1', (route) =>
    json(route, { documentId: 12, jobId: 22 }, 202),
  );
  await page.route('**/v1/jobs/22/pause', (route) => json(route, { outcome: 'paused' }, 202));
  await page.route('**/v1/source-folders?**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === null) {
      return json(route, {
        currentPath: '/',
        parentPath: null,
        selectable: false,
        items: [{ name: 'volume1', path: '/volume1' }],
      });
    }
    if (path === '/volume1') {
      return json(route, {
        currentPath: path,
        parentPath: '/',
        selectable: false,
        items: [{ name: 'shared', path: '/volume1/shared' }],
      });
    }
    if (path === '/volume1/shared') {
      return json(route, {
        currentPath: path,
        parentPath: '/volume1',
        selectable: true,
        items: [{ name: 'policies', path: '/volume1/shared/policies' }],
      });
    }
    return json(route, {
      currentPath: path,
      parentPath: '/volume1/shared',
      selectable: true,
      items: [],
    });
  });
  await page.route('**/v1/admin/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/admin/grants', (route) =>
    json(route, { items: [{ principalId: 2, siloId: 1, capability: 'read' }] }),
  );
  await page.route('**/v1/admin/grants/2/1/upload', (route) => json(route, { enabled: true }));
  await signIn(page);
  await page.getByRole('button', { name: 'Ingest' }).click();
  const queuedDocument = page
    .locator('.document-workflow')
    .filter({ hasText: 'Annual report.pdf' });
  await expect(queuedDocument.getByText('Annual report.pdf', { exact: true })).toBeVisible();
  await expect(
    queuedDocument.getByText('finance/Annual report.pdf', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect an input folder' })).toBeVisible();
  await expect(
    page.getByText(
      "It is not NodeRag's managed storage, and NodeRag does not modify the source files.",
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Browse' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an input folder' })).toBeVisible();
  await expect(page.getByText('Browse toward an allowed input folder')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open folder volume1' }).click();
  await page.getByRole('button', { name: 'Open folder shared' }).click();
  await expect(page.getByText('Selectable input folder')).toBeVisible();
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await expect(page.getByText('/volume1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder shared' }).click();
  await page.getByRole('button', { name: 'Open folder policies' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByLabel('Source folder path')).toHaveValue('/volume1/shared/policies');
  await page
    .getByLabel('Choose file')
    .setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') });
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await expect(page.getByText('notes.md was added')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /Capabilities/ }).click();
  await expect(page.getByText(/capability: read/)).toBeVisible();
  await page.getByLabel('User or key ID').fill('2');
  await page.getByLabel('Knowledge space ID').fill('1');
  await page.getByLabel('Capability').selectOption('upload');
  await page.getByRole('button', { name: 'Grant capability' }).click();
  await expect(page.getByText('Capability granted.')).toBeVisible();
});

test('shows one three-stage workflow per document instead of duplicate internal jobs', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await operational(page);
  const baseJob = {
    siloId: 1,
    maximumAttempts: 5,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route('**/v1/sources', (route) => json(route, { items: [] }));
  await page.route('**/v1/jobs', (route) =>
    json(route, {
      items: [
        {
          ...baseJob,
          id: 31,
          documentId: 101,
          documentName: 'Budget.pdf',
          documentPath: 'finance/Budget.pdf',
          kind: 'extract',
          state: 'succeeded',
          logicalAttempt: 1,
          progress: { stage: 'complete', percent: 100 },
        },
        {
          ...baseJob,
          id: 32,
          documentId: 101,
          documentName: 'Budget.pdf',
          documentPath: 'finance/Budget.pdf',
          kind: 'vision',
          state: 'succeeded',
          logicalAttempt: 1,
          progress: { stage: 'complete', percent: 100 },
        },
        {
          ...baseJob,
          id: 33,
          documentId: 101,
          documentName: 'Budget.pdf',
          documentPath: 'finance/Budget.pdf',
          kind: 'embed',
          state: 'leased',
          logicalAttempt: 1,
          heartbeatAt: new Date().toISOString(),
          progress: { stage: 'chunking', operation: 'forming-passages', percent: 55 },
        },
        {
          ...baseJob,
          id: 41,
          documentId: 102,
          documentName: 'Revenue.pdf',
          documentPath: 'finance/Revenue.pdf',
          kind: 'extract',
          state: 'succeeded',
          logicalAttempt: 1,
          progress: { stage: 'complete', percent: 100 },
        },
        {
          ...baseJob,
          id: 42,
          documentId: 102,
          documentName: 'Revenue.pdf',
          documentPath: 'finance/Revenue.pdf',
          kind: 'vision',
          state: 'retry_wait',
          logicalAttempt: 1,
          retryAt: new Date(Date.now() + 10_000).toISOString(),
          error: { code: 'vision-provider-timeout' },
          progress: { stage: 'extracting-pages', percent: 30 },
        },
        {
          ...baseJob,
          id: 43,
          documentId: 102,
          documentName: 'Revenue.pdf',
          documentPath: 'finance/Revenue.pdf',
          kind: 'embed',
          state: 'pending',
          logicalAttempt: 0,
          progress: {},
        },
      ],
    }),
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Ingest' }).click();

  await expect(page.locator('.document-workflow')).toHaveCount(2);
  const budget = page.locator('.document-workflow').filter({ hasText: 'Budget.pdf' });
  await expect(budget.locator('.job-progress b')).toHaveText('2/3 Chunking');
  await expect(budget.getByText('Current task: Forming searchable passages.')).toBeVisible();
  const revenue = page.locator('.document-workflow').filter({ hasText: 'Revenue.pdf' });
  await expect(revenue.locator('.job-progress b')).toContainText('1/3 Ingesting to Markdown');
  await expect(revenue.getByText(/Try 2 of 5 will start automatically/)).toBeVisible();
  await expect(page.getByText(/Attempt 1 of 5/)).toHaveCount(0);
  const pause = revenue.getByRole('button', { name: 'Pause' });
  const cancel = revenue.getByRole('button', { name: 'Cancel' });
  await expect(pause).toBeVisible();
  await expect(cancel).toBeVisible();
  expect(
    await pause.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      foreground: getComputedStyle(element).color,
      border: getComputedStyle(element).borderColor,
    })),
  ).toEqual({
    background: 'rgb(25, 45, 37)',
    foreground: 'rgb(229, 239, 235)',
    border: 'rgb(61, 104, 89)',
  });
  expect(
    await cancel.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      foreground: getComputedStyle(element).color,
      border: getComputedStyle(element).borderColor,
    })),
  ).toEqual({
    background: 'rgb(58, 35, 35)',
    foreground: 'rgb(242, 177, 177)',
    border: 'rgb(128, 80, 80)',
  });
  for (const scheme of ['light', 'dark', 'green', 'blue', 'red']) {
    await page
      .locator('.app-shell')
      .evaluate((element, selected) => element.setAttribute('data-theme', selected), scheme);
    const actionScan = await new AxeBuilder({ page })
      .include('.job-actions')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(actionScan.violations, `${scheme} queue controls`).toEqual([]);
  }
});

test('shows real embedding throughput and allows slow adaptive groups time to finish', async ({
  page,
}) => {
  await operational(page);
  const stageStartedAt = new Date(Date.now() - 60_000).toISOString();
  await page.route('**/v1/sources', (route) => json(route, { items: [] }));
  await page.route('**/v1/jobs', (route) =>
    json(route, {
      items: [
        {
          id: 51,
          documentId: 336,
          siloId: 1,
          documentName: 'Government report.pdf',
          documentPath: 'reports/Government report.pdf',
          kind: 'embed',
          state: 'leased',
          logicalAttempt: 1,
          maximumAttempts: 5,
          createdAt: stageStartedAt,
          updatedAt: stageStartedAt,
          heartbeatAt: new Date(Date.now() - 100_000).toISOString(),
          progress: {
            stage: 'embedding',
            operation: 'generating-embeddings',
            percent: 25,
            stageStartedAt,
            chunksCompleted: 491,
            chunksTotal: 491,
            embedded: 64,
            cached: 7,
            completed: 71,
            remaining: 420,
            total: 491,
            currentBatchStart: 65,
            currentBatchEnd: 66,
            currentBatchTotal: 484,
            batchSize: 2,
            passagesPerMinute: 5.3,
            estimatedRemainingMs: 720_000,
            expectedHeartbeatMs: 180_000,
            suspectedNoisyPassages: 12,
            qualityWarningCodes: ['token-dense-passages'],
          },
        },
      ],
    }),
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Ingest' }).click();

  const workflow = page.locator('.document-workflow').filter({ hasText: 'Government report.pdf' });
  await expect(workflow.getByText(/71 of 491 passages complete/)).toBeVisible();
  await expect(workflow.getByText(/64 newly embedded · 7 reused · 420 remaining/)).toBeVisible();
  await expect(workflow.getByText(/about 12m 0s remaining/)).toBeVisible();
  await expect(
    workflow.getByText(/Processing new passages 65–66 of 484 · adaptive group size 2/),
  ).toBeVisible();
  await expect(
    workflow.getByText(/Possible extraction noise detected in 12 passages/),
  ).toBeVisible();
  await expect(workflow.getByText(/491 of 491 passages/)).toHaveCount(0);
  await expect(workflow.getByText(/No progress update/)).toHaveCount(0);
});

test('shows live large-PDF ingestion progress from the selected knowledge base', async ({
  page,
}) => {
  await operational(page);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await page.route('**/v1/documents?**', (route) =>
    json(route, {
      items: [
        {
          id: 19,
          siloId: 1,
          name: 'large-plan.pdf',
          title: 'Large plan',
          path: 'plans/large-plan.pdf',
          state: 'extracting',
          sourceState: 'present',
          format: 'pdf',
          bytes: 50_000_000,
          pages: 50,
          imageCount: 0,
          ingestionJobs: [
            {
              id: 31,
              documentId: 19,
              siloId: 1,
              kind: 'extract',
              state: 'leased',
              logicalAttempt: 1,
              maximumAttempts: 3,
              createdAt: startedAt,
              progress: {
                stage: 'extracting-pages',
                percent: 50,
                pagesCompleted: 25,
                pagesTotal: 50,
              },
            },
          ],
        },
      ],
      nextCursor: null,
    }),
  );
  await page.route('**/v1/documents/19/markdown', (route) =>
    json(route, { code: 'document_not_ready' }, 409),
  );
  await signIn(page);
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await page.getByText('Large plan').click();
  await expect(page.getByRole('heading', { name: 'Ingestion progress' })).toBeVisible();
  await expect(page.getByText('extracting pages', { exact: true })).toBeVisible();
  await expect(page.getByText('30%', { exact: true })).toBeVisible();
  await expect(page.getByText(/25 of 50 pages/)).toBeVisible();
  await expect(page.getByText(/elapsed.*about 1m \d+s remaining/)).toBeVisible();
});

test('renders a safe GitHub-style Markdown preview with Mermaid diagrams', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { markdownXss?: boolean }).markdownXss = false;
  });
  await operational(page);
  const markdown = `# Architecture notes

This document has **formatted text**, \`inline code\`, and a task list.

- [x] Extract the document
- [ ] Review the result

| Stage | Status |
| --- | --- |
| Markdown | Ready |
| Search | Indexed |

> Important passages remain easy to scan.

The score is $confidence = \\frac{matched}{total}$.

\`\`\`mermaid
flowchart LR
  Input[Input folder] --> Extract[Markdown]
  Extract --> Search[Search index]
\`\`\`

![Remote architecture](https://example.com/architecture.png)

<script>window.markdownXss = true</script>`;
  await page.route('**/v1/documents?**', (route) =>
    json(route, {
      items: [
        {
          id: 27,
          siloId: 1,
          name: 'architecture.md',
          title: 'Architecture notes',
          path: 'planning/architecture.md',
          state: 'ready',
          sourceState: 'present',
          format: 'md',
          bytes: markdown.length,
          pages: 1,
          pageBasis: 'none',
          imageCount: 0,
          offsetsMatchOriginal: true,
          ingestionJobs: [],
        },
      ],
      nextCursor: null,
    }),
  );
  await page.route('**/v1/documents/27/markdown', (route) =>
    route.fulfill({ status: 200, contentType: 'text/markdown', body: markdown }),
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await page.getByText('Architecture notes').click();

  const dialog = page.getByRole('dialog', { name: 'Architecture notes' });
  const preview = dialog.locator('.markdown-document');
  await expect(dialog.getByRole('button', { name: 'Preview' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(preview.getByRole('heading', { name: 'Architecture notes' })).toBeVisible();
  await expect(preview.getByRole('table')).toContainText('Indexed');
  await expect(preview.locator('input[type="checkbox"]:checked')).toHaveCount(1);
  await expect(preview.locator('.markdown-external-image')).toContainText(
    'External image not loaded automatically',
  );
  await expect(preview.locator('.markdown-diagram-image')).toBeVisible();
  await expect(preview.locator('.markdown-math .katex')).toBeVisible();
  await expect(preview.locator('script')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { markdownXss: boolean }).markdownXss),
  ).toBe(false);

  await dialog.getByRole('button', { name: 'Markdown source' }).click();
  await expect(dialog.locator('.markdown-source')).toContainText('flowchart LR');
  await expect(dialog.locator('.markdown-source')).toContainText('<script>window.markdownXss');
  await expect(preview).not.toBeVisible();
});

test('connects a readable input folder with all default formats and a one-minute schedule', async ({
  page,
}) => {
  await operational(page);
  let sourceRequest: Record<string, unknown> | null = null;
  let crawlRequest: Record<string, unknown> | null = null;
  let updateRequest: Record<string, unknown> | null = null;
  let disconnected = false;
  const connectedSources: Record<string, unknown>[] = [];
  await page.route('**/v1/sources', (route) => {
    if (route.request().method() === 'POST') {
      sourceRequest = route.request().postDataJSON() as Record<string, unknown>;
      connectedSources.push({
        id: 41,
        siloId: 1,
        uri: '/volume1/Data/RAG/input',
        includeGlobs: sourceRequest['includeGlobs'],
        excludeGlobs: sourceRequest['excludeGlobs'],
        scheduleEnabled: true,
        scheduleIntervalMinutes: 1,
        healthState: 'unknown',
        lastCrawlAt: null,
      });
      return json(route, { id: 41, siloId: 1, uri: '/volume1/Data/RAG/input' }, 201);
    }
    return json(route, { items: connectedSources });
  });
  await page.route('**/v1/sources/41/crawl', (route) => {
    crawlRequest = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { jobId: 73 }, 202);
  });
  await page.route('**/v1/sources/41', (route) => {
    if (route.request().method() === 'PATCH') {
      updateRequest = route.request().postDataJSON() as Record<string, unknown>;
      const source = connectedSources[0];
      if (source !== undefined) {
        source['includeGlobs'] = updateRequest['includeGlobs'];
        source['excludeGlobs'] = updateRequest['excludeGlobs'];
        source['scheduleEnabled'] = updateRequest['scheduleEnabled'];
        source['scheduleIntervalMinutes'] = updateRequest['scheduleIntervalMinutes'];
      }
      return json(route, { id: 41, ...updateRequest });
    }
    disconnected = true;
    connectedSources.splice(0);
    return json(route, { detached: true });
  });
  await page.route('**/v1/jobs', (route) => json(route, { items: [] }));

  await signIn(page);
  await page.getByRole('button', { name: 'Ingest' }).click();
  await page.getByLabel('Source folder path').fill('/volume1/Data/RAG/input');
  await page.getByLabel('Repeat every (minutes)').fill('1');
  await page.getByRole('button', { name: 'Verify and connect' }).click();

  await expect(page.getByText('Source mapping saved.')).toBeVisible();
  await expect
    .poll(() => sourceRequest)
    .toMatchObject({
      siloId: 1,
      uri: '/volume1/Data/RAG/input',
      includeGlobs: ['**/*.pdf', '**/*.docx', '**/*.xlsx', '**/*.md', '**/*.txt'],
      scheduleIntervalMinutes: 1,
    });

  const connected = page.locator('.editable-record').filter({
    hasText: '/volume1/Data/RAG/input',
  });
  await expect(connected.getByText('Automatic crawl every 1 minute')).toBeVisible();
  await connected.getByRole('button', { name: 'Crawl now' }).click();
  await expect(page.getByText('Crawl queued as job #73.')).toBeVisible();
  expect(crawlRequest).toEqual({ siloId: 1 });

  await connected.getByText('Edit schedule and patterns').click();
  await connected.getByLabel('Repeat every (minutes; blank for manual)').fill('5');
  await connected.getByRole('button', { name: 'Save folder settings' }).click();
  await expect(page.getByText('Input-folder settings saved.')).toBeVisible();
  await expect
    .poll(() => updateRequest)
    .toMatchObject({
      siloId: 1,
      scheduleEnabled: true,
      scheduleIntervalMinutes: 5,
    });

  await connected.getByRole('button', { name: 'Disconnect folder' }).click();
  const confirmation = page.locator('.modal').filter({ hasText: 'Disconnect input folder?' });
  await expect(confirmation.getByText(/Previously ingested managed copies/)).toBeVisible();
  await confirmation.getByRole('button', { name: 'Disconnect folder' }).click();
  await expect(page.getByText('No folders connected.')).toBeVisible();
  expect(disconnected).toBe(true);
});

test('an administrator configures Ollama Cloud and its internet-search capabilities', async ({
  page,
}) => {
  await operational(page);
  let configured = false;
  let enabled = false;
  let generationModel: string | null = null;
  let maximumParallel = 2;
  let savedApiKey = '';
  let updatedAt = '2030-01-01T00:00:00Z';
  let models: Record<string, unknown>[] = [];
  const health: Record<string, string> = {
    model_catalog: 'untested',
    generation: 'untested',
    web_search: 'untested',
    web_fetch: 'untested',
  };
  const response = () => ({
    providers: [
      {
        provider: 'ollama_cloud',
        label: 'Ollama Cloud',
        serviceRoot: 'https://ollama.com',
        serviceRootEditable: false,
        enabled,
        credential: {
          configured,
          fingerprint: configured ? '0123456789abcdef' : null,
        },
        generationModel,
        limits: {
          maxParallelCalls: maximumParallel,
          requestsPerMinute: null,
          tokensPerMinute: null,
        },
        webToolUsage: {
          requestsThisMinute: 2,
          requestsLast24Hours: 17,
          activeMinutesLast24Hours: 6,
          lastRequestAt: '2030-01-01T00:02:00Z',
        },
        capabilities: Object.entries(health).map(([capability, status]) => ({
          capability,
          status,
          latencyMs: status === 'healthy' ? 42 : null,
          errorCode: null,
          metadata: {},
          testedAt: status === 'healthy' ? '2030-01-01T00:02:00Z' : null,
        })),
        models,
        updatedAt,
      },
    ],
  });
  await page.route('**/v1/admin/principals', (route) => json(route, { items: [] }));
  await page.route('**/v1/admin/chat/providers', (route) => json(route, response()));
  await page.route('**/v1/admin/chat/providers/ollama-cloud', (route) => {
    expect(route.request().method()).toBe('PUT');
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body['clearApiKey'] === true) {
      configured = false;
      enabled = false;
      Object.keys(health).forEach((capability) => {
        health[capability] = 'disabled';
      });
    } else {
      expect(body).not.toHaveProperty('serviceRoot');
      if (typeof body['apiKey'] === 'string' && body['apiKey'] !== '') {
        configured = true;
        savedApiKey = body['apiKey'];
      }
      enabled = body['enabled'] === true;
      generationModel =
        typeof body['generationModel'] === 'string' ? body['generationModel'] : null;
      maximumParallel = Number(body['maxParallelCalls']);
      Object.keys(health).forEach((capability) => {
        health[capability] = enabled ? 'untested' : 'disabled';
      });
    }
    updatedAt = '2030-01-01T00:01:00Z';
    return json(route, response());
  });
  await page.route('**/v1/admin/chat/providers/ollama-cloud/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body['apiKey']).toBeUndefined();
    if (path.endsWith('/refresh-models')) {
      models = [
        {
          model: 'minimax-m3:cloud',
          displayName: 'minimax-m3:cloud',
          contextProvenance: 'unknown',
        },
      ];
      health['model_catalog'] = 'healthy';
      return json(route, { ok: true, modelCount: 1, ...response() });
    }
    const capability = path.endsWith('/test-generation')
      ? 'generation'
      : path.endsWith('/test-web-search')
        ? 'web_search'
        : 'web_fetch';
    if (capability === 'generation') expect(body['model']).toBe('minimax-m3:cloud');
    health[capability] = 'healthy';
    return json(route, { ok: true, capability, latencyMs: 42 });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Chat providers/ }).click();
  await expect(page.getByRole('heading', { name: 'Ollama Cloud' })).toBeVisible();
  await expect(page.getByLabel('Ollama Cloud service address')).toHaveValue('https://ollama.com');
  await expect(page.getByLabel('Ollama Cloud service address')).toHaveAttribute('readonly', '');
  await expect(
    page.getByText('This is Ollama Cloud, not a local Ollama installation.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hosted web-tool usage' })).toBeVisible();
  await expect(page.getByText('17', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Private search text and fetched page content are never included/),
  ).toBeVisible();
  await page.getByLabel('Ollama Cloud API key').fill('synthetic-cloud-key');
  await page.getByLabel('Chat model').fill('minimax-m3:cloud');
  await page.getByLabel('Parallel Cloud calls').fill('4');
  await page.getByLabel(/Enable Ollama Cloud for Chat/).check();
  await page.getByRole('button', { name: 'Save connection and replace key' }).click();
  await expect(
    page.getByText('Ollama Cloud settings and replacement API key saved.'),
  ).toBeVisible();
  await expect(page.getByLabel('Ollama Cloud API key')).toHaveValue('');
  await expect(page.getByLabel('Ollama Cloud API key')).toHaveAttribute(
    'placeholder',
    'Protected key saved',
  );
  expect(savedApiKey).toBe('synthetic-cloud-key');
  await page.getByLabel('Ollama Cloud API key').fill('replacement-cloud-key');
  await page.getByRole('button', { name: 'Save connection and replace key' }).click();
  await expect(
    page.getByText('Ollama Cloud settings and replacement API key saved.'),
  ).toBeVisible();
  expect(savedApiKey).toBe('replacement-cloud-key');

  await page.getByRole('button', { name: 'Refresh Cloud models' }).click();
  await expect(page.getByText('Ollama Cloud model list refreshed (1 models).')).toBeVisible();
  await page.getByRole('button', { name: 'Test Chat generation' }).click();
  await page.getByRole('button', { name: 'Test Internet search' }).click();
  await page.getByRole('button', { name: 'Test Web-page fetch' }).click();
  await expect(page.getByText('Web-page fetch test passed in 42 ms.')).toBeVisible();

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Chat providers/ }).click();
  await expect(page.getByLabel('Chat model')).toHaveValue('minimax-m3:cloud');
  await expect(page.getByLabel('Parallel Cloud calls')).toHaveValue('4');
  await expect(page.getByLabel(/Enable Ollama Cloud for Chat/)).toBeChecked();
  const providerAccessibility = await new AxeBuilder({ page }).include('.admin-content').analyze();
  expect(providerAccessibility.violations).toEqual([]);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Clear saved key' }).click();
  await expect(
    page.getByText('Ollama Cloud was disabled and its saved API key was cleared.'),
  ).toBeVisible();
  await expect(page.getByLabel(/Enable Ollama Cloud for Chat/)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Clear saved key' })).toBeDisabled();
});

test('an administrator completes durable OpenAI device-code sign-in and manages live models', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await operational(page);
  let connected = false;
  let pending = false;
  let disconnected = false;
  let selectedModel = 'gpt-test';
  const openAiProvider = () => ({
    provider: 'openai_oauth',
    label: 'OpenAI OAuth',
    serviceRoot: null,
    serviceRootEditable: false,
    enabled: connected,
    credential: { configured: connected, fingerprint: connected ? 'fedcba9876543210' : null },
    generationModel: selectedModel,
    limits: { maxParallelCalls: 2, requestsPerMinute: null, tokensPerMinute: null },
    metadata: connected
      ? { accountEmail: 'shared@example.test', planType: 'team', sharedAccount: true }
      : {},
    capabilities: [
      {
        capability: 'model_catalog',
        status: connected ? 'healthy' : 'untested',
        metadata: connected ? { modelCount: 1 } : {},
        testedAt: connected ? '2030-01-01T00:00:00Z' : null,
      },
      { capability: 'generation', status: 'untested', metadata: {}, testedAt: null },
    ],
    models: [
      {
        model: 'gpt-test',
        displayName: 'GPT Test',
        reasoningEfforts: ['low', 'high', 'ultra'],
        contextProvenance: 'unknown',
        providerMetadata: {
          inputModalities: ['text', 'image'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      },
    ],
    updatedAt: connected ? '2030-01-01T00:02:00Z' : '2030-01-01T00:00:00Z',
  });
  await page.route('**/v1/admin/principals', (route) => json(route, { items: [] }));
  await page.route('**/v1/admin/chat/providers/openai-oauth/status', (route) =>
    json(route, {
      account: connected
        ? {
            connected: true,
            requiresOpenaiAuth: false,
            email: 'shared@example.test',
            planType: 'team',
          }
        : { connected: false, requiresOpenaiAuth: true, email: null, planType: null },
      login: pending
        ? {
            loginId: 'login-browser-test',
            userCode: 'ABCD-EFGH',
            verificationUrl: 'https://auth.openai.com/device',
            expiresAt: '2030-01-01T00:15:00Z',
            state: 'pending',
            safeErrorCode: null,
          }
        : null,
      rateLimits: connected
        ? {
            buckets: [
              {
                id: 'codex',
                name: 'Codex',
                planType: 'team',
                primary: {
                  usedPercent: 25,
                  resetsAt: 1_893_456_000,
                  windowDurationMins: 300,
                },
                secondary: null,
                spendControlReached: false,
                reachedType: null,
              },
            ],
          }
        : null,
      runtimeState: 'ready',
    }),
  );
  await page.route('**/v1/admin/chat/providers/openai-oauth/login', (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    pending = true;
    return json(route, {
      loginId: 'login-browser-test',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/device',
      expiresAt: '2030-01-01T00:15:00Z',
      state: 'pending',
      safeErrorCode: null,
    });
  });
  await page.route('**/v1/admin/chat/providers/openai-oauth/refresh-models', (route) =>
    json(route, { ok: true, modelCount: 1, models: openAiProvider().models }),
  );
  await page.route('**/v1/admin/chat/providers/openai-oauth/test', (route) =>
    json(route, {
      ok: true,
      modelCount: 1,
      account: {
        connected: true,
        requiresOpenaiAuth: false,
        email: 'shared@example.test',
        planType: 'team',
      },
      rateLimits: null,
    }),
  );
  await page.route('**/v1/admin/chat/providers/openai-oauth/disconnect', (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'DISCONNECT' });
    connected = false;
    pending = false;
    disconnected = true;
    return json(route, { ok: true, disconnected: true });
  });
  await page.route('**/v1/admin/chat/providers/openai-oauth', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    selectedModel = String(body['generationModel']);
    return json(route, { ok: true, enabled: true, generationModel: selectedModel });
  });
  await page.route('**/v1/admin/chat/providers', (route) =>
    json(route, { providers: [openAiProvider()] }),
  );

  await signIn(page);
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Chat providers/ }).click();
  await expect(page.getByRole('heading', { name: 'OpenAI OAuth' })).toBeVisible();
  await expect(page.getByText(/one server-wide ChatGPT\/OpenAI OAuth connection/)).toBeVisible();
  await expect(page.getByText(/All Chat internet searches.*Ollama Cloud/)).toBeVisible();
  await page.getByRole('button', { name: 'Connect OpenAI account' }).click();
  await expect(page.getByText('ABCD-EFGH')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open OpenAI sign-in' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/device',
  );
  await page.getByRole('button', { name: 'Copy code' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-EFGH');

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Chat providers/ }).click();
  await expect(page.getByText('ABCD-EFGH')).toBeVisible();

  connected = true;
  pending = false;
  await expect(page.getByText('shared@example.test')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('25% used')).toBeVisible();
  await expect(page.getByLabel('Generation model')).toHaveValue('gpt-test');
  await expect(page.getByText(/low, high, ultra/)).toBeVisible();
  await expect(page.locator('.provider-model-detail')).toContainText('Context limit: Unknown');
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect(page.getByText('OpenAI model list refreshed (1 models).')).toBeVisible();
  await page.getByRole('button', { name: 'Test account and catalog' }).click();
  await expect(page.getByText('OpenAI account and model catalog passed (1 models).')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.admin-content').analyze();
  expect(accessibility.violations).toEqual([]);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Disconnect account' }).click();
  await expect(
    page.getByText('The OpenAI account was disconnected and its saved credential was removed.'),
  ).toBeVisible();
  expect(disconnected).toBe(true);
});

test('an administrator configures context, Cloud-only internet defaults, and Chat storage', async ({
  page,
}) => {
  await operational(page);
  let contextRevision = '00000000-0000-4000-8000-000000000003';
  let settingsRevision = '00000000-0000-4000-8000-000000000004';
  let managed: Record<string, unknown> = {
    enabled: false,
    triggerPercent: 75,
    keepRecentTurns: 8,
    l1PinLimitTokens: 4096,
    l2: null,
    l3: null,
    tests: [],
  };
  let savedSettings: Record<string, unknown> | null = null;
  let reconcilePreviewCalls = 0;
  let reconciledOwnerMap: Record<string, unknown> | null = null;
  const models = [
    {
      id: 41,
      provider: 'openai_oauth',
      model: 'gpt-test',
      displayName: 'GPT Test',
      reasoningEfforts: ['low', 'high'],
      enabled: true,
      generationStatus: 'healthy',
      catalogStale: false,
      administratorContextTokens: null,
      administratorOutputTokens: null,
      note: null,
      capacity: {
        contextTokens: null,
        contextSource: 'unknown',
        maximumOutputTokens: null,
        outputSource: 'unknown',
      },
    },
    {
      id: 42,
      provider: 'ollama_cloud',
      model: 'minimax-m3:cloud',
      displayName: 'MiniMax M3 Cloud',
      reasoningEfforts: ['default'],
      enabled: true,
      generationStatus: 'healthy',
      catalogStale: false,
      administratorContextTokens: 200000,
      administratorOutputTokens: 32000,
      note: 'Verified Cloud capacity.',
      capacity: {
        contextTokens: 200000,
        contextSource: 'administrator_override',
        maximumOutputTokens: 32000,
        outputSource: 'administrator_override',
      },
    },
  ];
  const configuration = () => ({
    contract: 'chat-settings.v1',
    executionEnabled: savedSettings?.['defaultProvider'] != null,
    internetProvider: 'ollama_cloud',
    internet: {
      provider: 'ollama_cloud',
      ready: true,
      capabilities: [
        { capability: 'web_fetch', status: 'healthy' },
        { capability: 'web_search', status: 'healthy' },
      ],
    },
    context: {
      revisionId: contextRevision,
      rollingTurnLimit: 12,
      reserves: {
        inputTokens: 1024,
        outputTokens: 4096,
        pinnedInstructionTokens: 2048,
        toolResultTokens: 8192,
      },
      managed,
    },
    settings: {
      revisionId: settingsRevision,
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: 'default',
      defaultContextMode: 'rolling',
      defaults: { allowResearch: false, allowRag: false, allowInternet: false },
      markdownOnly: true,
      limits: {
        runTimeoutMs: 120000,
        maximumToolCalls: 8,
        maximumParallelRunsPerUser: 2,
        dailyRunQuota: 100,
        dailyInputTokenQuota: 1000000,
        dailyOutputTokenQuota: 250000,
      },
      retention: { retentionDays: 365, archiveAfterDays: 30 },
      artifacts: {
        maximumFileBytes: 10485760,
        chatQuotaBytes: 268435456,
        markdownExternalImages: false,
      },
      logs: { segmentMaximumBytes: 8388608, segmentMaximumAgeMinutes: 1440 },
      exports: {
        maximumOutputBytes: 67108864,
        timeoutMilliseconds: 120000,
        maximumAttempts: 2,
      },
      storage: null,
      ...(savedSettings ?? {}),
    },
    models,
  });
  await page.route('**/v1/admin/principals', (route) => json(route, { items: [] }));
  await page.route('**/v1/admin/chat/providers', (route) =>
    json(route, { providers: [{ provider: 'ollama_cloud' }] }),
  );
  await page.route('**/v1/admin/chat/configuration', (route) => json(route, configuration()));
  await page.route('**/v1/admin/chat/health', (route) =>
    json(route, {
      contract: 'chat-health.v1',
      generatedAt: '2030-01-01T00:00:00.000Z',
      providers: [
        {
          provider: 'ollama_cloud',
          enabled: true,
          generationModel: 'minimax-m3:cloud',
          capabilities: {
            generation: 'healthy',
            model_catalog: 'healthy',
            web_search: 'healthy',
            web_fetch: 'healthy',
          },
        },
        {
          provider: 'openai_oauth',
          enabled: true,
          generationModel: 'gpt-test',
          capabilities: { generation: 'healthy', model_catalog: 'healthy' },
        },
      ],
      runs: { counts: { completed: 12 }, active: [], failedLast24Hours: 0 },
      capacity: { profiles: 2, known: 2, unknown: 0, stale: 0 },
      context: {
        jobs: { completed: 3 },
        snapshots: 3,
        foldedMessages: 18,
        exactPins: 2,
        staleLeases: 0,
      },
      storage: {
        configured: true,
        state: 'healthy',
        freeBytes: '500000000000',
        recordedBytes: '5242880',
      },
      archives: {
        segments: { active: 2, sealed: 3 },
        unlinkedFoldedMessages: 0,
        unlinkedSnapshots: 0,
        verifiedSample: 3,
        failedSample: 0,
        sampleLimit: 20,
      },
      reconciliation: {
        operations: { completed: 1 },
        quarantinedConflicts: 0,
        latest: null,
      },
      performance: {
        sampleLimit: 10000,
        timeToFirstTokenMs: { samples: 12, p50: 84.5, p95: 210.2 },
        eventCommitLatencyMs: { samples: 64, p50: 2.1, p95: 7.4 },
        toolCallLatencyMs: { samples: 8, p50: 45.2, p95: 160.1 },
        contextInputTokens: { samples: 12, average: 3200, maximum: 11200 },
        compressionRatio: { samples: 3, average: 0.42 },
        runtimeMemory: { rssBytes: '134217728', heapUsedBytes: '67108864' },
      },
      quotas: {
        dailyRunLimit: 250,
        dailyInputTokenLimit: 1000000,
        dailyOutputTokenLimit: 250000,
        artifactBytesPerChat: 268435456,
        runsToday: 12,
        inputTokensToday: '38000',
        outputTokensToday: '6100',
        retentionDays: 730,
        archiveAfterDays: 45,
      },
      errorsLast24Hours: [],
    }),
  );
  await page.route('**/v1/admin/chat/exports/capabilities', (route) =>
    json(route, {
      status: 'healthy',
      documentModel: 'chat-document.v1',
      generatorRevision: 'chat-export.v1',
      formatPolicyRevision: 'safe-office-pdf.v1',
      formats: {
        docx: { available: true, passive: true, bytes: 12000 },
        pdf: { available: true, passive: true, embeddedFonts: true, bytes: 18000 },
      },
      externalRelationships: false,
      macros: false,
      shellConversion: false,
      networkConversion: false,
    }),
  );
  await page.route('**/v1/admin/chat/context', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(route.request().method()).toBe('PUT');
    expect(record(body['managed'])['enabled']).toBe(true);
    expect(record(record(body['managed'])['l2'])['provider']).toBe('openai_oauth');
    expect(record(record(body['managed'])['l3'])['provider']).toBe('ollama_cloud');
    managed = { ...record(body['managed']), tests: [] };
    contextRevision = '11111111-1111-4111-8111-111111111111';
    settingsRevision = '22222222-2222-4222-8222-222222222222';
    return json(route, {
      ok: true,
      revisionId: contextRevision,
      settingsRevisionId: settingsRevision,
    });
  });
  await page.route('**/v1/admin/chat/context/preview', (route) => {
    managed = {
      ...managed,
      tests: [
        { layer: 'l2', status: 'healthy', testedAt: '2030-01-01T00:00:00Z' },
        { layer: 'l3', status: 'healthy', testedAt: '2030-01-01T00:00:00Z' },
      ],
    };
    return json(route, {
      syntheticInput: true,
      beforeTokens: 14400,
      afterTokens: 5100,
      selectedPins: [{ label: 'Synthetic pinned instruction', tokens: 250 }],
      summary: { status: 'ready', estimatedTokens: 1200 },
      structuredState: { status: 'ready', estimatedTokens: 450 },
      recentTurns: 6,
      layerErrors: [],
      projectedProviderCalls: 2,
    });
  });
  await page.route('**/v1/admin/chat/models/41', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    models[0] = {
      ...models[0],
      administratorContextTokens: body['administratorContextTokens'] as number,
      administratorOutputTokens: body['administratorOutputTokens'] as number,
      note: body['note'] as string,
      capacity: {
        contextTokens: body['administratorContextTokens'] as number,
        contextSource: 'administrator_override',
        maximumOutputTokens: body['administratorOutputTokens'] as number,
        outputSource: 'administrator_override',
      },
    };
    return json(route, { ok: true });
  });
  await page.route('**/v1/admin/chat/storage/probe', (route) => {
    expect(route.request().postDataJSON()).toEqual({ storagePath: '/volume1/Data/RAG/chat' });
    return json(route, {
      ok: true,
      requestedPath: '/volume1/Data/RAG/chat',
      resolvedPath: '/volume1/Data/RAG/chat/.noderag-chat',
      manifestId: '33333333-3333-4333-8333-333333333333',
      initialized: true,
      filesystem: 'btrfs',
      availableBytes: '500000000000',
      warnings: [],
    });
  });
  await page.route('**/v1/admin/chat/storage/reconcile/preview', (route) => {
    reconcilePreviewCalls += 1;
    const body = record(route.request().postDataJSON());
    const mapped = record(body['ownerMap'])['77'] === 1;
    return json(route, {
      contract: 'chat-reconciliation-preview.v1',
      sourceManifestSha256: 'a'.repeat(64),
      rootManifestId: '33333333-3333-4333-8333-333333333333',
      candidates: [
        {
          conversationId: '55555555-5555-4555-8555-555555555555',
          name: 'Recovered legal notes',
          sourceOwnerId: 77,
          sourceOwnerLabel: 'theunis',
          suggestedDestinationPrincipalId: 1,
          destinationPrincipalId: mapped ? 1 : null,
          messages: 18,
          runs: 9,
          events: 45,
          segments: 3,
          action: mapped ? 'import' : 'quarantine',
        },
      ],
      destinationPrincipals: [{ id: 1, label: 'admin' }],
      conflicts: mapped
        ? []
        : [
            {
              kind: 'owner_unmapped',
              sourceRelativePath: 'conversations/55555555-5555-4555-8555-555555555555',
            },
          ],
      canReconcile: mapped,
    });
  });
  await page.route('**/v1/admin/chat/storage/reconcile', (route) => {
    reconciledOwnerMap = record(record(route.request().postDataJSON())['ownerMap']);
    return json(route, {
      operationId: '66666666-6666-4666-8666-666666666666',
      state: 'completed',
      importedChats: 1,
      importedEvents: 45,
    });
  });
  await page.route('**/v1/admin/chat/settings', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      defaultProvider: 'openai_oauth',
      defaultModel: 'gpt-test',
      defaultContextMode: 'managed',
      defaultAllowInternet: true,
      storagePath: '/volume1/Data/RAG/chat',
      exportMaxOutputBytes: 33554432,
      exportTimeoutMs: 180000,
      exportMaximumAttempts: 3,
    });
    savedSettings = {
      revisionId: '44444444-4444-4444-8444-444444444444',
      defaultProvider: body['defaultProvider'],
      defaultModel: body['defaultModel'],
      defaultReasoningEffort: body['defaultReasoningEffort'],
      defaultContextMode: body['defaultContextMode'],
      defaults: {
        allowResearch: body['defaultAllowResearch'],
        allowRag: body['defaultAllowRag'],
        allowInternet: body['defaultAllowInternet'],
      },
      exports: {
        maximumOutputBytes: body['exportMaxOutputBytes'],
        timeoutMilliseconds: body['exportTimeoutMs'],
        maximumAttempts: body['exportMaximumAttempts'],
      },
      storage: {
        requestedPath: body['storagePath'],
        resolvedPath: '/volume1/Data/RAG/chat/.noderag-chat',
        manifestId: '33333333-3333-4333-8333-333333333333',
      },
    };
    return json(route, { ok: true, revisionId: record(savedSettings)['revisionId'] });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Context window/ }).click();
  await expect(page.getByText(/Original chat history is never deleted/)).toBeVisible();
  await expect(page.getByText(/provider still reports no capacity/)).toBeVisible();
  await page.getByLabel('Fallback context tokens').first().fill('128000');
  await page.getByLabel('Fallback maximum output tokens').first().fill('16000');
  await page
    .getByLabel('Fallback evidence note')
    .first()
    .fill('Verified against provider documentation.');
  await page.getByRole('button', { name: 'Save model capacity' }).first().click();
  await expect(page.getByText('Capacity override saved for GPT Test.')).toBeVisible();

  await page.getByLabel(/Configure managed context/).check();
  await page.getByLabel('Provider and model').nth(1).selectOption('ollama_cloud|minimax-m3:cloud');
  await page.getByRole('button', { name: 'Save context revision' }).click();
  await expect(page.getByText(/new immutable context-settings revision/)).toBeVisible();
  await page.getByRole('button', { name: 'Run synthetic preview' }).click();
  await expect(page.getByText('Synthetic L2/L3 readiness preview passed.')).toBeVisible();
  await expect(page.getByText(/14,400.*5,100 tokens/)).toBeVisible();
  const contextAccessibility = await new AxeBuilder({ page }).include('.admin-content').analyze();
  expect(contextAccessibility.violations).toEqual([]);

  await page.getByRole('button', { name: /^Chat settings/ }).click();
  await expect(page.getByText(/Internet means Ollama Cloud hosted web search/)).toBeVisible();
  await expect(page.getByText(/DOCX and PDF self-tests passed/)).toBeVisible();
  await page.getByLabel('Default context mode').selectOption('managed');
  await page.getByLabel('Ollama Cloud internet search').check();
  await page.getByLabel('Maximum export file (MiB)').fill('32');
  await page.getByLabel('Export timeout (milliseconds)').fill('180000');
  await page.getByLabel('Export attempts').fill('3');
  await page.getByLabel('Storage root path').fill('/volume1/Data/RAG/chat');
  await page.getByRole('button', { name: 'Verify and initialize' }).click();
  await expect(page.getByText(/Writable Chat storage.*\.noderag-chat/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply Chat settings' }).click();
  await expect(page.getByText('A new immutable Chat-settings revision was saved.')).toBeVisible();
  expect(savedSettings).not.toBeNull();
  await expect(page.getByLabel('Default context mode')).toHaveValue('managed');
  await expect(page.getByText('chat ready')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect existing chats' }).click();
  await expect(page.getByText('Recovered legal notes')).toBeVisible();
  await expect(page.getByLabel('Owner for theunis')).toHaveValue('1');
  await page.getByRole('button', { name: 'Re-check ownership and checksums' }).click();
  await expect(page.getByRole('button', { name: 'Reconcile verified chats' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reconcile verified chats' }).click();
  await expect.poll(() => reconciledOwnerMap).toEqual({ '77': 1 });
  expect(reconcilePreviewCalls).toBeGreaterThanOrEqual(2);
  const settingsAccessibility = await new AxeBuilder({ page }).include('.admin-content').analyze();
  expect(settingsAccessibility.violations).toEqual([]);
  await page.getByRole('button', { name: /^Chat health/ }).click();
  await expect(page.getByRole('heading', { name: 'Provider capability health' })).toBeVisible();
  await expect(page.getByText('Ollama Cloud')).toBeVisible();
  await expect(page.getByText(/3 verified · 0 failed/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Chat performance' })).toBeVisible();
  await expect(page.getByText('84.5 ms')).toBeVisible();
  await expect(page.getByText(/No Chat errors were recorded/)).toBeVisible();
  const healthAccessibility = await new AxeBuilder({ page }).include('.admin-content').analyze();
  expect(healthAccessibility.violations).toEqual([]);
});

test('administrators can configure knowledge bases, settings, storage, and vision in dark mode', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await operational(page);
  const silos: Record<string, unknown>[] = [
    {
      id: 1,
      slug: 'default',
      displayName: 'My knowledge',
      description: 'Initial library',
      document_count: 2,
      principal_count: 1,
    },
  ];
  const storage: Record<string, unknown>[] = [
    {
      id: 4,
      name: 'Primary documents',
      managedPath: '/data/noderag',
      purpose: 'documents',
      enabled: true,
    },
  ];
  let settingsSaved: Record<string, unknown> | null = null;
  const settings: Record<string, unknown> = {
    targetChars: 2000,
    overlapChars: 300,
    maxTokens: 512,
    snapWindow: 0.15,
    headingPrefix: true,
    embedThreads: 2,
    ingestThreads: 2,
    throttleWhenBusy: true,
    defaultMode: 'hybrid',
    efSearch: 80,
    auditRetentionDays: 365,
    updatedAt: '2030-01-01T00:00:00Z',
    runtime: {
      availableProcessors: 8,
      maximumEmbeddingThreads: 8,
      activeEmbeddingThreads: 2,
      configuredEmbeddingThreads: 2,
      pendingRestart: false,
      generation: 0,
      controlAvailable: true,
      applyStatus: 'active',
    },
  };
  let storageSaved: Record<string, unknown> | null = null;
  let visionSaved: Record<string, unknown> | null = null;
  await page.route('**/v1/silos', (route) =>
    json(route, {
      items: silos.map((item) => ({
        id: item['id'],
        slug: item['slug'],
        displayName: item['displayName'],
      })),
    }),
  );
  await page.route('**/v1/admin/silos**', (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      silos.push({ id: 2, ...body, document_count: 0, principal_count: 1 });
      return json(route, { id: 2, ...body }, 201);
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      const existing = silos[0];
      if (existing !== undefined) Object.assign(existing, body);
      return json(route, { id: 1, slug: 'default', ...body });
    }
    return json(route, { items: silos });
  });
  await page.route('**/v1/admin/settings', (route) => {
    if (route.request().method() === 'PUT') {
      settingsSaved = route.request().postDataJSON() as Record<string, unknown>;
      Object.assign(settings, settingsSaved, {
        updatedAt: '2030-01-01T00:01:00Z',
        runtime: {
          ...(settings['runtime'] as Record<string, unknown>),
          activeEmbeddingThreads: settingsSaved['embedThreads'],
          configuredEmbeddingThreads: settingsSaved['embedThreads'],
          generation: 1,
          applyStatus: 'reloaded',
        },
      });
      return json(route, settings);
    }
    return json(route, settings);
  });
  await page.route('**/v1/admin/storage**', (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname.endsWith('/probe')) {
      return json(route, {
        writable: true,
        fsyncVerified: true,
        availableBytes: String(50 * 1024 ** 3),
      });
    }
    if (request.method() === 'PATCH') {
      storageSaved = request.postDataJSON() as Record<string, unknown>;
      const existing = storage[0];
      if (existing !== undefined) Object.assign(existing, storageSaved);
      return json(route, { id: 4, ...(existing ?? {}) });
    }
    return json(route, { items: storage });
  });
  await page.route('**/v1/admin/vision/status', (route) =>
    json(route, {
      settings: {
        enabled: true,
        baseUrl: 'https://ollama.com/api/chat',
        model: 'qwen2.5vl:7b',
        maximumParallel: 2,
        maximumImagesPerCall: 5,
        timeoutMs: 120000,
        maximumAttempts: 3,
        maximumImageDimension: 2048,
        credentialConfigured: true,
        activatedAt: '2030-01-01T00:00:00Z',
      },
      counts: { pending: 3, analysed: 7, failed: 0, skipped: 1 },
      estimate: { projectedCalls: 3 },
      warnings: [],
    }),
  );
  await page.route('**/v1/admin/vision/test', (route) => {
    visionSaved = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { elapsedMs: 48, bearerTokenPersisted: true });
  });
  await page.route('**/v1/admin/evaluation', (route) =>
    json(route, { cases: [], runs: [], baselines: [], alerts: [] }),
  );
  await page.route('**/v1/admin/logs', (route) =>
    json(route, {
      generatedAt: '2030-01-01T12:00:00Z',
      windowStartedAt: '2029-12-31T12:00:00Z',
      windowHours: 24,
      itemCount: 1,
      items: [
        {
          id: 301,
          createdAt: '2030-01-01T11:58:00Z',
          eventType: 'failed',
          detail: { attempt: 5, code: '23514' },
          jobId: 77,
          kind: 'extract',
          state: 'failed',
          logicalAttempt: 5,
          maximumAttempts: 5,
          progress: { stage: 'saving-extraction', pagesCompleted: 336, pagesTotal: 336 },
          errorClass: 'permanent',
          error: {
            code: '23514',
            message: 'new row violates a check constraint',
            detail: { table: 'document_block', constraint: 'document_block_check' },
          },
          documentId: 12,
          documentName: 'annual-report.pdf',
          documentPath: 'annual-report.pdf',
          siloId: 1,
          siloName: 'My knowledge',
        },
      ],
    }),
  );
  await page.route('**/v1/documents?**', (route) => json(route, { items: [], nextCursor: null }));

  await signIn(page);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', './favicon.svg');
  await expect(page.locator('.sidebar nav button')).toHaveText([
    'Search',
    'Research',
    'Knowledge Bases',
    'Ingest',
    'Operations',
    'Administration',
  ]);
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge Bases', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add knowledge base' }).click();
  const addSpace = page.getByRole('dialog', { name: 'Add a knowledge base' });
  await addSpace.getByLabel('Name').fill('Engineering');
  await addSpace.getByLabel('Slug').fill('engineering');
  await addSpace.getByLabel('Description').fill('Technical reference material');
  await addSpace.getByRole('button', { name: 'Create knowledge base' }).click();
  await expect(page.getByText('Knowledge base created.')).toBeVisible();
  await expect(
    page.locator('.selected-knowledge-base-summary').getByText('Engineering', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Administration' }).click();
  await expect(page.locator('.admin-nav')).not.toContainText('Knowledge Bases');
  await page.getByRole('button', { name: /^Logs/ }).click();
  await expect(page.getByText('Rolling 24-hour ingestion history')).toBeVisible();
  const failedLog = page.locator('.ingestion-log-entry').filter({ hasText: 'annual-report.pdf' });
  await expect(failedLog.getByText('Error 23514')).toBeVisible();
  await expect(failedLog.getByText(/Database table: document_block/)).toBeVisible();
  await expect(failedLog.getByText(/constraint: document_block_check/)).toBeVisible();
  await page.getByRole('button', { name: /^Settings/ }).click();
  await expect(page.getByText('Tune chunking, worker concurrency')).toBeVisible();
  await expect(page.getByText('Detected processors').locator('..')).toContainText('8');
  await page.getByRole('button', { name: /Balanced/ }).click();
  await expect(page.getByLabel('Embedding CPU threads')).toHaveValue('7');
  await page.getByLabel('Ingest workers').fill('4');
  await page.getByRole('button', { name: 'Apply settings and restart embedding engine' }).click();
  await expect
    .poll(() => settingsSaved)
    .toMatchObject({
      embedThreads: 7,
      ingestThreads: 4,
      throttleWhenBusy: true,
      defaultMode: 'hybrid',
    });

  await page.getByRole('button', { name: /^Storage/ }).click();
  await expect(page.getByText('different from the read-only input folders')).toBeVisible();
  const storageRecord = page.locator('.editable-record').filter({ hasText: 'Primary documents' });
  await storageRecord.getByLabel('Name').fill('Fast document storage');
  await storageRecord.getByRole('button', { name: 'Verify and save' }).click();
  await expect
    .poll(() => storageSaved)
    .toMatchObject({
      name: 'Fast document storage',
      managedPath: '/data/noderag',
      enabled: true,
    });

  await page.getByRole('button', { name: /^Settings/ }).click();
  await expect(page.getByLabel('Embedding CPU threads')).toHaveValue('7');
  await expect(page.getByLabel('Ingest workers')).toHaveValue('4');

  await page.getByRole('button', { name: /Image understanding/ }).click();
  await expect(page.getByLabel('Ollama API key')).toHaveAttribute('type', 'password');
  await page.getByLabel('Parallel vision calls').fill('6');
  await page.getByLabel('Images per call').fill('7');
  await page.getByLabel('Ollama API key').fill('replacement-secret');
  await page.getByRole('button', { name: 'Test and save vision settings' }).click();
  await expect
    .poll(() => visionSaved)
    .toMatchObject({
      maximumParallel: 6,
      maximumImagesPerCall: 7,
      bearerToken: 'replacement-secret',
    });

  await page.getByRole('button', { name: /^Color schemes/ }).click();
  await expect(page.locator('.theme-choice')).toHaveCount(5);
  await page.getByRole('button', { name: /^Midnight blue/ }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'blue');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('noderag.color-scheme.1')))
    .toBe('blue');
  const blueSidebar = await page.locator('.sidebar').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderRightColor,
  }));
  expect(blueSidebar).toEqual({ background: 'rgb(10, 25, 48)', border: 'rgb(102, 137, 186)' });

  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'blue');
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Color schemes/ }).click();
  await expect(page.getByRole('button', { name: /^Midnight blue/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /^Forest green/ }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'green');

  await page.getByRole('button', { name: /^Evaluation/ }).click();
  await expect(page.getByRole('heading', { name: 'Queue a pinned comparison' })).toBeVisible();
  const colors = await page
    .locator('.evaluation-card')
    .first()
    .evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      foreground: getComputedStyle(element).color,
    }));
  expect(colors).toEqual({ background: 'rgb(25, 45, 37)', foreground: 'rgb(229, 239, 235)' });
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('members can choose and retain a personal color scheme without administrator access', async ({
  page,
}) => {
  await operational(page, {
    principalId: 7,
    username: 'member',
    serverAdmin: false,
    searchOnly: false,
  });
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Knowledge Bases' })).toBeVisible();
  await page.getByRole('button', { name: 'Knowledge Bases' }).click();
  await expect(page.getByRole('button', { name: 'Add knowledge base' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit selected' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Administration' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your color scheme' })).toBeVisible();
  await expect(page.locator('.admin-nav button')).toHaveCount(1);
  await page.getByRole('button', { name: /^Deep red/ }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'red');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('noderag.color-scheme.7')))
    .toBe('red');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'red');
});

test('login and search surfaces have no automatically detectable WCAG A/AA violations', async ({
  page,
}) => {
  await operational(page);
  await page.goto('/');
  let scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('A-long-test-password!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.main-column').evaluate((element) => getComputedStyle(element).marginLeft),
    )
    .toBe('0px');
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    main: (() => {
      const element = document.querySelector<HTMLElement>('.main-column');
      return element === null
        ? null
        : {
            x: element.getBoundingClientRect().x,
            width: element.getBoundingClientRect().width,
            marginLeft: getComputedStyle(element).marginLeft,
            media900: matchMedia('(max-width: 900px)').matches,
            media901: matchMedia('(min-width: 901px)').matches,
            parentClass: element.parentElement?.className ?? null,
            styleAttribute: element.getAttribute('style'),
          };
    })(),
  }));
  expect(overflow).toEqual({
    scrollWidth: 320,
    innerWidth: 320,
    main: {
      x: 0,
      width: 320,
      marginLeft: '0px',
      media900: true,
      media901: false,
      parentClass: 'app-shell',
      styleAttribute: null,
    },
  });
  scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('creates and operates a durable tool-free Chat from the two-panel workspace', async ({
  page,
}) => {
  await operational(page);
  const chats: Record<string, unknown>[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Existing notes',
      archived: false,
      provider: 'ollama_cloud',
      model: 'minimax-m3:cloud',
      reasoningEffort: 'default',
      contextMode: 'rolling',
      updatedAt: '2030-01-01T00:00:00.000Z',
      capabilities: { research: false, rag: false, internet: false },
      activeRun: null,
    },
  ];
  const histories = new Map<string, Record<string, unknown>[]>([
    ['11111111-1111-4111-8111-111111111111', []],
  ]);
  let currentRun: Record<string, unknown> | null = null;
  let sentContent = '';
  const createOptions = {
    ready: true,
    default: {
      provider: 'ollama_cloud',
      model: 'minimax-m3:cloud',
      reasoningEffort: 'default',
      contextMode: 'rolling',
    },
    models: [
      {
        provider: 'ollama_cloud',
        model: 'minimax-m3:cloud',
        displayName: 'MiniMax M3 Cloud',
        reasoningEfforts: ['default', 'none', 'high'],
      },
      {
        provider: 'openai_oauth',
        model: 'gpt-test',
        displayName: 'GPT Test',
        reasoningEfforts: ['low', 'high'],
      },
    ],
  };
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      internetProvider: 'ollama_cloud',
      toolsEnabled: false,
      items: chats,
      createOptions,
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: 'id: 1\nevent: response.started\ndata: {"id":1}\n\n',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const chatId = url.pathname.split('/')[3] ?? '';
    if (route.request().method() === 'GET') {
      return json(route, { items: histories.get(chatId) ?? [], nextBefore: null });
    }
    sentContent = String(record(route.request().postDataJSON())['content'] ?? '');
    const messages = histories.get(chatId) ?? [];
    messages.push(
      {
        id: '33333333-3333-4333-8333-333333333333',
        sequence: 0,
        role: 'user',
        content: sentContent,
        state: 'committed',
        reasoning_summary: null,
        createdAt: '2030-01-01T00:01:00.000Z',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        sequence: 1,
        role: 'assistant',
        content: '',
        state: 'streaming',
        reasoning_summary: null,
        createdAt: '2030-01-01T00:01:01.000Z',
      },
    );
    histories.set(chatId, messages);
    currentRun = {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'running',
      attempts: 1,
      maximumAttempts: 3,
      safeErrorCode: null,
      updatedAt: '2030-01-01T00:01:01.000Z',
    };
    return json(route, { runId: currentRun.id, status: 'queued' }, 202);
  });
  await page.route(/\/v1\/chats\/[^/]+\/runs\/[^/]+\/(?:stop|retry)$/, (route) => {
    if (route.request().url().endsWith('/stop')) {
      currentRun = { ...(currentRun ?? {}), status: 'cancelled' };
      return json(
        route,
        { runId: '55555555-5555-4555-8555-555555555555', status: 'cancelled' },
        202,
      );
    }
    currentRun = {
      id: '66666666-6666-4666-8666-666666666666',
      status: 'queued',
      attempts: 0,
      maximumAttempts: 3,
      safeErrorCode: null,
    };
    return json(route, { runId: currentRun.id, status: 'queued' }, 202);
  });
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => {
    const chatId = new URL(route.request().url()).pathname.split('/')[3] ?? '';
    const chat = chats.find(({ id }) => id === chatId) ?? chats[0] ?? {};
    if (route.request().method() === 'GET') return json(route, { ...chat, activeRun: currentRun });
    const update = record(route.request().postDataJSON());
    Object.assign(chat, update['name'] === undefined ? {} : { name: update['name'] });
    if (update['archived'] === true) Object.assign(chat, { archived: true });
    return json(route, { ...chat, activeRun: currentRun });
  });
  await page.route('**/v1/chats', (route) => {
    const payload = record(route.request().postDataJSON());
    const created = {
      id: '22222222-2222-4222-8222-222222222222',
      name: payload['name'],
      archived: false,
      provider: payload['provider'],
      model: payload['model'],
      reasoningEffort: payload['reasoningEffort'],
      contextMode: payload['contextMode'],
      updatedAt: '2030-01-01T00:02:00.000Z',
      capabilities: { research: false, rag: false, internet: false },
      activeRun: null,
    };
    chats.unshift(created);
    histories.set(String(created.id), []);
    return json(route, created, 201);
  });

  await signIn(page);
  const researchNav = page.getByRole('button', { name: 'Research' });
  const chatNav = page.getByRole('button', { name: 'Chat' });
  await expect(chatNav).toBeVisible();
  await expect(researchNav).toBeVisible();
  const navigationLabels = await page.locator('.sidebar nav button').allTextContents();
  expect(navigationLabels.map((label) => label.trim())).toEqual([
    'Search',
    'Research',
    'Chat',
    'Knowledge Bases',
    'Ingest',
    'Operations',
    'Administration',
  ]);
  await chatNav.click();
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByText('Internet off · Ollama Cloud only')).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Chat name').fill('Legal notes');
  await expect(page.getByLabel('Reasoning effort').locator('option')).toHaveText([
    'default',
    'none',
    'high',
  ]);
  await page.getByLabel('Reasoning effort').selectOption('high');
  await expect(page.getByText(/Local or custom Ollama addresses are never offered/)).toBeVisible();
  await page.getByRole('button', { name: 'Create chat' }).click();
  await expect(page.getByRole('heading', { name: 'Legal notes' })).toBeVisible();
  expect(chats[0]?.['reasoningEffort']).toBe('high');
  const messageLog = page.locator('.chat-message-log');
  await messageLog.evaluate((element) => element.setAttribute('data-test-stable', 'true'));
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Summarize this point.');
  await composer.press('Enter');
  await expect.poll(() => sentContent).toBe('Summarize this point.');
  await expect(messageLog).toHaveAttribute('data-test-stable', 'true');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Retry last response' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry last response' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('prompt');
    await dialog.accept('Renamed legal notes');
  });
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('heading', { name: 'Renamed legal notes' })).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText(/Chat archived/)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.chat-page').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect(page.locator('.chat-conversation-panel')).toBeVisible();
});

test('manages exact context pins, compression, and verified older Chat logs', async ({ page }) => {
  await operational(page);
  const chatId = '12121212-1212-4212-8212-121212121212';
  const newest = [
    {
      id: '34343434-3434-4434-8434-343434343434',
      sequence: 4,
      role: 'user',
      content: 'Keep the DSM acceptance constraint exact.',
      state: 'committed',
      contextState: 'active',
      pinned: false,
      pinnedAt: null,
      reasoning_summary: null,
      createdAt: '2030-01-05T00:04:00.000Z',
      citations: [],
    },
    {
      id: '45454545-4545-4454-8454-454545454545',
      sequence: 5,
      role: 'assistant',
      content: 'The constraint will remain verbatim when pinned.',
      state: 'committed',
      contextState: 'active',
      pinned: false,
      pinnedAt: null,
      reasoning_summary: null,
      createdAt: '2030-01-05T00:05:00.000Z',
      citations: [],
    },
  ];
  const older = [
    {
      id: '56565656-5656-4565-8565-565656565656',
      sequence: 0,
      role: 'user',
      content: 'Earlier requirement retained in the sealed archive.',
      state: 'committed',
      contextState: 'folded',
      pinned: false,
      pinnedAt: null,
      reasoning_summary: null,
      createdAt: '2030-01-04T00:00:00.000Z',
      citations: [],
      archive: {
        segmentNumber: 0,
        encoding: 'gzip',
        manifestRevisionId: '67676767-6767-4676-8676-676767676767',
        integrity: 'verified',
      },
    },
  ];
  const chat = {
    id: chatId,
    name: 'Managed context review',
    archived: false,
    provider: 'ollama_cloud',
    model: 'minimax-m3:cloud',
    reasoningEffort: 'default',
    contextMode: 'managed',
    updatedAt: '2030-01-05T00:05:00.000Z',
    capabilities: { research: false, rag: false, internet: false },
    activeRun: null,
  };
  let contextJob: Record<string, unknown> | null = null;
  const contextResponse = () => ({
    contract: 'chat-managed-context.v1',
    mode: 'managed',
    counts: {
      active_messages: newest.length,
      folded_messages: older.length,
      pinned_messages: [...newest, ...older].filter(({ pinned }) => pinned).length,
    },
    snapshot: {
      schema_revision: 'chat-context-snapshot.v1',
      context_tokens: 186,
    },
    job: contextJob,
  });
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      internetProvider: 'ollama_cloud',
      toolsEnabled: false,
      researchEnabled: false,
      ragEnabled: false,
      internetEnabled: false,
      items: [chat],
      createOptions: {
        ready: true,
        default: {
          provider: 'ollama_cloud',
          model: 'minimax-m3:cloud',
          reasoningEffort: 'default',
          contextMode: 'managed',
        },
        contextModes: ['rolling', 'managed'],
        models: [
          {
            provider: 'ollama_cloud',
            model: 'minimax-m3:cloud',
            displayName: 'MiniMax M3 Cloud',
            reasoningEfforts: ['default'],
          },
        ],
      },
    }),
  );
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => json(route, chat));
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: '',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    const before = new URL(route.request().url()).searchParams.get('before');
    return json(
      route,
      before === null
        ? { items: newest, nextBefore: 4, historySources: ['database'] }
        : { items: older, nextBefore: null, historySources: ['database', 'sealed_archive'] },
    );
  });
  await page.route(/\/v1\/chats\/[^/]+\/messages\/[^/]+\/pin$/, (route) => {
    const messageId = new URL(route.request().url()).pathname.split('/')[5] ?? '';
    const target = [...newest, ...older].find(({ id }) => id === messageId);
    const pinned = record(route.request().postDataJSON())['pinned'] === true;
    if (target !== undefined) {
      target.pinned = pinned;
      target.pinnedAt = pinned ? '2030-01-05T00:06:00.000Z' : null;
    }
    return json(route, { messageId, pinned, pinnedAt: target?.pinnedAt ?? null });
  });
  await page.route(/\/v1\/chats\/[^/]+\/context$/, (route) => json(route, contextResponse()));
  await page.route(/\/v1\/chats\/[^/]+\/context\/compression-preview$/, (route) =>
    json(route, {
      completeTurns: 3,
      foldMessageIds: older.map(({ id }) => id),
      keepRecentTurns: 1,
      pinnedMessageIds: newest.filter(({ pinned }) => pinned).map(({ id }) => id),
      scheduling: 'sequential',
      estimatedSourceTokens: 412,
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/context\/compressions$/, (route) => {
    contextJob = {
      id: '78787878-7878-4787-8787-787878787878',
      state: 'queued',
      current_layer: null,
    };
    return json(route, { operationId: contextJob.id, state: 'queued' }, 202);
  });
  await page.route(/\/v1\/chats\/[^/]+\/context\/compressions\/[^/]+\/cancel$/, (route) => {
    contextJob = {
      id: '78787878-7878-4787-8787-787878787878',
      state: 'cancelled',
      current_layer: null,
    };
    return json(route, { operationId: contextJob.id, state: 'cancelled' }, 202);
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { name: 'Managed context review' })).toBeVisible();
  await expect(page.getByLabel('Managed context status')).toContainText(
    '2 active · 1 in older logs · 0 exact pins',
  );
  await page
    .getByTitle('Keep this exact message in managed context')
    .filter({ hasText: 'Pin' })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();
  await expect(page.getByLabel('Managed context status')).toContainText('1 exact pins');
  await page.getByRole('button', { name: 'View older logs' }).click();
  await expect(page.getByText('Earlier requirement retained in the sealed archive.')).toBeVisible();
  await expect(page.getByText('Archived from context')).toBeVisible();
  await page.getByRole('button', { name: 'Preview compression' }).click();
  await expect(page.getByRole('heading', { name: 'Compression preview' })).toBeVisible();
  await expect(page.getByText('This is a dry run.')).toBeVisible();
  await expect(page.getByText('412')).toBeVisible();
  await page.getByRole('button', { name: 'Compress context' }).click();
  await expect(page.getByText(/Context compression queued/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel compression' }).click();
  await expect(page.getByText(/cancellation requested/)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.chat-page').analyze();
  expect(accessibility.violations).toEqual([]);
});

test('attaches a Research snapshot and opens stable Chat citations', async ({ page }) => {
  await operational(page);
  const chatId = '77777777-7777-4777-8777-777777777777';
  const sourceId = '88888888-8888-4888-8888-888888888888';
  const chat = {
    id: chatId,
    name: 'Research-backed chat',
    archived: false,
    provider: 'openai_oauth',
    model: 'gpt-test',
    reasoningEffort: 'low',
    contextMode: 'rolling',
    updatedAt: '2030-01-02T00:00:00.000Z',
    capabilities: { research: true, rag: false, internet: false },
    activeRun: null,
  };
  const source = {
    attachmentRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    attachmentRevision: 1,
    id: sourceId,
    citationLabel: 'R1',
    researchId: 31,
    researchName: 'Legal Notes',
    referenceId: 41,
    siloId: 2,
    siloSlug: 'legal-space',
    documentId: 77,
    documentName: 'revenue-law.md',
    documentTitle: 'Revenue Law',
    documentFormat: 'md',
    pageOrdinal: 0,
    chunkId: 91,
    chunkIds: [91],
    locator: { pageStart: 1, pageEnd: 1, characterStart: 18 },
    confidence: 0.84,
    evidence: [
      { kind: 'semantic', text: 'Revenue is collected under the statute', confidence: 0.84 },
    ],
    query: 'revenue evidence',
    searchMode: 'semantic',
    originalSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    referenceSha256: 'c'.repeat(64),
    sourceSelectedAt: '2030-01-01T00:00:00.000Z',
    capturedAt: '2030-01-02T00:00:00.000Z',
    status: 'active',
    text: 'Revenue is collected under the statute.',
  };
  const chats: Record<string, unknown>[] = [];
  let createdResearchIds: unknown = null;
  let revision = 1;
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      internetProvider: 'ollama_cloud',
      providerToolsEnabled: true,
      researchEnabled: true,
      items: chats,
      createOptions: {
        ready: true,
        default: {
          provider: 'openai_oauth',
          model: 'gpt-test',
          reasoningEffort: 'low',
          contextMode: 'rolling',
        },
        models: [
          {
            provider: 'openai_oauth',
            model: 'gpt-test',
            displayName: 'GPT Test',
            reasoningEfforts: ['low'],
          },
        ],
        researchCollections: [
          {
            id: 31,
            name: 'Legal Notes',
            updatedAt: '2030-01-01T00:00:00.000Z',
            totalItems: 1,
            visibleItems: 1,
            visibleDocuments: 1,
          },
        ],
      },
    }),
  );
  await page.route('**/v1/chats', (route) => {
    const payload = record(route.request().postDataJSON());
    createdResearchIds = payload['researchIds'];
    chats.push(chat);
    return json(route, chat, 201);
  });
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'id: 1\nevent: response.completed\ndata: {"id":1}\n\n',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    json(route, {
      items: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          sequence: 0,
          role: 'assistant',
          content:
            '## Supported conclusion\n\nThe statute supports this conclusion [R1].\n\n- Revenue collection is authorized.\n- The cited passage remains available.',
          state: 'committed',
          reasoning_summary:
            'Checked the attached Research snapshot before answering. Confirmed the cited passage.',
          createdAt: '2030-01-02T00:01:00.000Z',
          toolCalls: [
            {
              id: 'abababab-abab-4bab-8bab-abababababab',
              ordinal: 0,
              name: 'research.read_page.v1',
              arguments: { sourceId, pageNumber: 1 },
              status: 'completed',
              resultBytes: 128,
              safeErrorCode: null,
              durationMs: 240,
              resultCount: 1,
              resultSummary: { kind: 'research' },
              startedAt: '2030-01-02T00:00:59.000Z',
              finishedAt: '2030-01-02T00:00:59.240Z',
            },
          ],
          activities: [
            {
              id: 'thinking-before-tool',
              type: 'thinking',
              sequence: 1,
              text: 'Checked the attached Research snapshot before answering.',
            },
            {
              id: 'tool-read-page',
              type: 'tool',
              sequence: 2,
              toolCall: {
                id: 'abababab-abab-4bab-8bab-abababababab',
                ordinal: 0,
                name: 'research.read_page.v1',
                arguments: { sourceId, pageNumber: 1 },
                status: 'completed',
                resultBytes: 128,
                safeErrorCode: null,
                durationMs: 240,
                resultCount: 1,
                resultSummary: { kind: 'research' },
                startedAt: '2030-01-02T00:00:59.000Z',
                finishedAt: '2030-01-02T00:00:59.240Z',
              },
            },
            {
              id: 'thinking-after-tool',
              type: 'thinking',
              sequence: 3,
              text: 'Confirmed the cited passage.',
            },
          ],
          citations: [source],
        },
      ],
      nextBefore: null,
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/research\/refresh$/, (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'REFRESH RESEARCH' });
    revision = 2;
    return json(route, { attachment: { revision } }, 201);
  });
  await page.route(/\/v1\/chats\/[^/]+\/research$/, (route) =>
    json(route, {
      attachment: {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${String(revision)}`,
        revision,
        snapshotAt: '2030-01-02T00:00:00.000Z',
        itemCount: 1,
        hiddenItemCount: 0,
        collections: [
          {
            researchId: 31,
            name: 'Legal Notes',
            sourceUpdatedAt: '2030-01-01T00:00:00.000Z',
            totalItems: 1,
            visibleItems: 1,
          },
        ],
      },
      sources: [source],
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/research\/sources\/[^/]+\/page\?.*$/, (route) =>
    json(route, {
      pageOrdinal: 0,
      pageNumber: 1,
      characterStart: 0,
      characterEnd: 55,
      markdown: '# Revenue Law\n\nRevenue is collected under the statute.',
      untrusted: true,
    }),
  );
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => json(route, chat));

  await signIn(page);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Chat name').fill('Research-backed chat');
  await page.getByText('Legal Notes', { exact: true }).click();
  await page.getByRole('button', { name: 'Create chat' }).click();
  await expect.poll(() => createdResearchIds).toEqual([31]);
  await expect(page.getByText('Research snapshot r1')).toBeVisible();
  await expect(page.getByText(/Internet off · Ollama Cloud only/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Supported conclusion' })).toBeVisible();
  const thinking = page.locator('details.chat-thinking-bubble').first();
  const tool = page.locator('details.chat-tool-bubble');
  await expect(page.locator('.chat-assistant-turn > *')).toHaveCount(4);
  await expect(page.locator('.chat-assistant-turn > *').nth(0)).toHaveClass(/chat-thinking-bubble/);
  await expect(page.locator('.chat-assistant-turn > *').nth(1)).toHaveClass(/chat-tool-bubble/);
  await expect(page.locator('.chat-assistant-turn > *').nth(2)).toHaveClass(/chat-thinking-bubble/);
  await expect(page.locator('.chat-assistant-turn > *').nth(3)).toHaveClass(/chat-final-answer/);
  await expect(thinking).not.toHaveAttribute('open', '');
  await expect(tool).not.toHaveAttribute('open', '');
  await thinking.getByText('Thinking', { exact: true }).click();
  await expect(
    page.getByText('Checked the attached Research snapshot before answering.'),
  ).toBeVisible();
  await tool.getByText('Read research page', { exact: true }).click();
  await expect(tool.getByText('research.read_page.v1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy final answer' })).toBeVisible();
  await expect(thinking.getByRole('button', { name: 'Copy thinking' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy tool details' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy final answer' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const citationButton = page.getByRole('button', { name: /\[R1\] Revenue Law/ });
  await expect(citationButton).toBeVisible();
  await citationButton.click();
  await expect(page.getByRole('heading', { name: /Revenue Law · Markdown/ })).toBeVisible();
  await expect(page.getByText('Revenue is collected under the statute.')).toBeVisible();
  await page.getByRole('button', { name: 'Source passage' }).click();
  await expect(page.getByText('Confidence 84%')).toBeVisible();
  await page.getByRole('button', { name: /Close/ }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Refresh Research' }).click();
  await expect(page.getByText('Research snapshot r2')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.chat-page').analyze();
  expect(accessibility.violations).toEqual([]);
});

test('opts into permission-aware RAG and opens a current-source citation without internet', async ({
  page,
}) => {
  await operational(page);
  const chatId = '12121212-1212-4121-8121-121212121212';
  const citationId = '34343434-3434-4343-8343-343434343434';
  const chat = {
    id: chatId,
    name: 'Knowledge-space answer',
    archived: false,
    provider: 'openai_oauth',
    model: 'gpt-test',
    reasoningEffort: 'low',
    contextMode: 'rolling',
    updatedAt: '2030-01-03T00:00:00.000Z',
    capabilities: { research: false, rag: true, internet: false },
    activeRun: null,
  };
  const source = {
    sourceKind: 'rag',
    attachmentRevisionId: null,
    attachmentRevision: null,
    id: citationId,
    citationLabel: 'S1',
    researchName: 'NodeRag search',
    siloId: 2,
    siloSlug: 'legal-space',
    documentId: 77,
    documentName: 'notice-register.md',
    documentTitle: 'Notice Register',
    documentFormat: 'md',
    pageOrdinal: 0,
    chunkId: 91,
    chunkIds: [91],
    locator: { pageStart: 1, pageEnd: 1, characterStart: 18 },
    confidence: 0.91,
    evidence: [{ kind: 'exact', text: 'ZX-991', confidence: 0.91 }],
    query: '',
    searchMode: 'keyword',
    originalSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    buildId: 4,
    modelManifestDigest: 'c'.repeat(64),
    capturedAt: '2030-01-03T00:01:00.000Z',
    status: 'active',
    text: 'ZX-991 requires a thirty-day termination notice.',
  };
  const chats: Record<string, unknown>[] = [];
  let createdPayload: Record<string, unknown> | null = null;
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      internetProvider: 'ollama_cloud',
      providerToolsEnabled: true,
      researchEnabled: false,
      ragEnabled: true,
      items: chats,
      createOptions: {
        ready: true,
        default: {
          provider: 'openai_oauth',
          model: 'gpt-test',
          reasoningEffort: 'low',
          contextMode: 'rolling',
        },
        models: [
          {
            provider: 'openai_oauth',
            model: 'gpt-test',
            displayName: 'GPT Test',
            reasoningEfforts: ['low'],
          },
        ],
        researchCollections: [],
      },
    }),
  );
  await page.route('**/v1/chats', (route) => {
    createdPayload = record(route.request().postDataJSON());
    chats.push(chat);
    return json(route, chat, 201);
  });
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'id: 1\nevent: response.completed\ndata: {"id":1}\n\n',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    json(route, {
      items: [
        {
          id: '56565656-5656-4565-8565-565656565656',
          sequence: 0,
          role: 'assistant',
          content: 'The notice period is thirty days [S1].',
          state: 'committed',
          reasoning_summary: null,
          createdAt: '2030-01-03T00:01:00.000Z',
          citations: [source],
        },
      ],
      nextBefore: null,
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/citations\/[^/]+\/page$/, (route) =>
    json(route, {
      citation: source,
      pageOrdinal: 0,
      pageNumber: 1,
      characterStart: 0,
      characterEnd: 74,
      markdown: '# Notice Register\n\nZX-991 requires a thirty-day termination notice.',
      untrusted: true,
    }),
  );
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => json(route, chat));

  await signIn(page);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Chat name').fill('Knowledge-space answer');
  await page.getByLabel('Allow broader knowledge-base search').check();
  await expect(
    page.getByText(/Chat internet always calls Ollama Cloud web search\/fetch/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create chat' }).click();
  await expect.poll(() => createdPayload?.['allowRag']).toBe(true);
  await expect(page.getByText('RAG on · current permissions')).toBeVisible();
  await expect(page.getByText('Internet off · Ollama Cloud only')).toBeVisible();
  const citationButton = page.getByRole('button', { name: /\[S1\] Notice Register/ });
  await expect(citationButton).toContainText('91%');
  await citationButton.click();
  await expect(page.getByRole('heading', { name: /Notice Register · Markdown/ })).toBeVisible();
  await expect(page.getByText('ZX-991 requires a thirty-day termination notice.')).toBeVisible();
  await page.getByRole('button', { name: 'Source passage' }).click();
  await expect(page.getByText('NodeRag search · legal-space · Confidence 91%')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.chat-page').analyze();
  expect(accessibility.violations).toEqual([]);
});

test('opts into Ollama Cloud web tools independently and opens a durable web citation', async ({
  page,
}) => {
  await operational(page);
  const chatId = '78787878-7878-4787-8787-787878787878';
  const citationId = '89898989-8989-4898-8989-898989898989';
  const toolCallId = '91919191-9191-4919-8919-919191919191';
  const chat = {
    id: chatId,
    name: 'Cloud-assisted research',
    archived: false,
    provider: 'openai_oauth',
    model: 'gpt-test',
    reasoningEffort: 'low',
    contextMode: 'rolling',
    updatedAt: '2030-01-04T00:00:00.000Z',
    capabilities: { research: false, rag: false, internet: true },
    activeRun: null,
  };
  const source = {
    sourceKind: 'web',
    id: citationId,
    toolCallId,
    citationLabel: 'W1',
    researchName: 'Ollama Cloud web',
    siloSlug: 'Public internet',
    documentId: 0,
    documentName: 'Official tax report',
    documentTitle: 'Official tax report',
    documentFormat: 'web',
    pageOrdinal: null,
    locator: { url: 'https://public.example.com/reports/tax' },
    confidence: null,
    evidence: [],
    query: '',
    status: 'active',
    text: 'Revenue comes from tax, fees, and grants.',
    webSourceKind: 'fetched_page',
    url: 'https://public.example.com/reports/tax',
    hostname: 'public.example.com',
    retrievedAt: '2030-01-04T00:01:00.000Z',
  };
  const chats: Record<string, unknown>[] = [];
  let createdPayload: Record<string, unknown> | null = null;
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      internetProvider: 'ollama_cloud',
      providerToolsEnabled: true,
      researchEnabled: false,
      ragEnabled: false,
      internetEnabled: true,
      items: chats,
      createOptions: {
        ready: true,
        default: {
          provider: 'openai_oauth',
          model: 'gpt-test',
          reasoningEffort: 'low',
          contextMode: 'rolling',
        },
        models: [
          {
            provider: 'openai_oauth',
            model: 'gpt-test',
            displayName: 'GPT Test',
            reasoningEfforts: ['low'],
          },
        ],
        researchCollections: [],
      },
    }),
  );
  await page.route('**/v1/chats', (route) => {
    createdPayload = record(route.request().postDataJSON());
    chats.push(chat);
    return json(route, chat, 201);
  });
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'id: 1\nevent: response.completed\ndata: {"id":1}\n\n',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    json(route, {
      items: [
        {
          id: '90909090-9090-4909-8909-909090909090',
          sequence: 0,
          role: 'assistant',
          content: 'The report identifies three public revenue sources [W1].',
          state: 'committed',
          reasoning_summary: null,
          createdAt: '2030-01-04T00:02:00.000Z',
          activities: [
            {
              id: `tool:${toolCallId}`,
              type: 'tool',
              sequence: 1,
              toolCall: {
                id: toolCallId,
                ordinal: 0,
                name: 'web.search.v1',
                arguments: { querySha256: 'a'.repeat(64), maxResults: 5 },
                status: 'completed',
                resultBytes: 2048,
                safeErrorCode: null,
                durationMs: 650,
                resultCount: 1,
                resultSummary: { kind: 'web_search', resultCount: 1 },
                startedAt: '2030-01-04T00:01:00.000Z',
                finishedAt: '2030-01-04T00:01:01.000Z',
              },
            },
          ],
          citations: [source],
        },
      ],
      nextBefore: null,
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/web-citations\/[^/]+$/, (route) =>
    json(route, { citation: source, untrusted: true }),
  );
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => json(route, chat));

  await signIn(page);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Chat name').fill('Cloud-assisted research');
  await page.getByLabel('Allow Ollama Cloud internet search').check();
  await expect(
    page.getByText(/always calls Ollama Cloud web search\/fetch—even when OpenAI writes/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create chat' }).click();
  await expect.poll(() => createdPayload?.['allowInternet']).toBe(true);
  await expect(createdPayload?.['allowRag']).toBe(false);
  await expect(page.getByText('Internet on · Ollama Cloud only')).toBeVisible();
  await expect(page.getByText('RAG off')).toBeVisible();
  const citationButton = page.getByRole('button', { name: /\[W1\] Official tax report/ });
  await expect(citationButton).not.toBeVisible();
  await page.getByText('Search the web', { exact: true }).click();
  await expect(page.getByText('Search results', { exact: true })).toBeVisible();
  await expect(citationButton).toBeVisible();
  await expect(citationButton).not.toContainText('%');
  await citationButton.click();
  await expect(page.getByRole('heading', { name: 'W1 · Official tax report' })).toBeVisible();
  await expect(page.getByText('Ollama Cloud web · Public internet')).toBeVisible();
  await expect(page.getByText(/public\.example\.com · Retrieved/)).toBeVisible();
  await expect(page.getByText('Revenue comes from tax, fees, and grants.')).toBeVisible();
  const original = page.getByRole('link', { name: 'Open original website' });
  await expect(original).toHaveAttribute('href', 'https://public.example.com/reports/tax');
  await expect(original).toHaveAttribute('target', '_blank');
  const accessibility = await new AxeBuilder({ page }).include('.chat-page').analyze();
  expect(accessibility.violations).toEqual([]);
});

test('navigates, previews, edits, compares, and deletes contained Chat artifacts', async ({
  page,
}) => {
  await operational(page);
  const chatId = 'abababab-abab-4aba-8aba-abababababab';
  const folderId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
  const artifactId = 'efefefef-efef-4efe-8efe-efefefefefef';
  const websiteFileId = '130ea00d-1856-499a-bc72-d856e6d7406f';
  const websiteFilePath = `/chat/${chatId}/file/${websiteFileId}.png`;
  const initialMarkdown = `# Case summary\n\nInitial finding.\n\n![Chat diagram](${websiteFilePath})\n\n![Remote](https://images.example/test.png)\n\n<script>window.chatArtifactXss = true</script>\n\n[Unsafe](javascript:alert(1))`;
  let markdown = initialMarkdown;
  let currentRevision = 1;
  let currentSha = 'a'.repeat(64);
  let deleted = false;
  let patchBody: Record<string, unknown> | null = null;
  let ingestionBody: Record<string, unknown> | null = null;
  const exportId = '56565656-7878-4901-8234-565656565656';
  let artifactExports: Record<string, unknown>[] = [];
  const chat = {
    id: chatId,
    name: 'Artifact workspace',
    archived: false,
    provider: 'ollama_cloud',
    model: 'minimax-m3:cloud',
    reasoningEffort: 'default',
    contextMode: 'rolling',
    updatedAt: '2030-01-05T00:00:00.000Z',
    capabilities: { research: false, rag: false, internet: false },
    activeRun: null,
  };
  const file = () => ({
    id: artifactId,
    path: 'summary.md',
    name: 'summary.md',
    kind: 'file',
    mimeType: 'text/markdown',
    state: 'active',
    revision: currentRevision,
    sha256: currentSha,
    bytes: markdown.length,
    createdAt: '2030-01-05T00:00:00.000Z',
    updatedAt: '2030-01-05T00:00:00.000Z',
  });
  await page.route('**/v1/chats?*', (route) =>
    json(route, {
      contract: 'chat-core.v1',
      artifactsEnabled: true,
      exportsEnabled: true,
      researchEnabled: false,
      ragEnabled: false,
      internetEnabled: false,
      items: [chat],
      createOptions: {
        ready: true,
        default: {
          provider: 'ollama_cloud',
          model: 'minimax-m3:cloud',
          reasoningEffort: 'default',
          contextMode: 'rolling',
        },
        models: [
          {
            provider: 'ollama_cloud',
            model: 'minimax-m3:cloud',
            displayName: 'MiniMax M3 Cloud',
            reasoningEfforts: ['default'],
          },
        ],
      },
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/events(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    json(route, { items: [], nextBefore: null }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/files$/, (route) =>
    json(route, {
      items: [
        {
          id: websiteFileId,
          chatId,
          originalFilename: 'diagram.png',
          extension: 'png',
          mimeType: 'image/png',
          sha256: 'd'.repeat(64),
          bytes: 68,
          state: 'active',
          createdAt: '2030-01-05T00:00:00.000Z',
          websitePath: websiteFilePath,
        },
      ],
    }),
  );
  await page.route(new RegExp(`/chat/${chatId}/file/${websiteFileId}\\.png$`, 'u'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.route(/\/v1\/chats\/[^/?]+$/, (route) => json(route, chat));
  await page.route(/\/v1\/chats\/[^/]+\/exports$/, (route) =>
    json(route, { items: artifactExports }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/exports$/, (route) => {
    artifactExports = [
      {
        id: exportId,
        chatId,
        artifactId,
        sourceRevision: currentRevision,
        sourceSha256: currentSha,
        format: 'pdf',
        state: 'succeeded',
        phase: 'complete',
        progressPercent: 100,
        attempts: 1,
        maximumAttempts: 2,
        filename: `summary-r${String(currentRevision)}.pdf`,
        mimeType: 'application/pdf',
        outputSha256: 'c'.repeat(64),
        outputBytes: 2048,
        warnings: [],
        errorCode: null,
        errorDetail: null,
        canCancel: false,
        createdAt: '2030-01-05T00:03:00.000Z',
        updatedAt: '2030-01-05T00:03:01.000Z',
      },
    ];
    return json(route, artifactExports[0], 202);
  });
  await page.route(/\/v1\/chats\/[^/]+\/exports\/[^/]+\/download(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'inline; filename="summary-r1.pdf"' },
      body: '%PDF-1.7\n%%EOF',
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/ingestions$/, (route) => {
    ingestionBody = record(route.request().postDataJSON());
    return json(route, { documentId: 91, jobId: 92, promotionId: 'promotion-test' }, 202);
  });
  await page.route(/\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/history$/, (route) =>
    json(route, {
      items: [
        ...(currentRevision === 1
          ? []
          : [
              {
                id: '12121212-3434-4567-8899-121212121212',
                revision: 2,
                sha256: currentSha,
                bytes: markdown.length,
                createdByKind: 'user',
                sourceCitations: [],
                createdAt: '2030-01-05T00:02:00.000Z',
              },
            ]),
        {
          id: '34343434-5656-4789-8012-343434343434',
          revision: 1,
          sha256: 'a'.repeat(64),
          bytes: 78,
          createdByKind: 'model',
          sourceCitations: ['R1'],
          createdAt: '2030-01-05T00:01:00.000Z',
        },
      ],
    }),
  );
  await page.route(/\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/content(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'PATCH') {
      patchBody = record(route.request().postDataJSON());
      markdown = '# Case summary\n\nUpdated finding.\n\n![Remote](https://images.example/test.png)';
      currentRevision = 2;
      currentSha = 'b'.repeat(64);
      return json(route, { artifact: file(), content: markdown });
    }
    const requestedRevision = new URL(route.request().url()).searchParams.get('revision');
    const content = requestedRevision === '1' ? initialMarkdown : markdown;
    return json(route, {
      artifact: file(),
      revision: { revision: requestedRevision === '1' ? 1 : currentRevision },
      content,
      offset: 0,
      nextOffset: null,
      totalCharacters: content.length,
      truncated: false,
      untrusted: true,
    });
  });
  await page.route(/\/v1\/chats\/[^/]+\/artifacts\/[^/]+$/, (route) => {
    if (route.request().method() === 'DELETE') {
      deleted = true;
      return json(route, { artifact: { ...file(), state: 'deleted' } });
    }
    return route.fallback();
  });
  await page.route(/\/v1\/chats\/[^/]+\/artifacts(?:\?.*)?$/, (route) => {
    const directory = new URL(route.request().url()).searchParams.get('directory') ?? '';
    return json(route, {
      directory,
      items:
        directory === ''
          ? [
              {
                id: folderId,
                path: 'reports',
                name: 'reports',
                kind: 'directory',
                revision: 0,
                sha256: null,
                bytes: 0,
                updatedAt: '2030-01-05T00:00:00.000Z',
              },
              ...(deleted ? [] : [file()]),
            ]
          : [],
      quota: {
        usedBytes: deleted ? 0 : markdown.length,
        quotaBytes: 268435456,
        availableBytes: 268435456 - markdown.length,
        maximumFileBytes: 10485760,
        fileCount: deleted ? 0 : 1,
        externalImages: false,
      },
    });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Artifacts' }).click();
  await expect(page.getByRole('heading', { name: 'Chat artifacts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chat files' })).toBeVisible();
  await expect(page.getByText('diagram.png')).toBeVisible();
  await expect(page.locator('.chat-managed-file-row code')).toContainText(websiteFileId);
  await expect(page.getByRole('button', { name: 'Copy URL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Markdown' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    new RegExp(`/chat/${chatId}/file/${websiteFileId}\\.png$`, 'u'),
  );
  await expect(page.getByText(/MiB used/)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: /reports/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'reports', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Artifact folder' })
    .getByRole('button', { name: 'Artifacts', exact: true })
    .click();
  await page.getByRole('button', { name: /summary\.md/ }).click();
  await expect(page.getByText('Initial finding.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Chat diagram' })).toHaveAttribute(
    'src',
    websiteFilePath,
  );
  await expect(page.locator('.chat-artifact-modal script')).toHaveCount(0);
  expect(await page.evaluate(() => 'chatArtifactXss' in window)).toBe(false);
  await expect(page.locator('.chat-artifact-modal a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText('External image not loaded automatically')).toBeVisible();
  await expect(page.getByRole('button', { name: /Load external images/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'DOCX and PDF exports' })).toBeVisible();
  await page.getByRole('button', { name: 'Export PDF' }).click();
  await expect(page.getByText('PDF export queued for revision 1.')).toBeVisible();
  await expect(page.getByText('PDF · revision 1')).toBeVisible();
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  await expect(page.getByTitle('Generated PDF preview')).toBeVisible();
  await page.getByLabel('Snapshot format').selectOption(exportId);
  await page.getByRole('button', { name: 'Upload exact revision' }).click();
  await expect
    .poll(() => ingestionBody)
    .toMatchObject({
      siloId: 1,
      revision: 1,
      sourceFormat: 'pdf',
      exportId,
      expectedSha256: 'c'.repeat(64),
    });
  await expect(page.getByText(/queued as document 91/)).toBeVisible();
  await page
    .getByLabel('Edit Markdown')
    .fill('# Case summary\n\nUpdated finding.\n\n![Remote](https://images.example/test.png)');
  await page.getByRole('button', { name: 'Save new revision' }).click();
  await expect.poll(() => patchBody?.['expectedSha256']).toBe('a'.repeat(64));
  await expect(page.getByText('Saved revision 2.')).toBeVisible();
  await page.getByText(/Revision history/).click();
  await page.locator('button:not([disabled])', { hasText: 'Compare with current' }).click();
  await expect(
    page.getByRole('heading', { name: 'Revision 1 compared with current' }),
  ).toBeVisible();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => deleted).toBe(true);
  await expect(page.getByText('Artifact deleted.')).toBeVisible();
});
