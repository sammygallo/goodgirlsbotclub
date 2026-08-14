import { describe, it, expect } from 'vitest';
import { selectWorldRules, sceneWindow } from './ruleSelector';
import type { ReplayEntry } from '../storyIngest/wiReplay';
import type { IngestMessage } from '../storyIngest/types';
import type { WorldRule } from '../../types/storyBible';

function msg(over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id: 'm',
    name: 'Ivy',
    isUser: false,
    isSystem: false,
    content: '',
    timestamp: 0,
    swipeIdx: 0,
    swipesCount: 1,
    ...over,
  };
}

function entry(over: Partial<ReplayEntry> = {}): ReplayEntry {
  return {
    id: 'e1',
    bookId: 'b1',
    keys: ['lantern'],
    content: 'The lanterns burn cold.',
    enabled: true,
    constant: false,
    caseSensitive: false,
    relatedIds: [],
    ...over,
  };
}

function rule(bookId: string, entryId: string, text = 'a rule'): WorldRule {
  return {
    id: `rule-${entryId}`,
    text,
    category: 'other',
    source: {
      kind: 'lorebook_entry',
      ref: { book_id: bookId, entry_id: entryId },
      snapshot: {},
      captured_at: 'x',
    } as WorldRule['source'],
    confidence: 'inferred',
    established_in: null,
  };
}

describe('selectWorldRules', () => {
  it('includes a rule whose entry key appears in the window', () => {
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry()],
      window: [
        msg({ id: 'm0', isUser: true, content: 'I lift the lantern.' }),
        msg({ id: 'm1', content: 'It gutters.' }),
      ],
    });
    expect(out.included).toHaveLength(1);
    expect(out.nonFiring).toHaveLength(0);
  });

  it('excludes a rule whose key never appears', () => {
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry()],
      window: [
        msg({ id: 'm0', isUser: true, content: 'Nothing relevant.' }),
        msg({ id: 'm1', content: 'Still nothing.' }),
      ],
    });
    expect(out.included).toHaveLength(0);
    expect(out.nonFiring).toHaveLength(1);
  });

  it('includes a constant entry’s rule even with NO AI turn in the window', () => {
    // The case the plan calls out: `wiReplay`'s `entry.constant ||` test
    // sits INSIDE the AI-turn loop, so a scene of pure user messages
    // fires nothing at all — constants included. Relying on the replay
    // for constants would silently drop always-on lore from exactly
    // those scenes.
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry({ constant: true, keys: [] })],
      window: [
        msg({ id: 'm0', isUser: true, content: 'a' }),
        msg({ id: 'm1', isUser: true, content: 'b' }),
      ],
    });
    expect(out.included).toHaveLength(1);
    expect(out.caveats.constantsOnly).toBe(true);
  });

  it('reports constantsOnly so the caller can say the scan did not run', () => {
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry()],
      window: [msg({ id: 'm0', isUser: true, content: 'lantern' })],
    });
    // The key IS present, but there is no AI turn to anchor a scan to —
    // "we could not check" rather than "we checked and it did not fire".
    expect(out.caveats.constantsOnly).toBe(true);
    expect(out.included).toHaveLength(0);
  });

  it('counts a rule whose entry is no longer in the book set', () => {
    // `booksForChat` recomputes from CURRENT app state, so a detached or
    // deleted book is reachable in normal use. Its `constant` flag is
    // unknowable, so the constants floor cannot cover it.
    const out = selectWorldRules({
      rules: [rule('b-gone', 'e-gone')],
      entries: [entry()],
      window: [msg({ id: 'm1', content: 'lantern' })],
    });
    expect(out.caveats.unresolvedRules).toBe(1);
    expect(out.nonFiring).toHaveLength(1);
  });

  it('keeps a rule that is not lorebook-derived rather than dropping it', () => {
    const handWritten: WorldRule = {
      ...rule('b1', 'e1'),
      source: { kind: 'user_annotation', snapshot: {}, captured_at: 'x' } as WorldRule['source'],
    };
    const out = selectWorldRules({
      rules: [handWritten],
      entries: [entry()],
      window: [msg({ id: 'm1', content: 'nothing' })],
    });
    expect(out.included).toHaveLength(1);
  });

  it('does NOT read secondary keys', () => {
    // Declared on ReplayEntry and populated, but never read by the hit
    // test. Adding support would pull in selective/selectiveLogic and
    // change shipped replay results everywhere, including ingestion's.
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry({ keys: ['nope'], secondaryKeys: ['lantern'] })],
      window: [
        msg({ id: 'm0', isUser: true, content: 'the lantern' }),
        msg({ id: 'm1', content: 'x' }),
      ],
    });
    expect(out.included).toHaveLength(0);
  });

  it('marks the selection approximate when the scanner contributed', () => {
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry()],
      window: [
        msg({ id: 'm0', isUser: true, content: 'lantern' }),
        msg({ id: 'm1', content: 'x' }),
      ],
    });
    expect(out.caveats.approximate).toBe(true);
  });
});

describe('sceneWindow', () => {
  const transcript = [
    msg({ id: 'm0', content: 'zero' }),
    msg({ id: 'm1', content: 'one' }),
    msg({ id: 'm2', content: 'two' }),
    msg({ id: 'm3', content: 'three' }),
    msg({ id: 'm4', content: 'four' }),
  ];

  it('includes the preceding scanDepth messages', () => {
    // Mandatory, not a nicety: the scanner scans BACKWARDS from each AI
    // turn, so without the overlap the first AI turn of every scene is
    // scanned against a truncated window.
    const w = sceneWindow(transcript, 'm2', 'm3', 2);
    expect(w.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('clamps at the start of the transcript', () => {
    expect(sceneWindow(transcript, 'm0', 'm1', 2).map((m) => m.id)).toEqual(['m0', 'm1']);
  });

  it('returns EMPTY when an anchor is missing rather than the whole chat', () => {
    // Over-inclusion here would put unrelated lore in the brief and evict
    // real content under the cap.
    expect(sceneWindow(transcript, 'gone', 'm3', 2)).toEqual([]);
    expect(sceneWindow(transcript, 'm1', 'gone', 2)).toEqual([]);
  });

  it('returns empty for an inverted range', () => {
    expect(sceneWindow(transcript, 'm3', 'm1', 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial review findings (confirmed)
// ---------------------------------------------------------------------------

describe('the constants floor respects the scanner’s own active filter', () => {
  it('does NOT include a DISABLED constant entry’s rule', () => {
    // The two routes disagreed: a disabled keyword entry correctly cannot
    // fire (it never reaches `active` in wiReplay), while a disabled
    // CONSTANT entry was force-included — into the one category the
    // assembler drops last. Lore the user switched off displaced rules
    // that actually fired.
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry({ constant: true, enabled: false, keys: [] })],
      window: [msg({ id: 'm1', content: 'anything' })],
    });
    expect(out.included).toHaveLength(0);
    expect(out.nonFiring).toHaveLength(1);
  });

  it('does NOT include a constant entry with empty content', () => {
    // wiReplay's `active` filter excludes these too.
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry({ constant: true, content: '   ', keys: [] })],
      window: [msg({ id: 'm1', content: 'anything' })],
    });
    expect(out.included).toHaveLength(0);
  });

  it('still includes an ENABLED constant entry’s rule', () => {
    const out = selectWorldRules({
      rules: [rule('b1', 'e1')],
      entries: [entry({ constant: true, enabled: true, keys: [] })],
      window: [msg({ id: 'm1', content: 'anything' })],
    });
    expect(out.included).toHaveLength(1);
  });
});

describe('sceneWindow counts the overlap in scannable messages', () => {
  it('skips system messages when counting back, matching wiReplay', () => {
    // wiReplay filters system messages out BEFORE slicing its scanDepth
    // window. Counting raw indices here made the overlap silently short —
    // zero effective messages when the preceding rows were system ones,
    // which is the truncated window the overlap exists to prevent.
    const transcript = [
      msg({ id: 'm0', content: 'real one' }),
      msg({ id: 'm1', content: 'real two' }),
      msg({ id: 'sys1', isSystem: true, content: 'system' }),
      msg({ id: 'sys2', isSystem: true, content: 'system' }),
      msg({ id: 'm2', content: 'scene start' }),
      msg({ id: 'm3', content: 'scene end' }),
    ];
    const w = sceneWindow(transcript, 'm2', 'm3', 2);
    const scannable = w.filter((m) => !m.isSystem).map((m) => m.id);
    // Two REAL messages of lead-in, not two rows of system noise.
    expect(scannable).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('still clamps at the start of the transcript', () => {
    const transcript = [
      msg({ id: 'sys', isSystem: true, content: 's' }),
      msg({ id: 'm0', content: 'a' }),
      msg({ id: 'm1', content: 'b' }),
    ];
    expect(sceneWindow(transcript, 'm0', 'm1', 5).map((m) => m.id)).toEqual([
      'sys',
      'm0',
      'm1',
    ]);
  });
});
