// Card analyzer detectors.
//
// Each exported function inspects one concern across the relevant field(s)
// of an already-normalized card and returns the Finding(s) it produces (or
// null/[] when clean). Pure, synchronous, no store imports — analyzeCard()
// in index.ts composes all of these into one report.

import { estimateTokens } from '../tokenizer';
import { detectFieldFormat, type FieldFormat } from './detectFormat';
import {
  findingId,
  type AnalyzableCardData,
  type CardTextField,
  type Finding,
  type FindingCode,
  type FindingFix,
  type SourceFormat,
} from './types';

/** Human-readable name for a field, for finding titles/details. */
function fieldLabel(field: CardTextField): string {
  switch (field) {
    case 'description':
      return 'the description';
    case 'personality':
      return 'the personality';
    case 'first_mes':
      return 'the first message';
    case 'scenario':
      return 'the scenario';
    case 'mes_example':
      return 'the example messages';
    case 'creator_notes':
      return 'the creator notes';
    case 'system_prompt':
      return 'the system prompt';
    case 'post_history_instructions':
      return 'the post-history instructions';
    default:
      return field;
  }
}

function isBlank(text: unknown): text is undefined {
  return typeof text !== 'string' || text.trim().length === 0;
}

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text.slice(start, end)` clamped to the string bounds, used to build
 *  "~N chars around the match" evidence snippets. */
function contextAround(text: string, index: number, matchLen: number, pad: number): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + matchLen + pad);
  return text.slice(start, end);
}

// ===========================================================================
// format.* — structured-notation fields that need a prose rewrite
// ===========================================================================

const FORMAT_FIELDS: Array<'description' | 'personality' | 'scenario'> = [
  'description',
  'personality',
  'scenario',
];

const FORMAT_CODE_BY_VERDICT: Record<
  Exclude<FieldFormat, 'prose' | 'unknown'>,
  FindingCode
> = {
  wpp: 'format.wpp',
  boostyle: 'format.boostyle',
  plist: 'format.plist',
  json: 'format.json',
};

const FORMAT_NAME: Record<Exclude<FieldFormat, 'prose' | 'unknown'>, string> = {
  wpp: 'W++',
  boostyle: 'boostyle (keyword-list)',
  plist: 'PList',
  json: 'raw JSON',
};

/** Below this length, format detection is noise — a one-line field can't
 *  meaningfully be told apart from a formatting problem. */
const FORMAT_FIELD_MIN_LENGTH = 20;

export function detectFormatFinding(
  card: AnalyzableCardData,
  sourceFormat: SourceFormat
): Finding[] {
  const findings: Finding[] = [];

  for (const field of FORMAT_FIELDS) {
    const text = card[field];
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length < FORMAT_FIELD_MIN_LENGTH) continue;

    const verdict = detectFieldFormat(text);
    if (verdict === 'prose' || verdict === 'unknown') continue;

    const code = FORMAT_CODE_BY_VERDICT[verdict];
    const name = FORMAT_NAME[verdict];
    findings.push({
      id: findingId(code, field),
      code,
      field,
      severity: 'warning',
      fix: 'ai',
      aiPass: 'rewriteProse',
      title: `${name} formatting in ${fieldLabel(field)}`,
      detail:
        `${fieldLabel(field)[0].toUpperCase()}${fieldLabel(field).slice(1)} ` +
        `reads as ${name} notation rather than prose (the card overall ` +
        `reads as "${sourceFormat}"). An AI rewrite pass can turn this ` +
        `into natural narration without losing the underlying facts.`,
      evidence: trimmed.slice(0, 150),
    });
  }

  return findings;
}

// ===========================================================================
// macro.* — legacy placeholders and literal-name-instead-of-{{char}}
// ===========================================================================

const LEGACY_ANGLE_FIELDS: CardTextField[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
];

// `<BOT>`, `<User>`, `<CHAR>` — the pre-{{macro}} SillyTavern placeholder
// convention, case-insensitive.
const LEGACY_ANGLE = /<(bot|user|char)>/gi;
// Bare `{bot}` / `{user}` / `{char}` — the lookbehind/lookahead exclude the
// already-correct `{{bot}}`/`{{user}}`/`{{char}}` double-brace form, so a
// card that's already using real macros is never flagged here.
const LEGACY_BRACE = /(?<!\{)\{(bot|user|char)\}(?!\})/gi;

function legacyPlaceholderMatches(text: string): { index: number; length: number }[] {
  const matches: { index: number; length: number }[] = [];
  for (const m of text.matchAll(LEGACY_ANGLE)) {
    matches.push({ index: m.index ?? 0, length: m[0].length });
  }
  for (const m of text.matchAll(LEGACY_BRACE)) {
    matches.push({ index: m.index ?? 0, length: m[0].length });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

function detectLegacyPlaceholderFindings(card: AnalyzableCardData): Finding[] {
  const findings: Finding[] = [];
  for (const field of LEGACY_ANGLE_FIELDS) {
    const text = card[field];
    if (typeof text !== 'string' || !text) continue;
    const matches = legacyPlaceholderMatches(text);
    if (matches.length === 0) continue;

    const first = matches[0];
    findings.push({
      id: findingId('macro.legacy_placeholder', field),
      code: 'macro.legacy_placeholder',
      field,
      severity: 'warning',
      fix: 'deterministic',
      title: `Legacy placeholder macro in ${fieldLabel(field)}`,
      detail:
        `Uses an old-style placeholder (e.g. <BOT>/<USER> or bare ` +
        `{bot}/{user}) instead of {{char}}/{{user}}. A direct text ` +
        `replace is safe here.`,
      evidence: contextAround(text, first.index, first.length, 30),
      metrics: { count: matches.length },
    });
  }
  return findings;
}

/** Below this many characters, comparing against a name risks matching on
 *  short common words that happen to equal the character's name. */
const MIN_NAME_LENGTH_FOR_LITERAL_CHECK = 3;
/** 2+ whole-word hits of the character's name in a narration field is
 *  enough to say "this should be {{char}}" — one mention could just be the
 *  opening line introducing them by name. */
const LITERAL_NAME_MIN_OCCURRENCES = 2;
// Fields where a literal-name replace is safe: narration/character-sheet
// prose, not dialogue. `first_mes`/`mes_example` are deliberately excluded
// — see detectMacroFindings's doc comment.
const LITERAL_NAME_FIELDS: Array<'description' | 'personality' | 'scenario'> = [
  'description',
  'personality',
  'scenario',
];

function nameOccurrences(text: string, name: string): { count: number; firstIndex: number } {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
  const matches = [...text.matchAll(re)];
  return { count: matches.length, firstIndex: matches[0]?.index ?? 0 };
}

function detectLiteralNameFindings(
  card: AnalyzableCardData,
  characterName: string
): Finding[] {
  if (characterName.trim().length < MIN_NAME_LENGTH_FOR_LITERAL_CHECK) return [];

  const findings: Finding[] = [];
  for (const field of LITERAL_NAME_FIELDS) {
    const text = card[field];
    if (typeof text !== 'string' || !text) continue;
    if (text.includes('{{char}}')) continue;

    const { count, firstIndex } = nameOccurrences(text, characterName);
    if (count < LITERAL_NAME_MIN_OCCURRENCES) continue;

    findings.push({
      id: findingId('macro.literal_name', field),
      code: 'macro.literal_name',
      field,
      severity: 'info',
      fix: 'deterministic',
      title: `"${characterName}" used instead of {{char}} in ${fieldLabel(field)}`,
      detail:
        `The character's name appears ${count} times in ${fieldLabel(field)} ` +
        `where {{char}} would let the card follow persona/name overrides. ` +
        `A whole-word replace is safe in narration fields like this one.`,
      evidence: contextAround(text, firstIndex, characterName.length, 30),
      metrics: { count },
    });
  }
  return findings;
}

/**
 * Two independent sub-detectors:
 *  - legacy placeholder macros (`<BOT>`, bare `{user}`, …) — deterministic,
 *    checked across every dialogue-bearing and narration field.
 *  - literal character name where `{{char}}` belongs — deterministic, but
 *    ONLY in description/personality/scenario. `first_mes` and
 *    `mes_example` are dialogue: a character's name legitimately appears
 *    there in third-person action text ("Aria smirks and leans in"), and a
 *    blind whole-word replace risks garbling quoted speech or turning a
 *    line that's deliberately about a DIFFERENT named character (a group
 *    example, an NPC mentioned in the greeting) into nonsense. Nothing
 *    here routes those two fields to the AI-fix agent's `macroNormalize`
 *    pass either — that pass exists for a human to invoke manually if they
 *    want a smarter, dialogue-aware rewrite there.
 */
export function detectMacroFindings(
  card: AnalyzableCardData,
  characterName: string
): Finding[] {
  return [
    ...detectLegacyPlaceholderFindings(card),
    ...detectLiteralNameFindings(card, characterName),
  ];
}

// ===========================================================================
// examples.* — mes_example structure
// ===========================================================================

// Matches lines like `{{char}}: ...`, `Aria: ...`, `{{user}}: ...` — the
// same speaker-prefix grammar `dialogueExamplesFrom()` in
// storyIngest/coldStart.ts uses to find turns. Reused here only to detect
// STRUCTURAL presence of speaker-prefixed dialogue (any speaker at all,
// not filtered to the character), not to extract or attribute lines.
const DIALOGUE_LINE = /^(?:\{\{char\}\}|char|assistant|([^:]{1,40})):\s*(.+)$/i;

function dialogueLineCount(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^<start>$/i.test(l));
  return lines.filter((l) => DIALOGUE_LINE.test(l)).length;
}

/** 2+ speaker-prefixed lines is enough to say "this field has dialogue
 *  structure" — a single line could be a stray "Note:" aside. */
const DIALOGUE_LINE_MIN = 2;

export function detectExampleFindings(card: AnalyzableCardData): Finding[] {
  const raw = card.mes_example;
  const text = typeof raw === 'string' ? raw : '';

  if (!text.trim()) {
    return [
      {
        id: findingId('examples.missing', 'mes_example'),
        code: 'examples.missing',
        field: 'mes_example',
        severity: 'info',
        fix: 'ai',
        aiPass: 'generateField',
        title: 'No example dialogue',
        detail:
          'mes_example is empty — a few example turns help steer voice ' +
          'and formatting. An AI pass can draft some from the description, ' +
          'personality, and first message.',
      },
    ];
  }

  const lineCount = dialogueLineCount(text);
  const hasStart = /<start>/i.test(text);
  const findings: Finding[] = [];

  if (lineCount >= DIALOGUE_LINE_MIN && !hasStart) {
    // A single example block (no blank-line-separated chunks) is safe to
    // fix with one prepended marker; multiple chunks make it ambiguous
    // where each <START> should land, so that needs an AI pass instead.
    const isSingleBlock = !/\n\s*\n/.test(text.trim());
    const fix: FindingFix = isSingleBlock ? 'deterministic' : 'ai';
    const startFinding: Finding = {
      id: findingId('examples.no_start_blocks', 'mes_example'),
      code: 'examples.no_start_blocks',
      field: 'mes_example',
      severity: 'warning',
      fix,
      title: 'Example dialogue missing <START> markers',
      detail: isSingleBlock
        ? 'Speaker-prefixed dialogue with no <START> marker. Since this ' +
          'reads as one example block, prepending a single <START> line ' +
          'is safe.'
        : 'Speaker-prefixed dialogue split into multiple blank-line-' +
          'separated blocks with no <START> markers — placing one per ' +
          'block needs a rewrite pass rather than a single blind prepend.',
      evidence: text.trim().slice(0, 150),
    };
    if (!isSingleBlock) startFinding.aiPass = 'restructureExamples';
    findings.push(startFinding);
  } else if (hasStart && lineCount === 0) {
    findings.push({
      id: findingId('examples.malformed_lines', 'mes_example'),
      code: 'examples.malformed_lines',
      field: 'mes_example',
      severity: 'warning',
      fix: 'ai',
      aiPass: 'restructureExamples',
      title: '<START> block without dialogue lines',
      detail:
        'Has one or more <START> markers but no lines match the ' +
        '{{char}}:/Name: dialogue format underneath — reads as prose ' +
        'dropped under a marker rather than structured example turns.',
      evidence: text.trim().slice(0, 150),
    });
  }

  return findings;
}

// ===========================================================================
// field.missing_* — required-ish fields left empty
// ===========================================================================

export function detectMissingFieldFindings(card: AnalyzableCardData): Finding[] {
  const findings: Finding[] = [];

  if (isBlank(card.first_mes)) {
    findings.push({
      id: findingId('field.missing_first_mes', 'first_mes'),
      code: 'field.missing_first_mes',
      field: 'first_mes',
      severity: 'issue',
      fix: 'ai',
      aiPass: 'generateField',
      title: 'No first message',
      detail:
        'first_mes is empty — without an opening line the chat has ' +
        'nothing to react to. An AI pass can draft one from the rest of ' +
        'the card.',
    });
  }

  if (isBlank(card.description)) {
    findings.push({
      id: findingId('field.missing_description', 'description'),
      code: 'field.missing_description',
      field: 'description',
      severity: 'issue',
      fix: 'ai',
      aiPass: 'generateField',
      title: 'No description',
      detail:
        'description is empty — the model has nothing to ground the ' +
        "character's identity in. An AI pass can draft one from whatever " +
        'other fields are filled in.',
    });
  }

  if (isBlank(card.scenario)) {
    findings.push({
      id: findingId('field.missing_scenario', 'scenario'),
      code: 'field.missing_scenario',
      field: 'scenario',
      severity: 'info',
      fix: 'ai',
      aiPass: 'generateField',
      title: 'No scenario',
      detail:
        'scenario is empty. More optional than description/first_mes, ' +
        'but a short setup line still helps ground the opening exchange.',
    });
  }

  return findings;
}

// ===========================================================================
// tokens.* / greeting.overlong — budget thresholds
// ===========================================================================

const ALL_CARD_TEXT_FIELDS: CardTextField[] = [
  'description',
  'personality',
  'first_mes',
  'scenario',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
];

/** Above this, the description alone is approaching what many providers'
 *  system-preamble budgets look like before the conversation has said a
 *  word. */
export const DESCRIPTION_WARNING_TOKENS = 900;
/** Past this the description is eating a meaningful slice of even a
 *  large (32k+) context window on its own. */
export const DESCRIPTION_ISSUE_TOKENS = 1500;
/** Personality sections tend to run shorter than description by nature
 *  (traits, not backstory) — this is roughly 2/3 of the description
 *  warning line. */
export const PERSONALITY_WARNING_TOKENS = 600;
/** A greeting this long is asking a lot of a reader before they've typed
 *  anything — also doubles as the `greeting.overlong` trigger below. */
export const FIRST_MES_WARNING_TOKENS = 800;
/** Example dialogue is the first thing trimmed under budget pressure (see
 *  `totalPermanentTokens`'s doc comment); this threshold is generous
 *  accordingly. */
export const MES_EXAMPLE_WARNING_TOKENS = 1200;
/** Past this, the permanent prompt (everything except mes_example) starts
 *  crowding out a meaningful chat history on an 8k-context provider. */
export const CARD_WARNING_TOKENS = 2500;
/** Past this, the card alone approaches what many free-tier / smaller-
 *  context providers offer in total. */
export const CARD_ISSUE_TOKENS = 4000;

function bloatFinding(field: CardTextField, tokens: number, severity: 'warning' | 'issue'): Finding {
  return {
    id: findingId('tokens.field_bloat', field),
    code: 'tokens.field_bloat',
    field,
    severity,
    fix: 'none',
    title: `${fieldLabel(field)[0].toUpperCase()}${fieldLabel(field).slice(1)} is long (~${tokens} tokens)`,
    detail: `Estimated at ~${tokens} tokens. Trimming it leaves more of the context budget for actual conversation.`,
    metrics: { tokens },
  };
}

export function detectTokenFindings(card: AnalyzableCardData): {
  findings: Finding[];
  fieldTokens: Partial<Record<CardTextField, number>>;
  totalPermanentTokens: number;
} {
  const fieldTokens: Partial<Record<CardTextField, number>> = {};
  for (const field of ALL_CARD_TEXT_FIELDS) {
    const text = card[field];
    if (typeof text === 'string' && text.trim()) {
      fieldTokens[field] = estimateTokens(text);
    }
  }

  const totalPermanentTokens = ALL_CARD_TEXT_FIELDS.filter(
    (f) => f !== 'mes_example'
  ).reduce((sum, f) => sum + (fieldTokens[f] ?? 0), 0);

  const findings: Finding[] = [];

  const description = fieldTokens.description;
  if (description !== undefined) {
    if (description > DESCRIPTION_ISSUE_TOKENS) {
      findings.push(bloatFinding('description', description, 'issue'));
    } else if (description > DESCRIPTION_WARNING_TOKENS) {
      findings.push(bloatFinding('description', description, 'warning'));
    }
  }

  const personality = fieldTokens.personality;
  if (personality !== undefined && personality > PERSONALITY_WARNING_TOKENS) {
    findings.push(bloatFinding('personality', personality, 'warning'));
  }

  const firstMes = fieldTokens.first_mes;
  if (firstMes !== undefined && firstMes > FIRST_MES_WARNING_TOKENS) {
    findings.push(bloatFinding('first_mes', firstMes, 'warning'));
    findings.push({
      id: findingId('greeting.overlong', 'first_mes'),
      code: 'greeting.overlong',
      field: 'first_mes',
      severity: 'warning',
      fix: 'none',
      title: 'Greeting is long',
      detail: `The opening message is ~${firstMes} tokens — a shorter greeting gives the reader more room to steer before the card has committed to a direction.`,
      metrics: { tokens: firstMes },
    });
  }

  const mesExample = fieldTokens.mes_example;
  if (mesExample !== undefined && mesExample > MES_EXAMPLE_WARNING_TOKENS) {
    findings.push(bloatFinding('mes_example', mesExample, 'warning'));
  }

  if (totalPermanentTokens > CARD_ISSUE_TOKENS) {
    findings.push({
      id: findingId('tokens.card_bloat', 'card'),
      code: 'tokens.card_bloat',
      field: 'card',
      severity: 'issue',
      fix: 'none',
      title: `Card is large (~${totalPermanentTokens} permanent tokens)`,
      detail: `The permanent prompt (everything but example dialogue) is ~${totalPermanentTokens} tokens — well past what smaller-context providers can spare alongside real conversation.`,
      metrics: { tokens: totalPermanentTokens },
    });
  } else if (totalPermanentTokens > CARD_WARNING_TOKENS) {
    findings.push({
      id: findingId('tokens.card_bloat', 'card'),
      code: 'tokens.card_bloat',
      field: 'card',
      severity: 'warning',
      fix: 'none',
      title: `Card is large (~${totalPermanentTokens} permanent tokens)`,
      detail: `The permanent prompt (everything but example dialogue) is ~${totalPermanentTokens} tokens — worth trimming on smaller-context providers.`,
      metrics: { tokens: totalPermanentTokens },
    });
  }

  return { findings, fieldTokens, totalPermanentTokens };
}

// ===========================================================================
// lore.embedded_in_description
// ===========================================================================

/** Only worth checking once the description is already long — a short
 *  description with a couple of labeled lines is still just a character
 *  sheet, not embedded worldbuilding. */
const LORE_EMBEDDED_MIN_TOKENS = 800;
// `## Heading`, `**Label**:`, `Capitalized Label:` — the shapes a
// worldbuilding doc pasted into description tends to carry.
const LORE_HEADING_LINE = /^(#{1,4}\s|\*\*[^*]+\*\*:?$|[A-Z][\w /]{2,30}:$)/gm;
const LORE_HEADING_MIN = 3;
const LORE_PARAGRAPH_MIN = 6;

export function detectLoreEmbeddedFinding(card: AnalyzableCardData): Finding | null {
  const text = card.description;
  if (typeof text !== 'string' || !text.trim()) return null;

  const tokens = estimateTokens(text);
  if (tokens <= LORE_EMBEDDED_MIN_TOKENS) return null;

  const headingCount = (text.match(LORE_HEADING_LINE) ?? []).length;
  const paragraphCount = text.split(/\n\s*\n/).filter((p) => p.trim()).length;

  const hasHeadings = headingCount >= LORE_HEADING_MIN;
  const hasManyParagraphs = paragraphCount >= LORE_PARAGRAPH_MIN;
  if (!hasHeadings && !hasManyParagraphs) return null;

  return {
    id: findingId('lore.embedded_in_description', 'description'),
    code: 'lore.embedded_in_description',
    field: 'description',
    severity: 'warning',
    fix: 'ai',
    aiPass: 'extractLore',
    title: 'Description reads like embedded lore, not a character sheet',
    detail:
      `~${tokens} tokens with ` +
      (hasHeadings
        ? `${headingCount} heading/label-style lines`
        : `${paragraphCount} separate paragraphs`) +
      ' — this looks like worldbuilding that got pasted into the ' +
      'description rather than kept as its own lorebook entries. An AI ' +
      'pass can split it out.',
    evidence: text.trim().slice(0, 150),
  };
}

// ===========================================================================
// greeting.speaks_for_user
// ===========================================================================

// `{{user}}: ...` — the greeting writes the user's own dialogue turn.
const GREETING_USER_LINE = /\{\{user\}\}\s*:/;
// `"..." you say`, `"..." {{user}} reply` — the greeting narrates what the
// user says or does, in second person or via the macro.
const GREETING_NARRATES_USER =
  /"[^"]{4,}"\s*,?\s*(?:you|\{\{user\}\})\s+(?:say|reply|answer|respond)/i;

export function detectGreetingIssues(card: AnalyzableCardData): Finding[] {
  const text = card.first_mes;
  if (typeof text !== 'string' || !text.trim()) return [];

  const match = text.match(GREETING_USER_LINE) ?? text.match(GREETING_NARRATES_USER);
  if (!match) return [];

  return [
    {
      id: findingId('greeting.speaks_for_user', 'first_mes'),
      code: 'greeting.speaks_for_user',
      field: 'first_mes',
      severity: 'warning',
      fix: 'none',
      title: 'Greeting speaks or acts for {{user}}',
      detail:
        "The first message writes {{user}}'s dialogue or actions for " +
        'them instead of leaving an opening to respond to — this takes ' +
        "away the reader's first move.",
      evidence: contextAround(text, match.index ?? 0, match[0].length, 30),
    },
  ];
}
