import { describe, it, expect, vi, beforeEach } from 'vitest';

// loreConflictStore pulls serverSettings at module load (and, through its
// circular import with worldInfoStore/chatLoreConfigStore, would again) —
// neutralize before importing, per the worldInfoStore.test.ts /
// chatLoreConfigStore.test.ts / chatLoreFork.integration.test.ts pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
}));

// loreConflictStore also imports useAuthStore (only for resolveConflict's
// 'fork_chat' branch, exercised in conflictResolution.integration.test.ts,
// not here). The real authStore.ts drags in nearly every other store in the
// app (chatStore, characterStore, branchStore, ...) purely to wire up its own
// logout-reset plumbing — none of that is relevant to this store's own
// behavior, so replace it with a minimal stand-in the same way serverSettings
// is neutralized above.
vi.mock('./authStore', () => {
  const state: { currentUser: { handle: string; name: string; role: string } | null } = {
    currentUser: null,
  };
  return {
    useAuthStore: {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
    },
  };
});

// Circular import order mirrors chatLoreFork.integration.test.ts: seed the
// stores loreConflictStore itself depends on first, then the module under
// test last.
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { useLoreConflictStore } = await import('./loreConflictStore');

import type { ConflictRecord } from './loreConflictStore';

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is an inert `{}` (Node's Web
// Storage implementation needs `--localstorage-file` to actually work), so
// every store call would silently no-op behind its own try/catch and the
// corrupt-localStorage / round-trip tests (which need a REAL write-then-read
// round trip) could never observe anything. Install a working in-memory
// Storage for the duration of this file, fresh before every test — mirrors
// chatLoreConfigStore.test.ts / chatLoreFork.integration.test.ts exactly.
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
  useLoreConflictStore.getState().resetUser();
  useChatLoreConfigStore.getState().resetUser();
  useWorldInfoStore.getState().resetUser();
});

// ---- Fixture helpers --------------------------------------------------------

function mkConflictInput(
  over: Partial<Omit<ConflictRecord, 'id' | 'createdAt'>> = {}
): Omit<ConflictRecord, 'id' | 'createdAt'> {
  return {
    chatFile: 'default-chat.jsonl',
    bookId: 'default-book',
    existingEntryId: 'default-entry',
    existingContentSnapshot: 'existing snapshot',
    proposedContent: 'proposed content',
    proposedKeys: [],
    detectedBy: 'llm',
    ...over,
  };
}

/** A full, storage-shaped record — used to hand-build raw localStorage blobs. */
function mkStoredRecord(over: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 'wic_fixture',
    chatFile: 'chat.jsonl',
    bookId: 'book1',
    existingEntryId: 'entry1',
    existingContentSnapshot: 'snapshot',
    proposedContent: 'proposal',
    proposedKeys: ['key1'],
    detectedBy: 'llm',
    createdAt: 1000,
    ...over,
  };
}

/** Seeds a real book + a real entry via useWorldInfoStore's own CRUD. */
function seedBookAndEntry(
  over: { content?: string; keys?: string[]; group?: string } = {}
) {
  const book = useWorldInfoStore.getState().createBook('Test Book');
  const entry = useWorldInfoStore.getState().createEntry(book.id, {
    content: over.content ?? 'original content',
    keys: over.keys ?? ['alpha'],
    group: over.group ?? '',
  })!;
  return { book, entry };
}

function liveEntryOf(bookId: string, entryId: string) {
  const book = useWorldInfoStore.getState().books.find((b) => b.id === bookId);
  return book?.entries.find((e) => e.id === entryId);
}

// ---------------------------------------------------------------------------

describe('round-trip persist/load', () => {
  it('addConflict persists to the scoped per-user localStorage key, and a fresh initForUser reloads it', () => {
    const handle = 'alice';
    useLoreConflictStore.getState().initForUser(handle);
    const record = useLoreConflictStore.getState().addConflict(mkConflictInput());

    const raw = localStorage.getItem(`lore_conflicts_v1_${handle}`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed[record.id]).toBeDefined();

    // Fresh load (simulating logout/login or a page reload) picks it back up.
    useLoreConflictStore.getState().resetUser();
    expect(useLoreConflictStore.getState().records).toEqual({});
    useLoreConflictStore.getState().initForUser(handle);

    expect(useLoreConflictStore.getState().records[record.id]).toEqual(record);
  });
});

describe('defensive parsing on load', () => {
  it('does not throw on invalid JSON and results in records === {}', () => {
    const handle = 'bob';
    localStorage.setItem(`lore_conflicts_v1_${handle}`, '{ not valid json !!!');

    expect(() => {
      useLoreConflictStore.getState().initForUser(handle);
    }).not.toThrow();

    expect(useLoreConflictStore.getState().records).toEqual({});
  });

  it('drops garbage/non-object entries and entries missing required string fields, keeping only valid records', () => {
    const handle = 'carol';
    const valid = mkStoredRecord({ id: 'good1' });
    const blob = {
      good1: valid,
      bad_string: 'just a string',
      bad_number: 42,
      bad_null: null,
      bad_array: [1, 2, 3],
      bad_missing_existingEntryId: {
        ...mkStoredRecord({ id: 'bad1' }),
        existingEntryId: undefined,
      },
      bad_missing_proposedContent: {
        ...mkStoredRecord({ id: 'bad2' }),
        proposedContent: undefined,
      },
      bad_wrong_detector: {
        ...mkStoredRecord({ id: 'bad3' }),
        detectedBy: 'not-a-real-detector',
      },
      _ts: 999999,
    };
    localStorage.setItem(`lore_conflicts_v1_${handle}`, JSON.stringify(blob));

    expect(() => {
      useLoreConflictStore.getState().initForUser(handle);
    }).not.toThrow();

    const records = useLoreConflictStore.getState().records;
    expect(Object.keys(records)).toEqual(['good1']);
    expect(records.good1).toEqual(valid);
  });

  it('filters non-string entries out of proposedKeys rather than dropping the whole record', () => {
    const handle = 'dave';
    const raw = {
      ...mkStoredRecord({ id: 'keys1' }),
      proposedKeys: ['ok', 5, null, 'also-ok'],
    };
    localStorage.setItem(`lore_conflicts_v1_${handle}`, JSON.stringify({ keys1: raw }));

    useLoreConflictStore.getState().initForUser(handle);

    expect(useLoreConflictStore.getState().records.keys1.proposedKeys).toEqual([
      'ok',
      'also-ok',
    ]);
  });
});

describe('addConflict', () => {
  it('stamps a fresh id and createdAt', () => {
    const before = Date.now();
    const record = useLoreConflictStore.getState().addConflict(mkConflictInput());
    const after = Date.now();

    expect(typeof record.id).toBe('string');
    expect(record.id.length).toBeGreaterThan(0);
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
    expect(useLoreConflictStore.getState().records[record.id]).toEqual(record);
  });

  it('dedupes on bookId + existingEntryId + normalized first-80-chars of proposedContent, returning the SAME record', () => {
    const original = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: 'bookD',
        existingEntryId: 'entryD',
        proposedContent: 'Alpha Beta Gamma',
      })
    );

    const dup = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: 'bookD',
        existingEntryId: 'entryD',
        // Same content once trimmed/lowercased — must dedupe against `original`.
        proposedContent: '  ALPHA BETA GAMMA  ',
      })
    );

    expect(dup).toBe(original);
    expect(Object.keys(useLoreConflictStore.getState().records)).toEqual([
      original.id,
    ]);
  });

  it('does NOT dedupe when bookId, existingEntryId, or the normalized content differs', () => {
    const base = useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookE', existingEntryId: 'entryE', proposedContent: 'same text' })
    );
    const diffBook = useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookF', existingEntryId: 'entryE', proposedContent: 'same text' })
    );
    const diffEntry = useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookE', existingEntryId: 'entryF', proposedContent: 'same text' })
    );
    const diffContent = useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookE', existingEntryId: 'entryE', proposedContent: 'different text' })
    );

    expect(new Set([base.id, diffBook.id, diffEntry.id, diffContent.id]).size).toBe(4);
  });

  it('evicts the oldest record by createdAt once the 100-record cap is exceeded', () => {
    vi.useFakeTimers();
    try {
      let firstId = '';
      for (let i = 0; i < 100; i++) {
        vi.setSystemTime(1000 + i);
        const r = useLoreConflictStore.getState().addConflict(
          mkConflictInput({
            bookId: `book${i}`,
            existingEntryId: `entry${i}`,
            proposedContent: `content ${i}`,
          })
        );
        if (i === 0) firstId = r.id;
      }
      expect(Object.keys(useLoreConflictStore.getState().records).length).toBe(100);
      expect(useLoreConflictStore.getState().records[firstId]).toBeDefined();

      vi.setSystemTime(1000 + 100);
      const newest = useLoreConflictStore.getState().addConflict(
        mkConflictInput({
          bookId: 'book100',
          existingEntryId: 'entry100',
          proposedContent: 'content 100',
        })
      );

      const records = useLoreConflictStore.getState().records;
      expect(Object.keys(records).length).toBe(100);
      expect(records[firstId]).toBeUndefined();
      expect(records[newest.id]).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updateProposed', () => {
  it('patches proposedContent/proposedKeys on an existing record, leaving other fields untouched', () => {
    const record = useLoreConflictStore.getState().addConflict(mkConflictInput());

    useLoreConflictStore.getState().updateProposed(record.id, {
      proposedContent: 'revised content',
      proposedKeys: ['k1', 'k2'],
    });

    const updated = useLoreConflictStore.getState().records[record.id];
    expect(updated.proposedContent).toBe('revised content');
    expect(updated.proposedKeys).toEqual(['k1', 'k2']);
    expect(updated.bookId).toBe(record.bookId);
    expect(updated.existingEntryId).toBe(record.existingEntryId);
    expect(updated.createdAt).toBe(record.createdAt);
  });

  it('no-ops silently on an unknown id', () => {
    const before = useLoreConflictStore.getState().records;

    expect(() => {
      useLoreConflictStore.getState().updateProposed('no-such-id', { proposedContent: 'x' });
    }).not.toThrow();

    expect(useLoreConflictStore.getState().records).toBe(before);
  });
});

describe('pendingForChat / pendingForBook', () => {
  it('filters correctly by chatFile and by bookId', () => {
    useLoreConflictStore.getState().addConflict(
      mkConflictInput({ chatFile: 'chatA.jsonl', bookId: 'bookX', existingEntryId: 'e1' })
    );
    useLoreConflictStore.getState().addConflict(
      mkConflictInput({ chatFile: 'chatB.jsonl', bookId: 'bookX', existingEntryId: 'e2' })
    );
    useLoreConflictStore.getState().addConflict(
      mkConflictInput({ chatFile: 'chatA.jsonl', bookId: 'bookY', existingEntryId: 'e3' })
    );

    const forChatA = useLoreConflictStore.getState().pendingForChat('chatA.jsonl');
    expect(forChatA).toHaveLength(2);
    expect(forChatA.every((r) => r.chatFile === 'chatA.jsonl')).toBe(true);

    const forBookX = useLoreConflictStore.getState().pendingForBook('bookX');
    expect(forBookX).toHaveLength(2);
    expect(forBookX.every((r) => r.bookId === 'bookX')).toBe(true);

    expect(useLoreConflictStore.getState().pendingForChat('never-seen.jsonl')).toEqual([]);
    expect(useLoreConflictStore.getState().pendingForBook('never-seen-book')).toEqual([]);
  });
});

describe('pruneBook', () => {
  it('removes every record for that bookId, leaving others untouched', () => {
    useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookP', existingEntryId: 'e1' })
    );
    useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookP', existingEntryId: 'e2' })
    );
    const keep = useLoreConflictStore.getState().addConflict(
      mkConflictInput({ bookId: 'bookQ', existingEntryId: 'e3' })
    );

    useLoreConflictStore.getState().pruneBook('bookP');

    const records = useLoreConflictStore.getState().records;
    expect(Object.keys(records)).toEqual([keep.id]);
    expect(records[keep.id]).toEqual(keep);
  });

  it('is a silent no-op when the book has no pending records', () => {
    const before = useLoreConflictStore.getState().records;
    expect(() => useLoreConflictStore.getState().pruneBook('never-seen')).not.toThrow();
    expect(useLoreConflictStore.getState().records).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// resolveConflict — real cross-store calls against useWorldInfoStore.
// ---------------------------------------------------------------------------

describe('resolveConflict', () => {
  it("'keep': entry content unchanged; a NEW revision is appended with action 'conflict_keep' even though content didn't change; record deleted", () => {
    const { book, entry } = seedBookAndEntry({ content: 'stable content', keys: ['alpha'] });
    const revsBefore = entry.revisions.length;
    const record = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entry.id,
        chatFile: 'chatKeep.jsonl',
        existingContentSnapshot: 'stable content',
        proposedContent: 'a different proposed content',
        proposedKeys: ['beta'],
      })
    );

    useLoreConflictStore.getState().resolveConflict(record.id, 'keep');

    const live = liveEntryOf(book.id, entry.id)!;
    expect(live.content).toBe('stable content'); // unchanged
    expect(live.revisions.length).toBe(revsBefore + 1);
    const lastRev = live.revisions[live.revisions.length - 1];
    expect(lastRev.action).toBe('conflict_keep');
    expect(lastRev.prevContent).toBe('stable content');
    expect(lastRev.sourceChatFile).toBe('chatKeep.jsonl');

    expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();
  });

  it("'replace': entry content becomes proposed content; keys become old+new union (case-insensitive dedup, old order first); revision 'conflict_replace' with prevContent = OLD content; record deleted", () => {
    const { book, entry } = seedBookAndEntry({ content: 'old content', keys: ['Alpha', 'Beta'] });
    const record = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entry.id,
        chatFile: 'chatReplace.jsonl',
        existingContentSnapshot: 'old content',
        proposedContent: 'new content',
        proposedKeys: ['alpha', 'Gamma'],
      })
    );

    useLoreConflictStore.getState().resolveConflict(record.id, 'replace');

    const live = liveEntryOf(book.id, entry.id)!;
    expect(live.content).toBe('new content');
    // 'alpha' is a case-insensitive dup of 'Alpha' -> dropped; 'Gamma' is new.
    expect(live.keys).toEqual(['Alpha', 'Beta', 'Gamma']);
    const lastRev = live.revisions[live.revisions.length - 1];
    expect(lastRev.action).toBe('conflict_replace');
    expect(lastRev.prevContent).toBe('old content');

    expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();
  });

  it("'fork_group': original entry gets a non-empty group + a recorded revision; a NEW sibling entry is created with proposed content/keys, source 'auto_memory', and the SAME group; record deleted", () => {
    const { book, entry } = seedBookAndEntry({ content: 'orig', keys: ['alpha'], group: '' });
    const entriesBefore = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!
      .entries.length;
    const record = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entry.id,
        chatFile: 'chatForkGroup.jsonl',
        existingContentSnapshot: 'orig',
        proposedContent: 'sibling content',
        proposedKeys: ['gamma'],
      })
    );

    useLoreConflictStore.getState().resolveConflict(record.id, 'fork_group');

    const liveBook = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
    const liveOriginal = liveBook.entries.find((e) => e.id === entry.id)!;
    expect(liveOriginal.group.length).toBeGreaterThan(0);
    const lastRev = liveOriginal.revisions[liveOriginal.revisions.length - 1];
    expect(lastRev.action).toBe('conflict_fork');

    expect(liveBook.entries.length).toBe(entriesBefore + 1);
    const sibling = liveBook.entries.find((e) => e.id !== entry.id)!;
    expect(sibling.content).toBe('sibling content');
    expect(sibling.keys).toEqual(['gamma']);
    expect(sibling.source).toBe('auto_memory');
    expect(sibling.group).toBe(liveOriginal.group);

    expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();
  });

  it("'fork_group': preserves a pre-existing non-empty group on the original entry rather than synthesizing one", () => {
    const { book, entry } = seedBookAndEntry({ content: 'orig', keys: ['alpha'], group: 'existing-group' });
    const record = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entry.id,
        chatFile: 'chatForkGroup2.jsonl',
        existingContentSnapshot: 'orig',
        proposedContent: 'sibling content 2',
        proposedKeys: ['delta'],
      })
    );

    useLoreConflictStore.getState().resolveConflict(record.id, 'fork_group');

    const liveBook = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
    const liveOriginal = liveBook.entries.find((e) => e.id === entry.id)!;
    expect(liveOriginal.group).toBe('existing-group');
    const sibling = liveBook.entries.find((e) => e.id !== entry.id)!;
    expect(sibling.group).toBe('existing-group');
  });

  it("'dismiss': no entry is touched at all; record simply deleted", () => {
    const { book, entry } = seedBookAndEntry({ content: 'untouched', keys: ['alpha'] });
    const record = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entry.id,
        chatFile: 'chatDismiss.jsonl',
        existingContentSnapshot: 'untouched',
        proposedContent: 'ignored proposal',
      })
    );
    const beforeEntry = liveEntryOf(book.id, entry.id);

    useLoreConflictStore.getState().resolveConflict(record.id, 'dismiss');

    const afterEntry = liveEntryOf(book.id, entry.id);
    expect(afterEntry).toBe(beforeEntry); // literally the same object reference
    expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();
  });

  describe('orphan handling', () => {
    it('leaves an error + the record pending for a non-add_new/dismiss kind when the entry has vanished, then add_new creates a fresh entry and deletes the record, then dismiss on a fresh orphan deletes cleanly with no entry side effects', () => {
      const { book, entry } = seedBookAndEntry({ content: 'will vanish' });
      const record = useLoreConflictStore.getState().addConflict(
        mkConflictInput({
          bookId: book.id,
          existingEntryId: entry.id,
          chatFile: 'chatOrphan.jsonl',
          existingContentSnapshot: 'will vanish',
          proposedContent: 'orphan proposal',
          proposedKeys: ['orph'],
        })
      );
      // Delete the entry out from under the pending record.
      useWorldInfoStore.getState().deleteEntry(book.id, entry.id);
      expect(liveEntryOf(book.id, entry.id)).toBeUndefined();

      useLoreConflictStore.getState().resolveConflict(record.id, 'keep');

      expect(useLoreConflictStore.getState().error).toBe(
        'The conflicting entry no longer exists'
      );
      expect(useLoreConflictStore.getState().records[record.id]).toBeDefined(); // still pending

      useLoreConflictStore.getState().clearError();
      useLoreConflictStore.getState().resolveConflict(record.id, 'add_new');

      const liveBook = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
      expect(liveBook.entries).toHaveLength(1);
      const created = liveBook.entries[0];
      expect(created.content).toBe('orphan proposal');
      expect(created.keys).toEqual(['orph']);
      expect(created.source).toBe('auto_memory');
      expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();

      // A fresh record referencing a nonexistent entry id from the start.
      const record2 = useLoreConflictStore.getState().addConflict(
        mkConflictInput({
          bookId: book.id,
          existingEntryId: 'never-existed',
          chatFile: 'chatOrphan2.jsonl',
          existingContentSnapshot: 'n/a',
          proposedContent: 'dismissed proposal',
        })
      );
      const entriesBefore = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!
        .entries.length;

      useLoreConflictStore.getState().resolveConflict(record2.id, 'dismiss');

      expect(useLoreConflictStore.getState().records[record2.id]).toBeUndefined();
      expect(
        useWorldInfoStore.getState().books.find((b) => b.id === book.id)!.entries.length
      ).toBe(entriesBefore);
    });
  });
});

describe('resolveAll', () => {
  it("resolves live pending records in scope with the given kind, leaving orphaned ones pending untouched", () => {
    const { book } = seedBookAndEntry({ content: 'live1', keys: ['a'] });
    const entryLive1 = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!
      .entries[0];
    const entryLive2 = useWorldInfoStore.getState().createEntry(book.id, {
      content: 'live2',
      keys: ['b'],
    })!;

    const chatFile = 'chatResolveAll.jsonl';
    const recLive1 = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entryLive1.id,
        chatFile,
        existingContentSnapshot: 'live1',
        proposedContent: 'p1',
      })
    );
    const recLive2 = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: entryLive2.id,
        chatFile,
        existingContentSnapshot: 'live2',
        proposedContent: 'p2',
      })
    );
    const recOrphan = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: book.id,
        existingEntryId: 'vanished-entry',
        chatFile,
        existingContentSnapshot: 'n/a',
        proposedContent: 'p3',
      })
    );

    useLoreConflictStore.getState().resolveAll({ kind: 'chat', chatFile }, 'keep');

    const records = useLoreConflictStore.getState().records;
    expect(records[recLive1.id]).toBeUndefined();
    expect(records[recLive2.id]).toBeUndefined();
    expect(records[recOrphan.id]).toBeDefined(); // orphan left pending, not force-resolved

    const e1 = liveEntryOf(book.id, entryLive1.id)!;
    const e2 = liveEntryOf(book.id, entryLive2.id)!;
    expect(e1.revisions[e1.revisions.length - 1].action).toBe('conflict_keep');
    expect(e2.revisions[e2.revisions.length - 1].action).toBe('conflict_keep');
  });

  it('scopes to a single book when given a book scope, ignoring records for other books', () => {
    const { book: bookA, entry: entryA } = seedBookAndEntry({ content: 'a' });
    const { book: bookB, entry: entryB } = seedBookAndEntry({ content: 'b' });

    const recA = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: bookA.id,
        existingEntryId: entryA.id,
        chatFile: 'chatX.jsonl',
        existingContentSnapshot: 'a',
        proposedContent: 'pa',
      })
    );
    const recB = useLoreConflictStore.getState().addConflict(
      mkConflictInput({
        bookId: bookB.id,
        existingEntryId: entryB.id,
        chatFile: 'chatX.jsonl',
        existingContentSnapshot: 'b',
        proposedContent: 'pb',
      })
    );

    useLoreConflictStore.getState().resolveAll({ kind: 'book', bookId: bookA.id }, 'keep');

    expect(useLoreConflictStore.getState().records[recA.id]).toBeUndefined();
    expect(useLoreConflictStore.getState().records[recB.id]).toBeDefined();
  });
});
