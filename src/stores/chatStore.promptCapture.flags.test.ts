/**
 * `collapsedByInstruct` / `replacedByInterceptor` (E2-S3, AC2) — both flags
 * come from the transforms' own return values (`maybeApplyInstructMode`,
 * `runGenerateInterceptors`), never from `instruct.enabled` directly.
 * Exercised through the `sendMessage`
 * seam: the flag logic lives inside the shared `dispatchWithCapture` helper
 * rather than at each call site, so one seam is enough to pin it —
 * `chatStore.promptCapture.callSites.test.ts` covers the call sites
 * themselves.
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
const { mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');
const { computeCaptureAttribution } = await import('../utils/promptCapture');

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

const IVY = mkChar({ name: 'Ivy', avatar: 'ivy.png', description: 'A quiet archivist.' });

function arrange() {
  resetStores();
  const messages = [mkMsg('u1', 'Hello?'), mkMsg('a1', 'Hi there.', { isUser: false, name: 'Ivy' })];
  useCharacterStore.setState({ selectedCharacter: IVY });
  useChatHistoryRagStore.setState({ enabled: false });
  useChatStore.setState({
    messages,
    currentChatFile: 'prompt-capture-flags.jsonl',
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
}

function capture() {
  return useGenerationStore.getState().lastPromptCapture;
}

describe('exact-prompt capture flags', () => {
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

  it('both flags are false on the plain path', async () => {
    arrange();
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.collapsedByInstruct).toBe(false);
    expect(capture()!.replacedByInterceptor).toBe(false);
  });

  it('collapsedByInstruct is true when instruct mode actually collapses the array', async () => {
    arrange();
    useGenerationStore.setState({ instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: true, templateId: 'chatml' } });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.collapsedByInstruct).toBe(true);
    expect(capture()!.replacedByInterceptor).toBe(false);
    expect(capture()!.messages).toHaveLength(1);
  });

  it('collapsedByInstruct is true under text completion mode even with instruct disabled', async () => {
    arrange();
    useGenerationStore.setState({
      instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: false, completionMode: 'text', templateId: 'chatml' },
    });
    const gen = vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.collapsedByInstruct).toBe(true);
    expect(capture()!.messages).toHaveLength(1);
    expect(gen.mock.calls[0][0]).toHaveLength(1);
  });

  it('collapsedByInstruct stays false when instruct is enabled but the template id is unknown', async () => {
    // `instruct.enabled` is true here, but `getInstructTemplate` finds
    // nothing for this id, so the array passes through unchanged — the
    // flag has to come from what actually happened, not from this setting.
    arrange();
    useGenerationStore.setState({ instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: true, templateId: 'does-not-exist' } });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.collapsedByInstruct).toBe(false);
  });

  it('replacedByInterceptor is true only when an interceptor actually returns a replacement array', async () => {
    arrange();
    useServerExtensionStore.setState({
      installed: [{ type: 'local', name: 'third-party/echo-swap' }],
      manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
    });
    const replacement = [{ role: 'user', content: 'REPLACED BY INTERCEPTOR' }];
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
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.replacedByInterceptor).toBe(true);
    expect(capture()!.collapsedByInstruct).toBe(false);
    expect(capture()!.messages).toEqual(replacement);
  });

  it('replacedByInterceptor stays false when an interceptor echoes the posted array back unchanged, and attribution still resolves', async () => {
    arrange();
    useServerExtensionStore.setState({
      installed: [{ type: 'local', name: 'third-party/echo-swap' }],
      manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
    });
    // Echoes back whatever `messages` it was posted with — the shape a
    // read-only extension (logger, moderation observer) has every reason to
    // return, and no reason to change.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/csrf-token') {
        return { ok: true, json: async () => ({ token: 'csrf-test' }), text: async () => '{}' } as Response;
      }
      if (url.includes('/generate-interceptors')) {
        const body = JSON.parse(String(init?.body)) as { messages: unknown };
        return {
          ok: true,
          json: async () => ({ messages: body.messages }),
          text: async () => JSON.stringify({ messages: body.messages }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    const c = capture()!;
    expect(c.replacedByInterceptor).toBe(false);
    expect(c.collapsedByInstruct).toBe(false);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
  });

  it('replacedByInterceptor stays false when an interceptor re-serializes the same content with keys in a different order', async () => {
    // A non-JS runtime (a typed struct, a pydantic model, Go's sorted map
    // keys) can echo the same {role, content} pairs back with the fields in
    // a different order — JSON.stringify would call that a replacement;
    // structural comparison must not.
    arrange();
    useServerExtensionStore.setState({
      installed: [{ type: 'local', name: 'third-party/echo-swap' }],
      manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/csrf-token') {
        return { ok: true, json: async () => ({ token: 'csrf-test' }), text: async () => '{}' } as Response;
      }
      if (url.includes('/generate-interceptors')) {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
        const reordered = body.messages.map((m) => ({ content: m.content, role: m.role }));
        return {
          ok: true,
          json: async () => ({ messages: reordered }),
          text: async () => JSON.stringify({ messages: reordered }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    const c = capture()!;
    expect(c.replacedByInterceptor).toBe(false);
    expect(computeCaptureAttribution(c, c.breakdown)).not.toBeNull();
  });

  it('replacedByInterceptor stays false across two hops when the second restores what the first changed', async () => {
    arrange();
    useServerExtensionStore.setState({
      installed: [
        { type: 'local', name: 'third-party/hop-a' },
        { type: 'local', name: 'third-party/hop-b' },
      ],
      manifests: {
        'third-party/hop-a': { generate_interceptor: true },
        'third-party/hop-b': { generate_interceptor: true },
      },
    });
    let original: unknown = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/csrf-token') {
        return { ok: true, json: async () => ({ token: 'csrf-test' }), text: async () => '{}' } as Response;
      }
      if (url.includes('/hop-a/generate-interceptors')) {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
        original = body.messages;
        const rewritten = body.messages.map((m) => ({ role: m.role, content: `${m.content} [hop-a]` }));
        return {
          ok: true,
          json: async () => ({ messages: rewritten }),
          text: async () => JSON.stringify({ messages: rewritten }),
        } as Response;
      }
      if (url.includes('/hop-b/generate-interceptors')) {
        // Restores hop-a's own input, so the FINAL array equals the
        // original context even though an intermediate hop changed it.
        return {
          ok: true,
          json: async () => ({ messages: original }),
          text: async () => JSON.stringify({ messages: original }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    const c = capture()!;
    expect(c.replacedByInterceptor).toBe(false);
    expect(c.messages).toEqual(original);
  });

  it('both flags are true when instruct collapses AND an interceptor then replaces the collapsed array', async () => {
    arrange();
    useGenerationStore.setState({ instruct: { ...DEFAULT_INSTRUCT_CONFIG, enabled: true, templateId: 'chatml' } });
    useServerExtensionStore.setState({
      installed: [{ type: 'local', name: 'third-party/echo-swap' }],
      manifests: { 'third-party/echo-swap': { generate_interceptor: true } },
    });
    const replacement = [{ role: 'user', content: 'REPLACED AGAIN' }];
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
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('reply'));
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('hi', IVY);

    expect(capture()!.collapsedByInstruct).toBe(true);
    expect(capture()!.replacedByInterceptor).toBe(true);
    expect(capture()!.messages).toEqual(replacement);
  });
});
