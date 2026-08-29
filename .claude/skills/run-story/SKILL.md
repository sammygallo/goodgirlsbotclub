---
name: run-story
description: "Execute ONE roadmap story through the GGBC agent-team pipeline (intake → brief → plan → build → review → QA → PR → merge → deploy → close). Use when the user says /run-story <STORY-ID> (e.g. /run-story E2-S1), 'run story X', 'execute the next story', or 'start the pilot'. Story IDs and acceptance criteria live in docs/product-roadmap-10.2-12.md; the team charter is docs/agent-team.md."
---

# Run a roadmap story — PM/orchestrator pipeline

You are the PM defined in `docs/agent-team.md`. Execute exactly ONE story per invocation. The roadmap (`docs/product-roadmap-10.2-12.md`) is the story source; this file is the process source. If they conflict with the charter, the charter wins; say so.

## Hard rules (non-negotiable)

- **You may MERGE a story PR yourself once every gate below is green and no ESCALATION TRIGGER fires (§8). You NEVER deploy without Sammy's explicit go.** Merge authority was delegated 2026-08-28 (charter D2); deploy was not. Merging is cheap to undo — a revert PR — and deploy is what users see.
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
Spawn the built-in `Plan` agent with the brief. Sanity-check the plan against the AC yourself before build. **The plan declares the story's task-PR split (the loop count N); restate the verify budget as N × the §5 class budget at PLAN exit. S stories, which skip this step, fix N=1 at the BRIEF.**

**Board artifact — publish/refresh here.** As soon as Definition of Ready is met — right after this step for M+ stories, right after step 2 BRIEF for S stories (which skip PLAN) — refresh the visual Kanban mirror and publish it, so Sammy sees the story move the moment its shape is locked rather than only at close:
- **Read the LIVE artifact before every publish — to RECONCILE, not to republish.** `Artifact action:"read"` returns a platform-wrapped copy (an injected runtime preamble, a closing `</body></html>`) that is **not** byte-identical to the source; publishing that file back corrupts the board, measured 2026-08-29. So: read it, diff it against your committed source, port any *other* session's card forward into the source, and publish **the source**. Concurrent sessions each hold a different base, so publishing a working copy blind silently deletes whatever another in-flight story put on the board (near-miss 2026-08-29, #489 — the platform's read-before-write guard caught that one, which is luck, not a control).
- **Touch only your own story's card, the stamp, and the counts your card moves.** Leave every other card exactly as the live version has it — *including* a card that disagrees with roadmap §7, which usually means another session is mid-run rather than that the board is stale. Fix another story's card only when you have ground-truthed it yourself.
- The committed source at `.claude/skills/run-story/board/ggbc-board.html` is the rebuild-from-scratch copy and the thing a fresh session reads first — never the scratchpad, which is session-scoped and gone by the next run. **At CLOSE, commit the live version back into it** so the committed copy catches up with whatever the runs published.
- The file's own header comment carries the published artifact URL. Publish via the `Artifact` tool with that exact `url` so it updates in place — a fresh URL every run leaves Sammy with duplicate links to the same board.
- **This is a mirror of roadmap §7, never a substitute for it** (§7's table is the Kanban source of truth per charter D4). If the two disagree, §7 wins and the board is what's wrong — fix the board, don't edit the roadmap to match a stale rendering.
- Refresh again at MERGE (step 8) and CLOSE (step 10) so it tracks the story through merge and deploy, not just at kickoff.

### 4 · BUILD
Spawn `story-dev` (model per the roadmap's tier column — Sonnet default, Opus for L/XL or named-risky seams; print your one-line reasoning). Verify its self-gate results are pasted counts, not claims.

### 5 · REVIEW — two tiers
- **Standard (S/M, no trigger-list hit):** invoke the built-in `/code-review` skill on the branch — S → medium effort, M → high.
- **Trigger tier (L/XL, or ANY trigger-list hit: spread/layering refactors, async store orchestration, backend contracts, model swaps under safety gates, user-writable storage, anything touching a safety gate):** run the `story-review` workflow (`.claude/workflows/story-review.js`) with the diff targets. Safety-gate findings additionally get **mutation-verified kill tests** (delete/weaken the gate → suite must go red).
- Findings fixed on the branch (small: inline; substantial: back through story-dev), then re-verified. Every finding ends CONFIRMED-fixed, REFUTED-with-reason, or ACCEPTED-with-reason.
- **Every fix round gets its own review — and the dial that shrinks is the SUBJECT, never the lens set.** A fix round reviews the fix delta (plus whatever it touches) with the FULL lens set: subject-scoping alone delivered most of E2-S2 round 6's ~7× saving, and dropping lenses removes exactly the independent hypotheses that catch fix-introduced defects (three of E2-S2's six rounds caught one). Bright line for lens reduction: only a **confirmation round** — one that follows a round with zero confirmed findings — may run a reduced lens set over the delta; if a scoped round confirms anything, the next round returns to the full set. Never scope by round number or by token pressure.
- **Tree hygiene — run the script, paste its verdict line.** `.claude/scripts/tree-hygiene.sh snapshot <scratchpad>/hygiene.txt` before the review stage; `… check <same file>` after every round and before QA. Non-zero exit stops the pipeline until the named paths are resolved.
  **It is a script, not a checklist, because this rule shipped broken three times as prose** (#486) — each version read plausibly and none was runnable, so none was testable. `.claude/scripts/tree-hygiene.test.sh` plants every violation class that got through before (in-place mutation · re-mutation of an already-dirty file · dirt in a *sibling worktree*, which a single `git status` cannot see · a new untracked file · content drift in an allowlisted untracked file · a stray registration) and asserts a non-zero exit for each, plus a clean tree exiting zero so the gate cannot regress into always-fires noise. Run the tests if you change the gate; a gate that cannot fail is not a gate.
  Two things the script cannot enforce for you. **Never silence a path with `.gitignore`** to make it pass — an ignored file drops out of ripgrep's default traversal and silently breaks the carrier sweeps INTAKE and plan absorption depend on. And a dirty *starting* tree is the contested-checkout condition: resolve it before review rather than baselining over it, which is why `snapshot` itself refuses to record one.
- **Vision divergence.** The delivered thing differs from what the story's AC described, the story's premise turned out false, scope grew beyond the AC, or the change alters user-visible product direction that the roadmap does not already approve.
- **Safety red line.** Anything touching media-generation provenance, the NCII red line, or content-safety gates (§6.1, §6.8) — regardless of how clean the review was.
- **Hard to reverse.** Schema migrations, changes to the shape of persisted user data, deletions, or anything a revert PR alone would not undo.
- **Cross-repo contract.** Frontend and backend must land together, or a deploy-order window exists.
- **Auth, permissions, or secrets** surface is touched.
- **A standard was waived, not met.** Any finding closed ACCEPTED-with-reason, any AC marked deferred, any gate skipped with a rationale. If the team chose to accept less, Sammy decides — that is the whole point of "unless something is significantly off from dev standards."
- **Review did not converge cleanly.** Two or more fix rounds each introduced a new defect, or the round count ran past what the story's band anticipated. Both signal the estimate was wrong, which means the risk was misjudged — and a misjudged risk is exactly what a human gate is for. (Once the §5 risk-class table lands, read the expected round count off it; until then, judge against the band on the card and say what you compared to.)
- **Third-party or dependency surface**: a new dependency, a lockfile change, or a change to committed `node_modules`.
- **Anything that governs, gates, builds, tests, or ships this project — not just its story rules.** `.claude/**` in full (every skill including `/deploy-ggbc`, the workflows, the agent contracts, settings, hooks), `docs/agent-team.md`, the roadmap's protocol sections, the memory directory, `.github/workflows/**`, `.gitignore`, and CI or release configuration anywhere. **A pipeline that can merge edits to its own rules can widen its own authority — including deleting this trigger, weakening the CI whose greenness the checklist reads, or rewriting the deploy procedure behind the one gate that was never delegated.** `/deploy-ggbc` is the sharpest case: it is symlinked into `~/.claude/skills/`, so a merge changes it for every future session immediately, with no deploy required. These always stop, no matter how green the checklist, and that explicitly includes any change whose only effect is to make more things auto-mergeable. **If you are unsure whether a file governs the pipeline, it does** — escalate. **The board source (`.claude/skills/run-story/board/ggbc-board.html`) is a rendering of §7, not a rule — it is outside this surface**, so the board refresh §3 requires does not turn every story PR into a governance escalation. The only other exemption is a docs commit that RECORDS what already happened (ledger rows, Kanban status, close reports) — the pipeline's own §10 bookkeeping, which it must be able to do without escalating every close. The exemption is about the COMMIT, not the file: a rule change is not exempt because it was written into a file that also holds records, and a commit carrying a rule change alongside records is not a records commit.

**If nothing fires: merge it** (squash, house commit-message rules), then post the same 5-line summary you would have presented — what, evidence highlights, risk, deploy constraints — as a **merge notice**, prefixed with the checklist result and the one-line reason no trigger fired. The notice is not a request; it is the audit trail, and it must be specific enough that Sammy can decide to revert from it alone. State the revert command.

**Say plainly in every merge notice that the story is now on `main` and will ship with the next deploy anyone approves.** The deploy gate does NOT gate deploy *content*: `:latest` is built from `main`, so a single "go" on some later story ships every merged story sitting there. That is the real cost of a wrong merge, and it is why the escalation triggers are surface-based rather than severity-based.

**If a trigger fires:** name which one, present the 5-line summary, and wait. Do not re-ping. Sammy may also pause the delegation at any time, for one story or in general, by saying so — treat that as a standing instruction until lifted.

**Cost signals are reported, never blocking:** if the run exceeded its §5 class budget, say so in the merge notice with the round count. An overrun is information, not a defect.

### 9 · DEPLOY — STOP, always (only on Sammy's explicit go)
**This gate did not move.** A merged story sits on `main` until Sammy says deploy; the merge notice from §8 is what he decides from. Never infer deploy authority from merge authority, and never batch a deploy in with a merge because the story feels routine.

**The deploy request must enumerate everything it would ship, across EVERY repo the stack ships — not just this story and not just the frontend.** Because each image is built from its repo's `main`, asking "deploy E-X?" actually asks "ship every merged-but-unshipped commit in the whole stack". `docker compose pull` refreshes the frontend AND `ggbc-backend` images together, and **the backend applies its Alembic migrations automatically on start**, so an unenumerated backend commit can migrate production schema under a deploy Sammy approved for a frontend story.

Build the window per repo:
- **Frontend** — diff `main` against the droplet's `.last-deployed` marker (`/deploy-ggbc` §5.5).
- **ggbc-backend** — there is **no equivalent marker**; do not silently skip it. Derive the deployed commit from the running container's image (digest/labels) or, failing that, from the last backend deploy recorded in `docs/agent-team-log.md`, and **say in the request which method you used and how confident it is**.
- **Intake bot** — only when in scope; it deploys separately under pm2 and is not part of the image pull.

List every story in every window with its merge notice. **If any window contains a change Sammy has not seen a notice for — or a migration — say that first, before asking.**
Invoke `/deploy-ggbc`. Honor the story's deploy-order constraints. Complete any `deferred-to-prod-verify` AC items now and record the evidence.

### 10 · CLOSE
**Definition of Done** — all true: every AC verified with evidence · findings all resolved/accepted-with-reason · merged (self-serve per §8, or by Sammy after an escalation) · deployed + prod-verified on Sammy's go (or explicitly parked by Sammy) · roadmap §7 Kanban table updated (docs commit, may batch with other doc changes) · **board artifact (§3) refreshed to match §7 and republished to its stored URL** · **POSTMORTEM run, its `verdict` pasted verbatim into the close report, and its proposals applied-or-declined** (see below) · **PLAN ABSORPTION done if this story produced ground truth** (see below) · **token actuals reported to Sammy as FOUR numbers — build / verification / plan absorption / postmortem — vs the story's band, one line per pipeline stage, with the review-round count stated next to the verification number (here and in the ledger row): rounds are the cost driver neither headline number explains (E2-S2: ~17 rounds across 4 task-PR loops for ~36.5M — ~24× the L verify letter at story level; its final loop's 6 rounds ≈ 11M). Record material infrastructure waste (usage-limit kills, resume overhead) in the ledger row's notes**. The fourth exists so a skipped postmortem is detectable: a stage that ran costs tokens, and a close report showing no postmortem spend is a skip, not a clean run. (Roadmap §6.5 adopted the same four-category reporting in the 2026-08-28 recalibration; the taxonomies now compose.)

**PLAN ABSORPTION (step 10b, only for knowledge-producing stories).** If the deliverable was knowledge rather than code — an audit, a research pass, a design validation, a red-teamed spec — then before closing, re-check the roadmap against what the story proved. Other stories were written on premises this one may have just falsified. **Correct every document that carries a falsified premise, named individually — not just the roadmap.** This clause said "the roadmap", singular, and that is the rule that failed: E9-S4 was found during E2-S1's absorption on 2026-08-24, the correction went to the repo docs, and the memory row that produced it (`project_roadmap_status.md` 10.3) was left standing — so the same file produced E9-S1 two days later, and a sweep then found a third dead row (10.2) already loaded into live story E9-S3. A premise typically has several carriers: the memory file, the tracked `ROADMAP.md`, this roadmap, and any handoff doc. Grep the claim, not the file you happen to have open. Run the absorption as a workflow (lenses over roadmap + deliverable → refute-first verifier per proposed change → completeness critic), apply the upheld changes in one docs PR, and file any defect the deliverable surfaced that no issue covers. Do NOT skip because the story "only wrote a doc": E2-S1's absorption found an epic whose entire premise had died (E4 planned to port a UI that no longer exists) and a backlog story already shipped. Roadmap §5 defines the cost category; report it separately.

**POSTMORTEM (step 10c — runs at PIPELINE EXIT, not just CLOSE).** Every run ends here: deployed, parked, or blocked-with-reason. Spawn the `postmortem` agent with the run record — brief, stage reports, review findings + resolutions, QA report, token actuals, PR, absorption result, or the blocked report — plus **the absolute path to the memory directory** (it does not inherit yours) and **whether this is a CURATE run**.

**CURATE cadence — computed, not remembered: read `docs/agent-team-log.md` and invoke CURATE when exits since the last CURATE row are ≥ 5, or whenever Sammy asks.** Those are the only two triggers; the charter (§2) states the same pair and wins on conflict. CAPTURE runs every time; the staleness sweep does not, because staleness accrues with repo change and calendar time, not with story closes — and a full sweep of the memory dir is most of this stage's cost. A fresh session has no memory of prior runs, so a cadence that cannot be read off a committed file is a cadence that silently never fires.

**It proposes; you apply — and the routing key is `removes_content`, not the proposal's kind.** Print the full proposal list to Sammy either way:
- `removes_content: false` (amendments, index corrections, additive notes) → **apply directly.**
- `removes_content: true` (a body rewrite, a delete, an index line removed) **or `memory-new`** → **Sammy's yes first.** Destruction is gated because the memory dir is unversioned and nothing there is diffable after the fact — a full-body "update" reaches that same worst case, which is why the gate keys on blast radius rather than on the word "delete". `memory-new` is gated for a different reason: it grows the index that loads into every future session.
- **Before ANY write that replaces or removes existing memory text — a postmortem proposal, your own correction at INTAKE, or ad-hoc cleanup — snapshot the pre-image to a durable path** — `<memory-dir>/.pre-image/<filename>.<YYYY-MM-DDTHHMMSS>.bak`, and never overwrite an existing snapshot. (Two fixes from E9-S1: the old wording said "any `removes_content: true` **proposal**", so PM-stage edits walked around it and that run rewrote a memory row and an index line with no pre-image at all; and the old `<YYYY-MM-DD>` name is date-resolution, so a second same-day write silently overwrote the first snapshot with edit #1's output — this directory already had two write windows in one day.) (create the dir if absent; it is dot-prefixed so it is never mistaken for a memory entry, and it lives outside git because memory content does not belong in the repo). **Not the scratchpad** — that is session-scoped and discarded, so a backup written there is gone by the time anyone wants it. Record the path in the ledger row. Then check the proposal's `preserved[]` list actually accounts for every claim in the current text; that list plus this snapshot are the only checks that a "distillation" did not quietly lose something.
- `doc-edit` (charter, this skill, agent files — anything on §8's governance surface) → **always its own PR, which fires the governance trigger and therefore stops for Sammy. It NEVER rides the story's close/bookkeeping commit**, which goes direct to `main` with no PR at all. A rule change that reaches `main` inside a records commit has bypassed the merge gate entirely — that is the one path by which a pipeline with merge authority could quietly widen it.
- **When Sammy declines a proposal, append it to `DECLINED.md` in the memory dir with the reason.** The agent reads that file before proposing and must not re-raise a declined item without new evidence. Without this, every run re-proposes the same gated deletes against the same unchanged files until declining costs more than consenting.

**Append the ledger row before the run ends — every exit, no exceptions.** One line in `docs/agent-team-log.md`: date, story, exit type, mode, the `verdict` verbatim, the four token numbers, and the path of any pre-image snapshot you took. This is the only proof the stage ran, and it is the *only* proof available on a blocked exit, which produces no close report at all. A row with a blank verdict or blank postmortem tokens is a skip, not a clean run. Where a close report does exist, paste the same verdict + token number there too.

`no durable lesson` is a legitimate and common verdict — a clean run is not a failed postmortem, and do not coax proposals out of one. It still gets its ledger row.

If a proposal would change **how the team works** (a charter rule, a pipeline stage, an agent contract), red-team it with `story-review` in design mode before applying: a wrong process rule misfires on every future story, so it earns the same scrutiny as a security design.

## Design-story variant (roadmap stories whose deliverable is a doc)
Steps 4–6 become: draft the doc → red-team it with the `story-review` workflow in design mode (lenses attack the DESIGN: bypasses, unstated assumptions, cheaper alternatives) → revise. Deliverable = Sammy-approved doc in `docs/`. Steps 9 is n/a; DoD adjusts accordingly. Security-relevant designs are ALWAYS red-teamed pre-code.

## Tier defaults (barbell — override per story with stated reasoning)
Mechanical/loud-failure (plumbing, ports, test scaffolds, copy): Haiku. Standard implementation: Sonnet. Risky seams, L/XL builds, heuristic design: Opus. Design synthesis, review orchestration, final verification judgment: strongest available. **Never economize on verifiers.**
