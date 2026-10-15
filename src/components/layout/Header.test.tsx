/**
 * @vitest-environment jsdom
 *
 * The header after E6-S3 (D-S10): the menu button at every width, the identity
 * of what is open in the middle, and Guides and Help on the right. The account
 * items moved into the drawer's Personal block, so none of them may come back.
 *
 * Help and the character editor are marker stubs, so these tests see the header
 * alone. `localStorage` is replaced before any app module loads, as in
 * MainLayout.test.tsx: the persona store reads it when it is imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CharacterInfo } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { Header } from './Header';

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
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  });
});

vi.mock('../help/HelpChat', () => ({
  HelpChat: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="help-chat-stub" /> : null),
}));
vi.mock('../character/CharacterEdit', () => ({
  CharacterEdit: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="character-edit-stub" /> : null),
}));

const initial = {
  auth: useAuthStore.getState(),
  character: useCharacterStore.getState(),
  guides: useGuidesPanelStore.getState(),
};

const ivy = { name: 'Ivy', avatar: 'ivy.png', first_mes: 'hi', tags: [] } as CharacterInfo;

function signIn(role: 'end_user' | 'contributor' | 'owner') {
  useAuthStore.setState({ currentUser: { handle: 'u', name: 'U', role } as never });
}

function renderHeader(menuOpen = false) {
  const onMenuClick = vi.fn();
  const ui = (open: boolean) => <Header onMenuClick={onMenuClick} menuOpen={open} />;
  const utils = render(ui(menuOpen));
  return { ...utils, onMenuClick, setMenuOpen: (open: boolean) => utils.rerender(ui(open)) };
}

/** The accessible names of every button in the header, in DOM order. */
const headerButtons = () =>
  within(screen.getByRole('banner'))
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));

beforeEach(() => {
  useCharacterStore.setState({ selectedCharacter: null });
  useGuidesPanelStore.setState({ isOpen: false });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(initial.auth, true);
  useCharacterStore.setState(initial.character, true);
  useGuidesPanelStore.setState(initial.guides, true);
});

describe('the menu button', () => {
  it('is named Open menu and controls the drawer by its id', () => {
    renderHeader();
    const menu = screen.getByRole('button', { name: 'Open menu' });
    expect(menu.getAttribute('aria-controls')).toBe('app-drawer');
  });

  it('reports in aria-expanded whether the drawer it opens is open', () => {
    const { setMenuOpen } = renderHeader(false);
    const menu = screen.getByRole('button', { name: 'Open menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');

    setMenuOpen(true);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
  });

  it('has no hidden class at any breakpoint', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Open menu' }).className).not.toContain('hidden');
  });

  it('takes focus on a click, even when nothing had focus before', () => {
    const { onMenuClick } = renderHeader();
    const menu = screen.getByRole('button', { name: 'Open menu' });
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(menu);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(menu);
  });
});

describe('the right-hand controls', () => {
  it('offers Guides and Help to a contributor', () => {
    signIn('contributor');
    renderHeader();
    expect(headerButtons()).toEqual(['Open menu', 'Guides', 'Help']);
  });

  it('offers Help alone to an end user', () => {
    signIn('end_user');
    renderHeader();
    expect(headerButtons()).toEqual(['Open menu', 'Help']);
  });

  it('has none of the account items, even for an owner, and does not offer install on beforeinstallprompt', () => {
    signIn('owner');
    renderHeader();
    expect(headerButtons()).toEqual(['Open menu', 'Guides', 'Help']);
    for (const name of ['Install app', 'Settings', 'My API Keys', 'Profile', 'Logout', 'More actions']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /persona/i })).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('beforeinstallprompt'));
    });
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });

  it('has no sm:contents or sm:hidden markup', () => {
    renderHeader();
    const html = screen.getByRole('banner').outerHTML;
    expect(html).not.toContain('sm:contents');
    expect(html).not.toContain('sm:hidden');
  });

  it('opens the guides panel from Guides', () => {
    signIn('contributor');
    renderHeader();
    expect(useGuidesPanelStore.getState().isOpen).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Guides' }));
    expect(useGuidesPanelStore.getState().isOpen).toBe(true);
  });

  it('renders the help chat open from Help', () => {
    renderHeader();
    expect(screen.queryByTestId('help-chat-stub')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByTestId('help-chat-stub')).toBeTruthy();
  });
});

describe('identity', () => {
  it('shows the logo, named for the app, when no character is selected', () => {
    renderHeader();
    expect(screen.getByRole('img', { name: 'Good Girls Bot Club' })).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it("shows the selected character's name as the heading, in place of the logo", () => {
    useCharacterStore.setState({ selectedCharacter: ivy });
    renderHeader();
    expect(screen.getByRole('heading', { level: 1, name: 'Ivy' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Good Girls Bot Club' })).toBeNull();
  });

  it('offers the edit pencil only to a user who can edit characters', () => {
    useCharacterStore.setState({ selectedCharacter: ivy });
    signIn('end_user');
    const { unmount } = renderHeader();
    expect(screen.queryByRole('button', { name: 'Edit character' })).toBeNull();
    unmount();

    signIn('contributor');
    renderHeader();
    expect(screen.getByRole('button', { name: 'Edit character' })).toBeTruthy();
  });
});
