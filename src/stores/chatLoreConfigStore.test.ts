import { describe, it, expect, vi, beforeEach } from 'vitest';

// chatLoreConfigStore pulls serverSettings at module load (and, through its
// circular import with worldInfoStore, would again) — neutralize before
// importing, per the worldInfoStore.test.ts / chatStore.groupWorldInfo.test.ts
// pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
}));

const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { useWorldInfoStore, DEFAULT_ENTRY } = await import('./worldInfoStore');

import type { WorldInfoEntry } from './worldInfoStore';
import type { ChatLoreConfig, EntryOverlay } from '../utils/worldInfoComposition';

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is an inert `{}` (Node's Web
// Storage implementation needs `--localstorage-file` to actually work), so
// every store call would silently no-op behind its own try/catch and the
// corrupt-localStorage test (which needs a REAL write-then-read round trip)
// could never observe anything. Install a working in-memory Storage for the
// duration of this file, fresh before every test.
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

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  useChatLoreConfigStore.getState().resetUser();
  useWorldInfoStore.setState({ chatLinkedBookIds: {} });
});

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

function mkOverlay(over: Partial<EntryOverlay> = {}): EntryOverlay {
  return {
    baseEntryId: 'base-entry',
    baseBookId: 'book-x',
    patch: {},
    baseContentHash: 'hash',
    createdBy: 'user1',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkConfig(over: Partial<ChatLoreConfig> & { chatFile: string }): ChatLoreConfig {
  return {
    linkedBookIds: [],
    excludedEntryIds: {},
    overlays: {},
    localEntries: [],
    updatedAt: 1,
    ...over,
  };
}

describe('round-trip persist/load', () => {
  it('updateConfig then getConfig reflects the patch with a fresh updatedAt', () => {
    const before = Date.now();
    useChatLoreConfigStore.getState().updateConfig('chat1.jsonl', {
      linkedBookIds: ['book1'],
    });
    const after = Date.now();

    const cfg = useChatLoreConfigStore.getState().getConfig('chat1.jsonl');
    expect(cfg).toBeDefined();
    expect(cfg!.chatFile).toBe('chat1.jsonl');
    expect(cfg!.linkedBookIds).toEqual(['book1']);
    expect(cfg!.excludedEntryIds).toEqual({});
    expect(cfg!.overlays).toEqual({});
    expect(cfg!.localEntries).toEqual([]);
    expect(cfg!.updatedAt).toBeGreaterThan(0);
    expect(cfg!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(cfg!.updatedAt).toBeLessThanOrEqual(after);
  });
});

describe('absent config', () => {
  it('getConfig returns undefined for a chatFile with no config', () => {
    expect(
      useChatLoreConfigStore.getState().getConfig('never-touched.jsonl')
    ).toBeUndefined();
  });
});

describe('legacy synthesis', () => {
  it('synthesizes an ephemeral config from chatLinkedBookIds without touching configs state', () => {
    useWorldInfoStore.setState({
      chatLinkedBookIds: { 'chat2.jsonl': ['bookA', 'bookB'] },
    });

    const effective = useChatLoreConfigStore
      .getState()
      .getEffectiveConfig('chat2.jsonl');

    expect(effective).toEqual({
      chatFile: 'chat2.jsonl',
      linkedBookIds: ['bookA', 'bookB'],
      excludedEntryIds: {},
      overlays: {},
      localEntries: [],
      updatedAt: 0,
    });

    // The store's own persisted state must be untouched by this read.
    expect(useChatLoreConfigStore.getState().configs).toEqual({});
    expect(
      useChatLoreConfigStore.getState().getConfig('chat2.jsonl')
    ).toBeUndefined();
  });
});

describe('promotion', () => {
  it('seeds linkedBookIds from the legacy map on first write, patch on top, then ignores further legacy mutation', () => {
    useWorldInfoStore.setState({
      chatLinkedBookIds: { 'chat3.jsonl': ['legacyBook1', 'legacyBook2'] },
    });

    const localEntry = mkEntry({ comment: 'promoted local entry' });
    useChatLoreConfigStore.getState().updateConfig('chat3.jsonl', {
      localEntries: [localEntry],
    });

    const persisted = useChatLoreConfigStore.getState().getConfig('chat3.jsonl');
    expect(persisted).toBeDefined();
    // Seeded from the legacy map...
    expect(persisted!.linkedBookIds).toEqual(['legacyBook1', 'legacyBook2']);
    // ...with the unrelated patch applied on top.
    expect(persisted!.localEntries).toEqual([localEntry]);

    // Now mutate the legacy map further — the persisted config must not react.
    useWorldInfoStore.setState({
      chatLinkedBookIds: { 'chat3.jsonl': ['someOtherBook'] },
    });

    const effective = useChatLoreConfigStore
      .getState()
      .getEffectiveConfig('chat3.jsonl');
    expect(effective!.linkedBookIds).toEqual(['legacyBook1', 'legacyBook2']);
  });
});

describe('persisted config shadows legacy', () => {
  it('getEffectiveConfig returns exactly the persisted config, ignoring the legacy map entirely', () => {
    useWorldInfoStore.setState({
      chatLinkedBookIds: { 'chat4.jsonl': ['legacyOnly'] },
    });
    useChatLoreConfigStore.getState().updateConfig('chat4.jsonl', {
      linkedBookIds: ['realBook'],
    });

    const persisted = useChatLoreConfigStore.getState().getConfig('chat4.jsonl');
    const effective = useChatLoreConfigStore
      .getState()
      .getEffectiveConfig('chat4.jsonl');

    expect(effective).toBe(persisted); // exact same object, not a re-synthesis
    expect(effective!.linkedBookIds).toEqual(['realBook']);
  });
});

describe('pruneBook', () => {
  it('strips every reference to the pruned book and deletes the config once nothing is left, leaving the unrelated config untouched', () => {
    const bookId = 'book-to-prune';
    useChatLoreConfigStore.setState({
      configs: {
        'affected.jsonl': mkConfig({
          chatFile: 'affected.jsonl',
          linkedBookIds: [bookId],
          excludedEntryIds: { [bookId]: ['entry1'] },
          overlays: { ov1: mkOverlay({ baseBookId: bookId }) },
        }),
        'unrelated.jsonl': mkConfig({
          chatFile: 'unrelated.jsonl',
          linkedBookIds: ['other-book'],
        }),
      },
    });
    const unrelatedBefore =
      useChatLoreConfigStore.getState().configs['unrelated.jsonl'];

    useChatLoreConfigStore.getState().pruneBook(bookId);

    // Fully scrubbed -> deleted entirely, not left behind as a vacuous config.
    expect(
      useChatLoreConfigStore.getState().getConfig('affected.jsonl')
    ).toBeUndefined();
    expect(Object.keys(useChatLoreConfigStore.getState().configs)).toEqual([
      'unrelated.jsonl',
    ]);

    // Untouched — same reference, not just equal content.
    const unrelatedAfter =
      useChatLoreConfigStore.getState().configs['unrelated.jsonl'];
    expect(unrelatedAfter).toBe(unrelatedBefore);
    expect(unrelatedAfter.linkedBookIds).toEqual(['other-book']);
  });

  it('strips the book from every field but keeps the config when other content remains', () => {
    const bookId = 'book-to-prune-2';
    useChatLoreConfigStore.setState({
      configs: {
        'affected2.jsonl': mkConfig({
          chatFile: 'affected2.jsonl',
          linkedBookIds: [bookId, 'keeper-book'],
          excludedEntryIds: { [bookId]: ['entry1'], 'keeper-book': ['entry2'] },
          overlays: {
            ov1: mkOverlay({ baseBookId: bookId }),
            ov2: mkOverlay({ baseBookId: 'keeper-book' }),
          },
        }),
      },
    });

    useChatLoreConfigStore.getState().pruneBook(bookId);

    const after = useChatLoreConfigStore.getState().getConfig('affected2.jsonl');
    expect(after).toBeDefined();
    expect(after!.linkedBookIds).toEqual(['keeper-book']);
    expect(after!.excludedEntryIds).toEqual({ 'keeper-book': ['entry2'] });
    expect(Object.keys(after!.overlays)).toEqual(['ov2']);
  });
});

describe('resetUser', () => {
  it('clears configs back to {}', () => {
    useChatLoreConfigStore.getState().updateConfig('chat5.jsonl', {
      linkedBookIds: ['x'],
    });
    expect(
      Object.keys(useChatLoreConfigStore.getState().configs).length
    ).toBeGreaterThan(0);

    useChatLoreConfigStore.getState().resetUser();

    expect(useChatLoreConfigStore.getState().configs).toEqual({});
  });
});

describe('corrupt localStorage', () => {
  it('initForUser does not throw on invalid JSON and results in configs === {}', () => {
    const handle = 'some-handle';
    // Mirrors this store's private scopedKey(CONFIGS_KEY, handle) exactly:
    // CONFIGS_KEY = 'chat_lore_configs_v1', scoped as `${base}_${handle}`.
    localStorage.setItem(`chat_lore_configs_v1_${handle}`, '{ not valid json !!!');

    expect(() => {
      useChatLoreConfigStore.getState().initForUser(handle);
    }).not.toThrow();

    expect(useChatLoreConfigStore.getState().configs).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Lorebook v2 Phase 2 — per-entry/per-book customization methods
// ---------------------------------------------------------------------------

describe('setEntryExcluded', () => {
  it('excluding then re-including an entry leaves excludedEntryIds with no key for that book', () => {
    const chatFile = 'excl1.jsonl';
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      linkedBookIds: ['book1'],
    });

    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', true);
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.excludedEntryIds
    ).toEqual({ book1: ['entry1'] });

    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', false);
    const cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.excludedEntryIds).toEqual({});
    expect(cfg.excludedEntryIds).not.toHaveProperty('book1');
  });
});

describe('setBookExcluded', () => {
  it('bulk-excluding then un-excluding a book fully removes the excludedEntryIds key (not an empty array)', () => {
    const chatFile = 'excl2.jsonl';
    const allEntryIds = ['e1', 'e2', 'e3'];
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      linkedBookIds: ['book1'],
    });

    useChatLoreConfigStore.getState().setBookExcluded(chatFile, 'book1', allEntryIds, true);
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.excludedEntryIds
    ).toEqual({ book1: allEntryIds });

    useChatLoreConfigStore.getState().setBookExcluded(chatFile, 'book1', allEntryIds, false);
    const cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.excludedEntryIds).toEqual({});
    expect(cfg.excludedEntryIds).not.toHaveProperty('book1');
  });
});

describe('exclusion preserved across an overlay', () => {
  it('excluding then re-including the overlaid entry never touches its overlay', () => {
    const chatFile = 'exclOverlay.jsonl';
    const overlay = mkOverlay({ baseEntryId: 'entry1', baseBookId: 'book1' });
    useChatLoreConfigStore.getState().upsertOverlay(chatFile, overlay);

    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', true);
    let cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.excludedEntryIds).toEqual({ book1: ['entry1'] });
    expect(cfg.overlays.entry1).toEqual(overlay);

    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', false);
    cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.excludedEntryIds).toEqual({});
    // The overlay must still be there — exclusion must never delete an overlay.
    expect(cfg.overlays.entry1).toEqual(overlay);
  });
});

describe('removeOverlay', () => {
  it("updateConfig's patch-merge can only add/overwrite overlay keys, never remove one (regression anchor)", () => {
    const chatFile = 'overlayMergeAnchor.jsonl';
    const overlay = mkOverlay({ baseEntryId: 'entry1', baseBookId: 'book1' });
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      overlays: { entry1: overlay },
    });
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.overlays
    ).toEqual({ entry1: overlay });

    // An "empty" patch can never remove an existing key — updateConfig
    // spreads base.overlays first, then the patch's overlays on top.
    useChatLoreConfigStore.getState().updateConfig(chatFile, { overlays: {} });
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.overlays
    ).toEqual({ entry1: overlay });
  });

  it('actually removes the overlay from the overlays object', () => {
    const chatFile = 'removeOverlay.jsonl';
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      linkedBookIds: ['book1'],
    });
    const overlay = mkOverlay({ baseEntryId: 'entry1', baseBookId: 'book1' });
    useChatLoreConfigStore.getState().upsertOverlay(chatFile, overlay);
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.overlays.entry1
    ).toEqual(overlay);

    useChatLoreConfigStore.getState().removeOverlay(chatFile, 'entry1');

    const cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.overlays).not.toHaveProperty('entry1');
    expect(cfg.overlays).toEqual({});
  });
});

describe('addLocalEntry', () => {
  it('creates a manual-source entry with a wi_local_ id and appends it to localEntries', () => {
    const chatFile = 'addLocal.jsonl';
    const entry = useChatLoreConfigStore
      .getState()
      .addLocalEntry(chatFile, { content: 'a fresh fact' });

    expect(entry.source).toBe('manual');
    expect(entry.id.startsWith('wi_local_')).toBe(true);
    expect(entry.content).toBe('a fresh fact');

    const cfg = useChatLoreConfigStore.getState().getConfig(chatFile);
    expect(cfg).toBeDefined();
    expect(cfg!.localEntries).toEqual([entry]);
  });
});

describe('updateLocalEntry', () => {
  it("flips a field and advances updatedAt; an unknown entryId is a silent no-op", () => {
    vi.useFakeTimers();
    try {
      const chatFile = 'updateLocal.jsonl';
      vi.setSystemTime(1000);
      const entry = useChatLoreConfigStore
        .getState()
        .addLocalEntry(chatFile, { enabled: true });
      expect(entry.updatedAt).toBe(1000);

      vi.setSystemTime(2000);
      useChatLoreConfigStore
        .getState()
        .updateLocalEntry(chatFile, entry.id, { enabled: false });

      const cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
      expect(cfg.localEntries).toHaveLength(1);
      const updated = cfg.localEntries.find((e) => e.id === entry.id)!;
      expect(updated.enabled).toBe(false);
      expect(updated.updatedAt).toBe(2000);
      expect(updated.updatedAt).toBeGreaterThan(entry.updatedAt);
      // Only the targeted entry's field changed — id/createdAt untouched.
      expect(updated.id).toBe(entry.id);
      expect(updated.createdAt).toBe(entry.createdAt);

      // Unknown entryId: silent no-op, no throw, no phantom entry, no
      // state-reference churn (mutateConfig's `result === base` early-out).
      const beforeConfig = useChatLoreConfigStore.getState().getConfig(chatFile);
      expect(() =>
        useChatLoreConfigStore
          .getState()
          .updateLocalEntry(chatFile, 'no-such-entry', { enabled: true })
      ).not.toThrow();
      const afterConfig = useChatLoreConfigStore.getState().getConfig(chatFile);
      expect(afterConfig).toBe(beforeConfig);
      expect(afterConfig!.localEntries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('removeLocalEntry', () => {
  it('removes the entry from localEntries; removing an already-absent id is a silent no-op', () => {
    const chatFile = 'removeLocal.jsonl';
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      linkedBookIds: ['book1'],
    });
    const entry = useChatLoreConfigStore.getState().addLocalEntry(chatFile, {});
    expect(
      useChatLoreConfigStore.getState().getConfig(chatFile)!.localEntries
    ).toHaveLength(1);

    useChatLoreConfigStore.getState().removeLocalEntry(chatFile, entry.id);
    const cfg = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(cfg.localEntries).toEqual([]);

    const beforeConfig = useChatLoreConfigStore.getState().getConfig(chatFile);
    expect(() =>
      useChatLoreConfigStore.getState().removeLocalEntry(chatFile, 'absent-id')
    ).not.toThrow();
    const afterConfig = useChatLoreConfigStore.getState().getConfig(chatFile);
    expect(afterConfig).toBe(beforeConfig);
  });
});

describe('resetCustomizations', () => {
  it('clears exclusions/overlays/local entries but leaves a non-empty linkedBookIds untouched', () => {
    const chatFile = 'resetKeepLinks.jsonl';
    useChatLoreConfigStore.getState().updateConfig(chatFile, {
      linkedBookIds: ['book1', 'book2'],
    });
    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', true);
    useChatLoreConfigStore
      .getState()
      .upsertOverlay(chatFile, mkOverlay({ baseEntryId: 'entry2', baseBookId: 'book1' }));
    useChatLoreConfigStore.getState().addLocalEntry(chatFile, { comment: 'local' });

    const before = useChatLoreConfigStore.getState().getConfig(chatFile)!;
    expect(before.linkedBookIds).toEqual(['book1', 'book2']);
    expect(Object.keys(before.excludedEntryIds).length).toBeGreaterThan(0);
    expect(Object.keys(before.overlays).length).toBeGreaterThan(0);
    expect(before.localEntries.length).toBeGreaterThan(0);

    useChatLoreConfigStore.getState().resetCustomizations(chatFile);

    const after = useChatLoreConfigStore.getState().getConfig(chatFile);
    expect(after).toBeDefined();
    expect(after!.excludedEntryIds).toEqual({});
    expect(after!.overlays).toEqual({});
    expect(after!.localEntries).toEqual([]);
    expect(after!.linkedBookIds).toEqual(['book1', 'book2']);
  });

  it('deletes the config entirely when reset leaves it fully empty (no linkedBookIds)', () => {
    const chatFile = 'resetToVacuous.jsonl';
    useChatLoreConfigStore.getState().setEntryExcluded(chatFile, 'book1', 'entry1', true);
    useChatLoreConfigStore
      .getState()
      .upsertOverlay(chatFile, mkOverlay({ baseEntryId: 'entry2', baseBookId: 'book1' }));
    useChatLoreConfigStore.getState().addLocalEntry(chatFile, { comment: 'local' });

    const before = useChatLoreConfigStore.getState().getConfig(chatFile);
    expect(before).toBeDefined();
    expect(before!.linkedBookIds).toEqual([]);

    useChatLoreConfigStore.getState().resetCustomizations(chatFile);

    expect(useChatLoreConfigStore.getState().getConfig(chatFile)).toBeUndefined();
  });
});

describe('vacuous-drop general check', () => {
  it('getConfig returns undefined once a config has no linkedBookIds, no excludedEntryIds keys, no overlays, and no localEntries', () => {
    const chatFile = 'vacuousDrop.jsonl';
    const entry = useChatLoreConfigStore.getState().addLocalEntry(chatFile, {});
    expect(useChatLoreConfigStore.getState().getConfig(chatFile)).toBeDefined();

    useChatLoreConfigStore.getState().removeLocalEntry(chatFile, entry.id);

    expect(useChatLoreConfigStore.getState().getConfig(chatFile)).toBeUndefined();
  });
});
