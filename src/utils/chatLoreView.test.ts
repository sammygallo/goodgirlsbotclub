import { describe, it, expect } from 'vitest';

import { buildChatLoreView } from './chatLoreView';
import type { BuildChatLoreViewInput } from './chatLoreView';
import {
  resolveEffectiveBooks,
  hashContent,
  CHAT_LOCAL_BOOK_NAME,
} from './worldInfoComposition';
import type { ChatLoreConfig, EntryOverlay } from './worldInfoComposition';

import { DEFAULT_ENTRY, auditBookHealth } from '../stores/worldInfoStore';
import type { WorldInfoEntry, WorldInfoBook } from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// Fixture helpers — same conventions as resolveEffectiveBooks.test.ts /
// chatStore.groupWorldInfo.test.ts (mkEntry/mkBook spreading DEFAULT_ENTRY),
// extended with an mkInput helper for BuildChatLoreViewInput's extra fields.
// ---------------------------------------------------------------------------

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
    source: 'manual',
    revisions: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkBook(
  entries: WorldInfoEntry[],
  over: Partial<WorldInfoBook> = {}
): WorldInfoBook {
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

function mkConfig(over: Partial<ChatLoreConfig> = {}): ChatLoreConfig {
  return {
    chatFile: 'test.jsonl',
    linkedBookIds: [],
    excludedEntryIds: {},
    overlays: {},
    localEntries: [],
    updatedAt: 0,
    ...over,
  };
}

function mkOverlay(over: Partial<EntryOverlay> = {}): EntryOverlay {
  return {
    baseEntryId: 'unset',
    baseBookId: 'unset',
    patch: {},
    baseContentHash: '',
    createdBy: 'tester',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkInput(over: Partial<BuildChatLoreViewInput> = {}): BuildChatLoreViewInput {
  return {
    books: [],
    inheritedBookIds: [],
    effectiveConfig: undefined,
    characterAvatars: [],
    characterNames: new Map(),
    personaName: null,
    personaBookIds: [],
    chatAttachedBookIds: [],
    profile: 'generic',
    tokenBudget: 0,
    characterBookIds: [],
    characterBookNames: new Map(),
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('buildChatLoreView — label precedence', () => {
  it('resolves "character" when a book id is in both characterBookIds and personaBookIds', () => {
    const book = mkBook([mkEntry()]);
    const vm = buildChatLoreView(
      mkInput({
        books: [book],
        inheritedBookIds: [book.id],
        characterBookIds: [book.id],
        personaBookIds: [book.id],
        personaName: 'Ash',
        characterBookNames: new Map([[book.id, 'Seraphina']]),
      })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    expect(section.labelKind).toBe('character');
    expect(section.labelName).toBe('Character: Seraphina');
  });

  it('resolves "persona" when a book id is in personaBookIds but not characterBookIds', () => {
    const book = mkBook([mkEntry()]);
    const vm = buildChatLoreView(
      mkInput({
        books: [book],
        inheritedBookIds: [book.id],
        personaBookIds: [book.id],
        personaName: 'Ash',
      })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    expect(section.labelKind).toBe('persona');
    expect(section.labelName).toBe('Persona: Ash');
  });

  it('resolves "chat_attached" when a book id is only present in chatAttachedBookIds', () => {
    const book = mkBook([mkEntry()]);
    const vm = buildChatLoreView(
      mkInput({
        books: [book],
        chatAttachedBookIds: [book.id],
      })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    expect(section.labelKind).toBe('chat_attached');
    expect(section.labelName).toBe(book.name);
  });

  it('resolves "world" for a plain unattached world book', () => {
    const book = mkBook([mkEntry()], { name: 'Generic Lore' });
    const vm = buildChatLoreView(
      mkInput({
        books: [book],
        inheritedBookIds: [book.id],
      })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    expect(section.labelKind).toBe('world');
    expect(section.labelName).toBe('Generic Lore');
  });
});

describe('buildChatLoreView — missing provenance defaults to inherited', () => {
  it('tags every row inherited when resolveEffectiveBooks takes its empty-provenance fast path', () => {
    const e1 = mkEntry({ keys: ['a'] });
    const e2 = mkEntry({ keys: ['b'] });
    const e3 = mkEntry({ keys: ['c'] });
    const book = mkBook([e1, e2, e3]);

    // Sanity-check the premise directly: no chatConfig at all takes the v1
    // identity fast path, whose provenance map is empty.
    const preCheck = resolveEffectiveBooks([book], [book.id], undefined);
    expect(preCheck.provenance.size).toBe(0);

    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id] })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    expect(section.rows).toHaveLength(3);
    expect(section.rows.every((r) => r.provenance === 'inherited')).toBe(true);
  });

  it('also defaults to inherited under the linked-only fast path (still an empty provenance map)', () => {
    const e1 = mkEntry({ keys: ['a'] });
    const book = mkBook([e1]);
    const linkedBook = mkBook([mkEntry()]);
    const config = mkConfig({ linkedBookIds: [linkedBook.id] });

    const preCheck = resolveEffectiveBooks([book, linkedBook], [book.id], config);
    expect(preCheck.provenance.size).toBe(0);

    const vm = buildChatLoreView(
      mkInput({
        books: [book, linkedBook],
        inheritedBookIds: [book.id],
        chatAttachedBookIds: [linkedBook.id],
        effectiveConfig: config,
      })
    );

    const section = vm.sections.find((s) => s.book.id === linkedBook.id)!;
    expect(section.rows.every((r) => r.provenance === 'inherited')).toBe(true);
  });
});

describe('buildChatLoreView — excluded rows still render', () => {
  it("keeps a row for an excluded entry, sourced from the book's own entry list, tagged excluded", () => {
    const kept = mkEntry({ keys: ['keep'] });
    const excluded = mkEntry({ keys: ['drop'] });
    const book = mkBook([kept, excluded]);
    const config = mkConfig({
      excludedEntryIds: { [book.id]: [excluded.id] },
    });

    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );

    const section = vm.sections.find((s) => s.book.id === book.id)!;
    const excludedRow = section.rows.find((r) => r.base.id === excluded.id);
    expect(excludedRow).toBeDefined();
    expect(excludedRow!.provenance).toBe('excluded');
    // The kept entry is unaffected.
    const keptRow = section.rows.find((r) => r.base.id === kept.id)!;
    expect(keptRow.provenance).toBe('inherited');

    // Confirm the premise: resolveEffectiveBooks's own effectiveBooks output
    // really does drop the excluded entry (that's exactly why the row still
    // needing to appear here is a meaningful assertion).
    const effectiveResult = resolveEffectiveBooks([book], [book.id], config);
    const effectiveBook = effectiveResult.effectiveBooks.find((b) => b.id === book.id)!;
    expect(effectiveBook.entries.some((e) => e.id === excluded.id)).toBe(false);
  });
});

describe('buildChatLoreView — bookToggle tri-state', () => {
  it('is "on" when none of a 3-entry book\'s entries are excluded', () => {
    const book = mkBook([mkEntry(), mkEntry(), mkEntry()]);
    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id] })
    );
    expect(vm.sections.find((s) => s.book.id === book.id)!.bookToggle).toBe('on');
  });

  it('is "off" when all 3 entries of a 3-entry book are excluded', () => {
    const [e1, e2, e3] = [mkEntry(), mkEntry(), mkEntry()];
    const book = mkBook([e1, e2, e3]);
    const config = mkConfig({
      excludedEntryIds: { [book.id]: [e1.id, e2.id, e3.id] },
    });
    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );
    expect(vm.sections.find((s) => s.book.id === book.id)!.bookToggle).toBe('off');
  });

  it('is "mixed" when exactly 1 of a 3-entry book\'s entries is excluded', () => {
    const [e1, e2, e3] = [mkEntry(), mkEntry(), mkEntry()];
    const book = mkBook([e1, e2, e3]);
    const config = mkConfig({
      excludedEntryIds: { [book.id]: [e1.id] },
    });
    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );
    expect(vm.sections.find((s) => s.book.id === book.id)!.bookToggle).toBe('mixed');
  });
});

describe('buildChatLoreView — overlayDrifted', () => {
  it("is false when the overlay's baseContentHash still matches the base entry's current content", () => {
    const entry = mkEntry({ content: 'original content' });
    const book = mkBook([entry]);
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'overridden content' },
      baseContentHash: hashContent(entry.content),
    });
    const config = mkConfig({ overlays: { [entry.id]: overlay } });

    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );

    const row = vm.sections
      .find((s) => s.book.id === book.id)!
      .rows.find((r) => r.base.id === entry.id)!;
    expect(row.overlayDrifted).toBe(false);
  });

  it('is true when the base entry\'s content changed since the overlay forked it (base edit, overlay stale)', () => {
    const forkedFromContent = 'original content';
    // Simulate a base edit: the entry currently in the library has different
    // content than what was hashed at fork time, but keeps the same id — the
    // overlay was never updated to match.
    const entry = mkEntry({ id: 'e-drift', content: 'edited content since the fork' });
    const book = mkBook([entry]);
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'overridden content' },
      baseContentHash: hashContent(forkedFromContent),
    });
    const config = mkConfig({ overlays: { [entry.id]: overlay } });

    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );

    const row = vm.sections
      .find((s) => s.book.id === book.id)!
      .rows.find((r) => r.base.id === entry.id)!;
    expect(row.overlayDrifted).toBe(true);
  });
});

describe('buildChatLoreView — effectiveEntryCount / pinnedTokens totals', () => {
  it('matches auditBookHealth summed over the same effective active books (cross-checked, not hardcoded)', () => {
    const constant = mkEntry({
      constant: true,
      content: 'Pinned constant lore that costs a meaningful number of tokens.',
    });
    const critical = mkEntry({
      critical: true,
      content: 'Pinned critical lore, also token-costly and never evicted.',
    });
    const plain = mkEntry({ content: 'Ordinary, unpinned lore entry.' });
    const disabled = mkEntry({
      enabled: false,
      content: 'Disabled entry, must not count toward entryCount or tokens.',
    });
    const book = mkBook([constant, critical, plain, disabled]);

    const otherEntry = mkEntry({ content: 'Lore from a second, separate book.' });
    const otherBook = mkBook([otherEntry]);

    const books = [book, otherBook];
    const inheritedBookIds = [book.id, otherBook.id];
    const profile = 'generic' as const;

    const vm = buildChatLoreView(
      mkInput({ books, inheritedBookIds, profile, tokenBudget: 100 })
    );

    // Cross-check against the real resolver + health function directly
    // (same call buildChatLoreView itself makes), instead of hardcoding
    // expected numeric totals.
    const effectiveResult = resolveEffectiveBooks(books, inheritedBookIds, undefined);
    const activeIdSet = new Set(effectiveResult.effectiveActiveIds);
    const activeBooks = effectiveResult.effectiveBooks.filter((b) => activeIdSet.has(b.id));

    let expectedEntryCount = 0;
    let expectedPinnedTokens = 0;
    for (const b of activeBooks) {
      const health = auditBookHealth(b, profile);
      expectedEntryCount += health.entryCount;
      expectedPinnedTokens += health.pinnedTokens;
    }

    expect(vm.effectiveEntryCount).toBe(expectedEntryCount);
    expect(vm.pinnedTokens).toBe(expectedPinnedTokens);
    // Guard against a vacuously-true assertion (both sides trivially 0).
    expect(expectedEntryCount).toBeGreaterThan(0);
    expect(expectedPinnedTokens).toBeGreaterThan(0);
  });

  it('also matches auditBookHealth under the full composition path (exclusions + overlay + local entries)', () => {
    const excluded = mkEntry({ content: 'Excluded lore, must not count.' });
    const overridden = mkEntry({ constant: true, content: 'original pinned content' });
    const plain = mkEntry({ content: 'Ordinary lore entry.' });
    const book = mkBook([excluded, overridden, plain]);

    const overlay = mkOverlay({
      baseEntryId: overridden.id,
      baseBookId: book.id,
      patch: { content: 'a longer overridden pinned content string' },
      baseContentHash: hashContent(overridden.content),
    });
    const localEntry = mkEntry({ critical: true, content: 'Local critical fact.' });

    const config = mkConfig({
      excludedEntryIds: { [book.id]: [excluded.id] },
      overlays: { [overridden.id]: overlay },
      localEntries: [localEntry],
    });

    const books = [book];
    const inheritedBookIds = [book.id];
    const profile = 'claude' as const;

    const vm = buildChatLoreView(
      mkInput({ books, inheritedBookIds, profile, tokenBudget: 100, effectiveConfig: config })
    );

    const effectiveResult = resolveEffectiveBooks(books, inheritedBookIds, config);
    const activeIdSet = new Set(effectiveResult.effectiveActiveIds);
    const activeBooks = effectiveResult.effectiveBooks.filter((b) => activeIdSet.has(b.id));

    let expectedEntryCount = 0;
    let expectedPinnedTokens = 0;
    for (const b of activeBooks) {
      const health = auditBookHealth(b, profile);
      expectedEntryCount += health.entryCount;
      expectedPinnedTokens += health.pinnedTokens;
    }

    expect(vm.effectiveEntryCount).toBe(expectedEntryCount);
    expect(vm.pinnedTokens).toBe(expectedPinnedTokens);
    expect(expectedEntryCount).toBeGreaterThan(0);
    expect(expectedPinnedTokens).toBeGreaterThan(0);
    // The excluded entry's content must not have leaked into the pinned-token
    // sum via the synthetic local book or anywhere else.
    expect(vm.effectiveEntryCount).toBeLessThan(
      books.reduce((n, b) => n + b.entries.length, 0) + config.localEntries.length
    );
  });
});

describe('buildChatLoreView — hasAnyCustomization', () => {
  it('is false when effectiveConfig is undefined', () => {
    const vm = buildChatLoreView(mkInput({ effectiveConfig: undefined }));
    expect(vm.hasAnyCustomization).toBe(false);
  });

  it('is false for a fully vacuous config', () => {
    const vm = buildChatLoreView(mkInput({ effectiveConfig: mkConfig({}) }));
    expect(vm.hasAnyCustomization).toBe(false);
  });

  it('is true when excludedEntryIds has any non-empty array', () => {
    const entry = mkEntry();
    const book = mkBook([entry]);
    const config = mkConfig({ excludedEntryIds: { [book.id]: [entry.id] } });
    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );
    expect(vm.hasAnyCustomization).toBe(true);
  });

  it('is true when overlays is non-empty', () => {
    const entry = mkEntry({ content: 'x' });
    const book = mkBook([entry]);
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      baseContentHash: hashContent('x'),
    });
    const config = mkConfig({ overlays: { [entry.id]: overlay } });
    const vm = buildChatLoreView(
      mkInput({ books: [book], inheritedBookIds: [book.id], effectiveConfig: config })
    );
    expect(vm.hasAnyCustomization).toBe(true);
  });

  it('is true when localEntries is non-empty', () => {
    const local = mkEntry({ content: 'local fact' });
    const config = mkConfig({ localEntries: [local] });
    const vm = buildChatLoreView(mkInput({ effectiveConfig: config }));
    expect(vm.hasAnyCustomization).toBe(true);
  });
});

describe('buildChatLoreView — synthetic "This chat" section', () => {
  it('is always present, even with zero local entries, and is the last section', () => {
    const book1 = mkBook([mkEntry()]);
    const book2 = mkBook([mkEntry()]);
    const vm = buildChatLoreView(
      mkInput({ books: [book1, book2], inheritedBookIds: [book1.id, book2.id] })
    );

    const last = vm.sections[vm.sections.length - 1];
    expect(last.labelKind).toBe('chat_local');
    expect(last.labelName).toBe(CHAT_LOCAL_BOOK_NAME);
    expect(last.rows).toHaveLength(0);
    expect(last.totalCount).toBe(0);
    expect(vm.sections.filter((s) => s.labelKind === 'chat_local')).toHaveLength(1);
  });

  it('is still last, and contains the local entries, when localEntries is non-empty', () => {
    const book1 = mkBook([mkEntry()]);
    const book2 = mkBook([mkEntry()]);
    const local = mkEntry({ content: 'local fact' });
    const config = mkConfig({ localEntries: [local] });
    const vm = buildChatLoreView(
      mkInput({
        books: [book1, book2],
        inheritedBookIds: [book1.id, book2.id],
        effectiveConfig: config,
      })
    );

    const last = vm.sections[vm.sections.length - 1];
    expect(last.labelKind).toBe('chat_local');
    expect(last.rows.some((r) => r.base.id === local.id)).toBe(true);
    expect(last.rows.find((r) => r.base.id === local.id)!.provenance).toBe('local');
  });
});
