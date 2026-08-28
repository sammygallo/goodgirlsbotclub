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
import { PROMPT_SECTION_LABELS } from '../stores/generationStore';
import { GROUP_HISTORY_WINDOW } from './groupHistoryWindow';

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
// The mapping VALUES, pinned (review round 1, M2/F2/F14). The "complete"
// describe above only proves the tables are the right SHAPE (key counts,
// values that are members of BUCKET_ORDER) — it does not notice a single
// slot re-mapped to a different (but still valid) bucket, e.g.
// `char_info_block: 'character'` -> `'instructions'`, which the file's own
// header calls the "WHOLE story" of this module. Every existing count/sum
// guard is invariant under that mutation: row count is unchanged (the slice
// still lands in exactly one bucket, just the wrong one) and every
// reconciliation sum is unchanged (the tokens moved between rows, not off
// the totals). Only a value-level pin catches it.
// ---------------------------------------------------------------------------

describe('SECTION_BUCKET / GROUP_SLOT_BUCKET / STAGE_B_BUCKET — the full mapping, pinned', () => {
  it('pins every prompt-section id to its exact bucket', () => {
    expect(SECTION_BUCKET).toEqual({
      main_prompt: 'instructions',
      persona_before_char: 'persona',
      wi_before_char: 'world_info',
      ext_before_char: 'instructions',
      char_info_block: 'character',
      wi_after_char: 'world_info',
      ext_after_char: 'instructions',
      persona_after_char: 'persona',
      wi_before_an: 'world_info',
      ext_before_an: 'instructions',
      jailbreak: 'instructions',
      emotion_instruction: 'instructions',
      selfie_instruction: 'instructions',
      rag_context: 'chat_recall',
      char_phi: 'instructions',
      user_phi: 'instructions',
      wi_after_an: 'world_info',
      ext_after_an: 'instructions',
    });
  });

  it('pins every group-slot id to its exact bucket', () => {
    expect(GROUP_SLOT_BUCKET).toEqual({
      group_system_chrome: 'system',
      group_cards: 'system',
      group_scenario: 'system',
      group_examples: 'system',
      group_wi_before_char: 'world_info',
      group_wi_after_char: 'world_info',
      group_wi_before_an: 'world_info',
      group_wi_after_an: 'world_info',
      group_rag_context: 'chat_recall',
    });
  });

  it('pins every Stage-B class to its exact bucket', () => {
    expect(STAGE_B_BUCKET).toEqual({
      history: 'chat_history',
      authors_note: 'summary_notes',
      characters_note: 'summary_notes',
      persona_at_depth: 'persona',
      wi_at_depth: 'world_info',
      ext_at_depth: 'summary_notes',
    });
  });

  it('a real fixture: char_info_block renders under the Character bucket, labeled by the section-label table', () => {
    // The one fixture-driven check the finding also asked for: SECTION_BUCKET
    // is pinned above in isolation, but this proves the pinned mapping is
    // actually what a real builder run feeds `computeBreakdownView` through.
    const breakdown = runSolo('all-sections');
    const rawCharSlice = breakdown.slices.find(
      (s) => s.kind.stage === 'A' && s.kind.id === 'char_info_block'
    );
    expect(rawCharSlice, 'all-sections should emit a char_info_block Stage-A slice').toBeDefined();
    const view = computeBreakdownView(breakdown);
    const character = view.buckets.find((b) => b.id === 'character');
    expect(character, 'no Character bucket at all').toBeDefined();
    expect(character!.slices).toEqual([
      { label: PROMPT_SECTION_LABELS.char_info_block, tokens: rawCharSlice!.tokens },
    ]);
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
// Itemized overhead rows — review round 1, M5/F9/F15. The describe above
// only proves `overhead.total` reconciles; `total` is written as ITS OWN
// independent expression rather than derived from the three fields the panel
// actually renders as an itemization (separatorRounding, messageOverhead,
// conversationPriming), so one of those three can drift from `total` with
// every existing assertion green. These tests recompute each displayed field
// from `breakdown`'s own raw collector fields — the same reading the panel
// promises, not the same expression computeBreakdownView happens to use — so
// a mutation that changes ONE field without touching `total` shows up as a
// mismatch here even though `overhead.total` itself is untouched.
// ---------------------------------------------------------------------------

describe('breakdown view — itemized overhead rows are individually pinned', () => {
  it('solo: each displayed row equals its own formula off the raw breakdown, and the rows sum to the target', () => {
    for (const fx of SOLO_FIXTURES) {
      const breakdown = runSolo(fx.name);
      const view = computeBreakdownView(breakdown);
      const perMessage = breakdown.messageOverheadPerMessage;
      const nB = breakdown.slices.filter((s) => s.kind.stage === 'B').length;
      const nC = breakdown.slices.filter((s) => s.kind.stage === 'C').length;
      const { overhead, stageC } = view.reconciliation;

      expect(overhead.separatorRounding, `${fx.name}: separator+rounding`).toBe(
        breakdown.stageAJoinResidual
      );
      expect(overhead.messageOverhead, `${fx.name}: message overhead`).toBe(
        breakdown.stageAMessageOverhead + perMessage * nB
      );
      expect(overhead.conversationPriming, `${fx.name}: conversation priming`).toBe(
        breakdown.conversationPriming
      );
      expect(
        (overhead.separatorRounding ?? 0) + overhead.messageOverhead + overhead.conversationPriming,
        `${fx.name}: the three itemized rows should sum EXACTLY to overhead.total`
      ).toBe(overhead.total);

      expect(stageC!.afterHistoryOverhead, `${fx.name}: after-history overhead`).toBe(perMessage * nC);
      // Buckets + the four displayed rows (Separator+rounding, Message
      // overhead, Conversation priming, then the headline total) is exactly
      // what a user reading the panel top to bottom adds up — AC 5's own
      // reconciliation claim, stated at the row level rather than the
      // opaque-total level the describe above checks.
      expect(
        view.reconciliation.bucketsTotal +
          (overhead.separatorRounding ?? 0) +
          overhead.messageOverhead +
          overhead.conversationPriming,
        `${fx.name}: buckets + itemized overhead rows should sum to the "Counted by the trim" target`
      ).toBe(view.reconciliation.target);
    }
  });

  it("group: message overhead folds Stage C's per-message cost in too (no separate after-history line), and the rows sum to the target", () => {
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      const view = computeBreakdownView(breakdown);
      const perMessage = breakdown.messageOverheadPerMessage;
      const nBC = breakdown.slices.filter(
        (s) => s.kind.stage === 'B' || s.kind.stage === 'C'
      ).length;
      const { overhead } = view.reconciliation;

      expect(overhead.messageOverhead, `${fx.name}: message overhead`).toBe(
        breakdown.stageAMessageOverhead + perMessage * nBC
      );
      expect(overhead.conversationPriming, `${fx.name}: conversation priming`).toBe(
        breakdown.conversationPriming
      );
      expect(
        overhead.messageOverhead + overhead.conversationPriming,
        `${fx.name}: the itemized rows should sum EXACTLY to overhead.total`
      ).toBe(overhead.total);
      expect(
        view.reconciliation.bucketsTotal + overhead.messageOverhead + overhead.conversationPriming,
        `${fx.name}: buckets + itemized overhead rows should sum to the assembled-prompt target`
      ).toBe(view.reconciliation.target);
    }
  });
});

// ---------------------------------------------------------------------------
// Drill-down row contents — review round 1, M6/F17. Bucket TOTALS
// (`row.tokens` / `row.stageCTokens`) are accumulated independently of the
// per-slice payload pushed into `row.slices` / `row.stageCSlices`, in the
// same loop, off the same `slice.tokens` / `content` value — so a push that
// drops or zeroes what it writes into the drill-down array leaves every
// count/sum guard elsewhere in this file green.
// ---------------------------------------------------------------------------

describe('breakdown view — drill-down rows are individually pinned', () => {
  it('Σ per-slice tokens equals the bucket total (and Σ stageC per-slice tokens equals stageCTokens) for every bucket of every fixture', () => {
    for (const fx of SOLO_FIXTURES) {
      const view = computeBreakdownView(runSolo(fx.name));
      for (const b of view.buckets) {
        const slicesSum = b.slices.reduce((n, s) => n + s.tokens, 0);
        expect(slicesSum, `${fx.name} / ${b.id}: Σ slices.tokens should equal bucket.tokens`).toBe(
          b.tokens
        );
        const stageCSum = (b.stageCSlices ?? []).reduce((n, s) => n + s.tokens, 0);
        expect(
          stageCSum,
          `${fx.name} / ${b.id}: Σ stageCSlices.tokens should equal stageCTokens`
        ).toBe(b.stageCTokens ?? 0);
      }
    }
    for (const fx of GROUP_FIXTURES) {
      const view = computeBreakdownView(runGroup(fx.name));
      for (const b of view.buckets) {
        const slicesSum = b.slices.reduce((n, s) => n + s.tokens, 0);
        expect(slicesSum, `${fx.name} / ${b.id}: Σ slices.tokens should equal bucket.tokens`).toBe(
          b.tokens
        );
      }
    }
  });

  it('a hand-built breakdown pins exact labels and content-only token math for Stage-B and Stage-C rows', () => {
    // KILLS: `stageALabel` collapsing to a constant (every row reading
    // "Section" instead of its real label), and the Reading-A subtraction
    // (`slice.tokens - messageOverheadPerMessage`) being skipped or applied
    // to the wrong stage.
    const b = createPromptBreakdown('solo');
    // Token-aware (a trim actually ran) — the badge this test pins below is
    // the trim-anchored string; review round 4 (R4-A/F1) made that badge
    // mode-conditional, so a hand-built breakdown now has to say which mode
    // it represents rather than getting it for free from the unconditional
    // old string.
    b.flags.historyTrimmed = true;
    const perMessage = b.messageOverheadPerMessage;
    addSlice(b, { stage: 'B', cls: 'history', messageId: 'm1', role: 'user' }, 14, 40);
    addSlice(b, { stage: 'B', cls: 'history', messageId: 'm2', role: 'assistant' }, 20, 60);
    addSlice(b, { stage: 'B', cls: 'authors_note' }, 10, 30);
    addSlice(b, { stage: 'C', id: 'char_phi' }, 12, 35);
    const view = computeBreakdownView(b);

    const yourMessage = view.buckets.find((bk) => bk.id === 'your_message')!;
    expect(yourMessage.slices).toEqual([
      { label: 'User', tokens: 14 - perMessage, role: 'user', messageId: 'm1' },
    ]);

    const history = view.buckets.find((bk) => bk.id === 'chat_history')!;
    expect(history.slices).toEqual([
      { label: 'Assistant', tokens: 20 - perMessage, role: 'assistant', messageId: 'm2' },
    ]);

    const notes = view.buckets.find((bk) => bk.id === 'summary_notes')!;
    expect(notes.slices).toEqual([{ label: "Author's Note", tokens: 10 - perMessage }]);

    const instructions = view.buckets.find((bk) => bk.id === 'instructions')!;
    expect(instructions.slices).toEqual([]);
    expect(instructions.stageCSlices).toEqual([
      {
        label: PROMPT_SECTION_LABELS.char_phi,
        tokens: 12 - perMessage,
        badge: 'not counted by the trim — sent after the history',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// System/Character exclusivity — review round 1, m7/F3/F10/F18. The panel
// reuses ONE chart hex for `system` and `character` on the premise the two
// buckets are never co-present (system is group-only, character solo-only).
// `SECTION_BUCKET`/`GROUP_SLOT_BUCKET` are plain `Record<K, BucketId>`s, so
// nothing in the type system enforces that — only this test does.
// ---------------------------------------------------------------------------

describe('breakdown view — system/character are mutually exclusive (shared chart color)', () => {
  it('no SECTION_BUCKET value is "system" and no GROUP_SLOT_BUCKET value is "character"', () => {
    expect(Object.values(SECTION_BUCKET)).not.toContain('system');
    expect(Object.values(GROUP_SLOT_BUCKET)).not.toContain('character');
  });

  it('solo never yields a system bucket, group never yields a character bucket, on any real fixture', () => {
    for (const fx of SOLO_FIXTURES) {
      const ids = computeBreakdownView(runSolo(fx.name)).buckets.map((b) => b.id);
      expect(ids, `${fx.name}: solo should never yield a 'system' bucket`).not.toContain('system');
    }
    for (const fx of GROUP_FIXTURES) {
      const ids = computeBreakdownView(runGroup(fx.name)).buckets.map((b) => b.id);
      expect(ids, `${fx.name}: group should never yield a 'character' bucket`).not.toContain(
        'character'
      );
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
  it('historyTrimmed false + solo: "Trim disabled" (with the window drop named — R4-B/F3), never "within budget"', () => {
    // token-aware-off: 9 raw messages, messageCount 5, two of the last five
    // raw slots are system turns — windowSkew (review round 4) is 4 (7
    // non-system messages total, 3 survive the window). Badge string updated
    // in review round 4 (R4-B/F3) to name the drop; the old "Trim disabled
    // (Message Count mode)" wording implied nothing was cut. Reworded AGAIN
    // in review round 5 (R5-A/F1/F2/F9): round 4's "last N messages kept"
    // wording claimed a KEPT count that `messageWindowSize` cannot supply —
    // it is the raw window setting applied BEFORE the isSystem filter, so
    // it overstated what actually reached the model (5 claimed vs 3 real
    // history rows on this very fixture). The badge now names only what it
    // actually measured: the window's own drop count and its own size, not
    // a derived "kept" claim.
    const breakdown = runSolo('token-aware-off');
    expect(breakdown.flags.historyTrimmed).toBe(false);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe(
      'Trim disabled (Message Count mode) — 4 older messages beyond the 5-message window'
    );
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

  it('group: "not trimmed", regardless of the fixture — derived from GROUP_HISTORY_WINDOW, not a hardcoded literal (review round 4, R4-E/F5)', () => {
    // Asserted via the CONSTANT, not a literal `30`: the builder's single
    // source of truth is GROUP_HISTORY_WINDOW (groupHistoryWindow.ts), and a
    // literal here — even one that currently matches — is exactly the
    // second-copy drift this module's own doc calls out
    // (promptBreakdown.ts:212-213: "a second copy of the number is how the
    // panel silently rots"). If the constant ever changes, this assertion
    // changes with it instead of silently cementing the old value.
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      expect(breakdown.flags.historyTrimmed, fx.name).toBe(false);
      const view = computeBreakdownView(breakdown);
      expect(view.badges.history, fx.name).toBe(
        `History not trimmed (fixed ${GROUP_HISTORY_WINDOW}-message window)`
      );
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
// Message Count mode: the window drop — review round 4, R4-B/F3
// ---------------------------------------------------------------------------

describe('breakdown view — Message Count mode surfaces its window drop (review round 4, R4-B/F3)', () => {
  it("runSolo('token-aware-off'): 9 raw messages, 5-slot window — the view surfaces droppedFromWindow 4", () => {
    // KILLS: chatStore recording windowSkew nowhere, or recording it but the
    // view never reading `flags.droppedByMessageWindow`/`messageWindowSize`.
    // Before this fix, Message Count mode's fixed window could silently
    // discard messages with nothing on the one panel whose job is "what
    // reached the model" disclosing it.
    const breakdown = runSolo('token-aware-off');
    expect(breakdown.flags.droppedByMessageWindow, 'the collector never recorded windowSkew').toBe(4);
    expect(breakdown.flags.messageWindowSize).toBe(5);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.droppedFromWindow).toBe(4);
    expect(view.badges.history).toBe(
      'Trim disabled (Message Count mode) — 4 older messages beyond the 5-message window'
    );
  });

  it("token-aware mode never surfaces a window drop (windowSkew is definitionally 0 on that path), and messageWindowSize is null (review round 5, R5-E/F10)", () => {
    // KILLS: `messageWindowSize` staying non-null on the token-aware path
    // (e.g. the ternary at chatStore.ts collapsing to an unconditional
    // assignment) — unreachable through `historyBadge` today (it only reads
    // the field when `!historyTrimmed`, and token-aware sets historyTrimmed
    // true), so nothing but a direct flag assertion can catch it. The null
    // is load-bearing for a future consumer per promptBreakdown.ts's own
    // doc: "a panel must be able to tell 'windowed to 0' from 'never
    // windowed'".
    const breakdown = runSolo('all-sections');
    expect(breakdown.flags.historyTrimmed).toBe(true);
    expect(breakdown.flags.messageWindowSize, 'token-aware builds never windowed on message count').toBeNull();
    expect(breakdown.flags.droppedByMessageWindow).toBe(0);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.droppedFromWindow).toBeUndefined();
  });

  it('Message Count mode with nothing windowed out (window covers the whole chat): no drop clause, plain wording stands (review round 5, R5-B/F3/F5/F8)', () => {
    // KILLS: the `&&` guard in `historyBadge` inverting to `||` (or any
    // other regression that emits the drop clause at
    // droppedByMessageWindow === 0) — the exact "0 older messages" nonsense
    // badge a shorter-than-its-window Message Count chat (the common case:
    // a fresh chat under e.g. a 30-message window) would otherwise show.
    //
    // Hand-built with flags set EXPLICITLY and NO `if` guard around the
    // assertions — the round-4 version of this test used
    // `if (!breakdown.flags.historyTrimmed) { ... }` around `runSolo('minimal')`,
    // but `minimal` never calls `withContext` so it runs under
    // DEFAULT_CONTEXT_CONFIG's `tokenAware: true` (generationStore.ts) —
    // `historyTrimmed` is always true there, the guard was always false, and
    // the body never executed. The test passed asserting nothing. This
    // version cannot do that: every assertion below always runs.
    const breakdown = createPromptBreakdown('solo');
    breakdown.flags.historyTrimmed = false;
    breakdown.flags.messageWindowSize = 20;
    breakdown.flags.droppedByMessageWindow = 0;
    const view = computeBreakdownView(breakdown);
    expect(view.badges.droppedFromWindow).toBeUndefined();
    expect(view.badges.history).toBe('Trim disabled (Message Count mode)');
  });

  it('group is unaffected by this field — GROUP path unchanged, per the story brief', () => {
    for (const fx of GROUP_FIXTURES) {
      const breakdown = runGroup(fx.name);
      expect(breakdown.flags.droppedByMessageWindow, fx.name).toBe(0);
      expect(breakdown.flags.messageWindowSize, fx.name).toBeNull();
      expect(computeBreakdownView(breakdown).badges.droppedFromWindow, fx.name).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The badge never claims a kept count — review round 5, R5-A/F1/F2/F9
// ---------------------------------------------------------------------------

describe('breakdown view — the Message Count badge never claims a kept count (review round 5, R5-A/F1/F2/F9)', () => {
  it('never renders the word "kept", in any mode, on any fixture', () => {
    // KILLS: any wording that reintroduces a kept-count claim.
    // `messageWindowSize` is the raw window setting (applied BEFORE the
    // isSystem filter, chatStore.ts) and is not the number of messages that
    // actually reached the model — a second mechanism (summary compaction)
    // can drop still more without ever touching this collector's fields.
    // This module cannot compute the true kept count from `flags` alone and
    // must not claim one; the drill-down rows ARE the kept count, and any
    // compaction-covered turns are disclosed by the Summary slice.
    for (const fx of SOLO_FIXTURES) {
      expect(computeBreakdownView(runSolo(fx.name)).badges.history, fx.name).not.toMatch(/kept/i);
    }
    for (const fx of GROUP_FIXTURES) {
      expect(computeBreakdownView(runGroup(fx.name)).badges.history, fx.name).not.toMatch(/kept/i);
    }
  });

  it("token-aware-off: the badge's interpolated numbers are EXACTLY flags.droppedByMessageWindow and flags.messageWindowSize, nothing derived", () => {
    const breakdown = runSolo('token-aware-off');
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe(
      `Trim disabled (Message Count mode) — ${breakdown.flags.droppedByMessageWindow} older messages beyond the ${breakdown.flags.messageWindowSize}-message window`
    );
  });

  it("fixed-window-summary-skew: same identity, on the fixture where a SECOND drop mechanism (summary compaction) also ran — the badge must still report only what it measured, not a kept count that compaction would falsify further", () => {
    // 30 messages, messageCount 12, a summary covering the first 20
    // non-system turns — windowSkew alone (18) is a sound measurement of
    // the WINDOW's own drop; the badge naming only that (never a kept
    // count) is what keeps it honest even though a second mechanism this
    // module knows nothing about also reduced what reached the model.
    const breakdown = runSolo('fixed-window-summary-skew');
    expect(breakdown.flags.historyTrimmed).toBe(false);
    expect(breakdown.flags.droppedByMessageWindow).toBeGreaterThan(0);
    const view = computeBreakdownView(breakdown);
    expect(view.badges.history).toBe(
      `Trim disabled (Message Count mode) — ${breakdown.flags.droppedByMessageWindow} older messages beyond the ${breakdown.flags.messageWindowSize}-message window`
    );
    expect(view.badges.history).not.toMatch(/kept/i);
  });

  it('pluralizes the drop count like the sibling trim badge — never a literal "(s)" (review round 6)', () => {
    // KILLS: the round-5 "message(s)" shorthand (rendered verbatim next to a
    // correctly pluralized "1 message dropped by the trim" badge), and a
    // naive always-plural fix. Skew of exactly 1 is the common first
    // exposure: every chat crossing its window boundary hits it. No golden
    // fixture has skew 1, so both cases are hand-built.
    const singular = createPromptBreakdown('solo');
    singular.flags.historyTrimmed = false;
    singular.flags.messageWindowSize = 20;
    singular.flags.droppedByMessageWindow = 1;
    expect(computeBreakdownView(singular).badges.history).toBe(
      'Trim disabled (Message Count mode) — 1 older message beyond the 20-message window'
    );
    expect(computeBreakdownView(singular).badges.history).not.toMatch(/\(s\)/);

    const plural = createPromptBreakdown('solo');
    plural.flags.historyTrimmed = false;
    plural.flags.messageWindowSize = 20;
    plural.flags.droppedByMessageWindow = 2;
    expect(computeBreakdownView(plural).badges.history).toBe(
      'Trim disabled (Message Count mode) — 2 older messages beyond the 20-message window'
    );
  });
});

// ---------------------------------------------------------------------------
// Stage-C drill-down badge — mode-conditional (review round 4, R4-A/F1/F6/F7)
// ---------------------------------------------------------------------------

describe('breakdown view — Stage-C drill-down badge is mode-conditional (review round 4, R4-A/F1/F6/F7)', () => {
  it('Message Count mode: no Stage-C badge names "the trim" — there is no trim to have excluded it FROM', () => {
    // KILLS: an unconditional 'not counted by the trim — sent after the
    // history' badge, R3-B/F4's exact class of defect one section lower —
    // round 3 fixed the reconciliation row's label and note but left this
    // identical claim in the per-slice badge.
    const v = computeBreakdownView(runSolo('token-aware-off'));
    const badges = v.buckets.flatMap((b) => b.stageCSlices ?? []).map((s) => s.badge);
    expect(badges.length, 'this fixture should carry at least one Stage-C slice').toBeGreaterThan(0);
    for (const b of badges) {
      expect(b, 'Message Count mode has no trim to be excluded from').not.toMatch(/trim/i);
    }
  });

  it('token-aware mode: the trim-anchored badge IS present — the positive twin, so the wording cannot be deleted wholesale', () => {
    const t = computeBreakdownView(runSolo('all-sections'));
    expect(t.buckets.flatMap((b) => b.stageCSlices ?? []).map((s) => s.badge)).toContain(
      'not counted by the trim — sent after the history'
    );
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

  it('gapExplanation is pinned verbatim — the "explains the gap" half of the §4.1 AC (review round 5, R5-C/F6)', () => {
    // Same treatment R3-G/F10 gave PROMPT_SECTION_DESCRIPTIONS: a plain
    // string field has no type-level protection against being emptied or
    // reworded into something that no longer explains the emitted-vs-raw
    // gap, so it has to be pinned by value.
    const view = computeBreakdownView(runSolo('minimal'));
    expect(view.wi.gapExplanation).toBe(
      'The gap is macro expansion and the attribution wrapper the app adds before injecting each entry — both counted in what reaches the prompt, neither charged by the WI budget, which measures the raw entry text.'
    );
  });

  // AC 9 (review round 1, M1/F1/F16): `buildWiSummary` must branch on
  // `activationSource`, never on the forbidden proxy "budget is 0 (and
  // nothing was evicted)". The two cases above happen to also agree with
  // that proxy — server-matched-entries is server+budget-0,
  // wi-budget-eviction is client+budget-40 — so together they cannot tell
  // the real guard from the forbidden one. These two close that gap.
  it('AC 9 kill test: a client-path turn with a zero WI budget is never mistaken for server-path', () => {
    // KILLS `activationSource === 'server'` -> `budget === 0` (or
    // `budget === 0 && droppedIds.length === 0`): 'minimal' never touches
    // World Info at all, so it keeps the collector's client-path defaults
    // verbatim (budget 0, no drops) — the ordinary case for most real
    // client-path turns (no WI token budget configured).
    const view = computeBreakdownView(runSolo('minimal'));
    expect(view.wi.unavailableNote).toBeUndefined();
    expect(view.wi.budget).toBe(0);
    expect(view.wi.evictedCount).toBe(0);
  });

  it('AC 9 kill test: server path still wins even with a nonzero budget and a recorded drop', () => {
    // The other half of the same guard: a server-path breakdown whose wi
    // fields are shaped exactly like an ordinary client-path eviction (budget
    // 40, one dropped id) must still render the unavailable note — proving
    // the branch reads `activationSource`, not "budget is 0 and nothing was
    // evicted".
    const breakdown = createPromptBreakdown('solo');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.budget = 40;
    breakdown.wi.droppedIds = ['ev1'];
    const view = computeBreakdownView(breakdown);
    expect(view.wi.unavailableNote).toBe('Activation details unavailable (server-path turn)');
    expect(view.wi.budget).toBeUndefined();
    expect(view.wi.evictedCount).toBeUndefined();
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
