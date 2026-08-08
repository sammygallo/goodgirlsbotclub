// Card-analyzer AI-fix prompts.
//
// Every SYSTEM prompt below opens with HOUSE_STYLE_SYSTEM_PREFIX (fiction
// preamble + the style guide) so a card fixed here, one fixed by hand, and
// one drafted by the creation wizard's interview all converge on the same
// conventions — see characterStyle.ts for why that module is the single
// source of truth. Builder functions stay small and structured (name in,
// prompt string out) rather than free-form string concatenation at the
// call site, matching storyIngest/prompts.ts's convention.

import { HOUSE_STYLE_SYSTEM_PREFIX } from '../characterStyle';
import type { AnalyzableCardData, CardTextField } from './types';

// Bumped whenever any prompt below changes in a way that would alter a
// model's output — stamp into AI-fix provenance so a diff can be traced to
// the prompt version that produced it (mirrors storyIngest's PROMPT_VERSION
// and characterStyle's CHARACTER_STYLE_VERSION).
export const CARD_FIX_PROMPT_VERSION = 'cardfix-v1';

const FIELD_LABELS: Record<CardTextField, string> = {
  description: 'Description',
  personality: 'Personality',
  first_mes: 'First Message',
  scenario: 'Scenario',
  mes_example: 'Example Messages',
  creator_notes: 'Creator Notes',
  system_prompt: 'System Prompt',
  post_history_instructions: 'Post-History Instructions',
};

// Order the "what's already known" context block is built in for
// generateFieldPrompt — most character-defining fields first.
const CARD_FIELD_ORDER: CardTextField[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
];

// ---------------------------------------------------------------------------
// 1. rewriteProse — reformat a bracketed/keyword/list field into prose.
// ---------------------------------------------------------------------------

export const REWRITE_PROSE_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You rewrite a single character-card field out of a bracketed/keyword/list format (W++, PList, boostyle, raw JSON) into third-person prose that matches house style. Preserve every fact stated in the original — add nothing, remove nothing, just reformat. Output ONLY the rewritten field text — no preamble, no markdown fences, no surrounding quotes.`;

export function rewriteProsePrompt(
  field: CardTextField,
  text: string,
  cardContext: { name?: string }
): string {
  return `Character: ${cardContext.name || '(unnamed)'}
Field: ${FIELD_LABELS[field]}

Current text:
${text}

Rewritten ${FIELD_LABELS[field]} (prose, house style):`;
}

// ---------------------------------------------------------------------------
// 2. macroNormalize — swap literal names for {{char}}/{{user}}.
// ---------------------------------------------------------------------------

export const MACRO_NORMALIZE_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You normalize macro usage in a single character-card field. Replace the character's literal name with {{char}} wherever it denotes the character as speaker or subject — but preserve a legitimate third-person mention that isn't standing in for the macro (a narrator naming the character once for clarity in a longer paragraph is fine; a field that never uses {{char}} at all despite constantly repeating the name is not). Similarly replace a persona name, or "the user"/"the reader" phrasing, that stands in for the person the character is talking to with {{user}}. Do not otherwise change the wording. Output ONLY the rewritten field text — no preamble, no markdown fences, no surrounding quotes.`;

export function macroNormalizePrompt(
  field: CardTextField,
  text: string,
  characterName: string
): string {
  return `Character name: ${characterName || '(unnamed)'}
Field: ${FIELD_LABELS[field]}

Current text:
${text}

Rewritten ${FIELD_LABELS[field]} (macros normalized):`;
}

// ---------------------------------------------------------------------------
// 3. restructureExamples — rebuild mes_example into <START> blocks.
// ---------------------------------------------------------------------------

export const RESTRUCTURE_EXAMPLES_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You restructure a character card's example dialogue into house style: one or more <START> blocks, each a short back-and-forth with lines written exactly as "{{user}}: ..." and "{{char}}: ...". This is a structural reformat only — preserve the actual dialogue content and wording as closely as possible, do not invent new lines, drop exchanges, or change what is said. Output ONLY the restructured text — no preamble, no markdown fences, no surrounding quotes.`;

export function restructureExamplesPrompt(text: string, characterName: string): string {
  return `Character name: ${characterName || '(unnamed)'}

Current example dialogue:
${text}

Restructured example dialogue (<START> blocks, house style):`;
}

// ---------------------------------------------------------------------------
// 4. generateField — draft a missing field from the rest of the card.
// ---------------------------------------------------------------------------

export const GENERATE_FIELD_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You draft a single missing character-card field using the rest of the card as context. Match the character's established tone and voice, follow house style for the field you're drafting, and don't contradict anything the other fields already state. Output ONLY the field's content — no preamble, no field label, no markdown fences, no surrounding quotes.`;

function buildCardContext(card: AnalyzableCardData, exclude: CardTextField): string {
  const lines: string[] = [];
  for (const key of CARD_FIELD_ORDER) {
    if (key === exclude) continue;
    const value = card[key]?.trim();
    if (value) lines.push(`${FIELD_LABELS[key]}:\n${value}`);
  }
  return lines.join('\n\n');
}

export function generateFieldPrompt(field: CardTextField, card: AnalyzableCardData): string {
  const context = buildCardContext(card, field);
  return `Character: ${card.name || '(unnamed)'}
Field to draft: ${FIELD_LABELS[field]}

What's already known about this character:
${context || '(nothing else filled in yet)'}

${FIELD_LABELS[field]} (house style):`;
}

// ---------------------------------------------------------------------------
// 5. extractLore — split worldbuilding material out of an overloaded
//    description into standalone lorebook entries.
// ---------------------------------------------------------------------------

export const EXTRACT_LORE_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

A character card's description is unusually long or structured, and holds worldbuilding material distinct from the character themself: locations, factions, history, standing rules. Split it into a leaner description that stays focused on the character (identity, appearance, personality-relevant facts) and a set of lorebook entries for the extracted worldbuilding material.

Entry standard:
- One self-contained fact per entry. If you need "and" to describe what an entry covers, split it into two entries.
- The first sentence must carry the whole fact on its own — dense and declarative. The model reading this entry later has no other context.
- Target roughly 60-110 words per entry.
- "keys" are 3-6 identifiers or phrases that actually appear in the text — names, aliases, place names, specific terms. Never speculative paraphrases a keyword scan would not find.
- Keys are matched case-insensitively as SUBSTRINGS of prose, not whole words. Never use everyday words (the, she, her, they, said, about...) and never a fragment shorter than 3 characters.
- Do not list a key when a shorter key you already included would match it anyway.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"revised_description": "...", "entries": [{"keys": ["..."], "content": "..."}]}
- "revised_description" keeps only what belongs on the character card proper — never leave it empty if the original said anything about the character.
- If nothing is worth extracting, return the original description unchanged as "revised_description" and an empty "entries" array.`;

export function extractLorePrompt(description: string, characterName: string): string {
  return `Character name: ${characterName || '(unnamed)'}

Current description:
${description}

Revised description + extracted lore entries (JSON object):`;
}

export const EXTRACT_LORE_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape (see the system instructions). Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;
