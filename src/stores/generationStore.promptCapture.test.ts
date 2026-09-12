/**
 * E2-S3: the `lastPromptCapture` slot, its parallel tagger, the fallback
 * amendment, and the persisted `showExactPrompt` toggle.
 *
 * The tagger is guarded by the capture's `id`, not object identity — see
 * `tagLastPromptCaptureMessage`'s own doc comment for why an identity guard
 * would reject the tag call that follows `notePromptCaptureFallback`, which
 * replaces the record in the slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// This vitest project runs with `environment: 'node'` — see the same note in
// characterStore.charactersLoaded.test.ts / dataBankStore.documentActivation.test.ts.
const memoryStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
})();
vi.stubGlobal('localStorage', memoryStorage);

const patchServerKey = vi.fn(async (..._args: unknown[]) => {});
const getSettingsBlob = vi.fn(async () => ({}) as Record<string, unknown>);
const shouldReuploadSection = vi.fn(() => false);
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob,
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey,
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection,
  clearLocalTs: vi.fn(),
}));

const { useGenerationStore } = await import('./generationStore');
const { createPromptCapture } = await import('../utils/promptCapture');

function reset() {
  useGenerationStore.setState({
    lastPromptCapture: null,
    lastPromptCaptureTag: null,
    showExactPrompt: false,
  });
}

function mkCapture(over: Partial<Parameters<typeof createPromptCapture>[0]> = {}) {
  return createPromptCapture({
    seam: 'send',
    messages: [{ role: 'user', content: 'hi' }],
    collapsedByInstruct: false,
    replacedByInterceptor: false,
    provider: 'openai',
    model: 'gpt-4o',
    textCompletionMode: false,
    imagesFolded: 0,
    characterName: 'Ivy',
    breakdown: null,
    ...over,
  });
}

beforeEach(() => {
  memoryStorage.clear();
  patchServerKey.mockClear();
  getSettingsBlob.mockReset().mockResolvedValue({});
  shouldReuploadSection.mockReset().mockReturnValue(false);
  reset();
});

describe('tagLastPromptCaptureMessage', () => {
  it('writes the message id and swipe index when the id matches the slot', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: 'msg-1', swipeIndex: 0 });
  });

  it('no-ops when the id does not match the slot (a concurrent turn already replaced it)', () => {
    const first = mkCapture();
    const second = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(first);
    useGenerationStore.getState().setLastPromptCapture(second);
    useGenerationStore.getState().tagLastPromptCaptureMessage(first.id, 'stale', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();

    useGenerationStore.getState().tagLastPromptCaptureMessage(second.id, 'fresh', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: 'fresh', swipeIndex: 0 });
  });

  it('is a no-op against a null slot', () => {
    useGenerationStore.getState().tagLastPromptCaptureMessage('orphan-id', 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
  });

  it('still succeeds after notePromptCaptureFallback has replaced the record — the reason for an id guard rather than object identity', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().notePromptCaptureFallback(c.id, 'anthropic', 'claude-x');
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: 'msg-1', swipeIndex: 0 });
  });
});

describe('notePromptCaptureFallback', () => {
  it('replaces provider/model and sets usedFallback when the id matches', () => {
    const c = mkCapture({ provider: 'openai', model: 'gpt-4o' });
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().notePromptCaptureFallback(c.id, 'anthropic', 'claude-x');
    const updated = useGenerationStore.getState().lastPromptCapture!;
    expect(updated.usedFallback).toBe(true);
    expect(updated.provider).toBe('anthropic');
    expect(updated.model).toBe('claude-x');
    expect(updated.id).toBe(c.id);
  });

  it('no-ops when the id does not match the slot', () => {
    const c = mkCapture({ provider: 'openai', model: 'gpt-4o' });
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().notePromptCaptureFallback('someone-elses-id', 'anthropic', 'claude-x');
    expect(useGenerationStore.getState().lastPromptCapture).toBe(c);
  });

  it('no-ops against a null slot', () => {
    useGenerationStore.getState().notePromptCaptureFallback('orphan-id', 'anthropic', 'claude-x');
    expect(useGenerationStore.getState().lastPromptCapture).toBeNull();
  });
});

describe('setLastPromptCapture', () => {
  it('clears the tag along with the capture', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptCaptureTag).not.toBeNull();

    useGenerationStore.getState().setLastPromptCapture(mkCapture());
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
  });
});

describe('setShowExactPrompt', () => {
  it('clears the capture and its tag when turned off', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);

    useGenerationStore.getState().setShowExactPrompt(false);

    expect(useGenerationStore.getState().lastPromptCapture).toBeNull();
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
  });

  it('leaves an existing capture alone when turned on', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);

    useGenerationStore.getState().setShowExactPrompt(true);

    expect(useGenerationStore.getState().lastPromptCapture).toBe(c);
    expect(useGenerationStore.getState().lastPromptCaptureTag).toEqual({ messageId: 'msg-1', swipeIndex: 0 });
  });
});

describe('resetUser', () => {
  it('clears the capture, its tag, and the toggle', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);
    useGenerationStore.getState().setShowExactPrompt(true);

    useGenerationStore.getState().resetUser();

    expect(useGenerationStore.getState().lastPromptCapture).toBeNull();
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
    expect(useGenerationStore.getState().showExactPrompt).toBe(false);
  });
});

describe('showExactPrompt persistence', () => {
  it('the persisted shape has exactly the expected key set, and never carries the capture fields', () => {
    useGenerationStore.getState().setShowExactPrompt(true);

    expect(patchServerKey).toHaveBeenCalled();
    const shape = patchServerKey.mock.calls[patchServerKey.mock.calls.length - 1][1] as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(
      [
        'sampler',
        'presets',
        'activePresetId',
        'defaultPresetId',
        'linkedPresetByAvatar',
        'linkedPresetByChatFile',
        'samplerSnapshot',
        'prompt',
        'context',
        'instruct',
        'promptOrder',
        'showExactPrompt',
      ].sort()
    );
    expect(shape.showExactPrompt).toBe(true);
    expect(shape).not.toHaveProperty('lastPromptCapture');
    expect(shape).not.toHaveProperty('lastPromptCaptureTag');
  });

  it('survives a store re-init from localStorage', async () => {
    useGenerationStore.getState().setShowExactPrompt(true);

    vi.resetModules();
    const fresh = await import('./generationStore');
    expect(fresh.useGenerationStore.getState().showExactPrompt).toBe(true);
  });

  it('fetchPrefs applies showExactPrompt from the server blob when local has nothing to re-upload', async () => {
    shouldReuploadSection.mockReturnValue(false);
    getSettingsBlob.mockResolvedValue({ stm_generation: { showExactPrompt: true, _ts: 1 } });

    await useGenerationStore.getState().fetchPrefs();

    expect(useGenerationStore.getState().showExactPrompt).toBe(true);
  });

  it('fetchPrefs clears the capture and its tag when the server turns showExactPrompt off (R2-C7)', async () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'msg-1', 0);
    useGenerationStore.setState({ showExactPrompt: true });
    shouldReuploadSection.mockReturnValue(false);
    getSettingsBlob.mockResolvedValue({ stm_generation: { showExactPrompt: false, _ts: 1 } });

    await useGenerationStore.getState().fetchPrefs();

    expect(useGenerationStore.getState().showExactPrompt).toBe(false);
    expect(useGenerationStore.getState().lastPromptCapture).toBeNull();
    expect(useGenerationStore.getState().lastPromptCaptureTag).toBeNull();
  });

  it('fetchPrefs re-uploads showExactPrompt from local state on the dirty-local branch', async () => {
    useGenerationStore.setState({ showExactPrompt: true });
    shouldReuploadSection.mockReturnValue(true);
    patchServerKey.mockClear();

    await useGenerationStore.getState().fetchPrefs();

    expect(patchServerKey).toHaveBeenCalled();
    const shape = patchServerKey.mock.calls[patchServerKey.mock.calls.length - 1][1] as Record<string, unknown>;
    expect(shape.showExactPrompt).toBe(true);
  });
});
