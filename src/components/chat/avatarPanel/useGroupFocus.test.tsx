/**
 * @vitest-environment jsdom
 *
 * useGroupFocus (D-C7) against the real chatStore: auto-follow, the manual pin
 * and what releases it, and that the hook only ever reads the stores (#458).
 *
 * `localStorage` is an in-memory stub (under Node 25 the global is Node's
 * experimental one, which has no methods) and `fetch` is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
// characterStore before chatStore: the reverse order trips a module cycle
// (chatStore → … → lovenseStore subscribes to a not-yet-defined chatStore).
import { useCharacterStore } from '../../../stores/characterStore';
import { useChatStore, type ChatMessage } from '../../../stores/chatStore';
import { useGroupFocus } from './useGroupFocus';

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

const initialChat = useChatStore.getState();
const roster = ['a.png', 'b.png', 'c.png'];

function ai(id: string, characterAvatar: string, content = ''): ChatMessage {
  return { id, name: 'x', isUser: false, isSystem: false, content, timestamp: 0, characterAvatar, swipes: [content], swipeId: 0 };
}
function user(id: string): ChatMessage {
  return { id, name: 'You', isUser: true, isSystem: false, content: 'hi', timestamp: 0, swipes: ['hi'], swipeId: 0 };
}

function setMessages(messages: ChatMessage[], isStreaming = false) {
  act(() => useChatStore.setState({ messages, isStreaming }));
}

beforeEach(() => {
  useChatStore.setState({
    messages: [ai('1', 'b.png')],
    isStreaming: false,
    currentChatFile: 'group-1',
    currentSpeakerName: null,
  });
});

afterEach(() => {
  cleanup();
  useChatStore.setState(initialChat, true);
});

describe('useGroupFocus', () => {
  it('auto-follows the newest speaker', () => {
    const { result } = renderHook(() => useGroupFocus(roster));
    expect(result.current.focusedAvatar).toBe('b.png');
    setMessages([ai('1', 'b.png'), ai('2', 'c.png', 'x')], true);
    expect(result.current.focusedAvatar).toBe('c.png');
  });

  it('a pin holds through streamed tokens into an existing message and a user message', () => {
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => result.current.pinMember('a.png'));
    expect(result.current.focusedAvatar).toBe('a.png');

    // Tokens streaming into the message that existed at pin time.
    setMessages([ai('1', 'b.png', 'more tokens')], true);
    expect(result.current.focusedAvatar).toBe('a.png');
    // A user message.
    setMessages([ai('1', 'b.png', 'more tokens'), user('2')]);
    expect(result.current.focusedAvatar).toBe('a.png');
  });

  it('a pin holds when an AI message that existed at pin time is deleted', () => {
    setMessages([ai('1', 'b.png'), ai('2', 'c.png')]);
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => result.current.pinMember('a.png'));
    // Deleting c2 makes b1 the newest AI message — not a new one.
    setMessages([ai('1', 'b.png')]);
    expect(result.current.focusedAvatar).toBe('a.png');
  });

  it('the next AI message releases the pin, and it stays released', () => {
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => result.current.pinMember('a.png'));
    // The group send path appends an empty placeholder for the next speaker.
    setMessages([ai('1', 'b.png'), user('2'), ai('3', 'c.png')], true);
    expect(result.current.focusedAvatar).toBe('c.png');
    // Deleting that message again does not bring the pin back.
    setMessages([ai('1', 'b.png')]);
    expect(result.current.focusedAvatar).toBe('b.png');
  });

  it('a pin holds in a chat with no AI message yet', () => {
    setMessages([user('1')]);
    const { result } = renderHook(() => useGroupFocus(roster));
    expect(result.current.focusedAvatar).toBe('a.png');
    act(() => result.current.pinMember('c.png'));
    expect(result.current.focusedAvatar).toBe('c.png');
    setMessages([user('1'), user('2')]);
    expect(result.current.focusedAvatar).toBe('c.png');
  });

  it('a chat-file change drops the pin', () => {
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => result.current.pinMember('a.png'));
    act(() => useChatStore.setState({ currentChatFile: 'group-2' }));
    expect(result.current.focusedAvatar).toBe('b.png');
  });

  it('a pinned member leaving the roster drops the pin', () => {
    const { result, rerender } = renderHook(({ r }) => useGroupFocus(r), { initialProps: { r: roster } });
    act(() => result.current.pinMember('a.png'));
    rerender({ r: ['b.png', 'c.png'] });
    expect(result.current.focusedAvatar).toBe('b.png');
  });

  it('ignores currentSpeakerName entirely (K14)', () => {
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => useChatStore.setState({ currentSpeakerName: 'Cat' }));
    expect(result.current.focusedAvatar).toBe('b.png');
  });

  it('mid-send, focuses the in-flight placeholder by avatar while currentSpeakerName names a same-name member (K14)', () => {
    // a.png and c.png share the name "Twin"; c.png is the one speaking.
    const twin = (id: string, avatar: string): ChatMessage => ({ ...ai(id, avatar), name: 'Twin' });
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() =>
      useChatStore.setState({
        messages: [twin('1', 'a.png'), user('2'), twin('3', 'c.png')],
        isStreaming: true,
        currentSpeakerName: 'Twin',
      }),
    );
    expect(result.current.focusedAvatar).toBe('c.png');
    setMessages([twin('1', 'a.png'), user('2'), { ...twin('3', 'c.png'), content: 'tokens' }], true);
    expect(result.current.focusedAvatar).toBe('c.png');
  });

  it('only reads: pinning leaves both stores\' state objects untouched', () => {
    const chatBefore = useChatStore.getState();
    const characterBefore = useCharacterStore.getState();
    const { result } = renderHook(() => useGroupFocus(roster));
    act(() => result.current.pinMember('c.png'));
    act(() => result.current.pinMember('a.png'));
    expect(useChatStore.getState()).toBe(chatBefore);
    expect(useCharacterStore.getState()).toBe(characterBefore);
  });
});
