/* eslint-disable react-refresh/only-export-components -- builtin extension file:
   registers its manifest as a module side-effect and defines its settings-panel
   components inline, the same pattern as the other builtins. */
import { useEffect, useMemo, useState } from 'react';
import { Vibrate, Loader2, Plus, Trash2, Square, BatteryMedium, Unplug, Bot } from 'lucide-react';
import { extensionRegistry } from '../registry';
import { registerCommand } from '../../utils/stscript/registry';
import {
  useLovenseStore,
  LOVENSE_PRESETS,
  SIMPLE_ACTIONS,
  actionMaxIntensity,
  capabilitiesForToy,
  toyDisplayName,
  type LovenseAction,
  type LovenseProfile,
} from '../../stores/lovenseStore';
import { useCharacterStore } from '../../stores/characterStore';
import {
  parseLovenseDirectives,
  buildAiControlInstruction,
  unionCapabilities,
} from '../../utils/lovense';
import type { ExtensionManifest, ContextBuildEvent, ContextContribution } from '../types';

const inputClass =
  'px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]';
const labelClass =
  'flex items-center justify-between text-xs text-[var(--color-text-secondary)]';
const btnClass =
  'px-3 py-1.5 text-xs rounded bg-[var(--color-primary)] text-white disabled:opacity-50 hover:opacity-90 transition-opacity';
const sectionTitle = 'text-xs font-medium text-[var(--color-text-primary)]';

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
        on ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function StatusPill() {
  const status = useLovenseStore((s) => s.status);
  const connected = useLovenseStore((s) => s.connected);
  const label = connected
    ? 'Connected'
    : status === 'awaiting-scan'
      ? 'Awaiting scan'
      : status === 'generating-qr'
        ? 'Generating QR…'
        : status === 'error'
          ? 'Error'
          : 'Not connected';
  const color = connected
    ? 'bg-green-500/20 text-green-400'
    : status === 'error'
      ? 'bg-red-500/20 text-red-400'
      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] ${color}`}>{label}</span>;
}

// --- Pairing + toy list ----------------------------------------------------

function ToyList() {
  const toys = useLovenseStore((s) => s.toys);
  if (toys.length === 0) return null;
  return (
    <div className="space-y-1">
      {toys.map((t) => {
        const cap = capabilitiesForToy(t.name);
        return (
          <div
            key={t.id}
            className="flex items-center justify-between gap-2 p-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]/40 text-xs"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[var(--color-text-primary)]">
                <Vibrate size={12} className="flex-shrink-0" />
                <span className="truncate">
                  {t.nickname || toyDisplayName(t.name)}
                  {t.nickname ? (
                    <span className="text-[var(--color-text-secondary)]"> · {toyDisplayName(t.name)}</span>
                  ) : null}
                </span>
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                {cap.actions.filter((a) => a !== 'All' && a !== 'Stop').join(', ')}
                {!cap.known && ' (unrecognized — showing common functions)'}
              </div>
            </div>
            {typeof t.battery === 'number' && t.battery >= 0 && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] flex-shrink-0">
                <BatteryMedium size={12} /> {t.battery}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PairingSection() {
  const qrUrl = useLovenseStore((s) => s.qrUrl);
  const pairingCode = useLovenseStore((s) => s.pairingCode);
  const status = useLovenseStore((s) => s.status);
  const connected = useLovenseStore((s) => s.connected);
  const generateQr = useLovenseStore((s) => s.generateQr);
  const checkPairing = useLovenseStore((s) => s.checkPairing);
  const unpair = useLovenseStore((s) => s.unpair);

  useEffect(() => {
    void checkPairing();
  }, [checkPairing]);

  return (
    <div className="space-y-2">
      <div className={labelClass}>
        <span>Device pairing</span>
        <StatusPill />
      </div>
      {!connected && (
        <button
          type="button"
          onClick={() => generateQr()}
          disabled={status === 'generating-qr'}
          className={btnClass}
        >
          {status === 'generating-qr' ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Generating…
            </span>
          ) : (
            'Generate pairing QR'
          )}
        </button>
      )}
      {qrUrl && !connected && (
        <div className="flex flex-col items-center gap-2 p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]/40">
          <img src={qrUrl} alt="Lovense pairing QR" className="w-40 h-40 rounded bg-white p-1" />
          <p className="text-[10px] text-[var(--color-text-secondary)] text-center">
            Scan with the Lovense Remote app to link your toy.
            {pairingCode && <span className="block">Code: {pairingCode}</span>}
          </p>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
            <Loader2 size={11} className="animate-spin" /> Waiting for you to scan…
          </div>
          <button type="button" onClick={() => checkPairing()} className={btnClass}>
            Check now
          </button>
        </div>
      )}
      {connected && (
        <>
          <ToyList />
          <button
            type="button"
            onClick={() => unpair()}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
          >
            <Unplug size={12} /> Unpair
          </button>
        </>
      )}
    </div>
  );
}

// --- Per-character profile editor ------------------------------------------

function MappingRow({
  avatar,
  mapping,
}: {
  avatar: string | null;
  mapping: { id: string; keyword: string; action: LovenseAction; intensity: number };
}) {
  const updateMapping = useLovenseStore((s) => s.updateMapping);
  const removeMapping = useLovenseStore((s) => s.removeMapping);
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        placeholder="keyword"
        value={mapping.keyword}
        onChange={(e) => updateMapping(avatar, mapping.id, { keyword: e.target.value })}
        className={`${inputClass} flex-1 min-w-0`}
      />
      <select
        value={mapping.action}
        onChange={(e) => updateMapping(avatar, mapping.id, { action: e.target.value as LovenseAction })}
        className={inputClass}
      >
        {SIMPLE_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        max={actionMaxIntensity(mapping.action)}
        value={mapping.intensity}
        onChange={(e) =>
          updateMapping(avatar, mapping.id, { intensity: parseInt(e.target.value, 10) || 0 })
        }
        className={`${inputClass} w-12 text-center`}
      />
      <button
        type="button"
        onClick={() => removeMapping(avatar, mapping.id)}
        className="p-1 text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
        aria-label="Remove mapping"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ProfileEditor() {
  const characters = useCharacterStore((s) => s.characters);
  const selectedCharacter = useCharacterStore((s) => s.selectedCharacter);
  const [avatar, setAvatar] = useState<string | null>(selectedCharacter?.avatar ?? null);

  const profilesByAvatar = useLovenseStore((s) => s.profilesByAvatar);
  const defaultProfile = useLovenseStore((s) => s.defaultProfile);
  const updateProfile = useLovenseStore((s) => s.updateProfile);
  const createCharacterProfile = useLovenseStore((s) => s.createCharacterProfile);
  const removeCharacterProfile = useLovenseStore((s) => s.removeCharacterProfile);
  const addMapping = useLovenseStore((s) => s.addMapping);

  const isCustom = avatar != null && !!profilesByAvatar[avatar];
  const profile: LovenseProfile = avatar == null ? defaultProfile : profilesByAvatar[avatar] ?? defaultProfile;
  const editingScope: string | null = avatar; // null = default
  const editable = avatar == null || isCustom;

  return (
    <div className="space-y-2">
      <div className={sectionTitle}>Character behavior</div>
      <select
        value={avatar ?? ''}
        onChange={(e) => setAvatar(e.target.value || null)}
        className={`${inputClass} w-full`}
      >
        <option value="">Default (all characters)</option>
        {characters.map((c) => (
          <option key={c.avatar} value={c.avatar}>
            {c.name}
            {profilesByAvatar[c.avatar] ? ' ★' : ''}
          </option>
        ))}
      </select>

      {avatar != null && !isCustom && (
        <div className="flex items-center justify-between gap-2 p-2 rounded border border-dashed border-[var(--color-border)] text-[10px] text-[var(--color-text-secondary)]">
          <span>Using the default behavior.</span>
          <button
            type="button"
            onClick={() => createCharacterProfile(avatar)}
            className="text-[var(--color-primary)] hover:opacity-80 flex items-center gap-1"
          >
            <Plus size={11} /> Customize
          </button>
        </div>
      )}

      <div className={`space-y-2 ${editable ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className={labelClass}>
          <span>React to this character&apos;s messages</span>
          <Toggle
            on={profile.reactionEnabled}
            onClick={() => updateProfile(editingScope, { reactionEnabled: !profile.reactionEnabled })}
          />
        </div>

        <div className={labelClass}>
          <span className="flex-1">
            AI-driven control
            <span className="block text-[10px] text-[var(--color-text-secondary)]/60 mt-0.5">
              Let the character control the toy with inline directives like
              <code className="mx-1">[lovense: vibrate 15 for 5s]</code>. Multiple functions
              can be combined in one directive (e.g.
              <code className="mx-1">[lovense: thrusting 15, depth 3]</code>). Replaces keyword matching.
            </span>
          </span>
          <Toggle on={profile.aiControl} onClick={() => updateProfile(editingScope, { aiControl: !profile.aiControl })} />
        </div>

        <div className={labelClass}>
          <span>Intensity ×{profile.intensityScale.toFixed(1)}</span>
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={profile.intensityScale}
            onChange={(e) => updateProfile(editingScope, { intensityScale: parseFloat(e.target.value) })}
            className="w-28"
          />
        </div>

        {!profile.aiControl && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--color-text-secondary)]">Keyword → action</span>
              <button
                type="button"
                onClick={() => addMapping(editingScope)}
                className="flex items-center gap-1 text-[10px] text-[var(--color-primary)] hover:opacity-80"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            {profile.mappings.map((m) => (
              <MappingRow key={m.id} avatar={editingScope} mapping={m} />
            ))}
            {profile.mappings.length === 0 && (
              <p className="text-[10px] text-[var(--color-text-secondary)]/60">No mappings.</p>
            )}
          </div>
        )}
      </div>

      {isCustom && avatar && (
        <button
          type="button"
          onClick={() => removeCharacterProfile(avatar)}
          className="text-[10px] text-[var(--color-text-secondary)] hover:text-red-400"
        >
          Reset to default behavior
        </button>
      )}
    </div>
  );
}

// --- Manual test -----------------------------------------------------------

function ManualTest() {
  const connected = useLovenseStore((s) => s.connected);
  const toys = useLovenseStore((s) => s.toys);
  const isSending = useLovenseStore((s) => s.isSending);
  const activeToyId = useLovenseStore((s) => s.activeToyId);
  const setActiveToyId = useLovenseStore((s) => s.setActiveToyId);
  const sendFunction = useLovenseStore((s) => s.sendFunction);
  const sendPreset = useLovenseStore((s) => s.sendPreset);
  const stopAll = useLovenseStore((s) => s.stopAll);

  const caps = useMemo<LovenseAction[]>(
    () => unionCapabilities(toys.map((t) => t.name)).filter((a) => a !== 'Stop'),
    [toys],
  );
  const [action, setAction] = useState<LovenseAction>('Vibrate');
  const [intensity, setIntensity] = useState(10);

  const currentAction = caps.includes(action) ? action : caps[0] ?? 'Vibrate';
  const max = actionMaxIntensity(currentAction);
  const clamped = Math.min(intensity, max);

  return (
    <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
      <div className={sectionTitle}>Manual test</div>
      {toys.length > 1 && (
        <select
          value={activeToyId ?? ''}
          onChange={(e) => setActiveToyId(e.target.value || null)}
          className={`${inputClass} w-full`}
        >
          <option value="">All toys</option>
          {toys.map((t) => (
            <option key={t.id} value={t.id}>
              {t.nickname || toyDisplayName(t.name)}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-1.5">
        <select
          value={currentAction}
          onChange={(e) => setAction(e.target.value as LovenseAction)}
          className={inputClass}
        >
          {caps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="range"
          min={0}
          max={max}
          value={clamped}
          onChange={(e) => setIntensity(parseInt(e.target.value, 10))}
          className="flex-1"
        />
        <span className="text-xs text-[var(--color-text-primary)] w-6 text-center">{clamped}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => sendFunction([{ action: currentAction, intensity: clamped }])}
          disabled={!connected || isSending}
          className={btnClass}
        >
          {isSending ? 'Sending…' : 'Send test'}
        </button>
        <button
          type="button"
          onClick={() => stopAll()}
          disabled={!connected}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
        >
          <Square size={11} /> Stop
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LOVENSE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => sendPreset(p)}
            disabled={!connected || isSending}
            className="px-2 py-1 text-[10px] rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 capitalize"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Global settings + panel root ------------------------------------------

function LovenseSettings() {
  const connected = useLovenseStore((s) => s.connected);
  const error = useLovenseStore((s) => s.error);

  const autoReact = useLovenseStore((s) => s.autoReact);
  const setAutoReact = useLovenseStore((s) => s.setAutoReact);
  const streamLive = useLovenseStore((s) => s.streamLive);
  const setStreamLive = useLovenseStore((s) => s.setStreamLive);
  const matchWholeWord = useLovenseStore((s) => s.matchWholeWord);
  const setMatchWholeWord = useLovenseStore((s) => s.setMatchWholeWord);
  const hideTagsInChat = useLovenseStore((s) => s.hideTagsInChat);
  const setHideTagsInChat = useLovenseStore((s) => s.setHideTagsInChat);
  const defaultDurationSec = useLovenseStore((s) => s.defaultDurationSec);
  const setDefaultDurationSec = useLovenseStore((s) => s.setDefaultDurationSec);

  return (
    <div className="space-y-4">
      <PairingSection />

      <div className="space-y-2">
        <div className={labelClass}>
          <span className="flex-1">
            Auto-react to messages
            <span className="block text-[10px] text-[var(--color-text-secondary)]/60 mt-0.5">
              Drive the toy from each AI reply (keywords or AI directives, per character below).
            </span>
          </span>
          <Toggle on={autoReact} onClick={() => setAutoReact(!autoReact)} />
        </div>
        <div className={labelClass}>
          <span className="flex-1">
            React while streaming
            <span className="block text-[10px] text-[var(--color-text-secondary)]/60 mt-0.5">
              For AI-directive characters, respond mid-message instead of only when it finishes.
            </span>
          </span>
          <Toggle on={streamLive} onClick={() => setStreamLive(!streamLive)} />
        </div>
        <div className={labelClass}>
          <span>Whole-word keyword matches</span>
          <Toggle on={matchWholeWord} onClick={() => setMatchWholeWord(!matchWholeWord)} />
        </div>
        <div className={labelClass}>
          <span>Hide control tags in chat</span>
          <Toggle on={hideTagsInChat} onClick={() => setHideTagsInChat(!hideTagsInChat)} />
        </div>
        <div className={labelClass}>
          <span>Default action duration (seconds)</span>
          <input
            type="number"
            min={1}
            max={600}
            value={defaultDurationSec}
            onChange={(e) => setDefaultDurationSec(parseInt(e.target.value, 10) || 1)}
            className={`${inputClass} w-16 text-center`}
          />
        </div>
      </div>

      <ProfileEditor />
      <ManualTest />

      <p className="flex items-start gap-1.5 text-[10px] text-[var(--color-text-secondary)]/70">
        <Bot size={12} className="flex-shrink-0 mt-0.5" />
        <span>
          Type <code>/lovense vibrate 15 for 5s</code>, <code>/lovense preset pulse</code>, or{' '}
          <code>/lovense stop</code> in chat for manual control.
        </span>
      </p>

      {!connected && (
        <p className="text-[10px] text-[var(--color-text-secondary)]/60">
          Pair a toy to enable controls.
        </p>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

// --- /lovense slash command ------------------------------------------------

registerCommand({
  name: 'lovense',
  description: 'Control the connected Lovense toy: /lovense vibrate 15 for 5s | preset pulse | stop | status',
  category: 'system',
  usage: '/lovense <action> <intensity> [for <n>s] | /lovense preset <name> | /lovense stop | /lovense status',
  async handler(_args, rawArgs, ctx) {
    if (!extensionRegistry.isEnabled('lovense')) {
      ctx.showToast('The Lovense extension is disabled', 'warning');
      return '';
    }
    const store = useLovenseStore.getState();
    const arg = rawArgs.trim();
    const lower = arg.toLowerCase();

    if (!arg || lower === 'status' || lower === 'toys') {
      if (!store.connected) return 'Lovense: not connected';
      const list =
        store.toys.map((t) => t.nickname || toyDisplayName(t.name)).join(', ') || 'unknown toy';
      return `Lovense: connected (${list})`;
    }
    if (!store.connected) {
      ctx.showToast('No Lovense toy connected', 'warning');
      return '';
    }

    const directives = parseLovenseDirectives(`[lovense: ${arg}]`);
    if (directives.length === 0) {
      ctx.showToast(`/lovense: couldn't understand "${arg}"`, 'error');
      return '';
    }
    for (const d of directives) {
      if (d.kind === 'stop') await store.stopAll();
      else if (d.kind === 'preset') await store.sendPreset(d.name, { durationSec: d.durationSec });
      else await store.sendFunction(d.actions, { durationSec: d.durationSec });
    }
    return '';
  },
});

// --- Manifest --------------------------------------------------------------

const manifest: ExtensionManifest = {
  id: 'lovense',
  displayName: 'Lovense Device Control',
  description:
    'Connect any Lovense toy and drive it from chat — per-character keyword reactions, AI-directed control the characters can trigger themselves, presets, and multi-toy targeting.',
  version: '2.0.0',
  icon: Vibrate,
  // Opt-in: hardware + intimate content, off until the user enables it.
  defaultEnabled: false,
  settingsPanel: LovenseSettings,

  // Teach AI-directive characters the tag syntax + the connected toy's
  // functions. Solo chats only (the group builder runs no context hooks).
  onBuildContext(event: ContextBuildEvent): ContextContribution[] {
    if (!extensionRegistry.isEnabled('lovense')) return [];
    const s = useLovenseStore.getState();
    if (!s.connected || !s.autoReact) return [];
    const profile = s.resolveProfile(event.characterAvatar);
    if (!profile.reactionEnabled || !profile.aiControl) return [];
    const actions =
      s.toys.length > 0 ? unionCapabilities(s.toys.map((t) => t.name)) : s.connectedCapabilities();
    const instruction = buildAiControlInstruction(actions, s.defaultDurationSec, s.hideTagsInChat);
    return [{ content: instruction, role: 'system', position: 'after_char', order: 60 }];
  },
};

extensionRegistry.register(manifest);
