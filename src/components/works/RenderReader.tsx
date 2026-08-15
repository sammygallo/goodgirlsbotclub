import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, RefreshCw } from 'lucide-react';
import {
  storyApi,
  type StorySceneOut,
  type StoryRenderUnit,
  type StoryRenderUnitSummary,
} from '../../api/client';
import { DROP_LABELS, readUnitNotes } from '../../utils/storyRender/unitNotes';
import { showToastGlobal } from '../ui/Toast';
import { Button } from '../ui';
import type { Scene } from '../../types/storyBible';

/** Prose pages are whole chapters, so the server pages them at 25 and this
 *  asks for exactly that rather than inventing a second number. */
const PROSE_PAGE = 25;
/** Unit summaries are tiny; one page covers any realistic render. */
const UNIT_PAGE = 200;
/** Backstop against a server that never stops saying `has_more`. */
const MAX_PAGES = 100;

/**
 * The next keyset cursor, or null when the page was the last one.
 *
 * One definition for all three pagers here, because the rule they share is
 * easy to get subtly wrong in one of them: a SHORT page is not a last page.
 * The server ends a page early on its own byte budget and points the cursor
 * at the last row INCLUDED, so only `has_more` terminates a loop — reading
 * `items.length < limit` as "done" silently truncates the story.
 */
function nextCursor(res: {
  next_after_sequence?: number | null;
  next_after_scene_id?: string | null;
  has_more: boolean;
}): { sequence: number; sceneId: string } | null {
  if (
    !res.has_more ||
    res.next_after_sequence === null ||
    res.next_after_sequence === undefined ||
    res.next_after_scene_id === null ||
    res.next_after_scene_id === undefined
  ) {
    return null;
  }
  return { sequence: res.next_after_sequence, sceneId: res.next_after_scene_id };
}

interface Chapter {
  sceneId: string;
  sequence: number;
  title: string;
  summary: StoryRenderUnitSummary;
  /** Absent until this chapter's prose page has been read. */
  body: StoryRenderUnit | null;
}

/**
 * Reading a finished (or partly finished) render — step 3, phase 5.
 *
 * Two reads, not one, and the split is forced by the API rather than
 * chosen: `is_stale` and `is_orphaned` are derived at read time and live
 * only on the unit SUMMARY (§3.8 — orphan-ness is deliberately never
 * stored, so nothing but the projection computes it), while the prose and
 * its continuity notes live on the prose page. The summaries are cheap and
 * fetched up front so the chapter list and its warnings are complete
 * immediately; the bodies are paged in behind "Load more" because each item
 * is a whole chapter.
 *
 * What this surfaces rather than re-derives, per the Phase 5 handoff notes:
 *
 *  - `truncated` means the chapter is CUT, not failed. It has prose, it was
 *    paid for, and §3.4 blocks it from export until it is rendered again.
 *  - `continuity.unreadable` means the check could not be READ. It is shown
 *    as unverified, never as clean.
 *  - `drops` and `rules_not_active` are the never-silent record of what the
 *    cap and the rule selector left out.
 *  - `is_stale` / `is_orphaned` say the prose no longer matches the scene it
 *    came from. A cosmetic retitle marks a chapter stale, which is accepted:
 *    false-stale is cheap, false-fresh is not.
 */
export function RenderReader({
  projectId,
  renderId,
  scenes,
  canManage,
  disabled,
  onRerender,
  /** Bumped by the parent whenever a run finishes, so the reader re-reads
   *  rather than showing the state from before the render. */
  reloadToken,
}: {
  projectId: string;
  renderId: string;
  scenes: StorySceneOut[];
  canManage: boolean;
  disabled: boolean;
  onRerender: (sceneId: string) => void;
  reloadToken: number;
}) {
  const [summaries, setSummaries] = useState<StoryRenderUnitSummary[] | null>(null);
  const [bodies, setBodies] = useState<Map<string, StoryRenderUnit>>(new Map());
  const [proseCursor, setProseCursor] = useState<
    { sequence: number; sceneId: string } | null
  >(null);
  const [proseHasMore, setProseHasMore] = useState(true);
  const [loadingProse, setLoadingProse] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  /**
   * Which render/reload the currently displayed state belongs to.
   *
   * `loadMoreProse` is fired by a button, so it has no effect cleanup to
   * cancel it — and its response is merged into a Map keyed by `scene_id`.
   * Two renders OF THE SAME STORY carry the same scene ids, so a page that
   * arrives after the user switched runs does not add rows that look wrong;
   * it silently REPLACES the new run's prose with the old run's, and moves
   * the cursor to a position in the wrong run's sequence. The guard has to
   * be an identity check, not a mounted check.
   *
   * Stamped in the effect below rather than during render: that effect's
   * deps ARE this identity, and a click handler cannot run before the effect
   * that reset the state it would be paging.
   */
  const tokenRef = useRef('');

  const titleFor = useMemo(() => {
    const byId = new Map(
      scenes.map((row) => [row.id, (row.data as unknown as Scene)?.title ?? ''])
    );
    return (sceneId: string) => byId.get(sceneId) ?? '';
  }, [scenes]);

  // --- unit summaries -------------------------------------------------
  useEffect(() => {
    const token = `${projectId}\u0000${renderId}\u0000${reloadToken}`;
    tokenRef.current = token;
    let cancelled = false;
    const run = async () => {
      setSummaries(null);
      setBodies(new Map());
      setProseCursor(null);
      setProseHasMore(true);
      setFailed(false);
      try {
        const rows: StoryRenderUnitSummary[] = [];
        let cursor: { sequence: number; sceneId: string } | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await storyApi.listRenderUnits(projectId, renderId, {
            limit: UNIT_PAGE,
            ...(cursor
              ? { afterSequence: cursor.sequence, afterSceneId: cursor.sceneId }
              : {}),
          });
          rows.push(...(res.items ?? []));
          cursor = nextCursor(res);
          if (!cursor) break;
        }
        if (cancelled) return;
        setSummaries(rows);
        if (rows.length === 0) {
          setProseHasMore(false);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        // Only a failure of the SUMMARIES is fatal: without them there is no
        // chapter list to show at all, and "no chapters" and "we could not
        // ask" look identical unless this says which.
        setSummaries([]);
        setFailed(true);
        showToastGlobal(
          error instanceof Error ? error.message : 'Could not read this render',
          'error'
        );
        return;
      }

      // The first prose page comes in with the summaries, in this same pass
      // rather than a follow-up effect: a reader that opens on a list of
      // titles and a Load-more button is a worse first impression than one
      // that opens on the first chapter.
      //
      // Its OWN try, deliberately. Sharing the summaries' one turned a
      // transient failure on this second request into `setSummaries([])` —
      // throwing away a chapter list that had just been read successfully
      // and replacing the whole reader with a fatal error. Leaving the
      // cursor null and `proseHasMore` true instead means the existing
      // "Load more chapters" button re-issues this exact page, which is a
      // real retry rather than a promised one.
      try {
        const first = await storyApi.readRenderProse(projectId, renderId, {
          limit: PROSE_PAGE,
        });
        if (cancelled) return;
        setBodies(new Map((first.items ?? []).map((u) => [u.scene_id, u])));
        const after = nextCursor(first);
        setProseCursor(after);
        setProseHasMore(after !== null);
      } catch (error) {
        if (cancelled) return;
        showToastGlobal(
          error instanceof Error
            ? `Could not read the chapters: ${error.message}`
            : 'Could not read the chapters',
          'error'
        );
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, renderId, reloadToken]);

  // --- prose pages ----------------------------------------------------
  const loadMoreProse = useCallback(async () => {
    if (loadingProse || !proseHasMore) return;
    // Captured BEFORE the await — see `tokenRef`. Everything below is
    // dropped if the reader has moved to another run or been reloaded.
    const token = tokenRef.current;
    setLoadingProse(true);
    try {
      const res = await storyApi.readRenderProse(projectId, renderId, {
        limit: PROSE_PAGE,
        ...(proseCursor
          ? { afterSequence: proseCursor.sequence, afterSceneId: proseCursor.sceneId }
          : {}),
      });
      if (tokenRef.current !== token) return;
      setBodies((prev) => {
        const next = new Map(prev);
        for (const unit of res.items ?? []) next.set(unit.scene_id, unit);
        return next;
      });
      const after = nextCursor(res);
      setProseCursor(after);
      setProseHasMore(after !== null);
    } catch (error) {
      if (tokenRef.current !== token) return;
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not read the prose',
        'error'
      );
    } finally {
      // Cleared unconditionally: the flag is per-component, not per-request,
      // so leaving it set on a superseded page would stick the button on
      // "Loading…" for the run the user actually switched to.
      setLoadingProse(false);
    }
  }, [projectId, renderId, proseCursor, proseHasMore, loadingProse]);

  const chapters: Chapter[] = useMemo(
    () =>
      (summaries ?? [])
        .map((summary) => ({
          sceneId: summary.scene_id,
          sequence: summary.sequence,
          title: titleFor(summary.scene_id),
          summary,
          body: bodies.get(summary.scene_id) ?? null,
        }))
        .sort((a, b) => a.sequence - b.sequence || a.sceneId.localeCompare(b.sceneId)),
    [summaries, bodies, titleFor]
  );

  const truncatedCount = chapters.filter((c) => c.summary.status === 'truncated').length;

  if (summaries === null) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">Loading the story…</p>
    );
  }

  if (failed) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-error)]">
          Couldn't read this render. Nothing has been lost — try again.
        </p>
      </div>
    );
  }

  if (chapters.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">
        No chapters written yet.
      </p>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          The story ({chapters.length}{' '}
          {chapters.length === 1 ? 'chapter' : 'chapters'})
        </h3>
      </div>

      {truncatedCount > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            {truncatedCount} {truncatedCount === 1 ? 'chapter was' : 'chapters were'}{' '}
            cut short by the model's length limit. They're saved and readable,
            but exporting is blocked until{' '}
            {truncatedCount === 1 ? "it's" : "they're"} written again.
          </span>
        </p>
      )}

      <ul className="space-y-2">
        {chapters.map((chapter, i) => (
          <ChapterRow
            key={chapter.sceneId}
            chapter={chapter}
            index={i + 1}
            open={expanded.has(chapter.sceneId)}
            canManage={canManage}
            disabled={disabled}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(chapter.sceneId)) next.delete(chapter.sceneId);
                else next.add(chapter.sceneId);
                return next;
              })
            }
            onRerender={() => onRerender(chapter.sceneId)}
          />
        ))}
      </ul>

      {proseHasMore && (
        <Button
          variant="secondary"
          onClick={() => void loadMoreProse()}
          disabled={loadingProse}
        >
          {loadingProse ? 'Loading…' : 'Load more chapters'}
        </Button>
      )}
    </section>
  );
}

function ChapterRow({
  chapter,
  index,
  open,
  canManage,
  disabled,
  onToggle,
  onRerender,
}: {
  chapter: Chapter;
  index: number;
  open: boolean;
  canManage: boolean;
  disabled: boolean;
  onToggle: () => void;
  onRerender: () => void;
}) {
  const { summary, body } = chapter;
  const notes = useMemo(() => readUnitNotes(body?.continuity), [body]);
  const truncated = summary.status === 'truncated';
  const errored = summary.status === 'error';

  return (
    <li className="rounded-lg bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
        >
          {open ? (
            <ChevronDown size={16} className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
          ) : (
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
          )}
          <span className="min-w-0">
            <span className="block text-sm text-[var(--color-text-primary)] truncate">
              {index}. {chapter.title || 'Untitled scene'}
            </span>
            <span className="block text-xs text-[var(--color-text-secondary)]">
              {errored
                ? 'Not written'
                : truncated
                  ? 'Cut short'
                  : summary.status === 'pending'
                    ? 'Not written yet'
                    : `${Math.max(1, Math.round(summary.prose_bytes / 6))} words, roughly`}
              {summary.is_orphaned
                ? ' · the scene this came from is gone'
                : summary.is_stale
                  ? ' · the scene has changed since'
                  : ''}
            </span>
          </span>
        </button>
        {canManage && (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={onRerender}
            title="Write this chapter again"
          >
            <RefreshCw size={14} />
          </Button>
        )}
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-[var(--color-border)] pt-3">
          {body === null ? (
            <p className="text-sm text-[var(--color-text-secondary)]">
              This chapter hasn't been loaded yet — use “Load more chapters”
              below.
            </p>
          ) : notes.failure ? (
            <p className="flex items-start gap-1.5 text-sm text-[var(--color-warning)]">
              <CircleAlert size={14} className="shrink-0 mt-0.5" />
              <span>{notes.failure}</span>
            </p>
          ) : (
            <>
              <div className="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap leading-relaxed">
                {body.prose}
              </div>
              {truncated && (
                <p className="text-xs text-[var(--color-warning)]">
                  This chapter stopped at the model's length limit
                  {notes.finishReason ? ` (${notes.finishReason})` : ''}, so it
                  ends mid-thought. Write it again to try for a full one.
                </p>
              )}
            </>
          )}

          {body !== null && !notes.failure && (
            <ContinuityNotes notes={notes} />
          )}
        </div>
      )}
    </li>
  );
}

function ContinuityNotes({ notes }: { notes: ReturnType<typeof readUnitNotes> }) {
  const hasDrops = notes.drops.length > 0;
  const hasCaveats =
    notes.approximate || notes.constantsOnly || notes.unresolvedRules > 0;

  return (
    <div className="space-y-1.5 text-xs">
      {/* "Could not be read" is NOT "clean" — the Phase 5 handoff notes call
          this out by name, and stating it as verified is the one thing this
          block must never do. */}
      {notes.unreadable ? (
        <p className="text-[var(--color-warning)]">
          The continuity check didn't come back readable, so this chapter
          hasn't been checked against the story's facts.
        </p>
      ) : notes.verdicts.length === 0 ? (
        <p className="text-[var(--color-text-secondary)]">
          Checked against the story's facts — nothing contradicts them.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-[var(--color-warning)]">
            {notes.verdicts.length}{' '}
            {notes.verdicts.length === 1 ? 'thing' : 'things'} here can't be
            true alongside the story's facts:
          </p>
          <ul className="space-y-1 pl-3">
            {notes.verdicts.map((v, i) => (
              <li key={i} className="text-[var(--color-text-secondary)]">
                <span className="text-[var(--color-text-primary)]">{v.claim}</span>
                {' — '}
                {v.canon}
                {v.severity === 'major' ? ' (major)' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasDrops && (
        <p className="text-[var(--color-text-secondary)]">
          Left out of this chapter to fit:{' '}
          {notes.drops
            .map((d) => `${DROP_LABELS[d.kind] ?? d.kind} (${d.count})`)
            .join(', ')}
          .
        </p>
      )}

      {notes.rulesNotActive > 0 && (
        <p className="text-[var(--color-text-secondary)]">
          {notes.rulesNotActive} lorebook{' '}
          {notes.rulesNotActive === 1 ? 'entry was' : 'entries were'} not active
          in this scene, so {notes.rulesNotActive === 1 ? 'it was' : 'they were'}{' '}
          not used.
        </p>
      )}

      {hasCaveats && (
        <p className="text-[var(--color-text-secondary)]">
          {notes.constantsOnly
            ? 'This scene has no reply from the character, so only always-on lorebook entries reached it.'
            : notes.approximate
              ? 'Which lorebook entries were active was reconstructed from the chat rather than measured, so treat it as approximate.'
              : ''}
          {notes.unresolvedRules > 0
            ? ` ${notes.unresolvedRules} lorebook ${
                notes.unresolvedRules === 1 ? 'entry' : 'entries'
              } couldn't be found in your current books.`
            : ''}
        </p>
      )}
    </div>
  );
}
