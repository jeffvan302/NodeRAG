import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  embedderResponseSchema,
  encodeJsonFrame,
  JsonFrameDecoder,
  type Embedder,
  type EmbedderModel,
  type EmbedderRequest,
  type EmbedderResponse,
} from '@noderag/shared';

interface PendingRequest {
  readonly resolve: (response: EmbedderResponse) => void;
  readonly reject: (error: Error) => void;
}

export class FramedEmbedderClient implements Embedder {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly socketPath: string) {}

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async connection(): Promise<Socket> {
    if (this.socket !== null && !this.socket.destroyed) return this.socket;
    if (this.connecting !== null) return this.connecting;
    this.connecting = new Promise<Socket>((resolveConnect, reject) => {
      const decoder = new JsonFrameDecoder();
      const socket = createConnection(this.socketPath);
      socket.once('connect', () => {
        this.socket = socket;
        this.connecting = null;
        resolveConnect(socket);
      });
      socket.on('data', (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const response = embedderResponseSchema.parse(value);
            const pending = this.pending.get(response.id);
            if (pending !== undefined) {
              this.pending.delete(response.id);
              pending.resolve(response);
            }
          }
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error('Invalid embedder frame.'));
        }
      });
      socket.once('error', (error) => {
        if (this.connecting !== null) {
          this.connecting = null;
          reject(error);
        }
        this.socket = null;
        this.failPending(error);
      });
      socket.once('close', () => {
        this.socket = null;
        this.failPending(new Error('Embedder connection closed.'));
      });
    });
    return this.connecting;
  }

  private async request(request: EmbedderRequest): Promise<EmbedderResponse> {
    const socket = await this.connection();
    const response = new Promise<EmbedderResponse>((resolveResponse, reject) => {
      this.pending.set(request.id, { resolve: resolveResponse, reject });
    });
    socket.write(encodeJsonFrame(request));
    return response;
  }

  async embed(texts: readonly string[], maxTokens: number, priority = 5, model?: EmbedderModel) {
    const response = await this.request({
      id: randomUUID(),
      operation: 'embed',
      priority,
      texts: [...texts],
      maxTokens,
      model,
    });
    if (!response.ok) throw new Error(response.code);
    return {
      vectors: response.vectors,
      tokenCounts: response.tokenCounts,
      elapsedMilliseconds: response.elapsedMilliseconds,
    };
  }

  async countTokens(
    texts: readonly string[],
    priority = 5,
    model?: EmbedderModel,
  ): Promise<readonly number[]> {
    const response = await this.request({
      id: randomUUID(),
      operation: 'count',
      priority,
      texts: [...texts],
      model,
    });
    if (!response.ok) throw new Error(response.code);
    return response.tokenCounts;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket === null || socket.destroyed) return;
    await new Promise<void>((resolveClose) => {
      socket.once('close', resolveClose);
      socket.end();
    });
  }
}
