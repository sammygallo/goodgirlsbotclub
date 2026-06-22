/**
 * Phase 8.4 — Connection Profiles
 *
 * A profile is a snapshot of the complete API configuration:
 *   provider + model + customUrl + sampler params
 *
 * Profiles are stored in localStorage under `stm:connection-profiles`.
 * Switching a profile writes directly into settingsStore + generationStore
 * so the rest of the app picks it up immediately.
 */

import { create } from 'zustand';
import type { SamplerParams } from './generationStore';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';

export interface ConnectionProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Only set when provider === 'custom'. */
  customUrl?: string;
  sampler: SamplerParams;
  createdAt: number;
}

interface ConnectionProfileState {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;

  /** Fetch from server after login and apply. No-op if no server data yet. */
  fetchPrefs: () => Promise<void>;

  // Actions
  saveProfile: (
    name: string,
    provider: string,
    model: string,
    customUrl: string,
    sampler: SamplerParams
  ) => void;
  deleteProfile: (id: string) => void;
  renameProfile: (id: string, name: string) => void;
  /** Returns the profile, so the caller can apply provider/model/sampler. */
  getProfile: (id: string) => ConnectionProfile | null;
  setActiveProfileId: (id: string | null) => void;
}

const STORAGE_KEY = 'stm:connection-profiles';
const SERVER_KEY = 'stm_connection_profiles';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

function markLocalDirty(): void {
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
}

function syncToServer(profiles: ConnectionProfile[], activeProfileId: string | null): void {
  markLocalDirty();
  patchServerKey(SERVER_KEY, { profiles, activeProfileId }, LOCAL_TS_KEY).catch(() => {});
}

interface PersistedShape {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
}

function load(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedShape;
  } catch { /* ignore */ }
  return { profiles: [], activeProfileId: null };
}

function save(state: PersistedShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

const initial = load();

export const useConnectionProfileStore = create<ConnectionProfileState>((set, get) => ({
  profiles: initial.profiles,
  activeProfileId: initial.activeProfileId,

  saveProfile: (name, provider, model, customUrl, sampler) => {
    const profile: ConnectionProfile = {
      id: `profile_${Date.now()}`,
      name: name.trim() || `Profile ${get().profiles.length + 1}`,
      provider,
      model,
      customUrl: provider === 'custom' ? customUrl : undefined,
      sampler,
      createdAt: Date.now(),
    };
    const profiles = [...get().profiles, profile];
    save({ profiles, activeProfileId: profile.id });
    set({ profiles, activeProfileId: profile.id });
    syncToServer(profiles, profile.id);
  },

  deleteProfile: (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id);
    const activeProfileId = get().activeProfileId === id ? null : get().activeProfileId;
    save({ profiles, activeProfileId });
    set({ profiles, activeProfileId });
    syncToServer(profiles, activeProfileId);
  },

  renameProfile: (id, name) => {
    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, name: name.trim() || p.name } : p
    );
    save({ profiles, activeProfileId: get().activeProfileId });
    set({ profiles });
    syncToServer(profiles, get().activeProfileId);
  },

  getProfile: (id) => get().profiles.find((p) => p.id === id) ?? null,

  setActiveProfileId: (id) => {
    save({ profiles: get().profiles, activeProfileId: id });
    set({ activeProfileId: id });
    syncToServer(get().profiles, id);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as Record<string, unknown> | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        syncToServer(get().profiles, get().activeProfileId);
        return;
      }

      if (!stored) return;

      const profiles = (stored.profiles as ConnectionProfile[] | undefined) ?? [];
      const activeProfileId = (stored.activeProfileId as string | null) ?? null;

      save({ profiles, activeProfileId });
      try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
      set({ profiles, activeProfileId });
    } catch { /* non-fatal */ }
  },
}));
