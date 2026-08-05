# pgvector migration plan (custom Alpine image)

**Status:** proposed, not started
**Written:** 2026-08-02

Adds the `vector` extension to production Postgres by replacing
`postgres:16-alpine` with a custom image that has pgvector compiled in,
staying on Alpine/musl so the existing `pgdata` volume is byte-compatible.

## Why a custom image and not `pgvector/pgvector:pg16`

The published pgvector images are Debian-based. Production runs
`postgres:16-alpine` ([docker-compose.yml](../docker-compose.yml)), so
switching to them changes the C library under the database from musl to
glibc. Postgres delegates text collation to the C library, so the sort
order of every `text` column can change — which silently corrupts B-tree
indexes built under the old ordering. Recovering means a full
`REINDEX DATABASE` (or dump/restore) with the database effectively
unusable meanwhile.

Compiling pgvector into the same `postgres:16-alpine` base keeps libc,
the collation provider, and the on-disk format identical. The volume is
then untouched by the swap and the change is a boring container update.

## Why this is phased

The backend container's command is `alembic upgrade head && uvicorn …`,
so **migrations apply automatically on every start** (deploy skill,
gotcha #4). If a migration that runs `CREATE EXTENSION vector` reaches a
Postgres image without pgvector, the backend never reaches uvicorn and
the whole site is down — not degraded, down.

So the image must be live and verified **before** the migration exists.
Phases 1–3 are separate deploys, in order.

---

## Phase 0 — Pre-flight

Run on the droplet (`ssh root@159.89.180.146`, app dir
`/opt/goodgirlsbotclub`).

**1. Take a logical backup off-box.**

```bash
docker compose exec -T postgres pg_dump -U ggbc ggbc | gzip > /root/ggbc-pre-pgvector.sql.gz
```

Then copy it to your machine (`scp root@159.89.180.146:/root/ggbc-pre-pgvector.sql.gz .`).
A backup that only exists on the box being changed is not a backup.

**2. Take a DigitalOcean snapshot** of the droplet as the coarse
rollback. It is the only thing that recovers a volume-level mistake.

**Never** run `docker volume prune` or `docker system prune --volumes`
here at any point. The dangling `st-data` / `st-config` volumes are the
last copy of the pre-migration SillyTavern state and both commands would
delete them without naming them (deploy skill, gotcha #2).

**3. Record the current state** so you can tell what changed:

```bash
docker compose exec -T postgres psql -U ggbc -d ggbc -c "\dx"
docker compose exec -T postgres postgres --version
```

---

## Phase 1 — Build and publish the image

Nothing in production changes in this phase. The image is built in
GitHub Actions and pushed to GHCR, matching the existing rule that
**the droplet never builds** (gotcha #3 — it is a 1 vCPU / 1 GB box).

### `docker/postgres/Dockerfile` (new)

```dockerfile
# Postgres 16 + pgvector, built on the SAME Alpine base as the stock
# image so the pgdata volume stays byte-compatible. See
# docs/pgvector-migration-plan.md for why we do not use the published
# Debian-based pgvector images.
ARG PG_VERSION=16

FROM postgres:${PG_VERSION}-alpine AS build

# Pin the extension version explicitly — an unpinned build means the
# extension can change under a routine image rebuild.
ARG PGVECTOR_VERSION=v0.8.0

RUN apk add --no-cache build-base git

RUN git clone --branch "${PGVECTOR_VERSION}" --depth 1 \
        https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    # OPTFLAGS="" strips pgvector's default -march=native. Without it the
    # CI runner's CPU features get baked in and the binary can SIGILL on
    # the droplet's different CPU.
    # with_llvm=no skips JIT bitcode so the build needs no clang/llvm at
    # all; JIT buys nothing for vector ops here.
    && make OPTFLAGS="" with_llvm=no \
    && make install

FROM postgres:${PG_VERSION}-alpine
COPY --from=build /usr/local/lib/postgresql/vector.so \
                  /usr/local/lib/postgresql/
COPY --from=build /usr/local/share/postgresql/extension/vector* \
                  /usr/local/share/postgresql/extension/
```

### `.github/workflows/docker-publish-postgres.yml` (new)

Model it on the existing `docker-publish.yml`, with two differences:

- Trigger on `paths: ['docker/postgres/**']` plus `workflow_dispatch`
  only — this image must not rebuild on every push to main.
- Tag it `ghcr.io/sammygallo/ggbc-postgres:16-pgvector` **and** a
  build-specific tag (for example `16-pgvector-v0.8.0`). Deploy the
  specific tag; a floating tag makes rollback ambiguous.

### Verify before it goes anywhere near production

Locally, against a throwaway volume:

```bash
docker run --rm -e POSTGRES_PASSWORD=x ghcr.io/sammygallo/ggbc-postgres:16-pgvector \
  postgres --version

docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=x \
  ghcr.io/sammygallo/ggbc-postgres:16-pgvector
sleep 5
docker exec pgtest psql -U postgres -c "CREATE EXTENSION vector;"
docker exec pgtest psql -U postgres -c "SELECT '[1,2,3]'::vector;"
docker rm -f pgtest
```

The `postgres --version` output must match the running production
version exactly. If the upstream Alpine tag has moved to a newer 16.x
that is fine (minor upgrades are in-place), but a different **major**
version is a separate migration and must not ride along with this one.

**The build does fail on missing clang, and `with_llvm=no` does not
prevent it** (confirmed 2026-08-05). `postgres:16-alpine` ships
`with_llvm = yes` baked into its PGXS `Makefile.global`, and passing
`with_llvm=no` on the make command line does not suppress the bitcode
targets — `vector.so` links fine, then the build dies on `clang-21`.

The fix is to install the toolchain and ship the bitcode. **The LLVM
version is not interchangeable:** PGXS hardcodes `CLANG = clang-21` and
`LLVM_BINPATH = /usr/lib/llvm21/bin`, while Alpine's unversioned
`llvm-dev` is currently LLVM 22 — so `apk add clang llvm-dev llvm`
(this document's original advice) installs the wrong major and still
fails. Use `clang21 llvm21-dev`, and copy both
`/usr/local/lib/postgresql/bitcode/vector.index.bc` and the
`bitcode/vector/` directory in the final stage. See
[docker/postgres/Dockerfile](../docker/postgres/Dockerfile) for the
working version.

---

## Phase 2 — Cut production over to the new image

Still no schema change. This phase proves the image runs on the real
volume before anything depends on it.

Change the `postgres` service image in
[docker-compose.yml](../docker-compose.yml):

```yaml
  postgres:
    image: ghcr.io/sammygallo/ggbc-postgres:16-pgvector-v0.8.0
```

Leave every other key (`network_mode`, env, `pgdata` volume, healthcheck)
exactly as-is. Then deploy the normal pull-only way:

```bash
cd /opt/goodgirlsbotclub && docker compose pull && docker compose up -d
```

Do not delete or overwrite `/opt/goodgirlsbotclub/docker-compose.override.yml`
— it is gitignored and pins the frontend to `127.0.0.1:8080` (gotcha #1).

### Verify

```bash
docker compose ps                       # all three healthy
docker compose logs --tail=50 postgres  # clean start, no collation warnings
docker compose exec -T postgres psql -U ggbc -d ggbc \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name='vector';"
```

The extension should be **available but not installed**. Confirm the app
still works normally (log in, open a chat) — at this point the only
change is the container image.

**Rollback:** revert the image line, `docker compose pull && docker compose up -d`.
Nothing in the database has changed, so this is clean and instant.

---

## Phase 3 — Enable the extension

New alembic migration in `ggbc-backend/migrations/versions/`, revision
`0017_enable_pgvector`, `down_revision = "0016_add_story_archives"`.

```python
def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")


def downgrade() -> None:
    op.execute("DROP EXTENSION IF EXISTS vector")
```

`POSTGRES_USER=ggbc` is the bootstrap role created by initdb, so it is a
superuser and `CREATE EXTENSION` succeeds without a grant.

**This must be a migration, not a `/docker-entrypoint-initdb.d` script.**
Those scripts only run when the data directory is empty, and `pgdata` has
been initialized since launch — an init script would never execute, and
the failure would be silent.

Deploy the backend normally; the migration applies on container start.

### Verify

```bash
docker compose exec -T postgres psql -U ggbc -d ggbc -c "\dx"
docker compose exec -T postgres psql -U ggbc -d ggbc \
  -c "SELECT extversion FROM pg_extension WHERE extname='vector';"
```

**Rollback:** `alembic downgrade 0016_add_story_archives`. Safe *only*
while no `vector` columns exist — which is why this phase adds none.

---

## Phase 4 — Actual vector storage (separate work, plan later)

Deliberately out of scope here. Notes for when it happens:

**The first thing to move is chat-history RAG, not lorebooks.**
[chatHistoryRagStore.ts:85](../src/stores/chatHistoryRagStore.ts:85)
stopped persisting per-message vectors because ~6 KB each blew the ~5 MB
localStorage quota, so it re-embeds the entire history **every session**
on the user's own OpenAI key. That is a live cost with a fix; semantic
lorebook retrieval is speculative by comparison.

**Sizing.** `text-embedding-3-small` is 1536 dims → `vector(1536)`,
6 KB/row plus overhead. 1,000 messages ≈ 6 MB. The droplet has a 25 GB
disk, so a few hundred heavy users is the point where this needs a
retention policy. `halfvec(1536)` (pgvector ≥ 0.7) halves the storage at
a small recall cost and is worth benchmarking before adding an index.

**Do not add an index reflexively.** HNSW wants the graph to fit in
`maintenance_work_mem` during the build; on a 1 GB box with three
containers there is no comfortable budget for that, and a build that
spills is extremely slow. Per-user result sets here are small (thousands
of vectors, filtered by user and chat), so exact search on a sequential
scan is likely fast enough. Measure first; if an index is needed, build
it during a quiet window with `maintenance_work_mem` raised for that
session only, and consider IVFFlat for its lower build cost.

**Rollback stops being cheap here.** Once a `vector` column exists,
reverting to the stock Alpine image leaves the column's type undefined
and those tables unreadable. From Phase 4 onward the rollback path is
"drop the columns and the extension, *then* revert the image" — so treat
the Phase 4 deploy as the point of no easy return and take a fresh
backup immediately before it.

---

## Risk summary

| Risk | Mitigation |
|---|---|
| Collation corruption from a libc change | Avoided entirely — same Alpine base, same musl |
| Migration lands before the image has pgvector → backend crashloop, site down | Phases 2 and 3 are separate deploys, in that order |
| `-march=native` binary SIGILLs on the droplet | `OPTFLAGS=""` in the Dockerfile |
| Extension changes under a routine rebuild | `PGVECTOR_VERSION` pinned; deploy an immutable tag |
| Init script silently never runs | Extension created by alembic, not `initdb.d` |
| Postgres major version drift riding along | Verify `postgres --version` matches before Phase 2 |
| Backup lost with the box | `pg_dump` copied off-box + DO snapshot |
| Accidental volume deletion | Never run `docker volume prune` on this host |

## Checklist

- [ ] Phase 0 — `pg_dump` off-box, DO snapshot, record `\dx` and version
- [ ] Phase 1 — Dockerfile + workflow, build in CI, verify locally
- [ ] Phase 2 — compose image swap, deploy, verify extension *available*
- [ ] Phase 3 — `0017_enable_pgvector`, deploy, verify extension *installed*
- [ ] Phase 4 — planned separately, starting from chat-history RAG

Add `docs/pgvector-migration-plan.md` to the `paths-ignore` list in
`.github/workflows/docker-publish.yml` — nothing imports it, so it should
not trigger a frontend image rebuild. (Follow the rule stated in that
file: only add a doc after confirming no `?raw` import pulls it in.)
