/**
 * @vitest-environment jsdom
 *
 * PersonaSelector's two variants and what the drawer (E6-S3) needs from it:
 * the row names the active persona and opens upward, Escape closes only its
 * list, it reports whether a surface it launched is open (D-E6S3-1), and a
 * Modal it launches hands focus back to the trigger rather than to nothing.
 *
 * The persona store is the real one with the list seeded through setState; the
 * manager is the real PersonaManager/Modal and the wizard the real
 * PersonaInterview, left on its intro screen. The store persists to
 * `localStorage`, so each test installs an in-memory one (under Node 25 the
 * global is Node's experimental one, which jsdom does not replace).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePersonaStore, type Persona } from '../../stores/personaStore';
import { PersonaSelector } from './PersonaSelector';

const initial = usePersonaStore.getState();

const persona = (id: string, name: string): Persona => ({
  id,
  name,
  description: '',
  descriptionPosition: 'in_prompt',
  descriptionDepth: 4,
  descriptionRole: 'system',
  createdAt: 0,
  updatedAt: 0,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  usePersonaStore.setState({ personas: [persona('p1', 'Ivy'), persona('p2', 'Rose')], activePersonaId: 'p1' });
});

afterEach(() => {
  cleanup();
  usePersonaStore.setState(initial, true);
  vi.unstubAllGlobals();
});

const rowTrigger = () => screen.getByRole('button', { name: /^Persona: / });

describe('variants', () => {
  it('keeps the compact icon button, named "Persona selector", by default', () => {
    render(<PersonaSelector />);
    expect(screen.getByRole('button', { name: 'Persona selector' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Persona: / })).toBeNull();
  });

  it('names the row for the active persona, and for none', () => {
    const { unmount } = render(<PersonaSelector variant="row" />);
    expect(rowTrigger().getAttribute('aria-label')).toBe('Persona: Ivy');
    unmount();

    usePersonaStore.setState({ activePersonaId: null });
    render(<PersonaSelector variant="row" />);
    expect(rowTrigger().getAttribute('aria-label')).toBe('Persona: none');
  });

  it('shows the row\'s list on a click, with aria-expanded following it', async () => {
    const user = userEvent.setup();
    render(<PersonaSelector variant="row" />);
    expect(rowTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Manage Personas' })).toBeNull();

    await user.click(rowTrigger());
    expect(rowTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Manage Personas' })).toBeTruthy();
  });

  it('opens the row\'s list upward, above its trigger', async () => {
    const user = userEvent.setup();
    render(<PersonaSelector variant="row" />);
    await user.click(rowTrigger());
    const manage = screen.getByRole('button', { name: 'Manage Personas' });
    expect(manage.closest('.bottom-full')).not.toBeNull();
  });
});

describe('Escape on the row', () => {
  it('closes the open list, returns focus to the trigger, and does not reach a document-level handler', async () => {
    const user = userEvent.setup();
    const atDocument = vi.fn();
    document.addEventListener('keydown', atDocument);
    try {
      render(<PersonaSelector variant="row" />);
      await user.click(rowTrigger());
      await user.keyboard('{Escape}');

      expect(rowTrigger().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(rowTrigger());
      expect(atDocument).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', atDocument);
    }
  });

  it('lets Escape through to the document when no list is open', async () => {
    const user = userEvent.setup();
    const atDocument = vi.fn();
    document.addEventListener('keydown', atDocument);
    try {
      render(<PersonaSelector variant="row" />);
      rowTrigger().focus();
      await user.keyboard('{Escape}');

      expect(atDocument).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', atDocument);
    }
  });
});

describe('onSurfaceOpenChange', () => {
  const reports = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => c[0]);

  it('reports false at first, true while the manager is open, and false once it closes', async () => {
    const user = userEvent.setup();
    const report = vi.fn();
    render(<PersonaSelector variant="row" onSurfaceOpenChange={report} />);
    expect(reports(report)).toEqual([false]);

    await user.click(rowTrigger());
    await user.click(screen.getByRole('button', { name: 'Manage Personas' }));
    expect(reports(report)).toEqual([false, true]);

    await user.keyboard('{Escape}');
    expect(reports(report)).toEqual([false, true, false]);
  });

  it('reports the wizard and the simple form it hands over to as one continuous surface', async () => {
    const user = userEvent.setup();
    const report = vi.fn();
    render(<PersonaSelector variant="row" onSurfaceOpenChange={report} />);

    await user.click(rowTrigger());
    await user.click(screen.getByRole('button', { name: 'New Persona' }));
    expect(screen.getByRole('heading', { name: 'Create a persona — interview' })).toBeTruthy();
    expect(reports(report)).toEqual([false, true]);

    await user.click(screen.getByRole('button', { name: 'Use the simple form instead' }));
    expect(screen.getByRole('dialog', { name: 'Create Persona' })).toBeTruthy();
    expect(reports(report)).toEqual([false, true]);

    await user.keyboard('{Escape}');
    expect(reports(report)).toEqual([false, true, false]);
  });

  it('reports a manager reopened after it closed', async () => {
    const user = userEvent.setup();
    const report = vi.fn();
    render(<PersonaSelector variant="row" onSurfaceOpenChange={report} />);

    for (let i = 0; i < 2; i++) {
      await user.click(rowTrigger());
      await user.click(screen.getByRole('button', { name: 'Manage Personas' }));
      await user.keyboard('{Escape}');
    }
    expect(reports(report)).toEqual([false, true, false, true, false]);
  });
});

describe('focus after a launched Modal closes', () => {
  it('is on the trigger after Manage Personas and Escape', async () => {
    const user = userEvent.setup();
    render(<PersonaSelector variant="row" />);

    await user.click(rowTrigger());
    await user.click(screen.getByRole('button', { name: 'Manage Personas' }));
    expect(screen.getByRole('dialog', { name: 'Personas' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowTrigger());
  });

  it('is on the trigger after choosing a persona from the list', async () => {
    const user = userEvent.setup();
    render(<PersonaSelector variant="row" />);

    await user.click(rowTrigger());
    await user.click(screen.getByRole('button', { name: /Rose/ }));
    expect(usePersonaStore.getState().activePersonaId).toBe('p2');
    expect(document.activeElement).toBe(rowTrigger());
  });
});
