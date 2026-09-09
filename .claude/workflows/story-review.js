export const meta = {
  name: 'story-review',
  description: 'Trigger-tier adversarial review: independent lenses over branch diffs, skeptic-verified findings',
  whenToUse: 'REVIEW stage of /run-story for L/XL stories or trigger-list hits; design mode for red-teaming design docs',
  phases: [
    { title: 'Lens review', detail: 'independent perspectives over the diff' },
    { title: 'Cluster', detail: 'collapse findings describing the same defect, before the wave is priced' },
    { title: 'Skeptic verify', detail: 'each finding attacked by two skeptics; majority-refute kills' },
  ],
}

// args: {
//   story: 'E1-S1',
//   mode: 'diff' | 'design',
//   targets: [{ repo: '<name>', path: '/abs/path', base: 'origin/main', branch: '<branch>' }]   (diff mode)
//   docPath: '/abs/path/to/design.md'                                                            (design mode)
//   context: 'PM-written brief excerpt: what this change is, safety invariants, known constraints'
//   classBudgetTokens: optional number — the story's roadmap §5 class-row budget. When set, the run
//     HOLDS before the skeptic wave if the projection exceeds it (see the cost gate below).
//   spentTokens: optional number — this story's review spend so far, so the gate prices the STORY
//     across its 1-2 passes rather than each pass in isolation.
//   confirmOverBudget: true — proceed past that hold. Pair it with resumeFromRunId or the lenses re-roll.
//   lenses: optional [{ key, focus }] override
//   skepticBatchSize: optional number, default 4 — how many findings one skeptic agent judges.
//     1 gives one agent per finding per skeptic, and reproduces the pre-2026-09-09
//     AGENT COUNT and projection arithmetic. The prompt and response schema are the
//     batched ones either way, so this is not a byte-identical restoration.
//   skepticSliceSize: optional number, default 25 — how many skeptic agents run before the
//     script awaits them. A backstop on kill blast radius; see the wave below.
//   clusterMinFindings: optional number, default 6 — below this the clustering agent is skipped
//     (it cannot save more than it costs on a tiny set).
// }
const DEFAULT_DIFF_LENSES = [
  { key: 'correctness', focus: 'regressions and logic defects: concrete inputs/state that produce wrong output, crashes, or broken existing behavior' },
  { key: 'bypass', focus: 'security and gate bypasses: what a raw API client (not the honest UI) can do; whether gates bind to content vs mutable references; fail-closed on every path' },
  { key: 'contract', focus: 'cross-repo/contract coherence: frontend expectations vs backend behavior, error-shape parsing, deploy-order windows where old FE meets new BE (and vice versa)' },
  { key: 'tests', focus: 'test adequacy: which claimed behaviors have no test that would go red if the behavior broke; kill tests that do not actually kill' },
]
const DEFAULT_DESIGN_LENSES = [
  { key: 'bypass', focus: 'how an adversary defeats this design as specified — unstated assumptions, scope holes, reference-vs-content confusions' },
  { key: 'simpler', focus: 'a materially simpler design meeting the same requirements, or proof none exists' },
  { key: 'ops', focus: 'operational failure: rollout, rollback, partial-deploy windows, cost blowups, provider failure modes' },
]

const FINDINGS_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'claim', 'severity', 'failure_scenario'],
    properties: {
      repo: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' },
      title: { type: 'string' }, claim: { type: 'string' },
      severity: { enum: ['critical', 'major', 'minor'] },
      failure_scenario: { type: 'string' }, suggested_kill_test: { type: 'string' },
    } } } },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}
// One skeptic agent now judges a BATCH, so its verdicts are index-addressed.
// `index` is the position in the deduped list, not in the batch — an agent that
// renumbers its own batch would otherwise vote on someone else's finding.
const BATCH_VERDICT_SCHEMA = {
  type: 'object', required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: {
    type: 'object', required: ['index', 'refuted', 'reason'],
    properties: {
      index: { type: 'number' }, refuted: { type: 'boolean' }, reason: { type: 'string' },
    } } } },
}
const CLUSTER_SCHEMA = {
  type: 'object', required: ['groups'],
  properties: { groups: { type: 'array', items: {
    type: 'object', required: ['members'],
    properties: {
      members: { type: 'array', items: { type: 'number' } },
      reason: { type: 'string' },
    } } } },
}

const mode = args.mode || 'diff'
const lenses = args.lenses || (mode === 'design' ? DEFAULT_DESIGN_LENSES : DEFAULT_DIFF_LENSES)
const subject = mode === 'design'
  ? `Design doc under review: ${args.docPath}. Read it fully, plus any code it references.`
  : `Diff targets (read each with: git -C <path> diff <base>...<branch>, plus surrounding files for context):\n` +
    args.targets.map(t => `- ${t.repo}: path=${t.path} base=${t.base} branch=${t.branch}`).join('\n')

// Lens stance. GENERATED from `.claude/agents/adversarial-reviewer.md` — the
// region between its `mirror:start` / `mirror:end` markers, minus its
// `mirror:skip` spans. DO NOT EDIT THIS LINE BY HAND: edit the .md, then run
// `node .claude/workflows/story-review.test.mjs --fix`. The suite asserts the
// two byte-for-byte, so a drifted copy fails the gate instead of surviving in
// silence.
//
// It is duplicated at all because this script must run in sessions where custom
// agent types are not loaded. It was hand-synced until 2026-09-09, and had
// drifted before: #517 (merged 2026-09-06) re-synced it after finding the copy
// missing three ## Stance items. Generating it is what stops that recurring.
const stance = "You are one review lens on the GGBC agent team (charter: `docs/agent-team.md`). You receive a diff target (repo path, base, branch) and an assigned lens (e.g. correctness/regression, security/bypass, contract coherence, test adequacy). Your job is to find defects that are REAL \u2014 reachable with concrete inputs \u2014 not stylistic preferences. Hunt from your assigned lens only; trust other lenses to cover theirs. For every candidate finding, construct the concrete failure scenario: inputs/state \u2192 wrong output, crash, or bypass. If you cannot construct one, it is not a finding. Read enough surrounding code to know whether a co-located check already masks the issue \u2014 the house has shipped \"findings\" that a neighboring gate made unreachable, and refuting your own candidate is a valid, valuable outcome. Safety-gate diffs get special suspicion: ask what an API client (not the honest UI) can do, whether the gate binds to CONTENT or to a mutable reference, and whether every path re-verifies fail-closed. A comment, docstring, fixture header or test name inside the diff is a claim, and a false one is a finding \u2014 the class `feedback_adversarial_review_catches_real_bugs` calls D-T4. The failure-scenario bar above is written for runtime failures; a false comment fails when the next reader acts on it \u2014 a future session, a roadmap card, the other repo's copy of the sentence \u2014 so a lens hunting from its assigned focus reads prose as context and catches this class only when it happens to read the line (E2-S2a's and E9-S9's rounds did; ggbc-backend#87's did not). Make it a check, not luck: every checkable assertion the diff's own prose makes (a count, an ordering, a last / only / always / never, an attribution, a `file:line` cite) is verified against the code it describes \u2014 in this diff, or in the other repo when the sentence is about the other repo's behaviour \u2014 and a false one is reported naming the check that fails. Wording you merely dislike is still a style nit; the bar is a named failing check, not a preference. (E9-S10, 2026-09-05: `app/providers/system_placement.py` was NEW in `sammygallo/ggbc-backend#87`; its module docstring said the four post-history sections are emitted \"precisely so they are the last thing the model reads\" \u2014 four sections cannot each be last, and the frontend's continue/impersonate call sites append a user turn after all of them, a check that lives in `chatStore.ts`. The full trigger-tier round over that diff \u2014 four lenses plus skeptics \u2014 passed it; a standard-tier eight-angle review of the frontend's docs caught it, and it cost follow-up PR `ggbc-backend#88` after merge.) Zero findings is a legitimate report \u2014 say what you checked and why it held. Never do any of the following: Patch the code, commit, or \"quickly fix\" anything \u2014 fixes flow through the dev/PM so branch history stays coherent. Mutate the target checkout. If you verify a coverage claim by MUTATION (temporarily editing code to prove a test stays green), do it in a THROWAWAY checkout \u2014 `git worktree add <scratchpad-path> --detach <sha>` \u2014 never in the target worktree, and remove it when done; the target stays byte-identical to its committed state. (Pilot E1-S1: a reviewer's uncommitted mutation was found sitting in the shared worktree.) Pad the report with hypotheticals, style nits, or findings you couldn't ground in a failure scenario."

// Validate the gate's inputs BEFORE spending anything. The house writes budgets
// as "9.8M" in prose, and a string is truthy while `n > "9.8M"` is false — which
// would DISABLE the gate silently, in the direction that never announces itself.
// A bare `7.16` meaning 7.16M passes every type check and disarms the cumulative
// half just as quietly, so magnitude is checked too.
//
// This runs above the lens fan-out deliberately: round 3 of this file's own
// red-team found the validation sitting below it, where rejecting a string
// literal first burned every lens agent — ~320-400k, more than roadmap §5's
// entire standard-pass row — and left the caller with completed lens findings
// reachable only by a resume nothing documented for the throw path.
const num = (v, name) => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`story-review: ${name} must be a non-negative number of tokens, got ${JSON.stringify(v)} ` +
                    `(write 9_800_000, not "9.8M")`)
  }
  if (v > 0 && v < 1000) {
    throw new Error(`story-review: ${name} is ${v}, which is almost certainly a magnitude error — ` +
                    `these are TOKEN counts, so 7.16M is 7_160_000, not 7.16`)
  }
  return v
}
const classBudgetTokens = num(args.classBudgetTokens, 'classBudgetTokens')
const spentTokens = num(args.spentTokens, 'spentTokens') || 0
const gateArmed = classBudgetTokens !== undefined

phase('Lens review')
const lensResults = await parallel(lenses.map(l => () =>
  agent(
    `${stance}\n\nYour lens: ${l.key} — ${l.focus}\n\nStory: ${args.story}\nPM context: ${args.context}\n\n${subject}\n\nReturn your findings.`,
    { label: `lens:${l.key}`, phase: 'Lens review', schema: FINDINGS_SCHEMA, model: 'opus', effort: 'high' } // lenses: broad hunting, opus+high
  )))
// Barrier is deliberate: dedup needs every lens's findings at once.
// #526: index BEFORE filtering. `filter(Boolean).flatMap((r,i) => lenses[i])` re-indexed, so a dead
// lens shifted the label of every lens ORIGINALLY AFTER it by one; lenses before it kept the correct
// label, so the damage was positional, not total. Silent, and only in the degraded condition where
// attribution matters most.
const all = lensResults.flatMap((r, i) => r ? r.findings.map(f => ({ ...f, lens: lenses[i].key })) : [])
const deadLenses = lenses.filter((_, i) => !lensResults[i]).map(l => l.key)
log(`lenses: ${lenses.length - deadLenses.length}/${lenses.length} returned` +
    (deadLenses.length ? ` — DIED: ${deadLenses.join(', ')} (this round hunted with fewer lenses)` : ''))
// Every lens dead is NOT a clean round. Without this the run returns empty verdict arrays byte-identical
// to a genuinely converged pass, and §8 checklist item 3 keys on exactly that shape. Same remedy as the
// budget hold below: null the four verdict keys so a downstream count throws instead of reading zero.
if (lenses.length && deadLenses.length === lenses.length) {
  log(`ALL ${lenses.length} lenses died — NOT A REVIEW ROUND, nothing was hunted.`)
  return { story: args.story, mode, status: 'all_lenses_died',
           confirmed: null, plausible: null, refuted: null, unverified: null,
           deadLenses, lensCount: lenses.length }
}
const seen = new Set()
const exact = all.filter(f => {
  const k = `${f.repo || ''}|${f.file || ''}|${(f.title || '').toLowerCase().slice(0, 60)}`
  if (seen.has(k)) return false
  seen.add(k); return true
})

// --- Semantic clustering -------------------------------------------------
// The exact-match filter above is a near no-op and always was: it keys on a
// byte-identical lowercased title, and independent lens agents hunting the same
// defect from different angles essentially never write the same title. So every
// near-duplicate reached the wave and was verified TWICE, at ~160k a copy.
//
// Measured on E9-S9 (ledger 2026-09-03): rounds 1-5 confirmed 10/13/17/20/9
// findings, which the PM then reduced by hand to 5/6/6/6/4 DISTINCT items — the
// collapse was real, it just happened after the money was spent.
//
// This stage moves that collapse in front of the wave. It is one cheap agent
// that reads TITLES AND CLAIMS ONLY — never the diff — so it costs about what a
// single skeptic used to, against a wave it can cut by a third to a half.
//
// THE ASYMMETRY THAT SHAPES THE PROMPT: under-merging costs money; over-merging
// hides a real defect behind an unrelated one and is a silent review hole. The
// prompt therefore biases hard toward keeping findings separate when unsure,
// and `applyClusters` below refuses any grouping that is not an exact partition
// of the input — a clusterer that drops, invents or double-counts an index gets
// its whole answer thrown away and the round proceeds unclustered.
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 }
const clusterMin = Math.max(2, Math.floor(args.clusterMinFindings ?? 6))

// Returns the collapsed list, or null if `groups` is not an exact partition of
// `findings` — the ONLY shape that cannot lose a finding. Fail-open is
// deliberate and is the safe direction: an unclustered round is merely
// expensive, a silently dropped finding is an unreviewed defect.
const applyClusters = (groups, findings) => {
  if (!Array.isArray(groups) || groups.length === 0) return null
  const claimed = new Set()
  for (const g of groups) {
    if (!g || !Array.isArray(g.members) || g.members.length === 0) return null
    for (const m of g.members) {
      if (!Number.isInteger(m) || m < 0 || m >= findings.length || claimed.has(m)) return null
      claimed.add(m)
    }
  }
  if (claimed.size !== findings.length) return null
  return groups.map(g => {
    // Representative = highest severity, ties by original order. Deterministic:
    // no Math.random() in a workflow script, and resume must replay identically.
    const members = g.members.slice().sort((a, b) =>
      ((SEVERITY_RANK[findings[a].severity] ?? 3) - (SEVERITY_RANK[findings[b].severity] ?? 3)) || (a - b))
    const rep = findings[members[0]]
    if (members.length === 1) return rep
    return {
      ...rep,
      // Independent corroboration is signal, not noise: a defect three lenses
      // found separately is stronger evidence than one that only `tests` saw.
      lenses: [...new Set(members.map(i => findings[i].lens))],
      // The WHOLE alternate finding, not a summary of it. An earlier version kept
      // only {lens, title, claim} and dropped `failure_scenario` — which is the
      // exact field the skeptic prompt makes its test ("unless the failure
      // scenario demonstrably holds") — plus `file`, `line` and
      // `suggested_kill_test`. That narrowed a merged cluster to ONE scenario on
      // the discriminating field while this comment claimed the opposite.
      merged_from: members.slice(1).map(i => findings[i]),
    }
  })
}

let deduped = exact
let clusterOutcome = 'skipped'
if (exact.length >= clusterMin) {
  phase('Cluster')
  const roster = exact.map((f, i) =>
    `${i}. [lens:${f.lens}] ${f.repo || '-'} ${f.file || '-'}${f.line ? ':' + f.line : ''} — ${f.title}\n` +
    `   claim: ${f.claim}\n   scenario: ${f.failure_scenario}`).join('\n')
  const grouped = await agent(
    `${exact.length} findings below came from independent review lenses over the same subject, so several ` +
    `may describe THE SAME underlying defect in different words. Partition them into groups.\n\n` +
    `Two findings belong in one group ONLY if fixing the single underlying defect resolves both. ` +
    `Same file, same area, or same theme is NOT enough — two distinct bugs in one function are two groups.\n\n` +
    `BIAS STRONGLY TOWARD SEPARATE GROUPS. Leaving a duplicate unmerged costs a little money. Merging two ` +
    `distinct defects hides one of them from verification entirely and it ships. When you are not sure, ` +
    `put them in separate groups.\n\n` +
    `Return EVERY index exactly once, across all groups. A singleton group is the normal case.\n\n` +
    `${roster}`,
    { label: 'cluster', phase: 'Cluster', schema: CLUSTER_SCHEMA, model: 'sonnet', effort: 'low' }
  )
  const applied = grouped && applyClusters(grouped.groups, exact)
  if (applied) {
    deduped = applied
    clusterOutcome = `${exact.length} → ${deduped.length}`
  } else {
    // Loud, because the round now costs what it used to and the record must say why.
    clusterOutcome = grouped ? 'REJECTED (not an exact partition)' : 'REJECTED (clusterer died)'
    log(`clustering ${clusterOutcome} — proceeding UNCLUSTERED at ${exact.length} findings`)
  }
}
log(`${all.length} raw findings → ${exact.length} after exact dedup → ${deduped.length} after clustering ` +
    `(${clusterOutcome})`)

// --- Skeptic batching ----------------------------------------------------
// Every finding still gets TWO independent skeptic votes. What changed is that
// one agent now judges several findings, because most of a skeptic's ~80k was
// re-reading the same diff to rule on one finding, and that read amortizes.
//
// The two partitions are built DIFFERENTLY on purpose:
//   partition 1 — contiguous runs   [0,1,2,3] [4,5,6,7] ...
//   partition 2 — strided           [0,4,8..] [1,5,9..] ...
// so no finding is ever judged twice by the SAME set of batch-mates. That is the
// property, and it is per-finding, not per-pair: some pairs do still co-occur in
// both partitions (n=5 puts 0 and 2 together twice), which is fine — what
// decorrelates the anchoring a batch introduces (an agent that talks itself into
// refuting everything in front of it) is that the two votes are cast in
// different company. It also bounds a dead agent: a finding's two votes are
// always two different agents, so one death takes at most one of them, and
// `votes.length === 0` still reports UNVERIFIED rather than confirmed. skepticBatchSize:1 collapses both partitions to one-agent-per-
// finding, i.e. exactly the pre-2026-09-09 behaviour, and is the escape hatch.
const skepticBatchSize = Math.max(1, Math.floor(args.skepticBatchSize ?? 4))
// FLOOR OF 2 BATCHES whenever there is more than one finding. Without it, any
// round with `deduped <= skepticBatchSize` collapses to a single batch, both
// partitions become the SAME batch, and the decorrelation this whole scheme
// rests on silently does not exist — at the shipped default that is every round
// of four findings or fewer, and one dead agent then takes BOTH of a finding's
// votes instead of one. So `skepticBatchSize` is a ceiling on batch size, not a
// target: the effective size is min(skepticBatchSize, ceil(deduped / 2)).
const batchCount = deduped.length <= 1
  ? deduped.length
  : Math.max(2, Math.ceil(deduped.length / skepticBatchSize))
// Partition 1 splits into `batchCount` CONTIGUOUS runs (not runs of
// skepticBatchSize — with the floor above those are no longer the same thing,
// and slicing by size would leave partition 1 with fewer batches than
// partition 2 and break the projection). Partition 2 strides. A single finding
// is the one case where both partitions must coincide: two agents each judging
// it once is still two independent votes.
const partitionFor = (n) => {
  const batches = Array.from({ length: batchCount }, () => [])
  deduped.forEach((_, i) =>
    batches[n === 1 ? Math.floor(i * batchCount / deduped.length) : i % batchCount].push(i))
  return batches.filter(b => b.length)
}

// --- Cost gate (E8-S1 postmortem P4) -------------------------------------
// The skeptic wave is nearly the whole cost of a pass and its size is EXACT
// here, before a single skeptic launches: one agent per lens already ran, and
// verification spawns two agents per BATCH of deduped findings. E8-S1 learned this ~18M late —
// its round 1 logged 70 deduped (145 agents, ~10.3M) against a whole-story
// claim-set budget of ~3.4–9.8M, and nothing read the number until the top of
// the next fix round.
//
// This HOLDS, it does not cap. Roadmap §5: the story slips, the review does
// not shrink.
//
// A HELD RUN IS NOT A REVIEW ROUND, and the return is shaped so it cannot be
// read as one. Its own first red-team found that the earlier shape — a plain
// object with no `confirmed` key — satisfied §8 merge-checklist item 3 ("the
// final review round confirmed zero findings") off a pass that verified
// nothing, which would have let a budget hold launder an unverified
// trigger-tier diff into a mergeable one. So the four verdict keys are
// explicitly `null`: any downstream `.confirmed.length` throws instead of
// quietly reading 0, and the lens output is named `unverifiedFindings`.
//
// To proceed after presenting, re-invoke with BOTH `confirmOverBudget: true`
// and `resumeFromRunId: <this run's id>` (plus the same scriptPath/args) — the
// resume is what replays the completed lens agents from cache; a plain
// re-invocation re-rolls them live and can silently drop a finding you already
// presented.
//
// The comparison is cumulative: pass `spentTokens` (this story's review spend
// so far) so the gate prices the STORY, not the pass. Roadmap §5 budgets are
// per story across 1-2 passes, and without this the gate misses the second
// half of an overrun — replaying E8-S1 at the class ceiling, round 1 holds and
// round 2 does not, although round 2 is what carried the story to 1.9x.
// NOTE: this figure has THREE carriers — here, roadmap §5's unit sentence, and
// the literal in story-review.test.mjs's PROJECTED_TOKENS. All three move
// together at the next recalibration, or the gate under-projects and silently
// fails to fire, which is its one invisible failure direction.
const PER_AGENT_TOKENS = 80_000 // midpoint of the ~70–90k band recorded in roadmap §5
// A batched skeptic costs more than a single-finding one, but far less than the
// findings it covers would cost separately: the subject read is paid once and
// only the per-finding reasoning repeats. BATCH_MARGINAL is the share of a full
// agent that each ADDITIONAL finding in a batch adds. It is a provisional
// estimate — like PER_AGENT_TOKENS itself, which roadmap §5 already flags as
// provisional and partly circular — and it is deliberately pessimistic, so the
// gate over-projects rather than under-projects. Re-derive both at the next
// recalibration from a round's actuals; the AGENT COUNT below is exact either way.
const BATCH_MARGINAL = 0.35

// The clusterer already ran, but it counts: projectedAgents has always meant
// "agents this round costs", lenses included, not "agents still to launch".
const clusterAgents = clusterOutcome === 'skipped' ? 0 : 1
const skepticAgents = 2 * batchCount
const projectedAgents = lenses.length + clusterAgents + skepticAgents
const projectedTokens = Math.round(
  (lenses.length + clusterAgents) * PER_AGENT_TOKENS +
  skepticAgents * PER_AGENT_TOKENS * (1 + BATCH_MARGINAL * (skepticBatchSize - 1)))
const cumulativeTokens = spentTokens + projectedTokens
log(`skeptic wave projection: ${projectedAgents} agents ≈ ${(projectedTokens / 1e6).toFixed(1)}M` +
    (spentTokens ? ` (story total would reach ${(cumulativeTokens / 1e6).toFixed(1)}M)` : '') +
    (gateArmed ? ` — gate ARMED at ${(classBudgetTokens / 1e6).toFixed(1)}M` : ' — gate DISARMED (no classBudgetTokens)'))
if (gateArmed && cumulativeTokens > classBudgetTokens && args.confirmOverBudget !== true) {
  log(`HELD before the skeptic wave: ${(cumulativeTokens / 1e6).toFixed(1)}M would exceed the ` +
      `${(args.classBudgetTokens / 1e6).toFixed(1)}M class budget. NOT A REVIEW ROUND — nothing was verified. ` +
      `To proceed, re-invoke with confirmOverBudget: true AND resumeFromRunId set to this run.`)
  return {
    story: args.story, mode, status: 'held_over_budget',
    // Explicitly null, not absent and not []: a held run verified nothing, and
    // must not satisfy §8 item 3 or §5's zero-confirmed predicate by omission.
    confirmed: null, plausible: null, refuted: null, unverified: null,
    projectedAgents, projectedTokens, spentTokens, cumulativeTokens,
    classBudgetTokens, gateArmed,
    rawFindings: all.length, exactDedupedFindings: exact.length, dedupedFindings: deduped.length,
    clusterOutcome, skepticBatchSize,
    lensCount: lenses.length, unverifiedFindings: deduped,
  }
}

phase('Skeptic verify')
// Votes accumulate here by finding index. A batch agent that dies, returns
// nothing, skips a member, or votes on an index outside its own batch simply
// contributes no vote for the affected findings — which lands them in
// 'unverified' below, never in 'confirmed'. Every degradation path in this
// stage has to fail toward LESS confidence; that is the invariant.
const votesByFinding = deduped.map(() => [])
const recordVerdicts = (batch, result) => {
  if (!result || !Array.isArray(result.verdicts)) return
  const allowed = new Set(batch)
  const taken = new Set()
  for (const v of result.verdicts) {
    if (!v || !Number.isInteger(v.index) || !allowed.has(v.index) || taken.has(v.index)) continue
    if (typeof v.refuted !== 'boolean') continue
    taken.add(v.index)
    votesByFinding[v.index].push({ refuted: v.refuted, reason: v.reason })
  }
}
// INTERLEAVED — p1[0], p2[0], p1[1], p2[1], … — never all of partition 1 and
// then all of partition 2. Dispatch order decides what a TRUNCATING outage
// takes, and the ledger records that outage twice (2026-08-28: "24 of 27 agents
// dead, all skeptics"; E9-S9 round 4: "killed at 24 of 61"). Partition-major
// order would make the wave's whole second half consist of second votes, so a
// kill part-way through strips one vote from many findings rather than both
// votes from some — and a lone surviving non-refuting vote scores `confirmed`.
// That inverts the fail-toward-less-confidence invariant: the old nesting
// launched a finding's two skeptics adjacently, so a truncated tail landed in
// `unverified` with a warning. Interleaving restores that.
const skepticThunks = []
const partitions = [partitionFor(1), partitionFor(2)]
for (let b = 0; b < batchCount; b++) {
  for (const n of [1, 2]) {
    const batch = partitions[n - 1][b]
    if (!batch) continue
    skepticThunks.push(() => agent(
      `${stance}\n\nYou are a SKEPTIC. Try to REFUTE each of the ${batch.length} finding(s) below from story ` +
      `${args.story}. Default to refuted=true unless the failure scenario demonstrably holds against the ` +
      `actual code/doc.\n\n` +
      `Judge each finding INDEPENDENTLY and on its own merits. They were grouped for efficiency, not because ` +
      `they are related — a batch commonly contains a mix of real and refuted, and the verdict on one tells ` +
      `you nothing about the next.\n\n` +
      `Return one verdict per finding, keyed by the index shown. Do not omit any.\n\n` +
      batch.map(i => `--- index ${i} ---\n${JSON.stringify(deduped[i])}`).join('\n\n') +
      `\n\n${subject}\n\nVerify each against the source, then give one verdict per index.`,
      // skeptics pin no model: they inherit the SESSION's model (lenses above are pinned to opus), so a limit
      // on the session tier takes out verifiers first — run the trigger tier from the strongest tier; never
      // economize on verifiers. Batching changes the agent COUNT, never the tier.
      { label: `skeptic${n}:${batch.length}×[${batch[0]}…]`, phase: 'Skeptic verify', schema: BATCH_VERDICT_SCHEMA, effort: 'high' }
    ).then(r => recordVerdicts(batch, r)))
  }
}
// Sliced, so a mid-wave kill loses at most one slice of IN-FLIGHT agents rather
// than the whole wave (completed agents are journaled and replay on resume
// either way). 10.2% of this pipeline's total spend — 30.4M across the ledger
// to 2026-09-09 — went to usage-limit kills, all of them in multi-agent waves;
// batching above is the primary mitigation and this is the
// backstop for the rounds batching does not shrink enough.
const sliceSize = Math.max(1, Math.floor(args.skepticSliceSize ?? 25))
for (let i = 0; i < skepticThunks.length; i += sliceSize) {
  await parallel(skepticThunks.slice(i, i + sliceSize))
  if (skepticThunks.length > sliceSize) {
    log(`skeptic wave: ${Math.min(i + sliceSize, skepticThunks.length)}/${skepticThunks.length} agents done`)
  }
}
const results = deduped.map((f, i) => {
  const votes = votesByFinding[i]
  const refutes = votes.filter(v => v.refuted).length
  // Zero surviving votes means NO verification happened (skeptics died —
  // model limit, terminal API error). That must never read as 'confirmed':
  // a silent verifier failure is false confidence, the exact thing this
  // workflow exists to prevent. Surface it as its own status. (E2-S1 retro:
  // a Fable-limit outage killed 42 skeptics and 21 unverified findings were
  // reported as confirmed.)
  const status = votes.length === 0 ? 'unverified'
    : refutes === votes.length ? 'refuted'
    : refutes === 0 ? 'confirmed'
    : 'plausible'
  return { ...f, status, skepticVotes: votes.length, skeptic_reasons: votes.map(v => v.reason) }
})
const confirmed = results.filter(f => f.status === 'confirmed')
const plausible = results.filter(f => f.status === 'plausible')
const refuted = results.filter(f => f.status === 'refuted')
const unverified = results.filter(f => f.status === 'unverified')
log(`confirmed ${confirmed.length} · plausible ${plausible.length} · refuted ${refuted.length} · unverified ${unverified.length}`)
if (unverified.length) log(`WARNING: ${unverified.length} finding(s) got no surviving skeptic vote — UNVERIFIED, do not treat as confirmed`)
// A finding that kept only ONE of its two votes is weaker evidence than the
// verdict word implies, and the status ternary cannot say so — one non-refuting
// vote scores `confirmed` exactly like two. That scoring is PRE-EXISTING (the
// old nesting scored a lone survivor the same way) so it is not changed here,
// but it is no longer silent: an outage that halves the wave now announces
// itself in the record instead of reading as a clean round.
const singleVote = results.filter(f => f.skepticVotes === 1)
if (singleVote.length) log(`WARNING: ${singleVote.length} finding(s) got only ONE surviving skeptic vote — ` +
  `verified once, not twice: ${singleVote.map(f => f.title.slice(0, 40)).join(' · ')}`)
return { story: args.story, mode, confirmed, plausible, refuted, unverified, lensCount: lenses.length, deadLenses,
         gateArmed, classBudgetTokens, spentTokens, projectedAgents, projectedTokens, cumulativeTokens,
         rawFindings: all.length, exactDedupedFindings: exact.length, dedupedFindings: deduped.length,
         clusterOutcome, skepticBatchSize }
