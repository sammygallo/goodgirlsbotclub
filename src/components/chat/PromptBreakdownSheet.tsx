/**
 * Opens `PromptBreakdownView` for one message's cost chip.
 *
 * Ownership is resolved here, not assumed by the caller: the store holds
 * exactly one `lastPromptBreakdown` slot (last-write-wins — a group round
 * overwrites it once per speaker), so by the time a user taps an OLDER
 * message's chip the slot may already describe a different turn. Showing
 * that stale breakdown under the tapped message's name would be silently
 * wrong in a way nothing on screen would hint at; an explicit "no longer
 * available" state is the honest alternative (E2-S2 task 6).
 */
import { BottomSheet } from '../ui/BottomSheet';
import { useGenerationStore } from '../../stores/generationStore';
import { computeBreakdownView } from '../../utils/breakdownBuckets';
import { PromptBreakdownView } from './PromptBreakdownView';

interface PromptBreakdownSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The message whose cost chip opened this sheet. */
  messageId: string;
}

export function PromptBreakdownSheet({ isOpen, onClose, messageId }: PromptBreakdownSheetProps) {
  const breakdown = useGenerationStore((s) => s.lastPromptBreakdown);
  const taggedMessageId = useGenerationStore((s) => s.lastPromptBreakdownMessageId);

  // Never a fallback to "whichever breakdown is in the slot" — a null slot
  // and a slot that has moved on are the same case from this message's
  // point of view, and both get the same explicit non-answer.
  const owned = breakdown !== null && taggedMessageId === messageId;

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Token breakdown">
      <div className="px-4">
        {owned ? (
          <PromptBreakdownView view={computeBreakdownView(breakdown)} provenanceVariant="compact" />
        ) : (
          <div className="py-4 text-sm text-[var(--color-text-secondary)] space-y-3">
            <p>
              Breakdown no longer available for this turn — the app keeps only the most recent
              prompt build, and a newer message, swipe, or group speaker replaced it.
            </p>
            {breakdown && (
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-[var(--color-primary)] underline underline-offset-2"
              >
                Close — the most recent turn's chip still shows the current build.
              </button>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
