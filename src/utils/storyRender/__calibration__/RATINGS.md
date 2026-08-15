# Rated prose corpus

**This is not a test.** Nothing here is asserted by CI, and it must never
be — see README.md. It is a review checklist with the material attached:
when you change the prose prompt, `PROSE_SYSTEM`, the compression rules or
the hint resolution, you re-render these and read the result against the
rating below.

The rating is a human judgement recorded at a moment, with the model that
produced it. It is evidence, not a threshold. A later render that reads
differently is not automatically a regression — but if it reads *worse*
and the golden brief is unchanged, the prompt or the model is why.

## How to add an entry

1. Render the fixture's scene against a real key.
2. Paste the prose verbatim. Do not tidy it.
3. Record model, date, and what you actually thought — including what was
   weak. An entry with no criticism is not a rating.
4. Set `ratedProse: true` on the fixture in `fixtures.ts`. A test enforces
   that only fixtures whose provenance starts with "Real" may do this.

---

## `ivy-ledger`

- **Model:** `claude-opus-4-7`
- **Rendered:** 2026-08-15, first end-to-end render on a live provider key
- **Brief:** `goldens/ivy-ledger.brief.txt`
- **Annotation it was written against:** beat `rising`, tension 7, mood
  "tense, adversarial, quietly alarmed", compression `preserve` (ratio
  0.9), dialogue density 0.7, pacing note "let the contradiction land
  cleanly; hold the beat where Sam registers the reversal"

### Prose as generated

> Sam set the ledger flat on the counter and turned it toward her.
>
> "You said the north wing was sealed."
>
> "It is."
>
> "Then explain this."
>
> He put his finger on the line. A signature. A date three weeks old. A
> time. A wing.
>
> Ivy looked at it. Did not lean in.
>
> "You've misread it," she said.
>
> "It says north."
>
> "It doesn't."
>
> "It's right here."
>
> "You've misread it," she said again. Same tone. Clipped. "I've never
> sealed the north wing. It stays open."
>
> […]
>
> "Two minutes ago," he said, "you told me nobody had walked it. Now
> you're telling me anyone may."
>
> "Yes."
>
> "Those aren't the same thing."
>
> "No," she said. "They aren't."
>
> She did not look away. He waited for her to correct herself, to soften
> one of them, to give him the sentence that stitched the two together.
> She didn't. She stood behind the counter with her hands folded and let
> both statements sit in the air between them like two stones on a shelf.

(Full text: 275 words. Truncated here at the two ends that carry the beat;
the middle is more of the same exchange.)

### Rating — **good**

**What it got right.** It honoured its annotation without being told to in
so many words: the contradiction lands cleanly and is *held* rather than
explained, which is exactly the pacing note. Dialogue density reads close
to the 0.7 it was given. It resisted the obvious failure of having a
character announce the subtext ("she was lying"), and the one image it
spends — two stones on a shelf — is doing the work a paragraph of
interiority would otherwise do.

**What was weak.** The repetition of "You've misread it" is effective once
and slightly mannered the second time. It invents concrete detail the
scene summary does not contain (a signature, a date three weeks old) —
defensible for prose, and worth watching, because the same latitude is
what would let it invent a *contradicting* detail on a less careful run.
It also renders Sam's dialogue with no distinguishing voice; the bible had
no user-voice section, so this is a fair result rather than a fault.

**What to watch on a re-render.** If the exchange starts being summarised
rather than played, compression is over-firing. If a narrator begins
explaining the contradiction to the reader, `PROSE_SYSTEM`'s
show-don't-explain footing has slipped.

---

## `full-brief`

- **Model:** `claude-opus-4-7`
- **Rendered:** 2026-08-15, through the app's own `generateOnceDetailed` on
  the live connection, from this fixture's assembled brief verbatim
- **Brief:** `goldens/full-brief.brief.txt`
- **Finish:** `stop`, 322 words
- **Input is hand-built.** The prose and this rating are real; what they
  are evidence about is the renderer's behaviour given a fully populated
  brief, not about real-world transcripts.

### What it did with the brief

This is the fixture that exists to prove the optional blocks reach the
model, and the prose settles it — it used nearly all of them, unprompted:

| Brief element | Where it surfaced |
|---|---|
| verbal tic `"As you like."` | used twice, and as the closing line |
| dialogue example `The archive does not run itself.` | verbatim |
| world rule *ledgers record intent, not entry* | `"Intent," Ivy said. "Not entry."` |
| appearance *ink on the side of her right hand* | `The ink on the side of her right hand caught the lamp` |
| POV third-limited through Ivy, past tense | `She heard them as he heard them` |
| author voice: understatement, sparse | `the wind found the eaves and left them alone again` |

### Rating — **good, with one real problem**

**What it got right.** The contradiction is played rather than narrated,
and the tense-slip is *observed by the POV character* — "the small change
of tense arrived a half-beat after, uninvited, and she did not chase it" —
which is third-limited doing actual work rather than decoration. Reusing
the verbal tic as the last line is a better ending than the material
strictly earned.

**The problem, and it is a finding rather than a nitpick.** The direction
this brief carries is *contradictory*, and the prose shows which half won.
`hints.compression_level` is `tight` — rendered as "Compress hard.
Summarise transitions, keep only the lines that carry the scene" — while
the scene's own `transformations` say `preserve` at 90%. Both go into
`Direction:` as sibling bullets with nothing to rank them. The output is
**322 words against ivy-ledger's 275**, where ivy-ledger was `balanced` +
`preserve`. So the scene-level annotation appears to dominate the
bible-level hint, and "tight" produced *more* prose than "balanced".

That may be the intended precedence — the scene knows itself better than a
global default — but nothing in the prompt or the plan says so, and a user
who sets "compress hard" and gets a longer chapter has been ignored
without being told. Worth resolving in phase 7 or a follow-up: either rank
the two explicitly in the prompt, or say in the hints editor that a
scene's own annotation can override the global setting.

---

## `first-scene-unannotated`

- **Model:** `claude-opus-4-7`
- **Rendered:** 2026-08-15, same path
- **Brief:** `goldens/first-scene-unannotated.brief.txt`
- **Finish:** `stop`, 357 words
- **Input is hand-built** (fixture 1 with the annotation groups cleared).

### Rating — **good prose, and the clearest argument for annotating first**

**What it got right.** Sentence for sentence this is the most confident of
the three. "That's two denials in a coat" is better than anything in the
annotated renders, and the physical business with the ledger — cracked
spine, pages sighing shut — is doing the pacing work that a `pacing_notes`
line does in the annotated version.

**What it tells us.** It is also the **longest** of the three at 357 words,
from the *least* direction: no beat, no tension, no compression
recommendation, no preceding summary. And it invents the most by a wide
margin — "Marchmas", "Merrit", "six years", "thirty years", the damp and
the plaster and the nails. None of that is in the brief. Most of it is
harmless colour, but "Merrit drive the nails" is a named character the
bible does not contain, and that is exactly the kind of detail a later
continuity check has no fact to test against.

So the unannotated path does not produce *worse* prose — it produces
**longer, more inventive, less governed** prose. That is a much better
argument for the Render tab's annotate-first default than "it reads
flatter", which is what the tab's own copy currently claims. Worth
correcting that copy.

**What to watch on a re-render.** If the annotated fixtures start inventing
at this rate, the annotation groups have stopped reaching the prompt —
check `full-brief`'s golden before assuming the model changed.

---

## Verification: the compression-precedence fix (2026-08-15)

The `full-brief` rating above reported that `compression_level` and a
scene's `transformations` entered `Direction:` as unranked siblings, and
that the scene-level one won. This is the measurement of the fix, on the
same fixture and the same model (`claude-opus-4-7`), one sample each.

| Prompt | Words | |
|---|---|---|
| Two unranked bullets (the defect) | 322 | "Compress hard" beat "Balanced" (275) — backwards |
| Fix v1 — `preserve` = *"give it room at the density above"* | **455** | **worse than the defect** |
| Fix v2 — `preserve` = *"cut this one last"* | **268** | now under `balanced`'s 275 |

**v1 is the interesting one.** Making the user's setting govern was
correct, but the adjustment I wrote for `preserve` said to "give it room",
which is an expansion licence — and removing the concrete "90% of its
length" anchor at the same time took away the only number pulling the
other way. The result was longer prose than the bug it was fixing.

The rule that came out of it, and which a test now enforces: **an
adjustment may say what to cut FIRST or LAST; it may never ask for more
prose.** Relative ordering is the only thing the annotate pass knows that
the user's setting does not.

**Quality at 268 words.** Tighter, and it holds: the dialogue example
("The archive does not run itself") survives, the appearance detail
survives, and world rule 2 survives paraphrased — "The ledger records
intent. Not passage." The verbal tic ("As you like.") is gone, which is a
fair casualty of a harder cut and the kind of thing to watch if the level
is pushed further.

**Caveat, stated because it matters:** one sample per variant. LLM output
varies run to run, so the exact numbers are not repeatable. The direction
is consistent and the mechanism for v1's regression is understood, which
is what makes this evidence rather than an anecdote — but do not treat 268
as a threshold.
