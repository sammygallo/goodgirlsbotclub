// Structured-format detection for card analyzer text fields.
//
// Old SillyTavern-era cards frequently carry `description`/`personality`/
// `scenario` written in one of a handful of tag-based notations (W++,
// boostyle, PList) instead of prose, or occasionally a raw JSON blob pasted
// in by mistake. `detectFieldFormat` classifies ONE field's text;
// `detectSourceFormat` combines the vote across the three fields that
// matter for this (description/personality/scenario — first_mes and
// mes_example are dialogue, not character-sheet notation, so they don't
// vote).
//
// Pure functions, no store imports — see lorebookLint.ts for the house
// style this follows.

import type { AnalyzableCardData, SourceFormat } from './types';

export type FieldFormat =
  | 'wpp'
  | 'boostyle'
  | 'plist'
  | 'json'
  | 'prose'
  | 'unknown';

// --- JSON ------------------------------------------------------------

// `{"name": "Aria", "age": 24}` / `["kind", "curious"]`
const JSON_BRACKET_START = /^[{[]/;
// `"name": "Aria"`, `"likes":"tea"` — a quoted key immediately followed by
// a colon. Counted even when the surrounding braces are missing or
// mangled, so a half-pasted JSON fragment still reads as JSON.
const JSON_KEY_COLON = /"[a-zA-Z_][\w]*"\s*:/g;
/** 3 quoted-key-colon pairs is enough to say "this is JSON shaped", short
 *  of fewer than that a field could just be prose that happens to quote a
 *  word before a colon once or twice ("Warning": don't trust her). */
const JSON_KEY_COLON_MIN = 3;

// --- W++ ---------------------------------------------------------------

// `Personality("kind")`, `Likes( "tea" )` — bare key, one quoted value.
const WPP_KEY_PAREN = /\w+\s*\(\s*"[^"]+"\s*\)/g;
/** 3 of the single-value `Key("value")` calls is enough on its own —
 *  below that a stray `Note("see below")` in prose shouldn't flip the
 *  verdict. */
const WPP_KEY_PAREN_MIN = 3;
// `[character("Aria")]` / `[Character (` — the classic W++ envelope; one
// hit is definitive, nothing else produces this shape by accident.
const WPP_CHARACTER_BRACKET = /\[\s*character\s*\(/i;
// `Likes("tea" + "rain" + "quiet mornings")` — the concatenation form.
// Tested per line (see detectFieldFormat), so this is anchored to the
// start of a line-sized string rather than using the `m` flag.
const WPP_CONCAT_LINE = /^\s*\w+\("[^"]*"(\s*\+\s*"[^"]*")*\)/;
/** 2 lines in this shape is enough — a single stray line could be a
 *  one-off string concatenation someone pasted in, not the field's
 *  format. */
const WPP_CONCAT_LINE_MIN = 2;

// --- boostyle ------------------------------------------------------------

// `kind + curious + soft-spoken` — 3+ short tokens joined by ` + ` on
// their own line. Tested per line, same reasoning as WPP_CONCAT_LINE.
const BOOSTYLE_LINE = /^\s*[\w'-]{2,20}(\s*\+\s*[\w'-]{2,20}){2,}\s*$/;

// --- PList -----------------------------------------------------------

// `[character: {name: Aria; age: 24; likes: tea, quiet mornings}]` — a
// bracketed block with real content, no nested brackets inside it.
const PLIST_BLOCK = /\[[^[\]]{20,}\]/g;
// `name:`, `age:`, `likes:` — a bare word followed by a colon.
const PLIST_KEY_COLON = /\w+\s*:/;
/** 2 colon-tagged segments inside one bracket block is the PList shape;
 *  one alone could just be a markdown link title or a stray `[note: x]`. */
const PLIST_KEY_COLON_MIN = 2;

// --- prose -------------------------------------------------------------

// `.` followed by whitespace — a real sentence boundary, not an ellipsis
// mid-word or a decimal.
const SENTENCE_END = /\.\s/g;
/** 2 sentence boundaries reliably reads as prose; one is too easy to hit
 *  by accident (a single trailing "Aria is quiet." greeting line). */
const SENTENCE_END_MIN = 2;
/** Below this length there usually isn't enough text for any of the
 *  structural heuristics above to mean anything either way — a one-line
 *  description like "A quiet librarian." shouldn't be flagged as a
 *  formatting problem just because it has no second sentence. */
const PROSE_SHORT_TEXT_MAX = 40;

/**
 * Classify a single field's raw text. Checked in priority order, first
 * strong match wins — a W++ snippet embedded in an otherwise prose-shaped
 * field should read as W++, not fall through to a looser "well, it has
 * periods" prose verdict.
 */
export function detectFieldFormat(text: string): FieldFormat {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);

  // 1. JSON --------------------------------------------------------------
  if (JSON_BRACKET_START.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON by itself — still check the fragment vote below.
    }
  }
  const keyColonCount = (trimmed.match(JSON_KEY_COLON) ?? []).length;
  if (keyColonCount >= JSON_KEY_COLON_MIN) return 'json';

  // 2. W++ -----------------------------------------------------------
  const keyParenCount = (trimmed.match(WPP_KEY_PAREN) ?? []).length;
  if (keyParenCount >= WPP_KEY_PAREN_MIN) return 'wpp';
  if (WPP_CHARACTER_BRACKET.test(trimmed)) return 'wpp';
  const concatLineCount = lines.filter((l) => WPP_CONCAT_LINE.test(l)).length;
  if (concatLineCount >= WPP_CONCAT_LINE_MIN) return 'wpp';

  // 3. boostyle -----------------------------------------------------------
  const boostyleLineCount = lines.filter((l) => BOOSTYLE_LINE.test(l)).length;
  if (boostyleLineCount >= 1) return 'boostyle';

  // 4. PList (only reached if nothing above already claimed the text) ----
  const blocks = trimmed.match(PLIST_BLOCK) ?? [];
  for (const block of blocks) {
    const inner = block.slice(1, -1);
    const segments = inner.split(/[;,]/);
    const taggedSegments = segments.filter((seg) => PLIST_KEY_COLON.test(seg));
    if (taggedSegments.length >= PLIST_KEY_COLON_MIN) return 'plist';
  }

  // 5. prose ----------------------------------------------------------
  const sentenceEnders = (trimmed.match(SENTENCE_END) ?? []).length;
  if (sentenceEnders >= SENTENCE_END_MIN) return 'prose';
  if (trimmed.length < PROSE_SHORT_TEXT_MAX) return 'prose';

  return 'unknown';
}

/** Fields that vote on the card's overall source format. `first_mes` and
 *  `mes_example` are dialogue, not character-sheet notation — a greeting
 *  written as prose says nothing about whether the description is W++. */
const VOTING_FIELDS: Array<'description' | 'personality' | 'scenario'> = [
  'description',
  'personality',
  'scenario',
];

/**
 * Combine the per-field verdicts into one call on the card's source
 * format.
 *
 * The three voting fields are read independently; "prose" and "unknown"
 * are non-committal votes (a field that's merely ambiguous shouldn't
 * outvote a sibling field that clearly IS W++), so the aggregate looks
 * only at the "structural" votes — wpp/boostyle/plist/json — when they
 * exist:
 *  - no field had any text at all               -> 'unknown'
 *  - no field voted a structural format          -> 'prose' if at least
 *    one field voted prose, else 'unknown' (every voter was unknown)
 *  - every structural vote is the SAME format     -> that format
 *  - two or more DIFFERENT structural formats     -> 'mixed'
 */
export function detectSourceFormat(card: AnalyzableCardData): SourceFormat {
  const votes: FieldFormat[] = [];
  for (const field of VOTING_FIELDS) {
    const text = card[field];
    if (typeof text === 'string' && text.trim()) {
      votes.push(detectFieldFormat(text));
    }
  }
  if (votes.length === 0) return 'unknown';

  const structural = votes.filter((v) => v !== 'prose' && v !== 'unknown');
  if (structural.length === 0) {
    return votes.includes('prose') ? 'prose' : 'unknown';
  }

  const distinct = new Set(structural);
  if (distinct.size === 1) return [...distinct][0] as SourceFormat;
  return 'mixed';
}
