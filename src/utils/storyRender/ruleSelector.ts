// World-rule selection by world-info activation replay (plan §3.5).
//
// The first draft of the step-3 plan proposed selecting rules "filtered by
// location_ref and participant ids". That filter CANNOT BE WRITTEN:
// `WorldRule` is `{id, text, category, source, confidence, established_in}`
// — no place reference, no character reference — and its one scene-facing
// join key, `established_in`, is `null` on every cold-start-minted rule.
// The two-hop path through a scene is dead too, since the walk writes
// `setting.location_ref: null` unconditionally.
//
// What DOES exist is the mechanism the story was played under. Every world
// rule is lorebook-derived (cold start is the only writer of `world.rules`,
// and the walk mints none), and each carries `source.ref.{book_id,
// entry_id}` back to its entry. So every rule can reach its entry's
// world-info KEYS, and `wiReplay` already implements the scanner over them.
//
// This selector is therefore honest about what it returns: THE ENTRIES
// WHOSE KEYS APPEAR IN THIS SCENE'S WINDOW — not "exactly what fired".

import {
  replayWorldInfo,
  type ReplayEntry,
} from '../storyIngest/wiReplay';
import { wiFiredKey } from '../wiFired';
import type { IngestMessage } from '../storyIngest/types';
import type { WorldRule } from '../../types/storyBible';
import type { SelectedRules } from './types';

/** The lorebook ref a cold-start rule carries. */
function entryKeyFor(rule: WorldRule): string | null {
  const source = rule.source as
    | { kind?: string; ref?: { book_id?: unknown; entry_id?: unknown } }
    | null
    | undefined;
  if (source?.kind !== 'lorebook_entry') return null;
  const bookId = source.ref?.book_id;
  const entryId = source.ref?.entry_id;
  if (typeof bookId !== 'string' || typeof entryId !== 'string') return null;
  return wiFiredKey(bookId, entryId);
}

export interface RuleSelectionInput {
  /** `world.rules` — every rule in the bible. */
  rules: WorldRule[];
  /** The CURRENT effective lorebook entries, from the live stores. Phase 4
   *  supplies these; this module never reads a store. */
  entries: ReplayEntry[];
  /**
   * The scene's own messages PLUS the preceding `scanDepth` messages.
   *
   * The overlap is mandatory, not a nicety: `wiReplay` anchors to AI turns
   * and scans the `scanDepth` messages BEFORE each one, so without the
   * preceding messages the first AI turn of every scene is scanned against
   * a truncated window.
   */
  window: IngestMessage[];
  scanDepth?: number;
}

/**
 * Select the world rules that belong in this scene's brief.
 *
 * Two routes in, and they are not interchangeable:
 *
 *  - **Fired against the window**, by replaying the scanner over it.
 *  - **`constant`**, by DIRECT inclusion from the entry. A scene with no
 *    AI turn fires nothing at all — `wiReplay`'s `entry.constant ||` test
 *    sits inside the AI-turn loop — so relying on the replay for constants
 *    would silently drop the always-on lore from exactly those scenes.
 *
 * The `constant` flag is read from the ENTRY, never from the rule.
 * `WorldRule` does not store it, and its one proxy — cold start's
 * `confidence: entry.constant ? 'explicit' : 'inferred'` — is erased on
 * any bible that has run pass 1.5, which promotes every fired entry to
 * `'explicit'`. A rule whose entry is no longer in the book set therefore
 * has an UNKNOWABLE constant flag, and is counted in `unresolvedRules`
 * rather than guessed at.
 *
 * `opts.capturedFired` is deliberately NOT passed to the replay. It seeds
 * whole-chat phase-0 telemetry into `fired` before scanning, which is
 * correct for the ingestion pass that does pass it and fatal here: every
 * entry that ever fired anywhere would report as firing in every scene.
 */
export function selectWorldRules(input: RuleSelectionInput): SelectedRules {
  const { rules, entries, window } = input;

  const entryByKey = new Map<string, ReplayEntry>();
  for (const entry of entries) {
    entryByKey.set(wiFiredKey(entry.bookId, entry.id), entry);
  }

  const hasAiTurn = window.some((m) => !m.isSystem && !m.isUser);

  // No AI turn means the scanner produces nothing, so skip the work and
  // fall back to the constants floor. Running it anyway would be correct
  // but would report `approximate: false` in a way that reads as "we
  // checked and nothing fired" rather than "we could not check".
  const replay = hasAiTurn
    ? replayWorldInfo(window, entries, { scanDepth: input.scanDepth })
    : null;
  const firedKeys = new Set(Object.keys(replay?.fired ?? {}));

  const included: WorldRule[] = [];
  const nonFiring: WorldRule[] = [];
  let unresolvedRules = 0;

  for (const rule of rules) {
    const key = entryKeyFor(rule);
    if (key === null) {
      // Not lorebook-derived. Nothing mints these today — the walk writes
      // no rules — but a hand-edited or future-written rule has no entry
      // to scan, and dropping it silently would be the same class of
      // arbitrary truncation this selector exists to replace.
      included.push(rule);
      continue;
    }
    const entry = entryByKey.get(key);
    if (!entry) {
      // The book was detached, deleted or edited since the story was
      // played. `booksForChat` recomputes from CURRENT app state, so this
      // is reachable in normal use, not a corruption case.
      unresolvedRules++;
      nonFiring.push(rule);
      continue;
    }
    // `isActive` mirrors `wiReplay`'s own `entries.filter(e => e.enabled &&
    // e.content.trim())`. Without it the two routes DISAGREE: a disabled
    // keyword entry correctly cannot fire (it never reaches the scanner),
    // while a disabled CONSTANT entry was force-included — and `included`
    // is the category the assembler drops last, so lore the user switched
    // off displaced rules that actually fired. Cold start takes the same
    // position for the same reason: a switched-off entry never reached a
    // prompt, so it is not canon.
    const isActive = entry.enabled && entry.content.trim().length > 0;
    if ((entry.constant && isActive) || firedKeys.has(key)) {
      included.push(rule);
    } else {
      nonFiring.push(rule);
    }
  }

  return {
    included,
    nonFiring,
    caveats: {
      approximate: replay?.approximate ?? false,
      constantsOnly: !hasAiTurn,
      unresolvedRules,
    },
  };
}

/**
 * The message window for a scene: its own messages plus the preceding
 * `scanDepth` for the scanner's backward look.
 *
 * Pure index arithmetic over the transcript the caller already holds, so
 * the assembler never needs the chat itself.
 */
export function sceneWindow(
  messages: IngestMessage[],
  startMsgId: string,
  endMsgId: string,
  scanDepth = 2
): IngestMessage[] {
  const startIdx = messages.findIndex((m) => m.id === startMsgId);
  const endIdx = messages.findIndex((m) => m.id === endMsgId);
  // A scene whose anchors are gone from the transcript (deleted messages,
  // pre-phase-1 messages with no `ggbc_id`) gets an empty window rather
  // than the whole chat — over-inclusion here would put unrelated lore in
  // the brief and evict real content under the cap.
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return [];

  // The overlap is counted in NON-SYSTEM messages, because that is what
  // the scanner counts: `wiReplay` filters system messages out BEFORE it
  // slices its `scanDepth` window. Counting raw indices here made the
  // overlap silently short — zero effective messages when the preceding
  // rows happened to be system messages — which is exactly the truncated
  // window the overlap exists to prevent.
  const want = Math.max(1, scanDepth);
  let from = startIdx;
  let seen = 0;
  while (from > 0 && seen < want) {
    from--;
    if (!messages[from].isSystem) seen++;
  }
  return messages.slice(from, endIdx + 1);
}
