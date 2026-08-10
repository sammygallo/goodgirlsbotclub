# Phase 8 — Reconcile: implementation plan

Status: **approved** — written 2026-08-09 (after Phase 7 merged via the
soak-gate routine on 2026-08-03); all four §3 decisions approved by Sammy
as recommended, same day. Successor step to the Phase 8 paragraph in
`story-state-step2-plan.md` §3; read `story-state-pickup.md` for the
standing hazards this plan repeatedly leans on. Built from a 5-reader /
3-designer review of the merged code on both repos' `main`, then an
adversarial 3-lens verification pass against the code (which is where the
`saveCheckpoint` token-usage finding in §4 comes from).

Scope in one sentence: turn the merged mechanical fact grouping
(`src/utils/storyIngest/reconcile.ts`, currently dead code) into a real
ingestion pass — an LLM judge over plausible-conflict fact groups plus a
card-vs-transcript check per card-backed character — that writes
`continuity.contradictions` and surfaces a count in the Story tab, so
Phase 10's review checkpoint has something to review.

---

## 1. What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Mechanical grouping | `src/utils/storyIngest/reconcile.ts` | Merged, tested. `groupFacts(facts, cast)` → `FactGroup[]` keyed by (entity, category); proper-noun capitalization rule; unattributed facts fall to `WORLD_ENTITY`; singleton groups dropped; deterministic order. Judge attaches on top; do not modify. |
| Contradiction types | `src/types/storyBible.ts` (~458–497) | Merged (#352 prep). `Contradiction`/`ContradictionResolution`/`ContinuitySection` mirror the backend Pydantic models exactly. |
| Backend contract | ggbc-backend `app/schemas/story.py`, `app/routers/story.py` | Live since 3a/3b. `continuity` is a registered writable section (`extra="forbid"`, 256 KiB stored-form cap, mandatory `base_ts`, 409-with-winner). `Contradiction.id/type/description` required, `description` min_length 1. No backend changes needed for this phase. |
| Pass machinery | `src/stores/storyIngestStore.ts` | `run()` orchestration, `countingLlm` (fuel gauge + abort injection), heartbeat soft lock (finally-only teardown), `saveCheckpoint` 409-adopt-retry, post-await guard pair. `IngestPass` union and `PASS_LABELS.reconcile` ("Checking for contradictions") already include reconcile — only `PHASE6_PASSES` and the orchestration are missing. |
| JSON recovery | `src/utils/llm/json.ts` | `firstJsonObject` (brace-matching, truncation-safe) + the walk's one-repair-round pattern. |
| Deterministic ids | `src/utils/storyBible/sourceRefs.ts` | `deterministicUuid(seed)` — UUID-shaped, stable; seeding discipline: intrinsic content, never response position. |
| Fact provenance | `transcriptWalk.ts` | Walk facts already carry `source: chatMessageSourceRef(...)` with MsgRef + excerpt snapshot — the lazily-fetched evidence Phase 10's ContradictionCard needs. Reconcile inlines zero quote bytes. |
| Card snapshots | `coldStart.ts` → `entities` section | Card-backed characters carry `source` and `provenance: [card_field refs]`, plus the card-derived text itself: `physical_description.summary` (card description, ≤4000 chars) and `personality.traits` (note: `background` is always `''` after cold start — don't use it). The card check reads the bible's own snapshot — no re-plumbing of raw card sources. |

## 2. The pass at a glance

After `user_voice` lands, `run()` continues:

1. Checkpoint `current_pass: 'reconcile'` (the honest signal that cold_start
   ids, every walk chunk, and user_voice are all durable).
2. Page the full fact log (`storyApi.listFacts` until exhausted), runtime-
   shape-checking every row; **exclude reconcile's own synthetic card facts**
   (`source.kind === 'card_field'`) from the loaded list before ANY use —
   both `groupFacts` and the card check's own `factEntities` collection
   (§6). Filtering only one consumer lets a re-run compare card facts
   against themselves.
3. `groupFacts(facts, cast)` → judge the multi-fact groups in packed batch
   calls (§5).
4. One card-vs-transcript call per eligible card-backed character (§6);
   conflicts lazily mint a card-claim fact row (an *append* — the append-only
   invariant is untouched).
5. Build `Contradiction[]` with deterministic ids, merge-write the
   `continuity` section (existing entries and their resolutions always win),
   byte-budgeted below the 256 KiB cap **before** the PUT.
6. On completion the store's in-memory `completed` gains `'reconcile'`
   (UI-only state — the wire checkpoint has **no** `completed` field, and
   adding one would 422 against `extra="forbid"`); notes + toast report the
   count and anything skipped.

Everything goes through `countingLlm`: fuel-gauge billing, live
`token_usage`, abort injection, and input-billed-on-failure are inherited,
not rebuilt.

## 3. Decisions — resolved 2026-08-09 (all four approved as recommended)

Four places this plan deviates from (or must interpret) the written spec.
Sammy approved every recommendation on 2026-08-09; the sections below
assume them. Kept in full as the record of what was decided and why.

1. **`contradicts` back-refs cannot land on existing facts.** The Phase 8
   spec says reconcile "emits … `contradicts` back-refs", but facts are
   append-only with *no update path as a server property* (locked Phase-4
   decision; the plan can't have both). **Recommend:** cross-references live
   in `continuity.contradictions[].sources` only; the sole `contradicts`
   population is on the newly *appended* card-claim facts (§6), which is an
   append, not a mutation. Phase 10's ContradictionCard is spec'd against the
   section, not `fact.contradicts`, so nothing downstream loses data.
2. **Mid-reconcile resume re-judges the whole pass** (no per-batch cursor).
   The alternative — persisting a reconcile cursor — needs either a new
   `IngestionSection` field (backend-first schema-minor deploy) or
   overloading `chunk_index`, and buys back only a handful of calls: the
   pass is bounded at roughly 2·(batches + eligible characters), typically
   4–12 calls, about one walk chunk's worth. Deterministic ids + the merge
   write make the re-judge produce zero duplicates. **Recommend:** whole-pass
   re-judge in v1; add a cursor only if soak shows large-cast pain.
3. **Card-vs-transcript check ships in Phase 8, tightly scoped** (§6). The
   minimal-scope review argued for cutting it (it needs synthetic fact rows
   to satisfy the ≥2-sources invariant and roughly doubles the pass), but it
   is the schema doc's stated motivation ("RPs frequently override their own
   card scenarios") and the spec names it. The lazily-minted card-fact design
   keeps it bounded: zero calls for transcript-introduced NPCs, zero appends
   unless a conflict is actually found.
4. **`PROMPT_VERSION` stays `'ingest-v2'`.** Reconcile adds prompts; it does
   not change walk/cold-start prompts. Bumping would strand every user's
   paused mid-walk checkpoint into a fresh paid build for zero benefit.
   Consequence to accept: a future reconcile-prompt change that warrants a
   bump also invalidates walk resumability (note this in `prompts.ts`).

## 4. Pass architecture in `run()`

### Placement and checkpoint

Reconcile starts only after `writeSection(projectId, 'user_voice', …)`
succeeds, mirroring the "chunk plan pinned only after cold_start landed"
discipline: `current_pass === 'reconcile'` is written exactly once upstream
work is durable. At the boundary:

- `set({ currentPass: 'reconcile', completed: [cold_start, wi_replay,
  transcript_walk] })`
- `saveCheckpoint({ ...checkpoint, current_pass: 'reconcile', token_usage:
  { input_tokens, output_tokens } /* the LIVE run() counters */, lock:
  refreshed })`

**The `token_usage` fold is load-bearing, and fixes an inherited bug.** The
run() closure's `checkpoint.token_usage` was last written at walk *entry*
(~line 562); the per-chunk saves (~line 1027) never update it, and
`countingLlm` only updates the in-store display copy. So today a mid-walk
pause already persists totals missing most of the walk's spend, and a
mid-reconcile pause would persist totals missing the *entire* walk. Fix it
at the single choke point: `saveCheckpoint` itself folds the live closure
counters into every write. That repairs the walk's chunk-boundary saves in
passing and makes "resume seeds running totals from the checkpoint" actually
true. Test 3 asserts the **persisted** totals, not the in-memory copy.

No new checkpoint fields (decision 2). `chunk_plan`/`chunk_index` are left
untouched — dead weight while reconciling, harmless, and still meaningful if
the checkpoint is ever inspected. The heartbeat needs no changes: its
primary teardown is run()'s `finally` (with the callback's own
ownership-loss self-clear as backstop), which already covers every new
exit.

A crash *between* the user_voice write and this checkpoint write leaves
`current_pass: 'transcript_walk'` fully advanced — the resume takes the
existing walk path, runs a zero-iteration chunk loop, reruns user_voice
(idempotent, one cheap call), and reaches reconcile fresh. Correct by
construction; test 9 pins it.

### Resume: a second predicate, checked with the first

`run()` gains, alongside `resumableWalk` (~line 296):

```ts
const resumableReconcile = existing !== null
  && existing.prompt_version === PROMPT_VERSION
  && existing.current_pass === 'reconcile';
// no status check — mirrors resumableWalk, so both 'paused' and 'error'
// reconcile checkpoints resume cheaply
```

When true: seed `completed` with all three prior passes, take the working
checkpoint over with a fresh lock, require `countingLlm` (else finish +
error, as the walk-resume path does), read the cast back from the
`entities` section using the existing validated read-back (missing section →
empty cast; transient error → rethrow *before any paid call*), and jump
straight to the reconcile body. **Never call `runTranscriptWalkPass` and
never rerun user_voice from this path.**

Two traps this dodges — both live bugs if reconcile ever writes
`current_pass: 'reconcile'` without this predicate:

- Unmodified code: `resumableWalk` goes false → the resume is classified a
  *fresh build* and re-pays cold_start plus the entire walk.
- The naive fix — widening only run()'s `resumableWalk` to accept
  `'reconcile'` — is *worse than it looks*: `runTranscriptWalkPass`'s own
  inner gate still requires `current_pass === 'transcript_walk'`, so it
  falls through to the **fresh-plan branch and silently re-walks (re-bills)
  the whole chat**. And widening both gates lands in
  `sliceChunksFromPlan`, where a user who *deleted a chunk-boundary
  message* (or the `last_ingested` message) after the walk completed trips
  `'diverged'` → "Use Reset story" — destroying a complete, fully-paid
  bible over a divergence that is irrelevant to reconcile, which reads the
  server-side fact log, not the chat. (Edits and interior deletions slip
  through silently — ids are permanent `ggbc_id`s and content isn't
  compared — so the trap is narrower than "any edit", but real.) The
  reconcile-resume path must not touch chat messages at all.

Abort/cancel/clear are unchanged: the judge receives `abort.signal` through
`countingLlm`; AbortError propagates to the existing catch → `status:
'paused'` with `current_pass: 'reconcile'` preserved → the next Build
resumes reconcile only. Failure classification: non-abort errors →
`status: 'error'`, same resume. **No reconcile failure mode can re-bill the
walk.**

### Trigger conditions

Reconcile runs iff the walk completed and `countingLlm` exists. The
no-LLM / `allCallsFailed` early-complete path exits before the walk and
therefore before reconcile — unchanged. If `groupFacts` yields zero groups
and no character is card-eligible, the pass makes **zero calls but still
creates the section if absent** (possibly `{contradictions: []}`) — section
presence in the manifest is what lets the UI and Phase 10 distinguish
"checked, clean" from "never checked". When the section already exists and
the merge adds/changes nothing, **skip the no-op PUT**: the backend bumps
`server_ts` on every PUT regardless, and gratuitous churn forces a
409+merge on the next write from any open Phase-10 tab.

## 5. Judge call design

New module `src/utils/storyIngest/reconcileJudge.ts` — pure helpers (batch
packing, prompt building, parsing/normalizing) injectable with an `LlmCall`,
unit-testable with zero network, mirroring the `transcriptWalk.ts` split.
Orchestration lives as a module-level helper in `storyIngestStore.ts` (it
needs the private `writeSection`/`saveCheckpoint` siblings), mirroring
`runTranscriptWalkPass`'s style. Prompts + repair instruction live in
`prompts.ts` under the existing `PROMPT_VERSION`.

### Batching (deterministic)

- Walk groups in `groupFacts` order (already deterministic); greedy first-fit
  packing into batches under ~4 000 estimated prompt tokens
  (`estimateTokens`), max 12 groups per call.
- Per-fact text clamped to ~300 chars in the prompt.
- A group larger than the budget (realistically only `WORLD_ENTITY` buckets)
  is windowed into consecutive slices of ≤ 40 facts; cross-window pairs go
  unjudged — counted and reported ("no silent caps"), not silently dropped.
- Facts get short per-call labels (`f1, f2, …`) — models mangle UUIDs; the
  label→id map is client-side and per-call. Labels are positional but
  nothing durable is ever seeded from them.

Call-count: with G groups packed into B batches and C eligible characters,
total calls ∈ [B + C, 2·(B + C)] (one repair round each, worst case).
Typical solo RP: 2–6 calls. Grouping itself is free.

### Prompt sketch (system)

> You audit a story bible for genuine contradictions — claims that cannot
> both be true of the same subject. Only flag mutually exclusive claims.
> Story progression is NOT a contradiction: a "change" fact superseding an
> earlier state is normal unless both are asserted as concurrently true.
> Groups labeled "(world / unattributed)" may mix facts about different
> subjects — never force a conflict between facts that could be about
> different people or things. If unsure, do not flag it. If nothing
> conflicts, return an empty list. Reply with exactly one JSON object, no
> prose.

User message: numbered groups (`Group 1 — subject: Ivy — category: reveal`),
facts as `f1: text [explicit]` lines with confidence markers. Expected
output:

```json
{"contradictions": [
  {"facts": ["f1", "f2"],
   "type": "character_attribute|world_rule|timeline|relationship|object_state",
   "description": "one sentence naming the conflict"}
]}
```

### Parsing, repair, tolerance

Walk doctrine throughout — every malformation fails toward *dropping the
entry*, never inventing:

- `firstJsonObject(raw)`; accept iff `parsed.contradictions` is an Array.
  One repair round (`[...messages, assistant: raw, user: REPAIR]`,
  maxTokens unchanged). Still bad → the batch contributes nothing,
  `unreadableBatches++`, the pass continues; a weak BYO model that never
  emits JSON still *completes* the run with "N contradiction checks could
  not be read" in the notes. AbortError always rethrows; transport errors
  rethrow (→ resumable `'error'`).
- Per entry: resolve labels through the batch's own map (unknown → drop);
  dedupe; **≥ 2 distinct fact ids or drop** (the `sources ≥ 2` invariant);
  citations must all belong to one group in the call (mechanical enforcement
  of the no-cross-group rule) or drop; `type` outside the 5-value enum →
  fallback by group (category `world_rule` → `'world_rule'`, else
  `'character_attribute'`); `description` clamped to 400 chars, empty →
  synthesized `"Conflicting <category> facts about <subject>"` (backend
  min_length 1).
- **Cross-batch dedupe by sorted source-id set** — a multi-entity fact sits
  in both entities' groups by design, so the same pair can surface twice;
  the deterministic id (§7) collapses them to one entry.

## 6. Card-vs-transcript check

Motivation is the schema doc's own: RPs override their card scenarios. Scoped
hard so big casts stay cheap:

**Eligibility** — a character gets a check only if **both**:
1. Card-backed: its `entities` entry carries a `card_field` provenance ref
   (what `coldStart.ts` stamps). Transcript-introduced NPCs: zero calls.
2. It has ≥ 1 transcript fact attributed via `factEntities` — including
   singleton facts (dropped by `groupFacts` for the group judge, but
   perfectly good card-contradiction material; collect them with a direct
   `factEntities` pass).

**One call per eligible character** (the spec's letter). Prompt: the
character's own bible snapshot as card text (`physical_description.summary`
+ top `personality.traits`, optionally the `card_field` provenance snapshot
excerpts — **not** `background`, which cold_start always leaves empty —
clamped ~1 500 chars; this is the text cold_start extracted *from the
card*, available identically on fresh and resume paths) + that character's
facts with local labels, collected from the **card-filtered** fact list
(§2.2). Output mirrors §5 plus a `card_claim` string (≤ 200 chars).

**The sources problem**: `Contradiction.sources` holds fact ids and the card
side has no fact row. When (and only when) a conflict is reported, append
one:

- `id = deterministicUuid('fact:card:' + characterId + ':' +
  sortedCitedFactIds.join(':'))` — seeded from the character and the *cited
  transcript fact ids*, **not** the model's claim wording, which varies
  across retries. Re-detection with different phrasing → same id →
  `appendFact` idempotently returns the stored row. Accepted edge: two
  genuinely distinct card claims conflicting with the same fact set collide
  into one card fact — fails toward fewer duplicates.
- Payload: `text: "Card: " + card_claim`, `category: 'introduction'`,
  `confidence: 'explicit'`, `established_in: null`, `source`: a
  `card_field` SourceRef with the claim as snapshot excerpt,
  `contradicts: [citedFactIds]` — the one legal home for back-refs
  (decision 1). Well under the 8 KiB fact cap.
- Append the card fact **before** the section write so `sources` never
  dangles even transiently. The contradiction then cites
  `[cardFactId, ...transcriptFactIds]`.

These synthetic facts are excluded from future grouping by the
`source.kind === 'card_field'` filter (§2.2) — a hard invariant, commented
at both the filter and the minting site: without it, a re-run's group judge
would re-litigate card facts against transcript facts and the batch plan
would shift under any future cursor.

## 7. The continuity write

### Payload (field-by-field against the Pydantic contract)

```json
{ "contradictions": [
  { "id": "<deterministicUuid>",
    "type": "character_attribute",
    "description": "<≤400 chars, never empty>",
    "sources": ["<fact-uuid>", "<fact-uuid>"],
    "detected_by": "agent",
    "resolution": { "status": "unresolved", "canonical_choice": null,
                    "rationale": "", "resolved_at": null } } ] }
```

No other keys anywhere (`extra="forbid"` recursively → 422). `resolution`
sent fully explicit (byte-equal to the server's materialized defaults).
`resolved_at` stays `null` — never a naive datetime. `sources` sorted (stable
bytes, stable seed).

### Deterministic id rule

```
id = deterministicUuid('contradiction:' + [...sources].sort().join(':'))
```

Seeded from the sorted participating fact ids — themselves content-seeded by
the walk and §6. Never from response position, group index, labels, or model
prose. Load-bearing consequences: a differently-shaped retry produces the
identical id set; the same pair from two entity groups dedupes to one entry;
a resume's whole-pass re-judge merges to zero duplicates; a Phase 10
resolution keyed by id survives an idempotent re-reconcile. `type` is
deliberately excluded from the seed so a model that re-labels the kind on
re-run doesn't orphan a resolution.

### Merge, not rebuild — `writeSection` must NOT be reused here

The continuity section is not a pass-owned full-rebuild section: Phase 10
writes user resolutions into it and users may add `detected_by: 'user'`
entries. The store's `writeSection` does a *blind* adopt-winner re-PUT on
409 — correct only for sections the pass rebuilds wholesale; here it would
revert a user's resolution written seconds earlier in another tab. New
helper `writeContinuityMerged(projectId, detected)`:

1. GET `continuity` (404 via `isMissingSection` → `{contradictions: []}`,
   baseTs 0; other errors rethrow — a network blip must not zero base_ts).
   Runtime shape-check the data; **a malformed existing section throws**
   (resumable error) rather than overwriting — silently replacing an
   unreadable section could destroy user resolutions. Fail loud.
2. Merge by id: existing ∪ detected, **existing wins on collision**
   (preserves resolutions on re-detection); entries not re-detected are
   **kept** (facts are append-only today, so an old contradiction between
   extant facts remains valid; judge nondeterminism must never silently
   un-surface one — schema principle 5). Two amendments to bare keep-all:
   - **Dangling-source prune:** a kept, agent-detected, *unresolved* entry
     whose sources are not all present in (loaded facts ∪ this run's
     appended card facts) is dropped — reconcile already holds the full
     fact log in memory, so this is one set-membership check, zero calls.
     Without it, Phase 10's fact hard-delete leaves immortal
     never-re-detectable entries pointing at 404 facts. Resolved and
     user-detected entries are never pruned (Phase 10 owns their cleanup —
     see §11).
   - **Drift dampener:** models trim citations nondeterministically, so
     run 1 can report {A,B,C} and run 2 {A,B} — different ids, near-
     duplicate entries accumulating across rebuilds. When a newly detected
     entry's source set is a strict subset/superset of an existing
     agent-detected *unresolved* entry's set, keep one (the resolved/user
     entry if either qualifies; else the superset).

   Spread the read `data` into the payload so a future additive backend
   field isn't wiped by the full-replace PUT (the Phase-5 `content_rating`
   lesson).
3. Byte-bound **before** the PUT (a 413 lands after the calls were paid and
   every retry fails identically): budget 200 KiB against the
   defaults-materialized form; hard cap ~200 contradictions; drop from the
   tail of the *newly detected* list in deterministic order, never dropping
   `detected_by: 'user'` or resolved entries; count drops into notes.
4. If the merge changed nothing and the section exists, return without
   PUTting (§4 trigger conditions). Otherwise PUT with the tracked ts. On
   `StoryConflictError`: shape-check the 409's `current` body (invalid →
   one fresh GET), **re-merge against the winner**, re-PUT once. Second
   409 → throw (resumable error; detections are recomputable, the winner's
   data is intact). This merge-aware retry is the difference from
   `writeSection` and what makes "user resolves a contradiction in another
   tab while reconcile writes" safe.

## 8. UI surfacing (minimal, honest — review UX is Phase 10)

- `PHASE6_PASSES` → append `'reconcile'` (rename to `INGEST_PASSES` while
  there); `IngestProgressCard` checklist row and progress denominator update
  automatically; the label already exists. Update the two hardcoded
  `completed` arrays (resume seeding; completion).
- `storyStore.load`'s `wanted` list gains `'continuity'` (manifest-gated, so
  no 404 noise on unreconciled bibles).
- StoryTab Contents grid gains a 4th tile — `Contradictions: N` (unresolved
  count from the section), warning-tinted when > 0 — plus a short read-only
  list under "Established facts": type badge + description, first ~20 with
  "and N more". No resolution controls, no evidence fetch. The persistent
  surface hangs off the **section**, not `checkpoint.error` — the
  checkpoint-notes pattern demonstrably vanishes once `status: 'complete'`
  (IngestProgressCard returns null). One honesty caveat: with a weak model,
  every batch can be unreadable and the pass still completes — a bare `0`
  tile would then read as "checked, clean". The completion notes ARE
  persisted in the `ingestion` section (already fetched by storyStore), so
  when they contain an unreadable-checks note, render it as a caption next
  to the tile ("N checks could not be read") to keep "clean" and
  "unjudgeable" distinguishable after the toast fades.
- Completion toast folds into the existing notes assembly: found > 0 →
  "Story built — N possible contradictions flagged" (warning flavor);
  unreadable batches / window splits / budget drops appended to the notes.
- `StartIngestModal` copy "Two model calls, plus a keyword pass that costs
  nothing" is already stale re: the walk; amend to mention the contradiction
  check sized to the story. Do **not** rework the single-number preflight
  estimate — reconcile's cost depends on walk output that doesn't exist at
  preflight; the live token readout is the honest instrument.

## 9. Test plan — and the definition of done

Every prior phase's adversarial review found a concurrency defect the green
suite missed; the concurrency tests below are part of the plan, not
follow-up.

### Unit — `reconcileJudge.test.ts`

- Packing: deterministic across two runs on identical input; budget + 12-
  group cap respected; oversized-group windowing deterministic, split count
  reported; card-fact filter excludes synthetic facts.
- Prompts: local labels only (assert no UUID in the user message);
  `(world / unattributed)` labeling; confidence markers present.
- Parsing fixtures: clean; prose-wrapped; truncated (→ repair); repair
  fails → batch counted unreadable, later batches unaffected; AbortError
  and transport errors rethrown.
- Tolerance: unknown label, < 2 distinct ids, cross-group citation, bad
  `type` fallback, empty description synthesis, clamps.
- **Id determinism (the Phase-7-lesson test):** two fixture responses with
  the same findings in different order/grouping/wording → byte-identical
  `Contradiction[]`; same pair from both of a multi-entity fact's groups →
  one entry; card-fact id stable across reworded `card_claim` retries.
- Merge: existing-wins preserves a `user_chose` resolution; non-redetected
  entries kept; byte bounding deterministic, never drops user/resolved
  entries; 200×400-char adversarial payload stays under budget.
- **Wire-contract:** golden compact-JSON fixture of an emitted section +
  card fact validated against the real `app/schemas/story.py` models in the
  disposable-Docker rig (reproduce, don't reason — `extra="forbid"` drift is
  invisible to tsc).

### Store-level — stateful fake backend driving the production `run()`

1. Happy path: reconcile after user_voice; section written; `completed`
   includes reconcile; card facts appended once.
2. **Resume-predicate regression:** checkpoint `{status:'paused',
   current_pass:'reconcile'}` → run() → assert **zero** cold_start prompts,
   zero walk chunks, zero scene writes, user_voice NOT re-synthesized;
   reconcile runs; no duplicate ids in the final section.
3. Interrupted mid-judge (LLM rejects on call k) → paused/'reconcile'
   checkpoint; resume → clean dedupe; **the persisted (server-side)
   checkpoint's `token_usage`** includes the walk's and reconcile's spend
   at every save point — this is the assertion that catches the stale-
   closure-totals bug §4 fixes; the in-memory copy passing is not enough.
   Also assert a mid-walk chunk-boundary save now persists live totals
   (the inherited half of the same fix).
4. Crash between card-fact append and section write → resume: appendFact
   returns the stored row (fake backend asserts one row), section correct.
5. **Concurrent-user-edit race:** fake backend bumps continuity (injects a
   user-resolved entry) between reconcile's GET and PUT → 409 path → final
   section holds the user's resolution AND the new detections; a second
   injected bump → run errors, winner's data untouched, no retry loop.
   Merge rules: dangling-source prune drops an unresolved agent entry
   citing a missing fact but never a resolved/user entry; subset/superset
   drift collapses to one entry; unchanged merge against an existing
   section → **no PUT issued** (fake backend asserts server_ts did not
   move).
6. Ownership loss mid-pass (`stillOurs` flips): bare false return, no
   set()/toast/PUT for the old project, heartbeat dead (fake timers, assert
   no further PUTs).
7. `cancel()` mid-judge: paused; input billed, output not; section either
   absent or fully merged — never partial garbage. `clear()` mid-reconcile:
   viewing state only, Stop still works.
8. Double-click `run()` in one tick → one run (extend the existing test
   through reconcile).
9. **Divergence non-trap:** a chunk-boundary message *deleted* after walk
   completion + reconcile resume → completes, **not** `'diverged'` (the
   delete fixture is the one that pins the trap — edits never trip
   `sliceChunksFromPlan` at all, since ids are permanent and content isn't
   compared); separately, a crash before the reconcile checkpoint write
   resumes via the walk path and reaches reconcile.
10. No-LLM / all-calls-failed paths unchanged (never reach reconcile);
    zero-group run writes the section with zero calls.

### Done means

`npm test` + `npx tsc -b` + `npm run build` green; wire-contract fixture
validated against the real Pydantic models; the multi-lens adversarial
review pass (concurrency + wire-contract lenses mandatory — it has caught
real defects in every phase, and this is its exact profile: async store
orchestration on a money path); one manual smoke against a real local stack
(build, kill the tab mid-reconcile, reopen, Build, watch the fuel gauge
resume from the prior subtotal, check the Contradictions tile). Revert
`node_modules/.vite/deps/_metadata.json` churn before committing.

## 10. Risks and non-goals

Risks, accepted with mitigations:

- **Judge over-reporting in `WORLD_ENTITY` buckets** (mixed subjects by
  design): prompt doctrine + "if unsure, don't" + Phase 10's human review as
  the backstop; contradictions are surfaced, never auto-resolved.
- **Cross-category conflicts are structurally invisible** (grouping is
  (entity, category)): inherited from the merged grouper; not this phase's
  to fix.
- Windowed mega-groups miss cross-window pairs; counted, reported.
- Weak models burn ≤ 2 calls/batch for nothing; bounded, reported, never
  blocking (locked decision: the warning stays informational).
- Estimated (not provider-measured) tokens can misprice the judge on
  expensive providers — standing risk, same as the walk; abort always works.
- **Stale deployed frontend:** during the deploy window (Chrome caches
  aggressively — see the standing memory), an old tab resuming a paused
  `'reconcile'` checkpoint classifies it as a fresh build and silently
  re-pays cold_start + the walk. Accepted: transient, non-destructive
  (every id is deterministic, so the re-run converges to identical rows),
  and there is no client-side mitigation. Documented so it isn't
  rediscovered as a bug report.
- **Residual citation drift:** the subset/superset dampener (§7) collapses
  the common drift shape; overlapping-but-incomparable sets ({A,B,C} vs
  {A,B,D}) can still coexist. Accepted — Phase 10's review is the human
  gate.
- Judge prompts embed model-authored fact text — a fact could try to steer
  the judge. Blast radius is bounded to bogus/omitted contradiction entries
  in a section the user reviews; no tool access, no writes beyond the
  section. Accepted.

Non-goals (locked or deferred — do not sneak in): annotate-style
beat/tension/mood scoring (step 3); resolution UX, `appendEdit` wiring, fact
hard-delete (Phase 10); incremental new-facts-only reconcile (Phase 11 — the
deterministic ids and merge write are already shaped for it); backend schema
or endpoint changes; tier gating; manifest contradiction counts; preflight
estimate rework.

## 11. What Phases 10 and 11 inherit

- Phase 10's ContradictionCard reads `continuity.contradictions`, fetches
  the competing fact rows by id, and lazily pulls quoted evidence from their
  MsgRef sources (checking swipe fingerprints) with snapshot excerpts as the
  backstop. Keep A / Keep B / Write my own / Defer map onto
  `resolution.status`; resolutions survive re-reconciles by id stability.
  Phase 10 must add the `appendEdit` client helper (list-only today).
  **Standing obligation for Phase 10's fact hard-delete:** deleting a fact
  must also resolve or remove every contradiction citing it — reconcile's
  dangling-source prune (§7) only covers *unresolved agent* entries on the
  next rebuild; resolved and user-detected entries are Phase 10's to clean
  up at delete time.
- Phase 11's incremental reconcile calls the same judge with a fact subset
  (post-watermark), and the merge write already handles "new detections into
  an existing section". No rework anticipated.

## 12. Files touched

- **New:** `src/utils/storyIngest/reconcileJudge.ts` + `reconcileJudge.test.ts`.
- `src/utils/storyIngest/prompts.ts` — judge system/user builders + repair
  instruction (no version bump).
- `src/stores/storyIngestStore.ts` — `resumableReconcile` predicate + branch,
  reconcile block after user_voice, `loadAllFacts` + `writeContinuityMerged`
  helpers, `saveCheckpoint` token-usage fold (§4), passes array, the
  completion `completed` set, notes.
- `src/stores/storyIngestStore.test.ts` — all §9 store-level tests,
  including extending the existing concurrent-run test.
- `src/components/works/IngestProgressCard.tsx` — only if the
  `PHASE6_PASSES` → `INGEST_PASSES` rename happens (it imports the constant
  by name); skipping the rename makes this file untouched.
- `src/stores/storyStore.ts` — `wanted` + `'continuity'`.
- `src/components/works/StoryTab.tsx` — tile + caption + read-only list.
- `src/components/works/StartIngestModal.tsx` — copy touch-up.
- `src/utils/storyIngest/reconcile.ts` — comment-only touch: fix the doc
  comment's ordering claim (implementation is first-appearance order, both
  deterministic).
- Untouched: `src/utils/llm/json.ts`, `sourceRefs.ts`, `src/api/client.ts`,
  all of ggbc-backend.
