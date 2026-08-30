#!/usr/bin/env bash
# Tests for tree-hygiene.sh. Each case plants a violation class that a PREVIOUS
# version of this gate let through (#486 records all three), plus the two the
# 2026-08-29 red-team proved against version four. A gate that cannot fail is
# not a gate, so every case asserts a NON-ZERO exit and the clean case asserts
# zero.
#
# Runs entirely in a throwaway repo under $TMPDIR — never against the real one.

set -uo pipefail
GATE="$(cd "$(dirname "$0")" && pwd)/tree-hygiene.sh"
pass=0; fail=0

setup() {
  root=$(mktemp -d)
  git init -q "$root"
  cd "$root" || exit 1
  git config user.email t@t; git config user.name t
  mkdir -p .claude
  printf 'worktrees/\n' > .claude/.gitignore
  printf 'export const guard = true;\n' > src.ts
  git add src.ts .claude/.gitignore
  git commit -qm init
  base="$root/baseline.txt"
}
teardown() { cd /; rm -rf "$root"; }

expect() { # expect <want-exit> <label>
  local want=$1 label=$2 got
  "$GATE" check "$base" >/dev/null 2>&1; got=$?
  if [ "$got" -eq "$want" ]; then echo "  PASS  $label"; pass=$((pass+1))
  else echo "  FAIL  $label (wanted exit $want, got $got)"; fail=$((fail+1)); fi
}

echo "tree-hygiene.sh"

# 1. Clean tree stays clean — guards against a gate that always fires (#485's
#    noise failure, which got waved through every round).
setup; "$GATE" snapshot "$base" >/dev/null 2>&1; expect 0 "clean tree passes"; teardown

# 2. In-place mutation of a tracked file — the E1-S1 class.
setup; "$GATE" snapshot "$base" >/dev/null 2>&1
printf 'export const guard = false;\n' > src.ts
expect 1 "tracked in-place mutation caught"; teardown

# 3. Re-mutation of an ALREADY-dirty file — version four's baseline-diff was
#    path-level and reported an identical porcelain line, so this was invisible.
setup
printf 'dirty\n' >> src.ts                      # dirty BEFORE the snapshot
"$GATE" snapshot "$base" >/dev/null 2>&1        # snapshot must itself refuse
snap=$?
printf 'dirtier\n' >> src.ts
if [ "$snap" -ne 0 ]; then echo "  PASS  dirty tree refuses to become a baseline"; pass=$((pass+1));
else echo "  FAIL  dirty tree was accepted as a baseline"; fail=$((fail+1)); fi
expect 1 "re-mutation of an already-dirty file caught"; teardown

# 4. Mutation inside a linked worktree — version four ran one status call and
#    was blind to sibling trees; this is the live instance the red-team found.
setup
git worktree add -q "$root/wt" -b side
"$GATE" snapshot "$base" >/dev/null 2>&1
printf 'export const guard = false;\n' > "$root/wt/src.ts"
expect 1 "mutation in a sibling worktree caught"; teardown

# 5. Stray untracked file appearing mid-review.
setup; "$GATE" snapshot "$base" >/dev/null 2>&1
printf 'junk\n' > stray.md
expect 1 "new untracked file caught"; teardown

# 6. CONTENT change to an allowlisted untracked file — a tracked-only rule
#    leaves this open, and the file it lands on is the handoff doc.
setup
printf 'handoff v1\n' > HANDOFF.md               # present at snapshot => allowlisted
"$GATE" snapshot "$base" >/dev/null 2>&1
printf 'handoff v2 — silently rewritten\n' > HANDOFF.md
expect 1 "content drift in an allowlisted untracked file caught"; teardown

# 7. Registration whose directory was removed by hand.
setup
git worktree add -q "$root/wt2" -b side2
"$GATE" snapshot "$base" >/dev/null 2>&1
rm -rf "$root/wt2"
expect 1 "stray registration caught"; teardown

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
