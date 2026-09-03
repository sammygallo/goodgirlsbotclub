/**
 * The FIVE `tagLastBreakdownMessage` call sites (E2-S2 task 4, review round 1
 * fix for M4/F8).
 *
 * WHAT THIS FILE EXISTS FOR. `generationStore.breakdownTag.test.ts` proves the
 * store ACTION works in isolation (object-identity guard, resets); it never
 * exercises a call site. Review round 1 deleted all five one-line
 * `tagLastBreakdownMessage(...)` calls in chatStore.ts (generateGroupTurn,
 * swipeRight, continueMessage, sendMessage, editMessageAndRegenerate) in a
 * throwaway worktree and the full suite stayed green — 98 files / 1901 tests.
 * `PromptBreakdownSheet` silently renders "no longer available" for every
 * fresh generation on the affected path, with CI green.
 *
 * Reuses `chatStore.callSites.test.ts`'s prelude (mocks, in-memory
 * localStorage, SSE-stub helper) rather than extending that file directly —
 * this file's claims are tag-shaped, not boundary/commit-shaped, and a
 * shared table would make an unrelated mutation redden rows here that prove
 * nothing about the tag.
 *
 * M3's swipe-identity fix (same review round) is folded in here rather than
 * getting its own file: the tag now carries a swipe index as well as a
 * message id, and getting THAT right is exactly what each of these five call
 * sites has to do — swipeRight tags the NEW swipe it is about to create,
 * continueMessage tags the CURRENT swipe it extends in place, and the other
 * three always tag swipe 0 (a freshly created message).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same prelude as chatStore.callSites.test.ts / promptGoldens.test.ts —
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

// A real generation round reaches `recordTurnUsage` -> the usage store's
// persist middleware, which writes localStorage UNGUARDED. This runtime's
// global is an inert `{}`, so `setItem` would throw straight into the
// action's catch and end the turn early. Same in-memory Storage the other
// chatStore suites install.
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

const { useChatStore } = await import('./chatStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useCharacterStore } = await import('./characterStore');
const { useGenerationStore } = await import('./generationStore');
const { api } = await import('../api/client');
const { GROUP_FIXTURES, mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');

import type { CharacterInfo } from '../api/client';
import type { ChatMessage, GroupChatInfo } from './chatStore';

// ---------------------------------------------------------------------------
// Stubs at the network edge — same shape as chatStore.callSites.test.ts
// ---------------------------------------------------------------------------

/** One SSE content frame, as the generation proxy emits them. */
function sseOnce(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
        )
      );
      controller.close();
    },
  });
}

function stubEdges() {
  const recall = vi
    .spyOn(api, 'getRetrievalMessages')
    .mockResolvedValue({ chunks: [], reason: null });
  const generate = vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('A reply.'));
  const save = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
  return { recall, generate, save };
}

/** The tag as the sheet would read it. */
function tag() {
  return useGenerationStore.getState().lastPromptBreakdownTag;
}

// ---------------------------------------------------------------------------
// Solo arrangement
// ---------------------------------------------------------------------------

const IVY = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  description: 'A quiet archivist who never throws anything away.',
});

/**
 * `aiMessageOverride` lets a row put the AI message at a NONZERO swipe —
 * every field this function's default sets (`mkMsg`'s `swipeId: 0`,
 * `swipes: [content]`) is otherwise the fixture continueMessage's coverage
 * gap depends on (review round 2, R2-A/F1/F5/F6/F8): without it, every row
 * in this file exercises a swipe-0 message, which cannot distinguish
 * "read the live swipeId" from "hardcode 0".
 */
function arrangeSolo(aiMessageOverride: Partial<ChatMessage> = {}): ChatMessage[] {
  resetStores();
  const messages = [
    mkMsg('u1', 'Hello?'),
    mkMsg('a1', 'Hi there.', { isUser: false, name: 'Ivy', ...aiMessageOverride }),
  ];
  useCharacterStore.setState({ selectedCharacter: IVY });
  useChatHistoryRagStore.setState({ enabled: false });
  useChatStore.setState({
    messages,
    currentChatFile: 'breakdown-tag-solo.jsonl',
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
  return messages;
}

describe('tagLastBreakdownMessage is wired at every solo generation call site', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
  });

  it('sendMessage tags the newly appended AI message at swipe 0', async () => {
    // KILLS: deleting the tagLastBreakdownMessage call at sendMessage's site
    // (chatStore.ts, inside the `if (stream)` branch right after the AI
    // message is appended).
    arrangeSolo();
    stubEdges();

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    const messages = useChatStore.getState().messages;
    const aiMsg = messages[messages.length - 1];
    expect(aiMsg.isUser, 'the last message should be the AI reply').toBe(false);
    expect(tag()).toEqual({ messageId: aiMsg.id, swipeIndex: 0 });
  });

  it('swipeRight tags the message being re-swiped, at the NEW swipe index it is about to create', async () => {
    // KILLS: deleting the tag call in swipeRight's generate-new-swipe branch.
    // ALSO kills a fix that tags the message's swipe id AS IT WAS AT CALL
    // TIME rather than the swipe the generation lands in — `msg.swipes` has
    // length 1 before this runs, so the new swipe is index 1, not 0.
    const messages = arrangeSolo();
    stubEdges();
    const lastAi = messages[messages.length - 1];
    expect(lastAi.swipes, 'sanity: exactly one swipe before this generation').toHaveLength(1);

    await useChatStore.getState().swipeRight(lastAi.id, IVY);

    expect(tag()).toEqual({ messageId: lastAi.id, swipeIndex: 1 });
  });

  it('continueMessage tags the last AI message at its CURRENT (unchanged) swipe index', async () => {
    // KILLS: deleting the tag call in continueMessage. Unlike swipeRight,
    // continue EXTENDS the swipe already on screen rather than creating a new
    // one, so the correct index is the message's existing `swipeId`.
    //
    // This row alone does NOT kill a fix that always tags swipe 0
    // (copy-pasted from a sibling call site) — the fixture's swipeId is 0
    // here, so `swipeIndex: lastAi.swipeId` degenerates to `swipeIndex: 0`
    // and cannot distinguish "read the live swipeId" from "hardcode 0". The
    // NEXT row below (review round 2, R2-A/F1/F5/F6/F8) is what actually
    // kills that mutant — round 1 claimed that coverage existed here and it
    // did not; this comment used to point at a "regenerate-after-continue"
    // row that was never written.
    const messages = arrangeSolo();
    stubEdges();
    const lastAi = messages[messages.length - 1];

    await useChatStore.getState().continueMessage(IVY);

    expect(tag()).toEqual({ messageId: lastAi.id, swipeIndex: lastAi.swipeId });
  });

  it('continueMessage tags the CURRENT swipe index even when it is NOT 0 — the one live-expression coordinate among the five call sites (review round 2, R2-A/F1/F5/F6/F8)', async () => {
    // KILLS: `tagLastBreakdownMessage(breakdown, lastAiMsg.id, lastAiMsg.swipeId)`
    // copy-pasted to a literal `0`. Every other row in this file (and the row
    // just above) exercises a swipe-0 fixture, so this is the ONE row that
    // can tell "the tag reads the live swipeId" apart from "the tag is
    // always 0" — of the five call sites, continueMessage is the only one
    // whose swipe argument is a live expression rather than a literal `0` or
    // a length-derived constant.
    const messages = arrangeSolo({
      content: 'Hello again.',
      swipes: ['Hi there.', 'Hello again.'],
      swipeId: 1,
    });
    stubEdges();
    const lastAi = messages[messages.length - 1];
    expect(lastAi.swipeId, 'sanity: the fixture is at a NONZERO swipe').toBe(1);

    await useChatStore.getState().continueMessage(IVY);

    expect(tag()).toEqual({ messageId: lastAi.id, swipeIndex: 1 });
    // Read/write coordinate parity: continueMessage extends the swipe in
    // place and never changes swipeId, so the tag's swipe index must still
    // equal the message's CURRENT swipe id after the call — the same
    // coordinate ChatMessage reads to build the sheet's swipeIndex prop.
    const after = useChatStore.getState().messages.find((m) => m.id === lastAi.id)!;
    expect(after.swipeId).toBe(1);
  });

  it('editMessageAndRegenerate tags the newly appended AI message at swipe 0', async () => {
    // KILLS: deleting the tag call in editMessageAndRegenerate's `if (stream)`
    // branch.
    const messages = arrangeSolo();
    stubEdges();
    const userMsg = messages[0];

    await useChatStore.getState().editMessageAndRegenerate(userMsg.id, 'Anyone home?', IVY);

    const after = useChatStore.getState().messages;
    const aiMsg = after[after.length - 1];
    expect(aiMsg.isUser, 'the last message should be the regenerated AI reply').toBe(false);
    expect(tag()).toEqual({ messageId: aiMsg.id, swipeIndex: 0 });
  });
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

function mkGroupChat(characters: CharacterInfo[]): GroupChatInfo {
  return {
    fileName: 'breakdown-tag-group.jsonl',
    characterNames: characters.map((c) => c.name),
    characterAvatars: characters.map((c) => c.avatar),
    identityAvatar: characters[0].avatar,
    lastMessage: '',
    createdAt: 0,
    activationStrategy: 'manual',
    mutedAvatars: [],
    pooledExcludeRecent: 0,
    autoModeEnabled: false,
    autoModeDelayMs: 0,
    scenarioOverride: '',
    talkativenessOverrides: {},
    cardMode: 'swap',
  };
}

describe('tagLastBreakdownMessage is wired at the group generation call site', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
  });

  it('generateGroupTurn (forceGroupMemberTalk) tags the SECOND speaker\'s message after two sequential turns, not the first', async () => {
    // KILLS: deleting the tag call in generateGroupTurn. Two sequential
    // speakers is the case the store action's own identity guard exists
    // for (each publish overwrites the slot before the next speaker's tag
    // call lands) — a call site that only worked for a SINGLE speaker per
    // round would still pass a one-speaker version of this test, so this row
    // is deliberately two speakers deep.
    resetStores();
    const fx = GROUP_FIXTURES.find((f) => f.name === 'swap')!;
    const input = fx.setup();
    useChatHistoryRagStore.setState({ enabled: false });
    useChatStore.setState({
      messages: input.messages,
      currentChatFile: 'breakdown-tag-group.jsonl',
      groupChats: [mkGroupChat(input.characters)],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    const edges = stubEdges();

    edges.generate.mockResolvedValueOnce(sseOnce('First speaker reply.'));
    await useChatStore.getState().forceGroupMemberTalk(input.characters[0], input.characters);
    const afterFirst = useChatStore.getState().messages;
    const firstReply = afterFirst[afterFirst.length - 1];
    expect(tag()).toEqual({ messageId: firstReply.id, swipeIndex: 0 });

    useChatStore.setState({ isSending: false, isStreaming: false, error: null, abortController: null });
    edges.generate.mockResolvedValueOnce(sseOnce('Second speaker reply.'));
    await useChatStore.getState().forceGroupMemberTalk(input.characters[1], input.characters);
    const afterSecond = useChatStore.getState().messages;
    const secondReply = afterSecond[afterSecond.length - 1];

    expect(secondReply.id, 'the two turns produced the same message — the fixture is not exercising two speakers').not.toBe(
      firstReply.id
    );
    expect(tag(), 'the tag still names the FIRST speaker\'s message after the SECOND speaker generated').toEqual({
      messageId: secondReply.id,
      swipeIndex: 0,
    });
  });
});
