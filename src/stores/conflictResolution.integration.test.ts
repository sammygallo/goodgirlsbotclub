import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both stores pull serverSettings at module load (and, through their
// circular import, again) — neutralize before importing, per the
// worldInfoStore.test.ts / chatLoreConfigStore.test.ts /
// chatLoreFork.integration.test.ts pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
}));

// loreConflictStore imports useAuthStore purely to stamp EntryOverlay.createdBy
// during resolveConflict('fork_chat'). The real authStore.ts drags in nearly
// every other store in the app to wire up its own logout-reset plumbing —
// none of that is relevant here, so replace it with a minimal stand-in whose
// currentUser this file controls directly (mirrors the serverSettings
// neutralization above).
vi.mock('./authStore', () => {
  const state: { currentUser: { handle: string; name: string; role: string } | null } = {
    currentUser: { handle: 'test-user', name: 'Test User', role: 'end_user' },
  };
  return {
    useAuthStore: {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
    },
  };
});

// chatLoreConfigStore <-> worldInfoStore is a require cycle; import
// chatLoreConfigStore first, matching chatLoreFork.integration.test.ts's
// order, then worldInfoStore, then loreConflictStore (the module whose
// cross-cutting guarantee this file is actually testing) last.
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { useLoreConflictStore } = await import('./loreConflictStore');
const { resolveEffectiveBooks, hashContent } = await import(
  '../utils/worldInfoComposition'
);

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is an inert `{}` (Node's Web
// Storage implementation needs `--localstorage-file` to actually work), so
// every store call would silently no-op behind its own try/catch. Install a
// working in-memory Storage for the duration of this file, fresh before
// every test — mirrors chatLoreFork.integration.test.ts exactly.
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
  useWorldInfoStore.getState().resetUser();
  useLoreConflictStore.getState().resetUser();
});

const CHAT_FILE = 'conflict-fork-flow.jsonl';

function liveEntryOf(bookId: string, entryId: string) {
  const book = useWorldInfoStore.getState().books.find((b) => b.id === bookId);
  return book?.entries.find((e) => e.id === entryId);
}

/**
 * Step 1: a real book + real entry (with initial content and keys) plus an
 * unrelated second book, both made globally active — mirrors
 * chatLoreFork.integration.test.ts's own createLibrary() exactly.
 */
function createLibrary() {
  const wi = useWorldInfoStore.getState();
  const book = wi.createBook('Main Lorebook');
  const entry = wi.createEntry(book.id, {
    content: 'original content',
    keys: ['dragon'],
  })!;
  const unrelatedBook = wi.createBook('Unrelated Lorebook');
  useWorldInfoStore.getState().createEntry(unrelatedBook.id, {
    content: 'unrelated content',
    keys: ['owl'],
  });
  useWorldInfoStore.getState().setBookActive(book.id, true);
  useWorldInfoStore.getState().setBookActive(unrelatedBook.id, true);
  return { book, entry, unrelatedBook };
}

// ---------------------------------------------------------------------------
// The load-bearing guarantee of this whole file: resolveConflict(id,
// 'fork_chat') must produce an overlay — and therefore a composed chat
// state — that is genuinely indistinguishable from a manual
// ForkEntryEditor-driven fork, not a parallel shadow mechanism.
// ---------------------------------------------------------------------------

describe("resolveConflict('fork_chat') produces a real overlay, same shape as a manual fork", () => {
  it('creates an EntryOverlay with the same field shape a manual upsertOverlay call would produce (note is the only expected value difference)', () => {
    const { book, entry, unrelatedBook } = createLibrary();
    const originalContent = entry.content;

    const record = useLoreConflictStore.getState().addConflict({
      chatFile: CHAT_FILE,
      bookId: book.id,
      existingEntryId: entry.id,
      existingContentSnapshot: originalContent,
      proposedContent: 'auto-memory proposed content',
      proposedKeys: ['dragon', 'ember'],
      detectedBy: 'llm',
    });

    useLoreConflictStore.getState().resolveConflict(record.id, 'fork_chat');

    // The record is resolved (deleted) exactly like every other resolution kind.
    expect(useLoreConflictStore.getState().records[record.id]).toBeUndefined();

    const overlay = useChatLoreConfigStore.getState().getConfig(CHAT_FILE)?.overlays[
      entry.id
    ];
    expect(overlay).toBeDefined();

    // --- Field-by-field content checks -------------------------------------
    expect(overlay!.baseEntryId).toBe(entry.id);
    expect(overlay!.baseBookId).toBe(book.id);
    expect(overlay!.patch.content).toBe('auto-memory proposed content');
    // unionKeys: old keys first (['dragon']), then new ones not already
    // present case-insensitively (['ember']).
    expect(overlay!.patch.keys).toEqual(['dragon', 'ember']);
    expect(overlay!.baseContentHash).toBe(hashContent(originalContent));
    expect(overlay!.createdBy).toBe('test-user');
    expect(typeof overlay!.createdAt).toBe('number');
    expect(overlay!.updatedAt).toBe(overlay!.createdAt);
    expect(overlay!.note).toBe('Auto Memory conflict resolution');

    // --- Field-SHAPE check against a manual ForkEntryEditor-style fork -----
    // ForkEntryEditor.tsx's handleSave calls upsertOverlay with exactly:
    //   { baseEntryId, baseBookId, patch, baseContentHash, createdBy,
    //     createdAt, updatedAt, note: overlay?.note }
    // A brand-new manual fork (no pre-existing overlay) has `note: undefined`
    // — the key is present, just unset. Build that same shape by hand (on an
    // unrelated chat, so it doesn't interfere with the fork_chat overlay
    // asserted above) and compare key sets.
    const manualChatFile = 'manual-fork-flow.jsonl';
    useChatLoreConfigStore.getState().upsertOverlay(manualChatFile, {
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'manually forked content' },
      baseContentHash: hashContent(originalContent),
      createdBy: 'test-user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      note: undefined,
    });
    const manualOverlay = useChatLoreConfigStore.getState().getConfig(manualChatFile)!
      .overlays[entry.id];

    expect(Object.keys(overlay!).sort()).toEqual(Object.keys(manualOverlay).sort());
    // Every non-note field is the same KIND of value (same shape), and the
    // note field is the one place they're expected to differ.
    expect(typeof overlay!.baseEntryId).toBe(typeof manualOverlay.baseEntryId);
    expect(typeof overlay!.baseBookId).toBe(typeof manualOverlay.baseBookId);
    expect(typeof overlay!.baseContentHash).toBe(typeof manualOverlay.baseContentHash);
    expect(typeof overlay!.createdBy).toBe(typeof manualOverlay.createdBy);
    expect(typeof overlay!.createdAt).toBe(typeof manualOverlay.createdAt);
    expect(typeof overlay!.updatedAt).toBe(typeof manualOverlay.updatedAt);
    expect('content' in overlay!.patch).toBe('content' in manualOverlay.patch);
    expect(overlay!.note).not.toBe(manualOverlay.note);

    // --------------------------------------------------------------------
    // resolveEffectiveBooks: this is genuinely the same composition path a
    // manual fork uses, not a parallel shadow mechanism.
    // --------------------------------------------------------------------
    const effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    expect(effectiveConfig).toBeDefined();

    const booksBeforeCompose = useWorldInfoStore.getState().books;
    const unrelatedBookRefBefore = booksBeforeCompose.find(
      (b) => b.id === unrelatedBook.id
    )!;
    const baseEntryRefBefore = liveEntryOf(book.id, entry.id)!;

    const result = resolveEffectiveBooks(
      booksBeforeCompose,
      [book.id, unrelatedBook.id],
      effectiveConfig
    );

    const composedBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    const composedEntry = composedBook.entries.find((e) => e.id === entry.id)!;
    expect(result.provenance.get(entry.id)).toBe('overridden');
    expect(composedEntry.content).toBe('auto-memory proposed content');
    expect(composedEntry.id).toBe(entry.id); // ids survive composition unchanged

    // Purity contract (Phase 1): resolveEffectiveBooks is a pure function —
    // it never touches useWorldInfoStore, and anything it doesn't need to
    // touch passes straight through by reference.
    expect(useWorldInfoStore.getState().books).toBe(booksBeforeCompose);
    const unrelatedEffective = result.effectiveBooks.find(
      (b) => b.id === unrelatedBook.id
    )!;
    expect(unrelatedEffective).toBe(unrelatedBookRefBefore);
    // The base entry's own object in the library is completely untouched by
    // composition — same reference before and after resolveEffectiveBooks,
    // and its content is still the ORIGINAL, never the overlay's patch.
    expect(liveEntryOf(book.id, entry.id)).toBe(baseEntryRefBefore);
    expect(baseEntryRefBefore.content).toBe(originalContent);

    // The base entry itself carries a 'conflict_fork' revision after this
    // resolution — resolveConflict's fork_chat branch records an audit trail
    // entry on the library entry even though the library content is
    // untouched (the fork lives entirely in the chat's overlay).
    expect(
      baseEntryRefBefore.revisions.some((r) => r.action === 'conflict_fork')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: Phase 4 added an optional `meta` parameter to createEntry /
// updateEntry. Every existing caller that never passes it must see
// byte-identical behavior to pre-Phase-4 semantics.
// ---------------------------------------------------------------------------

describe('updateEntry meta-parameter regression (no meta argument at all)', () => {
  it('appends a revision iff content actually changed, defaults action to "edit", and the 10-revision cap still holds', () => {
    const book = useWorldInfoStore.getState().createBook('Meta Regression Book');
    const entry = useWorldInfoStore.getState().createEntry(book.id, {
      content: 'v0',
      keys: [],
    })!;

    expect(entry.revisions).toHaveLength(1);
    expect(entry.revisions[0].action).toBe('create');

    // Same content, no meta arg at all -> no new revision.
    useWorldInfoStore.getState().updateEntry(book.id, entry.id, { content: 'v0' });
    expect(liveEntryOf(book.id, entry.id)!.revisions).toHaveLength(1);

    // Non-content field, no meta arg -> still no new revision (only content
    // changes trigger a revision when recordRevision isn't forced).
    useWorldInfoStore.getState().updateEntry(book.id, entry.id, { comment: 'just a comment' });
    let live = liveEntryOf(book.id, entry.id)!;
    expect(live.revisions).toHaveLength(1);
    expect(live.comment).toBe('just a comment');

    // Changed content, no meta arg -> exactly one revision appended, action
    // defaults to 'edit', prevContent is the pre-edit content.
    useWorldInfoStore.getState().updateEntry(book.id, entry.id, { content: 'v1' });
    live = liveEntryOf(book.id, entry.id)!;
    expect(live.revisions).toHaveLength(2);
    expect(live.revisions[1].action).toBe('edit');
    expect(live.revisions[1].prevContent).toBe('v0');
    expect(live.revisions[1].sourceChatFile).toBeUndefined();

    // Cap still holds at 10 across many content edits with no meta arg ever
    // passed.
    for (let i = 2; i <= 12; i++) {
      useWorldInfoStore.getState().updateEntry(book.id, entry.id, { content: `v${i}` });
    }
    live = liveEntryOf(book.id, entry.id)!;
    expect(live.revisions.length).toBe(10);
    expect(live.revisions.every((r) => r.action === 'edit')).toBe(true);
    expect(live.content).toBe('v12');
  });
});
