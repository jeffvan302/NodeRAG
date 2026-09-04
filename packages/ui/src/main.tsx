import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  displayError,
  forgetSession,
  type JsonRecord,
  type Principal,
  type SetupStatus,
  type Silo,
} from './api.js';
import { Notice, Spinner, StatusPill } from './components.js';
import { FirstRun, Login, SetupWizard } from './setup.js';
import { Workspace } from './workspace.js';
import './styles.css';

type BootState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'maintenance'; readonly status: SetupStatus; readonly ready: JsonRecord }
  | { readonly kind: 'setup'; readonly status: SetupStatus }
  | { readonly kind: 'login'; readonly status: SetupStatus }
  | {
      readonly kind: 'first-run';
      readonly status: SetupStatus;
      readonly principal: Principal;
      readonly silos: readonly Silo[];
    }
  | { readonly kind: 'workspace'; readonly principal: Principal; readonly silos: readonly Silo[] };

const Loading = () => (
  <main class="boot-screen">
    <a class="brand" href="/">
      <span>N</span>NodeRag
    </a>
    <div>
      <Spinner />
      <p>Opening your private library…</p>
    </div>
  </main>
);

const App = () => {
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });
  const load = useCallback(async () => {
    setBoot({ kind: 'loading' });
    try {
      const [status, ready] = await Promise.all([
        api<SetupStatus>('/v1/setup/status'),
        api<JsonRecord>('/ready').catch((error) => ({
          status: 'unavailable',
          reason: displayError(error),
        })),
      ]);
      if (status.state === 'unconfigured' || status.state === 'initializing') {
        setBoot({ kind: 'setup', status });
        return;
      }
      if (['upgrade_required', 'database_ahead', 'unavailable'].includes(status.state)) {
        setBoot({ kind: 'maintenance', status, ready });
        return;
      }
      let principal: Principal;
      try {
        principal = await api<Principal>('/v1/auth/me');
      } catch {
        forgetSession();
        setBoot({ kind: 'login', status });
        return;
      }
      const siloResponse = await api<{ readonly items: readonly Silo[] }>('/v1/silos');
      if (status.progress < 100 && principal.serverAdmin)
        setBoot({ kind: 'first-run', status, principal, silos: siloResponse.items });
      else setBoot({ kind: 'workspace', principal, silos: siloResponse.items });
    } catch (error) {
      setBoot({ kind: 'error', message: displayError(error) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (boot.kind !== 'setup' && boot.kind !== 'first-run') return;
    const source = new EventSource('/v1/setup/events');
    const update = (event: MessageEvent<string>) => {
      try {
        const status = JSON.parse(event.data) as SetupStatus;
        setBoot((current) => {
          if (current.kind === 'setup') return { ...current, status };
          if (current.kind === 'first-run') return { ...current, status };
          return current;
        });
      } catch {
        // Ignore malformed progress frames; the next status snapshot is authoritative.
      }
    };
    source.addEventListener('setup-status', update as EventListener);
    return () => source.close();
  }, [boot.kind]);
  if (boot.kind === 'loading') return <Loading />;
  if (boot.kind === 'error')
    return (
      <main class="state-screen">
        <a class="brand" href="/">
          <span>N</span>NodeRag
        </a>
        <section>
          <p class="eyebrow">Connection problem</p>
          <h1>NodeRag did not answer.</h1>
          <Notice kind="danger">{boot.message}</Notice>
          <button class="primary" onClick={() => void load()}>
            Try again
          </button>
        </section>
      </main>
    );
  if (boot.kind === 'maintenance')
    return (
      <main class="state-screen">
        <a class="brand" href="/">
          <span>N</span>NodeRag
        </a>
        <section>
          <StatusPill value={boot.status.state} />
          <h1>NodeRag needs attention.</h1>
          <p>
            The service is protecting your data while its database or runtime is brought back to a
            compatible state.
          </p>
          <pre class="json-summary">{JSON.stringify(boot.ready, null, 2)}</pre>
          <button class="primary" onClick={() => void load()}>
            Check again
          </button>
        </section>
      </main>
    );
  if (boot.kind === 'setup')
    return <SetupWizard status={boot.status} complete={() => void load()} />;
  if (boot.kind === 'login') return <Login complete={() => void load()} />;
  if (boot.kind === 'first-run')
    return (
      <FirstRun
        status={boot.status}
        silos={boot.silos}
        done={() => setBoot({ kind: 'workspace', principal: boot.principal, silos: boot.silos })}
      />
    );
  return <Workspace principal={boot.principal} silos={boot.silos} logout={() => void load()} />;
};

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app mount point.');
render(<App />, root);
