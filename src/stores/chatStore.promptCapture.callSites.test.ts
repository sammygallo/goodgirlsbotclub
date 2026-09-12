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

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  });

  it('swipeRight captures the array api.generateMessage received', async () => {
    const messages = arrangeSolo();
    const edges = stubEdges();
    const lastAi = messages[messages.length - 1];

    await useChatStore.getState().swipeRight(lastAi.id, IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('swipe');
  });

  it('continueMessage captures the array api.generateMessage received', async () => {
    arrangeSolo();
    const edges = stubEdges();

    await useChatStore.getState().continueMessage(IVY);

    const sent = edges.generate.mock.calls[0][0];
    const c = capture()!;
    expect(c.messages).toEqual(sent);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(sent));
    expect(c.seam).toBe('continue');
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

describe('capture metadata matches the dispatch on the non-fallback path (C7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
  });

  it('sendMessage: imagesFolded and the header fields match what api.generateMessage received', async () => {
    arrangeSolo();
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4o' });
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
    expect(c.characterName).toBe(call[1]);
    expect(c.textCompletionMode).toBe(call[7]);
  });
});

describe('publishes before send, even when the dispatch rejects (C9)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
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
  });
});
