import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  getSettingsBlob,
  patchServerKey,
  markSectionDirty,
  recordServerTs,
  shouldReuploadSection,
} from '../utils/serverSettings';

// ---------------------------------------------------------------------------
// Token-usage odometer + self-imposed budget.
//
// GGBC has no server-side billing or quota (users bring their own API keys),
// so this is a *client-side* accounting of estimated token spend. Every
// generation — send, swipe, regenerate, continue, and each group-member turn —
// increments these counters via recordGeneration(), so the totals reflect real
// tokens sent, not just the kept reply (matches the "count every generation"
// product decision).
//
// Only a handful of scalars persist; we deliberately keep NO per-turn arrays in
// localStorage so this can't re-introduce the quota overflow that commit
// 3630df4 fixed by moving per-message bulk out of localStorage. Per-turn
// breakdowns live on each chat message (extra.usage in the JSONL) instead.
//
// Sync safety: these are ACCUMULATORS, not a key/value map, so the generic
// last-write-wins patch can destroy data — a fresh device that PUTs its
// this-session count before it has read the server's real total would reconcile
// a 409 by overwriting the server's accumulators (serverSettings.patchServerKey
// merges `{...current, ...cleanValue}`, and cleanValue is a full snapshot, so
// every counter key is clobbered). We guard that two ways: (1) `loaded` — no
// server write happens until fetchPrefs has merged the server baseline into
// local state at least once, and (2) fetchPrefs merges the lifetime odometer by
// MAX rather than overwriting, so a stale read can never shrink it. After the
// baseline is loaded, ordinary last-write-wins drift between two live devices
// is acceptable for an estimate.
//
// v1 is tokens-only. The shape leaves room to add a dollar readout later
// (a pricing table × these token counts) without a storage migration.
// ---------------------------------------------------------------------------

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

function freshTotals(): TokenTotals {
  return { input: 0, output: 0, total: 0 };
}

function maxTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    total: Math.max(a.total, b.total),
  };
}

// Per-user scoping: the persist key is suffixed with the handle so one
// account's usage doesn't leak into the next on a shared device.
let _currentHandle: string | null = null;

const scopedLocalStorage = {
  getItem: (name: string) =>
    localStorage.getItem(_currentHandle ? `${name}_${_currentHandle}` : name),
  setItem: (name: string, value: string) =>
    localStorage.setItem(_currentHandle ? `${name}_${_currentHandle}` : name, value),
  removeItem: (name: string) =>
    localStorage.removeItem(_currentHandle ? `${name}_${_currentHandle}` : name),
};

// Cross-device sync via the `stm_usage` settings section.
const SERVER_KEY = 'stm_usage';

function localTsKey(): string {
  return _currentHandle ? `stm:usage-local-ts_${_currentHandle}` : 'stm:usage-local-ts';
}

interface UsageDurable {
  lifetime: TokenTotals;
  generations: number;
  budgetLimit: number | null;
  budgetUsed: TokenTotals;
  budgetStartedAt: number | null;
  contextMeterEnabled: boolean;
}

function durableOf(s: UsageDurable): UsageDurable {
  return {
    lifetime: s.lifetime,
    generations: s.generations,
    budgetLimit: s.budgetLimit,
    budgetUsed: s.budgetUsed,
    budgetStartedAt: s.budgetStartedAt,
    contextMeterEnabled: s.contextMeterEnabled,
  };
}

async function patchServer(d: UsageDurable): Promise<void> {
  await patchServerKey(SERVER_KEY, { ...d } as unknown as Record<string, unknown>, localTsKey());
}

// Coalesce the high-frequency per-generation PUT into a single trailing write
// so rapid swipes don't fire a request each. The section is a full-snapshot
// last-write-wins value, so collapsing N writes into one loses nothing; the
// dirty flag set alongside means a dropped flush is still recovered next fetch.
let _pushTimer: ReturnType<typeof setTimeout> | null = null;
function clearPushTimer(): void {
  if (_pushTimer) {
    clearTimeout(_pushTimer);
    _pushTimer = null;
  }
}

function sanitizeTotals(raw: unknown): TokenTotals {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Partial<TokenTotals>;
  const input = Number.isFinite(t.input) ? Math.max(0, Math.round(t.input as number)) : 0;
  const output = Number.isFinite(t.output) ? Math.max(0, Math.round(t.output as number)) : 0;
  const total = Number.isFinite(t.total)
    ? Math.max(0, Math.round(t.total as number))
    : input + output;
  return { input, output, total };
}

interface UsageState extends UsageDurable {
  /** True once fetchPrefs has merged the server baseline at least once this
   *  session. No server write happens before this — see the sync-safety note.
   *  Not persisted (always starts false on a fresh load). */
  loaded: boolean;
  /** Record one finished generation. Increments lifetime + budget odometers. */
  recordGeneration: (inputTokens: number, outputTokens: number) => void;
  /** Set (or clear, with null) the self-imposed token budget cap. */
  setBudgetLimit: (limit: number | null) => void;
  /** Zero the budget-period counter and stamp a new period start. */
  resetBudget: () => void;
  /** Toggle the in-chat context-fill meter shown while composing. */
  setContextMeterEnabled: (enabled: boolean) => void;
  /** Wipe lifetime + budget counters (does not touch prefs). */
  clearAll: () => void;
  /** Tokens left under the cap; null when no budget is set. Can go negative. */
  budgetRemaining: () => number | null;
  /** Seed counters from the server after login (merges; never shrinks). */
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

export const useUsageStore = create<UsageState>()(
  persist(
    (set, get) => {
      // Push pending local state to the server, gated on a loaded baseline.
      // `immediate` for discrete user actions (budget changes); debounced for
      // the high-frequency per-generation odometer bumps.
      const commit = (immediate: boolean) => {
        if (!get().loaded) return; // buffer locally until baseline merged
        markSectionDirty(localTsKey());
        if (immediate) {
          clearPushTimer();
          patchServer(durableOf(get())).catch(() => {});
        } else {
          clearPushTimer();
          _pushTimer = setTimeout(() => {
            _pushTimer = null;
            patchServer(durableOf(get())).catch(() => {});
          }, 1500);
        }
      };

      return {
        lifetime: freshTotals(),
        generations: 0,
        budgetLimit: null,
        budgetUsed: freshTotals(),
        budgetStartedAt: null,
        contextMeterEnabled: true,
        loaded: false,

        recordGeneration(inputTokens, outputTokens) {
          const inT = Number.isFinite(inputTokens) ? Math.max(0, Math.round(inputTokens)) : 0;
          const outT = Number.isFinite(outputTokens) ? Math.max(0, Math.round(outputTokens)) : 0;
          if (inT === 0 && outT === 0) return;
          const s = get();
          const lifetime: TokenTotals = {
            input: s.lifetime.input + inT,
            output: s.lifetime.output + outT,
            total: s.lifetime.total + inT + outT,
          };
          const budgetUsed: TokenTotals = {
            input: s.budgetUsed.input + inT,
            output: s.budgetUsed.output + outT,
            total: s.budgetUsed.total + inT + outT,
          };
          set({ lifetime, budgetUsed, generations: s.generations + 1 });
          commit(false);
        },

        setBudgetLimit(limit) {
          const normalized =
            limit === null || !Number.isFinite(limit) || limit <= 0 ? null : Math.round(limit);
          const budgetStartedAt =
            normalized !== null && get().budgetStartedAt === null ? Date.now() : get().budgetStartedAt;
          set({ budgetLimit: normalized, budgetStartedAt });
          commit(true);
        },

        resetBudget() {
          set({ budgetUsed: freshTotals(), budgetStartedAt: Date.now() });
          commit(true);
        },

        setContextMeterEnabled(enabled) {
          set({ contextMeterEnabled: !!enabled });
          commit(true);
        },

        clearAll() {
          set({
            lifetime: freshTotals(),
            generations: 0,
            budgetUsed: freshTotals(),
            budgetStartedAt: get().budgetLimit !== null ? Date.now() : null,
          });
          commit(true);
        },

        budgetRemaining() {
          const { budgetLimit, budgetUsed } = get();
          if (budgetLimit === null) return null;
          return budgetLimit - budgetUsed.total;
        },

        fetchPrefs: async () => {
          try {
            const settings = await getSettingsBlob();
            const section = settings[SERVER_KEY] as
              | (Partial<UsageDurable> & { _ts?: number })
              | undefined;
            const serverTs = Number(section?._ts || 0);

            // Local has unsynced edits and no other device moved past us — push
            // ours up (it already includes any prior server baseline) and mark
            // loaded so subsequent edits sync normally.
            if (shouldReuploadSection(localTsKey(), serverTs)) {
              set({ loaded: true });
              patchServer(durableOf(get())).catch(() => {});
              return;
            }

            if (section && typeof section === 'object') {
              const serverLifetime = sanitizeTotals(section.lifetime);
              const serverGenerations = Number.isFinite(section.generations)
                ? Math.max(0, Math.round(section.generations as number))
                : 0;
              // Merge the odometer by MAX so a stale/younger read can never
              // shrink the lifetime total; take server's value for the
              // resettable budget + prefs (ordinary last-write-wins).
              const mergedLifetime = maxTotals(get().lifetime, serverLifetime);
              const mergedGenerations = Math.max(get().generations, serverGenerations);
              set({
                lifetime: mergedLifetime,
                generations: mergedGenerations,
                budgetLimit:
                  section.budgetLimit === null || !Number.isFinite(section.budgetLimit)
                    ? null
                    : Math.max(0, Math.round(section.budgetLimit as number)) || null,
                budgetUsed: sanitizeTotals(section.budgetUsed),
                budgetStartedAt: Number.isFinite(section.budgetStartedAt)
                  ? (section.budgetStartedAt as number)
                  : null,
                contextMeterEnabled:
                  typeof section.contextMeterEnabled === 'boolean'
                    ? section.contextMeterEnabled
                    : true,
                loaded: true,
              });
              try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
              // If our merged total exceeded the server's, push the higher value
              // so the server converges upward.
              if (
                mergedLifetime.total > serverLifetime.total ||
                mergedGenerations > serverGenerations
              ) {
                markSectionDirty(localTsKey());
                patchServer(durableOf(get())).catch(() => {});
              }
            } else {
              // First device for this account — no server section yet. Seed it
              // from whatever we've accumulated locally.
              set({ loaded: true });
              const s = get();
              if (s.lifetime.total > 0 || s.generations > 0 || s.budgetLimit !== null) {
                markSectionDirty(localTsKey());
                patchServer(durableOf(s)).catch(() => {});
              }
            }
          } catch {
            // Server unreachable — leave loaded=false so we keep buffering
            // locally (no risky blind PUT) and retry on the next login/fetch.
          }
        },

        initForUser(handle) {
          _currentHandle = handle;
          useUsageStore.persist.rehydrate();
        },

        resetUser() {
          _currentHandle = null;
          clearPushTimer();
          set({
            lifetime: freshTotals(),
            generations: 0,
            budgetLimit: null,
            budgetUsed: freshTotals(),
            budgetStartedAt: null,
            contextMeterEnabled: true,
            loaded: false,
          });
        },
      };
    },
    {
      name: 'st-mobile-usage',
      version: 1,
      storage: createJSONStorage(() => scopedLocalStorage),
      // Persist only durable counters/prefs — never `loaded` (must start false
      // each session) or the action functions.
      partialize: (s) => ({
        lifetime: s.lifetime,
        generations: s.generations,
        budgetLimit: s.budgetLimit,
        budgetUsed: s.budgetUsed,
        budgetStartedAt: s.budgetStartedAt,
        contextMeterEnabled: s.contextMeterEnabled,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the gauge, the per-turn chip, and the page).
// ---------------------------------------------------------------------------

/** Compact token count: 1234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = v / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(2).replace(/\.?0+$/, '')}M`;
}
