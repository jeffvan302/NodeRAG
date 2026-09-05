import { useEffect, useState } from 'preact/hooks';
import {
  displayError,
  formatBytes,
  postJson,
  signIn,
  type JsonRecord,
  type SetupStatus,
  type Silo,
} from './api.js';
import { Field, Icon, Notice, Spinner } from './components.js';

const steps = [
  'Verify',
  'Administrator',
  'Sign in',
  'Storage',
  'Model',
  'Calibration',
  'Vision',
  'Sources',
];

const StepRail = ({ active }: { readonly active: number }) => (
  <ol class="setup-rail" aria-label="Setup progress">
    {steps.map((label, index) => (
      <li
        class={index < active ? 'done' : index === active ? 'active' : ''}
        key={label}
        aria-current={index === active ? 'step' : undefined}
      >
        <span>{index < active ? <Icon name="check" /> : index + 1}</span>
        <b>{label}</b>
      </li>
    ))}
  </ol>
);

export const SetupWizard = ({
  status,
  complete,
}: {
  readonly status: SetupStatus;
  readonly complete: () => void;
}) => {
  const [stage, setStage] = useState(0);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const verify = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ readonly valid: boolean }>('/v1/setup/verify-token', {
        setupToken: token,
      });
      if (!result.valid) throw new Error('That setup key is invalid or has expired.');
      setStage(1);
    } catch (problem) {
      setError(displayError(problem));
    } finally {
      setBusy(false);
    }
  };

  const configure = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirmPassword') ?? '')) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ readonly recoveryCode: string }>('/v1/setup/configure', {
        setupToken: token,
        username: String(form.get('username') ?? ''),
        email: String(form.get('email') ?? '') || undefined,
        password,
        defaultSiloName: String(form.get('silo') ?? '') || 'My knowledge',
      });
      setRecoveryCode(result.recoveryCode);
      setStage(2);
    } catch (problem) {
      setError(displayError(problem));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCode = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <main class="setup-shell">
      <aside class="setup-aside">
        <a class="brand" href="/" aria-label="NodeRag home">
          <span>N</span>NodeRag
        </a>
        <div>
          <p class="eyebrow">Private by design</p>
          <h1>Make your knowledge searchable.</h1>
          <p>NodeRag stays on your machine and respects the boundaries you set.</p>
        </div>
        <StepRail active={stage} />
        <small>Setup progress is saved by the server. You can safely return to this page.</small>
      </aside>
      <section class="setup-panel" aria-live="polite">
        <div class="setup-card">
          {stage === 0 ? (
            <>
              <p class="step-count">Step 1 of 8</p>
              <h2>Confirm this installation</h2>
              <p class="muted">
                Enter the one-time setup key from the installation log or protected setup-key file.
              </p>
              {!status.tokenIssued ? (
                <Notice kind="warning">
                  The setup key is missing or expired. Restart NodeRag to issue a new key.
                </Notice>
              ) : null}
              <form onSubmit={verify}>
                <Field
                  label="Setup key"
                  {...(status.tokenExpiresAt === null
                    ? {}
                    : { hint: `Expires ${new Date(status.tokenExpiresAt).toLocaleString()}` })}
                >
                  <input
                    name="token"
                    autoComplete="off"
                    spellcheck={false}
                    value={token}
                    onInput={(event) => setToken(event.currentTarget.value)}
                    required
                  />
                </Field>
                {error === '' ? null : <Notice kind="danger">{error}</Notice>}
                <button
                  class="primary wide-button"
                  disabled={busy || token.length < 16}
                  type="submit"
                >
                  {busy ? <Spinner /> : null}Verify and continue
                </button>
              </form>
            </>
          ) : stage === 1 ? (
            <>
              <p class="step-count">Step 2 of 8</p>
              <h2>Create the administrator</h2>
              <p class="muted">
                This account can manage users, storage, sources, and system settings.
              </p>
              <form onSubmit={configure}>
                <div class="field-grid">
                  <Field label="Username">
                    <input
                      name="username"
                      autoComplete="username"
                      pattern="[A-Za-z0-9._-]{3,64}"
                      required
                    />
                  </Field>
                  <Field label="Email (optional)">
                    <input name="email" autoComplete="email" type="email" />
                  </Field>
                </div>
                <Field label="Default knowledge space">
                  <input name="silo" defaultValue="My knowledge" required />
                </Field>
                <Field label="Password" hint="Use at least 12 characters.">
                  <input
                    name="password"
                    autoComplete="new-password"
                    minLength={12}
                    type="password"
                    required
                  />
                </Field>
                <Field label="Confirm password">
                  <input
                    name="confirmPassword"
                    autoComplete="new-password"
                    minLength={12}
                    type="password"
                    required
                  />
                </Field>
                {error === '' ? null : <Notice kind="danger">{error}</Notice>}
                <button class="primary wide-button" disabled={busy} type="submit">
                  {busy ? <Spinner /> : null}Create administrator
                </button>
              </form>
            </>
          ) : (
            <>
              <p class="step-count">Recovery access</p>
              <h2>Save your recovery code</h2>
              <p class="muted">
                This code is shown once. Keep it in your password manager or another protected
                place.
              </p>
              <div class="recovery-code-tools">
                <label for="recovery-code-value">Complete recovery code</label>
                <button class="secondary" type="button" onClick={() => void copyRecoveryCode()}>
                  <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} />
                  {copyStatus === 'copied' ? 'Copied full code' : 'Copy full recovery code'}
                </button>
              </div>
              <div class="recovery-code-boundaries" aria-hidden="true">
                <span>Start of code ↓</span>
                <span>↓ End of code</span>
              </div>
              <textarea
                id="recovery-code-value"
                class="recovery-code"
                dir="ltr"
                readOnly
                rows={3}
                spellcheck={false}
                value={recoveryCode}
                onFocus={(event) => event.currentTarget.select()}
                aria-describedby="recovery-code-hint"
              />
              <p id="recovery-code-hint" class="recovery-code-hint">
                Copy every character in the field. It contains only the code—no quotation marks or
                surrounding spaces. Selecting the field selects the complete value.
              </p>
              {copyStatus === 'copied' ? (
                <Notice kind="success">The full recovery code is on your clipboard.</Notice>
              ) : copyStatus === 'failed' ? (
                <Notice kind="danger">
                  Clipboard access failed. Select the recovery-code field and press Ctrl+C.
                </Notice>
              ) : null}
              <Notice kind="warning">
                Anyone with this code may be able to recover administrator access. Do not store it
                with the NodeRag data folder.
              </Notice>
              <button class="primary wide-button" type="button" onClick={complete}>
                I saved it — continue to sign in
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
};

export const Login = ({ complete }: { readonly complete: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setBusy(true);
    setError('');
    try {
      await signIn(String(form.get('username') ?? ''), String(form.get('password') ?? ''));
      complete();
    } catch (problem) {
      setError(displayError(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="login-shell">
      <section class="login-story">
        <a class="brand" href="/">
          <span>N</span>NodeRag
        </a>
        <div>
          <p class="eyebrow">Your private library</p>
          <h1>Find the passage, not just the file.</h1>
          <p>Search across documents with traceable sources and exact context.</p>
        </div>
        <p class="privacy-note">Local service · No cloud account required</p>
      </section>
      <section class="login-panel">
        <form class="login-card" onSubmit={submit}>
          <p class="step-count">Welcome back</p>
          <h2>Sign in to NodeRag</h2>
          <Field label="Username">
            <input name="username" autoComplete="username" required autoFocus />
          </Field>
          <Field label="Password">
            <input name="password" autoComplete="current-password" type="password" required />
          </Field>
          {error === '' ? null : <Notice kind="danger">{error}</Notice>}
          <button class="primary wide-button" disabled={busy} type="submit">
            {busy ? <Spinner /> : null}Sign in
          </button>
        </form>
      </section>
    </main>
  );
};

const saveProgress = (step: string, progress: number) =>
  postJson('/v1/admin/setup/progress', { step, progress }, { method: 'PUT', idempotent: true });

export const FirstRun = ({
  status,
  silos,
  done,
}: {
  readonly status: SetupStatus;
  readonly silos: readonly Silo[];
  readonly done: () => void;
}) => {
  const initial = Math.max(
    3,
    steps.indexOf(status.step.charAt(0).toUpperCase() + status.step.slice(1)),
  );
  const [stage, setStage] = useState(initial < 3 ? 3 : initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<JsonRecord | null>(null);
  const [modelCheck, setModelCheck] = useState<JsonRecord | null>(null);

  useEffect(() => {
    const recovered = steps.indexOf(status.step.charAt(0).toUpperCase() + status.step.slice(1));
    if (recovered >= 3) setStage(recovered);
  }, [status.step]);

  const advance = async (next: number) => {
    const map: Record<number, [string, number]> = {
      4: ['model', 45],
      5: ['calibration', 55],
      6: ['vision', 70],
      7: ['sources', 85],
      8: ['complete', 100],
    };
    const value = map[next];
    if (value !== undefined) await saveProgress(value[0], value[1]);
    if (next === 8) done();
    else {
      setResult(null);
      setError('');
      setStage(next);
    }
  };

  const run = async (work: () => Promise<JsonRecord>, next?: number) => {
    setBusy(true);
    setError('');
    try {
      const value = await work();
      setResult(value);
      if (next !== undefined) await advance(next);
    } catch (problem) {
      setError(displayError(problem));
    } finally {
      setBusy(false);
    }
  };

  const storage = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const managedPath = String(form.get('path') ?? '');
    await run(async () => {
      const probe = await postJson<JsonRecord>('/v1/admin/storage/probe', { managedPath });
      await postJson(
        '/v1/admin/storage',
        { name: 'Primary documents', managedPath, purpose: 'documents', enabled: true },
        { idempotent: true },
      );
      return probe;
    }, 4);
  };

  const verifyModel = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const file = form.get('modelFile');
    const expected = String(form.get('expectedSha256') ?? '').toLowerCase();
    if (!(file instanceof File)) return;
    setBusy(true);
    setError('');
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const actual = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      setModelCheck({
        name: file.name,
        bytes: file.size,
        sha256: actual,
        matches: actual === expected,
      });
    } catch (problem) {
      setError(displayError(problem));
    } finally {
      setBusy(false);
    }
  };

  const vision = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    await run(() =>
      postJson<JsonRecord>(
        '/v1/admin/vision/test',
        {
          baseUrl: String(form.get('baseUrl')),
          model: String(form.get('model')),
          maximumParallel: 2,
          timeoutMs: 120000,
          maximumAttempts: 3,
          maximumImageDimension: 2048,
        },
        { idempotent: true },
      ),
    );
  };

  const source = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    await run(() =>
      postJson<JsonRecord>(
        '/v1/sources',
        {
          siloId: Number(form.get('siloId')),
          uri: String(form.get('uri')),
          includeGlobs: ['**/*.md', '**/*.pdf', '**/*.docx', '**/*.xlsx', '**/*.txt'],
          excludeGlobs: ['**/.git/**', '**/~$*'],
          scheduleIntervalMinutes: null,
        },
        { idempotent: true },
      ),
    );
  };

  return (
    <main class="first-run-shell">
      <header>
        <a class="brand" href="/">
          <span>N</span>NodeRag
        </a>
        <div>
          <b>First-run checklist</b>
          <small>{Math.round((stage / 8) * 100)}% complete</small>
        </div>
      </header>
      <StepRail active={stage} />
      <section class="first-run-card" aria-live="polite">
        {stage === 3 ? (
          <>
            <p class="step-count">Step 4 of 8</p>
            <h1>Choose document storage</h1>
            <p class="muted">
              Use a persistent folder. For the Docker testbed, the recommended mounted path is shown
              below.
            </p>
            <form onSubmit={storage}>
              <Field
                label="Managed storage path"
                hint="NodeRag will create the folder if needed and run a write test."
              >
                <input name="path" defaultValue="/var/lib/noderag/documents" required />
              </Field>
              {error ? <Notice kind="danger">{error}</Notice> : null}
              <button class="primary" disabled={busy}>
                {busy ? <Spinner /> : null}Test and save storage
              </button>
            </form>
          </>
        ) : null}
        {stage === 4 ? (
          <>
            <p class="step-count">Step 5 of 8</p>
            <h1>Embedding model</h1>
            <p class="muted">
              The included, checksum-pinned Qwen3 embedding model is the tested default. The
              production installer adds resumable online download and server-side air-gapped import
              in Milestone 10.
            </p>
            <div class="choice-card selected">
              <span class="radio-mark" />
              <div>
                <b>Use the included model</b>
                <small>Qwen3-Embedding-0.6B · 1024 dimensions · local CPU</small>
              </div>
              <span class="recommended">Recommended</span>
            </div>
            <button class="primary" onClick={() => void advance(5)}>
              Use included model
            </button>
            <details class="advanced-setup">
              <summary>Verify an air-gapped model file</summary>
              <p>
                On an offline system, transfer the model on trusted media. This preflight hashes it
                entirely in your browser; the file is not sent anywhere.
              </p>
              <form onSubmit={verifyModel}>
                <Field label="Model file">
                  <input name="modelFile" type="file" required />
                </Field>
                <Field label="Expected SHA-256">
                  <input
                    name="expectedSha256"
                    pattern="[a-fA-F0-9]{64}"
                    defaultValue="a7eda29cc374b01ae75eb1af1ab65c3c61a64c43f39f16e08c6e37c075dcbf4d"
                    required
                  />
                </Field>
                <button class="secondary" disabled={busy}>
                  {busy ? <Spinner /> : null}Verify checksum
                </button>
              </form>
              {modelCheck === null ? null : modelCheck['matches'] === true ? (
                <Notice kind="success">
                  Checksum matches for {String(modelCheck['name'])} (
                  {formatBytes(modelCheck['bytes'])}).
                </Notice>
              ) : (
                <Notice kind="danger">Checksum mismatch. Do not import or rename this file.</Notice>
              )}
            </details>
          </>
        ) : null}
        {stage === 5 ? (
          <>
            <p class="step-count">Step 6 of 8</p>
            <h1>Measure this machine</h1>
            <p class="muted">
              NodeRag will embed 20 representative chunks, then estimate indexing time. No document
              content is retained.
            </p>
            {result === null ? null : (
              <Notice kind="success">
                <b>{String(result['charactersPerSecond'])} characters/second</b>
                <br />
                About {String(result['projectedMinutesPerMillionCharacters'])} minutes per million
                characters.
              </Notice>
            )}
            {error ? <Notice kind="danger">{error}</Notice> : null}
            <div class="button-row">
              <button
                class="primary"
                disabled={busy}
                onClick={() =>
                  void run(() => postJson<JsonRecord>('/v1/admin/calibration/embedding', {}))
                }
              >
                {busy ? <Spinner /> : null}Run calibration
              </button>
              {result === null ? null : (
                <button class="secondary" onClick={() => void advance(6)}>
                  Continue
                </button>
              )}
            </div>
          </>
        ) : null}
        {stage === 6 ? (
          <>
            <p class="step-count">Step 7 of 8</p>
            <h1>Connect optional image understanding</h1>
            <p class="muted">
              If Ollama is available, test it with a sample image. You can skip this and configure
              it later.
            </p>
            <form onSubmit={vision}>
              <Field label="Ollama address">
                <input
                  name="baseUrl"
                  type="url"
                  defaultValue="http://host.docker.internal:11434"
                  required
                />
              </Field>
              <Field label="Vision model">
                <input name="model" defaultValue="qwen2.5vl:7b" required />
              </Field>
              {result ? (
                <Notice kind="success">
                  Connection succeeded in {String(result['elapsedMs'])} ms.
                </Notice>
              ) : null}
              {error ? <Notice kind="danger">{error}</Notice> : null}
              <div class="button-row">
                <button class="primary" disabled={busy}>
                  {busy ? <Spinner /> : null}Test connection
                </button>
                <button class="secondary" type="button" onClick={() => void advance(7)}>
                  {result ? 'Continue' : 'Skip for now'}
                </button>
              </div>
            </form>
          </>
        ) : null}
        {stage === 7 ? (
          <>
            <p class="step-count">Step 8 of 8</p>
            <h1>Add a source folder</h1>
            <p class="muted">Only paths explicitly shared with the NodeRag package are accepted.</p>
            <form onSubmit={source}>
              <Field label="Knowledge space">
                <select name="siloId">
                  {silos.map((silo) => (
                    <option value={silo.id}>{silo.displayName}</option>
                  ))}
                </select>
              </Field>
              <Field label="Source folder">
                <input name="uri" defaultValue="/data/source" required />
              </Field>
              {result ? (
                <Notice kind="success">
                  Source mapping saved. You can start its first crawl from Ingest.
                </Notice>
              ) : null}
              {error ? <Notice kind="danger">{error}</Notice> : null}
              <div class="button-row">
                {result === null ? (
                  <button class="primary" disabled={busy}>
                    {busy ? <Spinner /> : null}Verify and add source
                  </button>
                ) : (
                  <button class="primary" type="button" onClick={() => void advance(8)}>
                    Open NodeRag
                  </button>
                )}
                <button class="secondary" type="button" onClick={() => void advance(8)}>
                  Skip for now
                </button>
              </div>
            </form>
          </>
        ) : null}
      </section>
      {stage === 3 && result !== null ? (
        <footer>{formatBytes(result['availableBytes'])} available</footer>
      ) : null}
    </main>
  );
};
