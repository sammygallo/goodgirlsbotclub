// Collecting a finished render for export (step 3, phase 6).
//
// The network half of the export path: `exportMarkdown` is pure and knows
// nothing about paging, and this module is the only thing between it and
// the API. Split that way so the serializer's rules — the gate, the
// grouping, the notice — stay testable in plain node, and so the two
// paging loops here have one obvious place to be got right.
//
// Both loops page on `has_more` ALONE. A short page is not a last page:
// the server can end one early on its own byte budget and the cursor then
// points at the last row INCLUDED, so the next request resumes at the
// first row it dropped. Stopping on a short page would silently produce a
// truncated book — which is the exact failure Decision 1's gate exists to
// prevent, arriving through a different door. It is the reason the plan
// singles this out for a mutation-tested pin.

import { storyApi } from '../../api/client';
import type {
  StoryRenderUnit,
  StoryRenderUnitSummary,
  StorySceneOut,
} from '../../api/client';
import type { RenderingHintsSection } from '../../types/storyBible';
import {
  exportBlockers,
  renderMarkdown,
  type ExportBlocker,
  type ExportUnit,
} from './exportMarkdown';

/** Units are a projection with no prose; the server's own ceiling is
 *  larger, but there is nothing to gain from a bigger page here. */
const UNIT_PAGE = 100;
/** Whole chapters. The reader uses the same figure for the same reason. */
const PROSE_PAGE = 25;
/** Backstop against a server that never stops saying `has_more` — a
 *  runaway cursor is a hang, not an error. Same shape as the pagers in
 *  `storyStore`. */
const MAX_EXPORT_PAGES = 200;

export type ExportResult =
  | { ok: true; markdown: string; filename: string }
  | { ok: false; blockers: ExportBlocker[] };

interface RunRef {
  projectId: string;
  renderId: string;
  sceneIdStart: string;
  sceneIdEnd: string;
}

/**
 * Read a run to exhaustion and serialize it, or refuse with the reasons.
 *
 * Order matters and is the cheap-first rule from the plan: unit summaries
 * carry every status the gate needs and no prose at all, so a run that
 * cannot be exported is refused before a single chapter body crosses the
 * wire.
 */
export async function collectRunForExport(
  run: RunRef,
  scenes: StorySceneOut[],
  hints: RenderingHintsSection['novel'] | null,
  workTitle: string
): Promise<ExportResult> {
  const summaries = await pageUnits(run.projectId, run.renderId);
  const sceneTitles = titleMap(scenes);
  const range = resolveRange(scenes, run.sceneIdStart, run.sceneIdEnd);

  // A run whose anchors are gone cannot have its COMPLETENESS checked —
  // there is no way to know which scenes it meant to cover. Its statuses
  // still gate, and the prose it has is still the user's, so this reports
  // what it can rather than holding finished chapters hostage to a scene
  // list that moved. `renderMarkdown`'s notice says the check was skipped.
  const gateRange =
    range ??
    summaries
      .map((u) => ({ id: u.scene_id, sequence: u.sequence }))
      .sort((a, b) => a.sequence - b.sequence);

  const blockers = exportBlockers(
    gateRange,
    summaries.map((u) => ({ sceneId: u.scene_id, status: u.status })),
    sceneTitles
  );
  if (blockers.length > 0) return { ok: false, blockers };

  const bodies = await pageProse(run.projectId, run.renderId);
  const flags = new Map(summaries.map((u) => [u.scene_id, u]));

  const units: ExportUnit[] = bodies.map((b) => {
    const summary = flags.get(b.scene_id);
    return {
      sceneId: b.scene_id,
      sequence: b.sequence,
      prose: b.prose,
      status: b.status,
      // Absent summary defaults to "we cannot say it is fresh". Same
      // direction as `unitNotes`: false-stale is cheap, false-fresh is not.
      isStale: summary ? summary.is_stale : true,
      isOrphaned: summary ? summary.is_orphaned : false,
    };
  });

  return {
    ok: true,
    markdown: renderMarkdown({
      title: workTitle,
      units,
      sceneTitles,
      hints,
      completenessUnverified: range === null,
    }),
    filename: filenameFor(workTitle),
  };
}

async function pageUnits(
  projectId: string,
  renderId: string
): Promise<StoryRenderUnitSummary[]> {
  const out: StoryRenderUnitSummary[] = [];
  let cursor: { sequence: number; sceneId: string } | null = null;
  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const res = await storyApi.listRenderUnits(projectId, renderId, {
      limit: UNIT_PAGE,
      ...(cursor ? { afterSequence: cursor.sequence, afterSceneId: cursor.sceneId } : {}),
    });
    out.push(...(res.items ?? []));
    cursor = nextCursor(res);
    if (!cursor) break;
  }
  return out;
}

async function pageProse(
  projectId: string,
  renderId: string
): Promise<StoryRenderUnit[]> {
  const out: StoryRenderUnit[] = [];
  let cursor: { sequence: number; sceneId: string } | null = null;
  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const res = await storyApi.readRenderProse(projectId, renderId, {
      limit: PROSE_PAGE,
      ...(cursor ? { afterSequence: cursor.sequence, afterSceneId: cursor.sceneId } : {}),
    });
    out.push(...(res.items ?? []));
    cursor = nextCursor(res);
    if (!cursor) break;
  }
  return out;
}

/** `has_more` is the ONLY terminator. Both cursor halves are required
 *  because `sequence` is not unique across scenes. */
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

/** The run's own span, in scene order. Null when either anchor is gone —
 *  the scenes were re-segmented by a re-walk, or deleted. */
function resolveRange(
  scenes: StorySceneOut[],
  startId: string,
  endId: string
): { id: string; sequence: number }[] | null {
  const ordered = [...scenes].sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
  );
  const start = ordered.findIndex((s) => s.id === startId);
  const end = ordered.findIndex((s) => s.id === endId);
  if (start < 0 || end < 0 || end < start) return null;
  return ordered
    .slice(start, end + 1)
    .map((s, i) => ({ id: s.id, sequence: i }));
}

function titleMap(scenes: StorySceneOut[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const scene of scenes) {
    const title = (scene.data as { title?: unknown })?.title;
    if (typeof title === 'string' && title.trim()) out.set(scene.id, title.trim());
  }
  return out;
}

/** Filesystem-safe, lowercase, no runs of separators. Falls back rather
 *  than emitting a bare extension for a work whose name is all
 *  punctuation. */
export function filenameFor(workTitle: string): string {
  const slug = workTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'story'}.md`;
}
