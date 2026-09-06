export const meta = {
  name: 'story-review',
  description: 'Trigger-tier adversarial review: independent lenses over branch diffs, skeptic-verified findings',
  whenToUse: 'REVIEW stage of /run-story for L/XL stories or trigger-list hits; design mode for red-teaming design docs',
  phases: [
    { title: 'Lens review', detail: 'independent perspectives over the diff' },
    { title: 'Skeptic verify', detail: 'each finding attacked by skeptics; majority-refute kills' },
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

const mode = args.mode || 'diff'
const lenses = args.lenses || (mode === 'design' ? DEFAULT_DESIGN_LENSES : DEFAULT_DIFF_LENSES)
const subject = mode === 'design'
  ? `Design doc under review: ${args.docPath}. Read it fully, plus any code it references.`
  : `Diff targets (read each with: git -C <path> diff <base>...<branch>, plus surrounding files for context):\n` +
    args.targets.map(t => `- ${t.repo}: path=${t.path} base=${t.base} branch=${t.branch}`).join('\n')

// Lens stance condenses .claude/agents/adversarial-reviewer.md (preamble, ## Stance,
// ## Never, and ## Report format's zero-findings sentence; the per-finding field
// list lives in FINDINGS_SCHEMA) — kept inline so this script runs even in sessions where
// custom agent types are not loaded. Change one, change both: the postmortem agent
// diffs the pair at CURATE (postmortem.md §B5). The constant shipped condensed in
// 1a0b67c9 and has lacked three ## Stance items ever since; E9-S7's postmortem
// (ledger 2026-09-02) reported the safety-gate bullet missing here, and #517's
// re-diff also found the lens-scope bullet and the refuting-your-own-candidate
// clause absent.
const stance = `You are an adversarial review lens on the GGBC agent team. Find defects that are REAL — for every finding construct the concrete failure scenario (inputs/state → wrong output/crash/bypass); no scenario, no finding. Check whether a co-located gate already masks a candidate before reporting it — refuting your own candidate is a valid, valuable outcome. When you have an assigned lens, hunt from it only and trust the other lenses to cover theirs. Safety-gate diffs get special suspicion: ask what an API client (not the honest UI) can do, whether the gate binds to CONTENT or to a mutable reference, and whether every path re-verifies fail-closed. Never patch anything. If you verify a coverage claim by MUTATION (temporarily editing code to prove a test stays green), do it in a THROWAWAY checkout — git worktree add <scratchpad-path> --detach <sha> — NEVER in the target worktree, and remove the throwaway when done; the target must stay byte-identical to its committed state (pilot E1-S1 lesson: a reviewer's uncommitted mutation was found sitting in the shared worktree). A comment, docstring, fixture header or test name inside the diff is a claim, and a false one IS a finding: the failure-scenario bar above will never produce these, because the scenario is the next reader acting on it rather than a crash — so check every checkable assertion the diff's own prose makes (a count, an ordering, a last/only/always/never, an attribution, a file:line cite) against the code in the same diff, and report the false ones naming the check that fails (E9-S10: a brand-new module's docstring claimed four post-history sections are "the last thing the model reads"; four cannot each be last, two trigger-tier rounds passed it, and it cost a follow-up PR after merge). Wording you merely dislike is still a style nit. Do not pad the report with hypotheticals, style nits, or findings you could not ground in a failure scenario. Zero findings is a legitimate result.`

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
const all = lensResults.filter(Boolean).flatMap((r, i) => r.findings.map(f => ({ ...f, lens: lenses[i].key })))
const seen = new Set()
const deduped = all.filter(f => {
  const k = `${f.repo || ''}|${f.file || ''}|${(f.title || '').toLowerCase().slice(0, 60)}`
  if (seen.has(k)) return false
  seen.add(k); return true
})
log(`${all.length} raw findings → ${deduped.length} after dedup`)

// --- Cost gate (E8-S1 postmortem P4) -------------------------------------
// The skeptic wave is nearly the whole cost of a pass and its size is EXACT
// here, before a single skeptic launches: one agent per lens already ran, and
// verification spawns two per deduped finding. E8-S1 learned this ~18M late —
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

const projectedAgents = lenses.length + 2 * deduped.length
const projectedTokens = projectedAgents * PER_AGENT_TOKENS
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
    rawFindings: all.length, dedupedFindings: deduped.length,
    lensCount: lenses.length, unverifiedFindings: deduped,
  }
}

phase('Skeptic verify')
const judged = await parallel(deduped.map(f => () =>
  parallel([1, 2].map(n => () =>
    agent(
      `${stance}\n\nYou are a SKEPTIC. Try to REFUTE this finding from story ${args.story}. Default to refuted=true unless the failure scenario demonstrably holds against the actual code/doc.\n\nFinding: ${JSON.stringify(f)}\n\n${subject}\n\nVerify against the source, then verdict.`,
      { label: `skeptic${n}:${f.title.slice(0, 30)}`, phase: 'Skeptic verify', schema: VERDICT_SCHEMA, effort: 'high' } // skeptics pin no model: they inherit the SESSION's model (lenses above are pinned to opus), so a limit on the session tier takes out verifiers first — run the trigger tier from the strongest tier; never economize on verifiers
    )))
    .then(vs => {
      const votes = vs.filter(Boolean)
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
    })))
const results = judged.filter(Boolean)
const confirmed = results.filter(f => f.status === 'confirmed')
const plausible = results.filter(f => f.status === 'plausible')
const refuted = results.filter(f => f.status === 'refuted')
const unverified = results.filter(f => f.status === 'unverified')
log(`confirmed ${confirmed.length} · plausible ${plausible.length} · refuted ${refuted.length} · unverified ${unverified.length}`)
if (unverified.length) log(`WARNING: ${unverified.length} finding(s) got no surviving skeptic vote — UNVERIFIED, do not treat as confirmed`)
return { story: args.story, mode, confirmed, plausible, refuted, unverified, lensCount: lenses.length,
         gateArmed, classBudgetTokens, spentTokens, projectedAgents, projectedTokens, cumulativeTokens }
