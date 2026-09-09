#!/usr/bin/env node
// Tests for story-review.js's cost gate (E8-S1 postmortem P4).
//
// WHY THIS EXISTS. The gate was proposed as a prose rule in run-story §5 —
// "read the dedup log line before the skeptic wave and compare it to the class
// budget". This house has measured what happens to prose gates: the
// tree-hygiene rule shipped broken three times because prose cannot be tested,
// and converged only once it became a script with tests (#486, #494). A rule
// that asks a PM to notice a log line mid-run is worse still: the workflow runs
// in the background, so nobody is necessarily looking at the moment the number
// appears. The gate therefore lives in the workflow, which already computes the
// number, and this file is what makes it falsifiable.
//
// WHAT IT ASSERTS, and why each case is here rather than folded into another:
//   1. no budget passed        -> proceeds (the gate must stay opt-in; every
//                                 existing caller omits the arg)
//   2. projection under budget -> proceeds (it must be possible NOT to fire;
//                                 a gate that always fires is noise, the
//                                 failure mode tree-hygiene.test.sh guards)
//   3. projection over budget  -> HOLDS, and crucially spawns ZERO skeptics
//                                 (holding after paying for the wave is not a
//                                 gate)
//   4. over budget + confirm   -> proceeds (the escape hatch must work, or the
//                                 gate becomes a cap; roadmap §5 forbids caps)
//   5. projection arithmetic   -> lenses + clusterer + 2 x batchCount, where
//                                 batchCount is max(2, ceil(deduped /
//                                 skepticBatchSize)) above one finding. Cases
//                                 1-13 pin batch size 1 and no clusterer, where
//                                 that gives the same agent count as the
//                                 pre-2026-09-09 lenses + 2 x deduped — which is
//                                 the point: the escape hatch must reproduce the
//                                 old arithmetic.
//   6. dedup unchanged         -> the gate must not perturb what it measures
//   7. held run is not a round -> the four verdict keys are null, NOT absent and
//                                 NOT [], so a downstream count throws rather
//                                 than reading zero. This is the gate's own
//                                 first red-team finding: without it a budget
//                                 hold satisfies §8 checklist item 3 ("the
//                                 final review round confirmed zero findings")
//                                 off a pass that verified nothing, laundering
//                                 an unverified trigger-tier diff into a
//                                 mergeable one. Lens output is named
//                                 `unverifiedFindings`, never `findings`.
//   8. cumulative budget       -> spentTokens + projection is compared, because
//                                 roadmap §5 budgets are per STORY over 1-2
//                                 passes; pass-at-a-time pricing misses the
//                                 second half of an overrun
//   9. cumulative under budget -> prior spend alone must not fire the gate
//  10. input validation        -> a wrong-typed budget ("9.8M", negative, NaN)
//                                 THROWS instead of silently disabling the
//                                 gate, which is its invisible failure
//                                 direction: a hold announces itself, a
//                                 missing hold does not
//  11. armed/disarmed recorded -> both returns say whether the gate was armed,
//                                 so a reader can tell a passed gate from an
//                                 absent one
//  12. magnitude guard        -> a bare `7.16` meaning 7.16M passes every type
//                                 check and silently disarms the half it
//                                 belongs to, so it throws too
//  13. gate log content       -> the ARMED/DISARMED/NOT-A-REVIEW-ROUND lines are
//                                 asserted, because deleting them left the
//                                 suite green when they were the deliverable
//
// Cases 14-21 cover clustering, skeptic batching, slicing and stance parity;
// they carry their own list at the point they are defined rather than extending
// this one, because this list is about the COST GATE and they are not.
//
// Keep this list in step with the cases below. It went stale once already, in
// the commit that added cases 7-9, and a whitespace-mismatched patch then
// silently failed to fix it — the D-T6 class twice over (a document has no call
// graph, so a dependent of your edit does not announce itself).
//
// Run: node .claude/workflows/story-review.test.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC_PATH = join(here, 'story-review.js')
const SRC = readFileSync(SRC_PATH, 'utf8')
const REVIEWER_PATH = join(here, '..', 'agents', 'adversarial-reviewer.md')

// --- stance parity -------------------------------------------------------
// The lens stance exists twice by necessity: `.claude/agents/adversarial-
// reviewer.md` is the contract, and story-review.js carries an inline copy
// because the workflow must run in sessions where custom agent types are not
// loaded. The pair drifted before: #517 (merged 2026-09-06) re-synced it after
// finding the copy missing three ## Stance items. Hand-syncing is what let that
// happen; nothing checked the pair.
//
// Prose cannot hold two files in step. So the .md is now the SOURCE and the
// constant is DERIVED from it by the mechanical transform below, asserted
// byte-for-byte. `node story-review.test.mjs --fix` regenerates the constant;
// nothing else should ever edit it by hand.
const deriveStance = (md) => {
  const start = md.indexOf('<!-- mirror:start -->')
  const end = md.indexOf('<!-- mirror:end -->')
  if (start < 0 || end < 0) throw new Error('adversarial-reviewer.md is missing its mirror:start/end markers')
  return md.slice(start, end)
    // Spans the contract carries for its human readers but a lens must not be
    // told — the notes documenting this mirror, and the per-finding field list
    // that FINDINGS_SCHEMA already enforces.
    .replace(/<!-- mirror:skip:start -->[\s\S]*?<!-- mirror:skip:end -->/g, ' ')
    // `## Never`'s bullets are bare imperatives ("Patch the code..."). Stripping
    // the heading without this would invert every one of them into an order.
    .replace(/<!-- mirror:text:\s*([\s\S]*?)\s*-->/g, ' $1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^#{1,6} .*$/gm, ' ')
    .replace(/^\s*- /gm, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
const STANCE_RE = /^const stance = ("(?:[^"\\]|\\.)*")$/m
const expectedStance = deriveStance(readFileSync(REVIEWER_PATH, 'utf8'))

if (process.argv.includes('--fix')) {
  if (!STANCE_RE.test(SRC)) throw new Error('could not locate the `const stance = "…"` line to regenerate')
  writeFileSync(SRC_PATH, SRC.replace(STANCE_RE, () => `const stance = ${JSON.stringify(expectedStance)}`))
  console.log(`regenerated stance from adversarial-reviewer.md (${expectedStance.length} chars)`)
  process.exit(0)
}

// The workflow runtime wraps the script in an async function and injects its
// globals, which is why the file legally ends in a top-level `return` and why
// `node --check` rejects it standalone. Reproduce that wrapper exactly; the
// only edit is stripping the ESM `export` keyword, which cannot appear inside
// a function body.
function loadScript() {
  const body = SRC.replace(/^export const meta/m, 'const meta')
  // eslint-disable-next-line no-new-func
  return new Function(
    'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
    `return (async () => { ${body} })()`
  )
}

// `cluster` returns the grouping the clustering agent would produce: a function
// of the finding list, or the string 'dead' for an agent that returns null.
// Default is all-singletons, i.e. a clusterer that merges nothing, so a case
// that is not about clustering keeps predictable arithmetic.
//
// `skeptic` is called once per BATCH agent with {n, indices, call} and returns
// the verdict rows that agent emits, or null for a dead agent. Default: one
// non-refuting verdict per index. Batching means "how many agents" and "how
// many votes" are now different numbers, so the harness counts both — the vote
// count is the invariant that must not move when the batch size does.
function makeHarness({ findingsPerLens, args, deadLenses, cluster, skeptic }) {
  const calls = { lens: 0, skeptic: 0, votes: 0, cluster: 0, batches: [], slices: [], logs: [] }
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label.startsWith('lens:')) {
      calls.lens++
      const key = label.slice('lens:'.length)
      // A dead lens is `null` — exactly what agent() returns on a terminal error
      // or a user skip. #526's defect only exists in this state.
      if ((deadLenses || []).includes(key)) return null
      return { findings: (findingsPerLens[key] || []) }
    }
    if (label === 'cluster') {
      calls.cluster++
      // The roster the script builds is what a real clusterer indexes against.
      const n = (prompt.match(/^\d+\. \[lens:/gm) || []).length
      if (cluster === 'dead') return null
      if (typeof cluster === 'function') return cluster(n)
      return { groups: Array.from({ length: n }, (_, i) => ({ members: [i] })) }
    }
    if (label.startsWith('skeptic')) {
      calls.skeptic++
      const n = Number(label.slice('skeptic'.length, label.indexOf(':')))
      const indices = [...prompt.matchAll(/^--- index (\d+) ---$/gm)].map((m) => Number(m[1]))
      calls.batches.push({ n, indices })
      const rows = skeptic
        ? skeptic({ n, indices, call: calls.skeptic })
        : indices.map((i) => ({ index: i, refuted: false, reason: 'stub' }))
      if (rows === null) return null
      calls.votes += rows.length
      return { verdicts: rows }
    }
    throw new Error(`unexpected agent label: ${label}`)
  }
  const parallel = async (thunks) => {
    calls.slices.push(thunks.length)
    return Promise.all(thunks.map((t) => t()))
  }
  const pipeline = async () => { throw new Error('pipeline not used by this script') }
  const phase = () => {}
  const log = (m) => calls.logs.push(String(m))
  return { calls, run: () => loadScript()(agent, parallel, pipeline, phase, log, args, { total: null }, null) }
}

// Cases 1-13 and the #526 pair are about the COST GATE and lens attribution, not
// about clustering or batching. They pin skepticBatchSize:1 and push the cluster
// threshold out of reach so their arithmetic stays the fixed target it was
// written against — which is also the assertion that the escape hatch is real:
// under these two args the script must behave exactly as it did before
// 2026-09-09. Clustering and batching get their own cases (14-19) that exercise
// the DEFAULTS, so neither path ships untested.
const baseArgs = (extra = {}) => ({
  story: 'TEST-1',
  mode: 'design',
  docPath: '/tmp/doc.md',
  context: 'test',
  skepticBatchSize: 1,
  clusterMinFindings: 999,
  ...extra,
})

// The script's own defaults are 3 lenses in design mode and 4 in diff mode, both
// overridable via args.lenses. Pin an explicit two-lens set here so the
// arithmetic in every assertion below is fixed and not a moving target.
const LENSES = [
  { key: 'a', focus: 'a' },
  { key: 'b', focus: 'b' },
]
const finding = (title) => ({
  title, claim: 'c', severity: 'major', failure_scenario: 'f', file: 'x.md', repo: 'r',
  // line and suggested_kill_test are here so the merged-alternate assertion can
  // actually see them dropped. Without them the check passed against a payload
  // that still discarded both.
  line: 7, suggested_kill_test: 'k',
})

// Mirrors the script's batch-count rule, including the floor of 2 that keeps the
// two partitions from collapsing into one. Kept as an expression the cases read
// so a change to the rule shows up as a diff here, not as silent drift.
const expectedBatchCount = (n, size) => (n <= 1 ? n : Math.max(2, Math.ceil(n / size)))

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`) }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++ }
}

// Two lenses, three distinct findings each -> 6 deduped -> 2 + 12 = 14 agents.
const SIX = {
  a: [finding('one'), finding('two'), finding('three')],
  b: [finding('four'), finding('five'), finding('six')],
}
const PROJECTED_AGENTS = 2 + 2 * 6           // 14
const PROJECTED_TOKENS = PROJECTED_AGENTS * 80_000  // 1.12M

console.log('story-review cost gate')

// 1 — no budget: gate is opt-in, must not interfere
{
  const h = makeHarness({ findingsPerLens: SIX, args: baseArgs({ lenses: LENSES }) })
  const r = await h.run()
  check('no classBudgetTokens -> proceeds', r.status === undefined && h.calls.skeptic === 12,
        `status=${r.status} skeptics=${h.calls.skeptic}`)
}

// 2 — under budget: the gate must be able NOT to fire
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS + 1 }),
  })
  const r = await h.run()
  check('projection under budget -> proceeds', r.status === undefined && h.calls.skeptic === 12,
        `status=${r.status} skeptics=${h.calls.skeptic}`)
}

// 3 — over budget: holds, and pays for nothing
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS - 1 }),
  })
  const r = await h.run()
  check('projection over budget -> holds', r.status === 'held_over_budget', `status=${r.status}`)
  check('hold spawns zero skeptics', h.calls.skeptic === 0, `skeptics=${h.calls.skeptic}`)
  check('hold returns the lens output for presentation', Array.isArray(r.unverifiedFindings) && r.unverifiedFindings.length === 6,
        `unverifiedFindings=${r.unverifiedFindings && r.unverifiedFindings.length}`)
  check('hold reports the projection', r.projectedAgents === PROJECTED_AGENTS && r.projectedTokens === PROJECTED_TOKENS,
        `agents=${r.projectedAgents} tokens=${r.projectedTokens}`)
}

// 4 — over budget + confirm: the escape hatch, or the gate is a cap
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS - 1, confirmOverBudget: true }),
  })
  const r = await h.run()
  check('over budget + confirmOverBudget -> proceeds', r.status === undefined && h.calls.skeptic === 12,
        `status=${r.status} skeptics=${h.calls.skeptic}`)
}

// 5 — arithmetic: one agent per lens, two skeptics per deduped finding
{
  const one = { a: [finding('only')], b: [] }
  const h = makeHarness({
    findingsPerLens: one,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: 100_000 }),
  })
  const r = await h.run()
  // batch size 1, clusterer skipped: lenses + 0 + 2 x ceil(1/1) = the old formula
  check('projection = lenses + clusterer + 2 x batchCount',
        r.projectedAgents === 2 + 0 + 2 * 1, `agents=${r.projectedAgents}`)
}

// 6 — the gate must not perturb what it measures: dedup still collapses
//     same repo|file|title, and the projection is computed on the DEDUPED count
{
  const dupes = { a: [finding('same'), finding('same')], b: [finding('same')] }
  const h = makeHarness({
    findingsPerLens: dupes,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: 100_000 }),
  })
  const r = await h.run()
  check('dedup unchanged (3 raw -> 1 deduped)', r.rawFindings === 3 && r.dedupedFindings === 1,
        `raw=${r.rawFindings} deduped=${r.dedupedFindings}`)
  check('projection uses deduped, not raw', r.projectedAgents === 2 + 2 * 1, `agents=${r.projectedAgents}`)
}

// 7 — a held run must be structurally unreadable as a review round
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS - 1 }),
  })
  const r = await h.run()
  check('held: confirmed is null, not absent',
        r.confirmed === null && 'confirmed' in r, `confirmed=${r.confirmed} present=${'confirmed' in r}`)
  check('held: plausible/refuted/unverified all null',
        r.plausible === null && r.refuted === null && r.unverified === null)
  // The defect this guards: `(r.confirmed || []).length === 0` reads TRUE on an
  // absent key and on [], and would satisfy §8 item 3. It must throw instead.
  let threw = false
  try { void r.confirmed.length } catch { threw = true }
  check('held: reading a verdict count throws rather than reading zero', threw)
  check('held: lens output is named unverifiedFindings, not findings',
        Array.isArray(r.unverifiedFindings) && r.unverifiedFindings.length === 6 && r.findings === undefined,
        `unverified=${r.unverifiedFindings && r.unverifiedFindings.length} findings=${r.findings}`)
}

// 8 — the budget is cumulative across the story's passes, not per pass
{
  // Projection alone fits the budget; prior spend pushes it over. A pass-at-a-
  // time gate proceeds here and misses the half that completes the overrun.
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({
      lenses: LENSES,
      classBudgetTokens: PROJECTED_TOKENS + 100_000,
      spentTokens: 200_000,
    }),
  })
  const r = await h.run()
  check('spentTokens counts toward the budget -> holds', r.status === 'held_over_budget', `status=${r.status}`)
  check('held reports cumulative total', r.cumulativeTokens === PROJECTED_TOKENS + 200_000,
        `cumulative=${r.cumulativeTokens}`)
  check('cumulative hold spawns zero skeptics', h.calls.skeptic === 0, `skeptics=${h.calls.skeptic}`)
}

// 9 — spentTokens must not fire the gate on its own when the total still fits
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({
      lenses: LENSES,
      classBudgetTokens: PROJECTED_TOKENS + 300_000,
      spentTokens: 200_000,
    }),
  })
  const r = await h.run()
  check('cumulative under budget -> proceeds', r.status === undefined && h.calls.skeptic === 12,
        `status=${r.status} skeptics=${h.calls.skeptic}`)
}

// 10 — a wrong-typed or nonsensical budget must THROW, not silently disarm.
//      The house writes budgets as "9.8M" in prose; a string is truthy and
//      `n > "9.8M"` is false, so the pre-validation gate would have proceeded
//      while looking armed.
{
  const bad = [['9.8M', 'string'], [-1, 'negative'], [Number.NaN, 'NaN']]
  for (const [value, kind] of bad) {
    const h = makeHarness({ findingsPerLens: SIX, args: baseArgs({ lenses: LENSES, classBudgetTokens: value }) })
    let threw = false
    try { await h.run() } catch { threw = true }
    check(`classBudgetTokens as ${kind} throws before any agent runs`,
          threw && h.calls.lens === 0 && h.calls.skeptic === 0,
          `threw=${threw} lenses=${h.calls.lens} skeptics=${h.calls.skeptic}`)
  }
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS + 1, spentTokens: '0.66M' }),
  })
  let threw = false
  try { await h.run() } catch { threw = true }
  check('spentTokens as string throws before any agent runs', threw && h.calls.lens === 0,
        `threw=${threw} lenses=${h.calls.lens}`)
}

// 11 — armed vs disarmed must be visible on BOTH returns, or a passed gate and
//      an absent one are indistinguishable in the record
{
  const armed = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS + 1 }),
  })
  const ra = await armed.run()
  check('completed run records gateArmed true', ra.gateArmed === true, `gateArmed=${ra.gateArmed}`)
  check('completed run carries the projection', ra.projectedAgents === PROJECTED_AGENTS,
        `agents=${ra.projectedAgents}`)

  const disarmed = makeHarness({ findingsPerLens: SIX, args: baseArgs({ lenses: LENSES }) })
  const rd = await disarmed.run()
  check('completed run records gateArmed false when no budget', rd.gateArmed === false, `gateArmed=${rd.gateArmed}`)

  const held = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS - 1 }),
  })
  const rh = await held.run()
  check('held run records gateArmed true', rh.gateArmed === true, `gateArmed=${rh.gateArmed}`)
}

// 12 — a bare magnitude silently disarms the half it belongs to: `7.16` meaning
//      7.16M is a non-negative finite number and passes every type check while
//      contributing nothing to the cumulative comparison
{
  for (const [field, value] of [['spentTokens', 7.16], ['classBudgetTokens', 9.8]]) {
    const h = makeHarness({
      findingsPerLens: SIX,
      args: baseArgs({ lenses: LENSES, classBudgetTokens: 9_800_000, [field]: value }),
    })
    let threw = false
    try { await h.run() } catch { threw = true }
    check(`${field} as a bare magnitude (${value}) throws`, threw && h.calls.lens === 0,
          `threw=${threw} lenses=${h.calls.lens}`)
  }
}

// 13 — the ARMED/DISARMED log line is what makes a passed gate distinguishable
//      from an absent one in the record. Without this, deleting it entirely
//      leaves the suite green.
{
  const armed = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS + 1 }),
  })
  await armed.run()
  const aLog = armed.calls.logs.find((l) => l.includes('projection'))
  check('armed run logs ARMED with the budget', !!aLog && /gate ARMED at 1\.1M/.test(aLog), `log=${aLog}`)

  const off = makeHarness({ findingsPerLens: SIX, args: baseArgs({ lenses: LENSES }) })
  await off.run()
  const oLog = off.calls.logs.find((l) => l.includes('projection'))
  check('disarmed run says DISARMED', !!oLog && /gate DISARMED/.test(oLog), `log=${oLog}`)

  const held = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: PROJECTED_TOKENS - 1 }),
  })
  await held.run()
  check('held run logs NOT A REVIEW ROUND',
        held.calls.logs.some((l) => l.includes('NOT A REVIEW ROUND')),
        `logs=${JSON.stringify(held.calls.logs)}`)
}

// --- #526: lens attribution and liveness ---------------------------------
// WHY THESE ARE HERE. The fix for #526 shipped with zero coverage: the whole
// change could be reverted and every existing assertion stayed green, because
// no case in this file ever killed a lens.
//
//   8. a lens dying must NOT relabel the survivors. The pre-fix expression
//      `filter(Boolean).flatMap((r,i) => lenses[i])` re-indexed, shifting the
//      label of every lens ORIGINALLY AFTER the dead one. The dead lens here is
//      index 0 precisely because that is the case where the old code was wrong
//      about every survivor — kill a LATER index and the old code still passes.
//   9. the death must be REPORTED, in the log and on the returned object. A
//      round that hunted with fewer lenses than it claims is not the round the
//      PM thinks they read.
//  10. ALL lenses dying must not look like a clean pass — the same null-verdict
//      contract as the budget hold (case 7), for the same reason.
{
  const THREE = [{ key: 'a', focus: 'a' }, { key: 'b', focus: 'b' }, { key: 'c', focus: 'c' }]
  const h = makeHarness({
    findingsPerLens: { b: [finding('from-b')], c: [finding('from-c')] },
    deadLenses: ['a'],
    args: baseArgs({ lenses: THREE }),
  })
  const out = await h.run()
  const labels = [...(out.confirmed || []), ...(out.plausible || []), ...(out.refuted || [])]
    .map((f) => `${f.title}:${f.lens}`).sort().join(',')
  check('a dead lens does not relabel the survivors (#526)',
        labels === 'from-b:b,from-c:c',
        `got ${labels} — pre-fix this was from-b:a,from-c:b`)
  check('a dead lens is named in the run log',
        h.calls.logs.some((l) => l.includes('DIED') && l.includes('a')),
        `logs=${JSON.stringify(h.calls.logs)}`)
  check('a dead lens is surfaced on the returned object',
        Array.isArray(out.deadLenses) && out.deadLenses.join() === 'a',
        `deadLenses=${JSON.stringify(out.deadLenses)}`)
}

{
  const h = makeHarness({
    findingsPerLens: {},
    deadLenses: ['a', 'b'],
    args: baseArgs({ lenses: LENSES }),
  })
  const out = await h.run()
  check('all lenses dead is NOT a review round', out.status === 'all_lenses_died', `status=${out.status}`)
  check('all lenses dead nulls the four verdict keys, not []',
        out.confirmed === null && out.plausible === null && out.refuted === null && out.unverified === null,
        `confirmed=${JSON.stringify(out.confirmed)}`)
  check('all lenses dead spawns zero skeptics', h.calls.skeptic === 0, `skeptics=${h.calls.skeptic}`)
}

// --- clustering, batching, slicing (2026-09-09 efficiency batch) ----------
// WHY THESE ARE HERE. Cases 1-13 pin skepticBatchSize:1 and clusterMinFindings
// out of reach, so they assert the ESCAPE HATCH and would stay green if the new
// default path were entirely broken. These exercise the defaults.
//
//  14. clustering collapses the wave, and the collapse reaches the projection
//      (the gate must price what will actually run, not what would have)
//  15. a clusterer that is not an exact partition is REJECTED WHOLE. This is
//      the safety property: under-merging costs money, over-merging or dropping
//      hides a defect from verification entirely. Each entry is a different way
//      to lose a finding silently.
//  16. a dead clusterer degrades to unclustered, loudly
//  17. two votes per finding survive batching — the invariant that must not
//      move when the batch size does
//  18. batch-mates differ between the two partitions, so one dead agent cannot
//      take both of a finding's votes, and a batch that omits or forges a
//      verdict degrades toward UNVERIFIED and never toward confirmed
//  19. no parallel() call exceeds the slice size
//  20. the documented defaults are the actual defaults
//  21. stance parity with adversarial-reviewer.md

// 14 — clustering collapses the wave and the projection follows it
{
  const h = makeHarness({
    findingsPerLens: SIX,
    // Six findings -> three groups of two, each pairing a lens-a finding (0-2)
    // with a lens-b one (3-5). Cross-lens on purpose: a same-lens grouping would
    // make the "names every lens" assertion below unfalsifiable.
    cluster: () => ({ groups: [{ members: [0, 3] }, { members: [1, 4] }, { members: [2, 5] }] }),
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 6 }),
  })
  const r = await h.run()
  check('clustering collapses 6 -> 3', r.exactDedupedFindings === 6 && r.dedupedFindings === 3,
        `exact=${r.exactDedupedFindings} deduped=${r.dedupedFindings}`)
  // 3 clustered findings at batch size 4 -> batchCount floors to 2 -> 4 skeptic
  // agents (was 12 unclustered at size 1). The floor is why this is 4 and not 2.
  check('projection prices the CLUSTERED count', r.projectedAgents === 2 + 1 + 4,
        `agents=${r.projectedAgents}`)
  check('clustering cuts the skeptic wave', h.calls.skeptic === 4, `skeptics=${h.calls.skeptic}`)
  check('every clustered finding still gets 2 votes',
        [...r.confirmed, ...r.plausible, ...r.refuted].every((f) => f.skepticVotes === 2))
  const merged = [...r.confirmed, ...r.plausible, ...r.refuted]
  // NOT `lenses.length >= 1`, which every possible implementation satisfies.
  // Each group here pairs one lens-a finding with one lens-b finding, so the
  // merged representative must name BOTH lenses and carry exactly one alternate.
  check('a merged finding names every lens that found it (2 distinct)',
        merged.every((f) => f.merged_from.length === 1 && [...new Set(f.lenses)].length === 2),
        JSON.stringify(merged.map((f) => [f.title, f.lenses, f.merged_from.length])))
  // C2: the alternate must arrive WHOLE. Dropping failure_scenario narrows the
  // cluster to one scenario on the exact field the skeptic prompt tests against.
  // Every field FINDINGS_SCHEMA defines, named individually: a summary payload
  // that keeps three of them must fail this, which is what it did before.
  const ALT_FIELDS = ['title', 'claim', 'severity', 'failure_scenario', 'file', 'repo',
                      'line', 'suggested_kill_test', 'lens']
  check('a merged alternate carries its full finding, not a summary',
        merged.every((f) => f.merged_from.every((m) => ALT_FIELDS.every((k) => m[k] !== undefined))),
        JSON.stringify(merged[0] && merged[0].merged_from))
  check('clusterOutcome is recorded', r.clusterOutcome === '6 → 3', `outcome=${r.clusterOutcome}`)
}

// 15 — a malformed grouping is rejected WHOLE, never partially applied
{
  const bad = {
    'drops an index': { groups: [{ members: [0, 1] }, { members: [2, 3] }] },            // 4 and 5 vanish
    'duplicates an index': { groups: [{ members: [0, 1] }, { members: [1, 2, 3, 4, 5] }] },
    'invents an index': { groups: [{ members: [0, 1, 2, 3, 4, 5] }, { members: [6] }] },
    'out of range': { groups: [{ members: [0, 1, 2, 3, 4, 99] }] },
    'empty group': { groups: [{ members: [] }, { members: [0, 1, 2, 3, 4, 5] }] },
    'no groups': { groups: [] },
  }
  for (const [kind, grouping] of Object.entries(bad)) {
    const h = makeHarness({
      findingsPerLens: SIX,
      cluster: () => grouping,
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 6 }),
    })
    const r = await h.run()
    const judged = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    check(`clusterer that ${kind} -> rejected, nothing lost`,
          r.dedupedFindings === 6 && judged.length === 6 && /REJECTED/.test(r.clusterOutcome),
          `deduped=${r.dedupedFindings} judged=${judged.length} outcome=${r.clusterOutcome}`)
    check(`clusterer that ${kind} -> says so in the log`,
          h.calls.logs.some((l) => l.includes('REJECTED')), `logs=${JSON.stringify(h.calls.logs)}`)
  }
}

// 16 — a dead clusterer must degrade to unclustered, not to zero findings
{
  const h = makeHarness({
    findingsPerLens: SIX,
    cluster: 'dead',
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 6 }),
  })
  const r = await h.run()
  check('dead clusterer -> proceeds unclustered with all 6',
        r.dedupedFindings === 6 && /clusterer died/.test(r.clusterOutcome), `outcome=${r.clusterOutcome}`)
}

// 17 — the vote invariant: batching changes agent count, never votes per finding
{
  for (const size of [1, 2, 3, 4, 6, 99]) {
    const h = makeHarness({
      findingsPerLens: SIX,
      args: baseArgs({ lenses: LENSES, skepticBatchSize: size, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const all = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    const expectedAgents = 2 * expectedBatchCount(6, size)
    check(`batch size ${size}: every finding gets exactly 2 votes`,
          all.length === 6 && all.every((f) => f.skepticVotes === 2),
          `judged=${all.length} votes=${all.map((f) => f.skepticVotes).join(',')}`)
    check(`batch size ${size}: ${expectedAgents} skeptic agents, ${h.calls.votes} votes`,
          h.calls.skeptic === expectedAgents && h.calls.votes === 12,
          `agents=${h.calls.skeptic} votes=${h.calls.votes}`)
  }
}

// 18 — degradation must always run toward LESS confidence
{
  // (a) the two partitions must not be the same partition, or a dead agent
  //     takes both votes for everything it was judging
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    await h.run()
    const p1 = h.calls.batches.filter((b) => b.n === 1).map((b) => b.indices.join(','))
    const p2 = h.calls.batches.filter((b) => b.n === 2).map((b) => b.indices.join(','))
    check('partition 2 is not partition 1', p1.join('|') !== p2.join('|'), `p1=${p1} p2=${p2}`)
    const shared = p1.filter((b) => p2.includes(b))
    check('no batch is identical across partitions', shared.length === 0, `shared=${shared}`)
  }
  // (b) one dead batch costs at most ONE of each affected finding's two votes
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      skeptic: ({ n, indices, call }) => (call === 1 ? null : indices.map((i) => ({ index: i, refuted: false, reason: 'r' }))),
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const all = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    check('a dead batch leaves every finding with >= 1 vote',
          all.every((f) => f.skepticVotes >= 1), `votes=${all.map((f) => f.skepticVotes).join(',')}`)
    check('a dead batch produces no unverified findings here',
          r.unverified.length === 0, `unverified=${r.unverified.length}`)
  }
  // (c) both batches covering a finding dying -> UNVERIFIED, never confirmed
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      skeptic: () => null,
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    check('all skeptic batches dead -> all findings UNVERIFIED, none confirmed',
          r.unverified.length === 6 && r.confirmed.length === 0,
          `unverified=${r.unverified.length} confirmed=${r.confirmed.length}`)
    check('all batches dead is warned about',
          h.calls.logs.some((l) => l.includes('UNVERIFIED')), `logs=${JSON.stringify(h.calls.logs)}`)
  }
  // (d) a batch that silently omits a verdict must not confirm that finding on
  //     the strength of the other partition's single vote count alone
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      skeptic: ({ indices }) => indices.filter((i) => i !== 0).map((i) => ({ index: i, refuted: false, reason: 'r' })),
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const zero = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified].find((f) => f.title === 'one')
    check('a finding both batches omit is UNVERIFIED', zero.status === 'unverified' && zero.skepticVotes === 0,
          `status=${zero.status} votes=${zero.skepticVotes}`)
  }
  // (e) a batch voting on an index outside its own batch is ignored — otherwise
  //     one confused agent can cast unlimited votes on findings it never read
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      skeptic: ({ indices, call }) => (call === 1
        ? [...indices, 97, 98].map((i) => ({ index: i, refuted: true, reason: 'forged' }))
        : indices.map((i) => ({ index: i, refuted: false, reason: 'r' }))),
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const all = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    check('out-of-batch verdicts are discarded',
          all.length === 6 && all.every((f) => f.skepticVotes <= 2),
          `votes=${all.map((f) => f.skepticVotes).join(',')}`)
  }
  // (f) a batch double-voting on one of its own members counts once
  {
    const h = makeHarness({
      findingsPerLens: SIX,
      skeptic: ({ indices }) => [...indices, indices[0]].map((i) => ({ index: i, refuted: false, reason: 'r' })),
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const all = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    check('a repeated index inside a batch counts once',
          all.every((f) => f.skepticVotes === 2), `votes=${all.map((f) => f.skepticVotes).join(',')}`)
  }
}

// 19 — slicing bounds how many agents are in flight at once
{
  const many = {
    a: Array.from({ length: 30 }, (_, i) => finding(`a${i}`)),
    b: Array.from({ length: 30 }, (_, i) => finding(`b${i}`)),
  }
  const h = makeHarness({
    findingsPerLens: many,
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 1, clusterMinFindings: 999, skepticSliceSize: 25 }),
  })
  await h.run()
  // 60 findings, batch size 1 -> 120 skeptic agents, capped at 25 per parallel()
  const skepticSlices = h.calls.slices.filter((n) => n > 0 && n <= 25)
  check('no skeptic slice exceeds skepticSliceSize',
        h.calls.slices.every((n) => n <= 25) && h.calls.skeptic === 120,
        `slices=${h.calls.slices.join(',')} skeptics=${h.calls.skeptic}`)
  check('slicing does not lose agents', skepticSlices.reduce((a, b) => a + b, 0) >= 120,
        `sum=${skepticSlices.reduce((a, b) => a + b, 0)}`)
  check('slice progress is logged', h.calls.logs.some((l) => /skeptic wave: \d+\/120/.test(l)))
}

// 20 — the documented defaults must be the real ones. Without this, cases 14-19
//      all pin their args explicitly and a changed default ships untested.
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: { story: 'T', mode: 'design', docPath: '/tmp/d.md', context: 't', lenses: LENSES },
  })
  const r = await h.run()
  check('default skepticBatchSize is 4', r.skepticBatchSize === 4, `size=${r.skepticBatchSize}`)
  // 6 findings >= default clusterMinFindings of 6 -> the clusterer runs
  check('default clusterMinFindings is 6 (clusterer ran on 6 findings)', h.calls.cluster === 1,
        `clusterCalls=${h.calls.cluster}`)
  const h5 = makeHarness({
    findingsPerLens: { a: [finding('1'), finding('2'), finding('3')], b: [finding('4'), finding('5')] },
    args: { story: 'T', mode: 'design', docPath: '/tmp/d.md', context: 't', lenses: LENSES },
  })
  const r5 = await h5.run()
  check('5 findings is below the default threshold -> clusterer skipped',
        h5.calls.cluster === 0 && r5.clusterOutcome === 'skipped', `outcome=${r5.clusterOutcome}`)
}

// 21 — stance parity. The constant is GENERATED from adversarial-reviewer.md;
//      this is what makes "change one, change both" enforceable instead of
//      aspirational. Regenerate with `--fix`, never by hand.
{
  const m = SRC.match(STANCE_RE)
  check('stance is a generated string literal', !!m, 'no `const stance = "…"` line found')
  if (m) {
    check('stance matches adversarial-reviewer.md byte-for-byte',
          JSON.parse(m[1]) === expectedStance,
          'run: node .claude/workflows/story-review.test.mjs --fix')
  }
  // Named individually so a transform that silently drops a section fails loudly.
  for (const [what, probe] of [
    ['lens-scope bullet', 'Hunt from your assigned lens only'],
    ['refute-your-own-candidate clause', 'refuting your own candidate is a valid'],
    ['safety-gate bullet', 'Safety-gate diffs get special suspicion'],
    ['D-T4 false-prose bullet', 'is a claim, and a false one is a finding'],
    ['zero-findings sentence', 'Zero findings is a legitimate report'],
  ]) check(`stance carries the ${what}`, expectedStance.includes(probe))
  // The contract's own meta-prose must NOT reach a lens prompt.
  check('stance excludes the mirror meta-notes',
        !expectedStance.includes('Mirrored, by necessity') && !expectedStance.includes('Change one, change both'))
  check('stance excludes the per-finding field list (FINDINGS_SCHEMA carries it)',
        !expectedStance.includes('suggested_kill_test'))
  // `## Never`'s bullets are bare imperatives; dropping the heading without a
  // lead-in would turn every prohibition into an instruction.
  check('the Never section keeps a negating lead-in',
        /Never do any of the following:\s*Patch the code/.test(expectedStance))
}


// --- 22: regressions for the #528 red-team's confirmed findings -----------
// Every case below is a defect the design red-team of this change set found in
// it. They are grouped here rather than folded into 14-21 because each names a
// specific finding, and a future reader should be able to delete the fix and
// watch a NAMED case go red.
//
//  C1  partition-major dispatch let a truncating outage strip second votes
//  C2  the cluster merge dropped failure_scenario/file/line from alternates
//  C4  both partitions were IDENTICAL whenever deduped <= skepticBatchSize
//  C13 the batched token projection was entirely unasserted
//  C15 cluster representative selection by severity was untested
//  C16 skepticSliceSize's default of 25 was untested
//  C19 four of applyClusters' rejection branches were untested

// C4 — the partitions must differ for EVERY finding count above one, most of
// all at the counts where batchCount would otherwise be 1. This is the case
// that was silently false at the shipped default for every round of <= 4.
{
  for (const n of [2, 3, 4, 5, 6, 9]) {
    const findings = Array.from({ length: n }, (_, i) => finding(`f${i}`))
    const h = makeHarness({
      findingsPerLens: { a: findings, b: [] },
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 999 }),
    })
    const r = await h.run()
    const p1 = h.calls.batches.filter((b) => b.n === 1).map((b) => b.indices.join(','))
    const p2 = h.calls.batches.filter((b) => b.n === 2).map((b) => b.indices.join(','))
    // The property that must hold is PER FINDING, not per pair. Contiguous-vs-
    // strided cannot keep every PAIR from co-occurring twice (n=5: findings 0
    // and 2 share a batch in both), and it does not need to: what matters is
    // that each finding's two votes come from different agents — structural,
    // since they are different partitions — and that the CONTEXT those two
    // votes are cast in differs, i.e. its batch-mates are not the same set both
    // times. That is what decorrelates batch anchoring.
    const matesIn = (parts, i) => {
      const b = parts.map((x) => x.split(',')).find((ix) => ix.includes(String(i))) || []
      return b.filter((x) => x !== String(i)).sort().join(',')
    }
    const sameContext = []
    for (let i = 0; i < n; i++) {
      const m1 = matesIn(p1, i), m2 = matesIn(p2, i)
      if (m1 !== '' && m1 === m2) sameContext.push(i)
    }
    check(`C4: n=${n} — no finding is judged twice by the same batch-mates`,
          sameContext.length === 0,
          `same-context findings=${sameContext.join(' ')} p1=[${p1.join('] [')}] p2=[${p2.join('] [')}]`)
    const all = [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified]
    check(`C4: n=${n} — every finding still gets exactly 2 votes`,
          all.length === n && all.every((f) => f.skepticVotes === 2),
          `votes=${all.map((f) => f.skepticVotes).join(',')}`)
  }
}

// C1 — dispatch must INTERLEAVE the partitions. Asserted two ways: the order
// itself, and the behaviour a truncating outage produces.
{
  const findings = Array.from({ length: 8 }, (_, i) => finding(`f${i}`))
  const h = makeHarness({
    findingsPerLens: { a: findings, b: [] },
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 2, clusterMinFindings: 999 }),
  })
  await h.run()
  const order = h.calls.batches.map((b) => b.n)
  check('C1: skeptic dispatch alternates between the partitions',
        order.every((n, i) => (i % 2 === 0 ? n === 1 : n === 2)), `order=${order.join('')}`)
  // The behavioural half: an outage part-way through the wave. Under
  // partition-major order this returned every finding `confirmed` on one vote
  // with no warning; interleaved, the tail loses BOTH votes and reads unverified.
  const cut = 4
  const h2 = makeHarness({
    findingsPerLens: { a: findings, b: [] },
    skeptic: ({ indices, call }) =>
      (call > cut ? null : indices.map((i) => ({ index: i, refuted: false, reason: 'r' }))),
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 2, clusterMinFindings: 999 }),
  })
  const r2 = await h2.run()
  check('C1: a truncating outage produces unverified findings, not silent single-vote confirms',
        r2.unverified.length > 0,
        `confirmed=${r2.confirmed.length} unverified=${r2.unverified.length}`)
  check('C1: no finding is confirmed on a single vote without the run saying so',
        r2.confirmed.every((f) => f.skepticVotes === 2) ||
          h2.calls.logs.some((l) => /only ONE surviving skeptic vote/.test(l)),
        `logs=${JSON.stringify(h2.calls.logs)}`)
}

// C1b — the single-vote warning must exist independently of ordering: one dead
// batch anywhere means some finding was verified once, and the record says so.
{
  const h = makeHarness({
    findingsPerLens: SIX,
    skeptic: ({ call, indices }) => (call === 1 ? null : indices.map((i) => ({ index: i, refuted: false, reason: 'r' }))),
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
  })
  await h.run()
  check('C1b: single-vote findings are named in the run log',
        h.calls.logs.some((l) => /only ONE surviving skeptic vote/.test(l)),
        `logs=${JSON.stringify(h.calls.logs)}`)
}

// C15 — the representative must be the HIGHEST-severity member. Reversing the
// comparator would demote a critical to its cluster-mate's severity, and the
// PM triages off the representative.
{
  const sev = (t, severity) => ({ ...finding(t), severity })
  const h = makeHarness({
    findingsPerLens: {
      a: [sev('minor-one', 'minor'), sev('critical-one', 'critical'), sev('major-one', 'major')],
      b: [sev('minor-two', 'minor'), sev('major-two', 'major'), sev('minor-three', 'minor')],
    },
    cluster: () => ({ groups: [{ members: [0, 1, 2] }, { members: [3, 4, 5] }] }),
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 6 }),
  })
  const r = await h.run()
  const reps = [...r.confirmed, ...r.plausible, ...r.refuted].map((f) => f.title).sort()
  check('C15: the cluster representative is its highest-severity member',
        reps.join(',') === 'critical-one,major-two', `reps=${reps.join(',')}`)
}

// C13 — the batched token projection was unasserted, so the gate could be made
// to under-project (its one invisible failure direction) with the suite green.
{
  const h = makeHarness({
    findingsPerLens: SIX,
    args: baseArgs({ lenses: LENSES, skepticBatchSize: 3, clusterMinFindings: 999 }),
  })
  const r = await h.run()
  // 6 findings, size 3 -> batchCount 2 -> 4 skeptic agents; 2 lenses, 0 clusterer.
  // Batched agents are priced at 80k x (1 + 0.35 x (size - 1)).
  const expected = Math.round(2 * 80_000 + 4 * 80_000 * (1 + 0.35 * 2))
  check('C13: batched projection prices batch size, not just agent count',
        r.projectedTokens === expected, `got=${r.projectedTokens} want=${expected}`)
  // And a batched projection must exceed the naive agents x 80k, or the gate
  // under-projects exactly where batching makes each agent bigger.
  check('C13: a batched projection exceeds agents x PER_AGENT_TOKENS',
        r.projectedTokens > r.projectedAgents * 80_000,
        `tokens=${r.projectedTokens} agents=${r.projectedAgents}`)
}

// C16 — the documented skepticSliceSize default of 25.
{
  const many = { a: Array.from({ length: 30 }, (_, i) => finding(`a${i}`)), b: [] }
  const h = makeHarness({
    findingsPerLens: many,
    args: { story: 'T', mode: 'design', docPath: '/tmp/d.md', context: 't', lenses: LENSES,
            skepticBatchSize: 1, clusterMinFindings: 999 },
  })
  await h.run()
  check('C16: default skepticSliceSize is 25', h.calls.slices.every((n) => n <= 25) &&
        h.calls.slices.includes(25), `slices=${h.calls.slices.join(',')}`)
}

// C19 — the rejection branches no case reached. Each must fail-open to
// unclustered, never crash and never partially apply.
{
  const bad = {
    'groups is not an array': { groups: 'nope' },
    'a group is null': { groups: [null, { members: [0, 1, 2, 3, 4, 5] }] },
    'members is not an array': { groups: [{ members: 'all' }] },
    'a member is a float': { groups: [{ members: [0, 1, 2, 3, 4, 5.5] }] },
    'a member is a string': { groups: [{ members: ['0', 1, 2, 3, 4, 5] }] },
  }
  for (const [kind, grouping] of Object.entries(bad)) {
    const h = makeHarness({
      findingsPerLens: SIX, cluster: () => grouping,
      args: baseArgs({ lenses: LENSES, skepticBatchSize: 4, clusterMinFindings: 6 }),
    })
    let threw = false
    let r = null
    try { r = await h.run() } catch { threw = true }
    const judged = r ? [...r.confirmed, ...r.plausible, ...r.refuted, ...r.unverified] : []
    check(`C19: clusterer where ${kind} -> rejected, no crash, nothing lost`,
          !threw && r && r.dedupedFindings === 6 && judged.length === 6 && /REJECTED/.test(r.clusterOutcome),
          `threw=${threw} deduped=${r && r.dedupedFindings} judged=${judged.length}`)
  }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
