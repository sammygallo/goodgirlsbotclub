import { describe, it, expect } from 'vitest';
import { detectFieldFormat, detectSourceFormat } from './detectFormat';
import type { AnalyzableCardData } from './types';

// --- fixtures --------------------------------------------------------

const WPP_CONCAT = `Personality("kind" + "curious")
Likes("tea" + "rain")
Dislikes("liars" + "loud crowds")`;

const WPP_SIMPLE = `Personality("kind") Likes("tea") Dislikes("liars")`;

const WPP_BRACKET = `[character("Aria")]`;

const BOOSTYLE = `kind + curious + soft-spoken + stubborn`;

const PLIST = `[character: {name: Aria; age: 24; likes: tea, quiet mornings}]`;

const PROSE = `Aria grew up in a small coastal town. She loves the smell of rain and spends her evenings reading by candlelight. Her calm exterior hides a fierce independence.`;

const PROSE_2 = `Marlowe keeps the lighthouse on the northern point. He has not missed a night in eleven years, and he likes it that way.`;

const PROSE_3 = `A quiet, half-abandoned dock town where the fish market opens before dawn. Most visitors pass through without stopping.`;

const UNKNOWN_TEXT = `she moves like she owns every room she enters without ever raising her voice or her eyes`;

const UNKNOWN_TEXT_2 = `low steady footsteps down an empty hallway that never seems to end no matter how far you walk`;

const JSON_OBJECT = `{"name": "Aria", "age": 24, "likes": ["tea", "rain"]}`;

const JSON_FRAGMENT = `"name": "Aria", "age": 24, "likes": "tea"`;

// --- detectFieldFormat -------------------------------------------------

describe('detectFieldFormat — json', () => {
  it('detects a fully valid JSON object', () => {
    expect(detectFieldFormat(JSON_OBJECT)).toBe('json');
  });

  it('detects a JSON array', () => {
    expect(detectFieldFormat('["kind", "curious", "playful"]')).toBe('json');
  });

  it('detects a pasted JSON fragment that does not parse on its own', () => {
    expect(detectFieldFormat(JSON_FRAGMENT)).toBe('json');
  });

  it('does not flag prose that quotes a word before a colon once', () => {
    expect(
      detectFieldFormat(
        'Her rule is simple: "never apologize first." She has broken it exactly once, and she still will not talk about it.'
      )
    ).not.toBe('json');
  });
});

describe('detectFieldFormat — W++', () => {
  it('detects the concatenation form across multiple lines', () => {
    expect(detectFieldFormat(WPP_CONCAT)).toBe('wpp');
  });

  it('detects 3+ simple Key("value") calls', () => {
    expect(detectFieldFormat(WPP_SIMPLE)).toBe('wpp');
  });

  it('detects the [character(...)] envelope', () => {
    expect(detectFieldFormat(WPP_BRACKET)).toBe('wpp');
  });

  it('does not flag a single stray Key("value") call in prose', () => {
    const text =
      'Her file has one odd line: Note("see appendix"). Everything else about her is written normally, in full sentences.';
    expect(detectFieldFormat(text)).not.toBe('wpp');
  });
});

describe('detectFieldFormat — boostyle', () => {
  it('detects a keyword-list line joined by " + "', () => {
    expect(detectFieldFormat(BOOSTYLE)).toBe('boostyle');
  });

  it('does not flag prose that happens to contain a plus sign once', () => {
    const text =
      'She scored a 9 + 1 on the entrance exam, which nobody quite believed. Her teachers still bring it up.';
    expect(detectFieldFormat(text)).not.toBe('boostyle');
  });
});

describe('detectFieldFormat — PList', () => {
  it('detects a bracketed colon-tagged block', () => {
    expect(detectFieldFormat(PLIST)).toBe('plist');
  });

  it('does not flag a short bracketed aside', () => {
    expect(detectFieldFormat('[see notes]')).not.toBe('plist');
  });
});

describe('detectFieldFormat — prose', () => {
  it('detects ordinary multi-sentence prose', () => {
    expect(detectFieldFormat(PROSE)).toBe('prose');
  });

  it('treats short text as prose rather than unknown', () => {
    expect(detectFieldFormat('A quiet librarian.')).toBe('prose');
  });
});

describe('detectFieldFormat — unknown', () => {
  it('classifies long, periodless, non-structured text as unknown', () => {
    expect(detectFieldFormat(UNKNOWN_TEXT)).toBe('unknown');
  });
});

// --- detectSourceFormat --------------------------------------------------

describe('detectSourceFormat', () => {
  it('returns unknown when every field is empty', () => {
    const card: AnalyzableCardData = {};
    expect(detectSourceFormat(card)).toBe('unknown');
  });

  it('returns prose when every voting field reads as prose', () => {
    const card: AnalyzableCardData = {
      description: PROSE,
      personality: PROSE_2,
      scenario: PROSE_3,
    };
    expect(detectSourceFormat(card)).toBe('prose');
  });

  it('returns the shared verdict when every voting field agrees', () => {
    const card: AnalyzableCardData = {
      description: PLIST,
      personality: PLIST,
      scenario: PLIST,
    };
    expect(detectSourceFormat(card)).toBe('plist');
  });

  it('returns mixed when two different structured formats appear', () => {
    const card: AnalyzableCardData = {
      description: WPP_CONCAT,
      personality: BOOSTYLE,
    };
    expect(detectSourceFormat(card)).toBe('mixed');
  });

  it('returns the single structured verdict even when a sibling field is prose', () => {
    const card: AnalyzableCardData = {
      description: WPP_CONCAT,
      personality: PROSE_2,
    };
    expect(detectSourceFormat(card)).toBe('wpp');
  });

  it('returns unknown when every voting field is unknown', () => {
    const card: AnalyzableCardData = {
      description: UNKNOWN_TEXT,
      personality: UNKNOWN_TEXT_2,
    };
    expect(detectSourceFormat(card)).toBe('unknown');
  });

  it('skips whitespace-only fields rather than counting them as votes', () => {
    const card: AnalyzableCardData = {
      description: PLIST,
      personality: '   \n  ',
      scenario: PLIST,
    };
    expect(detectSourceFormat(card)).toBe('plist');
  });
});
