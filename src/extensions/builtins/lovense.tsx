/* eslint-disable react-refresh/only-export-components -- builtin extension file:
   registers its manifest as a module side-effect and defines its settings-panel
   components inline, the same pattern as the other builtins. */
import { useEffect, useMemo, useState } from 'react';
import {
  Vibrate,
  Loader2,
  Plus,
  Trash2,
  Square,
  BatteryMedium,
  Unplug,
  Bot,
  QrCode,
  X,
} from 'lucide-react';
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
  type LovenseToy,
} from '../../stores/lovenseStore';
import { useCharacterStore } from '../../stores/characterStore';
import {
  parseLovenseDirectives,
  buildAiControlInstruction,
  unionCapabilities,
  assignToyHandles,
  resolveTargets,
} from '../../utils/lovense';
import type { ExtensionManifest, ContextBuildEvent, ContextContribution } from '../types';

const inputClass =
  'px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]';
const labelClass =
  'flex items-center justify-between text-xs text-[var(--color-text-secondary)]';
const btnClass =
  'px-3 py-1.5 text-xs rounded bg-[var(--color-primary)] text-white disabled:opacity-50 hover:opacity-90 transition-opacity';
const ghostBtnClass =
  'flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors';
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
  const toys = useLovenseStore((s) => s.toys);
  const label = connected
    ? `${toys.length || 1} toy${toys.length === 1 ? '' : 's'} connected`
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

/** One toy: what it can do, its battery, plus the user's mute + intensity trim.
 *  The trim is what makes two very different toys usable together — a Lush and
 *  a Domi at the same nominal intensity are not the same experience. */
function ToyRow({ toy, handle }: { toy: LovenseToy; handle: string }) {
  const pref = useLovenseStore((s) => s.toyPrefs[toy.id]);
  const setToyPref = useLovenseStore((s) => s.setToyPref);
  const cap = capabilitiesForToy(toy.name);
  const enabled = pref?.enabled !== false;
  const scale = pref?.scale ?? 1;

  return (
    <div className="p-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]/40 text-xs space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[var(--color-text-primary)]">
            <Vibrate size={12} className="flex-shrink-0" />
            <span className="truncate">
              {toy.nickname || toyDisplayName(toy.name)}
              {toy.nickname ? (
                <span className="text-[var(--color-text-secondary)]"> · {toyDisplayName(toy.name)}</span>
              ) : null}
            </span>
            <code className="text-[10px] text-[var(--color-primary)] flex-shrink-0">@{handle}</code>
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {cap.actions.filter((a) => a !== 'All' && a !== 'Stop').join(', ')}
            {!cap.known && ' (unrecognized — showing common functions)'}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {typeof toy.battery === 'number' && toy.battery >= 0 && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
              <BatteryMedium size={12} /> {toy.battery}%
            </span>
          )}
          <Toggle on={enabled} onClick={() => setToyPref(toy.id, { enabled: !enabled })} />
        </div>
      </div>
      <div className={`flex items-center gap-2 ${enabled ? '' : 'opacity-40'}`}>
        <span className="text-[10px] text-[var(--color-text-secondary)] w-14">×{scale.toFixed(1)}</span>
        <input
          type="range"
          min={0.1}
          max={2}
          step={0.1}
          value={scale}
          disabled={!enabled}
          onChange={(e) => setToyPref(toy.id, { scale: parseFloat(e.target.value) })}
          className="flex-1"
          aria-label={`Intensity trim for ${toy.nickname || toyDisplayName(toy.name)}`}
        />
      </div>
    </div>
  );
}

function PairingCard({ pairingId, index }: { pairingId: string; index: number }) {
  const pairing = useLovenseStore((s) => s.pairings.find((p) => p.id === pairingId));
  const allToys = useLovenseStore((s) => s.toys);
  const renamePairing = useLovenseStore((s) => s.renamePairing);
  const unpairOne = useLovenseStore((s) => s.unpairOne);
  const generateQr = useLovenseStore((s) => s.generateQr);
  const [draft, setDraft] = useState<string | null>(null);

  // Handles are assigned across ALL toys, so they stay unique between pairings.
  const handles = useMemo(() => assignToyHandles(allToys), [allToys]);
  if (!pairing) return null;
  const name = pairing.label || `Toy app ${index + 1}`;

  return (
    <div className="space-y-1.5 p-2 rounded-lg border border-[var(--color-border)]">
      <div className="flex items-center gap-1.5">
        {draft !== null ? (
          <input
            type="text"
            autoFocus
            value={draft}
            placeholder="Name this app"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              void renamePairing(pairing.id, draft);
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setDraft(null);
            }}
            className={`${inputClass} flex-1 min-w-0`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setDraft(pairing.label ?? '')}
            className="flex-1 min-w-0 text-left text-xs text-[var(--color-text-primary)] hover:text-[var(--color-primary)] truncate"
            title="Rename"
          >
            {name}
          </button>
        )}
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 ${
            pairing.status === 'paired'
              ? 'bg-green-500/20 text-green-400'
              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {pairing.status === 'paired' ? 'Paired' : 'Awaiting scan'}
        </span>
      </div>

      {pairing.toys.map((t) => (
        <ToyRow
          key={t.id}
          toy={t}
          handle={handles[allToys.findIndex((x) => x.id === t.id && x.pairingId === t.pairingId)] ?? t.id}
        />
      ))}
      {pairing.status === 'paired' && pairing.toys.length === 0 && (
        <p className="text-[10px] text-[var(--color-text-secondary)]/60">
          Paired, but this app hasn&apos;t reported a toy yet.
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => generateQr(pairing.id)} className={ghostBtnClass}>
          <QrCode size={11} /> Re-scan
        </button>
        <button
          type="button"
          onClick={() => unpairOne(pairing.id)}
          className={`${ghostBtnClass} hover:!text-red-400`}
        >
          <Unplug size={11} /> Forget
        </button>
      </div>
    </div>
  );
}

function PairingSection() {
  const pairings = useLovenseStore((s) => s.pairings);
  const qrUrl = useLovenseStore((s) => s.qrUrl);
  const pairingCode = useLovenseStore((s) => s.pairingCode);
  const status = useLovenseStore((s) => s.status);
  const generateQr = useLovenseStore((s) => s.generateQr);
  const cancelQr = useLovenseStore((s) => s.cancelQr);
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

      {pairings.map((p, i) => (
        <PairingCard key={p.id} pairingId={p.id} index={i} />
      ))}

      {!qrUrl && (
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
          ) : pairings.length === 0 ? (
            'Generate pairing QR'
          ) : (
            'Pair another app'
          )}
        </button>
      )}

      {qrUrl && (
        <div className="flex flex-col items-center gap-2 p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]/40">
          <img src={qrUrl} alt="Lovense pairing QR" className="w-40 h-40 rounded bg-white p-1" />
          <p className="text-[10px] text-[var(--color-text-secondary)] text-center">
            Scan with the Lovense Remote app to link your toy.
            {pairingCode && <span className="block">Code: {pairingCode}</span>}
          </p>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
            <Loader2 size={11} className="animate-spin" /> Waiting for you to scan…
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => checkPairing()} className={btnClass}>
              Check now
            </button>
            <button type="button" onClick={() => cancelQr()} className={ghostBtnClass}>
              <X size={11} /> Cancel
            </button>
          </div>
        </div>
      )}

      {pairings.length > 1 && (
        <button
          type="button"
          onClick={() => unpair()}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
        >
          <Unplug size={12} /> Forget all pairings
        </button>
      )}

      <p className="text-[10px] text-[var(--color-text-secondary)]/60">
        Each Lovense app you scan is its own pairing. One app can carry several
        toys; scan again to add a toy from another phone or account.
      </p>
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
  const toys = useLovenseStore((s) => s.toys);

  const isCustom = avatar != null && !!profilesByAvatar[avatar];
  const profile: LovenseProfile = avatar == null ? defaultProfile : profilesByAvatar[avatar] ?? defaultProfile;
  const editingScope: string | null = avatar; // null = default
  const editable = avatar == null || isCustom;
  const multiToy = toys.length > 1;

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
              Let the character control your toys with inline directives like
              <code className="mx-1">[lovense: vibrate 15 for 5s]</code>. Multiple functions
              can be combined in one directive (e.g.
              <code className="mx-1">[lovense: thrusting 15, depth 3]</code>).
              {multiToy && (
                <>
                  {' '}
                  With several toys connected it can drive each one differently in the same
                  directive — <code className="mx-1">[lovense: @lush vibrate 15, @nora rotate 8]</code>.
                </>
              )}{' '}
              Replaces keyword matching.
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
            {multiToy && (
              <p className="text-[10px] text-[var(--color-text-secondary)]/60">
                Keyword reactions go to every toy that supports the chosen function.
              </p>
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
  const activeToyIds = useLovenseStore((s) => s.activeToyIds);
  const toggleActiveToy = useLovenseStore((s) => s.toggleActiveToy);
  const setActiveToyIds = useLovenseStore((s) => s.setActiveToyIds);
  const sendFunction = useLovenseStore((s) => s.sendFunction);
  const sendPreset = useLovenseStore((s) => s.sendPreset);
  const stopAll = useLovenseStore((s) => s.stopAll);

  const handles = useMemo(() => assignToyHandles(toys), [toys]);
  // With nothing selected the command goes to every toy, so the action list is
  // the union over whichever set is actually being driven.
  const targeted = activeToyIds.length > 0 ? toys.filter((t) => activeToyIds.includes(t.id)) : toys;
  const caps = useMemo<LovenseAction[]>(
    () => unionCapabilities(targeted.map((t) => t.name)).filter((a) => a !== 'Stop'),
    [targeted],
  );
  const [action, setAction] = useState<LovenseAction>('Vibrate');
  const [intensity, setIntensity] = useState(10);

  const currentAction = caps.includes(action) ? action : caps[0] ?? 'Vibrate';
  const max = actionMaxIntensity(currentAction);
  const clamped = Math.min(intensity, max);
  const targets = activeToyIds.length > 0 ? activeToyIds : null;

  return (
    <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
      <div className={sectionTitle}>Manual test</div>
      {toys.length > 1 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-secondary)]">
            <span>Send to</span>
            {activeToyIds.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveToyIds([])}
                className="text-[var(--color-primary)] hover:opacity-80"
              >
                All toys
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {toys.map((t, i) => {
              const on = activeToyIds.length === 0 || activeToyIds.includes(t.id);
              return (
                <button
                  key={`${t.pairingId}:${t.id}`}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleActiveToy(t.id)}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    on
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'
                  }`}
                >
                  {t.nickname || toyDisplayName(t.name)}
                  <span className="opacity-60"> @{handles[i]}</span>
                </button>
              );
            })}
          </div>
        </div>
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
          onClick={() => sendFunction([{ action: currentAction, intensity: clamped }], { targets })}
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
            onClick={() => sendPreset(p, { targets })}
            disabled={!connected || isSending}
            className="px-2 py-1 text-[10px] rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 capitalize"
          >
            {p}
          </button>
        ))}
      </div>
      {toys.length > 1 && (
        <p className="text-[10px] text-[var(--color-text-secondary)]/60">
          Each toy only receives the functions it actually has, so one command can
          drive all of them at once.
        </p>
      )}
    </div>
  );
}

// --- Global settings + panel root ------------------------------------------

function LovenseSettings() {
  const connected = useLovenseStore((s) => s.connected);
  const error = useLovenseStore((s) => s.error);
  const toys = useLovenseStore((s) => s.toys);

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
              Drive your toys from each AI reply (keywords or AI directives, per character below).
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
          Type <code>/lovense vibrate 15 for 5s</code>, <code>/lovense preset pulse</code>,{' '}
          <code>/lovense toys</code>, or <code>/lovense stop</code> in chat for manual control.
          {toys.length > 1 && (
            <>
              {' '}
              Target one toy with <code>/lovense @lush vibrate 12</code>.
            </>
          )}
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
  description:
    'Control your Lovense toys: /lovense vibrate 15 for 5s | @lush vibrate 12 | preset pulse | stop | toys',
  category: 'system',
  usage:
    '/lovense [@toy] <action> <intensity> [for <n>s] | /lovense preset <name> | /lovense stop | /lovense toys',
  async handler(_args, rawArgs, ctx) {
    if (!extensionRegistry.isEnabled('lovense')) {
      ctx.showToast('The Lovense extension is disabled', 'warning');
      return '';
    }
    const store = useLovenseStore.getState();
    const arg = rawArgs.trim();
    const lower = arg.toLowerCase();
    const toys = store.toyRefs();

    if (!arg || lower === 'status' || lower === 'toys') {
      if (!store.connected) {
        ctx.showToast('Lovense: not connected', 'warning');
        return '';
      }
      // STscript return values aren't rendered anywhere, so report via toast.
      const handles = assignToyHandles(toys);
      const list =
        toys.map((t, i) => `@${handles[i]} (${t.nickname || toyDisplayName(t.name)})`).join(', ') ||
        'no toys reported';
      const apps = store.pairings.filter((p) => p.status === 'paired').length;
      ctx.showToast(`Lovense: ${list} — ${apps} app${apps === 1 ? '' : 's'} paired`, 'info');
      return '';
    }
    if (!store.connected) {
      ctx.showToast('No Lovense toy connected', 'warning');
      return '';
    }

    const directives = parseLovenseDirectives(`[lovense: ${arg}]`, toys);
    if (directives.length === 0) {
      ctx.showToast(`/lovense: couldn't understand "${arg}"`, 'error');
      return '';
    }
    for (const d of directives) {
      if (d.kind === 'stop') {
        await store.stopTargets(d.targets);
      } else if (d.kind === 'preset') {
        await store.sendPreset(d.name, { targets: d.targets, durationSec: d.durationSec });
      } else {
        // Warn rather than fail silently when the named toy isn't connected.
        const named = d.groups.flatMap((g) => g.targets ?? []);
        if (named.length > 0 && resolveTargets(named, toys).length === 0) {
          ctx.showToast(`/lovense: no connected toy matches "${named.join(', ')}"`, 'error');
          continue;
        }
        await store.sendGroups(d.groups, { durationSec: d.durationSec });
      }
    }
    return '';
  },
});

// --- Manifest --------------------------------------------------------------

const manifest: ExtensionManifest = {
  id: 'lovense',
  displayName: 'Lovense Device Control',
  description:
    'Connect your Lovense toys and drive them from chat — pair several apps at once, per-character keyword reactions, AI-directed control the characters can trigger themselves, presets, and per-toy targeting so one directive can drive every toy simultaneously.',
  version: '3.0.0',
  icon: Vibrate,
  // Opt-in: hardware + intimate content, off until the user enables it.
  defaultEnabled: false,
  settingsPanel: LovenseSettings,

  // Teach AI-directive characters the tag syntax, which toys are connected and
  // what each one can do. Solo chats only (the group builder runs no context
  // hooks).
  onBuildContext(event: ContextBuildEvent): ContextContribution[] {
    if (!extensionRegistry.isEnabled('lovense')) return [];
    const s = useLovenseStore.getState();
    if (!s.connected || !s.autoReact) return [];
    const profile = s.resolveProfile(event.characterAvatar);
    if (!profile.reactionEnabled || !profile.aiControl) return [];
    // Muted toys are left out of the prompt entirely — naming a toy the model
    // can't actually drive just invites directives that go nowhere.
    const toys = s.toyRefs().filter((t) => s.toyPrefs[t.id]?.enabled !== false);
    const instruction = buildAiControlInstruction(
      toys,
      s.connectedCapabilities(),
      s.defaultDurationSec,
      s.hideTagsInChat,
    );
    return [{ content: instruction, role: 'system', position: 'after_char', order: 60 }];
  },
};

extensionRegistry.register(manifest);
