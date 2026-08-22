import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Phase 3.3 step (b) of the memory-consolidation plan — the server-recorded
// legacy id map (stm_wi_legacy_id_map, persisted by ggbc-backend's
// _persist_legacy_id_map) takes precedence over buildLegacyIdRemap's
// heuristic content-signature matching. Separate file from
// legacyIdRemap.test.ts because that file's shared getSettingsBlob mock is
// pinned to always return {} — these tests need to control it per-case.
// ---------------------------------------------------------------------------

const getSettingsBlob = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: () => getSettingsBlob(),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

const listSharedWorldInfoBooks = vi.fn();
const importLorebooksFromBlob = vi.fn();
const listLorebooks = vi.fn();
const getLorebook = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSharedWorldInfoBooks: (...args: unknown[]) => listSharedWorldInfoBooks(...args),
      importLorebooksFromBlob: (...args: unknown[]) => importLorebooksFromBlob(...args),
      listLorebooks: (...args: unknown[]) => listLorebooks(...args),
      getLorebook: (...args: unknown[]) => getLorebook(...args),
    },
  };
});

const { useWorldInfoStore, DEFAULT_ENTRY, remapLegacyBookId, remapLegacyEntryId } =
  await import('./worldInfoStore');
import type { WorldInfoBook, WorldInfoEntry } from './worldInfoStore';

// Same MemoryStorage shim as legacyIdRemap.test.ts — this runtime's global
// localStorage is inert without a real backing store.
class MemoryStorage {
  private store = new Map<string, string>();
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

let idCounter = 0;
function mkEntry(over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  idCounter += 1;
  return {
    ...DEFAULT_ENTRY,
    id: `e${idCounter}`,
    content: 'lore content',
    keys: [],
    keysSecondary: [],
    relatedIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkBook(entries: WorldInfoEntry[], over: Partial<WorldInfoBook> = {}): WorldInfoBook {
  idCounter += 1;
  return {
    id: `b${idCounter}`,
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
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  useWorldInfoStore.getState().resetUser();
  getSettingsBlob.mockReset();
  getSettingsBlob.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildLegacyIdRemap — server map (Phase 3.3 step b)', () => {
  it('resolves a legacy id the content-signature heuristic could never match', async () => {
    // The old entry's content differs from its native counterpart's (as if
    // it were edited after migration) — the heuristic has nothing to match
    // on, so ONLY the server-recorded exact pair can resolve this.
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_legacy_1', comment: 'c', content: 'old text', keys: ['a'] })],
          { id: 'wibook_legacy_1', name: 'Legacy Book', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-book-1', name: 'Legacy Book' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-book-1', name: 'Legacy Book' }),
      entries: [
        mkEntryDto({
          id: 'uuid-entry-1',
          lorebook_id: 'uuid-book-1',
          comment: 'c',
          content: 'EDITED text, no longer matches',
          keys: ['a'],
        }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);
    getSettingsBlob.mockResolvedValue({
      stm_wi_legacy_id_map: {
        books: { wibook_legacy_1: 'uuid-book-1' },
        entries: { wi_legacy_1: 'uuid-entry-1' },
      },
    });

    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyBookId('wibook_legacy_1')).toBe('uuid-book-1');
    expect(remapLegacyEntryId('wi_legacy_1')).toBe('uuid-entry-1');
  });

  it('the server map wins when it disagrees with the heuristic', async () => {
    // Two old entries with IDENTICAL content — the heuristic's greedy
    // signature matching could plausibly pick either one for the (only)
    // matching native entry it's confident about; the server map names
    // exactly which old id maps to which new id, and that must be what
    // ends up in the remap, not a heuristic guess.
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [
            mkEntry({ id: 'wi_a', comment: 'c', content: 'same text', keys: [] }),
            mkEntry({ id: 'wi_b', comment: 'c', content: 'same text', keys: [] }),
          ],
          { id: 'wibook_x', name: 'Book X', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-book-x', name: 'Book X' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-book-x', name: 'Book X' }),
      entries: [
        mkEntryDto({ id: 'uuid-a', lorebook_id: 'uuid-book-x', comment: 'c', content: 'same text' }),
        mkEntryDto({ id: 'uuid-b', lorebook_id: 'uuid-book-x', comment: 'c', content: 'same text' }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);
    // Server says wi_a -> uuid-b (deliberately the OPPOSITE pairing the
    // heuristic's positional greedy match would likely produce).
    getSettingsBlob.mockResolvedValue({
      stm_wi_legacy_id_map: {
        books: {},
        entries: { wi_a: 'uuid-b', wi_b: 'uuid-a' },
      },
    });

    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyEntryId('wi_a')).toBe('uuid-b');
    expect(remapLegacyEntryId('wi_b')).toBe('uuid-a');
  });

  it('ignores a server-mapped id that no longer exists in the current books', async () => {
    useWorldInfoStore.setState({ books: [] });
    listLorebooks.mockResolvedValueOnce([]);
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);
    getSettingsBlob.mockResolvedValue({
      stm_wi_legacy_id_map: {
        books: { wibook_gone: 'uuid-deleted-book' },
        entries: { wi_gone: 'uuid-deleted-entry' },
      },
    });

    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyBookId('wibook_gone')).toBeNull();
    expect(remapLegacyEntryId('wi_gone')).toBeNull();
  });

  it('tolerates a missing/malformed stm_wi_legacy_id_map section (no crash, heuristic still runs)', async () => {
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_old_1', comment: 'c', content: 'text', keys: ['a'] })],
          { id: 'wibook_old_1', name: 'Shared Lore', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
      entries: [
        mkEntryDto({ id: 'uuid-entry-1', lorebook_id: 'uuid-book-1', comment: 'c', content: 'text', keys: ['a'] }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);
    getSettingsBlob.mockResolvedValue({}); // no legacy-id-map section at all

    await expect(useWorldInfoStore.getState().fetchPrefs()).resolves.not.toThrow();

    // The heuristic (content-signature matching) is unaffected by the
    // section's absence.
    expect(remapLegacyBookId('wibook_old_1')).toBe('uuid-book-1');
    expect(remapLegacyEntryId('wi_old_1')).toBe('uuid-entry-1');
  });
});
