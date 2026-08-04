import { useMemo } from 'react';
import { useLoreConflictStore } from '../../../stores/loreConflictStore';

export interface LoreConflictChipProps {
  chatFile: string;
  onReview: () => void;
}

/**
 * Non-blocking "Auto Memory found pending conflicts" pill for a single chat.
 *
 * Subscribes to the whole `records` map — never a per-selector derived array,
 * per this codebase's React #185 discipline (see the EMPTY_ENTRIES / "never
 * return a fresh array from a zustand selector" comment in
 * ForkEntryEditor.tsx) — then filters to this chat's records and derives a
 * plain count in useMemo.
 *
 * Purely presentational: it never mutates loreConflictStore, never writes to
 * the chat's message list/transcript, and never auto-opens anything on its
 * own. `onReview` is the caller's responsibility entirely. It renders nothing
 * at zero count and persists for exactly as long as pending records exist for
 * this chatFile, which falls out naturally from the store subscription.
 */
export function LoreConflictChip({ chatFile, onReview }: LoreConflictChipProps) {
  const records = useLoreConflictStore((s) => s.records);

  const count = useMemo(
    () => Object.values(records).filter((r) => r.chatFile === chatFile).length,
    [records, chatFile]
  );

  if (count === 0) return null;

  return (
    <div className="flex items-center justify-center gap-2 px-4 pb-4">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-xs font-medium text-amber-400">
        <span>
          Auto Memory found {count} fact{count === 1 ? '' : 's'} that conflict with existing lore
        </span>
        <button
          type="button"
          onClick={onReview}
          className="text-[var(--color-primary)] hover:underline font-semibold"
        >
          Review
        </button>
      </div>
    </div>
  );
}
