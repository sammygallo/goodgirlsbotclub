import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../tokenizer';
import {
  detectFormatFinding,
  detectMacroFindings,
  detectExampleFindings,
  detectMissingFieldFindings,
  detectTokenFindings,
  detectLoreEmbeddedFinding,
  detectGreetingIssues,
  DESCRIPTION_WARNING_TOKENS,
  DESCRIPTION_ISSUE_TOKENS,
  PERSONALITY_WARNING_TOKENS,
  FIRST_MES_WARNING_TOKENS,
  MES_EXAMPLE_WARNING_TOKENS,
  CARD_WARNING_TOKENS,
  CARD_ISSUE_TOKENS,
} from './detectors';
import type { AnalyzableCardData } from './types';

/** Build filler text (no whitespace, no punctuation) whose estimateTokens
 *  value is exactly `target` — lets threshold tests land precisely on a
 *  boundary instead of guessing at char counts. */
function textWithTokens(target: number): string {
  let len = 0;
  while (estimateTokens('a'.repeat(len)) < target) len += 1;
  return 'a'.repeat(len);
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

// ===========================================================================
// detectFormatFinding
// ===========================================================================

describe('detectFormatFinding', () => {
  const WPP = `Personality("kind" + "curious")\nLikes("tea" + "rain")\nDislikes("liars" + "loud crowds")`;
  const PROSE =
    'Aria grew up in a small coastal town. She loves the smell of rain and reads by candlelight most evenings.';

  it('flags a structurally-formatted field with an ai/rewriteProse fix', () => {
    const card: AnalyzableCardData = { description: WPP, personality: PROSE };
    const findings = detectFormatFinding(card, 'wpp');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'format.wpp',
      field: 'description',
      fix: 'ai',
      aiPass: 'rewriteProse',
      severity: 'warning',
    });
  });

  it('does not flag prose fields', () => {
    const card: AnalyzableCardData = { description: PROSE };
    expect(detectFormatFinding(card, 'prose')).toEqual([]);
  });

  it('skips fields under 20 characters regardless of content', () => {
    const card: AnalyzableCardData = { scenario: 'Hi("there")' };
    expect(detectFormatFinding(card, 'unknown')).toEqual([]);
  });
});

// ===========================================================================
// detectMacroFindings
// ===========================================================================

describe('detectMacroFindings — legacy placeholder', () => {
  it('flags angle-bracket placeholders and counts occurrences', () => {
    const card: AnalyzableCardData = {
      description: 'Hello <USER>, meet <BOT>. <BOT> has been expecting you.',
    };
    const findings = detectMacroFindings(card, 'Aria');
    const finding = findings.find((f) => f.code === 'macro.legacy_placeholder');
    expect(finding).toBeDefined();
    expect(finding?.fix).toBe('deterministic');
    expect(finding?.metrics?.count).toBe(3);
  });

  it('flags bare single-brace placeholders', () => {
    const card: AnalyzableCardData = {
      first_mes: 'Hi {user}, this is {char} speaking.',
    };
    const findings = detectMacroFindings(card, 'Aria');
    const finding = findings.find((f) => f.code === 'macro.legacy_placeholder');
    expect(finding).toBeDefined();
    expect(finding?.field).toBe('first_mes');
    expect(finding?.metrics?.count).toBe(2);
  });

  it('does not flag the already-correct double-brace macros', () => {
    const card: AnalyzableCardData = {
      first_mes: 'Hi {{user}}, this is {{char}} speaking.',
    };
    const findings = detectMacroFindings(card, 'Aria');
    expect(codes(findings)).not.toContain('macro.legacy_placeholder');
  });
});

describe('detectMacroFindings — literal name instead of {{char}}', () => {
  it('flags a repeated literal name in narration fields', () => {
    const card: AnalyzableCardData = {
      description:
        'Ana walked slowly through the market stalls. Ana always stopped at the flower cart first.',
    };
    const findings = detectMacroFindings(card, 'Ana');
    const finding = findings.find((f) => f.code === 'macro.literal_name');
    expect(finding).toBeDefined();
    expect(finding?.field).toBe('description');
    expect(finding?.fix).toBe('deterministic');
    expect(finding?.metrics?.count).toBe(2);
  });

  it('does not miscount a name embedded in a longer word (word-boundary guard)', () => {
    // "Ana" appears twice as a whole word, and "banana"/"bananas" contain
    // "ana" as a bare substring — the word-boundary regex must not count
    // those.
    const card: AnalyzableCardData = {
      description:
        'Ana bought bananas at the market. Ana said the bananas reminded her of home.',
    };
    const findings = detectMacroFindings(card, 'Ana');
    const finding = findings.find((f) => f.code === 'macro.literal_name');
    expect(finding?.metrics?.count).toBe(2);
  });

  it('does not flag when {{char}} is already used in the field', () => {
    const card: AnalyzableCardData = {
      description: 'Ana walked in. Ana is {{char}}, technically, but the file still says Ana twice.',
    };
    const findings = detectMacroFindings(card, 'Ana');
    expect(codes(findings)).not.toContain('macro.literal_name');
  });

  it('never checks first_mes or mes_example, even with a repeated bare name', () => {
    const card: AnalyzableCardData = {
      first_mes: 'Ana smiles. Ana turns to leave without another word.',
      mes_example: 'Ana: Hello there.\nAna: Good to see you.',
    };
    const findings = detectMacroFindings(card, 'Ana');
    expect(codes(findings)).not.toContain('macro.literal_name');
  });

  it('skips names shorter than 3 characters', () => {
    const card: AnalyzableCardData = {
      description: 'Al walked in. Al sat down. Al said nothing else at all.',
    };
    const findings = detectMacroFindings(card, 'Al');
    expect(codes(findings)).not.toContain('macro.literal_name');
  });
});

// ===========================================================================
// detectExampleFindings
// ===========================================================================

describe('detectExampleFindings', () => {
  it('flags missing mes_example with an ai/generateField fix', () => {
    const findings = detectExampleFindings({});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'examples.missing',
      field: 'mes_example',
      fix: 'ai',
      aiPass: 'generateField',
    });
  });

  it('flags a single dialogue block missing <START> as deterministic-fixable', () => {
    const card: AnalyzableCardData = {
      mes_example:
        "{{char}}: I've been waiting for you.\n{{user}}: Sorry, traffic was bad.\n{{char}}: It's fine, come sit.",
    };
    const findings = detectExampleFindings(card);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'examples.no_start_blocks',
      fix: 'deterministic',
    });
    expect(findings[0].aiPass).toBeUndefined();
  });

  it('flags multiple blank-line-separated blocks missing <START> as ai-fixable', () => {
    const card: AnalyzableCardData = {
      mes_example:
        "{{char}}: I've been waiting for you.\n{{user}}: Sorry, traffic was bad.\n\n{{char}}: Would you like some tea?\n{{user}}: Yes, please.",
    };
    const findings = detectExampleFindings(card);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'examples.no_start_blocks',
      fix: 'ai',
      aiPass: 'restructureExamples',
    });
  });

  it('flags a <START> block with no dialogue-shaped lines underneath', () => {
    const card: AnalyzableCardData = {
      mes_example:
        '<START>\nAria walked into the room and looked around thoughtfully before saying nothing at all.',
    };
    const findings = detectExampleFindings(card);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'examples.malformed_lines',
      fix: 'ai',
      aiPass: 'restructureExamples',
    });
  });

  it('does not flag a well-formed <START> block with real dialogue lines', () => {
    const card: AnalyzableCardData = {
      mes_example: '<START>\n{{char}}: Hello there.\n{{user}}: Hi yourself.',
    };
    expect(detectExampleFindings(card)).toEqual([]);
  });
});

// ===========================================================================
// detectMissingFieldFindings
// ===========================================================================

describe('detectMissingFieldFindings', () => {
  it('flags all three when the card is empty', () => {
    const findings = detectMissingFieldFindings({});
    expect(codes(findings).sort()).toEqual(
      [
        'field.missing_description',
        'field.missing_first_mes',
        'field.missing_scenario',
      ].sort()
    );
  });

  it('uses issue severity for first_mes/description and info for scenario', () => {
    const findings = detectMissingFieldFindings({});
    const byCode = Object.fromEntries(findings.map((f) => [f.code, f.severity]));
    expect(byCode['field.missing_first_mes']).toBe('issue');
    expect(byCode['field.missing_description']).toBe('issue');
    expect(byCode['field.missing_scenario']).toBe('info');
  });

  it('does not flag fields that are present', () => {
    const card: AnalyzableCardData = {
      first_mes: 'Hello.',
      description: 'A quiet librarian.',
      scenario: 'A rainy afternoon.',
    };
    expect(detectMissingFieldFindings(card)).toEqual([]);
  });

  it('treats whitespace-only text as missing', () => {
    const card: AnalyzableCardData = { first_mes: '   \n  ' };
    const findings = detectMissingFieldFindings(card);
    expect(codes(findings)).toContain('field.missing_first_mes');
  });
});

// ===========================================================================
// detectTokenFindings
// ===========================================================================

describe('detectTokenFindings — description thresholds', () => {
  it('does not flag exactly at the warning boundary', () => {
    const card: AnalyzableCardData = { description: textWithTokens(DESCRIPTION_WARNING_TOKENS) };
    const { findings } = detectTokenFindings(card);
    expect(codes(findings)).not.toContain('tokens.field_bloat');
  });

  it('flags warning severity just past the boundary', () => {
    const card: AnalyzableCardData = {
      description: textWithTokens(DESCRIPTION_WARNING_TOKENS + 1),
    };
    const { findings } = detectTokenFindings(card);
    const finding = findings.find((f) => f.code === 'tokens.field_bloat');
    expect(finding?.severity).toBe('warning');
  });

  it('escalates to issue severity past the issue boundary, without duplicating the finding', () => {
    const card: AnalyzableCardData = {
      description: textWithTokens(DESCRIPTION_ISSUE_TOKENS + 1),
    };
    const { findings } = detectTokenFindings(card);
    const bloatFindings = findings.filter((f) => f.code === 'tokens.field_bloat');
    expect(bloatFindings).toHaveLength(1);
    expect(bloatFindings[0].severity).toBe('issue');
  });

  it('does not flag exactly at the issue boundary itself', () => {
    const card: AnalyzableCardData = { description: textWithTokens(DESCRIPTION_ISSUE_TOKENS) };
    const { findings } = detectTokenFindings(card);
    const finding = findings.find((f) => f.code === 'tokens.field_bloat');
    expect(finding?.severity).toBe('warning');
  });
});

describe('detectTokenFindings — other field thresholds', () => {
  it('flags personality past its warning boundary', () => {
    const card: AnalyzableCardData = {
      personality: textWithTokens(PERSONALITY_WARNING_TOKENS + 1),
    };
    const { findings } = detectTokenFindings(card);
    expect(findings.find((f) => f.code === 'tokens.field_bloat' && f.field === 'personality')).toBeDefined();
  });

  it('does not flag personality exactly at its warning boundary', () => {
    const card: AnalyzableCardData = { personality: textWithTokens(PERSONALITY_WARNING_TOKENS) };
    const { findings } = detectTokenFindings(card);
    expect(findings.find((f) => f.code === 'tokens.field_bloat' && f.field === 'personality')).toBeUndefined();
  });

  it('flags mes_example past its warning boundary', () => {
    const card: AnalyzableCardData = {
      mes_example: textWithTokens(MES_EXAMPLE_WARNING_TOKENS + 1),
    };
    const { findings } = detectTokenFindings(card);
    expect(findings.find((f) => f.code === 'tokens.field_bloat' && f.field === 'mes_example')).toBeDefined();
  });

  it('flags both tokens.field_bloat and greeting.overlong once first_mes crosses its boundary', () => {
    const card: AnalyzableCardData = {
      first_mes: textWithTokens(FIRST_MES_WARNING_TOKENS + 1),
    };
    const { findings } = detectTokenFindings(card);
    expect(codes(findings)).toContain('tokens.field_bloat');
    expect(codes(findings)).toContain('greeting.overlong');
    expect(findings.filter((f) => f.field === 'first_mes')).toHaveLength(2);
  });

  it('does not flag first_mes or greeting.overlong under the boundary', () => {
    const card: AnalyzableCardData = { first_mes: textWithTokens(FIRST_MES_WARNING_TOKENS) };
    const { findings } = detectTokenFindings(card);
    expect(codes(findings)).not.toContain('greeting.overlong');
    expect(codes(findings)).not.toContain('tokens.field_bloat');
  });
});

describe('detectTokenFindings — card total and fieldTokens/totalPermanentTokens', () => {
  it('excludes mes_example from totalPermanentTokens but still reports it in fieldTokens', () => {
    const card: AnalyzableCardData = { mes_example: textWithTokens(500) };
    const result = detectTokenFindings(card);
    expect(result.fieldTokens.mes_example).toBe(500);
    expect(result.totalPermanentTokens).toBe(0);
  });

  it('does not flag the card total exactly at the warning boundary', () => {
    const card: AnalyzableCardData = { system_prompt: textWithTokens(CARD_WARNING_TOKENS) };
    const { findings } = detectTokenFindings(card);
    expect(codes(findings)).not.toContain('tokens.card_bloat');
  });

  it('flags warning severity for the card total just past the warning boundary', () => {
    const card: AnalyzableCardData = { system_prompt: textWithTokens(CARD_WARNING_TOKENS + 1) };
    const { findings } = detectTokenFindings(card);
    const finding = findings.find((f) => f.code === 'tokens.card_bloat');
    expect(finding?.severity).toBe('warning');
    expect(finding?.field).toBe('card');
  });

  it('escalates to issue severity for the card total past the issue boundary, only once', () => {
    const card: AnalyzableCardData = { system_prompt: textWithTokens(CARD_ISSUE_TOKENS + 1) };
    const { findings } = detectTokenFindings(card);
    const bloatFindings = findings.filter((f) => f.code === 'tokens.card_bloat');
    expect(bloatFindings).toHaveLength(1);
    expect(bloatFindings[0].severity).toBe('issue');
  });
});

// ===========================================================================
// detectLoreEmbeddedFinding
// ===========================================================================

function paragraph(): string {
  return 'This part of the file talks about something that happened a long time ago in a place nobody visits anymore. '.repeat(
    10
  );
}

describe('detectLoreEmbeddedFinding', () => {
  it('does not flag a long description under the token floor', () => {
    const card: AnalyzableCardData = { description: 'A short description.'.repeat(5) };
    expect(detectLoreEmbeddedFinding(card)).toBeNull();
  });

  it('flags via the heading/label path', () => {
    const description = [
      '## Background',
      paragraph(),
      '## Family',
      paragraph(),
      '## Secrets',
      paragraph(),
    ].join('\n\n');
    expect(estimateTokens(description)).toBeGreaterThan(800);
    const finding = detectLoreEmbeddedFinding({ description });
    expect(finding).toMatchObject({
      code: 'lore.embedded_in_description',
      fix: 'ai',
      aiPass: 'extractLore',
    });
  });

  it('flags via the paragraph-count path when there are no headings', () => {
    const description = Array.from({ length: 6 }, () => paragraph()).join('\n\n');
    expect(estimateTokens(description)).toBeGreaterThan(800);
    const finding = detectLoreEmbeddedFinding({ description });
    expect(finding?.code).toBe('lore.embedded_in_description');
  });

  it('does not flag a long description with neither headings nor many paragraphs', () => {
    const description = paragraph().repeat(6); // one giant paragraph, no blank lines
    expect(estimateTokens(description)).toBeGreaterThan(800);
    expect(detectLoreEmbeddedFinding({ description })).toBeNull();
  });
});

// ===========================================================================
// detectGreetingIssues
// ===========================================================================

describe('detectGreetingIssues', () => {
  it('flags an explicit {{user}}: dialogue line', () => {
    const card: AnalyzableCardData = {
      first_mes: 'Aria grins. {{user}}: "I\'ve missed you," you say without thinking.',
    };
    const findings = detectGreetingIssues(card);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('greeting.speaks_for_user');
  });

  it('flags narrated user speech/action', () => {
    const card: AnalyzableCardData = {
      first_mes:
        'Aria leans in close. "I\'ve missed you," you say before you can stop yourself.',
    };
    const findings = detectGreetingIssues(card);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('greeting.speaks_for_user');
  });

  it('does not flag a normal greeting that leaves room for the reader', () => {
    const card: AnalyzableCardData = {
      first_mes: "Aria smiles warmly and gestures to the seat across from her. \"Sit, if you'd like.\"",
    };
    expect(detectGreetingIssues(card)).toEqual([]);
  });

  it('returns nothing for an empty first_mes', () => {
    expect(detectGreetingIssues({})).toEqual([]);
  });
});
