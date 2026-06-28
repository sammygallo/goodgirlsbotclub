import { Fuel, Gauge } from 'lucide-react';
import { useUsageStore, formatTokens } from '../../stores/usageStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';

/**
 * Always-present token "fuel gauge" shown above the chat input.
 *
 * Two readouts side by side:
 *   - lifetime tokens used (an odometer that only counts up), and
 *   - remaining vs a self-imposed token budget (depletes; the fuel metaphor).
 *
 * Tokens-only in v1 — there's no server billing, so this is a client-side
 * estimate. Tapping opens the Usage settings page for the full breakdown.
 */
export function UsageGauge() {
  const lifetimeTotal = useUsageStore((s) => s.lifetime.total);
  const budgetLimit = useUsageStore((s) => s.budgetLimit);
  const budgetUsed = useUsageStore((s) => s.budgetUsed.total);
  const openToPage = useSettingsPanelStore((s) => s.openToPage);

  const hasBudget = budgetLimit !== null && budgetLimit > 0;
  const remaining = hasBudget ? budgetLimit - budgetUsed : 0;
  const pct = hasBudget
    ? Math.min(100, Math.max(0, (budgetUsed / budgetLimit) * 100))
    : 0;
  const over = hasBudget && remaining < 0;

  // Bar fills green → amber → red as the budget depletes. Inline style (not a
  // dynamic class) so Tailwind's purge can't strip the color.
  const barColor = over || pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : 'var(--color-primary)';

  return (
    <button
      type="button"
      onClick={() => openToPage('usage')}
      className="mx-4 mb-2 flex items-center gap-3 px-3 py-1.5 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      aria-label="Token usage — tap for details"
      title="Token usage — tap for details"
    >
      {/* Lifetime odometer */}
      <span className="flex items-center gap-1 flex-shrink-0">
        <Gauge size={13} className="opacity-80" />
        <span className="tabular-nums">~{formatTokens(lifetimeTotal)}</span>
        <span className="opacity-60">used</span>
      </span>

      {hasBudget ? (
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          <Fuel size={13} className={over ? 'text-red-400' : 'opacity-80'} />
          <span className="relative flex-1 min-w-[36px] h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-all"
              style={{ width: `${pct}%`, backgroundColor: barColor }}
            />
          </span>
          <span
            className="tabular-nums flex-shrink-0"
            style={over ? { color: '#f87171' } : undefined}
          >
            {over ? `−${formatTokens(-remaining)}` : `${formatTokens(remaining)} left`}
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1 ml-auto flex-shrink-0 opacity-80">
          <Fuel size={13} />
          <span>Set budget</span>
        </span>
      )}
    </button>
  );
}
