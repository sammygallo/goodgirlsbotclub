// Pure-code fixes for the subset of findings that don't need a model pass.
//
// applyDeterministicFix handles one Finding at a time; applyAllDeterministic
// Fixes composes every deterministic finding in a report, applying multiple
// fixes on the same field SEQUENTIALLY so their effects stack instead of
// each computing against the untouched original.

import type { AnalyzableCardData, CardTextField, Finding, FieldDiff } from './types';

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same patterns detectLegacyPlaceholderFindings uses to detect these — see
// detectors.ts for the false-positive reasoning (the brace form must not
// touch an already-correct `{{char}}`/`{{user}}`).
function replaceLegacyPlaceholders(text: string): string {
  return text
    .replace(/<bot>/gi, '{{char}}')
    .replace(/<char>/gi, '{{char}}')
    .replace(/<user>/gi, '{{user}}')
    .replace(/(?<!\{)\{bot\}(?!\})/gi, '{{char}}')
    .replace(/(?<!\{)\{char\}(?!\})/gi, '{{char}}')
    .replace(/(?<!\{)\{user\}(?!\})/gi, '{{user}}');
}

function replaceLiteralName(text: string, name: string): string {
  if (!name.trim()) return text;
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
  return text.replace(re, '{{char}}');
}

/**
 * Produce the FieldDiff for one deterministic finding, or null if this
 * finding's code isn't one this function handles (defensive — the caller
 * should only invoke this for findings whose `fix === 'deterministic'`) or
 * the finding is anchored to `'card'` rather than a real text field
 * (shouldn't happen for a deterministic fix given the current code
 * taxonomy, but there's nothing to rewrite if it does).
 */
export function applyDeterministicFix(
  finding: Finding,
  card: AnalyzableCardData,
  characterName: string
): FieldDiff | null {
  if (finding.field === 'card') return null;
  const field = finding.field as CardTextField;
  const original = card[field];
  const before = typeof original === 'string' ? original : '';

  switch (finding.code) {
    case 'macro.legacy_placeholder':
      return { field, before, after: replaceLegacyPlaceholders(before) };

    case 'macro.literal_name':
      return { field, before, after: replaceLiteralName(before, characterName) };

    case 'examples.no_start_blocks':
      if (finding.fix !== 'deterministic') return null;
      return { field, before, after: `<START>\n${before}` };

    default:
      return null;
  }
}

/**
 * Apply every deterministic-fix finding, composing fixes that land on the
 * same field SEQUENTIALLY: the second fix on a field operates on the
 * first fix's `after`, not the field's original text, so e.g. a
 * legacy-placeholder finding and a literal-name finding on the same
 * `description` both land in the returned diff rather than the second
 * one silently overwriting the first's work. `before` in the returned
 * diff is always the field's ORIGINAL text regardless of how many fixes
 * ran; `after` is the result of applying all of them in order.
 */
export function applyAllDeterministicFixes(
  findings: Finding[],
  card: AnalyzableCardData,
  characterName: string
): { diffs: FieldDiff[]; appliedFindingIds: string[] } {
  const deterministic = findings.filter((f) => f.fix === 'deterministic');

  const byField = new Map<CardTextField, Finding[]>();
  for (const finding of deterministic) {
    if (finding.field === 'card') continue;
    const field = finding.field as CardTextField;
    const list = byField.get(field);
    if (list) list.push(finding);
    else byField.set(field, [finding]);
  }

  const diffs: FieldDiff[] = [];
  const appliedFindingIds: string[] = [];

  for (const [field, fieldFindings] of byField) {
    const original = card[field];
    const before = typeof original === 'string' ? original : '';
    let current = before;

    for (const finding of fieldFindings) {
      // Feed each fix the PRIOR fix's output for this field, not the
      // untouched card, so effects compose instead of clobbering.
      const workingCard: AnalyzableCardData = { ...card, [field]: current };
      const diff = applyDeterministicFix(finding, workingCard, characterName);
      if (!diff) continue;
      current = diff.after;
      appliedFindingIds.push(finding.id);
    }

    if (current !== before) {
      diffs.push({ field, before, after: current });
    }
  }

  return { diffs, appliedFindingIds };
}
