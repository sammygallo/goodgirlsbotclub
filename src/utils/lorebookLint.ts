// Entry-quality checks for lorebook authoring.
//
// Adapted from the entry standard used by a production injection engine
// (one entry = one self-contained fact; deterministic triggers; lean
// bodies; few, well-chosen keys). The rules are re-derived against GGBC's
// actual scanner rather than ported verbatim, because the matching model
// differs in ways that invert some of the original advice:
//
//   - GGBC matches keys as case-insensitive SUBSTRINGS, not whole tokens.
//     So a short key is a liability here (`ana` fires inside "banana"),
//     whereas a token matcher needs short part-keys to catch compounds.
//   - A key wrapped in /slashes/ is compiled as a regex; on a compile
//     error the scanner falls back to substring-matching the literal text
//     including the slashes, which effectively never matches.
//   - Entries with empty content, or with no keys and no constant flag,
//     are silently skipped by the scanner — dead weight in the book with
//     nothing in the UI to say so.
//
// Pure functions, no store imports (the WorldInfoEntry import is type-only
// and erased at compile time), so this stays cheap to call per keystroke.

import { estimateTokens, type TokenizerProfile } from './tokenizer';
import type { WorldInfoEntry } from '../stores/worldInfoStore';

export type LintSeverity = 'error' | 'warning' | 'info';

/**
 * Which part of the entry a finding is about, so the editor can anchor the
 * message next to the control the author needs to touch.
 */
export type LintField =
  | 'entry'
  | 'keys'
  | 'content'
  | 'critical'
  | 'constant'
  | 'probability'
  | 'category'
  | 'related';

export interface LintFinding {
  code: string;
  severity: LintSeverity;
  field: LintField;
  message: string;
}

/** Bodies above this many estimated tokens usually hold two facts. */
export const BODY_TOKEN_TARGET = 150;
/** More keys than this and the entry starts firing on marginal mentions. */
export const MAX_RECOMMENDED_KEYS = 6;
/** Substring matching makes anything shorter fire inside unrelated words. */
export const MIN_KEY_LENGTH = 3;

/**
 * Words so common that a substring key containing one fires on nearly every
 * message, burning budget and drowning out entries that actually matter.
 */
const STOPWORD_KEYS = new Set([
  'the', 'and', 'but', 'for', 'from', 'that', 'this', 'these', 'those',
  'with', 'was', 'were', 'are', 'has', 'have', 'had', 'will', 'would',
  'could', 'should', 'what', 'when', 'where', 'why', 'how', 'all', 'any',
  'not', 'you', 'your', 'she', 'her', 'hers', 'him', 'his', 'they', 'them',
  'their', 'its', 'into', 'out', 'over', 'back', 'very', 'more', 'most',
  'some', 'than', 'too', 'also', 'only', 'even', 'still', 'just', 'now',
  'then', 'there', 'here', 'been', 'being', 'does', 'did', 'get', 'got',
  'one', 'two', 'like', 'said', 'says', 'about', 'because', 'which',
  'while', 'after', 'before', 'again', 'each', 'other', 'such', 'own',
]);

/** True when the key is written as a /regex/ literal. */
function isRegexKey(key: string): boolean {
  return /^\/(.+)\/([gimsuy]*)$/.test(key);
}

/** Mirrors the scanner: does this /regex/ key actually compile? */
function regexKeyCompiles(key: string): boolean {
  const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!m) return true;
  try {
    new RegExp(m[1], m[2]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check one entry against the authoring standard.
 *
 * Errors mean the entry cannot fire (or cannot fire as configured) — the
 * scanner will skip it and nothing else would tell the author. Warnings are
 * search-quality and leanness problems. Info is housekeeping.
 */
export function lintEntry(
  entry: WorldInfoEntry,
  profile: TokenizerProfile = 'generic'
): LintFinding[] {
  const findings: LintFinding[] = [];
  const keys = entry.keys ?? [];

  // --- Can this entry ever reach the prompt? -----------------------------

  if (entry.content.trim().length === 0) {
    findings.push({
      code: 'empty-content',
      severity: 'error',
      field: 'content',
      message: 'No content — the scanner skips this entry entirely.',
    });
  }

  // semanticOnly entries (e.g. auto-chunked Data Bank imports) are keyless
  // by design — they fire via the SERVER's semantic/FTS recall
  // (/retrieval/context), which this client-side scanner has no equivalent
  // of. Flagging them as "can never fire" would be simply wrong: they do
  // fire, just not through the local keyword scan this lint models. (They
  // also can't be critical — semanticOnly + critical is rejected server-side
  // — so the critical branch below is unreachable for them regardless.)
  if (!entry.constant && !entry.semanticOnly && keys.length === 0) {
    findings.push({
      code: 'no-trigger',
      severity: 'error',
      field: 'keys',
      message: entry.critical
        ? 'Critical, but nothing can trigger it: add a keyword or make it Constant. A critical entry with no trigger never fires at all.'
        : 'No keywords and not Constant — nothing can ever trigger this entry.',
    });
  }

  for (const key of keys) {
    if (isRegexKey(key) && !regexKeyCompiles(key)) {
      findings.push({
        code: 'invalid-regex-key',
        severity: 'error',
        field: 'keys',
        message: `"${key}" looks like a regex but does not compile, so it is matched as literal text (including the slashes) and will never fire.`,
      });
    }
  }

  // --- Trigger quality ---------------------------------------------------

  const seen = new Set<string>();
  for (const key of keys) {
    const norm = key.toLowerCase();
    if (seen.has(norm)) {
      findings.push({
        code: 'duplicate-key',
        severity: 'info',
        field: 'keys',
        message: `"${key}" is listed twice.`,
      });
    }
    seen.add(norm);

    if (isRegexKey(key)) continue; // length/stopword rules are literal-only

    if (key.trim().length > 0 && key.trim().length < MIN_KEY_LENGTH) {
      findings.push({
        code: 'short-key',
        severity: 'warning',
        field: 'keys',
        message: `"${key}" is very short. Keys match as substrings, so it will fire inside unrelated words.`,
      });
    } else if (STOPWORD_KEYS.has(norm.trim())) {
      findings.push({
        code: 'stopword-key',
        severity: 'warning',
        field: 'keys',
        message: `"${key}" is an everyday word — it will fire on almost every message and crowd out other entries.`,
      });
    }
  }

  // A longer key is unreachable when a shorter one already covers it: any
  // text containing the long key also contains the short one, so the long
  // key can never be the reason the entry fires.
  const literals = keys.filter((k) => !isRegexKey(k) && k.trim().length > 0);
  for (const long of literals) {
    for (const short of literals) {
      if (short === long) continue;
      if (short.length >= long.length) continue;
      if (long.toLowerCase().includes(short.toLowerCase())) {
        findings.push({
          code: 'redundant-key',
          severity: 'warning',
          field: 'keys',
          message: `"${long}" never adds a trigger — "${short}" already matches anything it would.`,
        });
        break;
      }
    }
  }

  if (keys.length > MAX_RECOMMENDED_KEYS) {
    findings.push({
      code: 'too-many-keys',
      severity: 'warning',
      field: 'keys',
      message: `${keys.length} keywords. Three to six well-chosen ones beat a long speculative list — every extra key is another way to fire on a passing mention.`,
    });
  }

  if (entry.constant && keys.length > 0) {
    findings.push({
      code: 'constant-keys-ignored',
      severity: 'info',
      field: 'constant',
      message: 'Constant entries fire on every message, so these keywords are never consulted.',
    });
  }

  // --- Contradictory settings -------------------------------------------

  if (entry.critical && entry.useProbability && entry.probability < 100) {
    findings.push({
      code: 'critical-probability',
      severity: 'warning',
      field: 'probability',
      message: `Critical but gated on a ${entry.probability}% dice roll — a fact you cannot afford to lose should not be left to chance.`,
    });
  }

  // Inclusion groups have no constant/critical exemption: a grouped entry
  // that loses the draw does not inject at all, which quietly defeats both
  // "always fires" and "never lose this".
  if (entry.group.trim() && (entry.critical || entry.constant)) {
    const which = entry.critical ? 'Critical' : 'Constant';
    findings.push({
      code: entry.critical ? 'critical-in-group' : 'constant-in-group',
      severity: entry.critical ? 'warning' : 'info',
      field: entry.critical ? 'critical' : 'constant',
      message: `${which}, but in group "${entry.group.trim()}" — only one entry in a group fires, so this one is skipped whenever another member wins.`,
    });
  }

  if (entry.selective && (entry.keysSecondary ?? []).length === 0) {
    findings.push({
      code: 'selective-without-secondary',
      severity: 'info',
      field: 'keys',
      message: 'Secondary-key logic is on but no secondary keys are set — the setting has no effect.',
    });
  }

  // --- Leanness ----------------------------------------------------------

  const bodyTokens = estimateTokens(entry.content, profile);
  if (bodyTokens > BODY_TOKEN_TARGET) {
    findings.push({
      code: 'long-body',
      severity: 'warning',
      field: 'content',
      message: `~${bodyTokens} tokens. Aim for under ${BODY_TOKEN_TARGET} — if you need "and" to describe what this covers, it is probably two entries.`,
    });
  }

  if (!entry.category) {
    findings.push({
      code: 'no-category',
      severity: 'info',
      field: 'category',
      message: 'No category. Tagging costs nothing at generation time and makes audits much faster.',
    });
  }

  return findings;
}

export interface EntryLintResult {
  entryId: string;
  findings: LintFinding[];
}

/**
 * Two bodies count as near-duplicates when their content words overlap this
 * much (intersection / union). Set from the two failure modes either side:
 * a genuine restatement of the same fact lands around 0.7-1.0, while two
 * different facts about the same subject rarely clear 0.35 — they share the
 * name and little else.
 */
export const DUPLICATE_SIMILARITY = 0.6;
/**
 * …or when one body's content words are almost entirely contained in the
 * other's. Subsumption is redundancy even when the lengths differ wildly:
 * the shorter entry adds nothing the longer one does not already say, and
 * union-based similarity is blind to it (a body twice as long as the one it
 * swallows caps out at 0.5).
 */
export const DUPLICATE_CONTAINMENT = 0.85;
/**
 * Containment needs a floor. Below this many content words almost anything
 * is "contained" in a longer entry by coincidence — "Ivy is the gardener"
 * sits inside any entry that happens to mention Ivy and gardening.
 */
const CONTAINMENT_MIN_WORDS = 4;

/**
 * The content words a near-duplicate comparison runs on: case- and
 * punctuation-insensitive, stopwords dropped so two entries are not judged
 * alike for sharing "the" and "with".
 *
 * Single characters go too — they are almost always the tail of a split
 * possessive ("Ivy's" → "ivy", "s") and would otherwise be a free point of
 * overlap between unrelated entries.
 */
function contentWords(content: string): Set<string> {
  const tokens =
    content.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = tokens.filter((w) => w.length > 1);
  const meaningful = words.filter((w) => !STOPWORD_KEYS.has(w));
  // A body that is nothing but stopwords still deserves to be compared —
  // falling back keeps two copies of "and then it was over" detectable.
  return new Set(meaningful.length > 0 ? meaningful : words);
}

/** Iterates the smaller set, so cost is O(min(|a|,|b|)). */
function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const word of small) if (large.has(word)) n += 1;
  return n;
}

/**
 * Lexical near-duplicate test.
 *
 * Deliberately lexical, not semantic: "Kestrel keeps a knife in her boot"
 * and "Kestrel hides a blade in her boot" say the same thing and share
 * almost no words, so nothing short of embeddings would catch them. This
 * finds restatements and copy-paste-then-edit, which is what the dedup
 * sweep is actually for.
 */
function isNearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const shared = intersectionSize(a, b);
  if (shared === 0) return false;
  const union = a.size + b.size - shared;
  if (shared / union >= DUPLICATE_SIMILARITY) return true;
  const smaller = Math.min(a.size, b.size);
  return (
    smaller >= CONTAINMENT_MIN_WORDS &&
    shared / smaller >= DUPLICATE_CONTAINMENT
  );
}

/**
 * Human-readable label for an entry: its comment if non-empty, else its
 * first key if it has any, else its id. Shared fallback chain for anywhere
 * an entry needs a short display name — lint messages that reference a
 * sibling entry (below), search results, etc.
 */
export function entryLabel(entry: WorldInfoEntry): string {
  return entry.comment || entry.keys[0] || entry.id;
}

/** One entry that reads as a near-duplicate of a candidate body. */
export interface NearDuplicateHit {
  entryId: string;
  /** Jaccard similarity over content words (shared / union), 0..1. */
  score: number;
}

/**
 * Find entries in `entries` whose content reads as a near-duplicate of
 * `content`, using the same tokenization and duplicate test as `lintBook`'s
 * cross-entry dedup sweep. Results are sorted by score, highest first.
 */
export function findNearDuplicates(
  content: string,
  entries: WorldInfoEntry[]
): NearDuplicateHit[] {
  const words = contentWords(content);
  if (words.size === 0) return [];

  const hits: NearDuplicateHit[] = [];
  for (const entry of entries) {
    const entryWords = contentWords(entry.content);
    if (entryWords.size === 0) continue;
    if (!isNearDuplicate(words, entryWords)) continue;
    const shared = intersectionSize(words, entryWords);
    const union = words.size + entryWords.size - shared;
    hits.push({ entryId: entry.id, score: union > 0 ? shared / union : 0 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Check every entry in a book, plus the cross-entry rules that need the
 * whole book in view: near-duplicate bodies (the standard's dedup sweep)
 * and related-entry links that cannot resolve.
 */
export function lintBook(
  entries: WorldInfoEntry[],
  profile: TokenizerProfile = 'generic'
): EntryLintResult[] {
  const byEntry = new Map<string, LintFinding[]>();
  const push = (id: string, finding: LintFinding) => {
    const list = byEntry.get(id);
    if (list) list.push(finding);
    else byEntry.set(id, [finding]);
  };

  for (const entry of entries) {
    const findings = lintEntry(entry, profile);
    if (findings.length > 0) byEntry.set(entry.id, [...findings]);
  }

  const label = (id: string) => {
    const target = entries.find((e) => e.id === id);
    return target ? entryLabel(target) : id;
  };

  // Near-duplicate bodies: two entries saying the same thing both fire and
  // both cost tokens, and editing one silently leaves the other stale.
  //
  // Pairwise, so O(n²) on entries with content — but the token sets are
  // built once up front and the inner test walks only the smaller set, and
  // books run to tens of entries, not thousands. Worth watching if that
  // stops being true: lintDraftInBook re-runs this on every keystroke.
  const comparable = entries
    .map((entry) => ({ entry, words: contentWords(entry.content) }))
    .filter((c) => c.words.size > 0);
  const partners = new Map<string, string[]>();
  for (let i = 0; i < comparable.length; i += 1) {
    for (let j = i + 1; j < comparable.length; j += 1) {
      if (!isNearDuplicate(comparable[i].words, comparable[j].words)) continue;
      const a = comparable[i].entry.id;
      const b = comparable[j].entry.id;
      partners.set(a, [...(partners.get(a) ?? []), b]);
      partners.set(b, [...(partners.get(b) ?? []), a]);
    }
  }
  for (const [id, others] of partners) {
    const named = others.slice(0, 2).map((o) => `"${label(o)}"`).join(' and ');
    const rest = others.length - Math.min(others.length, 2);
    push(id, {
      code: 'duplicate-entry',
      severity: 'warning',
      field: 'content',
      message:
        `Says nearly the same thing as ${named}` +
        (rest > 0 ? ` and ${rest} more` : '') +
        ' — merge them or narrow what each one covers.',
    });
  }

  // Related-entry links the scanner cannot follow.
  const ids = new Set(entries.map((e) => e.id));
  const active = new Set(
    entries
      .filter((e) => e.enabled && e.content.trim().length > 0)
      .map((e) => e.id)
  );
  for (const entry of entries) {
    const missing = (entry.relatedIds ?? []).filter((id) => !ids.has(id));
    if (missing.length > 0) {
      push(entry.id, {
        code: 'dangling-related',
        severity: 'warning',
        field: 'related',
        message:
          missing.length === 1
            ? '1 related-entry link points at an entry that no longer exists.'
            : `${missing.length} related-entry links point at entries that no longer exist.`,
      });
    }
    const inactive = (entry.relatedIds ?? []).filter(
      (id) => ids.has(id) && !active.has(id)
    );
    if (inactive.length > 0) {
      push(entry.id, {
        code: 'inactive-related',
        severity: 'warning',
        field: 'related',
        message: `Linked to ${inactive
          .map(label)
          .join(', ')}, which is disabled or empty — the chain stops there.`,
      });
    }
  }

  return entries
    .map((e) => ({ entryId: e.id, findings: byEntry.get(e.id) ?? [] }))
    .filter((r) => r.findings.length > 0);
}

/**
 * Check one in-progress draft against the book it belongs to.
 *
 * The entry editor needs this rather than `lintEntry`: three rules
 * (`duplicate-entry`, `dangling-related`, `inactive-related`) live only in
 * `lintBook` because they need sibling entries in view. Linting the draft
 * alone left the editor reporting "No issues found" for entries the list had
 * already badged from `lintBook` — the author was told to fix something and
 * then shown a clean panel.
 *
 * The draft REPLACES its saved counterpart (matched by id) rather than
 * joining it, so an unedited entry is not flagged as a near-duplicate of
 * itself. A new draft carries an id no sibling shares, so nothing is
 * replaced and every saved entry counts as a sibling.
 */
export function lintDraftInBook(
  draft: WorldInfoEntry,
  bookEntries: WorldInfoEntry[],
  profile: TokenizerProfile = 'generic'
): LintFinding[] {
  const siblings = bookEntries.filter((e) => e.id !== draft.id);
  const results = lintBook([...siblings, draft], profile);
  return results.find((r) => r.entryId === draft.id)?.findings ?? [];
}

/** Highest severity present, or null when the entry is clean. */
export function worstSeverity(findings: LintFinding[]): LintSeverity | null {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  if (findings.length > 0) return 'info';
  return null;
}
