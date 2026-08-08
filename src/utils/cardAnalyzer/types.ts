// Card analyzer — shared type contract.
//
// analyzeCard() is pure and synchronous: it runs on a card that has ALREADY
// been through characterNormalize.ts (whitespace/tag cleanup, <START> strip
// from first_mes) and reports on what's left. It does not itself apply
// anything — deterministicFixes.ts and aiFixes.ts do that, each producing
// FieldDiff[] the caller decides whether to accept.
//
// The "already fixed, lossless" bucket a Finding-based UI might expect
// (whitespace cleanup, tag dedup, <START> strip) is NOT modeled here — that
// information already exists as characterNormalize's own `changes: string[]`
// and is shown as its own list; wrapping it into Finding objects would just
// be a lossy re-encoding of strings the UI already has verbatim.

/** The subset of card-data text fields the analyzer reads and can target a
 *  fix at. Structurally compatible with both `CharacterCardV2['data']` and
 *  `CharacterExportData` — this module deliberately does not import either,
 *  so it stays testable without pulling in the whole card-parsing module. */
export interface AnalyzableCardData {
  name?: string;
  description?: string;
  personality?: string;
  first_mes?: string;
  scenario?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
}

/** Fields a finding or fix can be anchored to. `'card'` is used for
 *  whole-card findings (total token budget) that aren't about one field. */
export type CardTextField =
  | 'description'
  | 'personality'
  | 'first_mes'
  | 'scenario'
  | 'mes_example'
  | 'creator_notes'
  | 'system_prompt'
  | 'post_history_instructions';

export type FindingField = CardTextField | 'card';

export type FindingCode =
  | 'format.wpp'
  | 'format.boostyle'
  | 'format.plist'
  | 'format.json'
  | 'macro.literal_name'
  | 'macro.legacy_placeholder'
  | 'examples.no_start_blocks'
  | 'examples.malformed_lines'
  | 'examples.missing'
  | 'field.missing_first_mes'
  | 'field.missing_description'
  | 'field.missing_scenario'
  | 'tokens.field_bloat'
  | 'tokens.card_bloat'
  | 'lore.embedded_in_description'
  | 'greeting.speaks_for_user'
  | 'greeting.overlong';

export type FindingSeverity = 'info' | 'warning' | 'issue';

/**
 * How a finding can be resolved.
 *  - 'deterministic': a pure-code rewrite exists and is safe to apply with
 *    one click, no model call (e.g. a legacy `<BOT>` placeholder map).
 *  - 'ai': needs a model pass to resolve (e.g. rewriting W++ into prose).
 *  - 'none': informational only — nothing in this pass targets it, surfaced
 *    so the author can address it by hand.
 */
export type FindingFix = 'deterministic' | 'ai' | 'none';

export type AiPassId =
  | 'rewriteProse'
  | 'macroNormalize'
  | 'restructureExamples'
  | 'generateField'
  | 'extractLore';

export interface Finding {
  /** Stable toggle key: `${code}:${field}`. Unique within one report — a
   *  detector that fires more than once on the same field (shouldn't
   *  happen, each detector runs once per field) would collide, which is
   *  intentional: it signals a detector bug rather than silently doubling
   *  up in the UI. */
  id: string;
  code: FindingCode;
  field: FindingField;
  severity: FindingSeverity;
  fix: FindingFix;
  /** Set iff `fix === 'ai'`. */
  aiPass?: AiPassId;
  title: string;
  detail: string;
  /** Short excerpt from the card substantiating the finding, shown next to
   *  the finding so the author can judge it without opening the field.
   *  Callers should cap this before display; detectors may return longer
   *  quotes. */
  evidence?: string;
  metrics?: { tokens?: number; count?: number };
}

export function findingId(code: FindingCode, field: FindingField): string {
  return `${code}:${field}`;
}

/** One field's before/after text, produced by a deterministic or AI fix. */
export interface FieldDiff {
  field: CardTextField;
  before: string;
  after: string;
}

/** A lorebook entry drafted by the `extractLore` pass — same shape as
 *  `DraftLorebookEntry` from lorebookFromTranscript.ts (keys + content),
 *  intentionally not importing that module to keep this package
 *  dependency-light; the import UI is responsible for converting this into
 *  whatever the embedded-book staging path expects. */
export interface DraftLoreEntry {
  keys: string[];
  content: string;
}

export interface LoreExtractResult {
  /** The description exactly as it was before this pass ran — carried
   *  alongside the revised text so a caller can render a real before/after
   *  diff without needing to separately track (or guess at) the card's
   *  prior state. */
  originalDescription: string;
  /** The description with the extracted material removed — replaces
   *  `description` in a FieldDiff if the caller accepts the pass. */
  revisedDescription: string;
  entries: DraftLoreEntry[];
}

export type SourceFormat =
  | 'wpp'
  | 'boostyle'
  | 'plist'
  | 'json'
  | 'prose'
  | 'mixed'
  | 'unknown';

export interface AnalysisReport {
  sourceFormat: SourceFormat;
  findings: Finding[];
  /** Estimated token count per field that has any text (via
   *  `estimateTokens`, generic profile — this runs before a provider is
   *  necessarily chosen, so it's an approximation, same caveat as every
   *  other budget estimate in the app). */
  fieldTokens: Partial<Record<CardTextField, number>>;
  /** Sum of `fieldTokens` across every field that counts toward the
   *  permanent prompt (i.e. excluding `mes_example`, which many
   *  instruct/prompt configs trim or omit under budget pressure — still
   *  tracked per-field above, just not folded into this total). */
  totalPermanentTokens: number;
}
