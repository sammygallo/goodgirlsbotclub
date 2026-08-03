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
