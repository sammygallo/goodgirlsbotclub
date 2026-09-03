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
});
