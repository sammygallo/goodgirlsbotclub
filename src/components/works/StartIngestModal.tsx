import { useState } from 'react';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { Button, Modal } from '../ui';

/**
 * Pre-flight for a bible build (story-state phase 6).
 *
 * Two things the user must see before we spend their key: WHICH model
 * this will run on (their own connection profiles, so a cheap one can be
 * picked for a long job), and roughly HOW MUCH it will cost. The
 * estimate is framed as an estimate everywhere, because it comes from a
 * tokenizer profile rather than the provider's own accounting and will
 * be wrong by tens of percent on some providers.
 */
export function StartIngestModal({
  estimatedTokens,
  onStart,
  onClose,
  busy,
}: {
  estimatedTokens: number;
  onStart: (profileId: string | null) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const { profiles, activeProfileId } = useConnectionProfileStore();
  const [profileId, setProfileId] = useState<string | null>(activeProfileId);

  return (
    <Modal isOpen onClose={onClose} title="Build the story groundwork">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          This reads the character card, your persona and any lorebooks to
          lay the groundwork for the story. It runs on your own API key.
        </p>

        {profiles.length > 0 && (
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
              Connection
            </span>
            <select
              value={profileId ?? ''}
              onChange={(e) => setProfileId(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
            >
              <option value="">Current connection</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-3 space-y-1">
          <p className="text-sm text-[var(--color-text-primary)]">
            ~{estimatedTokens.toLocaleString()} tokens (estimated)
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            A rough figure from our own tokenizer, not your provider's
            count — treat it as a ballpark. Two model calls, plus a
            keyword pass that costs nothing.
          </p>
        </div>

        <p className="text-xs text-[var(--color-text-secondary)]">
          Whatever your chat contains goes to your chosen provider, under
          their terms — the same as any message you send from a chat.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onStart(profileId)}
            disabled={busy}
          >
            {busy ? 'Starting…' : 'Build groundwork'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
