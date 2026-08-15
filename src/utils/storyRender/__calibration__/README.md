# Renderer calibration set

Step 3, phase 6, Decision 4. Read that decision in
`docs/story-state-phase6-plan.md` before changing anything here.

## The one thing to understand

**You cannot assert LLM prose in a test.** Same input, same model,
different output — and a hash of generated text would fail on every
provider-side model update while catching nothing real. Any harness that
claims to test prose quality automatically is lying about what it does.

So this directory is two artefacts with different jobs, and conflating
them is the failure mode:

| | What it is | Runs in CI | Asserted |
|---|---|---|---|
| `calibration.test.ts` + `goldens/` | Golden-file pin on the assembled **brief** and the **prompt** | yes | yes |
| `RATINGS.md` | Generated prose with a human rating | no | **no** |

## Why pinning the brief is worth it

Every renderer regression that is *mechanically detectable* is a
regression in what went **into** the call. Which facts reached the model,
which world rules fired and which were excluded, what the 24k cap dropped
and in what order, how the hints resolved against `narrative`'s defaults —
all of it is decided before a token is sent, by pure functions.

If the prose gets worse and the brief is byte-identical, the change is in
the model or in the prompt text, and the goldens tell you which. That is a
genuinely useful thing to know and it costs nothing per run.

## Regenerating

```
npx vitest run src/utils/storyRender/__calibration__ -u
```

**Then read the diff.** The golden diff *is* the signal: it is the
complete list of everything your change altered about what the model is
told. An update committed without reading it throws away the only thing
this harness does.

Two parts of the diff deserve a deliberate look:

- **`drops`** — §3.5 forbids a silent drop. If your change alters what the
  cap eats, or the order it eats it in, that shows up here and nowhere
  else.
- **`facts.*`** — a fact that stops reaching the model is invisible in the
  prose until the continuity checker fires on it, one render later, on the
  user's key.

## Fixtures

Every fixture records its **provenance**, and a test enforces that only
fixtures built from a real render may set `ratedProse`. A hand-built
fixture is a perfectly good golden-brief test and is *not* evidence about
prose quality, because no prose was ever generated from it.

| Fixture | Path it walks | Provenance | Rated prose |
|---|---|---|---|
| `ivy-ledger` | The ordinary one: annotated beat, one participant, a fact tail under the cap | **Real** — the 2026-08-15 verification render | yes |
| `cap-overflow` | A bible-wide fact tail far over the 24k cap, so the drop is recorded | Hand-built | no |
| `first-scene-unannotated` | Opening scene: no preceding summary, no beat, no transformations | Hand-built | no |

The plan asks for 3–5 transcripts. There are three, and **only one has
rated prose** — deliberately. Fabricating ratings for prose nobody
generated would produce exactly the corpus-shaped object that §6 names as
the risk. The honest way to grow this set is to rate real renders as they
happen; see RATINGS.md for the format.

`cap-overflow`'s own history is the argument for reading goldens: its
first version used 400 facts, never reached the cap, and its golden said
`drops (0)` — a fixture named for the cap that never touched it. The
golden caught that on the day it was written.
