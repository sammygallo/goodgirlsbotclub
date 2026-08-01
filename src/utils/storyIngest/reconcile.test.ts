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

describe('names that are also ordinary words (review findings)', () => {
  const WILL: KnownCastMember[] = [{ id: 'char-will', name: 'Will', aliases: [] }];

  it('does not attribute a lowercase common word to a same-named character', () => {
    // Will, May, Rose, Grace, Dawn, Mark, Hope, Art are all ordinary
    // character names AND ordinary English words. Case-insensitive
    // matching handed every "he will leave" to a character named Will.
    expect(factEntities(fact('He will leave at dawn.'), WILL)).toEqual([]);
    expect(factEntities(fact('Will left at dawn.'), WILL)).toEqual(['char-will']);
  });

  it('does not let a common-word match displace the WORLD_ENTITY bucket', () => {
    // The severe half, and the silent one. A false attribution stops the
    // fact falling through to WORLD_ENTITY, so a real world-rule conflict
    // is never grouped and never reaches the judge. Nothing downstream
    // can recover it.
    const groups = groupFacts(
      [
        fact('Magic will always demand a blood price.', 'world_rule'),
        fact('Magic is free to cast.', 'world_rule'),
      ],
      WILL
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].entity).toBe(WORLD_ENTITY);
    expect(groups[0].facts).toHaveLength(2);
  });

  it('holds for a lowercase common noun matching a cast name', () => {
    expect(factEntities(fact('Poison ivy grows on the wall.'), CAST)).toEqual([]);
    expect(factEntities(fact('Ivy grows restless.'), CAST)).toEqual(['char-ivy']);
  });

  it('still matches a lowercase ALIAS, which carries no proper-noun signal', () => {
    // The capitalization rule keys off the NEEDLE's own casing, so a
    // deliberately lowercase alias is matched case-insensitively.
    expect(factEntities(fact('The archivist lied.'), CAST)).toEqual(['char-ivy']);
  });

  it('matches caseless scripts, which cannot satisfy a capitalization rule', () => {
    // A caseless name is exempted from the capitalization requirement —
    // without that exemption every CJK/kana cast member would silently
    // stop matching. Fact text is English prose (the walk prompts are),
    // so the name sits on ordinary word boundaries.
    const jp: KnownCastMember[] = [{ id: 'c-jp', name: '\u3072\u306a', aliases: [] }];
    expect(factEntities(fact('\u3072\u306a lied about the archive.'), jp)).toEqual([
      'c-jp',
    ]);
  });

  it('KNOWN LIMIT: a name embedded in space-less script is not matched', () => {
    // Documented, not accidental. The word-boundary rule is what stops
    // "Al" matching "already"; scripts without word separators put a
    // letter on both sides of every name, so the rule cannot fire. Such a
    // fact falls to WORLD_ENTITY — still grouped, still judged, just not
    // attributed. That is the same safe direction the rest of this module
    // fails in, and loosening the boundary rule for these scripts would
    // reintroduce exactly the over-matching it exists to prevent.
    const jp: KnownCastMember[] = [{ id: 'c-jp', name: '\u3072\u306a', aliases: [] }];
    expect(
      factEntities(fact('\u3072\u306a\u306f\u55e6\u3092\u3064\u3044\u305f\u3002'), jp)
    ).toEqual([]);
  });
});

describe('typographic and unicode skew (review findings)', () => {
  it('folds curly apostrophes so a card-typed name still matches model prose', () => {
    // Cards are typed with ASCII "'"; models emit U+2019. Without folding,
    // O'Brien is simply invisible and the fact is silently unattributed.
    const cast: KnownCastMember[] = [{ id: 'ob', name: "O'Brien", aliases: [] }];
    expect(factEntities(fact('O\u2019Brien lied.'), cast)).toEqual(['ob']);
    expect(factEntities(fact("O'Brien lied."), cast)).toEqual(['ob']);
  });

  it('treats accented neighbours as part of the word, independent of NFC/NFD', () => {
    // With an ASCII-only boundary class, "Jose" matched inside "Josee"
    // whenever the text happened to be precomposed — so attribution
    // depended on which normalization form each side used.
    const cast: KnownCastMember[] = [{ id: 'j', name: 'Jose', aliases: [] }];
    const nfc = 'Jos\u00e9e arrived.';
    const nfd = 'Jose\u0301e arrived.';
    expect(factEntities(fact(nfc), cast)).toEqual([]);
    expect(factEntities(fact(nfd), cast)).toEqual([]);
  });

  it('matches an accented name across normalization forms', () => {
    const cast: KnownCastMember[] = [{ id: 'j', name: 'Jos\u00e9', aliases: [] }];
    expect(factEntities(fact('Jose\u0301 arrived.'), cast)).toEqual(['j']);
  });
});

describe('overlapping cast names (review finding)', () => {
  it('the longer name claims the span, so the shorter one cannot re-match inside it', () => {
    // Sorting longest-first alone did nothing — without claiming the
    // matched span, "Ward" still matched inside "Mrs. Ward" and the fact
    // was attributed to two different characters at once.
    const cast: KnownCastMember[] = [
      { id: 'ward', name: 'Ward', aliases: [] },
      { id: 'mrsward', name: 'Mrs. Ward', aliases: [] },
    ];
    expect(factEntities(fact('Mrs. Ward arrived.'), cast)).toEqual(['mrsward']);
    // ...and a bare mention still resolves to the shorter one.
    expect(factEntities(fact('Ward arrived.'), cast)).toEqual(['ward']);
  });

  it('returns ids in CAST order regardless of mention order', () => {
    expect(factEntities(fact('Sam blamed Ivy.'), CAST)).toEqual(['char-ivy', 'char-sam']);
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
