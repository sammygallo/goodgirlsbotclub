# Phase 6 — Export, continuity review, calibration set: implementation plan

Status: **approved** — written 2026-08-15, the day the render path was
first exercised end to end on a real provider key (Claude,
`claude-opus-4-7`, local stack). Decisions 1 and 4 — the two that shape
the work — put to Sammy and approved as recommended the same day;
2, 3 and 5 stand as recommended. Successor to Phase 5
(goodgirlsbotclub #392 + #396); read `story-state-step3-plan.md` §3.4,
§3.5 and §3.7 for the invariants this phase leans on, and the "Phase 5,
as shipped" subsection for the deviations it must not undo.

Scope in one sentence: let a finished render **leave the app** as
Markdown, give the continuity verdicts a place to be reviewed as a set
rather than one expanded chapter at a time, and put the renderer under a
calibration harness so a prompt change cannot quietly make output worse.

---

## 1. What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Prose paging | `storyApi.readRenderProse` | Written, typed, and now **used** by the reader. Paged at 25 because each item is a whole chapter. Cursor is `(after_sequence, after_scene_id)`; `has_more` is the only terminator. |
| Unit status vocabulary | backend CHECK + `StoryRenderUnitStatus` | `pending` / `complete` / `truncated` / `error`. A unit is `complete` ONLY on an explicit terminal `stop` (§3.4). |
| Staleness flags | `StoryRenderUnitSummary.is_stale` / `.is_orphaned` | Derived server-side at read time, never stored. `is_stale` = the scene was written since this prose was rendered; `is_orphaned` = the scene is gone. |
| Continuity payload | `story_render_units.continuity` | `verdicts[]` (`canon` / `claim` / `factId` / `severity`), `drops[]`, `rules_not_active`, `terminal`, `finish_reason`, `unreadable`. Verified live 2026-08-15: a planted contradiction produced a `major` verdict. |
| Per-chapter surfacing | `RenderReader.tsx` + `utils/storyRender/unitNotes.ts` | Merged. `unitNotes` narrows the payload with every default falling toward uncertainty. The reader already shows verdicts inline on an expanded chapter. |
| Chapter hints | `RenderingHintsSection['novel']` | `chapter_breaks: string[]` (scene ids that START a chapter) and `chapter_titles: {scene_id, title}[]` exist in the schema and are persisted. **Nothing in the app writes either one** — see Decision 3. |
| Context assembler | `src/utils/storyRender/contextAssembler.ts` | Pure and network-free; takes transcript and lorebook entries as parameters. This purity is what makes Decision 4 possible at all. |

---

## 2. The problem this phase closes

A user can render a novel and cannot get it out. That is the whole of it.
§3.7 already accepts that prose is read-only in v1 and that the answer to
"I want to tweak a sentence" is *export and edit outside the app* — which
is an answer only once export exists. Until then the render path produces
output that lives exclusively in a panel, and §5's "done for step 3"
sentence cannot be satisfied.

Two things ride along because they are cheapest here:

- **The verdicts have no aggregate view.** They are per-chapter and only
  visible on expansion, so "does this book contradict itself, and where?"
  is currently answered by opening every chapter in turn.
- **Nothing measures the renderer.** §6 lists "prose quality is subjective
  and unmeasurable" against the mitigation *"calibration set in Phase 6,
  before the RAG phase it justifies"*. Phase 8 is defined as being measured
  against this set, so Phase 6 gates Phase 8.

---

## 3. Decisions needing approval

### Decision 1 — A truncated or failed chapter refuses the whole export

§3.4 says `truncated` "blocks export" but not at what granularity.

**Recommended: refuse the export for the entire run, name every offending
chapter, and offer per-chapter re-render from the refusal itself.**

The alternative — export the good chapters and omit or mark the bad ones —
produces a file that reads as a finished book with a hole in it. Once the
Markdown is on the user's disk it has left every guard rail this codebase
has; a footnote in it is not a guard rail. Refusing is recoverable in one
click (re-render that chapter), and the whole point of `truncated` existing
as a distinct status is that finished-looking output which is secretly cut
is the failure mode §3.4 was built to prevent.

`error` and `pending` units refuse on the same grounds. `pending` in a
finished run means a scene never got its call at all.

### Decision 2 — Stale and orphaned chapters export, with a stamped notice

`is_stale` (the scene changed after this prose was rendered) and
`is_orphaned` (the scene is gone) are not quality defects. The prose is
complete, it was paid for, and it is exactly what the model wrote.

**Recommended: export proceeds, and the file carries a note naming the
affected chapters** — in a comment block at the top, not inline, so the
prose body is clean for whatever the user pastes it into. The reader
already badges these; refusing on them would make a routine bible edit
(a scene retitle marks every downstream unit stale — "false-stale is
cheap") into an export outage.

### Decision 3 — Phase 6 adds the chapter-break writer, or the hint stays dead

`chapter_breaks` and `chapter_titles` are in the schema, are persisted, and
have no writer. §1's scope sentence promises "chapter breaks driven by
`rendering_hints.novel.chapter_breaks`", which is a promise about a field
the user cannot currently set.

**Recommended: the reader's chapter list gains a "start a new chapter
here" toggle and an inline title field, writing both hints through
`saveNovelHints`.** Without it, export's grouping logic is unreachable code
and every export is one-chapter-per-scene by default forever.

`saveNovelHints` already patches `rendering_hints.novel` (a full replace
would delete the three renderer groups step 3 does not own) and is gated
`allowWhileLocked: true`. Both properties are what this needs; do not add
a second writer.

**Default when both are empty:** one chapter per scene, titled from the
scene's own title. That is today's implicit behaviour, made explicit.

### Decision 4 — The calibration set asserts the BRIEF, not the prose

This is the decision most likely to be got wrong, so it is stated plainly:
**you cannot assert LLM prose in a unit test.** Same input, same model,
different output — and pinning a hash of generated text produces a suite
that fails on every provider-side model update while catching nothing.

**Recommended: the calibration set is two artefacts with different jobs.**

1. **Golden-file tests over the assembled brief** — deterministic, run in
   CI on every renderer change, like any other test. For each fixture
   transcript: which facts reached the brief, which world rules the
   selector fired and which it left out, what the 24k cap dropped, the
   scene ordering, and the rendered prompt text. `contextAssembler` is pure
   and network-free precisely so this is possible. **This is where a
   regression actually gets caught** — every renderer defect that is
   mechanically detectable is a defect in what went INTO the call.
2. **A rated sample corpus** — 3–5 transcripts with their generated prose
   and a human rating, checked in as fixtures with the rating recorded.
   These are **not** asserted automatically. They are the thing a human
   re-reads when the prose prompt changes, and the ratings are the baseline
   they compare against. The harness's job is to make regenerating them one
   command, not to grade them.

Calling artefact 2 a "test" would be the lie that makes it useless. It is
a review checklist with fixtures attached, and the plan should say so.

**Seed fixture available now:** the 2026-08-15 verification transcript —
10 messages, two planted contradictions (a sealed/never-sealed reversal
and a never-leaves/travelled reversal), 3 annotated scenes, whose rendered
output was read and judged good and whose continuity check correctly
flagged one of the two as `major`. That is fixture 1 of 5, already rated.

### Decision 5 — The review surface is a Render-tab section, not a new tab

The verdicts belong to a RUN, not to the bible. Phase 10's contradiction
review is bible-level and has its own home in the Story tab; putting
render verdicts there would merge two things that are true at different
times and are fixed in different ways (re-render a chapter vs. edit canon).

**Recommended: a collapsible "Continuity" section in the Render tab, above
the chapter list**, listing every verdict in the selected run grouped by
severity, each row linking to its chapter. Counts are visible collapsed, so
"does this book contradict itself" is answerable without expanding
anything. `unreadable` chapters are listed as *unverified* and never
folded into the clean count — the reader's existing rule, applied to the
aggregate.

---

## 4. Deliverables

One PR, human-reviewed, deployable on its own — but see §6 on review
timing.

| # | What lands | Where |
|---|---|---|
| 1 | Markdown serializer — chapter grouping from `chapter_breaks`, titles from `chapter_titles`, front-matter notice per Decision 2. Pure, no network, no DOM. | `src/utils/storyRender/exportMarkdown.ts` (new) |
| 2 | Export gate — the Decision 1 refusal, computed from unit summaries before any prose is paged | same module, separate exported predicate |
| 3 | Export action — pages `readRenderProse` to exhaustion (`has_more` only), serializes, triggers a browser download | `RenderTab.tsx` / `storyRenderStore` |
| 4 | Chapter-break + title editing in the reader's chapter list, through `saveNovelHints` | `RenderReader.tsx` |
| 5 | Continuity review section per Decision 5 | `RenderContinuityPanel.tsx` (new), mounted in `RenderTab` |
| 6 | Calibration harness: golden-brief fixtures + the regenerate command + the rated corpus with its README | `src/utils/storyRender/__calibration__/` |

**Paging discipline, restated because it has bitten twice:** a SHORT page
is not a last page. The server can end one early on its own byte budget
and the cursor then points at the last row INCLUDED. Only `has_more`
terminates the loop. An export that stops early because a page came back
short would silently produce a truncated book — the exact failure Decision
1 exists to prevent, arriving by a different door.

---

## 5. Tests

- Export refuses on `truncated`, on `error`, on `pending`; the refusal
  names every offending chapter, not just the first.
- Export proceeds on `is_stale` / `is_orphaned` and the notice names them.
- Chapter grouping: empty hints → one chapter per scene; breaks honoured;
  a break on the first scene does not produce an empty leading chapter; a
  break naming a scene outside the run is ignored rather than throwing.
- Titles: `chapter_titles` wins over the scene title; a missing entry falls
  back; an empty-string title falls back rather than emitting a blank
  heading.
- The exporter pages on `has_more`, NOT on page length, and resumes from
  the last row included. (Mutation-test this one.)
- Golden-brief fixtures: assembled brief is byte-stable for a fixed input.
- The continuity panel counts `unreadable` as unverified, never clean.

Every regression pin mutation-tested — revert the fix, watch it fail,
restore. That is the house rule and it is what caught the real defects in
Phase 4 and Phase 5.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| The calibration set becomes theatre — fixtures nobody re-reads | Artefact 2 is explicitly a review checklist, not a test; the PR that changes the prose prompt is the PR that must show updated ratings |
| Export paging stops early on a short page | `has_more`-only rule, mutation-tested pin (§5) |
| Chapter-break editing races a live render | Reuse the tab's existing predicate; hints are snapshotted per run, so a mid-run edit changes the NEXT run, not this one — state that in the UI copy |
| The review section duplicates Phase 10's | Different scope (run vs bible), different home, different fix; §3 Decision 5 states the boundary |
| Review lands after the PR again | See below |

**On review timing.** Phase 5's adversarial review finished minutes after
#392 merged, `main` shipped all nine defects it found, and the fixes
needed a second PR and a same-day hotfix deploy. Two of those nine were
data-loss class. Run the review against the branch BEFORE opening the PR
this time.
