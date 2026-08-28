/**
 * E2-S2 task 5: the section labels shown in PromptOrderEditor and the
 * breakdown panel (#456).
 *
 * `PromptOrderEditor.tsx` interpolates a label into its move/enable
 * aria-labels (`Move ${label} up`), so two sections sharing a label make
 * those controls indistinguishable to a screen reader — pairwise uniqueness
 * is the load-bearing assertion here, not just "has 18 entries".
 */
import { describe, it, expect } from 'vitest';
import { PROMPT_SECTION_LABELS } from './generationStore';

describe('PROMPT_SECTION_LABELS', () => {
  it('has no two sections sharing a label', () => {
    const labels = Object.values(PROMPT_SECTION_LABELS);
    const seen = new Set<string>();
    for (const label of labels) {
      expect(seen.has(label), `duplicate label: "${label}"`).toBe(false);
      seen.add(label);
    }
    expect(seen.size).toBe(18);
  });

  it('pins the recall relabel (#456: Data Bank docs moved to World Info)', () => {
    expect(PROMPT_SECTION_LABELS.rag_context).toBe('Chat recall');
  });

  it('pins the World Info / Lorebooks relabel, positional discriminators intact', () => {
    expect(PROMPT_SECTION_LABELS.wi_before_char).toBe('World Info / Lorebooks — Before Char');
    expect(PROMPT_SECTION_LABELS.wi_after_char).toBe('World Info / Lorebooks — After Char');
    expect(PROMPT_SECTION_LABELS.wi_before_an).toBe('World Info / Lorebooks — Before Author Note');
    expect(PROMPT_SECTION_LABELS.wi_after_an).toBe('World Info / Lorebooks — After Author Note');
  });
});
