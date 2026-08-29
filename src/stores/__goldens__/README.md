# Prompt goldens

Byte-for-byte pins on what `buildConversationContext` (solo) and
`buildGroupConversationContext` (group) hand the provider.

Built for **E2-S2 task 0** and merged **before** any instrumentation exists,
because E2-S2's AC 8 is *"zero diff in assembled prompts before vs after
instrumentation"* — and a golden cut from already-instrumented code proves
nothing about what the instrumentation changed.

| File | What it is |
|---|---|
| `../promptGoldens.fixtures.ts` | Store state + build inputs. One fixture = one build. Also `PINS_ANCHORS`. |
| `../promptGoldens.test.ts` | The harness: serializer, one build per fixture, structural self-checks. |
| `solo-*.prompt.txt` / `group-*.prompt.txt` | Every context entry the build emitted, in order, raw. |
| `solo-*.variables.txt` / `group-*.variables.txt` | The chat variables that build persisted. |
| `solo-*.fired.txt` / `group-*.fired.txt` | What the build reported back through its `wiTimerOut` — `fired`, `trimmedAtDepth`, the freshly-`activated` set, and the WI budget's `scanReport`. |

## Regenerating

```
npx vitest run src/stores/promptGoldens -u
```

**Then READ THE DIFF.** The golden diff *is* the signal: it is the complete
list of everything your change altered about what the model is sent. An update
committed without reading it throws away the only thing this harness does.
Never blind-accept `-u`.

Five parts of a diff deserve a deliberate look before you accept it:

- **`.variables.txt`** — a count that went from `"1"` to `"2"` means a macro
  now executes **twice**. `{{setvar}}`/`{{incvar}}` writes are persisted into
  the chat, so a double execution is a permanent, compounding corruption of
  the user's chat state, not a cosmetic prompt change. Task 1b's two-pass
  design splits the builder in two and runs the second half twice; these files
  are what stands between that design and exactly this bug.
- **`∅ (empty content)`** — an entry that gained or lost one. An empty content
  block 400s providers like Claude (`text content blocks must be non-empty`),
  and it is *invisible* as blank space, which is why it is rendered as a
  marker.
- **`.fired.txt`** — the world-info telemetry the build hands back. `fired`
  is what gets persisted into `header.wi_fired` and replayed by the
  story-bible ingest, so an entry appearing or disappearing here changes what
  a future replay believes fired. `activated` is what stamps the sticky /
  cooldown clock: a **sticky carry-over must never appear in it**
  (`worldInfoStore.ts:1541-1546`) or the carry-over becomes permanent.
- **`# toasts:`** (in `.fired.txt`) — the fail-loud world-info budget warning
  (`chatStore.ts:1234` / `:2239`), captured through a mocked
  `showToastGlobal`. It is the *only* output of that branch: it puts nothing
  in the context, so before round 3 both blocks could be deleted with the
  whole suite green. Exactly two builds raise one, on two different chat
  files — the warning is suppressed after the first time it fires for a chat
  (`wiPinnedWarnedChats`, `:975`), which is why those two fixtures call
  `withChatFile()`.
- **`# entries:` / `# overBudget:` / `# lastTokenEstimate:`** — the trim's own
  verdict. `lastTokenEstimate` has **two definitions** today: the token-aware
  path (`chatStore.ts:1944`) reports the trim's `usedTokens`, which excludes
  Stage C; the non-token-aware path (`:2007-2011`) re-estimates the whole
  assembled context, which includes it. Task 4 reconciles those; until it
  does, both numbers are pinned here so the discrepancy is visible rather
  than inherited.

## Why some goldens pin behaviour that is wrong

A golden's job is to make change visible, not to assert correctness. Three
fixtures deliberately record a live defect so its eventual fix arrives as a
readable diff instead of a surprise:

| Fixture | What it pins |
|---|---|
| `solo-persona-in-prompt` | A persona set to position **in_prompt** (an option the settings UI offers) has its `personaBlock` computed at `chatStore.ts:1391` and then emitted by nothing — `sectionContent.persona_before_char` gates on `descriptionPosition === 'before_char'`. The description silently never reaches the model. |
| `group-author-note-depth-zero-dropped` | A group author's note at depth 0 matches neither the in-loop branch nor the overflow branch and is dropped. Solo emits it. Known, filed separately (#466). |
| `solo-recall-absent` vs `solo-empty-system-block` | A character note that renders to **whitespace only** is unshifted by the overflow branch (`:1746` tests truthiness) and swallowed by the depth-0 branch (`:1696` tests `.trim()`). One of the two ships an all-whitespace context entry. Filed as #477; when it is fixed, `solo-recall-absent` loses an entry. |
| every `group-*` golden's `# lastTokenEstimate: -1` | Group never writes `lastTokenEstimate`, so the context meter shows a **stale** value from the last solo send. The fixtures seed the field with `-1`, so `-1` in a group golden reads "this build reported no total at all". |

## The mutation drill

**A green golden suite is not evidence that the goldens pin anything.** A
harness that snapshotted entry counts and the role sequence would pass every
fixture in this directory and catch nothing. Before trusting a change to the
harness itself (the serializer, `runSolo`/`runGroup`, or `resetStores`), run
the drill — **in a throwaway git worktree, never the main checkout**:

```
git worktree add /tmp/ggbc-mutate HEAD
# ...edit the mutation into /tmp/ggbc-mutate/src/stores/chatStore.ts...
cd /tmp/ggbc-mutate && npx vitest run src/stores/promptGoldens
git worktree remove --force /tmp/ggbc-mutate
```

| # | Mutation | Must fail |
|---|---|---|
| M1 | Change one character of the `emotion_instruction` string (`chatStore.ts:1357`) | ≥ 1 prompt golden |
| M2 | `join('\n\n')` → `join('\n')` at `chatStore.ts:1884` | ≥ 2 prompt goldens |
| M3 | Remove the `export` on `buildConversationContext` (`chatStore.ts:1076`) | the suite must fail to **compile** (`npm run build`) and fail at runtime — never silently skip |

Round 2 added five more, each one an adversarial reviewer's *proven-green*
mutation against round 1's harness. Round 3 split the last of them in two —
its two halves land on different fixtures, and saying so in one row was how
`solo-fixed-window-summary-skew` came to claim coverage it never had:

| # | Mutation | Must fail |
|---|---|---|
| M4 | Replace every at-depth `role:` expression with the literal `'system'` (14 sites: `:1621 :1633 :1641 :1662 :1698 :1707 :1715 :1737 :1750 :1759 :1767 :1794 :2726 :2830`) | the three `solo-at-depth-*` goldens plus `group-macro-writes` and `group-hidden-and-overflow-note` |
| M5 | Rewrite any single macro-executed input as `(sub(x), sub(x))` | that site's counter reads `"2"`, and `the macro canaries record every write exactly once` fails by name |
| M6 | Delete the `${wiAfterCharSlot}` or `${wiBeforeAnSlot}` interpolation from the group flat template (`:2577`/`:2578`), or empty either slot const (`:2566`/`:2571`) | `group-wi-attribution` |
| M7 | `const finalSystemPrompt = systemPrompt;` (drop the RAG concat, `:2593-2595`) | `group-join` |
| M8 | Drop `- windowSkew` from `summarySliceOffset` (`:1517`) | `solo-fixed-window-summary-skew` |
| M9 | Filter before slicing at `:1471` | `solo-token-aware-off` — **not** `solo-fixed-window-summary-skew`, whose `pins` claimed this until round 3 caught it. With a summary present the offset rebase subtracts `windowSkew` again, the window terms cancel, and both orderings emit the same tail |

Round 3 closed the gap between what fixtures *claimed* to pin and what a
mutation could actually reach. Each of these was **proven green** against
round 2's harness:

| # | Mutation | Must fail |
|---|---|---|
| M10a | Delete either pinned-over-budget `showToastGlobal` block (`:1228-1238` solo, `:2233-2243` group) | that builder's `*-wi-budget-eviction.fired.txt` (the `# toasts:` line), and `the fail-loud world-info budget warning fires once per chat file` by name |
| M10b | Delete **either** `withChatFile()` call in the fixtures | `the fail-loud …` test by name — the round-3 review proved each single deletion was GREEN until the test gained its `not.toBe(GOLDEN_CHAT_FILE)` assertion per fired run; that assertion is what makes this row true, so do not remove it without re-running this drill |
| M11 | Delete `if (!enabledSections.has(sectionId)) continue;` (`:2040`) | `solo-wi-sections-disabled.fired.txt` |
| M12 | Drop any one of the four `wiRendered` filters (`:1653`, `:1728`, `:1782`, `:2042`) | `solo-wi-blank-guards.fired.txt` |
| M13 | Iterate `wiAtDepthByMessage` instead of `keptHistory` at `:2045-2047` (ignore the trim) | `solo-trim-bites.fired.txt` + `solo-at-depth-overflow.fired.txt` — this third claim in `renderFired`'s docstring was already true; M11 and M12 are the two that were not |
| M14 | `:1696` depth-0 depth-prompt guard `.trim()` → plain truthiness | `solo-empty-system-block.prompt.txt` |
| M15 | `:1746` overflow depth-prompt guard truthiness → `.trim()` | `solo-recall-absent.prompt.txt` |
| M16 | Hoist the `sub()` out of the `:1333` or `:1337-1339` suppression ternary (execute the macro, discard the text) | `the macro canaries record every write exactly once`, via `card-overrides-disabled` / `linked-style-active` / `pure-chat-mode` |
| M17 | Delete any fixture's whole `counters` array | `the macro canaries record every write exactly once` — the assertion count is now EXACT, not a floor with slack |

Recorded results at the time this directory was created are in the task-0
build report; re-run them, do not trust the record.

## `pins` anchors are keys, not live line numbers

Every golden renders its fixture's `what` and `pins` prose in its header. That
makes `pins` **part of a byte-pinned artifact**: re-resolving its line numbers
after a refactor rewrites all 129 golden files for a documentation edit, in the
harness whose whole job is that those files change only when the prompt does.
E2-S2's instrumentation moved several hundred lines of `chatStore.ts` and made
that collision unavoidable.

So a `:NNNN` in `pins` is a stable **key**, resolved through `PINS_ANCHORS` in
`../promptGoldens.fixtures.ts`, which records the source construct behind it.
The test `every :NNNN anchor in a fixture pins line names a construct that
still exists` checks that every cited key has an entry, that the entry is
specific enough to prove something, and that the construct is still present in
the file it names. That is strictly more than the check it replaced — which
said of itself that it "cannot verify an anchor points at the RIGHT code", and
which silently resolved `worldInfoStore.ts:1319`, `:1420` and
`tokenizer.ts:180` against `chatStore.ts`.

Line numbers elsewhere in THIS file (the mutation tables, the seam-defence
table) are live, and were re-resolved for the instrumentation. Re-resolve them
whenever they drift — nothing byte-pinned depends on them.

## Adding a fixture

1. Add it to `SOLO_FIXTURES` / `GROUP_FIXTURES` in
   `../promptGoldens.fixtures.ts`. `what` and `pins` are required and are
   asserted — `pins` must name at least one line anchor, and that anchor needs
   its `PINS_ANCHORS` entry in the same commit.
2. `npx vitest run src/stores/promptGoldens -u`.
3. Read the new golden end to end and check it walks the branch you claimed.
   `cap-overflow` in `src/utils/storyRender/__calibration__/` is the cautionary
   tale: its first version was named for a cap it never reached, and only
   reading the golden caught it.

**Determinism rules** (a fixture that breaks one produces a different golden
on every run):

- No `{{time}}`, `{{date}}`, `{{roll}}`, `{{random}}`, `{{pick}}` macros —
  `utils/macros.ts` resolves those against `new Date()` / `Math.random()`.
- No `Date.now()`; every timestamp is a fixed literal.
- Explicit ids for books, entries and messages — never a shared counter.
- Never build twice inside one fixture. The second build re-runs every macro,
  and the variables golden would then pin the second build's writes, which is
  precisely the double execution it exists to detect.

## Coverage

Solo (28 fixtures): baseline · all sections · reordered + disabled promptOrder
· empty system block · trim bites · trim over budget · token-aware off ·
at-depth interleave · at-depth 0 · at-depth overflow · image-only + blank
assistant turn · macro writes · recall present/absent · persona after_char ·
persona in_prompt · pure chat mode · linked style · summary compaction floor ·
hidden messages · world-info scan options · world-info budget eviction ·
server-matched entries · server-matched entries grouped · card overrides
disabled · fixed window + summary skew · world-info sections disabled ·
world-info blank guards.

Group (16 fixtures): swap · join (+ recall) · swap + scenario override · join +
scenario override · blank user turn kept (folded) / dropped (unfolded) /
dropped (not last) · blank guards in-loop · blank guards overflow · 30-message
window slice before the system filter · macro writes (join) · macro writes
(swap) · author's note at depth 0 · world-info attribution + every slot ·
hidden turn + overflow note · world-info budget eviction.

Known gap: **no fixture makes all 14 pre-history sections non-empty at once**,
because `persona_before_char` and `persona_after_char` both read the single
`persona.descriptionPosition` field and are mutually exclusive. `all-sections`
covers 13 of 14 with the persona before the card; `persona-after-char` covers
the 14th.

Both counts above are asserted by `the fixture counts the README quotes are
the ones that exist`. They were prose until round 3, and the group number was
wrong by one for as long as it had been written down. Change a fixture list,
change that test, change this paragraph — in one commit.

Deferred (per the task-0 spec): empty roster · single-member group ·
promptOrder permutations beyond the one reordering.

## Two rules a future change must not quietly break

### 1. Counters are `{{incvar}}` / `{{addvar}}`, never `{{setvar}}`

`{{setvar::k::v}}` is **idempotent**. Writing the same literal twice is
byte-identical to writing it once, so a setvar-only fixture is *structurally
incapable* of detecting a double execution — the exact failure these files
exist to catch. Round 1's group blank-guard fixtures had this shape: their
placement implied they guarded double execution and they could not have.

Use:

- `{{incvar::k}}` where the value may be emitted — it returns the new count,
  so a second execution shows up in the **prompt** golden as well as the
  variables golden;
- `{{addvar::k::1}}` where the text must still render blank — it counts and
  returns `''` (`utils/macros.ts:442-453`), which is what the blank-content
  guards need.

`setvar` is still right for recording *which stage ran last* (the `stage`
variable in `solo-macro-writes`); it is never right for a run count.

### 2. The prepare/finish split boundary is defended by the at-depth counters

E2-S2 task 1 split `buildConversationContext` into
`prepareConversationContext` (`chatStore.ts:1104`) and
`finishConversationContext` (`:1832`); task 1b will **run the finish half
twice** (a two-pass fixed point: recall is an input to the builder and also
consumes the trim budget that decides the boundary). The seam is after the
at-depth overflow unshifts: everything above it executes macros, everything
below it executes none.

A review of round 1 proved that applying that design one block **higher** — at
the natural-looking seam after the history loop (now `:1695`), so that the
finish half re-runs the depth-0 trailing slot and the four overflow unshifts —
re-executed `sub()` at `:1704`/`:1756` and `joinWi()` at `:1722`/`:1777`, and
**not one golden changed**. Nothing in the harness defended the seam.

It does now. Every macro-executed input in those blocks carries its own
counter, and the fixture that owns it lists the counter in `counters`:

| Block | Counters | Fixture |
|---|---|---|
| in-loop insertions (`:1619`-`:1665`) | `note` `wiDepthInLoop` `soloWiBlankInLoop` | `solo-at-depth-interleave`, `solo-wi-blank-guards` |
| depth-0 trailing (`:1696`-`:1741`) | `anDepthZero` `wiDepthZero` `anGuardRuns` `soloWiBlankZero` | `solo-at-depth-zero`, `solo-empty-system-block`, `solo-wi-blank-guards` |
| overflow unshifts (`:1744`-`:1798`) | `anOverflow` `anGuardRuns` `wiDepthOverflow` `wiDepthOverflowB` `soloWiBlankOverflow` | `solo-at-depth-overflow`, `solo-recall-absent`, `solo-wi-blank-guards` |
| *(prepare half — NOT a split defence)* | `depthPromptRuns` | counts the single `sub(depthPrompt.prompt)` at `:1546`, **above** the boundary; the round-3 review proved re-running any block below it cannot move that counter. It defends against a split drawn above `:1546`, nothing later — the three rows above are what defend the seam |
| group in-loop / depth-0 / overflow | `gWiDepthInLoop` `gWiDepthZero` `gWiDepthOverflow` `anCount` `gAnOverflow` | `group-wi-attribution`, `group-hidden-and-overflow-note` |

`chatStore.breakdown.test.ts` now carries the same guarantee as a NAMED test
rather than only a file diff: `finish executes no macros, however many times it
runs` does one prepare and three finishes and asserts every counter still
reads `"1"`.

Re-running any of those blocks flips its counters to `"2"` and fails a named
test (`the macro canaries record every write exactly once`), not just an
anonymous file diff. **Do not move the seam without re-reading this table**,
and do not delete a counter to make a diff go away.

The companion test `every macro-executing input in the builders owns a named
counter` holds the hand-maintained map from "a place either builder calls
`sub()` / `processMacros()`" to "the fixture that would notice if it ran
twice". Adding a macro-executed input to either builder means adding a counter
there too.
