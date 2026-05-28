import { create } from 'zustand';
import { api, type CharacterMetadataMap } from '../api/client';
import type { UserRole } from '../types';

/**
 * Server-backed character ownership and visibility.
 *
 * Ownership and the personal/global visibility flag are stored in
 * `_global/character-metadata.json` on the SillyTavern backend and exposed
 * via `POST /api/characters/metadata`. Mutations go through
 * `POST /api/characters/set-visibility`, which physically moves the PNG
 * between a user's personal directory and `_global/characters/`.
 *
 * This store is a thin cache over the server map. It exposes synchronous
 * query helpers (used widely in render paths like `CharacterRow`) plus async
 * mutations that hit the server and refresh the cache.
 *
 * Anything not tracked in the server map defaults to `visibility: 'personal'`
 * with no owner. The GLOBAL vs PERSONAL badge in the UI reflects the server's
 * authoritative state — if it says global, the file physically lives in the
 * shared directory and every user will see it.
 */

export interface OwnershipEntry {
  ownerHandle: string;
  visibility: 'global' | 'personal';
  // Only populated when the caller is an admin/owner. Lists other users
  // who have a copy of this same-named card; used to render an "also
  // owned by X" hint in Character Management.
  otherOwners?: string[];
}

export interface CharacterOwnershipState {
  ownershipMap: Record<string, OwnershipEntry>;
  isLoading: boolean;
  error: string | null;

  // Fetch the current map from the server. Idempotent — safe to call on every
  // character refresh.
  fetchOwnership: () => Promise<void>;

  // Mutations — these hit the server. On success the cache is updated in
  // place; on failure the error field is set and the cache is left alone.
  setVisibility: (avatar: string, visibility: 'global' | 'personal') => Promise<void>;
  transferOwnership: (avatar: string, newOwnerHandle: string) => Promise<void>;

  // Queries — synchronous against the in-memory cache.
  getOwner: (avatar: string) => string | null;
  getVisibility: (avatar: string) => 'global' | 'personal';
  isOwnedBy: (avatar: string, handle: string) => boolean;
  getOtherOwners: (avatar: string) => string[];

  // Permission helpers
  canEditCharacter: (avatar: string, userHandle: string, userRole: UserRole | undefined) => boolean;
  canDeleteCharacter: (avatar: string, userHandle: string, userRole: UserRole | undefined) => boolean;
}

function toOwnershipMap(serverMap: CharacterMetadataMap): Record<string, OwnershipEntry> {
  const result: Record<string, OwnershipEntry> = {};
  for (const [avatar, entry] of Object.entries(serverMap)) {
    if (!entry || typeof entry !== 'object') continue;
    const out: OwnershipEntry = {
      ownerHandle: entry.ownerHandle,
      visibility: entry.visibility === 'global' ? 'global' : 'personal',
    };
    if (Array.isArray(entry.otherOwners) && entry.otherOwners.length > 0) {
      out.otherOwners = entry.otherOwners;
    }
    result[avatar] = out;
  }
  return result;
}

export const useCharacterOwnershipStore = create<CharacterOwnershipState>((set, get) => ({
  ownershipMap: {},
  isLoading: false,
  error: null,

  fetchOwnership: async () => {
    set({ isLoading: true, error: null });
    try {
      const serverMap = await api.getCharacterMetadata();
      set({ ownershipMap: toOwnershipMap(serverMap), isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load character ownership',
      });
    }
  },

  setVisibility: async (avatar, visibility) => {
    set({ error: null });
    try {
      await api.setCharacterVisibility(avatar, visibility);
      // Refetch the map so we pick up the server's authoritative state
      // (owner handle, claimedAt, and any file-move side effects).
      await get().fetchOwnership();
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to update visibility',
      });
      throw err;
    }
  },

  transferOwnership: async (avatar, newOwnerHandle) => {
    set({ error: null });
    try {
      await api.transferCharacterOwnership(avatar, newOwnerHandle);
      await get().fetchOwnership();
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to transfer ownership',
      });
      throw err;
    }
  },

  getOwner: (avatar) => {
    return get().ownershipMap[avatar]?.ownerHandle ?? null;
  },

  getVisibility: (avatar) => {
    return get().ownershipMap[avatar]?.visibility ?? 'personal';
  },

  isOwnedBy: (avatar, handle) => {
    return get().ownershipMap[avatar]?.ownerHandle === handle;
  },

  getOtherOwners: (avatar) => {
    return get().ownershipMap[avatar]?.otherOwners ?? [];
  },

  canEditCharacter: (avatar, userHandle, userRole) => {
    if (userRole === 'owner') return true;
    const entry = get().ownershipMap[avatar];
    // B1 — every character row is owned by the user who has it in their
    // list (the DB FK enforces this), so an empty metadata entry means
    // the requesting user IS the owner. Previously this returned false
    // and relied on the server check, but with the new /characters API
    // the row simply wouldn't be visible to a non-owner in the first
    // place; mirror that in the UI so the edit button isn't hidden.
    if (!entry) return true;
    return entry.ownerHandle === userHandle;
  },

  canDeleteCharacter: (avatar, userHandle, userRole) => {
    if (userRole === 'owner') return true;
    const entry = get().ownershipMap[avatar];
    // No metadata entry → personal character never pushed to global; the
    // requesting user is its only possible owner, so allow deletion.
    if (!entry) return true;
    return entry.ownerHandle === userHandle;
  },
}));
