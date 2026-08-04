import type { WorldInfoEntry, WorldInfoBook } from '../stores/worldInfoStore';
import { auditBookHealth } from '../stores/worldInfoStore';
import type { TokenizerProfile } from './tokenizer';
import type { ChatLoreConfig, EntryOverlay, EntryProvenance } from './worldInfoComposition';
import {
  resolveEffectiveBooks,
  hashContent,
  CHAT_LOCAL_BOOK_NAME,
  chatLocalBookId,
  isChatLocalBookId,
} from './worldInfoComposition';

// ---------------------------------------------------------------------------
// Lorebook v2 — pure "chat lore" view-model builder
// ---------------------------------------------------------------------------
//
// This module has no React/zustand imports and no store access. It takes
// plain data (books, the resolved per-chat config, and some caller-computed
// lookups the store layer would otherwise own) and produces a plain
// view-model the chat-lore UI can render directly. resolveEffectiveBooks is
// called exactly once per buildChatLoreView invocation — see the numbered
// call site below.

// ---- Types ------------------------------------------------------------------

export interface LoreEntryRowVM {
  base: WorldInfoEntry;
  effective: WorldInfoEntry;
  provenance: EntryProvenance;
  overlay?: EntryOverlay;
  overlayDrifted: boolean;
}

export interface LoreSourceSectionVM {
  book: WorldInfoBook;
  labelKind: 'world' | 'character' | 'persona' | 'chat_attached' | 'chat_local';
  labelName: string;
  rows: LoreEntryRowVM[];
  inheritedCount: number;
  totalCount: number;
  bookToggle: 'on' | 'off' | 'mixed';
}

export interface ChatLoreViewVM {
  sections: LoreSourceSectionVM[];
  effectiveEntryCount: number;
  pinnedTokens: number;
  tokenBudget: number;
  pinnedOverBudget: boolean;
  hasAnyCustomization: boolean;
}

export interface BuildChatLoreViewInput {
  books: WorldInfoBook[];
  /** Caller-computed union: global-active + character + persona book ids (NOT chat-linked). */
  inheritedBookIds: string[];
  effectiveConfig: ChatLoreConfig | undefined;
  characterAvatars: string[];
  /** avatar -> display name. */
  characterNames: Map<string, string>;
  personaName: string | null;
  personaBookIds: string[];
  /** The book ids attached to this specific chat (config.linkedBookIds, or the legacy fallback). */
  chatAttachedBookIds: string[];
  profile: TokenizerProfile;
  tokenBudget: number;
  /**
   * ADDED for Phase 2 (see report): every book id considered "character"
   * scoped for label-precedence purposes. This is not just each character's
   * embedded book (book.ownerCharacterAvatar) — a character can also link an
   * extra, non-owned global book (see CharacterLorebookSection), and this
   * module has no character-store access to compute that union itself, so
   * the caller precomputes it from characterAvatars.
   */
  characterBookIds: string[];
  /**
   * ADDED for Phase 2 (see report): bookId -> character display name, for
   * every id in characterBookIds. A "character book" per characterBookIds
   * above may be a linked (non-owned) book, so its label name can't always
   * be recovered from the book itself (WorldInfoBook.ownerCharacterAvatar is
   * null for those) — the caller resolves it once via characterAvatars +
   * characterNames and hands us the flat map. characterAvatars/characterNames
   * are kept on this input mainly for that caller-side bookkeeping; this
   * function itself only reads characterBookNames for labeling.
   */
  characterBookNames: Map<string, string>;
}

// ---- Internal helpers ---------------------------------------------------------

/** Unique values, preserving first-occurrence order. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 'off' when every one of the book's OWN current entries is excluded for
 * this chat, 'on' when none are, 'mixed' otherwise. An empty book counts as
 * 'on' (nothing to exclude, so there's nothing customized about it).
 */
function computeBookToggle(
  book: WorldInfoBook,
  effectiveConfig: ChatLoreConfig | undefined
): 'on' | 'off' | 'mixed' {
  const total = book.entries.length;
  if (total === 0) return 'on';
  const bookEntryIds = new Set(book.entries.map((e) => e.id));
  const excludedRaw = effectiveConfig?.excludedEntryIds?.[book.id] ?? [];
  const excludedCount = excludedRaw.filter((id) => bookEntryIds.has(id)).length;
  if (excludedCount === 0) return 'on';
  if (excludedCount === total) return 'off';
  return 'mixed';
}

function computeHasAnyCustomization(cfg: ChatLoreConfig | undefined): boolean {
  if (!cfg) return false;
  const anyExcluded = Object.values(cfg.excludedEntryIds ?? {}).some(
    (arr) => Array.isArray(arr) && arr.length > 0
  );
  const anyOverlays = Object.keys(cfg.overlays ?? {}).length > 0;
  const anyLocal = (cfg.localEntries?.length ?? 0) > 0;
  return anyExcluded || anyOverlays || anyLocal;
}

function buildRows(
  book: WorldInfoBook,
  provenanceMap: Map<string, EntryProvenance>,
  effectiveEntryById: Map<string, WorldInfoEntry>,
  effectiveConfig: ChatLoreConfig | undefined
): LoreEntryRowVM[] {
  return book.entries.map((entry) => {
    const provenance = provenanceMap.get(entry.id) ?? 'inherited';
    const effective = effectiveEntryById.get(entry.id) ?? entry;
    const overlay = effectiveConfig?.overlays?.[entry.id];
    const overlayDrifted = !!overlay && overlay.baseContentHash !== hashContent(entry.content);
    return { base: entry, effective, provenance, overlay, overlayDrifted };
  });
}

// ---- Core builder ---------------------------------------------------------

/**
 * Builds the full view-model for the "chat lore" screen: one section per
 * source book (world/character/persona/chat_attached) reflecting its own
 * full entry list — including entries excluded for this chat, so the UI can
 * still render them as "Off" rows — plus one always-present synthetic
 * "This chat" section for local entries (and any promoted orphans).
 */
export function buildChatLoreView(input: BuildChatLoreViewInput): ChatLoreViewVM {
  // Requirement 1: resolveEffectiveBooks is called exactly once, right here.
  const effectiveResult = resolveEffectiveBooks(
    input.books,
    input.inheritedBookIds,
    input.effectiveConfig
  );

  // Requirement 2: entryId -> effective (merged) entry, for O(1) lookup.
  const effectiveEntryById = new Map<string, WorldInfoEntry>();
  for (const b of effectiveResult.effectiveBooks) {
    for (const e of b.entries) effectiveEntryById.set(e.id, e);
  }

  const booksById = new Map<string, WorldInfoBook>();
  for (const b of input.books) booksById.set(b.id, b);

  const characterBookIdSet = new Set(input.characterBookIds);
  const personaBookIdSet = new Set(input.personaBookIds);
  const chatAttachedBookIdSet = new Set(input.chatAttachedBookIds);

  // Requirement 3: one section per SOURCE book referenced by
  // inheritedBookIds ∪ chatAttachedBookIds, iterating each book's own full
  // entries array (not the possibly-filtered effectiveBooks version).
  const sourceBookIds = dedupe([...input.inheritedBookIds, ...input.chatAttachedBookIds]);

  const sections: LoreSourceSectionVM[] = [];
  for (const bookId of sourceBookIds) {
    const book = booksById.get(bookId);
    if (!book) continue; // book deleted since it was linked/inherited

    const rows = buildRows(book, effectiveResult.provenance, effectiveEntryById, input.effectiveConfig);
    const inheritedCount = rows.filter((r) => r.provenance === 'inherited').length;
    const totalCount = rows.length;
    const bookToggle = computeBookToggle(book, input.effectiveConfig);

    // Requirement 4: labelKind/labelName precedence — character > persona >
    // chat_attached > world.
    let labelKind: LoreSourceSectionVM['labelKind'];
    let labelName: string;
    if (characterBookIdSet.has(bookId)) {
      labelKind = 'character';
      labelName = `Character: ${input.characterBookNames.get(bookId) ?? book.name}`;
    } else if (personaBookIdSet.has(bookId)) {
      labelKind = 'persona';
      labelName = `Persona: ${input.personaName ?? book.name}`;
    } else if (chatAttachedBookIdSet.has(bookId)) {
      labelKind = 'chat_attached';
      labelName = book.name;
    } else {
      labelKind = 'world';
      labelName = book.name;
    }

    sections.push({ book, labelKind, labelName, rows, inheritedCount, totalCount, bookToggle });
  }

  // Requirement 6: always append exactly one synthetic "This chat" section,
  // even when empty. Prefer the local book resolveEffectiveBooks already
  // produced (it folds in promoted orphans) over reading localEntries
  // directly — see the module doc for why that's the simplest correct
  // source: when there's no such book in effectiveBooks, localEntries was
  // necessarily empty too (resolveEffectiveBooks only skips building the
  // synthetic book when linked/excluded/overlays/local are all absent).
  const localBookFromResult = effectiveResult.effectiveBooks.find((b) => isChatLocalBookId(b.id));
  const localEntries = localBookFromResult?.entries ?? [];
  const chatFile = input.effectiveConfig?.chatFile ?? '__no_chat__';
  const localBook: WorldInfoBook = {
    id: localBookFromResult?.id ?? chatLocalBookId(chatFile),
    name: CHAT_LOCAL_BOOK_NAME,
    entries: localEntries,
    ownerCharacterAvatar: null,
    scope: 'world',
    ownerHandle: '',
    visibility: 'private',
    createdAt: input.effectiveConfig?.updatedAt ?? 0,
    updatedAt: input.effectiveConfig?.updatedAt ?? 0,
  };
  const localRows: LoreEntryRowVM[] = localEntries.map((entry) => ({
    base: entry,
    effective: entry,
    provenance: 'local',
    overlay: undefined,
    overlayDrifted: false,
  }));
  sections.push({
    book: localBook,
    labelKind: 'chat_local',
    labelName: CHAT_LOCAL_BOOK_NAME,
    rows: localRows,
    inheritedCount: 0,
    totalCount: localRows.length,
    bookToggle: computeBookToggle(localBook, input.effectiveConfig),
  });

  // Requirement 7: effectiveEntryCount / pinnedTokens summed over the books
  // actually present in resolveEffectiveBooks()'s result (effectiveBooks
  // filtered to effectiveActiveIds), NOT the raw source books used above.
  const activeIdSet = new Set(effectiveResult.effectiveActiveIds);
  const activeEffectiveBooks = effectiveResult.effectiveBooks.filter((b) => activeIdSet.has(b.id));
  let effectiveEntryCount = 0;
  let pinnedTokens = 0;
  for (const b of activeEffectiveBooks) {
    const health = auditBookHealth(b, input.profile);
    effectiveEntryCount += health.entryCount;
    pinnedTokens += health.pinnedTokens;
  }

  return {
    sections,
    effectiveEntryCount,
    pinnedTokens,
    tokenBudget: input.tokenBudget,
    pinnedOverBudget: input.tokenBudget > 0 && pinnedTokens > input.tokenBudget,
    hasAnyCustomization: computeHasAnyCustomization(input.effectiveConfig),
  };
}
