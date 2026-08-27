# Prompt goldens

Byte-for-byte pins on what `buildConversationContext` (solo) and
`buildGroupConversationContext` (group) hand the provider.

Built for **E2-S2 task 0** and merged **before** any instrumentation exists,
because E2-S2's AC 8 is *"zero diff in assembled prompts before vs after
instrumentation"* — and a golden cut from already-instrumented code proves
nothing about what the instrumentation changed.

| File | What it is |
|---|---|
| `../promptGoldens.fixtures.ts` | Store state + build inputs. One fixture = one build. |
| `../promptGoldens.test.ts` | The harness: serializer, one build per fixture, structural self-checks. |
| `solo-*.prompt.txt` / `group-*.prompt.txt` | Every context entry the build emitted, in order, raw. |
| `solo-*.variables.txt` / `group-*.variables.txt` | The chat variables that build persisted. |

## Regenerating

```
npx vitest run src/stores/promptGoldens -u
```

**Then READ THE DIFF.** The golden diff *is* the signal: it is the complete
list of everything your change altered about what the model is sent. An update
committed without reading it throws away the only thing this harness does.
Never blind-accept `-u`.

Three parts of a diff deserve a deliberate look before you accept it:

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
- **`# entries:` / `# overBudget:` / `# lastTokenEstimate:`** — the trim's own
  verdict. `lastTokenEstimate` has **two definitions** today: the token-aware
  path (`chatStore.ts:1676`) reports the trim's `usedTokens`, which excludes
  Stage C; the non-token-aware path (`:1694-1696`) re-estimates the whole
  assembled context, which includes it. Task 4 reconciles those; until it
  does, both numbers are pinned here so the discrepancy is visible rather
  than inherited.

## Why some goldens pin behaviour that is wrong

A golden's job is to make change visible, not to assert correctness. Three
fixtures deliberately record a live defect so its eventual fix arrives as a
readable diff instead of a surprise:

| Fixture | What it pins |
|---|---|
| `solo-persona-in-prompt` | A persona set to position **in_prompt** (an option the settings UI offers) has its `personaBlock` computed at `chatStore.ts:1266` and then emitted by nothing — `sectionContent.persona_before_char` gates on `descriptionPosition === 'before_char'`. The description silently never reaches the model. |
| `group-author-note-depth-zero-dropped` | A group author's note at depth 0 matches neither the in-loop branch nor the overflow branch and is dropped. Solo emits it. Known, filed separately (#466). |
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
| M1 | Change one character of the `emotion_instruction` string (`chatStore.ts:1229`) | ≥ 1 prompt golden |
| M2 | `join('\n\n')` → `join('\n')` at `chatStore.ts:1337` | ≥ 2 prompt goldens |
| M3 | Remove the `export` on `buildConversationContext` (`chatStore.ts:966`) | the suite must fail to **compile** (`npm run build`) and fail at runtime — never silently skip |

Recorded results at the time this directory was created are in the task-0
build report; re-run them, do not trust the record.

## Adding a fixture

1. Add it to `SOLO_FIXTURES` / `GROUP_FIXTURES` in
   `../promptGoldens.fixtures.ts`. `what` and `pins` are required and are
   asserted — `pins` must name at least one `chatStore.ts` line anchor, so a
   later reader can find the branch the fixture walks.
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

Solo (20 fixtures): baseline · all sections · reordered + disabled promptOrder
· empty system block · trim bites · trim over budget · token-aware off ·
at-depth interleave · at-depth 0 · at-depth overflow · image-only + blank
assistant turn · macro writes · recall present/absent · persona after_char ·
persona in_prompt · pure chat mode · linked style · summary compaction floor ·
hidden messages.

Group (13 fixtures): swap · join · swap + scenario override · join + scenario
override · blank user turn kept (folded) / dropped (unfolded) / dropped (not
last) · blank guards in-loop · blank guards overflow · 30-message window slice
before the system filter · macro writes · author's note at depth 0 · world-info
attribution.

Known gap: **no fixture makes all 14 pre-history sections non-empty at once**,
because `persona_before_char` and `persona_after_char` both read the single
`persona.descriptionPosition` field and are mutually exclusive. `all-sections`
covers 13 of 14 with the persona before the card; `persona-after-char` covers
the 14th.

Deferred (per the task-0 spec): empty roster · single-member group ·
promptOrder permutations beyond the one reordering.
