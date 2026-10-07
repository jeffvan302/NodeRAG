import type { Pool } from 'pg';
import type { InjectedVision } from '../extract/contract.js';
import { DatabaseVisionCache } from './database-cache.js';
import { DatabaseVisionSemaphore } from './database-semaphore.js';
import { OllamaVisionProvider } from './ollama.js';
import { VisionProcessor } from './service.js';
import type { SecretVault } from '../identity/secrets.js';

interface VisionSettingsRow {
  readonly vision_enabled: boolean;
  readonly ollama_base_url: string | null;
  readonly ollama_model: string | null;
  readonly ollama_model_revision: string | null;
  readonly ollama_parallel: number;
  readonly ollama_images_per_call: number;
  readonly ollama_timeout_ms: number;
  readonly ollama_max_attempts: number;
  readonly ollama_keep_alive: string;
  readonly ollama_num_ctx: number;
  readonly max_image_px: number;
  readonly ollama_secret_id: string | null;
}

export interface RuntimeVisionOptions {
  readonly bearerToken?: string;
  readonly providerParallelCapacity?: number;
  readonly secretVault?: SecretVault;
}

export const createRuntimeVisionProcessor = async (
  pool: Pool,
  options: RuntimeVisionOptions = {},
): Promise<InjectedVision | undefined> => {
  const found = await pool.query<VisionSettingsRow>(
    `SELECT vision_enabled, ollama_base_url, ollama_model, ollama_model_revision,
            ollama_parallel, ollama_images_per_call, ollama_timeout_ms, ollama_max_attempts, ollama_keep_alive,
            ollama_num_ctx, max_image_px, ollama_secret_id
     FROM noderag.settings WHERE id = 1`,
  );
  const settings = found.rows[0];
  if (
    settings === undefined ||
    !settings.vision_enabled ||
    settings.ollama_base_url === null ||
    settings.ollama_model === null
  ) {
    return undefined;
  }
  const storedToken =
    settings.ollama_secret_id === null || options.secretVault === undefined
      ? undefined
      : ((await options.secretVault.reveal(pool, 'ollama', 'bearer-token')) ?? undefined);
  const bearerToken = options.bearerToken ?? storedToken;
  const provider = new OllamaVisionProvider({
    baseUrl: settings.ollama_base_url,
    model: settings.ollama_model,
    ...(settings.ollama_model_revision === null
      ? {}
      : { modelRevision: settings.ollama_model_revision }),
    keepAlive: settings.ollama_keep_alive,
    contextWindow: settings.ollama_num_ctx,
    ...(bearerToken === undefined ? {} : { bearerToken }),
  });
  const maximumConcurrency = Math.min(
    settings.ollama_parallel,
    options.providerParallelCapacity ?? settings.ollama_parallel,
  );
  return new VisionProcessor({
    provider,
    cache: new DatabaseVisionCache(pool),
    maximumDimension: settings.max_image_px,
    maximumConcurrency,
    maximumImagesPerCall: settings.ollama_images_per_call,
    timeoutMs: settings.ollama_timeout_ms,
    maximumAttempts: settings.ollama_max_attempts,
    concurrency: new DatabaseVisionSemaphore(pool, maximumConcurrency),
  });
};
