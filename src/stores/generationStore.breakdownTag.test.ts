/**
 * E2-S2 task 4: `lastPromptBreakdownMessageId`, the object-identity guard
 * that lets `PromptBreakdownSheet` (task 6) tell "this is the breakdown for
 * MY message" from "a later turn replaced the slot" without a second store
 * subscription racing the first.
 */
import { describe, it, expect } from 'vitest';
import { useGenerationStore } from './generationStore';
import { createPromptBreakdown, type PromptBreakdown } from '../utils/promptBreakdown';

function reset() {
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownMessageId: null });
}

describe('tagLastBreakdownMessage', () => {
  it('writes the message id when the breakdown is still the one in the slot', () => {
    reset();
    const b = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1');
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBe('msg-1');
  });

  it('no-ops when a concurrent turn already replaced the slot', () => {
    // KILLS: tagging by equality (`===` on a fresh createPromptBreakdown('solo')
    // result would differ by reference but could look equal if compared by
    // value) or unconditionally — either would mis-tag the SECOND build with
    // the FIRST call site's message id, the exact race a group round hits
    // (generateGroupTurn publishes once per speaker, sequentially).
    reset();
    const first = createPromptBreakdown('solo');
    const second = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(first);
    // The slot moves on before the first call site's tag call lands.
    useGenerationStore.getState().setLastPromptBreakdown(second);
    useGenerationStore.getState().tagLastBreakdownMessage(first, 'stale-msg');
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBeNull();

    useGenerationStore.getState().tagLastBreakdownMessage(second, 'fresh-msg');
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBe('fresh-msg');
  });

  it('is a no-op against a null slot', () => {
    reset();
    const b = createPromptBreakdown('solo');
    // Never published via setLastPromptBreakdown — the slot is still null.
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'orphan');
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBeNull();
  });
});

describe('setLastPromptBreakdown', () => {
  it('resets the tagged message id along with the breakdown', () => {
    reset();
    const b: PromptBreakdown = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1');
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBe('msg-1');

    // A fresh publish — even of a DIFFERENT breakdown — clears the old tag
    // rather than leaving it pointing at content that no longer matches.
    useGenerationStore.getState().setLastPromptBreakdown(createPromptBreakdown('group'));
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBeNull();

    useGenerationStore.getState().setLastPromptBreakdown(null);
    expect(useGenerationStore.getState().lastPromptBreakdown).toBeNull();
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBeNull();
  });
});

describe('resetUser', () => {
  it('clears both the breakdown and its tag', () => {
    reset();
    const b = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1');
    useGenerationStore.getState().resetUser();
    expect(useGenerationStore.getState().lastPromptBreakdown).toBeNull();
    expect(useGenerationStore.getState().lastPromptBreakdownMessageId).toBeNull();
  });
});
