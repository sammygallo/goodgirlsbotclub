/**
 * @vitest-environment jsdom
 *
 * ChatView mounted with the real characterStore, chatStore and projectStore.
 *
 * ChatView's selection effect decides when a selection reloads the chat. A
 * null selection pauses it, selecting the character it last loaded again leaves
 * the open transcript alone, and a Works-panel request for that character
 * (projectStore's pendingChatFile) is loaded on the spot. Each case here drives
 * the stores the way the app does and reads what ChatView's chat loader does:
 *
 *  - Home (clearSelection) and then the Works panel's openChatRef for a chat of
 *    the character that was open before must reach loadChat and consume the
 *    pending request;
 *  - Home and then selecting that character again keeps the chat the Works
 *    panel had opened, and the next message is saved to that chat (D-S6);
 *  - a failed delete of the selected character (deleteCharacter clears the
 *    selection, then puts it back) leaves the open chat in place.
 *
 * Selecting a character again after a group chat is open issue #506 and is not
 * exercised here.
 *
 * chatStore's fetchChatFiles and loadChat are replaced by recorders that set
 * the state the real actions set before and after their network call; clearChat
 * is the real action wrapped in a spy. The api layer is spied at the network
 * edge where a case needs it (saveChat, deleteCharacter). Nothing else in the
 * three stores is stubbed and no child component is mocked. `fetch` is refused,
 * `localStorage` is an in-memory stub (under Node 25 the global is Node's
 * experimental one, which has no methods), and jsdom gets matchMedia and
 * scrollIntoView.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, type CharacterInfo } from '../../api/client';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { useProjectStore } from '../../stores/projectStore';
import { ChatView } from './ChatView';

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
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch refused')));
});

// jsdom implements neither of these; ChatView and its hooks call both.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
window.HTMLElement.prototype.scrollIntoView = () => {};

const initial = {
  character: useCharacterStore.getState(),
  chat: useChatStore.getState(),
  project: useProjectStore.getState(),
};

const ava = { name: 'Ava', avatar: 'a.png', first_mes: 'Hello from Ava.' } as CharacterInfo;
const bea = { name: 'Bea', avatar: 'b.png', first_mes: 'Hello from Bea.' } as CharacterInfo;

/** Ava's newest chat, which ChatView loads when it is not asked for another. */
const LATEST = 'Ava - 2026-10-14@2';
/** An older chat of Ava's, the one a Works panel row asks for. */
const REQUESTED = 'Ava - 2026-10-13@1';

let fetchChatFiles: Mock<(avatarUrl: string) => Promise<void>>;
let loadChat: Mock<(avatarUrl: string, fileName: string) => Promise<void>>;
let clearChat: Mock<() => void>;

/** The real action's shape: loading flag, then the list once the (here instant) request answers. */
function makeFetchChatFiles() {
  return vi.fn(async (_avatarUrl: string) => {
    useChatStore.setState({ isLoading: true, error: null });
    await Promise.resolve();
    useChatStore.setState({
      chatFiles: [
        { fileName: LATEST, messageCount: 4, lastMessage: 'later' },
        { fileName: REQUESTED, messageCount: 2, lastMessage: 'earlier' },
      ],
      isLoading: false,
    });
  });
}

/** The real action's shape: the file name is current at once, the loading flag clears after the request. */
function makeLoadChat() {
  return vi.fn(async (_avatarUrl: string, fileName: string) => {
    useChatStore.setState({ isLoading: true, error: null, currentChatFile: fileName });
    await Promise.resolve();
    useChatStore.setState({ isLoading: false });
  });
}

function mountChatView() {
  return render(
    <MemoryRouter>
      <ChatView />
    </MemoryRouter>,
  );
}

/** What the drawer's Home handler does to the stores (Sidebar.tsx handleHome), without the haptic, navigate and close. */
function pressHome() {
  act(() => {
    const { isGroupChatMode, exitGroupChat, clearSelection } = useCharacterStore.getState();
    if (isGroupChatMode) exitGroupChat();
    clearSelection();
  });
}

async function selectAva() {
  await act(async () => {
    await useCharacterStore.getState().selectCharacter(ava.avatar);
  });
}

/** Lets queued microtasks, and the renders and effects they cause, finish. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Ava selected with her newest chat loaded, then the Works panel opens her older chat while she is selected. */
async function openAvaWithRequestedChat() {
  mountChatView();
  await selectAva();
  await waitFor(() => expect(loadChat).toHaveBeenCalledWith(ava.avatar, LATEST));
  await act(async () => {
    await useProjectStore.getState().openChatRef({ character_avatar: ava.avatar, file_name: REQUESTED });
  });
  expect(useChatStore.getState().currentChatFile).toBe(REQUESTED);
  clearChat.mockClear();
  fetchChatFiles.mockClear();
  loadChat.mockClear();
}

beforeEach(() => {
  localStorage.clear();
  fetchChatFiles = makeFetchChatFiles();
  loadChat = makeLoadChat();
  clearChat = vi.fn(initial.chat.clearChat);
  useCharacterStore.setState({
    characters: [ava, bea],
    charactersLoaded: true,
    isLoading: false,
    selectedCharacter: null,
    isGroupChatMode: false,
    groupChatCharacters: [],
  });
  useChatStore.setState({
    messages: [],
    chatFiles: [],
    currentChatFile: null,
    isSending: false,
    isStreaming: false,
    fetchChatFiles,
    loadChat,
    clearChat,
  });
  useProjectStore.setState({ isOpen: false, pendingChatFile: null });
});

afterEach(() => {
  cleanup();
  useChatStore.getState().stopGeneration();
  vi.restoreAllMocks();
  useCharacterStore.setState(initial.character, true);
  useChatStore.setState(initial.chat, true);
  useProjectStore.setState(initial.project, true);
});

describe('selecting a character again after Home', () => {
  it('loads the chat the Works panel asks for and clears the pending request', async () => {
    mountChatView();
    await selectAva();
    await waitFor(() => expect(loadChat).toHaveBeenCalledWith(ava.avatar, LATEST));

    pressHome();
    await act(async () => {
      await useProjectStore.getState().openChatRef({ character_avatar: ava.avatar, file_name: REQUESTED });
    });

    await waitFor(() => expect(loadChat).toHaveBeenCalledWith(ava.avatar, REQUESTED));
    expect(useProjectStore.getState().pendingChatFile).toBeNull();
  });

  it('keeps the open chat through Home and a second selection of the same character, and saves the next message to it', async () => {
    await openAvaWithRequestedChat();
    const saveChat = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 6 });

    pressHome();
    await selectAva();
    await flush();

    expect(useChatStore.getState().currentChatFile).toBe(REQUESTED);
    expect(clearChat).not.toHaveBeenCalled();
    expect(fetchChatFiles).not.toHaveBeenCalled();
    expect(loadChat).not.toHaveBeenCalled();

    // sendMessage returns once the refused fetch has failed the generation.
    await act(async () => {
      await useChatStore.getState().sendMessage('hello again', ava);
    });
    expect(saveChat).toHaveBeenCalled();
    expect(saveChat.mock.calls[0][0]).toBe(ava.avatar);
    expect(saveChat.mock.calls[0][1]).toBe(REQUESTED);
    expect(saveChat.mock.calls.every((call) => call[1] === REQUESTED)).toBe(true);
  });
});

describe('a failed delete of the selected character', () => {
  it('does not reload the open chat when the selection is put back', async () => {
    await openAvaWithRequestedChat();
    let rejectDelete: (error: Error) => void = () => {};
    vi.spyOn(api, 'deleteCharacter').mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectDelete = reject;
      }),
    );

    // The optimistic clear is flushed to ChatView before the delete is rejected.
    let deletion!: Promise<boolean>;
    act(() => {
      deletion = useCharacterStore.getState().deleteCharacter(ava.avatar);
    });
    expect(useCharacterStore.getState().selectedCharacter).toBeNull();

    await act(async () => {
      rejectDelete(new Error('delete refused'));
      await deletion;
    });
    await flush();

    expect(await deletion).toBe(false);
    expect(useCharacterStore.getState().selectedCharacter).toBe(ava);
    expect(clearChat).not.toHaveBeenCalled();
    expect(fetchChatFiles).not.toHaveBeenCalled();
    expect(loadChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().currentChatFile).toBe(REQUESTED);
  });
});
