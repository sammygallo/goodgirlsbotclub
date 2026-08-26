# Agent-team run ledger

One line per **pipeline exit** — deployed, parked, *or blocked*. Appended by the PM at `run-story` step 10c, before the run ends. Committed, so it survives the session that wrote it.

It exists because three things the pipeline depends on were not computable from any durable artifact:

1. **The CURATE trigger.** `run-story` fires the postmortem's staleness sweep when **exits since the last CURATE ≥ 5**. A fresh PM session has no other way to know the count — the Kanban records deployed *cards*, and blocked runs never reach it at all.
2. **Proof the postmortem ran.** A skipped stage and a clean one are otherwise byte-identical. The `verdict` + token columns are the evidence; a row with them blank is a skip, not a clean run. This holds for blocked exits too, which produce no close report and therefore no other proof.
3. **Postmortem cost.** Roadmap §5 bands cover build / verification / plan absorption. Postmortem is pipeline overhead with no band; this ledger is where its actuals accumulate until there are enough to set one.

**Never rewrite a past row.** Corrections are appended as a new row referencing the original. The ledger is evidence, and evidence that gets edited is not evidence.

## Columns

`date` · `story` · `exit` (deployed / parked / blocked) · `mode` (CAPTURE / CURATE) · `verdict` (the postmortem's verbatim one-liner) · `tokens` (build / verification / absorption / postmortem) · `notes` (pre-image snapshot paths, escalations, links)

| Date | Story | Exit | Mode | Postmortem verdict | Tokens (b/v/a/p) | Notes |
|---|---|---|---|---|---|---|
| 2026-08-24 | E1-S1 | deployed | — | *(pre-role — Pilot 1, no postmortem stage existed)* | — / ~1.3M / — / — | Retro lessons were hand-copied into 4 unsynced places; this is the failure that motivated the role |
| 2026-08-24 | E2-S1 | deployed | — | *(pre-role — Pilot 2, no postmortem stage existed)* | — / ~5.1M / ~4.5M / — | Same |
| 2026-08-26 | E9-S1 | blocked | CAPTURE | Intake's ground-truth rule worked — ~55k to kill a 4.5-month-stale card — but routing failed twice: both stale-card incidents corrected the roadmap and never the memory row that caused them (that file still holds 3 known-false rows), and the record's own "dev leg never ran" premise was itself stale. | 0 / 0 / 0 / ~1.56M | Blocked at INTAKE: deliverable shipped 2026-04-11 (PR #59). Postmortem ran via general-purpose fallback — the `postmortem` type merged in `882d8a4a` this session and types load at session start, so it was not registered. Postmortem ~103k + charter-§2 adjudication of its 7 proposals ~1.46M (17 agents: 7 refute-first verifiers, 9 red-team lenses, 1 completeness critic) — P6 REFUTED, 6 upheld-with-correction, and the critic found a 5th false row (10.2) the postmortem missed. **No pre-image was taken** for two memory edits this run made at INTAKE (the gate keyed on "postmortem proposal"); reconstructed at `.pre-image/E9-S1-reconstructed-2026-08-26.md`, gate fixed in this PR. Sammy then approved the full memory sweep — `project_roadmap_status.md` swept end-to-end (6 false rows corrected: 5.3/6.1/6.3/10.1/10.2/10.3, plus frontmatter, banner, the PR-#58 line and all 4 candidate items; row 6.4 re-verified accurate) + `MEMORY.md` lines 2 and 35, with timestamped snapshots taken first. Verdict column is the postmortem's verbatim line. |

**CURATE counter starts with the E9-S1 row above** — it is exit #1. **Four** pipeline exits predate the role and do not count toward it, not two: E1-S1 and E2-S1 (the rows above), plus **E4-S0 and E9-S6, which completed full runs on 2026-08-25/26 — hours before this ledger merged at 22:58Z — and so were never rowed at all.** E9-S6's absence is the one that cost something: it carries the first recorded build leg (1.04M), and because no row records it, `MEMORY.md` went on asserting the dev leg had never run, which is the stale premise E9-S1's own run record then repeated back to the postmortem.

**The `tokens` column holds estimates, not measurements.** There is no per-stage meter; the PM reports its own best estimate. Reason #3 above — accumulating these until a postmortem band can be set — is weaker than it reads. Say "estimated" when you set one.
