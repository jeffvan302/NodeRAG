import {
  createDeterministicRuntime,
  createManagedOnnxRuntime,
  defaultModelManifestDigest,
} from './runtime.js';
import { startEmbedderServer } from './server.js';
import { availableParallelism } from 'node:os';

const main = async (): Promise<void> => {
  const socketPath = process.env['NODERAG_EMBEDDER_SOCKET'];
  if (socketPath === undefined) throw new Error('NODERAG_EMBEDDER_SOCKET is required.');
  const runtime =
    process.env['NODERAG_TEST_EMBEDDER'] === '1'
      ? createDeterministicRuntime()
      : createManagedOnnxRuntime({
          modelRoot: process.env['NODERAG_MODEL_ROOT'] ?? '',
          modelPath: process.env['NODERAG_MODEL_PATH'] ?? '',
          dimensions: 1024,
          threads: Math.min(
            Math.max(1, availableParallelism()),
            Number(process.env['NODERAG_EMBED_THREADS'] ?? '4'),
          ),
          availableProcessors: availableParallelism(),
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
