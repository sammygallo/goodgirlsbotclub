/**
 * @vitest-environment jsdom
 *
 * TakeSelfieModal — the mode/tier gating that keeps a request the backend
 * would 400/403 from ever being assembled. These are the rules with real
 * safety/UX weight (2026-08-23 review flagged the Studio ones as untested):
 *
 *   - Studio is disabled unless BOTH a fal key (canScene) AND a trained model
 *     (studioTrained) are present — a styling refactor that dropped the
 *     `lora: !canStudio` map entry would enable Studio for untrained
 *     characters and rain 403s.
 *   - Selecting Studio (or Scene) forces the tier back to SFW — NSFW for both
 *     is Phase B, and the backend rejects the combination.
 *   - Studio (like Scene) requires a prompt; Close-up does not.
 *   - The untrained-Studio upsell must not point a user without training
 *     permission at a section they can't see.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TakeSelfieModal } from './TakeSelfieModal';

// This repo doesn't wire @testing-library/jest-dom, so assert on plain DOM
// props (.disabled) and query presence (getByText throws if absent).

function renderModal(overrides: Partial<Parameters<typeof TakeSelfieModal>[0]> = {}) {
  const onGenerate = vi.fn();
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    characterName: 'Ivy',
    canNsfw: true,
    canScene: true,
    canCloseup: true,
    studioTrained: true,
    canTrainStudio: true,
    onGenerate,
    ...overrides,
  };
  render(<TakeSelfieModal {...props} />);
  return { onGenerate, props };
}

function modeButton(label: 'Close-up' | 'Scene' | 'Studio') {
  return screen.getByRole('button', { name: label });
}

describe('TakeSelfieModal — Studio (mode: lora) gating', () => {
  afterEach(() => cleanup());

  it('disables Studio when the character has no trained model', () => {
    renderModal({ studioTrained: false });
    expect((modeButton('Studio') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/train them under Character → Edit → Studio/i)).toBeTruthy();
  });

  it('disables Studio when there is no fal key, even if trained', () => {
    renderModal({ canScene: false, studioTrained: true });
    expect((modeButton('Studio') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Studio only with both a fal key and a trained model', () => {
    renderModal({ canScene: true, studioTrained: true });
    expect((modeButton('Studio') as HTMLButtonElement).disabled).toBe(false);
  });

  it('tells a user without training permission that Studio is unavailable, not to go train', () => {
    renderModal({ studioTrained: false, canTrainStudio: false });
    expect(screen.getByText(/Studio training isn't enabled for your account/i)).toBeTruthy();
    expect(screen.queryByText(/train them under Character → Edit/i)).toBeNull();
  });

  it('forces SFW and hides no-op NSFW when Studio is selected', async () => {
    const user = userEvent.setup();
    renderModal({ canNsfw: true, studioTrained: true });
    // Start on Close-up with the tier picker visible; pick NSFW, then Studio.
    await user.click(screen.getByRole('button', { name: 'nsfw' }));
    await user.click(modeButton('Studio'));
    // The nsfw button is now disabled (Studio forces SFW).
    expect((screen.getByRole('button', { name: 'nsfw' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/NSFW Studio selfies aren't available yet/i)).toBeTruthy();
  });

  it('requires a prompt for Studio and passes mode "lora" through on generate', async () => {
    const user = userEvent.setup();
    const { onGenerate } = renderModal({ studioTrained: true });
    await user.click(modeButton('Studio'));

    const generate = screen.getByRole('button', { name: /Generate/i });
    expect((generate as HTMLButtonElement).disabled).toBe(true); // empty prompt blocks Studio

    await user.type(
      screen.getByRole('textbox'),
      'walking through a night market in the rain',
    );
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    await user.click(generate);

    expect(onGenerate).toHaveBeenCalledWith(
      'walking through a night market in the rain',
      'sfw',
      'lora',
    );
  });

  it('leaves Close-up prompt optional (contrast with Studio)', async () => {
    const user = userEvent.setup();
    const { onGenerate } = renderModal({ canCloseup: true });
    // Default mode is Close-up; Generate is enabled with no prompt.
    const generate = screen.getByRole('button', { name: /Generate/i });
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    await user.click(generate);
    expect(onGenerate).toHaveBeenCalledWith('', 'sfw', 'closeup');
  });
});
