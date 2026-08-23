import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// R2 of the legacy-id strip scoping (docs/legacy-id-strip-scoping.md): the
// per-id drop rule. An unresolved id matching the STRICT legacy pattern
// (13-digit generateId shape) may be dropped only when the server-recorded
// map named it and its recorded successor is verifiably gone; everything
// else legacy-shaped is kept dangling. Native-format ids keep the old
// confident-drop behavior. Separate file because the sibling suites pin
// their getSettingsBlob mocks differently per-case.
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

const {
  useWorldInfoStore,
  resolveLegacyBookId,
  resolveLegacyEntryId,
  canConfidentlyDropUnresolvedLegacyIds,
} = await import('./worldInfoStore');

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

// Strict 13-digit generateId shapes — the pattern R2 keys on.
const LEGACY_BOOK = 'wibook_1777000000000_aaaaaa';
const LEGACY_ENTRY = 'wi_1777000000001_bbbbbb';
const OTHER_LEGACY_BOOK = 'wibook_1777000000009_zzzzzz';

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

/** Run one login session's fetchPrefs with the given native books (each an
 *  object of {dto, entries}), optional stm_wi_legacy_id_map content, an
 *  optional hydrated stm_worldinfo legacy blob, and optionally a set of
 *  book ids whose per-book entries fetch fails (the degraded-fallback
 *  path: the book survives with entries []). */
async function runSession(opts: {
  map?: Record<string, unknown> | null;
  native?: Array<{ dto: Record<string, unknown>; entries: Record<string, unknown>[] }>;
  blob?: Record<string, unknown>;
  failEntriesFor?: string[];
}): Promise<void> {
  const native = opts.native ?? [];
  listLorebooks.mockResolvedValueOnce(native.map((n) => n.dto));
  getLorebook.mockImplementation(async (id: unknown) => {
    if (opts.failEntriesFor?.includes(String(id))) {
      throw new Error(`simulated entries-fetch failure for ${String(id)}`);
    }
    const hit = native.find((n) => n.dto.id === id);
    if (!hit) throw new Error(`unexpected getLorebook(${String(id)})`);
    return { ...hit.dto, entries: hit.entries };
  });
  listSharedWorldInfoBooks.mockResolvedValueOnce([]);
  const settings: Record<string, unknown> = {};
  if (opts.map) settings.stm_wi_legacy_id_map = opts.map;
  if (opts.blob) settings.stm_worldinfo = opts.blob;
  getSettingsBlob.mockResolvedValue(settings);
  await useWorldInfoStore.getState().fetchPrefs();
  expect(canConfidentlyDropUnresolvedLegacyIds()).toBe(true);
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  useWorldInfoStore.getState().resetUser();
  getSettingsBlob.mockReset();
  getSettingsBlob.mockResolvedValue({});
  importLorebooksFromBlob.mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R2 per-id drop rule — books', () => {
  it('drops a legacy-pattern id the map names when its recorded successor is gone', async () => {
    await runSession({
      map: { books: { [LEGACY_BOOK]: 'uuid-deleted-book' }, entries: {} },
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBeNull();
  });

  it('remaps (never drops) a map-named id whose successor is alive', async () => {
    await runSession({
      map: { books: { [LEGACY_BOOK]: 'uuid-live-book' }, entries: {} },
      native: [{ dto: mkBookDto({ id: 'uuid-live-book', name: 'Live' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe('uuid-live-book');
  });

  it('keeps a legacy-pattern id the map does not name, even with the map present', async () => {
    // The cross-user shape: someone else's legacy book id can never appear
    // in MY map — it must dangle, not drop.
    await runSession({
      map: { books: { [OTHER_LEGACY_BOOK]: 'uuid-deleted-book' }, entries: {} },
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe(LEGACY_BOOK);
  });

  it('keeps a legacy-pattern id when no map section exists at all (blob absent)', async () => {
    // Post-strip straggler shape: no blob in hydration, no map, native
    // fetch green — the old code dropped here; R2 keeps.
    await runSession({
      map: null,
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe(LEGACY_BOOK);
  });

  it('keeps blob-present-but-unpaired ids (the import-failed first login)', async () => {
    // Vulpixxy's realistic first-contact failure mode: blob hydrated with
    // her books, zero native counterparts (import POST failed), no map.
    // The heuristic runs but pairs nothing; the old code dropped both ids
    // here — R2 keeps book AND entry.
    await runSession({
      map: null,
      blob: {
        activeBookIds: [LEGACY_BOOK],
        books: [
          {
            id: LEGACY_BOOK,
            name: 'Blob Book',
            ownerCharacterAvatar: null,
            entries: [
              {
                id: LEGACY_ENTRY,
                keys: ['k'],
                keysSecondary: [],
                content: 'blob lore',
                comment: '',
                relatedIds: [],
              },
            ],
          },
        ],
      },
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe(LEGACY_BOOK);
    expect(resolveLegacyEntryId(LEGACY_BOOK, LEGACY_ENTRY)).toBe(LEGACY_ENTRY);
  });

  it('native-format ids keep the old confident-drop behavior', async () => {
    await runSession({
      map: null,
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId('11111111-2222-4333-8444-555555555555')).toBeNull();
    // The still-live synthetic family shares the prefix but not the strict
    // 13-digit shape — it is NOT protected by the legacy keep-rule.
    expect(resolveLegacyBookId('wibook_chatlocal__somechat.jsonl')).toBeNull();
  });
});

describe('R2 per-id drop rule — entries', () => {
  it('drops a map-named entry id whose recorded successor is gone everywhere', async () => {
    await runSession({
      map: { books: {}, entries: { [LEGACY_ENTRY]: 'uuid-deleted-entry' } },
      native: [{ dto: mkBookDto({ id: 'uuid-book-a', name: 'A' }), entries: [] }],
    });
    expect(resolveLegacyEntryId('uuid-book-a', LEGACY_ENTRY)).toBeNull();
  });

  it('keeps a map-named entry id whose successor is alive in a DIFFERENT book', async () => {
    // The flat/scoped seam: target verification passed against the flat
    // cross-book set, so the filtered map has the pair — but the caller's
    // book does not contain it. Dropping here would use a dead-target
    // rationale on a live target; the reference must dangle instead.
    await runSession({
      map: { books: {}, entries: { [LEGACY_ENTRY]: 'uuid-entry-b' } },
      native: [
        { dto: mkBookDto({ id: 'uuid-book-a', name: 'A' }), entries: [] },
        {
          dto: mkBookDto({ id: 'uuid-book-b', name: 'B' }),
          entries: [mkEntryDto({ id: 'uuid-entry-b', lorebook_id: 'uuid-book-b' })],
        },
      ],
    });
    expect(resolveLegacyEntryId('uuid-book-a', LEGACY_ENTRY)).toBe(LEGACY_ENTRY);
    // …and against the book that actually holds it, it remaps normally.
    expect(resolveLegacyEntryId('uuid-book-b', LEGACY_ENTRY)).toBe('uuid-entry-b');
  });

  it('never authorizes entry drops off a degraded entries fetch', async () => {
    // The spoof the adversarial review caught: book B's per-book entries
    // fetch fails, fetchNativeBooks keeps the book with entries [] and the
    // confidence gate stays open — so a map pair targeting B's entries
    // fails liveness and reads exactly like "successor deleted". The
    // _entriesFetchDegraded flag must veto entry-drop authorization for
    // the whole session.
    await runSession({
      map: { books: {}, entries: { [LEGACY_ENTRY]: 'uuid-entry-b' } },
      native: [
        { dto: mkBookDto({ id: 'uuid-book-a', name: 'A' }), entries: [] },
        { dto: mkBookDto({ id: 'uuid-book-b', name: 'B' }), entries: [] },
      ],
      failEntriesFor: ['uuid-book-b'],
    });
    expect(resolveLegacyEntryId('uuid-book-a', LEGACY_ENTRY)).toBe(LEGACY_ENTRY);
    expect(resolveLegacyEntryId('uuid-book-b', LEGACY_ENTRY)).toBe(LEGACY_ENTRY);
  });

  it('keeps an un-named legacy-pattern entry id; drops a native-format one', async () => {
    await runSession({
      map: { books: {}, entries: {} },
      native: [{ dto: mkBookDto({ id: 'uuid-book-a', name: 'A' }), entries: [] }],
    });
    expect(resolveLegacyEntryId('uuid-book-a', LEGACY_ENTRY)).toBe(LEGACY_ENTRY);
    expect(
      resolveLegacyEntryId('uuid-book-a', '22222222-3333-4444-8555-666666666666')
    ).toBeNull();
  });
});

describe('R2 session scoping', () => {
  it('a previous account\'s map keys never authorize drops after resetUser', async () => {
    // Account A: map names LEGACY_BOOK with a dead successor — drop is
    // authorized this session.
    await runSession({
      map: { books: { [LEGACY_BOOK]: 'uuid-deleted-book' }, entries: {} },
      native: [{ dto: mkBookDto({ id: 'uuid-unrelated', name: 'Other' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBeNull();

    // Logout: the confidence flags reset, closing the gate — resolution
    // reverts to keep-unchanged immediately. (clearLegacyIdRemap also
    // clears the raw key sets as belt-and-braces; that clear isn't
    // independently observable through the public API because
    // buildLegacyIdRemap re-clears at the top of the next session's
    // build — the behavioral property pinned here and below is that no
    // drop authorization survives into account B.)
    useWorldInfoStore.getState().resetUser();
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe(LEGACY_BOOK);

    // …and account B's session (fetches green, NO map) must keep the id,
    // not inherit account A's drop authorization.
    await runSession({
      map: null,
      native: [{ dto: mkBookDto({ id: 'uuid-b-book', name: 'B Book' }), entries: [] }],
    });
    expect(resolveLegacyBookId(LEGACY_BOOK)).toBe(LEGACY_BOOK);
  });
});
