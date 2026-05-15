import { create } from 'zustand';
import { getSettingsBlob, makeLocalTsKey, patchServerKey } from '../utils/serverSettings';

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
  try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
}

// avatarDataUrl is a base64 blob — excluded from server sync (device-local).
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

      return persona;
    },

    updatePersona: (id, data) => {
      const { personas } = get();
      const exists = personas.some((p) => p.id === id);
      if (!exists) {
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
    },

    deletePersona: (id) => {
      const { personas, activePersonaId, locks } = get();
      const updatedPersonas = personas.filter((p) => p.id !== id);
      savePersonas(updatedPersonas);

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

    fetchPrefs: async () => {
      try {
        const settings = await getSettingsBlob();
        const stored = settings[SERVER_KEY] as Record<string, unknown> | undefined;
        const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
        const serverTs = Number(stored?._ts || 0);

        if (localTs > serverTs) {
          const { personas, activePersonaId, locks } = get();
          syncToServer(personas, activePersonaId, locks);
          return;
        }

        if (!stored) return;

        const serverPersonas = (stored.personas as PersonaForServer[] | undefined) ?? [];
        const serverActiveId = (stored.activePersonaId as string | null) ?? null;
        const serverLocks = (stored.locks as PersonaLocks | undefined) ?? { byCharacter: {}, byChat: {} };

        // Restore local avatarDataUrls for matching persona IDs.
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
        try { localStorage.setItem(LOCAL_TS_KEY, String(serverTs)); } catch { /* ignore */ }
        set({ personas: restoredPersonas, activePersonaId: serverActiveId, locks: serverLocks });
      } catch { /* non-fatal */ }
    },
  };
});
