# Story-state (productization step 2) — session pickup

Hand-off notes for continuing this work in a fresh session. The plan is
[story-state-step2-plan.md](story-state-step2-plan.md) (phases 0–11 now,
plus a resolved-decisions section 4 — read both before re-litigating
anything); the schema is [story-state-schema-v1.md](story-state-schema-v1.md)
(read its **v1.1 amendments** section — the original YAML above it is
superseded in places) and its [compatibility audit](story-state-schema-v1-audit.md).

Last updated: 2026-07-30, after Phase 9 (bible snapshot archive) was
built, adversarially reviewed twice over (backend + frontend, 17
findings between them, all fixed), verified live end-to-end, and both
PRs opened — ggbc-backend **#47**, goodgirlsbotclub **#343**, CI green
on both, **awaiting Sammy's review/merge**. Phase 7 is still built +
reviewed but gated, unmerged (see below), unaffected by Phase 9.

---

## Where things stand

**Phases 0–6 are merged, on `main` in both repos, and deployed to
production** (2026-07-29 — the droplet had been three days stale before
that deploy). **Phase 7 is built and adversarially reviewed but sitting
in draft, gated on the Phase-1 soak** (see below — do not merge yet).

| Phase | What landed | PR | Status |
|---|---|---|---|
| 0 | WI fired-state capture into the chat header | goodgirlsbotclub #333 | merged, deployed |
| 1 | Permanent message UUIDs at `extra.ggbc_id` | goodgirlsbotclub #334 | merged, deployed |
| 2 | Backend id heal + backfill migration 0013 | ggbc-backend #43 | merged, deployed |
| 3a | Story-bible Pydantic schemas | ggbc-backend #44 | merged, deployed |
| 3b | Story tables (0014) + sections API | ggbc-backend #45 | merged, deployed |
| 4 | Scenes, append-only logs (0015), reset | ggbc-backend #46 | merged, deployed |
| 5 | Story tab, source-chat designation, read plumbing | goodgirlsbotclub #336 | merged, deployed |
| 6 | Cold-start ingestion, WI replay, checkpoints | goodgirlsbotclub #337 | merged, deployed |
| 7 | Transcript walk (chunker, walk, resume, user_voice) | goodgirlsbotclub **#339** | **draft, gated on soak — see below** |
| 9 | Bible snapshot archive (snapshot+restore, both repos) | ggbc-backend **#47** + goodgirlsbotclub **#343** | **open, adversarially reviewed, CI green, awaiting merge** |

Plus docs: schema + audit (#330), the plan (#332), v1.1 amendments
(#335), the previous pickup doc (#338), **the plan's six open questions
resolved** (#340, merged — new Phase 9, Phase 10 gains fact hard-delete).

Also shipped and merged, independent of phase order:
**weak/cheap-model warning** in `StartIngestModal` — goodgirlsbotclub
**#341** (merged 2026-07-30).

**Backend migration head in PRODUCTION: `0015_story_log_seq`.**
ggbc-backend#47 adds `0016_add_story_archives` but is NOT merged yet —
don't assume 0016 is live until that PR actually merges and gets
deployed; check `alembic current` against the running container if it
matters, not this doc.

### What a user can do today (in production)

Open a Work → **Story** tab → designate a source chat → **Build the
groundwork**. That runs cold start (card/persona/lorebooks → bible, two
model calls on their own key) and the world-info replay. Scenes and facts
are still empty in production: the transcript walk (Phase 7) is built
and reviewed but not merged yet. "Reset story" is still the only escape
hatch and is still irreversible in production — Phase 9's snapshot +
restore (auto-snapshot before reset, a snapshot list, a restore action)
is built, reviewed, and PR'd (#47 + #343) but not merged/deployed yet.

---

## ⚠️ The Phase-1 soak gate — check this before doing anything else

Phase 7 must not merge until Phase 1 (permanent message UUIDs) has been
deployed and soaking in production for **days**, so stale open tabs stop
re-minting message ids before the walk's provenance depends on them being
stable. **Phase 1 (and 2–6) deployed to production on 2026-07-29
around 16:23 UTC.** Check elapsed time now:

```bash
ssh root@159.89.180.146 "docker ps --format '{{.Names}}\t{{.Status}}'"
```

`goodgirlsbotclub-ggbc-backend-1` / `-frontend-1` / `-postgres-1` uptime
*is* the soak clock, as long as nothing has restarted them since — a
redeploy for something unrelated resets it, so check `docker ps`, don't
just trust the date on this doc. As of this doc's last update the soak
was only ~10 hours old — nowhere close.

**Do not merge PR #339 until this has run for multiple days.** Building
on top of it, reviewing it further, or working on Phase 8 in the
meantime is all fine — only the *merge* is gated.

---

## Next up

Two independent threads, neither blocking the other:

1. **Wait out the soak, then merge #339.** Nothing to do here but watch
   the clock (see above) and merge when it's actually been days, not
   hours.
2. **Review/merge Phase 9's two PRs** — ggbc-backend **#47** and
   goodgirlsbotclub **#343**. Both built, adversarially reviewed (see
   below), verified live end-to-end, CI green. Backend should merge
   first (or alongside — the frontend degrades gracefully against an
   older backend since these are all new endpoints, but restore
   obviously needs them to exist). Nothing else is gated on this
   merging except Phase 10 (see below).

Once #339 actually merges: **Phase 8 (Reconcile)** is next in strict
sequence (needs 7). Once Phase 9's PRs merge too: **Phase 10** (review
checkpoint + lock canon + the new fact hard-delete work — plan resolved
this: a real owner-scoped delete, not append-only-only, since it breaks
the deliberately-built no-update/delete invariant it needs its own
migration + review pass) needs BOTH 8 and 9. Then **Phase 11**
(incremental re-ingestion — also where Phase 7's "trailing messages
added after a resumed plan was pinned" gap gets a real fix instead of
just a surfaced warning).

---

## Hazards that have actually bitten (do not rediscover these)

**Migrations auto-apply in PRODUCTION, but NOT in the bare image.**
Correction to an earlier version of this doc: production's
`docker-compose.yml` already wraps the backend's command as
`alembic upgrade head && uvicorn ...`, so `docker compose pull && up -d`
genuinely does apply pending migrations on container restart — verified
firsthand deploying 0013→0015 this way. The "migrations do NOT
auto-apply" trap is real only for the **bare image run standalone**
(e.g. `docker run ... ggbc-dev-api:local` in the local-dev recipes
below, with no compose wrapper) — there it's a deliberate separate step.
Don't assume either way; check the actual `command:` in whatever
compose file you're using.

**Deterministic ids for LLM-response-derived objects must be seeded from
intrinsic content, never from a response's ordinal position.** Phase
7's original scene/fact id scheme seeded from
`${chunkBoundary}:scene:${indexInResponse}` — reviewed as a **blocker**:
a retry whose model response is shaped differently (different scene
count/split) lands unrelated content on the same id, silently
overwriting a committed scene or dropping a billed fact. Fixed by
seeding scene ids from the scene's own first real message id, and fact
ids from `(source message id, fact text)` — so only a genuine
re-derivation of the *same* content can collide. Keep this pattern for
any future pass that mints ids from model output.

**A per-project advisory lock (`pg_advisory_xact_lock`) must be
acquired immediately before the DB write it protects, never before
reading/validating the request body.** Phase 9 added the lock to three
single-row write endpoints (section/scene PUT, scene DELETE) so they'd
serialize against the new restore endpoint's whole-bible staleness
check + wipe — but placed the lock call *before* the body was read.
Reviewed as a **blocker**: a slow or deliberately-trickled request body
held the project's lock for its entire transfer time, blocking every
other write to the project — an unbounded, self-inflicted DoS with no
request timeout anywhere in the app to bound it. Every *other* locked
path in this router (bulk scene writes, fact/edit append, reset,
restore) already validated the body first and locked only right before
the critical section; the three new ones didn't match that pattern.
Fixed by moving the lock to immediately before the write. Lesson: when
adding a lock to an existing endpoint, lock last, not first.

**A row recreated after being deleted (same id, brought back by a
restore or similar) must get a version/CAS token that cannot coincide
with a token a client cached from before the deletion.** Phase 9's
restore endpoint recreated every section/scene at the hardcoded
`server_ts=1` — the same value a brand-new row always starts at.
Reviewed as a **major ABA hazard**: a client holding a `base_ts` from
*before* the reset-that-preceded-the-restore (e.g. `1`, from when the
row was first created) would have its now-stale token coincidentally
match the freshly-restored row's version, and its write/delete would
silently succeed against content it never actually saw. Reproduced
live: a `base_ts=1` DELETE that had just been correctly rejected as
stale pre-reset was accepted post-restore, purely by coincidence of the
version number. Fixed by seeding restored rows' version from the
current epoch in milliseconds instead of a constant — a scale no real
`base_ts` counter (which increments by 1 per write) will ever reach.
Keep this pattern for any future pass that resurrects an id after
deletion: never restart a version counter at a fixed low value the old
incarnation could also have held.

**A resumable pass must be detected *before* re-running anything
upstream of it, not just before the pass itself.** Phase 7's `run()`
originally reran cold_start unconditionally on every call (including
resumes) and reset the checkpoint to empty before pass 1 — two symptoms
of the same bug: cold_start mints brand-new random character ids every
time, silently orphaning an already-open scene's participant refs on
resume, and any pass-1 hiccup during a resume attempt destroyed the
resumable `chunk_plan`/`chunk_index`. Fixed by checking "is there a
resumable walk in progress" as the very first thing `run()` does, before
any upstream work starts.

**Never statically import `chatStore` from a store.** `lovenseStore`
subscribes to it at module scope; a static edge TDZ-crashes the app. The
story stores stay clean by taking plain data — `components/works/ingestSources.ts`
is the one place that reaches across stores. If you see
`Cannot access 'useChatStore' before initialization` in the dev console,
check whether it is stale HMR noise before believing it: a production
build (`npm run build`) has no HMR and is the real test.

**Section PUTs are full replaces** with defaults materialized. Read the
section, spread it, override only your fields. Phase 5 shipped a bug
where re-designating wiped `content_rating`, `canon_locked_at` and more.

**`base_ts` is mandatory on story writes** (unlike `/sync` and
`/chats/save`). 0 means create. Conflicts return 409 with the winner —
adopt and retry once.

**The 256KB section cap is real and reachable.** Three 60-entry lorebooks
overflow the `world` section. Budget before writing; a 413 after paying
for model calls is unrecoverable and every retry fails identically.

**The frontend repo commits `node_modules`.** Never symlink it; revert
incidental churn (`git checkout -- node_modules/`) before committing —
running the local dev stack (below) touches `node_modules/.vite/deps/_metadata.json`
every time, so check `git status` before every commit, not just once.
`dist/` too.

**Backticks in `git commit -m` get shell-substituted** and silently eat
words. Write the message to a file and use `-F`.

**Browser-automation clicks in this app are flaky against stale
coordinates/refs.** A `ref` echoed by an earlier `read_page` call, or a
coordinate eyeballed off a screenshot, frequently lands on the wrong
element or silently no-ops — re-run `read_page` **immediately** before
every click rather than reusing refs across turns, and if a click
produces no visible/network effect, retry it once with a freshly-fetched
ref before assuming the feature is broken. This cost real time
verifying the weak-model warning (PR #341) even though the underlying
code was correct on the first try.

---

## Environment recipes that work

**Frontend tests:** `npm test` (vitest, node env, no jsdom).
`npx tsc -b`, `npm run build`. Lint is deliberately not in CI — there
are pre-existing errors, including one in `WorksPanel.tsx`.

**Backend tests** — disposable Docker only, never the compose db:

```bash
docker run -d --rm --name pg -e POSTGRES_USER=ggbc -e POSTGRES_PASSWORD=ggbc \
  -e POSTGRES_DB=ggbc -p 55432:5432 postgres:16-alpine
docker run --rm -v "$PWD":/app -w /app \
  -e DATABASE_URL=postgresql+asyncpg://ggbc:ggbc@host.docker.internal:55432/ggbc \
  python:3.12-slim bash -c "pip install -q -e '.[dev]' && pytest -q"
```

The host has no modern Python (3.9), so backend work must go through a
container. **Known flake:** this harness sporadically throws
`asyncpg TimeoutError` on a *different* unrelated test each run and never
reproduces in isolation — it is a `host.docker.internal` port-forward
stall, not a defect. Re-run before believing a failure.

**Full local stack** (for real end-to-end verification, which has caught
things unit tests did not — this is the recipe that verified PR #341
live, including logging in, creating a character/chat/Work, and driving
the actual Story-tab UI):

```bash
docker network create ggbc-dev
docker run -d --rm --name ggbc-dev-db --network ggbc-dev \
  -e POSTGRES_USER=ggbc -e POSTGRES_PASSWORD=ggbc -e POSTGRES_DB=ggbc postgres:16-alpine
cd ../ggbc-backend && docker build -t ggbc-dev-api:local .
docker run --rm --network ggbc-dev -e DATABASE_URL=postgresql+asyncpg://ggbc:ggbc@ggbc-dev-db:5432/ggbc \
  ggbc-dev-api:local alembic upgrade head
docker run -d --rm --name ggbc-dev-api --network ggbc-dev -p 127.0.0.1:8001:8000 \
  -e DATABASE_URL=postgresql+asyncpg://ggbc:ggbc@ggbc-dev-db:5432/ggbc \
  -e COOKIE_SECURE=false -e ALLOW_SELF_REGISTRATION=true \
  -e OWNER_HANDLE=dev -e OWNER_PASSWORD=devpassword -e OWNER_NAME=Dev ggbc-dev-api:local
```

The API listens on **8000** inside the container (map `8001:8000`; vite
proxies to 8001). Log in as `dev` / `devpassword`. The story routes need
no proxy entry — they nest under the existing `/projects` rule. Tear
down with `docker stop ggbc-dev-api ggbc-dev-db && docker network rm ggbc-dev`
when done — don't touch any *other* running containers you didn't start
(this box tends to accumulate long-lived ones from other work, e.g.
`ggbc-backend-db-1`).

**If `docker compose up` for the repo's own `docker-compose.dev.yml`
throws `Error response from daemon: No such container: <hash>`
repeatedly across retries** — that's Docker Desktop's compose-project
state getting out of sync with the real container runtime, not a code
problem. `docker compose down` first, `docker rm -f` any same-named
leftovers, and if it still happens, skip compose entirely and use the
plain `docker run` recipe above instead (it sidesteps compose's project
state completely and reliably works).

---

## The review discipline (it keeps finding real bugs)

Every phase has been reviewed by a multi-lens adversarial workflow before
commit, and **every single phase had a defect the green test suite
missed**. Phase 7 was the starkest case yet at the time: **11 findings,
all 11 confirmed on independent adversarial re-verification, 3 of them
blockers.** Phase 9 matched that hit rate exactly on the backend side —
**9 findings raised, all 9 confirmed, 0 refuted**, including a blocker
(the lock-before-body-validation DoS) and a major concurrency defect
(the restore ABA hazard) neither the shipped test suite nor a first
read-through caught — plus a **separate** frontend-side review, **8 of
10 findings confirmed** (2 refuted as non-issues), including two
blockers in `storyStore.ts` (unconditional cross-project state
clobbering in `resetBible`/`restoreArchive`, caught by the same "did
you check `get().projectId` is still current" pattern as prior phases,
just in two NEW functions). Worth continuing:

- Lenses per phase: wire-contract (against the backend's real Pydantic
  models — `extra="forbid"` means a wrong field name is a runtime 422 no
  type check catches), logic, concurrency/security, plan conformance.
- Tell verifiers to **reproduce**, not reason. The best findings came
  from agents that ran the real validator in a container, drove real
  concurrent HTTP requests, or built a stateful fake backend and ran the
  actual production code against it end-to-end.
- Findings to date included: a lost update under concurrent writes,
  Postgres deadlocks surfacing as 500s, a cursor that skipped rows
  forever, a scene-pagination cursor on a non-unique column, a blocker
  that started a second concurrent **paid** model run, cold_start
  reminting character ids on every resume, scene/fact ids collidable
  across a differently-shaped retry, an advisory lock held across a
  request body's transfer time (unbounded DoS), and an ABA version-token
  hazard on rows recreated by a restore (see the hazards above for the
  newest three — they're the least obvious).

**Standing lessons:**
- Any read-check-write in an async handler needs the check *in the SQL*.
- Anything spending the user's API key needs its interrupted and
  navigated-away paths tested explicitly.
- Write the concurrent-request test (`asyncio.gather` / `Promise.all`
  over the real transport) *before* claiming a write path works.
- IDs minted from an LLM's own response must be seeded from something
  mechanically stable (message ids, content), never from the response's
  ordinal position — the model's non-determinism can reshuffle that.
- A resume path must be detected *before* anything upstream of it runs,
  not just guarded at its own entry point.
- On the frontend store side: EVERY `set()` that runs after an `await`
  needs its own `get().projectId === projectId` check, not just the
  `reloadIfStillCurrent` call that typically follows it. Phase 9's
  `resetBible`/`restoreArchive` both cleared `sections`/`scenes`/
  `isSaving` unconditionally right after their API call resolved —
  correct for the common case, but wrong the instant the user had
  switched Works while the call was in flight, since it would clobber
  the NEW Work's live state (including stomping its own `isSaving`
  flag). The `reloadIfStillCurrent` guard downstream doesn't retroactively
  protect an unconditional `set()` that already ran before it.

---

## The plan's open questions — all resolved (2026-07-29, PR #340)

No longer open; recorded here so you don't re-ask them. Full detail in
the plan's §4:

1. **No tier gate** on the Story tab.
2. **Add owner-scoped fact hard-delete** (not append-only-only) — new
   scope on Phase 10, still needs an implementation choice (a real
   `DELETE`, or a scrub-in-place `PATCH` that blanks `text` but keeps
   the row/id for audit) — "pick one at implementation time" per the
   plan text, i.e. **still an open design detail**, just not an open
   *policy* question anymore.
3. **Build the snapshot archive first** — new Phase 9, snapshot +
   restore (not export-only). Built, reviewed, and PR'd (ggbc-backend
   #47 + goodgirlsbotclub #343) — see "Where things stand" above.
4. **Group chats stay allowed** as bible sources, unchanged.
5. **Warn about weak/cheap models, informational only** — shipped and
   merged, PR #341.
6. **No gating** from `content_rating` × `derivative_flags` on anything
   downstream.
