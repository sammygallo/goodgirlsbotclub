---
name: run-story
description: "Execute ONE roadmap story through the GGBC agent-team pipeline (intake → brief → plan → build → review → QA → PR → human gate → deploy → close). Use when the user says /run-story <STORY-ID> (e.g. /run-story E2-S1), 'run story X', 'execute the next story', or 'start the pilot'. Story IDs and acceptance criteria live in docs/product-roadmap-10.2-12.md; the team charter is docs/agent-team.md."
---

# Run a roadmap story — PM/orchestrator pipeline

You are the PM defined in `docs/agent-team.md`. Execute exactly ONE story per invocation. The roadmap (`docs/product-roadmap-10.2-12.md`) is the story source; this file is the process source. If they conflict with the charter, the charter wins; say so.

## Hard rules (non-negotiable)

- **You never merge and never deploy without Sammy's explicit go in chat.** The pipeline runs autonomously up to the HUMAN GATE, then stops and presents.
- **Review runs on the branch BEFORE the PR is marked ready** — never alongside, never after.
- **WIP limit:** if 2 stories are already in flight (open team PRs not yet merged), stop and tell Sammy instead of starting a third.
- **Blocked-with-reason beats a lowered bar.** Never weaken an acceptance criterion to pass it.
- **Delegation map before launch, token actuals at close** — both printed to Sammy every story.

## Pipeline

### 1 · INTAKE
- Read the story (tasks, acceptance criteria, tier, size, gate column) from the roadmap.
- **Ground-truth with `gh` + `git`** — branch/PR/deploy state for anything the story touches. Never trust the board's snapshot.
- If a design-first gate applies and the design doc isn't Sammy-approved → STOP, report.
- **Definition of Ready** — all true before proceeding: AC testable as written · dependencies verified against ground truth · required design doc approved · brief compiled (step 2) · tier map printed.

### 2 · BRIEF
Compile the story brief every downstream agent receives. Template:

```
STORY: <id> — <title>            SIZE/TIER: <from roadmap>
BRANCH: claude/<id-lower>-<slug>  (worktree if parallel WIP)
ACCEPTANCE CRITERIA (verbatim from roadmap):
  1. ...
HOUSE GOTCHAS RELEVANT HERE (pull from memory/CLAUDE.md — only the applicable ones):
  - ...
FILE / SEAM POINTERS: ...
DEPLOY CONSTRAINTS: <order, migrations, rollback caveats — or "none">
TRIGGER-LIST FLAGS: <which apply, or "none"> → review tier: <standard|trigger>
```

### 3 · PLAN (M-size and larger builds only; S skips)
Spawn the built-in `Plan` agent with the brief. Sanity-check the plan against the AC yourself before build.

### 4 · BUILD
Spawn `story-dev` (model per the roadmap's tier column — Sonnet default, Opus for L/XL or named-risky seams; print your one-line reasoning). Verify its self-gate results are pasted counts, not claims.

### 5 · REVIEW — two tiers
- **Standard (S/M, no trigger-list hit):** invoke the built-in `/code-review` skill on the branch — S → medium effort, M → high.
- **Trigger tier (L/XL, or ANY trigger-list hit: spread/layering refactors, async store orchestration, backend contracts, model swaps under safety gates, user-writable storage, anything touching a safety gate):** run the `story-review` workflow (`.claude/workflows/story-review.js`) with the diff targets. Safety-gate findings additionally get **mutation-verified kill tests** (delete/weaken the gate → suite must go red).
- Findings fixed on the branch (small: inline; substantial: back through story-dev), then re-verified. Every finding ends CONFIRMED-fixed, REFUTED-with-reason, or ACCEPTED-with-reason.

### 6 · QA
Spawn `qa-verifier` with the brief on the final branch state. Ambiguous-AC escalations come to you; resolve or take them to Sammy.

### 7 · PR
Open a DRAFT PR per repo, then mark ready once the evidence bundle is complete in the body:
AC checklist (from QA) · review findings + resolutions · gate results (counts) · deploy order + rollback notes · token actuals so far. House rules: "Closes #N" when issue-linked; footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### 8 · HUMAN GATE — STOP
Present to Sammy: 5-line summary per PR (what, evidence highlights, risk, deploy constraints, recommendation). Wait for merge. Do not proceed, do not re-ping.

### 9 · DEPLOY (only on Sammy's explicit go)
Invoke `/deploy-ggbc`. Honor the story's deploy-order constraints. Complete any `deferred-to-prod-verify` AC items now and record the evidence.

### 10 · CLOSE
**Definition of Done** — all true: every AC verified with evidence · findings all resolved/accepted-with-reason · deployed + prod-verified (or explicitly parked by Sammy) · roadmap §7 Kanban table updated (docs commit, may batch with other doc changes) · durable facts written to memory · **token actuals vs the story's size band reported to Sammy, one line per pipeline stage**.

## Design-story variant (roadmap stories whose deliverable is a doc)
Steps 4–6 become: draft the doc → red-team it with the `story-review` workflow in design mode (lenses attack the DESIGN: bypasses, unstated assumptions, cheaper alternatives) → revise. Deliverable = Sammy-approved doc in `docs/`. Steps 9 is n/a; DoD adjusts accordingly. Security-relevant designs are ALWAYS red-teamed pre-code.

## Tier defaults (barbell — override per story with stated reasoning)
Mechanical/loud-failure (plumbing, ports, test scaffolds, copy): Haiku. Standard implementation: Sonnet. Risky seams, L/XL builds, heuristic design: Opus. Design synthesis, review orchestration, final verification judgment: strongest available. **Never economize on verifiers.**
