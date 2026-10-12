/**
 * @vitest-environment jsdom
 *
 * The docked onboarding chip against an open Modal. The chip floats above the
 * page (z-110 over a Modal's z-100) so the user can carry on setting things up
 * in the Settings panel; useModalFocus makes everything in #root inert while a
 * Modal is open, and a click on an inert control lands on the modal's backdrop
 * beneath it. So the chip is drawn through a `data-modal-exempt` container on
 * <body>, outside the branch the inert walk reaches.
 *
 * jsdom ignores `inert`, so this asserts the attribute on the nodes the walk
 * reaches; whether a real click gets through is QA's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { Modal } from '../ui/Modal';
import { OnboardingWalkthrough } from './OnboardingWalkthrough';

// The global `localStorage` is an inert object under this runner, even in jsdom,
// and the onboarding store reads it as it loads: a working one has to exist
// before the imports above are evaluated (vi.hoisted runs ahead of them).
vi.hoisted(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  });
});

const initial = {
  onboarding: useOnboardingStore.getState(),
  settings: useSettingsPanelStore.getState(),
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  useOnboardingStore.setState(initial.onboarding, true);
  useSettingsPanelStore.setState(initial.settings, true);
});

const dock = (currentStep = 2) => useOnboardingStore.setState({ isOpen: false, isDocked: true, currentStep });
const chipButton = () => screen.getByRole('button', { name: 'Return to setup walkthrough' });

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="M">
        body
      </Modal>
      <OnboardingWalkthrough />
    </>
  );
}

describe('the docked chip', () => {
  it('is drawn in a container of its own on <body>, marked as exempt from a modal\'s inert walk', () => {
    dock();
    const { container } = render(<OnboardingWalkthrough />);
    const holder = chipButton().closest('[data-modal-exempt]');
    expect(holder).not.toBeNull();
    expect(holder?.parentElement).toBe(document.body);
    expect(container.contains(holder)).toBe(false);
  });

  it('keeps its position and layer (fixed, z-110)', () => {
    dock();
    render(<OnboardingWalkthrough />);
    const chip = chipButton().parentElement!;
    expect(chip.className).toContain('fixed');
    expect(chip.className).toContain('z-[110]');
  });

  it('stays operable above an open Modal while the page behind it goes inert', () => {
    dock();
    const { container } = render(<Page />);
    fireEvent.click(screen.getByText('Open'));

    expect(container.hasAttribute('inert')).toBe(true);
    expect(chipButton().closest('[inert]')).toBeNull();
  });

  it('still works through the portal: Continue returns to the walkthrough and advances it', () => {
    dock(2);
    render(<OnboardingWalkthrough />);
    fireEvent.click(chipButton());

    const state = useOnboardingStore.getState();
    expect(state.isDocked).toBe(false);
    expect(state.currentStep).toBe(3);
  });

  it('is the only part of the walkthrough that is exempt: the full dialog stays in the page', () => {
    useOnboardingStore.setState({ isOpen: true, isDocked: false, currentStep: 0 });
    render(<OnboardingWalkthrough />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.body.querySelector('[data-modal-exempt]')).toBeNull();
  });

  it('leaves nothing on <body> once it is no longer docked', () => {
    dock();
    const { unmount } = render(<OnboardingWalkthrough />);
    expect(document.body.querySelector('[data-modal-exempt]')).not.toBeNull();
    unmount();
    expect(document.body.querySelector('[data-modal-exempt]')).toBeNull();
  });
});
