# Phase 10 — Review checkpoint, provenance UX, lock canon, fact hard-delete: implementation plan

Status: **approved** — written 2026-08-10, after Phase 8 (Reconcile)
merged (goodgirlsbotclub #374); all four §3 decisions approved by Sammy
as recommended, same day.
Successor step to the Phase 10 paragraph in `story-state-step2-plan.md`
§3; read `story-state-pickup.md` for the standing hazards this plan
repeatedly leans on, and `story-state-phase8-plan.md` §11 for the two
obligations Phase 8 explicitly left on this phase's doorstep. Built from
a direct read of the merged code on both repos' `main` (backend
`app/routers/story.py` / `app/schemas/story.py` / `app/models/story.py`;
frontend `storyStore.ts`, `storyIngestStore.ts`, `StoryTab.tsx`,
`sourceRefs.ts`, `chatStore.renameChat`, `projectStore.ts`).

Scope in one sentence: turn the Story tab from a read-only report into
the review checkpoint — resolve contradictions (with quoted evidence),
review and hard-delete facts, edit and merge scenes, patch a weak voice
profile with pasted prose, surface and heal provenance drift, and Lock
canon behind the client-side referential check — plus the one backend
addition the phase needs: an owner-scoped fact delete that deliberately
breaks the append-only invariant, done as a tombstone so every
concurrency property the log relies on survives.

This is the largest remaining phase and it spans both repos. Backend
lands first (its PR is small and self-contained); the frontend PR
follows against the deployed contract, with wire-contract fixtures
binding the two.

---

## 1. What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Contradictions data | `continuity.contradictions` via Phase 8's reconcile | Merged. Deterministic ids seeded from sorted source fact ids; resolutions keyed by id survive re-reconciles. `Contradiction`/`ContradictionResolution` types mirror Pydantic exactly. |
| Merge-aware continuity writer | `storyIngestStore.ts` `writeContinuityMerged` (~1057) | Merged, but **reconcile-shaped**: merges *detections* into the section (existing wins). Phase 10's resolution writes are the opposite intent — patch one entry — so they get their own writer (§5), not a reuse. |
| Continuity shape check | `reconcileJudge.ts` `readContinuitySection` (exported) | Merged, reusable as-is. |
| Fact provenance | walk facts carry `source: chat_message` SourceRef with MsgRef + ≤500-char excerpt snapshot; card facts carry `card_field` refs | Merged. This is the evidence ContradictionCard fetches lazily. |
| Ref classification | `sourceRefs.ts` `resolveRefState` / `describeRef` / `hashText` | Merged. StoryTab already badges a dangling source chat; Phase 10 extends the surface, not the classifier. |
| Scene write paths | backend `PUT /scenes/{id}` (full replace, CAS in the WHERE), `DELETE /scenes/{id}` (base_ts-guarded), both advisory-locked after body validation | Live since Phase 4/9. **No backend scene changes needed.** Client has `getScene` but no single-scene put/delete helpers — those are new client code only. |
| Edit log | backend `POST /edits` (idempotent by client id, 16 KiB cap), `GET /edits`; client `listEdits` only | Live. **`appendEdit` client helper is missing** — Phase 8 §11 named it as Phase 10's to add. |
| Fact log | append-only rows, per-project dense `seq` cursor assigned as `max(seq)+1` under the project advisory lock; append idempotent via `(project_id, id)` existence check returning the stored row | Live. These two mechanics are exactly why the delete must be a tombstone (§4). |
| Archive | snapshot-before-destroy + restore, staleness-guarded by manifest counts (`_restore_conflict_if_stale`) | Live. Snapshots copy each row's `data` verbatim — which is why the tombstone must live *inside* `data` (§4). |
| Guard discipline | `storyStore.ts` `storeEpoch`/`stillOn` — every post-await `set()`, return value, and toast guarded | Merged. Every new store action in §5 inherits this pattern wholesale. |
| Voice profile | `user_voice` section with `sample_passages[]` (`SamplePassage.source: SourceRef \| null`), float `confidence` | Live. `storyStore.load`'s `wanted` list does **not** fetch it yet — Phase 10 adds it. |
| Rename plumbing | `chatStore.renameChat` (~3706): renames server-side, carries WI fired-state, updates its own pointers | Merged. Knows nothing about Works or bibles — the healing hook (§7) attaches here. |

## 2. The work at a glance

Backend (ggbc-backend, one PR, **no migration** under the recommended §3
decision 1):

1. `DELETE /projects/{pid}/story/facts/{fact_id}` — tombstones the row
   in place (§4).
2. `_load_manifest` and `_restore_conflict_if_stale` count only live
   facts, via one shared filter (§4).
3. Amend `test_logs_have_no_update_or_delete_route` — the invariant it
   pins is deliberately narrowed by this phase (facts gain exactly one
   mutation: live → tombstone; edits stay fully append-only).

Frontend (goodgirlsbotclub, one PR):

4. `storyApi` gains `appendEdit`, `deleteFact`, `putScene`,
   `deleteScene` (thin wrappers over existing endpoints).
5. `storyStore` gains the review actions (§5): `patchContinuity`,
   `deleteFact`, `patchScene`, `mergeSceneIntoPrevious`,
   `appendSamplePassage`, `relinkSourceChat`, `lockCanon`/`unlockCanon`,
   plus a `loadAllFactsById` review-mode fact index.
6. Review UI (§6): ContradictionCard with lazy evidence,
   low-confidence fact accordion with delete, editable scene titles +
   merge-with-previous, voice confidence meter with paste fallback,
   provenance badges + relink, Lock canon footer running the referential
   check.
7. `chatStore.renameChat` healing hook (§7).
8. Reconcile touch-ups tombstones force (§4.4): `loadAllFacts` excludes
   tombstoned rows from `existingIds`; a card-fact append that returns a
   tombstone suppresses that contradiction.

## 3. Decisions — resolved 2026-08-10 (all four approved as recommended)

Four places this plan must interpret or deviate from the written spec.
Sammy approved every recommendation on 2026-08-10; the sections below
assume them. Kept in full as the record of what was decided and why.

1. **Fact delete mechanism: tombstone-in-`data`, via a real `DELETE`
   verb (recommended) — not a physical row delete.** The step-2 plan
   left "a real DELETE, or a scrub-in-place PATCH" open. A physical
   delete has three defects the append-only design makes structural:
   (a) **seq reuse** — `seq` is allocated as `max(seq)+1`; deleting the
   highest-seq fact frees its value, the next append re-mints it, and
   any client holding `after_seq` of exactly that value silently never
   sees the new row — a forever-skipped fact, the exact cursor bug class
   Phase 4's review already killed once; (b) **resurrection** — append
   is idempotent by `(project_id, id)` existence; a paused walk resumed
   after the user deletes a fact re-appends it, silently undoing the
   delete; (c) **divergent race** — a delete racing a chunk append
   produces different final states depending on commit order.
   Tombstoning the row in place (keep `ord`/`id`/`seq`/`created_at`,
   replace `data` with `{"id": "<uuid>", "deleted_at": "<iso8601>"}`)
   fixes all three: the seq stays occupied, the idempotent re-append
   returns the tombstone (deletion survives retries *by the same
   mechanism that makes retries safe*), and both race orders converge.
   Putting the marker *inside* `data` (not a new column) means **no
   migration** and — decisive — archives round-trip deletion state for
   free, since snapshot/restore copy `data` verbatim; a `deleted_at`
   column would be silently dropped by the Phase 9 snapshot shape and a
   restore would un-delete facts. Live rows can never collide with the
   marker: `Fact` is `extra="forbid"`, so no appended fact has a
   `deleted_at` key — `data ? 'deleted_at'` is a clean discriminator.
   The verb stays `DELETE` (it is a delete, from the user's view: the
   text is gone from the live bible and from every list). Consequence to
   accept, stated in the UI copy: **archives taken before the delete
   still contain the fact text**, and restoring one restores the fact —
   consistent with what "restore a snapshot" means. This is a canon
   operation, not privacy erasure (the source chat itself still holds
   the underlying text regardless).
2. **Lock canon gate: every contradiction resolved-or-deferred;
   referential errors auto-fixed; everything else warns (recommended).**
   The spec says "unresolved contradictions may be deferred" — read as:
   locking requires each contradiction's status ∈ {user_chose,
   agent_resolved, deferred}, with a one-click "Defer the rest" in the
   footer so deferral is cheap. The referential check (§6.6) classifies
   findings as *errors* (a contradiction citing a missing/tombstoned
   fact, a `canonical_choice` pointing at one — both auto-fixable by the
   same mechanical cleanup rules as delete-time, §5.2) and *warnings*
   (dangling `fact.established_in` after a scene merge, dangling
   `supersedes`/`contradicts`, unknown scene participants, a dangling
   source-chat ref) which are listed in the confirm dialog but don't
   block. Locking sets `meta.canon_locked_at`; while locked, the Build
   button and every §5 mutating action are disabled behind an "Unlock"
   affordance (one confirm; clears the field; both lock and unlock
   append an edit row). Reset/change-source behave as today — they
   delete `meta` wholesale, which is unlock-by-destruction and honest.
3. **Scene edits and fact deletes are disabled while a build is running
   or resumable (recommended).** A checkpoint in status
   running/paused/error means walk state (chunk plan, open scene id,
   pending appends) references live rows; merging away the open scene or
   deleting a fact a chunk retry will re-cite invites exactly the races
   §4.3 defines outcomes for — legal, convergent, but pointlessly
   confusing. The review surface stays visible; mutating controls render
   disabled with "Finish or clear the build first". Contradiction
   *resolutions* stay enabled (reconcile's merge is already
   resolution-safe by design — existing-wins was built for this exact
   concurrency). Cheap, honest, and removes a whole class of
   support-debugging.
4. **"Change source chat" keeps the plain ConfirmDialog — the plan's
   typed-confirm is dropped (recommended).** The typed-confirm language
   predates open question 3's resolution: it was specced when a
   source-chat change was an *unrecoverable* discard. Phase 9 made it
   auto-snapshot + restore. A recoverable action behind typed friction
   trains users that the confirm is theater; the current dialog already
   states the discard and the snapshot. (If overruled this is a
   ~20-line change to the existing dialog, nothing downstream moves.)

## 4. Backend: the fact tombstone

### 4.1 Endpoint

`DELETE /projects/{project_id}/story/facts/{fact_id}` — **no request
body.** That is load-bearing twice over: the pickup doc's app-wide
"permission queries before body read" pool-pinning concern can't apply
to a bodiless request, and there is no body to mis-order against the
advisory lock (the Phase 9 blocker class). Flow:

1. `_require_permission(db, user, "project:manage")` +
   `_get_owned_project` (owner-scoped, per the resolved open question).
2. `await _lock_project(db, project_id)` — immediately before the
   write, nothing between. Serializes against restore's
   staleness-check-then-wipe, reset, and every log append, exactly like
   the other locked writes (`_restore_conflict_if_stale`'s docstring
   lists the write paths whose locks make its check meaningful — this
   endpoint joins that list, and its docstring says so).
3. One statement, CAS-free (facts have no version token; the tombstone
   is idempotent so none is needed):
   `UPDATE story_facts SET data = <tombstone> WHERE project_id = :pid
   AND id = :fid AND NOT (data ? 'deleted_at') RETURNING ord`.
   - Row updated → `204`.
   - No row updated: `SELECT` to distinguish → already tombstoned →
     `204` (idempotent — a double-click or retried request is not an
     error); never existed → `404`.
4. Tombstone payload built server-side:
   `{"id": str(fact_id), "deleted_at": <UTC now, iso8601>}`. The id is
   kept inside `data` so every consumer that reads ids from `data.id`
   (reconcile's `loadAllFacts` does) keeps working on tombstones.

No `seq` change, no `ord` change, `created_at` untouched. `LogEntryOut`
serializes tombstones exactly like any row — clients discriminate on
the `deleted_at` key.

### 4.2 Counts: one filter, used everywhere counts are compared

`fact_count` in `_load_manifest` and `_restore_conflict_if_stale`
switches to `WHERE ... AND NOT (data ? 'deleted_at')`, extracted into a
single shared helper so the two can never drift — the restore guard
compares its counts against a client-held manifest, and the two sides
must move together or every restore 409s (or worse, doesn't when it
should). Everything else deliberately does **not** filter:

- `GET /facts` returns tombstones. Reasons: cursor stability (a filter
  that hides rows mid-pagination makes `after_seq` gaps ambiguous),
  walk-retry fidelity (the resumed walk's bookkeeping must see the same
  rows the append idempotency sees), and honesty (clients decide how to
  render deletion, and the review UI wants to know a fact *was*
  deleted, not have it vanish inexplicably). The `scene_id` filter
  naturally excludes tombstones (no `established_in` key) — fine.
- Archive snapshot/restore: untouched, verbatim `data` — which is the
  point (§3.1).
- `_bible_is_empty`: untouched; a tombstone-only bible still has edit
  rows in practice, and an extra snapshot of a near-empty bible is
  harmless.

### 4.3 Race outcomes (the "defined outcome" the plan demanded)

All under the project advisory lock, so these are orderings, not
interleavings:

| Race | Order A | Order B | Converges to |
|---|---|---|---|
| delete vs re-append of the same id (paused-walk resume) | append finds live row, returns it; delete tombstones after | delete tombstones; append finds tombstone, returns it (stored-row-wins is existing behavior) | fact deleted — the user's adjudication survives the retry |
| delete vs append of a NEW fact whose `supersedes` names the deleted id | new fact lands, then target tombstoned | target tombstoned, then new fact lands | new fact live with a dangling `supersedes` — legal by contract (refs may dangle; server is shape-only), surfaced as a lock-canon warning |
| delete vs restore | delete first → restore's count guard sees a changed live count vs the client's manifest → 409 | restore first (wipe+recreate) → delete's target id may no longer exist → 404 to the deleting client | never a silent half-state; both sides report honestly |
| delete vs reconcile's section write | reconcile's merge cites the fact; §4.4's `existingIds` fix prunes it on the *next* run; delete-time cleanup (§5.2) fixes it *now* | cleanup runs; reconcile re-detects against remaining live facts only | no immortal entries citing deleted facts |

### 4.4 Reconcile touch-ups (frontend, but contract-driven)

Two places Phase 8's code assumes "a row in the log is a live fact":

- `loadAllFacts` (storyIngestStore ~1008) adds every row's id to
  `existingIds` even when the shape check drops it from `facts`.
  `liveFactIds = new Set(existingIds)` then feeds the dangling-source
  prune — so a tombstoned fact would read as live and an unresolved
  agent entry citing it would never prune. Fix: a row whose `data` has
  `deleted_at` contributes to **neither** `facts` nor `existingIds`.
- The card-check appends a card fact and cites whatever row comes back.
  If the user previously **deleted** that card fact, the idempotent
  append returns the tombstone — citing it would resurrect the exact
  claim the user adjudicated away. Fix: if the returned row's data has
  `deleted_at`, drop that card conflict entirely (count it in the
  pass notes as suppressed — "no silent caps" applies to suppression
  too). The user's delete is the resolution.

### 4.5 The invariant test

`test_logs_have_no_update_or_delete_route` asserts, against the OpenAPI
schema, that the log surface has no mutation route. That invariant is
**deliberately narrowed** by this phase (the step-2 plan flagged it as
"a genuine invariant break, not a small addition"). The test is amended
to pin the new, precise invariant: `/story/facts/{fact_id}` exposes
exactly `DELETE` (no PUT/PATCH), `/story/edits` still exposes no
mutation route at all, and the DELETE's only effect on a row is the
live → tombstone transition (asserted by fetching the page and checking
`seq`/`created_at`/`id` are untouched). Docstring updated to cite the
resolved open question 2.

## 5. Frontend store layer

All new actions live in `storyStore.ts` and inherit the full guard
discipline verbatim: capture `projectId` + `storeEpoch` at entry, guard
**every** post-await `set()`, the return value, and every toast with
`stillOn` — the pickup doc's standing lesson, twice burned. Everything
below also refuses to run while `meta.canon_locked_at` is set (except
`unlockCanon`) or while the build is active/resumable (§3.3, except
`patchContinuity`).

### 5.1 `patchContinuity(patchFn, editMeta)` — apply-intent-on-winner

The one continuity writer for every resolution-shaped change. NOT a
reuse of `writeContinuityMerged` — that helper's 409 semantics are
"merge my *detections* into the winner, existing entries win," which
would silently discard a resolution change on conflict. This one is
`projectStore.updateSelected`'s pattern on a section:

1. GET `continuity` (missing → nothing to patch, return false;
   malformed per `readContinuitySection` → fail loud, never overwrite).
2. `patched = patchFn(entries)` — a pure function over
   `Contradiction[]`; returns null to signal no-op (skip the PUT, no
   server_ts churn — reconcile's own no-op discipline).
3. PUT with the read `server_ts`, spreading the read `data` so unknown
   future fields survive the full replace (the content_rating lesson).
4. On `StoryConflictError`: re-run `patchFn` against the **winner's**
   entries, re-PUT once with the winner's ts. Second 409 → toast and
   return false (the user clicks again; their intent is not silently
   dropped *or* silently blind-overwritten).
5. On success: update `sections.continuity` in state (guarded), then
   `appendEdit` (§5.6) with `editMeta`.

Resolution actions are thin `patchFn`s over this:

- **Keep A / Keep B**: entry's `resolution = {status: 'user_chose',
  canonical_choice: <fact id>, rationale: <optional user text, ''
  default>, resolved_at: capturedAt()}`.
- **Defer** / **Defer the rest**: `status: 'deferred'`, choice null,
  `resolved_at` stamped.
- **Reopen** (undo a resolution — cheap to include, needed the first
  time someone fat-fingers Keep B): back to `unresolved`, fields
  cleared.
- **Write my own** (§6.2): appends the user fact FIRST (so the
  resolution never cites an id that doesn't exist yet — Phase 8's
  append-before-write discipline), then patches
  `{status: 'user_chose', canonical_choice: <new fact id>}`.

### 5.2 `deleteFact(factId)` — delete + mechanical cleanup + edit

1. Confirm dialog already happened (UI's job). `storyApi.deleteFact`.
   404 → treat as success (already gone — another tab).
2. `patchContinuity` with the **cleanup rules** — pure, deterministic,
   also reused by lock canon's auto-fix (§6.6):
   - remove `factId` from every entry's `sources`;
   - an entry left with < 2 sources is removed (the ≥2 invariant —
     Phase 8 §11's obligation: *resolved and user-detected entries
     included*, this is exactly the cleanup reconcile's prune refuses
     to do);
   - an entry still ≥ 2 sources whose `resolution.canonical_choice ===
     factId` reopens: `status: 'unresolved'`, choice null, rationale
     prefixed `'(canonical fact was deleted) '` — the user's pick no
     longer exists, pretending it's still resolved would be a lie.
   Entry ids are **kept stable** even though sources shrank — ids are
   the resolution key; reconcile's subset/superset dampener already
   handles a re-detection landing near them.
3. Update local state: the fact stays in `facts` (marked deleted for
   the accordion's strikethrough render) — the list mirrors the wire.
4. `appendEdit`: target `{type: 'fact', id}`, classification
   `'substantive'`, diff `deleted: "<text ≤200 chars>"`.
5. Scene `continuity_facts_established` refs are **not** healed here —
   a scene PUT per delete would race the walk for zero reader benefit
   (nothing consumes that index until the step-3 renderer); the lock
   canon check strips them lazily (§6.6). `fact.established_in` on
   OTHER facts is untouched by construction (facts are rows, not refs
   to each other except supersedes/contradicts, which dangle-by-design
   and warn at lock).

If step 2 fails after step 1 succeeded, the fact is deleted and the
section briefly over-cites: toast it plainly ("Fact deleted — some
contradiction references couldn't be cleaned; Lock canon will fix
them"), because both the lock-canon auto-fix and reconcile's next-run
prune (§4.4) are downstream nets. Never pretend the delete failed — it
didn't.

### 5.3 `patchScene(sceneId, patchFn, editMeta)` and `mergeSceneIntoPrevious(sceneId)`

`patchScene`: GET the full scene (summaries lack `data`), apply a pure
`patchFn` to `data`, PUT full-replace with the fetched `server_ts`;
on 409, one re-fetch + re-apply + re-PUT; second 409 → toast + false.
Update the summary row in `scenes` in place (guarded). Then
`appendEdit`. Title editing is
`patchScene(id, d => ({...d, title}), {classification: 'cosmetic', ...})`.

`mergeSceneIntoPrevious(sceneId)` — B into its predecessor A in the
loaded, (sequence, id)-ordered list:

1. GET both full rows.
2. Build merged A: title/setting/pov/`annotations.user_notes` keep A's;
   `summary`/`detailed_summary` concatenated with `' '` (clamped —
   64 KiB scene cap, checked client-side before the PUT: over budget →
   abort with a toast, a 413 after a partial merge is the unrecoverable
   shape the pickup doc warns about); `source.message_range` spans
   A.start–B.end; `total_messages` summed; `swipe_resolutions` /
   `excluded_segments` concatenated; `participants` /
   `continuity_facts_established` set-unioned;
   `annotations.flagged_issues` concatenated.
3. **PUT A first, then DELETE B** (both base_ts'd). This order fails
   safe: PUT-then-crash duplicates content (retryable, visible);
   delete-first-then-crash would destroy B's content with no archive
   (scene ops don't snapshot). Any 409 aborts the whole merge with a
   reload — no blind retry of a compound op.
4. B's deletion leaves a sequence gap (harmless — ordering only) and
   dangles `established_in` on B's facts **permanently** (facts are
   append-only; there is nothing to heal them with). That is the §3.2
   warning class, accepted by design and documented in the check's copy:
   the scene→fact index (`continuity_facts_established`) is healed by
   the union; only the fact→scene back-pointer dangles.
5. `appendEdit`: target `{type: 'scene', id: A}`, `'substantive'`,
   diff naming B's id + title.

### 5.4 `appendSamplePassage(text)`

Spread the current `user_voice` data, push
`{text: <trimmed, clamped 4000 chars>, source: userAnnotationSourceRef()}`
(new tiny helper in `sourceRefs.ts` — kind `user_annotation`, the
provenance terminator), PUT with read ts, one adopt-winner retry
(re-push onto the winner — additive, so adopt-and-reapply is safe
here). Does **not** touch `confidence` — that field is the model's
self-assessment (D6); fabricating a bump would defeat its purpose. The
meter renders pasted samples separately (§6.4). Cap: max 10
user-annotation passages; over → oldest user-annotation passage drops
(never a walk-captured one), noted in the toast. `appendEdit`: target
`{type: 'voice'}`, `'voice_shift'`.

### 5.5 `relinkSourceChat(chat)`, `lockCanon()`, `unlockCanon()`

`relinkSourceChat`: rewrite `meta.source.chat.ref` to the picked
`ProjectChatRef`, **keeping `snapshot` and `captured_at` verbatim**
(the plan's words: relink keeps snapshot — the snapshot records what
was true at capture; only the pointer moves). Same
read-spread-PUT-adopt-retry shape as `designateSourceChat`, but
narrower: it must NOT rebuild `source.characters`, NOT zero the
watermark, NOT touch title — relink asserts "same chat, new identity",
and resetting the watermark would make Phase 11 re-walk from zero.
`appendEdit`: target `{type: 'meta'}`, `'cosmetic'`, diff
`source chat relinked: <old> → <new>`.

`lockCanon`: run the referential check (§6.6); if errors remain
unfixed or any contradiction is `unresolved`, refuse (the footer UI
prevents reaching here, this is the belt). Patch `meta.canon_locked_at
= capturedAt()` via read-spread-PUT-adopt-retry. `unlockCanon`: null it
back. Both append edits (target meta, `'substantive'`).

### 5.6 `appendEdit` — the client helper (at last) and its discipline

`storyApi.appendEdit(projectId, edit)` → `POST /edits`. The `Edit`
payload is built by one store-level `recordEdit(meta)` helper so the
field mapping lives in exactly one place: `id: bibleUuid()` **captured
before the POST** so a transport retry re-sends the same id and the
server's idempotency absorbs it (edits are genuinely-new events —
random id is correct, per the sourceRefs doctrine; determinism is for
things a rerun re-derives); `occurred_at: capturedAt()`; `actor:
'user'`; `surface: 'bible_direct'`; `target`/`classification`/`diff`
from the call site, diff clamped ≤ 2000 chars (16 KiB row cap with
headroom, no partial-word cut). Mapping table (the classification enum
is closed — every action maps into it, nothing new invented):

| Action | target | classification |
|---|---|---|
| resolution (keep/defer/reopen/write-own) | contradiction | contradiction |
| fact delete | fact | substantive |
| scene title | scene | cosmetic |
| scene merge | scene (survivor) | substantive |
| sample passage | voice | voice_shift |
| relink | meta | cosmetic |
| lock / unlock | meta | substantive |

Edit appends are **best-effort trailing writes**: the primary mutation
already landed; an edit-append failure toasts once and never rolls
anything back or blocks the UI. `propagated_to_bible: true` on all of
these (they ARE bible-direct changes); `propagation_notes: ''`.

### 5.7 Review-mode fact index

ContradictionCard needs arbitrary facts by id; the paged `facts` list
can't answer that, and there is deliberately **no new backend read
endpoint** — reconcile already pages the whole log client-side, review
does the same. `loadAllFactsById()`: page `listFacts` to exhaustion
(500/page, the server max), build `Map<id, StoryLogEntry>`, cached in
store state per visit, invalidated by the epoch bump and by
`deleteFact` (which patches the map in place). Loaded lazily the first
time a card expands or the accordion opens, not on tab mount.

## 6. Review UI

All new components in `src/components/works/`, composed into
`StoryTab.tsx`'s existing sections; `storyStore.load`'s `wanted` list
gains `'user_voice'` (manifest-gated like the rest). `canManage` gates
every mutating control, same as today.

### 6.1 ContradictionCard (replaces the Phase 8 read-only list)

Collapsed: type badge + description + status chip (unresolved warning /
resolved green / deferred neutral). Expanded (lazy — this is where
evidence loads):

- Each source fact rendered from the §5.7 index: text, confidence,
  category; a tombstoned/missing source renders as "(deleted fact)" —
  visible, not hidden, because a dangling citation is reviewable
  information.
- **Quoted evidence** per fact, resolved lazily and cached per visit:
  - `card_field` sources (Phase 8's synthetic card facts): snapshot
    excerpt only, labeled "from the character card". No chat fetch.
  - `chat_message` sources: fetch the source chat's messages once per
    visit (`api.getChatMessages` — one fetch shared across all cards
    via a store-level cache, keyed by the chat ref), find the message
    by `extra.ggbc_id === msg_id`; hash the referenced swipe's current
    text with `hashText` and compare against
    `fingerprint.sha`/`hash_alg`. Match → quote the live text (clamped
    ~300 chars) with a `live` badge. Message present but hash differs
    (or the swipe index no longer exists, or hash_alg differs —
    **never compare across algorithms**) → snapshot excerpt with a
    `drifted` badge ("the message changed since ingestion"). Message
    absent, chat missing, or fetch fails → snapshot excerpt with
    `dangling` ("as captured during ingestion"). The snapshot is always
    a sufficient fallback — evidence display must never hard-depend on
    a fetch (the bible is self-sufficient by design).
- Actions row: **Keep this** on each fact (→ §5.1 Keep), **Write my
  own** (§6.2), **Defer**, and on resolved entries **Reopen**. Each
  fact also carries a small **Delete fact** action (→ §5.2 flow, same
  confirm as the accordion's — the plan's "surfaced next to the
  existing Keep/Defer actions"). Rationale: an optional one-line input
  folded into Keep/Write-own, stored in `resolution.rationale`.

### 6.2 Write my own

Modal: one textarea ("What's actually true?"). Submit appends a fact:
`id: bibleUuid()` captured pre-POST (retry-safe); `text` = the user's
text (trimmed, 8 KiB row cap pre-checked); `category`: `world_rule`
when the contradiction's type is `world_rule`, else `change` (the user
is overriding recorded state); `confidence: 'explicit'` (the user said
so — that is what explicit means); `source: userAnnotationSourceRef()`;
`contradicts`: the entry's source fact ids (the one legal home for
back-refs — an append, not a mutation, per Phase 8 decision 1);
`supersedes: null` (scalar can't hold two losers; `contradicts` carries
the set). Then the §5.1 resolution patch citing the new id.

### 6.3 Fact accordion

Reworks the flat "Established facts" section into confidence groups:
**contested** (open by default when non-empty), **inferred** (open when
contested is empty), **explicit** (collapsed). Within each: text,
category chip, scene link (title looked up from loaded scenes when the
id resolves — otherwise nothing; no fetch), and **Delete** behind a
per-fact ConfirmDialog whose copy states the two §3.1 consequences
("removed from the story everywhere; snapshots taken before now still
contain it"). Deleted facts render struck-through with `deleted` label
until the next reload drops… nothing — they stay, struck through, as
the honest record (they're on the wire regardless; hiding them makes
"where did my fact go" a support question). Pagination unchanged
(`loadMoreFacts`); the accordion groups whatever is loaded and says so
("showing the first N — load more").

### 6.4 Voice confidence meter

Renders when `user_voice` exists: a meter for `confidence` (0–1) with
the register label, plus a count of sample passages split by origin
(walk-captured vs user-added, discriminated by `source.kind ===
'user_annotation'`). Below 0.5 (one exported constant), the schema
doc's own copy appears — "we don't have a strong read on your voice —
paste a paragraph or two you've written elsewhere" — with a textarea
driving `appendSamplePassage`. Always-available smaller affordance when
≥ 0.5 ("Add a writing sample"). No model calls, ever, from this
surface.

### 6.5 Provenance badges + relink

- Source chat row: the existing dangling banner gains a **Relink**
  button (dangling only — a live ref has nothing to relink; drifted
  isn't possible for chat refs, which have no name snapshot to drift).
  Opens the existing SourceChatPickerModal in relink mode: picking a
  chat calls `relinkSourceChat`, does NOT discard, and the modal copy
  draws the line sharply — "Relink points the story at the same
  roleplay under a new name. If this is a *different* roleplay, use
  Change instead — that starts the story over." A wrong relink is
  non-destructive and self-surfacing (every evidence fingerprint goes
  drifted/dangling), but the copy exists so nobody gets there.
- `meta.source.characters` chips with `resolveRefState` badges
  (live/drifted/dangling) — display only in v1; character relink has no
  consumer pain yet and is out of scope (§10).
- Evidence badges are §6.1's.

### 6.6 Lock canon footer

Sticky footer section (visible whenever a bible with ≥1 section beyond
meta exists): unresolved-contradiction count, **Defer the rest**, and
**Lock canon** (or the locked state: "Canon locked <date>" + Unlock).
Pressing Lock runs `checkCanon(state) → {errors, warnings}` — a pure
function in a new `src/utils/storyBible/canonCheck.ts`, unit-tested
against fixtures, operating ONLY on already-loaded state (sections +
full fact index §5.7 + loaded scenes; it pages scenes to exhaustion
first via the existing cursor — scene counts are small):

- **Errors** (auto-fixable, offered as one "Fix and lock" action):
  contradiction sources citing missing/tombstoned facts and
  `canonical_choice` pointing at one — fixed by the §5.2 cleanup rules
  via `patchContinuity`; scene `continuity_facts_established` /
  `participants` / `pov_character` citing missing facts / unknown
  character ids — fixed by stripping via `patchScene` per affected
  scene (this is the lazy heal §5.2 deferred).
- **Warnings** (listed in the confirm, never block): dangling
  `fact.established_in` (the §5.3 merge consequence), dangling
  `supersedes`/`contradicts`, a dangling source-chat ref, `acts` /
  `chapter_breaks` / `chapter_titles` / `pov_character` refs in
  narrative/rendering_hints citing unknown scenes (sparse-by-design
  sections — checked cheaply since they're small; both need adding to
  a lazy `loadSection` call at check time, not to `load`'s hot path).

This check is **the only referential validation in the whole system**
(Decision 4 — the server is shape-only, deliberately), which is why it
lives in a pure, fixture-tested module and not inline JSX. The confirm
dialog lists counts per finding class; confirming applies fixes (each
appending its edit row via the §5 actions) and then `lockCanon()`.
While locked: Build, scene edits, fact deletes, resolutions, paste,
relink all disabled ("Canon is locked — unlock to edit"). Reset and
Change stay enabled (§3.2).

## 7. The renameChat healing hook

`chatStore.renameChat` gains a best-effort trailing block after
`fetchChatFiles` succeeds, behind **lazy imports only** (`await
import('./projectStore')`, `await import('../api/client')` pattern —
the TDZ hazard is standing doctrine; chatStore is already inside the
fragile cycle, and projectStore's own `openChatRef` shows the shape):

1. Compute `old = {character_avatar, file_name: originalFile}`,
   `renamed = {character_avatar, file_name: sanitized}` (the
   server-sanitized name, not the user's raw input — that distinction
   already bit the rename flow once).
2. `projectsApi.list()` (or the store's cached rows if fresh) → every
   project whose `chats` contains `old`. For each: patch the ref via
   `projectsApi.update(id, {chats: patched, base_ts: row.server_ts})`,
   one adopt-retry on `ProjectConflictError` re-deriving from the
   winner (`updateSelected`'s exact shape, but per-row — a rename can
   hit projects that are not selected, so `updateSelected` alone cannot
   carry this). If the selected project was patched, refresh it.
3. For each affected project, heal the bible: GET
   `story/sections/meta`; 404 → no bible, skip; if
   `meta.source.chat.ref` equals `old`, rewrite the ref **keeping the
   snapshot** (same rule as relink, §5.5) via read-spread-PUT with one
   adopt-retry, and append the edit row (target meta, `'cosmetic'`,
   `source chat renamed: <old> → <new>`, actor `'user'` — the user
   initiated the rename).
4. Failure tolerance: the rename itself already succeeded and must
   never be reported as failed by this block. Any heal failure →
   single toast "Chat renamed — a Work still points at the old name;
   use Relink in its Story tab", console.warn the specifics, continue
   with remaining projects. Success is silent (invisible correctness).
   The manual Relink action (§6.5) is the guaranteed recovery path
   for anything this best-effort pass misses.

`chatStore.deleteChat` gets **no** hook: a deleted chat is a genuinely
dangling ref, the badge says so, and the bible's snapshots are the
designed answer (self-sufficiency). Nothing to heal toward.

## 8. What this phase deliberately does NOT do

Locked or deferred — do not sneak in: no fact text *editing* (append-
only; Write-my-own is the mechanism); no contradiction creation UI
(`detected_by: 'user'` entries are schema-legal but have no v1 flow);
no character/persona/lorebook relink; no scene splitting or reordering
(merge only); no `user_voice` re-synthesis call; no server-side
referential checks; no tier gating (resolved question 1); no archive
scrubbing on fact delete (§3.1's accepted consequence); no
`annotations.stale_source` UI (Phase 11's); no renderer consumption of
`canon_locked_at` (step 3); no preflight-estimate rework; no backend
GET-fact-by-id (§5.7); no edit-log *viewer* (rows are written faithfully
now precisely so a later phase can render them — the manifest's edit
count already shows they exist).

## 9. Test plan — and the definition of done

Every prior phase's adversarial review found a concurrency defect the
green suite missed; the concurrency tests below are part of the plan,
not follow-up.

### Backend (`tests/test_story_fact_delete.py` + amendments)

- Tombstone shape: 204; row keeps `ord`/`seq`/`created_at`/`id`; `data`
  is exactly `{id, deleted_at}`; `deleted_at` is aware-UTC iso.
- Idempotency: second DELETE → 204, `deleted_at` unchanged (first
  timestamp wins); unknown id → 404; other owner's project → 404 (the
  existing `_get_owned_project` contract); permission matrix matches
  the other write endpoints.
- Re-append after delete returns the tombstone with 200 (the stored-
  row-wins branch), and its `data` is the tombstone, not the payload.
- **Concurrency (asyncio.gather over the real transport, per standing
  discipline):** delete vs append-with-supersedes both orders → §4.3's
  table holds; delete vs delete; delete vs restore → 409-or-404, never
  a resurrected row; delete vs reset.
- Counts: manifest `fact_count` excludes tombstones; scene_id-filtered
  list excludes them; unfiltered list includes them; restore's
  staleness guard passes with a manifest fetched after a delete and
  409s with one fetched before (the shared-filter consistency test).
- Archive round-trip: snapshot with tombstones → restore → tombstones
  intact; restore of a pre-delete snapshot resurrects the fact
  (documented-correct, pinned so it's deliberate).
- The amended OpenAPI invariant test (§4.5).

### Frontend — unit (`canonCheck.test.ts`, `storyStore.test.ts` additions, `sourceRefs.test.ts` addition)

- Cleanup rules: every §5.2 branch (sources shrink, <2 removal
  including resolved/user entries, canonical_choice reopen with
  rationale prefix, id stability).
- `checkCanon` fixtures: each error/warning class fires exactly when
  its fixture says; auto-fix output is idempotent (fix → recheck →
  clean); a fully-clean bible returns empty both.
- Evidence resolution: fingerprint match → live; hash mismatch /
  missing swipe / cross-algorithm → drifted with snapshot; absent
  message/chat/fetch-reject → dangling with snapshot; card_field never
  fetches.
- `userAnnotationSourceRef` shape; edit-row builder field mapping +
  clamps (golden fixtures).
- Reconcile touch-ups: tombstones excluded from `existingIds`;
  tombstone-returning card append suppresses the contradiction and
  counts it.

### Frontend — store-level (stateful fake backend, production actions)

1. `patchContinuity` 409: user resolves in tab A while tab B resolves a
   different entry → both survive (apply-intent-on-winner); second 409
   → false, winner intact, no blind overwrite.
2. `deleteFact` full flow incl. cleanup-failure path (delete succeeded,
   patch rejected → honest toast, fact locally marked).
3. Merge: PUT-A-then-DELETE-B ordering asserted; DELETE-B failure
   leaves duplicated-but-visible state; 409 on either aborts with
   reload; byte-budget refusal before any write.
4. Every new action × the stale-visit matrix: switch-Work mid-flight
   and leave-and-return (epoch) — no `set()`, no toast, `false` return,
   for EACH action (the twice-burned lesson gets its regression grid).
5. Locked-canon and build-active gating: each §5 action refuses; 
   `unlockCanon` works while locked; resolutions still allowed during a
   resumable build (§3.3's carve-out).
6. renameChat healing: multi-project patch (selected + unselected),
   bible healed with snapshot kept verbatim + watermark untouched,
   conflict adopt-retry, per-project failure isolation (one project
   failing doesn't stop the next; single toast), rename itself never
   reported failed.
7. `relinkSourceChat`: snapshot/captured_at byte-identical before and
   after; characters and watermark untouched (the not-designate test).
8. Sample passage: cap eviction order (user-annotation only), clamp,
   confidence untouched, adopt-retry re-pushes onto winner exactly
   once.

### Wire-contract (the reproduce-don't-reason rig)

Golden compact-JSON fixtures validated against the real Pydantic models
in the disposable-Docker rig: a resolved contradiction entry
(user_chose, rationale, aware resolved_at), the §6.2 user fact, each §5.6
edit-row variant, the user_voice section with an appended
user-annotation passage, meta after relink and after lock
(`extra="forbid"` drift is invisible to tsc — this rig has caught real
422s in three phases).

### Done means

Backend: pytest green in the disposable-Docker rig (re-run once on the
known `host.docker.internal` flake before believing a failure).
Frontend: `npm test` + `npx tsc -b` + `npm run build` green. The
multi-lens adversarial review pass on BOTH PRs before merge —
concurrency + wire-contract lenses mandatory, plus a second independent
pre-merge pass (both passes have paid for themselves every single
phase). One manual smoke against the real local stack: build a bible,
resolve a contradiction each way (incl. write-my-own), delete a fact
cited by a resolved contradiction, merge two scenes, paste a voice
sample, rename the source chat from the chat panel and watch the badge
stay live, relink after a manual rename with the healing hook
stubbed off, defer-the-rest → Lock → verify Build disables → Unlock.
Revert `node_modules/.vite/deps/_metadata.json` churn before every
commit.

## 10. Risks

- **The delete's blast radius is the whole review surface** — it
  touches counts, cursors, reconcile, archives, and the restore guard.
  Mitigated by the tombstone design doing nothing to `seq`/`ord`, by
  the shared count filter, and by the §9 concurrency grid; this is the
  PR the adversarial review should hit hardest.
- **Two-step operations (delete+cleanup, merge PUT+DELETE, heal
  fan-out) have visible intermediate states.** Each is ordered to fail
  safe, each failure mode has a named net (lock-canon auto-fix,
  reconcile prune, manual relink), and none is silent. Accepted over
  inventing client-side transactions the backend deliberately doesn't
  offer.
- **`getChatMessages` for evidence is a whole-chat fetch.** One shared
  fetch per visit, lazy, cached, snapshot fallback on failure. If soak
  shows pain on huge chats, a ranged read is a backend follow-up —
  not speculatively built now.
- **The healing hook writes to N projects from a chat-panel action.**
  Bounded by how many Works reference one chat file (realistically ≤2),
  best-effort, isolated per project, and the manual path covers every
  miss. The alternative — silent permanent dangling on every rename —
  is the thing Decision 4 was written to kill.
- **Stale deployed frontend during the deploy window**: an old tab
  won't know facts can be tombstones; its fact list renders entries
  with no text (blank rows, ugly but harmless — `loadAllFacts`-style
  consumers drop them) and its reconcile treats them per pre-§4.4
  semantics for one build. Transient, non-destructive, documented so
  it isn't rediscovered as a bug.

## 11. What Phase 11 and step 3 inherit

- Phase 11 (incremental re-ingestion): the untouched-by-relink
  watermark is what its new-messages-only walk keys from; tombstoned
  facts flow through its reconcile subset naturally (§4.4's filter);
  `annotations.stale_source` still has no writer — Phase 11 is it.
- Step 3 (renderer): `canon_locked_at` is now real and gated by the
  referential check, `continuity_facts_established` is guaranteed
  clean-at-lock (§6.6 errors), the edit log now actually accumulates
  rows worth rendering a history from, and `sample_passages`
  distinguishes captured vs user-supplied voice — all four were built
  here for that consumer.

## 12. Files touched

**ggbc-backend (PR 1):**
- `app/routers/story.py` — `delete_fact` endpoint, shared live-fact
  count helper used by `_load_manifest` + `_restore_conflict_if_stale`,
  docstring addition to the restore guard's lock list.
- `tests/test_story_fact_delete.py` (new), `tests/test_story_logs.py`
  (invariant amendment), `tests/test_story_archives.py` (tombstone
  round-trip + guard consistency).
- No migrations. No schema-module changes (`Fact` stays `extra="forbid"`
  — the tombstone is server-minted, never client-validated).

**goodgirlsbotclub (PR 2):**
- **New:** `src/utils/storyBible/canonCheck.ts` + `.test.ts`;
  `src/components/works/ContradictionCard.tsx`, `FactReviewList.tsx`,
  `VoiceConfidenceCard.tsx`, `LockCanonFooter.tsx`.
- `src/api/client.ts` — `appendEdit`, `deleteFact`, `putScene`,
  `deleteScene` wrappers (all against existing endpoints).
- `src/stores/storyStore.ts` — §5 actions, fact index, `wanted` +
  `'user_voice'`, deleted-fact local marking.
- `src/stores/storyIngestStore.ts` — §4.4 touch-ups only.
- `src/utils/storyBible/sourceRefs.ts` — `userAnnotationSourceRef`.
- `src/components/works/StoryTab.tsx` — compose the new components;
  relink mode on the picker; gating.
- `src/stores/chatStore.ts` — the §7 hook (lazy imports only).
- `src/types/storyBible.ts` — no type changes expected (tombstones are
  a runtime shape, discriminated structurally).
- Untouched: `reconcile.ts`, `reconcileJudge.ts` prompts,
  `transcriptWalk.ts`, `prompts.ts` (no version bump — no prompt
  changes anywhere in this phase).
