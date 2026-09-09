/**
 * E2-S4 PR2 — the insights data API's public type surface.
 *
 * WHAT THIS FILE IS. Every type the insights API (src/stores/insightsApi.ts)
 * exposes to a consumer (E5-S1, and this module's own tests), plus the
 * INPUT shapes `src/utils/insights/wiInsights.ts`'s pure projection
 * functions accept. Nothing here has a runtime footprint: every import is
 * `import type`, and `verbatimModuleSyntax` (tsconfig.app.json) makes that
 * a syntax-level guarantee `tools/insightsBoundary.test.ts` can check
 * mechanically rather than by inspecting behavior.
 *
 * WHY THE SOURCE (`*Source`) TYPES ARE LOCAL MIRRORS, NOT IMPORTS.
 * `PromptBreakdown.wi.entries` is `WiEntryRecord[]` (promptBreakdown.ts),
 * and `WiEntryRecord.placement` names `WiEntryPlacement`, which in turn
 * names `BreakdownSectionId` — the prompt-assembly taxonomy itself (every
 * `wi_*`/`group_wi_*`/`PromptSectionId` slot name). AC1 is "E5-S1 consumes
 * this without touching prompt-assembly internals," so nothing in this
 * module or `wiInsights.ts` may name `BreakdownSectionId`, even in a type
 * position — a `import type` edge is erased at compile time but a
 * consumer reading `TurnWiInsight`'s shape would still see the taxonomy
 * leak into its own type-checking. `SourceWiPlacement` below mirrors
 * `WiEntryPlacement`'s real shape field-for-field but widens `sectionId`
 * to plain `string` — a real `WiEntryPlacement` value (whose `sectionId`
 * is a `BreakdownSectionId`, a subtype of `string`) is structurally
 * assignable to it with zero conversion at the call site
 * (`src/stores/insightsApi.ts`, the only file that ever holds a real
 * `WiEntryRecord`). `WiPlacementInsight` (the OUTPUT type a consumer
 * actually reads) goes one step further and erases the shape entirely
 * behind an opaque `slot: string` label, built by `wiInsights.ts`.
 *
 * The same reasoning extends past what the plan strictly required
 * (only `WiPlacementInsight` was named as needing this): `WiWrapperKind`
 * and `WiActivationReason` are redeclared here too, rather than
 * `import type`'d from `promptBreakdown.ts`/`worldInfoStore.ts`. Both are
 * plain string-literal unions, so the redeclaration is one line each and
 * buys a strictly simpler boundary guard — File A's only import is
 * `TokenizerProfile`, a tokenizer-only utility type with no connection to
 * prompt assembly, chat storage, or world-info activation.
 */

import type { TokenizerProfile } from '../tokenizer';

// ---------------------------------------------------------------------------
// Observability primitives
// ---------------------------------------------------------------------------

/**
 * Every reason this API can refuse to report a figure. A closed set
 * (`as const`), not an open string — `ObservedFalseReason` derives from it
 * so a typo here is a compile error everywhere, and
 * `tools/insightsBoundary.test.ts`'s sibling suites (`I18`, in
 * `insightsApi.test.ts`) assert SET EQUALITY between this array and the
 * `why` values the test suite actually produces: nothing declared here may
 * go unexercised, and nothing produced may be a value that isn't declared.
 */
export const OBSERVED_FALSE_REASONS = [
  'server-path-no-scan-report',
  'server-facts-missing',
  'backend-does-not-report-eviction',
  'server-reports-id-only',
  'entry-never-rendered',
  'client-scan-computes-no-activation-reason',
  'no-observed-turn',
  'breakdown-slot-empty',
  'breakdown-slot-describes-another-turn',
  'chat-list-not-loaded',
  'chat-not-hydrated',
  'telemetry-coverage-partial',
  'transcript-not-in-memory',
  'turn-telemetry-not-persisted',
  'chat-recency-not-recorded',
] as const;

export type ObservedFalseReason = (typeof OBSERVED_FALSE_REASONS)[number];

/**
 * The false arm of `Observed<T>`. Deliberately has NO `value` field, not
 * even optional — `x.value ?? 0` on an `Unobservable` is a compile error,
 * not a silent `0`. That is the whole mechanism: a consumer cannot recover
 * a number from a refusal by accident.
 */
export interface Unobservable {
  readonly observed: false;
  readonly why: ObservedFalseReason;
}

/**
 * A figure this API can report, or an honest refusal. The refusal arm is
 * `Unobservable` verbatim (not a re-declared shape) so every unobservable
 * figure in this API — regardless of what `T` is — carries the identical
 * `{ observed: false; why }` shape a consumer can narrow on once and reuse
 * everywhere.
 */
export type Observed<T> = { readonly observed: true; readonly value: T } | Unobservable;

/**
 * A token count that names its own basis and the estimator that produced
 * it. A bare `number` is never a token figure anywhere in this API — see
 * `tools/insightsBoundary.test.ts`'s recursive-walker test (I9) and
 * `insightsApi.test.ts`'s own copy (I15), which both fail a figure that
 * loses either field.
 */
export interface TokenFigure {
  /** `'emitted'`: post-macro, post-wrapper cost of what actually reached
   *  the model. `'raw'`: the WI budget's own cost function, pre-macro,
   *  pre-wrapper — always computable, even for content that was never
   *  rendered. AC 6 / AC2's "self-describing" requirement is this field. */
  readonly basis: 'emitted' | 'raw';
  /** The tokenizer profile the count was measured with. Almost always the
   *  turn's own `profile` — the one documented exception is the server's
   *  own budget figure, which the backend always measures as `'generic'`
   *  regardless of the turn's provider (see `ServerTurnWiInsight.budget`). */
  readonly estimator: TokenizerProfile;
  readonly tokens: number;
}

// ---------------------------------------------------------------------------
// Redeclared leaf unions (see file header for why these aren't imported)
// ---------------------------------------------------------------------------

/** Mirrors `promptBreakdown.ts`'s `WiWrapperKind` exactly. */
export type WiWrapperKind = 'none' | 'persona' | 'owner';

/** Mirrors `worldInfoStore.ts`'s `WiActivationReason` exactly. */
export type WiActivationReason = 'constant' | 'keyword' | 'semantic' | 'sticky';

// ---------------------------------------------------------------------------
// Per-entry insight
// ---------------------------------------------------------------------------

/**
 * Where one entry's content landed in the assembled prompt, decoupled from
 * `BreakdownSectionId` — see file header. `slot` is an intentionally
 * OPAQUE label (e.g. `"A:wi_before_char"`, `"B:wi_at_depth:4"`): useful for
 * grouping/display and for telling two entries' placements apart, never
 * meant to be parsed back into a stage/section/depth by a consumer.
 */
export interface WiPlacementInsight {
  readonly slot: string;
}

/**
 * One world-info entry's own accounting for the CURRENT live turn — the
 * per-entry sibling of `ClientTurnWiInsight`/`ServerTurnWiInsight`'s
 * aggregate totals. Used for every entry that reached `wi.entries` or
 * `wi.trimmedFromHistoryEntries` (rendered), and — client path only — for
 * `wi.droppedEntries` (never rendered), where `emittedTokens`, `wrapper`
 * and `placement` all correctly refuse (`entry-never-rendered`) because
 * the underlying record really does carry `null` for each.
 */
export interface WiEntryInsight {
  readonly entryId: string;
  readonly bookId: string;
  /** Always observable — the WI budget's cost function reads stored
   *  content directly and runs no macros, so it is defined even for an
   *  entry that was evicted before ever rendering. */
  readonly rawTokens: TokenFigure;
  readonly emittedTokens: Observed<TokenFigure>;
  readonly wrapper: Observed<WiWrapperKind>;
  readonly placement: Observed<WiPlacementInsight>;
  /** Structurally absent on every client-scanned turn — the client
   *  scanner computes no activation reason at all, which is why the
   *  refusal reads `client-scan-computes-no-activation-reason` even
   *  though it is the near-universal case, not an edge one. */
  readonly activationReason: Observed<WiActivationReason>;
  readonly pinned: boolean;
}

/**
 * One entry the SERVER reported as evicted. Deliberately a different
 * (sparser) shape than `WiEntryInsight`: the server's `evictedEntryIds`
 * contract is a bare list of id strings with no book pairing and no token
 * cost — `bookId`/`tokens` always refuse `server-reports-id-only`, never
 * `entry-never-rendered` (the entry WAS evaluated; the server simply
 * never reports what it would have cost).
 */
export interface EvictedEntryInsight {
  readonly entryId: string;
  readonly bookId: Observed<string>;
  readonly tokens: Observed<TokenFigure>;
}

// ---------------------------------------------------------------------------
// Turn insight (AC4)
// ---------------------------------------------------------------------------

interface CommonTurnWiInsight {
  readonly mode: 'solo' | 'group';
  readonly chatFile: string | null;
  readonly publishedAt: number;
  readonly profile: TokenizerProfile;
  readonly emittedTotal: Observed<TokenFigure>;
  readonly rawTotal: Observed<TokenFigure>;
  readonly entries: readonly WiEntryInsight[];
  readonly trimmedFromHistoryEntries: readonly WiEntryInsight[];
  /** The WI budget itself — raw basis. Real and observable on the client
   *  path (the scan always ran); on the server path this is the backend's
   *  OWN reported budget, always estimator `'generic'`, and refuses
   *  `server-facts-missing` when the server never stamped facts at all. */
  readonly budget: Observed<TokenFigure>;
}

/**
 * A client-scanned turn. `pinnedTokens`/`pinnedOverBudget` are REAL,
 * observable figures here (`scanMessagesForEntries` always ran) — the type
 * itself is what makes `ServerTurnWiInsight`'s copies of these two fields
 * unable to hold a number (see that interface).
 */
export interface ClientTurnWiInsight extends CommonTurnWiInsight {
  readonly engine: 'client';
  /** Always `{ observed: true, ... }`, even when the value is `[]` — an
   *  empty scan-eviction list is a real positive fact ("nothing was
   *  evicted"), never a refusal. */
  readonly evicted: Observed<readonly WiEntryInsight[]>;
  readonly pinnedTokens: Observed<TokenFigure>;
  readonly pinnedOverBudget: Observed<boolean>;
}

/**
 * A server-scanned turn. `pinnedTokens`/`pinnedOverBudget` are typed as
 * `Unobservable` OUTRIGHT — not `Observed<TokenFigure>` — so there is no
 * `.value` a consumer (or a mutation) could ever read a number out of.
 * This is AC4's Layer 2: the server path's `wiScanReport` stays zeroed at
 * the source (chatStore.ts:1361-1371) precisely because no client scan
 * ran, and this type makes "read that zero as a real figure" a type error
 * rather than a runtime lie.
 */
export interface ServerTurnWiInsight extends CommonTurnWiInsight {
  readonly engine: 'server';
  readonly evicted: Observed<readonly EvictedEntryInsight[]>;
  readonly pinnedTokens: Unobservable;
  readonly pinnedOverBudget: Unobservable;
}

export type TurnWiInsight = ClientTurnWiInsight | ServerTurnWiInsight;

// ---------------------------------------------------------------------------
// Coverage (AC3)
// ---------------------------------------------------------------------------

/**
 * What set of chats a coverage or aggregate figure is scoped to.
 * `'in-memory-chat-list'`: chatStore's own `chatFiles` — one character's
 * chats, populated by `fetchChatFiles`, NOT the whole library.
 * `'caller-supplied'`: the caller passed an explicit `chatFiles` list.
 * Carried on every coverage figure so a consumer can never mistake either
 * for library-wide coverage.
 */
export type ChatScope = 'in-memory-chat-list' | 'caller-supplied';

export interface TurnCoverage {
  /** AI-turn count (prior non-user, non-system messages) of the chat
   *  currently open in `chatStore` — the only chat with a transcript held
   *  in memory. Refuses `transcript-not-in-memory` when no chat in scope
   *  is the open one. */
  readonly aiTurnsInScope: Observed<number>;
  /**
   * Always `Unobservable` — the type itself says so, not just the runtime
   * value. `wi_fired` persists `{first_turn,last_turn,count}` per entry,
   * never a per-TURN breakdown, so "how many of those N turns actually
   * have recorded telemetry" is not a question this data can answer, on
   * any chat, ever.
   */
  readonly turnsWithTelemetry: Unobservable;
  /** Chats in scope whose turn count this API structurally cannot count
   *  (every chat except the open one — no transcript in memory for it). */
  readonly chatsWithUncountedTurns: Observed<number>;
}

export interface TelemetryCoverage {
  readonly scope: ChatScope;
  /** The denominator. Refuses `chat-list-not-loaded` when the in-memory
   *  chat list is empty — empty is indistinguishable from never-fetched,
   *  so this never reports a bare `0` for that case. A caller-supplied
   *  empty list is a deliberate, unambiguous "zero chats" and DOES report
   *  a real `0` — see `insightsApi.ts`'s own comment at the point this is
   *  decided. */
  readonly chatsInScope: Observed<number>;
  /** The numerator: chats in scope this session has actually opened
   *  (`getWiFiredForChat(f) !== undefined`) — including a chat opened with
   *  zero recorded firings (`{}`), which is a positive fact, not a gap. */
  readonly chatsWithTelemetry: Observed<number>;
  readonly turns: TurnCoverage;
  /** Always `Unobservable`. `getChats`'s `last_mes` is a message-text
   *  preview (ggbc-backend `_last_message_preview`), not a timestamp, and
   *  a chat-filename epoch is a creation time `renameChat` can overwrite —
   *  there is no recency signal this API may honestly report. */
  readonly recency: Unobservable;
}

/**
 * How many times one entry fired, across the chats a `TelemetryCoverage`
 * claims. `exact` only when every in-scope chat both has been opened this
 * session AND has no legacy-remap partial-coverage flag; otherwise the
 * number is a LOWER BOUND (`atLeast`) and is never spelled `exact`.
 */
export type FiringCount =
  | { readonly observed: true; readonly complete: true; readonly exact: number }
  | {
      readonly observed: true;
      readonly complete: false;
      readonly atLeast: number;
      readonly why: ObservedFalseReason;
    }
  | Unobservable;

/**
 * A single measured emission cost for one entry, taken from the CURRENT
 * live turn only. `sampledTurns` is the literal `1` — not `number` — so
 * this type cannot even SHAPE a claim like "averaged over N turns": no
 * per-turn WI breakdown is ever persisted, so there is no second turn this
 * API could ever sample from.
 */
export interface EntryEmittedSample {
  readonly sampledTurns: 1;
  readonly tokens: TokenFigure;
}

export interface EntryFiringAggregate {
  readonly bookId: string;
  readonly entryId: string;
  readonly generations: FiringCount;
  /** REQUIRED, not optional — AC3's "a coverage figure accompanies every
   *  historical aggregate" is a type-level guarantee here, not a
   *  convention a caller could skip reading. */
  readonly coverage: TelemetryCoverage;
  readonly emittedSample: Observed<EntryEmittedSample>;
}

// ---------------------------------------------------------------------------
// Source types — what `wiInsights.ts`'s pure projection functions accept.
// Built and passed by `insightsApi.ts` from a real `PromptBreakdown`;
// structurally compatible with the real `WiEntryRecord`/
// `ServerActivationFacts` shapes (see file header) with zero conversion.
// ---------------------------------------------------------------------------

/** Mirrors `WiEntryPlacement`'s shape with `sectionId` widened to `string`
 *  — see file header. */
export type SourceWiPlacement =
  | { readonly stage: 'A'; readonly sectionId: string }
  | { readonly stage: 'B'; readonly cls: 'wi_at_depth'; readonly depth: number }
  | { readonly stage: 'C'; readonly sectionId: string };

/** Mirrors `WiEntryRecord`'s null-vs-zero discipline exactly (see that
 *  type's own doc comment in promptBreakdown.ts) — `emittedTokens`,
 *  `placement` and `wrapper` are all `null`, never a default, for an
 *  entry that never rendered. `emittedChars` is not carried through: no
 *  test or AC in this story needs it, and the WI insight surface has no
 *  field to put it in. */
export interface SourceWiEntryRecord {
  readonly entryId: string;
  readonly bookId: string;
  readonly emittedTokens: number | null;
  readonly rawTokens: number;
  readonly placement: SourceWiPlacement | null;
  readonly wrapper: WiWrapperKind | null;
  readonly activationReason?: WiActivationReason;
  readonly pinned: boolean;
}

/** Mirrors `ServerActivationFacts`'s eviction/budget fields.
 *  `activatedEntryIds` is not carried through — this API never derives
 *  eviction from it (see that field's own "provenance only" doc comment
 *  in promptBreakdown.ts). */
export interface SourceServerActivationFacts {
  readonly budgetRequested: number;
  readonly evictedEntryIds?: string[];
  readonly budgetEstimator: 'generic';
}

export interface CommonTurnSource {
  readonly mode: 'solo' | 'group';
  readonly chatFile: string | null;
  readonly publishedAt: number;
  readonly profile: TokenizerProfile;
  /**
   * Turn-level aggregates. Typed permissively (`number | null`) even
   * though the real `PromptBreakdown.wi.emittedTokens`/`rawTokens` are
   * always plain numbers today — this is what makes the refuse-don't-
   * default discipline testable at all (I11): a caller that ever DOES
   * have an unmeasured turn has a way to say so, and the projector must
   * refuse (`no-observed-turn`) rather than coerce it to `0`.
   */
  readonly emittedTokens: number | null;
  readonly rawTokens: number | null;
  readonly entries: readonly SourceWiEntryRecord[];
  readonly trimmedFromHistoryEntries: readonly SourceWiEntryRecord[];
}

/** No `server` field at all — a client-scanned turn's source can never
 *  carry server facts, by construction. */
export interface ClientTurnSource extends CommonTurnSource {
  readonly scan: {
    readonly budget: number;
    readonly pinnedTokens: number;
    readonly pinnedOverBudget: boolean;
    readonly droppedEntries: readonly SourceWiEntryRecord[];
  };
}

/**
 * No `scan` field AT ALL — this is the type-level half of AC4's Layer 1.
 * `projectServerTurn` (wiInsights.ts) takes a `ServerTurnSource`, so the
 * zeroed `wiScanReport` a server-path turn actually has in production is
 * not lexically reachable from inside that function: there is no field to
 * read it off even by mistake.
 */
export interface ServerTurnSource extends CommonTurnSource {
  readonly server: SourceServerActivationFacts | undefined;
}
