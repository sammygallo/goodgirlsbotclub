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

// Review round 2 G1 follow-up: this file's new deleteGroupChat test writes
// through to localStorage (saveGroupChatsToStorage) — this sandbox's Node
// build defines its own global `localStorage` (via an unconfigured
// `--localstorage-file` flag; `setItem` is `undefined` on it) that shadows
// a working implementation. Same in-memory Storage stub as the other
// chatStore suites, installed BEFORE the dynamic import below.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
vi.stubGlobal('localStorage', new MemoryStorage() as unknown as Storage);

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
    // KILLS (REQUIRED KILL c): resolveRagContext reverted to
    // `groupChat.characterAvatars[0]` (the pre-#458 read) — slot 0 is
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

  it("recall survives deleteGroupChat removing the OPEN group's record (G1, review round 2)", async () => {
    // Before this fix: deleteGroupChat on the OPEN group leaves group mode
    // (isGroupChatMode) untouched but removes the registry record, so
    // getGroupChatByFile returns null even though this is still a group
    // chat. The old code then fell straight to the SOLO branch — but
    // selectedCharacter is null in group mode — so recall went silently
    // dead for the rest of the session, no warning, no error. The F3
    // last-known-good memo (populated here by a real loadGroupChat call)
    // is the only surviving source of the identity once the record is gone.
    // KILLS: removing the `memoIdentity` read from the RECORD-ABSENT arm
    // of resolveRagContext's ternary (the `groupChat` lookup below finds
    // nothing once deleteGroupChat has run) — with selectedCharacter null,
    // that would leave characterAvatar '' and the spy would never be
    // called. This test alone does NOT exercise the record-PRESENT arm's
    // memo read (the record is deleted, not corrupted) — see the sibling
    // test below for that.
    const fileName = 'g1-delete.jsonl';
    const record = mkGroupChat({
      fileName,
      characterAvatars: ['b.png', 'a.png'],
      characterNames: ['B', 'A'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({ groupChats: [record], currentChatFile: fileName });
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });

    // Prime the memo the same way a real load does.
    await useChatStore.getState().loadGroupChat(record);

    // Group mode nulls selectedCharacter in production
    // (characterStore.setGroupChatCharacters); simulate it directly since
    // this file doesn't drive that store's group-mode actions.
    useCharacterStore.setState({ selectedCharacter: null });

    useChatStore.getState().deleteGroupChat(fileName);
    expect(useChatStore.getState().getGroupChatByFile(fileName)).toBeNull();

    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    await resolveRagContext(messages, fileName, null);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('a.png');
  });

  it('recall uses the memo when the record is PRESENT but its own identity is corrupted (empty) — H2, review round 3', async () => {
    // Companion to the test above: that one exercises resolveRagContext's
    // RECORD-ABSENT arm (deleteGroupChat removes the record entirely). This
    // one exercises the RECORD-PRESENT arm's memo read — a corrupted-but-
    // still-registered record (identityAvatar: '') takes a DIFFERENT branch
    // (`groupChat ? (groupIdentityAvatar(groupChat) ?? memoIdentity ?? '') :
    // ...`) that the test above cannot reach, since deleting the record
    // makes `groupChat` null and short-circuits straight past this arm.
    // Five skeptics confirmed: before this test existed, mutating the group
    // arm to `groupIdentityAvatar(groupChat) ?? ''` (dropping the memo
    // fallback) left the full 2036-test suite green.
    // KILLS: that exact mutation — with the record's own identity
    // corrupted to '' below, it would leave characterAvatar '' and the spy
    // would never be called.
    const record = mkGroupChat(); // default fixture: 'group1.jsonl', identity 'seraphina.png'
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });

    // Prime the memo the same way a real load does.
    await useChatStore.getState().loadGroupChat(record);

    // Corrupt the LIVE record's own identity (still present in the
    // registry, just empty) — distinct from deleteGroupChat, which removes
    // the record entirely.
    useChatStore.setState({ groupChats: [{ ...record, identityAvatar: '' }] });
    useCharacterStore.setState({ selectedCharacter: null });

    const spy = vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [] });
    const messages = [mkMsg('hello there')];
    await resolveRagContext(messages, record.fileName, null);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('seraphina.png');
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
