import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { useStoryStore, type BeatMapEntry } from '../../stores/storyStore';
import type { NarrativeSection } from '../../types/storyBible';

/**
 * The beat map — what the annotate pass read out of each scene.
 *
 * READ-ONLY, deliberately. The step-3 plan's §3.3 justifies annotate as
 * its own pass so a user can "read the beat map, and correct it before
 * spending render tokens on a wrong reading"; this is the reading half.
 * The correcting half waits for the renderer, because until prose comes
 * out of these numbers there is no way to judge which of them are wrong —
 * an editor built now would be guessing at what is worth editing.
 *
 * Collapsed and lazy by design. The scene-list projection carries no
 * `data`, so every field below means pulling whole scene rows; a bible
 * with hundreds of scenes should not pay that on every Story-tab open for
 * a panel most visits never expand.
 */
export function BeatMapCard() {
  const beatMap = useStoryStore((s) => s.beatMap);
  const beatMapLoading = useStoryStore((s) => s.beatMapLoading);
  const loadBeatMap = useStoryStore((s) => s.loadBeatMap);
  const loadSection = useStoryStore((s) => s.loadSection);
  const sections = useStoryStore((s) => s.sections);
  const [open, setOpen] = useState(false);

  const narrative = sections.narrative?.data as unknown as
    | NarrativeSection
    | undefined;
  const structure = narrative?.structure;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    void loadBeatMap();
    // `narrative` is not in `load()`'s wanted list, so on a fresh tab open
    // the structure line has nothing to read. `loadSection` swallows a
    // 404, which is the common case — the section only exists once an
    // annotate run has detected a structure.
    void loadSection('narrative');
  };

  const annotated = beatMap?.filter((s) => s.beat !== null) ?? [];
  const staleCount = beatMap?.filter((s) => s.stale).length ?? 0;

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        <span className="text-sm text-[var(--color-text-primary)]">Beat map</span>
        <span className="text-xs text-[var(--color-text-secondary)]">
          What each scene does, and how tightly to tell it
        </span>
      </button>

      {open && beatMapLoading && (
        <p className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <Loader2 size={13} className="animate-spin shrink-0" />
          Reading the scenes…
        </p>
      )}

      {open && !beatMapLoading && beatMap && beatMap.length === 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          There are no scenes yet.
        </p>
      )}

      {open && !beatMapLoading && beatMap && beatMap.length > 0 && (
        <>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {annotated.length} of {beatMap.length}{' '}
            {beatMap.length === 1 ? 'scene' : 'scenes'} annotated
            {staleCount > 0 && ` · ${staleCount} to re-check`}
          </p>

          {structure && structure.detected_type !== 'none_yet' && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Structure: {STRUCTURE_LABELS[structure.detected_type]} (
              {Math.round((structure.detection_confidence ?? 0) * 100)}%
              confidence
              {structure.acts.length > 0
                ? `, ${structure.acts.length} ${structure.acts.length === 1 ? 'act' : 'acts'}`
                : ''}
              )
            </p>
          )}

          <ul className="space-y-1.5">
            {beatMap.map((scene) => (
              <BeatRow key={scene.id} scene={scene} />
            ))}
          </ul>

          {annotated.length < beatMap.length && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Scenes without a beat haven’t been annotated yet — run
              Annotate above.
            </p>
          )}
        </>
      )}
    </section>
  );
}

const STRUCTURE_LABELS: Record<string, string> = {
  three_act: 'three act',
  kishotenketsu: 'kishōtenketsu',
  episodic: 'episodic',
  slice_of_life: 'slice of life',
  none_yet: 'none detected',
};

const BEAT_LABELS: Record<string, string> = {
  inciting: 'inciting',
  rising: 'rising',
  midpoint: 'midpoint',
  crisis: 'crisis',
  climax: 'climax',
  denouement: 'denouement',
  interlude: 'interlude',
};

const COMPRESSION_LABELS: Record<string, string> = {
  cut: 'cut',
  compress: 'compress',
  preserve: 'preserve',
  expand: 'expand',
};

function BeatRow({ scene }: { scene: BeatMapEntry }) {
  return (
    <li className="rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-[var(--color-text-secondary)] tabular-nums shrink-0">
          {scene.sequence + 1}.
        </span>
        <span className="text-sm text-[var(--color-text-primary)] min-w-0 truncate">
          {scene.title || '(untitled scene)'}
        </span>
        {scene.beat ? (
          <>
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] shrink-0">
              {BEAT_LABELS[scene.beat] ?? scene.beat}
            </span>
            {scene.tension !== null && (
              // The number is spelled out rather than shown as a bare bar:
              // a 10-point scale drawn as 10 pixels of colour reads as a
              // rating of the scene's quality, which is not what it is.
              <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
                tension {scene.tension}/10
              </span>
            )}
            {scene.compression && (
              <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
                {COMPRESSION_LABELS[scene.compression] ?? scene.compression}
                {scene.compressionRatio !== null &&
                  ` to ${Math.round(scene.compressionRatio * 100)}%`}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
            not annotated
          </span>
        )}
      </div>

      {(scene.mood || scene.stakes || scene.pacingNotes) && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {[scene.mood, scene.stakes, scene.pacingNotes]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {scene.stale && (
        <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
          <TriangleAlert size={12} className="shrink-0 mt-0.5" />
          <span>
            This scene grew after it was annotated, so its beat was read
            from less of it than it now holds. Annotate again to refresh.
          </span>
        </p>
      )}
    </li>
  );
}
