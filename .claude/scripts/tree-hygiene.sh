#!/usr/bin/env bash
# Tree-hygiene gate for run-story §5 — see #486.
#
# WHY THIS IS A SCRIPT. The rule was written three times as prose and shipped
# broken three times, each version reading plausibly: a byte-clean rule that
# tripped forever on one long-lived untracked file; a baseline-diff that was
# path-level, so re-mutating an already-dirty file diffed to nothing; and an
# `--ignored=matching` probe that emits a constant and therefore can never
# fail. Prose cannot be tested. This can, and is — see tree-hygiene.test.sh,
# which plants each of those violation classes and asserts a non-zero exit.
#
# WHAT IT CHECKS, and why each is here rather than folded into another:
#   1. Modified TRACKED files, in EVERY working tree of the repo — not only
#      the one we are standing in. `git status` reports its own tree only, so
#      a story running in .claude/worktrees/<x> is blind to the main checkout,
#      which is exactly where ~/.claude/skills/deploy-ggbc/SKILL.md points and
#      where that file's own header tells an editor to write.
#   2. Untracked files against an explicit allowlist, WITH hashes. A
#      tracked-only rule leaves the repo's long-lived untracked file (the
#      handoff doc, which the INTAKE carrier sweep must be able to grep)
#      unguarded in content.
#   3. Registrations whose directory is gone, and — via the same enumeration —
#      dirt inside ignored worktree directories, which `--ignored` on the
#      parent cannot reach because it collapses at the ignored directory.
#
# Never silence a path with .gitignore to make this pass: an ignored file
# drops out of ripgrep's default traversal and silently breaks the carrier
# sweeps INTAKE and plan absorption depend on.
#
# Usage:
#   tree-hygiene.sh snapshot <baseline-file>   # before the review stage
#   tree-hygiene.sh check    <baseline-file>   # after every round, and before QA
# Exit 0 = clean. Exit 1 = violation (offending paths printed, nothing else).

set -uo pipefail

mode=${1:-}
baseline=${2:-}
if [ "$mode" != snapshot ] && [ "$mode" != check ]; then
  echo "usage: tree-hygiene.sh {snapshot|check} <baseline-file>" >&2
  exit 2
fi
[ -n "$baseline" ] || { echo "usage: tree-hygiene.sh $mode <baseline-file>" >&2; exit 2; }

git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "FAIL: not inside a git repo"; exit 1; }

violations=0
untracked_now=$(mktemp)
trap 'rm -f "$untracked_now"' EXIT

# Enumerate every working tree. `git worktree list` is the only thing that
# knows about sibling trees; a per-tree status call is the only thing that
# knows about dirt. Neither substitutes for the other.
while read -r wt; do
  if [ ! -d "$wt" ]; then
    echo "STRAY-REGISTRATION: $wt (registered, directory missing — run 'git worktree prune')"
    violations=1
    continue
  fi

  dirty=$(git --no-optional-locks -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)
  if [ -n "$dirty" ]; then
    echo "DIRTY-TRACKED: $wt"
    printf '%s\n' "$dirty" | sed 's/^/    /'
    violations=1
  fi

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    f="$wt/$rel"
    [ -f "$f" ] || continue
    # Skip our own baseline file. A PM who parks it inside the repo would
    # otherwise see the gate report the gate's own output as drift — the
    # self-inflicted false positive that made #485's version noise.
    [ "$f" -ef "$baseline" ] 2>/dev/null && continue
    printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$wt/$rel"
  done < <(git --no-optional-locks -C "$wt" status --porcelain --untracked-files=all 2>/dev/null | sed -n 's/^?? //p')
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}') | sort > "$untracked_now"

# The loop above pipes to sort, so its `violations` assignment happens in a
# subshell. Re-derive the tracked/registration verdict outside the pipe.
tracked_report=$(
  while read -r wt; do
    if [ ! -d "$wt" ]; then echo "STRAY-REGISTRATION: $wt (registered, directory missing)"; continue; fi
    d=$(git --no-optional-locks -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)
    [ -n "$d" ] && { echo "DIRTY-TRACKED: $wt"; printf '%s\n' "$d" | sed 's/^/    /'; }
  done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')
)
if [ -n "$tracked_report" ]; then
  printf '%s\n' "$tracked_report"
  violations=1
fi

if [ "$mode" = snapshot ]; then
  cp "$untracked_now" "$baseline"
  n=$(wc -l < "$baseline" | tr -d ' ')
  if [ "$violations" -ne 0 ]; then
    echo "VERDICT: DIRTY — resolve the tracked modifications above before review starts."
    echo "         A dirty starting tree is the contested-checkout condition; do not baseline over it."
    exit 1
  fi
  echo "VERDICT: CLEAN — baseline recorded ($n untracked path(s) allowlisted) at $baseline"
  exit 0
fi

[ -f "$baseline" ] || { echo "FAIL: no baseline at $baseline — run 'snapshot' before the review stage"; exit 1; }

# Untracked: a NEW path, a REMOVED one, or a CHANGED one all matter. diff on
# "<sha>  <path>" catches content drift and appearance/disappearance at once.
if ! udiff=$(diff "$baseline" "$untracked_now"); then
  echo "UNTRACKED-DRIFT (baseline → now):"
  printf '%s\n' "$udiff" | sed 's/^/    /'
  violations=1
fi

if [ "$violations" -ne 0 ]; then
  echo "VERDICT: VIOLATION — the tree is not what it was when review started."
  exit 1
fi
echo "VERDICT: CLEAN — all working trees free of tracked modifications; untracked set unchanged."
exit 0
