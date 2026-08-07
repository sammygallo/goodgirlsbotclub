import { create } from 'zustand';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';
import { legacyIdRemapReady, resolveLegacyBookId } from './worldInfoStore';

// Where the persona description is injected in the prompt
export type PersonaDescriptionPosition =
  | 'in_prompt' // Included inline in the system prompt
  | 'before_char' // Inserted before character info
  | 'after_char' // Inserted after character info
  | 'at_depth'; // Inserted at a specific depth in the message history

export type PersonaDescriptionRole = 'system' | 'user' | 'assistant';

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatarDataUrl?: string; // base64-encoded data URL stored locally
  descriptionPosition: PersonaDescriptionPosition;
  descriptionDepth: number; // only used when position = 'at_depth'
  descriptionRole: PersonaDescriptionRole;
  isDefault?: boolean;
  /**
   * World info books to auto-activate whenever this persona is the active
   * one. Union'd with character-embedded + character-linked + chat-linked
   * books at scan time. Ids reference `WorldInfoBook.id`.
   */
  linkedBookIds?: string[];
  createdAt: number;
  updatedAt: number;
}

// Locks persona to a specific character (by avatar) or chat (by chat file name)
export interface PersonaLocks {
  byCharacter: Record<string, string>; // characterAvatar -> personaId
  byChat: Record<string, string>; // chatFileName -> personaId
}

const PERSONAS_KEY = 'sillytavern_personas_v2';
const ACTIVE_PERSONA_KEY = 'sillytavern_active_persona';
const PERSONA_LOCKS_KEY = 'sillytavern_persona_locks';

function loadPersonas(): Persona[] {
  try {
    const raw = localStorage.getItem(PERSONAS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePersonas(personas: Persona[]) {
  localStorage.setItem(PERSONAS_KEY, JSON.stringify(personas));
}

function loadActivePersonaId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PERSONA_KEY);
  } catch {
    return null;
  }
}

function saveActivePersonaId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_PERSONA_KEY, id);
  else localStorage.removeItem(ACTIVE_PERSONA_KEY);
}

function loadLocks(): PersonaLocks {
  try {
    const raw = localStorage.getItem(PERSONA_LOCKS_KEY);
    if (!raw) return { byCharacter: {}, byChat: {} };
    const parsed = JSON.parse(raw);
    return {
      byCharacter: parsed.byCharacter || {},
      byChat: parsed.byChat || {},
    };
  } catch {
    return { byCharacter: {}, byChat: {} };
  }
}

function saveLocks(locks: PersonaLocks) {
  localStorage.setItem(PERSONA_LOCKS_KEY, JSON.stringify(locks));
}

function generatePersonaId(): string {
  return `persona_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const SERVER_KEY = 'stm_personas';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

function markLocalDirty(): void {
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
}

// avatarDataUrl is a base64 blob — too large for the JSONB sync section. We
// strip it from the per-section sync and shuttle the bytes through the
// dedicated /blobs API instead (A3.2).
type PersonaForServer = Omit<Persona, 'avatarDataUrl'>;

function stripAvatar(p: Persona): PersonaForServer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { avatarDataUrl: _, ...rest } = p;
  return rest;
}

function syncToServer(personas: Persona[], activePersonaId: string | null, locks: PersonaLocks): void {
  markLocalDirty();
  patchServerKey(SERVER_KEY, {
    personas: personas.map(stripAvatar),
    activePersonaId,
    locks,
  }, LOCAL_TS_KEY).catch(() => {});
}

/**
 * Upload a persona's avatar bytes to /blobs/persona-avatar/{id}. Fire-and-
 * forget — failures are logged but never block the user; the data URL is
 * already in local state and localStorage at this point.
 */
function uploadAvatarBlob(personaId: string, avatarDataUrl: string | undefined): void {
  if (!avatarDataUrl) {
    // Drop the server-side blob if the user cleared their avatar locally.
    fetch(`/blobs/persona-avatar/${encodeURIComponent(personaId)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {});
    return;
  }
  const match = /^data:([^;]+);base64,(.+)$/.exec(avatarDataUrl);
  if (!match) return;
  const contentType = match[1];
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2]);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return;
  }
  fetch(`/blobs/persona-avatar/${encodeURIComponent(personaId)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': contentType },
    body: new Blob([bytes as BlobPart], { type: contentType }),
  }).catch(() => {});
}

/**
 * Fetch a persona's avatar from /blobs/persona-avatar/{id} and convert to a
 * data URL. Returns null if the blob doesn't exist or the request fails.
 */
async function fetchAvatarBlob(personaId: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `/blobs/persona-avatar/${encodeURIComponent(personaId)}`,
      { credentials: 'include' },
    );
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

interface PersonaState {
  personas: Persona[];
  activePersonaId: string | null;
  locks: PersonaLocks;
  error: string | null;

  // Queries
  getActivePersona: () => Persona | null;
  getPersonaForContext: (characterAvatar?: string, chatFileName?: string) => Persona | null;

  // CRUD
  createPersona: (
    data: Omit<Persona, 'id' | 'createdAt' | 'updatedAt'>
  ) => Persona;
  updatePersona: (
    id: string,
    data: Partial<Omit<Persona, 'id' | 'createdAt'>>
  ) => void;
  deletePersona: (id: string) => void;
  setActivePersona: (id: string | null) => void;
  setDefaultPersona: (id: string | null) => void;

  // Locking
  lockPersonaToCharacter: (personaId: string, characterAvatar: string) => void;
  unlockCharacter: (characterAvatar: string) => void;
  lockPersonaToChat: (personaId: string, chatFileName: string) => void;
  unlockChat: (chatFileName: string) => void;
  getCharacterLock: (characterAvatar: string) => string | null;
  getChatLock: (chatFileName: string) => string | null;

  clearError: () => void;

  /** Fetch from server after login and apply. No-op if no server data yet. */
  fetchPrefs: () => Promise<void>;

  /**
   * One-time-per-login remap of every Persona.linkedBookIds entry from a
   * pre-cutover local id to worldInfoStore's native-table id (see
   * resolveLegacyBookId there). PersonaForm only ever offers the viewer's
   * OWN books here (never a shared one), so this only needs the own-books
   * view — no dependency on sharedBooks having loaded. Synchronous and
   * idempotent: a second call once every id is already current is a true
   * no-op (no `set()`, no localStorage write, no server patch). Called
   * automatically from fetchPrefs once legacyIdRemapReady() resolves;
   * exposed directly so tests can invoke it without driving the full login
   * flow.
   */
  remapLinkedBookIds: () => void;
}

export const usePersonaStore = create<PersonaState>((set, get) => {
  const initialPersonas = loadPersonas();
  const initialActiveId = loadActivePersonaId();
  const initialLocks = loadLocks();

  // If there's a default persona and no active, set it as active
  let resolvedActiveId = initialActiveId;
  if (!resolvedActiveId) {
    const defaultPersona = initialPersonas.find((p) => p.isDefault);
    if (defaultPersona) {
      resolvedActiveId = defaultPersona.id;
    }
  }

  return {
    personas: initialPersonas,
    activePersonaId: resolvedActiveId,
    locks: initialLocks,
    error: null,

    getActivePersona: () => {
      const { personas, activePersonaId } = get();
      return personas.find((p) => p.id === activePersonaId) || null;
    },

    getPersonaForContext: (characterAvatar, chatFileName) => {
      const { personas, locks, activePersonaId } = get();

      // Chat lock wins over character lock
      if (chatFileName && locks.byChat[chatFileName]) {
        const locked = personas.find((p) => p.id === locks.byChat[chatFileName]);
        if (locked) return locked;
      }
      if (characterAvatar && locks.byCharacter[characterAvatar]) {
        const locked = personas.find((p) => p.id === locks.byCharacter[characterAvatar]);
        if (locked) return locked;
      }

      // Fall back to active persona
      return personas.find((p) => p.id === activePersonaId) || null;
    },

    createPersona: (data) => {
      const now = Date.now();
      const persona: Persona = {
        ...data,
        id: generatePersonaId(),
        createdAt: now,
        updatedAt: now,
      };

      const { personas } = get();

      // If isDefault, clear other defaults
      const updatedPersonas: Persona[] = persona.isDefault
        ? [...personas.map((p) => ({ ...p, isDefault: false })), persona]
        : [...personas, persona];

      savePersonas(updatedPersonas);
      set({ personas: updatedPersonas });

      let activeId = get().activePersonaId;
      if (personas.length === 0 || persona.isDefault) {
        saveActivePersonaId(persona.id);
        set({ activePersonaId: persona.id });
        activeId = persona.id;
      }
      syncToServer(updatedPersonas, activeId, get().locks);
      uploadAvatarBlob(persona.id, persona.avatarDataUrl);

      return persona;
    },

    updatePersona: (id, data) => {
      const { personas } = get();
      const previous = personas.find((p) => p.id === id);
      if (!previous) {
        set({ error: 'Persona not found' });
        return;
      }

      let updatedPersonas = personas.map((p) =>
        p.id === id ? { ...p, ...data, updatedAt: Date.now() } : p
      );

      // If setting isDefault = true, clear other defaults
      if (data.isDefault === true) {
        updatedPersonas = updatedPersonas.map((p) =>
          p.id === id ? p : { ...p, isDefault: false }
        );
      }

      savePersonas(updatedPersonas);
      set({ personas: updatedPersonas });
      syncToServer(updatedPersonas, get().activePersonaId, get().locks);

      // Push the avatar to /blobs only when it actually changed — keeps the
      // dev console quiet for unrelated edits (rename, description tweaks).
      if ('avatarDataUrl' in data && data.avatarDataUrl !== previous.avatarDataUrl) {
        uploadAvatarBlob(id, data.avatarDataUrl);
      }
    },

    deletePersona: (id) => {
      const { personas, activePersonaId, locks } = get();
      const updatedPersonas = personas.filter((p) => p.id !== id);
      savePersonas(updatedPersonas);
      uploadAvatarBlob(id, undefined); // also DELETE the blob on the server

      // Remove any locks that point to this persona
      const cleanedLocks: PersonaLocks = {
        byCharacter: Object.fromEntries(
          Object.entries(locks.byCharacter).filter(([, v]) => v !== id)
        ),
        byChat: Object.fromEntries(
          Object.entries(locks.byChat).filter(([, v]) => v !== id)
        ),
      };
      saveLocks(cleanedLocks);

      let newActiveId = activePersonaId;
      if (activePersonaId === id) {
        const defaultPersona = updatedPersonas.find((p) => p.isDefault);
        newActiveId = defaultPersona?.id || updatedPersonas[0]?.id || null;
        saveActivePersonaId(newActiveId);
      }

      set({ personas: updatedPersonas, locks: cleanedLocks, activePersonaId: newActiveId });
      syncToServer(updatedPersonas, newActiveId, cleanedLocks);
    },

    setActivePersona: (id) => {
      saveActivePersonaId(id);
      set({ activePersonaId: id });
      syncToServer(get().personas, id, get().locks);
    },

    setDefaultPersona: (id) => {
      const { personas } = get();
      const updatedPersonas = personas.map((p) => ({ ...p, isDefault: p.id === id }));
      savePersonas(updatedPersonas);
      set({ personas: updatedPersonas });
      syncToServer(updatedPersonas, get().activePersonaId, get().locks);
    },

    lockPersonaToCharacter: (personaId, characterAvatar) => {
      const { locks } = get();
      const updated: PersonaLocks = { ...locks, byCharacter: { ...locks.byCharacter, [characterAvatar]: personaId } };
      saveLocks(updated);
      set({ locks: updated });
      syncToServer(get().personas, get().activePersonaId, updated);
    },

    unlockCharacter: (characterAvatar) => {
      const { locks } = get();
      const newByCharacter = { ...locks.byCharacter };
      delete newByCharacter[characterAvatar];
      const updated: PersonaLocks = { ...locks, byCharacter: newByCharacter };
      saveLocks(updated);
      set({ locks: updated });
      syncToServer(get().personas, get().activePersonaId, updated);
    },

    lockPersonaToChat: (personaId, chatFileName) => {
      const { locks } = get();
      const updated: PersonaLocks = { ...locks, byChat: { ...locks.byChat, [chatFileName]: personaId } };
      saveLocks(updated);
      set({ locks: updated });
      syncToServer(get().personas, get().activePersonaId, updated);
    },

    unlockChat: (chatFileName) => {
      const { locks } = get();
      const newByChat = { ...locks.byChat };
      delete newByChat[chatFileName];
      const updated: PersonaLocks = { ...locks, byChat: newByChat };
      saveLocks(updated);
      set({ locks: updated });
      syncToServer(get().personas, get().activePersonaId, updated);
    },

    getCharacterLock: (characterAvatar) => {
      return get().locks.byCharacter[characterAvatar] || null;
    },

    getChatLock: (chatFileName) => {
      return get().locks.byChat[chatFileName] || null;
    },

    clearError: () => set({ error: null }),

    remapLinkedBookIds: () => {
      const { personas } = get();
      let anyChanged = false;
      const nextPersonas = personas.map((p) => {
        if (!p.linkedBookIds || p.linkedBookIds.length === 0) return p;
        const seen = new Set<string>();
        const nextIds: string[] = [];
        let changed = false;
        for (const id of p.linkedBookIds) {
          const resolved = resolveLegacyBookId(id);
          if (resolved === null) {
            console.warn(
              `[personaStore] dropping unresolvable linkedBookIds entry "${id}" from persona "${p.id}"`
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
        if (!changed) return p;
        anyChanged = true;
        return { ...p, linkedBookIds: nextIds, updatedAt: Date.now() };
      });

      if (!anyChanged) return; // true no-op: no set(), no persistence write
      savePersonas(nextPersonas);
      set({ personas: nextPersonas });
      syncToServer(nextPersonas, get().activePersonaId, get().locks);
    },

    fetchPrefs: async () => {
      try {
        const settings = await getSettingsBlob();
        const stored = settings[SERVER_KEY] as Record<string, unknown> | undefined;
        const serverTs = Number(stored?._ts || 0);

        if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
          const { personas, activePersonaId, locks } = get();
          syncToServer(personas, activePersonaId, locks);
        } else if (stored) {
          const serverPersonas = (stored.personas as PersonaForServer[] | undefined) ?? [];
          const serverActiveId = (stored.activePersonaId as string | null) ?? null;
          const serverLocks = (stored.locks as PersonaLocks | undefined) ?? { byCharacter: {}, byChat: {} };

          // Re-attach avatarDataUrls. Local cache wins for personas the user
          // has already loaded on this device; for others (e.g. just signed in
          // on a new device) fetch from /blobs/persona-avatar/{id}.
          const localAvatars: Record<string, string> = {};
          for (const p of get().personas) {
            if (p.avatarDataUrl) localAvatars[p.id] = p.avatarDataUrl;
          }
          const restoredPersonas: Persona[] = serverPersonas.map((p) => ({
            ...p,
            ...(localAvatars[p.id] ? { avatarDataUrl: localAvatars[p.id] } : {}),
          }));

          savePersonas(restoredPersonas);
          saveActivePersonaId(serverActiveId);
          saveLocks(serverLocks);
          try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
          set({ personas: restoredPersonas, activePersonaId: serverActiveId, locks: serverLocks });

          // Fire off /blobs fetches for the personas missing a local avatar.
          // These resolve asynchronously and patch into store state as they
          // complete — no UI blocking, no loading spinner.
          const missingAvatarIds = restoredPersonas
            .filter((p) => !p.avatarDataUrl)
            .map((p) => p.id);
          for (const id of missingAvatarIds) {
            fetchAvatarBlob(id)
              .then((dataUrl) => {
                if (!dataUrl) return;
                const next = get().personas.map((p) =>
                  p.id === id ? { ...p, avatarDataUrl: dataUrl } : p
                );
                savePersonas(next);
                set({ personas: next });
              })
              .catch(() => {});
          }
        }
        // else: no server state and no newer local — keep local as-is.
      } catch { /* non-fatal */ }

      // One-time-per-login legacy-id remap (see remapLinkedBookIds' own
      // docstring). Fired regardless of the branch above. Not awaited: no
      // caller needs it to finish before fetchPrefs itself resolves, and
      // legacyIdRemapReady() may not resolve until worldInfoStore's own
      // (separate, concurrent) fetchPrefs call finishes — every fetchPrefs
      // call across every store is already fire-and-forget from
      // authStore.ts, so this doesn't change that contract.
      legacyIdRemapReady()
        .then(() => get().remapLinkedBookIds())
        .catch(() => {});
    },
  };
});
