/**
 * @vitest-environment jsdom
 *
 * The toast container against an open Modal. useModalFocus makes everything in
 * #root inert while a Modal is open, and the HTML spec hit-tests an inert node
 * as if it had pointer-events: none, so a click on a toast painted ABOVE the
 * modal (z-200 over its z-100) would land on the modal's backdrop or buttons
 * beneath it. The container therefore lives outside the app root, in its own
 * `data-modal-exempt` container that the inert walk skips.
 *
 * jsdom ignores `inert`, so this asserts the attribute on the nodes the walk
 * reaches; whether a real click gets through is QA's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';
import { ToastProvider, useToast } from './Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function Page() {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => showToast('Saved', 'success')}>Toast</button>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="M">
        body
      </Modal>
    </>
  );
}

function mount() {
  const utils = render(
    <ToastProvider>
      <Page />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText('Toast'));
  return utils;
}

describe('the toast container', () => {
  it('is drawn in a container of its own on <body>, marked as exempt from a modal\'s inert walk', () => {
    const { container } = mount();
    const toast = screen.getByText('Saved');
    const holder = toast.closest('[data-modal-exempt]');
    expect(holder).not.toBeNull();
    expect(holder?.parentElement).toBe(document.body);
    expect(container.contains(holder)).toBe(false);
  });

  it('keeps its position and layer (fixed, z-200)', () => {
    mount();
    const stack = screen.getByText('Saved').parentElement!;
    expect(stack.className).toContain('fixed');
    expect(stack.className).toContain('z-[200]');
  });

  it('stays operable above an open Modal while the page behind it goes inert', () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Open'));

    expect(container.hasAttribute('inert')).toBe(true);
    expect(screen.getByText('Saved').closest('[inert]')).toBeNull();
  });

  it('removes its container along with the last toast', () => {
    mount();
    expect(document.body.querySelector('[data-modal-exempt]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(document.body.querySelector('[data-modal-exempt]')).toBeNull();
  });
});
