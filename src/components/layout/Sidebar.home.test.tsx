/**
 * @vitest-environment jsdom
 *
 * The drawer's Home control (D-S6) with the real character and chat stores.
 *
 * Home calls exitGroupChat() (group chats only), then clearSelection(), then
 * navigate('/'), then closes the drawer, and does nothing at all while a reply
 * is being generated. The order matters: a group chat's identity is its roster
 * (slot 0's avatar plus the file name), so the roster must be left before the
 * selection is cleared (#458).
 *
 * The two round trips are the spec's required guard (D-S6): leave a solo chat,
 * and a group chat, through Home, come back through the drawer's own handlers,
 * send, and the first save is still to the ORIGINAL chat file under the same
 * identity, with no new chat created. ChatView is not mounted, so these pin
 * what the Home control owns: it leaves chatStore's file and messages alone and
 * restores selection through the real handlers. They do not cover ChatView's own
 * chat loader (open issue #506).
 *
 * The api layer is spied at the network edge (getChatWithHeader, saveChat,
 * createChat); `fetch` never resolves, so the generation that follows the first
 * save simply hangs, and afterEach stops it. `localStorage` is an in-memory stub
 * (under Node 25 the global is Node's experimental one).
 */
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, type CharacterInfo } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterInterviewStore } from '../../stores/characterInterviewStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore, type GroupChatInfo } from '../../stores/chatStore';
import { useProjectStore } from '../../stores/projectStore';
import { Sidebar } from './Sidebar';

// The global `localStorage` is an inert object under this runner, even in jsdom,
// and the onboarding store (imported by the code under test) reads it as it
// loads: a working one has to exist before the imports above are evaluated.
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

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));

vi.mock('../../utils/haptics', () => ({ haptic: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    // Records the call and goes on to navigate for real, so the location probe sees it.
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return ((...args: Parameters<typeof navigate>) => {
        navigateSpy(...args);
        return navigate(...args);
      }) as typeof navigate;
    },
  };
});

const initial = {
  character: useCharacterStore.getState(),
  interview: useCharacterInterviewStore.getState(),
  chat: useChatStore.getState(),
  auth: useAuthStore.getState(),
  project: useProjectStore.getState(),
};

const ivy = { name: 'Ivy', avatar: 'ivy.png', first_mes: 'Hello, I am Ivy.' } as CharacterInfo;
const rose = { name: 'Rose', avatar: 'rose.png', first_mes: 'Hello, I am Rose.' } as CharacterInfo;

/** A message as the server stores it, which is what getChatWithHeader hands the store. */
type StoredMessage = Awaited<ReturnType<typeof api.getChatWithHeader>>['messages'][number];

const SOLO_FILE = 'Ivy - 2026-10-14@1';
const GROUP_FILE = 'Group_Ivy_Rose@2';

const stored = (id: string, name: string, isUser: boolean, mes: string) =>
  ({
    name,
    is_user: isUser,
    is_system: false,
    mes,
    send_date: 1,
    swipes: [mes],
    swipe_id: 0,
    extra: { ggbc_id: id },
  }) as unknown as StoredMessage;

const group = {
  fileName: GROUP_FILE,
  characterNames: ['Ivy', 'Rose'],
  characterAvatars: ['ivy.png', 'rose.png'],
  lastMessage: 'hi',
  createdAt: 0,
  activationStrategy: 'manual',
  mutedAvatars: [],
  pooledExcludeRecent: 0,
  autoModeEnabled: false,
  autoModeDelayMs: 0,
  scenarioOverride: '',
  talkativenessOverrides: {},
  cardMode: 'swap',
} as unknown as GroupChatInfo;

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

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function mount(startAt = '/chat/ivy') {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={[startAt]}>
      <Sidebar isOpen onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { onClose };
}

const home = () => screen.getByRole('button', { name: 'Home' });
const location = () => screen.getByTestId('location').textContent;
const rowPrimary = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-row-primary]')).find(
    (b) => b.querySelector('p')?.textContent === name,
  ) as HTMLElement;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  navigateSpy.mockClear();
  useAuthStore.setState({ currentUser: { handle: 'u', name: 'U', role: 'end_user', permissions: [] } as never });
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
  useChatStore.setState({
    groupChats: [],
    messages: [],
    currentChatFile: null,
    isSending: false,
    isStreaming: false,
  });
  useProjectStore.setState({ items: [], isOpen: false, fetchProjects: vi.fn(async () => {}) });
});

afterEach(() => {
  cleanup();
  useChatStore.getState().stopGeneration();
  vi.restoreAllMocks();
  useCharacterStore.setState(initial.character, true);
  useCharacterInterviewStore.setState(initial.interview, true);
  useChatStore.setState(initial.chat, true);
  useAuthStore.setState(initial.auth, true);
  useProjectStore.setState(initial.project, true);
  vi.unstubAllGlobals();
});

describe('what Home does', () => {
  it('leaves the group chat, then clears the selection, then goes to /, then closes', async () => {
    const user = userEvent.setup();
    const exitGroupChat = vi.fn();
    const clearSelection = vi.fn();
    useCharacterStore.setState({ isGroupChatMode: true, groupChatCharacters: [ivy, rose], exitGroupChat, clearSelection });
    const { onClose } = mount('/chat/ivy');

    await user.click(home());
    expect(exitGroupChat).toHaveBeenCalledTimes(1);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/');
    expect(onClose).toHaveBeenCalledTimes(1);

    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];
    expect(order(exitGroupChat)).toBeLessThan(order(clearSelection));
    expect(order(clearSelection)).toBeLessThan(order(navigateSpy));
    expect(order(navigateSpy)).toBeLessThan(onClose.mock.invocationCallOrder[0]);
    expect(location()).toBe('/');
  });

  it('does not touch group mode from a solo chat', async () => {
    const user = userEvent.setup();
    const exitGroupChat = vi.fn();
    const clearSelection = vi.fn();
    useCharacterStore.setState({ selectedCharacter: ivy, exitGroupChat, clearSelection });
    mount();

    await user.click(home());
    expect(exitGroupChat).not.toHaveBeenCalled();
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/');
  });

  it('closes the drawer', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.click(home());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('while a reply is being generated', () => {
  it.each([
    ['sending', { isSending: true }],
    ['streaming', { isStreaming: true }],
  ] as const)('does nothing while %s, and says so', async (_label, flag) => {
    const user = userEvent.setup();
    const exitGroupChat = vi.fn();
    const clearSelection = vi.fn();
    useCharacterStore.setState({ isGroupChatMode: true, groupChatCharacters: [ivy, rose], exitGroupChat, clearSelection });
    useChatStore.setState(flag);
    const { onClose } = mount('/chat/ivy');

    expect(home().getAttribute('aria-disabled')).toBe('true');
    expect(home().getAttribute('title')).toBe('Wait for the reply to finish');

    await user.click(home());
    expect(exitGroupChat).not.toHaveBeenCalled();
    expect(clearSelection).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(location()).toBe('/chat/ivy');
  });

  it('works again once the flag clears', async () => {
    const user = userEvent.setup();
    const clearSelection = vi.fn();
    useCharacterStore.setState({ selectedCharacter: ivy, clearSelection });
    useChatStore.setState({ isSending: true });
    mount();
    await user.click(home());
    expect(clearSelection).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({ isSending: false });
    });
    expect(home().getAttribute('aria-disabled')).toBe('false');
    expect(home().hasAttribute('title')).toBe(false);

    await user.click(home());
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(location()).toBe('/');
  });
});

describe('Home and back again saves to the original chat file (D-S6)', () => {
  it('a solo chat: Home, pick the same character, send', async () => {
    const user = userEvent.setup();
    const loaded = [stored('m1', 'Ivy', false, 'Hello, I am Ivy.'), stored('m2', 'User', true, 'Hi Ivy'), stored('m3', 'Ivy', false, 'Hi!')];
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({ header: {}, messages: loaded, server_ts: 5 });
    const saveChat = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 6 });
    const createChat = vi.spyOn(api, 'createChat');

    useCharacterStore.setState({ selectedCharacter: ivy });
    await useChatStore.getState().loadChat('ivy.png', SOLO_FILE);
    const messagesBefore = useChatStore.getState().messages;
    expect(messagesBefore).toHaveLength(loaded.length);
    mount();

    await user.click(home());
    expect(useCharacterStore.getState().selectedCharacter).toBeNull();
    expect(location()).toBe('/');
    expect(useChatStore.getState().currentChatFile).toBe(SOLO_FILE);
    expect(useChatStore.getState().messages).toBe(messagesBefore);

    await user.click(rowPrimary('Ivy'));
    const selected = useCharacterStore.getState().selectedCharacter;
    expect(selected?.avatar).toBe('ivy.png');

    void useChatStore.getState().sendMessage('hello again', selected as CharacterInfo);
    await waitFor(() => expect(saveChat).toHaveBeenCalled());

    const [avatarUrl, fileName, chatData, baseTs] = saveChat.mock.calls[0];
    expect(avatarUrl).toBe('ivy.png');
    expect(fileName).toBe(SOLO_FILE);
    expect(baseTs).toBe(5);
    expect(chatData).toHaveLength(1 + loaded.length + 1);
    expect((chatData[chatData.length - 1] as { mes: string }).mes).toBe('hello again');
    expect(saveChat.mock.calls.every((call) => call[1] === SOLO_FILE)).toBe(true);
    expect(createChat).not.toHaveBeenCalled();
  });

  it('a group chat: open it, Home, open it again, send', async () => {
    const user = userEvent.setup();
    const loaded = [stored('g1', 'Ivy', false, 'Hello, I am Ivy.'), stored('g2', 'Rose', false, 'Hello, I am Rose.')];
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({ header: {}, messages: loaded, server_ts: 9 });
    const saveChat = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 10 });
    const createChat = vi.spyOn(api, 'createChat');
    useChatStore.setState({ groupChats: [group] });
    mount('/');

    const openGroup = async () => {
      await user.click(screen.getByRole('button', { name: /Ivy, Rose/ }));
      await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(loaded.length));
    };
    await user.click(screen.getByRole('button', { name: /^Group chats/ }));
    await openGroup();
    expect(useCharacterStore.getState().isGroupChatMode).toBe(true);
    expect(useCharacterStore.getState().groupChatCharacters.map((c) => c.avatar)).toEqual(['ivy.png', 'rose.png']);
    expect(useChatStore.getState().currentChatFile).toBe(GROUP_FILE);

    await user.click(home());
    expect(useCharacterStore.getState().isGroupChatMode).toBe(false);
    expect(useCharacterStore.getState().groupChatCharacters).toEqual([]);
    expect(useChatStore.getState().currentChatFile).toBe(GROUP_FILE);

    await openGroup();
    const roster = useCharacterStore.getState().groupChatCharacters;
    expect(roster.map((c) => c.avatar)).toEqual(['ivy.png', 'rose.png']);

    await useChatStore.getState().sendGroupMessage('hi all', roster);
    expect(saveChat).toHaveBeenCalled();

    const [avatarUrl, fileName, chatData, baseTs] = saveChat.mock.calls[0];
    expect(avatarUrl).toBe('ivy.png');
    expect(fileName).toBe(GROUP_FILE);
    expect(baseTs).toBe(9);
    expect((chatData[0] as { is_group_chat?: boolean }).is_group_chat).toBe(true);
    expect(chatData).toHaveLength(1 + loaded.length + 1);
    expect(saveChat.mock.calls.every((call) => call[1] === GROUP_FILE)).toBe(true);
    expect(createChat).not.toHaveBeenCalled();
  });
});
