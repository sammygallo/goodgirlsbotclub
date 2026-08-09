// House style — the single standard GGBC converges every character on,
// regardless of where the card came from. The import-fix AI passes
// (src/utils/cardAnalyzer/) import this module today; the planned creation
// wizard is meant to import it too, so a card written by hand, imported
// from elsewhere, or drafted by an interview all end up following the same
// conventions — but that wizard hasn't landed yet.
//
// This is prose guidance for a model prompt, not an enforced schema — the
// platform has no structured-output support (see src/utils/llm/), so style
// is steered by instruction, not validated mechanically. Detectors in
// cardAnalyzer/detectors.ts check for the most common departures (W++,
// legacy macros, missing <START> blocks) but this file is the single
// source of truth for what "correct" looks like.

/** Bumped whenever the wording below changes in a way that would alter a
 *  model's output — stamped into AI-fix/interview provenance so a card's
 *  fixes/greeting can be traced to the style version that produced them. */
export const CHARACTER_STYLE_VERSION = 'style-v1';

/**
 * Every AI pass that edits or drafts character card text opens with this.
 * States the target conventions once; individual pass prompts (in
 * cardAnalyzer/prompts.ts and, later, the interview engine) reference it
 * rather than re-deriving their own phrasing, so the platform's idea of
 * "correct" can't drift between passes.
 */
export const HOUSE_STYLE_GUIDE = `House style for character card text:
- Description: third-person prose paragraphs. Never bracketed key-value blocks (no "Trait= \\"value\\"", no W++, no PList, no raw JSON) and never a boostyle keyword list.
- Personality: prose, or a compact comma-separated trait list at most — never bracketed key("value") syntax.
- Macros: use {{char}} for the character and {{user}} for the person they're talking to. Never the character's literal name in place of {{char}}, and never legacy placeholders like <BOT>, <USER>, {bot}, {char}, {user} without braces.
- Greetings (first_mes and alternate greetings): a present-tense opening scene. Actions in *asterisks*, dialogue in "straight double quotes". Never speak, act, or decide for {{user}} — the greeting sets up the scene and stops before {{user}} would need to respond.
- Example dialogue (mes_example): one or more <START> blocks, each a short back-and-forth with lines written as "{{user}}: ..." and "{{char}}: ...".`;

/**
 * Every AI pass opens with this before the style guide. States once, for
 * every pass, that editing/reformatting is the job — never moralizing,
 * refusing, or softening the card's content. GGBC hosts fictional NSFW
 * content by design; a pass that quietly sanitizes a card on import or
 * during editing is a bug, not a safety feature.
 */
export const FICTION_CONTEXT_PREAMBLE = `You are a technical editor for fictional roleplay character cards on a platform for adult creators. The card's content, themes, and rating are the author's own choice. Edit and reformat only — never bowdlerize, add content warnings, moralize, or soften the tone or explicitness of what's there.`;

/** Combined preamble + style guide, the block every text-editing pass's
 *  system prompt should open with. */
export const HOUSE_STYLE_SYSTEM_PREFIX = `${FICTION_CONTEXT_PREAMBLE}\n\n${HOUSE_STYLE_GUIDE}`;
