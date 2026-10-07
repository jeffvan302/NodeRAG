import { z } from 'zod';
import { chatProviderKindSchema } from './contract.js';

const safeEffortSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const optionalQuotaSchema = z.number().int().min(1_000).max(1_000_000_000_000).nullable();

export const managedLayerSchema = z
  .object({
    provider: chatProviderKindSchema,
    model: z.string().trim().min(1).max(180),
    reasoningEffort: safeEffortSchema,
    instructions: z.string().trim().min(1).max(20_000),
    outputTargetTokens: z.number().int().min(128).max(1_000_000),
  })
  .strict();

export const chatContextSettingsInputSchema = z
  .object({
    rollingTurnLimit: z.number().int().min(1).max(500),
    inputReserveTokens: z.number().int().min(0).max(1_000_000),
    outputReserveTokens: z.number().int().min(128).max(1_000_000),
    pinnedInstructionReserveTokens: z.number().int().min(0).max(1_000_000),
    toolResultReserveTokens: z.number().int().min(0).max(1_000_000),
    managed: z.discriminatedUnion('enabled', [
      z
        .object({
          enabled: z.literal(false),
          triggerPercent: z.number().min(25).max(95),
          keepRecentTurns: z.number().int().min(1).max(100),
          l1PinLimitTokens: z.number().int().min(0).max(1_000_000),
        })
        .strict(),
      z
        .object({
          enabled: z.literal(true),
          triggerPercent: z.number().min(25).max(95),
          keepRecentTurns: z.number().int().min(1).max(100),
          l1PinLimitTokens: z.number().int().min(0).max(1_000_000),
          l2: managedLayerSchema,
          l3: managedLayerSchema.extend({
            stateSchema: z.record(z.string(), z.unknown()),
          }),
        })
        .strict(),
    ]),
  })
  .strict();

export const chatSettingsInputSchema = z
  .object({
    defaultProvider: chatProviderKindSchema.nullable(),
    defaultModel: z.string().trim().min(1).max(180).nullable(),
    defaultReasoningEffort: safeEffortSchema,
    defaultContextMode: z.enum(['rolling', 'managed']),
    defaultAllowResearch: z.boolean(),
    defaultAllowRag: z.boolean(),
    defaultAllowInternet: z.boolean(),
    markdownOnly: z.literal(true),
    runTimeoutMs: z.number().int().min(10_000).max(1_800_000),
    maximumToolCalls: z.number().int().min(0).max(100),
    maximumParallelRunsPerUser: z.number().int().min(1).max(32),
    dailyRunQuota: z.number().int().min(1).max(1_000_000).nullable(),
    dailyInputTokenQuota: optionalQuotaSchema,
    dailyOutputTokenQuota: optionalQuotaSchema,
    retentionDays: z.number().int().min(1).max(3650),
    archiveAfterDays: z.number().int().min(1).max(3650),
    artifactMaxFileBytes: z.number().int().min(1024).max(104_857_600),
    artifactChatQuotaBytes: z.number().int().min(1024).max(10_737_418_240),
    markdownExternalImages: z.boolean(),
    logSegmentMaxBytes: z.number().int().min(1_048_576).max(67_108_864),
    logSegmentMaxAgeMinutes: z.number().int().min(5).max(10_080),
    exportMaxOutputBytes: z.number().int().min(1_048_576).max(536_870_912),
    exportTimeoutMs: z.number().int().min(10_000).max(900_000),
    exportMaximumAttempts: z.number().int().min(1).max(5),
    storagePath: z.string().trim().min(1).max(4096).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.defaultProvider === null) !== (value.defaultModel === null)) {
      context.addIssue({
        code: 'custom',
        message: 'default_provider_and_model_required_together',
        path: ['defaultModel'],
      });
    }
    if (value.archiveAfterDays > value.retentionDays) {
      context.addIssue({
        code: 'custom',
        message: 'archive_must_precede_retention',
        path: ['archiveAfterDays'],
      });
    }
    if (value.artifactChatQuotaBytes < value.artifactMaxFileBytes) {
      context.addIssue({
        code: 'custom',
        message: 'artifact_quota_must_cover_maximum_file',
        path: ['artifactChatQuotaBytes'],
      });
    }
  });

export const modelCapacityOverrideSchema = z
  .object({
    administratorContextTokens: z.number().int().min(1024).max(10_000_000).nullable(),
    administratorOutputTokens: z.number().int().min(128).max(1_000_000).nullable(),
    note: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export interface ModelCapacityInput {
  readonly administratorContextTokens: number | null;
  readonly runtimeContextTokens: number | null;
  readonly configuredContextTokens: number | null;
  readonly advertisedContextTokens: number | null;
  readonly knownContextTokens: number | null;
  readonly administratorOutputTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly knownOutputTokens: number | null;
}

export interface ResolvedModelCapacity {
  readonly contextTokens: number | null;
  readonly contextSource:
    | 'administrator_override'
    | 'provider_runtime'
    | 'provider_configured'
    | 'provider_advertised'
    | 'known_model_table'
    | 'unknown';
  readonly maximumOutputTokens: number | null;
  readonly outputSource:
    'administrator_override' | 'provider_metadata' | 'known_model_table' | 'unknown';
}

export const resolveModelCapacity = (input: ModelCapacityInput): ResolvedModelCapacity => {
  const contextOptions = [
    ['provider_runtime', input.runtimeContextTokens],
    ['provider_configured', input.configuredContextTokens],
    ['provider_advertised', input.advertisedContextTokens],
    ['administrator_override', input.administratorContextTokens],
    ['known_model_table', input.knownContextTokens],
  ] as const;
  const context = contextOptions.find(([, value]) => value !== null);
  const outputOptions = [
    ['provider_metadata', input.maximumOutputTokens],
    ['administrator_override', input.administratorOutputTokens],
    ['known_model_table', input.knownOutputTokens],
  ] as const;
  const output = outputOptions.find(([, value]) => value !== null);
  return {
    contextTokens: context?.[1] ?? null,
    contextSource: context?.[0] ?? 'unknown',
    maximumOutputTokens: output?.[1] ?? null,
    outputSource: output?.[0] ?? 'unknown',
  };
};

export interface ContextReserveInput {
  readonly contextTokens: number;
  readonly inputReserveTokens: number;
  readonly outputReserveTokens: number;
  readonly pinnedInstructionReserveTokens: number;
  readonly toolResultReserveTokens: number;
}

export const calculateUsableContextTokens = (input: ContextReserveInput): number => {
  const values = Object.values(input);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('context_reserve_invalid');
  }
  const reserved =
    input.inputReserveTokens +
    input.outputReserveTokens +
    input.pinnedInstructionReserveTokens +
    input.toolResultReserveTokens;
  const usable = input.contextTokens - reserved;
  if (usable < 1) throw new Error('context_reserve_exceeds_capacity');
  return usable;
};

export interface TurnMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly final?: boolean;
}

export interface CompleteTurn {
  readonly messages: readonly TurnMessage[];
}

export const groupCompleteTurns = (messages: readonly TurnMessage[]): readonly CompleteTurn[] => {
  const turns: TurnMessage[][] = [];
  let current: TurnMessage[] | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (current !== null) turns.push(current);
      current = [message];
    } else if (current !== null) {
      current.push(message);
    }
  }
  if (current !== null) turns.push(current);
  return turns
    .filter((turn) =>
      turn.some((message) => message.role === 'assistant' && message.final !== false),
    )
    .map((turn) => ({ messages: turn }));
};

export const selectRollingTurns = (
  messages: readonly TurnMessage[],
  turnLimit: number,
): readonly CompleteTurn[] => {
  if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) throw new Error('turn_limit_invalid');
  return groupCompleteTurns(messages).slice(-turnLimit);
};

export const estimateChatTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.max(1, Math.ceil([...text].length / 4));

export interface SyntheticCompressionPreviewInput {
  readonly turnCount: number;
  readonly averageCharactersPerMessage: number;
  readonly pinnedCharacters: number;
  readonly keepRecentTurns: number;
  readonly managedEnabled: boolean;
  readonly l2Ready: boolean;
  readonly l3Ready: boolean;
}

export const syntheticCompressionPreview = (input: SyntheticCompressionPreviewInput) => {
  const boundedTurns = Math.min(500, Math.max(1, Math.trunc(input.turnCount)));
  const characters = Math.min(
    2_000_000,
    Math.max(40, Math.trunc(input.averageCharactersPerMessage)),
  );
  const beforeTokens = estimateChatTokens('x'.repeat(boundedTurns * characters * 2));
  const recentTurns = Math.min(boundedTurns, Math.max(1, Math.trunc(input.keepRecentTurns)));
  const recentTokens = estimateChatTokens('x'.repeat(recentTurns * characters * 2));
  const pinnedTokens = estimateChatTokens(
    'x'.repeat(Math.min(200_000, Math.max(0, Math.trunc(input.pinnedCharacters)))),
  );
  const layerErrors = [
    ...(!input.managedEnabled ? ['managed_context_disabled'] : []),
    ...(input.managedEnabled && !input.l2Ready ? ['l2_not_ready'] : []),
    ...(input.managedEnabled && !input.l3Ready ? ['l3_not_ready'] : []),
  ];
  const projectedProviderCalls = input.managedEnabled ? 2 : 0;
  const summaryTokens = input.l2Ready
    ? Math.max(128, Math.ceil((beforeTokens - recentTokens) * 0.12))
    : 0;
  const stateTokens = input.l3Ready
    ? Math.max(128, Math.ceil((beforeTokens - recentTokens) * 0.04))
    : 0;
  return {
    syntheticInput: true,
    beforeTokens,
    afterTokens: recentTokens + pinnedTokens + summaryTokens + stateTokens,
    selectedPins:
      pinnedTokens === 0 ? [] : [{ label: 'Synthetic pinned instruction', tokens: pinnedTokens }],
    summary: { status: input.l2Ready ? 'ready' : 'unavailable', estimatedTokens: summaryTokens },
    structuredState: {
      status: input.l3Ready ? 'ready' : 'unavailable',
      estimatedTokens: stateTokens,
    },
    recentTurns,
    layerErrors,
    projectedProviderCalls,
  };
};
