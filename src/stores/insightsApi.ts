/**
 * E2-S4 PR2 — the insights data API's store binder.
 *
 * THE ONLY FILE (in this module) IMPORTING `chatStore`/`generationStore`.
 * `src/utils/insights/types.ts` and `src/utils/insights/wiInsights.ts`
 * never do (see their own headers) — `tools/insightsBoundary.test.ts`
 * checks that mechanically. This file is deliberately thin: it reads real
 * store state, shapes it into `wiInsights.ts`'s pure input types, and
 * otherwise contains only the coverage/aggregate bookkeeping that has no
 * natural home in a "computes no token count" pure module.
 *
 * NOT a zustand store — no `create()`, no subscribers, nothing to persist.
 * Every function below is a plain read: it looks at whatever
 * `chatStore`/`generationStore` hold RIGHT NOW and returns an
 * observability-typed snapshot. Calling it twice in a row can return two
 * different answers if the underlying stores changed in between, same as
 * reading `useChatStore.getState()` directly would.
 *
 * SCOPE BOUNDARY (roadmap E2-S4's crux, PM-decided): the coverage figures
 * below are computed by INTERSECTING with `chatStore`'s in-memory
 * `chatFiles` — the selected character's own chats, already resident, no
 * new network IO — rather than by fetching every chat's header to check
 * for `wi_fired` (which would be new async IO, a §6.1 trigger, and would
 * push this story out of its size class). `TelemetryCoverage.scope` names
 * this explicitly so a consumer can never mistake it for library-wide
 * coverage.
 */

import { getWiFiredForChat, isWiFiredCoveragePartial, useChatStore } from './chatStore';
import { useGenerationStore } from './generationStore';
import { projectClientTurn, projectServerTurn } from '../utils/insights/wiInsights';
import { wiFiredKey } from '../utils/wiFired';
import type {
  ChatScope,
  ClientTurnSource,
  EntryEmittedSample,
  EntryFiringAggregate,
  FiringCount,
  Observed,
  ObservedFalseReason,
  ServerTurnSource,
  TelemetryCoverage,
  TurnWiInsight,
  Unobservable,
} from '../utils/insights/types';
import type { ServerActivationFacts } from '../utils/promptBreakdown';

// ---------------------------------------------------------------------------
// getTurnWiInsight
// ---------------------------------------------------------------------------

/**
 * The current live turn's WI insight, or an honest refusal.
 *
 * `generationStore.lastPromptBreakdown` is ONE last-write-wins slot,
 * explicitly not persisted (generationStore.ts's own doc comment) — it
 * describes whatever the most recent build published, which in a group
 * round is only the LAST speaker's turn (each speaker's build overwrites
 * it). `opts.forChatFile` lets a caller holding a specific chat file
 * refuse rather than silently read a different turn's numbers.
 *
 * The client/server split reads `breakdown.wi.activationSource` —
 * NEVER `breakdown.wi.server`'s truthiness. See wiInsights.ts's own
 * header for why that distinction is load-bearing (I14).
 */
export function getTurnWiInsight(opts?: { forChatFile?: string }): Observed<TurnWiInsight> {
  const breakdown = useGenerationStore.getState().lastPromptBreakdown;
  if (!breakdown) return { observed: false, why: 'breakdown-slot-empty' };
  if (opts?.forChatFile !== undefined && breakdown.chatFile !== opts.forChatFile) {
    return { observed: false, why: 'breakdown-slot-describes-another-turn' };
  }

  const common = {
    mode: breakdown.mode,
    chatFile: breakdown.chatFile,
    publishedAt: breakdown.publishedAt,
    profile: breakdown.profile,
    emittedTokens: breakdown.wi.emittedTokens,
    rawTokens: breakdown.wi.rawTokens,
    entries: breakdown.wi.entries,
    trimmedFromHistoryEntries: breakdown.wi.trimmedFromHistoryEntries,
  };

  if (breakdown.wi.activationSource === 'server') {
    const src: ServerTurnSource = { ...common, server: breakdown.wi.server };
    return { observed: true, value: projectServerTurn(src) };
  }

  const src: ClientTurnSource = {
    ...common,
    scan: {
      budget: breakdown.wi.budget,
      pinnedTokens: breakdown.wi.pinnedTokens,
      pinnedOverBudget: breakdown.wi.pinnedOverBudget,
      droppedEntries: breakdown.wi.droppedEntries,
    },
  };
  return { observed: true, value: projectClientTurn(src) };
}

// ---------------------------------------------------------------------------
// getTelemetryCoverage
// ---------------------------------------------------------------------------

function resolveChatFileScope(opts?: {
  chatFiles?: readonly string[];
}): { scope: ChatScope; files: readonly string[] } {
  if (opts?.chatFiles) return { scope: 'caller-supplied', files: [...new Set(opts.chatFiles)] };
  return {
    scope: 'in-memory-chat-list',
    files: [...new Set(useChatStore.getState().chatFiles.map((f) => f.fileName))],
  };
}

/**
 * `chatFiles === []` refuses (`chat-list-not-loaded`) ONLY for the
 * in-memory scope: `chatStore.chatFiles` starts empty and is populated by
 * `fetchChatFiles`, so an empty list there is indistinguishable from
 * "never fetched" — reporting `0` would claim a fact this app does not
 * have. A CALLER-SUPPLIED empty list carries no such ambiguity (the
 * caller said, explicitly, "these zero chats") and reports a real `0`.
 */
function computeCoverage(scope: ChatScope, files: readonly string[]): TelemetryCoverage {
  if (scope === 'in-memory-chat-list' && files.length === 0) {
    const why: ObservedFalseReason = 'chat-list-not-loaded';
    return {
      scope,
      chatsInScope: { observed: false, why },
      chatsWithTelemetry: { observed: false, why },
      turns: {
        aiTurnsInScope: { observed: false, why },
        turnsWithTelemetry: { observed: false, why: 'turn-telemetry-not-persisted' },
        chatsWithUncountedTurns: { observed: false, why },
      },
      recency: { observed: false, why: 'chat-recency-not-recorded' },
    };
  }

  // Numerator: chats this session has actually opened. `undefined` means
  // never opened this session (unobservable-by-omission); `{}` means
  // opened with zero recorded firings (a positive fact) — both count as
  // "has telemetry" for this purpose is wrong for the first and right for
  // the second, which is exactly why the test is `!== undefined`, never
  // `Object.keys(map ?? {}).length > 0` (that would misreport a
  // legitimately-empty-but-hydrated chat as uncovered) and never
  // `wiFiredByFile.size` (that counts every chat ever touched THIS
  // SESSION, including ones `resetUser()` dropped from `chatFiles` but not
  // from the module-private map — see chatStore.ts's own comment on that
  // map).
  const hydrated = files.map((f) => getWiFiredForChat(f) !== undefined);
  const chatsWithTelemetryCount = hydrated.filter(Boolean).length;

  const { currentChatFile } = useChatStore.getState();
  const openChatInScope = currentChatFile !== null && files.includes(currentChatFile);
  // Transcript identity is UNPROVABLE from existing chatStore state (PM
  // ruling, issue #530) — `aiTurnsInScope` refuses UNCONDITIONALLY.
  // `loadChat`/`loadGroupChat` move `currentChatFile` without `messages`
  // in the same atomic set, and
  // neither stamps any per-file confirmation a reader could check — true
  // even with no load in flight and none errored, not only during one
  // (the old `isLoading || error !== null` predicate under-refused on at
  // least three reachable paths). Failing closed always, rather than
  // guessing from those two flags or adding a staleness mechanism to
  // chatStore, is the fix; see `transcript-identity-unprovable`
  // (OBSERVED_FALSE_REASONS, types.ts).
  const aiTurnsInScope: Observed<number> = {
    observed: false,
    why: openChatInScope ? 'transcript-identity-unprovable' : 'transcript-not-in-memory',
  };

  return {
    scope,
    chatsInScope: { observed: true, value: files.length },
    chatsWithTelemetry: { observed: true, value: chatsWithTelemetryCount },
    turns: {
      aiTurnsInScope,
      turnsWithTelemetry: { observed: false, why: 'turn-telemetry-not-persisted' },
      // Every chat in scope, unconditionally — aiTurnsInScope never
      // observes a count any more (see its own comment above, and #530).
      chatsWithUncountedTurns: { observed: true, value: files.length },
    },
    recency: { observed: false, why: 'chat-recency-not-recorded' },
  };
}

export function getTelemetryCoverage(opts?: { chatFiles?: readonly string[] }): TelemetryCoverage {
  const { scope, files } = resolveChatFileScope(opts);
  return computeCoverage(scope, files);
}

// ---------------------------------------------------------------------------
// getEntryFiringAggregate
// ---------------------------------------------------------------------------

/**
 * A recorded firing is a measurement and stays true even when this chat's
 * legacy-remap coverage is partial (PM ruling, F5) — so a partial chat's
 * MATCHED count is always added to the running sum. What downgrades the
 * whole aggregate to a lower bound is an ABSENCE claim becoming
 * untrustworthy: either a chat this session never opened at all (its true
 * count is simply unknown), or a chat whose remap is partial reporting
 * no hit for this key (it may have fired under an unresolved legacy key
 * this lookup can't see). `chat-not-hydrated` takes priority over
 * `telemetry-coverage-partial` when both are present in scope — an
 * entirely un-opened chat is a bigger gap than a partially-mapped one.
 *
 * A third, lower-priority downgrade applies only to a caller-supplied
 * scope: even when every named chat is hydrated and non-partial, a bare
 * file name is a chat identity only within the one character's chat list
 * it came from — `wiFiredByFile` (chatStore.ts) is keyed by bare file name
 * across every character, so a caller-supplied list can silently collapse
 * two different characters' same-named chats onto one key. The sum is
 * still real (nothing here inflates or drops it), but the completeness
 * claim is not, so this arm never reports `complete: true` for that scope
 * (`chat-file-names-not-verified-distinct`, OBSERVED_FALSE_REASONS,
 * types.ts).
 */
function computeFiringCount(
  key: { bookId: string; entryId: string },
  files: readonly string[],
  coverage: TelemetryCoverage
): FiringCount {
  if (!coverage.chatsInScope.observed) {
    return { observed: false, why: coverage.chatsInScope.why };
  }

  const wanted = wiFiredKey(key.bookId, key.entryId);
  let sum = 0;
  let anyUnhydrated = false;
  let anyPartial = false;

  for (const file of files) {
    const fired = getWiFiredForChat(file);
    if (fired === undefined) {
      anyUnhydrated = true;
      continue;
    }
    sum += fired[wanted]?.count ?? 0;
    if (isWiFiredCoveragePartial(file)) anyPartial = true;
  }

  if (anyUnhydrated) return { observed: true, complete: false, atLeast: sum, why: 'chat-not-hydrated' };
  if (anyPartial) {
    return { observed: true, complete: false, atLeast: sum, why: 'telemetry-coverage-partial' };
  }
  if (coverage.scope === 'caller-supplied') {
    return {
      observed: true,
      complete: false,
      atLeast: sum,
      why: 'chat-file-names-not-verified-distinct',
    };
  }
  return { observed: true, complete: true, exact: sum };
}

/**
 * The one live-turn sample this API can ever offer for an entry —
 * `sampledTurns` is always the literal `1` (`EntryEmittedSample`'s own doc
 * comment). A measured emission in `wi.entries` outranks any absence
 * claim — checked first, on BOTH engines, before any engine split runs.
 * Past that point absence means something different per engine: on the
 * client arm the scan always ran, so `wi.droppedEntries` is real and can
 * be consulted directly; on the server arm that array is structurally
 * `[]` and must never be read, so
 * `classifyServerUnaccounted` below handles it instead. Engine is read
 * off `wi.activationSource`, NEVER `wi.server`'s truthiness — same rule,
 * same highest-priority mutation, as I14 (getTurnWiInsight, above).
 */
function computeEmittedSample(key: { bookId: string; entryId: string }): Observed<EntryEmittedSample> {
  const breakdown = useGenerationStore.getState().lastPromptBreakdown;
  if (!breakdown) return { observed: false, why: 'no-observed-turn' };

  const matchesKey = (e: { bookId: string; entryId: string }): boolean =>
    e.bookId === key.bookId && e.entryId === key.entryId;

  const rendered = breakdown.wi.entries.find(matchesKey);
  if (rendered) {
    if (rendered.emittedTokens !== null) {
      return {
        observed: true,
        value: {
          sampledTurns: 1,
          tokens: { basis: 'emitted', estimator: breakdown.profile, tokens: rendered.emittedTokens },
        },
      };
    }
    // Defensive: production only ever puts entries that reached
    // `wrapWiContent` (and so carry a real cost) into `wi.entries`, but
    // the TYPE does not forbid a null one — and a null cost here still
    // means "evaluated, never rendered," not "never accounted for."
    return { observed: false, why: 'entry-never-rendered' };
  }

  if (breakdown.wi.trimmedFromHistoryEntries.some(matchesKey)) {
    return { observed: false, why: 'entry-trimmed-from-history' };
  }

  if (breakdown.wi.activationSource === 'server') {
    return classifyServerUnaccounted(key.entryId, breakdown.wi.server);
  }

  // Client arm only past this point — the scan always ran.
  if (breakdown.wi.droppedEntries.some(matchesKey)) {
    return { observed: false, why: 'entry-never-rendered' };
  }
  return { observed: false, why: 'entry-not-accounted-for-this-turn' };
}

/**
 * The server arm's classifier for an entry that reached neither
 * `wi.entries` nor `wi.trimmedFromHistoryEntries` on a server-scanned
 * turn. Return type `Unobservable`, not `Observed<...>` — a type error
 * for this function to ever manufacture a value, the per-entry twin of
 * `ServerTurnWiInsight.pinnedTokens` (types.ts). Never reads
 * `wi.droppedEntries` — see `computeEmittedSample`'s own call site for
 * why that array is unreachable on this arm.
 */
function classifyServerUnaccounted(
  entryId: string,
  server: ServerActivationFacts | undefined
): Unobservable {
  if (server === undefined) return { observed: false, why: 'server-facts-missing' };
  if (server.evictedEntryIds === undefined) {
    return { observed: false, why: 'backend-does-not-report-eviction' };
  }
  if (server.evictedEntryIds.includes(entryId)) {
    // Bare id match only — evictedEntryIds carries no bookId pairing, so
    // this can't confirm the caller's full (bookId, entryId) key, only the
    // entryId string.
    return { observed: false, why: 'entry-evicted-but-bookid-unverified' };
  }
  return { observed: false, why: 'entry-not-accounted-for-this-turn' };
}

/**
 * Entry keys come FROM THE CALLER — this API never enumerates the
 * world-info library itself, which is what keeps `worldInfoStore` out of
 * this module's (and `wiInsights.ts`'s) import graph entirely.
 */
export function getEntryFiringAggregate(
  keys: readonly { bookId: string; entryId: string }[],
  opts?: { chatFiles?: readonly string[] }
): readonly EntryFiringAggregate[] {
  const { scope, files } = resolveChatFileScope(opts);
  const coverage = computeCoverage(scope, files);

  return keys.map((key) => ({
    bookId: key.bookId,
    entryId: key.entryId,
    coverage,
    generations: computeFiringCount(key, files, coverage),
    emittedSample: computeEmittedSample(key),
  }));
}
