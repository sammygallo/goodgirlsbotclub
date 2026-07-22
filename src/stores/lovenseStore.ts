import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { apiRequest } from '../api/client';
import {
  getSettingsBlob,
  makeLocalTsKey,
  markSectionDirty,
  patchServerKey,
  recordServerTs,
  shouldReuploadSection,
} from '../utils/serverSettings';
import {
  LOVENSE_ACTIONS,
  actionMaxIntensity,
  capabilitiesForToy,
  parseLovenseDirectives,
  hasLovenseTag,
  type LovenseAction,
  type LovensePreset,
  type FunctionActionSpec,
  type LovenseDirective,
} from '../utils/lovense';
import { useChatStore } from './chatStore';
import { useExtensionStore } from './extensionStore';

// ---------------------------------------------------------------------------
// Lovense device control store (v2)
//
// A GGBC-native implementation of Lovense connectivity. Everything goes through
// the GGBC backend proxy — the browser never calls the Lovense API directly (no
// CORS) and the app-level developer token stays server-side:
//
//   1. POST /api/lovense/pairing-intent -> backend mints an opaque `uid`.
//   2. POST /api/lovense/qr             -> backend proxies getQrCode.
//   3. The user scans; Lovense calls /api/lovense/callback, flipping to "paired".
//   4. GET  /api/lovense/session        -> poll for "paired" + the toy list.
//   5. POST /api/lovense/command        -> backend proxies a Function/Pattern/
//      Preset command (injecting token + uid).
//
// v2 adds: the full documented action set (fixing Thrust→Thrusting), per-toy
// capability detection, per-character control profiles, AI-driven control via
// `[lovense: ...]` directives the character embeds in its replies, streaming
// vs. finish reactions, and multi-toy targeting.
// ---------------------------------------------------------------------------

export {
  LOVENSE_ACTIONS,
  SIMPLE_ACTIONS,
  LOVENSE_PRESETS,
  actionMaxIntensity,
  capabilitiesForToy,
  toyDisplayName,
} from '../utils/lovense';
export type { LovenseAction, LovensePreset } from '../utils/lovense';

let _currentHandle: string | null = null;

const scopedLocalStorage = {
  getItem: (name: string) =>
    localStorage.getItem(_currentHandle ? `${name}_${_currentHandle}` : name),
  setItem: (name: string, value: string) =>
    localStorage.setItem(_currentHandle ? `${name}_${_currentHandle}` : name, value),
  removeItem: (name: string) =>
    localStorage.removeItem(_currentHandle ? `${name}_${_currentHandle}` : name),
};

// Preferences (not pairing state) roam across devices via this section.
const SERVER_KEY = 'stm_lovense';
const LOCAL_TS_KEY = () =>
  _currentHandle ? `${makeLocalTsKey(SERVER_KEY)}_${_currentHandle}` : makeLocalTsKey(SERVER_KEY);

export interface KeywordMapping {
  id: string;
  /** Substring (or whole-word) matched against each AI message. */
  keyword: string;
  action: LovenseAction;
  /** Base intensity before the profile/global scale is applied. */
  intensity: number;
}

/** How a character's toy reactions are driven. */
export interface LovenseProfile {
  /** Master switch for this character's reactions. */
  reactionEnabled: boolean;
  /** Teach the model the directive syntax and parse `[lovense: ...]` tags from
   *  its replies. When true, keyword mappings are ignored for this character
   *  (the model's explicit directives are the control channel). */
  aiControl: boolean;
  /** Multiplier applied to every mapping/directive intensity for this character. */
  intensityScale: number;
  /** Keyword → action mappings (used only when aiControl is off). */
  mappings: KeywordMapping[];
}

export interface LovenseToy {
  id: string;
  name?: string | null;
  nickname?: string | null;
  status?: string | null;
  battery?: number | null;
}

type ConnectionStatus =
  | 'idle'
  | 'generating-qr'
  | 'awaiting-scan'
  | 'testing'
  | 'connected'
  | 'error';

function genId(): string {
  return `lv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_MAPPINGS: KeywordMapping[] = [
  { id: 'seed-moan', keyword: 'moan', action: 'Vibrate', intensity: 12 },
  { id: 'seed-kiss', keyword: 'kiss', action: 'Vibrate', intensity: 6 },
  { id: 'seed-gentle', keyword: 'gently', action: 'Vibrate', intensity: 4 },
  { id: 'seed-harder', keyword: 'harder', action: 'Vibrate', intensity: 18 },
];

function makeDefaultProfile(): LovenseProfile {
  return {
    reactionEnabled: true,
    aiControl: false,
    intensityScale: 1,
    mappings: DEFAULT_MAPPINGS.map((m) => ({ ...m })),
  };
}

/** Shape of GET /api/lovense/session. */
interface PairingSession {
  status: 'none' | 'pending' | 'paired';
  toys?: unknown | null;
  toy_list?: LovenseToy[] | null;
  platform?: string | null;
}

interface CommandResult {
  result: boolean;
  message: string | null;
  code?: number | null;
}

interface SendOptions {
  durationSec?: number;
  toy?: string | string[];
  stopPrevious?: boolean;
  loopRunningSec?: number;
  loopPauseSec?: number;
}

interface LovenseState {
  // --- persisted: pairing (device-local) ---
  uid: string;

  // --- persisted: preferences (roam via stm_lovense) ---
  /** Master switch: react to finished AI messages at all. */
  autoReact: boolean;
  /** React while the message is still streaming (throttled) vs. only on finish. */
  streamLive: boolean;
  /** Require whole-word keyword matches (avoids "harder" ⊂ "hardware"). */
  matchWholeWord: boolean;
  /** Seconds each triggered Function action runs before auto-stopping. */
  defaultDurationSec: number;
  /** Strip `[lovense: ...]` tags from the rendered message. */
  hideTagsInChat: boolean;
  /** Applies to every character without its own profile. */
  defaultProfile: LovenseProfile;
  /** Per-character overrides, keyed by avatar filename. */
  profilesByAvatar: Record<string, LovenseProfile>;

  // --- session state (transient) ---
  status: ConnectionStatus;
  connected: boolean;
  toys: LovenseToy[];
  platform: string | null;
  qrUrl: string | null;
  pairingCode: string | null;
  error: string | null;
  isSending: boolean;
  /** Id of the toy the manual/quick controls target; null = all toys. */
  activeToyId: string | null;

  // --- preference actions ---
  setAutoReact: (on: boolean) => void;
  setStreamLive: (on: boolean) => void;
  setMatchWholeWord: (on: boolean) => void;
  setDefaultDurationSec: (n: number) => void;
  setHideTagsInChat: (on: boolean) => void;
  setActiveToyId: (id: string | null) => void;
  clearError: () => void;

  // --- profile actions ---
  resolveProfile: (avatar?: string | null) => LovenseProfile;
  hasCharacterProfile: (avatar: string) => boolean;
  updateProfile: (avatar: string | null, patch: Partial<LovenseProfile>) => void;
  createCharacterProfile: (avatar: string) => void;
  removeCharacterProfile: (avatar: string) => void;
  addMapping: (avatar: string | null) => void;
  updateMapping: (avatar: string | null, id: string, patch: Partial<Omit<KeywordMapping, 'id'>>) => void;
  removeMapping: (avatar: string | null, id: string) => void;

  // --- pairing ---
  generateQr: () => Promise<void>;
  checkPairing: () => Promise<void>;
  unpair: () => Promise<void>;

  // --- commands ---
  sendFunction: (actions: FunctionActionSpec[], opts?: SendOptions) => Promise<boolean>;
  sendPreset: (name: LovensePreset, opts?: SendOptions) => Promise<boolean>;
  stopAll: () => Promise<void>;
  /** Union of supported actions across all connected toys. */
  connectedCapabilities: () => LovenseAction[];

  // --- reactions ---
  reactToMessage: (content: string, avatar: string | null | undefined, isFinal: boolean) => Promise<void>;

  // --- lifecycle ---
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

// Pairing poll — module-level so a re-render never spawns a second poller.
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TICKS = 100; // ~5 minutes

function stopPairingPoll(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// Soft throttle so a burst of reaction directives doesn't hammer the toy.
const MIN_COMMAND_GAP_MS = 180;
let _lastCommandAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = _lastCommandAt + MIN_COMMAND_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCommandAt = Date.now();
}

function clampIntensity(action: LovenseAction, n: number): number {
  return Math.max(0, Math.min(actionMaxIntensity(action), Math.round(n)));
}

function scaleSpec(spec: FunctionActionSpec, scale: number): FunctionActionSpec {
  if (spec.action === 'Stroke' || spec.action === 'Stop') return spec;
  return { ...spec, intensity: clampIntensity(spec.action, spec.intensity * scale) };
}

export const useLovenseStore = create<LovenseState>()(
  persist(
    (set, get) => ({
      uid: '',

      autoReact: false,
      streamLive: false,
      matchWholeWord: false,
      defaultDurationSec: 3,
      hideTagsInChat: true,
      defaultProfile: makeDefaultProfile(),
      profilesByAvatar: {},

      status: 'idle',
      connected: false,
      toys: [],
      platform: null,
      qrUrl: null,
      pairingCode: null,
      error: null,
      isSending: false,
      activeToyId: null,

      // ----- preference actions -----
      setAutoReact: (on) => {
        set({ autoReact: on });
        persistPrefs(get);
      },
      setStreamLive: (on) => {
        set({ streamLive: on });
        persistPrefs(get);
      },
      setMatchWholeWord: (on) => {
        set({ matchWholeWord: on });
        persistPrefs(get);
      },
      setDefaultDurationSec: (n) => {
        // Floor at 1s: 0 would make every keyword/AI reaction run indefinitely
        // (timeSec:0). Indefinite is reserved for the manual quick-control dial.
        set({ defaultDurationSec: Math.max(1, Math.min(600, Math.round(n))) });
        persistPrefs(get);
      },
      setHideTagsInChat: (on) => {
        set({ hideTagsInChat: on });
        persistPrefs(get);
      },
      setActiveToyId: (id) => set({ activeToyId: id }),
      clearError: () => set({ error: null }),

      // ----- profile actions -----
      resolveProfile: (avatar) => {
        const s = get();
        if (avatar && s.profilesByAvatar[avatar]) return s.profilesByAvatar[avatar];
        return s.defaultProfile;
      },
      hasCharacterProfile: (avatar) => !!get().profilesByAvatar[avatar],
      updateProfile: (avatar, patch) => {
        if (avatar == null) {
          set({ defaultProfile: { ...get().defaultProfile, ...patch } });
        } else {
          const current = get().profilesByAvatar[avatar] ?? makeDefaultProfile();
          set({
            profilesByAvatar: {
              ...get().profilesByAvatar,
              [avatar]: { ...current, ...patch },
            },
          });
        }
        persistPrefs(get);
      },
      createCharacterProfile: (avatar) => {
        if (get().profilesByAvatar[avatar]) return;
        // Seed a per-character profile from the current default.
        const seed = get().defaultProfile;
        set({
          profilesByAvatar: {
            ...get().profilesByAvatar,
            [avatar]: {
              ...seed,
              mappings: seed.mappings.map((m) => ({ ...m, id: genId() })),
            },
          },
        });
        persistPrefs(get);
      },
      removeCharacterProfile: (avatar) => {
        const next = { ...get().profilesByAvatar };
        delete next[avatar];
        set({ profilesByAvatar: next });
        persistPrefs(get);
      },
      addMapping: (avatar) => {
        const profile = getProfileForEdit(get, avatar);
        const mappings = [
          ...profile.mappings,
          { id: genId(), keyword: '', action: 'Vibrate' as LovenseAction, intensity: 10 },
        ];
        get().updateProfile(avatar, { mappings });
      },
      updateMapping: (avatar, id, patch) => {
        const profile = getProfileForEdit(get, avatar);
        const mappings = profile.mappings.map((m) => {
          if (m.id !== id) return m;
          const next = { ...m, ...patch };
          next.intensity = clampIntensity(next.action, next.intensity);
          return next;
        });
        get().updateProfile(avatar, { mappings });
      },
      removeMapping: (avatar, id) => {
        const profile = getProfileForEdit(get, avatar);
        get().updateProfile(avatar, { mappings: profile.mappings.filter((m) => m.id !== id) });
      },

      // ----- pairing -----
      generateQr: async () => {
        stopPairingPoll();
        set({
          status: 'generating-qr',
          error: null,
          qrUrl: null,
          pairingCode: null,
          connected: false,
          toys: [],
        });
        try {
          const intent = await apiRequest<{ uid: string }>('/api/lovense/pairing-intent', {
            method: 'POST',
          });
          set({ uid: intent.uid });
          const qr = await apiRequest<{ uid: string; qr: string; code: string | null }>(
            '/api/lovense/qr',
            { method: 'POST' },
          );
          set({ status: 'awaiting-scan', qrUrl: qr.qr, pairingCode: qr.code });

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
          set({ status: 'error', error: err instanceof Error ? err.message : 'QR request failed' });
        }
      },

      checkPairing: async () => {
        try {
          const session = await apiRequest<PairingSession>('/api/lovense/session');
          if (session.status === 'paired') {
            stopPairingPoll();
            set({
              connected: true,
              status: 'connected',
              toys: session.toy_list ?? [],
              platform: session.platform ?? null,
            });
          } else if (session.status === 'pending') {
            set({ connected: false, status: 'awaiting-scan' });
          } else {
            set({ connected: false, toys: [] });
          }
        } catch {
          // Non-fatal: a transient poll failure shouldn't drop the connection.
        }
      },

      unpair: async () => {
        stopPairingPoll();
        // Stop any running toy BEFORE deleting the pairing — once the row is
        // gone the command endpoint 409s ("no paired toy") and the toy is
        // unstoppable from the app.
        try {
          await get().stopAll();
        } catch {
          /* best effort */
        }
        try {
          await apiRequest('/api/lovense/session', { method: 'DELETE' });
        } catch {
          /* best effort */
        }
        set({
          connected: false,
          status: 'idle',
          toys: [],
          qrUrl: null,
          pairingCode: null,
          activeToyId: null,
        });
      },

      // ----- commands -----
      connectedCapabilities: () => {
        const toys = get().toys;
        const set2 = new Set<LovenseAction>();
        if (toys.length === 0) {
          for (const a of capabilitiesForToy(null).actions) set2.add(a);
        } else {
          for (const t of toys) for (const a of capabilitiesForToy(t.name).actions) set2.add(a);
        }
        return LOVENSE_ACTIONS.filter((a) => set2.has(a));
      },

      sendFunction: async (actions, opts) => {
        if (actions.length === 0) return false;
        await throttle();
        set({ isSending: true });
        try {
          const body: Record<string, unknown> = {
            command: 'Function',
            actions: actions.map((a) => ({
              action: a.action,
              intensity: a.intensity,
              ...(a.action === 'Stroke' ? { min: a.min, max: a.max } : {}),
            })),
            durationSec: opts?.durationSec ?? get().defaultDurationSec,
          };
          const toy = opts?.toy ?? get().activeToyId ?? undefined;
          if (toy) body.toy = toy;
          if (opts?.stopPrevious !== undefined) body.stopPrevious = opts.stopPrevious;
          if (opts?.loopRunningSec !== undefined) body.loopRunningSec = opts.loopRunningSec;
          if (opts?.loopPauseSec !== undefined) body.loopPauseSec = opts.loopPauseSec;
          return await postCommand(body, set);
        } finally {
          set({ isSending: false });
        }
      },

      sendPreset: async (name, opts) => {
        await throttle();
        set({ isSending: true });
        try {
          const body: Record<string, unknown> = {
            command: 'Preset',
            name,
            durationSec: opts?.durationSec ?? get().defaultDurationSec,
          };
          const toy = opts?.toy ?? get().activeToyId ?? undefined;
          if (toy) body.toy = toy;
          return await postCommand(body, set);
        } finally {
          set({ isSending: false });
        }
      },

      stopAll: async () => {
        // Stop targets every toy regardless of the active-toy selection.
        _lastCommandAt = 0; // never delay a stop
        set({ isSending: true });
        try {
          await postCommand(
            { command: 'Function', actions: [{ action: 'Stop', intensity: 0 }], durationSec: 0 },
            set,
          );
        } finally {
          set({ isSending: false });
        }
      },

      // ----- reactions -----
      reactToMessage: async (content, avatar, isFinal) => {
        if (!content) return;
        const s = get();
        if (!s.connected) return;
        const profile = s.resolveProfile(avatar);
        if (!profile.reactionEnabled) return;

        const key = _reactKey;
        if (profile.aiControl) {
          // Fire only directives beyond those already fired for this message.
          // Claim the counter SYNCHRONOUSLY (before the first await) so an
          // overlapping streaming tick + finish-edge invocation can't both read
          // the stale count and re-send the same in-flight directive.
          const directives = parseLovenseDirectives(content);
          const start = key.firedDirectives;
          if (start >= directives.length) return;
          _reactKey.firedDirectives = directives.length;
          // Keep the keyword cursor in sync so toggling aiControl off before a
          // Continue doesn't re-scan the already-processed portion.
          _reactKey.scannedLen = content.length;
          for (let i = start; i < directives.length; i++) {
            await executeDirective(get, directives[i], profile.intensityScale);
          }
        } else if (isFinal) {
          // Keyword mode fires once on finish, scanning only unseen content
          // (so Continue reacts to the appended tail, not the whole message).
          const span = content.slice(key.scannedLen);
          _reactKey.scannedLen = content.length;
          // Mirror the directive cursor so a later aiControl toggle doesn't
          // re-fire directives from the portion already handled here.
          _reactKey.firedDirectives = parseLovenseDirectives(content).length;
          await scanKeywords(get, span, profile);
        }
      },

      // ----- lifecycle -----
      fetchPrefs: async () => {
        try {
          const blob = await getSettingsBlob();
          const section = blob[SERVER_KEY] as (Partial<PersistedPrefs> & { _ts?: number }) | undefined;
          const serverTs = Number(section?._ts || 0);
          if (shouldReuploadSection(LOCAL_TS_KEY(), serverTs)) {
            persistPrefs(get);
            return;
          }
          if (section && typeof section === 'object') {
            set(sanitizePrefs(section));
            try {
              recordServerTs(LOCAL_TS_KEY(), serverTs);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* non-fatal — local values remain active */
        }
      },

      initForUser: (handle) => {
        _currentHandle = handle;
        useLovenseStore.persist.rehydrate();
        if (useExtensionStore.getState().enabled['lovense']) {
          void useLovenseStore.getState().checkPairing();
        }
      },
      resetUser: () => {
        _currentHandle = null;
        stopPairingPoll();
        set({
          uid: '',
          autoReact: false,
          streamLive: false,
          matchWholeWord: false,
          defaultDurationSec: 3,
          hideTagsInChat: true,
          defaultProfile: makeDefaultProfile(),
          profilesByAvatar: {},
          status: 'idle',
          connected: false,
          toys: [],
          platform: null,
          qrUrl: null,
          pairingCode: null,
          error: null,
          isSending: false,
          activeToyId: null,
        });
      },
    }),
    {
      name: 'ggbc-lovense',
      version: 2,
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (s) => ({
        uid: s.uid,
        autoReact: s.autoReact,
        streamLive: s.streamLive,
        matchWholeWord: s.matchWholeWord,
        defaultDurationSec: s.defaultDurationSec,
        hideTagsInChat: s.hideTagsInChat,
        defaultProfile: s.defaultProfile,
        profilesByAvatar: s.profilesByAvatar,
      }),
      migrate: (persisted, version) => {
        // v1 stored a flat { mappings, globalIntensityScale }; fold those into
        // the default profile so upgrading users keep their keyword setup.
        if (version < 2 && persisted && typeof persisted === 'object') {
          const p = persisted as Record<string, unknown>;
          const legacyMappings = Array.isArray(p.mappings)
            ? (p.mappings as KeywordMapping[])
            : DEFAULT_MAPPINGS;
          const legacyScale = typeof p.globalIntensityScale === 'number' ? p.globalIntensityScale : 1;
          return {
            ...p,
            defaultProfile: {
              reactionEnabled: true,
              aiControl: false,
              intensityScale: legacyScale,
              mappings: legacyMappings.map((m) => ({
                ...m,
                // v1 used the old "Thrust" name; normalize to "Thrusting".
                action: (m.action as string) === 'Thrust' ? 'Thrusting' : m.action,
              })),
            },
            profilesByAvatar: {},
          };
        }
        return persisted;
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Helpers (module scope — not part of the store interface)
// ---------------------------------------------------------------------------

interface PersistedPrefs {
  autoReact: boolean;
  streamLive: boolean;
  matchWholeWord: boolean;
  defaultDurationSec: number;
  hideTagsInChat: boolean;
  defaultProfile: LovenseProfile;
  profilesByAvatar: Record<string, LovenseProfile>;
}

function persistPrefs(get: () => LovenseState): void {
  const s = get();
  const value: PersistedPrefs = {
    autoReact: s.autoReact,
    streamLive: s.streamLive,
    matchWholeWord: s.matchWholeWord,
    defaultDurationSec: s.defaultDurationSec,
    hideTagsInChat: s.hideTagsInChat,
    defaultProfile: s.defaultProfile,
    profilesByAvatar: s.profilesByAvatar,
  };
  markSectionDirty(LOCAL_TS_KEY());
  patchServerKey(SERVER_KEY, value as unknown as Record<string, unknown>, LOCAL_TS_KEY()).catch(
    () => {},
  );
}

/** Validate one keyword mapping from an untrusted (server/cross-device) blob. */
function sanitizeMapping(raw: unknown): KeywordMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const action = LOVENSE_ACTIONS.includes(m.action as LovenseAction)
    ? (m.action as LovenseAction)
    : 'Vibrate';
  return {
    id: typeof m.id === 'string' ? m.id : genId(),
    keyword: typeof m.keyword === 'string' ? m.keyword : '',
    action,
    intensity: clampIntensity(action, typeof m.intensity === 'number' ? m.intensity : 0),
  };
}

/** Coerce an untrusted profile object into a well-formed LovenseProfile. */
function sanitizeProfile(raw: unknown): LovenseProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const mappings = Array.isArray(p.mappings)
    ? p.mappings.map(sanitizeMapping).filter((m): m is KeywordMapping => m !== null)
    : makeDefaultProfile().mappings;
  return {
    reactionEnabled: typeof p.reactionEnabled === 'boolean' ? p.reactionEnabled : true,
    aiControl: typeof p.aiControl === 'boolean' ? p.aiControl : false,
    intensityScale:
      typeof p.intensityScale === 'number' ? Math.max(0.1, Math.min(2, p.intensityScale)) : 1,
    mappings,
  };
}

/** Coerce a server section into a safe partial state (defensive against a
 *  malformed / partial blob written by another device / client version). */
function sanitizePrefs(section: Partial<PersistedPrefs>): Partial<LovenseState> {
  const out: Partial<LovenseState> = {};
  if (typeof section.autoReact === 'boolean') out.autoReact = section.autoReact;
  if (typeof section.streamLive === 'boolean') out.streamLive = section.streamLive;
  if (typeof section.matchWholeWord === 'boolean') out.matchWholeWord = section.matchWholeWord;
  if (typeof section.defaultDurationSec === 'number')
    out.defaultDurationSec = Math.max(1, Math.min(600, Math.round(section.defaultDurationSec)));
  if (typeof section.hideTagsInChat === 'boolean') out.hideTagsInChat = section.hideTagsInChat;
  const dp = sanitizeProfile(section.defaultProfile);
  if (dp) out.defaultProfile = dp;
  if (section.profilesByAvatar && typeof section.profilesByAvatar === 'object') {
    const clean: Record<string, LovenseProfile> = {};
    for (const [avatar, prof] of Object.entries(section.profilesByAvatar)) {
      const sp = sanitizeProfile(prof);
      if (sp) clean[avatar] = sp;
    }
    out.profilesByAvatar = clean;
  }
  return out;
}

/** The profile object the editor should mutate for a given avatar (creating a
 *  per-character override lazily on first edit; null → the default profile). */
function getProfileForEdit(get: () => LovenseState, avatar: string | null): LovenseProfile {
  if (avatar == null) return get().defaultProfile;
  return get().profilesByAvatar[avatar] ?? get().defaultProfile;
}

async function postCommand(
  body: Record<string, unknown>,
  set: (partial: Partial<LovenseState>) => void,
): Promise<boolean> {
  try {
    const res = await apiRequest<CommandResult>('/api/lovense/command', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.result) {
      set({ error: null });
    } else {
      set({ error: res.message ? `Lovense: ${res.message}` : 'Command rejected' });
    }
    return res.result;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : 'Command failed' });
    return false;
  }
}

async function executeDirective(
  get: () => LovenseState,
  dir: LovenseDirective,
  scale: number,
): Promise<void> {
  if (dir.kind === 'stop') {
    await get().stopAll();
    return;
  }
  if (dir.kind === 'preset') {
    await get().sendPreset(dir.name, { durationSec: dir.durationSec });
    return;
  }
  const scaled = dir.actions.map((a) => scaleSpec(a, scale));
  await get().sendFunction(scaled, { durationSec: dir.durationSec });
}

function matchesKeyword(haystack: string, keyword: string, wholeWord: boolean): boolean {
  if (!wholeWord) return haystack.includes(keyword);
  // Word-boundary match, escaping regex metacharacters in the keyword.
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(haystack);
}

async function scanKeywords(
  get: () => LovenseState,
  text: string,
  profile: LovenseProfile,
): Promise<void> {
  const haystack = text.toLowerCase();
  const wholeWord = get().matchWholeWord;
  // Collapse per action, keeping the strongest intensity.
  const strongest = new Map<LovenseAction, number>();
  for (const m of profile.mappings) {
    const kw = m.keyword.trim().toLowerCase();
    if (!kw || !matchesKeyword(haystack, kw, wholeWord)) continue;
    const scaled = clampIntensity(m.action, m.intensity * profile.intensityScale);
    const prev = strongest.get(m.action) ?? -1;
    if (scaled > prev) strongest.set(m.action, scaled);
  }
  if (strongest.size === 0) return;
  const actions: FunctionActionSpec[] = [...strongest.entries()].map(([action, intensity]) => ({
    action,
    intensity,
  }));
  await get().sendFunction(actions);
}

// ---------------------------------------------------------------------------
// Reaction bookkeeping: one entry per (message id + swipe id). Firing is
// idempotent within a message — directives fire once each (so streaming ticks
// and the final scan don't double-drive), and keyword scanning only sees
// content it hasn't scanned yet (Continue reacts to the appended tail).
// ---------------------------------------------------------------------------

const _reactKey = { key: '', firedDirectives: 0, scannedLen: 0 };

function ensureReactKey(id: string, swipeId: number): void {
  const key = `${id}#${swipeId}`;
  if (_reactKey.key !== key) {
    _reactKey.key = key;
    _reactKey.firedDirectives = 0;
    _reactKey.scannedLen = 0;
  }
}

// ---------------------------------------------------------------------------
// Wiring into the chat store.
//
// Two triggers, both module-level so a re-render never adds a second listener:
//   • streaming ticks — while a message streams, if streamLive + aiControl,
//     fire any newly-completed `[lovense: ...]` directives (throttled).
//   • finish edge — when isStreaming flips false, run the final reaction
//     (remaining directives, or a keyword scan).
// Fully gated: the extension must be enabled, autoReact on, and a toy reachable.
// ---------------------------------------------------------------------------

function activeReactionMessage(state: ReturnType<typeof useChatStore.getState>) {
  const msgs = state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isUser || m.isSystem) continue;
    return m;
  }
  return null;
}

let _prevStreaming = false;
let _lastLiveReactAt = 0;
// The reaction target message captured when streaming began, so we only react
// to a message that actually GREW during this stream. This is what
// distinguishes a real reply/continue/swipe (content grows) from Impersonate
// (streams into the input box, leaving the last AI message untouched) — the
// latter must never buzz the toy.
let _streamStart: { id: string; swipeId: number; len: number } | null = null;

useChatStore.subscribe((state) => {
  const streaming = state.isStreaming;
  const wasStreaming = _prevStreaming;
  _prevStreaming = streaming;

  // Capture the stream-start snapshot on the false→true edge, before any gate,
  // so the growth check below is always valid.
  if (streaming && !wasStreaming) {
    const m = activeReactionMessage(state);
    _streamStart = m ? { id: m.id, swipeId: m.swipeId, len: m.content.length } : null;
  }

  if (!useExtensionStore.getState().enabled['lovense']) return;
  const lovense = useLovenseStore.getState();
  if (!lovense.autoReact || !lovense.connected) return;

  const msg = activeReactionMessage(state);
  if (!msg) return;
  const avatar = msg.characterAvatar ?? null;

  // Growth gate: react only to the message that grew during THIS stream. Skips
  // Impersonate (last AI message unchanged) and empty generations.
  const grew =
    !!_streamStart &&
    msg.id === _streamStart.id &&
    msg.swipeId === _streamStart.swipeId &&
    msg.content.length > _streamStart.len;
  if (!grew) return;

  // Streaming tick: live AI-directive control (throttled) for aiControl chars.
  if (streaming && lovense.streamLive) {
    const profile = lovense.resolveProfile(avatar);
    if (profile.aiControl && profile.reactionEnabled && hasLovenseTag(msg.content)) {
      const now = Date.now();
      if (now - _lastLiveReactAt >= 120) {
        _lastLiveReactAt = now;
        ensureReactKey(msg.id, msg.swipeId);
        void lovense.reactToMessage(msg.content, avatar, false);
      }
    }
    return;
  }

  // Finish edge: run the final reaction once.
  const finished = wasStreaming && !streaming;
  if (!finished) return;
  ensureReactKey(msg.id, msg.swipeId);
  void lovense.reactToMessage(msg.content, avatar, true);
});

// Safety: if the user disables the Lovense extension while a toy is running,
// stop it (disabling also unmounts the quick control, removing the STOP button).
let _prevEnabled = useExtensionStore.getState().enabled['lovense'] ?? false;
useExtensionStore.subscribe((state) => {
  const enabled = state.enabled['lovense'] ?? false;
  if (_prevEnabled && !enabled) {
    const lovense = useLovenseStore.getState();
    if (lovense.connected) void lovense.stopAll();
  }
  _prevEnabled = enabled;
});
