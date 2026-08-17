import { describe, it, expect } from 'vitest';
import { avatarProvenanceAllowsSelfies } from './avatarProvenance';

describe('avatarProvenanceAllowsSelfies (the frontend selfie gate)', () => {
  it('clears fictional/AI provenance', () => {
    for (const p of ['generated', 'fictional-declared', 'grandfathered']) {
      expect(avatarProvenanceAllowsSelfies(p)).toBe(true);
    }
  });
  it('blocks uploaded/unknown and unrecognized values', () => {
    for (const p of ['uploaded', 'unknown', 'imported', 'bogus', '']) {
      expect(avatarProvenanceAllowsSelfies(p)).toBe(false);
    }
  });
  it('blocks null/undefined (older backend that never sent the field)', () => {
    expect(avatarProvenanceAllowsSelfies(null)).toBe(false);
    expect(avatarProvenanceAllowsSelfies(undefined)).toBe(false);
  });
});
