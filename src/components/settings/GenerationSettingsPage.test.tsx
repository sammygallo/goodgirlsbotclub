/**
 * @vitest-environment jsdom
 *
 * The Show-exact-prompt checkbox (E2-S3, AC5) — the only UI control that
 * writes `generationStore.showExactPrompt` (review round 6, R6-C7): before
 * this file, `GenerationSettingsPage` had zero render coverage, so neither
 * half of the control (`checked={showExactPrompt}` / `onChange`) was
 * exercised.
 *
 * No special mock prelude needed — same reasoning as UsagePage.test.tsx:
 * jsdom provides a real `localStorage`, so generationStore's module-level
 * read succeeds without stubbing.
 *
 * This repo doesn't wire @testing-library/jest-dom, so assert on plain DOM
 * properties (`.checked`) rather than `toBeChecked` — same convention as
 * GenerateSceneModal.test.tsx / TakeSelfieModal.test.tsx.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { GenerationSettingsPage } from './GenerationSettingsPage';
import { useGenerationStore } from '../../stores/generationStore';
import { createPromptCapture } from '../../utils/promptCapture';

afterEach(() => {
  cleanup();
  useGenerationStore.setState({
    showExactPrompt: false,
    lastPromptCapture: null,
    lastPromptCaptureTag: null,
  });
});

function renderOnPromptsTab() {
  render(<GenerationSettingsPage />);
  fireEvent.click(screen.getByText('Prompts'));
}

function sentinelCapture() {
  return createPromptCapture({
    seam: 'send',
    messages: [{ role: 'user', content: 'hello there' }],
    collapsedByInstruct: false,
    replacedByInterceptor: false,
    provider: 'openai',
    model: 'gpt-4o',
    textCompletionMode: false,
    imagesFolded: 0,
    characterName: 'Ivy',
    breakdown: null,
  });
}

describe('GenerationSettingsPage — the Show-exact-prompt checkbox (R6-C7)', () => {
  it('is unchecked by default', () => {
    useGenerationStore.setState({ showExactPrompt: false });
    renderOnPromptsTab();
    expect((screen.getByLabelText('Show exact prompt') as HTMLInputElement).checked).toBe(false);
  });

  it('renders checked when the store already has it on', () => {
    useGenerationStore.setState({ showExactPrompt: true });
    renderOnPromptsTab();
    expect((screen.getByLabelText('Show exact prompt') as HTMLInputElement).checked).toBe(true);
  });

  it('clicking it writes showExactPrompt to the store', () => {
    useGenerationStore.setState({ showExactPrompt: false });
    renderOnPromptsTab();

    fireEvent.click(screen.getByLabelText('Show exact prompt'));

    expect(useGenerationStore.getState().showExactPrompt).toBe(true);
  });

  it('clicking it again turns it back off and clears a seeded capture', () => {
    useGenerationStore.setState({ showExactPrompt: true, lastPromptCapture: sentinelCapture() });
    renderOnPromptsTab();

    fireEvent.click(screen.getByLabelText('Show exact prompt'));

    expect(useGenerationStore.getState().showExactPrompt).toBe(false);
    expect(useGenerationStore.getState().lastPromptCapture).toBeNull();
  });
});
