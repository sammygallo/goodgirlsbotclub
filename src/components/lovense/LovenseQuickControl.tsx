import { useState } from 'react';
import { Vibrate, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { useLovenseStore, actionMaxIntensity } from '../../stores/lovenseStore';
import { useExtensionStore } from '../../stores/extensionStore';

// Floating, collapsible in-chat control. Mounted globally (App.tsx) and shown
// only when the Lovense extension is enabled and a toy is connected — so the
// user always has a reachable STOP and a quick intensity dial without opening
// settings. Deliberately self-contained (no ChatView/ChatInput prop threading).

export function LovenseQuickControl() {
  const enabled = useExtensionStore((s) => s.enabled.lovense);
  const connected = useLovenseStore((s) => s.connected);
  const sendFunction = useLovenseStore((s) => s.sendFunction);
  const stopAll = useLovenseStore((s) => s.stopAll);
  const connectedCapabilities = useLovenseStore((s) => s.connectedCapabilities);

  const [open, setOpen] = useState(false);
  const [intensity, setIntensity] = useState(10);

  if (!enabled || !connected) return null;

  // Prefer Vibrate; otherwise the first real function the connected toy(s) have.
  const caps = connectedCapabilities().filter((a) => a !== 'Stop' && a !== 'All');
  const action = caps.includes('Vibrate') ? 'Vibrate' : caps[0] ?? 'Vibrate';
  const max = actionMaxIntensity(action);
  const clamped = Math.min(intensity, max);

  return (
    <div className="fixed bottom-24 right-3 z-40 flex flex-col items-end gap-1.5 pointer-events-none">
      {open && (
        <div className="pointer-events-auto w-52 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[var(--color-text-secondary)]">
            <span>{action}</span>
            <span className="text-[var(--color-text-primary)]">{clamped}</span>
          </div>
          <input
            type="range"
            min={0}
            max={max}
            value={clamped}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setIntensity(v);
              void sendFunction([{ action, intensity: v }], { durationSec: 0 });
            }}
            className="w-full"
            aria-label="Toy intensity"
          />
          <button
            type="button"
            onClick={() => stopAll()}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
          >
            <Square size={12} /> Stop
          </button>
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => stopAll()}
          title="Stop toy"
          aria-label="Stop toy"
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
          <span className="absolute -top-0.5 -right-0.5 bg-[var(--color-bg-secondary)] rounded-full">
            {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </span>
        </button>
      </div>
    </div>
  );
}
