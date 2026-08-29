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
# The pipeline's own §8 warns that "a pipeline that can merge edits to its own
# rules can widen its own authority — including deleting this trigger". That is
# reachable by ACCIDENT, not just by intent, and prose cannot notice itself
# going missing. This can.
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

# 2. Load-bearing clauses that a wide edit could swallow without any heading
#    disappearing. Each of these has its own incident behind it.
must_contain=(
  "ESCALATION TRIGGERS"        # the merge gate's stop condition (#488)
  "qa-verifier"                # step 6 spawns it; no other carrier
  "an empty checks list is not a pass"   # the silent-CI incident
  "re-checked at merge time"   # a review verdict is only valid against its base
  "tree-hygiene.sh"            # the §5 gate (#486)
)
for s in "${must_contain[@]}"; do
  grep -qF "$s" "$skill" || { echo "MISSING-CLAUSE: \"$s\""; bad=1; }
done

# 3. Every §N cross-reference must resolve to a stage that exists. This is what
#    turns an amputation into a loud failure instead of a dangling pointer.
while read -r n; do
  grep -qE "^### $n · " "$skill" || { echo "DANGLING-REF: §$n has no such stage"; bad=1; }
done < <(grep -oE '§[0-9]+' "$skill" | tr -d '§' | sort -un)

[ "$bad" -eq 0 ] && { echo "VERDICT: INTACT — 10 stages in order, cross-references resolve."; exit 0; }
echo "VERDICT: STRUCTURAL DAMAGE — see above. Do not commit."
exit 1
