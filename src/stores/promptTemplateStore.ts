import { create } from 'zustand';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';
import {
  useGenerationStore,
  DEFAULT_PROMPT_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_INSTRUCT_CONFIG,
  DEFAULT_SAMPLER,
  mergePromptOrder,
  type PromptConfig,
  type ContextConfig,
  type InstructConfig,
  type SamplerParams,
  type PromptSectionEntry,
} from './generationStore';

/**
 * Phase 9.2 — Prompt Templates & Presets.
 *
 * A PromptTemplate bundles an entire generation-side configuration so users
 * can save, load, export, and share a full "persona setup" — not just
 * samplers (which existing GenerationPreset already covers).
 */
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: PromptConfig;
  context: ContextConfig;
  instruct: InstructConfig;
  promptOrder: PromptSectionEntry[];
  /** Optional — only set when user opts in to "include samplers" on save. */
  sampler?: SamplerParams;
  createdAt: number;
}

interface PromptTemplateState {
  templates: PromptTemplate[];
  activeTemplateId: string | null;
  /** Per-character linked template, keyed by avatar filename. Loaded
   *  transiently on chat enter and restored on switch-away. */
  linkedTemplateByAvatar: Record<string, string>;
  /**
   * Snapshot of the user's mainPrompt when a transient (character-linked)
   * template was loaded. Restored on exit so per-character links don't
   * silently overwrite global settings.
   */
  mainPromptSnapshot: string | null;

  saveTemplate: (name: string, includeSampler: boolean) => void;
  /** Save a template with an explicit mainPrompt, leaving all other generation
   *  settings at their current values. Used by the HYPERCODE builder. */
  saveTemplateWithPrompt: (name: string, mainPrompt: string) => void;
  /** Save a template with explicit mainPrompt and link it to a character avatar.
   *  Returns the new template id. */
  saveTemplateWithPromptAndLink: (name: string, mainPrompt: string, avatar: string) => string;
  loadTemplate: (id: string) => void;
  /**
   * Apply just the mainPrompt portion of a template, snapshotting the
   * current mainPrompt so it can be restored. Does NOT touch context,
   * instruct, or promptOrder — those stay at the user's global settings.
   * Used for character-linked auto-load.
   */
  loadTemplateMainPromptTransient: (id: string) => void;
  /** Restore the snapshotted mainPrompt and clear the snapshot. */
  restoreDefaultMainPrompt: () => void;
  deleteTemplate: (id: string) => void;
  renameTemplate: (id: string, name: string) => void;
  /** Link an existing template to a character (or unlink with null). */
  setLinkedTemplate: (avatar: string, templateId: string | null) => void;
  importTemplates: (json: string) => { imported: number; errors: number };
  exportTemplates: () => string;
  exportTemplate: (id: string) => string | null;

  /** A3.1c — pull /sync/section/stm_prompt_templates and reconcile. */
  fetchPrefs: () => Promise<void>;
}

const STORAGE_KEY = 'stm:prompt-templates';
const SERVER_KEY = 'stm_prompt_templates';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(state: PersistedShape): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      state as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
}

interface PersistedShape {
  templates: PromptTemplate[];
  activeTemplateId: string | null;
  linkedTemplateByAvatar?: Record<string, string>;
  /** Persisted so a mid-chat refresh doesn't lose the user's original
   *  mainPrompt. If the page reloads while a transient template is active,
   *  the snapshot survives and gets restored on switch-away. */
  mainPromptSnapshot?: string | null;
}

function loadFromStorage(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { templates: [], activeTemplateId: null };
    const parsed = JSON.parse(raw) as PersistedShape;
    return {
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      activeTemplateId:
        typeof parsed.activeTemplateId === 'string' ? parsed.activeTemplateId : null,
      linkedTemplateByAvatar:
        parsed.linkedTemplateByAvatar &&
        typeof parsed.linkedTemplateByAvatar === 'object' &&
        !Array.isArray(parsed.linkedTemplateByAvatar)
          ? (parsed.linkedTemplateByAvatar as Record<string, string>)
          : {},
      mainPromptSnapshot:
        typeof parsed.mainPromptSnapshot === 'string' ? parsed.mainPromptSnapshot : null,
    };
  } catch {
    return { templates: [], activeTemplateId: null };
  }
}

/**
 * Persist state, merging with any existing fields in storage. This means
 * actions that only care about a subset of the persisted shape (e.g.
 * `renameTemplate` doesn't touch the mainPromptSnapshot) won't accidentally
 * drop fields they didn't pass.
 */
function saveToStorage(state: PersistedShape) {
  let merged: PersistedShape = state;
  try {
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    const existing: Partial<PersistedShape> = existingRaw ? JSON.parse(existingRaw) : {};
    merged = { ...existing, ...state };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore quota / parse errors
  }
  schedulePersist(merged);
}

function generateId(): string {
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function coerceTemplate(raw: unknown): PromptTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  if (!r.prompt || typeof r.prompt !== 'object') return null;
  const prompt = { ...DEFAULT_PROMPT_CONFIG, ...(r.prompt as Partial<PromptConfig>) };
  const context = { ...DEFAULT_CONTEXT_CONFIG, ...((r.context as Partial<ContextConfig>) ?? {}) };
  const instruct = {
    ...DEFAULT_INSTRUCT_CONFIG,
    ...((r.instruct as Partial<InstructConfig>) ?? {}),
  };
  const promptOrder = mergePromptOrder(
    Array.isArray(r.promptOrder) ? (r.promptOrder as PromptSectionEntry[]) : undefined
  );
  const sampler =
    r.sampler && typeof r.sampler === 'object'
      ? { ...DEFAULT_SAMPLER, ...(r.sampler as Partial<SamplerParams>) }
      : undefined;
  return {
    id: generateId(),
    name: r.name.trim(),
    prompt,
    context,
    instruct,
    promptOrder,
    sampler,
    createdAt: Date.now(),
  };
}

const initial = loadFromStorage();

export const usePromptTemplateStore = create<PromptTemplateState>((set, get) => ({
  templates: initial.templates,
  activeTemplateId: initial.activeTemplateId,
  linkedTemplateByAvatar: initial.linkedTemplateByAvatar ?? {},
  mainPromptSnapshot: initial.mainPromptSnapshot ?? null,

  saveTemplateWithPrompt: (name, mainPrompt) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const gen = useGenerationStore.getState();
    const template: PromptTemplate = {
      id: generateId(),
      name: trimmed,
      prompt: { ...gen.prompt, mainPrompt },
      context: { ...gen.context },
      instruct: { ...gen.instruct },
      promptOrder: gen.promptOrder.map((e) => ({ ...e })),
      createdAt: Date.now(),
    };
    const { templates, linkedTemplateByAvatar } = get();
    const nextTemplates = [...templates, template];
    saveToStorage({ templates: nextTemplates, activeTemplateId: template.id, linkedTemplateByAvatar });
    set({ templates: nextTemplates, activeTemplateId: template.id });
  },

  saveTemplateWithPromptAndLink: (name, mainPrompt, avatar) => {
    const trimmed = name.trim() || 'Linked Template';
    const gen = useGenerationStore.getState();
    const template: PromptTemplate = {
      id: generateId(),
      name: trimmed,
      prompt: { ...gen.prompt, mainPrompt },
      context: { ...gen.context },
      instruct: { ...gen.instruct },
      promptOrder: gen.promptOrder.map((e) => ({ ...e })),
      createdAt: Date.now(),
    };
    const { templates, linkedTemplateByAvatar } = get();
    const nextTemplates = [...templates, template];
    const nextLinks = { ...linkedTemplateByAvatar, [avatar]: template.id };
    saveToStorage({
      templates: nextTemplates,
      activeTemplateId: template.id,
      linkedTemplateByAvatar: nextLinks,
    });
    set({
      templates: nextTemplates,
      activeTemplateId: template.id,
      linkedTemplateByAvatar: nextLinks,
    });
    return template.id;
  },

  saveTemplate: (name, includeSampler) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const gen = useGenerationStore.getState();
    const template: PromptTemplate = {
      id: generateId(),
      name: trimmed,
      prompt: { ...gen.prompt },
      context: { ...gen.context },
      instruct: { ...gen.instruct },
      promptOrder: gen.promptOrder.map((e) => ({ ...e })),
      sampler: includeSampler ? { ...gen.sampler } : undefined,
      createdAt: Date.now(),
    };
    const { templates, linkedTemplateByAvatar } = get();
    const nextTemplates = [...templates, template];
    saveToStorage({ templates: nextTemplates, activeTemplateId: template.id, linkedTemplateByAvatar });
    set({ templates: nextTemplates, activeTemplateId: template.id });
  },

  loadTemplate: (id) => {
    const { templates, linkedTemplateByAvatar } = get();
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    const gen = useGenerationStore.getState();
    gen.setPrompt(template.prompt);
    gen.setContext(template.context);
    gen.setInstruct(template.instruct);
    gen.setPromptOrder(template.promptOrder);
    if (template.sampler) {
      gen.setSampler(template.sampler);
    }
    saveToStorage({ templates, activeTemplateId: template.id, linkedTemplateByAvatar });
    set({ activeTemplateId: template.id });
  },

  loadTemplateMainPromptTransient: (id) => {
    const state = get();
    const template = state.templates.find((t) => t.id === id);
    if (!template) return;
    const gen = useGenerationStore.getState();
    // Only snapshot once — repeated transient loads from the same default
    // shouldn't clobber the original. The snapshot is persisted so a
    // mid-chat refresh can't silently turn the linked prompt into the new
    // "default" on next restore.
    let snapshot = state.mainPromptSnapshot;
    if (snapshot === null) {
      snapshot = gen.prompt.mainPrompt;
    }
    gen.setPrompt({ mainPrompt: template.prompt.mainPrompt });
    saveToStorage({
      templates: state.templates,
      activeTemplateId: template.id,
      linkedTemplateByAvatar: state.linkedTemplateByAvatar,
      mainPromptSnapshot: snapshot,
    });
    set({ activeTemplateId: template.id, mainPromptSnapshot: snapshot });
  },

  restoreDefaultMainPrompt: () => {
    const state = get();
    if (state.mainPromptSnapshot === null) return;
    const gen = useGenerationStore.getState();
    gen.setPrompt({ mainPrompt: state.mainPromptSnapshot });
    saveToStorage({
      templates: state.templates,
      activeTemplateId: null,
      linkedTemplateByAvatar: state.linkedTemplateByAvatar,
      mainPromptSnapshot: null,
    });
    set({ mainPromptSnapshot: null, activeTemplateId: null });
  },

  setLinkedTemplate: (avatar, templateId) => {
    set((state) => {
      const nextLinks = { ...state.linkedTemplateByAvatar };
      if (templateId === null) {
        delete nextLinks[avatar];
      } else {
        nextLinks[avatar] = templateId;
      }
      saveToStorage({
        templates: state.templates,
        activeTemplateId: state.activeTemplateId,
        linkedTemplateByAvatar: nextLinks,
      });
      return { linkedTemplateByAvatar: nextLinks };
    });
  },

  deleteTemplate: (id) => {
    const { templates, activeTemplateId, linkedTemplateByAvatar } = get();
    const nextTemplates = templates.filter((t) => t.id !== id);
    const nextActive = activeTemplateId === id ? null : activeTemplateId;
    // Drop any character links that pointed at the deleted template.
    const nextLinks: Record<string, string> = {};
    for (const [avatar, templateId] of Object.entries(linkedTemplateByAvatar)) {
      if (templateId !== id) nextLinks[avatar] = templateId;
    }
    saveToStorage({
      templates: nextTemplates,
      activeTemplateId: nextActive,
      linkedTemplateByAvatar: nextLinks,
    });
    set({
      templates: nextTemplates,
      activeTemplateId: nextActive,
      linkedTemplateByAvatar: nextLinks,
    });
  },

  renameTemplate: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { templates, activeTemplateId, linkedTemplateByAvatar } = get();
    const nextTemplates = templates.map((t) =>
      t.id === id ? { ...t, name: trimmed } : t
    );
    saveToStorage({ templates: nextTemplates, activeTemplateId, linkedTemplateByAvatar });
    set({ templates: nextTemplates });
  },

  importTemplates: (json) => {
    let imported = 0;
    let errors = 0;
    try {
      const parsed = JSON.parse(json);
      const arr: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { templates?: unknown[] })?.templates)
          ? (parsed as { templates: unknown[] }).templates
          : [];

      if (arr.length === 0) return { imported: 0, errors: 0 };

      const { templates, activeTemplateId, linkedTemplateByAvatar } = get();
      const newTemplates: PromptTemplate[] = [];
      for (const raw of arr) {
        const t = coerceTemplate(raw);
        if (t) {
          newTemplates.push(t);
          imported++;
        } else {
          errors++;
        }
      }
      if (newTemplates.length === 0) return { imported: 0, errors };

      const nextTemplates = [...templates, ...newTemplates];
      saveToStorage({ templates: nextTemplates, activeTemplateId, linkedTemplateByAvatar });
      set({ templates: nextTemplates });
      return { imported, errors };
    } catch {
      return { imported: 0, errors: 1 };
    }
  },

  exportTemplates: () => {
    const { templates } = get();
    return JSON.stringify({ version: 1, templates }, null, 2);
  },

  exportTemplate: (id) => {
    const { templates } = get();
    const t = templates.find((x) => x.id === id);
    if (!t) return null;
    return JSON.stringify({ version: 1, templates: [t] }, null, 2);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (PersistedShape & { _ts?: number })
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        _persistEnabled = true;
        const s = get();
        const snapshot: PersistedShape = {
          templates: s.templates,
          activeTemplateId: s.activeTemplateId,
          linkedTemplateByAvatar: s.linkedTemplateByAvatar,
          mainPromptSnapshot: s.mainPromptSnapshot,
        };
        if (s.templates.length > 0 || Object.keys(s.linkedTemplateByAvatar).length > 0) {
          patchServerKey(
            SERVER_KEY,
            snapshot as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        const s = get();
        const snapshot: PersistedShape = {
          templates: s.templates,
          activeTemplateId: s.activeTemplateId,
          linkedTemplateByAvatar: s.linkedTemplateByAvatar,
          mainPromptSnapshot: s.mainPromptSnapshot,
        };
        patchServerKey(
          SERVER_KEY,
          snapshot as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      _persistEnabled = false;
      const templates = Array.isArray(stored.templates) ? stored.templates : [];
      const activeTemplateId =
        typeof stored.activeTemplateId === 'string' ? stored.activeTemplateId : null;
      const linkedTemplateByAvatar =
        stored.linkedTemplateByAvatar && typeof stored.linkedTemplateByAvatar === 'object'
          ? stored.linkedTemplateByAvatar
          : {};
      const mainPromptSnapshot =
        typeof stored.mainPromptSnapshot === 'string' ? stored.mainPromptSnapshot : null;
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ templates, activeTemplateId, linkedTemplateByAvatar, mainPromptSnapshot }),
        );
        recordServerTs(LOCAL_TS_KEY, serverTs);
      } catch { /* ignore */ }
      set({ templates, activeTemplateId, linkedTemplateByAvatar, mainPromptSnapshot });
      _persistEnabled = true;
    } catch {
      _persistEnabled = true;
    }
  },
}));
