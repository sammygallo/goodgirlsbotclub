/**
 * `computeCaptureAttribution` (E2-S3, AC3) driven directly with synthetic
 * `PromptCapture` + `PromptBreakdown` pairs — plain node, no chatStore or DOM
 * involved. The only production callers (`UsagePage`, `PromptCaptureSheet`)
 * pass hand-built or store-derived values through props; nothing else in the
 * suite calls this function directly.
 */
import { describe, it, expect } from 'vitest';
import { createPromptCapture, computeCaptureAttribution } from './promptCapture';
import { createPromptBreakdown, addSlice } from './promptBreakdown';

function mkCapture(messages: unknown[], over: Partial<Parameters<typeof createPromptCapture>[0]> = {}) {
  return createPromptCapture({
    seam: 'send',
    messages,
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

function entry(role: string, len: number) {
  return { role, content: 'x'.repeat(len) };
}

describe('computeCaptureAttribution', () => {
  it('(a) clean solo shape: labels the joined Stage-A entry and each Stage-B entry in order', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    const capture = mkCapture([entry('system', 40), entry('user', 14)]);

    const attribution = computeCaptureAttribution(capture, breakdown);

    expect(attribution).toEqual([
      { index: 0, labels: ['main_prompt'] },
      { index: 1, labels: ['history (user)'] },
    ]);
  });

  it('(b) collapsedByInstruct: true → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    const capture = mkCapture([entry('user', 40)], { collapsedByInstruct: true });

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(c) replacedByInterceptor: true → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    const capture = mkCapture([entry('user', 40)], { replacedByInterceptor: true });

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(d) null breakdown → null', () => {
    const capture = mkCapture([entry('user', 40)]);

    expect(computeCaptureAttribution(capture, null)).toBeNull();
  });

  it('(e) entry count does not match the breakdown\'s slice count → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 20);
    // The breakdown accounts for THREE entries (Stage A + two Stage-B
    // slices); the capture only has two — one entry went missing.
    const capture = mkCapture([entry('system', 40), entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(f) group at-depth overflow, DISTINCT lengths: labels follow content length, not context position', () => {
    // Mirrors buildGroupConversationContext's overflow splice: the history
    // loop records its slice FIRST, then the author's-note overflow branch
    // splices its entry into `context` at index 1 (before the history
    // entry) and records its own slice AFTER — so slice order (history,
    // authors_note) and context order (authors_note, history) disagree.
    const breakdown = createPromptBreakdown('group');
    addSlice(breakdown, { stage: 'A', id: 'group_system_chrome' }, 10, 30);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 20);
    const capture = mkCapture([entry('system', 30), entry('system', 20), entry('user', 14)]);

    const attribution = computeCaptureAttribution(capture, breakdown);

    expect(attribution).toEqual([
      { index: 0, labels: ['group_system_chrome'] },
      { index: 1, labels: ['authors_note'] },
      { index: 2, labels: ['history (user)'] },
    ]);
  });

  it('(g) same shape with EQUAL lengths → null (ambiguous, cannot be told apart)', () => {
    const breakdown = createPromptBreakdown('group');
    addSlice(breakdown, { stage: 'A', id: 'group_system_chrome' }, 10, 30);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 14);
    const capture = mkCapture([entry('system', 30), entry('system', 14), entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(h) a non-{role,content} entry after index 0 → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    const capture = mkCapture([entry('system', 40), 'a bare string']);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(i) a call-site slice is present: the last entry is labelled', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'callSite', turn: 'continue' }, 6, 25);
    const capture = mkCapture([entry('system', 40), entry('user', 14), entry('user', 25)]);

    const attribution = computeCaptureAttribution(capture, breakdown);

    expect(attribution).toEqual([
      { index: 0, labels: ['main_prompt'] },
      { index: 1, labels: ['history (user)'] },
      { index: 2, labels: ['call_site_continue'] },
    ]);
  });
});
