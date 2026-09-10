/**
 * Pure-function tests for `wiInsights.ts`'s two projectors — everything
 * that doesn't need a real chatStore/generationStore turn (those live in
 * `src/stores/insightsApi.test.ts`, which drives real store actions).
 *
 * Every test names the mutation it kills, per the story brief.
 */
import { describe, it, expect } from 'vitest';
import { projectClientTurn, projectServerTurn } from './wiInsights';
import type {
  ClientTurnSource,
  ServerTurnSource,
  SourceWiEntryRecord,
} from './types';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function mkEntry(over: Partial<SourceWiEntryRecord> = {}): SourceWiEntryRecord {
  return {
    entryId: 'e1',
    bookId: 'b1',
    emittedTokens: 10,
    rawTokens: 8,
    placement: { stage: 'A', sectionId: 'wi_before_char' },
    wrapper: 'none',
    pinned: false,
    ...over,
  };
}

function mkClientSource(over: Partial<ClientTurnSource> = {}): ClientTurnSource {
  return {
    mode: 'solo',
    chatFile: 'chat.jsonl',
    publishedAt: 1,
    profile: 'gpt',
    emittedTokens: 0,
    rawTokens: 0,
    entries: [],
    trimmedFromHistoryEntries: [],
    scan: { budget: 0, pinnedTokens: 0, pinnedOverBudget: false, droppedEntries: [] },
    ...over,
  };
}

function mkServerSource(over: Partial<ServerTurnSource> = {}): ServerTurnSource {
  return {
    mode: 'solo',
    chatFile: 'chat.jsonl',
    publishedAt: 1,
    profile: 'gpt',
    emittedTokens: 0,
    rawTokens: 0,
    entries: [],
    trimmedFromHistoryEntries: [],
    server: { budgetRequested: 100, budgetEstimator: 'generic', evictedEntryIds: [] },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// I1 — server pinned unobservable, paired with the exact client number
// ---------------------------------------------------------------------------

describe('pinnedTokens / pinnedOverBudget (I1)', () => {
  it('server: always refuses server-path-no-scan-report, regardless of server facts', () => {
    const insight = projectServerTurn(mkServerSource());
    expect(insight.pinnedTokens).toEqual({ observed: false, why: 'server-path-no-scan-report' });
    expect(insight.pinnedOverBudget).toEqual({ observed: false, why: 'server-path-no-scan-report' });
  });

  it('client: reports the EXACT seeded scan number — kills refusing unconditionally', () => {
    const insight = projectClientTurn(
      mkClientSource({ scan: { budget: 500, pinnedTokens: 137, pinnedOverBudget: true, droppedEntries: [] } })
    );
    expect(insight.pinnedTokens).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'gpt', tokens: 137 },
    });
    expect(insight.pinnedOverBudget).toEqual({ observed: true, value: true });
  });

  it('client: pinnedOverBudget false is also reported as false — kills a hardcoded `value: true` (round 10, job 2)', () => {
    const insight = projectClientTurn(
      mkClientSource({ scan: { budget: 500, pinnedTokens: 137, pinnedOverBudget: false, droppedEntries: [] } })
    );
    expect(insight.pinnedOverBudget).toEqual({ observed: true, value: false });
  });
});

// ---------------------------------------------------------------------------
// Round 10, Job 2 — `chatFile: string | null` was never asserted with
// `null` as an OUTPUT anywhere in this module's test suite (every fixture,
// in both this file and insightsApi.test.ts, only ever set/asserted a real
// file-name string) — a coercion like `src.chatFile ?? 'unknown'` would
// have passed every existing test.
// ---------------------------------------------------------------------------
describe('chatFile null passthrough', () => {
  it('client: chatFile null passes through as null, not a coerced default', () => {
    const insight = projectClientTurn(mkClientSource({ chatFile: null }));
    expect(insight.chatFile).toBeNull();
  });

  it('server: same passthrough', () => {
    const insight = projectServerTurn(mkServerSource({ chatFile: null }));
    expect(insight.chatFile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I3 — client empty eviction is a positive fact, not a refusal
// ---------------------------------------------------------------------------

describe('client eviction (I3)', () => {
  it('an empty scan-dropped list is {observed:true, value:[]} — NOT a refusal', () => {
    const insight = projectClientTurn(mkClientSource({ scan: { budget: 10, pinnedTokens: 0, pinnedOverBudget: false, droppedEntries: [] } }));
    expect(insight.evicted.observed).toBe(true);
    if (!insight.evicted.observed) throw new Error('unreachable');
    expect(insight.evicted.value).toEqual([]);
  });

  it('a non-empty scan-dropped list projects each entry as a full WiEntryInsight', () => {
    const dropped = mkEntry({
      entryId: 'dropped-1',
      emittedTokens: null,
      placement: null,
      wrapper: null,
    });
    const insight = projectClientTurn(
      mkClientSource({ scan: { budget: 10, pinnedTokens: 0, pinnedOverBudget: false, droppedEntries: [dropped] } })
    );
    expect(insight.evicted).toEqual({
      observed: true,
      value: [
        {
          entryId: 'dropped-1',
          bookId: 'b1',
          rawTokens: { basis: 'raw', estimator: 'gpt', tokens: dropped.rawTokens },
          emittedTokens: { observed: false, why: 'entry-never-rendered' },
          wrapper: { observed: false, why: 'entry-never-rendered' },
          placement: { observed: false, why: 'entry-never-rendered' },
          activationReason: { observed: false, why: 'client-scan-computes-no-activation-reason' },
          pinned: false,
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// I9 — every token figure carries basis+estimator (recursive walker)
// ---------------------------------------------------------------------------

/** Finds every TokenFigure-shaped leaf in an arbitrary result tree. */
function findTokenFigures(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findTokenFigures(item, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if ('basis' in obj && 'estimator' in obj && typeof obj.tokens === 'number') {
    out.push(obj);
  }
  for (const value of Object.values(obj)) findTokenFigures(value, out);
  return out;
}

describe('every token figure is self-describing (I9)', () => {
  it('a rich client turn: every figure found carries basis+estimator, and the walker is non-vacuous', () => {
    const rendered = mkEntry({ entryId: 'rendered-1', emittedTokens: 12, rawTokens: 9 });
    const dropped = mkEntry({ entryId: 'dropped-1', emittedTokens: null, placement: null, wrapper: null, rawTokens: 3 });
    const insight = projectClientTurn(
      mkClientSource({
        emittedTokens: 40,
        rawTokens: 30,
        entries: [rendered],
        scan: { budget: 100, pinnedTokens: 5, pinnedOverBudget: false, droppedEntries: [dropped] },
      })
    );
    const figures = findTokenFigures(insight);
    // Non-vacuity: a walker whose path resolution silently found nothing
    // (or a `projectClientTurn` that refused every figure) must not pass.
    // Expected here: emittedTotal, rawTotal, budget, pinnedTokens,
    // rendered.rawTokens, rendered.emittedTokens, dropped.rawTokens = 7.
    expect(figures.length).toBeGreaterThanOrEqual(6);
    for (const f of figures) {
      expect(typeof f.basis, JSON.stringify(f)).toBe('string');
      expect(typeof f.estimator, JSON.stringify(f)).toBe('string');
      expect(typeof f.tokens, JSON.stringify(f)).toBe('number');
    }
  });

  it('a server turn with an evicted id and an entry: every figure found still carries basis+estimator', () => {
    const rendered = mkEntry({ entryId: 'rendered-1', emittedTokens: 12, rawTokens: 9 });
    const insight = projectServerTurn(
      mkServerSource({
        emittedTokens: 20,
        rawTokens: 15,
        entries: [rendered],
        server: { budgetRequested: 200, budgetEstimator: 'generic', evictedEntryIds: ['ev-1'] },
      })
    );
    const figures = findTokenFigures(insight);
    // emittedTotal, rawTotal, budget, rendered.rawTokens, rendered.emittedTokens = 5.
    // (evicted entries are id-only — no TokenFigure to find there.)
    expect(figures.length).toBeGreaterThanOrEqual(5);
    for (const f of figures) {
      expect(typeof f.basis).toBe('string');
      expect(typeof f.estimator).toBe('string');
      expect(typeof f.tokens).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// I10 — the server budget uses estimator 'generic' unconditionally
// ---------------------------------------------------------------------------

describe('server budget estimator (I10)', () => {
  it('uses "generic" even though the turn profile is non-generic', () => {
    const insight = projectServerTurn(
      mkServerSource({
        profile: 'claude',
        server: { budgetRequested: 4096, budgetEstimator: 'generic', evictedEntryIds: [] },
      })
    );
    expect(insight.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'generic', tokens: 4096 },
    });
  });
});

// ---------------------------------------------------------------------------
// CONF1 — the client budget TokenFigure's three fields, previously pinned
// by nothing. profile 'claude' (non-generic) and budget != pinnedTokens so
// all three fields are independently discriminating in one assertion.
// ---------------------------------------------------------------------------

describe('client budget TokenFigure (CONF1)', () => {
  it('basis "raw", estimator the turn profile (not "generic"), tokens the scan budget (not pinnedTokens)', () => {
    const insight = projectClientTurn(
      mkClientSource({
        profile: 'claude',
        scan: { budget: 4096, pinnedTokens: 137, pinnedOverBudget: false, droppedEntries: [] },
      })
    );
    expect(insight.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'claude', tokens: 4096 },
    });
  });
});

// ---------------------------------------------------------------------------
// I11 — emittedTokens: 0 observes 0, null refuses (opposite-direction kills)
// ---------------------------------------------------------------------------

describe('turn-level emittedTotal null-vs-zero (I11)', () => {
  it('0 is a real observed value — kills a truthiness check (`if (!tokens)`)', () => {
    const insight = projectClientTurn(mkClientSource({ emittedTokens: 0 }));
    expect(insight.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 0 },
    });
  });

  it('null refuses no-observed-turn — kills a `?? 0` default', () => {
    const insight = projectClientTurn(mkClientSource({ emittedTokens: null }));
    expect(insight.emittedTotal).toEqual({ observed: false, why: 'no-observed-turn' });
  });

  it('same discipline applies to rawTotal', () => {
    expect(projectClientTurn(mkClientSource({ rawTokens: 0 })).rawTotal).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'gpt', tokens: 0 },
    });
    expect(projectClientTurn(mkClientSource({ rawTokens: null })).rawTotal).toEqual({
      observed: false,
      why: 'no-observed-turn',
    });
  });
});

// ---------------------------------------------------------------------------
// I12 — per-entry wrapper: 'none' observes 'none', null refuses
// ---------------------------------------------------------------------------

describe('per-entry wrapper null-vs-"none" (I12)', () => {
  it('"none" is a real, legal, observed wrapper result — kills `wrapper ?? "none"` collapsing null into it', () => {
    const insight = projectClientTurn(mkClientSource({ entries: [mkEntry({ wrapper: 'none' })] }));
    expect(insight.entries[0].wrapper).toEqual({ observed: true, value: 'none' });
  });

  it('null (never rendered) refuses entry-never-rendered, distinct from "none"', () => {
    const insight = projectClientTurn(
      mkClientSource({
        scan: {
          budget: 0,
          pinnedTokens: 0,
          pinnedOverBudget: false,
          droppedEntries: [mkEntry({ wrapper: null, emittedTokens: null, placement: null })],
        },
      })
    );
    expect(insight.evicted.observed).toBe(true);
    if (!insight.evicted.observed) throw new Error('unreachable');
    expect(insight.evicted.value[0].wrapper).toEqual({ observed: false, why: 'entry-never-rendered' });
  });

  it('"persona" and "owner" are also observed as themselves', () => {
    const insight = projectClientTurn(
      mkClientSource({
        entries: [mkEntry({ entryId: 'p', wrapper: 'persona' }), mkEntry({ entryId: 'o', wrapper: 'owner' })],
      })
    );
    expect(insight.entries[0].wrapper).toEqual({ observed: true, value: 'persona' });
    expect(insight.entries[1].wrapper).toEqual({ observed: true, value: 'owner' });
  });
});

// ---------------------------------------------------------------------------
// WiEntryInsight.pinned is a straight passthrough, but no prior fixture
// ever set it to true, so a hardcoded `pinned: false` was invisible.
// ---------------------------------------------------------------------------

describe('per-entry pinned passthrough', () => {
  it('a pinned entry projects pinned: true — kills a hardcoded `pinned: false`', () => {
    const insight = projectClientTurn(mkClientSource({ entries: [mkEntry({ pinned: true })] }));
    expect(insight.entries[0].pinned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I13 — activationReason: client always refuses, server with a reason observes
// ---------------------------------------------------------------------------

describe('per-entry activationReason (I13)', () => {
  it('client turn: refuses client-scan-computes-no-activation-reason even if the record happens to carry one', () => {
    const insight = projectClientTurn(
      mkClientSource({ entries: [mkEntry({ activationReason: 'keyword' })] })
    );
    expect(insight.entries[0].activationReason).toEqual({
      observed: false,
      why: 'client-scan-computes-no-activation-reason',
    });
  });

  it('server turn with a reason: observes the real value', () => {
    const insight = projectServerTurn(
      mkServerSource({ entries: [mkEntry({ activationReason: 'semantic' })] })
    );
    expect(insight.entries[0].activationReason).toEqual({ observed: true, value: 'semantic' });
  });

  it('server turn with no reason reported: refuses the DISTINCT server code, not the client-scan one (C2)', () => {
    // The client scanner never ran on this turn at all — naming
    // `client-scan-computes-no-activation-reason` here would describe a
    // mechanism that was never invoked.
    const insight = projectServerTurn(mkServerSource({ entries: [mkEntry({ activationReason: undefined })] }));
    expect(insight.entries[0].activationReason).toEqual({
      observed: false,
      why: 'server-reports-no-activation-reason',
    });
  });
});

// ---------------------------------------------------------------------------
// I17 — sampledTurns lives on EntryEmittedSample (insightsApi.ts), not here;
// I19 — emittedTotal is not re-summed from entries
// ---------------------------------------------------------------------------

describe('emittedTotal is not re-derived from entries (I19)', () => {
  it('two entries summing to a DIFFERENT number than emittedTokens: the aggregate wins, not the sum', () => {
    // Mirrors the real join-residual gap (stageAJoinResidual's own doc
    // comment in promptBreakdown.ts): the joined-string measurement
    // legitimately differs from the per-entry sum.
    const insight = projectClientTurn(
      mkClientSource({
        emittedTokens: 999, // deliberately NOT entry1 + entry2
        entries: [mkEntry({ entryId: 'a', emittedTokens: 10 }), mkEntry({ entryId: 'b', emittedTokens: 20 })],
      })
    );
    expect(insight.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 999 },
    });
    // Sanity: the entries kept their own real numbers rather than being
    // coerced to match the total.
    expect(insight.entries[0].emittedTokens).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 10 },
    });
    expect(insight.entries[1].emittedTokens).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 20 },
    });
  });

  it('same for a server turn', () => {
    const insight = projectServerTurn(
      mkServerSource({
        emittedTokens: 777,
        entries: [mkEntry({ entryId: 'a', emittedTokens: 5 }), mkEntry({ entryId: 'b', emittedTokens: 5 })],
      })
    );
    expect(insight.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 777 },
    });
  });
});

// ---------------------------------------------------------------------------
// AC4 Layer 3 — server eviction (unit-level slice of I2; the full
// integration proof through a real sendMessage turn lives in
// insightsApi.test.ts, since serverRetrieval.ts's absent/garbage-mapping
// is what actually collapses the wire shapes before this ever runs).
// ---------------------------------------------------------------------------

describe('server eviction — Layer 3 rules', () => {
  it('server undefined -> server-facts-missing', () => {
    const insight = projectServerTurn(mkServerSource({ server: undefined }));
    expect(insight.evicted).toEqual({ observed: false, why: 'server-facts-missing' });
    expect(insight.budget).toEqual({ observed: false, why: 'server-facts-missing' });
  });

  it('evictedEntryIds undefined (absent or garbage, already collapsed upstream) -> backend-does-not-report-eviction', () => {
    const insight = projectServerTurn(
      mkServerSource({ server: { budgetRequested: 10, budgetEstimator: 'generic', evictedEntryIds: undefined } })
    );
    expect(insight.evicted).toEqual({ observed: false, why: 'backend-does-not-report-eviction' });
  });

  it('evictedEntryIds [] -> observed, value [] — a real positive fact', () => {
    const insight = projectServerTurn(
      mkServerSource({ server: { budgetRequested: 10, budgetEstimator: 'generic', evictedEntryIds: [] } })
    );
    expect(insight.evicted).toEqual({ observed: true, value: [] });
  });

  it('evictedEntryIds non-empty -> observed, each id-only with server-reports-id-only bookId/tokens (the I2 mandatory kill)', () => {
    const insight = projectServerTurn(
      mkServerSource({
        server: { budgetRequested: 10, budgetEstimator: 'generic', evictedEntryIds: ['e1', 'e2'] },
      })
    );
    expect(insight.evicted).toEqual({
      observed: true,
      value: [
        { entryId: 'e1', bookId: { observed: false, why: 'server-reports-id-only' }, tokens: { observed: false, why: 'server-reports-id-only' } },
        { entryId: 'e2', bookId: { observed: false, why: 'server-reports-id-only' }, tokens: { observed: false, why: 'server-reports-id-only' } },
      ],
    });
    // KILLS `evicted = breakdown.wi.droppedEntries` (always [] on a server
    // turn, per chatStore.ts's zeroed wiScanReport) — that mutation would
    // report `[]` here instead of the two real evicted ids.
    if (!insight.evicted.observed) throw new Error('unreachable');
    expect(insight.evicted.value.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C11 — trimmedFromHistoryEntries projection: no prior fixture populated
// this array at all, so the mapping was entirely unexercised. It reuses
// the SAME `projectEntry` as `entries` — a trimmed entry rendered with a
// REAL cost (PR1: it reached a wi_at_depth slot and wrapWiContent ran on
// it), so its projection must be fully observed, never a refusal.
// ---------------------------------------------------------------------------

describe('trimmedFromHistoryEntries projection (C11)', () => {
  it('client turn: a trimmed entry projects with its REAL emitted cost, not a refusal', () => {
    const trimmed = mkEntry({ entryId: 'trimmed-1', emittedTokens: 25, rawTokens: 18 });
    const insight = projectClientTurn(mkClientSource({ trimmedFromHistoryEntries: [trimmed] }));
    expect(insight.trimmedFromHistoryEntries).toEqual([
      {
        entryId: 'trimmed-1',
        bookId: 'b1',
        rawTokens: { basis: 'raw', estimator: 'gpt', tokens: 18 },
        emittedTokens: { observed: true, value: { basis: 'emitted', estimator: 'gpt', tokens: 25 } },
        wrapper: { observed: true, value: 'none' },
        placement: { observed: true, value: { slot: 'A:wi_before_char' } },
        activationReason: { observed: false, why: 'client-scan-computes-no-activation-reason' },
        pinned: false,
      },
    ]);
  });

  it('server turn: same real-cost projection, and a reported activationReason observes', () => {
    const trimmed = mkEntry({
      entryId: 'trimmed-2',
      emittedTokens: 33,
      rawTokens: 20,
      activationReason: 'sticky',
    });
    const insight = projectServerTurn(mkServerSource({ trimmedFromHistoryEntries: [trimmed] }));
    expect(insight.trimmedFromHistoryEntries[0].emittedTokens).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gpt', tokens: 33 },
    });
    expect(insight.trimmedFromHistoryEntries[0].activationReason).toEqual({
      observed: true,
      value: 'sticky',
    });
  });
});

// ---------------------------------------------------------------------------
// C12 — placementSlot's stage A/B/C branches. No prior fixture ever
// constructed a stage B or C placement, so those branches never executed;
// mutating the whole switch to `return ''` was green. These also verify
// `WiPlacementInsight`'s documented example formats (types.ts) are exactly
// right, rather than leaving them as unverified prose.
// ---------------------------------------------------------------------------

describe('placementSlot / WiPlacementInsight.slot format (C12)', () => {
  it('stage A: "A:<sectionId>" — matches the documented example exactly', () => {
    const insight = projectClientTurn(
      mkClientSource({ entries: [mkEntry({ placement: { stage: 'A', sectionId: 'wi_before_char' } })] })
    );
    expect(insight.entries[0].placement).toEqual({
      observed: true,
      value: { slot: 'A:wi_before_char' },
    });
  });

  it('stage B: "B:wi_at_depth:<depth>" — matches the documented example exactly, and the depth is never dropped', () => {
    const insight = projectClientTurn(
      mkClientSource({
        entries: [mkEntry({ placement: { stage: 'B', cls: 'wi_at_depth', depth: 4 } })],
      })
    );
    expect(insight.entries[0].placement).toEqual({
      observed: true,
      value: { slot: 'B:wi_at_depth:4' },
    });
  });

  it('stage C: "C:<sectionId>" — a real, distinct branch, not a fallthrough from stage A', () => {
    const insight = projectServerTurn(
      mkServerSource({
        entries: [mkEntry({ placement: { stage: 'C', sectionId: 'wi_before_char' } })],
      })
    );
    expect(insight.entries[0].placement).toEqual({
      observed: true,
      value: { slot: 'C:wi_before_char' },
    });
  });
});

// ---------------------------------------------------------------------------
// Round 10, Job 2 — full output-surface inventory. One CLIENT turn and one
// SERVER turn, each built so every number in the SAME turn is distinct from
// every other number in that turn (a field swap or wrong-source read can't
// hide behind a shared value), then every field of ClientTurnWiInsight /
// ServerTurnWiInsight / WiEntryInsight / EvictedEntryInsight /
// WiPlacementInsight / TokenFigure reachable from these two turns is
// asserted as its own table row. Table-driven (`it.each`) so one wrong
// field reports as one failing row, not a full-object diff — and existing
// targeted tests above are left in place; this is an additional systematic
// layer, not a replacement.
// ---------------------------------------------------------------------------
describe('full output-surface inventory — every field, both directions', () => {
  const clientRenderedEntry = mkEntry({
    entryId: 'inv-client-entry',
    bookId: 'inv-client-book',
    emittedTokens: 111,
    rawTokens: 55,
    placement: { stage: 'A', sectionId: 'wi_before_char' },
    wrapper: 'persona',
    // Set even though the client engine always refuses this field — proves
    // the refusal is unconditional, not merely "absent because unset".
    activationReason: 'keyword',
    pinned: true,
  });
  const clientTrimmedEntry = mkEntry({
    entryId: 'inv-client-trimmed',
    bookId: 'inv-client-trimmed-book',
    emittedTokens: 222,
    rawTokens: 66,
    placement: { stage: 'B', cls: 'wi_at_depth', depth: 7 },
    wrapper: 'owner',
    pinned: false,
  });
  const clientDroppedEntry = mkEntry({
    entryId: 'inv-client-dropped',
    bookId: 'inv-client-dropped-book',
    emittedTokens: null,
    rawTokens: 33,
    placement: null,
    wrapper: null,
    pinned: false,
  });
  const client = projectClientTurn(
    mkClientSource({
      mode: 'group',
      chatFile: 'inv-client.jsonl',
      publishedAt: 90001,
      profile: 'gemini',
      emittedTokens: 701,
      rawTokens: 702,
      entries: [clientRenderedEntry],
      trimmedFromHistoryEntries: [clientTrimmedEntry],
      scan: { budget: 801, pinnedTokens: 802, pinnedOverBudget: true, droppedEntries: [clientDroppedEntry] },
    })
  );

  const serverRenderedEntry = mkEntry({
    entryId: 'inv-server-entry',
    bookId: 'inv-server-book',
    emittedTokens: 444,
    rawTokens: 77,
    placement: { stage: 'C', sectionId: 'wi_after_char' },
    wrapper: 'none',
    activationReason: 'semantic',
    pinned: true,
  });
  const serverTrimmedEntry = mkEntry({
    entryId: 'inv-server-trimmed',
    bookId: 'inv-server-trimmed-book',
    emittedTokens: 555,
    rawTokens: 88,
    placement: { stage: 'A', sectionId: 'wi_after_char' },
    wrapper: 'persona',
    activationReason: 'sticky',
    pinned: false,
  });
  const server = projectServerTurn(
    mkServerSource({
      mode: 'solo',
      chatFile: 'inv-server.jsonl',
      publishedAt: 90002,
      profile: 'llama',
      emittedTokens: 703,
      rawTokens: 704,
      entries: [serverRenderedEntry],
      trimmedFromHistoryEntries: [serverTrimmedEntry],
      server: { budgetRequested: 9001, budgetEstimator: 'generic', evictedEntryIds: ['inv-evicted-id'] },
    })
  );

  const rows: { label: string; actual: unknown; expected: unknown }[] = [
    // --- ClientTurnWiInsight: every field of CommonTurnWiInsight plus the
    // client-only fields (engine, evicted, pinnedTokens, pinnedOverBudget).
    { label: 'client.mode', actual: client.mode, expected: 'group' },
    { label: 'client.chatFile', actual: client.chatFile, expected: 'inv-client.jsonl' },
    { label: 'client.publishedAt', actual: client.publishedAt, expected: 90001 },
    { label: 'client.profile', actual: client.profile, expected: 'gemini' },
    { label: 'client.engine', actual: client.engine, expected: 'client' },
    {
      label: 'client.emittedTotal',
      actual: client.emittedTotal,
      expected: { observed: true, value: { basis: 'emitted', estimator: 'gemini', tokens: 701 } },
    },
    {
      label: 'client.rawTotal',
      actual: client.rawTotal,
      expected: { observed: true, value: { basis: 'raw', estimator: 'gemini', tokens: 702 } },
    },
    {
      label: 'client.budget',
      actual: client.budget,
      expected: { observed: true, value: { basis: 'raw', estimator: 'gemini', tokens: 801 } },
    },
    {
      label: 'client.pinnedTokens',
      actual: client.pinnedTokens,
      expected: { observed: true, value: { basis: 'raw', estimator: 'gemini', tokens: 802 } },
    },
    { label: 'client.pinnedOverBudget', actual: client.pinnedOverBudget, expected: { observed: true, value: true } },
    // --- WiEntryInsight, every field, via entries[0].
    { label: 'client.entries[0].entryId', actual: client.entries[0].entryId, expected: 'inv-client-entry' },
    { label: 'client.entries[0].bookId', actual: client.entries[0].bookId, expected: 'inv-client-book' },
    {
      label: 'client.entries[0].rawTokens',
      actual: client.entries[0].rawTokens,
      expected: { basis: 'raw', estimator: 'gemini', tokens: 55 },
    },
    {
      label: 'client.entries[0].emittedTokens',
      actual: client.entries[0].emittedTokens,
      expected: { observed: true, value: { basis: 'emitted', estimator: 'gemini', tokens: 111 } },
    },
    {
      label: 'client.entries[0].wrapper',
      actual: client.entries[0].wrapper,
      expected: { observed: true, value: 'persona' },
    },
    {
      label: 'client.entries[0].placement',
      actual: client.entries[0].placement,
      expected: { observed: true, value: { slot: 'A:wi_before_char' } },
    },
    {
      label: 'client.entries[0].activationReason',
      actual: client.entries[0].activationReason,
      expected: { observed: false, why: 'client-scan-computes-no-activation-reason' },
    },
    { label: 'client.entries[0].pinned', actual: client.entries[0].pinned, expected: true },
    // --- WiEntryInsight again, via trimmedFromHistoryEntries[0] — distinct
    // values, and the OTHER placement stage (B), so stage A and stage B
    // can't be told apart by a fallthrough.
    {
      label: 'client.trimmedFromHistoryEntries[0].entryId',
      actual: client.trimmedFromHistoryEntries[0].entryId,
      expected: 'inv-client-trimmed',
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].bookId',
      actual: client.trimmedFromHistoryEntries[0].bookId,
      expected: 'inv-client-trimmed-book',
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].rawTokens',
      actual: client.trimmedFromHistoryEntries[0].rawTokens,
      expected: { basis: 'raw', estimator: 'gemini', tokens: 66 },
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].emittedTokens',
      actual: client.trimmedFromHistoryEntries[0].emittedTokens,
      expected: { observed: true, value: { basis: 'emitted', estimator: 'gemini', tokens: 222 } },
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].wrapper',
      actual: client.trimmedFromHistoryEntries[0].wrapper,
      expected: { observed: true, value: 'owner' },
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].placement',
      actual: client.trimmedFromHistoryEntries[0].placement,
      expected: { observed: true, value: { slot: 'B:wi_at_depth:7' } },
    },
    {
      label: 'client.trimmedFromHistoryEntries[0].pinned',
      actual: client.trimmedFromHistoryEntries[0].pinned,
      expected: false,
    },
    // --- WiEntryInsight a third time, via evicted[0] — the never-rendered
    // refusal side (entry-never-rendered on emittedTokens/wrapper/placement).
    {
      label: 'client.evicted',
      actual: client.evicted,
      expected: {
        observed: true,
        value: [
          {
            entryId: 'inv-client-dropped',
            bookId: 'inv-client-dropped-book',
            rawTokens: { basis: 'raw', estimator: 'gemini', tokens: 33 },
            emittedTokens: { observed: false, why: 'entry-never-rendered' },
            wrapper: { observed: false, why: 'entry-never-rendered' },
            placement: { observed: false, why: 'entry-never-rendered' },
            activationReason: { observed: false, why: 'client-scan-computes-no-activation-reason' },
            pinned: false,
          },
        ],
      },
    },

    // --- ServerTurnWiInsight: same field list, a wholly distinct fixture.
    { label: 'server.mode', actual: server.mode, expected: 'solo' },
    { label: 'server.chatFile', actual: server.chatFile, expected: 'inv-server.jsonl' },
    { label: 'server.publishedAt', actual: server.publishedAt, expected: 90002 },
    { label: 'server.profile', actual: server.profile, expected: 'llama' },
    { label: 'server.engine', actual: server.engine, expected: 'server' },
    {
      label: 'server.emittedTotal',
      actual: server.emittedTotal,
      expected: { observed: true, value: { basis: 'emitted', estimator: 'llama', tokens: 703 } },
    },
    {
      label: 'server.rawTotal',
      actual: server.rawTotal,
      expected: { observed: true, value: { basis: 'raw', estimator: 'llama', tokens: 704 } },
    },
    // budget's estimator is 'generic' (server.budgetEstimator), NEVER the
    // turn's own profile 'llama' — I10's rule, reinforced here.
    {
      label: 'server.budget',
      actual: server.budget,
      expected: { observed: true, value: { basis: 'raw', estimator: 'generic', tokens: 9001 } },
    },
    {
      label: 'server.pinnedTokens',
      actual: server.pinnedTokens,
      expected: { observed: false, why: 'server-path-no-scan-report' },
    },
    {
      label: 'server.pinnedOverBudget',
      actual: server.pinnedOverBudget,
      expected: { observed: false, why: 'server-path-no-scan-report' },
    },
    // --- WiEntryInsight, server engine — activationReason CAN observe
    // here, unlike the client engine above.
    { label: 'server.entries[0].entryId', actual: server.entries[0].entryId, expected: 'inv-server-entry' },
    { label: 'server.entries[0].bookId', actual: server.entries[0].bookId, expected: 'inv-server-book' },
    {
      label: 'server.entries[0].rawTokens',
      actual: server.entries[0].rawTokens,
      expected: { basis: 'raw', estimator: 'llama', tokens: 77 },
    },
    {
      label: 'server.entries[0].emittedTokens',
      actual: server.entries[0].emittedTokens,
      expected: { observed: true, value: { basis: 'emitted', estimator: 'llama', tokens: 444 } },
    },
    {
      label: 'server.entries[0].wrapper',
      actual: server.entries[0].wrapper,
      expected: { observed: true, value: 'none' },
    },
    {
      label: 'server.entries[0].placement',
      actual: server.entries[0].placement,
      expected: { observed: true, value: { slot: 'C:wi_after_char' } },
    },
    {
      label: 'server.entries[0].activationReason',
      actual: server.entries[0].activationReason,
      expected: { observed: true, value: 'semantic' },
    },
    { label: 'server.entries[0].pinned', actual: server.entries[0].pinned, expected: true },
    {
      label: 'server.trimmedFromHistoryEntries[0].placement',
      actual: server.trimmedFromHistoryEntries[0].placement,
      expected: { observed: true, value: { slot: 'A:wi_after_char' } },
    },
    {
      label: 'server.trimmedFromHistoryEntries[0].activationReason',
      actual: server.trimmedFromHistoryEntries[0].activationReason,
      expected: { observed: true, value: 'sticky' },
    },
    {
      label: 'server.trimmedFromHistoryEntries[0].pinned',
      actual: server.trimmedFromHistoryEntries[0].pinned,
      expected: false,
    },
    // --- EvictedEntryInsight — entryId is real; bookId/tokens ALWAYS
    // refuse `server-reports-id-only` (the server never reports either) —
    // the only arm this type ever takes (see its own doc comment, types.ts).
    {
      label: 'server.evicted',
      actual: server.evicted,
      expected: {
        observed: true,
        value: [
          {
            entryId: 'inv-evicted-id',
            bookId: { observed: false, why: 'server-reports-id-only' },
            tokens: { observed: false, why: 'server-reports-id-only' },
          },
        ],
      },
    },
  ];

  it.each(rows)('$label', ({ actual, expected }) => {
    expect(actual).toEqual(expected);
  });
});
