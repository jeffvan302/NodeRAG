const once = process.argv.includes('--once');
console.info(JSON.stringify({ service: 'noderag-worker', event: 'started', once }));
if (!once) {
  const timer = setInterval(() => {
    console.info(JSON.stringify({ service: 'noderag-worker', event: 'heartbeat' }));
  }, 60_000);
  const stop = (): void => {
    clearInterval(timer);
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
