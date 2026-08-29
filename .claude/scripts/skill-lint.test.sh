#!/usr/bin/env bash
# Tests for skill-lint.sh. Every case is a bypass a red-team actually found in
# a previous version of the lint — including two that were found in the version
# written to fix the first one. A control that cannot fail is the defect this
# whole family kept reproducing, so each case asserts a NON-ZERO exit and the
# benign cases assert zero.
#
# Runs on a copy under $TMPDIR; never touches the real SKILL.md.

set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
skill_src="$here/../skills/run-story/SKILL.md"
pass=0; fail=0

sandbox=$(mktemp -d)
mkdir -p "$sandbox/.claude/scripts" "$sandbox/.claude/skills/run-story"
cp "$here/skill-lint.sh" "$sandbox/.claude/scripts/"
cp "$skill_src" "$sandbox/.claude/skills/run-story/SKILL.md"
S="$sandbox/.claude/skills/run-story/SKILL.md"
cp "$S" "$sandbox/pristine.md"
trap 'rm -rf "$sandbox"' EXIT

t() { # t <want-exit> <label> <mutation...>
  local want=$1 label=$2; shift 2
  cp "$sandbox/pristine.md" "$S"
  eval "$@" >/dev/null 2>&1
  ( cd "$sandbox" && bash .claude/scripts/skill-lint.sh >/dev/null 2>&1 )
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "  PASS  $label"; pass=$((pass+1))
  else echo "  FAIL  $label (wanted $want, got $got)"; fail=$((fail+1)); fi
}

echo "skill-lint.sh"

# The original accident: an index-arithmetic edit boundary ate three stages.
t 1 "amputation of §6/§7/§8" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');x=p.read_text();p.write_text(x[:x.index('### 6 · QA')]+x[x.index('### 9 · DEPLOY'):])\""

# Round-2 bypasses: body damage under a surviving heading.
t 1 "all 9 escalation-trigger bullets deleted" "sed -i '' '84,92d' '$S'"
t 1 "whole §9 DEPLOY body deleted"             "sed -i '' '103,113d' '$S'"
t 1 "all 5 Hard rules deleted"                 "sed -i '' '12,16d' '$S'"
t 1 "merge-checklist items 1-3 deleted"        "sed -i '' '74,76d' '$S'"
t 1 "a single checklist line deleted"          "sed -i '' '75d' '$S'"

# Round-3 bypasses: line-count-preserving substitution.
t 1 "§9 body replaced with blank lines" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');l=p.read_text().split(chr(10));l[102:114]=['']*12;p.write_text(chr(10).join(l))\""
t 1 "§9 body replaced with same-count filler" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');l=p.read_text().split(chr(10));l[102:114]=['Deploy when ready.']*12;p.write_text(chr(10).join(l))\""
t 1 "§8's trigger header reworded away" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');p.write_text(p.read_text().replace('ESCALATION TRIGGERS','ADVISORY NOTES',1))\""

# Structural damage other than deletion.
t 1 "two stages swapped out of order" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');x=p.read_text();a=x.index('### 6 · QA');b=x.index('### 7 · PR');c=x.index('### 8 · MERGE');p.write_text(x[:a]+x[b:c]+x[a:b]+x[c:])\""
t 1 "a dangling §11 reference introduced" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');p.write_text(p.read_text()+chr(10)+'See §11 for details.'+chr(10))\""

# Must NOT fire: ordinary editing.
t 0 "benign prose reword"        "sed -i '' 's/Sanity-check the plan/Sanity check the plan/' '$S'"
t 0 "adding blank lines"         "python3 -c \"import pathlib;p=pathlib.Path('$S');p.write_text(p.read_text().replace('### 4 · BUILD','### 4 · BUILD'+chr(10)+chr(10),1))\""
t 0 "expanding a stage"          "python3 -c \"import pathlib;p=pathlib.Path('$S');p.write_text(p.read_text().replace('### 4 · BUILD','### 4 · BUILD'+chr(10)+'- an added note.',1))\""

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
