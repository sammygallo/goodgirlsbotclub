/**
 * Auto-Memory — periodic LLM extraction of canonical facts from a chat,
 * appended to a per-character "auto-memory" lorebook.
 *
 * Why: lorebooks are great for keyword-triggered persistent memory, but
 * curating them by hand is tedious. This runs an extraction prompt every
 * N messages, dedupes against what's already in the book, and writes new
 * keyword-tagged entries automatically.
 *
 * Trigger lifecycle (mirrors summarize):
 *   1. ChatView watches message count; when (count - lastTriggered) crosses
 *      `triggerEvery`, calls `extractFacts(chatFile, character, messages)`.
 *   2. The store sends recent messages + currently-known entries to the LLM,
 *      asks for new canonical facts as JSON, and appends survivors as new
 *      entries on the character's auto-memory book (creating the book on
 *      first run via `createCharacterBook` + the `autoExtracted` flag).
 *
 * The extraction prompt uses the same active provider/model as chat
 * generation. There's no separate model setting — if the user changes
 * models, extractions follow.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '../api/client';
import { useSettingsStore } from './settingsStore';
import { useWorldInfoStore } from './worldInfoStore';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';
import type { CharacterInfo } from '../api/client';

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
// The on/off toggle and trigger frequency follow the user across devices via
// the `stm_auto_memory` settings section. `lastByChatFile` is intentionally
// NOT synced — it's per-chat trigger gating, and at worst a second device
// re-extracts one window (deduped against the book anyway).
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_auto_memory';

function localTsKey(): string {
  return _currentHandle
    ? `stm:auto-memory-local-ts_${_currentHandle}`
    : 'stm:auto-memory-local-ts';
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

interface AutoMemoryState {
  // --- persisted settings ---
  enabled: boolean;
  /** Trigger an extraction every N non-system messages since the last run. */
  triggerEvery: number;
  /**
   * Per-chat counter — message count at last successful extraction. Used
   * to gate the next trigger so the same window isn't extracted twice.
   */
  lastByChatFile: Record<string, number>;

  // --- session state ---
  isExtracting: boolean;
  error: string | null;

  // --- actions ---
  setEnabled: (on: boolean) => void;
  setTriggerEvery: (n: number) => void;
  /** Pull settings from the server after login and reconcile with local. */
  fetchPrefs: () => Promise<void>;
  shouldTrigger: (chatFile: string, currentNonSystemCount: number) => boolean;
  extractFacts: (
    chatFile: string,
    character: CharacterInfo,
    messages: { name: string; isUser: boolean; isSystem: boolean; content: string }[]
  ) => Promise<{ added: number }>;
  clearError: () => void;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

// Reuse the SSE parser from summarize — duplicated locally to avoid an
// awkward export from another store file. Both stores share the same
// generateMessage stream shape so the parser behavior is identical.
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

interface ExtractedFact {
  keys: string[];
  content: string;
}

function parseFactsFromResponse(text: string): ExtractedFact[] {
  // The LLM may wrap JSON in fences or add prose. Find the first JSON array.
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];
  try {
    const parsed = JSON.parse(arrayMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const rawKeys = Array.isArray(obj.keys)
        ? obj.keys.filter((k): k is string => typeof k === 'string')
        : typeof obj.keys === 'string'
          ? [obj.keys]
          : [];
      const content = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (rawKeys.length === 0 || !content) continue;
      out.push({
        keys: rawKeys.map((k) => k.trim()).filter(Boolean),
        content,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const AUTO_MEMORY_BOOK_SUFFIX = ' — Auto Memory';

export const useAutoMemoryStore = create<AutoMemoryState>()(
  persist(
    (set, get) => ({
      enabled: false,
      triggerEvery: 30,
      lastByChatFile: {},
      isExtracting: false,
      error: null,

      setEnabled: (on) => {
        set({ enabled: on });
        markLocalDirty();
        patchServer({ enabled: on }).catch(() => {});
      },
      setTriggerEvery: (n) => {
        const triggerEvery = Math.max(10, Math.min(200, Math.round(n)));
        set({ triggerEvery });
        markLocalDirty();
        patchServer({ triggerEvery }).catch(() => {});
      },

      fetchPrefs: async () => {
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as Record<string, unknown> | undefined;
          const serverTs = Number(section?._ts || 0);

          if (shouldReuploadSection(localTsKey(), serverTs)) {
            const s = get();
            patchServer({ enabled: s.enabled, triggerEvery: s.triggerEvery }).catch(() => {});
            return;
          }

          if (!section) return;

          const enabled = typeof section.enabled === 'boolean' ? section.enabled : get().enabled;
          const triggerEvery = typeof section.triggerEvery === 'number'
            ? Math.max(10, Math.min(200, Math.round(section.triggerEvery)))
            : get().triggerEvery;
          try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
          set({ enabled, triggerEvery });
        } catch { /* non-fatal — localStorage values remain active */ }
      },

      shouldTrigger: (chatFile, currentNonSystemCount) => {
        const { enabled, triggerEvery, lastByChatFile, isExtracting } = get();
        if (!enabled || isExtracting) return false;
        const last = lastByChatFile[chatFile] ?? 0;
        return currentNonSystemCount - last >= triggerEvery;
      },

      clearError: () => set({ error: null }),

      initForUser: (handle) => {
        _currentHandle = handle;
        useAutoMemoryStore.persist.rehydrate();
      },
      resetUser: () => {
        _currentHandle = null;
        set({
          enabled: false,
          triggerEvery: 30,
          lastByChatFile: {},
          isExtracting: false,
          error: null,
        });
      },

      extractFacts: async (chatFile, character, messages) => {
        if (get().isExtracting) return { added: 0 };
        set({ isExtracting: true, error: null });

        try {
          const { activeProvider, activeModel } = useSettingsStore.getState();
          const wiStore = useWorldInfoStore.getState();
          const avatar = character.avatar || '';
          if (!avatar) {
            set({ isExtracting: false });
            return { added: 0 };
          }

          // Find or create the auto-memory book for this character. We
          // can't reuse the embedded book because users may want to keep
          // hand-curated character lore separate from machine-extracted
          // notes. The naming convention + `autoExtracted` flag together
          // make this unambiguous.
          const allBooks = wiStore.books;
          let book = allBooks.find(
            (b) => b.ownerCharacterAvatar === avatar && b.autoExtracted
          );
          if (!book) {
            // First run for this character — create the auto-memory book.
            // If the character already has an embedded book, this returns
            // the existing one and we write into it (v1 model: at most one
            // character-owned book; auto-extracted entries coexist with
            // hand-curated ones, distinguished by their `Auto-extracted`
            // comment field).
            const created = wiStore.createCharacterBook(
              avatar,
              `${character.name}${AUTO_MEMORY_BOOK_SUFFIX}`
            );
            useWorldInfoStore.setState((s) => ({
              books: s.books.map((b) =>
                b.id === created.id ? { ...b, autoExtracted: true } : b
              ),
            }));
            book = { ...created, autoExtracted: true };
          }

          // Build "already known" digest so the LLM doesn't repeat itself.
          const knownDigest = book.entries
            .slice(-30)
            .map((e) => `- (${e.keys.join(', ')}) ${e.content}`)
            .join('\n');

          // Use the last 30 non-system messages as the extraction window.
          const sample = messages.filter((m) => !m.isSystem).slice(-30);
          if (sample.length < 4) {
            set({ isExtracting: false });
            return { added: 0 };
          }

          const transcript = sample
            .map((m) => `${m.isUser ? 'User' : character.name}: ${m.content}`)
            .join('\n');

          const sys = `You are an information-extraction assistant. Read a roleplay chat excerpt and produce CANONICAL FACTS worth remembering across future sessions — names, places, relationships, possessions, decisions, established traits.

Output rules:
- Return ONLY a JSON array. No prose.
- Each item: {"keys": ["keyword1", "keyword2"], "content": "fact in one sentence"}.
- Keys are short trigger words a future scan would look for to surface this fact.
- Skip facts already covered by the "Already known" list.
- Skip transient stuff (greetings, weather flavor, repeated ideas).
- If nothing new is worth recording, return [].`;

          const user = `Already known:
${knownDigest || '(none)'}

Chat excerpt:
${transcript}

New canonical facts (JSON array):`;

          const stream = await api.generateMessage(
            [
              { role: 'system', content: sys },
              { role: 'user', content: user },
            ],
            character.name,
            activeProvider,
            activeModel
          );

          if (!stream) {
            set({
              isExtracting: false,
              error: 'No response from API during extraction',
            });
            return { added: 0 };
          }

          let raw = '';
          for await (const token of parseSSEStream(stream)) {
            raw += token;
          }

          const facts = parseFactsFromResponse(raw);
          if (facts.length === 0) {
            // Mark this window as processed even on empty result so we
            // don't immediately retry on the next message.
            const total = messages.filter((m) => !m.isSystem).length;
            set((s) => ({
              lastByChatFile: { ...s.lastByChatFile, [chatFile]: total },
              isExtracting: false,
            }));
            return { added: 0 };
          }

          // Dedupe: drop any fact whose content substring-matches an
          // existing entry (case-insensitive prefix). Cheap and good
          // enough for v1; semantic dedup is a follow-up.
          const existingNorm = new Set(
            book.entries.map((e) => e.content.trim().toLowerCase().slice(0, 80))
          );
          let added = 0;
          for (const fact of facts) {
            const norm = fact.content.trim().toLowerCase().slice(0, 80);
            if (existingNorm.has(norm)) continue;
            existingNorm.add(norm);
            useWorldInfoStore.getState().createEntry(book.id, {
              keys: fact.keys,
              content: fact.content,
              comment: 'Auto-extracted',
              // Machine-extracted recent-window facts are continuity
              // notes by definition (see WI_CATEGORIES).
              category: 'continuity_note',
            });
            added++;
          }

          const total = messages.filter((m) => !m.isSystem).length;
          set((s) => ({
            lastByChatFile: { ...s.lastByChatFile, [chatFile]: total },
            isExtracting: false,
          }));
          return { added };
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Extraction failed',
            isExtracting: false,
          });
          return { added: 0 };
        }
      },
    }),
    {
      name: 'st-mobile-auto-memory',
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (s) => ({
        enabled: s.enabled,
        triggerEvery: s.triggerEvery,
        lastByChatFile: s.lastByChatFile,
      }),
    }
  )
);
