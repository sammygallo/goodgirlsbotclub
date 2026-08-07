import { describe, it, expect, vi, beforeEach } from 'vitest';

// autoMemoryStore pulls serverSettings (and through worldInfoStore /
// loreConflictStore / authStore, the whole store graph) at module load —
// neutralize before importing, per the worldInfoStore.test.ts /
// chatStore.groupWorldInfo.test.ts pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

// autoMemoryStore -> loreConflictStore -> authStore -> chatStore ->
// lovenseStore -> chatStore is the same require cycle
// chatStore.groupWorldInfo.test.ts hits (lovenseStore calls
// useChatStore.subscribe() at module scope). Neutralize it the same way.
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

// autoMemoryStore's extraction flow drives worldInfoStore's createCharacterBook
// / createEntry, which now (Phase 3a) fire native /lorebooks network calls in
// the background. Mock that whole CRUD surface — mirrors
// worldInfoStore.test.ts's own mock exactly, and for the same reason its
// comment gives: an unmocked call would fall through to a real fetch(), which
// happens to reject on Node's inability to resolve a bare relative URL, and a
// test that passes by accident on that rejection's timing (rather than by an
// explicit deterministic mock) is exactly the kind of thing that turns into a
// flaky suite later — relying on it once already made the pre-existing test
// below order-dependent on exactly how many microtask turns extractFacts's
// own SSE-stream consumption happens to take.
const listLorebooks = vi.fn();
const getLorebook = vi.fn();
const createLorebook = vi.fn();
const updateLorebook = vi.fn();
const deleteLorebook = vi.fn();
const createLorebookEntry = vi.fn();
const updateLorebookEntry = vi.fn();
const deleteLorebookEntry = vi.fn();
const generateMessage = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listLorebooks: (...args: unknown[]) => listLorebooks(...args),
      getLorebook: (...args: unknown[]) => getLorebook(...args),
      createLorebook: (...args: unknown[]) => createLorebook(...args),
      updateLorebook: (...args: unknown[]) => updateLorebook(...args),
      deleteLorebook: (...args: unknown[]) => deleteLorebook(...args),
      createLorebookEntry: (...args: unknown[]) => createLorebookEntry(...args),
      updateLorebookEntry: (...args: unknown[]) => updateLorebookEntry(...args),
      deleteLorebookEntry: (...args: unknown[]) => deleteLorebookEntry(...args),
      generateMessage: (...args: unknown[]) => generateMessage(...args),
    },
  };
});

const { useAutoMemoryStore, parseFactsFromResponse } = await import('./autoMemoryStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { useLoreConflictStore } = await import('./loreConflictStore');
const { useSettingsStore } = await import('./settingsStore');

import type { CharacterInfo } from '../api/client';

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is an inert `{}` (Node's Web
// Storage implementation needs `--localstorage-file` to actually work), so
// every store call would silently no-op behind its own try/catch. Install a
// working in-memory Storage for the duration of this file, fresh before
// every test — mirrors chatLoreConfigStore.test.ts exactly.
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

// Deterministic stand-ins for the native lorebook CRUD surface — echo the
// payload back with a fabricated server_ts, matching worldInfoStore.test.ts's
// own defaults exactly, so applyServer*Meta has something sane to apply.
let mockServerTs = 0;

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  generateMessage.mockReset();
  mockServerTs = 0;
  listLorebooks.mockReset();
  listLorebooks.mockResolvedValue([]);
  getLorebook.mockReset();
  getLorebook.mockResolvedValue({ id: '', ownerHandle: '', server_ts: 0, entries: [] });
  createLorebook.mockReset();
  createLorebook.mockImplementation(async (payload: Record<string, unknown>) => ({
    ownerHandle: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    server_ts: ++mockServerTs,
  }));
  updateLorebook.mockReset();
  updateLorebook.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
    ownerHandle: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    id,
    server_ts: ++mockServerTs,
  }));
  deleteLorebook.mockReset();
  deleteLorebook.mockResolvedValue(undefined);
  createLorebookEntry.mockReset();
  createLorebookEntry.mockImplementation(async (bookId: string, payload: Record<string, unknown>) => ({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    lorebook_id: bookId,
    server_ts: ++mockServerTs,
  }));
  updateLorebookEntry.mockReset();
  updateLorebookEntry.mockImplementation(
    async (bookId: string, entryId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      id: entryId,
      lorebook_id: bookId,
      server_ts: ++mockServerTs,
    })
  );
  deleteLorebookEntry.mockReset();
  deleteLorebookEntry.mockResolvedValue(undefined);
  useWorldInfoStore.getState().resetUser();
  useLoreConflictStore.getState().resetUser();
  useAutoMemoryStore.getState().resetUser();
  useSettingsStore.setState({ activeProvider: 'test-provider', activeModel: 'test-model' });
});

// ---------------------------------------------------------------------------
// parseFactsFromResponse — pure text-in/objects-out, no mocking needed.
// ---------------------------------------------------------------------------

describe('parseFactsFromResponse', () => {
  it('parses a valid conflicts_with integer within the digest range to that number', () => {
    const text = JSON.stringify([
      { keys: ['a'], content: 'fact one', conflicts_with: 3 },
    ]);
    const facts = parseFactsFromResponse(text, 5);
    expect(facts).toHaveLength(1);
    expect(facts[0].conflictsWithIndex).toBe(3);
    expect(facts[0].content).toBe('fact one');
    expect(facts[0].keys).toEqual(['a']);
  });

  it('degrades every malformed conflicts_with shape to null while still keeping the item', () => {
    const digestSize = 5;
    // One item per malformed shape: numeric string, float, zero, negative,
    // one past the valid [1, digestSize] range, an object, and the field
    // omitted entirely.
    const text = `[
      {"keys": ["a"], "content": "numeric string conflict", "conflicts_with": "3"},
      {"keys": ["b"], "content": "float conflict", "conflicts_with": 3.5},
      {"keys": ["c"], "content": "zero conflict", "conflicts_with": 0},
      {"keys": ["d"], "content": "negative conflict", "conflicts_with": -1},
      {"keys": ["e"], "content": "one past range conflict", "conflicts_with": 6},
      {"keys": ["f"], "content": "object conflict", "conflicts_with": {}},
      {"keys": ["g"], "content": "missing field conflict"}
    ]`;
    const facts = parseFactsFromResponse(text, digestSize);
    expect(facts).toHaveLength(7);
    for (const f of facts) {
      expect(f.conflictsWithIndex).toBeNull();
    }
    // Every item survived — none were dropped for the malformed field.
    expect(facts.map((f) => f.content)).toEqual([
      'numeric string conflict',
      'float conflict',
      'zero conflict',
      'negative conflict',
      'one past range conflict',
      'object conflict',
      'missing field conflict',
    ]);
  });

  it('skips an item missing keys and an item missing content, without dropping the rest (pre-existing behavior)', () => {
    const text = `[
      {"content": "no keys here"},
      {"keys": ["h"]},
      {"keys": ["i"], "content": "kept fact"}
    ]`;
    const facts = parseFactsFromResponse(text, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('kept fact');
  });

  it('tolerates the LLM wrapping the JSON array in prose or a markdown code fence', () => {
    const prose = [
      'Sure! Here are the facts:',
      '```json',
      '[{"keys": ["a"], "content": "wrapped fact"}]',
      '```',
      'Hope that helps!',
    ].join('\n');
    const facts = parseFactsFromResponse(prose, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('wrapped fact');
  });
});

// ---------------------------------------------------------------------------
// extractFacts — end-to-end with a mocked LLM response.
//
// api.generateMessage is stubbed to resolve a real ReadableStream carrying an
// SSE-shaped chunk (matching the OpenAI-style `choices[0].delta.content`
// shape parseSSEStream recognizes), so the store's own stream-parsing code
// runs unmodified against a deterministic payload.
// ---------------------------------------------------------------------------

function sseStreamFor(fullText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: fullText } }] })}\n\n` +
    `data: [DONE]\n\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

const AVATAR = 'Ivy.png';
const CHAT_FILE = 'chat-extract.jsonl';

function character(): CharacterInfo {
  return { name: 'Ivy', avatar: AVATAR } as CharacterInfo;
}

function transcript() {
  return [
    { name: 'User', isUser: true, isSystem: false, content: 'Tell me about your day.' },
    { name: 'Ivy', isUser: false, isSystem: false, content: 'It was quiet, mostly.' },
    { name: 'User', isUser: true, isSystem: false, content: 'Anything new happen?' },
    { name: 'Ivy', isUser: false, isSystem: false, content: 'A few things, actually.' },
  ];
}

describe('extractFacts — end-to-end with a mocked LLM response', () => {
  it('routes a mixed batch through both conflict nets (with net-1 precedence), skips an identical duplicate and a pending-duplicate, appends a genuine new fact, and reports correct added/conflicts totals', async () => {
    const wi = useWorldInfoStore.getState();
    const book = wi.createCharacterBook(AVATAR, 'Ivy — Auto Memory');
    useWorldInfoStore.setState((s) => ({
      books: s.books.map((b) => (b.id === book.id ? { ...b, autoExtracted: true } : b)),
    }));

    // Digest entries 1-4, in creation order (conflicts_with below is 1-based
    // against this exact order).
    const e1 = wi.createEntry(book.id, {
      content: 'Ivy has brown hair and ties it back every morning before chores.',
      keys: ['hair'],
    })!;
    const e2 = wi.createEntry(book.id, {
      content: 'Kestrel keeps her sword sheathed at the old forge every night.',
      keys: ['sword'],
    })!;
    const e3 = wi.createEntry(book.id, {
      content: 'Marlowe brews spiced cider nightly at the riverside tavern for weary travelers.',
      keys: ['cider'],
    })!;
    const e4 = wi.createEntry(book.id, {
      content: 'This filler entry exists only to test the identical duplicate skip path.',
      keys: ['dup'],
    })!;

    // A conflict already awaiting user resolution — a fact that re-proposes
    // the same content must be skipped, not re-recorded as a duplicate.
    // Anchored on e4 (deliberately uninvolved in any other conflict below)
    // so it can't be confused with the e1/e2/e3 conflict-count assertions.
    const pendingProposed =
      'A pending fact about the harbor lighthouse being repainted blue that awaits user review.';
    useLoreConflictStore.getState().addConflict({
      chatFile: CHAT_FILE,
      bookId: book.id,
      existingEntryId: e4.id,
      existingContentSnapshot: e4.content,
      proposedContent: pendingProposed,
      proposedKeys: ['lighthouse'],
      detectedBy: 'llm',
    });

    const llmFacts = [
      {
        // Net 1 only: low lexical overlap with e1, but self-reports a
        // conflict against digest item 1.
        keys: ['hair'],
        content: 'Ivy secretly dyed her hair a deep shade of silver last week.',
        conflicts_with: 1,
      },
      {
        // Both nets would catch this (heavy lexical overlap with e2 AND a
        // self-reported conflict against digest item 2) — net 1 must win,
        // producing exactly one record attributed to 'llm'.
        keys: ['sword'],
        content: 'Kestrel now keeps her sword unsheathed at the old forge every night.',
        conflicts_with: 2,
      },
      {
        // Net 2 only: the LLM didn't flag it, but it's a lexical
        // near-duplicate of e3 (only "weary" -> "exhausted" differs).
        keys: ['cider'],
        content:
          'Marlowe brews spiced cider nightly at the riverside tavern for exhausted travelers.',
        conflicts_with: null,
      },
      {
        // Genuinely new — no norm80 match, no near-duplicate, no
        // self-reported conflict.
        keys: ['bridge', 'thorne'],
        content: 'Thorne rebuilt the north bridge using reclaimed stone from the old quarry.',
        conflicts_with: null,
      },
      {
        // Identical to e4 up to case — caught by the cheap norm80 fast path
        // before either detection net runs.
        keys: ['dup'],
        content: e4.content.toUpperCase(),
        conflicts_with: null,
      },
      {
        // Matches an already-pending conflict's proposed content — must be
        // skipped, not re-proposed as a new duplicate record.
        keys: ['lighthouse'],
        content: pendingProposed,
        conflicts_with: null,
      },
    ];

    generateMessage.mockResolvedValueOnce(sseStreamFor(JSON.stringify(llmFacts)));

    const result = await useAutoMemoryStore
      .getState()
      .extractFacts(CHAT_FILE, character(), transcript());

    expect(result).toEqual({ added: 1, conflicts: 3 });

    const freshBook = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
    // 4 pre-seeded + exactly 1 genuinely new append.
    expect(freshBook.entries).toHaveLength(5);

    const appended = freshBook.entries.find((e) => e.keys.includes('thorne'));
    expect(appended).toBeDefined();
    expect(appended!.source).toBe('auto_memory');
    expect(appended!.content).toBe(
      'Thorne rebuilt the north bridge using reclaimed stone from the old quarry.'
    );
    expect(appended!.revisions[0].sourceChatFile).toBe(CHAT_FILE);

    // The identical-duplicate fact never became a second "dup"-keyed entry.
    expect(freshBook.entries.filter((e) => e.keys.includes('dup'))).toHaveLength(1);

    const records = useLoreConflictStore.getState().pendingForBook(book.id);
    // 1 pre-existing pending + 3 newly detected (llm, llm, lint). The
    // identical-duplicate and pending-duplicate facts must add none.
    expect(records).toHaveLength(4);

    const e1Records = records.filter((r) => r.existingEntryId === e1.id && r.detectedBy === 'llm');
    expect(e1Records).toHaveLength(1);
    expect(e1Records[0].proposedContent).toBe(
      'Ivy secretly dyed her hair a deep shade of silver last week.'
    );

    // Both-nets fact: exactly one record for e2, attributed to 'llm'.
    const e2Records = records.filter((r) => r.existingEntryId === e2.id);
    expect(e2Records).toHaveLength(1);
    expect(e2Records[0].detectedBy).toBe('llm');

    const e3Records = records.filter((r) => r.existingEntryId === e3.id);
    expect(e3Records).toHaveLength(1);
    expect(e3Records[0].detectedBy).toBe('lint');

    // Exactly the original pending record carries this proposed content —
    // the matching fact did not spawn a second one.
    expect(records.filter((r) => r.proposedContent === pendingProposed)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractFacts — first-ever run for a brand-new character (no pre-existing
// Auto Memory book).
//
// This is the specific path the test above never exercises: it pre-creates
// the book (and flips autoExtracted) before calling extractFacts, so it
// never touches the `if (!book) { ... createCharacterBook ... }` branch.
// Phase 3a made createCharacterBook/createEntry native-backed (optimistic
// local write + background network call) — this test pins down that the
// book minted mid-extraction is immediately visible in the store's
// synchronous state, not only after the background sync resolves, since
// extractFacts's own post-round-trip `useWorldInfoStore.getState().books
// .find((b) => b.id === book.id)` lookup (and any other same-tick caller)
// depends on that.
// ---------------------------------------------------------------------------

describe('extractFacts — first run for a fresh character (no pre-existing book)', () => {
  it('creates the Auto Memory book synchronously (findable by id and by ownerCharacterAvatar+autoExtracted immediately), sets autoExtracted, and appends the new entry into it', async () => {
    // Sanity: nothing owned by this avatar exists yet.
    expect(
      useWorldInfoStore.getState().books.find((b) => b.ownerCharacterAvatar === AVATAR)
    ).toBeUndefined();

    const llmFacts = [
      {
        keys: ['debut'],
        content: 'Ivy mentioned this is the first time she has told anyone about the lighthouse.',
        conflicts_with: null,
      },
    ];
    generateMessage.mockResolvedValueOnce(sseStreamFor(JSON.stringify(llmFacts)));

    const result = await useAutoMemoryStore
      .getState()
      .extractFacts(CHAT_FILE, character(), transcript());

    expect(result).toEqual({ added: 1, conflicts: 0 });

    // The book must exist, be owned by the right character, and be flagged
    // autoExtracted — all synchronously true by the time extractFacts
    // resolves (no separate fetch/rehydrate step required).
    const book = useWorldInfoStore
      .getState()
      .books.find((b) => b.ownerCharacterAvatar === AVATAR && b.autoExtracted === true);
    expect(book).toBeDefined();
    expect(book!.name).toBe(`Ivy${' — Auto Memory'}`);
    // Auto Memory books must stay private — the backend CHECK constraint
    // (lorebooks_auto_extracted_private_check) requires it, and this must
    // hold regardless of the fact that the book's id is a client-minted
    // UUID rather than a server-assigned one.
    expect(book!.visibility).toBe('private');
    expect(book!.entries).toHaveLength(1);
    expect(book!.entries[0].content).toBe(
      'Ivy mentioned this is the first time she has told anyone about the lighthouse.'
    );

    // A second extraction on the same character must reuse the SAME book,
    // not mint a second one — createCharacterBook's own dedup-by-avatar
    // plus the autoExtracted-scoped find at the top of extractFacts must
    // agree on which book is "the" Auto Memory book.
    generateMessage.mockResolvedValueOnce(sseStreamFor(JSON.stringify([
      { keys: ['second'], content: 'A second, distinct fact about the same night.', conflicts_with: null },
    ])));
    await useAutoMemoryStore.getState().extractFacts(CHAT_FILE, character(), transcript());

    const booksForAvatar = useWorldInfoStore
      .getState()
      .books.filter((b) => b.ownerCharacterAvatar === AVATAR);
    expect(booksForAvatar).toHaveLength(1);
    expect(booksForAvatar[0].id).toBe(book!.id);
    expect(booksForAvatar[0].entries).toHaveLength(2);
  });
});
