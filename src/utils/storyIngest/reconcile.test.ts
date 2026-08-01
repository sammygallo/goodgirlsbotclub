import { describe, it, expect } from 'vitest';
import { WORLD_ENTITY, factEntities, groupFacts } from './reconcile';
import type { BibleFact, FactCategory } from '../../types/storyBible';
import type { KnownCastMember } from './transcriptWalk';

const CAST: KnownCastMember[] = [
  { id: 'char-ivy', name: 'Ivy', aliases: ['the archivist'] },
  { id: 'char-sam', name: 'Sam', aliases: [] },
  { id: 'char-al', name: 'Al', aliases: [] },
];

let seq = 0;
function fact(
  text: string,
  category: FactCategory = 'reveal',
  over: Partial<BibleFact> = {}
): BibleFact {
  return {
    id: `fact-${++seq}`,
    text,
    category,
    confidence: 'explicit',
    ...over,
  };
}

describe('factEntities', () => {
  it('matches a canonical name and an alias', () => {
    expect(factEntities(fact('Ivy hates the rain.'), CAST)).toEqual(['char-ivy']);
    expect(factEntities(fact('The archivist hates the rain.'), CAST)).toEqual([
      'char-ivy',
    ]);
  });

  it('returns every named character, for relationship facts', () => {
    const ids = factEntities(fact('Ivy resents Sam for leaving.'), CAST);
    expect(ids).toContain('char-ivy');
    expect(ids).toContain('char-sam');
  });

  it('does not match a name inside a longer word', () => {
    // The whole reason matching is boundary-aware: a two-letter alias like
    // "Al" substring-matches "already"/"also"/"always", which would
    // attribute half the story to the wrong character and manufacture
    // contradictions out of unrelated facts.
    expect(factEntities(fact('She had already left, and also lied.'), CAST)).toEqual(
      []
    );
    expect(factEntities(fact('Al had already left.'), CAST)).toEqual(['char-al']);
  });

  it('matches case-insensitively and across punctuation', () => {
    expect(factEntities(fact('"IVY," he said, "you lied."'), CAST)).toEqual([
      'char-ivy',
    ]);
  });

  it('returns nothing for a fact that names no one', () => {
    expect(factEntities(fact('The tide comes in at dusk.', 'world_rule'), CAST)).toEqual(
      []
    );
  });

  it('survives an alias containing regex metacharacters', () => {
    // Matching is a manual scan, not a built RegExp, so a card with an
    // alias like "Dr. (Ward)" cannot throw or silently change meaning.
    const odd: KnownCastMember[] = [
      { id: 'char-w', name: 'Dr. (Ward)', aliases: ['V*ex'] },
    ];
    expect(() => factEntities(fact('Dr. (Ward) arrived.'), odd)).not.toThrow();
    expect(factEntities(fact('Dr. (Ward) arrived.'), odd)).toEqual(['char-w']);
    expect(factEntities(fact('V*ex arrived.'), odd)).toEqual(['char-w']);
  });
});

describe('groupFacts', () => {
  it('groups by entity AND category, not entity alone', () => {
    const facts = [
      fact('Ivy has green eyes.', 'reveal'),
      fact('Ivy has grey eyes.', 'reveal'),
      fact('Ivy arrives in chapter one.', 'introduction'),
    ];
    const groups = groupFacts(facts, CAST);

    // The two reveals can conflict; the introduction is a different kind
    // of claim and is not a candidate against them.
    expect(groups).toHaveLength(1);
    expect(groups[0].entity).toBe('char-ivy');
    expect(groups[0].category).toBe('reveal');
    expect(groups[0].facts).toHaveLength(2);
  });

  it('drops singleton groups — one fact cannot contradict anything', () => {
    const groups = groupFacts([fact('Ivy has green eyes.')], CAST);
    expect(groups).toEqual([]);
  });

  it('puts a relationship fact in BOTH characters groups', () => {
    const facts = [
      fact('Ivy resents Sam.'),
      fact('Ivy adores Sam.'),
    ];
    const groups = groupFacts(facts, CAST);
    const entities = groups.map((g) => g.entity).sort();
    expect(entities).toEqual(['char-ivy', 'char-sam']);
    // Both groups hold both competing facts, so the conflict is findable
    // from either side.
    for (const g of groups) expect(g.facts).toHaveLength(2);
  });

  it('buckets unattributable facts under WORLD_ENTITY rather than guessing', () => {
    const facts = [
      fact('Magic requires a blood price.', 'world_rule'),
      fact('Magic is free to cast.', 'world_rule'),
    ];
    const groups = groupFacts(facts, CAST);
    expect(groups).toHaveLength(1);
    expect(groups[0].entity).toBe(WORLD_ENTITY);
  });

  it('does NOT attribute a fact via its scenes participants', () => {
    // established_in is deliberately ignored: a scene has many
    // participants while a fact is about one of them, so deriving the
    // subject from the scene fabricates attribution the text does not
    // support — and invites the judge to invent contradictions between
    // facts that were never about the same person.
    const facts = [
      fact('Someone had been lying the whole time.', 'reveal', {
        established_in: 'scene-1',
      }),
      fact('Nobody had lied at all.', 'reveal', { established_in: 'scene-1' }),
    ];
    const groups = groupFacts(facts, CAST);
    expect(groups).toHaveLength(1);
    expect(groups[0].entity).toBe(WORLD_ENTITY);
  });

  it('does not let a repeated fact id look like a self-contradiction', () => {
    // The fact log is append-only and paged; a row can legitimately be
    // read twice across a page boundary.
    const dup = fact('Ivy has green eyes.');
    const groups = groupFacts([dup, { ...dup }], CAST);
    expect(groups).toEqual([]);
  });

  it('is stable across runs over the same input', () => {
    const facts = [
      fact('Ivy has green eyes.'),
      fact('Sam has green eyes.'),
      fact('Ivy has grey eyes.'),
      fact('Sam has grey eyes.'),
    ];
    const a = groupFacts(facts, CAST);
    const b = groupFacts(facts, CAST);
    expect(a.map((g) => `${g.entity}/${g.category}`)).toEqual(
      b.map((g) => `${g.entity}/${g.category}`)
    );
    expect(a).toHaveLength(2);
  });

  it('ignores malformed entries instead of throwing', () => {
    const facts = [
      fact('Ivy has green eyes.'),
      fact('Ivy has grey eyes.'),
      { id: 'bad', category: 'reveal', confidence: 'explicit' } as unknown as BibleFact,
      null as unknown as BibleFact,
    ];
    expect(() => groupFacts(facts, CAST)).not.toThrow();
    expect(groupFacts(facts, CAST)[0].facts).toHaveLength(2);
  });

  it('handles an empty cast by sending everything to WORLD_ENTITY', () => {
    const facts = [fact('Ivy has green eyes.'), fact('Ivy has grey eyes.')];
    const groups = groupFacts(facts, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].entity).toBe(WORLD_ENTITY);
  });
});
