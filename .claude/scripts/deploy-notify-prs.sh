#!/usr/bin/env bash
# Extract the PR numbers merged in a deploy window, for /deploy-ggbc step 5.5.
#
# WHY THIS IS A SCRIPT. Step 5.5 used to do this inline, inside an ssh
# heredoc, as:
#
#     git log "$PREV..$CURR" --merges --pretty=format:"%s" | grep -oE "pull request #[0-9]+"
#
# which could not see a single one of this project's merges. `--merges` keeps
# only commits with 2+ parents, and step 2 of that same skill mandates
# `gh pr merge --squash`, which produces a ONE-parent commit whose subject is
# `<title> (#N)` — never "Merge pull request #N from ...". So the loop found
# nothing, every time, and its failure was silent in the worst way: an empty
# PR list is indistinguishable from "no intake-linked features shipped", which
# is the common and expected case. Nobody was ever notified, and nobody could
# tell. Found during E2-S5's postmortem sweep (2026-08-30); recorded once in
# the E2-S2a ledger row before that and carried forward unfixed.
#
# It is a script rather than corrected prose for the reason #494 settled: a
# rule that cannot be executed cannot be tested, and this project has now
# shipped four prose versions of a shell gate that each read plausibly and
# each were broken. See deploy-notify-prs.test.sh, which plants the
# squash-blind case and the false-positive cases below and asserts on each.
#
# WHAT IT MATCHES, and why each is anchored:
#   1. `^Merge pull request #N` — a true merge commit. Kept so that turning
#      squash off, or an --admin merge, does not silently regress this.
#   2. `(#N)$` — GitHub's squash subject, anchored to END OF LINE.
#
# The end anchor on (2) is load-bearing, not tidiness. This list feeds DMs to
# real subscribers, so a false positive messages the wrong people about a
# feature they never asked for. An unanchored `\(#[0-9]+\)` also matches
# `fix: handle (#99) case in the parser`, where 99 is prose, not a PR. The
# anchor is what makes "looks like a PR reference" mean "is one".
#
# Deliberately PURE: it reads git and prints numbers. No ssh, no gh, no DMs.
# That is what lets the tests run offline against a throwaway repo, and it is
# why the caller — not this script — owns the marker file and the side effects.
#
# Usage:
#   deploy-notify-prs.sh <prev-sha> <curr-sha> [repo-dir]
#
# Prints one PR number per line, ascending, deduped. Empty output (exit 0)
# when the window holds no PR merges — the normal case for a docs-only deploy.
# Exits non-zero only when it cannot answer: bad arguments, not a repo, or a
# sha the repo does not have.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: deploy-notify-prs.sh <prev-sha> <curr-sha> [repo-dir]" >&2
  exit 2
fi

PREV="$1"
CURR="$2"
REPO_DIR="${3:-.}"

cd "$REPO_DIR" || { echo "deploy-notify-prs: cannot cd to '$REPO_DIR'" >&2; exit 2; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "deploy-notify-prs: '$REPO_DIR' is not a git repository" >&2
  exit 2
fi

# Fail loudly on an unknown sha rather than returning an empty list. An empty
# list is the ordinary "nothing shipped" answer, so it must never double as
# "the marker pointed at a commit this checkout has never fetched" — that is
# precisely how the old pipeline's failure hid.
for sha in "$PREV" "$CURR"; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "deploy-notify-prs: '$sha' is not a commit in this repo (fetch first?)" >&2
    exit 3
  fi
done

# tformat (not format) so EVERY subject is newline-terminated, including the
# last — with `format:` the final subject has no trailing newline, and a
# terminating grep can drop it depending on implementation.
#
# Taken in two steps on purpose. `git log` gets its own line so that a genuine
# failure (an unreachable range) still trips `set -e` and is reported. The
# grep chain that follows is then allowed to "fail" via `|| true`, because
# grep exits 1 when it simply matches nothing — and matching nothing is this
# script's documented, ordinary answer for a docs-only deploy window. Folding
# both into one `set -o pipefail` pipeline would turn every quiet deploy into
# a non-zero exit; folding in a blanket `|| true` would swallow the real
# failure too. The tests cover both halves.
subjects=$(git log "${PREV}..${CURR}" --pretty=tformat:'%s')

printf '%s\n' "$subjects" \
  | grep -oE '(^Merge pull request #[0-9]+|\(#[0-9]+\)$)' \
  | grep -oE '[0-9]+' \
  | sort -un \
  || true
