import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { HealthResponse } from '@noderag/shared';
import './styles.css';

const App = () => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void fetch('/health')
      .then(async (response) => {
        if (!response.ok) throw new Error('health request failed');
        setHealth((await response.json()) as HealthResponse);
      })
      .catch(() => setError(true));
  }, []);

  return (
    <main class="shell">
      <p class="eyebrow">Local knowledge, clear boundaries</p>
      <h1>NodeRag</h1>
      <p class="lede">The repository foundation is ready for the first vertical slice.</p>
      <section aria-live="polite" class="status-card">
        <span class={`dot ${health === null ? 'pending' : 'ready'}`} />
        {health !== null
          ? `API ${health.status} · version ${health.version}`
          : error
            ? 'API health is unavailable'
            : 'Checking API health…'}
      </section>
    </main>
  );
};

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app mount point.');
render(<App />, root);
