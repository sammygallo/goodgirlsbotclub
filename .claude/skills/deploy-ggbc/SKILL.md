---
name: deploy-ggbc
description: "Push, merge, and deploy Good Girls Bot Club (goodgirlsbotclub) to the production droplet. Use this skill whenever the user says /deploy-ggbc, asks to 'deploy ggbc', 'push and deploy', 'update the droplet', 'ship it', or wants to merge branches and update the live server. Also trigger when the user finishes a GGBC feature and wants to get it running on the server."
---

# Deploy Good Girls Bot Club to Production

> **This file is the single source of truth. Edit it HERE.**
>
> `~/.claude/skills/deploy-ggbc/SKILL.md` — the path the skill loads
> from — is a **symlink** to this file (set 2026-07-31):
>
> ```
> ~/.claude/skills/deploy-ggbc/SKILL.md
>   -> /Users/sammy/Documents/GitHub/goodgirlsbotclub/.claude/skills/deploy-ggbc/SKILL.md
> ```
>
> They used to be two hand-synced copies. They drifted, were unified, and
> re-diverged within the hour — so the copying was replaced with a link
> that makes drift structurally impossible. Every edit is now
> version-controlled and reviewable by construction.
>
> **The one failure mode this introduces:** the link is absolute, so
> moving, renaming or deleting the goodgirlsbotclub checkout leaves it
> dangling and the skill silently stops loading — no error, it just
> disappears from the skill list. If `/deploy-ggbc` ever goes missing,
> check `ls -la ~/.claude/skills/deploy-ggbc/` first. Recreate with:
>
> ```bash
> ln -sf <repo>/.claude/skills/deploy-ggbc/SKILL.md \
>        ~/.claude/skills/deploy-ggbc/SKILL.md
> ```

Push feature branches, merge them, wait for each repo's Docker image CI to finish, then update the live droplet with a pull-only deploy.

The frontend and ggbc-backend images are built in GitHub Actions and pulled from GHCR. **The droplet never builds — it just `docker compose pull`s and restarts.** Deploys should take under a minute once CI is green.

## Repos

| Repo | Local path | Remote | Merge target | Image tag | CI workflow |
|------|-----------|--------|-------------|-----------|-------------|
| goodgirlsbotclub (frontend) | `/Users/sammy/Documents/GitHub/goodgirlsbotclub` | `sammygallo/goodgirlsbotclub` | `main` | `ghcr.io/sammygallo/goodgirlsbotclub:latest` | `.github/workflows/docker-publish.yml` |
| ggbc-backend (FastAPI/Postgres) | `/Users/sammy/Documents/GitHub/ggbc-backend` | `sammygallo/ggbc-backend` | `main` | `ghcr.io/sammygallo/ggbc-backend:latest` | `.github/workflows/docker-publish.yml` |
| ggbc-intake-bot | `/Users/sammy/Documents/GitHub/ggbc-intake-bot` | `sammygallo/ggbc-intake-bot` | `main` | _(no image — builds on droplet)_ | _(none — no CI)_ |

## Droplet

- **Host:** `159.89.180.146` (DigitalOcean `s-1vcpu-1gb`, 2 GB swap)
- **User:** `root`
- **App dir (web):** `/opt/goodgirlsbotclub`
- **App dir (intake bot):** `/opt/ggbc-intake-bot` — runs under pm2, NOT docker
- **Connect:** `ssh root@159.89.180.146`
- **Public URL:** fronted by a reverse proxy; the frontend container binds to `127.0.0.1:8080` internally

## Environment gotchas — READ THIS BEFORE DEBUGGING

These are non-obvious things about the production environment that will bite you if you don't know them:

### 1. Droplet has a `docker-compose.override.yml`

At `/opt/goodgirlsbotclub/docker-compose.override.yml` there's a host-specific override that pins the frontend port to `127.0.0.1:8080:80` (instead of the repo default `${PORT:-80}:80`). This file is **gitignored** and **must not be deleted or committed**. It's why the frontend isn't directly exposed to the internet — the reverse proxy in front of the droplet forwards to `127.0.0.1:8080`.

If you see unexpected port behavior, `ssh root@159.89.180.146 "cat /opt/goodgirlsbotclub/docker-compose.override.yml"` to check it. If it's missing, recreate it with:

```yaml
services:
  frontend:
    ports: !override
      - "127.0.0.1:8080:80"
```

The `!override` tag is critical — without it, compose *merges* the ports lists and tries to bind both 80 and 8080, causing a port-in-use error.

### 2. Stack is three containers — frontend / ggbc-backend / postgres

Post-B3c-final (2026-05-26): SillyTavern and `seed-owner` are gone from production. A successful `docker ps` shows:

- `goodgirlsbotclub-frontend-1` — always running (nginx + Vite build)
- `goodgirlsbotclub-ggbc-backend-1` — always running (FastAPI; runs `alembic upgrade head` on every start, then uvicorn)
- `goodgirlsbotclub-postgres-1` — always running, healthy

`docker ps -a` is now clean of ST remnants: the last leftover was **deleted on 2026-07-31**. Note what it actually was, because the previous advice here was wrong — it was a standalone container plainly named `sillytavern` (not `goodgirlsbotclub-sillytavern-1`), created outside compose back in the pre-compose era and exited `(0)` since 2026-04-13. **`docker compose up -d --remove-orphans` would never have removed it** — compose only reaps containers carrying its own project labels. It took a direct `docker rm sillytavern`. If a stray container ever shows up again, check whether it's compose-managed before assuming `--remove-orphans` will handle it.

**The `st-data` / `st-config` volumes must be left alone — and they are easier to destroy than they look.** Card recovery off them is **complete** (verified 2026-07-31: `recover_st_characters.py` dry-run reports `imported=0`; all personal and global cards are in Postgres), so nothing on them is load-bearing today, but they are the only surviving copy of the pre-migration state. They are attached to no container, which makes them *dangling* — so `docker volume prune` or `docker system prune --volumes` would delete them **silently, without a confirmation naming them**. Never run either on this box. `docker image prune -af` is fine (images only). When removing containers, use `docker rm <name>` without `-v`.

### 3. Building the frontend on the droplet is the OLD way and must never happen again

The droplet is a 1 vCPU / 1 GB box. Running `vite build` on it takes 12+ minutes and thrashes the memory budget. The skill's deploy command must **never** use `docker compose up --build`. It must always be `docker compose pull && docker compose up -d`. The image is built in GitHub Actions and pulled from GHCR.

### 4. Backend migrations run automatically on startup

The `ggbc-backend` container's CMD is `alembic upgrade head && uvicorn …`, so every deploy applies any pending alembic migrations idempotently. You don't need to run them by hand. If a migration fails the container won't reach uvicorn and the deploy will be visibly broken; check `docker compose logs ggbc-backend` immediately.

### 5. The `SECRET_ENCRYPTION_KEY` env var is critical and lives in `.env`

API secrets (Replicate keys, OpenAI keys, etc.) are Fernet-encrypted in Postgres using `SECRET_ENCRYPTION_KEY` from `/opt/goodgirlsbotclub/.env`. **Never** regenerate or change this key without re-encrypting the existing rows — every secret in the DB becomes unrecoverable. If you find the var unset on the droplet, the backend falls back to a publicly-known dev key (visible in source), which would mean every API key in the DB is decryptable by anyone reading the repo.

### 6. NEVER scope `docker compose pull`/`up -d` to a single service — always deploy all three together

It's tempting, when only the frontend image actually changed, to save a few seconds with `docker compose pull frontend && docker compose up -d frontend` instead of the full `docker compose pull && docker compose up -d`. **This takes the site down.** `postgres` and `ggbc-backend` both run with `network_mode: "service:frontend"` (gotcha #1/#2) — they don't have their own network namespace, they borrow the frontend container's. Recreating *only* the frontend container destroys the network namespace `postgres`/`ggbc-backend` are still attached to; they keep running as processes (`docker ps` cheerfully reports them `Up`, exactly like the alembic-race case in step 5), but nothing can reach them — `curl 127.0.0.1:8001/health` gets `Connection refused` and the site is fully down until they're recreated too.

The visible symptom is a **persistent** 502 (unlike the normal alembic-migration 502 blip in step 5, this one never clears on its own — polling `/health` for 60s and seeing no change is the tell). `docker compose logs frontend` will show `connect() failed (111: Connection refused) ... upstream: "http://127.0.0.1:8001/..."` even though `ggbc-backend`'s own logs show it started cleanly — the backend is fine, it's just marooned on a namespace nginx no longer shares.

**Fix:** `docker compose up -d` with no service argument — this recreates `postgres` and `ggbc-backend` to attach to the current frontend container, and recovery is immediate (confirmed 2026-08-09: `/health` back to 200 on the very next poll after the full `up -d`).

The one-line takeaway: **there is no such thing as a partial restart on this stack.** Step 4's command is deliberately `docker compose pull && docker compose up -d` with no service scoping, even when you know only one image changed — don't "optimize" it. **Incurred on 2026-08-09**: a frontend-only hotfix deploy (`db6423c`, the interview-wizard close-button fix) took the site down for ~2 minutes this way before being caught and fixed with a full `up -d`.

## Arguments

The skill accepts optional branch names as arguments:

```
/deploy-ggbc                                          # auto-detect all three repos
/deploy-ggbc claude/some-branch                       # frontend only
/deploy-ggbc - claude/api-branch                      # ggbc-backend only (dash = skip frontend)
/deploy-ggbc claude/fe-branch claude/api-branch       # both web repos
/deploy-ggbc intake                                   # intake bot only
```

The second positional arg is a **ggbc-backend** branch. (Historically it was a SillyTavern branch; that repo has not been a deploy target since 2026-05-25 — see gotcha #2.)

The intake bot is auto-included when detection finds unpushed commits or local commits ahead of `origin/main` in `~/Documents/GitHub/ggbc-intake-bot`. Use the explicit `intake` keyword to target it alone and skip web repos.

If invoked with no args and nothing to deploy anywhere, interpret it as "sync the droplet with whatever is currently on the deployment branches" — skip the merge steps and go straight to step 5.

## Workflow

### 0. Always start with a fetch

Before ANY branch inspection, merge, or PR operation, fetch all three repos. Stale `origin/main` state has caused failed deploys in the past.

```bash
cd /Users/sammy/Documents/GitHub/goodgirlsbotclub && git fetch origin
cd /Users/sammy/Documents/GitHub/ggbc-backend && git fetch origin
cd /Users/sammy/Documents/GitHub/ggbc-intake-bot && git fetch origin
```

### 1. Determine what to deploy

If branch args were provided, use them. Otherwise, detect:

```bash
# Frontend
cd /Users/sammy/Documents/GitHub/goodgirlsbotclub
git log --oneline origin/main..HEAD  # if on a feature branch

# Backend (also main; ggbc-backend follows the standard PR-against-main flow)
cd /Users/sammy/Documents/GitHub/ggbc-backend
git log --oneline origin/main..HEAD

# Intake bot
cd /Users/sammy/Documents/GitHub/ggbc-intake-bot
git fetch origin && git log --oneline origin/main..HEAD
```

Confirm with the user what you're about to merge before proceeding. If a repo has no changes, skip it.

**Also check for open PRs**, since work often lives on GitHub rather than in a local branch:

```bash
gh pr list --repo sammygallo/goodgirlsbotclub --json number,title,headRefName,baseRefName,isDraft \
  --jq '.[] | "#\(.number) [\(if .isDraft then "DRAFT" else "ready" end)] \(.headRefName) -> \(.baseRefName)"'
```

Check the **base** branch, not just draft status. A non-draft PR whose base is another feature branch is a *stacked* review-fixes PR, not a deploy candidate — only PRs based on `main` ship. (Hit on 2026-07-31: #346 read as "ready" but was based on the draft `claude/story-state-phase7`, so nothing was deployable that run.)

#### Frontend: verify the build locally before pushing

**Do NOT rely on `tsc --noEmit` alone.** The Dockerfile runs `npm run build` → `tsc -b && vite build`, which uses `tsconfig.app.json` with stricter project-reference settings than the root `tsconfig.json`. Errors like zustand hook overloads resolving to `unknown`, or narrowed-union comparisons, will pass `tsc --noEmit` but fail `tsc -b`. Always run the **same thing CI will run** locally first:

```bash
cd /Users/sammy/Documents/GitHub/goodgirlsbotclub
npm run build  # runs tsc -b && vite build — matches the Dockerfile
```

If `npm run build` is green, the Docker CI build will be green. This is a two-minute local check that saves a ~3-minute round-trip of push → CI fail → fix → push → CI again. **Incurred on 2026-04-15 during the AI settings catalog deploy — two TS errors slipped past `tsc --noEmit` and failed in CI.**

#### Backend: pytest + ruff locally before pushing

CI runs `ruff check . && pytest`. Same check locally:

```bash
cd /Users/sammy/Documents/GitHub/ggbc-backend
# Spin up an ephemeral postgres on :5433 (avoids colliding with the dev stack on :5432)
docker run --rm -d --name ggbc-test-pg \
  -e POSTGRES_USER=ggbc -e POSTGRES_PASSWORD=ggbc -e POSTGRES_DB=ggbc \
  -p 127.0.0.1:5433:5432 postgres:16-alpine && sleep 3

docker run --rm -v "$PWD:/app" -w /app --network host \
  -e DATABASE_URL=postgresql+asyncpg://ggbc:ggbc@127.0.0.1:5433/ggbc \
  python:3.12-slim sh -c "pip install -q -e '.[dev]' && ruff check . && pytest"

docker stop ggbc-test-pg
```

Faster alternative if you already have a local stack running: point at the dev postgres on :5432 instead. Either way, green pytest + green ruff locally → green CI.

### 2. Merge — preferred path: `gh pr merge`

For any branch that has an open PR, just merge it:

```bash
# Frontend
gh pr merge <pr-number> --repo sammygallo/goodgirlsbotclub --squash --delete-branch

# Backend
gh pr merge <pr-number> --repo sammygallo/ggbc-backend --squash --delete-branch
```

No local checkout required, no worktree hunting, and GitHub handles any fast-forward edge cases. Use `--admin` instead of `--squash` if branch protection blocks the squash (rare).

If there's no PR yet, open one first:

```bash
cd /Users/sammy/Documents/GitHub/goodgirlsbotclub
git push origin <branch-name>
gh pr create --base main --head <branch-name> --title "..." --body "..."
gh pr merge <new-pr-number> --repo sammygallo/goodgirlsbotclub --squash --delete-branch
```

#### Fallback: local merge

Only use this if `gh pr merge` isn't available, or the branch has no PR and you can't create one:

```bash
cd /Users/sammy/Documents/GitHub/goodgirlsbotclub
git push origin <branch-name>
# Find where main is checked out (may be a worktree) — git branch -v
git checkout main
git merge <branch-name> --no-edit
git push origin main
```

#### Worktree pitfall

The frontend repo sometimes has secondary worktrees under `.claude/worktrees/<slug>/`. Branch checkout in a worktree fails with `'main' is already used by worktree at …`. Either work in the primary worktree (`/Users/sammy/Documents/GitHub/goodgirlsbotclub`) or use `git fetch && git push` without trying to checkout. **Incurred on 2026-05-26 during B3c-final** — bash session cwd drifted into the wrong worktree mid-deploy and silently dropped edits via failed `git checkout main` → fallback compound commands.

### 3. Wait for CI

Both repos build images in GitHub Actions. The droplet only pulls — it never builds — so you must wait for each repo whose code you pushed.

**Always match the run to the COMMIT YOU MERGED, never `--limit 1`.**
Both repos now skip the image build for docs-only pushes (`paths-ignore`
in `docker-publish.yml` — goodgirlsbotclub#349, ggbc-backend#49), and a
commit carrying `[skip ci]` skips it too. After such a merge there is NO
new run, so `--limit 1` silently returns the PREVIOUS run — already
`success` — and `gh run watch` reports green instantly for the wrong
commit. The deploy still does the right thing (`:latest` is genuinely
unchanged), but the "CI is green" signal is a lie, and it would keep
being a lie on a merge that *should* have built.

Note `paths-ignore` covers only what its allow-list names. `.claude/**`
is NOT in it — a skill-doc change will still trigger a build unless the
commit says `[skip ci]`.

Use this helper for each repo whose code you merged. It resolves the run
by `headSha`, tolerates the run not existing yet, and distinguishes
"skipped on purpose" from "something is wrong":

```bash
# usage: wait_for_image <repo> <local-checkout-path>
wait_for_image() {
  local REPO="$1" DIR="$2"
  local SHA; SHA=$(git -C "$DIR" rev-parse HEAD)
  echo "waiting on image build for ${REPO}@${SHA:0:7}"

  # A run appears within seconds of a push. Poll ~90s before concluding
  # it was skipped — declaring "skipped" too early would sail past a
  # build that was merely slow to be created.
  local RUN="" i
  for i in $(seq 1 18); do
    RUN=$(gh run list --repo "$REPO" --workflow docker-publish.yml --limit 30 \
      --json databaseId,headSha --jq "[.[] | select(.headSha==\"$SHA\")][0].databaseId")
    [ -n "$RUN" ] && [ "$RUN" != "null" ] && break
    RUN=""; sleep 5
  done

  if [ -z "$RUN" ]; then
    # No build for this SHA. Two legitimate causes: every changed file
    # matched paths-ignore, or the commit message carried [skip ci].
    # Don't try to distinguish them — verify the OUTCOME instead: the
    # published :latest must still descend from a commit on this line,
    # so we know it corresponds to real code.
    local LAST_SHA
    LAST_SHA=$(gh run list --repo "$REPO" --workflow docker-publish.yml --limit 30 \
      --json headSha,conclusion --jq '[.[] | select(.conclusion=="success")][0].headSha')
    if [ -n "$LAST_SHA" ] && git -C "$DIR" merge-base --is-ancestor "$LAST_SHA" "$SHA" 2>/dev/null; then
      echo "  no build for this SHA (paths-ignore, or [skip ci] in the commit)."
      echo "  :latest is from ${LAST_SHA:0:7}, an ancestor of HEAD. Safe to deploy."
      return 0
    fi
    echo "  ERROR: no build for this SHA, and the last successful build (${LAST_SHA:0:7})"
    echo "  is NOT an ancestor of HEAD. Do NOT deploy — investigate."
    return 1
  fi

  gh run watch "$RUN" --repo "$REPO" --exit-status
  # Explicit conclusion check — see the pipe warning below.
  local CONCLUSION
  CONCLUSION=$(gh run view "$RUN" --repo "$REPO" --json conclusion --jq .conclusion)
  echo "  conclusion: $CONCLUSION"
  [ "$CONCLUSION" = "success" ]
}

wait_for_image sammygallo/goodgirlsbotclub /Users/sammy/Documents/GitHub/goodgirlsbotclub
wait_for_image sammygallo/ggbc-backend    /Users/sammy/Documents/GitHub/ggbc-backend
```

Run it only for repos you actually merged into, and make sure that
repo's local checkout is on `main` and pulled first — `HEAD` there is
what the SHA is read from.

Typical durations:
- **Frontend CI:** ~1.5–3 minutes (Vite build on GitHub runner with GHA cache)
- **Backend CI:** ~3–5 minutes (pytest + ruff + multi-arch Docker image build). Measured 2026-07-31 across the last 5 successful runs: 3.9–4.2 min.

On a **sync-only** run (nothing merged this time — see the Arguments note about deploying with no pending work), `wait_for_image` still does the right thing: it finds no run for the current SHA, confirms the published `:latest` came from an ancestor commit, and returns 0. You can also eyeball recent runs directly:

```bash
gh run list --repo sammygallo/goodgirlsbotclub --workflow docker-publish.yml --limit 3 \
  --json databaseId,headSha,headBranch,status,conclusion \
  --jq '.[] | "\(.databaseId) \(.headSha[0:7]) \(.headBranch) \(.status)/\(.conclusion)"'
```

Use `run_in_background: true` on the Bash call if you want to keep working in parallel — you'll get a task-notification when it completes.

#### ⚠️ `gh run watch --exit-status` can be silently swallowed by pipes

If you pipe `gh run watch` through `tail`, `head`, or similar (which is tempting for log truncation), **the pipe's exit code (0) masks gh's non-zero exit code**. The background task will report success even though CI failed, and you'll only discover the failure if you actually read the output. Two ways to avoid this:

```bash
# Option A: ALWAYS follow the watch with an explicit conclusion check.
gh run watch $RUN --repo <repo> --exit-status
CONCLUSION=$(gh run view $RUN --repo <repo> --json conclusion --jq .conclusion)
echo "Conclusion: $CONCLUSION"  # Expect: success

# Option B: enable pipefail if you must pipe.
set -o pipefail
gh run watch $RUN --repo <repo> --exit-status 2>&1 | tail -20
```

**Option A is the safer default** — do it every time, even when the background task says exit 0. **Incurred on 2026-04-15:** the first deploy reported "exit code 0" from a backgrounded watch + tail pipeline while CI had actually failed, only caught by reading the output.

`wait_for_image` above already does Option A internally, so if you use it you are covered — this section is the rationale, and applies if you ever watch a run by hand.

If CI fails, stop and report the failing step:
```bash
gh run view <run-id> --repo <repo> --log-failed
```

### 4. Deploy to droplet

```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && git pull origin main && docker compose pull && docker compose up -d"
```

**Never scope `pull`/`up -d` to a single service (e.g. `... pull frontend && ... up -d frontend`), even on a frontend-only or backend-only change.** See Environment gotcha #6 — `postgres`/`ggbc-backend` share the frontend container's network namespace, and restarting frontend alone strands them, unreachable, with no visible warning until you poll `/health` and it never clears.

Pull-only deploy:
- `git pull origin main` — fetches the latest `docker-compose.yml` and any config/script changes
- `docker compose pull` — pulls the freshly-published frontend AND backend images from GHCR (harmless no-op for whichever one didn't change)
- `docker compose up -d` — recreates ALL THREE containers together so they share a fresh, consistent network namespace, restarting only the ones whose image actually changed

Should complete in under a minute. **Never add `--build`.** Building on the droplet is explicitly prohibited (see Environment gotcha #3).

The backend runs `alembic upgrade head` automatically on each start, so any new schema migrations apply themselves as part of the recreate.

### 4.5. Deploy intake bot (only when intake is in scope)

Skip this entire step if the intake bot wasn't detected in step 1 and wasn't explicitly requested.

The intake bot is **NOT** a docker service. It runs directly under pm2 on the droplet at `/opt/ggbc-intake-bot`. There is no GHA workflow — it builds on the droplet (cheap: `tsc` only, no Vite/Docker). Push the local main, then SSH and update.

```bash
# Push local main first (intake bot commits straight to main, no PR flow)
cd /Users/sammy/Documents/GitHub/ggbc-intake-bot
git push origin main

# Deploy in one SSH round-trip
ssh root@159.89.180.146 "cd /opt/ggbc-intake-bot && \
  git pull origin main && \
  npm ci && \
  npm run build && \
  npm run migrate && \
  pm2 start ecosystem.config.cjs --update-env && \
  pm2 save"
```

Why each command:
- `npm ci` — clean install from lockfile; tolerant of native rebuilds (`better-sqlite3`).
- `npm run migrate` — applies any new SQL migrations; idempotent (`IF NOT EXISTS`).
- `pm2 start ... --update-env` — re-registers all apps declared in `ecosystem.config.cjs`. Safe to run when apps are already online; pm2 restarts them with new env + new code. Also picks up newly-added apps (e.g. the nightly `ggbc-intake-recluster` cron).
- `pm2 save` — writes the current process list to `~/.pm2/dump.pm2`. **This alone does NOT survive a reboot** — it only refreshes the dump that `pm2 resurrect` reads. Resurrection on boot requires the one-time `pm2 startup systemd` (installs the `pm2-root` systemd unit that runs `pm2 resurrect` at boot). That unit **is now installed** on the droplet (done 2026-08-18), so no per-deploy action is needed; `pm2 save` here just keeps the dump current. If the droplet is ever rebuilt from scratch, re-run `pm2 startup systemd && pm2 save` once, or the bot will not come back after a reboot.

### 5. Verify

```bash
ssh root@159.89.180.146 "docker ps --format '{{.Names}}\t{{.Status}}'"
```

Expected output after a successful deploy:
- `goodgirlsbotclub-frontend-1` — **Up** (running)
- `goodgirlsbotclub-ggbc-backend-1` — **Up** (running)
- `goodgirlsbotclub-postgres-1` — **Up** (healthy)

For a deeper check, smoke-test. **`/health` must be polled, not curled once** — see the 502 note below:
```bash
ssh root@159.89.180.146 "curl -sI http://127.0.0.1:8080 | head -3
  for i in \$(seq 1 20); do
    S=\$(curl -s -o /dev/null -w '%{http_code}' https://www.goodgirlsbotclub.com/health)
    [ \"\$S\" = 200 ] && { echo \"health OK after \${i} \$([ \$i = 1 ] && echo try || echo tries)\"; break; }
    [ \$i = 20 ] && echo \"health still \$S after 60s — NOT a startup race, investigate\"
    sleep 3
  done
  curl -s https://www.goodgirlsbotclub.com/health"
```
Should return `HTTP/1.1 200 OK` for the frontend and `{"status":"ok"}` for health.

Note the `sleep` runs **on the droplet**, inside the SSH command — a foreground `sleep` in the local Bash tool is blocked, so a loop written to run locally will not work.

#### ⚠️ `/health` 502s for a few seconds after every deploy — poll, don't conclude

`docker compose up -d` returns as soon as the container *starts*, but the backend's CMD is `alembic upgrade head && uvicorn …` (gotcha #4). Until alembic finishes there is nothing listening on :8001, so the reverse proxy returns **502 Bad Gateway** — while `docker ps` cheerfully reports the container **Up**, because "Up" means the process is running, not that it is serving.

A single `curl` fired immediately after the deploy therefore reports a broken site on a perfectly good deploy. **Observed 2026-08-03**: `/health` returned the nginx 502 page 5 seconds in, and `{"status":"ok"}` on the very next check.

The distinction that matters:
- **502 that clears within ~60s** — normal startup, nothing to do.
- **502 that persists past the loop** — a real failure, and almost always a migration that did not apply. Go straight to the logs; the container will be sitting in a restart loop or stopped before uvicorn.

Confirm the backend actually reached uvicorn — this is what separates the two cases, so run it even when the poll went green on the first try:
```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && docker compose logs --tail 8 ggbc-backend"
```
Should end with `Application startup complete.` / `Uvicorn running on http://127.0.0.1:8001`. If it ends on an alembic traceback instead, see "Alembic migration failure" below.

If the intake bot was deployed, verify pm2:
```bash
ssh root@159.89.180.146 "pm2 list"
```
Expected:
- `ggbc-intake-bot` — `online`, low restart count.
- `ggbc-intake-recluster` — **`online`**, with a restart count (↺) that climbs by roughly 1 per day. It uses `cron_restart: '0 4 * * *'` (not crash-triggered `autorestart`), so pm2 deliberately restarts it once nightly at 04:00 and it shows `online` continuously between runs — it does **not** sit at `stopped`. A high-but-slowly-climbing restart count is just its age in days, not thrashing (confirmed 2026-07-21 at 95 restarts / ~95 days, and again 2026-07-31 at 105 — both healthy). To tell that apart from genuine thrashing, check the logs (see the error-handling entry below).

### 5.5. Notify intake-bot subscribers that their feature shipped

Skip this step if no web repos were deployed in this run (intake-only deploys have no user-facing feature ship).

The droplet keeps `/opt/goodgirlsbotclub/.last-deployed` as a marker. Walk the merge commits in the window since the previous deploy and DM the requester for each PR that closed an intake-linked issue.

```bash
# Read the previous deploy marker, compute merged PRs in the window, update the marker
MERGED_PRS=$(ssh root@159.89.180.146 '
  cd /opt/goodgirlsbotclub
  PREV=$(cat .last-deployed 2>/dev/null || echo "")
  CURR=$(git rev-parse HEAD)
  if [ -n "$PREV" ] && [ "$PREV" != "$CURR" ]; then
    git log "$PREV..$CURR" --merges --pretty=format:"%s" \
      | grep -oE "pull request #[0-9]+" \
      | grep -oE "[0-9]+" \
      | sort -u
  fi
  echo "$CURR" > .last-deployed
')

if [ -z "$MERGED_PRS" ]; then
  echo "no merged PRs in this deploy window (first run or no changes)"
else
  for PR in $MERGED_PRS; do
    PR_URL="https://github.com/sammygallo/goodgirlsbotclub/pull/$PR"
    ISSUES=$(gh pr view "$PR" --repo sammygallo/goodgirlsbotclub \
      --json closingIssuesReferences \
      --jq '.closingIssuesReferences[].number' 2>/dev/null)
    for ISSUE in $ISSUES; do
      echo "notifying subscribers of issue #$ISSUE (PR $PR)"
      ssh root@159.89.180.146 "cd /opt/ggbc-intake-bot && npm run notify:request-deployed -- $ISSUE $PR_URL" \
        || echo "  notify failed for #$ISSUE — non-fatal"
    done
  done
fi
```

The CLI no-ops if the GH issue isn't linked to an intake request, so PRs that came from non-intake issues (refactors, your own ideas) won't trigger noise. **First run after adding this step:** `.last-deployed` won't exist, so the whole loop is skipped — expected. Next deploy onward works normally.

### 5.6. Post a release note to `#feature-releases`

Channel: `1497283287867982104` (Discord ID — use the `mcp__ggbc-discord__post_message` tool). Run this after step 5.5 for every deploy that includes web-repo changes (skip on intake-only deploys).

**Compose the note yourself** — don't copy-paste PR titles or generated commit summaries. Subscribers in #feature-releases want **what changed and what it means for them**, not engineering jargon. The PR body's "Summary" section is good source material; rewrite it in user-facing language.

Format guidance (keep it under 2000 chars — Discord's hard limit):

- Lead with a punchy headline (`**🎯 Short attention-grabbing title**`).
- For each user-visible change: explain what it does, where to find it (settings path), trade-offs (cost, default on/off, etc.). Use Discord markdown.
- For bug fixes, say what was broken and what changed.
- Tell them how to access it ("reload the app", "Settings → Foo → Bar").

Determine what's in the deploy window from the PRs already computed in step 5.5 (`MERGED_PRS`). Read each PR's body via `gh pr view <n> --repo sammygallo/goodgirlsbotclub --json body --jq .body` to source the user-facing facts.

```bash
# Example call once the message text is ready (substitute your composed text)
mcp__ggbc-discord__post_message channel_id=1497283287867982104 content="<your release note>"
```

If the post errors with "max length", trim — don't multi-message; one message keeps the channel scannable. If the post fails for other reasons (Discord outage, etc.), report it but don't fail the deploy — the code is already live.

**When to skip the release note:**
- Intake-only deploys (no web changes shipped).
- Deploys with no user-visible impact (pure refactor, dep bumps, internal infra, docs).
- Re-deploys / "sync droplet to current branch" runs that don't include new merges.

### 5.7. Report

Report the final status to the user.

## Error handling

### Merge conflict
Stop immediately, report it, let the user resolve manually. Do NOT try to auto-resolve.

### CI failure
Do NOT deploy. Show the failing step:
```bash
gh run view <run-id> --repo <repo> --log-failed
```
Report the error and wait for the user to fix it.

**Recovery path when CI fails AFTER the merge** (the commits are on `main`, but the image didn't publish):

1. The existing feature branch is still valid — don't branch off main again.
2. Commit the fix directly on the feature branch, push:
   ```bash
   git add <fixed files> && git commit -m "fix: ..." && git push origin <feature-branch>
   ```
3. Open a NEW PR from the same branch to `main`. GitHub compares the feature branch to main, so the new PR contains only the fix commits (the previously merged ones are already on main and won't appear).
   ```bash
   gh pr create --repo sammygallo/goodgirlsbotclub --base main --head <feature-branch> --title "fix(...): ..." --body "Follow-up to #<prev-pr>"
   gh pr merge <new-pr-number> --repo sammygallo/goodgirlsbotclub --squash --delete-branch
   ```
4. Wait for CI again (step 3 of the main workflow), then deploy.

Do **not** try to `git revert` the original merge — that leaves history noisy for no benefit. A forward-fix PR is cleaner, and since CI didn't publish the broken image, nothing was ever live. **Pattern used on 2026-04-15:** PR #80 merged, CI failed, PR #81 from the same `claude/gifted-driscoll` branch shipped the fix in ~3 minutes. **Used again 2026-05-22** for the Anthropic top_p hotfix.

### `docker compose pull` reports "manifest unknown"
CI hasn't finished or it failed. Re-check:
```bash
gh run list --repo <repo> --workflow docker-publish.yml --limit 3
```
If the run is still in progress, wait for it. If it failed, see "CI failure" above. **Never deploy before CI is green.**

### `git pull` on droplet fails with "Your local changes would be overwritten"
Someone has modified a tracked file on the droplet. Do NOT blow the changes away blindly. First inspect, then use stash:

```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && git status && git diff"
# Inspect the diff, confirm with user if it's the override-file case or something new.
# If safe to pop later:
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && git stash push -m 'local' <files> && git pull origin main && git stash pop"
```

If the diff is the `ports:` line (`127.0.0.1:8080:80`), the droplet's override file has gone missing or been deleted — recreate it (see Environment gotcha #1) instead of stashing.

### Container not starting
```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && docker compose logs --tail 50 <service-name>"
```
Services are `frontend`, `ggbc-backend`, `postgres`. Report the logs to the user.

### Alembic migration failure
If the backend container won't start because `alembic upgrade head` errored, the deploy is broken until the migration is fixed. Pull the failing migration's downgrade path manually or fix-forward — never edit a migration that's already run on prod.

### Previous deploy was interrupted mid-build (legacy state)
If you SSH in and see a zombie `docker build` or `vite` process, the droplet is in the "old-way" state:
```bash
ssh root@159.89.180.146 "ps aux | grep -E 'docker build|vite|tsc|npm' | grep -v grep"
```
Kill any zombies (`kill -9 <pid>`), then retry the deploy. The droplet should never be building — always pulling.

### Intake bot: `npm ci` fails with `better-sqlite3` native rebuild error
Usually a Node version mismatch or missing build toolchain. Check:
```bash
ssh root@159.89.180.146 "node -v && which python3 && which make"
```
Node must be 20+. If the rebuild failed mid-install, a retry usually succeeds. If it persists, fall back to `npm rebuild better-sqlite3 --build-from-source`.

### Intake bot: pm2 app not starting
```bash
ssh root@159.89.180.146 "pm2 logs ggbc-intake-bot --lines 60 --nostream"
```
Common causes: missing `.env` (Discord token, Anthropic key, GitHub PAT), bad sqlite path, wrong working directory. `.env` at `/opt/ggbc-intake-bot/.env` is **not** in git — never overwrite it during deploy.

### Intake bot: `ggbc-intake-recluster` restart count / status looks wrong
Don't judge this app by restart count or `online` vs `stopped` alone — see step 5's note. The real signal is the *rate* and *content* of restarts:
```bash
ssh root@159.89.180.146 "pm2 logs ggbc-intake-recluster --lines 40 --nostream"
```
- **Healthy:** one `recluster: starting at <timestamp>` / `recluster: done in <n>s — ... errors=0` pair roughly every 24h; the only `-error-` content is harmless `@octokit/request` deprecation notices.
- **Actually thrashing:** multiple restarts within minutes/seconds of each other, or real stack traces in the error log.

`autorestart: false` must still be set alongside `cron_restart` — if it's missing, or the schedule fires more than once daily, that's the config bug to fix. If the script fails at import, fix the underlying error, then `pm2 delete ggbc-intake-recluster && pm2 start ecosystem.config.cjs --update-env`.

### Droplet is low on disk / RAM
2 GB swap is in place, but disk can fill with stale images:
```bash
ssh root@159.89.180.146 "df -h / && docker image prune -af"
```
`docker image prune -af` reclaims space from untagged / orphaned images. Safe to run routinely. (2026-07-31: 76% used, 5.8 G free.)

**Do NOT reach for `docker volume prune` or `docker system prune --volumes` when disk is tight.** The `st-data` / `st-config` volumes are dangling by design and are the only pre-migration backup — a volume prune destroys them silently. See gotcha #2. Stick to image pruning.

## CI cost tip

The docker-publish workflow triggers on every push to the default branch. For docs-only or `.gitignore`-only changes that's wasted CI time. **Note:** `[skip ci]` in a PR's commit message does NOT work with the `--merge` strategy — GitHub creates a new merge commit that doesn't inherit the tag. Options:

1. Use `--squash` or `--rebase` for docs-only PRs (preserves the commit message).
2. Add `paths-ignore` to `.github/workflows/docker-publish.yml`. **Done** — goodgirlsbotclub#349 and ggbc-backend#49. Note both are explicit allow-lists, NOT `docs/**`: three docs in the frontend are compiled into the bundle via Vite `?raw` imports (`docs/faq.md`, `docs/character-guide.md`, `docs/hypercode-guide.md`), so a blanket ignore would silently ship a stale FAQ.

#### ⚠️ Never write the skip-CI marker literally in a commit message

GitHub scans the WHOLE commit message — subject and body — for the
skip-CI marker (the `[skip` `ci]` bracket form, and its `[ci skip]` /
`[no ci]` / `[skip actions]` variants). It does not care that you were
merely *talking about* it.

Writing a commit message that discusses the marker therefore silently
suppresses every workflow for that commit. **This happened on
2026-07-31**: the commit documenting this very helper mentioned the
marker three times in prose, and CI never ran on its PR — no failure,
no warning, just an empty checks list that looks identical to "still
queued".

When a commit message needs to refer to it, break up the literal or
describe it in words ("the skip-CI marker"). And if a PR shows no checks
at all, grep its head commit message for the marker before assuming
GitHub is slow or Actions is down.
