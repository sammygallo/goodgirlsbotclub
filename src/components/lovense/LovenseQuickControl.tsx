import { useState } from 'react';
import { Vibrate, Square, ChevronDown, ChevronUp } from 'lucide-react';
import {
  useLovenseStore,
  actionMaxIntensity,
  capabilitiesForToy,
  toyDisplayName,
  type LovenseAction,
  type LovenseToy,
} from '../../stores/lovenseStore';
import { useExtensionStore } from '../../stores/extensionStore';

// Floating, collapsible in-chat control. Mounted globally (App.tsx) and shown
// only when the Lovense extension is enabled and a toy is connected — so the
// user always has a reachable STOP and a quick intensity dial without opening
// settings. Deliberately self-contained (no ChatView/ChatInput prop threading).
//
// With several toys connected it grows a dial per toy plus an "All" dial, so
// each one can be ridden independently without leaving the chat.

/** The function a quick dial should drive on a toy: Vibrate when it has it,
 *  otherwise whatever it does have. */
function primaryAction(toy: LovenseToy | null): LovenseAction {
  const caps = (toy ? capabilitiesForToy(toy.name).actions : [])
    .filter((a) => a !== 'Stop' && a !== 'All');
  if (caps.includes('Vibrate')) return 'Vibrate';
  return caps[0] ?? 'Vibrate';
}

function Dial({
  label,
  action,
  value,
  onChange,
}: {
  label: string;
  action: LovenseAction;
  value: number;
  onChange: (v: number) => void;
}) {
  const max = actionMaxIntensity(action);
  const clamped = Math.min(value, max);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-secondary)] gap-2">
        <span className="truncate">{label}</span>
        <span className="flex-shrink-0 text-[var(--color-text-secondary)]/70">
          {action}
          <span className="ml-1 text-[var(--color-text-primary)]">{clamped}</span>
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        value={clamped}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full"
        aria-label={`${label} intensity`}
      />
    </div>
  );
}

export function LovenseQuickControl() {
  const enabled = useExtensionStore((s) => s.enabled.lovense);
  const connected = useLovenseStore((s) => s.connected);
  const toys = useLovenseStore((s) => s.toys);
  const sendFunction = useLovenseStore((s) => s.sendFunction);
  const stopAll = useLovenseStore((s) => s.stopAll);
  const connectedCapabilities = useLovenseStore((s) => s.connectedCapabilities);

  const [open, setOpen] = useState(false);
  // Intensity per toy id, plus '' for the all-toys dial.
  const [levels, setLevels] = useState<Record<string, number>>({});

  if (!enabled || !connected) return null;

  const caps = connectedCapabilities().filter((a) => a !== 'Stop' && a !== 'All');
  const allAction: LovenseAction = caps.includes('Vibrate') ? 'Vibrate' : caps[0] ?? 'Vibrate';
  const multi = toys.length > 1;

  // durationSec: 0 = run until changed or stopped. The manual dial is the one
  // place indefinite is intended — every automatic reaction is time-boxed.
  const drive = (key: string, action: LovenseAction, v: number, targets: string[] | null) => {
    setLevels((prev) => ({ ...prev, [key]: v }));
    void sendFunction([{ action, intensity: v }], { durationSec: 0, targets });
  };

  return (
    <div className="fixed bottom-24 right-3 z-40 flex flex-col items-end gap-1.5 pointer-events-none">
      {open && (
        <div className="pointer-events-auto w-56 max-h-[60vh] overflow-y-auto p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg space-y-2.5">
          <Dial
            label={multi ? 'All toys' : toys[0] ? toys[0].nickname || toyDisplayName(toys[0].name) : 'Toy'}
            action={multi ? allAction : primaryAction(toys[0] ?? null)}
            value={levels[''] ?? 0}
            onChange={(v) => drive('', multi ? allAction : primaryAction(toys[0] ?? null), v, null)}
          />

          {multi &&
            toys.map((t) => {
              const action = primaryAction(t);
              return (
                <Dial
                  key={`${t.pairingId}:${t.id}`}
                  label={t.nickname || toyDisplayName(t.name)}
                  action={action}
                  value={levels[t.id] ?? 0}
                  onChange={(v) => drive(t.id, action, v, [t.id])}
                />
              );
            })}

          <button
            type="button"
            onClick={() => {
              setLevels({});
              void stopAll();
            }}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
          >
            <Square size={12} /> Stop all
          </button>
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setLevels({});
            void stopAll();
          }}
          title="Stop all toys"
          aria-label="Stop all toys"
          className="w-9 h-9 flex items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-red-400 shadow hover:bg-red-500/10 transition-colors"
        >
          <Square size={14} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Toy controls"
          aria-label="Toy controls"
          aria-expanded={open}
          className="w-11 h-11 flex items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-lg hover:opacity-90 transition-opacity relative"
        >
          <Vibrate size={18} />
          {multi && (
            <span className="absolute -bottom-0.5 -left-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[9px] text-[var(--color-text-primary)] border border-[var(--color-border)]">
              {toys.length}
            </span>
          )}
          <span className="absolute -top-0.5 -right-0.5 bg-[var(--color-bg-secondary)] rounded-full">
            {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </span>
        </button>
      </div>
    </div>
  );
}
