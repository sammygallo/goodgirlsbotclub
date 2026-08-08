import { describe, it, expect } from 'vitest';
import { normalizeCard } from './characterNormalize';
import type { CharacterCardV2, CharacterExportData } from './characterCard';

/** Minimal valid V2 card, all required string fields defaulted to ''. */
function makeV2Card(
  dataOverrides: Partial<CharacterCardV2['data']> = {}
): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '',
      description: '',
      personality: '',
      first_mes: '',
      scenario: '',
      mes_example: '',
      creator_notes: '',
      creator: '',
      tags: [],
      ...dataOverrides,
    },
  };
}

/** Minimal valid flat export card, all required string fields defaulted to ''. */
function makeExportData(
  overrides: Partial<CharacterExportData> = {}
): CharacterExportData {
  return {
    name: '',
    description: '',
    personality: '',
    first_mes: '',
    scenario: '',
    mes_example: '',
    creator_notes: '',
    creator: '',
    tags: [],
    ...overrides,
  };
}

/** Pull the field-bearing object out of either card shape. */
function fieldsOf(
  card: CharacterCardV2 | CharacterExportData
): CharacterCardV2['data'] | CharacterExportData {
  return 'spec' in card ? card.data : card;
}

describe('normalizeCard — line endings', () => {
  it('normalizes CRLF and lone CR to LF in a text field', () => {
    const card = makeExportData({
      name: 'Test',
      description: 'Line1\r\nLine2\rLine3\nLine4',
      first_mes: 'hi',
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).description).toBe('Line1\nLine2\nLine3\nLine4');
    expect(changes).toContain('Cleaned whitespace on 1 field');
  });
});

describe('normalizeCard — trailing whitespace', () => {
  it('strips trailing spaces/tabs on individual lines without touching interior text', () => {
    const card = makeExportData({
      name: 'Test',
      description: 'Line1   \nLine2\t\nLine3',
      first_mes: 'hi',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(fieldsOf(out).description).toBe('Line1\nLine2\nLine3');
  });
});

describe('normalizeCard — blank-line collapsing', () => {
  it('collapses 3+ consecutive blank lines to exactly one blank line', () => {
    const card = makeExportData({
      name: 'Test',
      description: 'Para1\n\n\n\nPara2',
      first_mes: 'hi',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(fieldsOf(out).description).toBe('Para1\n\nPara2');
  });

  it('trims leading and trailing blank lines from a field', () => {
    const card = makeExportData({
      name: 'Test',
      description: '\n\nFirst\nSecond\n\n',
      first_mes: 'hi',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(fieldsOf(out).description).toBe('First\nSecond');
  });
});

describe('normalizeCard — changes only count touched fields', () => {
  it('reports a field count that reflects only the field that actually changed', () => {
    const card = makeExportData({
      name: 'Test Character',
      description: 'Hello   \nWorld', // trailing spaces — needs cleanup
      personality: 'A clean and tidy personality.', // already clean
      first_mes: 'Hi there!', // already clean, no <START>
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).description).toBe('Hello\nWorld');
    expect(fieldsOf(out).personality).toBe('A clean and tidy personality.');
    expect(changes).toEqual(['Cleaned whitespace on 1 field']);
  });
});

describe('normalizeCard — stray <START> marker', () => {
  it('strips a leading <START> followed by a newline from first_mes and logs the change', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: '<START>\nHello there!',
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).first_mes).toBe('Hello there!');
    expect(changes).toContain('Removed stray <START> marker from first message');
  });

  it('strips a leading <START> with no trailing newline', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: '<START>Hi!',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(fieldsOf(out).first_mes).toBe('Hi!');
  });

  it('never touches <START> inside mes_example', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: '<START>\nGreeting',
      mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(fieldsOf(out).first_mes).toBe('Greeting');
    expect(fieldsOf(out).mes_example).toBe(
      '<START>\n{{user}}: Hi\n{{char}}: Hello'
    );
  });
});

describe('normalizeCard — tag dedup', () => {
  it('collapses tags that differ only in case, trims them, and reports the removed count', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      tags: ['Fantasy', 'fantasy', 'ROMANCE', 'romance', 'Adventure'],
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).tags).toEqual(['Fantasy', 'ROMANCE', 'Adventure']);
    expect(changes).toContain('Deduped / cleaned 2 tags');
  });

  it('drops non-string entries in the tags array silently', () => {
    const messyTags = [
      'Fantasy',
      42,
      'Romance',
      null,
      undefined,
      'fantasy',
    ] as unknown as string[];
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      tags: messyTags,
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).tags).toEqual(['Fantasy', 'Romance']);
    expect(changes).toContain('Deduped / cleaned 4 tags');
  });
});

describe('normalizeCard — standardizeFormatting: false', () => {
  it('leaves curly quotes, underscore italics, and typewriter dashes unchanged', () => {
    const text = '“Hello” she said, this is _italic_ text and a dash -- here.';
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description: text,
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: false,
    });

    expect(fieldsOf(out).description).toBe(text);
    expect(changes.some((c) => c.includes('Normalized formatting'))).toBe(
      false
    );
  });
});

describe('normalizeCard — standardizeFormatting: true', () => {
  it('converts curly double quotes to straight quotes', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description: '“Hello”',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: true });

    expect(fieldsOf(out).description).toBe('"Hello"');
  });

  it('converts _word_ to *word* at word boundaries without mangling snake_case', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description: 'a _word_ b, but snake_case_words stay put.',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: true });

    expect(fieldsOf(out).description).toBe(
      'a *word* b, but snake_case_words stay put.'
    );
  });

  it('collapses triple-or-more asterisks to single asterisks', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description: '***bold italic*** text',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: true });

    expect(fieldsOf(out).description).toBe('*bold italic* text');
  });

  it('converts a single-spaced double-dash to an em dash, preserving surrounding spaces', () => {
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description: 'word -- word.',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: true });

    expect(fieldsOf(out).description).toBe('word — word.');
  });

  it('applies all formatting conversions together and reports one field normalized', () => {
    const description = [
      '“Curly quotes” and _italic_ word, plus snake_case_words untouched.',
      '***bold italic*** and word -- word.',
    ].join('\n');
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      description,
    });
    const { card: out, changes } = normalizeCard(card, {
      standardizeFormatting: true,
    });

    expect(fieldsOf(out).description).toBe(
      [
        '"Curly quotes" and *italic* word, plus snake_case_words untouched.',
        '*bold italic* and word — word.',
      ].join('\n')
    );
    expect(changes).toContain('Normalized formatting on 1 field');
    expect(changes.some((c) => c.includes('Cleaned whitespace'))).toBe(false);
  });
});

describe('normalizeCard — warnings', () => {
  it('produces no warnings when name, description, first_mes, and personality are all present', () => {
    const card = makeExportData({
      name: 'Aria',
      description: 'A wandering bard.',
      personality: 'Cheerful and curious.',
      first_mes: 'Hello traveler!',
    });
    const { warnings } = normalizeCard(card, { standardizeFormatting: false });

    expect(warnings).toEqual([]);
  });

  it('reports every warning when name, description, personality, first_mes, and mes_example are all blank', () => {
    const card = makeExportData({
      name: '',
      description: '',
      personality: '',
      first_mes: '',
      mes_example: '',
    });
    const { warnings } = normalizeCard(card, { standardizeFormatting: false });

    expect(warnings).toEqual([
      'Character has no name',
      'Description and personality are both empty — the AI will struggle to play this character',
      'First message is empty',
      'No example messages or personality — consider adding some for better response quality',
    ]);
  });
});

describe('normalizeCard — V2 vs flat export shapes', () => {
  it('preserves spec/spec_version and data shape on a V2-shaped card while cleaning inner fields', () => {
    const card = makeV2Card({
      name: 'Aria',
      description: 'Line1\r\nLine2',
      creator: 'someone',
      tags: ['Tag'],
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect(out.spec).toBe('chara_card_v2');
    expect(out.spec_version).toBe('2.0');
    expect(out.data.description).toBe('Line1\nLine2');
    expect(out.data.creator).toBe('someone');
    expect(out.data.name).toBe('Aria');
  });

  it('works on a flat CharacterExportData-shaped card with fields at the top level', () => {
    const card = makeExportData({
      name: 'Aria',
      description: 'Line1\r\nLine2',
      creator: 'someone',
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect('spec' in out).toBe(false);
    expect(out.description).toBe('Line1\nLine2');
    expect(out.creator).toBe('someone');
    expect(out.name).toBe('Aria');
  });
});

describe('normalizeCard — alternate_greetings', () => {
  it('applies the same whitespace/formatting cleanup to each alternate greeting', () => {
    const messy = 'Hello!   \r\n\r\n\r\nGlad you are here.\n\n';
    const card = makeExportData({
      name: 'Test',
      first_mes: 'hi',
      alternate_greetings: [messy],
    });
    const { card: out } = normalizeCard(card, { standardizeFormatting: false });

    expect((fieldsOf(out) as CharacterExportData).alternate_greetings).toEqual([
      'Hello!\n\nGlad you are here.',
    ]);
  });
});
