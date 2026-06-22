import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';

let _currentHandle: string | null = null;

const scopedLocalStorage = {
  getItem: (name: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    return localStorage.getItem(key);
  },
  setItem: (name: string, value: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    localStorage.setItem(key, value);
  },
  removeItem: (name: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    localStorage.removeItem(key);
  },
};

// ---------------------------------------------------------------------------
// Server sync (mirrors displayPreferencesStore)
//
// The summarization settings (auto toggle, frequency, injection depth/role,
// compaction) follow the user across devices via the `stm_summarize` settings
// section. The per-chat `summaries` cache is NOT synced — it's potentially
// large per-chat data tied to local chat files.
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_summarize';

function localTsKey(): string {
  return _currentHandle
    ? `stm:summarize-local-ts_${_currentHandle}`
    : 'stm:summarize-local-ts';
}

function markLocalDirty(): void {
  try { markSectionDirty(localTsKey()); } catch { /* ignore */ }
}

async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const section = (settings[SERVER_KEY] as Record<string, unknown>) || {};
  Object.assign(section, patch);
  await patchServerKey(SERVER_KEY, section, localTsKey());
}

export interface ChatSummary {
  text: string;
  generatedAt: number;
  /** Number of non-system messages when this summary was generated. */
  messageCount: number;
}

interface SummarizeState {
  // --- persisted settings ---
  autoSummarize: boolean;
  /** Trigger a new summary every N non-system messages since the last summary. */
  autoTriggerEvery: number;
  /** Depth from the END of history to inject the summary (999 = before all history). */
  injectionDepth: number;
  injectionRole: 'system' | 'user';
  /**
   * When true, drop messages already covered by the summary from the prompt
   * history. Saves tokens by keeping ONLY the summary + post-summary turns,
   * instead of duplicating coverage between summary and raw history.
   */
  compactWhenSummarized: boolean;

  // --- persisted data ---
  /** Keyed by chat file name (e.g. "character_2024-01-01@12:00:00.jsonl"). */
  summaries: Record<string, ChatSummary>;

  // --- session state ---
  isGenerating: boolean;
  error: string | null;

  // --- actions ---
  setAutoSummarize: (on: boolean) => void;
  setAutoTriggerEvery: (n: number) => void;
  setInjectionDepth: (d: number) => void;
  setInjectionRole: (r: 'system' | 'user') => void;
  setCompactWhenSummarized: (on: boolean) => void;
  /** Pull settings from the server after login and reconcile with local. */
  fetchPrefs: () => Promise<void>;
  getSummary: (chatFile: string) => ChatSummary | null;
  clearSummary: (chatFile: string) => void;
  clearError: () => void;
  initForUser: (handle: string) => void;
  resetUser: () => void;
  generateSummary: (
    chatMessages: { name: string; isUser: boolean; isSystem: boolean; content: string }[],
    chatFile: string,
    characterName: string
  ) => Promise<void>;
}

async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const content =
              json.choices?.[0]?.delta?.content ||
              json.choices?.[0]?.text ||
              json.delta?.text ||
              (json.type === 'content_block_delta' ? json.delta?.text : null) ||
              json.content ||
              json.message?.content?.[0]?.text ||
              '';
            if (content) yield content;
          } catch {
            if (data.length > 0 && data !== 'undefined') yield data;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const useSummarizeStore = create<SummarizeState>()(
  persist(
    (set, get) => ({
      autoSummarize: false,
      autoTriggerEvery: 20,
      injectionDepth: 999,
      injectionRole: 'system',
      compactWhenSummarized: true,
      summaries: {},
      isGenerating: false,
      error: null,

      setAutoSummarize: (on) => {
        set({ autoSummarize: on });
        markLocalDirty();
        patchServer({ autoSummarize: on }).catch(() => {});
      },
      setAutoTriggerEvery: (n) => {
        const autoTriggerEvery = Math.max(5, Math.min(100, Math.round(n)));
        set({ autoTriggerEvery });
        markLocalDirty();
        patchServer({ autoTriggerEvery }).catch(() => {});
      },
      setInjectionDepth: (d) => {
        const injectionDepth = Math.max(0, Math.round(d));
        set({ injectionDepth });
        markLocalDirty();
        patchServer({ injectionDepth }).catch(() => {});
      },
      setInjectionRole: (r) => {
        set({ injectionRole: r });
        markLocalDirty();
        patchServer({ injectionRole: r }).catch(() => {});
      },
      setCompactWhenSummarized: (on) => {
        set({ compactWhenSummarized: on });
        markLocalDirty();
        patchServer({ compactWhenSummarized: on }).catch(() => {});
      },

      fetchPrefs: async () => {
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as Record<string, unknown> | undefined;
          const serverTs = Number(section?._ts || 0);

          if (shouldReuploadSection(localTsKey(), serverTs)) {
            const s = get();
            patchServer({
              autoSummarize: s.autoSummarize,
              autoTriggerEvery: s.autoTriggerEvery,
              injectionDepth: s.injectionDepth,
              injectionRole: s.injectionRole,
              compactWhenSummarized: s.compactWhenSummarized,
            }).catch(() => {});
            return;
          }

          if (!section) return;

          const cur = get();
          const autoSummarize = typeof section.autoSummarize === 'boolean' ? section.autoSummarize : cur.autoSummarize;
          const autoTriggerEvery = typeof section.autoTriggerEvery === 'number'
            ? Math.max(5, Math.min(100, Math.round(section.autoTriggerEvery)))
            : cur.autoTriggerEvery;
          const injectionDepth = typeof section.injectionDepth === 'number'
            ? Math.max(0, Math.round(section.injectionDepth))
            : cur.injectionDepth;
          const injectionRole = section.injectionRole === 'system' || section.injectionRole === 'user'
            ? section.injectionRole
            : cur.injectionRole;
          const compactWhenSummarized = typeof section.compactWhenSummarized === 'boolean'
            ? section.compactWhenSummarized
            : cur.compactWhenSummarized;

          try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
          set({ autoSummarize, autoTriggerEvery, injectionDepth, injectionRole, compactWhenSummarized });
        } catch { /* non-fatal — localStorage values remain active */ }
      },

      getSummary: (chatFile) => get().summaries[chatFile] ?? null,

      clearSummary: (chatFile) =>
        set((s) => {
          const { [chatFile]: _removed, ...rest } = s.summaries;
          return { summaries: rest };
        }),

      clearError: () => set({ error: null }),

      initForUser: (handle) => {
        _currentHandle = handle;
        useSummarizeStore.persist.rehydrate();
      },
      resetUser: () => {
        _currentHandle = null;
        set({ autoSummarize: false, autoTriggerEvery: 20, injectionDepth: 999, injectionRole: 'system', compactWhenSummarized: true, summaries: {}, error: null });
      },

      generateSummary: async (chatMessages, chatFile, characterName) => {
        if (get().isGenerating) return;
        set({ isGenerating: true, error: null });

        try {
          const { activeProvider, activeModel } = useSettingsStore.getState();

          // Use the last 40 non-system messages for the transcript
          const sample = chatMessages
            .filter((m) => !m.isSystem)
            .slice(-40);

          if (sample.length === 0) {
            set({ isGenerating: false });
            return;
          }

          const transcript = sample
            .map((m) => `${m.isUser ? 'User' : characterName}: ${m.content}`)
            .join('\n');

          const context: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
            {
              role: 'system',
              content: `You are a concise summarizer. Produce a 2-4 sentence summary of the following roleplay/chat conversation between the user and ${characterName}. Focus on key events, emotional beats, and story progression. Write in third person, past tense. Do not add commentary or analysis beyond the summary itself.`,
            },
            {
              role: 'user',
              content: `Summarize this conversation:\n\n${transcript}`,
            },
          ];

          const stream = await api.generateMessage(
            context,
            characterName,
            activeProvider,
            activeModel,
          );

          if (!stream) {
            set({ isGenerating: false, error: 'No response from API' });
            return;
          }

          let text = '';
          for await (const token of parseSSEStream(stream)) {
            text += token;
          }
          text = text.trim();

          if (text) {
            const messageCount = chatMessages.filter((m) => !m.isSystem).length;
            set((s) => ({
              summaries: {
                ...s.summaries,
                [chatFile]: { text, generatedAt: Date.now(), messageCount },
              },
            }));
          }
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Summarization failed' });
        } finally {
          set({ isGenerating: false });
        }
      },
    }),
    {
      name: 'st-mobile-summarize',
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (s) => ({
        autoSummarize: s.autoSummarize,
        autoTriggerEvery: s.autoTriggerEvery,
        injectionDepth: s.injectionDepth,
        injectionRole: s.injectionRole,
        compactWhenSummarized: s.compactWhenSummarized,
        summaries: s.summaries,
      }),
    }
  )
);
