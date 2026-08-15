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
  const seen = new Set<string>();

  // Pass 1, indexed off the RANGE so a scene with no unit row is caught.
  // Iterating only the units would report the chapters that exist and
  // silently accept a run that stopped a third of the way in.
  sceneRange.forEach((scene, i) => {
    seen.add(scene.id);
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

  // Pass 2 — the units the range does NOT cover.
  //
  // A unit whose scene has left the bible still has its prose exported
  // (Decision 2 keeps orphaned chapters), so its STATUS still has to gate.
  // Without this, deleting a scene mid-run — which `mergeSceneIntoPrevious`
  // does in one click, and which §3.8 deliberately leaves the unit row
  // behind for — takes that unit out of the range and lets a truncated or
  // errored chapter into the file. That is the artifact Decision 1 exists
  // to prevent, and the worst variant of it: the scene is gone, so no
  // re-render can fix it.
  //
  // A `complete` unit out here is fine. That is exactly the orphaned
  // chapter Decision 2 says to export.
  units.forEach((u, i) => {
    if (seen.has(u.sceneId) || u.status === 'complete') return;
    out.push({
      sceneId: u.sceneId,
      sequence: sceneRange.length + i,
      title: chapterLabel(sceneRange.length + i, sceneTitles.get(u.sceneId)),
      reason: u.status,
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

  // Position WITHIN THIS RUN, not `unit.sequence`.
  //
  // `sequence` is the scene's bible-wide index, so a run over scenes 10-20
  // would number its first chapter 11 while the refusal dialog — which
  // counts from the run's own range — calls the same chapter 1. Two names
  // for one chapter is worse than either name alone, and the reader
  // already labels rows by position.
  const positions = new Map(units.map((u, i) => [u.sceneId, i]));

  const parts: string[] = [];

  const notice = staleNotice(
    units,
    input.sceneTitles,
    positions,
    input.completenessUnverified === true
  );
  if (notice) parts.push(notice);

  parts.push(`# ${escapeInline(input.title.trim()) || 'Untitled'}`);

  for (const chapter of groupChapters(units, input.hints)) {
    const title = chapterTitle(chapter, input.sceneTitles, input.hints, positions);
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
  hints: RenderingHintsSection['novel'] | null,
  positions: Map<string, number>
): string {
  const first = chapter[0];
  const explicit = (hints?.chapter_titles ?? []).find(
    (t) => t && typeof t === 'object' && t.scene_id === first.sceneId
  );
  const named = typeof explicit?.title === 'string' ? explicit.title.trim() : '';
  const raw =
    named || chapterLabel(positions.get(first.sceneId) ?? 0, sceneTitles.get(first.sceneId));
  return escapeInline(raw);
}

/** Shared by the serializer and the blocker list so a chapter is named the
 *  same way in the refusal as it is in the file. Both callers pass a
 *  position within the RUN — see the `positions` note in `renderMarkdown`. */
function chapterLabel(position: number, sceneTitle: string | undefined): string {
  const title = (sceneTitle ?? '').trim();
  return title || `Chapter ${position + 1}`;
}

/**
 * Flatten free text that is about to be interpolated into a heading.
 *
 * Scene titles and chapter titles are user- and model-authored: the scene
 * editor is a plain 200-char input and the walk stores whatever the model
 * wrote. A newline in one would end the `## ` heading and let the rest of
 * the title become body text — or, starting with `#`, a second heading.
 */
function escapeInline(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/** Neutralise an HTML-comment terminator in text going INSIDE the notice
 *  block. `--` is enough to break it in strict parsers, so both forms are
 *  softened rather than only the exact `-->`. */
function escapeComment(text: string): string {
  return escapeInline(text).replace(/--+>?/g, (m) => m.replace(/-/g, '‑'));
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
  positions: Map<string, number>,
  completenessUnverified: boolean
): string | null {
  const stale = units.filter((u) => u.isStale && !u.isOrphaned);
  const orphaned = units.filter((u) => u.isOrphaned);
  if (stale.length === 0 && orphaned.length === 0 && !completenessUnverified) {
    return null;
  }

  // `escapeComment` because a scene title is free text and this block is
  // the one place a title is interpolated INSIDE an HTML comment: a title
  // containing `-->` would close the comment early and spill the rest of
  // the notice — and every chapter after it — into the visible document.
  const name = (u: ExportUnit) =>
    escapeComment(
      chapterLabel(positions.get(u.sceneId) ?? 0, sceneTitles.get(u.sceneId))
    );
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
