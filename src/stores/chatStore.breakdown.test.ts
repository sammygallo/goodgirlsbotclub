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
  MESSAGE_OVERHEAD_TOKENS,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from '../utils/tokenizer';
import type {
  GoldenWiScanOut,
  GroupInput,
  SoloInput,
} from './promptGoldens.fixtures';
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
  /** What the fixture fed the builder — so a test can name the expected
   *  message id from the INPUT rather than from the breakdown it is checking. */
  input: SoloInput;
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
  return { context, overBudget, breakdown, wiOut, input };
}

function runGroup(name: string): {
  context: ContextEntry[];
  breakdown: PromptBreakdown;
  input: GroupInput;
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
  return { context, breakdown, input };
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

function charsFor(b: PromptBreakdown, pred: (k: SectionKind) => boolean): number {
  return b.slices.filter((s) => pred(s.kind)).reduce((n, s) => n + s.chars, 0);
}

/** Every section id that carries world info, in both taxonomies: solo's four
 *  positional sections are `wi_*`, and group's four emitted slots are the same
 *  four names under `group_`. Matched by prefix rather than by a second copy
 *  of the list, so a fifth position cannot quietly escape the cross-check. */
function isWiId(id: string): boolean {
  return id.startsWith('wi_') || id.startsWith('group_wi_');
}

/**
 * The world-info headline, rebuilt from the slices rather than read off
 * `wi.emittedTokens`. Stage A sections are fragments of one message and are
 * billed without the role-marker overhead; Stage B and Stage C entries are
 * whole messages and carry it, while the world-info total counts CONTENT only
 * — hence the subtraction.
 *
 * The overhead comes off `b.messageOverheadPerMessage`, not off a literal 4.
 * That is deliberate twice over: it is how a render-side consumer is supposed
 * to do this (the field exists so nobody writes the 4 down again), and it
 * makes a coherent change to the estimator's constant leave this file green
 * while the goldens catch the behaviour change.
 */
function wiFromSlices(b: PromptBreakdown): number {
  const perMessage = b.messageOverheadPerMessage;
  return b.slices.reduce((n, s) => {
    const k = s.kind;
    if (k.stage === 'A') return isWiId(k.id) ? n + s.tokens : n;
    if (k.stage === 'C') return isWiId(k.id) ? n + s.tokens - perMessage : n;
    if (k.stage === 'B' && k.cls === 'wi_at_depth') return n + s.tokens - perMessage;
    return n;
  }, 0);
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
    // The Stage-A overhead is DERIVED (`estimateMessageTokens(joined) -
    // estimateTokens(joined)`), never a written-down 4 — and this pins it
    // against the named constant the rest of the prompt is charged with, so
    // the two cannot answer differently. That is also why the assertion is not
    // the literal any more: a coherent change to the estimator's per-message
    // overhead has to move the goldens, not this file.
    expect(breakdown.stageAMessageOverhead).toBe(breakdown.messageOverheadPerMessage);
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
        // NOT the literal 2: reading the collector's own field is what makes
        // this test the guard on it. A panel summing the documented parts is
        // short by exactly this much, so the number has to be ON the type —
        // and a second copy of a tokenizer constant is how the two drift.
        breakdown.conversationPriming;
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

  it("reconciles Reading A too: content rows plus ONE aggregate overhead line", () => {
    // AC 5 says the per-message overhead must be shown as its own line rather
    // than silently absorbed. The collector bakes it into each Stage-B/C slice
    // (Reading B — the cost belongs to the piece that incurred it, which is
    // what makes the identity above hold), so a panel that wants the other
    // presentation has to rebuild the aggregate. This is that arithmetic, done
    // exactly the way a render-side consumer must do it: content-only rows,
    // plus messageOverheadPerMessage x (Stage-B slices + Stage-C slices), plus
    // the Stage-A message's single share. No literal 4 anywhere in it.
    //
    // KILLS: a `messageOverheadPerMessage` that lies — a hand-written literal
    // beside the estimator's constant, or a 0 left over from construction.
    // Neither is visible to the Reading-B identity above, which never reads
    // the field, so the panel would draw an overhead line that agrees with
    // nothing.
    for (const fx of SOLO_FIXTURES) {
      const { context, breakdown } = runSolo(fx.name);
      const p = breakdown.profile;
      const perMessage = breakdown.messageOverheadPerMessage;
      const contentOnly = context.reduce((n, m) => n + estimateTokens(m.content, p), 0);
      const wholeMessages = breakdown.slices.filter(
        (sl) => sl.kind.stage === 'B' || sl.kind.stage === 'C'
      ).length;
      const aggregateOverhead = perMessage * wholeMessages + breakdown.stageAMessageOverhead;
      expect(
        contentOnly + aggregateOverhead + breakdown.conversationPriming,
        `${fx.name}: the aggregate overhead line does not reconcile`
      ).toBe(breakdown.totals.assembledTotal);
    }
    // Group's flat system message is assembled by a different function with
    // its own copy of the overhead derivation, so it gets the same arithmetic.
    for (const fx of GROUP_FIXTURES) {
      const { context, breakdown } = runGroup(fx.name);
      const p = breakdown.profile;
      const contentOnly = context.reduce((n, m) => n + estimateTokens(m.content, p), 0);
      const wholeMessages = breakdown.slices.filter(
        (sl) => sl.kind.stage === 'B' || sl.kind.stage === 'C'
      ).length;
      const aggregateOverhead =
        breakdown.messageOverheadPerMessage * wholeMessages +
        breakdown.stageAMessageOverhead;
      expect(
        contentOnly + aggregateOverhead + breakdown.conversationPriming,
        `group/${fx.name}: the aggregate overhead line does not reconcile`
      ).toBe(breakdown.totals.assembledTotal);
    }
  });

  it('reports the per-message overhead the estimator actually charges', () => {
    // The direct form of the kill above, and the one that survives a future
    // panel doing its own arithmetic: the field must BE the estimator's
    // constant, measured rather than asserted. KILLS a second hand-written
    // copy of the 4 on the collector, which is the same failure the priming
    // line was fixed for.
    const { breakdown } = runSolo('minimal');
    const p = breakdown.profile;
    expect(breakdown.messageOverheadPerMessage).toBe(
      estimateMessageTokens({ role: 'user', content: 'probe' }, p) -
        estimateTokens('probe', p)
    );
    expect(breakdown.messageOverheadPerMessage).toBe(MESSAGE_OVERHEAD_TOKENS);
    expect(runGroup('swap').breakdown.messageOverheadPerMessage).toBe(
      MESSAGE_OVERHEAD_TOKENS
    );
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
        breakdown.conversationPriming;
      expect(
        breakdown.totals.assembledTotal,
        `${fx.name}: group slices do not sum to the assembled total`
      ).toBe(reconstructed);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage A — every section on its OWN row
// ---------------------------------------------------------------------------

/**
 * A substring that appears in exactly one of `all-sections`' Stage-A sections,
 * in emission order. Read off the fixture's own configured content (and its
 * golden), never off the collector — the point is to have a second, independent
 * statement of which text belongs to which section id.
 */
const STAGE_A_MARKERS: Array<[string, string]> = [
  ['main_prompt', 'keeper of the closed stacks'],
  ['persona_before_char', 'night-shift cataloguer'],
  ['wi_before_char', 'the stacks run four floors down'],
  ['ext_before_char', '[ext] before_char contribution'],
  ['char_info_block', 'A quiet archivist who never throws anything away'],
  ['wi_after_char', 'the catalogue is not alphabetical'],
  ['ext_after_char', '[ext] after_char contribution'],
  ['wi_before_an', 'the lift only stops on even floors'],
  ['ext_before_an', '[ext] before_an contribution'],
  ['jailbreak', 'the padding spaces are deliberate'],
  ['emotion_instruction', 'Begin each response with an emotion tag'],
  ['selfie_instruction', 'can send a real photo of themselves'],
  ['rag_context', 'I asked about the closed stacks'],
];

/** The same idea for Stage C, whose sections are whole messages. */
const STAGE_C_MARKERS: Array<[string, string]> = [
  ['char_phi', 'Keep replies under four sentences'],
  ['user_phi', 'end on an image, not a question'],
  ['wi_after_an', 'nobody signs the ledger out'],
  ['ext_after_an', '[ext] after_an contribution'],
];

describe('token breakdown — per-section attribution', () => {
  it('bills every Stage-A section its own recomputed cost, under its own id', () => {
    // KILLS: any drift between `systemPartIds[i]` and `systemParts[i]`. The
    // sum identity, the POST_HISTORY membership test and all 142 goldens are
    // invariant under a permutation of those ids — reversing every one of them
    // leaves the whole suite green while every number in the panel sits on the
    // wrong row, telling a user tuning spend that their selfie instruction is
    // their persona. Per-section attribution is the entire product here, so it
    // gets asserted three ways: the id ORDER, an independently recomputed cost
    // per slice, and a distinctive piece of content per id.
    const { context, breakdown } = runSolo('all-sections');
    const p = breakdown.profile;
    const stageA = breakdown.slices.filter((s) => s.kind.stage === 'A');
    expect(
      stageA.map((s) => (s.kind as { id: string }).id),
      'the Stage-A sections are not the ones this fixture emits, in order'
    ).toEqual(STAGE_A_MARKERS.map(([id]) => id));

    // The parts were joined with '\n\n' in this order, so the slices have to
    // TILE the emitted system message: walking it by the recorded `chars`
    // recovers each section's exact text, and the walk only lands back on the
    // end of the string if every length is right.
    const joined = context[0].content;
    let offset = 0;
    for (let i = 0; i < stageA.length; i++) {
      const [id, marker] = STAGE_A_MARKERS[i];
      const part = joined.slice(offset, offset + stageA[i].chars);
      expect(
        estimateTokens(part, p),
        `${id}: billed a cost that is not this section's own`
      ).toBe(stageA[i].tokens);
      expect(
        joined.split(marker).length - 1,
        `${marker} no longer identifies exactly one section`
      ).toBe(1);
      expect(part, `${id}'s slice is covering another section's content`).toContain(marker);
      offset += stageA[i].chars + 2;
    }
    expect(
      offset - 2,
      'the Stage-A slices do not tile the system message they were joined into'
    ).toBe(joined.length);
  });

  it('bills every Stage-C section its own message, under its own id', () => {
    // Stage C is one message per section, so there is no join to hide behind:
    // KILLS `id: entry.id` -> a hardcoded member of POST_HISTORY_SECTIONS,
    // which satisfies both halves of the membership test, and any permutation
    // of the four. Under the hardcode a group of post-history sections — the
    // after-AN world info included — all bill to one label, and the user
    // cannot find their lore spend at all.
    const { context, breakdown } = runSolo('all-sections');
    const p = breakdown.profile;
    const stageC = breakdown.slices.filter((s) => s.kind.stage === 'C');
    expect(stageC.map((s) => (s.kind as { id: string }).id)).toEqual(
      STAGE_C_MARKERS.map(([id]) => id)
    );
    // Stage C is the tail of `context`, in the same order it was measured.
    const tail = context.slice(context.length - stageC.length);
    for (let i = 0; i < stageC.length; i++) {
      const [id, marker] = STAGE_C_MARKERS[i];
      expect(tail[i].content, `${id}'s slice is covering another section's content`).toContain(
        marker
      );
      expect(stageC[i].chars, `${id}: chars are not this section's own`).toBe(
        tail[i].content.length
      );
      expect(stageC[i].tokens, `${id}: cost is not this section's own`).toBe(
        estimateMessageTokens(tail[i], p)
      );
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

    // ...but 'd1' is also what the naive `kept[0]` gives on THIS fixture: its
    // insertions all sit at depth 2, so the head of kept history is a real
    // turn either way. These two are where the implementations diverge — the
    // head is an unshifted overflow insertion in the first and a pinned
    // critical world-info entry in the second, and `kept[0]` yields null for
    // both, which client.ts:1272 would drop from the request entirely.
    expect(
      runSolo('at-depth-overflow').breakdown.boundaryId,
      'kept[0] there is an unshifted at-depth insertion, not a turn'
    ).toBe('o1');
    expect(
      runSolo('trim-overbudget').breakdown.boundaryId,
      'kept[0] there is a pinned critical world-info insertion'
    ).toBe('big');
  });

  it('carries the emitted role on real turns, so "Your message" needs no join back to the store', () => {
    // AC 2g's bucket has to be answerable FROM THE BREAKDOWN. Without the
    // role, isolating the user's own turn means re-reading
    // `useChatStore.messages` at render time — a list that has already moved
    // on (the assistant's reply is appended before any panel draws) and that
    // is not the same list anyway: hidden turns and blank-turn skips mean a
    // stored message need not be an emitted one.
    //
    // KILLS: stamping every history slice 'user'. `at-depth-zero` emits
    // user -> assistant, so a constant role is wrong for exactly one of them.
    const { context, breakdown, input } = runSolo('at-depth-zero');
    const history = stageB(breakdown).filter((k) => k.cls === 'history');
    expect(history.map((k) => k.role)).toEqual(['user', 'assistant']);
    expect(history.map((k) => k.messageId)).toEqual(['z1', 'z2']);

    // The bucket itself: newest history slice whose role is 'user'.
    const yourMessage = [...history].reverse().find((k) => k.role === 'user');
    const newestUserInput = [...input.messages].reverse().find((m) => m.isUser)!;
    expect(yourMessage?.messageId).toBe(newestUserInput.id);

    // ...and why reading roles off the EMITTED context instead cannot work.
    // This fixture puts all five at-depth classes in the depth-0 slot, which
    // sits AFTER the newest turn, and two of them are role 'user' (the
    // author's note and the extension block). So the last user-role entry of
    // the assembled prompt is an injected note, and a panel that found "Your
    // message" that way would chart the note's tokens under the user's name.
    const lastUserInContext = [...context].reverse().find((m) => m.role === 'user');
    expect(
      lastUserInContext?.content,
      'this fixture is supposed to bury the user turn under user-role insertions'
    ).not.toBe(newestUserInput.content);
  });

  it('stamps the role on real turns and on nothing else', () => {
    // Same shape as the message-id test above and for a sharper reason: the
    // insertion classes DO have an emitted role, so "just copy entry.role onto
    // every Stage-B kind" is the cheapest wrong implementation and it looks
    // strictly more informative. It is not: it makes
    // `slices.filter(k => k.role === 'user')` — the query a panel author will
    // reach for — silently return the author's note as well as the user.
    for (const fixture of ['at-depth-interleave', 'at-depth-zero', 'at-depth-overflow']) {
      const { breakdown } = runSolo(fixture);
      const kinds = stageB(breakdown);
      expect(
        kinds.filter((k) => k.cls !== 'history').length,
        `${fixture}: no insertions to check`
      ).toBeGreaterThan(0);
      for (const k of kinds) {
        if (k.cls === 'history') {
          expect(k.role, `${fixture}: a real turn lost its role`).toBeTruthy();
        } else {
          expect(k.role, `${fixture}: ${k.cls} should carry no role`).toBeUndefined();
        }
      }
    }
  });

  it('carries the role through group history too', () => {
    // Group reaches the same field by a different route (`sliceForPushed`
    // reads the entry it just pushed, there is no prepare/finish split and no
    // entryClassByMessage map), so it gets its own pin. KILLS: wiring the role
    // in solo only, which leaves task 3 unable to draw "Your message" for
    // exactly the mode whose history is never trimmed.
    const { breakdown, input } = runGroup('swap');
    const history = stageB(breakdown).filter((k) => k.cls === 'history');
    expect(history.length).toBeGreaterThan(1);
    expect(new Set(history.map((k) => k.role))).toEqual(new Set(['user', 'assistant']));
    const yourMessage = [...history].reverse().find((k) => k.role === 'user');
    const newestUserInput = [...input.messages].reverse().find((m) => m.isUser)!;
    expect(yourMessage?.messageId).toBe(newestUserInput.id);
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
      {
        content: '[second ext] at depth 1',
        role: 'system',
        position: 'at_depth',
        depth: 1,
        // A contribution declaring someone ELSE's id. types.ts promises the
        // registry stamp "cannot be spoofed", and the production code keeps
        // that promise only because `sourceExtensionId: ext.id` sits AFTER
        // `...item` in registry.ts — a tidy-up that hoisted the key to the top
        // of the literal was green across the whole 1815-test suite. This is
        // the only place that override path is exercised.
        sourceExtensionId: 'summarize',
      },
    ];
    const messages = [mkMsg('x1', 'First.'), mkMsg('x2', 'Second.', { isUser: false, name: 'Ivy' })];
    const breakdown = createPromptBreakdown('solo');
    // The fixtures' own extension contributes nothing this run (resetStores
    // clears it), so the only at-depth block is the second extension's.
    buildConversationContext(messages, char, undefined, mkWiOut(messages), undefined, undefined, breakdown);
    const extIds = stageB(breakdown)
      .filter((k) => k.cls === 'ext_at_depth')
      .map((k) => k.extensionId);
    expect(
      extIds,
      'a contribution overrode the registry stamp — the id can be spoofed'
    ).toEqual(['__breakdown_second__']);

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

  it('prices the scenario and every world-info slot off its own emitted fragment', () => {
    // KILLS: understating any named slot. `group_system_chrome` is a RESIDUAL
    // (`tk(systemPrompt) - named`), so a slot that reports zero silently moves
    // its whole cost into "Template chrome" and every reconciliation identity
    // still holds — while `wi.emittedTokens` keeps reporting the real number,
    // so the panel's world-info rows and its own world-info headline disagree.
    // Only `group_cards` and `group_examples` were pinned; the scenario and all
    // four world-info slots could be zeroed with the suite green.
    //
    // Built here rather than off a fixture because the expected fragment has to
    // be computed independently: these entries are unowned, non-persona and
    // macro-free, so `wrapWiContent` returns them verbatim and the template's
    // own wrappers are the whole of the difference.
    resetStores();
    secondExtContributions = [];
    const BEFORE_CHAR = 'SLOT before_char: the vault door sticks in the cold.';
    const AFTER_CHAR = 'SLOT after_char: the deck is short a nine.';
    const BEFORE_AN = 'SLOT before_an: the pot is never counted aloud.';
    const AFTER_AN = 'SLOT after_an: losers leave by the stairs.';
    const SCENARIO = 'The back room, an hour before the game.';
    useWorldInfoStore.setState({
      books: [
        mkBook('b-slots', [
          mkEntry('e-bc', { content: BEFORE_CHAR, position: 'before_char' }),
          mkEntry('e-ac', { content: AFTER_CHAR, position: 'after_char' }),
          mkEntry('e-ba', { content: BEFORE_AN, position: 'before_an' }),
          mkEntry('e-aa', { content: AFTER_AN, position: 'after_an' }),
        ]),
      ],
      activeBookIds: ['b-slots'],
    });
    const messages = [mkMsg('g1', 'Who deals?')];
    const seraphina = mkChar({ name: 'Seraphina', avatar: 'ser.png' });
    const marcus = mkChar({ name: 'Marcus', avatar: 'mar.png' });
    const breakdown = createPromptBreakdown('group');
    const context = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina,
      SCENARIO,
      undefined,
      undefined,
      mkWiOut(messages),
      true,
      breakdown
    );
    const p = breakdown.profile;
    const stageASlot = (id: string) =>
      tokensFor(breakdown, (k) => k.stage === 'A' && k.id === id);
    // The fragment each slot contributes to the flat template, wrappers and all.
    for (const [id, fragment] of [
      ['group_wi_before_char', `\n${BEFORE_CHAR}\n`],
      ['group_wi_after_char', `\n${AFTER_CHAR}\n`],
      ['group_wi_before_an', `${BEFORE_AN}\n\n`],
      ['group_scenario', `Current scenario: ${SCENARIO}\n`],
    ] as Array<[string, string]>) {
      expect(
        context[0].content,
        `${id}: this build did not emit the fragment the test assumes`
      ).toContain(fragment);
      expect(stageASlot(id), `${id} is not priced as its own fragment`).toBe(
        estimateTokens(fragment, p)
      );
      expect(
        charsFor(breakdown, (k) => k.stage === 'A' && k.id === id),
        `${id}: chars are not its own fragment's`
      ).toBe(fragment.length);
      expect(stageASlot(id), `${id} measured nothing at all`).toBeGreaterThan(0);
    }
    // The fourth world-info slot is post-history and therefore a whole message
    // of its own — same obligation, different overhead.
    const afterAn = breakdown.slices.filter(
      (s) => s.kind.stage === 'C' && s.kind.id === 'group_wi_after_an'
    );
    expect(afterAn.length).toBe(1);
    expect(afterAn[0].tokens).toBe(
      estimateTokens(AFTER_AN, p) + breakdown.messageOverheadPerMessage
    );
    expect(afterAn[0].chars).toBe(AFTER_AN.length);
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

  it('reports the solo budget the entries were measured against, and what it evicted', () => {
    // The group half of this is pinned below; solo had nothing, though it has
    // its own copy of the propagation and its own dedicated fixture. KILLS:
    // `budget = 0` / `droppedIds = []`. Both are silent — the goldens pin
    // `scanReport` upstream of the breakdown — and both LIE in the same
    // direction: worldInfoStore treats a budget of 0 as unlimited, so the panel
    // would tell a user whose lore was evicted that no budget applied and
    // nothing was dropped. AC 6 / AC 9 make these two fields the whole
    // eviction story.
    const { breakdown } = runSolo('wi-budget-eviction');
    expect(breakdown.wi.budget).toBe(40);
    expect(breakdown.wi.droppedIds).toEqual(['e-evicted']);
  });

  it('counts lore placed after the author\'s note toward the world-info total', () => {
    // The Stage-C half of `wi.emittedTokens`. `after_an` is a first-class
    // world-info position, but the only fixture asserting emittedTokens keeps
    // all its lore at `before_char`, so deleting the Stage-C accumulation
    // entirely was green. The panel would then show a `wi_after_an` row whose
    // tokens are missing from its own World Info headline.
    resetStores();
    secondExtContributions = [];
    const LORE = 'AFTER-AN lore: the ledger is signed at the door.';
    useWorldInfoStore.setState({
      books: [mkBook('b-aa', [mkEntry('e-aa', { content: LORE, position: 'after_an' })])],
      activeBookIds: ['b-aa'],
    });
    const messages = [mkMsg('m1', 'Who signs it?')];
    const breakdown = createPromptBreakdown('solo');
    const { context } = buildConversationContext(
      messages,
      mkChar({ name: 'Ivy', avatar: 'ivy.png' }),
      undefined,
      mkWiOut(messages),
      undefined,
      undefined,
      breakdown
    );
    // It really did land post-history: its own trailing system message, and no
    // Stage-A world-info slice anywhere.
    expect(context[context.length - 1].content).toBe(LORE);
    expect(
      breakdown.slices.filter((s) => s.kind.stage === 'A' && isWiId(s.kind.id)).length
    ).toBe(0);
    expect(
      breakdown.slices.filter((s) => s.kind.stage === 'C' && s.kind.id === 'wi_after_an').length
    ).toBe(1);
    expect(breakdown.wi.emittedTokens).toBe(estimateTokens(LORE, breakdown.profile));
    expect(breakdown.wi.emittedTokens).toBeGreaterThan(0);
  });

  it('adds the world-info headline up from the same slices the panel renders', () => {
    // The cross-check promoted into the suite, across every fixture in both
    // modes: `wi.emittedTokens` is accumulated at FOUR sites (solo Stage A,
    // solo Stage B at-depth, solo Stage C, and group's own counter), and each
    // one of them can be dropped without moving a single other number. A panel
    // whose World Info headline disagrees with its own world-info rows is the
    // failure this makes impossible.
    for (const fx of SOLO_FIXTURES) {
      const { breakdown } = runSolo(fx.name);
      expect(
        breakdown.wi.emittedTokens,
        `${fx.name}: the world-info headline disagrees with the world-info slices`
      ).toBe(wiFromSlices(breakdown));
    }
    for (const fx of GROUP_FIXTURES) {
      const { breakdown } = runGroup(fx.name);
      expect(
        breakdown.wi.emittedTokens,
        `group/${fx.name}: the world-info headline disagrees with the world-info slices`
      ).toBe(wiFromSlices(breakdown));
    }
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
// Flags, identity, and re-entry
// ---------------------------------------------------------------------------

describe('token breakdown — the Reserved slice follows the reserve, not the mode', () => {
  it('is absent on every build where no trim consulted responseReserve', () => {
    // AC 7. KILLS: `hasReservedSlice = mode === 'solo'` at construction, which
    // is the only thing that ever set this field. `responseReserve` is read
    // inside the token-aware branch and nowhere else, so with the (shipped,
    // user-reachable) token-aware toggle off it constrains nothing — and a
    // panel following this field's contract would still render "Reserved for
    // response: N tokens" as a slice of a prompt whose assembly never looked
    // at N. Group was pinned; solo was not.
    expect(
      runSolo('token-aware-off').breakdown.flags.hasReservedSlice,
      'no trim ran, so nothing was reserved'
    ).toBe(false);
    expect(runSolo('fixed-window-summary-skew').breakdown.flags.hasReservedSlice).toBe(false);
    expect(
      runSolo('all-sections').breakdown.flags.hasReservedSlice,
      'the trim ran and the reserve bound the budget'
    ).toBe(true);
    expect(runGroup('swap').breakdown.flags.hasReservedSlice).toBe(false);
  });

  it('reports the reserve the trim actually used, not the one live in settings', () => {
    // `hasReservedSlice` says a Reserved slice belongs on the chart; it does
    // not say how big. Without the number, a panel has to read
    // `generationStore.context.responseReserve` at RENDER time — a value the
    // user can change in Settings between the send and the draw, which would
    // size a slice of this prompt from a reserve this prompt was never
    // assembled against. Exactly the staleness `chatFile` / `publishedAt`
    // exist to defend against, and quieter: the chart would just be wrong.
    //
    // KILLS: hardcoding the default 2048 — both trim fixtures deliberately
    // configure 256.
    expect(runSolo('trim-bites').breakdown.responseReserve).toBe(256);
    expect(runSolo('trim-overbudget').breakdown.responseReserve).toBe(256);
    // ...and a fixture that leaves the default alone, so "always 256" dies too.
    expect(runSolo('all-sections').breakdown.responseReserve).toBe(2048);

    // KILLS: setting it whenever the field exists. `token-aware-off` still
    // HAS a responseReserve of 2048 in its config — the trim just never reads
    // it — so a build that reported 2048 there would tell the user 2048
    // tokens of budget pressure shaped a prompt that was never budgeted.
    // Null rather than 0 because 0 is itself a legal reserve.
    expect(
      runSolo('token-aware-off').breakdown.responseReserve,
      'no trim ran, so no reserve was consulted'
    ).toBeNull();
    expect(runSolo('fixed-window-summary-skew').breakdown.responseReserve).toBeNull();
    expect(runGroup('swap').breakdown.responseReserve).toBeNull();

    // The flag and the number never disagree — a Reserved slice with no size,
    // or a size with no slice, is a panel bug either way.
    for (const name of ['trim-bites', 'token-aware-off', 'all-sections']) {
      const b = runSolo(name).breakdown;
      expect(b.flags.hasReservedSlice, name).toBe(b.responseReserve !== null);
    }
  });
});

describe('token breakdown — which prompt a breakdown describes', () => {
  it('stamps the chat and a distinct publish time on every build', () => {
    // `generationStore.lastPromptBreakdown` is one last-write-wins slot, and a
    // group round overwrites it once per speaker (sendGroupMessage awaits
    // generateGroupTurn per member, each publishing its own build before
    // dispatch). Without a stamp, a consumer holding a breakdown has no field
    // with which to notice it belongs to a different turn than the message it
    // is rendered against.
    //
    // PRESENCE AND DISTINCTNESS ONLY — never the value. A wall-clock number in
    // an assertion is a flake, and nothing here may reach a golden.
    const first = runGroup('swap').breakdown;
    const second = runGroup('swap').breakdown;
    expect(first.chatFile).toBe(GOLDEN_CHAT_FILE);
    expect(second.chatFile).toBe(GOLDEN_CHAT_FILE);
    expect(first.publishedAt).toBeGreaterThan(0);
    expect(
      second.publishedAt,
      'two back-to-back group builds carry the same stamp'
    ).not.toBe(first.publishedAt);
    const solo = runSolo('minimal').breakdown;
    expect(solo.chatFile).toBe(GOLDEN_CHAT_FILE);
    expect(solo.publishedAt).not.toBe(second.publishedAt);
  });
});

describe('token breakdown — a collector describes one pass, not their union', () => {
  it('group: a second build through the same collector replaces the first', () => {
    // KILLS: `addSlice` appending with nothing ever clearing `slices`. Group
    // derives its stage totals by SUMMING the accumulated slices while
    // `assembledTotal` is recomputed from `context`, so a reused collector
    // reports a prompt twice the size the model was sent and AC 5's
    // reconciliation breaks outright. Not reachable from today's six call
    // sites — each makes its own collector — but task 1b's two-pass finish and
    // task 3 are exactly the shapes that would reuse one.
    resetStores();
    secondExtContributions = [];
    const input = GROUP_FIXTURES.find((f) => f.name === 'swap')!.setup();
    const b = createPromptBreakdown('group');
    const build = () =>
      buildGroupConversationContext(
        input.messages,
        input.characters,
        input.currentCharacter,
        input.scenarioOverride,
        input.ragContext,
        input.cardMode,
        mkWiOut(input.messages),
        input.attachmentsFolded,
        b
      );
    build();
    const afterOne = b.slices.length;
    const stageAAfterOne = b.totals.stageA;
    const stampAfterOne = b.publishedAt;
    build();
    expect(b.slices.length, 'the second build appended to the first').toBe(afterOne);
    // The re-entry RE-STAMP is the only stamp on the reuse path — the scoped
    // fix-round review proved deleting it left the whole suite green while the
    // stamp's entire purpose (letting task 3 tell two builds apart) died. A
    // re-entered collector must carry the LAST build's identity, not the first's.
    expect(
      b.publishedAt,
      "the re-entered collector still carries the first build's stamp"
    ).toBeGreaterThan(stampAfterOne!);
    // And the chat half: switch the live chat underneath the third build — the
    // stamp must follow the build, not the constructor.
    useChatStore.setState({ currentChatFile: 'breakdown-restamp-other.jsonl' });
    build();
    expect(
      b.chatFile,
      'a re-entered collector still names the previous build\'s chat'
    ).toBe('breakdown-restamp-other.jsonl');
    useChatStore.setState({ currentChatFile: null });
    expect(b.totals.stageA).toBe(stageAAfterOne);
    expect(
      b.totals.stageA +
        b.stageAMessageOverhead +
        b.totals.stageB +
        b.totals.stageC +
        b.conversationPriming,
      'a re-entered collector no longer reconciles'
    ).toBe(b.totals.assembledTotal);
  });

  it('solo: an uncommitted pass and the committing one leave one set of slices', () => {
    // The documented task-1b shape: prepare once, finish twice — the first
    // uncommitted purely to learn the boundary. Solo assigns its totals from
    // local accumulators, so every total still looks right while the panel
    // renders each section twice; nothing but this test can see it.
    resetStores();
    secondExtContributions = [];
    const input = SOLO_FIXTURES.find((f) => f.name === 'minimal')!.setup();
    const prepared = prepareConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      mkWiOut(input.messages),
      input.serverMatchedEntries
    );
    const b = createPromptBreakdown('solo');
    finishConversationContext(prepared, undefined, { commit: false, breakdownOut: b });
    const { context } = finishConversationContext(prepared, undefined, {
      commit: true,
      breakdownOut: b,
    });
    const key = (s: { kind: SectionKind }) => JSON.stringify(s.kind);
    expect(
      new Set(b.slices.map(key)).size,
      'the collector kept both passes — every section is billed twice'
    ).toBe(b.slices.length);
    expect(b.totals.assembledTotal).toBe(estimateConversationTokens(context, b.profile));
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
    // Membership alone is satisfied by hardcoding any ONE member, which would
    // bill all four post-history sections under a single label. `all-sections`
    // emits every one of them, so the set is exactly this.
    expect(
      new Set(stageCIds).size,
      'two post-history sections were billed under one id'
    ).toBe(stageCIds.length);
    expect(new Set(stageCIds)).toEqual(
      new Set(['char_phi', 'user_phi', 'wi_after_an', 'ext_after_an'])
    );
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
