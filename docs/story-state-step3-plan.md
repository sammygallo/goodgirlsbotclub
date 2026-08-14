# Productization Step 3 — Renderers: implementation plan

> Status: **decisions approved 2026-08-12. Phases 1–4 built and merged
> 2026-08-13/14; Phase 5 is next — see "Phase 5 starting notes" in §4.**
> Phases 1–3 are deployed; Phase 4 is merged but NOT yet exercised against
> a real provider key, because Phase 5's tab is the only thing that can
> invoke it. Successor to
> [story-state-step2-plan.md](story-state-step2-plan.md) (phases 0–11, all
> merged and deployed; step 2 closed 2026-08-12).
> Inputs: [story-state-schema-v1.md](story-state-schema-v1.md) — especially
> its **Renderer consumption** section and the **v1.1 amendments** — and the
> normative Pydantic module `app/schemas/story.py` in `ggbc-backend`.
> Repos: `goodgirlsbotclub` (frontend), `ggbc-backend` (backend, migration
> head **0022**).
>
> **Shipped so far.** Phase 1 (backend): render tables, the `annotate` pass
> value, reset/restore accounting and `GET /scenes/full` — ggbc-backend #56,
> #57, #58, alembic head `0022_widen_render_token_counters`. Phase 2
> (frontend): the annotate pass and §3.9's four preservation rules — #384,
> plus a read-only beat map (#385) that is NOT in §4's table. §3.3 justifies
> annotate as its own pass so a user can "read the beat map, and correct it";
> the reading half had no phase assigned to it, and shipping a pass whose
> output nothing displays is not worth the token cost. The correcting half
> still waits for Phase 5 — until prose exists there is no way to judge which
> beats are worth correcting. Phase 3: the `finish_reason` bridge (#386, split
> out because it touches shared LLM plumbing) and the render engine (#387).
> Phase 4: `storyRenderStore` — orchestration, the project-wide soft lock and
> its independent heartbeat, `truncated` handling, §3.6's cross-gate, the
> fuel gauge, abort **and resume** — plus the render half of the API client
> (#389).
>
> Annotate has a **temporary** Story-tab entry point, explicitly marked as
> such in the code. Phase 5's Render tab replaces it.
>
> **Revision note.** Two adversarial review passes have run against this
> document. The first found that the original draft's mechanical context
> selector — "world rules filtered by `location_ref` and participant ids" —
> cannot be written: `WorldRule` carries neither reference, and its one
> scene-facing join key is `null` on every lorebook-derived rule. §3.5 was
> rewritten around world-info activation replay instead. The second pass
> reviewed that revision, and its findings are folded in here: §3.5 now names
> the selector's two inputs and what the scanner actually does (it is not
> "what the live engine did"), §3.3 no longer instructs an implementer to
> widen the walk's inner resume gate — the change the store documents as
> ending in a destroyed bible — §3.6's cross-gate is pass-aware so a parked
> annotate cannot strand a user, §3.9 gains the widened-scene case, and
> `orphaned` is derived rather than stored. **The nine decisions themselves
> are unchanged.**
>
> A **third** pass has since run — §5's "one over the implementation" — against
> Phase 3's render engine: four lenses, 21 findings, each judged by two
> independent skeptics, 10 confirmed and 11 refuted. It found two errors in
> **this document** rather than only in the code, both now corrected in §3.5
> and marked there as corrections: non-firing rules headed a truncation order
> they could not be in, and firing rules were in neither the mandatory core nor
> the drop order — which let the assembler return a brief 2.7× over the stated
> cap with no drop record and no refusal. The nine decisions are still
> unchanged.

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
| Deadlock discipline for multi-row writes | `_lock_project`, and the canonical-sort-then-lock pattern in `bulk_write_scenes` | `app/routers/story.py:132-145`, `:806-807` |
| Pass orchestration on the user's key | `storyIngestStore` — chunk planning, per-chunk server checkpoint, soft lock with heartbeat, abort/resume, fuel-gauge accounting | `src/stores/storyIngestStore.ts` |
| Model-to-pass bridge | `makeLlmCall` → `generateOnce`, on the user's active provider | `src/utils/storyIngest/llmBridge.ts` |
| World-info activation replay | `wiReplay.ts` — the WI scanner (primary keys incl. regex + case sensitivity, co-fire `relatedIds`, per-entry scan depth) run over transcript text, with an honest `replay_approx` caveat. **Secondary keys are declared on `ReplayEntry` and never read** (`:31` vs the hit test at `:123-125`) | `src/utils/storyIngest/wiReplay.ts` |
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
  unbounded parallelism, from two repeatable call sites — drift tier 2 on
  every diverged check (`StoryTab.tsx:449`) and every lock attempt
  (`LockCanonFooter.tsx:237`). See §4, Phase 1.
- **Restore's confirm is not a typed confirm.** It is a plain
  `ConfirmDialog` (`StoryTab.tsx:997-1013`). Nothing was removed for it —
  phase10-plan §3.4's typed-confirm removal was about *change source chat*.
- **The raw transcript and the live lorebook entries.** Neither is in the
  bible, and §3.5's rule selector needs both. See §3.5 and §4's Phase 4 row.

One deliberately unbuilt thing carried over from step 2:
**re-walk-from-divergence** (phase11-plan §3.3, which is where the deferral
was decided — step 2 scoped the work *in*). It stays deferred; step 3 does
not depend on it. Two of its three original blockers remain — an orphan
policy for re-segmented scene ids, and an answer for clobbering
user-reviewed titles. The third (crash-safe delete ordering) was answered by
Phase 10's scene-merge precedent (phase11-plan.md:200-212).

---

## 3. Decisions

Nine decisions: §3.1–§3.8 approved 2026-08-12, §3.9 added under review.
§3.5's supporting mechanism and stated cost changed under review; the
decision itself did not.

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
  `pending` | `complete` | `truncated` | `error`
  (`truncated` is §3.4's requirement). **Orphan-ness is deliberately not a
  status value** — it is derived at read time from §3.8's staleness
  predicate, because nothing would ever write it (no FK, no trigger, no
  scanner) and because as a `status` it would overwrite `complete` and lose
  it, which is the same argument that makes `stale_bible` its own column.
- `continuity` — the §3.4 verdict payload
- `server_ts`, timestamps
- Byte cap **128KB** per unit

Three constraints the review established, all of which must land in 0021
because a second backend deploy is the expensive way to fix any of them:

1. **Every status vocabulary is closed at the DB and in Pydantic.** The
   precedent that does both ends is `story_archives.reason` — a DB
   `CheckConstraint` (`app/models/story.py:275-280`) plus the `ArchiveReason`
   `Literal` (`app/schemas/story.py:1152`). `embedding_jobs.status`
   (`app/models/embedding_job.py:84-90`) is the DB-only case, and the
   ingestion checkpoint's status is the Pydantic-only case
   (`app/schemas/story.py:732`, being JSONB). Render status is not JSONB, so
   it gets both.
2. **Every new write endpoint takes `_lock_project(db, project_id)`** after
   body read and validation, per `_read_capped_body`'s ORDERING RULE
   (`app/routers/story.py:398-403`), and the bulk unit endpoint sorts rows
   canonically **before** locking, exactly as `bulk_write_scenes` does
   (sort `:806`, lock `:807`). "Mirror the `story_scenes` shape" means
   copying the discipline, not only the columns — the router's own docstrings
   record three concurrency bugs found by review in this table family.
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

- `IngestPass` (`src/utils/storyIngest/types.ts:14-19`), plus `INGEST_PASSES`
  and `PASS_LABELS` — which live in `storyIngestStore.ts:72-77` and `:86-92`,
  **not** in `types.ts`. `IngestProgressCard.tsx` is a third consumer: its
  `total = INGEST_PASSES.length` drives the progress bar, so adding a pass
  silently re-scales it.
- A `resumableAnnotate` predicate ORed into `continuingBuild`
  (`storyIngestStore.ts:379`), plus an `if (!resumableAnnotate)` skip of the
  walk block mirroring the shipped `if (!resumableReconcile)` at `:702`.
  Today a paused, aborted or errored annotate run falls to the `else` branch
  at `:601`, which re-runs `runColdStart`, full-replaces three sections
  (`:617-619`) and re-walks the entire chat.

  **`runTranscriptWalkPass`'s own inner gate must NOT be widened.** The store
  spells out where that ends (`:339-347`): widening `resumableWalk` alone
  falls through to the fresh-plan branch and silently re-bills the whole
  chat, and *"widening BOTH gates then lands in `sliceChunksFromPlan`, where
  a user who deleted a chunk-boundary message after the walk finished trips
  'diverged' and is told to Reset story, destroying a complete, fully-paid
  bible."* The shipped fix for the identical problem — reconcile — widened
  neither inner gate: a separate predicate (`:358-361`), the OR at `:379`,
  and the explicit skip at `:702` whose comment is *"It must NEVER call
  runTranscriptWalkPass."* Copy that, exactly.
- A decision on whether annotate sits inside `run()`'s linear pipeline or is
  a separate entry point that never touches cold start. **Recommend: separate
  entry point.** Annotate is re-runnable and idempotent per scene; the linear
  pipeline is not. A separate entry point also never reaches
  `runTranscriptWalkPass`, which is what makes the gate above safe.

**Canon lock.** §1 opens on "a locked bible," and annotate writes to one, so
the plan has to say what the lock means here. The codebase gives two
answers: `storyStore.patchScene` refuses while locked
(`storyStore.ts:394-401`, `:1322`), while `storyIngestStore` never consults
the lock and PUTs straight through `storyApi` (`:619`, `:1808`) — the only
gate on that path is one `disabled` prop (`StoryTab.tsx:1257`). The backend
enforces nothing; `canon_locked_at` appears once, as a schema field
(`app/schemas/story.py:323`).

The rule for step 3, stated as the change it is: **Phase 10 disabled the
Build button and every §5 mutating action while locked — including the
derived-write path (phase10-plan.md:129-131, implemented at
`StoryTab.tsx:1257`). Step 3 narrows that invariant to *user-authored* edits,
exempting annotate and render.** Build's own `canonLocked` gate is unchanged;
this is a deliberate narrowing, not a clarification of what Phase 10 meant.

The render and annotate entry points therefore gate on their own predicate,
not on `writesDisabled`. That symbol is a three-term composite —
`!canManage || canonLocked || buildActive` (`StoryTab.tsx:299`) — so
inheriting it would drag in the lock, and dropping it wholesale would drop
the permission term and §3.6's client-side build cross-gate with it. The
Render tab gates on `!canManage` and the build-active term, deliberately not
on `canonLocked`. No code change is needed to permit the write itself —
`storyIngestStore` already bypasses `refuseIfGated` — but the plan says so
out loud rather than relying on that accident. A lock is a
**recommendation**, not a precondition, for the Render tab; unlocking after a
render leaves existing renders untouched. The lock stays client-only: Phase
1's render endpoints will not enforce it.

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

**Truncation is a hard prerequisite, not a detail.** The *story* bridge
discards the one wire-level signal that would catch a cut chapter:
`sse.ts:52-60` reads only the content delta and never
`choices[0].finish_reason`, and `generateOnce` returns a bare string
(`generate.ts:32-58`). The signal exists at the wire and is already consumed
elsewhere in this repo — the backend maps `stop_reason: "max_tokens"` to
`finish_reason: "length"` for Anthropic
(`ggbc-backend/app/providers/anthropic.py:211-220`) and translates Google's
`finishReason` into the same OpenAI vocabulary
(`app/providers/google.py:155-167`, `:203`), and `chatStore` already captures
`choice?.finish_reason || json.stop_reason || json.delta?.stop_reason` into
an `SSEStreamMeta` out-param and drives a `'length'` error path from it
(`src/stores/chatStore.ts:596-620`, `:701-718`). **Phase 3 lifts that shape
rather than inventing one.**

Existing asks run 400–8192 max tokens (`chatStyles.ts:80` = 400,
`coldStart.ts:428` = 500, `lorebookFromTranscript.ts:293` = 8192). That
ceiling is the argument, not a counterexample: its comment reads *"the
default 1024 truncates mid-array and the whole chunk's output is lost"* — a
pass that already hit the cap and had to work around it, and it only noticed
because its output had to parse. Prose has no parser, so a chapter cut
mid-sentence would store as `complete` and export as finished work.

So `storyRenderStore` marks a unit `truncated` — never `complete` — in **two**
cases: an explicit `finish_reason: "length"`, and **an absent terminal
signal**. The second matters because `collectStream` returns whatever
accumulated when the reader reports done, with no completeness check
(`sse.ts:22-27`, `:64-72`); Anthropic's envelope only arrives on a
`message_delta` carrying `stop_reason`, OpenAI-family providers are a
passthrough (`app/routers/generation.py:282`), and a `custom` profile can
point anywhere (`:245-262`). A severed stream would otherwise store
`complete` — the exact failure this paragraph exists to prevent. A unit is
`complete` only on an explicit terminal `stop`. This is the "no silent caps"
rule applied to the one place it would actually bite.

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
reference. Its only join key *to a scene*, `established_in`, is set to `null`
by every cold-start-minted rule (`coldStart.ts:345`), and the two-hop path
through a scene is dead anyway because the walk writes
`setting.location_ref: null` unconditionally (`transcriptWalk.ts:486`). As
drafted, v1 would have been "all rules up to a cap" — arbitrary truncation
dressed as selection.

**The mechanism that actually exists** is the one the story was played
under. Every world rule is lorebook-derived — `coldStart.ts:328-346` is the
only writer of `world.rules`, and the walk mints none — and each carries
`source.ref.{book_id, entry_id}` back to its entry (`coldStart.ts:57-64`,
`:339`). That join already ships: the wi_replay pass promotes rule confidence
by looking entries up on exactly that key
(`storyIngestStore.ts:641-648`, against `wiFiredKey`'s
`${book_id}:${entry_id}` format). So every rule reaches its entry's world-info
**keys**, and `wiReplay.ts` already implements the scanner over them.

*(The rule id is `deterministicUuid('rule:${bookId}:${entryId}')` —
`sourceRefs.ts`, fnv1a + splitmix32. That is a one-way hash, not an
invertible key; it exists for rerun idempotence. Join on `source.ref`.)*

**What the scanner actually does, precisely** — the plan depends on this, and
it is not "what the live engine did":

- It is anchored to **AI turns, scanning backwards**: user turns are skipped
  (`wiReplay.ts:106`) and the haystack is the `scanDepth` messages *before*
  each AI turn (`:107-121`). So a scene's window is its own messages **plus
  the preceding `scanDepth` messages** — without that overlap the first AI
  turn of every scene is scanned against a truncated window.
- A scene with **no AI message fires nothing**, constants included, because
  the `entry.constant ||` test sits inside the AI-turn loop (`:123-125`).
  Such a scene falls back to constants-only by direct inclusion.
- **`opts.capturedFired` must not be passed.** It seeds whole-chat phase-0
  telemetry into `fired` before scanning (`:94-97`), and the one existing
  call site does pass it (`storyIngestStore.ts:631-634`) — correct there,
  fatal here, because every entry that ever fired anywhere would report as
  firing in every scene.
- **Secondary keys are not implemented.** `ReplayEntry.secondaryKeys` is
  declared (`:31`) and populated (`ingestSources.ts:72`) but never read; the
  hit test is `entry.constant || entry.keys.some(...)` (`:123-125`). Do not
  add support for it in Phase 3 — that pulls in `selective`/`selectiveLogic`
  and would change shipped replay results everywhere.

So the selector returns *the entries whose keys appear in this scene's
window* — not "exactly what would have fired."

**The selector's two inputs are not in the bible.** `replayWorldInfo(messages,
entries, opts)` (`wiReplay.ts:84-88`) needs raw chat text and `ReplayEntry`
objects carrying `keys`/`constant`/`relatedIds`/`scanDepth` (`:26-41`).
Scenes store message *ids* and fingerprints, never text
(`app/schemas/story.py:770-798`), and `WorldRule` stores no keys and no
`constant` flag. Both producers already exist and both touch the network or
the live stores — `gatherIngestInputs` fetches the chat
(`ingestSources.ts:88-140`) and `replayEntriesFrom(booksForChat(...))` reads
`worldInfoStore` (`ingestSources.ts:66-81`, `StoryTab.tsx:781-783`). They
therefore belong to **Phase 4**, which passes them into the Phase 3 assembler
as parameters so that module stays pure and network-free. §4's table assigns
them accordingly.

So the v1 context brief is:

- the target scene (full row) and the preceding scene's `detailed_summary`;
- the `participants` character objects — including their
  `voice_profile.dialogue_examples` — and `user_voice`;
- the scene's fact set (defined below);
- `narrative.pov_default` / `tense_default` and the resolved
  `rendering_hints.novel`;
- **world rules whose lorebook entry fires against this scene's window**, by
  WI replay, plus all `constant` entries' rules by direct inclusion — and
  nothing else. A rule whose entry did not fire is **excluded**, not
  deprioritised; see the cap paragraph below.

  The `constant` half reads the flag off the **entry**, and only when that
  entry is still `enabled` with non-empty content — the same filter
  `wiReplay` applies before scanning (`wiReplay.ts:99`). Without the filter
  the two halves disagree: a disabled *keyword* entry correctly cannot fire,
  while a disabled *constant* entry would be force-included into the one
  category the cap drops last, letting lore the user switched off displace
  rules that actually fired. Cold start refuses to mint rules from
  switched-off entries for the same reason (`coldStart.ts:355-358`).

Everything past the cap is dropped in a **stated priority order**, and the
drop is surfaced in the UI and logged — never silent.

**The scene's fact set** is a three-way union:
`scene.continuity_facts_established` ∪ facts whose `established_in ==
scene.id` ∪ **all live facts with `established_in: null`**, sourced through
the shipped `loadAllFactsById` (`storyStore.ts:1067-1104`). The third member
is the one that has to be spelled out: the first two exclude null-attributed
facts *by construction* — `continuity_facts_established` is only ever pushed
by the walk for facts it mints with `established_in: sceneId`
(`transcriptWalk.ts:473`, `:496`) — and the server-side filter excludes them
too (`app/routers/story.py:949-950`). Today that tail is `reconcileJudge`'s
card-conflict facts (`reconcileJudge.ts:773`) and the user's own "write my
own" resolution facts (`StoryTab.tsx:640`): bible-wide canon, and the
foundational claims prose is most likely to contradict. They enter
priority-ordered under the cap. (World rules are *not* in this set — they are
`world.rules` entries, never `story_facts` rows, and reach the brief only
through the rule selector above.)

The assembler must also drop rows carrying `deleted_at` itself:
`_read_log_page` never applies `_fact_is_live()`
(`app/routers/story.py:933-959` vs `:255-264`), so Phase 10 tombstones come
back in the page.

**Context cap: 24k tokens for the assembled brief**, with truncation priority
(first dropped first): bible-wide `established_in: null` facts → fact set
beyond the scene's own → preceding-scene summary → participants'
`dialogue_examples` → **firing rules, trimmed from the tail**. The mandatory
core — target scene, participant records *minus* their dialogue examples,
`user_voice`, hints — is never dropped; if it alone exceeds the cap the run
refuses with a named error rather than silently rendering a partial brief. A
number and an order are what make this testable in Phase 3 without a model.

*(Two corrections to this paragraph, both found by the Phase 3 implementation
and its adversarial review. Recorded rather than silently applied, because
each changes what the assembler does.)*

**(a) Non-firing rules are not in the brief at all, so they cannot head the
drop order.** The list above previously began with them, which contradicted
this section's own definition of the brief four paragraphs up — "world rules
whose lorebook entry **fires** against this scene's window … plus all
`constant` entries' rules". A category that is never included cannot be the
first thing dropped. Read the other way — non-firing rules included by default
and shed under pressure — the selector becomes a no-op for every bible that
fits under the cap, which is precisely the *"all rules up to a cap — arbitrary
truncation dressed as selection"* this decision was rewritten to escape.
Exclusion is the point. Their count is still surfaced, as a **selection**
fact ("N rules were not active in this scene") rather than a cap drop.

**(b) Firing rules are droppable, last.** They were in neither the core nor
the drop order, which left a third outcome this section forbids: a brief
returned **over cap** with no drop record and no refusal. That is reachable on
ordinary data, not corruption — cold start's `WORLD_RULE_BYTE_BUDGET` is 180KB
and every `constant` entry's rule is included unconditionally, so a large
always-on lorebook fills the category. Measured at 44k and 65k estimated
tokens against the 24k cap during review. They are therefore trimmed from the
tail, partially, with the count reported: a scene rendered with most of its
world rules is worth having, where a refusal is worth nothing.

**Cost, stated honestly.** WI keys are the author's own relevance model, not
a semantic one, and the replay is *deliberately over-inclusive*
(`wiReplay.ts:73-81`) — correct for a human-reviewed ingestion pass, inverted
here, where a false positive evicts real content under a hard cap. So the
selector both **misses** rules whose keys never appear in a scene's window
and **over-fires** entries the author gated behind secondary keys. It carries
the same approximation caveat `wiReplay` documents: probability rolls are
re-rolled and sticky/cooldown state was never recorded.

It also measures **today's state, not the state the story was played under**.
`booksForChat` recomputes from current app state
(`StoryTab.tsx:711-737`), so a detached, deleted or edited book silently
changes the brief; a dangling source chat (`StoryTab.tsx:1064`) or pre-phase-1
messages without `extra.ggbc_id` leave a scene with an empty or partial
window. Each of those surfaces as a drop under this section's own
never-silent rule.

One consequence worth naming: **the constants floor is not guaranteed.**
`constant` is not stored on `WorldRule`, and its one proxy —
`confidence: entry.constant ? 'explicit' : 'inferred'` (`coldStart.ts:344`) —
is erased on any bible that has run pass 1.5, which promotes *every* fired
entry to `'explicit'` (`storyIngestStore.ts:641-648`). So constants are
included when their book is still active and identifiable, not
unconditionally. If that floor has to be guaranteed, persisting a `constant`
flag on `WorldRule` is additive and §7 does not forbid it — but it is a
`world`-section schema change and would belong in Phase 1's deploy.

Distant thematic callbacks — the thing embeddings are actually good at — are
still missed. That is what Phase 8 measures.

**And Phase 8 is not one line.** The first draft called adding
`target_type = 'story_scene'` "genuinely cheap." It is not:
`embedding_jobs.target_id` is a bare `PGUUID` with a partial unique index on
`(target_type, target_id)` and **no tenant column**
(`app/models/embedding_job.py:64-65`, `:90-96`), while `StoryScene`'s PK is
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
- **Cross-gating with ingestion, and it must be pass-aware.** A transcript
  walk full-replaces the scene rows a running render is reading
  (`storyIngestStore.ts:1077-1100`), so this is a correctness problem, not
  only a spend problem. But a gate on `ingestion.status` alone would strand
  users: §3.3 puts annotate on that same checkpoint, and an aborted pass
  persists `paused` (`storyIngestStore.ts:737`, `:940-947`) or `error`
  (`:751`). A user who starts annotate — the step §3.3 has the tab default to
  — and stops partway could then never render at all.

  So `POST /renders` refuses only when `current_pass` is one that rewrites
  scene or section rows (`transcript_walk`, and `cold_start` for the section
  replace), and for those it refuses on `running`, `paused` **and `error`** —
  `error` is resumable (`resumableWalk` has no status check, `:331-335`), so
  a resumed errored walk does the very full-replace the gate exists to
  prevent. That triple matches the codebase's own predicate,
  `storyStore.isBuildActiveNow` (`:380-384`). A parked annotate or reconcile
  never blocks rendering. The gate is evaluated **client-side** in
  `storyRenderStore`, since the backend reads no checkpoint contents for
  control flow today. Symmetrically, Build is disabled while a render is in
  flight.

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

Reset deletes **both** render tables in the same transaction — its delete
list is an explicit enumeration of models (`app/routers/story.py:1547-1565`),
so deleting only `story_renders` would leave every unit row parentless.
`(project_id, render_id)` also carries a real FK to `story_renders`
`ON DELETE CASCADE`: unlike `story_scenes`, renders are never
delete-and-reinserted, so the objection below does not apply to the
parent/child edge. Phase 1 adds `renders_deleted` to `StoryResetOut`
(`app/schemas/story.py:1180-1189`) — one count, of render runs, since units
follow the cascade.

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

Decision: `story_render_units` carries `project_id` and **no FK to
`story_scenes`**. Rationale: restore physically deletes and re-inserts every
scene row (`app/routers/story.py:1450-1451`), so a scene-edge
`ON DELETE CASCADE` would silently cascade away the very renders §3.8
promises to keep and mark stale. This follows `embedding_jobs.target_id`'s
documented precedent (`app/models/embedding_job.py:16-23`).

**Orphan-ness is therefore derived at read time, never stored** — no FK, no
trigger and no scanner means nothing would ever write it, and §3.2 keeps it
out of the unit `status` vocabulary for the same reason `stale_bible` is its
own column. The read-time predicate is "scene absent OR
`scene.server_ts != unit.source_scene_ts`," and the reader labels both cases.
Because `patchScene` bumps `server_ts` for a cosmetic retitle as readily as
for a content change, a retitle marks prose stale. Accepted: false-stale is
cheap, false-fresh is not.

**Cost:** reset destroys prose irreversibly. **Three** shipped strings
currently promise otherwise, and Phase 5 rewrites all of them: the helper
copy under Reset story — "a snapshot is kept below — this can be undone"
(`StoryTab.tsx:1451`); the reset confirm — "A snapshot is kept, so this can
be undone from the snapshots list below" (`:1491`); and the **Re-ingest**
confirm (`:1518`), which is the one a user actually reads before an
irreversible prose delete, since `resetBible('reingest')` (`:891`) and
`resetBible('change_source_chat')` (`:698`) are the flows that reach reset.
The restore confirm is untouched.

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
**preserved** where the scene id and `source.message_range.start` are
unchanged **and the new range contains the old**. The guard is deliberately
not "message range unchanged": a continuing scene reuses `carry!.rangeStart`
and gets a *new* end (`transcriptWalk.ts:398-403`, `:491`), so the range
always extends, and the stricter guard would exclude the only path the test
below exercises. A scene whose range **extended** carries its annotation
forward *and* is marked for re-annotation — its beat and compression target
were computed for less material than it now holds.

**Ownership is `transcriptWalk.ts` *and* `storyIngestStore`**, because the
walk alone cannot implement it: `ProcessChunkParams` (`:88-110`) carries no
stored scene and no network — the module "never touches storyApi" (`:13-15`)
— `OpenSceneCarry` (`:53-71`) has no field to carry the annotations in, and
the 409 body cannot rescue it either (`SceneConflictItem` is
`{id, current_ts}`, `app/schemas/story.py:1083-1086`). So Phase 2 adds
`function`/`transformations` to `OpenSceneCarry` and populates them at the
reopen (`storyIngestStore.ts:1719-1735`, which already fetches the full row),
and picks a mechanism for re-emitted *non-open* scenes — pre-fetch the rows,
or merge semantics on the bulk write. The named pin below exercises only the
first.

**(c) The same defect already ships in `mergeScenes`.** The survivor is
spread wholesale (`storyStore.ts:282-283`), keeping `function` and
`transformations`, while its range is rewritten to span both scenes
(`:295-303`) — so its beat, tension and compression target now describe
roughly half the material it holds, and a re-render re-reads the stale
annotation. User-reachable today. **One rule covers both:** *a widened scene
loses its annotation.* `mergeScenes` nulls the survivor's
`function`/`transformations` (`storyStore.ts:282`), with its own pin.

**(b) `rendering_hints` is a fourth owned group, and cold start replaces
it.** The Render tab's hints editor writes `rendering_hints.novel`, and cold
start full-replaces that whole section with hardcoded defaults
(`coldStart.ts:349-368`; `storyIngestStore.ts:619`) — reachable from "Rebuild
the groundwork" with no reset and therefore no archive
(`StoryTab.tsx:1245-1258`). The store's own comment at `:553` already flags
this class as "clobbering sections this bible has been reviewed against."

**Rule:** cold start's `rendering_hints` write becomes a **merge**, not a
replace — hardcoded defaults fill only absent keys. Phase 2 owns it.

**Section loading.** `storyStore.load`'s `wanted` list is `meta`, `world`,
`entities`, `continuity`, `ingestion`, `user_voice`
(`storyStore.ts:618-627`) — so **both** `rendering_hints` *and* `narrative`
are absent. The generic lazy loader already exists and is what
`LockCanonFooter` calls for both (`storyStore.ts:679-690`;
`LockCanonFooter.tsx:240-243`), so this is a call, not new plumbing: Phase 2
calls `loadSection('narrative')` (annotate writes `narrative.structure` and
the brief reads `pov_default`/`tense_default`), Phase 5 calls it for
`rendering_hints`. Note also that `writeSection` is a documented FULL REPLACE
(`storyIngestStore.ts:762-763`), so annotate's `narrative.structure` write
must read-merge — prospective, since nothing writes that section today.

---

## 4. Phased delivery

Each phase is one PR, human-reviewed, independently deployable. Backend
phases serialize in migration order.

| Phase | Repo | What lands | Migration |
|---|---|---|---|
| 1 | backend | `story_renders` + `story_render_units` with closed status vocabularies, `stale_bible` and lock columns (§3.2); sub-resource API under `_lock_project` discipline; reset deletes **both** render tables and reports `renders_deleted`; restore marks `stale_bible`; `IngestPass` gains `annotate`; a full-data bulk scene read (§4 note); **docs patch** to `story-state-schema-v1.md:620-621`, the one place that states the pass enum excludes `annotate` | **0021** |
| 2 | frontend | Annotate pass — `src/utils/storyIngest/annotate.ts`; pass constants in `types.ts` **and `storyIngestStore.ts`** (plus `IngestProgressCard`); `resumableAnnotate` + the walk-block skip (§3.3); annotation preservation in `transcriptWalk.ts` **and `storyIngestStore`** and the widened-scene rule in `storyStore.mergeScenes`; the `rendering_hints` merge in `coldStart.ts`; `loadSection('narrative')` (§3.9); the `types.ts:11-13` comment that states the exclusion | — |
| 3 | frontend | Render engine — `src/utils/storyRender/` (context assembler incl. the WI-activation rule selector and the 24k cap, prose prompt, continuity checker), pure and network-free — it takes the transcript and lorebook entries as **parameters** (§3.5); **llm bridge extended to surface `finish_reason`**, lifting `chatStore.ts:596-620`'s shape (§3.4) | — |
| 4 | frontend | `storyRenderStore` — run orchestration, per-unit checkpoint, soft lock, abort/resume, `truncated` handling, fuel gauge; **gathers the assembler's inputs** (`gatherIngestInputs`, `replayEntriesFrom(booksForChat(...))`, §3.5); the pass-aware ingestion cross-gate (§3.6) | — |
| 5 | frontend | Render tab UI — hints editor, scene-range picker, preflight, progress, reader, per-scene re-render; `loadSection('rendering_hints')`; the three reset-family confirm strings (§3.8); Build disabled while a render is in flight; `WorksPanel.tsx` tab strip | — |
| 6 | frontend | Export to Markdown with chapter breaks; continuity-flag review surface; **calibration-set fixtures** (3–5 transcripts with human-rated expected output, run on every renderer change) | — |
| 7 | frontend | Screenplay/Fountain renderer | — |
| 8 | both | Scene embeddings and RAG-selective context, measured against the Phase 6 calibration set — at the real cost enumerated in §3.5 | 0022 |

Phases 3 and 4 are the `storyIngest` / `storyIngestStore` split repeated
exactly: pure engine, then store. That split is what made step 2's passes
unit-testable without a network.

**Phase 1's bulk scene read.** Annotate write-back, the range picker, the
context assembler and the export all need full scene rows, and the shipped
path is N unbounded round trips (§2). Phase 1 adds a bulk full-scene read so
step 3 does not promote an N+1 to a hot path — but it must **not** simply
reuse the existing page shape. `limit` is `le=500` default 200 and
`SCENE_MAX_BYTES` is 64KB, so a default full page is up to 12.8 MB and
`limit=500` up to 32 MB — reintroducing exactly what the SQL projection
exists to prevent (*"a 'projection' that shipped full summaries would put
megabytes on a bodyless GET"*). Full mode therefore gets its own row ceiling
**and** a cumulative byte budget that ends the page early, mirroring
`SCENE_BULK_MAX_BODY`'s reasoning, and its own response model, since
`ScenePage.items` is `SceneSummary` and FastAPI validates against it. If this
slips, Phase 3 must say where the full-scene set is cached within a visit and
bound the parallelism.

**It shipped as `GET /scenes/full`, not the `?full=true` this plan first
sketched** (ggbc-backend #58). The two cannot both be had: `response_model`
is per-route, and this paragraph's own requirement — full mode needs its own
response model — is what forces the split. Validating full rows against
`ScenePage` would not error; it would silently strip `data` from every scene,
which is the worst available failure for an export path. Keeping the query
parameter would have meant a union response model plus per-mode `limit`
defaults and ceilings fighting FastAPI's declarative `Query` validation.

What shipped, so §3 and Phase 4 can code against it rather than against the
sketch above:

- `GET /projects/{id}/story/scenes/full` → `FullScenePage`, whose `items` are
  whole `SceneOut` rows, keyset-paged on the `(sequence, id)` pair exactly
  like `ScenePage`.
- Two ceilings, each doing a job the other cannot: `FULL_SCENE_PAGE_MAX`
  (100, default 50) bounds the **database read**; `FULL_SCENE_MAX_BYTES`
  (4 MB) bounds the **response**, since by the time bytes are counted the
  rows are already in memory.
- `truncated_by_bytes` on the page reports an early cut, so a byte-limited
  page is visibly that rather than looking like a short one.
- The cursor points at the last row **included**, never the last row read: an
  early cut resumes at the first row it dropped. A page also always emits at
  least one row, or an empty page with `has_more` true would be a cursor that
  never advances.
- **Route declaration order is load-bearing.** `/scenes/full` must stay
  declared above `/scenes/{scene_id}`; `full` is not a UUID, so the
  parameterised route would otherwise shadow it with a 422. Pinned by a test.

### Phase 5 starting notes — the state at its door

*Written at the end of the Phase 4 session, against what actually shipped
rather than against this plan's own predictions. Phases 1–4 are merged;
none of the render path has ever run against a real provider key, because
Phase 5's tab is the only thing that can invoke it.*

**The store's real API.** `storyRenderStore` exposes `start`, `resume`,
`cancel`, `clear`, plus `ingestionBlocksRender` and `unitStatusFor` as pure
helpers the tab can call for gating and labels. Both entry points take
`RenderSources`:

```
scenes, factRows, characters, worldRules, userVoice, hints, narrative,
messages, wiEntries, wiScanDepth?, llm, model?, takeover?
```

plus `{projectId, format?, sceneIdStart, sceneIdEnd}` for `start` and
`{projectId, renderId}` for `resume`.

**The deviation Phase 5 has to absorb.** §4's Phase 4 row says the store
gathers the assembler's inputs. It does not: `messages` and `wiEntries` are
parameters, because `gatherIngestInputs` and `booksForChat` live in
`components/works/` and no store here imports from `components/`. **The tab
therefore owns that gathering**, exactly as `StoryTab` already does for a
build — `gatherIngestInputs(sourceChat.ref)` and
`replayEntriesFrom(booksForChat(avatar, fileName))`. Copy those call sites.

**What the tab still has to build on the API client**, which is written and
typed but has no consumer yet: `listRenders` (find a resumable or past
run), `readRenderProse` (the reader and Phase 6's exporter — paged at 25
because each item is a whole chapter), and `deleteRender`. `listRenderUnits`
is used by `resume` and gives the reader its per-scene status, including the
derived `is_stale` / `is_orphaned` flags §3.8 promises.

**Gating the tab.** Per §3.3 the Render tab derives its OWN predicate from
`canManage` and the build-active term, deliberately **not** from
`writesDisabled` (which carries `canonLocked`). `ingestionBlocksRender` is
the store's exported copy of §3.6's pass-aware rule — use it for the
disabled state so the button and the store cannot disagree. Symmetrically,
Build must be disabled while a render is in flight.

**Things a reader/preflight must not get wrong**, all already enforced in
the store and worth surfacing rather than re-deriving:

- A unit is `complete` only on an explicit terminal `stop`; `truncated`
  blocks export (§3.4). The reason lives in `continuity.terminal` /
  `continuity.finish_reason` on the unit.
- `continuity.unreadable: true` means the check could not be READ, which is
  not "clean". The reader must not present it as verified.
- `continuity.drops` and `rules_not_active` are the never-silent record of
  what the 24k cap and the rule selector left out (§3.5). Surface them.
- A `RenderLockedError` carries `takeable` — that flag is what draws a
  "Take over" affordance rather than a dead end. `resume` never takes over
  implicitly; the tab must ask and pass `takeover: true`.

**Phase 4's review is CLOSED — nothing is outstanding.** Its first pass
confirmed and fixed six defects, but 15 of 41 agents died on a session limit,
leaving several findings without verdicts. A second, focused pass re-judged
every one of those against the code as it then stood (deliberately not a
cache replay of the first run, whose verdicts predated the six fixes and
would have re-reported them as live). All ten agents completed: **two
confirmed and fixed, three refuted.**

- Fixed: `progress.done` went backwards on resume (a banked count seeded
  against a positional index), and `resume` stranded the project-wide lock
  when the status flip failed — no heartbeat exists at that point, so it was
  a dead lock held for the full 120s expiry against every device and every
  format.
- Refuted, and deliberately unchanged: `resume` ignoring `stale_bible`
  (restore sets the flag and nothing clears it, so a two-bible run IS
  distinguishable); a stale `base_ts` on resume's lock acquire (premise
  accurate, the 409-instead-of-423 chain does not exist against the
  backend's contract); and the unguarded `scene.source.message_range` deref
  (true as a code fact, but every writer of `story_scenes.data` goes through
  `_validated_scene`, so the trigger is unreachable through the API).

One of the two confirmed defects existed *only because of a fix made after
the first review ran* — `resume`'s status flip kept using the raw
`setRenderStatus` while the terminal writes moved to `setStatusWithRetry`.
A cache replay would have missed it, which is the argument for re-verifying
against current code rather than resuming a stale run.

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
user can read and export but cannot start, abort or re-render. Per §3.3 the
Render tab derives its **own** predicate from the same `canManage` and
build-active terms rather than reusing `writesDisabled`, which also carries
`canonLocked`. Projects are strictly user-scoped
(`app/routers/projects.py:49-58`), so there is no sharing case to design for.

**The one hard ordering constraint:** Phase 1 must deploy before Phase 2
merges, because `IngestPass` is a strict `Literal`
(`app/schemas/story.py:705-707`) — an older server 422s the entire
`PUT .../sections/ingestion` body (`app/routers/story.py:416-425`), so the
annotate pass cannot checkpoint at all. This is a *value* rejection, not the
`extra="forbid"` unknown-key rejection; step 2's documented mitigation for
`extra="forbid"` skew (relaxing leaves to `extra="allow"`) would not touch
this gate.

### Phase 5, as shipped — the deviations a later phase must not undo

*Written at the end of the Phase 5 session, against what landed rather than
what §4's one-line row predicted.*

**The store gained a third entry point.** §4 lists "per-scene re-render" as
tab work, but `storyRenderStore` exposed only `start`/`resume`, and neither
can do it: `resume` refuses a `complete` run (continuing one would re-bill
every scene) and deliberately never re-renders a `truncated` unit. So
`rerenderScene` was added as a generalisation of `resume` rather than a
second copy of it — one `continueRun` with a discriminated mode, because the
last time two copies of that sequence existed they drifted and the drift
stranded the project-wide lock.

Three things are true only of the re-render mode, and all three are pinned
and mutation-tested:

- It accepts **any** run status, including `complete`.
- It re-renders a `truncated` unit — the only path that ever does.
- **A failed re-render writes NOTHING.** `writeUnit` is a full replace, so
  banking an `error` over an existing unit would swap finished, paid-for
  prose for an empty row — destroying output because the *retry* failed.
  Every other caller is filling a gap, where an `error` unit beats no record;
  a re-render is replacing, where it does not. The failure is still counted
  and toasted, so nothing is silently swallowed.

**`storyStore` gained two members.** `saveNovelHints` (the hints editor's
writer — a patch over the stored section, since a full replace would delete
the three renderer groups step 3 does not own) and `loadAllScenesFull` (the
render path's whole-scene read, through `GET /scenes/full`). The latter is a
SECOND reader beside `loadAllScenesWithData` rather than a rewrite of it: the
shipped one is a summary page plus a GET per scene, called on an explicit
click, while this is called before every run, preflight and reader open, and
§4 is explicit that this step must not promote an N+1 to a hot path.

`saveNovelHints` is gated `allowWhileLocked: true`. That is §3.3's narrowing
applied consistently — a locked bible is the state §1 describes rendering
FROM, and refusing here would make the tab unusable in its primary case. The
build term is NOT waived: cold start full-replaces this section.

**`booksForChat` moved to `ingestSources.ts`**, out of `StoryTab`'s closure.
The renderer replays world-info activation against the same book set the
ingestion walked (§3.5), so two copies of that resolution order would
eventually disagree — and the symptom, rules quietly missing from rendered
prose, looks nothing like its cause.

**Four confirm strings changed, not three.** §3.8 names the helper copy, the
reset confirm and the re-ingest confirm. The **change-source-chat** confirm
also reaches `resetBible`; it was not on the list because it never promised
recoverability, but it enumerated what reset destroys and prose was missing
from that list. Fixed for the same reason as the other three.

**The Render tab loads the story store itself.** Only one Works tab is
mounted at a time and `StoryTab` clears the store on unmount, so a switch
from Story to Render arrives with an empty manifest — which the tab would
otherwise render as "nothing to write out yet" on a fully built bible.

**Not yet verified against a real provider key.** The suite is green and the
app boots, but no render has been run end to end. That is still the open
item, and it is Phase 6's precondition as much as this phase's.

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
- reset deletes render rows **and their unit rows**, and reports the count
- restore marks renders `stale_bible` inside the restore transaction
- a reset racing a bulk render-unit write does not 500
- `GET /scenes/full` ends a page early on the byte budget rather than
  returning a multi-megabyte body, and its cursor resumes at the first row
  the cut dropped rather than skipping it (§4)

**Mutation-tested pins, frontend:**

- a checkpoint parked at `annotate` plus a Build press does **not** re-run
  cold start — and does **not** call `runTranscriptWalkPass` (§3.3)
- annotate, then resume a paused walk that **extends** that scene:
  the annotation survives and the scene is marked for re-annotation (§3.9a).
  The extension is the point — a continuing scene's range always grows, so a
  test that held the range fixed would exercise no path at all.
- merging two scenes clears the survivor's `function`/`transformations`
  (§3.9c)
- "Rebuild the groundwork" does not reset user-edited `rendering_hints`
  (§3.9b)
- a `finish_reason: "length"` response stores the unit as `truncated`, and
  export refuses; **so does a stream that ends with no terminal signal at
  all** (§3.4)
- a render refuses to start while `current_pass` is `transcript_walk` and
  status is `running`/`paused`/`error`, and **starts fine** with a parked
  `annotate` checkpoint (§3.6)

Done for step 3 means: a user can take a bible, annotate it, render a scene
range to novel prose, read it on a second device, re-render a scene they did
not like, export it as Markdown, and render the same bible as a screenplay
without any bible change.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Per-render spend is user-visible and larger than ingestion | Preflight token estimate before any spend, two calls per scene not five (§3.4), per-scene re-render so a bad run is not a full re-pay |
| A chapter is silently truncated and exports as finished work | `finish_reason` surfaced through the bridge; `truncated` on `length` **and on an absent terminal signal**; blocks export (§3.4) |
| Prose quality is subjective and unmeasurable | Calibration set in Phase 6, before the RAG phase it justifies |
| The rule selector misses rules whose keys never appear in the scene's window, **and over-fires secondary-key entries** | Stated cost of §3.5; constants included when their book is still active; drops surfaced and logged, never silent |
| Continuity checking is blind to the `established_in: null` tail | The fact set is a **three-way** union that names that tail explicitly (§3.5) |
| A 60-scene render is a long tab-open operation | Per-unit checkpoints; a closed tab loses at most one scene |
| A re-walk, a merge or a rebuild destroys annotations and hints the user paid for | §3.9's preservation rule, widened-scene rule and merge rule, each with a mutation-tested pin |
| Reset destroys prose irreversibly while the confirms say otherwise | §3.8; Phase 5 rewrites all three reset-family strings |
| A render reads scene rows a concurrent walk is replacing | §3.6's pass-aware cross-gate — which deliberately does **not** strand a user whose annotate is parked |
| Renders outlive the bible they were rendered from | `source_scene_ts` per unit, `stale_bible` on restore, orphan-ness derived at read time (§3.8) |
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
- Secondary-key support in the WI scanner. It is declared but never read
  (§3.5); adding it pulls in `selective`/`selectiveLogic` and would change
  shipped replay results everywhere, including ingestion's.
- Any change to the bible schema's **existing** fields. Step 3 writes four
  field groups — `scenes[].function`, `scenes[].transformations`,
  `narrative.structure`, and `rendering_hints.novel` — and adds one enum
  value. (§3.5 notes one additive change that would be needed *only* if the
  constants floor has to be guaranteed: a `constant` flag on `WorldRule`.
  That is not in scope as planned.)
