# Productization Step 3 — Renderers: implementation plan

> Status: **decisions approved 2026-08-12; revised after adversarial plan
> review.** Successor to [story-state-step2-plan.md](story-state-step2-plan.md)
> (phases 0–11, all merged and deployed; step 2 closed 2026-08-12).
> Inputs: [story-state-schema-v1.md](story-state-schema-v1.md) — especially
> its **Renderer consumption** section and the **v1.1 amendments** — and the
> normative Pydantic module `app/schemas/story.py` in `ggbc-backend`.
> Repos: `goodgirlsbotclub` (frontend), `ggbc-backend` (backend, migration
> head **0020**).
>
> **Revision note (§3.5).** The first draft's mechanical context selector
> specified "world rules filtered by `location_ref` and participant ids."
> That filter cannot be written: `WorldRule` carries neither reference, and
> the one join key it does have (`established_in`) is `null` on every
> lorebook-derived rule. §3.5 is rewritten around world-info activation
> replay instead — a stronger mechanism that was available all along. The
> decision (defer embeddings to phase 8) is unchanged; its stated cost is
> not.

---

## 1. Goal & scope

Step 2 ended at "locked canon exists." Nothing consumes it. Step 3 makes the
bible pay for itself: **a user turns a locked bible into readable prose they
can export.**

**What a user gets at the end of step 3:**

- An **annotated** bible: every scene carries a beat, a tension score, a mood
  and a compression recommendation, and the bible carries a detected
  narrative structure. These are the schema's `scenes[].function`,
  `scenes[].transformations` and `narrative.structure` fields — modeled in
  Pydantic since v1.1, deliberately left empty by step 2 because nothing read
  them.
- A **Render tab**: pick a scene range, set the novel hints (POV, tense,
  compression, style anchors), see a preflight **token** estimate, and render
  on their own key with per-scene progress, abort and resume — the same
  machinery shape as ingestion.
- **Novel-form prose** stored server-side per scene, re-readable across
  devices, with a continuity check that cross-references the fact log and
  flags contradictions in the *output* rather than in the bible.
- **Export** to Markdown, with chapter breaks driven by
  `rendering_hints.novel.chapter_breaks`.
- A **second renderer** (screenplay/Fountain) that reuses the bible, the
  storage and the orchestration unchanged.

**Explicitly deferred (step 4+), with the cost of each stated in §3:**

- Round-trip edit propagation from rendered output (schema doc "Round-trip
  editing", audit G6). Renders are output in step 3; editing prose does not
  update canon.
- Embedding-based retrieval and the `story_embeddings` work (audit G7).
  Step 3 selects context by world-info activation replay — see Decision 5.
- Comic-script and storyboard renderers, and the image-generation chain they
  imply.
- Multi-bible / multi-chat rendering, collaborative editing, and export to
  external tools (Scrivener et al.) — all still v1 cuts from the schema doc.

**Platform constraints carried forward from step 2, unchanged:** all LLM
calls go through the existing generation proxy on the user's BYO key from the
frontend; every server write uses per-row `server_ts` optimistic concurrency;
public identity stays string-based with dangle-and-reconcile semantics; every
phase is one reviewable PR; backend migrations are a linear Alembic chain, so
backend merges serialize in migration order even when development is
parallel.

---

## 2. What already exists — do not rebuild

Step 3 is smaller than step 2 looks, because most of what a renderer needs
already shipped. What does *not* transfer is called out as sharply as what
does — the plan review found that the first draft over-credited this table.

| Need | Already there | Where |
|---|---|---|
| The bible itself | 8 section rows + scenes + append-only fact/edit logs, all owner-scoped, `project:view`/`project:manage` gated | `ggbc-backend` `app/routers/story.py`, `app/models/story.py` |
| Annotate target fields | `SceneFunction`, `SceneTransformations`, `NarrativeStructure`, `Act`, `Theme` — modeled, optional, empty | `app/schemas/story.py:572-621`, `:759-810` |
| Render configuration | `RenderingHintsSection` with `novel` / `screenplay` / `graphic_novel` / `storyboard` sub-objects | `app/schemas/story.py:637-690` |
| Deadlock discipline for multi-row writes | `_lock_project`, and the canonical-sort-then-lock pattern in `bulk_write_scenes` | `app/routers/story.py:132-145`, `:803-806` |
| Pass orchestration on the user's key | `storyIngestStore` — chunk planning, per-chunk server checkpoint, soft lock with heartbeat, abort/resume, fuel-gauge accounting | `src/stores/storyIngestStore.ts` |
| Model-to-pass bridge | `makeLlmCall` → `generateOnce`, on the user's active provider | `src/utils/storyIngest/llmBridge.ts` |
| World-info activation replay | `wiReplay.ts` — the WI scanner (keys, secondary keys, co-fire links, scan depth) run over transcript text, with an honest `replay_approx` caveat | `src/utils/storyIngest/wiReplay.ts` |
| Snapshot / restore / reset | `story_archives`; reset snapshots before deleting, in one transaction | `app/routers/story.py:1448-1450`, `:1519-1560`, migration 0016 |
| Full-scene reads | `loadAllScenesWithData` — page summaries, then one `GET /scenes/{id}` per scene | `src/stores/storyStore.ts:1106-1144` |
| Drift and staleness | `msgDrift`, `stale_source`, incremental re-ingestion | Phase 11 |

**What does *not* transfer, and the plan must not assume it does:**

- **Truncation safety.** Ingestion survives a `max_tokens` cut only because
  its responses must parse — `src/utils/llm/json.ts:14-16` skips a truncated
  final object and `transcriptWalk.ts:262-286` retries once. Prose has no
  parser. See §3.4.
- **Bulk full-scene reads.** `SceneSummary` deliberately omits every field the
  renderer needs (`app/schemas/story.py:1036-1045`), and `POST /scenes/bulk`
  is write-only. `loadAllScenesWithData` is N round trips with no cache and
  unbounded parallelism, and today fires exactly once per bible. See §4,
  Phase 1.
- **Restore's confirm is not a typed confirm.** It is a plain
  `ConfirmDialog` (`StoryTab.tsx:997-1013`); the typed confirm was removed as
  theater in phase10-plan §3.4.

One deliberately unbuilt thing carried over from step 2:
**re-walk-from-divergence** (step-2 plan §3.3). It stays deferred; step 3
does not depend on it. Two of its three original blockers remain — an orphan
policy for re-segmented scene ids, and an answer for clobbering
user-reviewed titles. The third (crash-safe delete ordering) was answered by
Phase 10's scene-merge precedent (phase11-plan.md:200-212).

---

## 3. Decisions

Eight decisions, approved 2026-08-12. §3.5's supporting mechanism and stated
cost changed under review; the decision itself did not. §3.9 is new — it
covers a class the first draft missed entirely.

### 3.1 The first renderer is **novel prose**

The schema doc specifies four renderers. Screenplay is the cheapest to build
— four transformation stages to novel's five, and Fountain is a plain-text
format with no layout engine. It is also the least differentiated.

Novel prose is the one that consumes `user_voice`, which is the point of the
chat-as-input modality — the bible knows how *this user* writes. It also
produces output a user will read end to end, which is what makes the annotate
pass and the review checkpoint feel worth their token cost in hindsight.

**Cost:** the longest chain, the largest outputs, and the highest per-render
spend of the four. Screenplay follows in Phase 7.

### 3.2 Prose lives in **new tables**, not in a section row

`story_sections.data` is capped at 256KB and is a single-row full replace
with `base_ts` concurrency. A rendered novel over 60 scenes is past that cap,
and a full-replace write means a crash mid-render loses the whole render
rather than one scene.

Migration **0021** adds two tables.

**`story_renders`** — one row per render run:

- `project_id`, `id` (composite PK, matching `story_scenes`)
- `format` — closed vocabulary, DB CHECK + Pydantic `Literal`:
  `novel` | `screenplay`
- `hints` — the `NovelHints`/`ScreenplayHints` snapshot the run was
  configured with, so a later hints edit does not silently reinterpret
  finished prose
- `scene_id_start`, `scene_id_end`
- `status` — closed vocabulary, DB CHECK + `Literal`:
  `running` | `paused` | `complete` | `aborted` | `error`
- `stale_bible` — `boolean not null default false`, a **separate column**,
  not a `status` value. Staleness is orthogonal to the run lifecycle; folding
  it into `status` would overwrite `complete` and lose it.
- `lock_client_id`, `lock_heartbeat_at` — the §3.6 soft lock. The ingestion
  lock works because there is exactly one `ingestion` checkpoint per project;
  a per-run table has no singular row to check unless these columns exist.
- `model`, `prompt_version`, `input_tokens`, `output_tokens`
- `server_ts`, `created_at`, `updated_at`

**`story_render_units`** — one row per scene per render:

- `project_id`, `render_id`, `scene_id` (composite PK)
- `sequence`, `prose`
- `source_scene_ts` — the scene's `server_ts` at render time, so an edited
  scene is detectably stale
- `status` — closed vocabulary, DB CHECK + `Literal`:
  `pending` | `complete` | `truncated` | `error` | `orphaned`
  (`truncated` is §3.4's requirement; `orphaned` is §3.8's deleted-scene
  state)
- `continuity` — the §3.4 verdict payload
- `server_ts`, timestamps
- Byte cap **128KB** per unit

Three constraints the review established, all of which must land in 0021
because a second backend deploy is the expensive way to fix any of them:

1. **Every status vocabulary is closed at the DB and in Pydantic.** Every
   status-like column in this codebase is pinned by both
   (`app/models/story.py:100-105`, `app/models/embedding_job.py:84-90`).
2. **Every new write endpoint takes `_lock_project(db, project_id)`** after
   body read and validation, per `_read_capped_body`'s ORDERING RULE
   (`app/routers/story.py:398-403`), and the bulk unit endpoint sorts rows
   canonically **before** locking, exactly as `bulk_write_scenes` does
   (`:803-806`). "Mirror the `story_scenes` shape" means copying the
   discipline, not only the columns — the router's own docstrings record
   three concurrency bugs found by review in this table family.
3. **Deleted scenes are handled, not assumed away** — see §3.8.

**Cost:** a migration and roughly 350 lines of router. The alternative —
prose in `user_documents` or client-only — was rejected because renders must
survive a device change and because reset, restore and scene deletion all
have to know about them.

### 3.3 Annotate ships **before** the renderer, as its own phase

The annotate pass is one LLM call per scene filling `function` (beat,
tension, mood, stakes) and `transformations` (compression recommendation,
ratio, pacing notes, dialogue density), plus one bible-wide call for
`narrative.structure`. The renderer reads all of it —
`compression_ratio_target` is literally the compressor's input.

Shipping it separately lets a user run annotate, read the beat map, and
correct it before spending render tokens on a wrong reading. Folding it into
the render chain would make every re-render re-pay for annotation.

**This is not a one-line change.** It needs, in Phase 1 (backend):

- `IngestPass` in `app/schemas/story.py:705-707` gains `"annotate"`.

and in Phase 2 (frontend), because a checkpoint parked at an unknown pass is
not merely unrecognized — it is misclassified as a **fresh build**:

- `IngestPass`, `INGEST_PASSES` and `PASS_LABELS`
  (`src/utils/storyIngest/types.ts:14-19, 72-77, 86-92`).
- A resume gate in `continuingBuild` (`storyIngestStore.ts:379`), **and** the
  runner's own inner gate — the store documents twice, in comments, that
  widening one without the other is insufficient. Today a paused, aborted or
  errored annotate run falls to the `else` branch at `:601`, which re-runs
  `runColdStart` and full-replaces three sections (`:617-619`) and re-walks
  the entire chat.
- A decision on whether annotate sits inside `run()`'s linear pipeline or is
  a separate entry point that never touches cold start. **Recommend: separate
  entry point.** Annotate is re-runnable and idempotent per scene; the linear
  pipeline is not.

**Canon lock.** §1 opens on "a locked bible," and annotate writes to one, so
the plan has to say what the lock means here. The codebase gives two
answers: `storyStore.patchScene` refuses while locked
(`storyStore.ts:394-401`, `:1322`), while `storyIngestStore` never consults
the lock and PUTs straight through `storyApi` (`:619`, `:1808`) — the only
gate on that path is one `disabled` prop (`StoryTab.tsx:1257`). The backend
enforces nothing; `canon_locked_at` appears once, as a schema field
(`app/schemas/story.py:323`).

The rule for step 3: **Phase 10's "every mutating action disabled while
locked" invariant governs *user-authored* edits, not derived annotations.**
Annotate and render are permitted on a locked bible, and their entry points
must not inherit `canonLocked` (`StoryTab.tsx:1257`) or `writesDisabled`
(`:299`). No code change is needed to permit it — `storyIngestStore` already
bypasses `refuseIfGated` — but the plan says so out loud rather than relying
on that accident. A lock is a **recommendation**, not a precondition, for the
Render tab; unlocking after a render leaves existing renders untouched. The
lock stays client-only: Phase 1's render endpoints will not enforce it.

**Cost:** one more pass the user has to run, and one more preflight estimate
to explain. Mitigated by defaulting the Render tab to "annotate first" when
`scenes[].function` is empty.

### 3.4 The chain is **two LLM calls per scene**, not five

The schema doc's chain is five specialist stages: POV/tense transformer →
dramatic compressor → dialogue polisher → narration voice-matcher →
continuity validator (`schema-v1.md:431-439`). The first four each rewrite
the whole scene.

Five stages on a 60-scene bible is 300 calls, each carrying the full scene
text in and out. That is a per-render cost a user will notice on their own
key, and each rewrite handoff is a lossy generation — stage 4 has no access
to what stage 1 saw, only to stage 3's paraphrase of it. The failure mode of
long rewrite chains is drift toward generic prose, which is the opposite of
what `user_voice` is for.

For v1: **one prose call** receiving POV/tense, the compression target, the
participants' `voice_profile`s and the user's voice profile as a single
structured brief, and **one continuity call** reading the produced prose
against the scene's fact set and returning structured verdicts (no rewrite).
Two calls, one rewrite, no lossy handoffs.

**Truncation is a hard prerequisite, not a detail.** The bridge discards the
one wire-level signal that would catch a cut chapter: `sse.ts:52-60` reads
only the content delta and never `choices[0].finish_reason`, and
`generateOnce` returns a bare string (`generate.ts:32-58`). The signal
exists — `ggbc-backend/app/providers/anthropic.py:211-220` maps
`stop_reason: "max_tokens"` to `finish_reason: "length"` in the envelope.
Every existing ask in the app is small (700–4096 max tokens); a scene of
novel prose is the first output that will routinely sit at the ceiling, and a
chapter cut mid-sentence would store as `complete` and export as finished
work. So Phase 3 **must** extend the llm bridge to surface `finish_reason`,
and `storyRenderStore` must set the unit's status to `truncated` — never
`complete` — when it is `length`, blocking export and surfacing in the
reader. This is the "no silent caps" rule applied to the one place it would
actually bite.

**Cost:** less specialist control. If prose comes back with good voice but
bad compression, we cannot re-run just the compressor. The mitigation is that
per-scene re-render is a one-row write, so "regenerate this scene tighter" is
cheap and user-driven. If measurement later shows the single call is worse,
the multi-stage chain goes behind a "high effort" toggle — the storage shape
does not change either way.

### 3.5 Context selection is **world-info activation replay**; embeddings deferred

*(Mechanism rewritten after review. The decision — defer embeddings to
Phase 8 — is unchanged.)*

The first draft proposed selecting world rules "filtered by `location_ref`
and participant ids." **That filter cannot be written.** `WorldRule` is
`{id, text, category, source, confidence, established_in}`
(`app/schemas/story.py:360-367`) — no place reference, no character
reference. Its one join key, `established_in`, is set to `null` by every
cold-start-minted rule (`coldStart.ts:344`), and the two-hop path through a
scene is dead because the walk writes `setting.location_ref: null`
unconditionally (`transcriptWalk.ts:486`). As drafted, v1 would have been
"all rules up to a cap" — arbitrary truncation dressed as selection.

**The mechanism that actually exists** is the one the story was played
under. Cold start mints each rule with a deterministic id,
`mintId('rule:${bookId}:${entryId}')` (`coldStart.ts:330-336`), so every
lorebook-derived rule maps back to its lorebook entry — and therefore to that
entry's world-info **keys**. `wiReplay.ts` already implements the full
scanner: primary and secondary keys, regex keys, case sensitivity, co-fire
links, per-entry scan depth. Running that scanner over a scene's own message
window yields exactly the entries that would have fired for that scene.

So the v1 context brief is:

- the target scene (full row) and the preceding scene's `detailed_summary`;
- the `participants` character objects, and `user_voice`;
- the scene's fact set (defined below);
- `narrative.pov_default` / `tense_default` and the resolved
  `rendering_hints.novel`;
- **world rules whose lorebook entry fires against this scene's text**, by WI
  replay; plus all `constant` entries' rules unconditionally (they were
  always in the prompt); plus rules whose `established_in` points at this or
  an earlier scene, most recent first.

Everything past the cap is dropped in a **stated priority order**, and the
drop is surfaced in the UI and logged — never silent.

**The scene's fact set** is `scene.continuity_facts_established` ∪ facts
whose `established_in == scene.id`, sourced through the shipped
`loadAllFactsById` (`storyStore.ts:1068-1096`). Naming this matters: the
server-side filter alone (`app/routers/story.py:949-950`) excludes every fact
written with `established_in: null` — which is all lorebook-derived rules and
all card-conflict facts from `reconcileJudge`, the foundational claims prose
is most likely to contradict. The assembler must also drop rows carrying
`deleted_at` itself: `_read_log_page` never applies `_fact_is_live()`
(`app/routers/story.py:933-959` vs `:255-264`), so Phase 10 tombstones come
back in the page.

**Context cap: 24k tokens for the assembled brief**, with truncation priority
(first dropped first): non-firing rules → older `established_in` rules →
fact set beyond the scene's own → preceding-scene summary → dialogue
examples. The mandatory core (target scene, participants, `user_voice`,
hints) is never dropped; if it alone exceeds the cap the run refuses with a
named error rather than silently rendering a partial brief. A number and an
order are what make this testable in Phase 3 without a model.

**Cost, stated honestly.** WI keys are the author's own relevance model, not
a semantic one. A rule whose keys never appear in a scene's text is missed,
and the replay carries the same approximation caveat `wiReplay` already
documents — probability rolls are re-rolled and sticky/cooldown state was
never recorded. Rules minted by the transcript walk rather than from a
lorebook have no keys at all and reach the brief only through
`established_in`. Distant thematic callbacks — the thing embeddings are
actually good at — are still missed. That is what Phase 8 measures.

**And Phase 8 is not one line.** The first draft called adding
`target_type = 'story_scene'` "genuinely cheap." It is not:
`embedding_jobs.target_id` is a bare `PGUUID` with a partial unique index on
`(target_type, target_id)` and **no tenant column**
(`app/models/embedding_job.py:64`, `:90-96`), while `StoryScene`'s PK is
composite `(project_id, id)` **by design** — the model docstring says two
projects may legitimately hold the same scene id (`app/models/story.py:108-114`)
— and scene ids are deterministic on the first message id, so two projects
fed the same chat collide and one silently never enqueues. Phase 8 therefore
needs: a scope column on `embedding_jobs` with a rebuilt three-column partial
unique index (or a surrogate globally-unique target id), a CHECK
drop/recreate, a `_load_target` branch that cannot use `db.get`
(`app/workers/embeddings.py:193-199`), an `_owner_user_id` project→owner hop
(`:203-218`), and embedding-cache columns on `story_scenes`. It must also
pick a rule-retrieval path: rule-level vectors re-import exactly the
`world`-section decomposition this decision defers, so Phase 8 either does
that decomposition explicitly or embeds only scenes. Finally, the pipeline
requires an **OpenAI** key specifically (`app/workers/embeddings.py:242-262`)
— a BYO-provider asymmetry that constrains what a Phase 8 measurement can
conclude for users on other providers.

### 3.6 Orchestration stays in the **frontend on the user's key**

Same reasoning as step-2 Decision 3, with a proven implementation to copy:
per-unit server checkpoints, a heartbeat soft lock, abort/resume, and
`usageStore.recordGeneration` accounting.

Two things the first draft left undefined:

- **Lock scope.** The lock is **per project, across formats**, held in
  `story_renders.lock_client_id`/`lock_heartbeat_at` (§3.2). Per-run locking
  would let two devices render two formats on one key simultaneously, which
  is the double-spend the lock exists to prevent.
- **Cross-gating with ingestion.** A transcript walk full-replaces the scene
  rows a running render is reading (`storyIngestStore.ts:1077-1100`), so this
  is a correctness problem, not only a spend problem. `POST /renders` refuses
  while `ingestion.status` is `running` or `paused`, and Build is disabled
  while a render is in flight.

**Cost:** rendering only progresses while a tab is open. Unchanged from step
2; the checkpoint contract stays adoptable by a later backend orchestrator.

### 3.7 Renders are **read-only output** in v1

The user can read, re-render a scene, and export. They cannot edit prose in
place and have it propagate to canon. Round-trip propagation is a classifier
(cosmetic / substantive / voice-shift / contradiction), a proposal UI, a
confirm step, and downstream re-render prompting — a phase in its own right,
and one that can corrupt canon if it lands half-built.

**Cost:** the "authoring environment" framing waits. A user who wants to
tweak a sentence exports and edits outside the app, and their edit is lost on
re-render. First candidate for step 3.5.

### 3.8 **Every path that removes a scene** must account for renders

The first draft covered reset and restore. There are three paths, and the one
it named as costly is not the destructive one.

**Reset** (`/story/reset`) is the destructive path, and phase 9 deliberately
made it fully recoverable — lock → snapshot → four deletes → one commit
(`app/routers/story.py:1519-1560`, docstring: "Recoverable as of phase 9").
Adding render deletion while declining to snapshot prose makes prose the only
story data reset destroys irreversibly. Reset is reached from two flows that
are not "wipe it": `resetBible('change_source_chat')` (`StoryTab.tsx:698`)
and `resetBible('reingest')` (`:891`).

Reset deletes render rows in the same transaction, and Phase 1 adds
`renders_deleted` to `StoryResetOut` (`app/schemas/story.py:1178-1187`) so the
confirm can name a count.

**Restore** marks every existing render `stale_bible = true` — one UPDATE
inside restore's existing commit, under the same `_lock_project`. It does not
bump `server_ts` (which would 409 an in-flight client), only a re-render
clears it, and undo-the-restore (`pre_restore_archive_id`,
`app/routers/story.py:1509`) leaving it set is accepted.

**Scene deletion** — `DELETE /scenes/{scene_id}` (`app/routers/story.py:727`)
— already ships and is user-reachable through `mergeSceneIntoPrevious`
(`storyStore.ts:1428-1490`) from the scene review row. No reset, no restore,
no archive. `source_scene_ts` detects an *edited* scene but has nothing to
compare for a *deleted* one. Unlike `embedding_jobs`, a real FK **is**
expressible here because `story_scenes`' PK is `(project_id, id)`.

Decision: `story_render_units` carries `project_id` and **no FK**; a unit
whose scene is gone is marked `orphaned` and labeled in the reader. Rationale:
restore physically deletes and re-inserts every scene row
(`app/routers/story.py:1450-1451`), so an `ON DELETE CASCADE` would silently
cascade away the very renders §3.8 promises to keep and mark stale. This
follows `embedding_jobs.target_id`'s documented precedent
(`app/models/embedding_job.py:16-23`). Staleness is therefore "scene absent
OR `scene.server_ts != unit.source_scene_ts`" — and because `patchScene`
bumps `server_ts` for a cosmetic retitle as readily as for a content change,
a retitle marks prose stale. Accepted: false-stale is cheap, false-fresh is
not.

**Cost:** reset destroys prose irreversibly. Two shipped strings currently
promise the opposite — the reset confirm reads "A snapshot is kept, so this
can be undone from the snapshots list below" (`StoryTab.tsx:1491`), which
becomes false. Phase 5 rewrites that string and the two chained callers
(`:698`, `:891`). The restore confirm is untouched.

### 3.9 Ingestion must stop clobbering step 3's output *(new)*

The first draft's §7 claimed step 3 "writes only the three field groups v1.1
reserved for it." Both halves are wrong, and the second is a live data-loss
path.

**(a) The walk overwrites annotations.** `transcriptWalk` writes every scene
with `function: null` and `transformations: null` unconditionally
(`transcriptWalk.ts:489`, `:497`) through a full-replace bulk PUT whose 409
handler is a blind adopt-and-re-PUT (`storyIngestStore.ts:1077-1100`).
Re-emission happens today via the cross-chunk open-scene carry, a resumed
walk replaying from `prior.chunk_index`, and Phase 11's reuse-and-extend
branch. So a re-walk silently discards annotations the user paid for and
corrected.

**Rule:** on a re-emitted scene, `function` and `transformations` are
**preserved** where the scene id and message range are unchanged. Phase 2
owns this change to `transcriptWalk.ts`, with a store test: annotate, then
resume a paused walk covering that scene, and the annotations survive.

**(b) `rendering_hints` is a fourth owned group, and cold start replaces
it.** The Render tab's hints editor writes `rendering_hints.novel`, and cold
start full-replaces that whole section with hardcoded defaults
(`coldStart.ts:349-368`; `storyIngestStore.ts:619`) — reachable from "Rebuild
the groundwork" with no reset and therefore no archive
(`StoryTab.tsx:1245-1258`). The store's own comment at `:553` already flags
this class as "clobbering sections this bible has been reviewed against."

**Rule:** cold start's `rendering_hints` write becomes a **merge**, not a
replace — hardcoded defaults fill only absent keys. Phase 2 owns it.
`rendering_hints` is also absent from `storyStore.load`'s section fetch (only
`LockCanonFooter.tsx:242` pulls it), so Phase 5 adds the lazy-load plumbing.

---

## 4. Phased delivery

Each phase is one PR, human-reviewed, independently deployable. Backend
phases serialize in migration order.

| Phase | Repo | What lands | Migration |
|---|---|---|---|
| 1 | backend | `story_renders` + `story_render_units` with closed status vocabularies, `stale_bible` and lock columns (§3.2); sub-resource API under `_lock_project` discipline; reset deletes renders and reports `renders_deleted`; restore marks `stale_bible`; `IngestPass` gains `annotate`; a full-data bulk scene read (§4 note); **docs patch** to `story-state-schema-v1.md` and the `app/schemas/story.py` module docstring, both of which currently state the pass enum excludes `annotate` | **0021** |
| 2 | frontend | Annotate pass — `src/utils/storyIngest/annotate.ts`; `types.ts` pass constants; a resume gate in `continuingBuild` **and** the runner's inner gate (§3.3); annotation preservation in `transcriptWalk.ts` and the `rendering_hints` merge in `coldStart.ts` (§3.9) | — |
| 3 | frontend | Render engine — `src/utils/storyRender/` (context assembler incl. the WI-activation rule selector and the 24k cap, prose prompt, continuity checker), pure and network-free; **llm bridge extended to surface `finish_reason`** (§3.4) | — |
| 4 | frontend | `storyRenderStore` — run orchestration, per-unit checkpoint, soft lock, abort/resume, `truncated` handling, fuel gauge | — |
| 5 | frontend | Render tab UI — hints editor, scene-range picker, preflight, progress, reader, per-scene re-render; `rendering_hints` lazy load; the reset-confirm string rewrite (§3.8); `WorksPanel.tsx` tab strip | — |
| 6 | frontend | Export to Markdown with chapter breaks; continuity-flag review surface; **calibration-set fixtures** (3–5 transcripts with human-rated expected output, run on every renderer change) | — |
| 7 | frontend | Screenplay/Fountain renderer | — |
| 8 | both | Scene embeddings and RAG-selective context, measured against the Phase 6 calibration set — at the real cost enumerated in §3.5 | 0022 |

Phases 3 and 4 are the `storyIngest` / `storyIngestStore` split repeated
exactly: pure engine, then store. That split is what made step 2's passes
unit-testable without a network.

**Phase 1's bulk scene read.** Annotate write-back, the range picker, the
context assembler and the export all need full scene rows, and the shipped
path is N unbounded round trips (§2). Phase 1 adds `GET /scenes?full=true`
(paged, reusing the existing cursor) so step 3 does not promote an N+1 to a
hot path. If that slips, Phase 3 must say where the full-scene set is cached
within a visit and bound the parallelism.

**Phase 7's reuse is partial, and saying otherwise sets up a claim that
cannot hold.** Carried over unchanged: migration 0021, the render store, run
orchestration, the reader, and progress/abort UI. Not carried over: the prose
prompt, the context brief, and the exporter — `ScreenplayHints` has no
chapter concept (`app/schemas/story.py:655-659`) and Fountain is not
Markdown. `final_draft` is out of scope for step 3.

**Permissions.** Every mutating render endpoint takes `project:manage`;
reads and exports take `project:view`, matching every existing story route
(`app/routers/story.py:342-343`, `:412-413`). The frontend threads `canManage`
into `writesDisabled` (`WorksPanel.tsx:57` → `StoryTab.tsx:299`); a view-only
user can read and export but cannot start, abort or re-render. Projects are
strictly user-scoped (`app/routers/projects.py:49-58`), so there is no
sharing case to design for.

**The one hard ordering constraint:** Phase 1 must deploy before Phase 2
merges, because `IngestPass` is a strict `Literal`
(`app/schemas/story.py:705-707`) — an older server 422s the entire
`PUT .../sections/ingestion` body (`app/routers/story.py:416-425`), so the
annotate pass cannot checkpoint at all. This is a *value* rejection, not the
`extra="forbid"` unknown-key rejection; step 2's documented mitigation for
`extra="forbid"` skew (relaxing leaves to `extra="allow"`) would not touch
this gate.

**Schema version.** Adding `annotate` bumps `meta.schema_version` to **1.2**
by the project's own convention (additive, backend-first). Nothing enforces
it either way — `SCHEMA_VERSION_RE` accepts any `1.x`
(`app/schemas/story.py:91-95`) — so this is a documentation discipline, not a
gate.

---

## 5. Test plan and definition of done

Per the process this project has settled on:

- **Every regression pin is mutation-tested.** Revert the fix, watch the test
  fail, restore. Two Phase 11 tests passed with their bug reverted; a pin
  never watched to fail is not a pin.
- **Two adversarial review passes** — one over the plan (done; this revision
  is its output), one over the implementation, each finding re-verified by
  independent skeptics before being trusted.
- **Live verification on production**, not just a green suite. Phase 11's
  jsdom harness covers `StoryTab`; the Render tab gets the same treatment,
  and the end-to-end click-through runs against a real provider key.

**Phase 1, `tests/test_story_renders.py`** — named because this router's own
docstrings record three concurrency bugs found by review in this table
family:

- `base_ts` compare-and-set, including the 0-means-create path
- bulk all-or-nothing, with every conflicting id reported
- 128KB unit cap returns 413 naming the cap and the overage
- reset deletes render rows and reports the count
- restore marks renders `stale_bible` inside the restore transaction
- a reset racing a bulk render-unit write does not 500

**Mutation-tested pins, frontend:**

- a checkpoint parked at `annotate` plus a Build press does **not** re-run
  cold start (§3.3)
- annotate, then resume a paused walk covering that scene: annotations
  survive (§3.9a)
- "Rebuild the groundwork" does not reset user-edited `rendering_hints`
  (§3.9b)
- a `finish_reason: "length"` response stores the unit as `truncated`, and
  export refuses (§3.4)

Done for step 3 means: a user can take a bible, annotate it, render a scene
range to novel prose, read it on a second device, re-render a scene they did
not like, export it as Markdown, and render the same bible as a screenplay
without any bible change.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Per-render spend is user-visible and larger than ingestion | Preflight token estimate before any spend, two calls per scene not five (§3.4), per-scene re-render so a bad run is not a full re-pay |
| A chapter is silently truncated and exports as finished work | `finish_reason` surfaced through the bridge; `truncated` status blocks export (§3.4) |
| Prose quality is subjective and unmeasurable | Calibration set in Phase 6, before the RAG phase it justifies |
| The rule selector misses rules whose keys never appear in the scene | Stated cost of §3.5; constants always included; drops surfaced and logged, never silent |
| Continuity checking is blind to the `established_in: null` tail | Fact set is the union of both mechanisms, named explicitly in §3.5 |
| A 60-scene render is a long tab-open operation | Per-unit checkpoints; a closed tab loses at most one scene |
| A re-walk or a rebuild destroys annotations and hints the user paid for | §3.9's preservation rule and merge rule, each with a mutation-tested pin |
| Reset destroys prose irreversibly while the confirm says otherwise | §3.8; Phase 5 rewrites the string |
| A render reads scene rows a concurrent walk is replacing | §3.6 cross-gates render against `ingestion.status` |
| Renders outlive the bible they were rendered from | `source_scene_ts` per unit, `stale_bible` on restore, `orphaned` on scene delete (§3.8) |
| Scope creep into round-trip editing | Explicitly cut (§3.7) |

---

## 7. What this step deliberately does NOT do

- Round-trip edit propagation (§3.7).
- Embedding-based retrieval, until Phase 8 and until it can be measured
  (§3.5).
- Comic-script and storyboard renderers, and image generation for them.
- A dollar-denominated cost estimate. `est_cost_usd` exists in the schema
  with no writer, and `usageStore.ts:38` records that v1 is tokens-only
  pending a pricing table. Step 3 estimates **tokens**; a pricing table
  across every BYO provider is out of scope, and nothing today enforces
  `usageStore`'s budget cap against a render run.
- Re-walk-from-divergence — still deferred from step 2, still blocked on its
  two remaining questions (§2).
- Backend-orchestrated rendering (§3.6).
- Any change to the bible schema's **existing** fields. Step 3 writes four
  field groups — `scenes[].function`, `scenes[].transformations`,
  `narrative.structure`, and `rendering_hints.novel` — and adds one enum
  value.
