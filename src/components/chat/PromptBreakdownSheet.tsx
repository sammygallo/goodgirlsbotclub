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
 *
 * Ownership also checks the SWIPE, not just the message id (review round 1,
 * M3/F6): `ChatMessage.id` is stable across every swipe of the same AI
 * message, so swiping right (generating a new swipe) and then back tags the
 * slot for a swipe that is no longer the one on screen. `swipeIndex` — the
 * message's CURRENT swipe, read off the same source the swipe control
 * itself uses — is what lets that mismatch fall into the same "not owned"
 * state as any other stale slot, rather than rendering the newer swipe's
 * numbers under the older swipe's text.
 *
 * FOUR causes clear the slot's tag, not three (review round 3, R3-E/F6):
 * a newer message, a swipe, a group speaker — and `impersonate`, which
 * publishes its own breakdown (chatStore.ts) with no message to tag, so it
 * always lands the sheet in this "not owned" branch for whatever message was
 * previously current. The copy below names all four so it never states a
 * cause that did not happen.
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
  /** That message's CURRENT swipe index (`ChatMessage.swipeId`) — part of the
   *  ownership check, see the file doc. */
  swipeIndex: number;
}

export function PromptBreakdownSheet({ isOpen, onClose, messageId, swipeIndex }: PromptBreakdownSheetProps) {
  const breakdown = useGenerationStore((s) => s.lastPromptBreakdown);
  const tag = useGenerationStore((s) => s.lastPromptBreakdownTag);

  // Never a fallback to "whichever breakdown is in the slot" — a null slot
  // and a slot that has moved on (different message OR the same message's
  // slot describing a different swipe) are both the same case from this
  // message's point of view, and both get an explicit non-answer. The two
  // ARE distinguished in the copy below (F5): a null slot means nothing was
  // ever assembled this session, which is a different cause than "something
  // was assembled but it isn't this turn/swipe" and reads wrong if worded as
  // a replacement that never happened.
  const owned =
    breakdown !== null &&
    tag !== null &&
    tag.messageId === messageId &&
    tag.swipeIndex === swipeIndex;

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Token breakdown">
      <div className="px-4">
        {owned ? (
          <PromptBreakdownView view={computeBreakdownView(breakdown!)} provenanceVariant="compact" />
        ) : breakdown === null ? (
          <div className="py-4 text-sm text-[var(--color-text-secondary)] space-y-3">
            <p>No prompt assembled yet this session — send a message to see its breakdown.</p>
          </div>
        ) : (
          <div className="py-4 text-sm text-[var(--color-text-secondary)] space-y-3">
            <p>
              Breakdown no longer available for this turn — the app keeps only the most recent
              prompt build, and a newer message, swipe, group speaker, or impersonation draft
              replaced it.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-[var(--color-primary)] underline underline-offset-2"
            >
              Close — the most recent turn's chip still shows the current build.
            </button>
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
