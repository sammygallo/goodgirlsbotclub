import type { BookHealth } from '../../stores/worldInfoStore';

export interface BookHealthCardProps {
  audit: BookHealth;
  lintErrorCount: number;
  lintWarningCount: number;
  tokenBudget: number;
}

/**
 * Persistent, always-visible health summary for the book currently open in
 * WorldInfoBookEditor's list view. Mirrors the per-book health block in
 * WorldInfoPage's "Lorebook health" section (same thresholds, same copy)
 * so the two surfaces read as one system rather than two designs.
 */
export function BookHealthCard({
  audit,
  lintErrorCount,
  lintWarningCount,
  tokenBudget,
}: BookHealthCardProps) {
  const pinnedOverBudget = tokenBudget > 0 && audit.pinnedTokens > tokenBudget;

  return (
    <div
      className={`p-3 rounded-lg border ${
        pinnedOverBudget
          ? 'bg-red-500/10 border-red-500/30'
          : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
      }`}
    >
      <p
        className={`text-xs ${
          pinnedOverBudget
            ? 'text-red-400 font-medium'
            : 'text-[var(--color-text-secondary)]'
        }`}
      >
        {audit.entryCount} enabled · {audit.constantCount} constant ·{' '}
        {audit.criticalCount} critical · ~{audit.pinnedTokens}
        {tokenBudget > 0 ? ` / ${tokenBudget}` : ''} pinned tokens
      </p>

      {pinnedOverBudget && (
        <p className="mt-1 text-xs text-red-400">
          If every constant + critical entry fired at once they would exceed
          the budget on their own — raise the budget, narrow scope, or demote
          entries. (Keyword-gated critical entries only cost tokens when they
          actually fire.)
        </p>
      )}

      {audit.constantShare > 0.2 && (
        <p className="mt-1 text-xs text-amber-400">
          Over 20% constant — consider demoting some.
        </p>
      )}

      {audit.criticalCount > 5 && (
        <p className="mt-1 text-xs text-amber-400">
          More than a handful marked critical — if everything is critical,
          nothing is.
        </p>
      )}

      {audit.danglingRelated.length > 0 && (
        <p className="mt-1 text-xs text-amber-400">
          {audit.danglingRelated.length} broken related-entry link
          {audit.danglingRelated.length === 1 ? '' : 's'}.
        </p>
      )}

      {audit.inactiveRelated.length > 0 && (
        <p className="mt-1 text-xs text-amber-400">
          {audit.inactiveRelated.length} related-entry link
          {audit.inactiveRelated.length === 1 ? '' : 's'} point
          {audit.inactiveRelated.length === 1 ? 's' : ''} at a disabled or
          empty entry — the chain silently stops there.
        </p>
      )}

      {lintErrorCount > 0 && (
        <p className="mt-1 text-xs text-red-400">
          {lintErrorCount} entr{lintErrorCount === 1 ? 'y' : 'ies'} can never
          fire.
        </p>
      )}

      {lintWarningCount > 0 && (
        <p className="mt-1 text-xs text-amber-400">
          {lintWarningCount} entr{lintWarningCount === 1 ? 'y' : 'ies'} need
          {lintWarningCount === 1 ? 's' : ''} attention.
        </p>
      )}
    </div>
  );
}
