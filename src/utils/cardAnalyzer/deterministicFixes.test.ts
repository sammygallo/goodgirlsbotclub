import { describe, it, expect } from 'vitest';
import { applyDeterministicFix, applyAllDeterministicFixes } from './deterministicFixes';
import { findingId } from './types';
import type { AnalyzableCardData, Finding } from './types';

function mkFinding(over: Partial<Finding> & Pick<Finding, 'code' | 'field'>): Finding {
  return {
    id: findingId(over.code, over.field),
    severity: 'warning',
    fix: 'deterministic',
    title: 'test finding',
    detail: 'test finding',
    ...over,
  };
}

// ===========================================================================
// applyDeterministicFix
// ===========================================================================

describe('applyDeterministicFix — macro.legacy_placeholder', () => {
  it('rewrites angle-bracket and bare-brace placeholders to real macros', () => {
    const card: AnalyzableCardData = {
      description: 'Hello <USER>, meet <BOT>. {char} is happy to see {user}.',
    };
    const finding = mkFinding({ code: 'macro.legacy_placeholder', field: 'description' });
    const diff = applyDeterministicFix(finding, card, 'Aria');
    expect(diff).not.toBeNull();
    expect(diff?.before).toBe(card.description);
    expect(diff?.after).toBe('Hello {{user}}, meet {{char}}. {{char}} is happy to see {{user}}.');
  });

  it('does not touch already-correct double-brace macros', () => {
    const card: AnalyzableCardData = { description: 'Hi {{user}}, this is {{char}}.' };
    const finding = mkFinding({ code: 'macro.legacy_placeholder', field: 'description' });
    const diff = applyDeterministicFix(finding, card, 'Aria');
    expect(diff?.after).toBe(card.description);
  });
});

describe('applyDeterministicFix — macro.literal_name', () => {
  it('replaces whole-word occurrences of the character name with {{char}}', () => {
    const card: AnalyzableCardData = {
      description: 'Ana walked in. Ana said hello, and the bananas on the table went unnoticed.',
    };
    const finding = mkFinding({ code: 'macro.literal_name', field: 'description' });
    const diff = applyDeterministicFix(finding, card, 'Ana');
    expect(diff?.after).toBe(
      '{{char}} walked in. {{char}} said hello, and the bananas on the table went unnoticed.'
    );
  });
});

describe('applyDeterministicFix — examples.no_start_blocks', () => {
  it('prepends a <START> marker when the finding was marked deterministic', () => {
    const card: AnalyzableCardData = { mes_example: '{{char}}: Hi.\n{{user}}: Hello.' };
    const finding = mkFinding({
      code: 'examples.no_start_blocks',
      field: 'mes_example',
      fix: 'deterministic',
    });
    const diff = applyDeterministicFix(finding, card, 'Aria');
    expect(diff?.after).toBe('<START>\n{{char}}: Hi.\n{{user}}: Hello.');
  });

  it('returns null if the finding was actually marked ai (defensive guard)', () => {
    const card: AnalyzableCardData = { mes_example: '{{char}}: Hi.' };
    const finding = mkFinding({
      code: 'examples.no_start_blocks',
      field: 'mes_example',
      fix: 'ai',
    });
    expect(applyDeterministicFix(finding, card, 'Aria')).toBeNull();
  });
});

describe('applyDeterministicFix — unhandled inputs', () => {
  it('returns null for a code this function does not handle', () => {
    const card: AnalyzableCardData = { first_mes: '' };
    const finding = mkFinding({
      code: 'field.missing_first_mes',
      field: 'first_mes',
      fix: 'ai',
    });
    expect(applyDeterministicFix(finding, card, 'Aria')).toBeNull();
  });

  it('returns null for a card-level finding', () => {
    const card: AnalyzableCardData = { system_prompt: 'x'.repeat(20000) };
    const finding = mkFinding({ code: 'tokens.card_bloat', field: 'card', fix: 'none' });
    expect(applyDeterministicFix(finding, card, 'Aria')).toBeNull();
  });
});

// ===========================================================================
// applyAllDeterministicFixes — sequential composition on the same field
// ===========================================================================

describe('applyAllDeterministicFixes', () => {
  it('composes a legacy-placeholder fix and a literal-name fix on the same field sequentially', () => {
    const card: AnalyzableCardData = {
      description: '<BOT> is also known as Ana. Ana greets everyone the same way.',
    };
    const findings: Finding[] = [
      mkFinding({ code: 'macro.legacy_placeholder', field: 'description' }),
      mkFinding({ code: 'macro.literal_name', field: 'description', severity: 'info' }),
    ];

    const { diffs, appliedFindingIds } = applyAllDeterministicFixes(findings, card, 'Ana');

    expect(diffs).toHaveLength(1);
    const diff = diffs[0];
    expect(diff.field).toBe('description');
    // `before` is the ORIGINAL text, not either fix's intermediate output.
    expect(diff.before).toBe(card.description);
    // The final text must have BOTH problems fixed, not just the first one
    // applied — this is the case a naive "apply each fix against the
    // original independently" implementation gets wrong.
    expect(diff.after).not.toMatch(/<BOT>/i);
    expect(diff.after).not.toMatch(/\bAna\b/);
    expect(diff.after).toBe(
      '{{char}} is also known as {{char}}. {{char}} greets everyone the same way.'
    );
    expect(appliedFindingIds).toEqual(
      expect.arrayContaining([
        findingId('macro.legacy_placeholder', 'description'),
        findingId('macro.literal_name', 'description'),
      ])
    );
  });

  it('produces the same composed result regardless of finding order', () => {
    const card: AnalyzableCardData = {
      description: '<BOT> is also known as Ana. Ana greets everyone the same way.',
    };
    const findings: Finding[] = [
      mkFinding({ code: 'macro.literal_name', field: 'description', severity: 'info' }),
      mkFinding({ code: 'macro.legacy_placeholder', field: 'description' }),
    ];

    const { diffs } = applyAllDeterministicFixes(findings, card, 'Ana');
    expect(diffs[0].after).toBe(
      '{{char}} is also known as {{char}}. {{char}} greets everyone the same way.'
    );
  });

  it('keeps fixes on different fields independent', () => {
    const card: AnalyzableCardData = {
      description: 'Ana smiles. Ana waves.',
      first_mes: 'Hello <USER>.',
    };
    const findings: Finding[] = [
      mkFinding({ code: 'macro.literal_name', field: 'description', severity: 'info' }),
      mkFinding({ code: 'macro.legacy_placeholder', field: 'first_mes' }),
    ];

    const { diffs } = applyAllDeterministicFixes(findings, card, 'Ana');
    expect(diffs).toHaveLength(2);
    const byField = Object.fromEntries(diffs.map((d) => [d.field, d.after]));
    expect(byField.description).toBe('{{char}} smiles. {{char}} waves.');
    expect(byField.first_mes).toBe('Hello {{user}}.');
  });

  it('ignores non-deterministic findings and produces no diff when nothing applies', () => {
    const card: AnalyzableCardData = { description: 'Just plain prose, nothing to fix here.' };
    const findings: Finding[] = [
      mkFinding({ code: 'format.wpp', field: 'description', fix: 'ai' }),
    ];
    const { diffs, appliedFindingIds } = applyAllDeterministicFixes(findings, card, 'Aria');
    expect(diffs).toEqual([]);
    expect(appliedFindingIds).toEqual([]);
  });
});
