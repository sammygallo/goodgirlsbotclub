#!/bin/sh
# Seed an owner account on first boot via the SillyTavern API.
# Runs as a sidecar sharing ST's network namespace — calls localhost:8000
# so it is always within ST's whitelist.
#
# Required env vars: OWNER_HANDLE, OWNER_PASSWORD
# Optional env var:  OWNER_NAME (defaults to OWNER_HANDLE)
#
# Sentinel file in the st-config volume prevents re-seeding on restart.

set -e

SENTINEL="/config/.owner-seeded"
# Use 127.0.0.1 (not localhost) — busybox wget resolves `localhost` to
# IPv6 ::1 first, and ST listens on IPv4 only, so the localhost form
# fails with "connection refused" on environments whose /etc/hosts
# resolves localhost to both ::1 and 127.0.0.1 (Docker Desktop on Mac).
ST="http://127.0.0.1:${ST_PORT:-8000}"

# Skip if already seeded or env vars not set
if [ -f "$SENTINEL" ]; then
  echo "[seed-owner] Already seeded, skipping"
  exit 0
fi

if [ -z "$OWNER_HANDLE" ] || [ -z "$OWNER_PASSWORD" ]; then
  echo "[seed-owner] OWNER_HANDLE/OWNER_PASSWORD not set, skipping"
  exit 0
fi

# seed-owner connects directly to ST on localhost:8000 (same network namespace),
# bypassing nginx. If enableForwardedWhitelist is true in a stale config, ST
# checks X-Forwarded-For instead of the direct TCP IP — so we send it explicitly.
# This header cannot be spoofed since ST's port is never exposed externally.
WGET="wget -q --header=X-Forwarded-For:127.0.0.1"

echo "[seed-owner] Waiting for SillyTavern to be ready..."
for i in $(seq 1 60); do
  if $WGET -O /dev/null "$ST/csrf-token" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[seed-owner] Timed out waiting for SillyTavern"
    exit 1
  fi
  sleep 2
done

# Grab CSRF token
CSRF=$($WGET -O- "$ST/csrf-token" | sed 's/.*"token":"\([^"]*\)".*/\1/')
if [ -z "$CSRF" ]; then
  echo "[seed-owner] Could not get CSRF token"
  exit 1
fi

# Login as default-user (auto-created admin, no password)
LOGIN=$($WGET -O- \
  --header="Content-Type: application/json" \
  --header="X-CSRF-Token: $CSRF" \
  --post-data='{"handle":"default-user","password":""}' \
  --save-cookies=/tmp/st-cookies.txt \
  --keep-session-cookies \
  "$ST/api/users/login" 2>/dev/null) || true

if ! echo "$LOGIN" | grep -q '"handle"'; then
  echo "[seed-owner] Could not log in as default-user: $LOGIN"
  exit 1
fi

# Refresh CSRF token after login
CSRF=$($WGET -O- \
  --load-cookies=/tmp/st-cookies.txt \
  "$ST/csrf-token" | sed 's/.*"token":"\([^"]*\)".*/\1/')

OWNER_NAME="${OWNER_NAME:-$OWNER_HANDLE}"

# Create the owner account. The backend uses permission groups as the source
# of truth; the { admin, role } shape is still accepted for backward compat
# but we send the new groupId shape to stay current. The owner-default group
# is guaranteed to exist after the server-side migration runs on first boot.
CREATE=$($WGET -O- \
  --header="Content-Type: application/json" \
  --header="X-CSRF-Token: $CSRF" \
  --post-data="{\"handle\":\"$OWNER_HANDLE\",\"name\":\"$OWNER_NAME\",\"password\":\"$OWNER_PASSWORD\",\"groupId\":\"owner-default\"}" \
  --load-cookies=/tmp/st-cookies.txt \
  "$ST/api/users/create" 2>/dev/null) || true

if echo "$CREATE" | grep -q '"handle"'; then
  echo "[seed-owner] Owner account '$OWNER_HANDLE' created"
  touch "$SENTINEL"
else
  echo "[seed-owner] Failed to create owner account: $CREATE"
  exit 1
fi

# Logout default-user
$WGET -O /dev/null \
  --header="Content-Type: application/json" \
  --header="X-CSRF-Token: $CSRF" \
  --post-data='{}' \
  --load-cookies=/tmp/st-cookies.txt \
  "$ST/api/users/logout" 2>/dev/null || true

echo "[seed-owner] Done"
