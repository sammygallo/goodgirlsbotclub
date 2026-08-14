import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { isWeakModel } from '../../utils/storyIngest/modelStrength';
import { Button, Modal } from '../ui';

/** Copy that differs between the two passes this preflight fronts. The
 *  structure — connection picker, weak-model warning, token estimate,
 *  provider-terms note — is identical for both, and duplicating it into a
 *  second modal is how the two would drift. */
const COPY = {
  build: {
    title: 'Build the story groundwork',
    lead: 'This reads the character card, your persona and any lorebooks to lay the groundwork for the story. It runs on your own API key.',
    estimateNote:
      "A rough figure from our own tokenizer, not your provider's count — treat it as a ballpark. It covers the groundwork's two model calls; reading the chat and checking it for contradictions cost more on top, sized to how long the story is.",
    confirm: 'Build groundwork',
  },
  annotate: {
    title: 'Annotate the scenes',
    lead: "This reads each scene and records what it does — its beat, how tense it is, and how tightly it should be told when the story is written out. It runs on your own API key.",
    estimateNote:
      "A rough figure from our own tokenizer, not your provider's count — treat it as a ballpark. It assumes every scene needs annotating; scenes already annotated are skipped, so the real figure is often lower.",
    confirm: 'Annotate scenes',
  },
} as const;

/**
 * Pre-flight for a bible build (story-state phase 6) or an annotate run
 * (step 3 phase 2).
 *
 * Two things the user must see before we spend their key: WHICH model
 * this will run on (their own connection profiles, so a cheap one can be
 * picked for a long job), and roughly HOW MUCH it will cost. The
 * estimate is framed as an estimate everywhere, because it comes from a
 * tokenizer profile rather than the provider's own accounting and will
 * be wrong by tens of percent on some providers.
 *
 * The weak-model warning applies to both passes for the same reason:
 * each depends on the model consistently returning structured output.
 */
export function StartIngestModal({
  mode = 'build',
  estimatedTokens,
  onStart,
  onClose,
  busy,
}: {
  mode?: 'build' | 'annotate';
  estimatedTokens: number;
  onStart: (profileId: string | null) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const copy = COPY[mode];
  const { profiles, activeProfileId } = useConnectionProfileStore();
  const [profileId, setProfileId] = useState<string | null>(activeProfileId);
  const settingsActiveModel = useSettingsStore((s) => s.activeModel);

  // The model this build will actually run on: the chosen profile's, or
  // the app's current connection when "Current connection" is selected.
  const selectedModel = profileId
    ? (profiles.find((p) => p.id === profileId)?.model ?? null)
    : settingsActiveModel;
  const weakModel = isWeakModel(selectedModel);

  return (
    <Modal isOpen onClose={onClose} title={copy.title}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">{copy.lead}</p>

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

        {weakModel && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              This looks like a smaller/cheaper model. This pass relies on
              the model consistently returning structured output — a
              stronger model will generally give more reliable results,
              but this one can still run now.
            </span>
          </p>
        )}

        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-3 space-y-1">
          <p className="text-sm text-[var(--color-text-primary)]">
            ~{estimatedTokens.toLocaleString()} tokens (estimated)
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {copy.estimateNote}
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
            {busy ? 'Starting…' : copy.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
