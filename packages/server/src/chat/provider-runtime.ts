import type { Pool } from 'pg';
import type { SecretVault } from '../identity/secrets.js';
import type { ChatProvider, ChatProviderKind } from './contract.js';
import { OllamaCloudChatProvider } from './ollama-cloud-chat.js';
import { OLLAMA_CLOUD_SERVICE_ROOT } from './ollama-cloud.js';
import { OpenAiOAuthChatProvider } from './openai-chat-provider.js';
import type { OpenAiOAuthManager } from './openai-oauth.js';

export interface ChatProviderRuntimeOptions {
  readonly pool: Pool;
  readonly secretVault: SecretVault;
  readonly openAiOAuth?: OpenAiOAuthManager;
}

export const createChatProviderResolver =
  (options: ChatProviderRuntimeOptions) =>
  async (kind: ChatProviderKind): Promise<ChatProvider> => {
    const status = await options.pool.query<{
      enabled: boolean;
      service_root: string | null;
      generation_status: string;
    }>(
      `SELECT connection.enabled,connection.service_root,
              capability.status AS generation_status
       FROM noderag.chat_provider_connection AS connection
       JOIN noderag.chat_provider_capability AS capability
         ON capability.connection_id=connection.id AND capability.capability='generation'
       WHERE connection.provider_kind=$1`,
      [kind],
    );
    const row = status.rows[0];
    if (row === undefined || !row.enabled || row.generation_status !== 'healthy') {
      throw new Error('chat_provider_unavailable');
    }
    if (kind === 'ollama_cloud') {
      if (row.service_root !== OLLAMA_CLOUD_SERVICE_ROOT) {
        throw new Error('ollama_cloud_service_root_invalid');
      }
      const key = await options.secretVault.reveal(options.pool, 'ollama_cloud', 'api-key');
      if (key === null) throw new Error('ollama_cloud_key_required');
      return new OllamaCloudChatProvider({ apiKey: key });
    }
    if (options.openAiOAuth === undefined) throw new Error('openai_oauth_unavailable');
    return new OpenAiOAuthChatProvider(options.openAiOAuth);
  };
