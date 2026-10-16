/**
 * @vitest-environment jsdom
 *
 * ChatView's wiring of the desktop avatar panel (E6-S4), mounted with the real
 * character, chat and display-preference stores:
 *
 *  - where the panel sits (D-C1) and when it renders (D-C2, D-C9);
 *  - Hide / Show portrait, persisted, with focus following the toggle (§5.3);
 *  - the split row stays mounted, so toggling never remounts the chat;
 *  - below 1024 the mobile portrait panel is unchanged, and the chat's own
 *    controls (swipe, message actions) still render beside the panel.
 *
 * As in ChatView.selection.test.tsx, chatStore's fetchChatFiles and loadChat
 * are recorders and clearChat is a no-op, so the seeded transcript survives
 * ChatView's selection effect. useLivePortraitDiscovery is replaced so a case
 * can give a character clips, and useCharacterSprites so a case can give a
 * sprite folder sprites. `fetch` is refused, `localStorage` is an
 * in-memory stub (under Node 25 the global is Node's experimental one, which
 * has no methods), and jsdom gets matchMedia and scrollIntoView. The viewport
 * width is set before mounting: useIsMobile reads innerWidth at init.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CharacterInfo } from '../../api/client';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useDisplayPreferencesStore } from '../../stores/displayPreferencesStore';
import { AVATAR_PANEL_EXPANDED_KEY } from '../../hooks/avatarPanelExpanded';
import { ChatView } from './ChatView';

const env = vi.hoisted(() => {
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
  return {
    clips: {} as Record<string, Record<string, string>>,
    /** sprite folder (costume, or the avatar without extension) → emotion → path. */
    spriteFolders: {} as Record<string, Record<string, string>>,
  };
});

vi.mock('../../hooks/useLivePortraitDiscovery', () => ({
  useLivePortraitDiscovery: (avatar: string | null | undefined) => {
    const clips = avatar ? env.clips[avatar] ?? null : null;
    return { clips, hasClips: !!clips?.idle, loading: false };
  },
}));

vi.mock('../../hooks/useCharacterSprites', () => ({
  useCharacterSprites: (avatar: string | undefined, nameOverride?: string | null) => {
    const folder = nameOverride || avatar?.replace(/\.[^/.]+$/, '');
    const map = folder ? env.spriteFolders[folder] ?? {} : {};
    return {
      availableEmotions: Object.keys(map),
      getSpritePath: (e: string | null) => (e ? map[e] ?? null : null),
    };
  },
}));

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
  display: useDisplayPreferencesStore.getState(),
};
const initialWidth = window.innerWidth;
const initialHeight = window.innerHeight;

const ava = { name: 'Ava', avatar: 'a.png', first_mes: 'Hello from Ava.' } as CharacterInfo;
const bea = { name: 'Bea', avatar: 'b.png', first_mes: 'Hello from Bea.' } as CharacterInfo;

const transcript: ChatMessage[] = [
  { id: 'u1', name: 'You', isUser: true, isSystem: false, content: 'Hi', timestamp: 1, swipes: ['Hi'], swipeId: 0 },
  {
    id: 'a1',
    name: 'Ava',
    isUser: false,
    isSystem: false,
    content: 'Second reply',
    timestamp: 2,
    characterAvatar: 'a.png',
    swipes: ['First reply', 'Second reply'],
    swipeId: 1,
  },
];

let swipeLeft: Mock<(messageId: string) => void>;

/** Width and height; useOrientation reads landscape as width > height at init. */
function setViewport(width: number, height = 900) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

function seedSolo() {
  useCharacterStore.setState({ selectedCharacter: ava, isGroupChatMode: false, groupChatCharacters: [] });
}

function seedGroup() {
  useCharacterStore.setState({ selectedCharacter: null, isGroupChatMode: true, groupChatCharacters: [ava, bea] });
}

async function mount() {
  const view = render(
    <MemoryRouter>
      <ChatView />
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

const panel = () => document.getElementById('chat-avatar-panel');
const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  env.clips = {};
  env.spriteFolders = {};
  setViewport(1440);
  swipeLeft = vi.fn<(messageId: string) => void>();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  useCharacterStore.setState({ characters: [ava, bea], charactersLoaded: true, isLoading: false });
  useDisplayPreferencesStore.setState({ vnMode: false });
  useChatStore.setState({
    messages: transcript,
    chatFiles: [],
    currentChatFile: 'Ava - 1',
    isSending: false,
    isStreaming: false,
    fetchChatFiles: vi.fn(async () => {
      useChatStore.setState({ chatFiles: [{ fileName: 'Ava - 1', messageCount: 2, lastMessage: '' }] });
    }),
    loadChat: vi.fn(async (_avatar: string, fileName: string) => {
      useChatStore.setState({ currentChatFile: fileName });
    }),
    clearChat: vi.fn(),
    swipeLeft,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewport(initialWidth, initialHeight);
  useCharacterStore.setState(initial.character, true);
  useChatStore.setState(initial.chat, true);
  useDisplayPreferencesStore.setState(initial.display, true);
});

describe('placement (D-C1)', () => {
  it('solo at 1440: the aside is the first child of the split row, full-bleed 1/3, chat column beside it', async () => {
    seedSolo();
    await mount();
    const aside = panel() as HTMLElement;
    expect(aside).not.toBeNull();
    expect(aside.tagName).toBe('ASIDE');
    expect(aside.getAttribute('aria-label')).toBe('Ava portrait');

    const row = aside.parentElement as HTMLElement;
    expect(row.className).toBe('flex flex-1 min-h-0');
    expect(row.firstElementChild).toBe(aside);

    const cls = aside.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['w-1/3', 'flex-none', 'border-r', 'hidden', 'lg:@min-[600px]/main:flex']));
    expect(cls.some((c) => /^(p|px|py|pt|pb|pl|pr)-/.test(c) || c.startsWith('rounded'))).toBe(false);

    const chat = aside.nextElementSibling as HTMLElement;
    expect(chat.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
    expect(chat.contains(textarea())).toBe(true);
  });

  it('group: the aside is labelled with the focused member', async () => {
    seedGroup();
    await mount();
    expect(screen.getByRole('complementary', { name: 'Group portrait: Ava' })).toBeTruthy();
  });
});

describe('render conditions (D-C2, D-C9)', () => {
  it('no panel on the hero (no chat open)', async () => {
    useCharacterStore.setState({ selectedCharacter: null, isGroupChatMode: false, groupChatCharacters: [] });
    await mount();
    expect(panel()).toBeNull();
  });

  it('a group chat with an empty roster gets no panel and no Show button', async () => {
    useCharacterStore.setState({ selectedCharacter: null, isGroupChatMode: true, groupChatCharacters: [] });
    const first = await mount();
    expect(panel()).toBeNull();
    first.unmount();
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    await mount();
    expect(screen.queryByRole('button', { name: 'Show portrait' })).toBeNull();
  });

  it('collapsed: no panel; "Show portrait" with aria-expanded and aria-controls', async () => {
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    seedSolo();
    await mount();
    expect(panel()).toBeNull();
    const show = screen.getByRole('button', { name: 'Show portrait' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(show.getAttribute('aria-controls')).toBe('chat-avatar-panel');
    // Frame C4: a bordered text button, not an icon.
    expect(show.textContent).toBe('Show portrait');
    expect(show.className).toContain('border');
  });

  it('VN mode: no panel, no Show button, and the VN sprite layer still renders', async () => {
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    useDisplayPreferencesStore.setState({ vnMode: true });
    seedSolo();
    const { container } = await mount();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show portrait' })).toBeNull();
    // The single-character VN layer: Live Portrait at z-1 behind the content.
    const vnLayer = container.querySelector('div.pointer-events-none[style*="z-index: 1"]');
    expect(vnLayer?.querySelector('video')).not.toBeNull();
  });

  it('VN mode with the panel collapsed shows no Show button either', async () => {
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    useDisplayPreferencesStore.setState({ vnMode: true });
    seedSolo();
    await mount();
    expect(screen.queryByRole('button', { name: 'Show portrait' })).toBeNull();
  });

  it('below 1024: no panel or Show button; the mobile portrait panel is unchanged', async () => {
    setViewport(800, 1200);
    seedSolo();
    await mount();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show portrait' })).toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize character portrait' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close character view' })).toBeTruthy();
  });

  it('below 1024 with the desktop panel collapsed, the mobile panel still shows', async () => {
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    setViewport(800, 1200);
    seedSolo();
    await mount();
    expect(screen.getByRole('separator', { name: 'Resize character portrait' })).toBeTruthy();
  });

  it('mobile landscape still hides the mobile portrait panel', async () => {
    setViewport(800, 400);
    seedSolo();
    await mount();
    expect(panel()).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize character portrait' })).toBeNull();
  });

  it('a tablet in landscape at 1180×820 gets the split', async () => {
    setViewport(1180, 820);
    seedSolo();
    await mount();
    expect(panel()).not.toBeNull();
  });
});

describe('Hide / Show portrait (§5.3)', () => {
  it.each([
    ['solo', seedSolo],
    ['group', seedGroup],
  ])('%s: Hide persists "false" and focuses Show; Show restores the panel and focuses Hide — same chat input throughout', async (_mode, seed) => {
    seed();
    await mount();
    const input = textarea();
    fireEvent.change(input, { target: { value: 'draft in progress' } });

    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: 'Hide portrait' }));
    expect(panel()).toBeNull();
    expect(localStorage.getItem(AVATAR_PANEL_EXPANDED_KEY)).toBe('false');
    const show = screen.getByRole('button', { name: 'Show portrait' });
    await waitFor(() => expect(document.activeElement).toBe(show));
    expect(textarea()).toBe(input);

    fireEvent.click(show);
    expect(panel()).not.toBeNull();
    expect(localStorage.getItem(AVATAR_PANEL_EXPANDED_KEY)).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel() as HTMLElement).getByRole('button', { name: 'Hide portrait' })),
    );
    expect(textarea()).toBe(input);
    expect(textarea().value).toBe('draft in progress');
  });

  it('the focus hand-off is one-shot: a later panel remount does not take focus from the input', async () => {
    seedSolo();
    await mount();
    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: 'Hide portrait' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show portrait' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel() as HTMLElement).getByRole('button', { name: 'Hide portrait' })),
    );

    textarea().focus();
    expect(document.activeElement).toBe(textarea());
    act(() => useDisplayPreferencesStore.setState({ vnMode: true }));
    expect(panel()).toBeNull();
    act(() => useDisplayPreferencesStore.setState({ vnMode: false }));
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(textarea());
  });

  it('when lg does not match, the desktop panel is CSS-hidden and the header Show button with it', async () => {
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    seedSolo();
    await mount();
    // The panel's display needs lg AND the container rule; the Show button
    // needs lg. Below lg (in rem) only the mobile portrait, which is lg:hidden, shows.
    const show = screen.getByRole('button', { name: 'Show portrait' });
    expect(show.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:inline-flex']));
    fireEvent.click(show);
    const cls = (panel() as HTMLElement).className.split(/\s+/);
    expect(cls).toContain('hidden');
    expect(cls).toContain('lg:@min-[600px]/main:flex');
    expect(cls.filter((c) => c.endsWith(':flex'))).toEqual(['lg:@min-[600px]/main:flex']);
  });

  it('a new mount reads the collapsed state back', async () => {
    seedSolo();
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Hide portrait' }));
    first.unmount();
    await mount();
    expect(panel()).toBeNull();
    expect(screen.getByRole('button', { name: 'Show portrait' })).toBeTruthy();
  });
});

describe('chat interactions beside the panel', () => {
  it('the last AI message keeps its swipe controls and message actions', async () => {
    seedSolo();
    await mount();
    expect(panel()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous response' }));
    expect(swipeLeft).toHaveBeenCalledWith('a1');
    expect(screen.getByRole('button', { name: /Next response|Generate alternative response/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Message actions' }).length).toBe(2);
  });
});

describe('sprites in the panel (ChatView wiring)', () => {
  const withEmotion = () =>
    useChatStore.setState({ messages: transcript.map((m) => (m.id === 'a1' ? { ...m, emotion: 'joy' } : m)) });
  const panelImage = () => within(panel() as HTMLElement).getByRole('img', { name: 'Ava' });
  /**
   * The last AI message's avatar: the one 'Ava' image in neither the panel nor
   * the mobile portrait (lg:hidden, still in the DOM at 1440).
   */
  const messageAvatar = () => {
    const outside = screen
      .getAllByRole('img', { name: 'Ava' })
      .filter((img) => !panel()?.contains(img) && !img.closest('.lg\\:hidden'));
    expect(outside).toHaveLength(1);
    return outside[0];
  };

  it('a 404 on the panel\'s sprite falls back to the default avatar through ChatView\'s failed set', async () => {
    env.spriteFolders['a'] = { joy: '/sprites/a/joy.png' };
    withEmotion();
    seedSolo();
    await mount();
    expect(panelImage().getAttribute('src')).toBe('/sprites/a/joy.png');
    expect(messageAvatar().getAttribute('src')).toBe('/sprites/a/joy.png');
    fireEvent.error(panelImage());
    expect(panelImage().getAttribute('src')).toBe('/blobs/character/a.png');
    // The set is ChatView's own: the message avatar stops asking for the sprite too.
    expect(messageAvatar().getAttribute('src')).not.toBe('/sprites/a/joy.png');
  });

  it('a 404 on the message avatar\'s sprite falls the panel back too: one shared failed set', async () => {
    env.spriteFolders['a'] = { joy: '/sprites/a/joy.png' };
    withEmotion();
    seedSolo();
    await mount();
    expect(panelImage().getAttribute('src')).toBe('/sprites/a/joy.png');
    fireEvent.error(messageAvatar());
    expect(panelImage().getAttribute('src')).toBe('/blobs/character/a.png');
  });

  it('with an active costume the panel\'s sprite comes from the costume folder', async () => {
    env.spriteFolders['a'] = { joy: '/sprites/a/joy.png' };
    env.spriteFolders['Ava_swim'] = { joy: '/sprites/Ava_swim/joy.png' };
    localStorage.setItem('stm:costume-a.png', 'Ava_swim');
    withEmotion();
    seedSolo();
    await mount();
    expect(panelImage().getAttribute('src')).toBe('/sprites/Ava_swim/joy.png');
  });
});
