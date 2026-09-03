/**
 * E9-S9 (#458) — group recall identity is positional.
 *
 * Before this story, every group save/load/recall read `characterAvatars[0]`
 * — a roster POSITION, not a stable identity. Reordering or removing members
 * shifted slot 0, so the very next save addressed a DIFFERENT server row
 * (`(character_avatar, file_name)`), orphaning the old row and its message
 * embeddings with no cascade. The fix freezes the identity at creation as
 * `GroupChatInfo.identityAvatar`, written in FOUR places (`startNewGroupChat`,
 * `convertCurrentToGroup`, `migrateGroupChat`'s backfill, and — round 3 H5 —
 * `reconcileGroupIdentities`, which runs on incoming sync data BEFORE
 * `migrateGroupChat` and may overwrite only a MISSING or EMPTY incoming
 * identity with this client's own local one; it never touches a non-empty
 * incoming identity) and read through exactly two helpers
 * (`groupIdentityAvatar`, `resolveGroupIdentityAvatar`) — neither exported,
 * so every test below drives a real store action and asserts on what
 * actually got sent/loaded, per this repo's house style
 * (chatStore.callSites.test.ts, etc.).
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
  // F4 (review round 1): resetUser() clears groupIdentityByFile (the F3
  // memo) and re-arms positionalFallbackWarnedThisSession, in addition to
  // the store fields this suite already needed reset — a plain setState
  // could leave either module-private latch dirty from a prior test.
  useChatStore.getState().resetUser();
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

  it('startNewGroupChat([]) bails before api.createChat, sets an error, and never dereferences characters[0]', async () => {
    // Review round 1 F1: an empty roster is reachable in production (the
    // sidebar renders saved groups before characters load, or after every
    // member card is deleted; setGroupChatCharacters skips unknown avatars
    // while still flipping isGroupChatMode true; ChatView's New-chat /
    // Delete-messages call startNewGroupChat(groupChatCharacters) with no
    // length guard). Before the fix, `characters[0].avatar` threw AFTER
    // api.createChat had already run, orphaning a server file.
    // KILLS: removing the `characters.length === 0` guard — createChat gets
    // called and/or the call throws instead of resolving with an error set.
    const createChatSpy = vi.spyOn(api, 'createChat');
    const priorFile = useChatStore.getState().currentChatFile;

    await expect(useChatStore.getState().startNewGroupChat([])).resolves.toBeUndefined();

    expect(createChatSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().currentChatFile).toBe(priorFile);
    expect(useChatStore.getState().error).toBe('Group has no loaded members');
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

  it("deleteGroupChat on the OPEN chat doesn't fall back to slot 0 on the next send (F3 memo)", async () => {
    // Review round 1 F3: deleteGroupChat only filters the registry array —
    // it doesn't touch currentChatFile, exit group mode, or clear messages.
    // Without a last-known-good memo, the very next save after deleting the
    // OPEN group's record would find no record, fall to
    // warnPositionalFallback's roster-slot-0 read, and fork the chat onto a
    // new server tuple — the exact #458 harm, reachable through a normal UI
    // gesture (the sidebar trash icon).
    // KILLS: removing the memo read from resolveGroupIdentityAvatar — after
    // the delete below the registry has no record for 'g.jsonl', so a
    // memo-less resolveGroupIdentityAvatar returns null and buildChatPayload
    // falls to groupCharacters[0].avatar = 'b.png' on the second send.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useChatStore.setState({
      currentChatFile: 'g.jsonl',
      messages: [],
      isSending: false,
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
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Prime the memo: one send while the record still exists.
    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);
    expect(saveSpy.mock.calls.every((call) => call[0] === 'a.png')).toBe(true);

    // The sidebar trash icon on the OPEN chat: registry entry gone,
    // currentChatFile/messages/group mode untouched — exactly what
    // deleteGroupChat does today.
    useChatStore.getState().deleteGroupChat('g.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')).toBeNull();
    expect(useChatStore.getState().currentChatFile).toBe('g.jsonl');

    saveSpy.mockClear();
    await useChatStore.getState().sendGroupMessage('hi again', [charB, charA]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('a.png');
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });
});

// ---------------------------------------------------------------------------
// Each explicit memo warm, in isolation (review round 2 G3 — zero coverage
// before this: with all three `groupIdentityByFile.set(...)` warm lines
// deleted, the full 2029-test suite stayed green, because both F3 tests
// primed the memo through a SEND, which itself warms the memo via
// buildChatPayload's own resolveGroupIdentityAvatar call — never isolating
// loadGroupChat's/startNewGroupChat's/convertCurrentToGroup's own warm)
// ---------------------------------------------------------------------------

describe('each explicit memo warm has its own coverage (G3, review round 2)', () => {
  it('loadGroupChat warms the memo on its own (no prior save)', async () => {
    // KILLS: deleting `groupIdentityByFile.set(groupChat.fileName, avatarUrl);`
    // inside loadGroupChat — the memo is empty at delete time below, so the
    // send afterward falls to warnPositionalFallback's roster-slot-0 avatar
    // ('b.png') instead of the frozen 'a.png'.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      characterNames: ['B', 'A'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({
      groupChats: [record],
      currentChatFile: null,
      messages: [],
      isSending: false,
    });
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });

    await useChatStore.getState().loadGroupChat(record);

    useChatStore.getState().deleteGroupChat('g.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')).toBeNull();

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('a.png');
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });

  it('startNewGroupChat warms the memo on its own (no prior save)', async () => {
    // KILLS: deleting `groupIdentityByFile.set(fileName, characters[0].avatar);`
    // inside startNewGroupChat.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');

    await useChatStore.getState().startNewGroupChat([charA, charB]);
    const fileName = useChatStore.getState().currentChatFile!;
    expect(fileName).toBeTruthy();

    useChatStore.getState().deleteGroupChat(fileName);
    expect(useChatStore.getState().getGroupChatByFile(fileName)).toBeNull();

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('a.png');
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });

  it('convertCurrentToGroup warms the memo on its own (no prior save)', async () => {
    // KILLS: deleting
    // `groupIdentityByFile.set(currentChatFile, currentCharacter.avatar);`
    // inside convertCurrentToGroup.
    useChatStore.setState({ currentChatFile: 'solo.jsonl', messages: [] });
    const charC = mkChar('C', 'c.png');
    const charD = mkChar('D', 'd.png');

    await useChatStore.getState().convertCurrentToGroup(charC, [charD]);

    useChatStore.getState().deleteGroupChat('solo.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('solo.jsonl')).toBeNull();

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useChatStore.getState().sendGroupMessage('hi', [charD, charC]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('c.png');
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });
});

// ---------------------------------------------------------------------------
// A live record with its OWN identity corrupted (empty), distinct from the
// record being gone entirely — resolveGroupIdentityAvatar must fall to the
// memo here too (G5, review round 2)
// ---------------------------------------------------------------------------

describe('resolveGroupIdentityAvatar falls to the memo for a live-but-corrupt record (G5)', () => {
  it("a record with an empty identityAvatar resolves through the memo, not straight to slot 0", async () => {
    // Before this fix: resolveGroupIdentityAvatar returned EARLY the
    // moment a live record was found, even when that record's own
    // identityAvatar was '' — never consulting the memo, which is a
    // strictly better witness for this file than a corrupt-but-present
    // record. The two flushChatOnUnload/buildChatPayload comments already
    // claimed the fallback fires only when NEITHER a record NOR a memo
    // entry exists; this closes the gap between that claim and the code.
    // KILLS: restoring the early return (`if (groupChat) { const identity
    // = groupIdentityAvatar(groupChat); if (identity) memo.set(...); return
    // identity; }`) — with the record's identity corrupted to '' below,
    // that reverted code returns null regardless of the memo, and
    // buildChatPayload falls to warnPositionalFallback's slot-0 avatar
    // ('b.png') instead of the memoized 'a.png'.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      characterNames: ['B', 'A'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({
      groupChats: [record],
      currentChatFile: null,
      messages: [],
      isSending: false,
    });
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });

    // Prime the memo with the record's real identity.
    await useChatStore.getState().loadGroupChat(record);

    // Corrupt the LIVE record's own identity (still present in the
    // registry, just empty) — distinct from deleteGroupChat, which removes
    // the record entirely.
    useChatStore.setState({ groupChats: [{ ...record, identityAvatar: '' }] });

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);

    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('a.png');
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[E9-S9]'));
  });
});

// ---------------------------------------------------------------------------
// warnPositionalFallback and its call site (review round 1 F4 — zero
// coverage before this: the reviewer mutated the fallback to return '' and
// removed both the latch and the resetUser reset, and all 2024 tests
// stayed green)
// ---------------------------------------------------------------------------

describe('warnPositionalFallback: the roster-slot-0 degraded path', () => {
  it('is used (and warned about exactly once) across multiple sends when a group has no record and no memo', async () => {
    // No groupChats record for 'g.jsonl' and (thanks to beforeEach's
    // resetUser()) no memo entry either, so resolveGroupIdentityAvatar
    // returns null on every call and buildChatPayload must fall back to
    // warnPositionalFallback(groupCharacters[0].avatar).
    // KILLS: warnPositionalFallback mutated to return '' — every saveChat
    // arg0 below would be '' instead of 'b.png'.
    // KILLS: the `positionalFallbackWarnedThisSession` latch removed (warn
    // unconditionally) — the second send below would add a second
    // '[E9-S9]' warning, so the count assertion goes from 1 to 2 (or more).
    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useChatStore.setState({
      currentChatFile: 'g.jsonl',
      messages: [],
      isSending: false,
      groupChats: [], // no registry record at all
    });

    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);
    await useChatStore.getState().sendGroupMessage('hi again', [charB, charA]);

    // Each send is Fix#1 + finally-flush, so >=4 saves across both sends.
    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toBe('b.png'); // roster slot 0 — the intended degraded answer
    }
    const e9s9Warnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[E9-S9]')
    );
    expect(e9s9Warnings).toHaveLength(1);
  });

  it('resetUser() re-arms the latch so the next fallback warns again', async () => {
    // KILLS: the `positionalFallbackWarnedThisSession = false` reset
    // removed from resetUser() — the second send below (after resetUser())
    // would add zero new '[E9-S9]' warnings instead of exactly one.
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const countE9S9 = () =>
      warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[E9-S9]')
      ).length;

    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useChatStore.setState({
      currentChatFile: 'g.jsonl',
      messages: [],
      isSending: false,
      groupChats: [],
    });
    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);
    expect(countE9S9()).toBe(1);

    // Logout/user-switch: resetUser() clears the registry, the memo, AND
    // (per this test) must re-arm the warn latch.
    useChatStore.getState().resetUser();
    warnSpy.mockClear();
    useChatStore.setState({
      currentChatFile: 'g2.jsonl',
      messages: [],
      isSending: false,
      groupChats: [],
    });

    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);
    expect(countE9S9()).toBe(1);
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
    // buildChatPayload resolve it from the registry — `chars[0]` here is
    // 'b.png' (characterAvatars[0] in the record below), while the frozen
    // identity is 'a.png', so that wrong implementation reports 'b.png' and
    // this goes red on the very first assertion.
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

  it("deleteMessage still persists after deleteGroupChat removes the OPEN group's record (G2, review round 2)", async () => {
    // Before this fix: persistTruncatingEdit picked its solo-vs-group
    // branch from `getGroupChatByFile(currentChatFile)` alone. After
    // deleteGroupChat removes the OPEN group's record, that lookup returns
    // null, so the old code took the SOLO arm — selectedCharacter is null
    // in group mode — and returned WITHOUT saving. Message delete and
    // hide-from-AI would silently persist nothing in exactly the window F3
    // declared covered.
    // KILLS (G2): reverting the branch condition to `if (groupChat)` —
    // after the delete below, groupChat is null, so that condition takes
    // the solo arm and api.saveChat is never called.
    const charA = mkChar('A', 'a.png');
    const charB = mkChar('B', 'b.png');
    useCharacterStore.setState({ characters: [charA, charB] });

    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      characterNames: ['B', 'A'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({ groupChats: [record] });

    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: null,
      messages: [],
      server_ts: 1,
    });
    // Real UI flow (Sidebar's handleGroupChatSelect): enter group mode,
    // THEN load — this is also what warms the F3 memo for 'g.jsonl'.
    await useCharacterStore.getState().setGroupChatCharacters(['b.png', 'a.png']);
    await useChatStore.getState().loadGroupChat(record);

    const msg = mkMsg('to be deleted');
    useChatStore.setState({ messages: [msg] });

    // The sidebar trash icon on the OPEN chat.
    useChatStore.getState().deleteGroupChat('g.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')).toBeNull();
    expect(useCharacterStore.getState().isGroupChatMode).toBe(true);

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    useChatStore.getState().deleteMessage(msg.id);
    await vi.waitFor(() => expect(saveSpy).toHaveBeenCalled());

    expect(saveSpy.mock.calls[0][0]).toBe('a.png');
    expect(saveSpy.mock.calls[0][4]).toBe(true); // allow_truncate
  });

  it("a SOLO chat left mid-conversion by a failed startNewGroupChat is never saved as a group (H1, review round 3)", async () => {
    // Round 3 H1 (MAJOR — introduced by the G2 fix): Sidebar's "Start Group
    // Chat" flow calls the SYNCHRONOUS characterStore.startGroupChat()
    // (mode -> true, selectedCharacter -> null) and only THEN the async
    // chatStore.startNewGroupChat, whose `set({ currentChatFile })` runs
    // only after `api.createChat` resolves. If that call rejects, the
    // SOLO chat stays open in `currentChatFile` with `isGroupChatMode`
    // stuck true and `selectedCharacter` stuck null. G2's fix branched on
    // `isGroupChatMode` — a GLOBAL flag unrelated to which file is open —
    // so it would misclassify this still-solo chat as a group and save it
    // under a staged member's avatar with `is_group_chat: true`.
    // KILLS: restoring `|| charState.isGroupChatMode` to the `isGroup`
    // condition — with mode stuck true and no memo entry for
    // 'solo-chat.jsonl' (the failed conversion never warmed one), that
    // reverted code takes the group branch and calls api.saveChat with
    // 'b.png' (roster slot 0 of the staged members).
    const solo = mkChar('Solo', 'solo.png');
    const charB = mkChar('B', 'b.png');
    const charC = mkChar('C', 'c.png');
    useCharacterStore.setState({
      selectedCharacter: solo,
      isGroupChatMode: false,
      groupChatCharacters: [charB, charC],
      characters: [solo, charB, charC],
    });
    const msg = mkMsg('hi');
    useChatStore.setState({
      currentChatFile: 'solo-chat.jsonl',
      messages: [msg],
      groupChats: [],
    });

    useCharacterStore.getState().startGroupChat();
    expect(useCharacterStore.getState().isGroupChatMode).toBe(true);
    expect(useCharacterStore.getState().selectedCharacter).toBeNull();

    vi.spyOn(api, 'createChat').mockRejectedValue(new Error('network blip'));
    await useChatStore.getState().startNewGroupChat([charB, charC]).catch(() => {});

    // The failed conversion left the SOLO chat still open — no group file
    // was ever created, and the memo was never warmed for it.
    expect(useChatStore.getState().currentChatFile).toBe('solo-chat.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('solo-chat.jsonl')).toBeNull();

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    useChatStore.getState().deleteMessage(msg.id);
    // persistTruncatingEdit is fire-and-forget from deleteMessage; flush a
    // macrotask so any queued save (correct or not) has had a chance to
    // fire before we inspect the spy.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The fix's honest limit: `selectedCharacter` is still null (nulled by
    // startGroupChat, never restored by the failed conversion), so the
    // correct SOLO branch's own guard drops the save rather than sending
    // it — a safe no-op is acceptable; corrupting it under 'b.png' is not.
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).not.toBe('b.png');
      expect(call[0]).toBe('solo.png');
    }
  });

  it("a file reopened as SOLO after its group record was deleted saves correctly, not as a stale group (I1, review round 4)", async () => {
    // Round 4 I1 (MAJOR — introduced by the H1 fix): the memo never
    // expires (only resetUser clears it), so a file that was a group
    // earlier this session and is later reopened as a genuinely different
    // SOLO chat (deleteGroupChat leaves the server row itself intact,
    // which can then top the identity character's own chat list and get
    // auto-loaded as solo) would still read "group" forever under a
    // memo-only check. The fix needs BOTH signals live: mode AND the memo.
    // KILLS: reverting to `groupIdentityByFile.has(currentChatFile)` alone
    // (dropping `charState.isGroupChatMode &&`) — mode is false below
    // (mirroring the sidebar's real solo-select flow) yet the memo for
    // 'g.jsonl' is still warm from the earlier loadGroupChat call, so that
    // reverted code takes the GROUP branch: roster = groupChatCharacters =
    // [] -> the truncating edit is silently dropped instead of saving the
    // solo chat under 'a.png'.
    const charA = mkChar('A', 'a.png');
    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      characterNames: ['B', 'A'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({ groupChats: [record], currentChatFile: null, messages: [] });
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({ header: null, messages: [], server_ts: 1 });

    // Warm the memo the same way a real load does.
    await useChatStore.getState().loadGroupChat(record);

    // The sidebar trash icon; the server row itself is untouched.
    useChatStore.getState().deleteGroupChat('g.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')).toBeNull();

    // The identity character's chat list now tops 'g.jsonl' as a plain
    // solo chat (still a real row under 'a.png' on the server) and the
    // user opens it — a genuine solo load, exiting group mode.
    useCharacterStore.setState({
      selectedCharacter: charA,
      isGroupChatMode: false,
      groupChatCharacters: [],
    });
    await useChatStore.getState().loadChat('a.png', 'g.jsonl');
    const msg = mkMsg('to be deleted');
    useChatStore.setState({ messages: [msg] });

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    useChatStore.getState().deleteMessage(msg.id);
    await vi.waitFor(() => expect(saveSpy).toHaveBeenCalled());

    expect(saveSpy.mock.calls[0][0]).toBe('a.png');
    const header = saveSpy.mock.calls[0][2][0] as { is_group_chat?: boolean };
    expect(header.is_group_chat).toBeUndefined();
  });

  it("the memo being warm for a DIFFERENT file doesn't make an unrelated open group-mode chat save as a group (I2, review round 4)", async () => {
    // Round 4 I2: the "keyed to currentChatFile" property had no coverage
    // — mutating the predicate to `groupIdentityByFile.size > 0` (any memo
    // entry anywhere unlocks the group branch for whatever file happens to
    // be open) left the whole suite green.
    // KILLS: that exact mutation — the memo below is warm only for
    // 'g.jsonl', but `currentChatFile` is 's.jsonl' (a solo file with no
    // record or memo entry of its own); `size > 0` would still take the
    // group branch and call api.saveChat with is_group_chat true under
    // 'b.png' (groupChatCharacters slot 0, via the slot-0 fallback since
    // 's.jsonl' has no resolvable identity of its own).
    const charB = mkChar('B', 'b.png');
    const charC = mkChar('C', 'c.png');
    const record = mkGroupChat({
      fileName: 'g.jsonl',
      characterAvatars: ['b.png', 'a.png'],
      identityAvatar: 'a.png',
    });
    useChatStore.setState({ groupChats: [record] });
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({ header: null, messages: [], server_ts: 1 });

    // Warm the memo for 'g.jsonl' only.
    await useChatStore.getState().loadGroupChat(record);

    // A DIFFERENT, unrelated chat is now open, staged as a group (mode
    // true) but with no record and no memo entry of ITS OWN.
    useCharacterStore.setState({
      selectedCharacter: null,
      isGroupChatMode: true,
      groupChatCharacters: [charB, charC],
    });
    const msg = mkMsg('to be deleted');
    useChatStore.setState({ currentChatFile: 's.jsonl', messages: [msg] });

    const saveSpy = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });

    useChatStore.getState().deleteMessage(msg.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(saveSpy).not.toHaveBeenCalled();
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
    // KILLS (REQUIRED KILL e, second case): loadGroupChat reverted to
    // `groupChat.characterAvatars[0]` — the record below has a non-empty
    // characterAvatars, so that implementation would happily call
    // getChatWithHeader with the slot-0 avatar and never set `error`.
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
    // KILLS: the fetchPrefs server-apply branch reading `stored.groupChats`
    // directly instead of `.map(migrateGroupChat)` — the legacy fixture
    // below has no `identityAvatar` field at all, so an unmigrated record
    // would leave it `undefined`, not backfilled to 'x.png'.
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

  it('the server-apply path prefers the LOCAL identity when the incoming record is missing it (G4, review round 2)', async () => {
    // Review round 2 G4: `groupChats` syncs as a whole-section blob
    // (whole-section PUT/GET, not per-field). A device still on the
    // pre-#458 bundle would round-trip this section WITHOUT
    // `identityAvatar` at all — it doesn't know the field exists, and
    // rebuilds the blob from its own fixed key list. If this (upgraded)
    // client ran that incoming record straight through migrateGroupChat's
    // ordinary backfill, it would re-derive the identity from the
    // INCOMING record's own slot 0 ('b.png' below) — silently moving this
    // client's frozen identity ('a.png') via sync, with a record present
    // so no fallback warning ever fires. The "unknown locally" half of
    // this behavior (ordinary slot-0 backfill still applies) is the
    // preceding test's 'server-legacy.jsonl' case.
    // KILLS: removing the local-identity preference from
    // reconcileGroupIdentities (or from fetchPrefs's wiring of it) — the
    // identity below would come back 'b.png' instead of 'a.png'.
    useChatStore.setState({
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['b.png', 'a.png'],
          characterNames: ['B', 'A'],
          identityAvatar: 'a.png',
        }),
      ],
    });

    const incomingWithoutIdentity = {
      fileName: 'g.jsonl',
      characterNames: ['B', 'A'],
      characterAvatars: ['b.png', 'a.png'],
      lastMessage: '',
      createdAt: 0,
      // no identityAvatar field at all — a pre-#458 device's round-trip.
    };
    getSettingsBlob.mockResolvedValueOnce({
      stm_chat_state: {
        authorNotes: {},
        chatVariables: {},
        groupChats: [incomingWithoutIdentity],
        _ts: 999,
      },
    });

    await useChatStore.getState().fetchPrefs();

    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')?.identityAvatar).toBe('a.png');
  });

  it("the incoming identity is kept even when the local record disagrees (H3, review round 3)", async () => {
    // Round 3 H3: reconcileGroupIdentities must NEVER prefer the local
    // registry over an incoming record that already carries its OWN
    // non-empty identity — the local-preference rescue exists only for a
    // record that's missing one, not as a general "local wins" rule. If it
    // won unconditionally, a stale/lagging local copy could overwrite a
    // genuinely newer, correct identity written by another (upgraded)
    // device.
    // KILLS: reordering the preference so local wins over a non-empty
    // incoming identity — the result below would be 'b.png' (local)
    // instead of 'a.png' (incoming).
    useChatStore.setState({
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['a.png', 'b.png'],
          characterNames: ['A', 'B'],
          identityAvatar: 'b.png', // local thinks it's 'b.png'
        }),
      ],
    });

    const incomingWithIdentity = {
      fileName: 'g.jsonl',
      characterNames: ['A', 'B'],
      characterAvatars: ['a.png', 'b.png'],
      identityAvatar: 'a.png', // incoming already has its own (different) identity
      lastMessage: '',
      createdAt: 0,
    };
    getSettingsBlob.mockResolvedValueOnce({
      stm_chat_state: {
        authorNotes: {},
        chatVariables: {},
        groupChats: [incomingWithIdentity],
        _ts: 999,
      },
    });

    await useChatStore.getState().fetchPrefs();

    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')?.identityAvatar).toBe('a.png');
  });

  it("an incoming identityAvatar of '' is treated as missing, not as a real (empty) value (H3, review round 3)", async () => {
    // Round 3 H3: `typeof incomingIdentity === 'string' && incomingIdentity
    // !== ''` must NOT be simplified to `??` — `??` only falls through on
    // null/undefined, so an incoming `identityAvatar: ''` (present, but
    // empty) would read as "already has one" and skip the local-preference
    // rescue entirely, same failure shape as REQUIRED KILL d for
    // migrateGroupChat's own backfill.
    // KILLS: reconcileGroupIdentities using
    // `incomingIdentity ?? localByFile.get(rec.fileName)` instead of the
    // explicit non-empty-string check — `??` treats the incoming '' as
    // already-present and passes the RECORD THROUGH UNCHANGED (still
    // carrying identityAvatar: ''), so the local-preference rescue never
    // fires; `migrateGroupChat`'s OWN slot-0 backfill then runs on that
    // still-empty field and derives 'b.png' (this fixture's
    // characterAvatars[0]) — a silent positional fork, the exact #458
    // harm, not 'a.png'. Verified: the result below comes back 'b.png',
    // not ''.
    useChatStore.setState({
      groupChats: [
        mkGroupChat({
          fileName: 'g.jsonl',
          characterAvatars: ['b.png', 'a.png'],
          characterNames: ['B', 'A'],
          identityAvatar: 'a.png',
        }),
      ],
    });

    const incomingEmptyIdentity = {
      fileName: 'g.jsonl',
      characterNames: ['B', 'A'],
      characterAvatars: ['b.png', 'a.png'],
      identityAvatar: '', // present, but empty
      lastMessage: '',
      createdAt: 0,
    };
    getSettingsBlob.mockResolvedValueOnce({
      stm_chat_state: {
        authorNotes: {},
        chatVariables: {},
        groupChats: [incomingEmptyIdentity],
        _ts: 999,
      },
    });

    await useChatStore.getState().fetchPrefs();

    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')?.identityAvatar).toBe('a.png');
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
