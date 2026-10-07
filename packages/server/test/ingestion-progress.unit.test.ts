import { describe, expect, it } from 'vitest';
import { assessMarkdownQuality, nextEmbeddingBatchSize } from '../src/ingest/pipeline.js';

describe('adaptive ingestion progress', () => {
  it('shrinks slow embedding groups and grows fast ones toward frequent updates', () => {
    expect(nextEmbeddingBatchSize(8, 80_000, 100)).toBe(2);
    expect(nextEmbeddingBatchSize(2, 5_000, 100)).toBe(8);
    expect(nextEmbeddingBatchSize(4, 20_000, 100)).toBe(4);
  });

  it('never exceeds the remaining passages and stops at zero', () => {
    expect(nextEmbeddingBatchSize(16, 1_000, 1)).toBe(1);
    expect(nextEmbeddingBatchSize(4, 20_000, 0)).toBe(0);
  });

  it('leaves clean extracted Markdown unflagged', () => {
    const assessment = assessMarkdownQuality(
      '# Revenue\n\nThe annual report describes tax revenue and operating income in clear prose.',
    );
    expect(assessment.warningCodes).toEqual([]);
  });

  it('flags common signs of repeated or corrupted extraction without deleting content', () => {
    const repeatedHeader = 'Government revenue report — confidential';
    const markdown = [
      repeatedHeader,
      repeatedHeader,
      repeatedHeader,
      repeatedHeader,
      repeatedHeader,
      '������������������������',
      '!!!!!!!!!!!!!!!!!!!!!!!!',
      '########################',
      'Broken Ã© text and a replacement \uFFFD character.\u0001',
    ].join('\n');
    const assessment = assessMarkdownQuality(markdown);
    expect(assessment.warningCodes).toEqual(
      expect.arrayContaining([
        'replacement-characters',
        'unexpected-control-characters',
        'possible-mojibake',
        'symbol-heavy-lines',
        'repeated-lines',
      ]),
    );
    expect(markdown).toContain(repeatedHeader);
  });
});
