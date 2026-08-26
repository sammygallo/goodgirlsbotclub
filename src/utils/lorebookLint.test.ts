import { describe, it, expect } from 'vitest';
import {
  lintEntry,
  lintBook,
  lintDraftInBook,
  worstSeverity,
  BODY_TOKEN_TARGET,
  findNearDuplicates,
  DUPLICATE_SIMILARITY,
} from './lorebookLint';
import type { WorldInfoEntry } from '../stores/worldInfoStore';

let idCounter = 0;
function mkEntry(over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  idCounter += 1;
  return {
    id: `e${idCounter}`,
    keys: ['dragonspire'],
    content: 'The keep at Dragonspire burned three winters ago.',
    comment: '',
    enabled: true,
    constant: false,
    caseSensitive: false,
    position: 'before_char',
    depth: 4,
    order: 100,
    keysSecondary: [],
    selective: false,
    selectiveLogic: 'AND_ANY',
    scanDepth: null,
    probability: 100,
    useProbability: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    preventRecursion: false,
    excludeRecursion: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    critical: false,
    semanticOnly: false,
    category: 'world_rule',
    relatedIds: [],
    source: 'manual',
    revisions: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const codes = (entry: WorldInfoEntry) => lintEntry(entry).map((f) => f.code);

describe('lintEntry — entries that can never fire', () => {
  it('passes a well-formed entry with nothing to say', () => {
    expect(lintEntry(mkEntry())).toEqual([]);
  });

  it('flags empty content', () => {
    expect(codes(mkEntry({ content: '   ' }))).toContain('empty-content');
  });

  it('flags a selective entry with no keys', () => {
    expect(codes(mkEntry({ keys: [] }))).toContain('no-trigger');
  });

  it('does not flag a constant entry for having no keys', () => {
    expect(codes(mkEntry({ keys: [], constant: true }))).not.toContain(
      'no-trigger'
    );
  });

  it('does not flag a semanticOnly entry for having no keys', () => {
    // Auto-chunked Data Bank imports are keyless by design — they fire via
    // the server's semantic/FTS recall, not this client-side keyword scan.
    // Flagging them "can never fire" would be wrong, not just unhelpful.
    expect(codes(mkEntry({ keys: [], semanticOnly: true }))).not.toContain(
      'no-trigger'
    );
  });

  // E4-S0 / #450 F4 — the honest half of the finding above: server-side
  // matching is not "everywhere", and the lint used to say nothing at all.
  it('warns that a keyless semanticOnly entry cannot fire on local-scan turns', () => {
    const findings = lintEntry(mkEntry({ keys: [], semanticOnly: true }));
    const finding = findings.find((f) => f.code === 'semantic-only-not-everywhere');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toMatch(/group chats/i);
    expect(finding?.message).toMatch(/server-side/i);
  });

  it('stays quiet about semantic matching once the entry has keywords', () => {
    // With keys the entry matches in the local scan like any other, so the
    // "not everywhere" caveat no longer applies.
    expect(codes(mkEntry({ keys: ['ivy'], semanticOnly: true }))).not.toContain(
      'semantic-only-not-everywhere'
    );
  });

  it('calls out a critical entry with no trigger specifically', () => {
    const findings = lintEntry(mkEntry({ keys: [], critical: true }));
    const noTrigger = findings.find((f) => f.code === 'no-trigger');
    expect(noTrigger?.severity).toBe('error');
    expect(noTrigger?.message).toMatch(/critical/i);
  });

  it('flags a regex key that does not compile', () => {
    // The scanner falls back to substring-matching the literal "/[unclosed/",
    // which never appears in prose.
    expect(codes(mkEntry({ keys: ['/[unclosed/'] }))).toContain(
      'invalid-regex-key'
    );
  });

  it('accepts a regex key that compiles', () => {
    expect(codes(mkEntry({ keys: ['/dragon(spire|fire)/i'] }))).not.toContain(
      'invalid-regex-key'
    );
  });
});

describe('lintEntry — trigger quality', () => {
  it('flags keys too short to survive substring matching', () => {
    expect(codes(mkEntry({ keys: ['ka'] }))).toContain('short-key');
  });

  it('flags everyday words as keys', () => {
    expect(codes(mkEntry({ keys: ['the'] }))).toContain('stopword-key');
  });

  it('leaves a distinctive proper noun alone', () => {
    expect(codes(mkEntry({ keys: ['Dragonspire'] }))).toEqual([]);
  });

  it('flags a key made redundant by a shorter one in the same entry', () => {
    const findings = lintEntry(
      mkEntry({ keys: ['dragon', 'dragonspire keep'] })
    );
    const redundant = findings.find((f) => f.code === 'redundant-key');
    expect(redundant).toBeDefined();
    expect(redundant?.message).toContain('dragonspire keep');
  });

  it('does not call distinct keys redundant', () => {
    expect(codes(mkEntry({ keys: ['dragonspire', 'ashvale'] }))).toEqual([]);
  });

  it('flags a long speculative key list', () => {
    expect(
      codes(
        mkEntry({
          keys: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'],
        })
      )
    ).toContain('too-many-keys');
  });

  it('notes that a constant entry ignores its keys', () => {
    expect(codes(mkEntry({ constant: true, keys: ['dragonspire'] }))).toContain(
      'constant-keys-ignored'
    );
  });

  it('flags a duplicated key', () => {
    expect(
      codes(mkEntry({ keys: ['dragonspire', 'Dragonspire'] }))
    ).toContain('duplicate-key');
  });
});

describe('lintEntry — contradictory settings', () => {
  it('flags a critical entry gated on a dice roll', () => {
    expect(
      codes(mkEntry({ critical: true, useProbability: true, probability: 30 }))
    ).toContain('critical-probability');
  });

  it('accepts probability on a normal entry', () => {
    expect(
      codes(mkEntry({ useProbability: true, probability: 30 }))
    ).not.toContain('critical-probability');
  });

  it('notes secondary-key logic with no secondary keys', () => {
    expect(codes(mkEntry({ selective: true }))).toContain(
      'selective-without-secondary'
    );
  });

  it('flags a critical entry that can lose a group draw', () => {
    // resolveGroups has no critical exemption — losing the group means the
    // entry does not inject at all, defeating "never lose this".
    const findings = lintEntry(mkEntry({ critical: true, group: 'season' }));
    const finding = findings.find((f) => f.code === 'critical-in-group');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('season');
  });

  it('notes a constant entry competing in a group', () => {
    expect(codes(mkEntry({ constant: true, keys: [], group: 'season' })))
      .toContain('constant-in-group');
  });

  it('leaves an ordinary grouped entry alone', () => {
    expect(codes(mkEntry({ group: 'season' }))).toEqual([]);
  });
});

describe('lintEntry — leanness and housekeeping', () => {
  it('flags a body well over the token target', () => {
    const findings = lintEntry(mkEntry({ content: 'word '.repeat(400) }));
    const long = findings.find((f) => f.code === 'long-body');
    expect(long).toBeDefined();
    expect(long?.message).toContain(String(BODY_TOKEN_TARGET));
  });

  it('accepts a body inside the target', () => {
    expect(codes(mkEntry({ content: 'A short, dense fact about the keep.' })))
      .toEqual([]);
  });

  it('notes an untagged entry', () => {
    expect(codes(mkEntry({ category: '' }))).toContain('no-category');
  });
});

describe('lintBook', () => {
  it('reports nothing for a clean book', () => {
    expect(
      lintBook([
        mkEntry(),
        mkEntry({ keys: ['ashvale'], content: 'Ashvale pays no tithe to the crown.' }),
      ])
    ).toEqual([]);
  });

  it('flags near-duplicate bodies on every copy', () => {
    const a = mkEntry({ content: 'The keep burned down.' });
    const b = mkEntry({ keys: ['ashvale'], content: '  the keep BURNED down.  ' });
    const results = lintBook([a, b]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.findings.map((f) => f.code)).toContain('duplicate-entry');
    }
  });

  it('names the entry a duplicate collides with', () => {
    const a = mkEntry({ content: 'The keep burned down.', comment: 'Keep fire' });
    const b = mkEntry({ keys: ['ashvale'], content: 'The keep burned down.' });
    const finding = lintBook([a, b])
      .find((r) => r.entryId === b.id)!
      .findings.find((f) => f.code === 'duplicate-entry');
    expect(finding?.message).toContain('"Keep fire"');
  });

  it('flags related links pointing at missing entries', () => {
    const source = mkEntry({ relatedIds: ['ghost'] });
    const results = lintBook([source]);
    expect(results[0].findings.map((f) => f.code)).toContain(
      'dangling-related'
    );
  });

  it('agrees in number for one dangling link and for several', () => {
    const one = lintBook([mkEntry({ relatedIds: ['ghost'] })])[0].findings.find(
      (f) => f.code === 'dangling-related'
    );
    expect(one?.message).toBe(
      '1 related-entry link points at an entry that no longer exists.'
    );
    const many = lintBook([
      mkEntry({ relatedIds: ['ghost', 'wraith'] }),
    ])[0].findings.find((f) => f.code === 'dangling-related');
    expect(many?.message).toBe(
      '2 related-entry links point at entries that no longer exist.'
    );
  });

  it('flags related links pointing at disabled or empty entries', () => {
    const disabled = mkEntry({ keys: ['ashvale'], enabled: false, comment: 'Ashvale' });
    const source = mkEntry({ relatedIds: [disabled.id] });
    const results = lintBook([source, disabled]);
    const sourceResult = results.find((r) => r.entryId === source.id);
    const finding = sourceResult?.findings.find(
      (f) => f.code === 'inactive-related'
    );
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('Ashvale');
  });

  it('keeps per-entry findings alongside cross-entry ones', () => {
    const a = mkEntry({ content: 'Same text.', keys: ['the'] });
    const b = mkEntry({ content: 'Same text.', keys: ['ashvale'] });
    const results = lintBook([a, b]);
    const aCodes = results.find((r) => r.entryId === a.id)!.findings.map((f) => f.code);
    expect(aCodes).toContain('stopword-key');
    expect(aCodes).toContain('duplicate-entry');
  });
});

describe('lintBook — near-duplicate detection', () => {
  const dupes = (...contents: string[]) => {
    const es = contents.map((content, i) =>
      mkEntry({ content, keys: [`k${i}`], comment: `entry ${i}` })
    );
    const results = lintBook(es);
    return es.map((e) =>
      (results.find((r) => r.entryId === e.id)?.findings ?? []).some(
        (f) => f.code === 'duplicate-entry'
      )
    );
  };

  it('catches a restatement that diverges after the opening', () => {
    // The old fingerprint compared only the first 120 characters, so a pair
    // that reworded the tail read as two unrelated entries.
    expect(
      dupes(
        'The keep at Dragonspire burned three winters ago during the siege.',
        'Dragonspire keep burned down three winters ago, during the siege.'
      )
    ).toEqual([true, true]);
  });

  it('catches a reordered restatement of the same fact', () => {
    expect(
      dupes(
        'Seraphina lost her right hand to the Ashfall siege and writes left-handed.',
        'Writes left-handed: Seraphina lost her right hand during the Ashfall siege.'
      )
    ).toEqual([true, true]);
  });

  it('catches an entry wholly subsumed by a longer one', () => {
    // Containment, not similarity — the longer body is twice the length, so
    // intersection-over-union alone tops out below the threshold.
    expect(
      dupes(
        'Aldric shoes horses in the lower market.',
        'Aldric shoes horses in the lower market, owes the guard a favour, and drinks at the Rookery every night after closing.'
      )
    ).toEqual([true, true]);
  });

  it('leaves two different facts about the same subject alone', () => {
    expect(
      dupes(
        'Seraphina lost her right hand to the Ashfall siege.',
        'Seraphina commands the northern garrison.'
      )
    ).toEqual([false, false]);
  });

  it('does not call entries alike for sharing only stopwords', () => {
    expect(
      dupes(
        'The dragon was in the tower and it was very cold.',
        'The merchant was in the market and it was very loud.'
      )
    ).toEqual([false, false]);
  });

  it('does not let a very short entry be contained by everything', () => {
    // Under the containment floor: two content words would otherwise sit
    // inside any longer entry that happens to mention both.
    expect(
      dupes(
        'Ivy gardens.',
        'Ivy gardens behind the chapel, sells cuttings at market, and has never once been seen indoors before dusk.'
      )
    ).toEqual([false, false]);
  });

  it('still catches whitespace- and case-only differences', () => {
    expect(dupes('The keep burned down.', '  the KEEP burned   down.  ')).toEqual([
      true,
      true,
    ]);
  });

  it('ignores empty bodies rather than matching them to each other', () => {
    expect(dupes('', '')).toEqual([false, false]);
  });

  it('flags every member of a three-way pile-up', () => {
    expect(
      dupes(
        'The keep at Dragonspire burned three winters ago.',
        'Dragonspire keep burned three winters ago.',
        'Three winters ago the keep at Dragonspire burned.'
      )
    ).toEqual([true, true, true]);
  });

  it('stays fast enough for the editor to run per keystroke', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      mkEntry({
        keys: [`key${i}`],
        content: `Entry ${i} concerns the ${i} garrison at outpost ${i} and its supply line.`,
      })
    );
    const started = performance.now();
    lintBook(many);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('findNearDuplicates', () => {
  it('returns a restatement pair at or above the near-dup similarity threshold', () => {
    const original = mkEntry({
      content: 'The keep at Dragonspire burned three winters ago during the siege.',
    });
    const hits = findNearDuplicates(
      'Dragonspire keep burned down three winters ago, during the siege.',
      [original]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].entryId).toBe(original.id);
    expect(hits[0].score).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
  });

  it('catches a same-topic pair whose key claim is reversed despite heavy lexical overlap — this is the case Phase 4 exists for', () => {
    // Only "broken" vs "repaired" differs; every other word (subject, sword,
    // forge) is shared, so a lexical net alone (no semantics) still catches
    // this even though the two sentences assert opposite facts.
    const existing = mkEntry({
      content: 'Kestrel\'s sword lies broken after the forge accident last winter.',
    });
    const hits = findNearDuplicates(
      'Kestrel\'s sword lies repaired after the forge accident last winter.',
      [existing]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].entryId).toBe(existing.id);
    expect(hits[0].score).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
  });

  it('misses a same-subject pair with low overall lexical overlap — an accepted limitation of a lexical-only net (semantic overlap needs the LLM net, not this one)', () => {
    const existing = mkEntry({ content: 'Ivy is the gardener.' });
    const hits = findNearDuplicates('Ivy hates the rain.', [existing]);
    expect(hits).toEqual([]);
  });

  it('returns nothing for empty content', () => {
    const existing = mkEntry({ content: 'Some perfectly ordinary lore entry.' });
    expect(findNearDuplicates('', [existing])).toEqual([]);
  });

  it('returns nothing for content that tokenizes to zero meaningful words', () => {
    const existing = mkEntry({ content: 'Some perfectly ordinary lore entry.' });
    expect(findNearDuplicates('!!! --- ...', [existing])).toEqual([]);
  });

  it('sorts multiple hits descending by score', () => {
    const content = 'alpha bravo charlie delta echo foxtrot golf';
    // Near-total match (adds one word) — highest score.
    const closeMatch = mkEntry({
      keys: ['k1'],
      content: 'alpha bravo charlie delta echo foxtrot golf hotel',
    });
    // Wholly contained but much shorter — qualifies via containment, lower score.
    const contained = mkEntry({ keys: ['k2'], content: 'alpha bravo charlie delta' });
    // No meaningful overlap — not a hit at all.
    const unrelated = mkEntry({ keys: ['k3'], content: 'zulu yankee xray whiskey' });

    const hits = findNearDuplicates(content, [unrelated, contained, closeMatch]);

    expect(hits.map((h) => h.entryId)).toEqual([closeMatch.id, contained.id]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });
});

describe('lintDraftInBook', () => {
  it('reports the cross-entry rules lintEntry cannot see', () => {
    // The editor's panel used to call lintEntry, which returns nothing here —
    // while the list badge and health panel (both lintBook) flagged the entry.
    const draft = mkEntry({ relatedIds: ['ghost'] });
    expect(lintEntry(draft)).toEqual([]);
    expect(lintDraftInBook(draft, [draft]).map((f) => f.code)).toContain(
      'dangling-related'
    );
  });

  it('does not flag an unedited entry as a duplicate of its saved self', () => {
    const saved = mkEntry({ content: 'The keep burned down.' });
    // Same id, so the draft replaces the stored copy rather than joining it.
    expect(lintDraftInBook({ ...saved }, [saved])).toEqual([]);
  });

  it('flags a draft that duplicates a sibling', () => {
    const sibling = mkEntry({ content: 'The keep burned down.' });
    const draft = mkEntry({
      keys: ['ashvale'],
      content: '  the keep BURNED down.  ',
    });
    expect(lintDraftInBook(draft, [sibling]).map((f) => f.code)).toContain(
      'duplicate-entry'
    );
  });

  it('treats a brand-new draft as a sibling of every saved entry', () => {
    const sibling = mkEntry({ content: 'The keep burned down.' });
    // id 'draft' matches nothing in the book — the form's new-entry case.
    const draft = mkEntry({ id: 'draft', content: 'The keep burned down.' });
    expect(lintDraftInBook(draft, [sibling]).map((f) => f.code)).toContain(
      'duplicate-entry'
    );
  });

  it('resolves related links against the saved siblings', () => {
    const disabled = mkEntry({
      keys: ['ashvale'],
      enabled: false,
      comment: 'Ashvale',
    });
    const draft = mkEntry({ relatedIds: [disabled.id] });
    const codes = lintDraftInBook(draft, [disabled]).map((f) => f.code);
    expect(codes).toContain('inactive-related');
    expect(codes).not.toContain('dangling-related');
  });

  it('still reports the per-entry findings', () => {
    const draft = mkEntry({ keys: [] });
    expect(lintDraftInBook(draft, [draft]).map((f) => f.code)).toContain(
      'no-trigger'
    );
  });
});

describe('worstSeverity', () => {
  it('ranks error over warning over info', () => {
    expect(worstSeverity(lintEntry(mkEntry({ keys: [] })))).toBe('error');
    expect(worstSeverity(lintEntry(mkEntry({ keys: ['the'] })))).toBe('warning');
    expect(worstSeverity(lintEntry(mkEntry({ category: '' })))).toBe('info');
    expect(worstSeverity([])).toBeNull();
  });
});
