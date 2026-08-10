import { useState } from 'react';
import { PenLine } from 'lucide-react';
import { useStoryStore } from '../../stores/storyStore';
import { Button, TextArea } from '../ui';
import type { SamplePassage, UserVoiceSection } from '../../types/storyBible';

/**
 * Below this, the model is saying it could not hear the user's voice well
 * enough to write in it. Exported because it is a product threshold, not a
 * styling detail: the copy the user sees flips here, and anything else
 * reasoning about "do we have a voice read" must agree with this surface.
 */
export const VOICE_CONFIDENCE_THRESHOLD = 0.5;

const REGISTER_LABEL: Record<UserVoiceSection['register'], string> = {
  literary: 'Literary',
  commercial: 'Commercial',
  pulp: 'Pulp',
  experimental: 'Experimental',
  mixed: 'Mixed',
};

/**
 * Voice confidence meter (story-state phase 10, §6.4).
 *
 * Three jobs, all read-only about the model's own numbers: show how well
 * the build thinks it heard the user's prose voice, show where the sample
 * passages came from, and — when the read is weak — ask for real writing
 * instead of pretending.
 *
 * `confidence` is the model's self-assessment (D6). This surface NEVER
 * writes it, and adding a sample deliberately does not bump it: a meter
 * the client can nudge is a meter that stops meaning anything. Nor does
 * anything here call a model — the fix for a low read is the user's own
 * paragraph, not another paid pass.
 */
export function VoiceConfidenceCard({
  voice,
  canManage,
  disabled,
}: {
  voice: UserVoiceSection | undefined;
  canManage: boolean;
  disabled: boolean;
}) {
  const appendSamplePassage = useStoryStore((s) => s.appendSamplePassage);
  const isSaving = useStoryStore((s) => s.isSaving);
  const [draft, setDraft] = useState('');
  /** Only meaningful at or above the threshold, where the textarea is
   *  folded behind "Add a writing sample". Below it, the textarea is the
   *  point of the card and is always open. */
  const [composerOpen, setComposerOpen] = useState(false);

  // The lead gates the mount on the section existing; this is the second
  // lock on the same door, because `sections.user_voice` is a lazy load
  // and an unbuilt bible legitimately has nothing here.
  if (!voice) return null;

  // Section data arrives as `Record<string, unknown>` on the wire and is
  // cast into shape upstream, so treat the numbers as claims: a NaN or an
  // out-of-range float should render an honest 0%, never a broken bar.
  const confidence = Number.isFinite(voice.confidence)
    ? Math.min(1, Math.max(0, voice.confidence))
    : 0;
  const pct = Math.round(confidence * 100);
  const weak = confidence < VOICE_CONFIDENCE_THRESHOLD;

  const passages: SamplePassage[] = Array.isArray(voice.sample_passages)
    ? voice.sample_passages
    : [];
  // `user_annotation` is the provenance terminator — it is the only kind
  // that means "the user typed this", so everything else is walk-captured.
  const userAdded = passages.filter(
    (p) => p.source?.kind === 'user_annotation'
  ).length;
  const walkCaptured = passages.length - userAdded;

  // The fallback is unreachable by types and deliberate anyway: a register
  // added server-side ahead of this map would otherwise render "undefined"
  // where a label belongs.
  const register = REGISTER_LABEL[voice.register] ?? 'Unclassified';
  const canSubmit = draft.trim().length > 0 && !isSaving && !disabled;

  const submit = async () => {
    if (!canSubmit) return;
    // No toast of our own — appendSamplePassage owns success, eviction
    // and conflict messaging, including the "oldest one dropped" case.
    const ok = await appendSamplePassage(draft);
    if (ok) {
      setDraft('');
      setComposerOpen(false);
    }
  };

  const composer = (
    <div className="space-y-2">
      <TextArea
        rows={5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={isSaving || disabled}
        placeholder="Paste a paragraph or two of your own prose…"
        aria-label="Writing sample"
      />
      <div className="flex justify-end gap-2">
        {!weak && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft('');
              setComposerOpen(false);
            }}
            disabled={isSaving}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!canSubmit}
        >
          {isSaving ? 'Adding…' : 'Add sample'}
        </Button>
      </div>
    </div>
  );

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          Your writing voice
        </h3>
        <span className="text-xs text-[var(--color-text-secondary)]">
          {register}
        </span>
      </div>

      <div className="space-y-1.5">
        <div
          className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden"
          role="meter"
          aria-label="Voice read confidence"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}% confident`}
        >
          <div
            className={`h-full transition-[width] duration-300 ${
              weak ? 'bg-[var(--color-warning)]' : 'bg-[var(--color-accent)]'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {/* Framed as the model's own read, not a score of the user's
              writing — it is an assessment of the evidence available, and
              a low number is our shortfall to fix, not theirs. */}
          {pct}% — how well the build thinks it read your voice
        </p>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)]">
        {passages.length === 0
          ? 'No writing samples yet'
          : `${passages.length} writing ${
              passages.length === 1 ? 'sample' : 'samples'
            } · ${walkCaptured} from your chat · ${userAdded} you added`}
      </p>

      {weak && (
        <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3 space-y-2">
          <p className="text-sm text-[var(--color-text-primary)]">
            {/* The schema doc's own words, kept verbatim: this is the one
                place the low-confidence contract is spoken to the user. */}
            We don't have a strong read on your voice — paste a paragraph
            or two you've written elsewhere.
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Anything you wrote yourself works: chat prose, a scrap of a
            draft, an old story. Nothing is sent to a model here — it's
            kept as a sample for later.
          </p>
          {canManage && composer}
        </div>
      )}

      {!weak && canManage && !composerOpen && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setComposerOpen(true)}
          disabled={disabled}
          className="gap-1.5"
        >
          <PenLine size={13} />
          Add a writing sample
        </Button>
      )}

      {!weak && canManage && composerOpen && composer}
    </section>
  );
}
