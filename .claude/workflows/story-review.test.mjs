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
//   5. projection arithmetic   -> lenses + 2 x deduped, exactly
//   6. dedup unchanged         -> the gate must not perturb what it measures
//
// Run: node .claude/workflows/story-review.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'story-review.js'), 'utf8')

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

function makeHarness({ findingsPerLens, args }) {
  const calls = { lens: 0, skeptic: 0, logs: [] }
  const agent = async (_prompt, opts = {}) => {
    const label = opts.label || ''
    if (label.startsWith('lens:')) {
      calls.lens++
      const key = label.slice('lens:'.length)
      return { findings: (findingsPerLens[key] || []) }
    }
    if (label.startsWith('skeptic')) {
      calls.skeptic++
      return { refuted: false, reason: 'stub' }
    }
    throw new Error(`unexpected agent label: ${label}`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const pipeline = async () => { throw new Error('pipeline not used by this script') }
  const phase = () => {}
  const log = (m) => calls.logs.push(String(m))
  return { calls, run: () => loadScript()(agent, parallel, pipeline, phase, log, args, { total: null }, null) }
}

const baseArgs = (extra = {}) => ({
  story: 'TEST-1',
  mode: 'design',
  docPath: '/tmp/doc.md',
  context: 'test',
  ...extra,
})

// Five lenses is the script's design-mode default (3) unless overridden; pin an
// explicit lens set so the arithmetic in the assertions is not a moving target.
const LENSES = [
  { key: 'a', focus: 'a' },
  { key: 'b', focus: 'b' },
]
const finding = (title) => ({
  title, claim: 'c', severity: 'major', failure_scenario: 'f', file: 'x.md', repo: 'r',
})

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
    args: baseArgs({ lenses: LENSES, classBudgetTokens: 1 }),
  })
  const r = await h.run()
  check('projection = lenses + 2 x deduped', r.projectedAgents === 2 + 2 * 1, `agents=${r.projectedAgents}`)
}

// 6 — the gate must not perturb what it measures: dedup still collapses
//     same repo|file|title, and the projection is computed on the DEDUPED count
{
  const dupes = { a: [finding('same'), finding('same')], b: [finding('same')] }
  const h = makeHarness({
    findingsPerLens: dupes,
    args: baseArgs({ lenses: LENSES, classBudgetTokens: 1 }),
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

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
