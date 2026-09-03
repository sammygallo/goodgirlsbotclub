/** @vitest-environment jsdom */
/**
 * E9-S9 (#458) — the page-unload beacon must use the same identity source as
 * every other group save.
 *
 * `flushChatOnUnload` (chatStore.ts) registers its `pagehide` listener only
 * when `window` exists at import time (see this repo's vitest.config.ts note
 * on why the default project runs in `node`, not `jsdom`) — hence the
 * per-file environment override rather than relying on chatStore.groupIdentity
 * .test.ts's node-env suite to exercise this path.
 *
 * The beacon rebuilds the save payload from module-level `lastSaveContext`
 * (primed by the last real `saveChatToBackend` call) via the SAME
 * `buildChatPayload` every other save path uses — so priming it with a
 * post-reorder roster and then asserting the flushed body's
 * `character_avatar` is the frozen identity (not roster slot 0) proves the
 * beacon can't be raced into addressing the wrong server row mid-generation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Review round 1 F3/F4 follow-up: this file's new deleteGroupChat test
// writes through to localStorage (saveGroupChatsToStorage), which exposed
// that this sandbox's Node build defines its own global `localStorage`
// (via an unconfigured `--localstorage-file` flag — `setItem` is
// `undefined` on it) that shadows jsdom's working implementation even
// under `@vitest-environment jsdom`. Same in-memory Storage stub as the
// node-env suites, installed BEFORE the dynamic import below.
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

const { useChatStore } = await import('./chatStore');
const { api } = await import('../api/client');

import type { GroupChatInfo } from './chatStore';
import type { CharacterInfo } from '../api/client';

function mkChar(name: string, avatar: string): CharacterInfo {
  return { name, avatar } as CharacterInfo;
}

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
  // F4/F3 (review round 1): resetUser() clears groupIdentityByFile (the F3
  // memo) and re-arms positionalFallbackWarnedThisSession between tests in
  // this file, same reasoning as chatStore.groupIdentity.test.ts's beforeEach.
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
});

describe('flushChatOnUnload uses the same identity resolution as every other group save', () => {
  it('flushes with character_avatar === the frozen identity, not the post-drag roster\'s slot 0', async () => {
    // KILLS (REQUIRED KILL f): flushChatOnUnload (or buildChatPayload) reading
    // `lastSaveContext.groupCharacters[0].avatar` instead of resolving through
    // the registry — the priming send below hands the roster in post-drag
    // order [charB, charA], so a slot-0 read reports 'b.png' and this test
    // goes red.
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);

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
          identityAvatar: 'a.png', // the frozen server identity
        }),
      ],
    });

    // Prime `lastSaveContext` the same way a real turn would: a real group
    // send, with the roster in post-drag order.
    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);
    expect(useChatStore.getState().messages.length).toBeGreaterThan(0);
    expect(useChatStore.getState().currentChatFile).toBe('g.jsonl');

    // Simulate the risky mid-generation window flushChatOnUnload guards:
    // isSending true when the tab closes.
    useChatStore.setState({ isSending: true });

    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);

    window.dispatchEvent(new Event('pagehide'));

    // Exactly once proves the listener registered AND fired exactly one
    // flush — a second beacon (e.g. from a duplicated listener) would also
    // pass the body assertion below for the wrong reason.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/chats/save');
    const body = JSON.parse(init.body as string) as { character_avatar: string; file_name: string };
    expect(body.file_name).toBe('g.jsonl');
    expect(body.character_avatar).toBe('a.png');
  });

  it("deleteGroupChat on the OPEN chat doesn't break the unload beacon (F3 memo)", async () => {
    // Review round 1 F3: same hazard as the node-env suite's memo test, but
    // through the unload beacon specifically — flushChatOnUnload's own
    // comment used to claim the registry entry it reads "can't change out
    // from under an in-flight unload," which deleteGroupChat falsifies (it
    // is not gated on isSending, unlike reorder/add/remove). The F3 memo is
    // what makes a corrected version of that claim true again.
    // KILLS: removing the memo read from resolveGroupIdentityAvatar — after
    // the delete below the registry has no record for 'g.jsonl', so this
    // beacon would flush character_avatar 'b.png' (roster slot 0) instead.
    vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null);

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

    // Prime lastSaveContext AND the memo via a real send while the record
    // still exists, roster in post-drag order [charB, charA].
    await useChatStore.getState().sendGroupMessage('hi', [charB, charA]);

    // The sidebar trash icon on the OPEN chat.
    useChatStore.getState().deleteGroupChat('g.jsonl');
    expect(useChatStore.getState().getGroupChatByFile('g.jsonl')).toBeNull();

    useChatStore.setState({ isSending: true });

    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);

    window.dispatchEvent(new Event('pagehide'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init2] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body2 = JSON.parse(init2.body as string) as { character_avatar: string };
    expect(body2.character_avatar).toBe('a.png');
  });
});
