// World-info replay (story-state phase 6, pass 1.5).
//
// Zero LLM calls. The question this pass answers is "which lorebook
// entries actually shaped this story?" — a selective entry that never
// fired is latent canon at best, while one that fired forty times is
// established fact the transcript was played under.
//
// Two sources, in order of trust:
//
//   1. `header.wi_fired` — real telemetry captured at generation time by
//      phase 0. Exact, but only covers turns played since that shipped.
//   2. A replay of the world-info scanner over the transcript. Covers
//      everything, but is APPROXIMATE by construction: probability rolls
//      are re-rolled, and sticky/cooldown state was never recorded, so a
//      replayed activation is "this could have fired", not "this did".
//
// The union is marked `replay_approx` whenever (2) contributed, and the
// caller propagates that into the checkpoint so the review UI can say so
// rather than presenting a guess as a measurement.

import { sanitizeWiFired, wiFiredKey, looksLikeLegacyWiFiredKey, type WiFiredMap } from '../wiFired';
import type { IngestMessage } from './types';

/** The subset of a world-info entry the replay needs. Structural copy so
 *  this module never imports worldInfoStore (and through it, half the
 *  app) into the ingestion path. */
export interface ReplayEntry {
  id: string;
  bookId: string;
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  caseSensitive: boolean;
  /** Explicit co-fire links (entry ids): targets fire whenever this
   *  entry does, transitively, bypassing their own keys. */
  relatedIds: string[];
  /** Per-entry override; falls back to the global scan depth. */
  scanDepth?: number | null;
}

export interface ReplayResult {
  /** bookId:entryId → how many turns it plausibly fired on. */
  fired: WiFiredMap;
  /** True when any part of this map came from replay rather than
   *  captured telemetry. */
  approximate: boolean;
  /** Active entries confirmed to have never fired: the (deliberately
   *  over-inclusive) replay scan found no keyword hit, AND telemetry
   *  coverage for this chat has no known gaps. Disjoint from
   *  notObservable — an entry is in exactly one of the two, never both. */
  neverFired: string[];
  /** Active entries this pass cannot make a never-fired claim about,
   *  because `capturedFired` carried at least one pre-cutover key
   *  (looksLikeLegacyWiFiredKey) that doesn't match any CURRENTLY active
   *  entry — real telemetry sitting under an id this pass can't place. An
   *  apparent miss might be that orphaned key's actual entry rather than a
   *  fact, and there's no way to tell which one, so the whole never-fired
   *  verdict for this chat is downgraded rather than risk a false claim
   *  for an arbitrary subset. Empty whenever `capturedFired` carries no
   *  such residue — the ordinary post-cutover case, and this field's
   *  entire reason for existing is Gap 1 (id-crosswalk) coverage, not a
   *  general "replay didn't run" signal: `approximate` already owns that. */
  notObservable: string[];
}

function keyMatches(haystack: string, key: string, caseSensitive: boolean): boolean {
  if (!key) return false;
  const re = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (re) {
    try {
      let flags = re[2];
      if (!caseSensitive && !flags.includes('i')) flags += 'i';
      return new RegExp(re[1], flags).test(haystack);
    } catch {
      // Fall through to a literal match — an uncompilable regex key is
      // the author's typo, not a reason to drop the entry entirely.
    }
  }
  return caseSensitive
    ? haystack.includes(key)
    : haystack.toLowerCase().includes(key.toLowerCase());
}

/**
 * Replay the keyword scan across the transcript.
 *
 * Deliberately simplified against the live scanner: no recursion, no
 * token budgeting, no group weighting, probability is treated as "could
 * fire" rather than re-rolled, and relatedIds pull-ins skip the timed
 * effects (delay/cooldown) the live scanner consults. Every one of those
 * simplifications makes the result MORE inclusive, which is the right
 * direction — an entry we flag as possibly-fired gets reviewed, one we
 * wrongly drop silently vanishes from the bible. (`critical` needs no
 * modelling here for the same reason: it only restricts recursion
 * triggering and budget eviction, neither of which replay has.)
 */
export function replayWorldInfo(
  messages: IngestMessage[],
  entries: ReplayEntry[],
  opts: { scanDepth?: number; capturedFired?: unknown } = {}
): ReplayResult {
  const scanDepth = Math.max(1, opts.scanDepth ?? 2);
  const captured = sanitizeWiFired(opts.capturedFired);
  const fired: WiFiredMap = {};
  let replayed = false;

  // Captured telemetry wins outright — it's a measurement.
  for (const [key, stats] of Object.entries(captured)) {
    fired[key] = { ...stats };
  }

  const active = entries.filter((e) => e.enabled && e.content.trim());
  const scannable = messages.filter((m) => !m.isSystem);

  let turn = 0;
  for (let i = 0; i < scannable.length; i++) {
    // The scanner looks at the trailing `scanDepth` messages before each
    // AI turn, so replay that window rather than the whole transcript.
    if (scannable[i].isUser) continue;
    const window = scannable
      .slice(Math.max(0, i - scanDepth), i)
      .map((m) => m.content || '')
      .join('\n');

    for (const entry of active) {
      const key = wiFiredKey(entry.bookId, entry.id);
      const perEntryDepth = entry.scanDepth ?? scanDepth;
      const haystack =
        perEntryDepth === scanDepth
          ? window
          : scannable
              .slice(Math.max(0, i - Math.max(1, perEntryDepth)), i)
              .map((m) => m.content || '')
              .join('\n');

      const hit =
        entry.constant ||
        entry.keys.some((k) => keyMatches(haystack, k, entry.caseSensitive));
      if (!hit) continue;

      replayed = true;
      const prev = fired[key];
      if (prev) {
        prev.first_turn = Math.min(prev.first_turn, turn);
        prev.last_turn = Math.max(prev.last_turn, turn);
        // Don't inflate a captured count with replayed hits: keep the
        // measured number when we have one.
        if (!captured[key]) prev.count += 1;
      } else {
        fired[key] = { first_turn: turn, last_turn: turn, count: 1 };
      }
    }
    turn++;
  }

  // Explicit links: mirror the live scanner's relatedIds pull-ins — an
  // entry linked from one that fired co-fires with it, transitively,
  // regardless of its own keys. Cycle-safe via the seen-set; dangling
  // ids (deleted entries, inactive books) are ignored.
  const byId = new Map(active.map((e) => [e.id, e]));
  const queue = active.filter((e) => fired[wiFiredKey(e.bookId, e.id)]);
  const seen = new Set(queue.map((e) => e.id));
  while (queue.length > 0) {
    const src = queue.pop() as ReplayEntry;
    const srcStats = fired[wiFiredKey(src.bookId, src.id)];
    for (const relId of src.relatedIds) {
      if (seen.has(relId)) continue;
      seen.add(relId);
      const rel = byId.get(relId);
      if (!rel) continue;
      const key = wiFiredKey(rel.bookId, rel.id);
      if (!fired[key]) {
        // A pull-in is reconstructed, never measured — it co-fired
        // whenever its source did, so it inherits the source's stats.
        replayed = true;
        fired[key] = { ...srcStats };
      }
      queue.push(rel);
    }
  }

  // A captured key that (a) looks pre-cutover and (b) doesn't match any
  // CURRENTLY active entry's key is orphaned residue: real telemetry this
  // pass can't place. See notObservable's own doc comment for why that
  // downgrades the WHOLE chat's never-fired verdict rather than a guessed
  // subset of it. Checked against `captured` (the raw input), not `fired`
  // (the union) — every captured key already lands in `fired` regardless
  // of shape (the loop above), so this is purely "does the key's OWN
  // active-entry match exist," independent of whether IT reads as fired.
  const activeKeys = new Set(active.map((e) => wiFiredKey(e.bookId, e.id)));
  const hasUnplacedLegacyResidue = Object.keys(captured).some(
    (key) => !activeKeys.has(key) && looksLikeLegacyWiFiredKey(key)
  );

  const missing = active
    .map((e) => wiFiredKey(e.bookId, e.id))
    .filter((key) => !fired[key]);
  const neverFired = hasUnplacedLegacyResidue ? [] : missing;
  const notObservable = hasUnplacedLegacyResidue ? missing : [];

  return { fired, approximate: replayed, neverFired, notObservable };
}

/**
 * Group chats never scan world info at all (the group context builder
 * takes a different path), so a replay over one is pure speculation.
 * Callers use this to skip the pass and say why.
 */
export function replaySupported(isGroupChat: boolean): boolean {
  return !isGroupChat;
}
