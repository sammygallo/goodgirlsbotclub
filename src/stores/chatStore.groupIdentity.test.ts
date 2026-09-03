/**
 * E9-S9 (#458) — group recall identity is positional.
 *
 * Before this story, every group save/load/recall read `characterAvatars[0]`
 * — a roster POSITION, not a stable identity. Reordering or removing members
 * shifted slot 0, so the very next save addressed a DIFFERENT server row
 * (`(character_avatar, file_name)`), orphaning the old row and its message
 * embeddings with no cascade. The fix freezes the identity at creation as
 * `GroupChatInfo.identityAvatar`, written in exactly three places
 * (`startNewGroupChat`, `convertCurrentToGroup`, `migrateGroupChat`'s
 * backfill) and read through exactly two helpers (`groupIdentityAvatar`,
 * `resolveGroupIdentityAvatar`) — neither exported, so every test below
 * drives a real store action and asserts on what actually got sent/loaded,
 * per this repo's house style (chatStore.callSites.test.ts, etc.).
 *
 * Every test's `KILLS` comment names the cheapest wrong implementation it
 * fails on; each was verified red against a real edit of chatStore.ts
 * (edit -> run -> paste the red line -> revert), not just written in prose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chatStore pulls serverSettings (and through it the api layer) at module
// load, and chatStore -> authStore -> lovenseStore -> chatStore is a require
// cycle whose leaf subscribes at module scope — same workarounds as
// chatStore.callSites.test.ts / chatStore.ragGroupIdentity.test.ts. Declared
// as controllable vi.fn()s (not inline in the factory) so the server-apply
// backfill test and the round-trip persistence test can drive/inspect them
// per-case, same shape as worldInfoStore.legacyIdMapServer.test.ts.
const getSettingsBlob = vi.fn(async () => ({}) as Record<string, unknown>);
const patchServerKey = vi.fn(
  async (_serverKey: string, _value: Record<string, unknown>, _localTsKey: string) => {}
);
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: () => getSettingsBlob(),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: (serverKey: string, value: Record<string, unknown>, localTsKey: string) =>
    patchServerKey(serverKey, value, localTsKey),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

// This vitest project runs with `environment: 'node'`, where the global
// `localStorage` exists as an inert object with no working methods — same
// note as characterStore.charactersLoaded.test.ts / dataBankStore's. Must be
// installed BEFORE the dynamic import below: chatStore reads it at module
// load to seed its initial `groupChats` state.
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
const memoryStorage = new MemoryStorage();
globalThis.localStorage = memoryStorage as unknown as Storage;

const { useChatStore } = await import('./chatStore');
const { useCharacterStore } = await import('./characterStore');
const { api } = await import('../api/client');

import type { ChatMessage, GroupChatInfo } from './chatStore';
import type { CharacterInfo } from '../api/client';

function mkChar(name: string, avatar: string): CharacterInfo {
  return { name, avatar } as CharacterInfo;
}

let msgId = 0;
function mkMsg(content: string): ChatMessage {
  msgId += 1;
  return {
    id: `m${msgId}`,
    name: 'User',
    isUser: true,
    isSystem: false,
    hidden: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
  };
}

/** A complete GroupChatInfo, written without `as` so `tsc -b` fails loudly
 *  if the record gains a required field (same convention as
 *  chatStore.callSites.test.ts's mkGroupChat). Defaults to 'list' strategy
 *  and identityAvatar at slot 0 (what a never-reordered group resolves to);
 *  tests that need to prove the read isn't positional override both. */
function mkGroupChat(over: Partial<GroupChatInfo> & { fileName: string }): GroupChatInfo {
  const characterAvatars = over.characterAvatars ?? ['a.png', 'b.png'];
  const characterNames = over.characterNames ?? ['A', 'B'];
  return {
    characterNames,
    characterAvatars,
    identityAvatar: characterAvatars[0],
    lastMessage: '',
    createdAt: 0,
    activationStrategy: 'list',
    mutedAvatars: [],
    pooledExcludeRecent: 0,
    autoModeEnabled: false,
    autoModeDelayMs: 0,
    scenarioOverride: '',
    talkativenessOverrides: {},
    cardMode: 'swap',
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  memoryStorage.clear();
  getSettingsBlob.mockReset();
  getSettingsBlob.mockResolvedValue({});
  patchServerKey.mockReset();
  patchServerKey.mockResolvedValue(undefined);
  useChatStore.setState({
    groupChats: [],
    messages: [],
    currentChatFile: null,
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
  useCharacterStore.setState({ characters: [] });
});

// ---------------------------------------------------------------------------
// Roster mutations never touch identityAvatar
// ---------------------------------------------------------------------------

describe('roster mutations leave identityAvatar untouched', () => {
  it('reorderGroupMembers', () => {
    // KILLS (REQUIRED KILL a): reorderGroupMembers rewriting
    // `identityAvatar: nextAvatars[0]` — after this reorder slot 0 becomes
    // 'b.png', so a positional rewrite would flip identityAvatar to 'b.png'
    // and this goes red.
    useChatStore.setState({
      groupChats: [
        mkGroupChat({ fileName: 'g.jsonl', characterAvatars: ['a.png', 'b.png'], identityAvatar: 'a.png' }),
      ],
    });

    useChatStore.getState().reorderGroupMembers('g.jsonl', ['b.png', 'a.png']);

    const record = useChatStore.getState().getGroupChatByFile('g.jsonl');
    expect(record?.characterAvatars).toEqual(['b.png', 'a.png']);
    expect(record?.identityAvatar).toBe('a.png');
  });

  it('removeGroupChatMember, even when removing the identity member itself (and still prunes muted/overrides)', () => {
    // KILLS: removeGroupChatMember deleting identityAvatar (or resetting it
    // to the new slot 0) when the removed avatar IS the identity — the
    // record must keep addressing the same server row even though that
    // avatar is no longer a roster member.
    useChatStore.setState({
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['a.png', 'b.png', 'c.png'],
          characterNames: ['A', 'B', 'C'],
          identityAvatar: 'a.png',
          mutedAvatars: ['a.png'],
          talkativenessOverrides: { 'a.png': 0.5 },
        }),
      ],
    });

    useChatStore.getState().removeGroupChatMember('g.jsonl', 'a.png');

    const record = useChatStore.getState().getGroupChatByFile('g.jsonl');
    expect(record?.characterAvatars).toEqual(['b.png', 'c.png']);
    expect(record?.identityAvatar).toBe('a.png');
    // Unchanged behavior (not this story's concern, but a mutation that
    // dropped these while touching the function would slip through
    // otherwise): the removed avatar's mute/override entries are pruned.
    expect(record?.mutedAvatars).toEqual([]);
    expect(record?.talkativenessOverrides).toEqual({});
  });

  it('addGroupChatMember', () => {
    // KILLS: addGroupChatMember resetting identityAvatar to the newly
    // appended avatar or to slot 0.
    useChatStore.setState({
      messages: [],
      groupChats: [
        mkGroupChat({ fileName: 'g.jsonl', characterAvatars: ['a.png', 'b.png'], identityAvatar: 'a.png' }),
      ],
    });

    useChatStore.getState().addGroupChatMember('g.jsonl', mkChar('C', 'c.png'));

    const record = useChatStore.getState().getGroupChatByFile('g.jsonl');
    expect(record?.characterAvatars).toEqual(['a.png', 'b.png', 'c.png']);
    expect(record?.identityAvatar).toBe('a.png');
  });
});

// ---------------------------------------------------------------------------
// Creation freezes the identity
// ---------------------------------------------------------------------------

describe('creation freezes identityAvatar', () => {
  it('startNewGroupChat freezes characters[0]', async () => {
    // KILLS: startNewGroupChat omitting identityAvatar (tsc catches that —
    // this pins the VALUE) or freezing the wrong slot.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');

    await useChatStore.getState().startNewGroupChat([charA, charB]);

    const fileName = useChatStore.getState().currentChatFile;
    expect(fileName).toBeTruthy();
    const record = useChatStore.getState().getGroupChatByFile(fileName!);
    expect(record?.identityAvatar).toBe('a.png');
  });

  it("convertCurrentToGroup freezes the solo character's avatar, never additionalCharacters[0]", async () => {
    // KILLS: `identityAvatar: additionalCharacters[0].avatar` — the solo
    // chat's server row already exists under the CURRENT character's avatar
    // ('c.png'); freezing on the first additional member ('d.png') would
    // fork a new empty row on the next save.
    useChatStore.setState({ currentChatFile: 'solo.jsonl', messages: [] });
    const charC = mkChar('C', 'c.png');
    const charD = mkChar('D', 'd.png');

    await useChatStore.getState().convertCurrentToGroup(charC, [charD]);

    const record = useChatStore.getState().getGroupChatByFile('solo.jsonl');
    expect(record?.identityAvatar).toBe('c.png');
  });
});

// ---------------------------------------------------------------------------
// The save path: sendGroupMessage after a reorder
// ---------------------------------------------------------------------------

describe('group saves resolve identity from the registry, not the roster argument', () => {
  it('a send after a reorder saves under the frozen identity for every save this turn', async () => {
    // KILLS (REQUIRED KILL b): buildChatPayload reverted to
    // `groupCharacters[0].avatar` — the roster argument sendGroupMessage
    // receives below is post-drag order [charB, charA], so that
    // implementation reports 'b.png' for every call and this goes red on
    // the very first assertion.
    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useChatStore.setState({
      currentChatFile: 'g.jsonl',
      messages: [],
      isSending: false,
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['b.png', 'a.png'], // post-drag roster order
          characterNames: ['B', 'A'],
          identityAvatar: 'a.png', // the ORIGINAL slot-0 member, frozen
        }),
      ],
    });

    // The roster argument mirrors the post-drag order too — this is what a
    // real caller (GroupChatControls after a drag) would pass.
    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('a.png');
    }
    // The registry has a live record, so the slot-0 fallback (and its
    // one-shot warning) must never fire.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });

  it('a ghost identity member (no longer in the live character roster) still resolves for save and load', async () => {
    // KILLS: any implementation that derives the save/load avatar from the
    // CURRENT character roster (`characters`) instead of the registry
    // record — 'ghost.png' names no character in `characters` below, so a
    // roster-derived avatar could never produce it.
    const marcus = mkChar('Marcus', 'marcus.png');
    const record = mkGroupChat({
      fileName: 'ghost.jsonl',
      characterAvatars: ['ghost.png', 'marcus.png'],
      characterNames: ['Ghost', 'Marcus'],
      identityAvatar: 'ghost.png',
    });
    useChatStore.setState({
      currentChatFile: 'ghost.jsonl',
      messages: [],
      isSending: false,
      groupChats: [record],
    });

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);

    await useChatStore.getState().sendGroupMessage('hi', [marcus]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('ghost.png');
    }

    const loadSpy = vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadGroupChat(record);
    expect(loadSpy).toHaveBeenCalledWith('ghost.png', 'ghost.jsonl');
  });
});

// ---------------------------------------------------------------------------
// The truncating-edit path (deleteMessage / persistTruncatingEdit)
// ---------------------------------------------------------------------------

describe('persistTruncatingEdit resolves identity from the registry too', () => {
  it('deleteMessage saves under the frozen identity with allow_truncate', async () => {
    // KILLS: a save call site that resolves the avatar from
    // `chars[0].avatar` (the live-roster reconstruction persistTruncatingEdit
    // builds for ITS OWN `character` argument) rather than letting
    // buildChatPayload resolve it from the registry — chars[0] here is
    // whichever of A/B sorts first in characterAvatars ('a.png'), so a
    // roster-order bug and the correct answer coincide unless the record's
    // identity is the one still standing after a reorder; the reorder below
    // moves 'a.png' out of slot 0 to separate the two.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useCharacterStore.setState({ characters: [charA, charB] });

    const msg = mkMsg('to be deleted');
    useChatStore.setState({
      currentChatFile: 'g.jsonl',
      messages: [msg],
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['b.png', 'a.png'],
          characterNames: ['B', 'A'],
          identityAvatar: 'a.png',
        }),
      ],
    });

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    useChatStore.getState().deleteMessage(msg.id);
    await vi.waitFor(() => expect(saveSpy).toHaveBeenCalled());

    expect(saveSpy.mock.calls[0][0]).toBe('a.png');
    expect(saveSpy.mock.calls[0][4]).toBe(true); // allow_truncate
  });
});

// ---------------------------------------------------------------------------
// loadGroupChat
// ---------------------------------------------------------------------------

describe('loadGroupChat resolves against the frozen identity', () => {
  it('loads using identityAvatar, not characterAvatars[0]', async () => {
    // KILLS (REQUIRED KILL e): loadGroupChat reverted to
    // `groupChat.characterAvatars[0]` — slot 0 is 'b.png' here, identity is
    // 'a.png'; a slot-0 read calls getChatWithHeader with the wrong avatar.
    const getSpy = vi
      .spyOn(api, 'getChatWithHeader')
      .mockResolvedValue({ header: null, messages: [], server_ts: 5 });
    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      identityAvatar: 'a.png',
    });

    await useChatStore.getState().loadGroupChat(record);

    expect(getSpy).toHaveBeenCalledWith('a.png', 'g.jsonl');
    expect(useChatStore.getState().error).toBeNull();
  });

  it('sets an error and never calls the server when identityAvatar is empty', async () => {
    // A corrupt/never-set record must fail loudly, not silently degrade to
    // slot 0 (which could load a completely unrelated chat's row).
    const getSpy = vi
      .spyOn(api, 'getChatWithHeader')
      .mockResolvedValue({ header: null, messages: [], server_ts: 5 });
    const record = mkGroupChat({ fileName: 'g.jsonl', identityAvatar: '' });

    await useChatStore.getState().loadGroupChat(record);

    expect(getSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().error).toBe('Group chat record is missing its server identity');
    expect(useChatStore.getState().isLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backfill — localStorage (migrateGroupChat via refreshGroupChats)
// ---------------------------------------------------------------------------

describe('migrateGroupChat backfills identityAvatar for pre-#458 records', () => {
  it('via a localStorage refresh', () => {
    // KILLS (REQUIRED KILL d): the backfill written as
    // `raw.identityAvatar ?? (raw.characterAvatars?.[0] ?? '')` instead of
    // the explicit non-empty-string check — `??` only falls through on
    // null/undefined, so a stored `identityAvatar: ''` would be KEPT as ''
    // instead of backfilling to slot 0, and the third case below goes red.
    const legacy = {
      fileName: 'legacy.jsonl',
      characterNames: ['X', 'Y'],
      characterAvatars: ['x.png', 'y.png'],
      lastMessage: '',
      createdAt: 0,
    };
    const hasIdentity = {
      fileName: 'has-identity.jsonl',
      characterNames: ['X', 'Y'],
      characterAvatars: ['x.png', 'y.png'],
      identityAvatar: 'y.png',
      lastMessage: '',
      createdAt: 0,
    };
    const emptyIdentity = {
      fileName: 'empty-identity.jsonl',
      characterNames: ['X', 'Y'],
      characterAvatars: ['x.png', 'y.png'],
      identityAvatar: '',
      lastMessage: '',
      createdAt: 0,
    };
    memoryStorage.setItem(
      'sillytavern_group_chats',
      JSON.stringify([legacy, hasIdentity, emptyIdentity])
    );

    useChatStore.getState().refreshGroupChats();

    const byFile = Object.fromEntries(
      useChatStore.getState().groupChats.map((g) => [g.fileName, g.identityAvatar])
    );
    expect(byFile['legacy.jsonl']).toBe('x.png');
    expect(byFile['has-identity.jsonl']).toBe('y.png');
    expect(byFile['empty-identity.jsonl']).toBe('x.png');
  });

  it('via the server-apply path (fetchPrefs)', async () => {
    const legacy = {
      fileName: 'server-legacy.jsonl',
      characterNames: ['X', 'Y'],
      characterAvatars: ['x.png', 'y.png'],
      lastMessage: '',
      createdAt: 0,
    };
    getSettingsBlob.mockResolvedValueOnce({
      stm_chat_state: {
        authorNotes: {},
        chatVariables: {},
        groupChats: [legacy],
        _ts: 999,
      },
    });

    await useChatStore.getState().fetchPrefs();

    const record = useChatStore.getState().getGroupChatByFile('server-legacy.jsonl');
    expect(record?.identityAvatar).toBe('x.png');
  });
});

// ---------------------------------------------------------------------------
// Round-trip persistence
// ---------------------------------------------------------------------------

describe('a reorder round-trips identityAvatar through both persistence layers', () => {
  it('localStorage and the debounced server patch both carry the frozen identity', async () => {
    // KILLS: identityAvatar living only in the in-memory store object
    // (e.g. spread lost across a serialization boundary) — this fails if
    // EITHER persistence layer drops the field.
    vi.useFakeTimers();
    try {
      // First-sync branch (no stm_chat_state yet) unconditionally flips
      // _persistEnabled on, same as a real fresh-login session.
      await useChatStore.getState().fetchPrefs();

      useChatStore.setState({
        groupChats: [
          mkGroupChat({ fileName: 'g.jsonl', characterAvatars: ['a.png', 'b.png'], identityAvatar: 'a.png' }),
        ],
      });

      useChatStore.getState().reorderGroupMembers('g.jsonl', ['b.png', 'a.png']);

      const storedRaw = memoryStorage.getItem('sillytavern_group_chats');
      expect(storedRaw).toBeTruthy();
      const stored = JSON.parse(storedRaw!) as GroupChatInfo[];
      expect(stored.find((g) => g.fileName === 'g.jsonl')?.identityAvatar).toBe('a.png');

      // schedulePersist debounces 300ms.
      vi.advanceTimersByTime(300);

      expect(patchServerKey).toHaveBeenCalled();
      const lastCall = patchServerKey.mock.calls[patchServerKey.mock.calls.length - 1];
      const payload = lastCall[1] as { groupChats: GroupChatInfo[] };
      expect(payload.groupChats.find((g) => g.fileName === 'g.jsonl')?.identityAvatar).toBe('a.png');
    } finally {
      vi.useRealTimers();
    }
  });
});
