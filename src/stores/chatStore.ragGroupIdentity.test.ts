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
    // E9-S9 (#458): the frozen server identity. Defaults to slot 0 here only
    // because that's what a never-reordered group resolves to — the tests
    // below deliberately move it out of slot 0 to prove the read isn't
    // positional.
    identityAvatar: 'seraphina.png',
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

  it('carries identityAvatar as characterAvatar, not roster slot 0 or the current speaker', async () => {
    // KILLS: `groupChat.characterAvatars[0]` (the pre-#458 read) — slot 0 is
    // Marcus here (matches selectedCharacter too, deliberately, to prove
    // neither the roster's first slot nor the solo fallback is what supplied
    // the avatar), so a slot-0 implementation reports 'marcus.png' and this
    // goes red.
    useChatStore.setState({
      groupChats: [
        mkGroupChat({
          characterAvatars: ['marcus.png', 'seraphina.png'],
          characterNames: ['Marcus', 'Seraphina'],
        }),
      ],
    });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    // The boundary is an ARGUMENT since E2-S2 task 1b (the caller derives it —
    // group from `groupHistoryWindow`, solo from an uncommitted builder pass).
    // Null here: these tests are about identity resolution, not the boundary.
    await resolveRagContext(messages, 'group1.jsonl', null);

    expect(spy).toHaveBeenCalledTimes(1);
    const [characterAvatar, fileName] = spy.mock.calls[0];
    expect(characterAvatar).toBe('seraphina.png');
    expect(fileName).toBe('group1.jsonl');
  });

  it('never calls the server, and never falls back to the selected character, when the group record has no identityAvatar', async () => {
    // KILLS: `groupIdentityAvatar(g) ?? selectedCharacter?.avatar` (i.e.
    // treating a group record like the solo fallback instead of stopping at
    // its own null) — selectedCharacter is Marcus here, so that wrong
    // implementation would call the spy with 'marcus.png' instead of never
    // calling it.
    useChatStore.setState({ groupChats: [mkGroupChat({ identityAvatar: '' })] });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    const result = await resolveRagContext(messages, 'group1.jsonl', null);

    expect(spy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('falls back to the selected character for a chat that is not a group chat', async () => {
    useChatStore.setState({ groupChats: [] });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    await resolveRagContext(messages, 'solo-chat.jsonl', null);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('marcus.png');
  });

  it('never calls the server when no character identity can be resolved', async () => {
    useChatStore.setState({ groupChats: [] });
    useCharacterStore.setState({ selectedCharacter: null });
    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    const result = await resolveRagContext(messages, 'solo-chat.jsonl', null);

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

    await expect(resolveRagContext(messages, 'solo-chat.jsonl', null)).resolves.toBeNull();
  });

  it('resolves to null instead of throwing on an unexpected response shape', async () => {
    // @ts-expect-error deliberately malformed to exercise the shape guard
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ notChunks: [] });
    const messages = [mkMsg('hello there')];

    await expect(resolveRagContext(messages, 'solo-chat.jsonl', null)).resolves.toBeNull();
  });
});
