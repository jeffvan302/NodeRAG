export const CHAT_FEATURE_KEYS = [
  'chat.providers.enabled',
  'chat.context.enabled',
  'chat.ui.enabled',
  'chat.tools.research.enabled',
  'chat.tools.rag.enabled',
  'chat.tools.web.enabled',
  'chat.artifacts.enabled',
  'chat.exports.enabled',
  'chat.import.enabled',
] as const;

export type ChatFeatureKey = (typeof CHAT_FEATURE_KEYS)[number];
export type ChatFeatureFlags = Readonly<Record<ChatFeatureKey, boolean>>;

const CHAT_FEATURE_ENV: Readonly<Record<ChatFeatureKey, string>> = {
  'chat.providers.enabled': 'NODERAG_CHAT_PROVIDERS_ENABLED',
  'chat.context.enabled': 'NODERAG_CHAT_CONTEXT_ENABLED',
  'chat.ui.enabled': 'NODERAG_CHAT_UI_ENABLED',
  'chat.tools.research.enabled': 'NODERAG_CHAT_RESEARCH_TOOLS_ENABLED',
  'chat.tools.rag.enabled': 'NODERAG_CHAT_RAG_TOOLS_ENABLED',
  'chat.tools.web.enabled': 'NODERAG_CHAT_WEB_TOOLS_ENABLED',
  'chat.artifacts.enabled': 'NODERAG_CHAT_ARTIFACTS_ENABLED',
  'chat.exports.enabled': 'NODERAG_CHAT_EXPORTS_ENABLED',
  'chat.import.enabled': 'NODERAG_CHAT_IMPORT_ENABLED',
};

const parseFlag = (environmentName: string, value: string | undefined): boolean => {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`${environmentName} must be true, false, 1, or 0.`);
};

export const loadChatFeatureFlags = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChatFeatureFlags => {
  const flags = Object.fromEntries(
    CHAT_FEATURE_KEYS.map((key) => [
      key,
      parseFlag(CHAT_FEATURE_ENV[key], environment[CHAT_FEATURE_ENV[key]]),
    ]),
  ) as Record<ChatFeatureKey, boolean>;
  assertChatFeatureDependencies(flags);
  return flags;
};

export const assertChatFeatureDependencies = (flags: ChatFeatureFlags): void => {
  const requireEnabled = (feature: ChatFeatureKey, dependency: ChatFeatureKey): void => {
    if (flags[feature] && !flags[dependency]) {
      throw new Error(`${feature} requires ${dependency}.`);
    }
  };
  requireEnabled('chat.ui.enabled', 'chat.providers.enabled');
  requireEnabled('chat.ui.enabled', 'chat.context.enabled');
  requireEnabled('chat.context.enabled', 'chat.providers.enabled');
  requireEnabled('chat.tools.research.enabled', 'chat.ui.enabled');
  requireEnabled('chat.tools.rag.enabled', 'chat.ui.enabled');
  requireEnabled('chat.tools.web.enabled', 'chat.ui.enabled');
  requireEnabled('chat.tools.web.enabled', 'chat.providers.enabled');
  requireEnabled('chat.artifacts.enabled', 'chat.ui.enabled');
  requireEnabled('chat.exports.enabled', 'chat.artifacts.enabled');
  requireEnabled('chat.import.enabled', 'chat.artifacts.enabled');
};
