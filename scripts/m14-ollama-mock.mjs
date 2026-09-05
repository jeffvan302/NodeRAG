import { createServer } from 'node:http';

const port = Number(process.env.NODERAG_M14_OLLAMA_PORT ?? '11434');
const model = 'noderag-soak-vision:latest';
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/tags') {
    response.end(JSON.stringify({ models: [{ name: model, digest: 'sha256:m14-soak' }] }));
    return;
  }
  if (request.url === '/api/chat' && request.method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part) => {
      body += part;
    });
    request.on('end', () => {
      JSON.parse(body);
      response.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              kind: 'table',
              markdown: '| Component | State |\n| --- | --- |\n| M14 | healthy |',
              alt: 'A two-column release-candidate health table.',
              confidence: 0.99,
            }),
          },
        }),
      );
    });
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not-found' }));
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`M14 Ollama fixture listening on ${String(port)}.\n`);
});
