/**
 * E2-S2 task 4: `lastPromptBreakdownTag`, the object-identity guard
 * that lets `PromptBreakdownSheet` (task 6) tell "this is the breakdown for
 * MY message, at MY swipe" from "a later turn (or a later swipe of the SAME
 * message) replaced the slot" without a second store subscription racing the
 * first.
 *
 * `swipeIndex` joined the tag in review round 1 (M3/F6): `messageId` alone is
 * stable across every swipe of one AI message, so it cannot by itself
 * distinguish "this build" from "an earlier or later swipe's build of the
 * same message".
 */
import { describe, it, expect } from 'vitest';
import { useGenerationStore } from './generationStore';
import { createPromptBreakdown, type PromptBreakdown } from '../utils/promptBreakdown';

function reset() {
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
}

describe('tagLastBreakdownMessage', () => {
  it('writes the message id and swipe index when the breakdown is still the one in the slot', () => {
    reset();
    const b = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toEqual({
      messageId: 'msg-1',
      swipeIndex: 0,
    });
  });

  it('records a nonzero swipe index verbatim — swipeRight tags the swipe the build LANDS in, not swipe 0', () => {
    // KILLS: a fix that always writes swipeIndex 0 regardless of the argument
    // — that would satisfy every other test here (all use swipe 0) while
    // silently breaking swipeRight's call site, which passes the swipe the
    // generation is about to create.
    reset();
    const b = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1', 3);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toEqual({
      messageId: 'msg-1',
      swipeIndex: 3,
    });
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
    useGenerationStore.getState().tagLastBreakdownMessage(first, 'stale-msg', 0);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toBeNull();

    useGenerationStore.getState().tagLastBreakdownMessage(second, 'fresh-msg', 0);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toEqual({
      messageId: 'fresh-msg',
      swipeIndex: 0,
    });
  });

  it('is a no-op against a null slot', () => {
    reset();
    const b = createPromptBreakdown('solo');
    // Never published via setLastPromptBreakdown — the slot is still null.
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'orphan', 0);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toBeNull();
  });
});

describe('setLastPromptBreakdown', () => {
  it('resets the tag along with the breakdown', () => {
    reset();
    const b: PromptBreakdown = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1', 0);
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toEqual({
      messageId: 'msg-1',
      swipeIndex: 0,
    });

    // A fresh publish — even of a DIFFERENT breakdown — clears the old tag
    // rather than leaving it pointing at content that no longer matches.
    useGenerationStore.getState().setLastPromptBreakdown(createPromptBreakdown('group'));
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toBeNull();

    useGenerationStore.getState().setLastPromptBreakdown(null);
    expect(useGenerationStore.getState().lastPromptBreakdown).toBeNull();
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toBeNull();
  });
});

describe('resetUser', () => {
  it('clears both the breakdown and its tag', () => {
    reset();
    const b = createPromptBreakdown('solo');
    useGenerationStore.getState().setLastPromptBreakdown(b);
    useGenerationStore.getState().tagLastBreakdownMessage(b, 'msg-1', 0);
    useGenerationStore.getState().resetUser();
    expect(useGenerationStore.getState().lastPromptBreakdown).toBeNull();
    expect(useGenerationStore.getState().lastPromptBreakdownTag).toBeNull();
  });
});
