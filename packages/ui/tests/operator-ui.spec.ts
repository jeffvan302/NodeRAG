import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const operational = async (page: Page) => {
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
      ? json(route, { principalId: 1, username: 'admin', serverAdmin: true, searchOnly: false })
      : json(route, { status: 401, code: 'authentication_required' }, 401),
  );
  await page.route('**/v1/auth/login', (route) => {
    signedIn = true;
    return json(route, {
      principalId: 1,
      serverAdmin: true,
      csrfToken: 'test-csrf',
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });
  await page.route('**/v1/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
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

test('signs in, searches all modes, and opens source context', async ({ page }) => {
  await operational(page);
  await page.route('**/v1/search', (route) =>
    json(route, {
      mode: 'hybrid',
      elapsedMs: 18,
      nextCursor: null,
      items: [
        {
          chunkId: 41,
          documentId: 7,
          siloId: 1,
          score: 0.91,
          text: 'Keep every recovery code in a protected password manager.',
          headingPath: ['Security', 'Recovery'],
          locator: { pageStart: 2 },
          document: {
            name: 'handbook.pdf',
            title: 'Security handbook',
            format: 'pdf',
            path: 'policies/handbook.pdf',
          },
        },
      ],
    }),
  );
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
  await signIn(page);
  await page.getByRole('button', { name: 'Both' }).click();
  await page.getByLabel('Search your knowledge').fill('recovery code');
  await page.locator('#main-content').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Security handbook' })).toBeVisible();
  await page.getByText('Keep every recovery code').click();
  await expect(page.getByRole('dialog', { name: 'Source passage' })).toContainText(
    'Previous context',
  );
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
  await page.getByRole('button', { name: 'Documents' }).click();
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

test('uploads, exposes durable job controls, and lists capability grants', async ({ page }) => {
  await operational(page);
  await page.route('**/v1/sources', (route) => json(route, { items: [] }));
  await page.route('**/v1/jobs', (route) =>
    json(route, {
      items: [
        {
          id: 22,
          siloId: 1,
          kind: 'document_ingest',
          state: 'running',
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
  await page.route('**/v1/admin/silos', (route) =>
    json(route, { items: [{ id: 1, slug: 'default', displayName: 'My knowledge' }] }),
  );
  await page.route('**/v1/admin/grants', (route) =>
    json(route, { items: [{ principalId: 2, siloId: 1, capability: 'read' }] }),
  );
  await page.route('**/v1/admin/grants/2/1/upload', (route) => json(route, { enabled: true }));
  await signIn(page);
  await page.getByRole('button', { name: 'Ingest' }).click();
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
