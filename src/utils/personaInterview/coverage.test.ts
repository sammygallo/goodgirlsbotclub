import { describe, expect, it } from 'vitest';
import { isReadyToFinish, markTopicSkipped, mergeCoverage } from './coverage';
import { emptyCoverage, emptyDraft } from './types';

describe('mergeCoverage', () => {
  it('applies a delta over pending/partial topics', () => {
    const merged = mergeCoverage(emptyCoverage(), { identity: 'done', personality: 'partial' });
    expect(merged.identity).toBe('done');
    expect(merged.personality).toBe('partial');
    expect(merged.details).toBe('pending');
  });

  it('never downgrades or overwrites a terminal (done/skipped) topic', () => {
    const current = { ...emptyCoverage(), identity: 'done' as const, personality: 'skipped' as const };
    const merged = mergeCoverage(current, { identity: 'partial', personality: 'done' });
    expect(merged.identity).toBe('done');
    expect(merged.personality).toBe('skipped');
  });

  it('returns the same reference when nothing changes', () => {
    const current = emptyCoverage();
    expect(mergeCoverage(current, undefined)).toBe(current);
    expect(mergeCoverage(current, { details: 'pending' })).toBe(current);
  });
});

describe('markTopicSkipped', () => {
  it('marks a topic skipped without mutating the input', () => {
    const current = emptyCoverage();
    const next = markTopicSkipped(current, 'details');
    expect(next.details).toBe('skipped');
    expect(current.details).toBe('pending');
  });

  it('returns the same reference when already skipped', () => {
    const current = { ...emptyCoverage(), details: 'skipped' as const };
    expect(markTopicSkipped(current, 'details')).toBe(current);
  });
});

describe('isReadyToFinish', () => {
  it('requires a non-empty name', () => {
    expect(isReadyToFinish(emptyDraft())).toBe(false);
    expect(isReadyToFinish({ name: '   ', description: 'x' })).toBe(false);
    expect(isReadyToFinish({ name: 'Mara', description: '' })).toBe(true);
  });
});
