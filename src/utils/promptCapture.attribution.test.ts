/**
 * `computeCaptureAttribution` (E2-S3, AC3) driven directly with synthetic
 * `PromptCapture` + `PromptBreakdown` pairs — plain node, no chatStore or DOM
 * involved. The only production callers (`UsagePage`, `PromptCaptureSheet`)
 * pass hand-built or store-derived values through props.
 */
import { describe, it, expect } from 'vitest';
import { createPromptCapture, computeCaptureAttribution } from './promptCapture';
import { createPromptBreakdown, addSlice, recordAttachments } from './promptBreakdown';

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

  it('(e) undercount: fewer entries than the breakdown\'s candidate slices → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 20);
    // The breakdown accounts for THREE entries (Stage A + two Stage-B
    // slices); the capture only has two — one entry went missing.
    const capture = mkCapture([entry('system', 40), entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(e2) overcount: more entries than the breakdown\'s candidate slices → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    // The breakdown accounts for TWO entries; the capture has three.
    const capture = mkCapture([entry('system', 40), entry('user', 14), entry('user', 5)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(f) ordinary chat with two equal-length HISTORY entries in slice order → labelled (kills R2-C1)', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 6);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'a1', role: 'assistant' }, 4, 6);
    const capture = mkCapture([entry('system', 40), entry('user', 6), entry('assistant', 6)]);

    const attribution = computeCaptureAttribution(capture, breakdown);

    expect(attribution).toEqual([
      { index: 0, labels: ['main_prompt'] },
      { index: 1, labels: ['history (user)'] },
      { index: 2, labels: ['history (assistant)'] },
    ]);
  });

  it('(g) splice rotation, distinct lengths: positional lengths disagree → null', () => {
    // Mirrors buildGroupConversationContext's overflow splice: the history
    // loop records its slice FIRST, then the author's-note overflow branch
    // splices its entry into `context` at index 1 (before the history
    // entry) and records its own slice AFTER — so slice order (history,
    // authors_note) and context order (authors_note, history) disagree, and
    // the position-i-to-slice-i check catches the length mismatch directly.
    const breakdown = createPromptBreakdown('group');
    addSlice(breakdown, { stage: 'A', id: 'group_system_chrome' }, 10, 30);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 20);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 14);
    const capture = mkCapture([entry('system', 30), entry('system', 14), entry('user', 20)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(g2) splice rotation, coincident lengths → null (rule 6: the authors_note slice\'s chars matches two entries)', () => {
    const breakdown = createPromptBreakdown('group');
    addSlice(breakdown, { stage: 'A', id: 'group_system_chrome' }, 10, 30);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 14);
    const capture = mkCapture([entry('system', 30), entry('user', 14), entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(g3) rule-6-only case (kills R2-C3): duplicated entry lengths against a non-history slice → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 2);
    addSlice(breakdown, { stage: 'B', cls: 'authors_note' }, 5, 2);
    const capture = mkCapture([entry('user', 2), entry('user', 2)]);

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

  it('(j) an attachments slice is present alongside an otherwise clean shape → labelled, not null (kills R2-C2)', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    recordAttachments(breakdown, [{ base64: 'aaaa' }]);
    const capture = mkCapture([entry('system', 40), entry('user', 14)], { imagesFolded: 1 });

    const attribution = computeCaptureAttribution(capture, breakdown);

    expect(attribution).toEqual([
      { index: 0, labels: ['main_prompt'] },
      { index: 1, labels: ['history (user)'] },
    ]);
  });

  it('(k) entry 0 is a bare string against a Stage-A + Stage-B breakdown → null (kills R2-P1)', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'A', id: 'main_prompt' }, 10, 40);
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 14);
    const capture = mkCapture(['a bare string', entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });

  it('(l) history role mismatch, same length → null', () => {
    const breakdown = createPromptBreakdown('solo');
    addSlice(breakdown, { stage: 'B', cls: 'history', messageId: 'a1', role: 'assistant' }, 4, 14);
    const capture = mkCapture([entry('user', 14)]);

    expect(computeCaptureAttribution(capture, breakdown)).toBeNull();
  });
});
