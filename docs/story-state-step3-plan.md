# Productization Step 3 — Renderers: implementation plan (draft)

> Status: draft for review. Successor to
> [story-state-step2-plan.md](story-state-step2-plan.md) (phases 0–11, all
> merged and deployed; step 2 closed 2026-08-12).
> Inputs: [story-state-schema-v1.md](story-state-schema-v1.md) — especially
> its **Renderer consumption** section and the **v1.1 amendments** — and the
> normative Pydantic module `app/schemas/story.py` in `ggbc-backend`.
> Repos: `goodgirlsbotclub` (frontend), `ggbc-backend` (backend, migration
> head **0020**).

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
  compression, style anchors), see a preflight cost estimate, and render on
  their own key with per-scene progress, abort and resume — the same
  machinery shape as ingestion.
- **Novel-form prose** stored server-side per scene, re-readable across
  devices, with a continuity check that cross-references the fact log and
  flags contradictions in the *output* rather than in the bible.
- **Export** to Markdown, with chapter breaks driven by
  `rendering_hints.novel.chapter_breaks`.
- A **second renderer** (screenplay/Fountain) that reuses the same bible and
  the same storage, proving the schema doc's central claim that the bible is
  format-independent.

**Explicitly deferred (step 4+), with the cost of each stated in §3:**

- Round-trip edit propagation from rendered output (schema doc "Round-trip
  editing", audit G6). Renders are output in step 3; editing prose does not
  update canon.
- RAG-selective context assembly and the `story_embeddings` work (audit G7).
  Step 3 selects context mechanically — see Decision 5.
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

Step 3 is much smaller than step 2 looks, because four of the five things a
renderer needs already shipped.

| Need | Already there | Where |
|---|---|---|
| The bible itself | 8 section rows + scenes + append-only fact/edit logs, all owner-scoped | `ggbc-backend` `app/routers/story.py` (1565 lines), `app/models/story.py` |
| Annotate target fields | `SceneFunction`, `SceneTransformations`, `NarrativeStructure`, `Act`, `Theme` — all modeled, all optional, all empty | `app/schemas/story.py:572-621`, `:759-810` |
| Render configuration | `RenderingHintsSection` with `novel` / `screenplay` / `graphic_novel` / `storyboard` sub-objects, fully modeled | `app/schemas/story.py` |
| Pass orchestration on the user's key | `storyIngestStore` (1846 lines) — chunk planning, per-chunk server checkpoint, soft lock with heartbeat, abort/resume, fuel-gauge accounting, tolerant JSON recovery with one repair re-ask | `src/stores/storyIngestStore.ts`, `src/utils/storyIngest/` |
| Model-to-pass bridge | `makeLlmCall` — messages in, text out, on the user's active provider | `src/utils/storyIngest/llmBridge.ts` |
| Snapshot / restore / reset | `story_archives` with restore behind a typed confirm | `app/routers/story.py:1317-1565`, migration 0016 |
| Drift and staleness | `msgDrift`, `stale_source` on scene annotations, incremental re-ingestion | Phase 11 |

Two things do **not** exist and are the real work: **somewhere to put prose**,
and **a pass that reads scenes and writes prose**.

One deliberately unbuilt thing carried over from step 2:
**re-walk-from-divergence** (step-2 plan §3.3). It stays deferred; step 3
does not depend on it, and its three blockers (orphan policy for re-segmented
scene ids, crash-safe delete ordering, clobbering user-reviewed titles) are
unchanged.

---

## 3. Decisions — **need approval before implementation**

Eight decisions. Each carries a recommendation and what the recommendation
costs.

### 3.1 The first renderer is **novel prose** (recommended)

The schema doc specifies four renderers. Screenplay is the cheapest to build
— its transformation chain is four stages to novel's six, and Fountain is a
plain-text format with no layout engine. It is also the least differentiated:
a screenplay formatter over scene summaries is a thing anyone can ship.

Novel prose is the one that consumes `user_voice`, which is the whole point
of the chat-as-input modality — the bible knows how *this user* writes. It
also produces output a user will actually read end to end, which is what
makes the annotate pass and the review checkpoint feel worth their token cost
in hindsight.

**Cost:** the longest chain, the largest outputs, and the highest per-render
spend of the four. Screenplay follows in Phase 7 specifically to prove the
bible is format-independent, which is a claim we should test before adding a
third format.

### 3.2 Prose lives in **new tables**, not in a section row (recommended)

`story_sections.data` is capped at 256KB and is a single-row full replace with
`base_ts` concurrency. A rendered novel over 60 scenes is comfortably past
that cap, and a full-replace write means a crash mid-render loses the whole
render rather than one scene.

Proposal: migration **0021** adds two tables.

- `story_renders` — one row per render run: `id`, `project_id`, `format`
  (`novel` | `screenplay`), the `hints` snapshot the run was configured with,
  the scene-id range, `status`, `model`, `prompt_version`, token/cost
  accounting, `server_ts`, timestamps.
- `story_render_units` — one row per scene per render: `(render_id,
  scene_id)`, `sequence`, the prose, a `source_scene_ts` watermark so a scene
  edited after its unit was rendered is detectably stale, per-unit
  `status`, and the continuity verdict from Decision 4. Byte cap **128KB**
  per unit, matching the section cap's spirit at a grain that actually holds
  one scene of prose.

This mirrors the `story_scenes` shape (per-row `server_ts`, all-or-nothing
bulk endpoint) rather than inventing a third convention, and it makes
"re-render just scene 14" a one-row write.

**Cost:** a migration and roughly 350 lines of router. The alternative —
prose in `user_documents` or client-only — was rejected because renders must
survive a device change and because reset/archive have to know about them
(Decision 8).

### 3.3 Annotate ships **before** the renderer, as its own phase (recommended)

The annotate pass is one LLM call per scene that fills `function` (beat,
tension, mood, stakes) and `transformations` (compression recommendation,
ratio, pacing notes, dialogue density), plus one bible-wide call for
`narrative.structure`. The renderer reads all of it — `compression_ratio_target`
is literally the compressor's input.

Shipping it separately means a user can run annotate, look at the beat map,
and correct it before spending render tokens on a wrong reading. Folding it
into the render chain would make every re-render re-pay for annotation.

This needs one **backend** change: `IngestPass` in `app/schemas/story.py` is
`Literal["cold_start", "wi_replay", "transcript_walk", "reconcile",
"review"]` and deliberately excludes `annotate`. Adding the value is a
one-line change plus tests, but `extra="forbid"` and the strict enum mean it
must **deploy before** any client emits it. It rides along with the 0021
migration PR (Phase 2) so there is exactly one backend deploy gating the
frontend work.

**Cost:** one more pass the user has to run, and one more preflight estimate
to explain. Mitigated by defaulting the Render tab to "annotate first" when
`scenes[].function` is empty.

### 3.4 The chain is **two LLM calls per scene**, not six (recommended)

The schema doc's chain is five specialist stages: POV/tense transformer →
dramatic compressor → dialogue polisher → narration voice-matcher →
continuity validator. The first four each rewrite the whole scene.

Five stages on a 60-scene bible is 300 calls, each carrying the full scene
text in and out. That is a per-render cost a user will notice on their own
key, and each rewrite handoff is a lossy generation — stage 4 has no access
to what stage 1 actually saw, only to stage 3's paraphrase of it. The failure
mode of long rewrite chains is drift toward generic prose, which is the exact
opposite of what `user_voice` is for.

Proposal for v1: **one prose call** that receives POV/tense, the compression
target, the participants' `voice_profile`s and the user's voice profile as a
single structured brief, and **one continuity call** that reads the produced
prose against the scene's fact range and returns structured verdicts (no
rewrite). Two calls, one rewrite, no lossy handoffs.

**Cost:** less specialist control. If the prose comes back with, say, good
voice but bad compression, we cannot re-run just the compressor. The
mitigation is that per-scene re-render is a one-row write (Decision 2), so
"regenerate this scene with a tighter compression target" is cheap and
user-driven. If measurement later shows the single call is genuinely worse,
the multi-stage chain goes behind a "high effort" toggle — the storage shape
does not change either way.

### 3.5 Context selection is **mechanical** in v1; embeddings deferred (recommended)

The step-2 plan deferred pgvector "until the first RAG-selective renderer
phase," and the schema doc's renderer-consumption section calls for RAG over
world-rule text against scene content.

We now have more information than when that was written. The lorebook work
shipped a **polymorphic** server-side embedding pipeline —
`embedding_jobs(target_type, target_id)` with an idempotent partial unique
index, an asyncio worker on the owner's OpenAI key, `Vector(1536)` columns,
no ANN index by deliberate choice at this corpus size. Adding
`target_type = 'story_scene'` is genuinely cheap.

But **world rules have no row identity.** They live inside the `world`
section's JSONB blob as `WorldRule` entries. RAG over rule text — the
specific thing the schema doc asks for — needs either a decomposition of
rules into rows or a client-side in-memory cosine, and the first is a
schema change to a section that step 2 just finished stabilizing.

Proposal: v1 selects context mechanically and completely deterministically —
the target scene, the `participants` character objects, the scene's fact
range from the append-only log, the preceding scene's `detailed_summary` for
continuity of voice, `user_voice`, `narrative.pov_default`/`tense_default`,
the resolved `rendering_hints.novel`, and world rules filtered by
`location_ref` and participant ids with the remainder included up to a token
cap.

**Cost:** distant callbacks are missed. A rule established in scene 3 that
matters in scene 47 gets in only if it is attached to a participant or place,
and a bible with more rules than the cap allows silently drops the tail — so
the cap is **logged and surfaced in the UI**, never silent. Embeddings become
Phase 8, once there is a calibration set (§9) to measure what the mechanical
selector actually misses. That ordering is deliberate: the schema doc's own
open decision 5 says build the benchmark early, and shipping RAG before we
can measure it means shipping a cost we cannot justify.

### 3.6 Orchestration stays in the **frontend on the user's key** (recommended)

Same reasoning as step-2 Decision 3, and now with a proven implementation to
copy rather than invent: per-unit server checkpoints, a heartbeat soft lock so
two devices cannot double-spend the key, abort/resume, and
`usageStore.recordGeneration` accounting. `story_renders.status` plays the
role `ingestion.status` plays today.

**Cost:** rendering only progresses while a tab is open. Unchanged from step
2, and the checkpoint contract stays adoptable by a later backend
orchestrator without a storage change.

### 3.7 Renders are **read-only output** in v1 (recommended)

The user can read, re-render a scene, and export. They cannot edit prose in
place and have it propagate to canon. Round-trip propagation is a
classifier (cosmetic / substantive / voice-shift / contradiction), a
propagation-proposal UI, a confirm step, and downstream re-render prompting —
a phase in its own right, and one that can corrupt canon if it lands
half-built.

**Cost:** the "authoring environment" framing waits. A user who wants to
tweak a sentence exports and edits outside the app, and their edit is lost on
re-render. Accepted for v1; this is the first candidate for step 3.5.

### 3.8 Reset and archive **must** cover renders (recommended)

`/story/reset` and `story_archives` were built when the bible was the only
story data. Renders are derived from a bible; a bible that gets reset or
restored leaves its renders pointing at scene ids that may no longer exist.

Proposal: `/story/reset` deletes render rows in the same transaction.
Archives **do not** snapshot prose — a render is regenerable and prose would
blow past any sane snapshot size — but a restore marks every existing render
`stale_bible`, surfaced in the UI as "the bible changed under this render."
The Phase 10 precedent applies to the delete ordering: write the survivor
before deleting the victim.

**Cost:** restoring an old bible does not bring back the prose that matched
it. Stated plainly in the restore confirm text, which already exists.

---

## 4. Phased delivery

Each phase is one PR, human-reviewed, independently deployable. Backend
phases serialize in migration order.

| Phase | Repo | What lands | Migration |
|---|---|---|---|
| 1 | backend | `story_renders` + `story_render_units` tables, sub-resource API, reset/archive integration (§3.8), `IngestPass` gains `annotate` (§3.3) | **0021** |
| 2 | frontend | Annotate pass — `src/utils/storyIngest/annotate.ts`, per-scene `function` + `transformations`, bible-wide `narrative.structure`; wired into `storyIngestStore` as a sixth pass with its own preflight estimate | — |
| 3 | frontend | Render engine — `src/utils/storyRender/` (context assembler, prose prompt, continuity checker), pure and network-free, injected `LlmCall` per the `storyIngest` precedent | — |
| 4 | frontend | `storyRenderStore` — run orchestration, per-unit checkpoint, soft lock, abort/resume, fuel gauge | — |
| 5 | frontend | Render tab UI — hints editor, scene-range picker, preflight, progress, reader, per-scene re-render | — |
| 6 | frontend | Export to Markdown with chapter breaks; continuity-flag review surface | — |
| 7 | frontend | Screenplay/Fountain renderer reusing Phases 1–6 unchanged — the format-independence test | — |
| 8 | both | Scene + rule embeddings, RAG-selective context, measured against the Phase 6 calibration set (§3.5) | 0022 |

Phases 3 and 4 are the `storyIngest` / `storyIngestStore` split repeated
exactly: pure engine, then store. That split is what made step 2's passes
unit-testable without a network, and it is why `reconcileJudge.ts` has 949
lines of tests against 1053 lines of implementation.

**The one hard ordering constraint:** Phase 1 must deploy before Phase 2
merges, because `extra="forbid"` rejects `current_pass: "annotate"` from a
newer client against an older server.

---

## 5. Test plan and definition of done

Per the process this project has settled on:

- **Every regression pin is mutation-tested.** Revert the fix, watch the test
  fail, restore. Two Phase 11 tests passed with their bug reverted; a pin
  never watched to fail is not a pin.
- **Two adversarial review passes** — one over the plan (this document), one
  over the implementation, each dimension's findings re-verified by
  independent skeptics before being trusted.
- **Live verification on production**, not just a green suite. Phase 11's
  jsdom harness exists now and covers `StoryTab`; the Render tab gets the
  same treatment, and the end-to-end click-through happens against a real
  provider key.
- **A calibration set** (schema doc open decision 5): 3–5 real transcripts
  with human-rated expected output, checked into the repo as fixtures, run
  against the renderer on every change. This is what makes Phase 8's RAG
  question answerable instead of a matter of taste, and it is why it lands in
  Phase 6 rather than after.

Done for step 3 means: a user can take a locked bible, annotate it, render a
scene range to novel prose, read it on a second device, re-render a scene
they did not like, export it as Markdown, and render the same bible as a
screenplay without any bible change.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Per-render spend is user-visible and larger than ingestion | Preflight estimate before any spend (the step-2 pattern), two calls per scene not six (§3.4), per-scene re-render so a bad run is not a full re-pay |
| Prose quality is subjective and unmeasurable | Calibration set in Phase 6, before the RAG phase that would otherwise be justified by vibes |
| A 60-scene render is a long-running tab-open operation | Per-unit checkpoints mean a closed tab loses at most one scene; resume is the ingestion resume, already proven |
| The context cap silently truncates world rules | Surfaced in the UI and logged, never silent (§3.5) — the "no silent caps" rule |
| Renders outlive the bible they were rendered from | `source_scene_ts` per unit, `stale_bible` on restore (§3.8) |
| Scope creep into round-trip editing | Explicitly cut (§3.7); renders are read-only until a phase is planned for it |

---

## 7. What this step deliberately does NOT do

- Round-trip edit propagation (§3.7).
- Embedding-based retrieval, until Phase 8 and until it can be measured
  (§3.5).
- Comic-script and storyboard renderers, and image generation for them.
- Re-walk-from-divergence — still deferred from step 2, still blocked on the
  same three questions.
- Backend-orchestrated rendering (§3.6).
- Any change to the bible schema's existing fields. Step 3 writes only the
  three field groups v1.1 reserved for it, and adds one enum value.
