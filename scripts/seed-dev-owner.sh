#!/usr/bin/env bash
#
# Seed (or repair) the evergreen local-dev owner account.
#
# Why this exists: ggbc-backend's first-boot bootstrap only seeds the
# OWNER_HANDLE/OWNER_PASSWORD owner when the database has ZERO users
# (app/main.py:_bootstrap_owner). Once any test user exists, the bootstrap is
# skipped, so a stable owner never gets created on a populated dev DB. This
# script creates it directly using the backend's own User model + password
# hasher, and is idempotent — re-run it anytime the owner goes missing.
#
# Credentials are a NON-SECRET local-dev fixture (see .env / .env.example):
#   handle:   dev
#   password: devpassword
#   role:     owner
#
# Requires the dev stack to be running:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
#
# Usage:
#   ./scripts/seed-dev-owner.sh
#
set -euo pipefail

# Pull the values from .env so this stays in lockstep with the bootstrap that
# recreates the same owner on a fresh/empty DB.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLE="$(grep -E '^OWNER_HANDLE=' "$ROOT/.env" | cut -d= -f2- || true)"
PASSWORD="$(grep -E '^OWNER_PASSWORD=' "$ROOT/.env" | cut -d= -f2- || true)"
DISPLAY="$(grep -E '^OWNER_NAME=' "$ROOT/.env" | cut -d= -f2- || true)"
HANDLE="${HANDLE:-dev}"
PASSWORD="${PASSWORD:-devpassword}"
DISPLAY="${DISPLAY:-Dev User}"

docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.dev.yml" \
  exec -T ggbc-backend \
  env SEED_HANDLE="$HANDLE" SEED_PASSWORD="$PASSWORD" SEED_DISPLAY="$DISPLAY" \
  python -c '
import asyncio, os
from sqlalchemy import select
from app.db import SessionLocal
from app.models import User
from app.security.passwords import hash_password, verify_password
from app.security.permissions import OWNER_GROUP_ID
from app.security.roles import OWNER

HANDLE = os.environ["SEED_HANDLE"].lower()
PW = os.environ["SEED_PASSWORD"]
DISPLAY = os.environ["SEED_DISPLAY"]

async def main():
    async with SessionLocal() as db:
        u = await db.scalar(select(User).where(User.handle == HANDLE))
        if u:
            u.role = OWNER; u.group_id = OWNER_GROUP_ID
            u.password_hash = hash_password(PW)
            if not u.display_name: u.display_name = DISPLAY
            if not u.name: u.name = HANDLE
            action = "updated existing"
        else:
            u = User(handle=HANDLE, display_name=DISPLAY, name=HANDLE,
                     password_hash=hash_password(PW), role=OWNER, group_id=OWNER_GROUP_ID)
            db.add(u); action = "created"
        await db.commit()
        u2 = await db.scalar(select(User).where(User.handle == HANDLE))
        ok = verify_password(u2.password_hash, PW)
        print(f"{action} owner: handle={u2.handle} role={u2.role} password_valid={ok}")

asyncio.run(main())
'
