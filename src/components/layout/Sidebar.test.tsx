/**
 * @vitest-environment jsdom
 *
 * The navigation drawer (E6-S3): the shell (dialog semantics, open and close,
 * slide-out timing, the layering classes), the collapsible sections and their
 * persisted state, and the capabilities the old list view had that must still
 * work from inside it (search, filters, sort, favorites, About, group select,
 * drafts, Import and New, group chats, Works, pull-to-refresh).
 *
 * Also the group-select vs an outside selection pair: the hero (E6-S2) can
 * select a character while the drawer is mid-way through picking group
 * members, and selecting must end that mode, or a later row click would toggle
 * membership instead of choosing a character.
 *
 * The drawer is rendered with its store actions stubbed and `fetch` refused, so
 * nothing here reaches a network. `localStorage` is an in-memory stub: under
 * Node 25 the global is Node's experimental one, which jsdom does not replace.
 * jsdom ignores `inert`, so focus containment is asserted in MainLayout.test.tsx
 * on the attribute, and the real Tab walk is QA's.
 */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CharacterInfo, ProjectListItem } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterInterviewStore } from '../../stores/characterInterviewStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore, type GroupChatInfo } from '../../stores/chatStore';
import { useProjectStore } from '../../stores/projectStore';
import { haptic } from '../../utils/haptics';
import { Sidebar } from './Sidebar';

vi.mock('../../utils/haptics', () => ({ haptic: vi.fn(), hapticMedium: vi.fn() }));

const initial = {
  character: useCharacterStore.getState(),
  interview: useCharacterInterviewStore.getState(),
  chat: useChatStore.getState(),
  auth: useAuthStore.getState(),
  project: useProjectStore.getState(),
};

const ivy = {
  name: 'Ivy',
  avatar: 'ivy.png',
  first_mes: 'hi',
  tags: ['cozy'],
  creator_notes: 'Ivy keeps the shop. She is kind.',
} as CharacterInfo;
const rose = { name: 'Rose', avatar: 'rose.png', first_mes: 'hello', tags: ['dark'] } as CharacterInfo;

const groupChat = (fileName: string, names = ['Ivy', 'Rose']) =>
  ({
    fileName,
    characterNames: names,
    characterAvatars: names.map((n) => `${n.toLowerCase()}.png`),
    lastMessage: 'hello there',
    createdAt: 0,
  }) as unknown as GroupChatInfo;

const work = (id: string): ProjectListItem => ({
  id,
  name: `Work ${id}`,
  description: '',
  deliverable_type: 'novel',
  status: 'active',
  character_count: 2,
  chat_count: 1,
  updated_at: '2026-10-01T00:00:00',
});

const fetchCharacters = vi.fn(async () => {});
const fetchProjects = vi.fn(async () => {});
const openPanel = vi.fn();

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

function signIn(role: 'end_user' | 'contributor' | 'admin' | 'owner' = 'end_user', permissions?: string[]) {
  useAuthStore.setState({ currentUser: { handle: 'u', name: 'U', role, permissions } as never });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  fetchCharacters.mockClear();
  fetchProjects.mockClear();
  openPanel.mockClear();
  vi.mocked(haptic).mockClear();
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
    fetchCharacters,
    loadManualDraft: vi.fn(async () => {}),
  });
  useCharacterInterviewStore.setState({ resumableDraft: null, loadDraft: vi.fn(async () => {}) });
  useChatStore.setState({ groupChats: [], isSending: false, isStreaming: false, messages: [], currentChatFile: null });
  useProjectStore.setState({ items: [], isOpen: false, fetchProjects, openPanel });
  useAuthStore.setState({ currentUser: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  useCharacterStore.setState(initial.character, true);
  useCharacterInterviewStore.setState(initial.interview, true);
  useChatStore.setState(initial.chat, true);
  useAuthStore.setState(initial.auth, true);
  useProjectStore.setState(initial.project, true);
  vi.unstubAllGlobals();
});

function renderDrawer({ isOpen = true, onClose = vi.fn() }: { isOpen?: boolean; onClose?: () => void } = {}) {
  const ui = (open: boolean) => (
    <MemoryRouter>
      <Sidebar isOpen={open} onClose={onClose} />
    </MemoryRouter>
  );
  const utils = render(ui(isOpen));
  return { ...utils, onClose, setOpen: (open: boolean) => utils.rerender(ui(open)) };
}

const root = () => document.getElementById('app-drawer') as HTMLElement;
const panel = () => within(root()).getByRole('navigation', { name: 'Main', hidden: true });
const scrim = () => root().querySelector('[aria-hidden="true"]') as HTMLElement;
const toggle = (name: string | RegExp) => screen.getByRole('button', { name });
const rowPrimaries = () => Array.from(document.querySelectorAll<HTMLElement>('[data-row-primary]'));
const rowNames = () => rowPrimaries().map((b) => b.querySelector('p')?.textContent);
const rowPrimary = (name: string) => rowPrimaries().find((b) => b.querySelector('p')?.textContent === name) as HTMLElement;

describe('group selection and an outside selection', () => {
  it('ends group-select when a character is selected from outside the drawer', () => {
    renderDrawer();

    fireEvent.click(toggle('Start group chat'));
    expect(toggle('Cancel group selection')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Start Group Chat \(0\/2\+\)$/ })).toBeTruthy();
    expect(document.querySelectorAll('[data-row-primary][aria-pressed]')).toHaveLength(2);

    // What the hero's Chat button does: select one character, clearing the picks.
    act(() => {
      useCharacterStore.setState({ selectedCharacter: ivy, groupChatCharacters: [] });
    });

    expect(screen.queryByRole('button', { name: 'Cancel group selection' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Start Group Chat/ })).toBeNull();
    expect(toggle('Start group chat')).toBeTruthy();
    expect(document.querySelectorAll('[data-row-primary][aria-pressed]')).toHaveLength(0);
  });

  it('chooses the character on a row click afterwards, rather than toggling group membership', () => {
    const selectCharacter = vi.fn(async () => {});
    useCharacterStore.setState({ selectCharacter });
    renderDrawer();

    fireEvent.click(toggle('Start group chat'));
    act(() => {
      useCharacterStore.setState({ selectedCharacter: ivy, groupChatCharacters: [] });
    });
    fireEvent.click(rowPrimary('Rose'));

    expect(selectCharacter).toHaveBeenCalledWith('rose.png');
    expect(useCharacterStore.getState().groupChatCharacters).toEqual([]);
  });
});

describe('the drawer shell', () => {
  it('is a dialog named Menu, modal, wrapping exactly one nav named Main', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog).toBe(root());
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelectorAll('nav')).toHaveLength(1);
    expect(within(dialog).getByRole('navigation', { name: 'Main' })).toBe(dialog.querySelector('nav'));
  });

  it('is hidden while closed and shown while open', () => {
    const { setOpen } = renderDrawer({ isOpen: false });
    expect(root().hasAttribute('hidden')).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();

    setOpen(true);
    expect(root().hasAttribute('hidden')).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
  });

  describe('closing', () => {
    it('stays shown and slides out for 200 ms, then hides', () => {
      vi.useFakeTimers();
      const { setOpen } = renderDrawer();
      expect(panel().classList.contains('animate-drawer-in')).toBe(true);

      setOpen(false);
      expect(root().hasAttribute('hidden')).toBe(false);
      expect(panel().classList.contains('animate-drawer-out')).toBe(true);
      expect(panel().classList.contains('animate-drawer-in')).toBe(false);

      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(root().hasAttribute('hidden')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(root().hasAttribute('hidden')).toBe(true);
    });

    it('hides at 0 ms under reduced motion', () => {
      vi.useFakeTimers();
      window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      const { setOpen } = renderDrawer();

      setOpen(false);
      expect(root().hasAttribute('hidden')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(root().hasAttribute('hidden')).toBe(true);
    });

    it('takes no pointer input while it slides out', () => {
      vi.useFakeTimers();
      const { setOpen } = renderDrawer();
      expect(panel().classList.contains('pointer-events-none')).toBe(false);
      expect(scrim().classList.contains('pointer-events-none')).toBe(false);

      setOpen(false);
      expect(panel().classList.contains('pointer-events-none')).toBe(true);
      expect(scrim().classList.contains('pointer-events-none')).toBe(true);
    });

    it('cancels the hide when it is reopened mid-slide', () => {
      vi.useFakeTimers();
      const { setOpen } = renderDrawer();
      setOpen(false);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      setOpen(true);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(root().hasAttribute('hidden')).toBe(false);
      expect(panel().classList.contains('animate-drawer-in')).toBe(true);
    });
  });

  it('is shown in the very commit that carries isOpen, not one effect later', () => {
    const api: { setOpen: ((open: boolean) => void) | null } = { setOpen: null };
    function Controlled() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        api.setOpen = setOpen;
      }, []);
      return (
        <MemoryRouter>
          <Sidebar isOpen={open} onClose={() => setOpen(false)} />
        </MemoryRouter>
      );
    }
    render(<Controlled />);
    expect(root().hasAttribute('hidden')).toBe(true);

    act(() => {
      flushSync(() => api.setOpen?.(true));
      expect(root().hasAttribute('hidden')).toBe(false);
    });
  });

  it('keeps the root classless, with the scrim inside it at z 999 and the panel fixed at z 1000', () => {
    renderDrawer();
    expect(root().hasAttribute('class')).toBe(false);

    expect(scrim().parentElement).toBe(root());
    expect(scrim().classList.contains('z-[999]')).toBe(true);
    expect(scrim().classList.contains('fixed')).toBe(true);
    expect(panel().parentElement).toBe(root());
    expect(panel().classList.contains('z-[1000]')).toBe(true);
    expect(panel().classList.contains('fixed')).toBe(true);
  });

  it('has no lg: variant anywhere in its markup', () => {
    renderDrawer();
    expect(root().outerHTML).not.toContain('lg:');
  });

  it('has a Close button that names the drawer it closes', () => {
    renderDrawer();
    const close = toggle('Close menu');
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(close.getAttribute('aria-controls')).toBe('app-drawer');
  });

  it('closes, once, on the Close button', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(toggle('Close menu'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes, once, on a click on the scrim', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes, once, on Escape', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts first focus on Home, with Close next in Tab order', async () => {
    const user = userEvent.setup();
    renderDrawer();
    expect(document.activeElement).toBe(toggle('Home'));

    await user.tab();
    expect(document.activeElement).toBe(toggle('Close menu'));
  });
});

describe('sections', () => {
  it('has h2 toggles for My Characters, Works and Personal, with Group chats an h3 inside My Characters', () => {
    signIn('end_user', ['project:view']);
    useProjectStore.setState({ items: [work('w1')] });
    useChatStore.setState({ groupChats: [groupChat('g1')] });
    renderDrawer();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'My Characters',
      'Works (1)',
      'Personal',
    ]);
    const groups = screen.getByRole('heading', { level: 3, name: 'Group chats (1)' });
    expect(document.getElementById('sidebar-sec-characters')?.contains(groups)).toBe(true);
  });

  it('opens with My Characters, Works and Personal expanded and Group chats collapsed', () => {
    signIn('end_user', ['project:view']);
    useChatStore.setState({ groupChats: [groupChat('g1')] });
    renderDrawer();

    const expanded = (name: string | RegExp) => toggle(name).getAttribute('aria-expanded');
    expect(expanded('My Characters')).toBe('true');
    expect(expanded(/^Group chats/)).toBe('false');
    expect(expanded(/^Works/)).toBe('true');
    expect(expanded('Personal')).toBe('true');
  });

  it('writes a toggle to stm:sidebar-sections, and a fresh mount reads it back', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(toggle('My Characters'));
    expect(toggle('My Characters').getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('stm:sidebar-sections') ?? 'null')).toEqual({
      characters: false,
      groups: false,
      works: true,
      personal: true,
    });

    cleanup();
    renderDrawer();
    expect(toggle('My Characters').getAttribute('aria-expanded')).toBe('false');
  });

  it('uses the defaults, and still toggles, when the storage throws', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage denied');
      },
      setItem: () => {
        throw new Error('storage denied');
      },
      removeItem: () => {},
    });
    renderDrawer();
    expect(toggle('My Characters').getAttribute('aria-expanded')).toBe('true');

    await user.click(toggle('My Characters'));
    expect(toggle('My Characters').getAttribute('aria-expanded')).toBe('false');
  });

  it('is closed on load whatever is stored, including a stale stm:sidebar-expanded', () => {
    localStorage.setItem('stm:sidebar-expanded', 'true');
    localStorage.setItem('stm:sidebar-sections', JSON.stringify({ characters: true, groups: true, works: true, personal: true }));
    renderDrawer({ isOpen: false });
    expect(root().hasAttribute('hidden')).toBe(true);
  });

  it('removes the search box from the accessibility tree when My Characters is collapsed, and keeps it mounted', async () => {
    const user = userEvent.setup();
    renderDrawer();
    expect(screen.getByRole('searchbox', { name: 'Search characters' })).toBeTruthy();

    await user.click(toggle('My Characters'));
    expect(screen.queryByRole('searchbox', { name: 'Search characters' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search characters', hidden: true })).toBeTruthy();
  });

  describe('Works', () => {
    it('is absent without project:view, and present with it', () => {
      signIn('end_user', []);
      const { unmount } = renderDrawer();
      expect(screen.queryByRole('heading', { name: /^Works/ })).toBeNull();
      unmount();

      signIn('end_user', ['project:view']);
      renderDrawer();
      expect(screen.getByRole('heading', { name: /^Works/ })).toBeTruthy();
    });

    it('offers neither new-work row without project:manage', () => {
      signIn('end_user', ['project:view']);
      renderDrawer();
      expect(screen.queryByRole('button', { name: 'New work' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start your first work' })).toBeNull();
    });

    it('offers "Start your first work" with project:manage and no works, and "New work" once there is one', () => {
      signIn('end_user', ['project:view', 'project:manage']);
      const { unmount } = renderDrawer();
      expect(toggle('Start your first work')).toBeTruthy();
      unmount();

      useProjectStore.setState({ items: [work('w1')] });
      renderDrawer();
      expect(toggle('New work')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Start your first work' })).toBeNull();
    });

    it('is hidden while picking group members', () => {
      signIn('end_user', ['project:view']);
      renderDrawer();
      fireEvent.click(toggle('Start group chat'));
      expect(screen.queryByRole('heading', { name: /^Works/ })).toBeNull();
    });
  });

  describe('Group chats', () => {
    it('is absent when there are none', () => {
      renderDrawer();
      expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    });

    it('is collapsed by default and expands on a click', async () => {
      const user = userEvent.setup();
      useChatStore.setState({ groupChats: [groupChat('g1')] });
      renderDrawer();
      expect(screen.queryByRole('button', { name: /Ivy, Rose/ })).toBeNull();

      await user.click(toggle(/^Group chats/));
      expect(screen.getByRole('button', { name: /Ivy, Rose/ })).toBeTruthy();
    });
  });
});

describe('the character list', () => {
  it('fetches the characters on mount, and the works only with project:view', () => {
    renderDrawer();
    expect(fetchCharacters).toHaveBeenCalledTimes(1);
    expect(fetchProjects).not.toHaveBeenCalled();
    cleanup();

    signIn('end_user', ['project:view']);
    renderDrawer();
    expect(fetchProjects).toHaveBeenCalledTimes(1);
  });

  it('narrows to the characters matching the search box', () => {
    renderDrawer();
    const search = screen.getByRole('searchbox', { name: 'Search characters' });
    expect(search.id).toBe('character-search');
    expect(rowNames()).toEqual(['Ivy', 'Rose']);

    fireEvent.change(search, { target: { value: 'ros' } });
    expect(rowNames()).toEqual(['Rose']);
  });

  it('filters to favorites from a labelled toggle that reports its state', () => {
    useCharacterStore.setState({ favorites: new Set(['rose.png']) });
    renderDrawer();
    const favorites = toggle('Show favorites only');
    expect(favorites.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(favorites);
    expect(favorites.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames()).toEqual(['Rose']);
  });

  it('filters by tag from a labelled toggle that reports its state, and Clear resets every filter', () => {
    renderDrawer();
    const tags = toggle('Filter by tags');
    expect(tags.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'cozy' })).toBeNull();

    fireEvent.click(tags);
    expect(tags.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'cozy' }));
    expect(rowNames()).toEqual(['Ivy']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search characters' }), { target: { value: 'iv' } });
    fireEvent.click(toggle('Show favorites only'));
    fireEvent.click(toggle('Clear all filters'));

    const state = useCharacterStore.getState();
    expect(state.searchQuery).toBe('');
    expect(state.showFavoritesOnly).toBe(false);
    expect(state.selectedTags.size).toBe(0);
    expect(rowNames()).toEqual(['Ivy', 'Rose']);
  });

  it('offers the same three sort options, by the same values, in a labelled select', () => {
    renderDrawer();
    const sort = screen.getByRole('combobox', { name: 'Sort characters' }) as HTMLSelectElement;
    expect(Array.from(sort.options).map((o) => [o.value, o.text])).toEqual([
      ['name', 'Name'],
      ['date_added', 'Recently added'],
      ['date_last_chat', 'Recent chat'],
    ]);

    fireEvent.change(sort, { target: { value: 'date_added' } });
    expect(useCharacterStore.getState().sortMode).toBe('date_added');
  });

  it('selects a character on a row click, buzzes, and closes the drawer', () => {
    const selectCharacter = vi.fn(async () => {});
    useCharacterStore.setState({ selectCharacter });
    const { onClose } = renderDrawer();

    fireEvent.click(rowPrimary('Rose'));
    expect(selectCharacter).toHaveBeenCalledWith('rose.png');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalled();
  });

  it('shows the selected character\'s creator notes in About, and Chat selects them', () => {
    const selectCharacter = vi.fn(async () => {});
    useCharacterStore.setState({ selectCharacter });
    const { onClose } = renderDrawer();

    fireEvent.click(toggle('About Ivy'));
    const dialog = screen.getByRole('dialog', { name: 'Ivy' });
    expect(within(dialog).getByText(/Ivy keeps the shop/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Chat with Ivy' }));
    expect(selectCharacter).toHaveBeenCalledWith('ivy.png');
    expect(onClose).toHaveBeenCalled();
  });

  it('favorites a character from a button that is named for them and reports its state', () => {
    renderDrawer();
    const favorite = toggle('Favorite Ivy');
    expect(favorite.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(favorite);
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    expect(useCharacterStore.getState().favorites.has('ivy.png')).toBe(true);
  });

  it('refetches the characters on a pull from the top of the scroller', async () => {
    renderDrawer();
    expect(fetchCharacters).toHaveBeenCalledTimes(1);
    const scroller = document.getElementById('app-drawer-scroll') as HTMLElement;

    const touch = (type: 'touchstart' | 'touchmove' | 'touchend', y: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      const point = [{ clientX: 100, clientY: y }];
      Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : point });
      Object.defineProperty(ev, 'changedTouches', { value: point });
      return act(async () => {
        scroller.dispatchEvent(ev);
      });
    };
    await touch('touchstart', 0);
    await touch('touchmove', 200);
    await touch('touchend', 200);

    await waitFor(() => expect(fetchCharacters).toHaveBeenCalledTimes(2));
  });
});

describe('group selection', () => {
  it('shows checkboxes, keeps Start disabled under two picks, and starts the group', async () => {
    const user = userEvent.setup();
    const startGroupChat = vi.fn();
    const startNewGroupChat = vi.fn(async (_characters: CharacterInfo[]) => {});
    useCharacterStore.setState({ startGroupChat });
    useChatStore.setState({ startNewGroupChat });
    const { onClose } = renderDrawer();

    await user.click(toggle('Start group chat'));
    const start = () => screen.getByRole('button', { name: /^Start Group Chat/ }) as HTMLButtonElement;
    expect(rowPrimaries().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(start().disabled).toBe(true);

    await user.click(rowPrimary('Ivy'));
    expect(start().textContent).toBe('Start Group Chat (1/2+)');
    expect(start().disabled).toBe(true);

    await user.click(rowPrimary('Rose'));
    expect(start().textContent).toBe('Start Group Chat (2/2+)');
    expect(start().disabled).toBe(false);

    await user.click(start());
    expect(startGroupChat).toHaveBeenCalledTimes(1);
    expect(startNewGroupChat).toHaveBeenCalledTimes(1);
    expect(startNewGroupChat.mock.calls[0][0].map((c) => c.avatar)).toEqual(['ivy.png', 'rose.png']);
    expect(startGroupChat.mock.invocationCallOrder[0]).toBeLessThan(startNewGroupChat.mock.invocationCallOrder[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel group selection' })).toBeNull();
  });

  it('offers About and Favorite on a row only outside group selection', () => {
    renderDrawer();
    expect(screen.getAllByRole('button', { name: /^About / })).toHaveLength(2);

    fireEvent.click(toggle('Start group chat'));
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Favorite / })).toBeNull();
  });

  it('cancels from the header toggle, which ends group mode', () => {
    const exitGroupChat = vi.fn();
    useCharacterStore.setState({ exitGroupChat });
    renderDrawer();

    fireEvent.click(toggle('Start group chat'));
    fireEvent.click(toggle('Cancel group selection'));
    expect(exitGroupChat).toHaveBeenCalledTimes(1);
    expect(toggle('Start group chat')).toBeTruthy();
  });
});

describe('drafts, Import and New', () => {
  const draftCharacter = (name: string) => ({ payload: { formData: { name }, draft: { name } } }) as never;

  beforeEach(() => {
    useCharacterStore.setState({ manualDraft: draftCharacter('Draft Ivy') });
    useCharacterInterviewStore.setState({ resumableDraft: draftCharacter('Interview Rose') });
  });

  it('shows both drafts, with Discard, to a user who can create characters', () => {
    signIn('contributor');
    renderDrawer();
    expect(screen.getByRole('button', { name: /^Resume interview:/ }).textContent).toContain('Interview Rose');
    expect(screen.getByRole('button', { name: /^Resume draft:/ }).textContent).toContain('Draft Ivy');
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(2);
  });

  it('hides the drafts from a user who cannot create characters', () => {
    signIn('end_user');
    renderDrawer();
    expect(screen.queryByRole('button', { name: /^Resume / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('hides the drafts while picking group members', () => {
    signIn('contributor');
    renderDrawer();
    fireEvent.click(toggle('Start group chat'));
    expect(screen.queryByRole('button', { name: /^Resume / })).toBeNull();
  });

  it('discards each draft through its own store', () => {
    signIn('contributor');
    const discardManualDraft = vi.fn(async () => {});
    const discardDraft = vi.fn(async () => {});
    useCharacterStore.setState({ discardManualDraft });
    useCharacterInterviewStore.setState({ discardDraft });
    renderDrawer();

    const [discardInterview, discardManual] = screen.getAllByRole('button', { name: 'Discard' });
    fireEvent.click(discardInterview);
    fireEvent.click(discardManual);
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(discardManualDraft).toHaveBeenCalledTimes(1);
  });

  it('shows Import and New only to a user who can create characters', () => {
    signIn('end_user');
    const { unmount } = renderDrawer();
    expect(screen.queryByRole('button', { name: 'Import character' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New character' })).toBeNull();
    unmount();

    signIn('contributor');
    renderDrawer();
    expect(toggle('Import character')).toBeTruthy();
    expect(toggle('New character')).toBeTruthy();
  });

  it('hides Import and New while picking group members', () => {
    signIn('contributor');
    renderDrawer();
    fireEvent.click(toggle('Start group chat'));
    expect(screen.queryByRole('button', { name: 'Import character' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New character' })).toBeNull();
  });

  it('reaches the plain form from the interview\'s "Use the simple form instead"', async () => {
    const user = userEvent.setup();
    signIn('contributor');
    renderDrawer();

    await user.click(toggle('New character'));
    await user.click(screen.getByRole('button', { name: 'Use the simple form instead' }));
    expect(screen.getByRole('dialog', { name: 'Create Character' })).toBeTruthy();
  });
});

describe('group chats', () => {
  beforeEach(() => {
    useChatStore.setState({ groupChats: [groupChat('g1'), groupChat('g2', ['Ivy', 'Rose', 'Nia'])] });
  });

  it('opens a saved group by setting its roster, then loading it, then closing', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const setGroupChatCharacters = vi.fn(async (avatars: string[]) => {
      calls.push(`roster:${avatars.join(',')}`);
    });
    const loadGroupChat = vi.fn(async (g: GroupChatInfo) => {
      calls.push(`load:${g.fileName}`);
    });
    useCharacterStore.setState({ setGroupChatCharacters });
    useChatStore.setState({ loadGroupChat });
    const { onClose } = renderDrawer({ onClose: () => calls.push('close') });

    await user.click(toggle(/^Group chats/));
    await user.click(screen.getByText('Ivy, Rose'));
    expect(calls).toEqual(['roster:ivy.png,rose.png', 'load:g1', 'close']);
    expect(onClose).toBeTypeOf('function');
  });

  it('puts Delete beside the entry, not inside it, and deletes only after a yes', async () => {
    const user = userEvent.setup();
    const deleteGroupChat = vi.fn();
    useChatStore.setState({ deleteGroupChat });
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    renderDrawer();

    await user.click(toggle(/^Group chats/));
    expect(document.querySelectorAll('button button')).toHaveLength(0);
    const [deleteFirst] = screen.getAllByRole('button', { name: 'Delete group chat' });

    await user.click(deleteFirst);
    expect(confirmSpy).toHaveBeenCalledWith('Delete this group chat?');
    expect(deleteGroupChat).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(deleteFirst);
    expect(deleteGroupChat).toHaveBeenCalledWith('g1');
  });
});

describe('Works', () => {
  beforeEach(() => {
    signIn('end_user', ['project:view', 'project:manage']);
    useProjectStore.setState({ items: [work('w1')] });
  });

  it('closes the drawer before a work row opens the Works panel', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    openPanel.mockImplementation((id?: string) => calls.push(`panel:${id}`));
    renderDrawer({ onClose: () => calls.push('close') });

    await user.click(screen.getByRole('button', { name: /Work w1/ }));
    expect(calls).toEqual(['close', 'panel:w1']);
  });

  it('closes the drawer before New work opens the Works panel', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    openPanel.mockImplementation((id?: string) => calls.push(`panel:${id}`));
    renderDrawer({ onClose: () => calls.push('close') });

    await user.click(toggle('New work'));
    expect(calls).toEqual(['close', 'panel:undefined']);
  });
});

describe('anatomy (A1 to A3)', () => {
  it('stacks the top bar, the current-chat card, the scroller and Personal, in that order', () => {
    useCharacterStore.setState({ selectedCharacter: ivy });
    renderDrawer();

    const topBar = toggle('Home').parentElement as HTMLElement;
    const card = screen.getByRole('region', { name: 'Current chat' });
    const scroller = document.getElementById('app-drawer-scroll') as HTMLElement;
    const personal = document.getElementById('app-drawer-personal') as HTMLElement;
    const children = Array.from(panel().children);
    expect(children).toHaveLength(4);
    expect(children[0]).toBe(topBar);
    expect(children[1]).toBe(card);
    expect(children[2]).toBe(scroller);
    expect(children[3]).toBe(personal);
  });

  it('keeps Personal and the group-select bar outside the scroller, with no absolute, sticky or fixed positioning', () => {
    renderDrawer();
    const scroller = document.getElementById('app-drawer-scroll') as HTMLElement;
    const personal = document.getElementById('app-drawer-personal') as HTMLElement;
    expect(scroller.contains(personal)).toBe(false);
    expect(personal.parentElement).toBe(panel());
    for (const token of ['absolute', 'sticky', 'fixed']) {
      expect(personal.classList.contains(token)).toBe(false);
    }

    fireEvent.click(toggle('Start group chat'));
    const bar = screen.getByRole('button', { name: /^Start Group Chat/ }).parentElement as HTMLElement;
    expect(scroller.contains(bar)).toBe(false);
    expect(bar.parentElement).toBe(panel());
    for (const token of ['absolute', 'sticky', 'fixed']) {
      expect(bar.classList.contains(token)).toBe(false);
    }
  });

  it('pads the top bar for the notch and Personal for the home indicator', () => {
    renderDrawer();
    const topBar = toggle('Home').parentElement as HTMLElement;
    const personal = document.getElementById('app-drawer-personal') as HTMLElement;
    expect(topBar.classList.contains('safe-top')).toBe(true);
    expect(personal.classList.contains('input-safe-bottom')).toBe(true);
  });

  it('gives the scroller the classes that let it scroll and shrink inside the column', () => {
    renderDrawer();
    const scroller = document.getElementById('app-drawer-scroll') as HTMLElement;
    for (const token of ['overflow-y-auto', 'min-h-0', 'flex-1', 'scroll-py-2']) {
      expect(scroller.classList.contains(token)).toBe(true);
    }
  });
});

describe('row controls (D1 to D6)', () => {
  /** Opens the drawer with a saved group chat, so Group chats is expanded and its Delete control is mounted. */
  function renderWithGroups() {
    useChatStore.setState({ groupChats: [groupChat('g1')] });
    const utils = renderDrawer();
    fireEvent.click(toggle(/^Group chats/));
    return utils;
  }

  /** Ivy's About and Favorite buttons, and the group chat's Delete button. */
  function ivyControls() {
    const list = rowPrimary('Ivy').closest('ul') as HTMLElement;
    return {
      about: within(list).getByRole('button', { name: 'About Ivy' }),
      favorite: within(list).getByRole('button', { name: 'Favorite Ivy' }),
      remove: screen.getByRole('button', { name: 'Delete group chat' }),
    };
  }

  it('keeps About, Favorite and Delete visible on keyboard focus, not only on hover', () => {
    renderWithGroups();
    const { about, favorite, remove } = ivyControls();
    for (const control of [about, favorite, remove]) {
      expect(control.classList.contains('focus-visible:opacity-100')).toBe(true);
      expect(control.classList.contains('group-focus-within:opacity-100')).toBe(true);
    }
  });

  it('names each favorite button for its character, and reports whether it is a favorite', () => {
    useCharacterStore.setState({ favorites: new Set(['rose.png']) });
    renderDrawer();
    expect(toggle('Favorite Ivy').getAttribute('aria-pressed')).toBe('false');
    expect(toggle('Favorite Rose').getAttribute('aria-pressed')).toBe('true');
  });

  it('gives the favorites toggle, tags toggle, sort select and Clear accessible names, and no tooltip', () => {
    useCharacterStore.setState({ searchQuery: 'iv' });
    renderDrawer();
    const controls = [
      toggle('Show favorites only'),
      toggle('Filter by tags'),
      screen.getByRole('combobox', { name: 'Sort characters' }),
      toggle('Clear all filters'),
    ];
    for (const control of controls) {
      expect(control.hasAttribute('title')).toBe(false);
    }
  });

  it('keeps no button inside another button, with Group chats expanded', () => {
    renderWithGroups();
    expect(screen.getByRole('button', { name: /Ivy, Rose/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete group chat' })).toBeTruthy();
    expect(document.querySelectorAll('button button')).toHaveLength(0);
  });

  it('marks the active row with aria-current, a semibold name and a left rule, and leaves the other rows plain', () => {
    useCharacterStore.setState({ selectedCharacter: ivy });
    renderDrawer();
    const nameOf = (row: HTMLElement) => row.querySelector('p') as HTMLElement;
    const active = rowPrimary('Ivy');
    const other = rowPrimary('Rose');

    expect(active.getAttribute('aria-current')).toBe('true');
    expect(nameOf(active).classList.contains('font-semibold')).toBe(true);
    expect(active.parentElement?.classList.contains('border-l-2')).toBe(true);

    expect(other.hasAttribute('aria-current')).toBe(false);
    expect(nameOf(other).classList.contains('font-semibold')).toBe(false);
    expect(other.parentElement?.classList.contains('border-l-2')).toBe(false);
  });

  it('sizes each row as a 44 px target and each row action as a 32 px square', () => {
    renderWithGroups();
    expect(rowPrimary('Ivy').classList.contains('min-h-11')).toBe(true);
    const { about, favorite, remove } = ivyControls();
    for (const control of [about, favorite, remove]) {
      expect(control.classList.contains('h-8')).toBe(true);
      expect(control.classList.contains('w-8')).toBe(true);
    }
  });
});

describe('keyboard (K1 to K3)', () => {
  it('moves focus between row buttons with ArrowDown and ArrowUp, and stops at either end', () => {
    renderDrawer();
    const ivyRow = rowPrimary('Ivy');
    const roseRow = rowPrimary('Rose');
    ivyRow.focus();

    fireEvent.keyDown(ivyRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(roseRow);
    fireEvent.keyDown(roseRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(roseRow);

    fireEvent.keyDown(roseRow, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ivyRow);
    fireEvent.keyDown(ivyRow, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ivyRow);
  });

  it('jumps to the first and last row with Home and End', () => {
    renderDrawer();
    const ivyRow = rowPrimary('Ivy');
    const roseRow = rowPrimary('Rose');
    ivyRow.focus();

    fireEvent.keyDown(ivyRow, { key: 'End' });
    expect(document.activeElement).toBe(roseRow);
    fireEvent.keyDown(roseRow, { key: 'Home' });
    expect(document.activeElement).toBe(ivyRow);
  });

  it('leaves the arrow keys to About and Favorite, and keeps Tab moving through each row control', async () => {
    const user = userEvent.setup();
    renderDrawer();
    const list = rowPrimary('Ivy').closest('ul') as HTMLElement;
    const about = within(list).getByRole('button', { name: 'About Ivy' });
    const favorite = within(list).getByRole('button', { name: 'Favorite Ivy' });

    about.focus();
    expect(fireEvent.keyDown(about, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(about);

    favorite.focus();
    expect(fireEvent.keyDown(favorite, { key: 'ArrowUp' })).toBe(true);
    expect(document.activeElement).toBe(favorite);

    expect(list.querySelectorAll('[tabindex="-1"]')).toHaveLength(0);

    rowPrimary('Ivy').focus();
    await user.tab();
    expect(document.activeElement).toBe(about);
    await user.tab();
    expect(document.activeElement).toBe(favorite);
  });
});
