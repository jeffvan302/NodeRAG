import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateUsableContextTokens,
  chatContextSettingsInputSchema,
  chatSettingsInputSchema,
  estimateChatTokens,
  groupCompleteTurns,
  resolveModelCapacity,
  selectRollingTurns,
  syntheticCompressionPreview,
} from '../src/chat/configuration.js';
import { probeChatStorage } from '../src/chat/storage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const capacities = (overrides: Partial<Parameters<typeof resolveModelCapacity>[0]> = {}) => ({
  administratorContextTokens: null,
  runtimeContextTokens: null,
  configuredContextTokens: null,
  advertisedContextTokens: null,
  knownContextTokens: null,
  administratorOutputTokens: null,
  maximumOutputTokens: null,
  knownOutputTokens: null,
  ...overrides,
});

describe('Chat context and settings policy', () => {
  it('uses the documented context-capacity precedence without inventing an unknown limit', () => {
    expect(resolveModelCapacity(capacities())).toMatchObject({
      contextTokens: null,
      contextSource: 'unknown',
      maximumOutputTokens: null,
    });
    const sources = [
      ['knownContextTokens', 'known_model_table'],
      ['administratorContextTokens', 'administrator_override'],
      ['advertisedContextTokens', 'provider_advertised'],
      ['configuredContextTokens', 'provider_configured'],
      ['runtimeContextTokens', 'provider_runtime'],
    ] as const;
    let input = capacities();
    for (const [field, source] of sources) {
      input = { ...input, [field]: 16_000 + sources.indexOf([field, source] as never) };
      expect(resolveModelCapacity(input).contextSource).toBe(source);
    }
  });

  it('prefers provider, administrator fallback, then known output limits', () => {
    expect(
      resolveModelCapacity(
        capacities({
          knownOutputTokens: 1_000,
          maximumOutputTokens: 2_000,
          administratorOutputTokens: 3_000,
        }),
      ),
    ).toMatchObject({ maximumOutputTokens: 2_000, outputSource: 'provider_metadata' });
  });

  it('subtracts explicit reserves and rejects configurations that consume the window', () => {
    expect(
      calculateUsableContextTokens({
        contextTokens: 32_000,
        inputReserveTokens: 1_000,
        outputReserveTokens: 4_000,
        pinnedInstructionReserveTokens: 2_000,
        toolResultReserveTokens: 5_000,
      }),
    ).toBe(20_000);
    expect(() =>
      calculateUsableContextTokens({
        contextTokens: 4_000,
        inputReserveTokens: 1_000,
        outputReserveTokens: 1_000,
        pinnedInstructionReserveTokens: 1_000,
        toolResultReserveTokens: 1_000,
      }),
    ).toThrow('context_reserve_exceeds_capacity');
  });

  it('keeps only complete user/assistant turns and never slices by raw message count', () => {
    const messages = [
      { role: 'system' as const, content: 'policy' },
      { role: 'user' as const, content: 'one' },
      { role: 'tool' as const, content: 'evidence' },
      { role: 'assistant' as const, content: 'answer one' },
      { role: 'user' as const, content: 'two' },
      { role: 'assistant' as const, content: 'streaming', final: false },
      { role: 'user' as const, content: 'three' },
      { role: 'assistant' as const, content: 'answer three' },
    ];
    expect(groupCompleteTurns(messages)).toHaveLength(2);
    expect(selectRollingTurns(messages, 1)[0]?.messages[0]?.content).toBe('three');
  });

  it('provides deterministic token estimates and synthetic-only compression previews', () => {
    expect(estimateChatTokens('')).toBe(0);
    expect(estimateChatTokens('12345678')).toBe(2);
    const preview = syntheticCompressionPreview({
      turnCount: 20,
      averageCharactersPerMessage: 800,
      pinnedCharacters: 400,
      keepRecentTurns: 4,
      managedEnabled: true,
      l2Ready: true,
      l3Ready: false,
    });
    expect(preview).toMatchObject({
      syntheticInput: true,
      projectedProviderCalls: 2,
      recentTurns: 4,
      layerErrors: ['l3_not_ready'],
      summary: { status: 'ready' },
      structuredState: { status: 'unavailable' },
    });
    expect(preview.afterTokens).toBeLessThan(preview.beforeTokens);
  });

  it('validates safe defaults and requires complete managed L2/L3 configuration', () => {
    expect(
      chatContextSettingsInputSchema.safeParse({
        rollingTurnLimit: 12,
        inputReserveTokens: 1024,
        outputReserveTokens: 4096,
        pinnedInstructionReserveTokens: 2048,
        toolResultReserveTokens: 8192,
        managed: {
          enabled: false,
          triggerPercent: 75,
          keepRecentTurns: 8,
          l1PinLimitTokens: 4096,
        },
      }).success,
    ).toBe(true);
    expect(
      chatSettingsInputSchema.safeParse({
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: 'default',
        defaultContextMode: 'rolling',
        defaultAllowResearch: false,
        defaultAllowRag: false,
        defaultAllowInternet: false,
        markdownOnly: true,
        runTimeoutMs: 120_000,
        maximumToolCalls: 8,
        maximumParallelRunsPerUser: 2,
        dailyRunQuota: 100,
        dailyInputTokenQuota: 1_000_000,
        dailyOutputTokenQuota: 250_000,
        retentionDays: 365,
        archiveAfterDays: 30,
        artifactMaxFileBytes: 10 * 1024 * 1024,
        artifactChatQuotaBytes: 256 * 1024 * 1024,
        markdownExternalImages: false,
        logSegmentMaxBytes: 8 * 1024 * 1024,
        logSegmentMaxAgeMinutes: 1440,
        exportMaxOutputBytes: 64 * 1024 * 1024,
        exportTimeoutMs: 120_000,
        exportMaximumAttempts: 2,
        storagePath: null,
      }).success,
    ).toBe(true);
  });
});

describe('Chat storage initialization', () => {
  it('creates one private .noderag-chat store and reuses its stable manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-chat-storage-'));
    roots.push(root);
    const first = await probeChatStorage(root, {
      policy: 'testbed',
      rebuildReserveBytes: 0n,
      manifestId: () => '11111111-1111-4111-8111-111111111111',
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });
    expect(first).toMatchObject({
      initialized: true,
      manifest: { manifestId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toEqual(first.manifest);
    const second = await probeChatStorage(root, {
      policy: 'testbed',
      rebuildReserveBytes: 0n,
    });
    expect(second.initialized).toBe(false);
    expect(second.manifest.manifestId).toBe(first.manifest.manifestId);
  });

  it('rejects an occupied managed child instead of overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-chat-storage-invalid-'));
    roots.push(root);
    await writeFile(join(root, '.noderag-chat'), 'occupied', 'utf8');
    await expect(
      probeChatStorage(root, { policy: 'testbed', rebuildReserveBytes: 0n }),
    ).rejects.toThrow('chat_storage_path_invalid');
  });

  it('rejects a malformed existing Chat manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-chat-storage-manifest-'));
    roots.push(root);
    const initialized = await probeChatStorage(root, {
      policy: 'testbed',
      rebuildReserveBytes: 0n,
    });
    await writeFile(initialized.manifestPath, '{"kind":"unrecognized"}\n', 'utf8');
    await expect(
      probeChatStorage(root, { policy: 'testbed', rebuildReserveBytes: 0n }),
    ).rejects.toThrow('chat_storage_manifest_invalid');
  });
});
