// Reconcile (story-state phase 8, pass "reconcile").
//
// Finds contradictions among the facts the transcript walk appended, and
// emits them as `continuity.contradictions` for the phase-10 review
// checkpoint to resolve. This module is the MECHANICAL half: it groups
// facts into plausible-conflict buckets so the LLM judge only has to look
// at groups that could actually contradict.
//
// Kept network-free and model-free like coldStart.ts / transcriptWalk.ts —
// pure functions in, data out, so the grouping is unit-testable without a
// fake LLM. The judge pass and the store wiring build on top of this.

import type { BibleFact, FactCategory } from '../../types/storyBible';
import type { KnownCastMember } from './transcriptWalk';

// ---------------------------------------------------------------------------
// Entity association
// ---------------------------------------------------------------------------

/** The bucket a fact with no identifiable subject lands in.
 *
 *  Deliberately not a real entity id: it must never collide with one, and
 *  it must be obvious in a debug dump that nothing was attributed. */
export const WORLD_ENTITY = '__world__';

/** Facts about the world rather than a person group here regardless of
 *  category, so two `world_rule`s about the same setting still meet. */
export type EntityKey = string;

/** Canonical form for comparison. NFC so a card typed with a precomposed
 *  "é" still matches a model that emitted the decomposed form (or vice
 *  versa) — without it, matching silently depends on which normalization
 *  each side happened to use. Typographic apostrophes fold to ASCII for
 *  the same reason: cards are typed with `'`, models emit `’`, and
 *  "O'Brien" must not become invisible because of the difference.
 *
 *  NOTE: case is deliberately NOT folded here — see `mentions`. */
function canon(s: string): string {
  return s.normalize('NFC').replace(/[‘’ʼ`]/g, "'");
}

/** True when a character has case at all. Caseless scripts (Han, kana,
 *  Hebrew…) must not be held to the capitalization rule below, or every
 *  such cast member would silently stop matching. */
function caseless(ch: string): boolean {
  return ch.toLowerCase() === ch.toUpperCase();
}

/** Word-boundary test. Anything that isn't a letter or digit ends a word.
 *  Uses a Unicode property escape rather than `[a-z0-9]` so an accented
 *  or non-Latin neighbour counts as part of the word — with the ASCII
 *  class, "Jose" matched inside "Josée" whenever the text happened to be
 *  precomposed, making attribution depend on normalization form. */
function boundary(ch: string): boolean {
  return ch === '' || !/[\p{L}\p{N}]/u.test(ch);
}

interface Span {
  id: string;
  start: number;
  end: number;
}

/** Every whole-word occurrence of `needle` in `text`, matched
 *  case-insensitively but reported with the ORIGINAL text's positions.
 *
 *  Deliberately scans the ORIGINAL string and lowercases only the
 *  candidate span for comparison. Lowercasing the whole haystack first
 *  and indexing into it is a trap: `toLowerCase()` is not
 *  length-preserving ("İ" becomes two code units), so every later index
 *  silently shifts and matches land on the wrong characters.
 *
 *  An explicit scan rather than a RegExp so a name containing regex
 *  metacharacters ("Dr. (Ward)", "V*ex") can't throw or change meaning. */
function findSpans(text: string, needle: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (!needle) return out;
  const lowerNeedle = needle.toLowerCase();
  const limit = text.length - needle.length;
  for (let at = 0; at <= limit; at++) {
    const span = text.slice(at, at + needle.length);
    if (span.toLowerCase() !== lowerNeedle) continue;
    if (!boundary(at === 0 ? '' : text[at - 1])) continue;
    if (!boundary(text[at + needle.length] ?? '')) continue;
    out.push({ start: at, end: at + needle.length });
  }
  return out;
}

/** Which cast members a fact is ABOUT, by name/alias mention in its text.
 *
 *  THE CAPITALIZATION RULE. A match only counts when the text preserves
 *  the name's capitalization. Plenty of ordinary character names are also
 *  ordinary English words — Will, May, Rose, Grace, Dawn, Mark, Hope, Art
 *  — and case-insensitive matching hands every "he will leave" to a
 *  character named Will. That is not merely a false positive: because an
 *  attributed fact no longer falls through to WORLD_ENTITY, a genuine
 *  world-rule contradiction ("Magic will always demand a blood price" vs
 *  "Magic is free to cast") stops being grouped at all and is never shown
 *  to the judge. Silent, and unrecoverable downstream. Reproduced before
 *  this rule existed; pinned by a test now.
 *
 *  Known, accepted limits, all failing toward WORLD_ENTITY — where facts
 *  are still grouped and still judged, which is the safe direction;
 *  guessing a subject is the unsafe one:
 *    - a sentence-initial "Will he return?" still matches;
 *    - a model writing fact text entirely in lowercase loses attribution;
 *    - a name embedded in a script without word separators (Japanese,
 *      Chinese) can't satisfy the boundary rule, since every character
 *      has a letter on both sides. Loosening the rule for those scripts
 *      would reintroduce the over-matching it exists to prevent. In
 *      practice fact text is English prose, so a CJK name sitting in an
 *      English sentence does match.
 *
 *  Deliberately NOT derived from `established_in` -> the scene's
 *  participants. A scene routinely has several participants while a fact
 *  is about one of them, so attributing every fact to everyone present
 *  fabricates subject matter the fact text does not support. That costs
 *  real model calls on impossible pairs and, worse, invites the judge to
 *  invent contradictions between facts that were never about the same
 *  person.
 *
 *  Returns ids in CAST order, deduped, so grouping is deterministic
 *  regardless of where the names appear in the sentence. */
export function factEntities(
  fact: BibleFact,
  cast: KnownCastMember[]
): string[] {
  const text = canon(fact?.text ?? '').trim();
  if (!text) return [];

  // Longest needles first so a claimed span blocks the shorter names
  // inside it: with "Mrs. Ward" and "Ward" both in the cast, "Mrs. Ward
  // arrived" is about ONE of them. Ordering alone doesn't achieve that —
  // the claimed spans below are what actually enforce it.
  const needles: { id: string; needle: string }[] = [];
  for (const c of cast ?? []) {
    for (const raw of [c?.name, ...(c?.aliases ?? [])]) {
      if (typeof raw !== 'string') continue;
      const n = canon(raw).trim();
      if (n) needles.push({ id: c.id, needle: n });
    }
  }
  needles.sort((a, b) => b.needle.length - a.needle.length);

  const claimed: Span[] = [];
  for (const { id, needle } of needles) {
    const capitalized = !caseless(needle[0]) && needle[0] === needle[0].toUpperCase();
    for (const { start, end } of findSpans(text, needle)) {
      if (claimed.some((s) => start < s.end && end > s.start)) continue;
      if (capitalized) {
        const first = text[start];
        if (!caseless(first) && first !== first.toUpperCase()) continue;
      }
      claimed.push({ id, start, end });
    }
  }

  const hit = new Set(claimed.map((s) => s.id));
  return (cast ?? []).map((c) => c?.id).filter((id) => id && hit.has(id)) as string[];
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface FactGroup {
  /** Cast member id, or WORLD_ENTITY when nothing was attributable. */
  entity: EntityKey;
  category: FactCategory;
  facts: BibleFact[];
}

/** Group facts into (entity, category) buckets that could plausibly
 *  contradict each other.
 *
 *  A fact naming two characters lands in BOTH their groups on purpose —
 *  a relationship fact ("Ivy resents Sam") genuinely belongs to each, and
 *  a later fact contradicting it will be found from either side.
 *
 *  Only groups with two or more facts are returned: one fact cannot
 *  contradict anything, and the plan scopes the judge to multi-fact
 *  groups precisely so a long story doesn't spend a model call per fact.
 *
 *  Output order is FIRST-APPEARANCE order of each (entity, category)
 *  bucket, with facts inside a bucket in their original order — not
 *  sorted by entity. That is just as deterministic for a given fact log,
 *  which is the property the judge needs: a rerun over the same bible
 *  produces the same groups in the same sequence, so its batches, and
 *  anything seeded from them, stay reproducible. */
export function groupFacts(
  facts: BibleFact[],
  cast: KnownCastMember[]
): FactGroup[] {
  const buckets = new Map<string, FactGroup>();
  const order: string[] = [];

  for (const fact of facts) {
    if (!fact || typeof fact.text !== 'string') continue;
    const entities = factEntities(fact, cast);
    const keys = entities.length > 0 ? entities : [WORLD_ENTITY];
    for (const entity of keys) {
      const key = `${entity} ${fact.category}`;
      let group = buckets.get(key);
      if (!group) {
        group = { entity, category: fact.category, facts: [] };
        buckets.set(key, group);
        order.push(key);
      }
      // Guard against the same fact id arriving twice (an append-only log
      // read across a paging boundary can repeat a row); a group holding
      // the same fact twice would look like a self-contradiction.
      if (!group.facts.some((f) => f.id === fact.id)) group.facts.push(fact);
    }
  }

  return order
    .map((k) => buckets.get(k)!)
    .filter((g) => g.facts.length >= 2);
}
