// Markdown export for a finished render (step 3, phase 6).
//
// Pure and network-free, like every other module in this directory: the
// caller pages `readRenderProse` to exhaustion, joins each chapter to its
// unit summary and its scene title, and hands the result here. That split
// is what lets the whole of §5's test list run in plain node, and it is
// the same shape `contextAssembler` uses for the same reason.
//
// Two exports, and the order they run in matters:
//
//   1. `exportBlockers` — the phase-6 plan's Decision 1 gate. Runs on unit
//      SUMMARIES, before a single byte of prose is paged, because a run
//      that cannot be exported should cost nothing to discover.
//   2. `renderMarkdown` — the serializer, which assumes the gate passed.
//
// The gate is not advisory. Once the file is on the user's disk it has
// left every guard rail this codebase has, so "finished-looking output
// that is secretly cut" has to be stopped here or not at all.

import type { StoryRenderUnitStatus } from '../../api/client';
import type { RenderingHintsSection } from '../../types/storyBible';

/** Why a chapter blocks the export. Every one of these means the run does
 *  not currently hold a complete book. */
export type BlockerReason =
  /** `finish_reason: length`, or a stream that ended with no terminal
   *  signal at all (§3.4). There IS prose; it stops mid-thought. */
  | 'truncated'
  /** The scene's model call failed. */
  | 'error'
  /** A unit row exists but never got its call. */
  | 'pending'
  /** No unit row at all — the run never reached this scene. The usual
   *  cause is a paused run, where exporting what exists would produce a
   *  two-chapter book out of a forty-scene story. */
  | 'missing';

export interface ExportBlocker {
  sceneId: string;
  /** Position in the RUN's range, 0-based — what the reader labels
   *  "Chapter n+1". */
  sequence: number;
  title: string;
  reason: BlockerReason;
}

/** One chapter's worth of input: a unit joined to its summary flags and
 *  the title of the scene it was rendered from. */
export interface ExportUnit {
  sceneId: string;
  sequence: number;
  prose: string;
  status: StoryRenderUnitStatus;
  /** The scene was written after this prose was rendered from it. */
  isStale: boolean;
  /** The scene it was rendered from no longer exists. */
  isOrphaned: boolean;
}

export interface MarkdownInput {
  /** Shown as the document's H1. The work's name, not the run's. */
  title: string;
  /** Every chapter to write, any order — this sorts. */
  units: ExportUnit[];
  /** Scene id → the scene's own title, for chapters `chapter_titles` does
   *  not name. A missing entry is fine and falls back. */
  sceneTitles: Map<string, string>;
  /** `chapter_breaks` and `chapter_titles` come from here. Null means the
   *  user has set no hints, which is the one-chapter-per-scene default. */
  hints: RenderingHintsSection['novel'] | null;
  /**
   * The run's range anchors could not be resolved against the current
   * scene list, so nobody could check whether chapters are MISSING.
   *
   * The statuses of the units that exist still gated this export; what
   * could not be established is whether the run covered scenes it has no
   * row for. Said out loud in the notice rather than silently assumed
   * either way — §3.5's never-silent rule applied to the export itself.
   */
  completenessUnverified?: boolean;
}

/**
 * Everything that would stop this run exporting, in reading order.
 *
 * An empty array means the run is exportable. `sceneRange` is the run's
 * OWN range (`scene_id_start`..`scene_id_end` resolved against the scene
 * list), not the current bible — a run owns the scenes it was created
 * with, and a scene added to the bible afterwards is not a hole in this
 * book.
 */
export function exportBlockers(
  sceneRange: { id: string; sequence: number }[],
  units: { sceneId: string; status: StoryRenderUnitStatus }[],
  sceneTitles: Map<string, string>
): ExportBlocker[] {
  const byScene = new Map(units.map((u) => [u.sceneId, u.status]));
  const out: ExportBlocker[] = [];

  // Indexed off the RANGE, not off the units, so a scene with no unit row
  // is caught. Iterating the units would report only the chapters that
  // exist and silently accept a run that stopped a third of the way in.
  sceneRange.forEach((scene, i) => {
    const status = byScene.get(scene.id);
    const reason: BlockerReason | null =
      status === undefined
        ? 'missing'
        : status === 'complete'
          ? null
          : status;
    if (!reason) return;
    out.push({
      sceneId: scene.id,
      sequence: i,
      title: chapterLabel(i, sceneTitles.get(scene.id)),
      reason,
    });
  });

  return out;
}

/** Human phrasing for a blocker, for the refusal the tab shows. Separate
 *  from the reason code so the copy can change without the callers
 *  re-deriving it from a union. */
export function blockerMessage(reason: BlockerReason): string {
  switch (reason) {
    case 'truncated':
      return 'stops mid-chapter';
    case 'error':
      return 'failed to render';
    case 'pending':
      return 'was never written';
    case 'missing':
      return 'is not in this render yet';
  }
}

/**
 * Serialize a passing run to Markdown.
 *
 * Assumes `exportBlockers` returned empty: every unit here is `complete`.
 * Stale and orphaned chapters are NOT blockers (Decision 2) — that prose
 * is finished and was paid for — but they are named in a comment block at
 * the top so the fact travels with the file without touching the prose
 * body, which the user is likely pasting somewhere else.
 */
export function renderMarkdown(input: MarkdownInput): string {
  const units = [...input.units].sort(
    (a, b) => a.sequence - b.sequence || a.sceneId.localeCompare(b.sceneId)
  );
  if (units.length === 0) return '';

  const parts: string[] = [];

  const notice = staleNotice(
    units,
    input.sceneTitles,
    input.completenessUnverified === true
  );
  if (notice) parts.push(notice);

  parts.push(`# ${input.title.trim() || 'Untitled'}`);

  for (const chapter of groupChapters(units, input.hints)) {
    const title = chapterTitle(chapter, input.sceneTitles, input.hints);
    parts.push(`## ${title}`);
    // One blank line between scenes inside a chapter. The prose is the
    // model's own paragraphing and is emitted verbatim — reflowing it
    // here would silently rewrite output the user paid for.
    parts.push(chapter.map((u) => u.prose.trim()).filter(Boolean).join('\n\n'));
  }

  // Exactly one trailing newline: POSIX-shaped, and it keeps a diff of two
  // exports of the same book to the chapters that actually changed.
  return parts.join('\n\n').replace(/\n+$/, '') + '\n';
}

/**
 * Chapters, as lists of consecutive units.
 *
 * With no `chapter_breaks` set, every scene is its own chapter — today's
 * implicit behaviour, made explicit. With breaks set, a new chapter starts
 * at each named scene and everything between falls into the preceding one,
 * which is what lets a user group a run of short scenes into one chapter.
 *
 * The first unit always starts a chapter whether or not it is named, so a
 * break on it cannot produce an empty leading chapter. A break naming a
 * scene outside this run is ignored rather than throwing — the hints are
 * bible-wide and long-lived, and a run over scenes 10–20 will routinely
 * see breaks belonging to scenes 1–9.
 */
function groupChapters(
  units: ExportUnit[],
  hints: RenderingHintsSection['novel'] | null
): ExportUnit[][] {
  const breaks = new Set(
    (hints?.chapter_breaks ?? []).filter((id): id is string => typeof id === 'string')
  );
  if (breaks.size === 0) return units.map((u) => [u]);

  const out: ExportUnit[][] = [];
  for (const unit of units) {
    if (out.length === 0 || breaks.has(unit.sceneId)) out.push([unit]);
    else out[out.length - 1].push(unit);
  }
  return out;
}

/** A chapter is titled by its FIRST scene: an explicit `chapter_titles`
 *  entry, else that scene's own title, else its position. An entry that is
 *  present but blank falls back rather than emitting an empty heading. */
function chapterTitle(
  chapter: ExportUnit[],
  sceneTitles: Map<string, string>,
  hints: RenderingHintsSection['novel'] | null
): string {
  const first = chapter[0];
  const explicit = (hints?.chapter_titles ?? []).find(
    (t) => t && typeof t === 'object' && t.scene_id === first.sceneId
  );
  const named = typeof explicit?.title === 'string' ? explicit.title.trim() : '';
  if (named) return named;
  return chapterLabel(first.sequence, sceneTitles.get(first.sceneId));
}

/** Shared by the serializer and the blocker list so a chapter is named the
 *  same way in the refusal as it is in the file. */
function chapterLabel(sequence: number, sceneTitle: string | undefined): string {
  const title = (sceneTitle ?? '').trim();
  return title || `Chapter ${sequence + 1}`;
}

/**
 * The Decision 2 comment block, or null when there is nothing to say.
 *
 * An HTML comment rather than YAML front matter: it survives a paste into
 * a document that has no front-matter parser, and it does not become a
 * visible metadata table in the renderers that do.
 */
function staleNotice(
  units: ExportUnit[],
  sceneTitles: Map<string, string>,
  completenessUnverified: boolean
): string | null {
  const stale = units.filter((u) => u.isStale && !u.isOrphaned);
  const orphaned = units.filter((u) => u.isOrphaned);
  if (stale.length === 0 && orphaned.length === 0 && !completenessUnverified) {
    return null;
  }

  const name = (u: ExportUnit) => chapterLabel(u.sequence, sceneTitles.get(u.sceneId));
  const lines = ['<!--', 'Exported from Good Girls Bot Club.', ''];

  if (stale.length > 0) {
    lines.push(
      `These chapters were written before their scene was last edited, so the`,
      `prose may not match the current story: ${stale.map(name).join(', ')}.`,
      `Re-render them if that matters.`,
      ''
    );
  }
  if (orphaned.length > 0) {
    lines.push(
      `These chapters were written from scenes that no longer exist. The prose`,
      `is kept as written and cannot be re-rendered: ${orphaned.map(name).join(', ')}.`,
      ''
    );
  }

  if (completenessUnverified) {
    lines.push(
      `The scenes this render was made from have changed, so we could not`,
      `check whether any chapters are missing from it. What is here is`,
      `everything the render holds.`,
      ''
    );
  }

  lines.push('-->');
  return lines.join('\n');
}
