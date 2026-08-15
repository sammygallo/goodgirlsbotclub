import { describe, it, expect } from 'vitest';
import { readUnitNotes } from './unitNotes';

/**
 * Reading a unit's continuity payload (step 3, phase 5).
 *
 * The rule this file exists to protect is a single one, and it is the one
 * the Phase 5 handoff notes call out by name: **"could not be read" is not
 * "clean."** Every default here has to fall toward uncertainty, because the
 * failure mode in the other direction is a reader telling a user their
 * chapter was checked against canon when nothing checked it.
 */

describe('readUnitNotes', () => {
  it('treats an absent payload as UNVERIFIED, not as clean', () => {
    expect(readUnitNotes(null).unreadable).toBe(true);
    expect(readUnitNotes(undefined).unreadable).toBe(true);
    expect(readUnitNotes({}).unreadable).toBe(true);
  });

  it('treats an unshaped payload as unverified', () => {
    // A half-written row from a crashed tab, or a payload from a future
    // writer. Neither is evidence that anything was checked.
    expect(readUnitNotes('nonsense').unreadable).toBe(true);
    expect(readUnitNotes([1, 2, 3]).unreadable).toBe(true);
    expect(readUnitNotes({ unreadable: 'no' }).unreadable).toBe(true);
  });

  it('reports clean ONLY on an explicit unreadable:false with no verdicts', () => {
    const notes = readUnitNotes({ unreadable: false, verdicts: [] });
    expect(notes.unreadable).toBe(false);
    expect(notes.verdicts).toEqual([]);
  });

  it('keeps verdicts that carry both halves of the contradiction', () => {
    const notes = readUnitNotes({
      unreadable: false,
      verdicts: [
        { factId: 'f1', claim: 'Ivy has green eyes', canon: 'They are grey', severity: 'major' },
        // Dropped: a verdict with no claim renders as a contradiction with
        // no detail, which is worse than not listing it at all.
        { factId: 'f2', canon: 'nothing to compare' },
      ],
    });
    expect(notes.verdicts).toHaveLength(1);
    expect(notes.verdicts[0].severity).toBe('major');
  });

  it('defaults an unrecognised severity to minor rather than dropping the verdict', () => {
    const notes = readUnitNotes({
      unreadable: false,
      verdicts: [{ claim: 'a', canon: 'b', severity: 'catastrophic' }],
    });
    expect(notes.verdicts[0].severity).toBe('minor');
  });

  it('carries the cap drops and the selector exclusions separately', () => {
    // §3.5 keeps these apart on purpose: a drop means "did not fit", an
    // exclusion means "not relevant here". They have different fixes.
    const notes = readUnitNotes({
      unreadable: false,
      drops: [{ kind: 'unattributed_facts', count: 4 }, { kind: 'bogus' }],
      rules_not_active: 7,
    });
    expect(notes.drops).toEqual([
      { kind: 'unattributed_facts', count: 4 },
      // An unknown kind survives with a count of 1 — a future drop kind
      // should read oddly, never vanish.
      { kind: 'bogus', count: 1 },
    ]);
    expect(notes.rulesNotActive).toBe(7);
  });

  it('distinguishes a refusal from a failed call', () => {
    // Different remedies: split the scene vs. try again.
    const refused = readUnitNotes({ refused: 'core_exceeds_cap', core_tokens: 30000 });
    expect(refused.failure).toMatch(/splitting it/i);

    const failed = readUnitNotes({ error: '429 rate limited' });
    expect(failed.failure).toMatch(/429 rate limited/);
  });

  it('reads the rule-selection caveats', () => {
    const notes = readUnitNotes({
      unreadable: false,
      caveats: { approximate: true, constantsOnly: false, unresolvedRules: 2 },
    });
    expect(notes.approximate).toBe(true);
    expect(notes.constantsOnly).toBe(false);
    expect(notes.unresolvedRules).toBe(2);
  });
});
