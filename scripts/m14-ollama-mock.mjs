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
      const parsed = JSON.parse(body);
      const imageCount = parsed.messages?.[0]?.images?.length ?? 0;
      const visionResult = (imageIndex) => ({
        ...(imageIndex === null ? {} : { imageIndex }),
        kind: 'table',
        markdown: '| Component | State |\n| --- | --- |\n| M14 | healthy |',
        alt: 'A two-column release-candidate health table.',
        confidence: 0.99,
      });
      const content =
        imageCount > 1
          ? { results: Array.from({ length: imageCount }, (_, index) => visionResult(index + 1)) }
          : visionResult(null);
      response.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: JSON.stringify(content),
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
