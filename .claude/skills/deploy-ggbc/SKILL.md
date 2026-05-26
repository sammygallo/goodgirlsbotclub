---
name: deploy-ggbc
description: "Push, merge, and deploy Good Girls Bot Club (goodgirlsbotclub) to the production droplet. Use this skill whenever the user says /deploy-ggbc, asks to 'deploy ggbc', 'push and deploy', 'update the droplet', 'ship it', or wants to merge branches and update the live server. Also trigger when the user finishes a GGBC feature and wants to get it running on the server."
---

# Deploy Good Girls Bot Club to Production

Push feature branches, merge them, wait for each repo's Docker image CI to finish, then update the live droplet with a pull-only deploy.

Both the frontend and backend images are built in GitHub Actions and pulled from GHCR. **The droplet never builds — it just `docker compose pull`s and restarts.** Deploys should take under a minute once CI is green.

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

If you see lingering `goodgirlsbotclub-sillytavern-1` or `goodgirlsbotclub-seed-owner-1`, run `docker compose up -d --remove-orphans` to clean them up. The `st-config` / `st-data` volumes may still exist as historical backups — leave them alone.

### 3. Building the frontend on the droplet is the OLD way and must never happen again

The droplet is a 1 vCPU / 1 GB box. Running `vite build` on it takes 12+ minutes and thrashes the memory budget. The skill's deploy command must **never** use `docker compose up --build`. It must always be `docker compose pull && docker compose up -d`. The image is built in GitHub Actions and pulled from GHCR.

### 4. Backend migrations run automatically on startup

The `ggbc-backend` container's CMD is `alembic upgrade head && uvicorn …`, so every deploy applies any pending alembic migrations idempotently. You don't need to run them by hand. If a migration fails the container won't reach uvicorn and the deploy will be visibly broken; check `docker compose logs ggbc-backend` immediately.

### 5. The `SECRET_ENCRYPTION_KEY` env var is critical and lives in `.env`

API secrets (Replicate keys, OpenAI keys, etc.) are Fernet-encrypted in Postgres using `SECRET_ENCRYPTION_KEY` from `/opt/goodgirlsbotclub/.env`. **Never** regenerate or change this key without re-encrypting the existing rows — every secret in the DB becomes unrecoverable. If you find the var unset on the droplet, the backend falls back to a publicly-known dev key (visible in source), which would mean every API key in the DB is decryptable by anyone reading the repo.

## Arguments

The skill accepts optional branch names as arguments:

```
/deploy-ggbc                                          # auto-detect all three repos
/deploy-ggbc claude/some-branch                       # frontend only
/deploy-ggbc - feat/some-branch                       # backend only (dash = skip frontend)
/deploy-ggbc claude/some-branch feat/some-branch      # both web repos
/deploy-ggbc intake                                   # intake bot only
```

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

#### Worktree pitfall

The frontend repo sometimes has secondary worktrees under `.claude/worktrees/<slug>/`. Branch checkout in a worktree fails with `'main' is already used by worktree at …`. Either work in the primary worktree (`/Users/sammy/Documents/GitHub/goodgirlsbotclub`) or use `git fetch && git push` without trying to checkout. **Incurred on 2026-05-26 during B3c-final** — bash session cwd drifted into the wrong worktree mid-deploy and silently dropped edits via failed `git checkout main` → fallback compound commands.

### 3. Wait for CI

Both repos build images in GitHub Actions. The droplet only pulls — it never builds — so you must wait for each repo whose code you pushed.

Get the run ID and watch it in one flow:

```bash
# Frontend
FE_RUN=$(gh run list --repo sammygallo/goodgirlsbotclub --workflow docker-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $FE_RUN --repo sammygallo/goodgirlsbotclub --exit-status

# Backend
BE_RUN=$(gh run list --repo sammygallo/ggbc-backend --workflow docker-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $BE_RUN --repo sammygallo/ggbc-backend --exit-status
```

Typical durations:
- **Frontend CI:** ~1.5–3 minutes (Vite build on GitHub runner with GHA cache)
- **Backend CI:** ~3–5 minutes (pytest + ruff + multi-arch Docker image build)

Use `run_in_background: true` on the Bash call if you want to keep working in parallel — you'll get a task-notification when it completes.

#### ⚠️ `gh run watch --exit-status` can be silently swallowed by pipes

If you pipe `gh run watch` through `tail`, `head`, or similar (which is tempting for log truncation), **the pipe's exit code (0) masks gh's non-zero exit code**. The background task will report success even though CI failed, and you'll only discover the failure if you actually read the output. Two ways to avoid this:

```bash
# Option A: ALWAYS follow the watch with an explicit conclusion check.
gh run watch $FE_RUN --repo sammygallo/goodgirlsbotclub --exit-status
CONCLUSION=$(gh run view $FE_RUN --repo sammygallo/goodgirlsbotclub --json conclusion --jq .conclusion)
echo "Conclusion: $CONCLUSION"  # Expect: success

# Option B: enable pipefail if you must pipe.
set -o pipefail
gh run watch $FE_RUN --repo sammygallo/goodgirlsbotclub --exit-status 2>&1 | tail -20
```

**Option A is the safer default** — do it every time, even when the background task says exit 0. **Incurred on 2026-04-15:** the first deploy reported "exit code 0" from a backgrounded watch + tail pipeline while CI had actually failed, only caught by reading the output.

If CI fails, stop and report the failing step:
```bash
gh run view <run-id> --repo <repo> --log-failed
```

### 4. Deploy to droplet

```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && git pull origin main && docker compose pull && docker compose up -d"
```

Pull-only deploy:
- `git pull origin main` — fetches the latest `docker-compose.yml` and any config/script changes
- `docker compose pull` — pulls the freshly-published frontend AND backend images from GHCR
- `docker compose up -d` — recreates any containers whose image changed and restarts them

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
- `pm2 save` — persists the process list so `pm2 resurrect` restores it after a reboot.

### 5. Verify

```bash
ssh root@159.89.180.146 "docker ps --format '{{.Names}}\t{{.Status}}'"
```

Expected output after a successful deploy:
- `goodgirlsbotclub-frontend-1` — **Up** (running)
- `goodgirlsbotclub-ggbc-backend-1` — **Up** (running)
- `goodgirlsbotclub-postgres-1` — **Up** (healthy)

For a deeper check, smoke-test:
```bash
ssh root@159.89.180.146 "curl -sI http://127.0.0.1:8080 | head -3 && curl -s https://www.goodgirlsbotclub.com/health"
```
Should return `HTTP/1.1 200 OK` and `{"status":"ok"}`.

If the intake bot was deployed, verify pm2:
```bash
ssh root@159.89.180.146 "pm2 list"
```
Expected:
- `ggbc-intake-bot` — `online`, low restart count.
- `ggbc-intake-recluster` — `stopped` (it runs once nightly at 04:00 then exits; that is normal).

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

### 5.6. Report

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
