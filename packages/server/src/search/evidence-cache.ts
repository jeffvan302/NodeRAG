import { createHash } from 'node:crypto';
import type { RetrievalConfidenceCalibration } from './confidence.js';
import type { SearchEvidence } from './evidence.js';

export type SemanticEvidenceCacheStatus = 'hit' | 'miss' | 'shared';

interface CompletedEntry {
  readonly evidence: readonly SearchEvidence[];
  readonly expiresAt: number;
}

export interface SemanticEvidenceCacheKeyInput {
  readonly query: string;
  readonly passage: string;
  readonly manifestDigest: string;
  readonly dimensions: number;
  readonly maximumTokens: number;
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  readonly calibration: RetrievalConfidenceCalibration;
}

export const semanticEvidenceCacheKey = (input: SemanticEvidenceCacheKeyInput): string => {
  const digest = createHash('sha256');
  digest.update('noderag-semantic-evidence-v1\0', 'utf8');
  digest.update(input.query.normalize('NFC'), 'utf8');
  digest.update('\0', 'utf8');
  digest.update(input.passage.normalize('NFC'), 'utf8');
  digest.update('\0', 'utf8');
  digest.update(
    JSON.stringify({
      manifestDigest: input.manifestDigest,
      dimensions: input.dimensions,
      maximumTokens: input.maximumTokens,
      queryPrefix: input.queryPrefix,
      documentPrefix: input.documentPrefix,
      calibration: input.calibration,
    }),
    'utf8',
  );
  return digest.digest('hex');
};

export class SemanticEvidenceCache {
  readonly #completed = new Map<string, CompletedEntry>();
  readonly #inFlight = new Map<string, Promise<readonly SearchEvidence[]>>();

  constructor(
    readonly maximumEntries = 512,
    readonly ttlMilliseconds = 24 * 60 * 60 * 1000,
    readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('semantic-evidence-cache-size-invalid');
    }
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1) {
      throw new Error('semantic-evidence-cache-ttl-invalid');
    }
  }

  async getOrCompute(
    key: string,
    compute: () => Promise<readonly SearchEvidence[]>,
  ): Promise<{
    readonly evidence: readonly SearchEvidence[];
    readonly status: SemanticEvidenceCacheStatus;
  }> {
    const cached = this.#completed.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) {
        this.#completed.delete(key);
        this.#completed.set(key, cached);
        return { evidence: cached.evidence, status: 'hit' };
      }
      this.#completed.delete(key);
    }

    const shared = this.#inFlight.get(key);
    if (shared !== undefined) return { evidence: await shared, status: 'shared' };

    const operation = compute().then((evidence) => {
      this.#completed.set(key, {
        evidence: [...evidence],
        expiresAt: this.now() + this.ttlMilliseconds,
      });
      while (this.#completed.size > this.maximumEntries) {
        const oldest = this.#completed.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#completed.delete(oldest);
      }
      return evidence;
    });
    this.#inFlight.set(key, operation);
    try {
      return { evidence: await operation, status: 'miss' };
    } finally {
      if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
    }
  }
}
