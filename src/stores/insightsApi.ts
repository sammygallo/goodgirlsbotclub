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
} from '../utils/insights/types';

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
  if (opts?.chatFiles) return { scope: 'caller-supplied', files: opts.chatFiles };
  return {
    scope: 'in-memory-chat-list',
    files: useChatStore.getState().chatFiles.map((f) => f.fileName),
  };
}

function countAiTurns(messages: readonly { isUser: boolean; isSystem: boolean }[]): number {
  let n = 0;
  for (const m of messages) {
    if (!m.isUser && !m.isSystem) n++;
  }
  return n;
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

  const { currentChatFile, messages } = useChatStore.getState();
  const openChatInScope = currentChatFile !== null && files.includes(currentChatFile);
  const aiTurnsInScope: Observed<number> = openChatInScope
    ? { observed: true, value: countAiTurns(messages) }
    : { observed: false, why: 'transcript-not-in-memory' };

  return {
    scope,
    chatsInScope: { observed: true, value: files.length },
    chatsWithTelemetry: { observed: true, value: chatsWithTelemetryCount },
    turns: {
      aiTurnsInScope,
      turnsWithTelemetry: { observed: false, why: 'turn-telemetry-not-persisted' },
      chatsWithUncountedTurns: {
        observed: true,
        value: files.length - (openChatInScope ? 1 : 0),
      },
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
  return { observed: true, complete: true, exact: sum };
}

/**
 * The one live-turn sample this API can ever offer for an entry —
 * `sampledTurns` is always the literal `1` (`EntryEmittedSample`'s own doc
 * comment). Deliberately searches only `wi.entries` (what actually
 * reached the assembled prompt), not `wi.trimmedFromHistoryEntries`: a
 * trimmed entry rendered but never reached the model, so counting it
 * would misrepresent what this turn actually cost.
 */
function computeEmittedSample(key: { bookId: string; entryId: string }): Observed<EntryEmittedSample> {
  const breakdown = useGenerationStore.getState().lastPromptBreakdown;
  if (!breakdown) return { observed: false, why: 'no-observed-turn' };

  const match = breakdown.wi.entries.find(
    (e) => e.bookId === key.bookId && e.entryId === key.entryId
  );
  if (!match || match.emittedTokens === null) {
    return { observed: false, why: 'entry-never-rendered' };
  }
  return {
    observed: true,
    value: {
      sampledTurns: 1,
      tokens: { basis: 'emitted', estimator: breakdown.profile, tokens: match.emittedTokens },
    },
  };
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
