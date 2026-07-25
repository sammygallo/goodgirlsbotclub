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
  planFunctionCommands,
  planTargets,
  hasLovenseTag,
  type LovenseAction,
  type LovensePreset,
  type FunctionActionSpec,
  type LovenseDirective,
  type PlannedCommand,
  type TargetedActions,
  type ToyPref,
  type ToyRef,
} from '../utils/lovense';
import { useChatStore } from './chatStore';
import { useExtensionStore } from './extensionStore';

// ---------------------------------------------------------------------------
// Lovense device control store (v3)
//
// A GGBC-native implementation of Lovense connectivity. Everything goes through
// the GGBC backend proxy — the browser never calls the Lovense API directly (no
// CORS) and the app-level developer token stays server-side:
//
//   1. POST /api/lovense/pairing-intent -> backend mints an opaque `uid` and
//      returns the pairing row it belongs to.
//   2. POST /api/lovense/qr             -> backend proxies getQrCode.
//   3. The user scans; Lovense calls /api/lovense/callback, flipping to "paired".
//   4. GET  /api/lovense/session        -> poll for the pairing list + toys.
//   5. POST /api/lovense/command(s)     -> backend proxies one / several
//      Function/Preset commands, injecting token + uid(s).
//
// v2 added: the full documented action set (fixing Thrust→Thrusting), per-toy
// capability detection, per-character control profiles, AI-driven control via
// `[lovense: ...]` directives, and streaming vs. finish reactions.
//
// v3 adds MULTIPLE PAIRINGS and true multi-toy control. A user can scan several
// Lovense apps; every toy across them is individually addressable (`@lush`), and
// one directive is planned into the set of commands that drives every applicable
// toy at once — each toy receiving only the functions it actually has. The whole
// plan goes out as ONE request so the toys move together instead of being
// serialized behind the client send throttle.
// ---------------------------------------------------------------------------

export {
  LOVENSE_ACTIONS,
  SIMPLE_ACTIONS,
  LOVENSE_PRESETS,
  actionMaxIntensity,
  capabilitiesForToy,
  toyDisplayName,
  assignToyHandles,
} from '../utils/lovense';
export type { LovenseAction, LovensePreset, ToyRef } from '../utils/lovense';

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

/** Matches MAX_BATCH_COMMANDS on the backend. */
const MAX_BATCH_COMMANDS = 24;

/** Shown only when the caller NAMED a toy that isn't there — an untargeted
 *  command that matches nothing (every toy muted, or none supports the
 *  function) is a no-op the user already chose, not an error worth reporting. */
const NO_MATCH = 'No connected toy matched that command';

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
  /** Which pairing this toy is attached to — toy ids are only unique within one. */
  pairingId: string;
  name?: string | null;
  nickname?: string | null;
  status?: string | null;
  battery?: number | null;
}

/** One paired Lovense app and the toys attached to it. */
export interface LovensePairingInfo {
  id: string;
  label: string | null;
  status: 'pending' | 'paired';
  platform: string | null;
  toys: LovenseToy[];
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

/** Shape of one pairing in GET /api/lovense/session. */
interface PairingPayload {
  id: string;
  label?: string | null;
  status?: string | null;
  platform?: string | null;
  toy_list?: LovenseToy[] | null;
}

/** Shape of GET /api/lovense/session. `pairings` is the multi-pairing view;
 *  the flat fields are the pre-multi-pairing aggregate, kept for compatibility. */
interface PairingSession {
  status: 'none' | 'pending' | 'paired';
  toys?: unknown | null;
  toy_list?: LovenseToy[] | null;
  platform?: string | null;
  pairings?: PairingPayload[] | null;
}

/** One command's outcome within a fan-out. */
interface CommandResultDetail {
  result: boolean;
  message: string | null;
  code?: number | null;
  pairing_id?: string | null;
  toy?: string[] | null;
}

interface CommandResult {
  result: boolean;
  message: string | null;
  code?: number | null;
  results?: CommandResultDetail[] | null;
}

interface SendOptions {
  durationSec?: number;
  /** Target tokens — a toy id, `@handle`, nickname, or 1-based index.
   *  null/omitted targets every applicable toy. */
  targets?: string[] | null;
  stopPrevious?: boolean;
  loopRunningSec?: number;
  loopPauseSec?: number;
}

interface LovenseState {
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
  /** Per-toy mute + intensity trim, keyed by toy id. Roams: toy ids are the
   *  hardware's, so they mean the same thing on every device. */
  toyPrefs: Record<string, ToyPref>;

  // --- session state (transient) ---
  status: ConnectionStatus;
  connected: boolean;
  pairings: LovensePairingInfo[];
  /** Every toy across every paired app, flattened. */
  toys: LovenseToy[];
  platform: string | null;
  qrUrl: string | null;
  pairingCode: string | null;
  /** Which pairing the on-screen QR belongs to. */
  qrPairingId: string | null;
  error: string | null;
  isSending: boolean;
  /** Toys the manual/quick controls target; empty = all toys. */
  activeToyIds: string[];

  // --- preference actions ---
  setAutoReact: (on: boolean) => void;
  setStreamLive: (on: boolean) => void;
  setMatchWholeWord: (on: boolean) => void;
  setDefaultDurationSec: (n: number) => void;
  setHideTagsInChat: (on: boolean) => void;
  setActiveToyIds: (ids: string[]) => void;
  toggleActiveToy: (id: string) => void;
  setToyPref: (toyId: string, patch: Partial<ToyPref>) => void;
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
  /** Start (or re-start) a scan. Pass a pairing id to re-scan that one in
   *  place; omit it to add a pairing alongside the ones already connected. */
  generateQr: (pairingId?: string) => Promise<void>;
  cancelQr: () => void;
  checkPairing: () => Promise<void>;
  renamePairing: (pairingId: string, label: string) => Promise<void>;
  unpairOne: (pairingId: string) => Promise<void>;
  unpair: () => Promise<void>;

  // --- commands ---
  /** Toys in the shape the targeting/planning helpers want. */
  toyRefs: () => ToyRef[];
  sendFunction: (actions: FunctionActionSpec[], opts?: SendOptions) => Promise<boolean>;
  /** Drive several toys with different functions in one go. */
  sendGroups: (groups: TargetedActions[], opts?: SendOptions) => Promise<boolean>;
  sendPreset: (name: LovensePreset, opts?: SendOptions) => Promise<boolean>;
  /** Stop the named toys (null = every toy on every pairing). */
  stopTargets: (targets: string[] | null) => Promise<void>;
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

// Pairing poll — module-level so a re-render never spawns a second poller. One
// poller is still enough with several pairings: /session returns all of them.
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TICKS = 100; // ~5 minutes

function stopPairingPoll(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// Soft throttle so a burst of reaction directives doesn't hammer the toys. One
// tick covers a whole fan-out, because the entire plan is posted as a single
// request — N toys never cost N throttle waits.
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

export const useLovenseStore = create<LovenseState>()(
  persist(
    (set, get) => ({
      autoReact: false,
      streamLive: false,
      matchWholeWord: false,
      defaultDurationSec: 3,
      hideTagsInChat: true,
      defaultProfile: makeDefaultProfile(),
      profilesByAvatar: {},
      toyPrefs: {},

      status: 'idle',
      connected: false,
      pairings: [],
      toys: [],
      platform: null,
      qrUrl: null,
      pairingCode: null,
      qrPairingId: null,
      error: null,
      isSending: false,
      activeToyIds: [],

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
      setActiveToyIds: (ids) => set({ activeToyIds: [...new Set(ids)] }),
      toggleActiveToy: (id) => {
        const current = get().activeToyIds;
        set({
          activeToyIds: current.includes(id)
            ? current.filter((x) => x !== id)
            : [...current, id],
        });
      },
      setToyPref: (toyId, patch) => {
        const current = get().toyPrefs[toyId] ?? {};
        const next: ToyPref = { ...current, ...patch };
        if (next.scale !== undefined) next.scale = Math.max(0.1, Math.min(2, next.scale));
        set({ toyPrefs: { ...get().toyPrefs, [toyId]: next } });
        persistPrefs(get);
      },
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
      generateQr: async (pairingId) => {
        stopPairingPoll();
        // Re-scanning an already-paired app mints a new uid on that row and
        // marks it pending, which makes its toys unreachable from /command —
        // including Stop. So stop them FIRST, exactly as unpairOne does before
        // deleting a row. Without this, re-scanning while the quick-control
        // dial is running (durationSec: 0 — indefinite) strands a toy with no
        // reachable STOP until the new scan completes.
        const rescanning = pairingId
          ? get().pairings.find((p) => p.id === pairingId && p.status === 'paired')
          : undefined;
        if (rescanning && rescanning.toys.length > 0) {
          try {
            await get().stopTargets(rescanning.toys.map((t) => t.id));
          } catch {
            /* best effort — never block the re-scan on it */
          }
        }
        // Deliberately does NOT clear `connected`/`toys`/`pairings`: adding a
        // second toy must not black out the one already running.
        set({
          status: 'generating-qr',
          error: null,
          qrUrl: null,
          pairingCode: null,
          qrPairingId: null,
        });
        try {
          const intent = await apiRequest<{ uid: string; pairing_id: string }>(
            '/api/lovense/pairing-intent',
            {
              method: 'POST',
              body: JSON.stringify(pairingId ? { pairingId } : {}),
            },
          );
          const qr = await apiRequest<{ qr: string; code: string | null }>('/api/lovense/qr', {
            method: 'POST',
            body: JSON.stringify({ pairingId: intent.pairing_id }),
          });
          set({
            status: 'awaiting-scan',
            qrUrl: qr.qr,
            pairingCode: qr.code,
            qrPairingId: intent.pairing_id,
          });

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

      cancelQr: () => {
        stopPairingPoll();
        set({
          qrUrl: null,
          pairingCode: null,
          qrPairingId: null,
          status: get().connected ? 'connected' : 'idle',
        });
      },

      checkPairing: async () => {
        try {
          const session = await apiRequest<PairingSession>('/api/lovense/session');
          const pairings = pairingsFromSession(session);
          const paired = pairings.filter((p) => p.status === 'paired');
          const toys = paired.flatMap((p) => p.toys);
          const connected = paired.length > 0;

          // The scan we're waiting on has landed → drop the QR and stop polling.
          const waitingFor = get().qrPairingId;
          const scanned =
            waitingFor !== null &&
            pairings.some((p) => p.id === waitingFor && p.status === 'paired');
          if (scanned) stopPairingPoll();
          const stillWaiting = waitingFor !== null && !scanned;

          const liveIds = new Set(toys.map((t) => t.id));
          set({
            pairings,
            toys,
            connected,
            platform: paired[0]?.platform ?? null,
            status: stillWaiting ? 'awaiting-scan' : connected ? 'connected' : 'idle',
            // Don't leave the manual controls pointed at a toy that went away.
            activeToyIds: get().activeToyIds.filter((id) => liveIds.has(id)),
            ...(scanned ? { qrUrl: null, pairingCode: null, qrPairingId: null } : {}),
          });
        } catch {
          // Non-fatal: a transient poll failure shouldn't drop the connection.
        }
      },

      renamePairing: async (pairingId, label) => {
        try {
          await apiRequest(`/api/lovense/pairings/${encodeURIComponent(pairingId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ label }),
          });
          set({
            pairings: get().pairings.map((p) =>
              p.id === pairingId ? { ...p, label: label.trim() || null } : p,
            ),
          });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Rename failed' });
        }
      },

      unpairOne: async (pairingId) => {
        // Stop this pairing's toys BEFORE deleting the row — once it's gone the
        // command endpoint can no longer reach them and they'd run on forever.
        const toys = get().pairings.find((p) => p.id === pairingId)?.toys ?? [];
        if (toys.length > 0) {
          try {
            await get().stopTargets(toys.map((t) => t.id));
          } catch {
            /* best effort */
          }
        }
        try {
          await apiRequest(`/api/lovense/pairings/${encodeURIComponent(pairingId)}`, {
            method: 'DELETE',
          });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Unpair failed' });
        }
        if (get().qrPairingId === pairingId) {
          stopPairingPoll();
          set({ qrUrl: null, pairingCode: null, qrPairingId: null });
        }
        await get().checkPairing();
      },

      unpair: async () => {
        stopPairingPoll();
        // Stop every running toy BEFORE deleting the pairings — once the rows
        // are gone the command endpoint 409s ("no paired toy") and the toys are
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
          pairings: [],
          toys: [],
          qrUrl: null,
          pairingCode: null,
          qrPairingId: null,
          activeToyIds: [],
        });
      },

      // ----- commands -----
      toyRefs: () => {
        const labels = new Map(get().pairings.map((p) => [p.id, p.label]));
        return get().toys.map((t) => ({
          id: t.id,
          pairingId: t.pairingId,
          name: t.name,
          nickname: t.nickname,
          pairingLabel: labels.get(t.pairingId) ?? null,
        }));
      },

      connectedCapabilities: () => {
        const toys = get().toys;
        const seen = new Set<LovenseAction>();
        if (toys.length === 0) {
          for (const a of capabilitiesForToy(null).actions) seen.add(a);
        } else {
          for (const t of toys) for (const a of capabilitiesForToy(t.name).actions) seen.add(a);
        }
        return LOVENSE_ACTIONS.filter((a) => seen.has(a));
      },

      sendFunction: async (actions, opts) =>
        get().sendGroups([{ targets: opts?.targets ?? null, actions }], opts),

      sendGroups: async (groups, opts) => {
        if (groups.length === 0) return false;
        const planned = planFunctionCommands(groups, get().toyRefs(), {
          toyPrefs: get().toyPrefs,
        });
        if (planned.length === 0) {
          if (groups.some((g) => g.targets !== null)) set({ error: NO_MATCH });
          return false;
        }
        return sendPlanned(get, set, planned, opts);
      },

      sendPreset: async (name, opts) => {
        const plans = planTargets(opts?.targets ?? null, get().toyRefs(), {
          toyPrefs: get().toyPrefs,
        });
        if (plans.length === 0) {
          if (opts?.targets) set({ error: NO_MATCH });
          return false;
        }
        await throttle();
        set({ isSending: true });
        try {
          return await postCommands(
            plans.map((p) => ({
              command: 'Preset',
              name,
              durationSec: opts?.durationSec ?? get().defaultDurationSec,
              ...(p.pairingId ? { pairingId: p.pairingId } : {}),
              ...(p.toy ? { toy: p.toy } : {}),
            })),
            set,
          );
        } finally {
          set({ isSending: false });
        }
      },

      stopTargets: async (targets) => {
        // `ignorePrefs` so a toy the user muted is still stoppable — a mute must
        // never be able to strand a running toy.
        const plans = planTargets(targets, get().toyRefs(), { ignorePrefs: true });
        if (plans.length === 0) return;
        _lastCommandAt = 0; // never delay a stop
        set({ isSending: true });
        try {
          await postCommands(
            plans.map((p) => ({
              command: 'Function',
              actions: [{ action: 'Stop', intensity: 0 }],
              durationSec: 0,
              ...(p.pairingId ? { pairingId: p.pairingId } : {}),
              ...(p.toy ? { toy: p.toy } : {}),
            })),
            set,
          );
        } finally {
          set({ isSending: false });
        }
      },

      stopAll: async () => {
        await get().stopTargets(null);
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
          // the stale count and re-send the same in-flight directive. The whole
          // fan-out for a directive happens inside one cursor advance.
          const directives = parseLovenseDirectives(content, s.toyRefs());
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
          _reactKey.firedDirectives = parseLovenseDirectives(content, s.toyRefs()).length;
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
          autoReact: false,
          streamLive: false,
          matchWholeWord: false,
          defaultDurationSec: 3,
          hideTagsInChat: true,
          defaultProfile: makeDefaultProfile(),
          profilesByAvatar: {},
          toyPrefs: {},
          status: 'idle',
          connected: false,
          pairings: [],
          toys: [],
          platform: null,
          qrUrl: null,
          pairingCode: null,
          qrPairingId: null,
          error: null,
          isSending: false,
          activeToyIds: [],
        });
      },
    }),
    {
      name: 'ggbc-lovense',
      version: 2,
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (s) => ({
        autoReact: s.autoReact,
        streamLive: s.streamLive,
        matchWholeWord: s.matchWholeWord,
        defaultDurationSec: s.defaultDurationSec,
        hideTagsInChat: s.hideTagsInChat,
        defaultProfile: s.defaultProfile,
        profilesByAvatar: s.profilesByAvatar,
        toyPrefs: s.toyPrefs,
      }),
      migrate: (persisted, version) => {
        // v1 stored a flat { mappings, globalIntensityScale }; fold those into
        // the default profile so upgrading users keep their keyword setup.
        // (v3 added `toyPrefs` and dropped the never-read `uid`, neither of
        // which needs a version bump: a missing key falls back to its default
        // and a stale one is ignored by partialize.)
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
  toyPrefs: Record<string, ToyPref>;
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
    toyPrefs: s.toyPrefs,
  };
  markSectionDirty(LOCAL_TS_KEY());
  patchServerKey(SERVER_KEY, value as unknown as Record<string, unknown>, LOCAL_TS_KEY()).catch(
    () => {},
  );
}

/** Normalize GET /session into the pairing list.
 *
 *  Falls back to synthesizing a single pairing from the flat fields, so a
 *  backend that predates multi-pairing (or a response cached from one) still
 *  drives the toy instead of showing "not connected". */
function pairingsFromSession(session: PairingSession): LovensePairingInfo[] {
  if (Array.isArray(session.pairings) && session.pairings.length > 0) {
    return session.pairings.map((p) => ({
      id: p.id,
      label: p.label ?? null,
      status: p.status === 'paired' ? 'paired' : 'pending',
      platform: p.platform ?? null,
      toys: (p.toy_list ?? []).map((t) => ({ ...t, pairingId: p.id })),
    }));
  }
  if (session.status === 'none') return [];
  const id = LEGACY_PAIRING_ID;
  return [
    {
      id,
      label: null,
      status: session.status === 'paired' ? 'paired' : 'pending',
      platform: session.platform ?? null,
      toys: (session.toy_list ?? []).map((t) => ({ ...t, pairingId: id })),
    },
  ];
}

/** Stand-in id for the single pairing an older backend reports. Never sent as
 *  a `pairingId` (such a backend ignores the field anyway), it only keys the
 *  client-side grouping. */
const LEGACY_PAIRING_ID = 'default';

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
  if (section.toyPrefs && typeof section.toyPrefs === 'object') {
    const clean: Record<string, ToyPref> = {};
    for (const [toyId, raw] of Object.entries(section.toyPrefs)) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      clean[toyId] = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
        scale: typeof p.scale === 'number' ? Math.max(0.1, Math.min(2, p.scale)) : 1,
      };
    }
    out.toyPrefs = clean;
  }
  return out;
}

/** The profile object the editor should mutate for a given avatar (creating a
 *  per-character override lazily on first edit; null → the default profile). */
function getProfileForEdit(get: () => LovenseState, avatar: string | null): LovenseProfile {
  if (avatar == null) return get().defaultProfile;
  return get().profilesByAvatar[avatar] ?? get().defaultProfile;
}

/** A pairing id worth sending — the synthetic legacy one means "unknown". */
function wireP(pairingId: string | null): string | undefined {
  return pairingId && pairingId !== LEGACY_PAIRING_ID ? pairingId : undefined;
}

/** POST a set of commands and fold the reply into the store's error state.
 *
 *  One command goes to /command (the endpoint every backend version has);
 *  several go to /commands, which fans them out concurrently server-side. That
 *  split also means a single-toy user never depends on the newer endpoint. */
async function postCommands(
  commands: Record<string, unknown>[],
  set: (partial: Partial<LovenseState>) => void,
): Promise<boolean> {
  if (commands.length === 0) return false;
  let batch = commands;
  if (batch.length > MAX_BATCH_COMMANDS) {
    batch = batch.slice(0, MAX_BATCH_COMMANDS);
    set({ error: `Too many toys to drive at once — only the first ${MAX_BATCH_COMMANDS} were sent` });
  }
  try {
    const single = batch.length === 1;
    const res = await apiRequest<CommandResult>(
      single ? '/api/lovense/command' : '/api/lovense/commands',
      {
        method: 'POST',
        body: JSON.stringify(single ? batch[0] : { commands: batch }),
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
  }
}

/** Send a planned Function fan-out as one request. */
async function sendPlanned(
  get: () => LovenseState,
  set: (partial: Partial<LovenseState>) => void,
  planned: PlannedCommand[],
  opts?: SendOptions,
): Promise<boolean> {
  await throttle();
  set({ isSending: true });
  try {
    return await postCommands(
      planned.map((p) => ({
        command: 'Function',
        actions: p.actions.map((a) => ({
          action: a.action,
          intensity: a.intensity,
          ...(a.action === 'Stroke' ? { min: a.min, max: a.max } : {}),
        })),
        durationSec: opts?.durationSec ?? get().defaultDurationSec,
        ...(wireP(p.pairingId) ? { pairingId: wireP(p.pairingId) } : {}),
        ...(p.toy ? { toy: p.toy } : {}),
        ...(opts?.stopPrevious !== undefined ? { stopPrevious: opts.stopPrevious } : {}),
        ...(opts?.loopRunningSec !== undefined ? { loopRunningSec: opts.loopRunningSec } : {}),
        ...(opts?.loopPauseSec !== undefined ? { loopPauseSec: opts.loopPauseSec } : {}),
      })),
      set,
    );
  } finally {
    set({ isSending: false });
  }
}

async function executeDirective(
  get: () => LovenseState,
  dir: LovenseDirective,
  scale: number,
): Promise<void> {
  if (dir.kind === 'stop') {
    await get().stopTargets(dir.targets);
    return;
  }
  if (dir.kind === 'preset') {
    await get().sendPreset(dir.name, { targets: dir.targets, durationSec: dir.durationSec });
    return;
  }
  // Plan here (not in sendGroups) so the character's intensity scale is folded
  // in alongside the per-toy trims before the toys are grouped by action set.
  const planned = planFunctionCommands(dir.groups, get().toyRefs(), {
    scale,
    toyPrefs: get().toyPrefs,
  });
  if (planned.length === 0) return;
  await sendPlanned(get, useLovenseStore.setState, planned, { durationSec: dir.durationSec });
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
  // Untargeted: the planner gives every toy the subset of these it supports.
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
// Reaches every pairing, since stopAll is untargeted.
let _prevEnabled = useExtensionStore.getState().enabled['lovense'] ?? false;
useExtensionStore.subscribe((state) => {
  const enabled = state.enabled['lovense'] ?? false;
  if (_prevEnabled && !enabled) {
    const lovense = useLovenseStore.getState();
    if (lovense.connected) void lovense.stopAll();
  }
  _prevEnabled = enabled;
});
