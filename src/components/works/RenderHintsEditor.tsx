import { useMemo, useState } from 'react';
import { useStoryStore } from '../../stores/storyStore';
import { Button, Input } from '../ui';
import {
  emptyRenderingHintsSection,
  type BibleCharacter,
  type EntitiesSection,
  type NarrativeSection,
  type RenderPov,
  type RenderingHintsSection,
} from '../../types/storyBible';

/**
 * How the novel should read (productization step 3, phase 5).
 *
 * These four choices are the ones the prose prompt actually consumes:
 * `resolveHints` maps them onto the brief, and everything else in
 * `rendering_hints.novel` (`chapter_breaks`, `chapter_titles`) is Phase 6's
 * exporter, not this phase's.
 *
 * **POV and tense are deliberately three-state, not two.** Null is not
 * "unset waiting for a default" — it IS the choice to defer to the bible's
 * own `narrative.pov_default` / `tense_default`, which the annotate pass
 * derives from how the story was actually played. Collapsing null into a
 * concrete value at the form layer would silently override the bible's
 * reading with the first item in a dropdown, and the user would have no
 * way back to it. So "Follow the story" is a real, selectable option, and
 * the label says which value it resolves to.
 *
 * The editor writes ONLY on Save. A save-per-keystroke against a section
 * with `base_ts` concurrency would turn a typed word count into a dozen
 * conflicting writes.
 */
export function RenderHintsEditor({ disabled }: { disabled: boolean }) {
  const sections = useStoryStore((s) => s.sections);
  const isSaving = useStoryStore((s) => s.isSaving);
  const saveNovelHints = useStoryStore((s) => s.saveNovelHints);

  const stored = sections.rendering_hints?.data as
    | unknown as RenderingHintsSection
    | undefined;
  const narrative = sections.narrative?.data as
    | unknown as NarrativeSection
    | undefined;
  const entities = sections.entities?.data as
    | unknown as EntitiesSection
    | undefined;

  const novel = stored?.novel ?? emptyRenderingHintsSection().novel;
  const characters: BibleCharacter[] = entities?.characters ?? [];

  // Re-seeded whenever the server row advances, via the `key` its parent
  // gives this component. Holding drafts across a save without that would
  // show the user their own pre-save text as if it were stored state.
  const [pov, setPov] = useState<RenderPov | null>(novel.pov ?? null);
  const [povCharacter, setPovCharacter] = useState<string | null>(
    novel.pov_character ?? null
  );
  const [tense, setTense] = useState<'past' | 'present' | null>(novel.tense ?? null);
  const [compression, setCompression] = useState(novel.compression_level ?? 'balanced');
  const [wordCount, setWordCount] = useState(
    novel.target_word_count === null || novel.target_word_count === undefined
      ? ''
      : String(novel.target_word_count)
  );
  const [anchors, setAnchors] = useState((novel.style_anchors ?? []).join('\n'));

  const parsedWordCount = useMemo(() => {
    const trimmed = wordCount.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }, [wordCount]);
  const wordCountInvalid = wordCount.trim() !== '' && parsedWordCount === null;

  const anchorList = useMemo(
    () =>
      anchors
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    [anchors]
  );

  const dirty =
    pov !== (novel.pov ?? null) ||
    povCharacter !== (novel.pov_character ?? null) ||
    tense !== (novel.tense ?? null) ||
    compression !== (novel.compression_level ?? 'balanced') ||
    parsedWordCount !== (novel.target_word_count ?? null) ||
    anchorList.join('\u0000') !== (novel.style_anchors ?? []).join('\u0000');

  const save = () =>
    void saveNovelHints({
      pov,
      // A POV character is meaningless outside first/third-limited, and
      // leaving a stale one behind would have the prompt name a viewpoint
      // holder the POV no longer has.
      pov_character: pov === 'first' || pov === 'third_limited' ? povCharacter : null,
      tense,
      compression_level: compression,
      target_word_count: parsedWordCount,
      style_anchors: anchorList,
    });

  const povDefaultLabel = narrative?.pov_default
    ? POV_LABELS[narrative.pov_default]
    : 'not set yet';
  const tenseDefaultLabel = narrative?.tense_default ?? 'not set yet';

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm text-[var(--color-text-primary)]">How it should read</h3>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          Applied to every scene of the next render. A run keeps the settings
          it started with, so changing these never rewrites prose you already
          have.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Point of view
          </span>
          <select
            value={pov ?? ''}
            disabled={disabled}
            onChange={(e) => setPov((e.target.value || null) as RenderPov | null)}
            className={SELECT_CLASS}
          >
            <option value="">Follow the story ({povDefaultLabel})</option>
            <option value="first">First person</option>
            <option value="third_limited">Third person, limited</option>
            <option value="third_omniscient">Third person, omniscient</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Tense
          </span>
          <select
            value={tense ?? ''}
            disabled={disabled}
            onChange={(e) =>
              setTense((e.target.value || null) as 'past' | 'present' | null)
            }
            className={SELECT_CLASS}
          >
            <option value="">Follow the story ({tenseDefaultLabel})</option>
            <option value="past">Past</option>
            <option value="present">Present</option>
          </select>
        </label>

        {/* Only where a viewpoint holder means anything. Omniscient has no
            single one, and offering the control there invites a setting
            that is then silently discarded on save. */}
        {(pov === 'first' || pov === 'third_limited') && characters.length > 0 && (
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
              Whose eyes
            </span>
            <select
              value={povCharacter ?? ''}
              disabled={disabled}
              onChange={(e) => setPovCharacter(e.target.value || null)}
              className={SELECT_CLASS}
            >
              <option value="">Let each scene decide</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.canonical_name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Compression
          </span>
          <select
            value={compression}
            disabled={disabled}
            onChange={(e) =>
              setCompression(e.target.value as RenderingHintsSection['novel']['compression_level'])
            }
            className={SELECT_CLASS}
          >
            <option value="tight">Tight — cut hard, keep the spine</option>
            <option value="balanced">Balanced</option>
            <option value="loose">Loose — stay close to the chat</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Words per chapter (optional)
          </span>
          <Input
            value={wordCount}
            disabled={disabled}
            inputMode="numeric"
            placeholder="Let the scene decide"
            onChange={(e) => setWordCount(e.target.value)}
          />
          {wordCountInvalid && (
            <span className="block text-xs text-[var(--color-warning)]">
              Needs to be a number above zero — leave it blank to let each
              scene decide.
            </span>
          )}
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          Style notes, one per line (optional)
        </span>
        <textarea
          value={anchors}
          disabled={disabled}
          rows={3}
          placeholder={'Sparse, concrete description\nNo dream sequences'}
          onChange={(e) => setAnchors(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)] disabled:opacity-50"
        />
      </label>

      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={disabled || !dirty || wordCountInvalid || isSaving}
          onClick={save}
        >
          {isSaving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </section>
  );
}

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)] disabled:opacity-50';

const POV_LABELS: Record<RenderPov, string> = {
  first: 'first person',
  third_limited: 'third person, limited',
  third_omniscient: 'third person, omniscient',
};
