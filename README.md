# Good Girls Bot Club

A mobile-first AI character chat app. React + Vite + Tailwind frontend, FastAPI + Postgres backend, multi-provider LLM routing. Character cards follow the open v2/v3 PNG spec, so cards from the broader community ecosystem work as-is.

## First-Time Admin Setup

After a fresh installation, no real users exist yet. The first person to register becomes the **owner** automatically — no manual credential setup required.

### Steps

1. **Open the app** — you will be redirected to the login page.
2. **Click "Create an account"** (visible at the bottom of the login form when no real users exist).
3. **Fill in the registration form:**
   - **Username** — at least 3 characters; letters, numbers, `_`, and `-` only.
   - **Display Name** — your visible name inside the app.
   - **Password** — optional, but recommended (minimum 4 characters if set).
4. **Submit** — the app creates your account with the **owner** role and full admin privileges, then signs you in.
5. The "Create an account" link disappears for future visitors — further registrations require an admin invite.

> **Note:** If the "Create an account" link is not visible, a real user already exists. Log in with that account or ask the existing admin to invite you.

### Role Hierarchy

| Role | Level | Description |
|------|-------|-------------|
| `end_user` | 0 | Read-only / limited access |
| `contributor` | 1 | Standard user |
| `admin` | 2 | Administrative access |
| `owner` | 3 | Full control (first registrant) |

Roles are a deprecated shim over the permission-group system — see the Permission Groups page in admin for fine-grained control.

---

## Local development (full stack)

Runs the production-style backend in Docker plus Vite dev for the frontend with HMR. Requires Docker Desktop and a local checkout of [ggbc-backend](https://github.com/sammygallo/ggbc-backend) (defaults to `../ggbc-backend`; override with `GGBC_BACKEND_PATH`).

```bash
cp .env.example .env       # one-time
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
npm install                # one-time
npm run dev
```

- Frontend with HMR: http://localhost:3000
- ggbc-backend API: http://localhost:8001 (Vite proxies `/auth`, `/sync`, `/blobs`, `/invitations`, `/health`, `/api`, `/characters`, `/chats`, `/scripts` to this)
- Postgres: localhost:5432 (`psql -h 127.0.0.1 -U ggbc`)

The dev overlay (`docker-compose.dev.yml`) flips `COOKIE_SECURE` off so cookies work over HTTP localhost and enables self-registration so you can create test users without an invite. First-boot bootstrap creates the owner from `OWNER_HANDLE`/`OWNER_PASSWORD` in `.env`.

### Backend changes

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build ggbc-backend
```

### Frontend-only

If you don't need the backend stack (e.g. styling tweaks), `npm run dev` alone works — fetches will 404 but the UI renders. `GGBC_BACKEND=http://...` overrides the proxy target if you want to point at a remote backend.

## Build

```bash
npm run build
```

## Architecture

GGBC is a standalone full-stack app. Compatibility with the open character-card ecosystem (v2/v3 PNG spec, the STscript slash-command language, the extension SDK shape used by Live2d and friends) is preserved by design, but the runtime is entirely ours:

- **Frontend** — React SPA, mobile-first chat UX, Zustand stores synced cross-device via the backend.
- **Backend** ([sammygallo/ggbc-backend](https://github.com/sammygallo/ggbc-backend)) — FastAPI, owns auth, characters, chats, sync, blobs, secrets, multi-provider LLM generation (OpenAI-compatible, Anthropic, …), users, permissions, settings, live-portrait generation (Replicate), and extension serving.
- **Storage** — Postgres for relational data + per-user encrypted secrets, `user_blobs` (bytea) for character art, expression sprites, live-portrait MP4s, and per-user extension files.
