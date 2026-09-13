/**
 * @vitest-environment jsdom
 *
 * `PromptCaptureView` (E2-S3, AC2/AC3) and `PromptCaptureSheet`'s ownership
 * states.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PromptCaptureView } from './PromptCaptureView';
import { PromptCaptureSheet } from './PromptCaptureSheet';
import { useGenerationStore } from '../../stores/generationStore';
import { createPromptCapture, type PromptCapture, type CaptureAttribution } from '../../utils/promptCapture';
import { createPromptBreakdown, addSlice } from '../../utils/promptBreakdown';

afterEach(cleanup);

function mkCapture(over: Partial<Parameters<typeof createPromptCapture>[0]> = {}): PromptCapture {
  return createPromptCapture({
    seam: 'send',
    messages: [
      { role: 'system', content: 'SYSTEM BLOCK' },
      { role: 'user', content: 'hello there' },
    ],
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

describe('PromptCaptureView', () => {
  it('renders no transform notices on the plain path', () => {
    render(<PromptCaptureView capture={mkCapture()} attribution={null} />);
    expect(screen.queryByText(/collapsed this prompt/)).toBeNull();
    expect(screen.queryByText(/replaced this payload/)).toBeNull();
    expect(screen.queryByText(/Image attachments/)).toBeNull();
    expect(screen.queryByText(/Text completion mode/)).toBeNull();
  });

  it('renders each entry\'s role as its block header', () => {
    render(<PromptCaptureView capture={mkCapture()} attribution={null} />);
    expect(screen.getByText('system')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
  });

  it('shows the collapse notice when collapsedByInstruct is true', () => {
    render(<PromptCaptureView capture={mkCapture({ collapsedByInstruct: true })} attribution={null} />);
    expect(
      screen.getByText(
        /collapsed this prompt into a single user turn before it was sent\. Section attribution is unavailable — collapsed by instruct mode\./
      )
    ).toBeTruthy();
  });

  it('shows the interceptor-replacement notice when replacedByInterceptor is true', () => {
    render(<PromptCaptureView capture={mkCapture({ replacedByInterceptor: true })} attribution={null} />);
    expect(
      screen.getByText(
        /generate-interceptor replaced this payload before it was sent\. Section attribution is unavailable — payload was replaced\./
      )
    ).toBeTruthy();
  });

  it('shows both notices when both flags are true, and neither is hidden by the other', () => {
    render(
      <PromptCaptureView
        capture={mkCapture({ collapsedByInstruct: true, replacedByInterceptor: true })}
        attribution={null}
      />
    );
    expect(
      screen.getByText(
        /collapsed this prompt into a single user turn before it was sent\. Section attribution is unavailable — collapsed by instruct mode\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /generate-interceptor replaced this payload before it was sent\. Section attribution is unavailable — payload was replaced\./
      )
    ).toBeTruthy();
  });

  it('renders no image-attachments line when imagesFolded is 0', () => {
    render(<PromptCaptureView capture={mkCapture({ imagesFolded: 0 })} attribution={null} />);
    expect(screen.queryByText(/Image attachments/)).toBeNull();
  });

  it('renders the exact image-attachments line for a non-zero count', () => {
    render(<PromptCaptureView capture={mkCapture({ imagesFolded: 2 })} attribution={null} />);
    expect(
      screen.getByText('Image attachments handed to the provider client: 2 — not part of the captured array, not shown below.')
    ).toBeTruthy();
  });

  it('renders the image-attachments line for a single attachment', () => {
    render(<PromptCaptureView capture={mkCapture({ imagesFolded: 1 })} attribution={null} />);
    expect(
      screen.getByText('Image attachments handed to the provider client: 1 — not part of the captured array, not shown below.')
    ).toBeTruthy();
  });

  it('renders the same exact image-attachments line in text completion mode', () => {
    render(
      <PromptCaptureView
        capture={mkCapture({ imagesFolded: 2, textCompletionMode: true })}
        attribution={null}
      />
    );
    expect(
      screen.getByText('Image attachments handed to the provider client: 2 — not part of the captured array, not shown below.')
    ).toBeTruthy();
  });

  it('the image-attachments line makes no carried/fold/attribution claim', () => {
    const { container } = render(
      <PromptCaptureView capture={mkCapture({ imagesFolded: 2 })} attribution={null} />
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/carried/i);
    expect(text).not.toMatch(/fold/i);
    expect(text).not.toMatch(/attached to this message/i);
  });

  it('shows the text-completion notice when textCompletionMode is true', () => {
    render(<PromptCaptureView capture={mkCapture({ textCompletionMode: true })} attribution={null} />);
    expect(screen.getByText(/Text completion mode/)).toBeTruthy();
  });

  it('renders attribution labels beside each entry on the clean path', () => {
    const capture = mkCapture();
    const attribution: CaptureAttribution = [
      { index: 0, labels: ['main_prompt', 'persona_before_char'] },
      { index: 1, labels: ['history (user)'] },
    ];
    const { container } = render(<PromptCaptureView capture={capture} attribution={attribution} />);
    expect(screen.getByText(/main_prompt, persona_before_char/)).toBeTruthy();
    expect(screen.getByText(/history \(user\)/)).toBeTruthy();
    expect(container.textContent ?? '').toContain('main_prompt, persona_before_char');
  });

  it('does not render attribution labels when replacedByInterceptor is true, even if a non-null attribution is passed', () => {
    // The view checks the capture's own flags itself rather than trusting
    // the prop alone — a second line of defense alongside
    // `computeCaptureAttribution` already refusing to produce one for this
    // path.
    const capture = mkCapture({ replacedByInterceptor: true });
    const staleAttribution: CaptureAttribution = [{ index: 0, labels: ['main_prompt'] }];
    render(<PromptCaptureView capture={capture} attribution={staleAttribution} />);
    expect(screen.queryByText(/main_prompt/)).toBeNull();
  });

  it('does not render attribution labels when collapsedByInstruct is true, even if a non-null attribution is passed', () => {
    const capture = mkCapture({ collapsedByInstruct: true });
    const staleAttribution: CaptureAttribution = [{ index: 0, labels: ['main_prompt'] }];
    render(<PromptCaptureView capture={capture} attribution={staleAttribution} />);
    expect(screen.queryByText(/main_prompt/)).toBeNull();
  });

  it('renders an unrecognized array shape as JSON without throwing', () => {
    const capture = mkCapture({ messages: [{ foo: 'bar' }, 'a bare string', 42] });
    expect(() => render(<PromptCaptureView capture={capture} attribution={null} />)).not.toThrow();
    expect(screen.getByText(/"foo"/)).toBeTruthy();
  });

  it('renders an entry that carries a key beyond role and content as JSON, so the extra key is visible', () => {
    const capture = mkCapture({
      messages: [{ role: 'user', content: 'hi', name: 'moderator' }],
      replacedByInterceptor: true,
    });
    const { container } = render(<PromptCaptureView capture={capture} attribution={null} />);
    const text = container.textContent ?? '';
    expect(text).toContain('"name"');
    expect(text).toContain('moderator');
  });

  it('renders an empty array as JSON', () => {
    const capture = mkCapture({ messages: [], replacedByInterceptor: true });
    const { container } = render(<PromptCaptureView capture={capture} attribution={null} />);
    expect(container.textContent ?? '').toContain('[]');
  });

  it('renders an entry whose content is not a string as JSON without throwing', () => {
    const capture = mkCapture({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      replacedByInterceptor: true,
    });
    let container: HTMLElement | undefined;
    expect(() => {
      container = render(<PromptCaptureView capture={capture} attribution={null} />).container;
    }).not.toThrow();
    expect(container?.textContent ?? '').toContain('"type"');
  });

  it('renders a null element as JSON without throwing', () => {
    const capture = mkCapture({ messages: [null], replacedByInterceptor: true });
    let container: HTMLElement | undefined;
    expect(() => {
      container = render(<PromptCaptureView capture={capture} attribution={null} />).container;
    }).not.toThrow();
    expect(container?.textContent ?? '').toContain('null');
  });

  it('renders an entry whose role is not a string as JSON without throwing', () => {
    const capture = mkCapture({
      messages: [{ role: { n: 'user' }, content: 'hi' }],
      replacedByInterceptor: true,
    });
    let container: HTMLElement | undefined;
    expect(() => {
      container = render(<PromptCaptureView capture={capture} attribution={null} />).container;
    }).not.toThrow();
    expect(container?.textContent ?? '').toContain('"n"');
  });

  it('marks the header "(fallback)" when usedFallback is true (R5-C5)', () => {
    const capture = { ...mkCapture(), usedFallback: true };
    render(<PromptCaptureView capture={capture} attribution={null} />);
    expect(screen.getByText(/\(fallback\)/)).toBeTruthy();
  });

  it('does not mark the header "(fallback)" on the plain, non-fallback capture (R5-C5)', () => {
    render(<PromptCaptureView capture={mkCapture()} attribution={null} />);
    expect(screen.queryByText(/\(fallback\)/)).toBeNull();
  });

  it('renders the header\'s seam label and the provider/model pair the fallback marker qualifies (R6-C6)', () => {
    const capture = {
      ...mkCapture({ seam: 'swipe', provider: 'anthropic', model: 'claude-x' }),
      usedFallback: true,
    };
    const { container } = render(<PromptCaptureView capture={capture} attribution={null} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Seam: swipe');
    expect(text).toContain('anthropic/claude-x (fallback)');
    const capturedAtStr = new Date(capture.capturedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    expect(text).toContain(`Captured ${capturedAtStr}`);
  });

  it('renders the time string of the capture it was given, not of some other capture', () => {
    const fmt = (ms: number) =>
      new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const base = Date.UTC(2026, 0, 2, 15, 4, 5);
    const a = { ...mkCapture(), capturedAt: base };
    const b = { ...mkCapture(), capturedAt: base - 5000 };
    expect(fmt(a.capturedAt)).not.toBe(fmt(b.capturedAt));
    const ra = render(<PromptCaptureView capture={a} attribution={null} />);
    expect(ra.container.textContent ?? '').toContain(`Captured ${fmt(a.capturedAt)}`);
    cleanup();
    const rb = render(<PromptCaptureView capture={b} attribution={null} />);
    expect(rb.container.textContent ?? '').toContain(`Captured ${fmt(b.capturedAt)}`);
    expect(rb.container.textContent ?? '').not.toContain(`Captured ${fmt(a.capturedAt)}`);
  });
});

describe('PromptCaptureSheet ownership states', () => {
  beforeEach(() => {
    useGenerationStore.setState({
      lastPromptCapture: null,
      lastPromptCaptureTag: null,
      lastPromptBreakdown: null,
      lastPromptBreakdownTag: null,
      showExactPrompt: true,
    });
  });

  it('shows the off-state copy when showExactPrompt is false and nothing is captured', () => {
    useGenerationStore.setState({ showExactPrompt: false });
    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m1" swipeIndex={0} />);
    expect(screen.getByText(/Exact prompt capture is off/)).toBeTruthy();
  });

  it('shows "nothing captured yet" when the toggle is on but nothing has generated', () => {
    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m1" swipeIndex={0} />);
    expect(screen.getByText(/No prompt captured yet this session/)).toBeTruthy();
  });

  it('renders the capture when the tag matches this message/swipe', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'm1', 0);
    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m1" swipeIndex={0} />);
    expect(screen.getByText(/Seam:/)).toBeTruthy();
  });

  it('shows "no longer available" when a capture exists but nothing tagged it', () => {
    useGenerationStore.getState().setLastPromptCapture(mkCapture({ seam: 'impersonate' }));
    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m1" swipeIndex={0} />);
    expect(screen.getByText(/no longer available for this turn/)).toBeTruthy();
    expect(screen.queryByText(/Seam:/)).toBeNull();
  });

  it('shows "no longer available" when the tag names a different message/swipe', () => {
    const c = mkCapture();
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'm1', 0);
    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m2" swipeIndex={0} />);
    expect(screen.getByText(/no longer available for this turn/)).toBeTruthy();
  });

  it('attributes using the capture\'s OWN breakdown, not the independently-tagged lastPromptBreakdown slot (R2-C11)', () => {
    const captureBreakdown = createPromptBreakdown('solo');
    addSlice(captureBreakdown, { stage: 'A', id: 'main_prompt' }, 10, 12);
    addSlice(captureBreakdown, { stage: 'B', cls: 'history', messageId: 'u1', role: 'user' }, 4, 5);
    const c = mkCapture({
      messages: [
        { role: 'system', content: 'x'.repeat(12) },
        { role: 'user', content: 'x'.repeat(5) },
      ],
      breakdown: captureBreakdown,
    });
    useGenerationStore.getState().setLastPromptCapture(c);
    useGenerationStore.getState().tagLastPromptCaptureMessage(c.id, 'm1', 0);

    // A DIFFERENT breakdown, same slice lengths, sitting in the
    // independently-tagged lastPromptBreakdown slot.
    const foreignBreakdown = createPromptBreakdown('solo');
    addSlice(foreignBreakdown, { stage: 'A', id: 'persona_before_char' }, 10, 12);
    addSlice(foreignBreakdown, { stage: 'B', cls: 'authors_note' }, 4, 5);
    useGenerationStore.setState({ lastPromptBreakdown: foreignBreakdown });

    render(<PromptCaptureSheet isOpen={true} onClose={() => {}} messageId="m1" swipeIndex={0} />);

    expect(screen.getByText(/main_prompt/)).toBeTruthy();
    expect(screen.queryByText(/persona/)).toBeNull();
    expect(screen.queryByText(/authors_note/)).toBeNull();
  });
});
