/**
 * E2-S3 AC4: the exact-prompt capture must never leak into a save, a chat
 * export, or the persisted-prefs sync — it lives only in the volatile
 * `generationStore.lastPromptCapture` slot.
 *
 * Proving test (plan §7): run a real `sendMessage` turn with the toggle on
 * and a sentinel string embedded in the character description, so it lands
 * in the prompt and therefore in the capture; then check every OTHER wire
 * this app actually writes to for the same sentinel.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const patchServerKey = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey,
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
const { useGenerationStore } = await import('./generationStore');
const { api } = await import('../api/client');
const { mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');

const SENTINEL = 'ZZZ_E2S3_SENTINEL_NEVER_PERSISTED_ZZZ';

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

const IVY = mkChar({ name: 'Ivy', avatar: 'ivy.png', description: SENTINEL });

beforeEach(() => {
  vi.restoreAllMocks();
  patchServerKey.mockClear();
  resetStores();
  useGenerationStore.setState({ lastPromptCapture: null, lastPromptCaptureTag: null, showExactPrompt: true });
  const messages = [mkMsg('u1', 'Hello?')];
  useCharacterStore.setState({ selectedCharacter: IVY });
  useChatHistoryRagStore.setState({ enabled: false });
  useChatStore.setState({
    messages,
    currentChatFile: 'prompt-capture-exclusion.jsonl',
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
});

describe('exact-prompt capture never rides the save/export/prefs-sync paths', () => {
  it('the sentinel lands in the capture but not in the saved chat payload or the synced prefs blob', async () => {
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [], reason: null });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('A reply.'));
    const save = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    await useChatStore.getState().sendMessage('Anyone there?', IVY);

    // Sanity: the sentinel actually reached the capture — otherwise every
    // assertion below would pass for the wrong reason (nothing was ever in
    // the prompt to leak).
    const capture = useGenerationStore.getState().lastPromptCapture;
    expect(capture, 'a capture should have been published').not.toBeNull();
    expect(JSON.stringify(capture!.messages)).toContain(SENTINEL);

    // The chat save (buildChatPayload's output, forwarded to api.saveChat)
    // must not carry it.
    expect(save).toHaveBeenCalled();
    const chatData = save.mock.calls[0][2];
    expect(JSON.stringify(chatData)).not.toContain(SENTINEL);

    // Nothing this turn wrote to the server-synced prefs blob carries it
    // either — generationStore's own persisted shape has no field the
    // capture could ride (generationStore.promptCapture.test.ts pins the key
    // set directly); this checks the same claim end-to-end, against every
    // call any store made during a real turn.
    for (const call of patchServerKey.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SENTINEL);
    }
  });
});
