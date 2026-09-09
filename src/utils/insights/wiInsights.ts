/**
 * E2-S4 PR2 — pure projection from PR1's per-turn WI data into the
 * insights API's observability-typed shapes.
 *
 * WHAT THIS FILE IS NOT. It computes no token count of its own — every
 * `tokens` value below is copied verbatim from a number PR1 already
 * measured (`promptBreakdown.ts`'s builders, at assembly time). In
 * particular nothing here re-renders a world-info entry: that would run
 * `{{setvar}}`/`{{incvar}}` macros a second time and persist a write into
 * the user's chat (see promptBreakdown.ts's own header).
 *
 * WHAT THIS FILE IS. Two entry points, `projectClientTurn` and
 * `projectServerTurn` — AC4's Layer 1 (lexical split). Which one a given
 * turn goes through is decided by the CALLER (`insightsApi.ts`, reading
 * `PromptBreakdown.wi.activationSource`) — not by this module, and
 * specifically not by whether server facts happen to be present. That
 * distinction is the highest-priority mutation `insightsApi.test.ts`'s
 * I14 guards: deriving the split from `wi.server`'s truthiness instead of
 * `activationSource` would still put a client-scanned turn on the client
 * side and a normal server turn on the server side, but would mis-route a
 * turn stamped `activationSource: 'server'` whose `wi.server` never got
 * recorded — reconstructing exactly the "zeroed wiScanReport read as a
 * real figure" lie AC4 exists to prevent.
 *
 * `ServerTurnSource` (types.ts) has no `scan` field at all, so
 * `projectServerTurn` has no lexical way to read a client-scan number even
 * by accident — AC4's Layer 1 enforced by the type checker, not by
 * discipline. `ClientTurnWiInsight`/`ServerTurnWiInsight`'s differing
 * types for `pinnedTokens`/`pinnedOverBudget` are Layer 2 (see types.ts).
 * This file's own `evicted`-construction logic below is Layer 3 (runtime).
 *
 * Every import here is `import type` — this module's only runtime
 * dependency is on values it is handed as arguments, never on a store, a
 * builder, or a network call. `tools/insightsBoundary.test.ts` checks this
 * mechanically (AC1).
 */

import type {
  ClientTurnSource,
  ClientTurnWiInsight,
  EvictedEntryInsight,
  Observed,
  ServerTurnSource,
  ServerTurnWiInsight,
  SourceWiEntryRecord,
  SourceWiPlacement,
  TokenFigure,
  WiActivationReason,
  WiEntryInsight,
  WiPlacementInsight,
  WiWrapperKind,
} from './types';
import type { TokenizerProfile } from '../tokenizer';

// ---------------------------------------------------------------------------
// Shared per-entry projection
// ---------------------------------------------------------------------------

/**
 * Opaque slot label for one entry's placement — see `WiPlacementInsight`'s
 * own doc comment for why this is a label and not a re-exposed shape.
 */
function placementSlot(placement: SourceWiPlacement): string {
  switch (placement.stage) {
    case 'A':
      return `A:${placement.sectionId}`;
    case 'B':
      return `B:${placement.cls}:${placement.depth}`;
    case 'C':
      return `C:${placement.sectionId}`;
  }
}

/**
 * One `SourceWiEntryRecord` -> one `WiEntryInsight`. Shared by both
 * projectors for `entries`/`trimmedFromHistoryEntries`, and by
 * `projectClientTurn` for `evicted` (the client's `droppedEntries` are
 * full records, unlike the server's bare id list — see
 * `EvictedEntryInsight`'s doc comment).
 *
 * `engine` decides `activationReason` only: the client scanner computes no
 * activation reason at all (structural, not a gap — every client-scanned
 * entry refuses `client-scan-computes-no-activation-reason` regardless of
 * what the record happens to carry), while a server-scanned entry reports
 * the reason the backend sent, refusing the SAME code when the backend
 * didn't report one (the historical missing-`dto.activations` case,
 * serverRetrieval.ts) — `client-scan-computes-no-activation-reason` is the
 * one declared reason that fits "no activation reason is knowable for
 * this entry from this data source," so both cases reuse it rather than
 * inventing an undeclared one.
 */
function projectEntry(
  record: SourceWiEntryRecord,
  profile: TokenizerProfile,
  engine: 'client' | 'server'
): WiEntryInsight {
  const emittedTokens: Observed<TokenFigure> =
    record.emittedTokens === null
      ? { observed: false, why: 'entry-never-rendered' }
      : {
          observed: true,
          value: { basis: 'emitted', estimator: profile, tokens: record.emittedTokens },
        };

  const wrapper: Observed<WiWrapperKind> =
    record.wrapper === null
      ? { observed: false, why: 'entry-never-rendered' }
      : { observed: true, value: record.wrapper };

  const placement: Observed<WiPlacementInsight> =
    record.placement === null
      ? { observed: false, why: 'entry-never-rendered' }
      : { observed: true, value: { slot: placementSlot(record.placement) } };

  const activationReason: Observed<WiActivationReason> =
    engine === 'server' && record.activationReason !== undefined
      ? { observed: true, value: record.activationReason }
      : { observed: false, why: 'client-scan-computes-no-activation-reason' };

  return {
    entryId: record.entryId,
    bookId: record.bookId,
    // Always observable — see SourceWiEntryRecord's own doc comment.
    rawTokens: { basis: 'raw', estimator: profile, tokens: record.rawTokens },
    emittedTokens,
    wrapper,
    placement,
    activationReason,
    pinned: record.pinned,
  };
}

/**
 * Turn-level aggregate (`emittedTotal`/`rawTotal`). `=== null` (never
 * `?? 0`) and no truthiness test on `tokens` (never `if (!tokens)`) — I11
 * pins both: a mutation to either check fails in the OPPOSITE direction
 * (defaulting null to a false "observed 0", or refusing a genuine 0 as
 * unobserved).
 */
function projectAggregateTokens(
  tokens: number | null,
  basis: TokenFigure['basis'],
  profile: TokenizerProfile
): Observed<TokenFigure> {
  if (tokens === null) return { observed: false, why: 'no-observed-turn' };
  return { observed: true, value: { basis, estimator: profile, tokens } };
}

// ---------------------------------------------------------------------------
// The two projectors (AC4 Layer 1)
// ---------------------------------------------------------------------------

/**
 * A client-scanned turn. Every scan-report figure (`budget`, `pinnedTokens`,
 * `pinnedOverBudget`, `droppedEntries`) is REAL and unconditionally
 * observable — `scanMessagesForEntries` always ran when this function is
 * the one being called, so there is nothing to refuse.
 *
 * `evicted` is always `{ observed: true, ... }`, even when
 * `scan.droppedEntries` is empty — I3: an empty scan-eviction list is a
 * real positive fact ("nothing was evicted this scan"), never a refusal.
 * Never re-derive it from `evicted.value.length === 0`; read it off the
 * scan's own dropped list, whatever its length.
 */
export function projectClientTurn(src: ClientTurnSource): ClientTurnWiInsight {
  return {
    mode: src.mode,
    chatFile: src.chatFile,
    publishedAt: src.publishedAt,
    profile: src.profile,
    engine: 'client',
    emittedTotal: projectAggregateTokens(src.emittedTokens, 'emitted', src.profile),
    rawTotal: projectAggregateTokens(src.rawTokens, 'raw', src.profile),
    entries: src.entries.map((e) => projectEntry(e, src.profile, 'client')),
    trimmedFromHistoryEntries: src.trimmedFromHistoryEntries.map((e) =>
      projectEntry(e, src.profile, 'client')
    ),
    evicted: {
      observed: true,
      value: src.scan.droppedEntries.map((e) => projectEntry(e, src.profile, 'client')),
    },
    budget: {
      observed: true,
      value: { basis: 'raw', estimator: src.profile, tokens: src.scan.budget },
    },
    pinnedTokens: {
      observed: true,
      value: { basis: 'raw', estimator: src.profile, tokens: src.scan.pinnedTokens },
    },
    pinnedOverBudget: { observed: true, value: src.scan.pinnedOverBudget },
  };
}

/**
 * A server-scanned turn. `pinnedTokens`/`pinnedOverBudget` refuse
 * UNCONDITIONALLY (`server-path-no-scan-report`) regardless of whether
 * `src.server` itself is present — the client scan never ran on this turn
 * either way, which is the fact those two fields report. `budget` and
 * `evicted` DO depend on `src.server`'s presence (`server-facts-missing`
 * when absent — the "activationSource is 'server' but wi.server never got
 * stamped" case, I14's third case) and otherwise follow AC4's Layer 3
 * eviction rules:
 *
 *   src.server undefined                 -> server-facts-missing
 *   server.evictedEntryIds undefined      -> backend-does-not-report-eviction
 *     (covers both "backend never sent the key" and "sent pure garbage" —
 *      serverRetrieval.ts already collapses both to `undefined` before
 *      this ever runs)
 *   server.evictedEntryIds === []         -> observed, value [] (a real
 *      positive fact: the backend said nothing was evicted)
 *   server.evictedEntryIds non-empty      -> observed, value [...] — each
 *      entry's bookId/tokens refuse `server-reports-id-only` (the backend
 *      reports bare ids only, never a book pairing or a cost)
 *
 * `budget` uses `src.server.budgetEstimator` ('generic', unconditionally —
 * ServerActivationFacts's own contract), NEVER `src.profile` — I10.
 */
export function projectServerTurn(src: ServerTurnSource): ServerTurnWiInsight {
  const server = src.server;

  const budget: Observed<TokenFigure> = server
    ? {
        observed: true,
        value: { basis: 'raw', estimator: server.budgetEstimator, tokens: server.budgetRequested },
      }
    : { observed: false, why: 'server-facts-missing' };

  const evicted: Observed<readonly EvictedEntryInsight[]> = !server
    ? { observed: false, why: 'server-facts-missing' }
    : server.evictedEntryIds === undefined
      ? { observed: false, why: 'backend-does-not-report-eviction' }
      : {
          observed: true,
          value: server.evictedEntryIds.map((entryId) => ({
            entryId,
            bookId: { observed: false, why: 'server-reports-id-only' },
            tokens: { observed: false, why: 'server-reports-id-only' },
          })),
        };

  return {
    mode: src.mode,
    chatFile: src.chatFile,
    publishedAt: src.publishedAt,
    profile: src.profile,
    engine: 'server',
    emittedTotal: projectAggregateTokens(src.emittedTokens, 'emitted', src.profile),
    rawTotal: projectAggregateTokens(src.rawTokens, 'raw', src.profile),
    entries: src.entries.map((e) => projectEntry(e, src.profile, 'server')),
    trimmedFromHistoryEntries: src.trimmedFromHistoryEntries.map((e) =>
      projectEntry(e, src.profile, 'server')
    ),
    evicted,
    budget,
    pinnedTokens: { observed: false, why: 'server-path-no-scan-report' },
    pinnedOverBudget: { observed: false, why: 'server-path-no-scan-report' },
  };
}
