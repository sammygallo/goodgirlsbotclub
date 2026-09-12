/**
 * `createPromptCapture`'s snapshot contract (E2-S3): the array handed in is
 * copied before freezing, the copy is deep-frozen, and the caller's live
 * array is left untouched — see `snapshotMessages`'s own doc comment for why.
 */
import { describe, it, expect } from 'vitest';
import { createPromptCapture } from './promptCapture';

function mkParams(messages: unknown) {
  return {
    seam: 'send' as const,
    messages,
    collapsedByInstruct: false,
    replacedByInterceptor: false,
    provider: 'openai',
    model: 'gpt-4o',
    textCompletionMode: false,
    imagesFolded: 0,
    characterName: 'Ivy',
    breakdown: null,
  };
}

describe('createPromptCapture — snapshot semantics', () => {
  it('the capture is unaffected by a later mutation of the live array', () => {
    const live = [{ role: 'user', content: 'before' }];
    const capture = createPromptCapture(mkParams(live));

    live[0].content = 'after';

    expect((capture.messages[0] as { content: string }).content).toBe('before');
  });

  it('the live array itself is never frozen', () => {
    const live = [{ role: 'user', content: 'hi' }];
    createPromptCapture(mkParams(live));

    expect(Object.isFrozen(live)).toBe(false);
  });

  it('the capture array is frozen, including nested entries', () => {
    const live = [{ role: 'user', content: 'hi' }];
    const capture = createPromptCapture(mkParams(live));

    expect(Object.isFrozen(capture.messages)).toBe(true);
    expect(Object.isFrozen(capture.messages[0])).toBe(true);
  });

  it('a circular structure does not throw — the capture falls back to the original reference', () => {
    const live: Record<string, unknown>[] = [{ role: 'user', content: 'hi' }];
    live[0].self = live;

    expect(() => createPromptCapture(mkParams(live))).not.toThrow();
  });
});
