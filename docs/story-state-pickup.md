# Story-state (productization step 2) — session pickup

Hand-off notes for continuing this work in a fresh session. The plan is
[story-state-step2-plan.md](story-state-step2-plan.md); the schema is
[story-state-schema-v1.md](story-state-schema-v1.md) (read its **v1.1
amendments** section — the original YAML above it is superseded in
places) and its [compatibility audit](story-state-schema-v1-audit.md).

Last updated: 2026-07-29, after Phase 6 merged.

---

## Where things stand

**Phases 0–6 are merged and on `main` in both repos. Nothing is open.**

| Phase | What landed | PR |
|---|---|---|
| 0 | WI fired-state capture into the chat header | goodgirlsbotclub #333 |
| 1 | Permanent message UUIDs at `extra.ggbc_id` | goodgirlsbotclub #334 |
| 2 | Backend id heal + backfill migration 0013 | ggbc-backend #43 |
| 3a | Story-bible Pydantic schemas | ggbc-backend #44 |
| 3b | Story tables (0014) + sections API | ggbc-backend #45 |
| 4 | Scenes, append-only logs (0015), reset | ggbc-backend #46 |
| 5 | Story tab, source-chat designation, read plumbing | goodgirlsbotclub #336 |
| 6 | Cold-start ingestion, WI replay, checkpoints | goodgirlsbotclub #337 |

Plus docs: schema + audit (#330), the plan (#332), v1.1 amendments (#335).

**Backend migration head: `0015_story_log_seq`.**

### What a user can do today

Open a Work → **Story** tab → designate a source chat → **Build the
groundwork**. That runs cold start (card/persona/lorebooks → bible, two
model calls on their own key) and the world-info replay. Scenes and facts
are still empty: the transcript walk is Phase 7.

---

## Next up: Phase 7 — the transcript walk

The plan's designated **risk hotspot**, and the largest remaining piece.
Read its bullet in the plan for the full spec. Shape:

- `transcriptChunker.ts` — token-budgeted ~6000/chunk, never splits a
  message, plan pinned into `ingestion.chunk_plan` for deterministic
  resume, soft cap 200 chunks. **Name it that**, not `chunker.ts`: a
  Data-Bank `chunker.ts` already exists and is unrelated.
- `transcriptWalk.ts` — one call per chunk, rolling context, strict-JSON
  with brace-matching recovery + one repair retry, mechanical swipe
  resolution, force-split at 60 messages, cross-chunk scenes via
  `open_scene`. Per chunk: bulk scene upsert → fact append → section PUT
  → cursor advance → heartbeat.
- Post-walk `user_voice` synthesis (sentence stats computed in TS, not
  by the model).

### ⚠️ Gate before merging Phase 7

Phase 1 must have been **deployed and soaking for days** first, so stale
tabs stop re-minting message ids. The walk writes provenance that points
at those ids; churning them afterwards poisons it. Check when phase 1
actually reached production before merging the walk.

### Two things Phase 6 deferred that Phase 7 should pick up

1. **Resume.** Phase 6 has none — a stopped build starts over, and the
   progress card says so honestly. The walk is where resume matters (it
   is long and expensive), and the checkpoint already carries
   `chunk_index` / `chunk_plan` / `last_ingested` for it.
2. **`PHASE6_PASSES`** in `storyIngestStore.ts` is what the progress
   checklist renders from — add `transcript_walk` there to make it
   appear. `PASS_LABELS` already has copy for it.

---

## Hazards that have actually bitten (do not rediscover these)

**Migrations do NOT auto-apply.** The backend image's entrypoint is plain
uvicorn; an unmigrated database fails startup outright with
`relation "..." does not exist`. `alembic upgrade head` is a deliberate
deploy step. 0013/0014/0015 are all pending production.

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
incidental churn (`git checkout -- node_modules/`) before committing.
`dist/` too.

**Backticks in `git commit -m` get shell-substituted** and silently eat
words. Write the message to a file and use `-F`.

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
things unit tests did not):

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
no proxy entry — they nest under the existing `/projects` rule.

---

## The review discipline (it keeps finding real bugs)

Every phase has been reviewed by a multi-lens adversarial workflow before
commit, and **every single phase had a defect the green test suite
missed**. Worth continuing:

- Lenses per phase: wire-contract (against the backend's real Pydantic
  models — `extra="forbid"` means a wrong field name is a runtime 422 no
  type check catches), logic, concurrency/security, plan conformance.
- Tell verifiers to **reproduce**, not reason. The best findings came
  from agents that ran the real validator in a container or drove real
  concurrent HTTP requests.
- Findings to date included: a lost update under concurrent writes,
  Postgres deadlocks surfacing as 500s, a cursor that skipped rows
  forever, a scene-pagination cursor on a non-unique column, and a
  blocker that started a second concurrent **paid** model run.

**Standing lessons:**
- Any read-check-write in an async handler needs the check *in the SQL*.
- Anything spending the user's API key needs its interrupted and
  navigated-away paths tested explicitly.
- Write the concurrent-request test (`asyncio.gather` / `Promise.all`
  over the real transport) *before* claiming a write path works.

---

## Still open for Sammy (plan §4)

None of these block Phase 7, but 8–10 will want answers:

1. Is the Story tab tier-gated under the features-not-compute model?
2. Facts are server-enforced append-only; removal is `supersedes` or a
   full reset. Given the NSFW context, is that acceptable, or is an
   owner-scoped hard delete needed?
3. "Change source chat" and re-ingest **discard** the bible with no
   archive. Ship as-is, or build a snapshot archive first?
4. Group chats as bible sources — currently allowed, with lorebook
   confidence degraded (group chats never scan world info).
5. Weak-model messaging: soft recommendation, hard warning, or nothing?
6. `content_rating` × `derivative_flags` policy for step-3 rendering.
