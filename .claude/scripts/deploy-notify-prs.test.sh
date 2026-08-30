#!/usr/bin/env bash
# Tests for deploy-notify-prs.sh.
#
# Case 1 is the whole reason this script exists: it plants a squash merge, the
# only kind /deploy-ggbc step 2 produces, and asserts the PR is found. Run it
# against the OLD inline pipeline (`git log --merges | grep "pull request #"`)
# and it fails — which is the point. A test that cannot go red is not a test.
#
# Cases 3-5 are the safety half. This list feeds DMs to real subscribers, so a
# false positive messages people about a feature they never requested; each
# plants a subject that merely LOOKS like a PR reference and asserts silence.
#
# Runs entirely in a throwaway repo under $TMPDIR — never against the real one.

set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/deploy-notify-prs.sh"
pass=0; fail=0

setup() {
  root=$(mktemp -d)
  cd "$root" || exit 1
  git init -q .
  git config user.email t@t; git config user.name t
  git commit -q --allow-empty -m "init"
  BASE=$(git rev-parse HEAD)
}

commit() { git commit -q --allow-empty -m "$1"; }

# check <name> <expected-stdout> <expected-exit>
check() {
  local name="$1" want="$2" want_rc="$3"
  local got rc
  got=$("$SCRIPT" "$BASE" HEAD "$root" 2>/dev/null); rc=$?
  if [ "$got" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then
    pass=$((pass+1)); echo "  ok   — $name"
  else
    fail=$((fail+1))
    echo "  FAIL — $name"
    echo "         want rc=$want_rc out=[$want]"
    echo "         got  rc=$rc out=[$got]"
  fi
}

echo "deploy-notify-prs.sh"

# 1. THE REGRESSION THAT MOTIVATED THIS. A squash merge is single-parent and
#    its subject ends in (#N). The old --merges pipeline saw zero of these.
setup
commit "E2-S5 blocked at intake: correct the falsified premise (#496)"
check "finds a squash merge (old --merges pipeline found none)" "496" 0

# 2. True merge commits must not regress — --admin merges and any future
#    change away from squash still have to notify.
setup
commit "Merge pull request #123 from sammygallo/claude/some-branch"
check "still finds a true merge-commit subject" "123" 0

# 3. FALSE POSITIVE: (#N) mid-subject is prose, not a PR reference. Unanchored
#    matching would DM the subscribers of PR 99 about an unrelated parser fix.
setup
commit "fix: handle (#99) case in the parser"
check "ignores (#N) that is not at end of subject" "" 0

# 4. FALSE POSITIVE: a bare issue reference is not a merge.
setup
commit "fix: stop the flicker, fixes #12"
check "ignores a bare #N issue reference" "" 0

# 5. FALSE POSITIVE: version numbers and digits generally.
setup
commit "chore: bump tooling to 1.2.3 and drop node 18"
check "ignores unrelated digits" "" 0

# 6. Several PRs in one window, deduped and ascending — a deploy window is
#    normally more than one merge.
setup
commit "feat: b (#20)"
commit "feat: a (#3)"
commit "docs: repeat of the same PR (#20)"
commit "Merge pull request #7 from sammygallo/x"
check "dedupes and sorts numerically" "$(printf '3\n7\n20')" 0

# 7. A quiet window must exit ZERO with no output. grep exits 1 when it
#    matches nothing, so under `set -o pipefail` this is exactly where a
#    careless implementation turns every docs-only deploy into a hard failure.
setup
commit "docs(agent-team): ledger row"
check "empty result exits 0, not grep's 1" "" 0

# 8. ...and a window with no commits at all.
setup
check "empty commit range exits 0" "" 0

# 9. An unknown sha must FAIL LOUDLY. Returning empty here would be
#    indistinguishable from case 7 — which is precisely how the original
#    defect stayed invisible for months.
setup
commit "feat: thing (#42)"
out=$("$SCRIPT" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" HEAD "$root" 2>/dev/null); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$out" ]; then
  pass=$((pass+1)); echo "  ok   — unknown sha exits non-zero, not empty-success"
else
  fail=$((fail+1)); echo "  FAIL — unknown sha should exit non-zero (rc=$rc out=[$out])"
fi

# 10. Not a git repo.
notrepo=$(mktemp -d)
"$SCRIPT" "$BASE" HEAD "$notrepo" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  pass=$((pass+1)); echo "  ok   — non-repo directory exits non-zero"
else
  fail=$((fail+1)); echo "  FAIL — non-repo directory should exit non-zero"
fi

# 11. Argument arity.
"$SCRIPT" only-one-arg >/dev/null 2>&1
if [ $? -ne 0 ]; then
  pass=$((pass+1)); echo "  ok   — wrong argument count exits non-zero"
else
  fail=$((fail+1)); echo "  FAIL — wrong argument count should exit non-zero"
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
