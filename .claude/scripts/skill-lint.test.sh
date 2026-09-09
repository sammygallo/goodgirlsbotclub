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

# Line-addressed mutations were the original shape of these cases, and they rot:
# every absolute number below pointed at different content the moment SKILL.md
# grew (measured 2026-09-09 — a batch of §5 edits shifted the file and "a single
# checklist line deleted" started passing a lint that no longer saw a deletion,
# while five sibling cases silently began mutating the wrong lines and asserting
# nothing). `del_at` addresses by CONTENT: find the line holding the anchor, cut
# N lines from there. A missing anchor is a hard error, so a rename fails the
# suite instead of quietly disarming a case.
del_at() { # del_at <file> <anchor-substring> <count>
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys, pathlib
path, anchor, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
p = pathlib.Path(path); lines = p.read_text().split("\n")
hits = [i for i, l in enumerate(lines) if anchor in l]
if not hits:
    sys.exit(f"del_at: anchor not found: {anchor!r}")
i = hits[0]
del lines[i:i + count]
p.write_text("\n".join(lines))
PYEOF
}

replace_at() { # replace_at <file> <anchor-substring> <count> <filler>
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import sys, pathlib
path, anchor, count, filler = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
p = pathlib.Path(path); lines = p.read_text().split("\n")
hits = [i for i, l in enumerate(lines) if anchor in l]
if not hits:
    sys.exit(f"replace_at: anchor not found: {anchor!r}")
i = hits[0]
lines[i:i + count] = [filler] * count
p.write_text("\n".join(lines))
PYEOF
}

echo "skill-lint.sh"

# The original accident: an index-arithmetic edit boundary ate three stages.
t 1 "amputation of §6/§7/§8" \
  "python3 -c \"import pathlib;p=pathlib.Path('$S');x=p.read_text();p.write_text(x[:x.index('### 6 · QA')]+x[x.index('### 9 · DEPLOY'):])\""

# Round-2 bypasses: body damage under a surviving heading.
t 1 "all 9 escalation-trigger bullets deleted" "del_at '$S' '- **Vision divergence.**' 9"
t 1 "whole §9 DEPLOY body deleted"             "del_at '$S' '**This gate did not move.**' 11"
t 1 "all 5 Hard rules deleted"                 "del_at '$S' '- **You may MERGE a story PR yourself' 5"
t 1 "merge-checklist items 1-3 deleted"        "del_at '$S' '1. Every AC verified with evidence' 3"
t 1 "a single checklist line deleted"          "del_at '$S' '2. Every **confirmed** review finding' 1"

# Round-3 bypasses: line-count-preserving substitution.
t 1 "§9 body replaced with blank lines" \
  "replace_at '$S' '**This gate did not move.**' 12 ''"
t 1 "§9 body replaced with same-count filler" \
  "replace_at '$S' '**This gate did not move.**' 12 'Deploy when ready.'"
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

# The floors are documented as "EXACT current NON-BLANK sizes, no slack", and
# that is load-bearing: any slack is content a wide edit can eat with the lint
# still reporting INTACT. Nothing checked it, and it rotted immediately — the
# 2026-09-09 batch grew §5 by 12 lines and §10 by 6 without raising either
# floor, so every rule it added was deletable under a green lint. This pins the
# invariant: floor MUST equal actual on the pristine file.
{
  cp "$sandbox/pristine.md" "$S"
  mismatch=""
  names=("1 · INTAKE" "2 · BRIEF" "3 · PLAN" "4 · BUILD" "5 · REVIEW" "6 · QA" "7 · PR" "8 · MERGE" "9 · DEPLOY" "10 · CLOSE")
  declared=$(sed -n 's/^declare -a floor_min=(\([^)]*\)).*/\1/p' "$here/skill-lint.sh")
  read -r -a floors <<< "$declared"
  for i in "${!names[@]}"; do
    n=$(awk -v want="### ${names[$i]}" 'index($0, want)==1 {inb=1; next} /^### / {inb=0} inb && NF {c++} END {print c+0}' "$S")
    [ "$n" -ne "${floors[$i]}" ] && mismatch="$mismatch §${names[$i]}(floor=${floors[$i]} actual=$n)"
  done
  if [ -z "$mismatch" ]; then echo "  PASS  every stage floor equals its actual size (no slack)"; pass=$((pass+1))
  else echo "  FAIL  stage floors have slack —$mismatch"; echo "        raise floor_min in skill-lint.sh to match, in the SAME commit"; fail=$((fail+1)); fi
}

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
