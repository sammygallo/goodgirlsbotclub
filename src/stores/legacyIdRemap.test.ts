import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Phase 3a step 2 — legacy id remap for the stores that persist a reference
// keyed off a book/entry id minted before worldInfoStore's native-CRUD
// cutover: chatLoreConfigStore (linkedBookIds / excludedEntryIds / overlays),
// characterStore (linkedBookIdsByAvatar), and personaStore (linkedBookIds).
//
// Every scenario drives the REAL worldInfoStore.fetchPrefs() (with the
// native /lorebooks API mocked) so the remap maps
// (remapLegacyBookId/remapLegacyEntryId) and the drop-confidence gate
// (canConfidentlyDropUnresolvedLegacyIds) are populated exactly the way
// production login does — never faked directly — then calls each dependent
// store's own remap method synchronously and asserts on the result. Mirrors
// worldInfoStore.test.ts's own "legacy id remap" describe block and mocking
// setup.
// ---------------------------------------------------------------------------

vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
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
const createLorebook = vi.fn();
const updateLorebook = vi.fn();
const deleteLorebook = vi.fn();
const createLorebookEntry = vi.fn();
const updateLorebookEntry = vi.fn();
const deleteLorebookEntry = vi.fn();
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
      createLorebook: (...args: unknown[]) => createLorebook(...args),
      updateLorebook: (...args: unknown[]) => updateLorebook(...args),
      deleteLorebook: (...args: unknown[]) => deleteLorebook(...args),
      createLorebookEntry: (...args: unknown[]) => createLorebookEntry(...args),
      updateLorebookEntry: (...args: unknown[]) => updateLorebookEntry(...args),
      deleteLorebookEntry: (...args: unknown[]) => deleteLorebookEntry(...args),
    },
  };
});

const { useWorldInfoStore, DEFAULT_ENTRY, remapLegacyBookId, canConfidentlyDropUnresolvedLegacyIds } =
  await import('./worldInfoStore');
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { useCharacterStore } = await import('./characterStore');
const { usePersonaStore } = await import('./personaStore');

import type { WorldInfoBook, WorldInfoEntry } from './worldInfoStore';
import type { EntryOverlay } from '../utils/worldInfoComposition';

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is inert without a real backing
// store (see chatLoreConfigStore.test.ts for the same note) — install a
// working in-memory Storage so every store's localStorage writes actually
// round-trip instead of silently no-op'ing behind their own try/catch.
// ---------------------------------------------------------------------------
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
  useChatLoreConfigStore.getState().resetUser();
  useCharacterStore.getState().resetUser();
  usePersonaStore.setState({
    personas: [],
    activePersonaId: null,
    locks: { byCharacter: {}, byChat: {} },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Drives a real worldInfoStore.fetchPrefs() so remapLegacyBookId/
 * remapLegacyEntryId and canConfidentlyDropUnresolvedLegacyIds are populated
 * exactly like a real login: one old-id book ('wibook_old_1', containing
 * entry 'wi_old_1') gets matched onto its native-fetched counterpart
 * ('uuid-book-1' / 'uuid-entry-1') by (scope, name) + content signature, and
 * both the native-books and shared-books legs succeed (shared list empty by
 * default).
 */
async function seedMigratedBook(opts: { sharedBooksFail?: boolean } = {}): Promise<void> {
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
      mkEntryDto({
        id: 'uuid-entry-1',
        lorebook_id: 'uuid-book-1',
        comment: 'c',
        content: 'text',
        keys: ['a'],
      }),
    ],
  });
  if (opts.sharedBooksFail) {
    listSharedWorldInfoBooks.mockRejectedValueOnce(new Error('network down'));
  } else {
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);
  }

  await useWorldInfoStore.getState().fetchPrefs();

  // Sanity check on the underlying primitives every remap in this file
  // depends on — if these ever stop holding, every test below would fail
  // for a confusing reason, so assert them explicitly up front.
  expect(remapLegacyBookId('wibook_old_1')).toBe('uuid-book-1');
}

describe('personaStore.remapLinkedBookIds', () => {
  it('remaps a persona-linked legacy book id to its native-table id', async () => {
    await seedMigratedBook();
    usePersonaStore.setState({
      personas: [
        {
          id: 'persona-1',
          name: 'P',
          description: '',
          descriptionPosition: 'in_prompt',
          descriptionDepth: 0,
          descriptionRole: 'system',
          linkedBookIds: ['wibook_old_1'],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    usePersonaStore.getState().remapLinkedBookIds();

    expect(usePersonaStore.getState().personas[0].linkedBookIds).toEqual(['uuid-book-1']);
  });

  it('is a no-op on a persona with no linkedBookIds', async () => {
    await seedMigratedBook();
    const persona = {
      id: 'persona-1',
      name: 'P',
      description: '',
      descriptionPosition: 'in_prompt' as const,
      descriptionDepth: 0,
      descriptionRole: 'system' as const,
      createdAt: 0,
      updatedAt: 0,
    };
    usePersonaStore.setState({ personas: [persona] });

    usePersonaStore.getState().remapLinkedBookIds();

    expect(usePersonaStore.getState().personas[0]).toBe(persona); // same reference
  });
});

describe('characterStore.remapLinkedBookIds', () => {
  it('remaps a character-linked legacy book id to its native-table id', async () => {
    await seedMigratedBook();
    useCharacterStore.setState({
      linkedBookIdsByAvatar: { 'char.png': ['wibook_old_1'] },
    });

    useCharacterStore.getState().remapLinkedBookIds();

    expect(useCharacterStore.getState().linkedBookIdsByAvatar).toEqual({
      'char.png': ['uuid-book-1'],
    });
  });

  it('drops an unresolvable character-linked book id without crashing', async () => {
    await seedMigratedBook();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useCharacterStore.setState({
      linkedBookIdsByAvatar: { 'char.png': ['totally-unknown-id'] },
    });

    expect(() => useCharacterStore.getState().remapLinkedBookIds()).not.toThrow();

    expect(useCharacterStore.getState().linkedBookIdsByAvatar).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe('chatLoreConfigStore.remapLegacyIds', () => {
  it('preserves an excludedEntryIds entry that was successfully remapped, pointing at the new book/entry ids', async () => {
    await seedMigratedBook();
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      linkedBookIds: ['wibook_old_1'],
      excludedEntryIds: { wibook_old_1: ['wi_old_1'] },
    });

    useChatLoreConfigStore.getState().remapLegacyIds();

    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl')!;
    expect(cfg.linkedBookIds).toEqual(['uuid-book-1']);
    expect(cfg.excludedEntryIds).toEqual({ 'uuid-book-1': ['uuid-entry-1'] });
  });

  it('drops an excludedEntryIds entry that cannot be resolved, without crashing', async () => {
    await seedMigratedBook();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      linkedBookIds: ['wibook_old_1'],
      // 'wi_old_1' has a real content-signature match; 'wi_ghost' never
      // existed in the native-fetched book at all — genuinely unresolvable.
      excludedEntryIds: { wibook_old_1: ['wi_old_1', 'wi_ghost'] },
    });

    expect(() => useChatLoreConfigStore.getState().remapLegacyIds()).not.toThrow();

    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl')!;
    expect(cfg.excludedEntryIds).toEqual({ 'uuid-book-1': ['uuid-entry-1'] });
    expect(warn).toHaveBeenCalled();
  });

  it('running remapLegacyIds twice is a no-op the second time', async () => {
    await seedMigratedBook();
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      linkedBookIds: ['wibook_old_1'],
      excludedEntryIds: { wibook_old_1: ['wi_old_1'] },
    });

    useChatLoreConfigStore.getState().remapLegacyIds();
    const afterFirst = useChatLoreConfigStore.getState().configs;

    useChatLoreConfigStore.getState().remapLegacyIds();
    const afterSecond = useChatLoreConfigStore.getState().configs;

    // Exact same object reference: the second call never called set().
    expect(afterSecond).toBe(afterFirst);
  });

  it('remaps a confidently-matched overlay\'s baseBookId/baseEntryId and its key', async () => {
    await seedMigratedBook();
    const overlay: EntryOverlay = {
      baseEntryId: 'wi_old_1',
      baseBookId: 'wibook_old_1',
      patch: { content: 'forked content' },
      baseContentHash: 'hash',
      createdBy: 'user1',
      createdAt: 0,
      updatedAt: 0,
    };
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      overlays: { wi_old_1: overlay },
    });

    useChatLoreConfigStore.getState().remapLegacyIds();

    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl')!;
    expect(Object.keys(cfg.overlays)).toEqual(['uuid-entry-1']);
    expect(cfg.overlays['uuid-entry-1'].baseBookId).toBe('uuid-book-1');
    expect(cfg.overlays['uuid-entry-1'].baseEntryId).toBe('uuid-entry-1');
  });

  it('never drops an overlay whose base entry cannot be matched — leaves it for orphan promotion', async () => {
    await seedMigratedBook();
    const overlay: EntryOverlay = {
      baseEntryId: 'wi_truly_deleted',
      baseBookId: 'wibook_truly_deleted',
      patch: { content: 'salvaged content' },
      baseContentHash: 'hash',
      createdBy: 'user1',
      createdAt: 0,
      updatedAt: 0,
    };
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      overlays: { wi_truly_deleted: overlay },
    });

    useChatLoreConfigStore.getState().remapLegacyIds();

    // Unchanged — no remap entry exists for either id, so this pass leaves
    // it exactly as-is for resolveEffectiveBooks' own orphan-promotion logic.
    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl')!;
    expect(cfg.overlays).toEqual({ wi_truly_deleted: overlay });
  });

  it('does not drop an unresolved reference when the shared-books fetch failed (ambiguous, not confidently gone)', async () => {
    await seedMigratedBook({ sharedBooksFail: true });
    expect(canConfidentlyDropUnresolvedLegacyIds()).toBe(false);

    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      linkedBookIds: ['some-unrelated-id'],
    });
    useChatLoreConfigStore.getState().remapLegacyIds();

    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl')!;
    expect(cfg.linkedBookIds).toEqual(['some-unrelated-id']);
  });
});

describe('buildLegacyIdRemap — ambiguous scope-key collisions (Phase 3a review finding)', () => {
  it('remaps only the old book whose content unambiguously matches the surviving native row, leaving the other old book (whose content was NOT the one import-from-blob kept) unmapped', async () => {
    // Two DISTINCT pre-cutover local books legitimately share a scope key
    // (nothing in createBook/renameBook enforced name uniqueness) — only
    // ONE of them has a surviving native row (import-from-blob's own
    // dedup-by-scope-key silently skipped the other). Blindly mapping BOTH
    // old ids onto the one surviving book would misattribute the skipped
    // book's references onto content it was never actually linked to.
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_a1', comment: 'kept', content: 'kept-content', keys: ['k'] })],
          { id: 'wibook_dup_a', name: 'Notes', ownerCharacterAvatar: null }
        ),
        mkBook(
          [mkEntry({ id: 'wi_b1', comment: 'lost', content: 'lost-content', keys: ['l'] })],
          { id: 'wibook_dup_b', name: 'Notes', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-notes', name: 'Notes' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-notes', name: 'Notes' }),
      entries: [
        mkEntryDto({
          id: 'uuid-entry-kept',
          lorebook_id: 'uuid-notes',
          comment: 'kept',
          content: 'kept-content',
          keys: ['k'],
        }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);

    await useWorldInfoStore.getState().fetchPrefs();

    // The book whose content genuinely survived gets remapped...
    expect(remapLegacyBookId('wibook_dup_a')).toBe('uuid-notes');
    // ...but the one whose content did NOT (a different, un-migrated book
    // that just happened to share the same name) is left unmapped, not
    // silently pointed at book A's surviving content.
    expect(remapLegacyBookId('wibook_dup_b')).toBeNull();
  });

  it('leaves every old book in a collision group unmapped when content overlap cannot disambiguate them (a tie)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Both old books are equally (non-)matched against the surviving
    // book's entries — genuinely ambiguous, so neither should be guessed at.
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_x1', comment: 'x', content: 'x-content', keys: [] })],
          { id: 'wibook_tie_a', name: 'Duplicated', ownerCharacterAvatar: null }
        ),
        mkBook(
          [mkEntry({ id: 'wi_y1', comment: 'y', content: 'y-content', keys: [] })],
          { id: 'wibook_tie_b', name: 'Duplicated', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-dup', name: 'Duplicated' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-dup', name: 'Duplicated' }),
      // Neither old book's entry content-matches this one — a 0-0 tie.
      entries: [
        mkEntryDto({
          id: 'uuid-entry-z',
          lorebook_id: 'uuid-dup',
          comment: 'z',
          content: 'z-content',
          keys: [],
        }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);

    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyBookId('wibook_tie_a')).toBeNull();
    expect(remapLegacyBookId('wibook_tie_b')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('still remaps normally when only one old book exists for a scope key (the common case, unaffected by the collision guard)', async () => {
    await seedMigratedBook();
    expect(remapLegacyBookId('wibook_old_1')).toBe('uuid-book-1');
  });
});

describe('worldInfoStore — chatLinkedBookIds/activeBookIds remap (fetchPrefs tail)', () => {
  it('remaps chatLinkedBookIds and activeBookIds in place, dropping a confidently-unresolvable id', async () => {
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_old_1', comment: 'c', content: 'text', keys: ['a'] })],
          { id: 'wibook_old_1', name: 'Shared Lore', ownerCharacterAvatar: null }
        ),
      ],
      activeBookIds: ['wibook_old_1', 'totally-unknown-book'],
      chatLinkedBookIds: { 'chat1.jsonl': ['wibook_old_1'] },
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
      entries: [
        mkEntryDto({ id: 'uuid-entry-1', lorebook_id: 'uuid-book-1', comment: 'c', content: 'text', keys: ['a'] }),
      ],
    });
    listSharedWorldInfoBooks.mockResolvedValueOnce([]);

    await useWorldInfoStore.getState().fetchPrefs();

    const state = useWorldInfoStore.getState();
    expect(state.activeBookIds).toEqual(['uuid-book-1']);
    expect(state.chatLinkedBookIds).toEqual({ 'chat1.jsonl': ['uuid-book-1'] });
  });
});
