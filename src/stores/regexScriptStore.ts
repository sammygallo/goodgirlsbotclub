import { create } from 'zustand';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';

/** Phase 8.2: Regex Scripts — find/replace patterns applied to AI output,
 *  user input, or both. Scripts can be display-only (render transform only)
 *  or permanent (modifies stored text). Per-character scoping supported. */
export interface RegexScript {
  id: string;
  name: string;
  /** Raw regex pattern string (not wrapped in slashes). */
  pattern: string;
  /** Replacement text. Supports $1, $2 capture group references. */
  replacement: string;
  /** Standard JS regex flags (g, i, m, s). */
  flags: string;
  enabled: boolean;
  scope: RegexScope;
  /** true = transform rendered text only, original stored unchanged. */
  displayOnly: boolean;
  /** Character avatars this script applies to. Empty = global (all). */
  characterScope: string[];
  /** Execution order — lower values run first. */
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type RegexScope = 'ai_output' | 'user_input' | 'both';

const STORAGE_KEY = 'sillytavern_regex_scripts';
const SERVER_KEY = 'stm_regex_scripts';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(scripts: RegexScript[]): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      { scripts } as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
}

function generateId(): string {
  return `rs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadFromStorage(): RegexScript[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveToStorage(scripts: RegexScript[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
  } catch {
    console.error('[RegexScripts] Failed to save to localStorage');
  }
  schedulePersist(scripts);
}

interface RegexScriptState {
  scripts: RegexScript[];

  createScript: (partial?: Partial<RegexScript>) => string;
  updateScript: (id: string, partial: Partial<RegexScript>) => void;
  deleteScript: (id: string) => void;
  duplicateScript: (id: string) => string | null;
  toggleScript: (id: string) => void;

  importScripts: (json: string) => number;
  exportScripts: () => string;

  /** A3.1c — pull /sync/section/stm_regex_scripts and reconcile. */
  fetchPrefs: () => Promise<void>;
}

export const useRegexScriptStore = create<RegexScriptState>((set, get) => ({
  scripts: loadFromStorage(),

  createScript: (partial) => {
    const now = Date.now();
    const { scripts } = get();
    const maxOrder = scripts.reduce((max, s) => Math.max(max, s.order), -1);
    const script: RegexScript = {
      id: generateId(),
      name: partial?.name || 'New Script',
      pattern: partial?.pattern || '',
      replacement: partial?.replacement ?? '',
      flags: partial?.flags || 'g',
      enabled: partial?.enabled ?? true,
      scope: partial?.scope || 'ai_output',
      displayOnly: partial?.displayOnly ?? false,
      characterScope: partial?.characterScope || [],
      order: partial?.order ?? maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    };
    const updated = [...scripts, script];
    saveToStorage(updated);
    set({ scripts: updated });
    return script.id;
  },

  updateScript: (id, partial) => {
    const { scripts } = get();
    const updated = scripts.map((s) =>
      s.id === id ? { ...s, ...partial, updatedAt: Date.now() } : s
    );
    saveToStorage(updated);
    set({ scripts: updated });
  },

  deleteScript: (id) => {
    const { scripts } = get();
    const updated = scripts.filter((s) => s.id !== id);
    saveToStorage(updated);
    set({ scripts: updated });
  },

  duplicateScript: (id) => {
    const { scripts } = get();
    const source = scripts.find((s) => s.id === id);
    if (!source) return null;
    const now = Date.now();
    const maxOrder = scripts.reduce((max, s) => Math.max(max, s.order), -1);
    const copy: RegexScript = {
      ...source,
      id: generateId(),
      name: `${source.name} (copy)`,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    };
    const updated = [...scripts, copy];
    saveToStorage(updated);
    set({ scripts: updated });
    return copy.id;
  },

  toggleScript: (id) => {
    const { scripts } = get();
    const updated = scripts.map((s) =>
      s.id === id ? { ...s, enabled: !s.enabled, updatedAt: Date.now() } : s
    );
    saveToStorage(updated);
    set({ scripts: updated });
  },

  importScripts: (json: string) => {
    try {
      const parsed = JSON.parse(json);
      const arr: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.scripts)
          ? parsed.scripts
          : [];
      if (arr.length === 0) return 0;

      const { scripts } = get();
      let maxOrder = scripts.reduce((max, s) => Math.max(max, s.order), -1);
      const now = Date.now();
      const imported: RegexScript[] = [];

      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.pattern !== 'string' || !r.pattern.trim()) continue;

        imported.push({
          id: generateId(),
          name: typeof r.name === 'string' ? r.name : 'Imported Script',
          pattern: r.pattern as string,
          replacement: typeof r.replacement === 'string' ? r.replacement : '',
          flags: typeof r.flags === 'string' ? r.flags : 'g',
          enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
          scope: (['ai_output', 'user_input', 'both'].includes(r.scope as string)
            ? r.scope as RegexScope
            : 'ai_output'),
          displayOnly: typeof r.displayOnly === 'boolean' ? r.displayOnly : false,
          characterScope: Array.isArray(r.characterScope)
            ? (r.characterScope as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
          order: ++maxOrder,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (imported.length === 0) return 0;
      const updated = [...scripts, ...imported];
      saveToStorage(updated);
      set({ scripts: updated });
      return imported.length;
    } catch {
      return 0;
    }
  },

  exportScripts: () => {
    const { scripts } = get();
    return JSON.stringify({ scripts }, null, 2);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | { scripts?: RegexScript[]; _ts?: number }
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        _persistEnabled = true;
        const scripts = get().scripts;
        if (scripts.length > 0) {
          patchServerKey(
            SERVER_KEY,
            { scripts } as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          { scripts: get().scripts } as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      _persistEnabled = false;
      const scripts = Array.isArray(stored.scripts) ? stored.scripts : [];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
        recordServerTs(LOCAL_TS_KEY, serverTs);
      } catch { /* ignore */ }
      set({ scripts });
      _persistEnabled = true;
    } catch {
      _persistEnabled = true;
    }
  },
}));
