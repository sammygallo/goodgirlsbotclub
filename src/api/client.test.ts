import { describe, it, expect } from 'vitest';
import { isStoryManifestShape } from './client';

describe('isStoryManifestShape', () => {
  it('accepts a real manifest', () => {
    expect(
      isStoryManifestShape({
        project_id: 'p1',
        sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      })
    ).toBe(true);
  });

  it('accepts an empty-bible manifest (empty sections array)', () => {
    expect(
      isStoryManifestShape({
        project_id: 'p1',
        sections: [],
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      })
    ).toBe(true);
  });

  // Regression coverage for a reviewed bug: storyRestoreCall's 409 handler
  // used to adopt `detail.current` with only a compile-time TS cast, no
  // runtime check — a malformed body (version skew, a differently-shaped
  // error) got adopted straight into store state and crashed the next
  // hasBible()/`.sections` read. Every case below must be rejected.
  it('rejects a body missing sections', () => {
    expect(
      isStoryManifestShape({ scene_count: 0, fact_count: 0, edit_count: 0 })
    ).toBe(false);
  });

  it('rejects sections that is not an array', () => {
    expect(
      isStoryManifestShape({
        sections: 'meta',
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      })
    ).toBe(false);
  });

  it('rejects a body missing the count fields', () => {
    expect(isStoryManifestShape({ sections: [] })).toBe(false);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(isStoryManifestShape(null)).toBe(false);
    expect(isStoryManifestShape(undefined)).toBe(false);
    expect(isStoryManifestShape('current')).toBe(false);
    expect(isStoryManifestShape(42)).toBe(false);
    expect(isStoryManifestShape({})).toBe(false);
  });
});
