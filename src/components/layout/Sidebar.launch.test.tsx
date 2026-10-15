/**
 * @vitest-environment jsdom
 *
 * Surfaces launched from the drawer (D-E6S3-1). Layering puts Modal (z 100)
 * beneath the open drawer (z 1000), so a launched surface closes the drawer. It
 * must do that AFTER the surface has pushed onto useModalFocus's stack: the
 * hook then moves the surface's return focus from the drawer's own button,
 * which is about to be hidden, to the drawer's opener, the menu button.
 *
 * The host is a menu button next to a real Sidebar, with the real Modals. A Modal
 * has one of two timings, and each gets its own cases: About and Resume draft
 * mount theirs already open (Resume draft remounts its form to re-seed it), so
 * it pushes in the same commit as the click; Import's Modal is already mounted
 * and flips `isOpen`, so it pushes a commit later. Every case ends with Escape on
 * the Modal and asks where focus is and whether anything is still inert.
 *
 * The interviews are not Modals and never enter the stack: nothing pushes, so
 * the drawer's own cleanup returns focus to the menu button. jsdom ignores
 * `inert`, so "nothing is inert" is asserted on the attribute. `localStorage`
 * is an in-memory stub (under Node 25 the global is Node's experimental one).
 */
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CharacterInfo } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterInterviewStore } from '../../stores/characterInterviewStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { usePersonaStore } from '../../stores/personaStore';
import { useProjectStore } from '../../stores/projectStore';
import { Sidebar } from './Sidebar';

vi.mock('../../utils/haptics', () => ({ haptic: vi.fn(), hapticMedium: vi.fn() }));

const initial = {
  character: useCharacterStore.getState(),
  interview: useCharacterInterviewStore.getState(),
  chat: useChatStore.getState(),
  auth: useAuthStore.getState(),
  persona: usePersonaStore.getState(),
  project: useProjectStore.getState(),
};

const ivy = {
  name: 'Ivy',
  avatar: 'ivy.png',
  first_mes: 'hi',
  creator_notes: 'Ivy keeps the shop. She is kind.',
} as CharacterInfo;
const rose = { name: 'Rose', avatar: 'rose.png', first_mes: 'hello' } as CharacterInfo;

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

let closes: number;

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" aria-label="Open menu" aria-expanded={open} aria-controls="app-drawer" onClick={() => setOpen(true)}>
        Menu
      </button>
      <Sidebar
        isOpen={open}
        onClose={() => {
          closes += 1;
          setOpen(false);
        }}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  closes = 0;
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  useAuthStore.setState({ currentUser: { handle: 'u', name: 'U', role: 'contributor', permissions: [] } as never });
  useCharacterStore.setState({
    characters: [ivy, rose],
    charactersLoaded: true,
    isLoading: false,
    selectedCharacter: null,
    groupChatCharacters: [],
    isGroupChatMode: false,
    favorites: new Set(),
    searchQuery: '',
    selectedTags: new Set(),
    showFavoritesOnly: false,
    sortMode: 'name',
    manualDraft: null,
    fetchCharacters: vi.fn(async () => {}),
    loadManualDraft: vi.fn(async () => {}),
  });
  useCharacterInterviewStore.setState({ resumableDraft: null, loadDraft: vi.fn(async () => {}) });
  useChatStore.setState({ groupChats: [], isSending: false, isStreaming: false });
  usePersonaStore.setState({ personas: [], activePersonaId: null });
  useProjectStore.setState({ items: [], isOpen: false, fetchProjects: vi.fn(async () => {}) });
});

afterEach(() => {
  cleanup();
  useCharacterStore.setState(initial.character, true);
  useCharacterInterviewStore.setState(initial.interview, true);
  useChatStore.setState(initial.chat, true);
  useAuthStore.setState(initial.auth, true);
  usePersonaStore.setState(initial.persona, true);
  useProjectStore.setState(initial.project, true);
  vi.unstubAllGlobals();
});

const menuButton = () => screen.getByRole('button', { name: 'Open menu' });
const drawerRoot = () => document.getElementById('app-drawer') as HTMLElement;
const anythingInert = () => document.querySelector('[inert]');

/** Opens the drawer the way a user does: focus on the menu button, then a click. */
async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  const menu = menuButton();
  menu.focus();
  await user.click(menu);
  expect(menu.getAttribute('aria-expanded')).toBe('true');
  return menu;
}

/** After a launch: the drawer is closed (then hidden), and the launched surface is what the user sees. */
async function expectDrawerClosed(menu: HTMLElement) {
  await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
  await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(true));
}

describe('a Modal that mounts already open (About, Resume draft)', () => {
  it('closes the drawer, and Escape on the Modal returns focus to the menu button', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: 'About Ivy' }));
    expect(await screen.findByRole('dialog', { name: 'Ivy' })).toBeTruthy();
    await expectDrawerClosed(menu);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ivy' })).toBeNull());
    expect(anythingInert()).toBeNull();
  });

  it('does the same from the current-chat card\'s About', async () => {
    const user = userEvent.setup();
    useCharacterStore.setState({ selectedCharacter: ivy });
    render(<Host />);
    const menu = await openDrawer(user);

    const card = screen.getByRole('region', { name: 'Current chat' });
    await user.click(within(card).getByRole('button', { name: 'About Ivy' }));
    expect(await screen.findByRole('dialog', { name: 'Ivy' })).toBeTruthy();
    await expectDrawerClosed(menu);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    expect(anythingInert()).toBeNull();
  });

  it('lets one Escape close the Modal, and a second change nothing', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);
    await user.click(screen.getByRole('button', { name: 'About Ivy' }));
    await screen.findByRole('dialog', { name: 'Ivy' });
    await expectDrawerClosed(menu);
    const closesAfterLaunch = closes;

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ivy' })).toBeNull());
    await user.keyboard('{Escape}');

    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    expect(closes).toBe(closesAfterLaunch);
  });

  it('Resume draft: closes the drawer, and Escape on the Modal returns focus to the menu button', async () => {
    const user = userEvent.setup();
    useCharacterStore.setState({ manualDraft: { payload: { formData: { name: 'Draft Ivy' } } } as never });
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: /^Resume draft:/ }));
    expect(await screen.findByRole('dialog', { name: 'Create Character' })).toBeTruthy();
    await expectDrawerClosed(menu);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    expect(anythingInert()).toBeNull();
  });
});

describe('a Modal that mounts one commit after isOpen (Import)', () => {
  it('Import: closes the drawer, and Escape on the Modal returns focus to the menu button', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: 'Import character' }));
    expect(await screen.findByRole('dialog', { name: 'Import Character' })).toBeTruthy();
    await expectDrawerClosed(menu);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import Character' })).toBeNull());
    expect(anythingInert()).toBeNull();
  });
});

describe('an overlay that is not a Modal (the interviews)', () => {
  it('New: shows the interview, closes the drawer, leaves focus on the menu button and nothing inert', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: 'New character' }));
    expect(await screen.findByRole('heading', { name: 'Create a character — interview' })).toBeTruthy();
    await expectDrawerClosed(menu);

    expect(document.activeElement).toBe(menu);
    expect(anythingInert()).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', { name: 'Create a character — interview' })).toBeTruthy();
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  it('New persona: shows the wizard and closes the drawer', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: 'Persona: none' }));
    await user.click(screen.getByRole('button', { name: 'New Persona' }));
    expect(await screen.findByRole('heading', { name: 'Create a persona — interview' })).toBeTruthy();
    await expectDrawerClosed(menu);
    expect(document.activeElement).toBe(menu);
    expect(anythingInert()).toBeNull();
  });
});

describe('a persona surface', () => {
  it('Manage Personas: closes the drawer, and Escape on the Modal returns focus to the menu button', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);

    await user.click(screen.getByRole('button', { name: 'Persona: none' }));
    await user.click(screen.getByRole('button', { name: 'Manage Personas' }));
    expect(await screen.findByRole('dialog', { name: 'Personas' })).toBeTruthy();
    await expectDrawerClosed(menu);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Personas' })).toBeNull());
    expect(anythingInert()).toBeNull();
  });
});

describe('afterwards', () => {
  it('lets the drawer be opened again and stay open once the launched surface is gone', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const menu = await openDrawer(user);
    await user.click(screen.getByRole('button', { name: 'About Ivy' }));
    await screen.findByRole('dialog', { name: 'Ivy' });
    await expectDrawerClosed(menu);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ivy' })).toBeNull());

    await openDrawer(user);
    await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(false));
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement && drawerRoot().contains(document.activeElement)).toBe(true);
  });
});
