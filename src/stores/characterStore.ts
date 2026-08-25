import { create } from 'zustand';
import { api, type CharacterInfo, type CharacterCreateData, type CharacterEditData, type CharacterDraft } from '../api/client';
import {
  extractCharacterFromPNG,
  extractCharacterBook,
  parseCharacterFromJSON,
  parseLorebookFromJSON,
  cardToCharacterInfo,
  exportCharacterAsJSON,
  embedCharacterInPNG,
  downloadFile,
  LorebookDetectedError,
  type CharacterBookV2,
  type CharacterBookMeta,
  type CharacterCardV2,
  type CharacterExportData,
} from '../utils/characterCard';
import { normalizeCard, type NormalizeOptions } from '../utils/characterNormalize';
import {
  useWorldInfoStore,
  bookToCharacterBookV2,
  legacyIdRemapReady,
  resolveLegacyBookId,
} from './worldInfoStore';
import { useCharacterOwnershipStore } from './characterOwnershipStore';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';

const FAVORITES_KEY = 'sillytavern_character_favorites';
const LINKED_BOOKS_KEY = 'sillytavern_character_linked_books_v1';

// ---------------------------------------------------------------------------
// Server sync for character→lorebook links (mirrors displayPreferencesStore).
//
// The map of avatar → [bookId] follows the user across devices via the
// `stm_character_links` settings section. The book IDs it references live in
// the already-synced `stm_worldinfo` section, so a linked book resolves on any
// device. localStorage stays the instant-render cache; every mutation patches
// the server in the background and stamps LINKED_BOOKS_LOCAL_TS_KEY so a failed
// patch is re-uploaded by the next fetchLinkedBooks instead of being clobbered.
// ---------------------------------------------------------------------------
const LINKED_BOOKS_SERVER_KEY = 'stm_character_links';
const LINKED_BOOKS_LOCAL_TS_KEY = 'stm:character-links-local-ts';

function markLinkedBooksDirty(): void {
  try { markSectionDirty(LINKED_BOOKS_LOCAL_TS_KEY); } catch { /* ignore */ }
}

async function patchLinkedBooksServer(map: Record<string, string[]>): Promise<void> {
  await patchServerKey(LINKED_BOOKS_SERVER_KEY, { links: map }, LINKED_BOOKS_LOCAL_TS_KEY);
}

// Favorites sync in their own section (the links section above stays focused on
// character→book links; folding both in would risk a links-only patch dropping
// favorites).
const FAVORITES_SERVER_KEY = 'stm_character_favorites';
const FAVORITES_LOCAL_TS_KEY = 'stm:character-favorites-local-ts';

function markFavoritesDirty(): void {
  try { markSectionDirty(FAVORITES_LOCAL_TS_KEY); } catch { /* ignore */ }
}

async function patchFavoritesServer(favorites: Set<string>): Promise<void> {
  await patchServerKey(FAVORITES_SERVER_KEY, { favorites: Array.from(favorites) }, FAVORITES_LOCAL_TS_KEY);
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const arr: string[] = JSON.parse(raw);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favorites)));
}

function loadLinkedBooks(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(LINKED_BOOKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, string[]>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveLinkedBooks(map: Record<string, string[]>) {
  try {
    localStorage.setItem(LINKED_BOOKS_KEY, JSON.stringify(map));
  } catch {
    // ignore quota/security errors
  }
}

export type CharacterSortMode = 'name' | 'date_added' | 'date_last_chat' | 'recent_chat';

interface CharacterState {
  characters: CharacterInfo[];
  selectedCharacter: CharacterInfo | null;
  // Group chat support
  groupChatCharacters: CharacterInfo[];
  isGroupChatMode: boolean;
  isLoading: boolean;
  isCreating: boolean;
  isEditing: boolean;
  isImporting: boolean;
  isExporting: boolean;
  isDuplicating: boolean;
  error: string | null;
  /** Set instead of `error` when the only reason importCharacter found no
   *  character is that a dropped JSON file is a lorebook/world-info export
   *  in disguise (has `entries`, no character fields). The UI reads this
   *  off the store rather than re-parsing the file itself, so it always
   *  agrees with the parser's own detection. */
  lorebookDetected: { text: string; name: string; entryCount: number } | null;
  // Organization state
  favorites: Set<string>;
  searchQuery: string;
  selectedTags: Set<string>;
  showFavoritesOnly: boolean;
  sortMode: CharacterSortMode;
  // Per-character extra lorebooks to auto-activate (avatar → book ids).
  // The embedded book (if any) is tracked on the WI book itself via
  // `ownerCharacterAvatar` and is NOT duplicated here.
  linkedBookIdsByAvatar: Record<string, string[]>;
  /** In-progress manual-form character creation, if any — see /character-drafts.
   *  `null` before the first `loadManualDraft()` call resolves, and stays
   *  `null` if there's nothing saved. */
  manualDraft: CharacterDraft | null;

  // Actions
  fetchCharacters: () => Promise<void>;
  selectCharacter: (avatar: string) => Promise<void>;
  createCharacter: (data: CharacterCreateData, avatarFile?: File) => Promise<string | null>;
  /** Pull the caller's saved manual-form draft (if any) from the backend. */
  loadManualDraft: () => Promise<void>;
  /** Upsert the manual-form draft. Best-effort — a failed autosave doesn't
   *  surface an error, it just means the next debounce tick retries. */
  saveManualDraft: (payload: Record<string, unknown>) => Promise<void>;
  /** Clear the manual-form draft (after a successful create, or an explicit discard). */
  discardManualDraft: () => Promise<void>;
  updateCharacter: (data: CharacterEditData, avatarFile?: File) => Promise<boolean>;
  deleteCharacter: (avatar: string) => Promise<boolean>;
  duplicateCharacter: (avatar: string) => Promise<string | null>;
  clearSelection: () => void;
  clearError: () => void;
  clearLorebookDetected: () => void;
  // Group chat actions
  toggleGroupChatCharacter: (avatar: string) => Promise<void>;
  startGroupChat: () => void;
  exitGroupChat: () => void;
  isCharacterInGroup: (avatar: string) => boolean;
  setGroupChatCharacters: (avatars: string[]) => Promise<void>;
  /** Reorder the in-memory group roster without hitting the API. */
  reorderGroupChatCharacters: (avatars: string[]) => void;
  // Import/Export actions
  importCharacter: (
    files: File | File[],
    options?: NormalizeOptions
  ) => Promise<{
    data: Partial<CharacterInfo>;
    avatarFile?: File;
    characterBook?: CharacterBookV2;
    /** Book-level fields (description/scan_depth/token_budget/
     *  recursive_scanning/extensions) that don't survive the native-lorebook
     *  round trip — stashed here so a future provenance write (Phase 1) can
     *  re-merge them at export instead of silently dropping them. */
    bookMeta?: CharacterBookMeta;
    /** The parsed card exactly as read, before whitespace/tag normalization —
     *  for a future "view/restore original import" affordance (Phase 1). */
    rawCard: CharacterCardV2 | CharacterExportData;
    warnings: string[];
    changes: string[];
    /** Names of extra PNG/character-JSON/lorebook-JSON files dropped
     *  alongside the ones actually used (only the first of each kind is
     *  imported today). */
    ignoredFiles: string[];
  } | null>;
  exportCharacterAsPNG: (character: CharacterInfo) => Promise<void>;
  exportCharacterAsJSON: (character: CharacterInfo) => void;
  // Character-embedded lorebook actions
  registerEmbeddedBookFromCard: (
    avatar: string,
    characterBook: CharacterBookV2,
    fallbackName: string
  ) => void;
  getLinkedBookIds: (avatar: string) => string[];
  setLinkedBookIds: (avatar: string, ids: string[]) => void;
  /** Pull character→book links from the server after login and reconcile. */
  fetchLinkedBooks: () => Promise<void>;
  /**
   * One-time-per-login remap of every linkedBookIdsByAvatar entry from a
   * pre-cutover local id to worldInfoStore's native-table id (see
   * resolveLegacyBookId there). The character-lorebook UI only ever offers
   * the viewer's OWN books here (never a shared one, see
   * CharacterLorebookSection.tsx), so this only needs the own-books view —
   * no dependency on sharedBooks having loaded. Synchronous and idempotent:
   * a second call once every id is already current is a true no-op (no
   * `set()`, no localStorage write, no server patch). Called automatically
   * from fetchLinkedBooks once legacyIdRemapReady() resolves; exposed
   * directly so tests can invoke it without driving the full login flow.
   */
  remapLinkedBookIds: () => void;
  /** Pull favorite characters from the server after login and reconcile. */
  fetchFavorites: () => Promise<void>;
  /**
   * Full per-user reset on logout/switch: clears the character list, favorites,
   * and character→book links from memory and localStorage. The links live under
   * a browser-global key, so without this the next user on the same browser
   * could re-upload the previous user's links to their own account (the
   * section's dirty flag + version token would survive into their session).
   */
  resetUser: () => void;
  /** Ids to merge with the globally-active ids during scan. */
  getActiveBookIdsForCharacter: (avatar: string) => string[];
  // Organization actions
  toggleFavorite: (avatar: string) => void;
  isFavorite: (avatar: string) => boolean;
  setSearchQuery: (q: string) => void;
  toggleTagFilter: (tag: string) => void;
  clearTagFilters: () => void;
  setShowFavoritesOnly: (show: boolean) => void;
  setSortMode: (mode: CharacterSortMode) => void;
  getAllTags: () => string[];
  getFilteredCharacters: () => CharacterInfo[];
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  selectedCharacter: null,
  groupChatCharacters: [],
  isGroupChatMode: false,
  isLoading: false,
  isCreating: false,
  isEditing: false,
  isImporting: false,
  isExporting: false,
  isDuplicating: false,
  error: null,
  lorebookDetected: null,
  favorites: loadFavorites(),
  searchQuery: '',
  selectedTags: new Set<string>(),
  showFavoritesOnly: false,
  sortMode: 'name' as CharacterSortMode,
  linkedBookIdsByAvatar: loadLinkedBooks(),
  manualDraft: null,

  fetchCharacters: async () => {
    set({ isLoading: true, error: null });
    try {
      // Fetch characters and ownership metadata in parallel — they're
      // independent but both need to be fresh before UI renders badges.
      const [characters] = await Promise.all([
        api.getCharacters(),
        useCharacterOwnershipStore.getState().fetchOwnership(),
      ]);
      set({ characters, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch characters',
      });
    }
  },

  selectCharacter: async (avatar: string) => {
    const { characters } = get();
    let character = characters.find((c) => c.avatar === avatar);

    if (!character) {
      set({ error: 'Character not found' });
      return;
    }

    // If we don't have full data, fetch it
    if (!character.first_mes) {
      try {
        set({ isLoading: true });
        const fullCharacter = await api.getCharacter(avatar);
        character = { ...character, ...fullCharacter };

        // Update in the list
        set({
          characters: characters.map((c) => (c.avatar === avatar ? character! : c)),
          isLoading: false,
        });
      } catch (error) {
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load character',
        });
        return;
      }
    }

    set({ selectedCharacter: character, isGroupChatMode: false, groupChatCharacters: [] });
  },

  clearSelection: () => set({ selectedCharacter: null }),

  clearLorebookDetected: () => set({ lorebookDetected: null }),

  createCharacter: async (data: CharacterCreateData, avatarFile?: File) => {
    set({ isCreating: true, error: null });
    try {
      const avatarUrl = await api.createCharacter(data, avatarFile);
      // Ownership is recorded server-side when a character is flipped to
      // global. Newly-created characters start personal with no metadata
      // entry, which is the correct default.

      // Fetch the new character directly by its avatar url and push it into
      // the local list so the UI updates instantly, regardless of any
      // server-side listing cache. No background list refetch: the list
      // endpoint can briefly omit the just-created character, which would
      // race the direct push and make the new character vanish until the
      // next pull-to-refresh. Fall back to a full refetch if the direct get
      // itself fails.
      try {
        const newChar = await api.getCharacter(avatarUrl);
        const { characters } = get();
        if (!characters.some((c) => c.avatar === avatarUrl)) {
          set({ characters: [...characters, newChar] });
        }
      } catch {
        await get().fetchCharacters();
      }

      set({ isCreating: false });
      return avatarUrl;
    } catch (error) {
      set({
        isCreating: false,
        error: error instanceof Error ? error.message : 'Failed to create character',
      });
      return null;
    }
  },

  loadManualDraft: async () => {
    try {
      const drafts = await api.listCharacterDrafts();
      set({ manualDraft: drafts.find((d) => d.kind === 'manual') ?? null });
    } catch {
      // Best-effort — no draft banner if the fetch failed, not a hard error.
    }
  },

  saveManualDraft: async (payload: Record<string, unknown>) => {
    try {
      const draft = await api.saveCharacterDraft('manual', payload);
      set({ manualDraft: draft });
    } catch {
      // Best-effort autosave — the next debounce tick retries.
    }
  },

  discardManualDraft: async () => {
    set({ manualDraft: null });
    try {
      await api.deleteCharacterDraft('manual');
    } catch {
      // Best-effort — a stale row left server-side just gets overwritten next save.
    }
  },

  updateCharacter: async (data: CharacterEditData, avatarFile?: File) => {
    set({ isEditing: true, error: null });
    try {
      await api.editCharacter(data, avatarFile);
      // Refresh the character list and selected character
      await get().fetchCharacters();
      // Re-select to get updated data
      const { selectedCharacter } = get();
      if (selectedCharacter?.avatar === data.avatar_url) {
        const updatedCharacter = await api.getCharacter(data.avatar_url);
        set({ selectedCharacter: updatedCharacter });
      }
      set({ isEditing: false });
      return true;
    } catch (error) {
      set({
        isEditing: false,
        error: error instanceof Error ? error.message : 'Failed to update character',
      });
      return false;
    }
  },

  deleteCharacter: async (avatar: string) => {
    const {
      characters: previousCharacters,
      selectedCharacter,
      favorites,
      linkedBookIdsByAvatar,
    } = get();

    // Optimistic update: remove from the local list immediately so the UI
    // reflects the deletion without waiting for the server roundtrip. If the
    // server call fails we roll back below.
    set({
      characters: previousCharacters.filter((c) => c.avatar !== avatar),
      selectedCharacter:
        selectedCharacter?.avatar === avatar ? null : selectedCharacter,
      error: null,
    });

    try {
      await api.deleteCharacter(avatar);

      // Also remove from favorites
      if (favorites.has(avatar)) {
        const newFavorites = new Set(favorites);
        newFavorites.delete(avatar);
        saveFavorites(newFavorites);
        set({ favorites: newFavorites });
        markFavoritesDirty();
        patchFavoritesServer(newFavorites).catch(() => {});
      }
      // Ownership cleanup happens server-side as part of /api/characters/delete
      // when the target is a global character. For personal characters there's
      // no metadata entry to clean up.
      // Clean up every book this character owned — its embedded lorebook and
      // any character-scoped documents — plus linked-book references. Owned
      // books are only ever reachable through their owner, so leaving them
      // behind would strand them; the old call deleted whichever owned book
      // came first, which could destroy a document and leave the card's book.
      useWorldInfoStore.getState().deleteCharacterBooks(avatar);
      if (linkedBookIdsByAvatar[avatar]) {
        const nextLinks = { ...linkedBookIdsByAvatar };
        delete nextLinks[avatar];
        saveLinkedBooks(nextLinks);
        set({ linkedBookIdsByAvatar: nextLinks });
        markLinkedBooksDirty();
        patchLinkedBooksServer(nextLinks).catch(() => {});
      }
      // No post-delete refetch: the server's character list endpoint can
      // briefly still include the just-deleted character (filesystem/cache
      // lag). A background refetch here would race the optimistic removal
      // and make the character pop back into the list until the next
      // pull-to-refresh. The optimistic update is authoritative.
      return true;
    } catch (error) {
      // Roll back the optimistic removal on server failure
      set({
        characters: previousCharacters,
        selectedCharacter,
        error: error instanceof Error ? error.message : 'Failed to delete character',
      });
      return false;
    }
  },

  duplicateCharacter: async (avatar: string) => {
    set({ isDuplicating: true, error: null });
    try {
      const newAvatar = await api.duplicateCharacter(avatar);
      // Server-side: duplicating a global character produces a personal
      // copy in the caller's directory. No metadata to record client-side.
      // Refresh list to show the new character (also refetches ownership).
      await get().fetchCharacters();
      set({ isDuplicating: false });
      return newAvatar;
    } catch (error) {
      set({
        isDuplicating: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate character',
      });
      return null;
    }
  },

  clearError: () => set({ error: null }),

  // ---- Organization actions ----
  toggleFavorite: (avatar: string) => {
    const { favorites } = get();
    const newFavorites = new Set(favorites);
    if (newFavorites.has(avatar)) {
      newFavorites.delete(avatar);
    } else {
      newFavorites.add(avatar);
    }
    saveFavorites(newFavorites);
    set({ favorites: newFavorites });
    markFavoritesDirty();
    patchFavoritesServer(newFavorites).catch(() => {});
  },

  isFavorite: (avatar: string) => get().favorites.has(avatar),

  setSearchQuery: (q: string) => set({ searchQuery: q }),

  toggleTagFilter: (tag: string) => {
    const { selectedTags } = get();
    const newTags = new Set(selectedTags);
    if (newTags.has(tag)) {
      newTags.delete(tag);
    } else {
      newTags.add(tag);
    }
    set({ selectedTags: newTags });
  },

  clearTagFilters: () => set({ selectedTags: new Set<string>() }),

  setShowFavoritesOnly: (show: boolean) => set({ showFavoritesOnly: show }),

  setSortMode: (mode: CharacterSortMode) => set({ sortMode: mode }),

  getAllTags: () => {
    const { characters } = get();
    const tagSet = new Set<string>();
    for (const char of characters) {
      const tags = char.tags || char.data?.tags || [];
      for (const tag of tags) {
        if (tag && typeof tag === 'string') {
          tagSet.add(tag);
        }
      }
    }
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  },

  getFilteredCharacters: () => {
    const {
      characters,
      searchQuery,
      selectedTags,
      showFavoritesOnly,
      favorites,
      sortMode,
    } = get();

    const query = searchQuery.trim().toLowerCase();

    const filtered = characters.filter((char) => {
      // Favorites filter
      if (showFavoritesOnly && !favorites.has(char.avatar)) {
        return false;
      }

      // Tag filter (AND logic: must match all selected tags)
      if (selectedTags.size > 0) {
        const charTags = (char.tags || char.data?.tags || []).map((t) => t.toLowerCase());
        for (const tag of selectedTags) {
          if (!charTags.includes(tag.toLowerCase())) {
            return false;
          }
        }
      }

      // Search filter
      if (query) {
        const name = (char.name || '').toLowerCase();
        const desc = (char.description || char.data?.description || '').toLowerCase();
        const personality = (char.personality || char.data?.personality || '').toLowerCase();
        const creator = (char.creator || char.data?.creator || '').toLowerCase();
        if (
          !name.includes(query) &&
          !desc.includes(query) &&
          !personality.includes(query) &&
          !creator.includes(query)
        ) {
          return false;
        }
      }

      return true;
    });

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      // Favorites always bubble to the top
      const aFav = favorites.has(a.avatar);
      const bFav = favorites.has(b.avatar);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      switch (sortMode) {
        case 'name':
          return (a.name || '').localeCompare(b.name || '');
        case 'date_added':
          return (b.date_added || 0) - (a.date_added || 0);
        case 'date_last_chat':
        case 'recent_chat':
          return (b.date_last_chat || 0) - (a.date_last_chat || 0);
        default:
          return 0;
      }
    });

    return sorted;
  },

  // Group chat actions
  toggleGroupChatCharacter: async (avatar: string) => {
    const { characters, groupChatCharacters } = get();
    const isInGroup = groupChatCharacters.some((c) => c.avatar === avatar);

    if (isInGroup) {
      // Remove from group
      set({
        groupChatCharacters: groupChatCharacters.filter((c) => c.avatar !== avatar),
      });
    } else {
      // Add to group - fetch full character data if needed
      let character = characters.find((c) => c.avatar === avatar);
      if (!character) return;

      if (!character.first_mes) {
        try {
          const fullCharacter = await api.getCharacter(avatar);
          character = { ...character, ...fullCharacter };
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to load character' });
          return;
        }
      }

      set({
        groupChatCharacters: [...groupChatCharacters, character],
      });
    }
  },

  startGroupChat: () => {
    const { groupChatCharacters } = get();
    if (groupChatCharacters.length < 2) {
      set({ error: 'Select at least 2 characters for group chat' });
      return;
    }
    set({
      isGroupChatMode: true,
      selectedCharacter: null, // Clear single character selection
    });
  },

  exitGroupChat: () => {
    set({
      isGroupChatMode: false,
      groupChatCharacters: [],
    });
  },

  isCharacterInGroup: (avatar: string) => {
    return get().groupChatCharacters.some((c) => c.avatar === avatar);
  },

  setGroupChatCharacters: async (avatars: string[]) => {
    const { characters } = get();
    const groupCharacters: CharacterInfo[] = [];

    for (const avatar of avatars) {
      let character = characters.find((c) => c.avatar === avatar);
      if (character) {
        // Fetch full data if needed
        if (!character.first_mes) {
          try {
            const fullCharacter = await api.getCharacter(avatar);
            character = { ...character, ...fullCharacter };
          } catch {
            // Use what we have
          }
        }
        groupCharacters.push(character);
      }
    }

    set({
      groupChatCharacters: groupCharacters,
      isGroupChatMode: true,
      selectedCharacter: null,
    });
  },

  reorderGroupChatCharacters: (avatars: string[]) => {
    const { groupChatCharacters } = get();
    const byAvatar = new Map(groupChatCharacters.map((c) => [c.avatar, c]));
    const reordered: CharacterInfo[] = [];
    for (const a of avatars) {
      const c = byAvatar.get(a);
      if (c) reordered.push(c);
    }
    // Append any members not included in the incoming list so we never lose
    // a participant to a stale payload.
    for (const c of groupChatCharacters) {
      if (!avatars.includes(c.avatar)) reordered.push(c);
    }
    set({ groupChatCharacters: reordered });
  },

  // Import/Export actions
  importCharacter: async (files: File | File[], options?: NormalizeOptions) => {
    const fileList = Array.isArray(files) ? files : [files];
    set({ isImporting: true, error: null, lorebookDetected: null });
    try {
      let characterData: CharacterCardV2 | CharacterExportData | null = null;
      let avatarFile: File | undefined;
      let characterBook: CharacterBookV2 | undefined;
      const ignoredFiles: string[] = [];

      const isPNG = (f: File) =>
        f.type === 'image/png' || f.name.toLowerCase().endsWith('.png');
      const isJSON = (f: File) =>
        f.type === 'application/json' || f.name.toLowerCase().endsWith('.json');

      const pngFiles = fileList.filter(isPNG);
      const jsonFiles = fileList.filter(isJSON);

      if (fileList.some((f) => !isPNG(f) && !isJSON(f))) {
        throw new Error('Unsupported file format. Please use PNG or JSON files.');
      }

      if (pngFiles.length > 1) {
        ignoredFiles.push(...pngFiles.slice(1).map((f) => f.name));
      }

      // Classify JSON files as either lorebook or character card
      const standaloneBooks: CharacterBookV2[] = [];
      const characterJsons: Array<CharacterCardV2 | CharacterExportData> = [];
      // First lorebook-shaped JSON that failed character parsing (a `spec`-
      // tagged file with `entries` but no character fields — the one case
      // parseLorebookFromJSON's own detection doesn't already catch). Kept
      // as authoritative parser output, not a UI-side re-guess, so a caller
      // that finds no character can offer "import as lorebook" using the
      // real detection rather than reimplementing the heuristic.
      let detectedLorebook: { text: string; name: string; entryCount: number } | null = null;

      for (const json of jsonFiles) {
        const book = await parseLorebookFromJSON(json);
        if (book) {
          standaloneBooks.push(book);
        } else {
          try {
            characterJsons.push(await parseCharacterFromJSON(json));
          } catch (err) {
            if (err instanceof LorebookDetectedError) {
              detectedLorebook ??= {
                text: await json.text(),
                name: json.name.replace(/\.json$/i, ''),
                entryCount: err.entryCount,
              };
            }
            // otherwise: unparseable JSON — skip
          }
        }
      }

      if (standaloneBooks.length > 1) {
        ignoredFiles.push('extra lorebook JSON file(s)');
      }
      // A PNG always wins over every character JSON (below), not just the
      // extras beyond the first — report all of them as ignored in that
      // case, rather than only flagging duplicates within the JSON set
      // (which would silently miss the common "dropped one PNG + one JSON
      // for the same character" combination).
      if (pngFiles.length > 0 && characterJsons.length > 0) {
        ignoredFiles.push(
          characterJsons.length === 1
            ? 'character JSON file (a PNG card takes priority)'
            : `${characterJsons.length} character JSON files (a PNG card takes priority)`
        );
      } else if (characterJsons.length > 1) {
        ignoredFiles.push('extra character JSON file(s)');
      }

      // Resolve character source: PNG takes priority over JSON
      if (pngFiles.length > 0) {
        const png = pngFiles[0];
        characterData = await extractCharacterFromPNG(png);
        if (!characterData) throw new Error('No character data found in PNG file');
        avatarFile = png;
      } else if (characterJsons.length > 0) {
        characterData = characterJsons[0];
      }

      if (!characterData) {
        if (detectedLorebook) {
          set({ isImporting: false, lorebookDetected: detectedLorebook });
          return null;
        }
        throw new Error('No character data found. Please provide a PNG or character JSON file.');
      }

      const rawCard = characterData;

      // Normalize: clean whitespace, dedup tags, optionally standardize formatting.
      const { card: normalized, warnings, changes } = normalizeCard(
        characterData,
        { standardizeFormatting: options?.standardizeFormatting ?? false }
      );

      // Lorebook priority: standalone JSON > embedded in card
      if (standaloneBooks.length > 0) {
        characterBook = standaloneBooks[0];
      } else {
        characterBook = extractCharacterBook(normalized) || undefined;
      }

      // Book-level fields the native-lorebook round trip can't carry (the
      // backend's Lorebook table has fixed columns) — stashed for a future
      // provenance write so a re-export doesn't silently drop them.
      const bookMeta: CharacterBookMeta | undefined = characterBook
        ? {
            description: characterBook.description,
            scan_depth: characterBook.scan_depth,
            token_budget: characterBook.token_budget,
            recursive_scanning: characterBook.recursive_scanning,
            extensions: characterBook.extensions,
          }
        : undefined;

      const info = cardToCharacterInfo(normalized);
      set({ isImporting: false });
      return { data: info, avatarFile, characterBook, bookMeta, rawCard, warnings, changes, ignoredFiles };
    } catch (error) {
      set({
        isImporting: false,
        error: error instanceof Error ? error.message : 'Failed to import character',
      });
      return null;
    }
  },

  exportCharacterAsPNG: async (character: CharacterInfo) => {
    set({ isExporting: true, error: null });
    try {
      // B1 — the server hands back the character art with its stored card
      // embedded, but that card's `data.character_book` is only as fresh as
      // the last card write. Lorebook edits go through worldInfoStore and
      // never touch the character row, so the server's copy is stale (and
      // for cards imported before the book was registered, absent). Re-embed
      // client-side from the live book — the same source
      // exportCharacterAsJSON reads — so PNG and JSON exports carry the same
      // card. embedCharacterInPNG strips the server's card chunks first, so
      // the download ends up with exactly one.
      const resp = await fetch(
        `/characters/${encodeURIComponent(character.avatar)}/export.png`,
        { credentials: 'include' },
      );
      if (!resp.ok) {
        throw new Error(`Export failed (HTTP ${resp.status})`);
      }
      const embedded = useWorldInfoStore.getState().getCharacterBook(character.avatar);
      const characterBook = embedded ? bookToCharacterBookV2(embedded) : undefined;
      const pngBlob = await embedCharacterInPNG(
        await resp.blob(),
        character,
        characterBook,
      );
      const filename = `${character.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
      downloadFile(pngBlob, filename);
      set({ isExporting: false });
    } catch (error) {
      set({
        isExporting: false,
        error: error instanceof Error ? error.message : 'Failed to export character',
      });
    }
  },

  exportCharacterAsJSON: (character: CharacterInfo) => {
    try {
      const embedded = useWorldInfoStore.getState().getCharacterBook(character.avatar);
      const characterBook = embedded ? bookToCharacterBookV2(embedded) : undefined;
      const jsonBlob = exportCharacterAsJSON(character, characterBook);
      const filename = `${character.name.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
      downloadFile(jsonBlob, filename);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to export character',
      });
    }
  },

  // ---- Character-embedded lorebook actions ----
  registerEmbeddedBookFromCard: (avatar, characterBook, fallbackName) => {
    useWorldInfoStore
      .getState()
      .upsertCharacterBook(avatar, characterBook, fallbackName);
  },

  getLinkedBookIds: (avatar) => {
    return get().linkedBookIdsByAvatar[avatar] || [];
  },

  setLinkedBookIds: (avatar, ids) => {
    // Drop missing books + character-owned books belonging to a different
    // character. A user linking a book for character A should not be able
    // to scope-activate character B's embedded book.
    const allBooks = useWorldInfoStore.getState().books;
    const valid = ids.filter((id) => {
      const book = allBooks.find((b) => b.id === id);
      if (!book) return false;
      if (book.ownerCharacterAvatar && book.ownerCharacterAvatar !== avatar) {
        return false;
      }
      return true;
    });
    const deduped = Array.from(new Set(valid));
    const next = { ...get().linkedBookIdsByAvatar, [avatar]: deduped };
    if (deduped.length === 0) {
      delete next[avatar];
    }
    saveLinkedBooks(next);
    set({ linkedBookIdsByAvatar: next });
    markLinkedBooksDirty();
    patchLinkedBooksServer(next).catch(() => {});
  },

  fetchLinkedBooks: async () => {
    try {
      const settings = await getSettingsBlob();
      const section = settings[LINKED_BOOKS_SERVER_KEY] as Record<string, unknown> | undefined;
      const serverTs = Number(section?._ts || 0);

      if (shouldReuploadSection(LINKED_BOOKS_LOCAL_TS_KEY, serverTs)) {
        // Local has links that never confirmed to the server — re-upload.
        patchLinkedBooksServer(get().linkedBookIdsByAvatar).catch(() => {});
      } else if (section) {
        const links = section.links;
        if (links && typeof links === 'object' && !Array.isArray(links)) {
          const map = links as Record<string, string[]>;
          saveLinkedBooks(map);
          try { recordServerTs(LINKED_BOOKS_LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
          set({ linkedBookIdsByAvatar: map });
        }
      }
      // else: no server state and no newer local — keep local as-is.
    } catch { /* non-fatal — localStorage values remain active */ }

    // One-time-per-login legacy-id remap (see remapLinkedBookIds' own
    // docstring). Fired regardless of the branch above — even a pure
    // network-failure fallthrough leaves whatever's already in local state
    // worth a remap attempt. Not awaited, for the same reason
    // chatLoreConfigStore's equivalent call isn't: nothing here needs it to
    // finish before fetchLinkedBooks itself resolves, and every fetchPrefs/
    // fetchLinkedBooks call is already fire-and-forget from authStore.ts.
    legacyIdRemapReady()
      .then(() => get().remapLinkedBookIds())
      .catch(() => {});
  },

  remapLinkedBookIds: () => {
    const { linkedBookIdsByAvatar } = get();
    let anyChanged = false;
    const next: Record<string, string[]> = {};

    for (const [avatar, ids] of Object.entries(linkedBookIdsByAvatar)) {
      const seen = new Set<string>();
      const nextIds: string[] = [];
      let changed = false;
      for (const id of ids) {
        const resolved = resolveLegacyBookId(id);
        if (resolved === null) {
          console.warn(
            `[characterStore] dropping unresolvable linkedBookIdsByAvatar entry "${id}" for avatar "${avatar}"`
          );
          changed = true;
          continue;
        }
        if (resolved !== id) changed = true;
        if (seen.has(resolved)) {
          changed = true;
          continue;
        }
        seen.add(resolved);
        nextIds.push(resolved);
      }

      if (nextIds.length > 0) {
        next[avatar] = nextIds;
      } else if (ids.length > 0) {
        changed = true; // dropped to empty -> avatar key removed
      }
      if (changed) anyChanged = true;
    }

    if (!anyChanged) return; // true no-op: no set(), no persistence write
    saveLinkedBooks(next);
    set({ linkedBookIdsByAvatar: next });
    markLinkedBooksDirty();
    patchLinkedBooksServer(next).catch(() => {});
  },

  fetchFavorites: async () => {
    try {
      const settings = await getSettingsBlob();
      const section = settings[FAVORITES_SERVER_KEY] as Record<string, unknown> | undefined;
      const serverTs = Number(section?._ts || 0);

      if (shouldReuploadSection(FAVORITES_LOCAL_TS_KEY, serverTs)) {
        patchFavoritesServer(get().favorites).catch(() => {});
        return;
      }

      if (!section) return;

      if (Array.isArray(section.favorites)) {
        const favorites = new Set(section.favorites.filter((a): a is string => typeof a === 'string'));
        saveFavorites(favorites);
        try { recordServerTs(FAVORITES_LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
        set({ favorites });
      }
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  resetUser: () => {
    set({
      characters: [],
      selectedCharacter: null,
      isGroupChatMode: false,
      groupChatCharacters: [],
      favorites: new Set(),
      linkedBookIdsByAvatar: {},
      manualDraft: null,
    });
    try { localStorage.removeItem(FAVORITES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(LINKED_BOOKS_KEY); } catch { /* ignore */ }
    clearLocalTs(LINKED_BOOKS_LOCAL_TS_KEY);
    clearLocalTs(FAVORITES_LOCAL_TS_KEY);
  },

  getActiveBookIdsForCharacter: (avatar) => {
    if (!avatar) return [];
    const ids: string[] = [];
    // EVERY book this character owns, not just the embedded card book: a
    // character-scoped Data Bank document is a second owned book, and
    // resolving only the first left it invisible to the scan entirely
    // (#450 F1). Owned books stay out of the global activeBookIds on
    // purpose — an active foreign character-scoped book disqualifies every
    // other character's chat from server retrieval (serverRetrieval.ts
    // condition 5) — so this union is the only path that reaches them.
    for (const owned of useWorldInfoStore.getState().getCharacterBooks(avatar)) {
      ids.push(owned.id);
    }
    const linked = get().linkedBookIdsByAvatar[avatar] || [];
    const allBooks = useWorldInfoStore.getState().books;
    for (const linkedId of linked) {
      if (ids.includes(linkedId)) continue; // avoid double-adding an owned id
      const book = allBooks.find((b) => b.id === linkedId);
      if (!book) continue;
      if (book.ownerCharacterAvatar && book.ownerCharacterAvatar !== avatar) {
        continue;
      }
      ids.push(linkedId);
    }
    return ids;
  },
}));
