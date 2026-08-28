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
- **Blocked-with-reason beats a lowered bar.** Never weaken an acceptance criterion to pass it. **A blocked story still runs the postmortem before you exit, and still appends its `docs/agent-team-log.md` row** — a falsified premise is the highest-value lesson the pipeline produces, and it is exactly the run that never reaches CLOSE, so the ledger is its only evidence.
- **Delegation map before launch, token actuals at close** — both printed to Sammy every story.

## Pipeline

### 1 · INTAKE
- Read the story (tasks, acceptance criteria, tier, size, gate column) from the roadmap.
- **Ground-truth with `gh` + `git`** — branch/PR/deploy state for anything the story touches. Never trust the board's snapshot.
- **If ground-truth proves the story already shipped, the roadmap fix is half the job.** Grep the dead claim across memory, `ROADMAP.md`, this roadmap and any handoff doc, correct each carrier, and sweep the *source* file end-to-end for its other status claims — that file rots by the row, and one bad row means others. This is bounded to the carriers, and is not CURATE. Cheapest ground-truth: `gh pr view <n> --json state,mergedAt` plus `git merge-base --is-ancestor <sha> origin/main`. Then exit blocked; do not invent scope to justify the run.
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

**Board artifact — publish/refresh here.** As soon as Definition of Ready is met — right after this step for M+ stories, right after step 2 BRIEF for S stories (which skip PLAN) — refresh the visual Kanban mirror and publish it, so Sammy sees the story move the moment its shape is locked rather than only at close:
- Source lives at `.claude/skills/run-story/board/ggbc-board.html`, committed to the repo — never the scratchpad, which is session-scoped and gone by the next run. Read it, move this story's card to its new column/state, and leave every other card as last ground-truthed.
- The file's own header comment carries the published artifact URL. Publish via the `Artifact` tool with that exact `url` so it updates in place — a fresh URL every run leaves Sammy with duplicate links to the same board.
- **This is a mirror of roadmap §7, never a substitute for it** (§7's table is the Kanban source of truth per charter D4). If the two disagree, §7 wins and the board is what's wrong — fix the board, don't edit the roadmap to match a stale rendering.
- Refresh again at HUMAN GATE (step 8) and CLOSE (step 10) so it tracks the story through merge and deploy, not just at kickoff.

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
Present to Sammy: 5-line summary per PR (what, evidence highlights, risk, deploy constraints, recommendation). Refresh the board artifact (§3) alongside it — the card that moved to "Review"/"PR" should already be visible when Sammy reads the summary. Wait for merge. Do not proceed, do not re-ping.

### 9 · DEPLOY (only on Sammy's explicit go)
Invoke `/deploy-ggbc`. Honor the story's deploy-order constraints. Complete any `deferred-to-prod-verify` AC items now and record the evidence.

### 10 · CLOSE
**Definition of Done** — all true: every AC verified with evidence · findings all resolved/accepted-with-reason · deployed + prod-verified (or explicitly parked by Sammy) · roadmap §7 Kanban table updated (docs commit, may batch with other doc changes) · **board artifact (§3) refreshed to match §7 and republished to its stored URL** · **POSTMORTEM run, its `verdict` pasted verbatim into the close report, and its proposals applied-or-declined** (see below) · **PLAN ABSORPTION done if this story produced ground truth** (see below) · **token actuals reported to Sammy as FOUR numbers — build / verification / plan absorption / postmortem — vs the story's band, one line per pipeline stage**. The fourth exists so a skipped postmortem is detectable: a stage that ran costs tokens, and a close report showing no postmortem spend is a skip, not a clean run. (Roadmap §5/§6.5 still define three *story* cost categories; postmortem is pipeline overhead. Flag the taxonomy mismatch at the next plan absorption rather than editing the approved roadmap unilaterally.)

**PLAN ABSORPTION (step 10b, only for knowledge-producing stories).** If the deliverable was knowledge rather than code — an audit, a research pass, a design validation, a red-teamed spec — then before closing, re-check the roadmap against what the story proved. Other stories were written on premises this one may have just falsified. **Correct every document that carries a falsified premise, named individually — not just the roadmap.** This clause said "the roadmap", singular, and that is the rule that failed: E9-S4 was found during E2-S1's absorption on 2026-08-24, the correction went to the repo docs, and the memory row that produced it (`project_roadmap_status.md` 10.3) was left standing — so the same file produced E9-S1 two days later, and a sweep then found a third dead row (10.2) already loaded into live story E9-S3. A premise typically has several carriers: the memory file, the tracked `ROADMAP.md`, this roadmap, and any handoff doc. Grep the claim, not the file you happen to have open. Run the absorption as a workflow (lenses over roadmap + deliverable → refute-first verifier per proposed change → completeness critic), apply the upheld changes in one docs PR, and file any defect the deliverable surfaced that no issue covers. Do NOT skip because the story "only wrote a doc": E2-S1's absorption found an epic whose entire premise had died (E4 planned to port a UI that no longer exists) and a backlog story already shipped. Roadmap §5 defines the cost category; report it separately.

**POSTMORTEM (step 10c — runs at PIPELINE EXIT, not just CLOSE).** Every run ends here: deployed, parked, or blocked-with-reason. Spawn the `postmortem` agent with the run record — brief, stage reports, review findings + resolutions, QA report, token actuals, PR, absorption result, or the blocked report — plus **the absolute path to the memory directory** (it does not inherit yours) and **whether this is a CURATE run**.

**CURATE cadence — computed, not remembered: read `docs/agent-team-log.md` and invoke CURATE when exits since the last CURATE row are ≥ 5, or whenever Sammy asks.** Those are the only two triggers; the charter (§2) states the same pair and wins on conflict. CAPTURE runs every time; the staleness sweep does not, because staleness accrues with repo change and calendar time, not with story closes — and a full sweep of the memory dir is most of this stage's cost. A fresh session has no memory of prior runs, so a cadence that cannot be read off a committed file is a cadence that silently never fires.

**It proposes; you apply — and the routing key is `removes_content`, not the proposal's kind.** Print the full proposal list to Sammy either way:
- `removes_content: false` (amendments, index corrections, additive notes) → **apply directly.**
- `removes_content: true` (a body rewrite, a delete, an index line removed) **or `memory-new`** → **Sammy's yes first.** Destruction is gated because the memory dir is unversioned and nothing there is diffable after the fact — a full-body "update" reaches that same worst case, which is why the gate keys on blast radius rather than on the word "delete". `memory-new` is gated for a different reason: it grows the index that loads into every future session.
- **Before ANY write that replaces or removes existing memory text — a postmortem proposal, your own correction at INTAKE, or ad-hoc cleanup — snapshot the pre-image to a durable path** — `<memory-dir>/.pre-image/<filename>.<YYYY-MM-DDTHHMMSS>.bak`, and never overwrite an existing snapshot. (Two fixes from E9-S1: the old wording said "any `removes_content: true` **proposal**", so PM-stage edits walked around it and that run rewrote a memory row and an index line with no pre-image at all; and the old `<YYYY-MM-DD>` name is date-resolution, so a second same-day write silently overwrote the first snapshot with edit #1's output — this directory already had two write windows in one day.) (create the dir if absent; it is dot-prefixed so it is never mistaken for a memory entry, and it lives outside git because memory content does not belong in the repo). **Not the scratchpad** — that is session-scoped and discarded, so a backup written there is gone by the time anyone wants it. Record the path in the ledger row. Then check the proposal's `preserved[]` list actually accounts for every claim in the current text; that list plus this snapshot are the only checks that a "distillation" did not quietly lose something.
- `doc-edit` (charter, this skill, agent files) → rides this story's docs commit or a follow-up PR under the normal merge gate.
- **When Sammy declines a proposal, append it to `DECLINED.md` in the memory dir with the reason.** The agent reads that file before proposing and must not re-raise a declined item without new evidence. Without this, every run re-proposes the same gated deletes against the same unchanged files until declining costs more than consenting.

**Append the ledger row before the run ends — every exit, no exceptions.** One line in `docs/agent-team-log.md`: date, story, exit type, mode, the `verdict` verbatim, the four token numbers, and the path of any pre-image snapshot you took. This is the only proof the stage ran, and it is the *only* proof available on a blocked exit, which produces no close report at all. A row with a blank verdict or blank postmortem tokens is a skip, not a clean run. Where a close report does exist, paste the same verdict + token number there too.

`no durable lesson` is a legitimate and common verdict — a clean run is not a failed postmortem, and do not coax proposals out of one. It still gets its ledger row.

If a proposal would change **how the team works** (a charter rule, a pipeline stage, an agent contract), red-team it with `story-review` in design mode before applying: a wrong process rule misfires on every future story, so it earns the same scrutiny as a security design.

## Design-story variant (roadmap stories whose deliverable is a doc)
Steps 4–6 become: draft the doc → red-team it with the `story-review` workflow in design mode (lenses attack the DESIGN: bypasses, unstated assumptions, cheaper alternatives) → revise. Deliverable = Sammy-approved doc in `docs/`. Steps 9 is n/a; DoD adjusts accordingly. Security-relevant designs are ALWAYS red-teamed pre-code.

## Tier defaults (barbell — override per story with stated reasoning)
Mechanical/loud-failure (plumbing, ports, test scaffolds, copy): Haiku. Standard implementation: Sonnet. Risky seams, L/XL builds, heuristic design: Opus. Design synthesis, review orchestration, final verification judgment: strongest available. **Never economize on verifiers.**
