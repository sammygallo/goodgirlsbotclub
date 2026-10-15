/**
 * @vitest-environment jsdom
 *
 * The drawer's current-chat card (D-S5): nothing with no chat open, a compact
 * card for a solo chat (avatar, name, About, the motion picker in a popover),
 * and for a group chat the roster in stable order with the last speaker ringed
 * and named.
 *
 * Stores are the real ones, seeded with setState. The sprite and Live Portrait
 * discovery hooks are mocked, since they would otherwise fetch; their return
 * values feed the picker's availability flags and are set per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CharacterInfo } from '../../../api/client';
import { useCharacterStore } from '../../../stores/characterStore';
import { useChatStore, type ChatMessage, type GroupChatInfo } from '../../../stores/chatStore';
import { useMotionModeStore } from '../../../stores/motionModeStore';
import { CurrentChatCard } from './CurrentChatCard';

const discovery = vi.hoisted(() => ({
  emotions: [] as string[],
  hasClips: false,
}));

vi.mock('../../../hooks/useCharacterSprites', () => ({
  useCharacterSprites: () => ({ availableEmotions: discovery.emotions, getSpritePath: () => undefined }),
}));
vi.mock('../../../hooks/useLivePortraitDiscovery', () => ({
  useLivePortraitDiscovery: () => ({ clips: null, hasClips: discovery.hasClips, loading: false }),
}));

const initial = {
  character: useCharacterStore.getState(),
  chat: useChatStore.getState(),
  motion: useMotionModeStore.getState(),
};

const ivy = { name: 'Ivy', avatar: 'ivy.png' } as CharacterInfo;
const rose = { name: 'Rose', avatar: 'rose.png' } as CharacterInfo;
const nia = { name: 'Nia', avatar: 'nia.png' } as CharacterInfo;

const aiMessage = (id: string, who: CharacterInfo): ChatMessage =>
  ({ id, name: who.name, isUser: false, isSystem: false, content: 'hi', timestamp: 0, swipes: [], swipeId: 0, characterAvatar: who.avatar }) as ChatMessage;
const userMessage = (id: string): ChatMessage =>
  ({ id, name: 'You', isUser: true, isSystem: false, content: 'hello', timestamp: 0, swipes: [], swipeId: 0 }) as ChatMessage;

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
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  discovery.emotions = [];
  discovery.hasClips = false;
  useCharacterStore.setState({ selectedCharacter: null, isGroupChatMode: false, groupChatCharacters: [] });
  useChatStore.setState({ messages: [], groupChats: [], currentChatFile: null });
  useMotionModeStore.setState({ modesByAvatar: {} });
});

afterEach(() => {
  cleanup();
  // Before the globals go: the motion store persists on every setState.
  useCharacterStore.setState(initial.character, true);
  useChatStore.setState(initial.chat, true);
  useMotionModeStore.setState(initial.motion, true);
  vi.unstubAllGlobals();
});

const card = () => screen.getByRole('region', { name: 'Current chat' });
const select = (character: CharacterInfo) => useCharacterStore.setState({ selectedCharacter: character });
const startGroup = (members: CharacterInfo[]) =>
  useCharacterStore.setState({ selectedCharacter: null, isGroupChatMode: true, groupChatCharacters: members });
const thumbAlts = () => within(card()).getAllByRole('listitem').map((li) => li.querySelector('img')?.getAttribute('alt'));

describe('mode none', () => {
  it('renders nothing when no chat is open', () => {
    const { container } = render(<CurrentChatCard onAbout={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('single chat', () => {
  beforeEach(() => select(ivy));

  it('is a region named "Current chat" with a 40px avatar, the name, About and a 32px picker toggle', () => {
    render(<CurrentChatCard onAbout={vi.fn()} />);

    const avatar = within(card()).getByRole('img', { name: 'Ivy' });
    expect(avatar.classList.contains('w-10') && avatar.classList.contains('h-10')).toBe(true);
    expect(within(card()).getByText('Ivy')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'About Ivy' })).toBeTruthy();
    const toggle = within(card()).getByRole('button', { name: 'Avatar motion' });
    expect(toggle.classList.contains('h-8') && toggle.classList.contains('w-8')).toBe(true);
  });

  it('has no portrait, expanded notes or character switcher of its own', () => {
    render(<CurrentChatCard onAbout={vi.fn()} />);

    expect(card().querySelectorAll('img')).toHaveLength(1);
    expect(screen.queryByText('Show more')).toBeNull();
    expect(screen.queryByRole('button', { name: /switch character/i })).toBeNull();
  });

  it('hands the selected character to onAbout', async () => {
    const user = userEvent.setup();
    const onAbout = vi.fn();
    render(<CurrentChatCard onAbout={onAbout} />);

    await user.click(screen.getByRole('button', { name: 'About Ivy' }));
    expect(onAbout).toHaveBeenCalledTimes(1);
    expect(onAbout).toHaveBeenCalledWith(ivy);
  });

  it('opens the motion picker from its toggle, and choosing a mode stores it for the character', async () => {
    const user = userEvent.setup();
    render(<CurrentChatCard onAbout={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Avatar motion' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('radiogroup', { name: 'Avatar motion mode' })).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('radiogroup', { name: 'Avatar motion mode' });
    expect(toggle.getAttribute('aria-controls')).toBe(group.parentElement?.id);

    await user.click(within(group).getByRole('radio', { name: 'None' }));
    expect(useMotionModeStore.getState().modesByAvatar['ivy.png']).toBe('none');
  });

  it('enables the picker\'s Expressions and Live Portrait options only for the assets discovery found', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CurrentChatCard onAbout={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Avatar motion' }));
    const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLButtonElement;
    expect(radio('Expressions').disabled).toBe(true);
    expect(radio('Live Portrait').disabled).toBe(true);
    unmount();

    discovery.emotions = ['joy'];
    discovery.hasClips = true;
    render(<CurrentChatCard onAbout={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Avatar motion' }));
    expect(radio('Expressions').disabled).toBe(false);
    expect(radio('Live Portrait').disabled).toBe(false);
  });

  it('closes only the popover on Escape, and lets a later Escape through to the document', async () => {
    const user = userEvent.setup();
    const atDocument = vi.fn();
    document.addEventListener('keydown', atDocument);
    try {
      render(<CurrentChatCard onAbout={vi.fn()} />);
      const toggle = screen.getByRole('button', { name: 'Avatar motion' });
      await user.click(toggle);
      await user.keyboard('{Escape}');

      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
      expect(atDocument).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(atDocument).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', atDocument);
    }
  });

  it('closes the popover on a mousedown outside it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <CurrentChatCard onAbout={vi.fn()} />
      </>,
    );
    const toggle = screen.getByRole('button', { name: 'Avatar motion' });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('group chat', () => {
  it('wins when a character is selected as well', () => {
    useCharacterStore.setState({ selectedCharacter: ivy, isGroupChatMode: true, groupChatCharacters: [ivy, rose] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    expect(within(card()).getByText('Group chat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull();
  });

  it('shows the label, the member names as the title, the roster in order, and who spoke last', () => {
    startGroup([ivy, rose, nia]);
    useChatStore.setState({ messages: [userMessage('1'), aiMessage('2', rose)] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    expect(within(card()).getByText('Group chat')).toBeTruthy();
    expect(within(card()).getByText('Ivy, Rose, Nia')).toBeTruthy();
    expect(thumbAlts()).toEqual(['Ivy', 'Rose', 'Nia']);
    for (const img of card().querySelectorAll('li img')) {
      expect(img.classList.contains('h-7') && img.classList.contains('w-7')).toBe(true);
    }
    expect(within(card()).getByText('Last to speak: Rose')).toBeTruthy();
  });

  it('uses the record\'s title when the chat has one', () => {
    startGroup([ivy, rose]);
    useChatStore.setState({
      groupChats: [{ fileName: 'g1.jsonl', title: 'Movie night' } as GroupChatInfo, { fileName: 'g2.jsonl', title: 'Other' } as GroupChatInfo],
      currentChatFile: 'g1.jsonl',
    });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    expect(within(card()).getByText('Movie night')).toBeTruthy();
    expect(within(card()).queryByText('Ivy, Rose')).toBeNull();
  });

  it('rings the last speaker with aria-current, and keeps the roster order when the speaker changes', () => {
    startGroup([ivy, rose, nia]);
    useChatStore.setState({ messages: [aiMessage('1', rose)] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    const current = () =>
      within(card())
        .getAllByRole('listitem')
        .filter((li) => li.getAttribute('aria-current') === 'true');
    expect(current()).toHaveLength(1);
    expect(current()[0].querySelector('img')?.getAttribute('alt')).toBe('Rose');
    expect(current()[0].classList.contains('ring-2')).toBe(true);
    expect(thumbAlts()).toEqual(['Ivy', 'Rose', 'Nia']);

    act(() => {
      useChatStore.setState({ messages: [aiMessage('1', rose), aiMessage('2', nia)] });
    });
    expect(current()).toHaveLength(1);
    expect(current()[0].querySelector('img')?.getAttribute('alt')).toBe('Nia');
    expect(thumbAlts()).toEqual(['Ivy', 'Rose', 'Nia']);
    expect(within(card()).getByText('Last to speak: Nia')).toBeTruthy();
  });

  it('finds the last speaker by avatar, not by name, when two members share a name', () => {
    const ivyA = { name: 'Ivy', avatar: 'ivy-a.png' } as CharacterInfo;
    const ivyB = { name: 'Ivy', avatar: 'ivy-b.png' } as CharacterInfo;
    startGroup([ivyA, ivyB, rose]);
    useChatStore.setState({ messages: [aiMessage('1', ivyB)] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    const items = within(card()).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'true', null]);
  });

  it('falls back to roster slot 0 when no message carries an avatar', () => {
    startGroup([ivy, rose]);
    useChatStore.setState({ messages: [userMessage('1')] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    const items = within(card()).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual(['true', null]);
    expect(within(card()).getByText('Last to speak: Ivy')).toBeTruthy();
  });

  it('names a last speaker who is no longer in the roster from the message, and rings no one', () => {
    startGroup([ivy, rose]);
    useChatStore.setState({ messages: [{ ...aiMessage('1', nia), name: 'Nia (left)' }] });
    render(<CurrentChatCard onAbout={vi.fn()} />);

    expect(within(card()).getByText('Last to speak: Nia (left)')).toBeTruthy();
    expect(within(card()).getAllByRole('listitem').every((li) => li.getAttribute('aria-current') === null)).toBe(true);
  });
});
