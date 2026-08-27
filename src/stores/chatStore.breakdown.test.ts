/**
 * The prompt token breakdown (E2-S2 tasks 1 + 2).
 *
 * WHAT THE GOLDENS CANNOT DO: `promptGoldens.test.ts` proves the
 * instrumentation changed nothing about what the model is sent. It cannot
 * prove the instrumentation MEASURED anything — an accounting layer that
 * silently computes zero leaves all 142 goldens green. That is this file's
 * job, and it is why every test below names the cheapest wrong implementation
 * it exists to kill.
 *
 * Runs the REAL builders over the REAL golden fixtures. A second set of
 * hand-built store states would be a second thing to keep in sync with
 * production, and the fixtures already walk the branches that matter.
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// Same prelude as promptGoldens.test.ts / chatStore.groupMacros.test.ts —
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
vi.mock('./lovenseStore', () => ({
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

const {
  buildConversationContext,
  buildGroupConversationContext,
  prepareConversationContext,
  finishConversationContext,
  useChatStore,
} = await import('./chatStore');
const { useGenerationStore, POST_HISTORY_SECTIONS } = await import('./generationStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { extensionRegistry } = await import('../extensions/registry');
const {
  GOLDEN_CHAT_FILE,
  GROUP_FIXTURES,
  NOT_WRITTEN,
  SOLO_FIXTURES,
  mkBook,
  mkChar,
  mkEntry,
  mkMsg,
  productionCurrentTurn,
  resetStores,
} = await import('./promptGoldens.fixtures');

import {
  createPromptBreakdown,
  recordAttachments,
  recordCallSiteTurn,
  type PromptBreakdown,
  type SectionKind,
} from '../utils/promptBreakdown';
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from '../utils/tokenizer';
import type { GoldenWiScanOut } from './promptGoldens.fixtures';
import type { LucideIcon } from 'lucide-react';
import type { ContextContribution } from '../extensions/types';
import type { ChatMessage } from './chatStore';

// ---------------------------------------------------------------------------
// A SECOND registered extension
// ---------------------------------------------------------------------------

/**
 * The fixtures register exactly one extension, so a breakdown that hardcoded
 * a single id would pass every fixture-driven assertion. This one exists so
 * "which extension contributed this at-depth block" has more than one possible
 * answer. Registered once, silent unless `secondExtContributions` is set.
 */
let secondExtContributions: ContextContribution[] = [];
extensionRegistry.register({
  id: '__breakdown_second__',
  displayName: 'Second contributor',
  description: 'Test-only: a second at-depth extension source.',
  version: '0.0.0',
  icon: null as unknown as LucideIcon,
  defaultEnabled: true,
  onBuildContext: () => secondExtContributions,
});

// ---------------------------------------------------------------------------
// Running a fixture with a collector attached
// ---------------------------------------------------------------------------

type ContextEntry = { role: string; content: string };

function mkWiOut(messages: ChatMessage[]): GoldenWiScanOut {
  return {
    currentTurn: productionCurrentTurn(messages),
    timers: {},
    activated: new Set<string>(),
  };
}

function runSolo(name: string): {
  context: ContextEntry[];
  overBudget: boolean;
  breakdown: PromptBreakdown;
  wiOut: GoldenWiScanOut;
} {
  const fx = SOLO_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`no solo fixture "${name}"`);
  resetStores();
  secondExtContributions = [];
  const input = fx.setup();
  const wiOut = mkWiOut(input.messages);
  const breakdown = createPromptBreakdown('solo');
  const { context, overBudget } = buildConversationContext(
    input.messages,
    input.character,
    input.availableEmotions,
    wiOut,
    input.ragContext,
    input.serverMatchedEntries,
    breakdown
  );
  return { context, overBudget, breakdown, wiOut };
}

function runGroup(name: string): {
  context: ContextEntry[];
  breakdown: PromptBreakdown;
} {
  const fx = GROUP_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`no group fixture "${name}"`);
  resetStores();
  secondExtContributions = [];
  const input = fx.setup();
  const breakdown = createPromptBreakdown('group');
  const context = buildGroupConversationContext(
    input.messages,
    input.characters,
    input.currentCharacter,
    input.scenarioOverride,
    input.ragContext,
    input.cardMode,
    mkWiOut(input.messages),
    input.attachmentsFolded,
    breakdown
  );
  return { context, breakdown };
}

/** Stage-B slices, in emission order. */
function stageB(b: PromptBreakdown): Extract<SectionKind, { stage: 'B' }>[] {
  return b.slices
    .map((s) => s.kind)
    .filter((k): k is Extract<SectionKind, { stage: 'B' }> => k.stage === 'B');
}

function tokensFor(b: PromptBreakdown, pred: (k: SectionKind) => boolean): number {
  return b.slices.filter((s) => pred(s.kind)).reduce((n, s) => n + s.tokens, 0);
}

// ---------------------------------------------------------------------------
// Reconciliation — AC 5
// ---------------------------------------------------------------------------

describe('token breakdown — the numbers reconcile', () => {
  it('Stage A: sections + join residual + message overhead === the emitted system message', () => {
    // KILLS: measuring the joined string once and calling that "the sections"
    // (per-section counts would be absent or fabricated), and computing the
    // residual from separator character counts instead of the difference —
    // estimateTokens is non-additive (ceil per part, plus a whitespace term
    // that MERGES at the join seams), so a derived residual is wrong by a
    // double-digit number of tokens on a full prompt.
    //
    // Asserting the residual is NON-ZERO is the second half of the kill: an
    // implementation that never measures the join reports 0 and satisfies the
    // identity only because Σ parts would then have to equal the joined total,
    // which for a 13-section prompt it does not.
    const { context, breakdown } = runSolo('all-sections');
    const stageASlices = breakdown.slices.filter((s) => s.kind.stage === 'A');
    expect(stageASlices.length).toBeGreaterThan(5);
    const sum = stageASlices.reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBe(breakdown.totals.stageA);
    expect(
      sum + breakdown.stageAJoinResidual + breakdown.stageAMessageOverhead,
      'Stage-A sections do not add up to the message they were joined into'
    ).toBe(estimateMessageTokens(context[0], breakdown.profile));
    expect(
      breakdown.stageAJoinResidual,
      'a residual pinned at zero means the join was never measured'
    ).not.toBe(0);
    expect(breakdown.stageAMessageOverhead).toBe(4);
  });

  it('every solo fixture reconciles slices + residual + overhead to the assembled total', () => {
    // AC 5, across all 27 branch shapes rather than one. KILLS: an
    // `assembledTotal` computed independently of the slices (the panel would
    // then show a total its own rows cannot sum to), and any slice that is
    // measured but left out of a total.
    for (const fx of SOLO_FIXTURES) {
      const { context, breakdown } = runSolo(fx.name);
      const p = breakdown.profile;
      const reconstructed =
        breakdown.totals.stageA +
        breakdown.stageAJoinResidual +
        breakdown.stageAMessageOverhead +
        breakdown.totals.stageB +
        breakdown.totals.stageC +
        2; // estimateConversationTokens' final priming tokens
      expect(
        breakdown.totals.assembledTotal,
        `${fx.name}: assembledTotal disagrees with its own slices`
      ).toBe(reconstructed);
      expect(
        breakdown.totals.assembledTotal,
        `${fx.name}: assembledTotal is not the assembled context`
      ).toBe(estimateConversationTokens(context, p));
      expect(
        breakdown.totals.trimTotal + breakdown.totals.stageC,
        `${fx.name}: trimTotal + Stage C should be the whole prompt`
      ).toBe(breakdown.totals.assembledTotal);
      expect(
        breakdown.totals.stageB,
        `${fx.name}: stageB total disagrees with its slices`
      ).toBe(tokensFor(breakdown, (k) => k.stage === 'B'));
    }
  });

  it('trimTotal is exactly what the trim charged', () => {
    // The ANCHOR identity, and tautological by design: the token-aware path
    // writes `trimmed.usedTokens` into lastTokenEstimate and the breakdown
    // reads the same field, so this can only fail if one of the two stops
    // being wired. The independent obligation is the section-sum test above.
    for (const fx of SOLO_FIXTURES) {
      const { breakdown } = runSolo(fx.name);
      if (!breakdown.flags.historyTrimmed) continue;
      expect(
        breakdown.totals.trimTotal,
        `${fx.name}: trimTotal is not the trim's usedTokens`
      ).toBe(useGenerationStore.getState().lastTokenEstimate);
    }
  });

  it('group reconciles the same way', () => {
    for (const fx of GROUP_FIXTURES) {
      const { context, breakdown } = runGroup(fx.name);
      expect(
        breakdown.totals.assembledTotal,
        `${fx.name}: assembledTotal is not the assembled context`
      ).toBe(estimateConversationTokens(context, breakdown.profile));
      const reconstructed =
        breakdown.totals.stageA +
        breakdown.stageAMessageOverhead +
        breakdown.totals.stageB +
        breakdown.totals.stageC +
        2;
      expect(
        breakdown.totals.assembledTotal,
        `${fx.name}: group slices do not sum to the assembled total`
      ).toBe(reconstructed);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage B — the split that is the whole point
// ---------------------------------------------------------------------------

describe('token breakdown — Stage B is split, not lumped', () => {
  it('names every at-depth insertion class exactly once on the interleave fixture', () => {
    // KILLS: tagging everything 'history'. That is the cheapest implementation
    // that still reconciles — Stage B's total is unaffected by how the entries
    // are classified, so the reconciliation tests above cannot see it.
    const { breakdown } = runSolo('at-depth-interleave');
    const classes = stageB(breakdown).map((k) => k.cls);
    for (const cls of [
      'characters_note',
      'authors_note',
      'persona_at_depth',
      'wi_at_depth',
      'ext_at_depth',
    ]) {
      expect(
        classes.filter((c) => c === cls).length,
        `expected exactly one ${cls} entry`
      ).toBe(1);
    }
    // Three real turns in that fixture; a class that swallowed them would show
    // up here.
    expect(classes.filter((c) => c === 'history').length).toBe(3);
  });

  it('tags both world-info overflow entries as world info, not as history', () => {
    // The overflow fixture unshifts TWO world-info depths. KILLS a classifier
    // that only handles the in-loop and depth-0 branches — the two overflow
    // unshifts are a separate code path and were the easiest to miss.
    const { breakdown } = runSolo('at-depth-overflow');
    expect(stageB(breakdown).filter((k) => k.cls === 'wi_at_depth').length).toBe(2);
  });

  it('carries the message id on real turns and on nothing else', () => {
    // The recall boundary task 1b needs (`kept[0]` can be an injected note).
    // KILLS: stamping a message id onto every Stage-B entry, which would make
    // an author's note a legal boundary the server cannot resolve.
    const { breakdown } = runSolo('at-depth-interleave');
    for (const k of stageB(breakdown)) {
      if (k.cls === 'history') expect(k.messageId, 'a real turn lost its id').toBeTruthy();
      else expect(k.messageId, `${k.cls} should carry no message id`).toBeUndefined();
    }
    expect(breakdown.boundaryId).toBe('d1');
  });

  it('measures Stage B on what survived the trim, not on the pre-trim array', () => {
    // KILLS: measuring `historyWithInsertions`. That is the array in scope at
    // the natural-looking measurement point, it reconciles against nothing the
    // other tests check, and it reports tokens for messages the model is never
    // sent. The fixture is chosen because its trim actually bites.
    const { context, breakdown } = runSolo('trim-bites');
    expect(breakdown.flags.droppedFromHistory, 'the trim did not bite').toBeGreaterThan(0);

    // Rebuild the same prepare to see what the trim was handed.
    resetStores();
    const input = SOLO_FIXTURES.find((f) => f.name === 'trim-bites')!.setup();
    const prepared = prepareConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      mkWiOut(input.messages),
      input.serverMatchedEntries
    );
    expect(stageB(breakdown).length).toBeLessThan(prepared.historyWithInsertions.length);

    // And what it measured IS the history that shipped: the context minus the
    // leading Stage-A message and the trailing Stage-C ones.
    const stageCCount = breakdown.slices.filter((s) => s.kind.stage === 'C').length;
    const shipped = context.slice(1, context.length - stageCCount);
    expect(stageB(breakdown).length).toBe(shipped.length);
    expect(breakdown.totals.stageB).toBe(
      shipped.reduce((n, m) => n + estimateMessageTokens(m, breakdown.profile), 0)
    );
  });

  it('attributes at-depth extension blocks to the extension that produced them', () => {
    // KILLS: hardcoding 'summarize'. `summarize` is the only at-depth
    // contributor the app ships, so a hardcoded id is green against every
    // fixture until a second extension exists — which is what this test
    // installs.
    resetStores();
    const char = mkChar({ name: 'Ivy', avatar: 'ivy.png' });
    secondExtContributions = [
      { content: '[second ext] at depth 1', role: 'system', position: 'at_depth', depth: 1 },
    ];
    const messages = [mkMsg('x1', 'First.'), mkMsg('x2', 'Second.', { isUser: false, name: 'Ivy' })];
    const breakdown = createPromptBreakdown('solo');
    // The fixtures' own extension contributes nothing this run (resetStores
    // clears it), so the only at-depth block is the second extension's.
    buildConversationContext(messages, char, undefined, mkWiOut(messages), undefined, undefined, breakdown);
    const extIds = stageB(breakdown)
      .filter((k) => k.cls === 'ext_at_depth')
      .map((k) => k.extensionId);
    expect(extIds).toEqual(['__breakdown_second__']);

    // Now BOTH sources contribute at the same depth: two blocks, two distinct
    // ids. A single hardcoded id cannot produce this.
    const withBoth = runSolo('at-depth-interleave');
    secondExtContributions = [
      { content: '[second ext] at depth 2', role: 'system', position: 'at_depth', depth: 2 },
    ];
    const input = SOLO_FIXTURES.find((f) => f.name === 'at-depth-interleave')!.setup();
    const b2 = createPromptBreakdown('solo');
    buildConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      mkWiOut(input.messages),
      undefined,
      undefined,
      b2
    );
    const bothIds = stageB(b2)
      .filter((k) => k.cls === 'ext_at_depth')
      .map((k) => k.extensionId);
    expect(new Set(bothIds).size, 'two extensions should be told apart').toBe(2);
    expect(bothIds).toContain('__prompt_goldens__');
    expect(bothIds).toContain('__breakdown_second__');
    // The one-source run above really did have one source.
    expect(
      stageB(withBoth.breakdown).filter((k) => k.cls === 'ext_at_depth').length
    ).toBe(1);
    secondExtContributions = [];
  });
});

// ---------------------------------------------------------------------------
// Group — per emitted slot
// ---------------------------------------------------------------------------

describe('token breakdown — group tags per emitted slot', () => {
  it('moves tokens between slots when Card mode changes, because the emission does', () => {
    // KILLS: one "character info" concept. Join mode bakes scenario and
    // examples INTO the member blocks and emits nothing in the standalone
    // slots; swap emits description + personality in the cards and routes the
    // rest through their own slots. A single conceptual slice reports the same
    // shape for both, and flipping Card mode would silently move numbers
    // between buckets with no change to what the model is sent.
    const swap = runGroup('swap').breakdown;
    const join = runGroup('join').breakdown;
    const slot = (b: PromptBreakdown, id: string) =>
      tokensFor(b, (k) => k.stage === 'A' && k.id === id);

    expect(slot(swap, 'group_examples'), 'swap emits the speaker example block').toBeGreaterThan(0);
    expect(slot(join, 'group_examples'), 'join folds examples into the cards').toBe(0);
    expect(slot(join, 'group_cards')).toBeGreaterThan(slot(swap, 'group_cards'));
    // Both modes still name the same eight slots — the difference is the
    // numbers, not a different taxonomy.
    const ids = (b: PromptBreakdown) =>
      b.slices.filter((s) => s.kind.stage === 'A').map((s) => (s.kind as { id: string }).id);
    expect(new Set(ids(swap))).toEqual(new Set(ids(join)));
  });

  it('prices recall as the concat delta, not as the raw chunk text', () => {
    // Group appends recall onto the system prompt as a STRING (:2233-2235), so
    // its cost includes the `[Relevant background information]` header and the
    // joining blank line. KILLS: estimateTokens(ragContext), which is smaller
    // and which no total would ever contradict.
    const join = runGroup('join'); // the recall-bearing group fixture
    const recall = tokensFor(join.breakdown, (k) => k.stage === 'A' && k.id === 'group_rag_context');
    expect(recall).toBeGreaterThan(0);
    const raw = GROUP_FIXTURES.find((f) => f.name === 'join')!.setup().ragContext ?? '';
    expect(raw, 'the join fixture stopped carrying recall').not.toBe('');
    expect(recall).toBeGreaterThan(estimateTokens(raw, join.breakdown.profile));
  });

  it('badges the history slice not-trimmed and omits the Reserved slice', () => {
    // AC 7. Group DOES enforce the world-info budget, so the flag has to be
    // per-slice, not a blanket "un-budgeted" on the whole view.
    const { breakdown } = runGroup('wi-budget-eviction');
    expect(breakdown.flags.historyTrimmed).toBe(false);
    expect(breakdown.flags.hasReservedSlice).toBe(false);
    expect(breakdown.wi.budget, 'group does enforce the WI budget').toBeGreaterThan(0);
    expect(breakdown.wi.droppedIds.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// World info — AC 6 and AC 9
// ---------------------------------------------------------------------------

describe('token breakdown — world info', () => {
  it('reports emitted and raw world-info cost as two different numbers', () => {
    // AC 6. The WI budget charges RAW entry content
    // (worldInfoStore.ts applyTokenBudget); the model is charged the
    // POST-macro, post-attribution-wrapper text. KILLS: reporting one number
    // twice, which is invisible to every reconciliation test — the macro
    // fixture expands `{{incvar}}` into digits, so the two must differ.
    const { breakdown } = runSolo('macro-writes');
    expect(breakdown.wi.emittedTokens).toBeGreaterThan(0);
    expect(breakdown.wi.rawTokens).toBeGreaterThan(0);
    expect(
      breakdown.wi.emittedTokens,
      'emitted and raw world-info cost are the same number — one of them is a copy'
    ).not.toBe(breakdown.wi.rawTokens);
  });

  it('records where the activation decision came from', () => {
    // AC 9's data. KILLS: hardcoding 'client', which is right for every
    // fixture except the one that hands the builder a server result.
    expect(runSolo('server-matched-entries').breakdown.wi.activationSource).toBe('server');
    expect(runSolo('all-sections').breakdown.wi.activationSource).toBe('client');
    expect(runGroup('swap').breakdown.wi.activationSource).toBe('client');
  });
});

// ---------------------------------------------------------------------------
// The prepare / finish split
// ---------------------------------------------------------------------------

describe('the prepare/finish split', () => {
  it('finish({ commit: false }) writes nothing at all', () => {
    // KILLS: gating only `setLastTokenEstimate`. There are FOUR writes below
    // the boundary — the token estimate, the chat variables, and the two
    // wiTimerOut fields — and a first pass that persists any of them corrupts
    // real user state with a throwaway measurement.
    resetStores();
    const input = SOLO_FIXTURES.find((f) => f.name === 'macro-writes')!.setup();
    const wiOut = mkWiOut(input.messages);
    const prepared = prepareConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      wiOut,
      input.serverMatchedEntries
    );
    const chatFile = useChatStore.getState().currentChatFile ?? GOLDEN_CHAT_FILE;
    // prepare itself must not have persisted the macro writes either.
    expect(useChatStore.getState().getChatVariables(chatFile)).toEqual({});

    finishConversationContext(prepared, input.ragContext, { commit: false });
    expect(
      useChatStore.getState().getChatVariables(chatFile),
      'an uncommitted pass persisted chat variables'
    ).toEqual({});
    expect(
      useGenerationStore.getState().lastTokenEstimate,
      'an uncommitted pass wrote lastTokenEstimate'
    ).toBe(NOT_WRITTEN);
    expect(wiOut.fired, 'an uncommitted pass wrote wiTimerOut.fired').toBeUndefined();
    expect(wiOut.trimmedAtDepth).toBeUndefined();

    // The committing pass does all four.
    finishConversationContext(prepared, input.ragContext, { commit: true });
    expect(Object.keys(useChatStore.getState().getChatVariables(chatFile)).length).toBeGreaterThan(0);
    expect(useGenerationStore.getState().lastTokenEstimate).not.toBe(NOT_WRITTEN);
    expect(wiOut.fired).toBeDefined();
    expect(wiOut.trimmedAtDepth).toBeDefined();
  });

  it('finish executes no macros, however many times it runs', () => {
    // The contract the whole two-pass design rests on, and the reason the
    // boundary is where it is. KILLS: a split drawn one block higher (the
    // round-2 review proved that re-runs the depth-0 and overflow macro sites
    // and changed no golden) — every counter would read '2'.
    resetStores();
    const input = SOLO_FIXTURES.find((f) => f.name === 'macro-writes')!.setup();
    const wiOut = mkWiOut(input.messages);
    const prepared = prepareConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      wiOut,
      input.serverMatchedEntries
    );
    // The world-info scan — and the activation registration it stamps — lives
    // in prepare. Snapshotted after it, so a finish that re-scanned would move
    // this number.
    const activatedAfterPrepare = [...wiOut.activated].sort();
    const first = finishConversationContext(prepared, input.ragContext, { commit: false });
    const second = finishConversationContext(prepared, input.ragContext, { commit: false });
    const third = finishConversationContext(prepared, input.ragContext, { commit: true });
    expect(JSON.stringify(second.context)).toBe(JSON.stringify(first.context));
    expect(JSON.stringify(third.context)).toBe(JSON.stringify(first.context));
    expect(
      [...wiOut.activated].sort(),
      'a finish pass re-registered world-info activations'
    ).toEqual(activatedAfterPrepare);

    const chatFile = useChatStore.getState().currentChatFile ?? GOLDEN_CHAT_FILE;
    const vars = useChatStore.getState().getChatVariables(chatFile);
    const fx = SOLO_FIXTURES.find((f) => f.name === 'macro-writes')!;
    for (const key of fx.counters ?? []) {
      expect(vars[key], `counter "${key}" executed more than once across three finishes`).toBe('1');
    }
  });

  it('the wrapper is one prepare and one committing finish', () => {
    // KILLS: a wrapper that calls buildConversationContext twice, or that
    // leaves `commit` defaulted to false. Same fixture through the public
    // entry point must produce the single-execution counters.
    const { breakdown } = runSolo('macro-writes');
    const chatFile = useChatStore.getState().currentChatFile ?? GOLDEN_CHAT_FILE;
    const vars = useChatStore.getState().getChatVariables(chatFile);
    const fx = SOLO_FIXTURES.find((f) => f.name === 'macro-writes')!;
    for (const key of fx.counters ?? []) {
      expect(vars[key], `counter "${key}" via buildConversationContext`).toBe('1');
    }
    expect(useGenerationStore.getState().lastTokenEstimate).not.toBe(NOT_WRITTEN);
    expect(breakdown.slices.length).toBeGreaterThan(0);
  });

  it('a rag context supplied only to finish reaches the prompt', () => {
    // The reason the split exists: recall is an INPUT the second pass supplies.
    // KILLS: leaving `rag_context` computed in prepare (where task 1b's second
    // pass could never influence it) — the marker would simply be absent.
    resetStores();
    const input = SOLO_FIXTURES.find((f) => f.name === 'recall-absent')!.setup();
    const prepared = prepareConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      mkWiOut(input.messages),
      input.serverMatchedEntries
    );
    const without = finishConversationContext(prepared, undefined, { commit: false });
    const withRecall = finishConversationContext(prepared, 'BOUNDARY-MARKER-9', {
      commit: false,
    });
    expect(JSON.stringify(without.context)).not.toContain('BOUNDARY-MARKER-9');
    expect(withRecall.context[0].content).toContain('[Relevant background information]');
    expect(withRecall.context[0].content).toContain('BOUNDARY-MARKER-9');
  });
});

// ---------------------------------------------------------------------------
// The buckets the builder cannot see
// ---------------------------------------------------------------------------

describe('token breakdown — the post-return buckets', () => {
  it('records the call-site turn outside the assembled total', () => {
    // continue/impersonate push their instruction AFTER the builder returned,
    // so `assembledTotal` cannot include it. KILLS: adding it into
    // assembledTotal, which would break the identity every other test checks.
    const { breakdown } = runSolo('minimal');
    const before = breakdown.totals.assembledTotal;
    recordCallSiteTurn(breakdown, 'continue', '(Continue your previous response naturally.)');
    expect(breakdown.totals.callSite).toBeGreaterThan(4);
    expect(breakdown.totals.assembledTotal).toBe(before);
    expect(
      breakdown.slices.some((s) => s.kind.stage === 'callSite' && s.kind.turn === 'continue')
    ).toBe(true);
  });

  it('records attachments as their own bucket and charges them nothing', () => {
    // Audit §4.4: image cost is counted nowhere on the client — not by the
    // trim, not by the estimator. KILLS: inventing a token cost for them,
    // which would make the panel's total agree with no other number in the app.
    const { breakdown } = runSolo('minimal');
    const before = breakdown.totals.assembledTotal;
    recordAttachments(breakdown, [{ base64: 'AAAA'.repeat(64) }]);
    expect(breakdown.attachments.count).toBe(1);
    expect(breakdown.attachments.bytes).toBe(192);
    expect(breakdown.totals.assembledTotal).toBe(before);
    const slice = breakdown.slices.find((s) => s.kind.stage === 'attachments');
    expect(slice?.tokens).toBe(0);
  });

  it('produces a populated breakdown, not an empty shell', () => {
    // KILLS: instrumentation that computes nothing. Every golden stays green
    // for an implementation that allocates the object and never fills it —
    // that is exactly the failure this whole file exists for.
    const { breakdown } = runSolo('all-sections');
    const nonZero = breakdown.slices.filter((s) => s.tokens > 0);
    expect(nonZero.length, 'fewer than ten non-empty slices').toBeGreaterThanOrEqual(10);
    expect(new Set(breakdown.slices.map((s) => s.kind.stage)).size).toBeGreaterThanOrEqual(3);
    expect(breakdown.totals.stageA).toBeGreaterThan(0);
    expect(breakdown.totals.stageB).toBeGreaterThan(0);
    expect(breakdown.totals.stageC).toBeGreaterThan(0);
    expect(breakdown.profile, 'the builder did not stamp its real profile').toBe('gpt');
  });
});

// ---------------------------------------------------------------------------
// TASK 2 — regression characterizations
// ---------------------------------------------------------------------------

describe('E2-S2 task 2 — deduplication is absent, and that is the pinned behaviour', () => {
  /**
   * THE CORRECT IMPLEMENTATION DOES NOTHING.
   *
   * Audit §5: the same sentence in a world-info entry and in the recall
   * context reaches the model TWICE, in both builders. There is no cross-
   * pipeline dedup, suppression, or shared ranking anywhere on the client.
   *
   * This test exists to FAIL when someone adds dedup — not because dedup is
   * wrong, but because it would change what every existing chat is sent and
   * would silently invalidate the token breakdown's world-info slice (an entry
   * counted as emitted that recall then swallowed). If you are here because
   * you deliberately added it: update this file and the audit in the same
   * commit, and expect the goldens to move.
   */
  const MARKER = 'The archive floods every third winter.';

  it('emits the same sentence twice in solo when it is both lore and recall', () => {
    resetStores();
    useWorldInfoStore.setState({
      books: [mkBook('b-dup', [mkEntry('e-dup', { content: MARKER, constant: true })])],
      activeBookIds: ['b-dup'],
    });
    const messages = [mkMsg('m1', 'Tell me about the archive.')];
    const context = buildConversationContext(
      messages,
      mkChar({ name: 'Ivy', avatar: 'ivy.png' }),
      undefined,
      mkWiOut(messages),
      MARKER
    ).context;
    const joined = context.map((m) => m.content).join('\n');
    expect(joined.split(MARKER).length - 1, 'solo deduplicated lore against recall').toBe(2);
  });

  it('emits the same sentence twice in group', () => {
    resetStores();
    useWorldInfoStore.setState({
      books: [mkBook('b-dup', [mkEntry('e-dup', { content: MARKER, constant: true })])],
      activeBookIds: ['b-dup'],
    });
    const messages = [mkMsg('m1', 'Tell me about the archive.')];
    const seraphina = mkChar({ name: 'Seraphina', avatar: 'ser.png' });
    const marcus = mkChar({ name: 'Marcus', avatar: 'mar.png' });
    const context = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina,
      undefined,
      MARKER,
      undefined,
      mkWiOut(messages)
    );
    const joined = context.map((m) => m.content).join('\n');
    expect(joined.split(MARKER).length - 1, 'group deduplicated lore against recall').toBe(2);
  });
});

describe('E2-S2 task 2 — the Stage-A / Stage-C membership boundary', () => {
  it('classifies every emitted section by POST_HISTORY_SECTIONS and nothing else', () => {
    // The boundary is a single set (generationStore's POST_HISTORY_SECTIONS)
    // read at two loops. KILLS: a breakdown that decides the stage by position
    // in `context` (correct today, wrong the moment a post-history section is
    // reordered) or that hardcodes the four ids in a second place — the two
    // lists would then drift apart silently.
    const { breakdown } = runSolo('all-sections');
    const stageAIds = breakdown.slices
      .filter((s) => s.kind.stage === 'A')
      .map((s) => (s.kind as { id: string }).id);
    const stageCIds = breakdown.slices
      .filter((s) => s.kind.stage === 'C')
      .map((s) => (s.kind as { id: string }).id);
    expect(stageAIds.length).toBeGreaterThan(0);
    expect(stageCIds.length).toBeGreaterThan(0);
    for (const id of stageAIds) {
      expect(
        POST_HISTORY_SECTIONS.has(id as never),
        `${id} is emitted pre-history but is a post-history section`
      ).toBe(false);
    }
    for (const id of stageCIds) {
      expect(
        POST_HISTORY_SECTIONS.has(id as never),
        `${id} is emitted post-history but is not in POST_HISTORY_SECTIONS`
      ).toBe(true);
    }
    // And the two sets are disjoint — a section cannot be billed twice.
    expect(stageAIds.filter((id) => stageCIds.includes(id))).toEqual([]);
  });

  it('the post-history sections are the ones the trim never charged for', () => {
    // The Stage-C badge ("not counted by the trim") has to be true, not
    // decorative: trimTotal excludes exactly the Stage-C slices.
    const { breakdown } = runSolo('all-sections');
    expect(breakdown.totals.stageC).toBeGreaterThan(0);
    expect(breakdown.totals.assembledTotal - breakdown.totals.trimTotal).toBe(
      breakdown.totals.stageC
    );
  });
});
