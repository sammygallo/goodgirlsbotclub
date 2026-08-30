/**
 * E2-S5 Gap 1 — pre-cutover `wi_fired` keys read through chatStore.ts's
 * getWiFiredForChat/isWiFiredCoveragePartial.
 *
 * `wi_fired` telemetry shipped fa3cd1bf (2026-07-26), 12 days before
 * worldInfoStore's native-CRUD cutover (77e689d2, 2026-08-07). A firing
 * captured in that window is keyed `wibook_<ts>_<rand>:wi_<ts>_<rand>` —
 * the pre-cutover generateId('wibook'|'wi') scheme — and nothing remapped
 * those keys onto the entries' current native ids, so a real pre-cutover
 * firing reads as "this entry never fired." These tests drive a REAL
 * worldInfoStore.fetchPrefs() (mocked network) so remapLegacyBookId/
 * remapLegacyEntryId are populated exactly like a real login — never
 * faked directly — mirroring legacyIdRemap.test.ts's own harness, then
 * drive chatStore's real loadChat() to hydrate wiFiredByFile from a
 * synthetic header and assert on the exported read accessors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chatStore pulls serverSettings (and the api layer) at module load, and
// chatStore -> authStore -> lovenseStore -> chatStore is a require cycle
// whose leaf subscribes at module scope — same prelude as
// chatStore.callSites.test.ts / chatStore.ragBoundary.test.ts.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

// worldInfoStore's remap-map build (buildLegacyIdRemap) and chatStore's own
// usage store both write localStorage; this runtime's global is an inert
// `{}` (Node's Web Storage needs --localstorage-file). Same in-memory
// Storage every other chatStore/worldInfoStore suite installs.
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
globalThis.localStorage = new MemoryStorage() as unknown as Storage;

const { useChatStore, getWiFiredForChat, isWiFiredCoveragePartial } = await import('./chatStore');
const { useWorldInfoStore, remapLegacyBookId, DEFAULT_ENTRY } = await import('./worldInfoStore');
const { api } = await import('../api/client');
const { wiFiredKey } = await import('../utils/wiFired');

import type { WorldInfoBook, WorldInfoEntry } from './worldInfoStore';

const AVATAR = 'legacy-remap-char.png';

function mkEntry(id: string, over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    ...DEFAULT_ENTRY,
    id,
    content: 'lore content',
    keys: [],
    keysSecondary: [],
    relatedIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkBook(id: string, entries: WorldInfoEntry[], over: Partial<WorldInfoBook> = {}): WorldInfoBook {
  return {
    id,
    name: 'Test Book',
    entries,
    ownerCharacterAvatar: null,
    scope: 'world',
    ownerHandle: '',
    visibility: 'private',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkEntryDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-entry',
    lorebook_id: 'dto-book',
    server_ts: 1,
    keys: [],
    content: '',
    comment: '',
    enabled: true,
    constant: false,
    caseSensitive: false,
    position: 'before_char',
    depth: 4,
    order: 100,
    keysSecondary: [],
    selective: false,
    selectiveLogic: 'AND_ANY',
    scanDepth: null,
    probability: 100,
    useProbability: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    preventRecursion: false,
    excludeRecursion: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    critical: false,
    category: '',
    relatedIds: [],
    source: 'manual',
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function mkBookDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-book',
    ownerHandle: 'alice',
    server_ts: 1,
    name: 'DTO Book',
    ownerCharacterAvatar: null,
    autoExtracted: false,
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  (globalThis.localStorage as unknown as MemoryStorage).clear();
  useWorldInfoStore.getState().resetUser();
  vi.restoreAllMocks();
});

/**
 * Drives a real worldInfoStore.fetchPrefs() so remapLegacyBookId/
 * remapLegacyEntryId are populated exactly like a real login: one old-id
 * book ('wibook_old_1', containing entry 'wi_old_1') gets matched onto its
 * native-fetched counterpart ('uuid-book-1' / 'uuid-entry-1') by
 * (scope, name) + content signature — same fixture shape as
 * legacyIdRemap.test.ts's seedMigratedBook, kept local to this file since
 * each suite owns its own api mocks.
 */
async function seedMigratedBook(): Promise<void> {
  useWorldInfoStore.setState({
    books: [
      mkBook('wibook_old_1', [mkEntry('wi_old_1', { comment: 'c', content: 'text', keys: ['a'] })], {
        name: 'Shared Lore',
      }),
    ],
  });
  vi.spyOn(api, 'listLorebooks').mockResolvedValue([mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' })] as never);
  vi.spyOn(api, 'getLorebook').mockResolvedValue({
    ...mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
    entries: [
      mkEntryDto({ id: 'uuid-entry-1', lorebook_id: 'uuid-book-1', comment: 'c', content: 'text', keys: ['a'] }),
    ],
  } as never);
  vi.spyOn(api, 'listSharedWorldInfoBooks').mockResolvedValue([] as never);
  vi.spyOn(api, 'importLorebooksFromBlob').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 } as never);

  await useWorldInfoStore.getState().fetchPrefs();

  // Sanity check on the primitive every test below depends on — if this
  // ever stops holding, both tests fail for a confusing reason.
  expect(remapLegacyBookId('wibook_old_1')).toBe('uuid-book-1');
}

describe('getWiFiredForChat — legacy-id remap (E2-S5 Gap 1, AC1)', () => {
  it('folds a pre-cutover key onto its current native id once the remap map is populated', async () => {
    await seedMigratedBook();
    const chatFile = 'legacy-remap-resolved.jsonl';
    const legacyKey = wiFiredKey('wibook_old_1', 'wi_old_1');
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [legacyKey]: { first_turn: 0, last_turn: 3, count: 5 } } },
      messages: [],
      server_ts: 1,
    });

    await useChatStore.getState().loadChat(AVATAR, chatFile);

    expect(getWiFiredForChat(chatFile)).toEqual({
      [wiFiredKey('uuid-book-1', 'uuid-entry-1')]: { first_turn: 0, last_turn: 3, count: 5 },
    });
    expect(isWiFiredCoveragePartial(chatFile), 'a fully-resolved chat must not read as partial coverage').toBe(
      false
    );
  });

  it('KEEPS a legacy key with no known remap rather than dropping it, and flags partial coverage (T1/T2)', async () => {
    // No fetchPrefs/migration driven here — resetUser() alone leaves the
    // remap map empty, which is what BOTH "genuinely unmatched" and "the
    // readiness gate hasn't resolved yet" look like from the caller's side
    // (remapLegacyBookId/remapLegacyEntryId return null either way).
    const chatFile = 'legacy-remap-unresolved.jsonl';
    const legacyKey = wiFiredKey('wibook_1777000000000_aaaaaa', 'wi_1777000000001_bbbbbb');
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [legacyKey]: { first_turn: 2, last_turn: 6, count: 9 } } },
      messages: [],
      server_ts: 1,
    });

    await useChatStore.getState().loadChat(AVATAR, chatFile);

    const fired = getWiFiredForChat(chatFile);
    expect(fired?.[legacyKey], 'an unresolved legacy key must survive, never be dropped').toEqual({
      first_turn: 2,
      last_turn: 6,
      count: 9,
    });
    expect(isWiFiredCoveragePartial(chatFile), 'an unresolved legacy key must flag partial coverage').toBe(true);
  });

  it('a native-shaped key with no lore data loaded is left alone and reads as full coverage', async () => {
    // The overwhelmingly common case post-cutover: no legacy residue at
    // all, so the "no remap found" branch must NOT be read as partial —
    // see wiFired.ts's looksLikeLegacyWiFiredKey for the shape check that
    // keeps this from being misflagged.
    const chatFile = 'ordinary-native-chat.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { 'native-book-1:native-entry-1': { first_turn: 0, last_turn: 1, count: 2 } } },
      messages: [],
      server_ts: 1,
    });

    await useChatStore.getState().loadChat(AVATAR, chatFile);

    expect(getWiFiredForChat(chatFile)).toEqual({
      'native-book-1:native-entry-1': { first_turn: 0, last_turn: 1, count: 2 },
    });
    expect(isWiFiredCoveragePartial(chatFile)).toBe(false);
  });

  it('returns undefined / false for a chat with no captured telemetry at all', () => {
    expect(getWiFiredForChat('never-loaded.jsonl')).toBeUndefined();
    expect(isWiFiredCoveragePartial('never-loaded.jsonl')).toBe(false);
  });
});
