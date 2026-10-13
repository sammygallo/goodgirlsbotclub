import { Button, Modal } from '../ui';
import { MarkdownDoc } from '../ui/MarkdownDoc';

interface FeatureInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  heading: string;
  /** Optional hero art for the feature; decorative, so no alt text. */
  image?: string;
  /** Markdown from the slide config (D-H6). */
  bodyMarkdown: string;
}

/**
 * What a feature slide's "Learn more" opens (D-H6): the heading, an optional
 * image and a Markdown body, on the shared Modal.
 *
 * `bodyMarkdown` is rendered by MarkdownDoc, which does not sanitise. That is
 * deliberate and bounded: the text comes from `public/hero/feature-slides.json`,
 * first-party static content that only a deploy can change. Never feed this
 * from user-writable storage.
 */
export function FeatureInfoModal({ isOpen, onClose, heading, image, bodyMarkdown }: FeatureInfoModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={heading} size="lg">
      <div className="space-y-4">
        {image && (
          <img
            src={image}
            alt=""
            className="max-h-64 w-full rounded-lg border border-[var(--color-border)] object-cover"
          />
        )}
        <MarkdownDoc source={bodyMarkdown} />
        <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
