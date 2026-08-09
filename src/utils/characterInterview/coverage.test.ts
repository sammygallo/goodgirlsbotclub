import { describe, expect, it } from 'vitest';
import { isReadyToFinish, markTopicSkipped, mergeCoverage } from './coverage';
import { emptyCoverage, emptyDraft } from './types';
import type { CoverageState } from './types';

describe('mergeCoverage', () => {
  it('sets a pending topic to whatever the delta says', () => {
    const current = emptyCoverage();
    const next = mergeCoverage(current, { concept: 'partial' });
    expect(next.concept).toBe('partial');
    expect(next).not.toBe(current);
  });

  it('upgrades a partial topic to done', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'partial' };
    const next = mergeCoverage(current, { concept: 'done' });
    expect(next.concept).toBe('done');
  });

  it('never downgrades a done topic, even to another non-terminal status', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'done' };
    const next = mergeCoverage(current, { concept: 'partial' });
    expect(next.concept).toBe('done');
  });

  it('never overwrites a done topic even with another done', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'done' };
    const next = mergeCoverage(current, { concept: 'done' });
    expect(next).toBe(current); // no-op, same reference
  });

  it('never downgrades a skipped topic, including to done', () => {
    const current: CoverageState = { ...emptyCoverage(), world: 'skipped' };
    const next = mergeCoverage(current, { world: 'done' });
    expect(next.world).toBe('skipped');
  });

  it('allows a non-terminal topic to move to skipped via delta', () => {
    const current: CoverageState = { ...emptyCoverage(), world: 'partial' };
    const next = mergeCoverage(current, { world: 'skipped' });
    expect(next.world).toBe('skipped');
  });

  it('applies only the topics present in the delta, leaving others untouched', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'done' };
    const next = mergeCoverage(current, { identity: 'partial' });
    expect(next.concept).toBe('done');
    expect(next.identity).toBe('partial');
  });

  it('returns the same reference when delta is undefined', () => {
    const current = emptyCoverage();
    expect(mergeCoverage(current, undefined)).toBe(current);
  });

  it('returns the same reference when delta is empty', () => {
    const current = emptyCoverage();
    expect(mergeCoverage(current, {})).toBe(current);
  });

  it('returns the same reference when every topic in the delta is already terminal', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'done', world: 'skipped' };
    const next = mergeCoverage(current, { concept: 'partial', world: 'done' });
    expect(next).toBe(current);
  });

  it('returns the same reference when the delta value matches the current value', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'partial' };
    const next = mergeCoverage(current, { concept: 'partial' });
    expect(next).toBe(current);
  });

  it('does not mutate the input current object', () => {
    const current = emptyCoverage();
    const snapshot = { ...current };
    mergeCoverage(current, { concept: 'done' });
    expect(current).toEqual(snapshot);
  });

  it('handles a mixed delta: one terminal-blocked, one applied', () => {
    const current: CoverageState = { ...emptyCoverage(), concept: 'done', identity: 'pending' };
    const next = mergeCoverage(current, { concept: 'skipped', identity: 'partial' });
    expect(next.concept).toBe('done');
    expect(next.identity).toBe('partial');
    expect(next).not.toBe(current);
  });
});

describe('markTopicSkipped', () => {
  it('sets a pending topic to skipped', () => {
    const current = emptyCoverage();
    const next = markTopicSkipped(current, 'world');
    expect(next.world).toBe('skipped');
    expect(next).not.toBe(current);
  });

  it('overwrites a done topic with skipped (unconditional)', () => {
    const current: CoverageState = { ...emptyCoverage(), world: 'done' };
    const next = markTopicSkipped(current, 'world');
    expect(next.world).toBe('skipped');
  });

  it('returns the same reference when already skipped', () => {
    const current: CoverageState = { ...emptyCoverage(), world: 'skipped' };
    const next = markTopicSkipped(current, 'world');
    expect(next).toBe(current);
  });

  it('does not mutate the input current object', () => {
    const current = emptyCoverage();
    const snapshot = { ...current };
    markTopicSkipped(current, 'world');
    expect(current).toEqual(snapshot);
  });
});

describe('isReadyToFinish', () => {
  it('is false for a completely empty draft', () => {
    expect(isReadyToFinish(emptyDraft())).toBe(false);
  });

  it('is false with only a name', () => {
    expect(isReadyToFinish({ ...emptyDraft(), name: 'Aria' })).toBe(false);
  });

  it('is false with only a description', () => {
    expect(isReadyToFinish({ ...emptyDraft(), description: 'A knight.' })).toBe(false);
  });

  it('is false when name is whitespace-only', () => {
    expect(isReadyToFinish({ ...emptyDraft(), name: '   ', description: 'A knight.' })).toBe(false);
  });

  it('is true with both name and description non-empty', () => {
    expect(isReadyToFinish({ ...emptyDraft(), name: 'Aria', description: 'A knight.' })).toBe(true);
  });
});
