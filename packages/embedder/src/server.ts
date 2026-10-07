import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  embedderRequestSchema,
  encodeJsonFrame,
  JsonFrameDecoder,
  type EmbedderRequest,
  type EmbedderResponse,
} from '@noderag/shared';
import type { EmbeddingRuntime, ManagedEmbeddingRuntime } from './runtime.js';

interface QueuedRequest {
  readonly request: EmbedderRequest;
  readonly socket: Socket;
  readonly sequence: number;
}

const writeResponse = (socket: Socket, response: EmbedderResponse): void => {
  socket.write(encodeJsonFrame(response));
};

export const embedderFailureCode = (error: unknown): string => {
  const operatingSystemCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (operatingSystemCode === 'ENOENT') return 'EMBEDDER_MODEL_FILES_MISSING';
  const message = error instanceof Error ? error.message : '';
  if (
    [
      'TOKEN_LIMIT',
      'EMBEDDER_EMPTY_BATCH',
      'EMBEDDER_MODEL_DIMENSION_MISMATCH',
      'EMBEDDER_MODEL_UNAVAILABLE',
      'EMBEDDER_RUNTIME_CONTROL_UNAVAILABLE',
      'EMBEDDER_THREAD_COUNT_INVALID',
    ].includes(message)
  ) {
    return message;
  }
  if (message === 'Embedding has an invalid norm.') return 'EMBEDDER_INVALID_OUTPUT';
  return 'EMBEDDER_MODEL_LOAD_FAILED';
};

export const startEmbedderServer = async (
  socketPath: string,
  runtime: EmbeddingRuntime,
): Promise<{ readonly close: () => Promise<void> }> => {
  const queue: QueuedRequest[] = [];
  let sequence = 0;
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        queue.sort(
          (left, right) =>
            left.request.priority - right.request.priority || left.sequence - right.sequence,
        );
        const item = queue.shift();
        if (item === undefined || item.socket.destroyed) continue;
        try {
          if (item.request.operation === 'status') {
            const managed = runtime as Partial<ManagedEmbeddingRuntime>;
            const runtimeStatus = managed.runtimeStatus?.();
            if (runtimeStatus === undefined)
              throw new Error('EMBEDDER_RUNTIME_CONTROL_UNAVAILABLE');
            writeResponse(item.socket, {
              id: item.request.id,
              ok: true,
              vectors: [],
              tokenCounts: [],
              elapsedMilliseconds: 0,
              runtimeStatus,
            });
          } else if (item.request.operation === 'configure') {
            const managed = runtime as Partial<ManagedEmbeddingRuntime>;
            const runtimeStatus = await managed.configureThreads?.(item.request.threads);
            if (runtimeStatus === undefined)
              throw new Error('EMBEDDER_RUNTIME_CONTROL_UNAVAILABLE');
            writeResponse(item.socket, {
              id: item.request.id,
              ok: true,
              vectors: [],
              tokenCounts: [],
              elapsedMilliseconds: 0,
              runtimeStatus,
            });
          } else if (item.request.operation === 'count') {
            const started = performance.now();
            const tokenCounts = await runtime.countTokens(
              item.request.texts,
              item.request.priority,
              item.request.model,
            );
            writeResponse(item.socket, {
              id: item.request.id,
              ok: true,
              vectors: [],
              tokenCounts: [...tokenCounts],
              elapsedMilliseconds: performance.now() - started,
            });
          } else {
            const result = await runtime.embed(
              item.request.texts,
              item.request.maxTokens,
              item.request.priority,
              item.request.model,
            );
            writeResponse(item.socket, {
              id: item.request.id,
              ok: true,
              vectors: result.vectors.map((vector) => [...vector]),
              tokenCounts: [...result.tokenCounts],
              elapsedMilliseconds: result.elapsedMilliseconds,
            });
          }
        } catch (error) {
          writeResponse(item.socket, {
            id: item.request.id,
            ok: false,
            code: embedderFailureCode(error),
          });
        }
      }
    } finally {
      running = false;
    }
  };

  if (!socketPath.startsWith('\\\\.\\pipe\\')) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
  }
  const server = createServer((socket) => {
    const decoder = new JsonFrameDecoder();
    socket.on('data', (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          queue.push({ request: embedderRequestSchema.parse(value), socket, sequence });
          sequence += 1;
        }
        void drain();
      } catch {
        socket.destroy();
      }
    });
    socket.on('end', () => {
      try {
        decoder.finish();
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListen);
  });
  if (!socketPath.startsWith('\\\\.\\pipe\\')) await chmod(socketPath, 0o600);
  return {
    close: async () => {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error === undefined ? resolveClose() : reject(error))),
      );
      await runtime.close();
      if (!socketPath.startsWith('\\\\.\\pipe\\')) await rm(socketPath, { force: true });
    },
  };
};
