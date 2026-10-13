/**
 * @vitest-environment jsdom
 *
 * D-G6. jsdom has no matchMedia, so these tests install a controllable one.
 * What is pinned: the exact media query (a typo here would read as "never
 * reduced" and silently ship rotating carousels to people who asked for none),
 * liveness (the OS setting can flip while the app is open), and clean
 * unsubscription.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

function Probe() {
  return <span data-testid="probe">{String(usePrefersReducedMotion())}</span>;
}

const original = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = original;
});

function installMatchMedia(initial: boolean) {
  let reduced = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return reduced && query === '(prefers-reduced-motion: reduce)';
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  return {
    queries,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      reduced = next;
      listeners.forEach((l) => l());
    },
  };
}

describe('usePrefersReducedMotion', () => {
  it('is false where matchMedia does not exist, and does not throw', () => {
    // @ts-expect-error simulating the jsdom / ancient-browser case
    window.matchMedia = undefined;
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('reads the OS preference on first render', () => {
    installMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });

  it('asks for exactly prefers-reduced-motion: reduce', () => {
    const mm = installMatchMedia(false);
    render(<Probe />);
    expect(new Set(mm.queries)).toEqual(new Set(['(prefers-reduced-motion: reduce)']));
  });

  it('is false when the user has not asked for reduced motion', () => {
    installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('follows the setting when it changes while mounted', () => {
    const mm = installMatchMedia(false);
    render(<Probe />);
    act(() => mm.set(true));
    expect(screen.getByTestId('probe').textContent).toBe('true');
    act(() => mm.set(false));
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('stops listening on unmount', () => {
    const mm = installMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });
});
