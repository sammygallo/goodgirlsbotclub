import { useMemo } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useUsageStore, formatTokens } from '../../stores/usageStore';
import { useGenerationStore } from '../../stores/generationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useChatStore } from '../../stores/chatStore';
import { estimateTokens, estimateConversationTokens, profileForProvider } from '../../utils/tokenizer';

interface ContextMeterProps {
  /** The current draft text in the composer. */
  draft: string;
}

/**
 * Context-window fill indicator that appears as the user composes a message and
 * can be dismissed (the X flips the persisted `contextMeterEnabled` pref; the
 * Usage settings page toggles it back on).
 *
 * Estimates the next prompt against the configured context budget
 * (`context.maxTokens` — what the app actually trims history to). The base is
 * the last assembled prompt size (`lastTokenEstimate`); before the first send
 * of a session that's still 0, so we fall back to estimating the loaded thread
 * directly, avoiding a near-empty bar that then lurches up after the first
 * reply. When the bar nears the cap, older messages get dropped, so we flag it.
 */
export function ContextMeter({ draft }: ContextMeterProps) {
  const enabled = useUsageStore((s) => s.contextMeterEnabled);
  const setEnabled = useUsageStore((s) => s.setContextMeterEnabled);
  const lastTokenEstimate = useGenerationStore((s) => s.lastTokenEstimate);
  const maxTokens = useGenerationStore((s) => s.context.maxTokens);
  const provider = useSettingsStore((s) => s.activeProvider);
  const messages = useChatStore((s) => s.messages);

  const profile = profileForProvider(provider || '');

  // Fallback thread estimate (only needed before the first send). Memoized so
  // it isn't recomputed on every keystroke — only when the thread changes.
  const threadEstimate = useMemo(
    () =>
      estimateConversationTokens(
        messages.map((m) => ({ role: m.isUser ? 'user' : 'assistant', content: m.content })),
        profile,
      ),
    [messages, profile],
  );

  if (!enabled) return null;
  if (!draft.trim()) return null;

  const base = lastTokenEstimate > 0 ? lastTokenEstimate : threadEstimate;
  const used = base + estimateTokens(draft, profile);
  const budget = Math.max(1, maxTokens || 8192);
  const pct = Math.min(100, (used / budget) * 100);
  const near = pct >= 80;
  const barColor = pct >= 95 ? '#ef4444' : near ? '#f59e0b' : 'var(--color-primary)';

  return (
    <div className="flex items-center gap-2 mb-2 text-[11px] text-[var(--color-text-secondary)]">
      {near && <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />}
      <span className="relative flex-1 min-w-[40px] h-1 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </span>
      <span className="tabular-nums flex-shrink-0">
        ~{formatTokens(used)} / {formatTokens(budget)} ctx
        {near && <span className="text-amber-400"> · trimming</span>}
      </span>
      <button
        type="button"
        onClick={() => setEnabled(false)}
        className="p-0.5 rounded hover:bg-[var(--color-bg-tertiary)] flex-shrink-0"
        aria-label="Hide context meter"
        title="Hide context meter (re-enable in Usage settings)"
      >
        <X size={12} />
      </button>
    </div>
  );
}
