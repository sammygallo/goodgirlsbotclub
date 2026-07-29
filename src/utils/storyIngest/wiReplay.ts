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

import { sanitizeWiFired, wiFiredKey, type WiFiredMap } from '../wiFired';
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
  /** Per-entry override; falls back to the global scan depth. */
  scanDepth?: number | null;
}

export interface ReplayResult {
  /** bookId:entryId → how many turns it plausibly fired on. */
  fired: WiFiredMap;
  /** True when any part of this map came from replay rather than
   *  captured telemetry. */
  approximate: boolean;
  /** Entries that never fired by either route. */
  neverFired: string[];
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
 * token budgeting, no group weighting, and probability is treated as
 * "could fire" rather than re-rolled. Every one of those simplifications
 * makes the result MORE inclusive, which is the right direction — an
 * entry we flag as possibly-fired gets reviewed, one we wrongly drop
 * silently vanishes from the bible.
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

  const neverFired = active
    .map((e) => wiFiredKey(e.bookId, e.id))
    .filter((key) => !fired[key]);

  return { fired, approximate: replayed, neverFired };
}

/**
 * Group chats never scan world info at all (the group context builder
 * takes a different path), so a replay over one is pure speculation.
 * Callers use this to skip the pass and say why.
 */
export function replaySupported(isGroupChat: boolean): boolean {
  return !isGroupChat;
}
