/**
 * E2-S2 task 1b — the recall boundary, after the re-simulation was deleted.
 *
 * `src/utils/ragBoundary.ts` used to answer "where does this turn's raw
 * history start?" by re-running a stripped copy of the solo trim before the
 * builder. It diverged from the real assembly five ways (tokenizer profile,
 * an EMPTY system block against the real 2-3K one, no at-depth insertions or
 * summary, raw instead of macro-substituted content, and no blank/image-only
 * skips), in both directions, so it was deleted rather than repaired. This
 * file covers what replaced it:
 *
 *   solo  — the call sites run the REAL builder once (`prepare`) and finish
 *           twice: an uncommitted probe with no recall to learn the boundary,
 *           then the committing pass with the recall it produced.
 *   group — `groupRecallBoundary`, reading the same `groupHistoryWindow` the
 *           group builder slices its history from.
 *
 * The goldens cannot cover any of this: they hand `ragContext` to the builder
 * directly, so they never exercise resolution at all. Every test below names
 * the cheapest wrong implementation it exists to kill.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A spy that WRAPS the real `groupHistoryWindow` (it must keep behaving
// exactly as it does in production) so the last describe block can prove both
// callers reach the same function object. Declared through `vi.hoisted` because
// `vi.mock`'s factory is hoisted above every const in this file.
const { groupWindowSpy } = vi.hoisted(() => ({ groupWindowSpy: vi.fn() }));
vi.mock('../utils/groupHistoryWindow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/groupHistoryWindow')>();
  return {
    ...actual,
    groupHistoryWindow: (messages: Parameters<typeof actual.groupHistoryWindow>[0]) => {
      groupWindowSpy(messages);
      return actual.groupHistoryWindow(messages);
    },
  };
});

// Same prelude as promptGoldens.test.ts / chatStore.breakdown.test.ts —
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
  _resetNoKeyHintForTests,
  buildGroupConversationContext,
  finishConversationContext,
  groupRecallBoundary,
  prepareConversationContext,
  resolveRagContext,
  useChatStore,
} = await import('./chatStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useCharacterStore } = await import('./characterStore');
const { api } = await import('../api/client');
const { showToastGlobal } = await import('../components/ui/Toast');
const { groupHistoryWindow } = await import('../utils/groupHistoryWindow');
const {
  GROUP_FIXTURES,
  SOLO_FIXTURES,
  productionCurrentTurn,
  resetStores,
} = await import('./promptGoldens.fixtures');

import { createPromptBreakdown, type PromptBreakdown } from '../utils/promptBreakdown';
import type { ChatMessage } from './chatStore';
import type { GoldenWiScanOut, SoloInput } from './promptGoldens.fixtures';

function mkWiOut(messages: ChatMessage[]): GoldenWiScanOut {
  return {
    currentTurn: productionCurrentTurn(messages),
    timers: {},
    activated: new Set<string>(),
  };
}

/** A fixture, prepared once — exactly what a call site does before probing. */
function prepareSolo(name: string): {
  prepared: ReturnType<typeof prepareConversationContext>;
  input: SoloInput;
} {
  const fx = SOLO_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`no solo fixture "${name}"`);
  resetStores();
  const input = fx.setup();
  const prepared = prepareConversationContext(
    input.messages,
    input.character,
    input.availableEmotions,
    mkWiOut(input.messages),
    input.serverMatchedEntries
  );
  return { prepared, input };
}

/** The message id on the OLDEST Stage-B slice that is a real chat turn —
 *  the same thing the panel will read when it draws the history bucket. */
function firstHistorySliceId(b: PromptBreakdown): string | undefined {
  for (const s of b.slices) {
    if (s.kind.stage === 'B' && s.kind.cls === 'history') return s.kind.messageId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Solo: what the probe pass returns
// ---------------------------------------------------------------------------

describe('the recall boundary a solo call site probes for', () => {
  it('agrees with the breakdown the same pass reports', () => {
    // Parity between the value the CALL SITE reads (the return) and the value
    // the PANEL reads (the collector). KILLS: two derivations that can drift —
    // e.g. a return computed from `keptHistory[0]` while the collector walks
    // the tagged slices. `at-depth-overflow` is the fixture where those two
    // disagree: the head of its kept history is an unshifted at-depth
    // insertion, which carries no message id at all.
    const { prepared } = prepareSolo('at-depth-overflow');
    const b = createPromptBreakdown('solo');
    const finished = finishConversationContext(prepared, undefined, {
      commit: false,
      breakdownOut: b,
    });
    expect(finished.boundaryId).toBe(firstHistorySliceId(b));
    expect(finished.boundaryId).toBe('o1');
  });

  it('is returned with NO collector attached', () => {
    // THE probe-pass contract, and the cheapest wrong implementation in this
    // whole task: deriving `boundaryId` inside the `if (out)` block that wraps
    // every other Stage-B measurement. The probe attaches no collector — it
    // exists only to learn the boundary — so that version returns null, the
    // call site sends no boundaryId at all, and the server silently falls back
    // to excluding a fixed tail count. Nothing else in the suite notices: the
    // committing pass DOES pass a collector, so the breakdown, the goldens and
    // the parity test above all stay green.
    const { prepared } = prepareSolo('at-depth-overflow');
    const bare = finishConversationContext(prepared, undefined, { commit: false });
    expect(bare.boundaryId).toBe('o1');
  });

  it('names a real chat turn even when the kept history starts with an injection', () => {
    // KILLS: `keptHistory[0].id`. On `trim-overbudget` the head of kept
    // history is a PINNED critical world-info entry — an object with no
    // message id — so that implementation hands the server null and, per
    // client.ts, the boundaryId is then omitted from the request entirely.
    const { prepared } = prepareSolo('trim-overbudget');
    expect(finishConversationContext(prepared, undefined, { commit: false }).boundaryId).toBe(
      'big'
    );
  });
});

// ---------------------------------------------------------------------------
// Solo: the direction invariant
// ---------------------------------------------------------------------------

describe('the two-pass direction invariant', () => {
  /** Where a boundary sits in the fixture's own message list. */
  const indexOf = (input: SoloInput, id: string | null) =>
    input.messages.findIndex((m) => m.id === id);

  it('moves the boundary NEWER when recall is added, never older', () => {
    // Why one round trip is enough. Recall lands in the Stage-A system block,
    // which the trim charges as fixed overhead BEFORE it keeps any history, so
    // pass 2 keeps a subset of pass 1's turns and its boundary can only be the
    // same message or a newer one. The residual error is under-recall (a thin
    // band of turns pass 2 dropped that we told the server to treat as still
    // present); duplication — recalling something the prompt also carries — is
    // unreachable.
    //
    // KILLS, in the strict half: any `finish` that assembles Stage A before
    // folding `ragContext` in, or that measures the trim against a system
    // block missing the recall section — the boundary would not move at all
    // and this reads as an equality. That is precisely the shape of the bug
    // the deleted re-simulation had (it passed `[]` for systemPrompts).
    // KILLS, in the >= half: any future change that makes recall SHRINK the
    // charged system block, which would silently reopen the duplication case.
    const { prepared, input } = prepareSolo('trim-bites');
    const withoutRecall = finishConversationContext(prepared, undefined, { commit: false });
    const withRecall = finishConversationContext(
      prepared,
      `Earlier in chat: ${'ledger '.repeat(200).trim()}`,
      { commit: false }
    );

    const before = indexOf(input, withoutRecall.boundaryId);
    const after = indexOf(input, withRecall.boundaryId);
    expect(before, 'pass 1 produced no boundary on a fixture the trim bites').toBeGreaterThan(-1);
    expect(after, 'pass 2 produced no boundary').toBeGreaterThan(-1);
    expect(after, 'pass 2 moved the boundary OLDER — recall could duplicate raw history').toBeGreaterThanOrEqual(before);
    expect(after, 'recall did not shrink the kept history at all on a fixture the trim bites').toBeGreaterThan(before);
  });

  it('holds with a recall block large enough to swallow the whole budget', () => {
    // The degenerate end of the same invariant: even when recall crowds out
    // nearly all of history, the boundary stays inside the chat and stays
    // newer. KILLS: a trim that goes negative and returns an empty kept set
    // without force-including the newest turn — the boundary would be null and
    // the request would carry none.
    const { prepared, input } = prepareSolo('trim-bites');
    const withoutRecall = finishConversationContext(prepared, undefined, { commit: false });
    const huge = finishConversationContext(prepared, 'ledger '.repeat(3000).trim(), {
      commit: false,
    });
    expect(huge.boundaryId).not.toBeNull();
    expect(indexOf(input, huge.boundaryId)).toBeGreaterThanOrEqual(
      indexOf(input, withoutRecall.boundaryId)
    );
  });
});

// ---------------------------------------------------------------------------
// The server's degradation reason
// ---------------------------------------------------------------------------

describe('resolveRagContext — the server degradation reason', () => {
  const CHAT = 'solo-chat.jsonl';
  const messages = [
    {
      id: 'u1',
      name: 'User',
      isUser: true,
      isSystem: false,
      hidden: false,
      content: 'where did the thurible go?',
      timestamp: 0,
      swipes: ['where did the thurible go?'],
      swipeId: 0,
    } as ChatMessage,
  ];
  const CHUNK = { ggbcId: 'old1', text: 'It went with the ledger.', isUser: false, score: 0.9 };

  beforeEach(() => {
    vi.restoreAllMocks();
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({ groupChats: [] });
    useCharacterStore.setState({
      selectedCharacter: { name: 'Ivy', avatar: 'ivy.png' } as never,
    });
    // The once-per-session toast latch is module state, not a mock —
    // `vi.restoreAllMocks()` above does not touch it. Without this reset,
    // whichever `no_key` test runs first would "use up" the toast and every
    // later test in this file would see it silent.
    _resetNoKeyHintForTests();
    // `showToastGlobal` is a plain `vi.fn()` from the top-of-file
    // `vi.mock('../components/ui/Toast', ...)` factory, not a `vi.spyOn` —
    // `restoreAllMocks()` above has no original implementation to restore it
    // to, so its call history survives across tests unless cleared here.
    vi.mocked(showToastGlobal).mockClear();
  });

  it('forwards the caller\'s boundary verbatim', () => {
    // KILLS: a signature change that quietly kept deriving a boundary
    // internally and ignored the argument — which is what the whole task
    // deleted. The argument is the only source now.
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    return resolveRagContext(messages, CHAT, 'b17').then(() => {
      expect(spy.mock.calls[0][4]).toBe('b17');
    });
  });

  it('warns, naming the degraded window, on boundary_not_found', async () => {
    // The backend half of this task (ggbc-backend#81). The id we sent named no
    // live message, so the server excluded a fixed COUNT of newest messages
    // instead of our raw tail — recall on that window can return turns the
    // prompt already carries. KILLS: dropping `dto.reason` on the floor, which
    // is what the client did before this change and is invisible otherwise
    // (the response is a 200 with chunks either way).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({
      chunks: [CHUNK],
      reason: 'boundary_not_found',
    });
    const out = await resolveRagContext(messages, CHAT, 'b17');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line, 'the warning does not say which boundary was lost').toContain('b17');
    expect(line.toLowerCase()).toContain('guessed');
    // Degraded is not disabled: the chunks still reach the prompt.
    expect(out).toContain('It went with the ledger.');
  });

  it('says nothing on the REAL ordinary-success wire shape, reason: null', async () => {
    // THE DEPLOYED SHAPE. `RetrievalMessagesOut.reason` is `str | None = None`
    // and the route serializes it with no `exclude_none`, so an ordinary 200
    // carries `"reason": null` — ggbc-backend's own tests assert that literal
    // body. This fixture used to be `{ chunks: [CHUNK] }`, i.e. `undefined`,
    // a shape no server has ever sent: it left the healthy production path
    // entirely untested while reading as though it covered it.
    //
    // KILLS: the natural TS narrowing `if (dto.reason !== undefined)`, which
    // the old `reason?: string` type actively invited and the compiler
    // accepted as exhaustive — every successful recall would have been
    // classified as degraded, and nothing would have failed. Also kills
    // warning on every call, or on an empty-chunks response.
    //
    // AND THE SEMANTICS: a null reason means ONLY "the id resolved to a
    // live message". It is NOT a statement that the window is correct — the
    // server cannot check that. Nothing here, and nothing at the read site,
    // may treat a null reason as validation.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({
      chunks: [CHUNK],
      reason: null,
    });
    const out = await resolveRagContext(messages, CHAT, 'b17');
    expect(warn).not.toHaveBeenCalled();
    // Degradation-free is not recall-free: the chunks still reach the prompt.
    expect(out).toContain('It went with the ledger.');
  });

  it('says nothing when the field is absent entirely', async () => {
    // The other half of the shared `case null: case undefined:` arm. No
    // deployed backend emits this — it is the stripping-proxy / pre-#81
    // shape the optional DTO field still permits — so it is kept as the
    // secondary case rather than the one that claims to cover production.
    // KILLS: deleting `case undefined` on the grounds that null is the real
    // wire, which would send an absent field to `default:`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [CHUNK] });
    await resolveRagContext(messages, CHAT, 'b17');
    expect(warn).not.toHaveBeenCalled();
  });

  it('hints at the embedding-key setting on no_key, once per session', async () => {
    // E9-S7 (#455): recall-without-a-key used to be indistinguishable from
    // recall-that-found-nothing. This is the row that used to pin `no_key`
    // as silent (it fell through to the unknown-reason `default:` arm before
    // this task gave it its own case) — it now asserts the opposite.
    //
    // KILLS (a): removing the `showToastGlobal` call from the `no_key` arm —
    // the toast assertion on the first turn goes from 1 call to 0.
    // KILLS (b): removing the once-per-session guard — the SECOND no_key
    // turn below would toast again instead of staying at 1 total call.
    // KILLS (c): a `no_key` arm that returns early instead of falling out of
    // the switch into the normal chunk-reading code below it — the server
    // returns `chunks: []` alongside `no_key` in production, but this test's
    // mock deliberately returns a non-empty CHUNK to prove the client reads
    // whatever chunks come back rather than assuming the reason implies
    // emptiness; an early return would drop it and `out` would be null.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({
      chunks: [CHUNK],
      reason: 'no_key',
    });

    const first = await resolveRagContext(messages, CHAT, 'b17');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(showToastGlobal).toHaveBeenCalledWith(
      expect.stringContaining('embedding'),
      'warning'
    );
    expect(first).toContain('It went with the ledger.');

    // A second no_key turn in the same session: console.warn is per-turn
    // (matching the boundary_not_found arm's style) so it fires again, but
    // the toast is a one-time session hint and must not.
    const second = await resolveRagContext(messages, CHAT, 'b17');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(second).toContain('It went with the ledger.');
  });

  it('is silent and non-fatal on a reason this build does not know', async () => {
    // The unknown-reason case must stay exactly as it was before E9-S7 gave
    // `no_key` its own arm: forward compatibility with a newer server that
    // sends a reason this build has never heard of. KILLS: an if/else that
    // treats "not undefined" as "boundary_not_found" (every future code
    // would warn about a lost boundary), any `throw` / early return on an
    // unknown value (would drop recall the server actually returned), and a
    // `default:` arm that starts toasting — only `no_key` gets the hint.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({
      chunks: [CHUNK],
      reason: 'something_invented_next_year',
    });
    await expect(resolveRagContext(messages, CHAT, 'b17')).resolves.toContain(
      'It went with the ledger.'
    );
    expect(warn).not.toHaveBeenCalled();
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group: one window, two callers
// ---------------------------------------------------------------------------

describe('the group history window has exactly one definition', () => {
  beforeEach(() => {
    groupWindowSpy.mockClear();
  });

  it('is the same function object for the builder and the recall path', () => {
    // THE point of extracting it. KILLS: leaving the expression inline in the
    // builder and writing a second, equal-looking copy for the recall path —
    // which is the state this task found (`chatStore.ts`'s `recentMessages`
    // and the deleted `ragBoundary.ts`'s `GROUP_WINDOW`, whose in-code anchor
    // had already drifted 270 lines from the real one). Two copies pass every
    // behavioural test on the day they are written; this one fails the moment
    // either caller stops going through the shared function.
    const fx = GROUP_FIXTURES.find((f) => f.name === 'window-slice-before-filter')!;
    resetStores();
    const input = fx.setup();

    buildGroupConversationContext(
      input.messages,
      input.characters,
      input.currentCharacter,
      input.scenarioOverride,
      input.ragContext,
      input.cardMode,
      mkWiOut(input.messages),
      input.attachmentsFolded
    );
    const afterBuilder = groupWindowSpy.mock.calls.length;
    expect(afterBuilder, 'the group builder no longer goes through groupHistoryWindow').toBe(1);

    groupRecallBoundary(input.messages);
    expect(
      groupWindowSpy.mock.calls.length,
      'the group recall path no longer goes through groupHistoryWindow'
    ).toBe(afterBuilder + 1);
  });

  it('gives the recall path the oldest turn the builder actually emits', () => {
    // The behavioural half, end to end: whatever the window is, the boundary
    // is its head and the prompt carries that turn but not the one before it.
    // KILLS: an off-by-one (`window[1]`, or the newest instead of the oldest),
    // which the import-identity check above cannot see.
    const fx = GROUP_FIXTURES.find((f) => f.name === 'window-slice-before-filter')!;
    resetStores();
    const input = fx.setup();

    const window = groupHistoryWindow(input.messages);
    expect(groupRecallBoundary(input.messages)).toBe(window[0].id);

    const context = buildGroupConversationContext(
      input.messages,
      input.characters,
      input.currentCharacter,
      input.scenarioOverride,
      input.ragContext,
      input.cardMode,
      mkWiOut(input.messages),
      input.attachmentsFolded
    );
    const emitted = context.map((e) => e.content).join('\n');
    const boundaryMsg = input.messages.find((m) => m.id === window[0].id)!;
    const justOlder = input.messages[input.messages.indexOf(boundaryMsg) - 1];
    expect(emitted).toContain(boundaryMsg.content);
    expect(emitted, 'the prompt carries a turn older than the boundary we send').not.toContain(
      justOlder.content
    );
  });

  it('reports no boundary for a chat with nothing to emit', () => {
    // KILLS: `groupHistoryWindow(messages)[0].id` without the length guard —
    // a TypeError on an empty or all-system chat, thrown from inside a turn.
    expect(groupRecallBoundary([])).toBeNull();
  });
});
