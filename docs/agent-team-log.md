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

**CURATE counter starts at the first row below this line.** Both pilots predate the role and do not count toward it.
