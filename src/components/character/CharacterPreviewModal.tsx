import { MessageCircle, Tag } from 'lucide-react';
import { Modal, Button } from '../ui';
import { CharacterRichText } from './CharacterRichText';
import type { CharacterInfo } from '../../api/client';

interface CharacterPreviewModalProps {
  isOpen: boolean;
  character: CharacterInfo | null;
  onClose: () => void;
  onStartChat: (avatar: string) => void;
}

/**
 * Read-only preview of a character — surfaced before the user commits to
 * opening a chat. Shows the avatar, tags, and the creator's notes (the
 * author-written, user-facing blurb) only — deliberately NOT the prompt
 * internals (description, personality, scenario, first message), which are
 * model-facing and not meant as preview reading.
 *
 * Triggered from the character list (sidebar) by the per-row info button;
 * not used from any flow that already has the character loaded.
 */
export function CharacterPreviewModal({
  isOpen,
  character,
  onClose,
  onStartChat,
}: CharacterPreviewModalProps) {
  if (!character) return null;

  // Prefer the canonical CharacterInfo fields, falling back to nested
  // `data.*` for V2 cards that only populated the spec-shape copy.
  const creator =
    character.creator?.trim() || character.data?.creator?.trim() || '';
  const creatorNotes =
    character.creator_notes?.trim() || character.data?.creator_notes?.trim() || '';
  const tags = character.tags ?? character.data?.tags ?? [];

  const fullAvatarUrl = `/blobs/character/${encodeURIComponent(character.avatar)}`;

  const handleStartChat = () => {
    onStartChat(character.avatar);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={character.name} size="lg">
      <div className="space-y-4">
        {/* Avatar — full size so creator art reads properly */}
        <div className="flex justify-center">
          <img
            src={fullAvatarUrl}
            alt={character.name}
            className="max-h-72 w-auto rounded-lg border border-[var(--color-border)] object-cover"
          />
        </div>

        {/* Creator line */}
        {creator && (
          <p className="text-xs text-[var(--color-text-secondary)] text-center">
            by {creator}
            {character.character_version && ` · v${character.character_version}`}
          </p>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Tag size={14} className="text-[var(--color-text-secondary)] mt-0.5" />
            {tags.map((tag) => (
              <span
                key={tag}
                className="text-[11px] px-2 py-0.5 leading-5 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] rounded-full border border-[var(--color-border)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Creator notes — the only detail surfaced here */}
        {creatorNotes && (
          <PreviewSection label="Creator notes" body={creatorNotes} />
        )}

        {/* Empty-state — no creator notes to show */}
        {!creatorNotes && (
          <p className="text-sm text-[var(--color-text-secondary)] italic text-center py-6">
            This character doesn&apos;t have any creator notes yet.
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className="flex-1"
          >
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleStartChat}
            className="flex-1"
          >
            <MessageCircle size={16} />
            Chat with {character.name}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface PreviewSectionProps {
  label: string;
  body: string;
}

function PreviewSection({ label, body }: PreviewSectionProps) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
        {label}
      </h3>
      <CharacterRichText content={body} />
    </section>
  );
}
