/**
 * The bucketing + view-model layer over the frozen `PromptBreakdown` data
 * (E2-S2 task 3, #456).
 *
 * Runs the REAL builders over the REAL golden fixtures for everything that
 * can be reached that way — same reasoning as chatStore.breakdown.test.ts:
 * a second set of hand-built store states is a second thing to drift from
 * production. `computeBreakdownView` is a pure function of a `PromptBreakdown`
 * value, though, so cases the builders cannot produce (an adversarial
 * author's note carrying a message id, a zero-user-turn history) are built
 * directly with `createPromptBreakdown` / `addSlice` — the same collector
 * API the builders themselves call.
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// Same prelude as chatStore.breakdown.test.ts / promptGoldens.test.ts —
// chatStore pulls serverSettings (and the api layer) at module load, and
// chatStore -> authStore -> lovenseStore -> chatStore is a require cycle whose
// leaf subscribes at module scope.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('../stores/lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
globalThis.localStorage = new MemoryStorage() as unknown as Storage;

const { buildConversationContext, buildGroupConversationContext } = await import(
  '../stores/chatStore'
);
const { SOLO_FIXTURES, GROUP_FIXTURES, resetStores } = await import(
  '../stores/promptGoldens.fixtures'
);

import {
  addSlice,
  createPromptBreakdown,
  recordAttachments,
  recordCallSiteTurn,
  type PromptBreakdown,
} from './promptBreakdown';
import {
  BUCKET_ORDER,
  GROUP_SLOT_BUCKET,
  SECTION_BUCKET,
  STAGE_B_BUCKET,
  computeBreakdownView,
  type BucketId,
} from './breakdownBuckets';

function runSolo(name: string): PromptBreakdown {
  const fx = SOLO_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`no solo fixture "${name}"`);
  resetStores();
  const input = fx.setup();
  const breakdown = createPromptBreakdown('solo');
  buildConversationContext(
    input.messages,
    input.character,
    input.availableEmotions,
    { currentTurn: input.messages.length, timers: {}, activated: new Set<string>() },
    input.ragContext,
    input.serverMatchedEntries,
    breakdown
  );
  return breakdown;
}

function runGroup(name: string): PromptBreakdown {
  const fx = GROUP_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`no group fixture "${name}"`);
  resetStores();
  const input = fx.setup();
  const breakdown = createPromptBreakdown('group');
  buildGroupConversationContext(
    input.messages,
    input.characters,
    input.currentCharacter,
    input.scenarioOverride,
    input.ragContext,
    input.cardMode,
    { currentTurn: input.messages.length, timers: {}, activated: new Set<string>() },
    input.attachmentsFolded,
    breakdown
  );
  return breakdown;
}

// ---------------------------------------------------------------------------
// The static tables are exhaustive by construction (Record<K, BucketId>), so
// the compile step already guards a future id — this is a cheap runtime
// tripwire in case a stray `as any` cast ever bypasses that.
// ---------------------------------------------------------------------------

describe('bucket tables are complete', () => {
  it('names a bucket for every prompt section, group slot, and Stage-B class', () => {
    expect(Object.keys(SECTION_BUCKET)).toHaveLength(18);
    expect(Object.keys(GROUP_SLOT_BUCKET)).toHaveLength(9);
    expect(Object.keys(STAGE_B_BUCKET)).toHaveLength(6);
    for (const id of Object.values(SECTION_BUCKET) as BucketId[]) {
      expect(BUCKET_ORDER).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Mapping exhaustiveness — every slice lands in exactly one bucket
// ---------------------------------------------------------------------------

describe('breakdown view — every slice lands in exactly one bucket', () => {
  it('across every solo fixture', () => {
    // KILLS: a slice silently dropped on the floor (an id missing from the
    // static tables, or a stage the loop forgot to handle) — the cheapest
    // wrong implementation reconciles fine on totals that happen to sum
    // right while quietly losing rows nobody asked to see. Counting bucketed
    // rows against bucketable slices catches that even when the arithmetic
    // downstream doesn't.
    for (const fx of SOLO_FIXTURES) {
      const breakdown = runSolo(fx.name);
      const view = computeBreakdownView(breakdown);
      const bucketableSlices = breakdown.slices.filter(
        (s) => s.kind.stage === 'A' || s.kind.stage === 'B' || s.kind.stage === 'C'
      ).length;
      const rowCount = view.buckets.reduce(
        (n, b) => n + b.slices.length + (b.stageCSlices?.length ?? 0),
        0
      );
      expect(rowCount, `${fx.name}: bucketed row count disagrees with bucketable slices`).toBe(
        bucketableSlices
      );
    }
  });

  it('across every group fixture', () => {
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      const view = computeBreakdownView(breakdown);
      const bucketableSlices = breakdown.slices.filter(
        (s) => s.kind.stage === 'A' || s.kind.stage === 'B' || s.kind.stage === 'C'
      ).length;
      const rowCount = view.buckets.reduce(
        (n, b) => n + b.slices.length + (b.stageCSlices?.length ?? 0),
        0
      );
      expect(rowCount, `${fx.name}: bucketed row count disagrees with bucketable slices`).toBe(
        bucketableSlices
      );
      // Group never gets a Your-message or a Stage-C badge of "not counted
      // by the trim" — its Stage-C content is folded into the ordinary rows.
      expect(view.buckets.find((b) => b.id === 'your_message')).toBeUndefined();
      for (const b of view.buckets) expect(b.stageCSlices).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Reconciliation identity
// ---------------------------------------------------------------------------

describe('breakdown view — reconciliation', () => {
  it('solo: buckets + overhead = trimTotal, and trimTotal + stageC = assembledTotal', () => {
    for (const fx of SOLO_FIXTURES) {
      const breakdown = runSolo(fx.name);
      const view = computeBreakdownView(breakdown);
      const bucketsTotal = view.buckets.reduce((n, b) => n + b.tokens, 0);
      expect(bucketsTotal, `${fx.name}: bucket sum disagrees with the view's own total`).toBe(
        view.reconciliation.bucketsTotal
      );
      expect(
        bucketsTotal + view.reconciliation.overhead.total,
        `${fx.name}: solo buckets + overhead should equal trimTotal`
      ).toBe(breakdown.totals.trimTotal);
      expect(view.reconciliation.target).toBe(breakdown.totals.trimTotal);

      const stageC = view.reconciliation.stageC!;
      const stageCFromBuckets = view.buckets.reduce((n, b) => n + (b.stageCTokens ?? 0), 0);
      expect(
        stageCFromBuckets + stageC.afterHistoryOverhead,
        `${fx.name}: per-bucket Stage-C content + after-history overhead should equal totals.stageC`
      ).toBe(breakdown.totals.stageC);
      expect(stageC.tokens).toBe(breakdown.totals.stageC);
      expect(
        breakdown.totals.trimTotal + stageC.tokens,
        `${fx.name}: trimTotal + stageC should equal assembledTotal`
      ).toBe(breakdown.totals.assembledTotal);
      expect(stageC.assembledTotal).toBe(breakdown.totals.assembledTotal);
    }
  });

  it('group: buckets + overhead = assembledTotal, no stageC split', () => {
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      const view = computeBreakdownView(breakdown);
      const bucketsTotal = view.buckets.reduce((n, b) => n + b.tokens, 0);
      expect(
        bucketsTotal + view.reconciliation.overhead.total,
        `${fx.name}: group buckets + overhead should equal assembledTotal`
      ).toBe(breakdown.totals.assembledTotal);
      expect(view.reconciliation.target).toBe(breakdown.totals.assembledTotal);
      expect(view.reconciliation.stageC).toBeUndefined();
      expect(view.reconciliation.overhead.separatorRounding).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// "Your message"
// ---------------------------------------------------------------------------

describe('breakdown view — Your message', () => {
  it('is the newest user-role history slice, not a same-depth user-role note', () => {
    // at-depth-zero buries the real user turn (z1) under FIVE depth-0
    // insertions, two of which are role 'user' (the author's note and the
    // extension block) and sit AFTER it in emission order — the exact case
    // chatStore.breakdown.test.ts uses to prove the emitted-context reading
    // is wrong. If Your-message were selected from "last role:'user' slice"
    // rather than "last cls:'history' slice with role:'user'", it would
    // point at one of those notes instead.
    const breakdown = runSolo('at-depth-zero');
    const view = computeBreakdownView(breakdown);
    const yourMessage = view.buckets.find((b) => b.id === 'your_message');
    expect(yourMessage, 'no Your-message bucket at all').toBeDefined();
    expect(yourMessage!.slices).toHaveLength(1);
    expect(yourMessage!.slices[0].messageId).toBe('z1');
    expect(yourMessage!.slices[0].role).toBe('user');
  });

  it('adversarial: a non-history slice cannot be selected even if it illegally carries a message id', () => {
    // Production never stamps a message id on an insertion class
    // (`withHistoryRole`'s doc). This proves the selector does not rely on
    // that invariant holding — it filters on `cls === 'history'` first, not
    // on "has a message id" — so a future bug that mis-stamps an insertion
    // still cannot leak it into Your-message.
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'real-user-turn', role: 'user' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'reply', role: 'assistant' }, 8, 30);
    // Illegal: an authors_note slice with a role AND a message id.
    addSlice(
      breakdown,
      { stage: 'B', cls: 'authors_note', role: 'user', messageId: 'not-a-real-turn' } as never,
      6,
      20
    );
    breakdown.totals.trimTotal = 24;
    breakdown.totals.assembledTotal = 24;
    const view = computeBreakdownView(breakdown);
    const yourMessage = view.buckets.find((b) => b.id === 'your_message')!;
    expect(yourMessage.slices).toHaveLength(1);
    expect(yourMessage.slices[0].messageId).toBe('real-user-turn');
  });

  it('is absent when no history slice was ever emitted with role user', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'a1', role: 'assistant' }, 8, 30);
    breakdown.totals.trimTotal = 8;
    breakdown.totals.assembledTotal = 8;
    const view = computeBreakdownView(breakdown);
    expect(view.buckets.find((b) => b.id === 'your_message')).toBeUndefined();
    // The turn still shows up — just under Chat history instead.
    const history = view.buckets.find((b) => b.id === 'chat_history')!;
    expect(history.slices.map((s) => s.messageId)).toEqual(['a1']);
  });

  it('group never has a Your-message bucket, even with a role:user history slice', () => {
    const breakdown = createPromptBreakdown('group');
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'g1', role: 'user' }, 8, 30);
    breakdown.totals.assembledTotal = 8;
    const view = computeBreakdownView(breakdown);
    expect(view.buckets.find((b) => b.id === 'your_message')).toBeUndefined();
    expect(view.buckets.find((b) => b.id === 'chat_history')?.slices).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

describe('breakdown view — history badge', () => {
  it('historyTrimmed false + solo: "Trim disabled", never "within budget"', () => {
    const breakdown = runSolo('token-aware-off');
    expect(breakdown.flags.historyTrimmed).toBe(false);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe('Trim disabled (Message Count mode)');
  });

  it('historyTrimmed false wins over overBudget — checked FIRST, not OR-ed', () => {
    // Not reachable through the real trim (overBudget is only ever computed
    // inside the token-aware branch that also sets historyTrimmed), so this
    // is the direct proof that the badge function checks historyTrimmed
    // before it looks at overBudget at all, rather than happening to agree
    // with production on the combinations production can produce.
    const breakdown = createPromptBreakdown('solo');
    breakdown.flags.historyTrimmed = false;
    breakdown.flags.overBudget = true;
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe('Trim disabled (Message Count mode)');
  });

  it('historyTrimmed true + overBudget false: "Within budget"', () => {
    const breakdown = runSolo('trim-bites');
    expect(breakdown.flags.historyTrimmed).toBe(true);
    expect(breakdown.flags.overBudget).toBe(false);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe('Within budget');
  });

  it('historyTrimmed true + overBudget true: names the cause', () => {
    const breakdown = runSolo('trim-overbudget');
    expect(breakdown.flags.historyTrimmed).toBe(true);
    expect(breakdown.flags.overBudget).toBe(true);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe(
      'Over budget — the pinned content alone (newest turn + critical lore + system block) exceeded the trim budget'
    );
  });

  it('group: "not trimmed", regardless of the fixture', () => {
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      expect(breakdown.flags.historyTrimmed, fx.name).toBe(false);
      const view = computeBreakdownView(breakdown);
      expect(view.badges.history, fx.name).toBe('History not trimmed (fixed 30-message window)');
    }
  });

  it('surfaces droppedFromHistory only when the trim actually dropped something', () => {
    const bites = computeBreakdownView(runSolo('trim-bites'));
    expect(bites.badges.droppedFromHistory).toBeGreaterThan(0);
    const minimal = computeBreakdownView(runSolo('minimal'));
    expect(minimal.badges.droppedFromHistory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reserved
// ---------------------------------------------------------------------------

describe('breakdown view — Reserved', () => {
  it('follows hasReservedSlice, not whether responseReserve is set', () => {
    const withReserve = computeBreakdownView(runSolo('all-sections'));
    expect(withReserve.reserved).toEqual({ tokens: 2048 });
    const withoutReserve = computeBreakdownView(runSolo('token-aware-off'));
    expect(withoutReserve.reserved).toBeNull();
  });

  it('0 is a legal reserve and still renders a line', () => {
    // KILLS: `reserved: tokens || null`-style falsy coalescing, which would
    // swallow a real (if degenerate) 0-token reserve.
    const breakdown = createPromptBreakdown('solo');
    breakdown.flags.hasReservedSlice = true;
    breakdown.responseReserve = 0;
    const view = computeBreakdownView(breakdown);
    expect(view.reserved).toEqual({ tokens: 0 });
  });

  it('group: never a Reserved line', () => {
    for (const fx of GROUP_FIXTURES) {
      expect(computeBreakdownView(runGroup(fx.name)).reserved).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// World info summary
// ---------------------------------------------------------------------------

describe('breakdown view — world info summary', () => {
  it('server path: unavailable note, budget/evicted suppressed', () => {
    const view = computeBreakdownView(runSolo('server-matched-entries'));
    expect(view.wi.unavailableNote).toBe('Activation details unavailable (server-path turn)');
    expect(view.wi.budget).toBeUndefined();
    expect(view.wi.evictedCount).toBeUndefined();
  });

  it('client path: budget + evicted count present, no unavailable note', () => {
    const view = computeBreakdownView(runSolo('wi-budget-eviction'));
    expect(view.wi.unavailableNote).toBeUndefined();
    expect(view.wi.budget).toBe(40);
    expect(view.wi.evictedCount).toBe(1);
    expect(view.wi.emittedTokens).toBeGreaterThan(0);
    expect(view.wi.rawTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Empty-system note
// ---------------------------------------------------------------------------

describe('breakdown view — empty-system note', () => {
  it('present when solo emits an empty system block, names the real overhead', () => {
    const breakdown = runSolo('empty-system-block');
    expect(breakdown.totals.stageA).toBe(0);
    const view = computeBreakdownView(breakdown);
    expect(view.emptySystemNote).toContain(String(breakdown.messageOverheadPerMessage));
    expect(view.emptySystemNote).toContain('empty system message');
  });

  it('absent when Stage A has content, and absent in group regardless', () => {
    expect(computeBreakdownView(runSolo('all-sections')).emptySystemNote).toBeNull();
    for (const fx of GROUP_FIXTURES) {
      expect(computeBreakdownView(runGroup(fx.name)).emptySystemNote, fx.name).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Attachments and call-site turns — recorded by the call site, not the builder
// ---------------------------------------------------------------------------

describe('breakdown view — attachments and call-site lines', () => {
  it('reports bytes, never tokens, and is absent with nothing attached', () => {
    const breakdown = runSolo('minimal');
    expect(computeBreakdownView(breakdown).attachments).toBeNull();
    // 4 raw bytes, base64-encoded with no padding: 'QUJD' decodes to 3 bytes
    // ('ABC'), chosen so the byte count is provably NOT a token count off any
    // real estimator.
    recordAttachments(breakdown, [{ base64: 'QUJD' }, { base64: 'QUJD' }]);
    const view = computeBreakdownView(breakdown);
    expect(view.attachments).toEqual({ count: 2, bytes: 6 });
  });

  it('call-site turn is absent until recorded, then carries its own overhead note', () => {
    const breakdown = runSolo('minimal');
    expect(computeBreakdownView(breakdown).callSite).toEqual([]);
    recordCallSiteTurn(breakdown, 'continue', 'Pick up where you left off.');
    const view = computeBreakdownView(breakdown);
    expect(view.callSite).toHaveLength(1);
    expect(view.callSite[0].turn).toBe('continue');
    expect(view.callSite[0].label).toBe('Continue instruction');
    expect(view.callSite[0].tokens).toBeGreaterThan(0);
    expect(view.callSite[0].note).toContain(String(breakdown.messageOverheadPerMessage));
  });

  it('impersonate gets its own label', () => {
    const breakdown = runSolo('minimal');
    recordCallSiteTurn(breakdown, 'impersonate', 'Write the next user turn.');
    const view = computeBreakdownView(breakdown);
    expect(view.callSite[0].turn).toBe('impersonate');
    expect(view.callSite[0].label).toBe('Impersonate instruction');
  });
});

// ---------------------------------------------------------------------------
// Provenance passthrough
// ---------------------------------------------------------------------------

describe('breakdown view — provenance', () => {
  it('passes mode, chatFile, publishedAt, and profile through unchanged', () => {
    const breakdown = runSolo('minimal');
    const view = computeBreakdownView(breakdown);
    expect(view.provenance).toEqual({
      mode: breakdown.mode,
      chatFile: breakdown.chatFile,
      publishedAt: breakdown.publishedAt,
      profile: breakdown.profile,
    });
  });
});
