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
