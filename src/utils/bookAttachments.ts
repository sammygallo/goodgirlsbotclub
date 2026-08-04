import type { WorldInfoBook } from '../stores/worldInfoStore';
import type { ChatLoreConfig } from './worldInfoComposition';

// ---------------------------------------------------------------------------
// Lorebook v2 — book attachment summary (pure utility)
// ---------------------------------------------------------------------------
//
// Pure module: no React, no zustand/store imports, no side effects. Every
// store's real shape is read by the caller and passed in as plain data.
//
// Precedence note (chat references): a chat's PERSISTED ChatLoreConfig always
// wins over the legacy per-chat chatLinkedBookIds map for that same chat,
// exactly like chatLoreConfigStore.ts's getEffectiveConfig — which returns
// the persisted `configs[chatFile]` immediately when present and only ever
// falls back to synthesizing a config from the legacy map when no persisted
// config exists for that chatFile. There is no merging of the two sources
// for a single chat: promoted (persisted) beats legacy, full stop.

/** Summary of everything a single book is attached to, for the library UI. */
export interface BookAttachments {
  ownerAvatar: string | null;
  /** Deduped, insertion order. */
  linkedByCharacterAvatars: string[];
  linkedByPersonas: { id: string; name: string }[];
  /** Deduped. */
  chatFiles: string[];
  globallyActive: boolean;
}

export interface ComputeBookAttachmentsInput {
  books: WorldInfoBook[];
  activeBookIds: string[];
  /**
   * Character avatar -> extra (non-owned) linked book ids. Matches
   * characterStore.ts's real field name, `linkedBookIdsByAvatar`
   * (the spec's guessed name was correct).
   */
  linkedBookIdsByAvatar: Record<string, string[]>;
  personas: { id: string; name: string; linkedBookIds?: string[] }[];
  chatConfigs: Record<string, ChatLoreConfig>;
  legacyChatLinkedBookIds: Record<string, string[]>;
}

export type LibraryScope = 'all' | 'character' | 'world' | 'auto_memory';

/**
 * Computes, for every book, who/what has it attached: its owning character
 * (if any), which other characters link it in, which personas link it in,
 * which chats reference it, and whether it's in the globally-active set.
 *
 * Dangling references (an id that doesn't correspond to any book in `books`)
 * are silently ignored — never thrown, never given a phantom map entry.
 */
export function computeBookAttachments(
  input: ComputeBookAttachmentsInput
): Map<string, BookAttachments> {
  const {
    books,
    activeBookIds,
    linkedBookIdsByAvatar,
    personas,
    chatConfigs,
    legacyChatLinkedBookIds,
  } = input;

  // 1. Seed every book's entry.
  const result = new Map<string, BookAttachments>();
  for (const book of books) {
    result.set(book.id, {
      ownerAvatar: book.ownerCharacterAvatar,
      linkedByCharacterAvatars: [],
      linkedByPersonas: [],
      chatFiles: [],
      globallyActive: false,
    });
  }

  // 2. Globally active.
  for (const id of activeBookIds) {
    const entry = result.get(id);
    if (entry) entry.globallyActive = true;
  }

  // 3. Character links.
  for (const [avatar, ids] of Object.entries(linkedBookIdsByAvatar)) {
    for (const id of ids) {
      const entry = result.get(id);
      if (!entry) continue;
      if (!entry.linkedByCharacterAvatars.includes(avatar)) {
        entry.linkedByCharacterAvatars.push(avatar);
      }
    }
  }

  // 4. Persona links.
  for (const persona of personas) {
    for (const id of persona.linkedBookIds ?? []) {
      const entry = result.get(id);
      if (!entry) continue;
      if (!entry.linkedByPersonas.some((p) => p.id === persona.id)) {
        entry.linkedByPersonas.push({ id: persona.id, name: persona.name });
      }
    }
  }

  // 5. Chat references — precedence-critical. Persisted config always wins
  // over the legacy map for a given chatFile (mirrors getEffectiveConfig).
  const promotedChatFiles = new Set(Object.keys(chatConfigs));

  // Per-book Set for internal dedupe; converted to arrays at the end.
  const chatFileSets = new Map<string, Set<string>>();
  const addChatFile = (bookId: string, chatFile: string) => {
    if (!result.has(bookId)) return;
    let set = chatFileSets.get(bookId);
    if (!set) {
      set = new Set();
      chatFileSets.set(bookId, set);
    }
    set.add(chatFile);
  };

  for (const [chatFile, cfg] of Object.entries(chatConfigs)) {
    for (const id of cfg.linkedBookIds) {
      addChatFile(id, chatFile);
    }
  }

  for (const [chatFile, ids] of Object.entries(legacyChatLinkedBookIds)) {
    if (promotedChatFiles.has(chatFile)) continue; // stale — promoted config wins
    for (const id of ids) {
      addChatFile(id, chatFile);
    }
  }

  for (const [bookId, set] of chatFileSets) {
    const entry = result.get(bookId);
    if (entry) entry.chatFiles = [...set];
  }

  return result;
}

/**
 * Filters books by library scope. These are FILTERS, not a PARTITION — a
 * book can satisfy more than one scope simultaneously (an auto-extracted
 * character-owned book matches 'all', 'character', AND 'auto_memory' at the
 * same time). That overlap is intentional, not a bug to reconcile.
 */
export function filterBooksByScope(
  books: WorldInfoBook[],
  scope: LibraryScope
): WorldInfoBook[] {
  switch (scope) {
    case 'all':
      return books;
    case 'character':
      return books.filter((b) => b.ownerCharacterAvatar != null);
    case 'world':
      return books.filter((b) => b.ownerCharacterAvatar == null);
    case 'auto_memory':
      return books.filter((b) => b.autoExtracted === true);
  }
}
