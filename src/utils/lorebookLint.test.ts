import { describe, it, expect } from 'vitest';
import {
  lintEntry,
  lintBook,
  worstSeverity,
  BODY_TOKEN_TARGET,
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
    category: 'world_rule',
    relatedIds: [],
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

  it('flags related links pointing at missing entries', () => {
    const source = mkEntry({ relatedIds: ['ghost'] });
    const results = lintBook([source]);
    expect(results[0].findings.map((f) => f.code)).toContain(
      'dangling-related'
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

describe('worstSeverity', () => {
  it('ranks error over warning over info', () => {
    expect(worstSeverity(lintEntry(mkEntry({ keys: [] })))).toBe('error');
    expect(worstSeverity(lintEntry(mkEntry({ keys: ['the'] })))).toBe('warning');
    expect(worstSeverity(lintEntry(mkEntry({ category: '' })))).toBe('info');
    expect(worstSeverity([])).toBeNull();
  });
});
