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
import { PROMPT_SECTION_DESCRIPTIONS, PROMPT_SECTION_LABELS } from './generationStore';

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

// ---------------------------------------------------------------------------
// PROMPT_SECTION_DESCRIPTIONS — review round 3, R3-G/F10. This table had NO
// test at all: `PromptOrderEditor.tsx` is its only consumer, and nothing
// renders that editor or imports the table in any test. The label test above
// pins WHERE Data Bank content moved to (World Info); this is task 5's other
// half — telling the user, section by section, that it's actually there. A
// `Record<PromptSectionId, string>` only type-checks key PRESENCE, so
// dropping the clarifier from one WI section (or reverting rag_context to
// its old "Data Bank chunks" claim) compiles clean and was invisible to the
// full suite before this file.
// ---------------------------------------------------------------------------

describe('PROMPT_SECTION_DESCRIPTIONS', () => {
  it('every World Info section names Data Bank documents as included — dropping it from even one is invisible without this test', () => {
    for (const id of ['wi_before_char', 'wi_after_char', 'wi_before_an', 'wi_after_an'] as const) {
      expect(PROMPT_SECTION_DESCRIPTIONS[id], id).toMatch(/\(incl\. Data Bank documents\)/);
    }
  });

  it("rag_context's description is chat-history recall, and does NOT claim Data Bank chunks (that content moved to World Info)", () => {
    expect(PROMPT_SECTION_DESCRIPTIONS.rag_context).toMatch(/older messages from this chat/i);
    expect(PROMPT_SECTION_DESCRIPTIONS.rag_context).not.toMatch(/data bank chunks/i);
  });

  it('pins the five descriptions task 5 actually changed, verbatim', () => {
    expect(PROMPT_SECTION_DESCRIPTIONS.wi_before_char).toBe(
      'World Info entries marked "before character" (incl. Data Bank documents).'
    );
    expect(PROMPT_SECTION_DESCRIPTIONS.wi_after_char).toBe(
      'World Info entries marked "after character" (incl. Data Bank documents).'
    );
    expect(PROMPT_SECTION_DESCRIPTIONS.wi_before_an).toBe(
      'World Info entries marked "before author note" (incl. Data Bank documents).'
    );
    expect(PROMPT_SECTION_DESCRIPTIONS.wi_after_an).toBe(
      'World Info entries marked "after author note" (after chat history) (incl. Data Bank documents).'
    );
    expect(PROMPT_SECTION_DESCRIPTIONS.rag_context).toBe(
      'Relevant older messages from this chat, retrieved semantically and re-injected. (Data Bank documents now arrive through the World Info sections.)'
    );
  });

  it('has an entry for every prompt section (key presence — a Record<PromptSectionId, string> catches a missing key, never a wrong value)', () => {
    expect(Object.keys(PROMPT_SECTION_DESCRIPTIONS)).toHaveLength(18);
  });
});
