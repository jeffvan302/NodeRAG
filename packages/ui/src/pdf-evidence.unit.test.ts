import { describe, expect, it } from 'vitest';
import { immediateExactPdfEvidence, mergePdfEvidence } from './pdf-evidence.js';

describe('PDF evidence preparation', () => {
  it('makes query terms and ordinary inflections available before semantic evidence returns', () => {
    expect(immediateExactPdfEvidence('tax revenue')).toEqual(
      expect.arrayContaining([
        { kind: 'exact', text: 'tax', confidence: 1 },
        { kind: 'exact', text: 'revenue', confidence: 1 },
        { kind: 'exact', text: 'revenues', confidence: 1 },
      ]),
    );
  });

  it('deduplicates later evidence while retaining the strongest confidence', () => {
    expect(
      mergePdfEvidence(
        [{ kind: 'semantic', text: 'Revenue supports services.', confidence: 0.72 }],
        [
          { kind: 'semantic', text: 'revenue supports services.', confidence: 0.86 },
          { kind: 'exact', text: 'revenue', confidence: 1 },
        ],
      ),
    ).toEqual([
      { kind: 'semantic', text: 'revenue supports services.', confidence: 0.86 },
      { kind: 'exact', text: 'revenue', confidence: 1 },
    ]);
  });
});
