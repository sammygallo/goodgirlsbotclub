import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useChatStore } from './chatStore';
import { useExtensionStore } from './extensionStore';

// ---------------------------------------------------------------------------
// Lovense device control store
//
// A fresh GGBC-native implementation of Lovense connectivity (NOT a port of any
// third-party SillyTavern extension code). It talks to the official Lovense
// Cloud API (https://api.lovense.com) directly from the browser, which is the
// same transport community integrations use:
//
//   • QR pairing:  POST /api/lan/getQrCode   -> returns a QR image the user
//                  scans with the Lovense Remote app to link their toys.
//   • Commands:    POST /api/lan/v2/command  -> drives the paired toy(s) with
//                  an action + intensity for a given duration.
//
// A developer token (from the Lovense developer dashboard) is required for both
// calls. Live "scan complete" detection needs Lovense's Socket API or a
// server-side callback and is intentionally out of scope for this first pass —
// instead the user pairs in the app, then hits "Test connection" which sends a
// no-op command and reports whether a toy responded. See the PR notes.
// ---------------------------------------------------------------------------

const LOVENSE_API_BASE = 'https://api.lovense.com';

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

/** Lovense toy actions we expose. The Cloud command action string is
 *  `"<Action>:<intensity>"`, e.g. `"Vibrate:10"`. `All` targets every
 *  function the connected toy supports simultaneously. */
export const LOVENSE_ACTIONS = [
  'Vibrate',
  'Rotate',
  'Pump',
  'Thrust',
  'Suction',
  'Oscillate',
  'All',
] as const;
export type LovenseAction = (typeof LOVENSE_ACTIONS)[number];

/** Per-action intensity ceiling. Most functions accept 0-20; Pump is 0-3. */
export function actionMaxIntensity(action: LovenseAction): number {
  return action === 'Pump' ? 3 : 20;
}

export interface KeywordMapping {
  id: string;
  /** Case-insensitive substring matched against each AI message. */
  keyword: string;
  action: LovenseAction;
  /** Base intensity before the global scale is applied. */
  intensity: number;
}

type ConnectionStatus =
  | 'idle'
  | 'generating-qr'
  | 'awaiting-scan'
  | 'testing'
  | 'connected'
  | 'error';

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_MAPPINGS: KeywordMapping[] = [
  { id: 'seed-moan', keyword: 'moan', action: 'Vibrate', intensity: 12 },
  { id: 'seed-kiss', keyword: 'kiss', action: 'Vibrate', intensity: 6 },
  { id: 'seed-gentle', keyword: 'gently', action: 'Vibrate', intensity: 4 },
  { id: 'seed-harder', keyword: 'harder', action: 'Vibrate', intensity: 18 },
];

interface LovenseState {
  // --- persisted settings ---
  /** Lovense developer token. Required for every Cloud API call. */
  devToken: string;
  /** Stable per-user id sent as `uid` to the Cloud API. */
  uid: string;
  /** Scan finished AI messages for keywords and drive the toy automatically. */
  autoReact: boolean;
  mappings: KeywordMapping[];
  /** Multiplier applied to every mapping's base intensity (0.1 – 2.0). */
  globalIntensityScale: number;
  /** How long (seconds) each triggered action runs before auto-stopping. */
  defaultDurationSec: number;

  // --- session state ---
  status: ConnectionStatus;
  /** Whether a paired toy last responded to a command. */
  connected: boolean;
  qrUrl: string | null;
  pairingCode: string | null;
  error: string | null;
  isSending: boolean;

  // --- actions ---
  setDevToken: (t: string) => void;
  setAutoReact: (on: boolean) => void;
  setGlobalIntensityScale: (n: number) => void;
  setDefaultDurationSec: (n: number) => void;
  addMapping: () => void;
  updateMapping: (id: string, patch: Partial<Omit<KeywordMapping, 'id'>>) => void;
  removeMapping: (id: string) => void;
  clearError: () => void;

  /** Ask the Cloud API for a pairing QR the user scans in the Lovense app. */
  generateQr: () => Promise<void>;
  /** Send a single action to the paired toy(s). */
  sendCommand: (action: LovenseAction, intensity: number, timeSec?: number) => Promise<boolean>;
  /** Immediately halt all toy activity. */
  stopAll: () => Promise<void>;
  /** Fire a brief no-op command to confirm a toy is paired and reachable. */
  testConnection: () => Promise<void>;
  /** Scan finished AI text for mapped keywords and drive the toy. */
  scanAndTrigger: (text: string) => Promise<void>;

  initForUser: (handle: string) => void;
  resetUser: () => void;
}

function ensureUid(get: () => LovenseState, set: (p: Partial<LovenseState>) => void): string {
  let uid = get().uid;
  if (!uid) {
    uid = _currentHandle ? `ggbc-${_currentHandle}` : `ggbc-${genId()}`;
    set({ uid });
  }
  return uid;
}

async function lovensePost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${LOVENSE_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Lovense API ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export const useLovenseStore = create<LovenseState>()(
  persist(
    (set, get) => ({
      devToken: '',
      uid: '',
      autoReact: false,
      mappings: DEFAULT_MAPPINGS,
      globalIntensityScale: 1,
      defaultDurationSec: 3,

      status: 'idle',
      connected: false,
      qrUrl: null,
      pairingCode: null,
      error: null,
      isSending: false,

      setDevToken: (t) => set({ devToken: t.trim(), connected: false, status: 'idle' }),
      setAutoReact: (on) => set({ autoReact: on }),
      setGlobalIntensityScale: (n) =>
        set({ globalIntensityScale: Math.max(0.1, Math.min(2, n)) }),
      setDefaultDurationSec: (n) =>
        set({ defaultDurationSec: Math.max(1, Math.min(60, Math.round(n))) }),

      addMapping: () =>
        set({
          mappings: [
            ...get().mappings,
            { id: genId(), keyword: '', action: 'Vibrate', intensity: 10 },
          ],
        }),
      updateMapping: (id, patch) =>
        set({
          mappings: get().mappings.map((m) => {
            if (m.id !== id) return m;
            const next = { ...m, ...patch };
            const max = actionMaxIntensity(next.action);
            next.intensity = Math.max(0, Math.min(max, Math.round(next.intensity)));
            return next;
          }),
        }),
      removeMapping: (id) => set({ mappings: get().mappings.filter((m) => m.id !== id) }),
      clearError: () => set({ error: null }),

      generateQr: async () => {
        const { devToken } = get();
        if (!devToken) {
          set({ error: 'Enter a Lovense developer token first.', status: 'error' });
          return;
        }
        const uid = ensureUid(get, set);
        set({ status: 'generating-qr', error: null, qrUrl: null, pairingCode: null });
        try {
          const data = await lovensePost('/api/lan/getQrCode', {
            token: devToken,
            uid,
            uname: _currentHandle ?? 'GGBC user',
            v: 2,
          });
          const inner = (data.data ?? data) as Record<string, unknown>;
          const qr = typeof inner.qr === 'string' ? inner.qr : null;
          const code = typeof inner.code === 'string' ? inner.code : null;
          if (!qr) {
            const msg = typeof data.message === 'string' ? data.message : 'No QR returned';
            set({ status: 'error', error: `Lovense: ${msg}` });
            return;
          }
          set({ status: 'awaiting-scan', qrUrl: qr, pairingCode: code });
        } catch (err) {
          set({
            status: 'error',
            error: err instanceof Error ? err.message : 'QR request failed',
          });
        }
      },

      sendCommand: async (action, intensity, timeSec) => {
        const { devToken } = get();
        if (!devToken) {
          set({ error: 'Enter a Lovense developer token first.' });
          return false;
        }
        const uid = ensureUid(get, set);
        const clamped = Math.max(0, Math.min(actionMaxIntensity(action), Math.round(intensity)));
        const seconds = timeSec ?? get().defaultDurationSec;
        set({ isSending: true });
        try {
          const data = await lovensePost('/api/lan/v2/command', {
            token: devToken,
            uid,
            command: 'Function',
            action: `${action}:${clamped}`,
            timeSec: seconds,
            apiVer: 1,
          });
          const code = typeof data.code === 'number' ? data.code : -1;
          const ok = code === 0 || data.result === true;
          if (ok) {
            set({ connected: true, status: 'connected', error: null });
          } else {
            const msg = typeof data.message === 'string' ? data.message : 'Command rejected';
            set({ error: `Lovense: ${msg}` });
          }
          return ok;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Command failed', connected: false });
          return false;
        } finally {
          set({ isSending: false });
        }
      },

      stopAll: async () => {
        await get().sendCommand('All', 0, 0);
      },

      testConnection: async () => {
        set({ status: 'testing', error: null });
        // A 1-second, zero-intensity pulse: reaches the toy without doing anything.
        const ok = await get().sendCommand('Vibrate', 0, 1);
        set({ status: ok ? 'connected' : 'error' });
      },

      scanAndTrigger: async (text) => {
        const { mappings, globalIntensityScale } = get();
        if (!text) return;
        const haystack = text.toLowerCase();

        // Collapse matches per action, keeping the strongest intensity so two
        // keywords hitting the same function don't fight each other.
        const strongest = new Map<LovenseAction, number>();
        for (const m of mappings) {
          const kw = m.keyword.trim().toLowerCase();
          if (!kw || !haystack.includes(kw)) continue;
          const scaled = Math.round(m.intensity * globalIntensityScale);
          const prev = strongest.get(m.action) ?? -1;
          if (scaled > prev) strongest.set(m.action, scaled);
        }
        if (strongest.size === 0) return;

        for (const [action, intensity] of strongest) {
          await get().sendCommand(action, intensity);
        }
      },

      initForUser: (handle) => {
        _currentHandle = handle;
        useLovenseStore.persist.rehydrate();
      },
      resetUser: () => {
        _currentHandle = null;
        set({
          devToken: '',
          uid: '',
          autoReact: false,
          mappings: DEFAULT_MAPPINGS,
          globalIntensityScale: 1,
          defaultDurationSec: 3,
          status: 'idle',
          connected: false,
          qrUrl: null,
          pairingCode: null,
          error: null,
          isSending: false,
        });
      },
    }),
    {
      name: 'ggbc-lovense',
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (s) => ({
        devToken: s.devToken,
        uid: s.uid,
        autoReact: s.autoReact,
        mappings: s.mappings,
        globalIntensityScale: s.globalIntensityScale,
        defaultDurationSec: s.defaultDurationSec,
      }),
    }
  )
);

// ---------------------------------------------------------------------------
// Auto-react: when a generation finishes, scan the freshly-completed AI message
// for mapped keywords and drive the toy. Wired as a module-level subscription
// (the extension manifest's onAfterAIMessage/onInit hooks aren't consumed by
// the app yet) and fully gated: the Lovense extension must be enabled, the
// autoReact toggle on, and a toy already reachable. Fires once per generation,
// on the isStreaming true -> false edge.
// ---------------------------------------------------------------------------

let _prevStreaming = false;

useChatStore.subscribe((state) => {
  const streaming = state.isStreaming;
  const finished = _prevStreaming && !streaming;
  _prevStreaming = streaming;
  if (!finished) return;

  if (!useExtensionStore.getState().enabled['lovense']) return;
  const lovense = useLovenseStore.getState();
  if (!lovense.autoReact || !lovense.connected || !lovense.devToken) return;

  // The just-finished assistant turn is the last non-user, non-system message.
  const msgs = state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isUser || m.isSystem) continue;
    void lovense.scanAndTrigger(m.content);
    break;
  }
});
