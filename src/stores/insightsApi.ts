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
  ChatCountFigure,
  ChatScope,
  ClientTurnSource,
  EntryEmittedSample,
  EntryFiringAggregate,
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
 * refuse.
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
 * caller said, explicitly, "these zero chats") and reports a real `0` —
 * summing (or counting) over zero chats can never be wrong, so nothing
 * name-dependent about it needs the unverified wrapping either
 * (`wrapChatCount` below).
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
  // map). `getWiFiredForChat` reads that same module-level map, shared
  // across every character, so a `true` here does not prove THIS scope's
  // own chat was ever opened — see `wrapChatCount` below.
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

  // `chatsInScope`/`chatsWithUncountedTurns` count the NAMES in `files`
  // itself, never `wiFiredByFile` — real whenever nothing about name
  // identity is in doubt for that count: an empty scope, or the in-memory
  // scope's own list (backend-unique per character). `chatsWithTelemetry`
  // reads `wiFiredByFile` directly (see the comment above), which has no
  // such safe scope past empty — see types.ts's own doc on each field for
  // the full reasoning.
  const scopeListIsClean = files.length === 0 || scope === 'in-memory-chat-list';
  const telemetryIsClean = files.length === 0;

  return {
    scope,
    chatsInScope: wrapChatCount(files.length, scopeListIsClean),
    chatsWithTelemetry: wrapChatCount(chatsWithTelemetryCount, telemetryIsClean),
    turns: {
      aiTurnsInScope,
      turnsWithTelemetry: { observed: false, why: 'turn-telemetry-not-persisted' },
      // Every chat in scope, unconditionally — aiTurnsInScope never
      // observes a count any more (see its own comment above, and #530).
      chatsWithUncountedTurns: wrapChatCount(files.length, scopeListIsClean),
    },
    recency: { observed: false, why: 'chat-recency-not-recorded' },
  };
}

/**
 * Shared wrapper for `chatsInScope`/`chatsWithTelemetry`/
 * `chatsWithUncountedTurns` (`ChatCountFigure`, types.ts): a real,
 * verified `Observed<number>` when `clean` is true, else
 * `TelemetryDerivedCount`'s unverified arm carrying ONLY the
 * name-identity caveat — these three counts never have an internal reason
 * (unlike `computeFiringCount`'s `chat-not-hydrated`/`telemetry-coverage-
 * partial`), so the reasons tuple here is always exactly the one
 * mandatory element.
 */
function wrapChatCount(value: number, clean: boolean): ChatCountFigure {
  if (clean) return { observed: true, value };
  return {
    observed: true,
    verified: false,
    count: value,
    reasons: ['chat-file-names-not-verified-distinct'],
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
 * `chat-not-hydrated` means `getWiFiredForChat` had NO entry at all under
 * a scope file's bare name — a bigger gap than a partially-mapped chat's
 * entry existing but reporting no hit for this key, which is why it takes
 * priority over `telemetry-coverage-partial` when both are present in
 * scope. It does NOT mean the count is otherwise trustworthy once every
 * file IS hydrated: `wiFiredByFile` (chatStore.ts) has no per-character
 * partition at all, so a "hydrated" entry can belong wholly or partly to a
 * DIFFERENT character's same-named chat (`captureWiFired` accretes onto
 * it, `loadChat`/`loadGroupChat` merge into it, regardless of which
 * character is open) — hydration answers "does this map key exist",
 * never "is this map key's history solely the chat I meant." That is why
 * the sum below is wrapped as `TelemetryDerivedCount`'s unverified arm
 * once observed, in every NON-EMPTY scope — in-memory included, never
 * just for a caller-supplied one — see `chat-file-names-not-verified-
 * distinct`'s own comment (OBSERVED_FALSE_REASONS, types.ts) for the full
 * mechanism. A provably EMPTY scope is the one exception (see the early
 * return below): summing over zero chats can never collide, so it reports
 * a real `ChatCountFigure` `Observed<number>` `0` instead. This module
 * cannot say whether an affected sum reads higher or lower than a single
 * chat's own true count — `captureWiFired` can only add to a shared key,
 * `deleteChat` can wipe one out from under an unrelated character's chat —
 * so `count`'s own doc (types.ts) claims neither direction.
 */
function computeFiringCount(
  key: { bookId: string; entryId: string },
  files: readonly string[],
  coverage: TelemetryCoverage
): ChatCountFigure {
  if (!coverage.chatsInScope.observed) {
    return { observed: false, why: coverage.chatsInScope.why };
  }

  // Reachable here with `files.length === 0` only via an explicit
  // caller-supplied `chatFiles: []` — an empty in-memory scope already
  // returned above (`chatsInScope.observed` is false there,
  // `chat-list-not-loaded`). A caller-supplied empty scope is a
  // deliberate, unambiguous "zero chats": summing over none of them can
  // never collide on a shared `wiFiredByFile` key, so this is real, not
  // unverified — the same carve-out `wrapChatCount` gives
  // `chatsInScope`/`chatsWithTelemetry`/`chatsWithUncountedTurns`.
  if (files.length === 0) {
    return { observed: true, value: 0 };
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

  if (anyUnhydrated) {
    return {
      observed: true,
      verified: false,
      count: sum,
      reasons: ['chat-not-hydrated', 'chat-file-names-not-verified-distinct'],
    };
  }
  if (anyPartial) {
    return {
      observed: true,
      verified: false,
      count: sum,
      reasons: ['telemetry-coverage-partial', 'chat-file-names-not-verified-distinct'],
    };
  }
  return { observed: true, verified: false, count: sum, reasons: ['chat-file-names-not-verified-distinct'] };
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
          turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
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
