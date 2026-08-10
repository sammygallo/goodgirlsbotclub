// Canon check (story-state phase 10, plan §6.6).
//
// THE referential validation in the whole system, and the only one. The
// server is shape-only by design (it validates JSON, not meaning),
// reconcile's prune deliberately refuses to touch anything a human wrote
// or resolved, and nothing else ever asks whether an id still points at
// something. Lock canon is where that debt is collected — which is why
// it lives in a pure, fixture-tested module and not inline in the
// footer's JSX.
//
// Three rules the whole file is built on:
//
//  - Everything here crossed a fetch, so everything here is read through
//    a runtime reader, never a cast. A section an older build wrote — or
//    a newer one will — must degrade to "nothing to say" rather than to
//    a fabricated finding.
//  - "Not loaded" and "not there" are DIFFERENT, and conflating them is
//    destructive in a way it isn't in a provenance badge: errors drive
//    an auto-fix that strips ids. An unloaded `entities` section read as
//    "no characters exist" would strip every participant off every
//    scene. Every input that can be absent is therefore SKIPPED when
//    absent, the same way `resolveRefState` answers `live` when it
//    cannot tell.
//  - Errors are exactly the auto-fixable class, warnings never block
//    (§6.6, Decision 2). Anything that dangles by design — the ref kinds
//    the schema's own comments say MAY dangle — is a warning, forever.
//
// The cleanup rules below are shared verbatim with `deleteFact` (§5.2):
// the same code cleaning up from both directions is what makes the
// auto-fix a genuine net for a delete whose cleanup PUT failed, instead
// of a second, subtly different opinion about what cleanup means.

import { isFactTombstone, type ChatSourceRef, type Contradiction } from '../../types/storyBible';
import { readContinuitySection } from '../storyIngest/reconcileJudge';
import { describeRef, resolveRefState, type LiveRefs } from './sourceRefs';

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Auto-fixable classes. `contradiction_*` are fixed by one
 *  `patchContinuity` carrying `cleanupFactRefs`; `scene_*` by one
 *  `patchScene` per affected scene carrying `cleanupSceneRefs` — the lazy
 *  heal §5.2 deferred to here. */
export type CanonErrorKind =
  | 'contradiction_source'
  | 'contradiction_choice'
  | 'scene_fact'
  | 'scene_participant'
  | 'scene_pov';

export type CanonWarningKind =
  | 'fact_established_in'
  | 'fact_supersedes'
  | 'fact_contradicts'
  | 'source_chat'
  | 'act_scene'
  | 'chapter_break'
  | 'chapter_title'
  | 'hints_pov_character';

interface CanonFindingBase {
  /** One user-facing sentence. The confirm dialog lists these under a
   *  per-class count, so they are written to be read by whoever is about
   *  to press "Fix and lock", not by whoever debugs it. */
  message: string;
}

export interface ContradictionCanonError extends CanonFindingBase {
  class: 'error';
  kind: 'contradiction_source' | 'contradiction_choice';
  /** The entry to patch. Stable across the fix — ids are the resolution
   *  key (§5.2). */
  contradictionId: string;
  /** The fact id that is gone: what `cleanupFactRefs` strips. */
  factId: string;
}

export interface SceneCanonError extends CanonFindingBase {
  class: 'error';
  kind: 'scene_fact' | 'scene_participant' | 'scene_pov';
  /** The scene row to PUT. */
  sceneId: string;
  /** The dead id — a fact id for `scene_fact`, a character id for the
   *  other two. */
  refId: string;
}

export type CanonError = ContradictionCanonError | SceneCanonError;

export interface CanonWarning extends CanonFindingBase {
  class: 'warning';
  kind: CanonWarningKind;
  /** The row the dangling ref sits on — a fact id, an act id. Null for
   *  the section-level ones (`source_chat`, the rendering-hints refs),
   *  which have no row to point at. */
  ownerId: string | null;
  /** The id that no longer resolves. Null for `source_chat`, whose
   *  referent is a chat address rather than a bible id — the message
   *  names it instead. */
  refId: string | null;
}

export interface CanonCheckResult {
  errors: CanonError[];
  warnings: CanonWarning[];
}

// ---------------------------------------------------------------------------
// The §5.2 cleanup rules — pure, and shared with deleteFact
// ---------------------------------------------------------------------------

/** Stamped on a reopened entry's rationale (§5.2). Exported so the card's
 *  "why is this open again" copy and this module cannot drift apart. */
export const CANON_REOPEN_RATIONALE_PREFIX = '(canonical fact was deleted) ';

function reopenRationale(previous: unknown): string {
  const text = typeof previous === 'string' ? previous : '';
  // Write-my-own's fact can itself be deleted later, so an entry can be
  // reopened twice — without this the prefix stacks.
  return text.startsWith(CANON_REOPEN_RATIONALE_PREFIX)
    ? text
    : `${CANON_REOPEN_RATIONALE_PREFIX}${text}`;
}

/**
 * Remove dead facts from the continuity list (§5.2), as one pure patch.
 *
 * Returns null for "nothing to write", which `patchContinuity` uses to
 * skip the PUT entirely: the backend bumps `server_ts` on every write,
 * and a gratuitous bump forces a 409-and-merge on every other open
 * review tab.
 *
 * Entry ids are KEPT even where the sources shrank. They are the
 * resolution key, and reconcile's subset/superset dampener already
 * handles a re-detection landing next to a narrowed entry.
 */
export function cleanupFactRefs(
  entries: readonly Contradiction[],
  deadFactIds: ReadonlySet<string>
): Contradiction[] | null {
  if (deadFactIds.size === 0) return null;

  const out: Contradiction[] = [];
  let changed = false;

  for (const entry of entries) {
    const sources = entry.sources.filter((id) => !deadFactIds.has(id));
    const shrank = sources.length !== entry.sources.length;

    // The ≥2 invariant — resolved and user-detected entries INCLUDED.
    // This is precisely the cleanup reconcile's prune refuses to do
    // (Phase 8 §11 handed it here), and refusing it for a `user_chose`
    // entry would leave an immortal "A contradicts <nothing>" row.
    //
    // Applied only to entries this pass actually shrank: an entry that
    // already carried fewer than two sources and cites nothing dead was
    // written by something else, and dropping it would delete a user's
    // row for a reason unrelated to the delete.
    if (shrank && sources.length < 2) {
      changed = true;
      continue;
    }

    // Checked independently of `sources`: §6.2's write-my-own points
    // `canonical_choice` at a fact it deliberately never adds to the
    // citation list, so an entry can lose its winner while its sources
    // stay untouched.
    const choice = entry.resolution?.canonical_choice;
    if (choice && deadFactIds.has(choice)) {
      changed = true;
      out.push({
        ...entry,
        sources,
        resolution: {
          ...entry.resolution,
          status: 'unresolved',
          canonical_choice: null,
          // §5.1's Reopen clears the fields; an `unresolved` entry still
          // carrying its old `resolved_at` is the same lie in a
          // different field.
          resolved_at: null,
          rationale: reopenRationale(entry.resolution?.rationale),
        },
      });
      continue;
    }

    if (shrank) {
      changed = true;
      out.push({ ...entry, sources });
      continue;
    }

    out.push(entry);
  }

  return changed ? out : null;
}

/** Ids a scene must stop citing. Kept as two named sets rather than one
 *  pooled set of "dead ids" so the fix can never strip a fact id out of
 *  `participants` on the strength of a finding about something else. */
export interface DeadSceneRefs {
  factIds?: ReadonlySet<string>;
  characterIds?: ReadonlySet<string>;
}

/**
 * Strip dead refs off one scene (§6.6's lazy heal), as one pure patch.
 *
 * Takes and returns the RAW stored payload because `patchScene`
 * full-replaces the row: every field this doesn't understand has to
 * survive the trip (the content_rating lesson). Returns null for no-op.
 *
 * A field whose shape can't be read is left ALONE rather than rewritten
 * — `checkCanon` won't have flagged it either, so the two halves agree
 * about what is untouchable.
 */
export function cleanupSceneRefs(
  data: Record<string, unknown>,
  dead: DeadSceneRefs
): Record<string, unknown> | null {
  const deadFacts = dead.factIds;
  const deadCharacters = dead.characterIds;
  const patched = { ...data };
  let changed = false;

  const facts = readIdList(data.continuity_facts_established);
  if (facts && deadFacts?.size) {
    const kept = facts.filter((id) => !deadFacts.has(id));
    if (kept.length !== facts.length) {
      patched.continuity_facts_established = kept;
      changed = true;
    }
  }

  const participants = readIdList(data.participants);
  if (participants && deadCharacters?.size) {
    const kept = participants.filter((id) => !deadCharacters.has(id));
    if (kept.length !== participants.length) {
      patched.participants = kept;
      changed = true;
    }
  }

  const pov = data.pov_character;
  if (typeof pov === 'string' && deadCharacters?.has(pov)) {
    patched.pov_character = null;
    changed = true;
  }

  return changed ? patched : null;
}

export interface CanonFixPlan {
  /** Feeds ONE `cleanupFactRefs` call, however many entries cite them —
   *  the whole continuity section is a single PUT. */
  deadFactIds: Set<string>;
  /** One `patchScene` each, keyed by scene id. */
  scenes: Map<string, DeadSceneRefs>;
}

/**
 * Group the errors into the writes that fix them.
 *
 * The fix is derived from the FINDINGS, never re-derived from state: the
 * check has already decided what is dead, and a fix that re-decided
 * could disagree with the confirm dialog the user just approved.
 */
export function planCanonFixes(errors: readonly CanonError[]): CanonFixPlan {
  const deadFactIds = new Set<string>();
  const scenes = new Map<string, { factIds: Set<string>; characterIds: Set<string> }>();

  // Exhaustive by kind rather than by shape: a sixth error class added
  // without a route here is a compile error, not an error the fix
  // silently drops on the floor.
  for (const error of errors) {
    switch (error.kind) {
      case 'contradiction_source':
      case 'contradiction_choice':
        deadFactIds.add(error.factId);
        break;
      case 'scene_fact':
      case 'scene_participant':
      case 'scene_pov': {
        let entry = scenes.get(error.sceneId);
        if (!entry) {
          entry = { factIds: new Set(), characterIds: new Set() };
          scenes.set(error.sceneId, entry);
        }
        if (error.kind === 'scene_fact') entry.factIds.add(error.refId);
        else entry.characterIds.add(error.refId);
        break;
      }
    }
  }

  return { deadFactIds, scenes };
}

// ---------------------------------------------------------------------------
// Runtime readers — every input crossed a fetch
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A list of ids, or null for anything else. Null means "unreadable,
 *  leave it alone" in BOTH directions — the check won't flag what the
 *  fix can't safely rewrite. */
function readIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function readId(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

interface SceneRefs {
  title: string;
  factIds: string[];
  participants: string[];
  pov: string | null;
}

function readSceneRefs(data: Record<string, unknown>): SceneRefs {
  return {
    title: typeof data.title === 'string' ? data.title : '',
    factIds: readIdList(data.continuity_facts_established) ?? [],
    participants: readIdList(data.participants) ?? [],
    pov: readId(data.pov_character),
  };
}

interface FactRefs {
  text: string;
  establishedIn: string | null;
  supersedes: string | null;
  contradicts: string[];
}

function readFactRefs(data: Record<string, unknown>): FactRefs {
  return {
    text: typeof data.text === 'string' ? data.text : '',
    establishedIn: readId(data.established_in),
    supersedes: readId(data.supersedes),
    contradicts: readIdList(data.contradicts) ?? [],
  };
}

/**
 * Character ids out of an `entities` payload — null when there is
 * nothing trustworthy to compare against, which SKIPS every character
 * check.
 *
 * A loaded-but-empty cast reads as null too. It is a real state (cold
 * start hasn't run), but so is a section whose shape drifted or whose
 * fetch never landed, and a scene cannot have participants without a
 * cast in the first place — so the only bible where the distinction
 * would matter is one where treating it as "no characters exist" strips
 * every participant off every scene.
 */
function readCharacterIds(entities: unknown): Set<string> | null {
  const characters = asRecord(entities)?.characters;
  if (!Array.isArray(characters)) return null;
  const ids = new Set<string>();
  for (const raw of characters) {
    const id = readId(asRecord(raw)?.id);
    if (id) ids.add(id);
  }
  return ids.size ? ids : null;
}

/** The bible's source chat, rebuilt (not cast) from the fields the ref
 *  helpers actually read. */
function readSourceChatRef(meta: unknown): ChatSourceRef | null {
  const chat = asRecord(asRecord(asRecord(meta)?.source)?.chat);
  if (!chat || chat.kind !== 'chat') return null;
  const ref = asRecord(chat.ref);
  const avatar = readId(ref?.character_avatar);
  const fileName = readId(ref?.file_name);
  if (!avatar || !fileName) return null;
  const name = asRecord(chat.snapshot)?.name;
  return {
    kind: 'chat',
    ref: { character_avatar: avatar, file_name: fileName },
    snapshot: { name: typeof name === 'string' ? name : null },
    captured_at: typeof chat.captured_at === 'string' ? chat.captured_at : '',
  };
}

interface ActRefs {
  id: string | null;
  label: string;
  sceneIds: string[];
}

function readActs(narrative: unknown): ActRefs[] {
  const acts = asRecord(asRecord(narrative)?.structure)?.acts;
  if (!Array.isArray(acts)) return [];
  const out: ActRefs[] = [];
  for (const raw of acts) {
    const act = asRecord(raw);
    if (!act) continue;
    const range = readIdList(act.scene_range) ?? [];
    out.push({
      id: readId(act.id),
      label: typeof act.label === 'string' ? act.label : '',
      // An act's range is [start, end] and both halves may be the same
      // scene — dedup so a one-scene act can't warn twice about one id.
      sceneIds: [...new Set(range)],
    });
  }
  return out;
}

interface NovelHintRefs {
  chapterBreaks: string[];
  chapterTitleScenes: string[];
  povCharacter: string | null;
}

function readNovelHints(renderingHints: unknown): NovelHintRefs {
  const novel = asRecord(asRecord(renderingHints)?.novel);
  const titles = novel && Array.isArray(novel.chapter_titles) ? novel.chapter_titles : [];
  const chapterTitleScenes: string[] = [];
  for (const raw of titles) {
    const sceneId = readId(asRecord(raw)?.scene_id);
    if (sceneId) chapterTitleScenes.push(sceneId);
  }
  return {
    chapterBreaks: readIdList(novel?.chapter_breaks) ?? [],
    chapterTitleScenes,
    povCharacter: readId(novel?.pov_character),
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** The §5.7 fact index, narrowed to what this module reads. A
 *  `Map<string, StoryLogEntry>` satisfies it structurally, which keeps a
 *  pure util free of the API client. */
export type FactIndex = ReadonlyMap<string, { data: Record<string, unknown> }>;

/** One scene as the wire returns it: the row's own id (what `patchScene`
 *  addresses) plus its raw payload. `StorySceneOut` satisfies it — scene
 *  SUMMARIES do not, and cannot: they carry none of the ref fields §6.6
 *  checks, so the footer must have the full rows in hand. */
export interface SceneRow {
  id: string;
  data: Record<string, unknown>;
}

export interface CanonCheckState {
  /** Every fact row in the log, live AND tombstoned, paged to
   *  exhaustion. An id absent from a COMPLETE index is missing; one
   *  whose payload is a tombstone was deleted; both are errors. */
  facts: FactIndex;
  /** Every scene, paged to exhaustion, with full payloads. */
  scenes: readonly SceneRow[];
  /** Raw `StorySectionOut.data` payloads, absent when not loaded.
   *  `continuity` is the one section this refuses to guess about: a
   *  PRESENT-but-malformed list throws out of `readContinuitySection`
   *  rather than reading as empty, because the caller's very next move
   *  is an auto-fix that full-replaces it. */
  continuity?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  entities?: Record<string, unknown> | null;
  narrative?: Record<string, unknown> | null;
  renderingHints?: Record<string, unknown> | null;
  /** For the source-chat badge. Omitted reads as `live`, per
   *  `resolveRefState`'s own can't-tell rule. */
  liveRefs?: LiveRefs;
}

const LABEL_CLAMP = 80;

/** Enough of a description or fact text to recognise the row, in a
 *  dialog that may list dozens. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LABEL_CLAMP
    ? `${trimmed.slice(0, LABEL_CLAMP - 1)}…`
    : trimmed;
}

type FactState = 'live' | 'deleted' | 'missing';

function factState(facts: FactIndex, id: string): FactState {
  const row = facts.get(id);
  if (!row) return 'missing';
  // The single live-vs-deleted discriminator (types/storyBible.ts).
  // Never inline the key check — it has to stay in step with a server
  // that mints the tombstone.
  return isFactTombstone(row.data) ? 'deleted' : 'live';
}

function goneAs(state: FactState): string {
  return state === 'deleted' ? 'was deleted' : 'is no longer in the bible';
}

/**
 * Every referential problem in the loaded bible, split into the class
 * that blocks a lock until fixed and the class that never does.
 *
 * Pure and synchronous: it reads state the footer has already loaded and
 * nothing else. Anything it cannot see, it does not judge — an omitted
 * section is skipped, never read as empty (see the file header).
 */
export function checkCanon(state: CanonCheckState): CanonCheckResult {
  const errors: CanonError[] = [];
  const warnings: CanonWarning[] = [];

  // Absent = not loaded / no section yet. Malformed throws — deliberately
  // uncaught: a contradiction list nothing can read must not be locked,
  // and certainly must not be auto-fixed by a writer that would replace
  // what it failed to parse.
  const entries = state.continuity ? readContinuitySection(state.continuity) : [];

  // The three can't-tell guards. Each one is the difference between a
  // finding and a fabrication, and each drives (or refuses to drive) a
  // destructive fix.
  //
  // An empty fact index against a bible that cites facts can only mean
  // the §5.7 index was not paged: contradictions are keyed by the fact
  // ids they cite, so entries without facts is not a state the system
  // can produce. Guessing here would auto-fix the entire continuity
  // section into nothing.
  const factsKnown = state.facts.size > 0;
  const sceneIds = state.scenes.length ? new Set(state.scenes.map((s) => s.id)) : null;
  const characterIds = readCharacterIds(state.entities);

  for (const entry of factsKnown ? entries : []) {
    const label = clip(entry.description);
    for (const factId of entry.sources) {
      const found = factState(state.facts, factId);
      if (found === 'live') continue;
      errors.push({
        class: 'error',
        kind: 'contradiction_source',
        contradictionId: entry.id,
        factId,
        message: `“${label}” cites a fact that ${goneAs(found)}.`,
      });
    }
    // Reported separately from its own citation even when the dead fact
    // is both: they are two different problems (a stale citation, and a
    // resolution that resolved onto nothing), the dialog counts them by
    // class, and only one of them reopens the entry.
    const choice = entry.resolution?.canonical_choice;
    if (choice) {
      const found = factState(state.facts, choice);
      if (found !== 'live') {
        errors.push({
          class: 'error',
          kind: 'contradiction_choice',
          contradictionId: entry.id,
          factId: choice,
          message: `“${label}” was resolved onto a fact that ${goneAs(found)}.`,
        });
      }
    }
  }

  for (const row of state.scenes) {
    const scene = readSceneRefs(row.data);
    const label = clip(scene.title) || 'Untitled scene';

    if (factsKnown) {
      for (const factId of scene.factIds) {
        const found = factState(state.facts, factId);
        if (found === 'live') continue;
        errors.push({
          class: 'error',
          kind: 'scene_fact',
          sceneId: row.id,
          refId: factId,
          message: `Scene “${label}” lists a fact that ${goneAs(found)}.`,
        });
      }
    }

    if (characterIds) {
      for (const characterId of scene.participants) {
        if (characterIds.has(characterId)) continue;
        errors.push({
          class: 'error',
          kind: 'scene_participant',
          sceneId: row.id,
          refId: characterId,
          message: `Scene “${label}” lists a character that is no longer in the bible.`,
        });
      }
      if (scene.pov && !characterIds.has(scene.pov)) {
        errors.push({
          class: 'error',
          kind: 'scene_pov',
          sceneId: row.id,
          refId: scene.pov,
          message: `The POV character of scene “${label}” is no longer in the bible.`,
        });
      }
    }
  }

  for (const [factId, row] of state.facts) {
    if (isFactTombstone(row.data)) continue;
    const fact = readFactRefs(row.data);
    const label = clip(fact.text) || 'Untitled fact';

    // Warnings, all three of them, because every one of these refs
    // dangles BY DESIGN: `established_in` outlives a scene merge (§5.3),
    // and `supersedes`/`contradicts` are fact-to-fact pointers the
    // append-only log never promised to keep whole.
    if (sceneIds && fact.establishedIn && !sceneIds.has(fact.establishedIn)) {
      warnings.push({
        class: 'warning',
        kind: 'fact_established_in',
        ownerId: factId,
        refId: fact.establishedIn,
        message: `The fact “${label}” points at a scene that no longer exists.`,
      });
    }
    if (fact.supersedes && factState(state.facts, fact.supersedes) !== 'live') {
      warnings.push({
        class: 'warning',
        kind: 'fact_supersedes',
        ownerId: factId,
        refId: fact.supersedes,
        message: `The fact “${label}” supersedes a fact that is no longer in the bible.`,
      });
    }
    for (const other of fact.contradicts) {
      if (factState(state.facts, other) === 'live') continue;
      warnings.push({
        class: 'warning',
        kind: 'fact_contradicts',
        ownerId: factId,
        refId: other,
        message: `The fact “${label}” contradicts a fact that is no longer in the bible.`,
      });
    }
  }

  const sourceChat = readSourceChatRef(state.meta);
  if (sourceChat && resolveRefState(sourceChat, state.liveRefs ?? {}) === 'dangling') {
    warnings.push({
      class: 'warning',
      kind: 'source_chat',
      ownerId: null,
      refId: null,
      message: `The source chat “${describeRef(sourceChat)}” is no longer in this Work.`,
    });
  }

  // narrative and rendering_hints are sparse-by-design (their annotate
  // pass is deferred to step 3), so these are usually zero-cost — but
  // both need a lazy `loadSection` at check time, not a slot in load()'s
  // hot path.
  if (sceneIds) {
    for (const act of readActs(state.narrative)) {
      const actLabel = clip(act.label) || 'an act';
      for (const sceneId of act.sceneIds) {
        if (sceneIds.has(sceneId)) continue;
        warnings.push({
          class: 'warning',
          kind: 'act_scene',
          ownerId: act.id,
          refId: sceneId,
          message: `The range of ${actLabel} covers a scene that no longer exists.`,
        });
      }
    }
  }

  const hints = readNovelHints(state.renderingHints);
  if (sceneIds) {
    for (const sceneId of hints.chapterBreaks) {
      if (sceneIds.has(sceneId)) continue;
      warnings.push({
        class: 'warning',
        kind: 'chapter_break',
        ownerId: null,
        refId: sceneId,
        message: 'A chapter break points at a scene that no longer exists.',
      });
    }
    for (const sceneId of hints.chapterTitleScenes) {
      if (sceneIds.has(sceneId)) continue;
      warnings.push({
        class: 'warning',
        kind: 'chapter_title',
        ownerId: null,
        refId: sceneId,
        message: 'A chapter title points at a scene that no longer exists.',
      });
    }
  }
  // §6.6 lists `pov_character` among the rendering-hints refs "citing
  // unknown scenes", but the field is a CHARACTER id (types/storyBible.ts
  // RenderingHintsSection.novel) — checked against the cast, warned
  // rather than errored because nothing renders from it in v1.
  if (characterIds && hints.povCharacter && !characterIds.has(hints.povCharacter)) {
    warnings.push({
      class: 'warning',
      kind: 'hints_pov_character',
      ownerId: null,
      refId: hints.povCharacter,
      message: 'The rendering POV character is no longer in the bible.',
    });
  }

  return { errors, warnings };
}
