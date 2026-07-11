import { useEffect, useState } from 'react';
import { Vibrate, Loader2, Plus, Trash2, Square } from 'lucide-react';
import { extensionRegistry } from '../registry';
import {
  useLovenseStore,
  LOVENSE_ACTIONS,
  actionMaxIntensity,
  type LovenseAction,
} from '../../stores/lovenseStore';
import type { ExtensionManifest } from '../types';

const inputClass =
  'px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]';
const labelClass =
  'flex items-center justify-between text-xs text-[var(--color-text-secondary)]';
const btnClass =
  'px-3 py-1.5 text-xs rounded bg-[var(--color-primary)] text-white disabled:opacity-50 hover:opacity-90 transition-opacity';

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
        : status === 'testing'
          ? 'Testing…'
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

function MappingRow({ id }: { id: string }) {
  const mapping = useLovenseStore((s) => s.mappings.find((m) => m.id === id));
  const updateMapping = useLovenseStore((s) => s.updateMapping);
  const removeMapping = useLovenseStore((s) => s.removeMapping);
  if (!mapping) return null;

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        placeholder="keyword"
        value={mapping.keyword}
        onChange={(e) => updateMapping(id, { keyword: e.target.value })}
        className={`${inputClass} flex-1 min-w-0`}
      />
      <select
        value={mapping.action}
        onChange={(e) => updateMapping(id, { action: e.target.value as LovenseAction })}
        className={inputClass}
      >
        {LOVENSE_ACTIONS.map((a) => (
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
        onChange={(e) => updateMapping(id, { intensity: parseInt(e.target.value, 10) || 0 })}
        className={`${inputClass} w-12 text-center`}
      />
      <button
        type="button"
        onClick={() => removeMapping(id)}
        className="p-1 text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
        aria-label="Remove mapping"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function LovenseSettings() {
  const qrUrl = useLovenseStore((s) => s.qrUrl);
  const pairingCode = useLovenseStore((s) => s.pairingCode);
  const status = useLovenseStore((s) => s.status);
  const connected = useLovenseStore((s) => s.connected);
  const toys = useLovenseStore((s) => s.toys);
  const error = useLovenseStore((s) => s.error);
  const isSending = useLovenseStore((s) => s.isSending);

  const autoReact = useLovenseStore((s) => s.autoReact);
  const setAutoReact = useLovenseStore((s) => s.setAutoReact);
  const globalIntensityScale = useLovenseStore((s) => s.globalIntensityScale);
  const setGlobalIntensityScale = useLovenseStore((s) => s.setGlobalIntensityScale);
  const defaultDurationSec = useLovenseStore((s) => s.defaultDurationSec);
  const setDefaultDurationSec = useLovenseStore((s) => s.setDefaultDurationSec);

  const mappingIds = useLovenseStore((s) => s.mappings.map((m) => m.id));
  const addMapping = useLovenseStore((s) => s.addMapping);

  const generateQr = useLovenseStore((s) => s.generateQr);
  const checkPairing = useLovenseStore((s) => s.checkPairing);
  const sendCommand = useLovenseStore((s) => s.sendCommand);
  const stopAll = useLovenseStore((s) => s.stopAll);

  const [testAction, setTestAction] = useState<LovenseAction>('Vibrate');
  const [testIntensity, setTestIntensity] = useState(10);

  // Reflect the real backend pairing state when the panel opens (e.g. after a
  // reload where the toy is still paired server-side).
  useEffect(() => {
    void checkPairing();
  }, [checkPairing]);

  return (
    <div className="space-y-4">
      {/* Pairing */}
      <div className="space-y-2">
        <div className={labelClass}>
          <span>Device pairing</span>
          <StatusPill />
        </div>
        <button type="button" onClick={() => generateQr()} disabled={status === 'generating-qr'} className={btnClass}>
          {status === 'generating-qr' ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Generating…
            </span>
          ) : (
            'Generate pairing QR'
          )}
        </button>
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
          <div className="flex items-center gap-2 p-2 rounded border border-green-500/30 bg-green-500/10 text-xs text-green-400">
            <Vibrate size={14} />
            <span>
              Paired
              {toys && typeof toys === 'object'
                ? ` — ${Object.keys(toys as Record<string, unknown>).length} toy(s) connected`
                : ''}
            </span>
          </div>
        )}
      </div>

      {/* Auto-react */}
      <div className={labelClass}>
        <span className="flex-1">
          Auto-react to messages
          <span className="block text-[10px] text-[var(--color-text-secondary)]/60 mt-0.5">
            Scan each finished AI message for the keywords below and drive the toy.
          </span>
        </span>
        <Toggle on={autoReact} onClick={() => setAutoReact(!autoReact)} />
      </div>

      {/* Intensity + duration */}
      <div className={labelClass}>
        <span>
          Global intensity ×{globalIntensityScale.toFixed(1)}
        </span>
        <input
          type="range"
          min={0.1}
          max={2}
          step={0.1}
          value={globalIntensityScale}
          onChange={(e) => setGlobalIntensityScale(parseFloat(e.target.value))}
          className="w-28"
        />
      </div>
      <div className={labelClass}>
        <span>Action duration (seconds)</span>
        <input
          type="number"
          min={1}
          max={60}
          value={defaultDurationSec}
          onChange={(e) => setDefaultDurationSec(parseInt(e.target.value, 10) || 1)}
          className={`${inputClass} w-16 text-center`}
        />
      </div>

      {/* Keyword mappings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--color-text-secondary)]">Keyword → action</span>
          <button
            type="button"
            onClick={() => addMapping()}
            className="flex items-center gap-1 text-[10px] text-[var(--color-primary)] hover:opacity-80"
          >
            <Plus size={12} /> Add
          </button>
        </div>
        <div className="space-y-1.5">
          {mappingIds.map((id) => (
            <MappingRow key={id} id={id} />
          ))}
          {mappingIds.length === 0 && (
            <p className="text-[10px] text-[var(--color-text-secondary)]/60">
              No mappings — add one to enable auto-react.
            </p>
          )}
        </div>
      </div>

      {/* Manual test */}
      <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-secondary)]">Manual test</span>
        <div className="flex items-center gap-1.5">
          <select
            value={testAction}
            onChange={(e) => setTestAction(e.target.value as LovenseAction)}
            className={inputClass}
          >
            {LOVENSE_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={0}
            max={actionMaxIntensity(testAction)}
            value={Math.min(testIntensity, actionMaxIntensity(testAction))}
            onChange={(e) => setTestIntensity(parseInt(e.target.value, 10))}
            className="flex-1"
          />
          <span className="text-xs text-[var(--color-text-primary)] w-6 text-center">
            {Math.min(testIntensity, actionMaxIntensity(testAction))}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => sendCommand(testAction, Math.min(testIntensity, actionMaxIntensity(testAction)))}
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
      </div>

      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

const manifest: ExtensionManifest = {
  id: 'lovense',
  displayName: 'Lovense Device Control',
  description:
    'Connect a Lovense toy via the Lovense Cloud API and drive it from chat — manually or by auto-reacting to keywords in AI messages.',
  version: '1.0.0',
  icon: Vibrate,
  // Opt-in: hardware + intimate content, off until the user enables it.
  defaultEnabled: false,
  settingsPanel: LovenseSettings,
};

extensionRegistry.register(manifest);
