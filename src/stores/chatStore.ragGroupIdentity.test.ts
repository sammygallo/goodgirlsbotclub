import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, GroupChatInfo } from './chatStore';

// Same load-time-side-effect workarounds as chatStore.groupWorldInfo.test.ts.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

const { resolveRagContext, useChatStore } = await import('./chatStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useCharacterStore } = await import('./characterStore');
const { api } = await import('../api/client');

let msgId = 0;
function mkMsg(content: string, isUser = true): ChatMessage {
  msgId += 1;
  return {
    id: `m${msgId}`,
    name: isUser ? 'User' : 'Bot',
    isUser,
    isSystem: false,
    hidden: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
  } as ChatMessage;
}

function mkGroupChat(over: Partial<GroupChatInfo> = {}): GroupChatInfo {
  return {
    fileName: 'group1.jsonl',
    characterNames: ['Seraphina', 'Marcus'],
    characterAvatars: ['seraphina.png', 'marcus.png'],
    lastMessage: '',
    createdAt: 0,
    activationStrategy: 'manual',
    mutedAvatars: [],
    pooledExcludeRecent: 0,
    autoModeEnabled: false,
    autoModeDelayMs: 0,
    ...over,
  } as GroupChatInfo;
}

describe('resolveRagContext — group identity resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({ groupChats: [mkGroupChat()] });
    useCharacterStore.setState({
      selectedCharacter: { name: 'Marcus', avatar: 'marcus.png' } as never,
    });
  });

  it('carries characterAvatars[0] (slot 0) as characterAvatar, not the current speaker', async () => {
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    // The current speaker for this turn is Marcus (matches selectedCharacter
    // too, deliberately, to prove the group branch — not the solo fallback —
    // is what supplied the avatar): the group save/load identity is always
    // slot 0 (Seraphina here), regardless of who's actually speaking.
    const messages = [mkMsg('hello there')];
    await resolveRagContext(messages, 'group1.jsonl');

    expect(spy).toHaveBeenCalledTimes(1);
    const [characterAvatar, fileName] = spy.mock.calls[0];
    expect(characterAvatar).toBe('seraphina.png');
    expect(fileName).toBe('group1.jsonl');
  });

  it('falls back to the selected character for a chat that is not a group chat', async () => {
    useChatStore.setState({ groupChats: [] });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    await resolveRagContext(messages, 'solo-chat.jsonl');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('marcus.png');
  });

  it('never calls the server when no character identity can be resolved', async () => {
    useChatStore.setState({ groupChats: [] });
    useCharacterStore.setState({ selectedCharacter: null });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    const result = await resolveRagContext(messages, 'solo-chat.jsonl');

    expect(spy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('resolveRagContext — never-throws wrapper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({ groupChats: [] });
    useCharacterStore.setState({
      selectedCharacter: { name: 'Marcus', avatar: 'marcus.png' } as never,
    });
  });

  it('resolves to null instead of throwing when the server call rejects', async () => {
    vi.spyOn(api, 'getRetrievalMessages').mockRejectedValue(new Error('network blip'));
    const messages = [mkMsg('hello there')];

    await expect(resolveRagContext(messages, 'solo-chat.jsonl')).resolves.toBeNull();
  });

  it('resolves to null instead of throwing on an unexpected response shape', async () => {
    // @ts-expect-error deliberately malformed to exercise the shape guard
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ notChunks: [] });
    const messages = [mkMsg('hello there')];

    await expect(resolveRagContext(messages, 'solo-chat.jsonl')).resolves.toBeNull();
  });
});
