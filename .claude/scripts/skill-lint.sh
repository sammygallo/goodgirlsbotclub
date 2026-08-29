#!/usr/bin/env bash
# Structural lint for run-story's SKILL.md — see #486.
#
# WHY THIS EXISTS. On 2026-08-29 a scripted edit to §5 used an index-arithmetic
# boundary to find "the next bullet" and swallowed 33 lines instead of 9,
# silently deleting **§6 QA, §7 PR and §8 MERGE** — the whole merge checklist
# and the ESCALATION TRIGGERS header — from a commit whose message described
# only a tree-hygiene change. The diffstat read "5 insertions, 29 deletions"
# and nothing failed. A red-team caught it; nothing in the repo would have.
#
# WHAT THIS IS AND IS NOT. It detects ACCIDENTS — a wide edit that eats content
# nobody meant to remove. It is NOT an integrity boundary: anyone who can invert
# §8 can edit this file in the same commit, and a same-length reword that guts
# meaning while keeping every guarded phrase will pass. Do not treat a green
# verdict as review. The control for intent is §8's governance trigger, which
# routes every change to these files to Sammy; the control for accidents is
# this, plus reading your own diff — which is what would have caught the
# 2026-08-29 amputation and did not, because nobody looked.
#
# Run it after any edit to SKILL.md. Exit 0 = intact, 1 = structural damage.

set -uo pipefail
skill="$(cd "$(dirname "$0")/.." && pwd)/skills/run-story/SKILL.md"
[ -f "$skill" ] || { echo "FAIL: cannot find $skill"; exit 1; }
bad=0

# 1. Every pipeline stage must be present, in order. The numbers are the
#    contract every cross-reference in this file and the charter relies on.
expected=("### 1 · INTAKE" "### 2 · BRIEF" "### 3 · PLAN" "### 4 · BUILD" \
          "### 5 · REVIEW" "### 6 · QA" "### 7 · PR" "### 8 · MERGE" \
          "### 9 · DEPLOY" "### 10 · CLOSE")
prev=0
for want in "${expected[@]}"; do
  line=$(grep -n -F "$want" "$skill" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then
    echo "MISSING-STAGE: $want"; bad=1; continue
  fi
  if [ "$line" -le "$prev" ]; then echo "OUT-OF-ORDER: $want"; bad=1; fi
  prev=$line
done

# 2. SIZE FLOOR PER STAGE — the general net, and the one that matters most.
#    Named-string checks are whack-a-mole: the first version of this lint
#    guarded the string "ESCALATION TRIGGERS" but not one trigger bullet, so
#    deleting all nine bullets while leaving the header printed INTACT — and
#    the resulting file read "any one fires, you STOP" immediately followed by
#    "If nothing fires: merge it", i.e. nothing can fire and everything merges.
#    A floor catches ANY wide deletion, including ones nobody thought to name.
#    Counts NON-BLANK lines: the first version counted every line, so replacing
#    a stage's body with an equal number of blank lines passed clean — the whole
#    §9 DEPLOY stage could be blanked and the lint still said INTACT.
#    Floors are the EXACT current body sizes, deliberately with no slack —
#    the first version left a few lines of headroom and three checklist items
#    could be deleted inside it. Deliberately shortening a stage is fine: lower
#    its floor in the SAME commit, which makes every shrink explicit and
#    reviewable instead of silent.
declare -a floor_name=("1 · INTAKE" "2 · BRIEF" "3 · PLAN" "4 · BUILD" "5 · REVIEW" \
                       "6 · QA" "7 · PR" "8 · MERGE" "9 · DEPLOY" "10 · CLOSE")
declare -a floor_min=(5 12 8 1 5 1 2 22 8 17)   # EXACT current NON-BLANK sizes, no slack:
i=0
for name in "${floor_name[@]}"; do
  n=$(awk -v want="### $name" '
        index($0, want)==1 {inb=1; next}
        /^### / {inb=0}
        inb && NF {c++}
        END {print c+0}' "$skill")
  if [ "$n" -lt "${floor_min[$i]}" ]; then
    echo "STAGE-SHRANK: §$name has $n body lines, floor is ${floor_min[$i]} — a wide edit may have eaten content."
    echo "              If the shrink is intentional, lower the floor in this script in the SAME commit."
    bad=1
  fi
  i=$((i+1))
done

# 3. Named clauses with their own incident behind them. These are the ones a
#    floor alone could miss, because a same-length reword would pass it.
must_contain=(
  "ESCALATION TRIGGERS"                  # the merge gate's stop condition (#488)
  "Vision divergence"                    # trigger 1 — deleting the bullets, not the header
  "Safety red line"                      # trigger 2
  "Hard to reverse"                      # trigger 3
  "governs, gates, builds, tests, or ships"   # the governance trigger, which stops self-widening
  "NEVER deploy without Sammy"           # the one authority that did not move
  "qa-verifier"                          # step 6 spawns it; no other carrier
  "an empty checks list is not a pass"   # the silent-CI incident
  "re-checked at merge time"             # a review verdict is only valid against its base
  "tree-hygiene.sh"                      # the §5 gate (#486)
  "WIP limit"                            # a Hard rule; the whole block was deletable before
)
for s in "${must_contain[@]}"; do
  grep -qF "$s" "$skill" || { echo "MISSING-CLAUSE: \"$s\""; bad=1; }
done

# 3a. STAGE-ANCHORED clauses. The list above is a file-global grep, so a string
#     can satisfy it from the wrong section entirely: "NEVER deploy without
#     Sammy" matched the Hard rules at the top of the file, which meant §9
#     DEPLOY had no named coverage at all and its whole body could be replaced
#     with same-length filler. These assert the phrase is inside THAT stage.
check_in_stage() { # <stage-prefix> <phrase>
  local body
  body=$(awk -v want="### $1" 'index($0,want)==1{inb=1;next} /^### /{inb=0} inb' "$skill")
  printf '%s' "$body" | grep -qF "$2" || { echo "MISPLACED-CLAUSE: §$1 does not contain \"$2\""; bad=1; }
}
check_in_stage "9 · DEPLOY"  "no equivalent marker"      # the backend window gap
check_in_stage "9 · DEPLOY"  "enumerate everything it would ship"
check_in_stage "8 · MERGE"   "ESCALATION TRIGGERS"
check_in_stage "8 · MERGE"   "governs, gates, builds, tests, or ships"
check_in_stage "5 · REVIEW"  "tree-hygiene.sh"

# 3b. The regions inside no `### N` stage — the Hard rules above §1 and the
#     trailing variant/tier sections — had no floor at all, so the entire
#     Hard-rules block (incl. the deploy authority and the WIP limit) could be
#     deleted with every other check green.
pre=$(awk '/^### 1 · INTAKE/{exit} NF{c++} END{print c+0}' "$skill")
[ "$pre" -lt 13 ] && { echo "PREAMBLE-SHRANK: $pre non-blank lines before §1, floor 13 (Hard rules live here)."; bad=1; }
post=$(awk '/^## Design-story variant/{p=1} p && NF{c++} END{print c+0}' "$skill")
[ "$post" -lt 4 ] && { echo "TAIL-SHRANK: $post non-blank lines from the design-story variant on, floor 4."; bad=1; }

# 4. Every §N cross-reference must resolve to a stage that exists. This is what
#    turns an amputation into a loud failure instead of a dangling pointer.
while read -r n; do
  grep -qE "^### $n · " "$skill" || { echo "DANGLING-REF: §$n has no such stage"; bad=1; }
done < <(grep -oE '§[0-9]+' "$skill" | tr -d '§' | sort -un)

[ "$bad" -eq 0 ] && { echo "VERDICT: INTACT — 10 stages in order, cross-references resolve."; exit 0; }
echo "VERDICT: STRUCTURAL DAMAGE — see above. Do not commit."
exit 1
