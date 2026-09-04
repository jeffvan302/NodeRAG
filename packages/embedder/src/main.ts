import {
  createDeterministicRuntime,
  createOnnxRuntime,
  defaultModelManifestDigest,
} from './runtime.js';
import { startEmbedderServer } from './server.js';

const main = async (): Promise<void> => {
  const socketPath = process.env['NODERAG_EMBEDDER_SOCKET'];
  if (socketPath === undefined) throw new Error('NODERAG_EMBEDDER_SOCKET is required.');
  const runtime =
    process.env['NODERAG_TEST_EMBEDDER'] === '1'
      ? createDeterministicRuntime()
      : await createOnnxRuntime({
          modelRoot: process.env['NODERAG_MODEL_ROOT'] ?? '',
          modelPath: process.env['NODERAG_MODEL_PATH'] ?? '',
          dimensions: 1024,
          threads: Number(process.env['NODERAG_EMBED_THREADS'] ?? '4'),
          manifestDigest:
            process.env['NODERAG_MODEL_MANIFEST_DIGEST'] ?? defaultModelManifestDigest,
        });
  const server = await startEmbedderServer(socketPath, runtime);
  const stop = (): void => {
    void server.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
