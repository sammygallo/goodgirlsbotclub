/**
 * The exact-prompt capture (E2-S3), pinned per generation dispatch seam.
 *
 * WHAT THIS FILE EXISTS FOR. `dispatchWithCapture` (chatStore.ts) is the one
 * place a generation seam runs its transforms and dispatch — this file
 * proves each seam actually routes through it, by comparing the published
 * capture against what `api.generateMessage` was really called with. Reuses the
 * prelude and fixtures from `chatStore.breakdownTag.callSites.test.ts` /
 * `promptGoldens.fixtures.ts` rather than inventing a new arrangement.
 *
 * Byte-identity is checked two ways per row: `toEqual` against the spy's
 * captured argument (structural), and `JSON.stringify` equality (so a
 * capture that quietly dropped or reordered a field the deep-equal check
 * happens not to weight still reddens).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const { useChatStore } = await import('./chatStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useCharacterStore } = await import('./characterStore');
const { useGenerationStore, DEFAULT_INSTRUCT_CONFIG } = await import('./generationStore');
const { useServerExtensionStore } = await import('./serverExtensionStore');
const { api } = await import('../api/client');
const { GROUP_FIXTURES, mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');
const { computeCaptureAttribution } = await import('../utils/promptCapture');
const { createPromptBreakdown } = await import('../utils/promptBreakdown');
const { estimateConversationTokens, profileForProvider } = await import('../utils/tokenizer');

import type { CharacterInfo } from '../api/client';
import type { ChatMessage, GroupChatInfo } from './chatStore';

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

function capture() {
  return useGenerationStore.getState().lastPromptCapture;
}

const IVY = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  description: 'A quiet archivist who never throws anything away.',
});

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
    currentChatFile: 'prompt-capture-solo.jsonl',
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
  return messages;
}

function mkGroupChat(characters: CharacterInfo[]): GroupChatInfo {
  return {
    fileName: 'prompt-capture-group.jsonl',
    characterNames: characters.map((c) => c.name),
    characterAvatars: characters.map((c) => c.avatar),
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

/** Installs an interceptor extension whose `/generate-interceptors` response
 *  is a REPLACEMENT array distinct from whatever it was posted, so the
 *  seam's dispatched array differs from `context`. */
function stubInterceptorReplacement(replacement: { role: string; content: string }[]) {
  useServerExtensionStore.setState({
    installed: [{ type: 'local', name: 'third-party/echo-swap' }],
    manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
  });
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/csrf-token') {
      return { ok: true, json: async () => ({ token: 'csrf-test' }), text: async () => '{}' } as Response;
    }
    if (url.includes('/generate-interceptors')) {
      return {
        ok: true,
        json: async () => ({ messages: replacement }),
        text: async () => JSON.stringify({ messages: replacement }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Same interceptor arrangement as `stubInterceptorReplacement`, except the
 *  `/generate-interceptors` response stays pending until the caller resolves
 *  it by hand — for pinning what `dispatchWithCapture` reads while it is
 *  parked in that `await`. `issued` settles once the request has actually
 *  gone out. */
function stubInterceptorReplacementDeferred(replacement: { role: string; content: string }[]) {
  useServerExtensionStore.setState({
    installed: [{ type: 'local', name: 'third-party/echo-swap' }],
    manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
  });
  let markIssued: () => void;
  const issued = new Promise<void>((res) => { markIssued = res; });
  let resolveResponse: (value: Response) => void;
  const response = new Promise<Response>((res) => { resolveResponse = res; });
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/csrf-token') {
      return { ok: true, json: async () => ({ token: 'csrf-test' }), text: async () => '{}' } as Response;
    }
    if (url.includes('/generate-interceptors')) {
      markIssued();
      return response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    issued,
    resolve: () =>
      resolveResponse({
        ok: true,
        json: async () => ({ messages: replacement }),
        text: async () => JSON.stringify({ messages: replacement }),
      } as Response),
  };
}

/** One entry per solo dispatch seam, so AC1 can be proven under a transform
 *  at each of them individually rather than only through `sendMessage` (the
 *  one seam `chatStore.promptCapture.flags.test.ts` exercises). */
function soloSeams(): { name: string; run: () => Promise<unknown> }[] {
  return [
    {
      name: 'sendMessage',
      run: () => useChatStore.getState().sendMessage('Anyone there?', IVY),
    },
    {
      name: 'swipeRight',
      run: () => {
        const messages = useChatStore.getState().messages;
        const lastAi = messages[messages.length - 1];
        return useChatStore.getState().swipeRight(lastAi.id, IVY);
      },
    },
    {
      name: 'continueMessage',
      run: () => useChatStore.getState().continueMessage(IVY),
    },
    {
      name: 'impersonate',
      run: () => useChatStore.getState().impersonate(IVY),
    },
    {
      name: 'editMessageAndRegenerate',
      run: () => {
        const userMsg = useChatStore.getState().messages[0];
        return useChatStore.getState().editMessageAndRegenerate(userMsg.id, 'Anyone home?', IVY);
      },
    },
  ];
}

describe('exact-prompt capture is wired at every solo generation call site', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
  });

  it('sendMessage captures the array api.generateMessage received', async () => {
    arrangeSolo();
    const edges = stubEdges();

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c, 'a capture should have been published').not.toBeNull();
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.imagesFolded).toBe((edges.generate.mock.calls[0][6] as unknown[] | undefined)?.length ?? 0);
    expect(c.seam).toBe('send');
    expect(c.collapsedByInstruct).toBe(false);
    expect(c.replacedByInterceptor).toBe(false);
    // R2-C10: pins that THIS seam's own breakdown, not just some breakdown,
    // reached the capture — an empty/foreign breakdown fails the count check
    // inside computeCaptureAttribution immediately.
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    // R5-C1: the ownership tag this seam publishes alongside the capture —
    // read the created AI message off the store rather than hardcoding an id.
    const aiMsg = useChatStore.getState().messages[useChatStore.getState().messages.length - 1];
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: aiMsg.id, swipeIndex: 0 });
  });

  it('swipeRight captures the array api.generateMessage received', async () => {
    // R5-C1: two swipes already on the fixture, so the tagged swipeIndex
    // (the swipe count BEFORE this call) differs from the 0 a copy-pasted
    // call site would produce.
    const messages = arrangeSolo({ swipes: ['Hi there.', 'Hello again.'], swipeId: 1 });
    const edges = stubEdges();
    const lastAi = messages[messages.length - 1];
    const swipesBefore = lastAi.swipes.length;
    expect(swipesBefore, 'sanity: the fixture already has more than one swipe').toBeGreaterThan(1);

    await useChatStore.getState().swipeRight(lastAi.id, IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('swipe');
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({
      messageId: lastAi.id,
      swipeIndex: swipesBefore,
    });
  });

  it('continueMessage captures the array api.generateMessage received', async () => {
    // R5-C1: a nonzero swipeId, so the tagged swipeIndex can't be mistaken
    // for a hardcoded 0 — see chatStore.breakdownTag.callSites.test.ts's
    // sibling row for the same reasoning.
    const messages = arrangeSolo({
      content: 'Hello again.',
      swipes: ['Hi there.', 'Hello again.'],
      swipeId: 1,
    });
    const edges = stubEdges();
    const lastAi = messages[messages.length - 1];

    await useChatStore.getState().continueMessage(IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('continue');
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({
      messageId: lastAi.id,
      swipeIndex: lastAi.swipeId,
    });
  });

  it('impersonate captures the array api.generateMessage received', async () => {
    arrangeSolo();
    const edges = stubEdges();

    await useChatStore.getState().impersonate(IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('impersonate');
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    // R5-C1: impersonate creates no message to tag — see chatStore.ts's own
    // comment at that seam.
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
  });

  it('editMessageAndRegenerate captures the array api.generateMessage received', async () => {
    const messages = arrangeSolo();
    const edges = stubEdges();
    const userMsg = messages[0];

    await useChatStore.getState().editMessageAndRegenerate(userMsg.id, 'Anyone home?', IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('regenerate');
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    const aiMsg = useChatStore.getState().messages[useChatStore.getState().messages.length - 1];
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: aiMsg.id, swipeIndex: 0 });
  });

  it('sendMessage records the fallback provider/model when the primary call rejects', async () => {
    arrangeSolo();
    const edges = stubEdges();
    edges.generate.mockRejectedValueOnce(new Error('primary down'));
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState({ fallbackProvider: 'anthropic', fallbackModel: 'claude-x' });

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    expect(edges.generate).toHaveBeenCalledTimes(2);
    const c = capture()!;
    expect(c.usedFallback).toBe(true);
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('claude-x');
  });
});

describe('exact-prompt capture is wired at the group generation call site', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
  });

  it('generateGroupTurn (forceGroupMemberTalk) captures the array api.generateMessage received', async () => {
    resetStores();
    const fx = GROUP_FIXTURES.find((f) => f.name === 'swap')!;
    const input = fx.setup();
    useChatHistoryRagStore.setState({ enabled: false });
    useChatStore.setState({
      messages: input.messages,
      currentChatFile: 'prompt-capture-group.jsonl',
      groupChats: [mkGroupChat(input.characters)],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    const edges = stubEdges();

    await useChatStore.getState().forceGroupMemberTalk(input.characters[0], input.characters);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('group');
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown!.slices.length).toBeGreaterThan(0);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
    const groupMsgs = useChatStore.getState().messages;
    const aiMsg = groupMsgs[groupMsgs.length - 1];
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: aiMsg.id, swipeIndex: 0 });
  });

  it('generateGroupTurn (forceGroupMemberTalk) under a transform: usage.inputTokens is estimated from the dispatched (post-collapse) array (R6-C4)', async () => {
    resetStores();
    const fx = GROUP_FIXTURES.find((f) => f.name === 'swap')!;
    const input = fx.setup();
    useChatHistoryRagStore.setState({ enabled: false });
    useChatStore.setState({
      messages: input.messages,
      currentChatFile: 'prompt-capture-group.jsonl',
      groupChats: [mkGroupChat(input.characters)],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    useGenerationStore.setState({
      instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: true, templateId: 'chatml' },
    });
    const edges = stubEdges();

    await useChatStore.getState().forceGroupMemberTalk(input.characters[0], input.characters);

    const sent = edges.generate.mock.calls[0][0];
    expect(sent).toHaveLength(1);
    const { useSettingsStore } = await import('./settingsStore');
    const groupMsgs = useChatStore.getState().messages;
    const aiMsg = groupMsgs[groupMsgs.length - 1];
    expect(aiMsg.usage!.inputTokens).toBe(
      estimateConversationTokens(sent, profileForProvider(useSettingsStore.getState().activeProvider)),
    );
  });
});

describe('showExactPrompt off: no capture is published', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: false });
  });

  it('sendMessage dispatches normally but publishes nothing', async () => {
    arrangeSolo();
    const edges = stubEdges();

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    expect(edges.generate).toHaveBeenCalledTimes(1);
    expect(capture()).toBeNull();
  });
});

describe('AC1 under a transform, at every solo seam (C5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useGenerationStore.setState({
      lastPromptCapture: null,
      lastPromptCaptureTag: null,
      showExactPrompt: true,
      instruct: { ...DEFAULT_INSTRUCT_CONFIG },
    });
    useServerExtensionStore.setState({ installed: [], manifests: {} });
  });

  // R2-C12: `stubInterceptorReplacement` (used by the REPLACED-array case
  // below) leaves a stubbed `fetch` and an installed interceptor extension
  // behind — nothing in this describe's own beforeEach undoes them, and
  // vitest.config.ts sets neither `unstubGlobals` nor `restoreMocks`. Without
  // this cleanup, every describe that runs AFTER this one inherits the
  // leftover fetch stub and interceptor, so its "plain path" tests silently
  // run against the last seam's replacement array instead.
  afterEach(() => {
    vi.unstubAllGlobals();
    useServerExtensionStore.setState({ installed: [], manifests: {} });
  });

  for (const seam of soloSeams()) {
    it(`${seam.name}: capture equals the COLLAPSED array api.generateMessage received`, async () => {
      arrangeSolo();
      useGenerationStore.setState({
        instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: true, templateId: 'chatml' },
      });
      const edges = stubEdges();

      await seam.run();

      const sent = edges.generate.mock.calls[0][0];
      const c = capture()!;
      expect(c, 'a capture should have been published').not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(c.messages).toEqual(sent);
      expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
      expect(c.collapsedByInstruct).toBe(true);
    });

    it(`${seam.name}: capture equals the REPLACED array api.generateMessage received`, async () => {
      arrangeSolo();
      const replacement = [{ role: 'user', content: `REPLACED FOR ${seam.name}` }];
      stubInterceptorReplacement(replacement);
      const edges = stubEdges();

      await seam.run();

      const sent = edges.generate.mock.calls[0][0];
      const c = capture()!;
      expect(c, 'a capture should have been published').not.toBeNull();
      expect(sent).toEqual(replacement);
      expect(c.messages).toEqual(sent);
      expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
      expect(c.replacedByInterceptor).toBe(true);
    });
  }
});

describe('the capture carries its OWN breakdown, not whatever is in lastPromptBreakdown by publish time (R7-C6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useServerExtensionStore.setState({ installed: [], manifests: {} });
  });

  it('sendMessage: publishes the breakdown its own dispatch built, even when lastPromptBreakdown is overwritten while the interceptor is pending', async () => {
    arrangeSolo();
    const edges = stubEdges();
    const stub = stubInterceptorReplacementDeferred([{ role: 'user', content: 'from the interceptor' }]);

    const turn = useChatStore.getState().sendMessage('Anyone there?', IVY);
    await stub.issued;

    const foreign = createPromptBreakdown('solo');
    useGenerationStore.setState({ lastPromptBreakdown: foreign });

    stub.resolve();
    await turn;

    expect(edges.generate).toHaveBeenCalled();
    const c = capture()!;
    expect(c, 'a capture should have been published').not.toBeNull();
    expect(c.breakdown).not.toBeNull();
    expect(c.breakdown).not.toBe(foreign);
  });
});

describe('capture metadata matches the dispatch on the non-fallback path (C7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({
      lastPromptCapture: null,
      lastPromptCaptureTag: null,
      showExactPrompt: true,
      instruct: { ...DEFAULT_INSTRUCT_CONFIG },
    });
    // R2-C12: this describe runs after C5, whose interceptor-replacement
    // case leaves a stubbed `fetch` and an installed extension behind if
    // C5's own cleanup didn't run — reassert the plain path holds here too.
    useServerExtensionStore.setState({ installed: [], manifests: {} });
  });

  it('sendMessage: imagesFolded and the header fields match what api.generateMessage received', async () => {
    arrangeSolo();
    const { useSettingsStore } = await import('./settingsStore');
    // Values distinct from any literal `dispatchWithCapture`/`createPromptCapture`
    // could hardcode (R2-C13) — 'openai'/'gpt-4o' are also settingsStore's own
    // defaults, so a hardcoded capture would still coincidentally match them.
    // Also vision-capable, so the image attachments still fold.
    useSettingsStore.setState({ activeProvider: 'claude', activeModel: 'claude-3-test' });
    const edges = stubEdges();
    const dataUrls = [
      'data:image/png;base64,aaa',
      'data:image/png;base64,bbb',
    ];

    await useChatStore.getState().sendMessage('Look at these', IVY, undefined, dataUrls);

    const call = edges.generate.mock.calls[0];
    const c = capture()!;
    expect(c.imagesFolded).toBe(2);
    expect((call[6] as unknown[] | undefined)?.length).toBe(2);
    expect(c.provider).toBe(call[2]);
    expect(c.model).toBe(call[3]);
    expect(c.provider).toBe('claude');
    expect(c.model).toBe('claude-3-test');
    expect(c.characterName).toBe(call[1]);
    expect(c.textCompletionMode).toBe(call[7]);
    expect(c.textCompletionMode).toBe(false);
    // R2-C12: proves this ran the plain path, not a leftover interceptor
    // replacement from a describe that ran earlier.
    expect(c.replacedByInterceptor).toBe(false);
    // R5-C5: this describe's own title names the non-fallback path — the
    // field distinguishing it from the fallback case (below) was unchecked.
    expect(c.usedFallback).toBe(false);
    expect(JSON.stringify(c.messages)).toContain(IVY.description);
  });

  it('sendMessage: textCompletionMode true is forwarded from meta, not hardcoded (R2-C13)', async () => {
    arrangeSolo();
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState({ activeProvider: 'anthropic', activeModel: 'claude-x' });
    useGenerationStore.setState({
      instruct: { ...DEFAULT_INSTRUCT_CONFIG, completionMode: 'text' },
    });
    const edges = stubEdges();

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    const call = edges.generate.mock.calls[0];
    const c = capture()!;
    expect(c.textCompletionMode).toBe(true);
    expect(call[7]).toBe(true);
  });
});

describe('publishes before send, even when the dispatch rejects (C9)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
    // R2-C12: guard against a leftover fetch stub / installed interceptor
    // from a describe that ran earlier — see the C5 afterEach.
    useServerExtensionStore.setState({ installed: [], manifests: {} });
  });

  it('sendMessage: a rejecting dispatch with no fallback still leaves a capture in the slot', async () => {
    arrangeSolo();
    const edges = stubEdges();
    edges.generate.mockRejectedValue(new Error('down'));
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState({ fallbackProvider: '', fallbackModel: '' });

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    const c = capture()!;
    expect(c, 'a capture should have been published even though the dispatch rejected').not.toBeNull();
    expect(c.seam).toBe('send');
    expect(c.messages).toEqual(edges.generate.mock.calls[0][0]);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(edges.generate.mock.calls[0][0]));
    // R2-C12: proves this ran the plain path, not a leftover interceptor
    // replacement from a describe that ran earlier.
    expect(c.replacedByInterceptor).toBe(false);
    expect(JSON.stringify(c.messages)).toContain(IVY.description);
  });
});
