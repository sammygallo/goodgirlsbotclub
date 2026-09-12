/**
 * Opens `PromptCaptureView` for one message's "prompt" button — the E2-S3
 * sibling of `PromptBreakdownSheet`, copying its ownership logic exactly
 * (`messageId` + `swipeIndex` against `lastPromptCaptureTag`) for the same
 * reason: `generationStore` holds one `lastPromptCapture` slot, last-write-
 * wins, so a stale tap must land on an explicit "not owned" state rather
 * than a silently wrong turn's payload.
 *
 * One extra state this sheet has that the breakdown sheet doesn't: the
 * toggle. `capture === null` is ambiguous between "nothing generated yet"
 * and "the toggle is off, so nothing is ever captured" — `showExactPrompt`
 * disambiguates it.
 */
import { BottomSheet } from '../ui/BottomSheet';
import { useGenerationStore } from '../../stores/generationStore';
import { computeCaptureAttribution } from '../../utils/promptCapture';
import { PromptCaptureView } from './PromptCaptureView';

interface PromptCaptureSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The message whose "prompt" button opened this sheet. */
  messageId: string;
  /** That message's CURRENT swipe index — part of the ownership check, see
   *  the file doc. */
  swipeIndex: number;
}

export function PromptCaptureSheet({ isOpen, onClose, messageId, swipeIndex }: PromptCaptureSheetProps) {
  const capture = useGenerationStore((s) => s.lastPromptCapture);
  const tag = useGenerationStore((s) => s.lastPromptCaptureTag);
  const breakdown = useGenerationStore((s) => s.lastPromptBreakdown);
  const breakdownTag = useGenerationStore((s) => s.lastPromptBreakdownTag);
  const showExactPrompt = useGenerationStore((s) => s.showExactPrompt);

  const owned =
    capture !== null &&
    tag !== null &&
    tag.messageId === messageId &&
    tag.swipeIndex === swipeIndex;

  // Attribution needs the BREAKDOWN that describes this same turn, not just
  // any breakdown sitting in its own slot — the two slots are tagged
  // independently (see `lastPromptCaptureTag`'s doc comment), so this only
  // pairs them when both agree on the same message/swipe.
  const breakdownOwned =
    breakdown !== null &&
    breakdownTag !== null &&
    breakdownTag.messageId === messageId &&
    breakdownTag.swipeIndex === swipeIndex;
  const attribution = owned && breakdownOwned ? computeCaptureAttribution(capture!, breakdown) : null;

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Exact prompt">
      <div className="px-4">
        {owned ? (
          <PromptCaptureView capture={capture!} attribution={attribution} />
        ) : capture === null ? (
          <div className="py-4 text-sm text-[var(--color-text-secondary)] space-y-3">
            {showExactPrompt ? (
              <p>No prompt captured yet this session.</p>
            ) : (
              <p>
                Exact prompt capture is off. Turn it on under Settings → Generation → Prompts to
                capture the next prompt.
              </p>
            )}
          </div>
        ) : (
          <div className="py-4 text-sm text-[var(--color-text-secondary)] space-y-3">
            <p>
              Exact prompt no longer available for this turn — the app keeps only the most recent
              captured prompt, and this turn isn&apos;t it.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-[var(--color-primary)] underline underline-offset-2"
            >
              Close — see Settings → Usage → "Last exact prompt".
            </button>
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
