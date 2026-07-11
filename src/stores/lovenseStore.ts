import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { apiRequest } from '../api/client';
import { useChatStore } from './chatStore';
import { useExtensionStore } from './extensionStore';

// ---------------------------------------------------------------------------
// Lovense device control store
//
// A fresh GGBC-native implementation of Lovense connectivity (NOT a port of any
// third-party SillyTavern extension code). Everything goes through the GGBC
// backend proxy — the browser never calls api.lovense.com directly (no CORS),
// and the app-level developer token lives server-side, never in the client:
//
//   1. POST /api/lovense/pairing-intent  -> backend mints an opaque `uid` and
//      marks the pairing pending.
//   2. POST /api/lovense/qr              -> backend proxies Lovense getQrCode
//      (injecting the dev token + uid) and returns the QR image to show.
//   3. The user scans; Lovense calls the backend's /api/lovense/callback with
//      that `uid`, flipping the pairing to "paired".
//   4. We poll GET /api/lovense/session until it reports "paired".
//   5. POST /api/lovense/command         -> backend proxies a toy command
//      (injecting token + the user's paired uid). We only send action +
//      intensity + duration.
// The backend keeps the LAN credentials; the browser only learns status + toy
// names.
// ---------------------------------------------------------------------------

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
  /** Server-minted pairing id (from /api/lovense/pairing-intent). Informational
   *  on the client; the backend owns it for QR + command proxying. */
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
  /** True once the backend reports the pairing as "paired". */
  connected: boolean;
  /** Connected toy names/types as reported by the backend session, if any. */
  toys: unknown | null;
  qrUrl: string | null;
  pairingCode: string | null;
  error: string | null;
  isSending: boolean;

  // --- actions ---
  setAutoReact: (on: boolean) => void;
  setGlobalIntensityScale: (n: number) => void;
  setDefaultDurationSec: (n: number) => void;
  addMapping: () => void;
  updateMapping: (id: string, patch: Partial<Omit<KeywordMapping, 'id'>>) => void;
  removeMapping: (id: string) => void;
  clearError: () => void;

  /** Ask the backend to mint a pairing intent + proxy a QR to scan. */
  generateQr: () => Promise<void>;
  /** Send a single action to the paired toy(s). */
  sendCommand: (action: LovenseAction, intensity: number, timeSec?: number) => Promise<boolean>;
  /** Immediately halt all toy activity. */
  stopAll: () => Promise<void>;
  /** Fetch the backend pairing session once and reconcile connected state. */
  checkPairing: () => Promise<void>;
  /** Scan finished AI text for mapped keywords and drive the toy. */
  scanAndTrigger: (text: string) => Promise<void>;

  initForUser: (handle: string) => void;
  resetUser: () => void;
}

/** Shape of GET /api/lovense/session. */
interface PairingSession {
  status: 'none' | 'pending' | 'paired';
  toys?: unknown | null;
  platform?: string | null;
}

// Poll the backend for scan completion after a QR is shown. Module-level so a
// re-render never spawns a second poller; capped so a never-scanned QR (they
// expire after 4h) doesn't poll forever.
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TICKS = 100; // ~5 minutes

function stopPairingPoll(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

export const useLovenseStore = create<LovenseState>()(
  persist(
    (set, get) => ({
      uid: '',
      autoReact: false,
      mappings: DEFAULT_MAPPINGS,
      globalIntensityScale: 1,
      defaultDurationSec: 3,

      status: 'idle',
      connected: false,
      toys: null,
      qrUrl: null,
      pairingCode: null,
      error: null,
      isSending: false,

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
        stopPairingPoll();
        set({
          status: 'generating-qr',
          error: null,
          qrUrl: null,
          pairingCode: null,
          connected: false,
          toys: null,
        });
        try {
          // 1. Backend mints a fresh pairing uid and marks it pending.
          const intent = await apiRequest<{ uid: string }>(
            '/api/lovense/pairing-intent',
            { method: 'POST' },
          );
          set({ uid: intent.uid });

          // 2. Backend proxies Lovense getQrCode (token stays server-side).
          const qr = await apiRequest<{ uid: string; qr: string; code: string | null }>(
            '/api/lovense/qr',
            { method: 'POST' },
          );
          set({ status: 'awaiting-scan', qrUrl: qr.qr, pairingCode: qr.code });

          // 3. Poll the backend until Lovense's callback flips us to "paired".
          let ticks = 0;
          _pollTimer = setInterval(() => {
            ticks += 1;
            if (ticks > POLL_MAX_TICKS) {
              stopPairingPoll();
              return;
            }
            void get().checkPairing();
          }, POLL_INTERVAL_MS);
        } catch (err) {
          set({
            status: 'error',
            error: err instanceof Error ? err.message : 'QR request failed',
          });
        }
      },

      sendCommand: async (action, intensity, timeSec) => {
        const clamped = Math.max(0, Math.min(actionMaxIntensity(action), Math.round(intensity)));
        const durationSec = timeSec ?? get().defaultDurationSec;
        set({ isSending: true });
        try {
          // Backend injects the dev token + the user's paired uid.
          const res = await apiRequest<{ result: boolean; message: string | null }>(
            '/api/lovense/command',
            {
              method: 'POST',
              body: JSON.stringify({ action, intensity: clamped, durationSec }),
            },
          );
          if (res.result) {
            set({ error: null });
          } else {
            set({ error: res.message ? `Lovense: ${res.message}` : 'Command rejected' });
          }
          return res.result;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Command failed' });
          return false;
        } finally {
          set({ isSending: false });
        }
      },

      stopAll: async () => {
        await get().sendCommand('All', 0, 0);
      },

      checkPairing: async () => {
        try {
          const session = await apiRequest<PairingSession>('/api/lovense/session');
          if (session.status === 'paired') {
            stopPairingPoll();
            set({ connected: true, status: 'connected', toys: session.toys ?? null });
          } else if (session.status === 'pending') {
            set({ connected: false, status: 'awaiting-scan' });
          } else {
            set({ connected: false, toys: null });
          }
        } catch {
          // Non-fatal: a transient poll failure shouldn't surface an error or
          // drop an already-established connection.
        }
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
        stopPairingPoll();
        set({
          uid: '',
          autoReact: false,
          mappings: DEFAULT_MAPPINGS,
          globalIntensityScale: 1,
          defaultDurationSec: 3,
          status: 'idle',
          connected: false,
          toys: null,
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
  if (!lovense.autoReact || !lovense.connected) return;

  // The just-finished assistant turn is the last non-user, non-system message.
  const msgs = state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isUser || m.isSystem) continue;
    void lovense.scanAndTrigger(m.content);
    break;
  }
});
