/**
 * The SIX generation call sites (E2-S2 task 1b, review round 3).
 *
 * WHAT THIS FILE EXISTS FOR. `chatStore.ragBoundary.test.ts` covers the two
 * ENDS of the boundary wire — `finishConversationContext` returns the right
 * `boundaryId`, `resolveRagContext` forwards its argument verbatim,
 * `groupRecallBoundary` reads the shared window — by calling each of them
 * directly. Nothing connected them. The review proved the consequence with
 * four mutations that each left the whole suite green:
 *
 *   M6  `probe.boundaryId` -> `null` at all five solo sites
 *   M7  `groupRecallBoundary(updatedMessages)` -> `null` at the group site
 *   M8  the five committing passes flipped to `{ commit: false }`
 *   M9  the five probes run WITH a recall block instead of `undefined`
 *
 * Three more, found while writing this file and green until it landed:
 *
 *   the PROBE flipped to `{ commit: true }` — every turn's macro writes,
 *     token estimate and WI fired state persisted twice
 *   `prepare` called twice — the side-effecting half re-run per turn
 *   the recall QUERY taken from the wrong array — `resolveRagContext` derives
 *     it as the newest visible user turn of whatever it is handed, and the
 *     five sites hand it three DIFFERENT locals (`contextMessages`,
 *     `messages`, `updatedMessages`), so a `messages`/`updatedMessages` slip
 *     retrieves against the PREVIOUS turn's question forever, with a correct
 *     boundary and a well-formed 200 to hide it
 *
 * i.e. the entire deliverable of task 1b could be absent from the build the
 * suite certifies. Every test below therefore drives a REAL store action —
 * `swipeRight`, `continueMessage`, `impersonate`, `sendMessage`,
 * `editMessageAndRegenerate`, `forceGroupMemberTalk` — with `api` stubbed at
 * the network edge only, and asserts on what the call site actually sent.
 *
 * EVERY SOLO CLAIM IS PER-SITE. Round 3 found the file's coverage was
 * swipeRight-shaped while its claims were five-site-shaped: the boundary rows
 * were parameterised over `SOLO_SITES` but the commit and purity rows drove
 * swipeRight alone, so M8 and the probe flip were pinned at ONE of the five.
 * Measured then: flipping sendMessage's committing pass by itself left the
 * whole suite green at 1847/1847. Both describes below are therefore driven
 * from the same table as the boundary rows — if a claim in this header says
 * "five sites", the loop that backs it iterates five sites.
 *
 * `regenerateMessage` is deliberately absent: it is `await
 * get().swipeRight(lastAiMsg.id, ...)` and shares swipeRight's call site, so a
 * sixth copy here would pin nothing the swipeRight rows do not already pin.
 *
 * WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE. The strong form is not
 * "the id equals what I recomputed" (a test can recompute a value the same
 * wrong way); it is "the id DELIMITS THE PROMPT THAT WAS SENT" — the turn it
 * names is in the prompt and the turn just older than it is not. That holds
 * exactly when recall is empty, so the boundary rows stub the recall response
 * with no chunks: pass 2 then has the same budget as the probe and keeps the
 * same turns. It kills all three mutation families at once:
 *   - a nulled boundary fails the non-null assertion;
 *   - a probe run WITH recall (M9) reports a NEWER boundary than the prompt's
 *     real head, so the turn just older than it IS in the prompt — which is
 *     the duplication direction the swipeRight comment calls "unreachable by
 *     construction" while nothing but a literal `undefined` enforces it.
 *
 * NO LINE NUMBERS. The rows used to name their call site as `chatStore.ts:NNNN`
 * and all six were stale in the commit that wrote them — computed against a
 * pre-round checkout, off by exactly the +10 the round's own first commit
 * added above them, so `sendMessage — chatStore.ts:5193` pointed at a
 * `tryServerRetrieval` statement. In a 5,700-line file with five near-identical
 * three-line blocks a wrong anchor is worse than none. Rows are named by their
 * store action, and the location hint is a `construct` fingerprint checked
 * against the source — the convention `PINS_ANCHORS` established, which cannot
 * rot silently because a test resolves it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// Raw-source import (the house `?raw` pattern — tsconfig.app types only
// vite/client, so node:fs is unavailable in src and would break the
// Dockerfile's `tsc -b`, which — unlike PR CI — typechecks test files).
// Read only by the `construct` guard at the bottom of this file.
import chatStoreRaw from './chatStore.ts?raw';

// Same prelude as promptGoldens.test.ts / chatStore.ragBoundary.test.ts —
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
// global is an inert `{}` (node's Web Storage needs --localstorage-file), so
// `setItem` would throw straight into the action's catch and end the turn
// early. Same in-memory Storage the other chatStore suites install.
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
  DEFAULT_GROUP_CARD_MODE,
  finishConversationContext,
  getWiFiredForChat,
  prepareConversationContext,
  useChatStore,
} = await import('./chatStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useCharacterStore } = await import('./characterStore');
const { useGenerationStore, DEFAULT_CONTEXT_CONFIG } = await import('./generationStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { api } = await import('../api/client');
const { groupHistoryWindow } = await import('../utils/groupHistoryWindow');
const {
  GROUP_FIXTURES,
  NOT_WRITTEN,
  mkBook,
  mkChar,
  mkEntry,
  mkMsg,
  productionCurrentTurn,
  resetStores,
} = await import('./promptGoldens.fixtures');

const { extensionRegistry } = await import('../extensions/registry');

import type { LucideIcon } from 'lucide-react';
import type { CharacterInfo } from '../api/client';
import type { ChatMessage, GroupChatInfo } from './chatStore';

// ---------------------------------------------------------------------------
// Counting the side-effecting half
// ---------------------------------------------------------------------------

/**
 * `prepareConversationContext` calls `extensionRegistry.runContextHooks`
 * exactly once (chatStore.ts:1356 is its only call site in the file), so a
 * registered extension that counts invocations counts `prepare` runs.
 *
 * WHY THIS IS NEEDED AT ALL. The design comment above every solo call site
 * says "`prepare` runs ONCE — it is the side-effecting half (macro writes,
 * world-info activation) and running it twice would double-execute every
 * `{{setvar}}`", and nothing enforced it. A chat-variable canary CANNOT:
 * `prepare` re-clones the chat's variables off the store on every call
 * (chatStore.ts:1216-1218) and only a committing `finish` writes them back, so
 * a second `prepare` whose predecessor was discarded starts from the same map
 * and lands on the same value. Verified: duplicating the `prepare` call at
 * swipeRight left the whole suite green with the canary reading '1'. Counting
 * the hook is what actually sees it — and running a user extension's
 * `onBuildContext` twice per turn is its own defect.
 *
 * Contributes nothing, so no prompt moves.
 */
let prepareCalls = 0;
extensionRegistry.register({
  id: '__call_sites_prepare_counter__',
  displayName: 'Call-site prepare counter',
  description: 'Test-only: counts prepareConversationContext runs.',
  version: '0.0.0',
  icon: null as unknown as LucideIcon,
  defaultEnabled: true,
  onBuildContext: () => {
    prepareCalls += 1;
    return [];
  },
});

// ---------------------------------------------------------------------------
// Stubs at the network edge
// ---------------------------------------------------------------------------

/** One SSE content frame, as the generation proxy emits them. Needed wherever
 *  a test has to reach code AFTER `if (!stream) return` — `captureWiFired`,
 *  `recordTurnUsage`, `saveWiTimers` all sit past that gate. */
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

/**
 * Stub only what leaves the process. Everything between the store action and
 * these three is the production code under test — the builder, the two-pass
 * probe, the trim, the macro pass, the WI scan.
 *
 * `getRetrievalMessages` defaults to the REAL ordinary-success wire shape
 * (`reason: null`, not an absent field — see client.ts's DTO note) with no
 * chunks, so `resolveRagContext` returns null and the committing pass builds
 * against the same budget the probe measured.
 */
function stubEdges(over: { stream?: ReadableStream<Uint8Array> | null } = {}) {
  const recall = vi
    .spyOn(api, 'getRetrievalMessages')
    .mockResolvedValue({ chunks: [], reason: null });
  const generate = vi
    .spyOn(api, 'generateMessage')
    .mockResolvedValue(over.stream ?? null);
  const save = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
  return { recall, generate, save };
}

type Edges = ReturnType<typeof stubEdges>;

/** The boundary argument the call site handed `api.getRetrievalMessages`. */
function boundarySent(edges: Edges): string | null {
  expect(
    edges.recall,
    'the call site never asked the server for recall at all'
  ).toHaveBeenCalledTimes(1);
  return edges.recall.mock.calls[0][4] as string | null;
}

/**
 * THE OTHER call-site argument: `resolveRagContext(messages, chatFile,
 * boundaryId)` derives the retrieval QUERY from the array it is handed —
 * `[...messages.filter(m => !m.hidden)].reverse().find(m => m.isUser &&
 * !m.isSystem)` (chatStore.ts, inside `resolveRagContext`) — and the five solo
 * sites hand it three different locals. Nothing pinned which one, so
 * `resolveRagContext(updatedMessages.slice(0, -1), ...)` at sendMessage left
 * the whole suite green while every send retrieved against the question the
 * user asked one turn AGO: the boundary comes from the probe, which is built
 * on the untouched array, so every other assertion here is satisfied and the
 * server answers a well-formed 200 with `reason: null`.
 *
 * `history` is the array that site hands the builder, so the expected query is
 * read off the same list the row already reports.
 */
function expectRecallQueryIsLatestUserTurn(history: ChatMessage[], edges: Edges): void {
  const expected = [...history.filter((m) => !m.hidden)]
    .reverse()
    .find((m) => m.isUser && !m.isSystem);
  expect(expected, 'this fixture has no visible user turn — the row proves nothing').toBeDefined();
  expect(edges.recall, 'the call site never asked the server for recall at all').toHaveBeenCalledTimes(
    1
  );
  expect(
    edges.recall.mock.calls[0][2],
    'the call site retrieved against a DIFFERENT turn than the newest one in the build it shipped — recall is answering a stale question'
  ).toBe(expected!.content);
}

/** The prompt the call site handed `api.generateMessage`, flattened. */
function promptSent(edges: Edges): string {
  expect(edges.generate, 'the call site never dispatched a generation').toHaveBeenCalledTimes(1);
  return (edges.generate.mock.calls[0][0] as { content: string }[])
    .map((c) => c.content)
    .join('\n');
}

/**
 * THE call-site contract: the id sent names the oldest chat turn the prompt
 * that shipped actually carries.
 *
 * `history` is the message list the call site handed the builder, so the
 * "turn just older" is read off the same array the trim walked.
 */
function expectBoundaryDelimitsPrompt(history: ChatMessage[], edges: Edges): void {
  const sent = boundarySent(edges);
  expect(sent, 'the call site sent NO boundary — the server falls back to a fixed tail count').not.toBeNull();

  const idx = history.findIndex((m) => m.id === sent);
  expect(idx, `the boundary sent (${String(sent)}) names no message in this chat`).toBeGreaterThan(
    -1
  );
  expect(
    idx,
    'the trim did not bite on this fixture — the boundary is the first message, so this row proves nothing'
  ).toBeGreaterThan(0);

  const prompt = promptSent(edges);
  expect(prompt, 'the prompt does not carry the turn the boundary names').toContain(
    history[idx].content
  );
  expect(
    prompt,
    'the prompt carries a turn OLDER than the boundary sent — recall was told that turn is still present and can hand it back, duplicating raw history'
  ).not.toContain(history[idx - 1].content);
}

// ---------------------------------------------------------------------------
// Solo arrangement
// ---------------------------------------------------------------------------

const SOLO_CHAT = 'call-sites-solo.jsonl';

const IVY = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  description: 'A quiet archivist who never throws anything away.',
});

/**
 * A solo chat the token-aware trim provably bites WITHOUT any recall.
 *
 * Deliberately local rather than a `SOLO_FIXTURES` entry: the shared fixtures
 * drive the goldens, so adding one would mint golden files, and `trim-bites`
 * (the closest existing fixture) only demonstrably drops turns once a recall
 * block is added — which is the one condition under which the boundary sent
 * and the prompt's head are allowed to differ. These rows need the trim to bite
 * with recall EMPTY so the two must be equal.
 */
function longSoloChat(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    const isUser = i % 2 === 0;
    out.push(
      mkMsg(`t${i}`, `Turn ${i}. ${'ledger '.repeat(30).trim()}`, {
        isUser,
        name: isUser ? 'User' : 'Ivy',
      })
    );
  }
  return out;
}

/** Reset every store, then install the long-chat solo scenario. */
function arrangeSolo(): ChatMessage[] {
  resetStores();
  useGenerationStore.setState({
    context: { ...DEFAULT_CONTEXT_CONFIG, maxTokens: 1200, responseReserve: 256, tokenAware: true },
  });
  prepareCalls = 0;
  const messages = longSoloChat();
  useCharacterStore.setState({ selectedCharacter: IVY });
  useChatHistoryRagStore.setState({ enabled: true });
  useChatStore.setState({
    messages,
    currentChatFile: SOLO_CHAT,
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
  return messages;
}

/**
 * One row per solo call site. `history` is the message array THAT site hands
 * the builder — swipeRight excludes the message being re-swiped, sendMessage
 * appends the user's new turn — so each row reports its own.
 *
 * `character` is a parameter rather than a closed-over `IVY` because every
 * describe below drives the SAME five rows against a different arrangement:
 * the boundary rows need a chat long enough for the trim to bite, the commit
 * rows need the macro/lore canary card.
 */
interface SoloSite {
  name: string;
  /**
   * A verbatim, unique slice of chatStore.ts inside the action this row
   * drives, so a reader can map row -> call site. Checked by the guard at the
   * bottom of the file; see it, and the header's NO LINE NUMBERS note, for why
   * this is a source fingerprint rather than a `:NNNN`.
   *
   * Deliberately a NEIGHBOUR of the two-pass block rather than the block
   * itself: naming `{ commit: true }` or `probe.boundaryId` here would make
   * the guard a second, source-level detector for mutations the behavioural
   * rows already own, and every such mutation would then redden two rows
   * instead of the one that actually reports the defect.
   */
  construct: string;
  run: (
    messages: ChatMessage[],
    character: CharacterInfo
  ) => Promise<{ history: ChatMessage[] }>;
}

const SOLO_SITES: SoloSite[] = [
  {
    name: 'swipeRight',
    // The canonical two-pass site; regenerateMessage delegates here.
    construct: 'const contextMessages = messages.slice(0, msgIndex);',
    run: async (messages, character) => {
      const lastAi = [...messages].reverse().find((m) => !m.isUser && !m.isSystem)!;
      await useChatStore.getState().swipeRight(lastAi.id, character);
      // swipeRight builds from everything BEFORE the message being re-swiped.
      return { history: messages.slice(0, messages.indexOf(lastAi)) };
    },
  },
  {
    name: 'continueMessage',
    construct: "recordCallSiteTurn(breakdown, 'continue', context[context.length - 1].content);",
    run: async (messages, character) => {
      await useChatStore.getState().continueMessage(character);
      return { history: messages };
    },
  },
  {
    name: 'impersonate',
    construct: "recordCallSiteTurn(breakdown, 'impersonate', context[context.length - 1].content);",
    run: async (messages, character) => {
      await useChatStore.getState().impersonate(character);
      return { history: messages };
    },
  },
  {
    name: 'sendMessage',
    construct: 'const sendImages = resolveImagesForSend(attachedImages);',
    run: async (_messages, character) => {
      await useChatStore.getState().sendMessage('And the thurible?', character);
      // The user's turn is appended and persisted before the build runs, so
      // the builder saw one more message than the arrangement installed.
      return { history: useChatStore.getState().messages };
    },
  },
  {
    name: 'editMessageAndRegenerate',
    construct: 'const regenImages = imagesFromLastUserMessage(updatedMessages, provider, model);',
    run: async (messages, character) => {
      const last = messages[messages.length - 1];
      await useChatStore
        .getState()
        .editMessageAndRegenerate(last.id, `${last.content} (revised)`, character);
      return { history: useChatStore.getState().messages };
    },
  },
];

// ---------------------------------------------------------------------------
// Solo: the boundary reaches the request
// ---------------------------------------------------------------------------

describe('every solo call site sends the boundary of the build it is about to ship', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  for (const siteRow of SOLO_SITES) {
    it(siteRow.name, async () => {
      // KILLS, per site: `resolveRagContext(messages, file, null)` (M6) — the
      // one-token edit a merge resolution or a sixth generation path lands
      // silently, because `boundaryId` is typed `string | null` so null
      // compiles, client.ts then OMITS the field, and the server takes its
      // `_TAIL_SKIP = 4` fallback with `reason: null` so not even the new
      // console warning fires. Also kills M9 (a probe that runs WITH a recall
      // block): its boundary is newer than the prompt's real head, so the
      // turn just older than it would still be in the prompt.
      const messages = arrangeSolo();
      const edges = stubEdges();

      const { history } = await siteRow.run(messages, IVY);

      expectBoundaryDelimitsPrompt(history, edges);
      // The FIRST argument of the same call, which nothing read until round 3:
      // the boundary can be perfect while the query is a turn stale.
      expectRecallQueryIsLatestUserTurn(history, edges);
      // The other half of the two-pass shape: `finish` is pure and runs twice,
      // `prepare` is the side-effecting half and must run ONCE.
      expect(
        prepareCalls,
        'prepareConversationContext ran a number of times other than once — the side-effecting half (macro writes, WI activation, extension hooks) is per-turn'
      ).toBe(1);
    });
  }

  it('swipeRight sends exactly what an uncommitted probe of the same build reports', async () => {
    // The brief's explicit parity check, and the direct kill for "the wiring
    // reads SOME boundary, just not the probe's". Recomputed from the same
    // seam the call site uses, on a freshly reset arrangement — the probe pass
    // is pure with respect to every store (that is its contract), so replaying
    // it cannot disturb what the run above measured.
    const messages = arrangeSolo();
    const edges = stubEdges();
    const lastAi = [...messages].reverse().find((m) => !m.isUser && !m.isSystem)!;
    await useChatStore.getState().swipeRight(lastAi.id, IVY);
    const sent = boundarySent(edges);

    const contextMessages = arrangeSolo().slice(0, messages.indexOf(lastAi));
    const prepared = prepareConversationContext(contextMessages, IVY, undefined, {
      currentTurn: productionCurrentTurn(contextMessages),
      timers: {},
      activated: new Set<string>(),
    });
    const probe = finishConversationContext(prepared, undefined, { commit: false });

    expect(probe.boundaryId, 'the probe seam itself produced no boundary').not.toBeNull();
    expect(sent).toBe(probe.boundaryId);
  });
});

// ---------------------------------------------------------------------------
// Solo: commit is on the pass that ships, and only on that pass
// ---------------------------------------------------------------------------

/**
 * A minimal solo chat carrying an `{{addvar}}` canary and a constant lore
 * entry — the two observable consequences of `commit`.
 *
 * `{{addvar}}` and never `{{setvar}}`: setvar is idempotent, so a setvar
 * canary cannot tell one macro pass from two. addvar counts AND renders to ''
 * (macros.ts:442-453), so it moves nothing any prompt golden can see.
 *
 * Each call gets its OWN chat file: `wiFiredByFile` is module-level state in
 * chatStore that no reset clears, so a shared file name would let one test's
 * telemetry satisfy another's assertion.
 */
const CANARY_IVY = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  description: 'A quiet archivist.{{addvar::commitCanary::1}}',
});

let canaryRun = 0;
function arrangeCommitCanary(): { chatFile: string; messages: ChatMessage[]; entryId: string } {
  resetStores();
  prepareCalls = 0;
  const chatFile = `call-sites-commit-${++canaryRun}.jsonl`;
  const entryId = 'e-commit-canary';
  useWorldInfoStore.setState({
    books: [
      mkBook('b-commit-canary', [
        mkEntry(entryId, {
          content: 'The ledger lives in the closed stacks.',
          constant: true,
        }),
      ]),
    ],
    activeBookIds: ['b-commit-canary'],
  });
  const messages = [
    mkMsg('c1', 'Where is the ledger?'),
    mkMsg('c2', 'Exactly where you left it.', { isUser: false, name: 'Ivy' }),
  ];
  useCharacterStore.setState({ selectedCharacter: CANARY_IVY });
  useChatHistoryRagStore.setState({ enabled: true });
  useChatStore.setState({
    messages,
    currentChatFile: chatFile,
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
  return { chatFile, messages, entryId };
}

describe('the committing pass really commits, at every solo call site', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // PARAMETERISED OVER `SOLO_SITES`, and that is the whole point of round 3.
  // Both rows below used to drive swipeRight alone while the header claimed
  // "the five committing passes" — measured at the time: flipping sendMessage's
  // committing pass by itself, or all four non-swipeRight passes together, left
  // the full suite green at 1847/1847; only swipeRight's flip reddened anything.
  // A copy-paste lands at ONE site, so a one-site guard covers 20% of the
  // threat model it names.
  for (const siteRow of SOLO_SITES) {
    it(`${siteRow.name} persists the turn's macro writes, token estimate and WI fired state`, async () => {
      // KILLS M8 at this site: `{ commit: true }` -> `{ commit: false }` (the
      // two `finish` calls sit three lines apart and differ only in the options
      // object, so a copy-paste or a merge resolution lands it). `commit` gates
      // three writes and for the solo path each is the ONLY writer:
      //   setChatVariables  — every {{setvar}}/{{incvar}}/{{addvar}} this turn
      //                       executed is discarded, so variable-driven lorebooks
      //                       silently stop advancing;
      //   setLastTokenEstimate — the token badge freezes on its last value;
      //   wiTimerOut.fired  — captureWiFired early-returns when it is unset, so
      //                       sticky/cooldown/delay entries never record a firing.
      // Nothing before this file could see any of it: the goldens go through
      // `buildConversationContext`, whose wrapper DEFAULTS commit and therefore
      // never routes through a call site's flag.
      //
      // NOT what `commitCanary === '1'` kills: a discarded second `prepare`.
      // That reads '1' too — see the `prepareCalls` counter's note for why, and
      // for the assertion that does catch it. What the '1' DOES pin is a build
      // whose macro writes are persisted twice, i.e. a probe that commits.
      const { chatFile, messages, entryId } = arrangeCommitCanary();
      // A real stream, because `captureWiFired` sits past `if (!stream) return`
      // at all five sites.
      const edges = stubEdges({ stream: sseOnce('[emotion:neutral] It is here.') });

      await siteRow.run(messages, CANARY_IVY);

      expect(edges.generate, 'the turn never dispatched').toHaveBeenCalledTimes(1);
      expect(
        prepareCalls,
        'the side-effecting half ran a number of times other than once for this turn'
      ).toBe(1);
      expect(
        useChatStore.getState().getChatVariables(chatFile).commitCanary,
        'the macro writes this turn executed were not persisted'
      ).toBe('1');
      // `NOT_WRITTEN` is -1, so `> 0` rejects both the reset sentinel and a
      // build that estimated nothing.
      expect(
        useGenerationStore.getState().lastTokenEstimate,
        'the token estimate never advanced past the reset sentinel'
      ).toBeGreaterThan(0);

      // Keyed `bookId:entryId` by wiFired.ts — the composite is what the
      // story-bible replay looks entries up by.
      const fired = getWiFiredForChat(chatFile);
      expect(fired, 'no WI fired-state was recorded for this turn').toBeDefined();
      expect(Object.keys(fired ?? {}), 'the injected entry did not record a firing').toContain(
        `b-commit-canary:${entryId}`
      );
    });
  }

  for (const siteRow of SOLO_SITES) {
    it(`${siteRow.name} has written NOTHING by the time the probe pass is done`, async () => {
      // The purity half — the reverse mutation, and the one no builder-level
      // test can see: flipping the PROBE to `{ commit: true }` would double the
      // persisted state of every turn while leaving the committing pass intact,
      // so every assertion in the row above still passes.
      //
      // The recall call is the seam, and it is the same seam at all five sites:
      // `resolveRagContext` is awaited strictly between the two `finish`
      // passes, so a snapshot taken inside its stub is a snapshot of "after the
      // probe, before the commit".
      const { chatFile, messages } = arrangeCommitCanary();
      let atProbeTime: { canary: string | undefined; tokenEstimate: number } | null = null;
      vi.spyOn(api, 'getRetrievalMessages').mockImplementation(async () => {
        atProbeTime = {
          canary: useChatStore.getState().getChatVariables(chatFile).commitCanary,
          tokenEstimate: useGenerationStore.getState().lastTokenEstimate,
        };
        return { chunks: [], reason: null };
      });
      vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
      vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

      await siteRow.run(messages, CANARY_IVY);

      expect(atProbeTime, 'the probe/commit seam was never reached').not.toBeNull();
      expect(
        atProbeTime!.canary,
        'the PROBE pass persisted the macro writes — every turn now double-counts them'
      ).toBeUndefined();
      expect(
        atProbeTime!.tokenEstimate,
        'the PROBE pass wrote the token estimate — the badge reports a build that was never sent'
      ).toBe(NOT_WRITTEN);
      // And the commit still happened afterwards, so this row cannot be
      // satisfied by a build that simply never commits. It runs with a null
      // stream on purpose: the commit precedes `api.generateMessage`, so this
      // holds without the dispatch the row above needs.
      expect(useChatStore.getState().getChatVariables(chatFile).commitCanary).toBe('1');
    });
  }
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const GROUP_CHAT = 'call-sites-group.jsonl';

/** A persisted group-chat record, complete rather than cast: `resolveRagContext`
 *  reads `identityAvatar` off it for the recall identity (E9-S9, #458 — no
 *  longer `characterAvatars[0]`), and `generateGroupTurn` reads `cardMode`
 *  and `scenarioOverride`. Written without an `as` so `tsc -b` fails loudly
 *  if the record gains a required field. */
function mkGroupChat(avatars: string[], names: string[]): GroupChatInfo {
  return {
    fileName: GROUP_CHAT,
    characterNames: names,
    characterAvatars: avatars,
    identityAvatar: avatars[0],
    lastMessage: '',
    createdAt: 0,
    activationStrategy: 'manual',
    mutedAvatars: [],
    pooledExcludeRecent: 0,
    autoModeEnabled: false,
    autoModeDelayMs: 0,
    scenarioOverride: '',
    talkativenessOverrides: {},
    cardMode: DEFAULT_GROUP_CARD_MODE,
  };
}

/** The group's one row, in the same shape the solo table uses. */
const GROUP_SITE = {
  name: 'forceGroupMemberTalk -> generateGroupTurn',
  construct: 'async function generateGroupTurn(',
};

describe('the group call site sends the head of the window the builder emits', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it(GROUP_SITE.name, async () => {
    // KILLS M7: `groupRecallBoundary(updatedMessages)` -> `null`, which the
    // full suite tolerated. Same silent consequence as the solo mutation — the
    // server falls back to excluding a fixed COUNT of newest messages and
    // hands back turns this prompt already carries, with `reason: null` so no
    // warning fires.
    //
    // `window-slice-before-filter` is the right fixture precisely because its
    // window is a real slice: forty messages, so the head is gw10 and a
    // `messages[0].id` implementation is visibly wrong rather than accidentally
    // right.
    resetStores();
    const fx = GROUP_FIXTURES.find((f) => f.name === 'window-slice-before-filter')!;
    const input = fx.setup();
    const avatars = input.characters.map((c: CharacterInfo) => c.avatar);
    const names = input.characters.map((c: CharacterInfo) => c.name);
    useChatStore.setState({
      messages: input.messages,
      currentChatFile: GROUP_CHAT,
      groupChats: [mkGroupChat(avatars, names)],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    useChatHistoryRagStore.setState({ enabled: true });
    const edges = stubEdges();

    await useChatStore
      .getState()
      .forceGroupMemberTalk(input.currentCharacter, input.characters);

    const sent = boundarySent(edges);
    const window = groupHistoryWindow(input.messages);
    expect(sent, 'the group call site sent NO boundary').not.toBeNull();
    expect(sent).toBe(window[0].id);

    // The behavioural half, against the prompt that actually shipped: the
    // boundary's turn is in it and the turn just older than it is not.
    const prompt = promptSent(edges);
    const idx = input.messages.findIndex((m: ChatMessage) => m.id === sent);
    expect(idx, 'the group window is not a real slice on this fixture').toBeGreaterThan(0);
    expect(prompt).toContain(input.messages[idx].content);
    expect(
      prompt,
      'the group prompt carries a turn older than the boundary sent'
    ).not.toContain(input.messages[idx - 1].content);

    // The query argument, per the solo rows. WEAKER HERE, deliberately stated:
    // group hands `resolveRagContext` the FULL `updatedMessages` while the
    // boundary comes from the window, and the window is a tail slice of the
    // same array — so substituting the window for it would not move the query
    // and this cannot see that particular slip. What it does see is a tail
    // that drops the newest visible user turn (`.slice(0, -2)` on this
    // fixture, whose last message is Seraphina's), i.e. the same
    // stale-question defect the solo rows pin.
    expectRecallQueryIsLatestUserTurn(input.messages, edges);
  });
});

// ---------------------------------------------------------------------------
// The rows still name real call sites
// ---------------------------------------------------------------------------

describe('every row names a call site that exists exactly once', () => {
  it('resolves each construct fingerprint against chatStore.ts', () => {
    // WHY THIS EXISTS. The rows used to carry `chatStore.ts:NNNN` anchors, and
    // all six were stale in the commit that wrote them — nothing resolved
    // them, so `sendMessage — chatStore.ts:5193` shipped pointing at an
    // unrelated statement and would have rotted again on the next insertion
    // above it. Same fix as `PINS_ANCHORS`: the hint is a source substring, and
    // a test resolves it.
    //
    // EXACTLY ONCE, not merely present: the six generation call sites are
    // near-identical, so a fingerprint that matches twice is satisfied by
    // either copy and stops witnessing the site it names. The 12-character
    // floor is PINS_ANCHORS' too — `{` or `} else {` survives anything.
    const bad: string[] = [];
    for (const row of [...SOLO_SITES, GROUP_SITE]) {
      if (row.construct.length < 12) {
        bad.push(`${row.name}: fingerprint ${JSON.stringify(row.construct)} is too generic to prove anything`);
        continue;
      }
      const found = chatStoreRaw.split(row.construct).length - 1;
      if (found !== 1) {
        bad.push(
          `${row.name}: fingerprint ${JSON.stringify(row.construct)} occurs ${found} times in chatStore.ts, not once`
        );
      }
    }
    expect(
      bad,
      'a row names a construct that no longer exists, or that is no longer unique — re-read the call site and update the row'
    ).toEqual([]);
  });
});
