import { useState } from 'react';
import { ArrowLeft, Fuel, Gauge, Info, ReceiptText, RotateCcw, Trash2 } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useUsageStore, formatTokens } from '../../stores/usageStore';
import { useGenerationStore } from '../../stores/generationStore';
import { computeBreakdownView } from '../../utils/breakdownBuckets';
import { PromptBreakdownView } from '../chat/PromptBreakdownView';
import { Button, Input } from '../ui';

/** Parse a budget entry like "2m", "500k", or "1500000" into a token count. */
function parseTokenBudget(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[, _]/g, '');
  if (!s) return null;
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(k|m)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') n *= 1_000;
  else if (m[2] === 'm') n *= 1_000_000;
  n = Math.round(n);
  return n > 0 ? n : null;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-sm text-[var(--color-text-secondary)]">{label}</span>
      <span className="text-sm font-medium text-[var(--color-text-primary)] tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function UsagePage() {
  const { goBack } = useSettingsPanelStore();
  const lifetime = useUsageStore((s) => s.lifetime);
  const generations = useUsageStore((s) => s.generations);
  const budgetLimit = useUsageStore((s) => s.budgetLimit);
  const budgetUsed = useUsageStore((s) => s.budgetUsed);
  const contextMeterEnabled = useUsageStore((s) => s.contextMeterEnabled);
  const setBudgetLimit = useUsageStore((s) => s.setBudgetLimit);
  const resetBudget = useUsageStore((s) => s.resetBudget);
  const setContextMeterEnabled = useUsageStore((s) => s.setContextMeterEnabled);
  const clearAll = useUsageStore((s) => s.clearAll);
  const lastPromptBreakdown = useGenerationStore((s) => s.lastPromptBreakdown);

  const [budgetInput, setBudgetInput] = useState('');
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const hasBudget = budgetLimit !== null && budgetLimit > 0;
  const remaining = hasBudget ? budgetLimit - budgetUsed.total : 0;
  const pct = hasBudget
    ? Math.min(100, Math.max(0, (budgetUsed.total / budgetLimit) * 100))
    : 0;
  const over = hasBudget && remaining < 0;
  const barColor = over || pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : 'var(--color-primary)';
  const avgPerGen = generations > 0 ? Math.round(lifetime.total / generations) : 0;

  const applyBudget = () => {
    const parsed = parseTokenBudget(budgetInput);
    if (parsed === null) {
      setBudgetError('Enter a positive number (e.g. 500k, 2M, or 1500000).');
      return;
    }
    setBudgetLimit(parsed);
    setBudgetInput('');
    setBudgetError(null);
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button variant="ghost" size="sm" onClick={() => goBack()} className="p-2" aria-label="Back">
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)] flex-1">Usage</h1>
      </header>

      <div className="p-4 space-y-4 max-w-2xl mx-auto">
        {/* Estimate disclaimer */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <Info size={16} className="text-[var(--color-text-secondary)] flex-shrink-0 mt-0.5" />
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Token counts are <strong>estimated</strong> on-device (~±15–20%) — the app doesn't
            ship a full tokenizer and your provider's real usage isn't reported back, so treat
            these as a guide, not a bill. Every generation counts, including swipes and
            regenerations.
          </p>
        </div>

        {/* Lifetime */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-3">
            <Gauge size={18} className="text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Lifetime usage</h2>
          </div>
          <div className="text-3xl font-bold text-[var(--color-text-primary)] tabular-nums mb-3">
            ~{lifetime.total.toLocaleString()}
            <span className="text-base font-normal text-[var(--color-text-secondary)]"> tokens</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]/40">
            <StatRow label="Input (prompts sent)" value={`~${formatTokens(lifetime.input)}`} />
            <StatRow label="Output (replies)" value={`~${formatTokens(lifetime.output)}`} />
            <StatRow label="Generations" value={generations.toLocaleString()} />
            <StatRow label="Avg per generation" value={`~${formatTokens(avgPerGen)}`} />
          </div>
        </section>

        {/* Budget */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-3">
            <Fuel size={18} className={over ? 'text-red-400' : 'text-[var(--color-primary)]'} />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Token budget</h2>
          </div>

          {hasBudget ? (
            <>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-sm text-[var(--color-text-secondary)]">
                  ~{formatTokens(budgetUsed.total)} of {formatTokens(budgetLimit)} used
                </span>
                <span
                  className="text-sm font-semibold tabular-nums"
                  style={over ? { color: '#f87171' } : undefined}
                >
                  {over ? `Over by ~${formatTokens(-remaining)}` : `~${formatTokens(remaining)} left`}
                </span>
              </div>
              <div className="relative h-2.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden mb-4">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all"
                  style={{ width: `${pct}%`, backgroundColor: barColor }}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => resetBudget()}>
                  <RotateCcw size={14} className="mr-1.5" />
                  Reset period
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setBudgetLimit(null)}>
                  Remove budget
                </Button>
              </div>
              <div className="mt-4 pt-3 border-t border-[var(--color-border)]/40">
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                  Change the cap
                </label>
                <div className="flex gap-2">
                  <Input
                    value={budgetInput}
                    onChange={(e) => { setBudgetInput(e.target.value); setBudgetError(null); }}
                    placeholder={`${formatTokens(budgetLimit)} — e.g. 2M`}
                    inputMode="decimal"
                    className="flex-1"
                  />
                  <Button variant="primary" size="sm" onClick={applyBudget} disabled={!budgetInput.trim()}>
                    Save
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed mb-3">
                Set a self-imposed token cap and the gauge above the chat turns into a fuel meter
                that depletes as you chat. It's a soft reminder — nothing is enforced or blocked.
              </p>
              <div className="flex gap-2">
                <Input
                  value={budgetInput}
                  onChange={(e) => { setBudgetInput(e.target.value); setBudgetError(null); }}
                  placeholder="e.g. 500k, 2M, or 1500000"
                  inputMode="decimal"
                  className="flex-1"
                />
                <Button variant="primary" size="sm" onClick={applyBudget} disabled={!budgetInput.trim()}>
                  Set budget
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {[500_000, 1_000_000, 5_000_000].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setBudgetLimit(preset)}
                    className="text-xs px-2.5 py-1 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                  >
                    {formatTokens(preset)}
                  </button>
                ))}
              </div>
            </>
          )}
          {budgetError && <p className="text-xs text-red-400 mt-2">{budgetError}</p>}
        </section>

        {/* Last prompt breakdown (E2-S2 task 6) — the same PromptBreakdownView
            the per-message sheet uses, embedded inline. This page reads
            `lastPromptBreakdown` directly rather than via a message id: there
            is no "owning message" concept here, just "whatever the app last
            built" — the header below is the breakdown's own provenance
            stamps, not a claim about which chat bubble it belongs to. */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-3">
            <ReceiptText size={18} className="text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Last prompt breakdown</h2>
          </div>
          {lastPromptBreakdown ? (
            <PromptBreakdownView view={computeBreakdownView(lastPromptBreakdown)} provenanceVariant="full" />
          ) : (
            <p className="text-xs text-[var(--color-text-secondary)]">
              No prompt assembled yet this session — send a message to see its breakdown.
            </p>
          )}
        </section>

        {/* Preferences */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                Context meter while typing
              </span>
              <span className="block text-xs text-[var(--color-text-secondary)] mt-0.5">
                Show how full the model's context is as you compose a message.
              </span>
            </span>
            <input
              type="checkbox"
              checked={contextMeterEnabled}
              onChange={(e) => setContextMeterEnabled(e.target.checked)}
              className="w-5 h-5 flex-shrink-0 accent-[var(--color-primary)]"
            />
          </label>
        </section>

        {/* Danger zone */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          {confirmClear ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--color-text-secondary)]">Reset all counters to zero?</span>
              <div className="flex gap-2 flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>Cancel</Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => { clearAll(); setConfirmClear(false); }}
                >
                  Reset
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)} className="text-red-400">
              <Trash2 size={14} className="mr-1.5" />
              Reset all usage counters
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
