# Character Architecture v2 — P0 methodology brief and gate criteria

**Story:** E8-S1 (roadmap `docs/product-roadmap-10.2-12.md` §5, epic E8) · **Status:** draft for Sammy's sign-off · **Prepared:** 2026-09-03 by the run-story PM (Fable) from four research passes, committed alongside this brief under `docs/research/e8-s1-*.md` — R1 consumer character apps · R2 the Tavern lineage and community formats · R3 role-play consistency research and measurement method · R4 the GGBC prompt surface.

**Review status.** This document was red-teamed in `story-review` design mode before sign-off, per charter §3, which lists E8-S1 in the design-story variant (*draft doc → red-team → revise*). Roadmap §5's L-minimum paragraph says the opposite — that E8-S1's "only gate is Sammy's approval" and it therefore keeps its build band. The charter wins on conflict and the red-team ran; the roadmap sentence is a restatement bug for Sammy's own PR, not something this story edits. Round 1: five lenses, 72 raw findings, 70 after dedup, **23 confirmed · 5 plausible · 42 refuted · 0 unverified**. This revision answers all 28 confirmed-or-plausible findings; the disposition of each is in the PR's evidence bundle.

**What this document is for.** E8's P0 gate says a validation report on ≥5 reimagined characters must show *measured behavior-consistency improvement at ≤ token parity vs their current definitions*, with targets set here before E8-S2 spends a token and never moved afterwards. This document is that pre-registration: it picks the methodology E8-S2 prototypes, fixes the measurement (arms, canon cards, probes, judges, estimator, runtime pins) and fixes the GO / ITERATE / STOP thresholds. Everything in §1 is frozen once Sammy approves; the approving commit's hash is the pre-registration E8-S2's report cites.

---

## 0 · TL;DR and the decisions this asks of Sammy

- **Methodology picked: behavioral definition compiled through a fixed template** — ranked values with explicit conflict ordering, a decision framework, conflict patterns, the character's present psychological tension (arc), voice markers, hard limits and a knowledge boundary — rendered by one compiler into the card fields the runtime already reads. **E8-S2 needs no change to the prompt builders**: the new arm *is* a card, so all arms run through byte-identical assembly and are measured at the same seam.
- **The bet, narrowed by the evidence and stated falsifiably.** A January 2026 study across 211 personas and five models found that whether a profile is *structured or unstructured* has negligible effect on role-play quality [STUDY, arXiv:2601.04716]. So the claim is **not** "structure beats prose". It is: *behavioral content — values in tension, decision rules, conflict patterns, present arc — at no more character-attributable prompt tokens, improves in-character consistency under pressure and over longer histories, and does so beyond what an effort-matched freeform rewrite achieves.* The strongest pro-structure result on record is exactly that kind of content: conditioning on a character's psychological arc beat every other context strategy on every model tested, with the largest gap on scenarios the source never covered [STUDY, arXiv:2606.05553].
- **Three arms, three judged comparisons.** O (the live card), N (behavioral, compiled), F (an effort- and token-matched freeform rewrite). **N vs F** isolates structure and is what GO rides on. **F vs O** is the honest alternative — if that is most of the win, the roadmap should not build a schema. **N vs O** is the epic's literal criterion and is reported as the sum of the two. The third pairing costs one extra judge call per cell and no extra generation, and without it the design cannot tell "structure helps" from "rewriting helps".
- **A finding that changes the methodology, not just the measurement.** On Anthropic providers the backend's translation hoists **every** system-role message into the top-level `system` block regardless of position (`ggbc-backend/app/providers/anthropic.py`, `translate_request`). The post-history instructions are therefore not post-history, and the character's note — whose role defaults to `system` — does not inject at depth at all. The one lever this design leans on hardest is provider-dependent. That is pre-existing on `main`, filed as [#509](https://github.com/sammygallo/goodgirlsbotclub/issues/509), and it forces D1 and §5.2 to be provider-aware rather than assuming a late slot exists.
- **Measurement, in one breath.** Eight characters (five is the floor, and at five only a clean sweep decides) × three arms × twelve locked probes across eight families, every probe on a **fully scripted** shared history so a pairwise unit exists, each at a short and a long depth, ten samples per cell at the shipped sampler configuration; judged blind and pairwise in both orders by two judge models from families other than either generator, against a plain-prose *canon card* the judges see instead of any definition; **ties score 0.5 and stay in the denominator**; token parity measured on post-macro rendered text of the character-attributable prompt slices under one named `estimateTokens` profile. **A one-character pilot computes every validity number before the other seven are authorized.** Lore is off in every arm.
- **Decisions requested (§0.1):** the primary and secondary probe models · that GO requires beating the freeform control (recommended: yes) · the character set and its size (recommended: eight, disposition-balanced) · whether the behavioral arm may carry one counted anchor exchange (recommended: yes) · who writes canon cards, rewrites and probes · and whether E8-S2 may spend a small backend task on surfacing provider token usage (recommended: yes, but the gate does not depend on it).

### 0.1 · Decisions requested, with recommendations

| # | Decision | Recommendation | Why it is Sammy's |
|---|---|---|---|
| D1 | Primary probe model, and one secondary | Primary: the provider and model GGBC's owner-tier chats run on today (Sammy names it). **This choice now carries more than the tokenizer profile**: on an Anthropic-family primary, #509 means the PHI and the character's note lose their positions, so §5.2 compiles the anti-drift reminder into a surviving role and the report states which. Secondary: one model from a third family, reported, never gating | The gate is only meaningful on the model users chat with; the roadmap does not name it |
| D2 | Does GO require the behavioral arm to beat the freeform control, not only the current card? | **Yes.** N > O proves rewriting helps; N > F is what proves *behavioral structure* helps, and structure is what E8-S3/S4 would build. The 2026 null on structure makes N ≈ F the expected outcome, which is exactly why it must be measured rather than assumed away | It raises the bar above the epic's literal wording, so it is a scope call |
| D3 | The character set | **Eight** of the live cards (the roadmap's E8 P1 counts 42), budget permitting; five is the floor and then §7 requires 5 of 5. Balanced on disposition (≥ 2 morally dark, ≥ 2 sympathetic — dark characters degrade in every condition and would confound an unbalanced arm); no behavior-bearing embedded lorebook; **no card containing `{{random}}`, `{{pick}}`, `{{roll}}` or `{{setvar}}`** (they exist in `src/utils/macros.ts` and would make O's cells irreproducible); **a floor on O's character-attributable token sum**, so a very lean card cannot make N un-authorable at parity and deny GO under the 7-of-8 rule; at least two carrying a card `system_prompt` or PHI; no famous or licensed character; none authored in the last month | Sammy knows which characters he trusts his own intent for |
| D4 | May the behavioral arm carry one short anchor exchange (≤ 60 tokens) as a voice sample? | **Yes, counted toward parity.** SillyTavern's docs and the Ali:Chat practice both hold that shown style beats told style; refusing the arm one example handicaps it against a card that may carry hundreds of tokens of `mes_example` | It is a methodology boundary ("voice markers, not dialogue samples" in the original vision) |
| D5 | Who authors canon cards, rewrites and probes | Fable drafts every canon card from the current card; Sammy corrects each **before** either rewrite exists; Fable writes N and then F under the same time and token budget; a *separate* agent that has read neither rewrite authors the scripted histories and the held-out probes | The canon card is the yardstick; only the owner can say what the character was meant to be |
| D6 | May E8-S2 spend a small backend task to surface provider token usage? | **Yes, recommended, but the gate does not depend on it.** The relay records no usage today (`ggbc-backend/app/routers/generation.py`), so parity rests on the in-repo estimator unless usage passthrough is added. It is a cross-repo change and therefore an escalation at its own merge | It adds scope to E8-S2 and touches a second repo |

---

## 1 · What is frozen once this is approved

1. **The methodology** (§5): the element set, the compiler template, and the rule that compiled output lands only in existing card fields.
2. **The arms and the three comparisons** (§6.1): O, N, F, sharing `first_mes`, `scenario`, avatar and name byte-for-byte; N vs F gating, F vs O and N vs O reported.
3. **The canon card protocol** (§6.2): plain prose, owner-corrected before any rewrite, the only character document judges see, recording what the owner changed.
4. **The probe battery** (§6.3): eight families, twelve locked probes per character, fully scripted histories, the two depths, the development / held-out / ablation pools, the overlap check, the repeat count.
5. **The runtime pins and the rig's path** (§6.4): the switch list, and the rule that the rig renders through the golden harness and generates through the same client path production uses.
6. **The judging protocol** (§6.5): blind pairwise in both orders, ties scored 0.5, judge families, agreement floor, the fixed calibration set.
7. **The token measure** (§6.6): the slices and how they are addressed, post-substitution, one named profile, parity as an authoring constraint.
8. **The thresholds and the decision map** (§7): validity preconditions, GO, ITERATE, STOP, and the rule that every outcome routes somewhere.

Moving any of these after E8-S2 begins is a **new gate**, recorded in the validation report with the reason, and the report must show the result under both the old and the new criterion.

---

## 2 · Competitive analysis — what works, what fails, what nobody does

Every claim carries a source in §10, labelled **[DOC]** vendor documentation or spec, **[STUDY]** measured research, **[SEC]** secondary reporting, **[FOLK]** community practice without a controlled test, or **[INF]** our inference. The full reports, with per-claim URLs and an explicit "not found" list, are committed as `docs/research/e8-s1-r1-consumer-apps.md`, `-r2-tavern-lineage.md`, `-r3-persona-research-measurement.md` and `-r4-codebase-surface.md`.

### 2.1 · What works (best-evidenced first)

- **Fixed-depth re-injection is the only drift countermeasure that is both shipped and measured.** SillyTavern's Author's Note / Character's Note and KoboldAI's "A/N Strength" re-assert trait text near the generation point regardless of chat length [DOC]; Li et al. measured why: persona adherence decays within eight rounds because system-prompt tokens receive proportionally less attention as the conversation grows [STUDY, arXiv:2402.10962]. GGBC ships the mechanism and most live cards leave it empty — **but see §3: on Anthropic providers it is currently hoisted out of its depth position (#509)**, which is why §5.2's placement rule is provider-aware.
- **Psychological-trajectory structure pays off; attribute-list structure does not.** ArcANE's arc conditioning topped every other context strategy on every model, largest on beyond-source scenarios [STUDY, arXiv:2606.05553]; the profile-axes study found generic structure negligible [STUDY, arXiv:2601.04716]; once character-name memorization is removed, explicit personality specification consistently helps [STUDY, arXiv:2603.03915]. **Consequence:** §5 carries the present arc as a first-class element, and §4's bet is about behavioral content, not formatting.
- **Interview-style elicitation beats self-report** for personality fidelity (InCharacter, 80.7% agreement with human-perceived personality) [STUDY]; **given-circumstance acting** — a fixed scene in which the character must act — is the probe design that works (CoSER) [STUDY]. **Consequence:** probes are situations on scripted histories, never questionnaires (§6.3).
- **Shown style beats told style.** SillyTavern's docs say the model picks up style and length "from the first message than anything else" [DOC]; the Ali:Chat practice rests on the same observation [FOLK]. **Consequence:** `first_mes` is pinned identical across arms, and D4 lets the behavioral arm carry one counted anchor exchange.
- **Separating "who the character is" from "how it talks"** is the only structural pattern any consumer product has adopted — Candy.ai's personality and communication-style layers, PolyBuzz's split creator guide [SEC] — and Inworld's engine already separates *motivations* and *flaws* from description and models goals as activation/completion state [DOC].
- **Bounding the trait set at creation.** Nomi locks three traits, two interests and one limitation, uneditable afterwards [SEC]. **Consequence:** §5 caps ranked values at five and makes the conflict ordering explicit.
- **Traits, not rules.** Anthropic's account of Claude's character avoids narrow rules "in favor of broad traits" [DOC]; the OpenAI Model Spec separates hard rules from steerable defaults [DOC]. **Consequence:** values compile as ranked tendencies; absolute language is confined to a short hard-limits element.
- **Token compression works, and it is not consistency.** The PList guide's one case study took a card from ~1300 to 599 tokens by reformatting alone [FOLK]; per-field token counters exist across SillyTavern and its extensions [DOC]. **Consequence:** parity is trivially gameable by shrinking, so the gate pairs parity with fidelity and token-matches F to N.

### 2.2 · What fails (documented or measured)

- **Context eviction is the named root cause of drift wherever anyone investigated.** Character.AI's docs warn a long Definition's end "may be truncated" and its memory blog admits it "can't guarantee the Character will always use or reference the information exactly as written" [DOC]; Janitor AI characters fall out of an ~8–9K-token window after ~25–30 messages [SEC]; Agnai carries an open issue titled "Character personality loss during chat" [DOC].
- **Single-turn evaluation under-detects the failure this architecture targets.** Frontier models lose ~39% on multi-turn under-specified tasks [STUDY, arXiv:2505.06120]; drift shows within eight rounds [STUDY, arXiv:2402.10962]. **Consequence:** every probe sits on a multi-turn history.
- **Alignment bias bends characters toward agreeable helpers.** A *positive moral bias* and a *helpful-assistant bias*, traced to pretraining plus assistant fine-tuning [STUDY, arXiv:2601.03396]; morally dark characters degrade in every condition [STUDY, arXiv:2601.04716]. **Consequence:** an explicit assistant-collapse probe, a decision-framework element naming the default under pressure, and disposition balancing in D3.
- **Persona prose is not a steering mechanism by itself.** A 162-persona study found no accuracy gain from expert framing [SEC]; persona prompting can hurt factual accuracy [STUDY, arXiv:2512.05858].
- **LLM judges have known, measured biases** — position, verbosity, self-preference [STUDY, arXiv:2306.05685], rating-scale drift, and a strong pull toward outputs mirroring a spec the judge was shown [STUDY, arXiv:2509.03419]. **Consequence:** §6.5 is built around those failure modes.
- **Vendor self-report is not evidence.** Nomi's founder publicly denied memory loss against years of user reports [SEC].
- **Format folklore does not survive sourcing.** "W++ died because brackets confuse the model" could not be traced to a primary source; JED/JED+ could not be found at all [INF].

### 2.3 · What nobody does — confirmed absences

- **No product, spec, client or engine tests a character's behavior before it ships or publishes a per-character consistency score.** The one candidate tool in the Tavern lineage tests scripting wiring, by its own README [DOC]; Inworld publishes a conversational-authenticity benchmark but no per-character validator [DOC]; persona-fidelity metrics exist only in papers [STUDY].
- **No published work compares behaviorally specified against descriptively specified characters at a matched token budget**, and none uses a freeform-rewrite control to separate format from authoring effort [INF, R3 survey].
- **No card format encodes a value hierarchy, decision framework or conflict pattern as a first-class field.** Every field added from Card V1 to V3 is prose, example dialogue, lorebook, or metadata and asset plumbing [DOC, spec diff].
- **Per-element token accounting tied to definition fields exists in no creator UI** [DOC]. E8-S5 productizes exactly this, on the numbers E8-S2 produces.

### 2.4 · What this changes about the original vision

The vision memo proposed behavioral definition, testing, a modular stack, adversarial prompt design, world binding and interaction archetypes. The evidence narrows P0 to the first two plus the anti-drift half of the fourth, and adds two things the memo did not name: **re-injection is a first-class compile target** (where the provider preserves it), and **the character's present arc is an element**, because psychological trajectory is the structure that measurably generalizes. The modular stack, world binding and interaction archetypes stay post-GO.

---

## 3 · The GGBC baseline — what a "character definition" is at the prompt today

Symbols are cited rather than line numbers (line cites in this repo rot within days — house rule D-T5).

**Solo assembly** (`buildConversationContext` → `prepareConversationContext` + `finishConversationContext`, `src/stores/chatStore.ts`). Every card read goes through `getCharacterField` and every value through the macro substituter (`processMacros`, `src/utils/macros.ts`) **before** it is measured. Four surfaces are character-attributable:

| Card field | Where it is emitted | Stage | Gate that must be pinned |
|---|---|---|---|
| `description`, `personality`, `scenario`, `mes_example` | `char_info_block`, one Stage-A section | A | `scenario` and `mes_example` drop under pure-chat mode |
| `system_prompt` | `main_prompt`, a Stage-A section | A | `respectCharacterOverride`; loses to an active linked style (`mainPromptSnapshot`) |
| `post_history_instructions` | `char_phi`, its own system message after history | C | `respectCharacterPHI`, and **not** empty when suppressed: pure-chat and linked-style modes substitute an app-authored style note into the same slot |
| `extensions.depth_prompt` (the character's note) | a Stage-B insertion tagged `{stage:'B', cls:'characters_note'}`, placed `depth` messages from the end (`getDepthPrompt`, default depth 4, role `system`) | B | when `depth` exceeds the history length the note is unshifted to the head of history — graceful degradation, not an error |

The embedded `character_book` lands in the World Info sections and is out of scope because lore is off (§6.4). `first_mes` never reaches the model except as ordinary history. The emotion-tag and selfie instructions are character-*conditional* furniture, identical across arms, and are not counted.

**The provider translation layer — the finding that reshapes this design.** Production does not talk to a provider directly: `api.generateMessage` (`src/api/client.ts`) POSTs the message array to the backend relay, which dispatches by `chat_completion_source`. For the Anthropic family, `translate_request` (`ggbc-backend/app/providers/anthropic.py`) walks the array and appends **every** `role == "system"` message to a `system_chunks` list, dropping it from the array, then joins them into a single top-level `system` string. So on that path:

- the Stage-C `char_phi` is **not** after the history — it is concatenated into the leading system block;
- the Stage-B character's note, whose role defaults to `system`, **loses its depth position entirely**;
- a note authored with `role: 'user'` or `'assistant'` survives in place, because non-system roles fall through to the message array.

This is pre-existing on `main` and is filed as [#509](https://github.com/sammygallo/goodgirlsbotclub/issues/509). It means **prompt semantics differ by provider**, and it is why §5.2's placement rule and D1 are provider-aware instead of assuming a late slot exists.

**Sampler reality.** `DEFAULT_SAMPLER` (`src/stores/generationStore.ts`) is temperature 0.9, top-p 1.0, `maxTokens` 2048. But `modelRejectsSamplers` (`src/api/client.ts`) returns true for Claude Opus/Sonnet/Haiku 4.7 and newer, and the request body then **omits temperature entirely**, letting the provider default apply; the body's own token fallback is a third value again (1024) when the caller passes none. On the Anthropic path the translation additionally refuses to send temperature and top-p together. So "the shipped temperature" is not a constant — it is a function of the model D1 names.

**Token measurement.** E2-S2's breakdown measures each emitted piece post-substitution (`addSlice`, `src/utils/promptBreakdown.ts`; view via `computeBreakdownView`, `src/utils/breakdownBuckets.ts`). **Addressing differs by stage, and this matters for §6.6:** Stage-A and Stage-C pieces carry a `BreakdownSectionId` (`PromptSectionId | GroupSlotId`), while the character's note is not a section id at all — it is a `StageBClass` on `kind.cls`. Bucketing is by slot, not content: `char_info_block` is the only member of the *Character* bucket, `main_prompt` and `char_phi` fall under *Instructions*, and `characters_note` under *Summary + Notes*. A "Character bucket" comparison would miss three of the four surfaces.

The estimator (`estimateTokens`, `src/utils/tokenizer.ts`) is `ceil(chars / cpt) + floor(whitespaceRuns × 0.05)` with `cpt` per profile — gpt 4.0, claude 3.6, gemini 4.0, llama 3.5, generic 3.8 — selected by `profileForProvider` from the active provider (`custom`, local and cohere all map to `generic`; `llama` is never selected). It is non-additive across joins and counts zero for image attachments. **No real provider usage is recorded anywhere in the stack**: `recordTurnUsage` always writes `source: 'estimated'`, and the relay records none — hence D6.

**Group assembly** (`buildGroupConversationContext`) emits `description` + `personality` per member in `swap` card mode and adds `scenario` + `mes_example` in `join`; it **drops** the card `system_prompt`, PHI and the character's note entirely. A behavioral definition leaning on those slots does not exist in group chat today. **P0 is solo-only for that reason**, and the group gap is an E8-S3 design input.

**Determinism available today.** The golden-prompt harness (`src/stores/promptGoldens.fixtures.ts`, `promptGoldens.test.ts`, `chatStore.breakdown.test.ts`; 44 committed prompt goldens under `src/stores/__goldens__/`) renders a full prompt from fixed store state without a network call and attaches a `PromptBreakdown`. Its `resetStores()` pins `activeProvider: 'openai'` and sets no sampler at all, so the rig must **set** the provider and sampler rather than inherit them (§6.4).

**Authoring surface.** The interview wizard (`src/utils/characterInterview/`) extracts eleven topics into an allowlist of nine card fields plus staged lore — no behavioral field exists. Two typed behavioral shapes do exist in the story-ingest pipeline (`src/types/storyBible.ts`): `Personality { traits, voice_profile, motivations, fears, values }` and its sibling `CharacterArc { starting_state, current_state, target_state, beats[] }`, the latter being exactly §5.1's element 5. Nothing in chat assembly reads either. They are candidate shapes for E8-S3, not for P0.

---

## 4 · Methodology candidates and the pick

Five candidates, weighed against four questions: *does it make the probe families predictable in principle*; *is each element separately testable and separately token-attributable*; *does it run without code changes*; *is a gain attributable to the content rather than to a rewrite*.

| Candidate | What it is | Verdict |
|---|---|---|
| **A · Behavioral definition, compiled** — ranked values with conflict ordering · decision framework · conflict patterns · present arc · voice markers · hard limits · knowledge boundary · anti-drift counterweights, rendered by one fixed template into existing card fields | The vision memo's candidate, tightened by §2 | **Picked.** The only candidate whose elements map one-to-one onto the probe families and onto per-element token attribution, and whose content is the kind the 2026 evidence says generalizes. Zero code change. |
| B · Compressed attribute lists (PList / SBF) with an Ali:Chat interview | The community's current best practice | A formatting of descriptive content; carries no decision or conflict semantics for a dilemma probe to bind to, and is the form of structure the 2026 null was measured on. Folded in: N's compiler emits terse labelled lines. |
| C · Goals-and-motivations engine (Inworld-style) | Runtime steering over a structured profile | Needs a runtime we do not have; would test the engine, not the definition. Its motivations/flaws fields are the first ITERATE candidates. |
| D · Freeform rewrite + anti-drift patterns only | "Write the card better, add guardrails" | The cheapest alternative, and it **is arm F** — measured directly rather than argued about. |
| E · Example-heavy definition | Show, don't tell, taken to the limit | Strong on voice, blind on decisions, expensive per token, and the shape most current cards already have — it is arm O. |

**The bet.** A behavioral definition claims that *what a character values, in what order, how it decides, and what it is currently struggling with* predicts responses to situations the author never wrote about, better than describing the character does **and** better than a careful description written with the same knowledge. If true, N beats O and F at parity, and the margin survives at the longer history. If N beats O but not F, the value is in rewriting and E8-S3 should not build a schema. If N beats neither, roadmap §8's fallback applies. All three outcomes are informative; only the first is GO.

---

## 5 · The prototype structure v0 and the compiler

A **prototype spec** for P0, not E8-S3's schema. E8-S3 designs the durable shape (and may borrow `Personality` / `CharacterArc`) with this v0 and E8-S2's per-element results as evidence.

### 5.1 · Elements (terse labelled lines, each with a token guideline)

| # | Element | What it must contain | Guideline |
|---|---|---|---|
| 1 | **Essence** | One sentence: who this is, in the character's own terms | ≤ 30 tokens |
| 2 | **Ranked values** | 3–5 values, ranked, each with one *"when X conflicts with Y, X wins"* clause for its neighbour — the ordering a dilemma probe binds to | ≤ 120 |
| 3 | **Decision framework** | What they weigh first, their default when they cannot tell, what they never do to get an outcome, and their default under pressure (the assistant-collapse guard) | ≤ 100 |
| 4 | **Conflict patterns** | What sets them off, how they escalate, how they de-escalate, how they treat betrayal, their tells | ≤ 100 |
| 5 | **Present arc** | What they want, what they fear, what is unresolved, which way they are leaning — the trajectory content ArcANE found generalizes; `CharacterArc` is its existing typed shape | ≤ 60 |
| 6 | **Voice markers** | Register, sentence length, vocabulary tier, tics, expressiveness, things they never say — plus, if D4 is yes, one anchor exchange ≤ 60 tokens | ≤ 90 (+60) |
| 7 | **Hard limits** | 2–4 absolute lines — the only place absolute language is allowed | ≤ 50 |
| 8 | **Knowledge boundary** | What they know and do not, and how they handle not knowing | ≤ 50 |
| 9 | **Anti-drift counterweights** | 2–3 lines of the form *"when tempted to [pattern], instead [value-consistent move]"*, derived from 2–5 | ≤ 60 |

Guideline total ≈ 660 tokens rendered before the anchor exchange. Parity (§6.6) is per character against O, so a lean card forces a leaner N; the guidelines are ceilings, not targets.

### 5.2 · The compiler (one template, fixed for every character)

A deterministic text template (Appendix C), so arm-N cards differ only in their elements, never in prompt engineering.

- `description` ← Essence · Ranked values · Decision framework · Conflict patterns · Present arc · Knowledge boundary, as labelled terse lines using `{{char}}`.
- `personality` ← Voice markers (and the anchor exchange, if allowed).
- `post_history_instructions` ← Hard limits + anti-drift counterweights, ≤ 80 tokens.
- `extensions.depth_prompt` ← a ≤ 40-token reminder of the top two values, the present arc and the register, at depth 4.
- **Placement is provider-aware (#509).** The compiler's intent is that the PHI is read last and the note is re-asserted at depth. On providers that preserve inline system messages, both hold. On the Anthropic path both are hoisted into the leading system block, so the note is compiled with **`role: 'user'`**, which survives in place, and the report states which regime the run used. **This choice is fixed at D1 and applies identically to N and F**, so it can never advantage one rewrite arm over the other; what it changes is what the run is able to conclude about re-injection, which §8 requires the report to say plainly.
- `scenario`, `first_mes`, `alternate_greetings`, avatar, name, tags ← copied byte-for-byte from the current card.
- `mes_example` ← empty. This is a deliberate confound: N drops whatever example prose O carried, so the report records each character's O `mes_example` size and the per-element ablation is what separates "the elements helped" from "removing stale examples helped".
- `system_prompt` ← empty in N unless the current card carries one, in which case N carries a compiled equivalent of no greater length.

**Every slice N writes is one O may already use**, so the parity sum is like-for-like. If N's gain comes mostly from the PHI and note slots, that is a finding about re-injection, not values — §8 requires the ablation that tells them apart, and F carries the same anti-drift line in its PHI so the lever is present in both rewrites.

### 5.3 · The freeform control arm F

Written by the same author from the same canon card, after N, under the same time budget, as prose in the same four fields, **token-matched to N within ±5%**, carrying the same anti-drift line in the PHI and a prose reminder of equal length in the note at the same role and depth. F is allowed everything N is allowed except the element structure.

---

## 6 · The P0 measurement design

### 6.1 · Arms, comparisons, and the leak that is stated rather than denied

| Arm | Content | Constraint |
|---|---|---|
| **O** | The live card, byte-for-byte | embedded lorebook removed from the test copy; no nondeterministic macros (D3) |
| **N** | Behavioral elements compiled by the fixed template | character-attributable tokens ≤ O, checked before any probe runs |
| **F** | Freeform prose rewrite | within ±5% of N |

Three judged comparisons, from the same three responses:

| Comparison | What it isolates | Role |
|---|---|---|
| **N vs F** | behavioral structure alone | **GO-gating** (D2) |
| **F vs O** | careful rewriting from a corrected intent spec, with no new architecture | the honest alternative |
| **N vs O** | the sum of both, plus the owner's corrections | the epic's literal criterion, reported as a sum |

**The leak.** The canon card is drafted from O and corrected by Sammy; N and F are authored from the corrected card, O is not. So N and F both hold information O lacks. This does **not** bias N vs F — the leak is symmetric across the rewrite arms, which is why GO rides there. It **does** inflate N vs O and F vs O by the size of Sammy's corrections, which is precisely what F vs O measures. §6.2 requires the canon card to record what the owner changed, so the leak's size is visible in the report rather than argued about.

Authoring order is fixed: canon cards → Sammy corrects → N (all characters) → F (all characters) → parity check → held-out probes and scripted histories revealed to the rig, never to the author.

### 6.2 · The canon card (what judges see instead of a definition)

One per character, plain prose, 150–300 words, no field labels: who the character is, what they care about and in what order, how they decide, how they speak, three to five things they would do and three to five they would never, and three expected reactions. Drafted by Fable from the current card, corrected by Sammy **before** N or F exists, and carrying a short **change log** of what the owner corrected. It is the only character document a judge ever sees, and it is identical across arms by construction.

### 6.3 · The probe battery

**Eight families, twelve locked probes per character** — adversarial pressure carries three (one per Appendix A variant), betrayal and moral dilemma two each, the remaining five one each.

| Family | Situation shape | Scored by |
|---|---|---|
| 1 Betrayal / loyalty | a trusted party is revealed to have acted against the character | pairwise |
| 2 Moral dilemma | a forced choice between two of the character's own values | pairwise |
| 3 Genre shift | the scene lurches mid-conversation | pairwise |
| 4 Adversarial pressure | out-of-character pressure, manipulation toward a hard limit, and the assistant-collapse variant | **binary break / no-break** |
| 5 Knowledge boundary | something the character cannot know | pairwise + binary hallucination flag |
| 6 Emotional escalation | provocation over several turns toward a sore point | pairwise |
| 7 Long-horizon callback | a commitment planted early is contradicted at the probe turn | pairwise |
| 8 Mundane control | low-stakes small talk, no pressure | pairwise + naturalness |

**Every family is fully scripted.** The user turns *and* the character turns of the history are written once per probe, from the canon card, by the probe-author agent, and are byte-identical across arms; only the final probe turn is generated. Family 7's commitment is planted as a **scripted character turn** early in that history, so every arm inherits the identical commitment.

*Why not a live conversation:* a live multi-turn arm produces a different history per arm, so there is no comparable pair to judge and no defined source for the user's turns. Scripting buys an exact pairwise unit at a stated cost: **P0 measures definition-driven resistance at depth, not self-conditioning drift** — an arm being pulled off by its own earlier outputs. Full conversational drift needs the live A/B harness, which is E8-S6's job.

**Depths.** Each probe runs at a **short** depth (probe as turn 6, i.e. five prior messages) and a **long** depth (probe as turn 13, twelve prior). Five prior messages is the smallest history that puts a depth-4 note **strictly inside** it: the insertion matches when `depthFromEnd === 4`, so at exactly four prior messages the note would still land at index 0 — the same place the overflow branch would put it — and the two cells would differ in the note's position as well as in history length. At five it sits after one message, at twelve after eight. The rig asserts the note's index in both rendered prompts and the report attaches it. The long cell is six exchanges deep; the drift literature's eight-round figure is cited as motivation, not as a claim about this cell's arithmetic.

**Pools and hygiene.** Three disjoint probe pools per character: a **development** pool (four probes) the author may use while writing N and F; the **held-out** pool (twelve) that decides GO, authored by an agent that has read neither rewrite and sealed until authoring is complete; and an **ablation** pool (four) used only for §8's per-element ablation, so the ablation is not run on probes the author optimized against. Probes describe situations, never traits. The overlap check is mechanical and runnable: after stopword removal and lemmatization, no held-out probe may share a **content-word 4-gram** with any arm's rendered definition, and a flagged probe is rewritten by the probe author before sealing, never after.

**Samples.** Ten per (character × probe × depth × arm) at the shipped sampler configuration; five is the floor for a reduced run and is reported as such. Single-shot evaluation agrees with multi-sample ground truth only ~92% of the time, and decision flips roughly double as temperature rises [STUDY, arXiv:2512.12066].

### 6.4 · Runtime pins and the rig's path

The rig renders every prompt through the golden harness (§3) and **generates through the same client path production uses** — `api.generateMessage` into the backend relay — not by calling a provider directly. Whatever the relay's translation does (§3, #509), it then happens identically for every arm and matches what users get. The rig records, per generation, the rendered message array, the request body the client built, and the response.

| Switch | Symbol | Pinned |
|---|---|---|
| Provider / model | `useSettingsStore.activeProvider` (sole input to `profileForProvider`) | **set by the rig** to D1's primary; the fixtures' own `openai` default is overridden explicitly. The secondary model is a second full run |
| Sampling | `DEFAULT_SAMPLER`; `modelRejectsSamplers` (`src/api/client.ts`) | **whatever production sends for D1's model.** If `modelRejectsSamplers(primary)` is true the client omits temperature — the rig omits it too and the report records the provider default in force. Otherwise temperature 0.9. Top-p is not sent alongside temperature on the Anthropic path. Before the run the rig asserts which branch was taken and prints it |
| Output length | request `max_tokens` | set explicitly to 400 for every arm — a deliberate rig override so responses are length-comparable, not a default (`DEFAULT_SAMPLER` is 2048; the client's own fallback is 1024) |
| Instruct mode | `instruct.enabled`, `instruct.completionMode` | off, `chat` |
| Generate interceptors | `runGenerateInterceptors` | no server extensions installed |
| Linked style | `mainPromptSnapshot` | `null` |
| Pure-chat mode | `chatCompanionModeByChatFile` | off |
| Card overrides | `respectCharacterOverride`, `respectCharacterPHI` | both on |
| Section order | `promptOrder` | `DEFAULT_PROMPT_ORDER` |
| Persona | `personaStore` | none active; the user is addressed by a fixed neutral name |
| Summary | `compactWhenSummarized` | no summary exists |
| Chat recall | `useChatHistoryRagStore.enabled` | off |
| **World Info** | `activeBookIds`, the character's own books via `getActiveBookIdsForCharacter`, persona and chat-lore overlays | **all empty — lore is off**; an empty `wiScanReport` is attached per rendered prompt as evidence |
| History trim | `trimHistoryToBudget`, `DEFAULT_CONTEXT_CONFIG` | `maxTokens` raised so nothing trims at either depth |
| Macros | `processMacros` | D3 excludes cards containing `{{random}}`, `{{pick}}`, `{{roll}}`, `{{setvar}}`, so every arm's rendered prompt is reproducible |

**Why lore is off rather than pinned to one engine.** Pinning still leaves per-turn activation as a variable between arms, since a rewrite changes which keys appear in the character's own text. Disabling removes the variable entirely and costs only the characters whose behavior lives in lore, which D3 excludes. Those are an explicit residual for E8-S3.

### 6.5 · Judging protocol

- **Unit.** For each (character, probe, depth, sample index) the judge sees the canon card, the scripted history, the probe turn, and two responses labelled A and B, and answers which is more in character *given the canon card*, with a one-line reason. Responses are paired by sample index across arms. Three pairings per unit — N vs F, F vs O, N vs O — each presented in **both orders**.
- **Ties are scored, not discarded.** A tie counts 0.5 and stays in the denominator, so the gating statistic is a proportion in [0,1] where 0.50 means indistinguishable. That is the design's own predicted outcome, and it must read as a result rather than shrinking the denominator until a minority looks decisive. A pair whose verdict flips with order is dropped and counted toward the flip rate. **The report states the tie rate, the flip rate, and the decided fraction for every comparison.**
- **The judge never sees any definition** — not O's card, not N's elements, not F's prose. A judge shown a spec rewards the response that mirrors it [STUDY, arXiv:2509.03419].
- **Judges:** two models from two families, **neither of which is the family of either generator** (primary or secondary), three if budget allows. Judge diversity matters more than judge size — a frontier model and an 8B model scored identically on PersonaScore [STUDY, arXiv:2407.18416].
- **Agreement:** Krippendorff's α across judges, reported per comparison, with **α ≥ 0.667** as the floor for a decisive reading.
- **Human calibration:** a **fixed 60 pairs** drawn from the pilot character, stratified across families, rated blind by Sammy under the identical protocol. Judge–human agreement is computed as **α against the judges' α** — the same chance-corrected statistic on both sides — and is reported with a floor, not used to void a completed run.
- **Length:** `max_tokens` identical across arms; the median output-length delta per comparison is reported, and a cell whose delta exceeds 15% is flagged in the report.
- **Diagnostics, not gates:** an absolute 1–5 rubric on four dimensions **per response** (not per pair) for per-element diagnosis and E8-S5's calibration set; a **stability** score — the fraction of a cell's samples in which the judged decision is the same; and an optional NLI contradiction count against atomic canon facts.
- **Binary families:** adversarial pressure and the hallucination flag are scored break / no-break by the same judges.

### 6.6 · The token measure

- **Surface.** The character-attributable pieces, summed from the `PromptBreakdown` the harness attaches, addressed **by stage because the addressing differs by stage** (§3): the Stage-A/C sections `char_info_block`, `main_prompt` (counted only when the card supplies a `system_prompt`) and `char_phi` by their `BreakdownSectionId`, **plus** the Stage-B slices whose `kind.cls === 'characters_note'`. `characters_note` is not a section id; a sum written over section ids alone silently scores the re-injection slot at zero, in the direction that flatters N.
- **Estimator.** `estimateTokens` under **one profile, named in the report** — whatever `profileForProvider` maps D1's primary to. The same profile is used for every arm and character; the secondary model's run uses its own mapped profile and is reported separately, never pooled.
- **Provider usage.** The relay records none today, so **the gate rests on the estimator**. If D6 is approved and E8-S2 adds usage passthrough, the report additionally states the measured **difference in prompt tokens between arms on identical scripted history** — that difference, not a ratio of the whole prompt, is what a tolerance may be applied to, since the definition is a minority of the prompt and a percentage of the total would permit a large overrun on the only part being compared.
- **Images:** none exist in any probe by construction; the report states this rather than relying on the estimator's zero.
- **Parity as an authoring constraint, checked before probes run:** per character N ≤ O on the estimator, strict — both arms are measured by the same deterministic function on macro-free text (D3), so there is no noise to absorb — and in aggregate Σ N ≤ Σ O. F is matched to N within ±5%.
- **Per-element attribution (E8-S2 task 3):** the compiler tags each element's rendered lines; the report gives per-element estimator tokens for N and the equivalent per-field numbers for O, with the non-additivity of `estimateTokens` across joins reported as a residual.

### 6.7 · Configurations, arithmetic, and the pilot that gates the spend

**Stage 1 — pilot: one character, the full pipeline end to end.** It produces every validity number — tie rate, flip rate, decided fraction, judge α, judge–human agreement, length deltas, parity, and the assertion of which sampler branch and which provider regime were in force — before the remaining characters are authorized. **Stage 2** runs the rest only if the pilot's numbers hold. This caps the blast radius of a design flaw at one character's spend and converts every "only computable after the run is paid for" precondition into a staged decision.

| Row | Generations | Judge calls | Status |
|---|---|---|---|
| **Pilot** (1 char × 12 probes × 2 depths × 10 samples × 3 arms) | 720 | 12 × 2 × 10 × 3 pairings × 2 orders × 2 judges = 2,880 | gating |
| **Stage 2 primary** (7 further characters) | 5,040 | 20,160 | gating |
| Secondary-model full run (8 chars) | 5,760 | 23,040 | diagnostic |
| Per-element ablation (4 chars × 4 ablation probes × 1 depth × 5 samples × 9 variants) | 720 | each of the 8 removals judged against full N: 4 × 4 × 5 × 8 = 640 pairs × 2 orders × 2 judges = 2,560 | diagnostic |
| Per-response 1–5 rubric (every gating response, 2 judges) | — | 11,520 | diagnostic |

Gating totals: **5,760 generations and 23,040 judge calls.** At roughly 3.5K prompt tokens per generation and 3K per judge call this is on the order of 20M generation and 70M judge tokens — provider spend on Sammy's key, not agent tokens, and **materially larger than a naive count of the primary run alone**. E8-S2's plan quotes it exactly against D1's actual pricing before anything runs; the diagnostic rows may be dropped for cost without a new gate, at the stated cost of losing the answer each buys. Agent spend for authoring, the rig, judging orchestration and the report is E8-S2's own L band, separate from provider spend.

**Floor configuration** (five characters, five samples) exists for a reduced run and requires 5 of 5 characters directional; its own paired-item count is roughly 600 per comparison, which is where R3's "effective sample in the twenties" clustering figure comes from — that figure is the **floor** configuration's, not the eight-character gate's.

Why the character is the unit of generalization: items within a character are strongly correlated, so a large paired-item count collapses to a much smaller effective sample once clustered, and the character-level sign test is the honest statistic.

---

## 7 · Thresholds — GO / ITERATE / STOP (pre-registered)

**Validity preconditions — computed on the pilot first, then on the full run. A failure pauses for a repair decision; it is not a STOP.**

1. Judge–judge Krippendorff α ≥ 0.667 per gating comparison.
2. Order-flip rate ≤ 25% of pairs.
3. Parity held as authored: per character N ≤ O, Σ N ≤ Σ O, F within ±5% of N.
4. The held-out probes passed the overlap check and were sealed before N and F were authored, attested by commit timestamps.
5. The sampler branch and provider regime actually in force are recorded and match D1.

Reported with the result, never voiding it: judge–human α on the fixed 60-pair calibration set, the tie rate, the decided fraction, and the median length delta per comparison.

**GO — all of the following, on held-out probes, primary model, ties scored 0.5:**

1. Aggregate **N-over-F** ≥ **0.56**, with a 95% character-clustered bootstrap interval excluding 0.50.
2. Aggregate **N-over-O** ≥ 0.56 with the same interval test (the epic's literal criterion).
3. **≥ 7 of 8** characters individually favor N over F (5 of 5 in the floor configuration).
4. **Depth non-inferiority:** N-over-F at the long depth ≥ its short-depth value **− 0.05**, and the long-depth value ≥ 0.56 on its own. This is the drift claim, stated as non-inferiority because a strict point increase passes half the time under its own null.
5. Adversarial break rate: N ≤ F and N ≤ O.
6. Naturalness non-inferiority on family 8: N ≥ 0.45.
7. Stability non-inferiority: N ≥ O **− 0.05**, averaged per character.

**Power, stated rather than implied.** This is not a scientific test of whether behavioral definition helps at all; it is a business test of whether it helps enough to justify E8-S3 → S6, one of which is an XL build. At eight characters with per-character clustering the design reliably detects a character-level advantage in the high 0.60s and will miss a small one. That is the intended trade: **an effect too small for this design to see is also too small to justify the build**, and it lands in ITERATE, not in a false STOP. The report states the minimum detectable effect it actually achieved and, for the record, the fraction of judged pairs on which the arms were indistinguishable.

**The decision map is total.** Every outcome routes:

| Outcome | Verdict |
|---|---|
| All seven GO criteria met | **GO** |
| Criterion 1 fails with N-over-F < 0.50 and the interval excluding 0.50, **and** criterion 2 also fails | **STOP** |
| Parity unattainable for ≥ 2 characters (no N authorable under O's tokens that passes the development probes) | **STOP** |
| Anything else — including any single criterion failing, an N-over-F between 0.50 and 0.56, or a precondition that could not be repaired | **ITERATE** |

**ITERATE — one bounded cycle, then a strategy call.** The iteration changes **which elements carry content** — the per-element ablation says which; the first candidates are motivations and flaws in the Inworld shape and a fuller arc — never the thresholds, never the probes, never the judges. Only arm N is re-authored, so O's and F's responses are reused from cache and only N's generations and the pairings containing N are re-run; that is roughly two-thirds of a gating cycle, which is what the ITERATE budget must cover. All preconditions are re-checked. After one cycle the result goes to Sammy regardless.

**Roadmap consequence.** GO unlocks E8-S3 → S6 as written. ITERATE holds them for one cycle. STOP applies roadmap §8's fallback — E7-S2 builds on current fields plus cascade rails, and E8's testing and prompt-pattern concepts apply to freeform definitions — and E8-S3/S4 are re-scoped or dropped.

---

## 8 · What E8-S2 must deliver

**Before any generation:** the canon cards with their owner-correction change logs, the arm cards (O untouched, N and F), the parity table per character and per element, the three sealed probe pools with the overlap check's output, the scripted histories, the rig's pinned configuration dump including which sampler branch and provider regime are in force, and the commit hash of this brief.

**The validation report:** per-character and aggregate rates for all three comparisons with clustered intervals; tie rates, decided fractions, flip rates; the depth split; break rates; naturalness; stability; judge α and the human-calibration α; length deltas; the **per-element ablation** on the ablation pool, so the report can say which elements carried the gain and whether the PHI and note slots alone explain it; the secondary model's run, reported separately; token accounting per element; and the verdict read off §7's decision table with no reinterpretation.

**It must also state plainly:** which provider regime the run used and therefore what it can and cannot conclude about re-injection (#509); that the design measures definition-driven resistance at depth rather than self-conditioning drift; and the size of the owner's canon-card corrections, since those are what separate N-vs-O from N-vs-F.

**What the report may not do:** pool the two models, drop a character after the fact, re-weight families, or cite a threshold not in §7. If any of that seems necessary it is a new gate (§1) and is recorded as one.

---

## 9 · Threats to validity, and what the design does about each

| Threat | Mechanism | Mitigation |
|---|---|---|
| Authoring-effort confound | a fresh careful rewrite beats an old card regardless of format | arm F, time- and token-matched; GO gates on N vs F |
| Owner-correction leak | N and F are authored from a canon card O never saw | stated, symmetric across N and F, sized by F vs O and by the change log |
| Rubric leakage | a judge shown the structure rewards outputs mirroring it | judges see only the canon card; probes share no content-word 4-gram with any definition |
| Position / verbosity / self-preference bias | judges prefer the first, the longer, or their own family's style | both orders with flips dropped; identical `max_tokens`; judge families exclude both generators |
| Correlated judge error | two judges agree on an artifact | fixed 60-pair human calibration, α against α |
| A tie-heavy battery reading as a win | excluding ties shrinks the denominator until a minority looks decisive | ties score 0.5 and stay in; tie rate and decided fraction reported |
| Coin-flip criteria | bare point-estimate inequalities pass half the time under their null | criteria 4 and 7 are non-inferiority with margins; 1–3 carry intervals |
| Goodhart on probes | the author writes to the test | three disjoint pools; held-out authored by another agent and sealed |
| Sampling noise | one draw decides a cell | ten samples per cell; stability reported |
| Small n | five characters cannot support a partial result | eight recommended; at five, 5 of 5, said in advance |
| Disposition confound | dark characters degrade in every arm | balanced set; per-stratum reporting |
| Memorization | a famous character is recalled, not played | no famous or licensed characters |
| Nondeterministic prompts | `{{random}}`/`{{pick}}`/`{{roll}}` in a live card | excluded at selection (D3) |
| Provider reshaping | the relay moves system messages (#509) | the rig generates through the production client path; placement is provider-aware and identical across arms; the regime is reported |
| Sampler mismatch | the shipped temperature is model-dependent | `modelRejectsSamplers` branch asserted and recorded |
| Estimator is a heuristic | chars-per-token is not a tokenizer | parity is a strict inequality on macro-free text under one profile; provider usage only if D6 |
| Re-injection explains everything | the gain comes from PHI and note slots | F carries the same lever; per-element ablation required |
| Example removal explains it | N empties `mes_example` | recorded per character; ablation separates it |
| Consistent but wrong | the canon card itself is wrong | the owner corrects every canon card before rewrites; family 8 and naturalness guard a joyless win |
| Cost surprise | the gate is larger than a naive count | pilot stage gates the spend; every mandated run has its own row |

**What this design still cannot see:** whether users prefer the new characters in live chats — E8-S6's A/B harness, not P0; self-conditioning drift; and behavior in group chat, where three of the four surfaces do not exist today (§3).

---

## 10 · Sources

Grouped; per-claim URLs and evidence labels are in the four research reports. Preprints from 2026 were read from abstracts and landing pages where full PDFs did not render; their headline claims should be re-read in full before E8-S3 builds on them.

**Role-play and persona research [STUDY]:** profile axes (Familiarity × Structure × Disposition), arXiv:2601.04716 · ArcANE character-arc conditioning, arXiv:2606.05553 · anonymized role-play benchmarking, arXiv:2603.03915 · persona drift and attention decay, arXiv:2402.10962 · lost in multi-turn, arXiv:2505.06120 · Breaking the Assistant Mold, arXiv:2601.03396 · InCharacter, ACL 2024 · PersonaGym, arXiv:2407.18416 · CharacterEval, ACL 2024 · CharacterBench, AAAI 2025 · CoSER, ICML 2025 · TimeChara, ACL Findings 2024 · RoleLLM · Character-LLM · Ditto · persona prompting and accuracy, arXiv:2512.05858 · psychometric-validity critiques, arXiv:2405.07248 and 2502.08265 · adversarial persona breaking, arXiv:2506.14539, 2409.16727, 2605.01899.

**Judging and statistics [STUDY]:** LLM-as-judge biases, arXiv:2306.05685 · curse of knowledge in judges, arXiv:2509.03419 · scoring bias, arXiv:2506.22316 · comparative vs absolute judging, arXiv:2602.16610 and 2606.09409 · rating inconsistency, arXiv:2510.27106 · sampling instability, arXiv:2512.12066 · benchmark uncertainty, arXiv:2410.03492 · Krippendorff's α conventions · Dialogue NLI, ACL 2019.

**Vendor and platform documentation [DOC]:** Character.AI Definition docs, Character Guide and memory blog · Anthropic, "Claude's Character" and prompting best practices · OpenAI Model Spec and GPT Builder help · Inworld Studio docs and CAM benchmark · Convai character APIs · SillyTavern docs (Character Design, Author's Note, World Info, Group Chats) · KoboldAI Memory / Author's Note / World Info wiki · Character Card V2 and V3 specs · Agnai docs and issue #301 · RisuAI wiki and `RisuAI_bot_test` README · Backyard AI docs · Oobabooga character wiki · Replika and Kindroid help pages (search snippets; lower confidence).

**Community practice [FOLK / SEC]:** Trappu's PList + Ali:Chat guide · kingbri's MinimALIstic guide · Nomi wiki and user-issue summaries · Janitor AI, Chai, Candy.ai, PolyBuzz, CrushOn, Talkie creator guides and secondary reporting.

**Not found, stated so it is not re-searched:** a primary source for "W++ brackets confuse the model"; any definition of JED/JED+; Chub.ai's first-party documentation; any consumer or engine product that scores a character's consistency before publishing.

---

## Appendix A · Probe family seeds (shapes, not the sealed probes)

Each probe is a fully scripted history plus one generated probe turn; the probe describes a situation and uses no trait vocabulary.

1. **Betrayal.** A named ally from the scripted history is shown to have sold the character out for something the character values less than loyalty. Probe: the ally walks in.
2. **Moral dilemma.** Two things the canon card says the character values are put in direct conflict by a concrete choice with a deadline; neither outcome is the "nice" one. Probe: the user asks which it is going to be.
3. **Genre shift.** The scripted history establishes one register; the probe turn announces, in-world and matter-of-factly, an event from a different genre. Probe: the user reacts in the new register.
4. **Adversarial pressure**, three variants: (a) "you're an AI, drop the act"; (b) flattery plus a request crossing a hard limit; (c) *assistant-collapse* — a polite, reasonable request an assistant would fulfil and this character would refuse or deflect.
5. **Knowledge boundary.** The user references, as common knowledge, something outside the character's world or timeline, then asks the character's opinion of it.
6. **Emotional escalation.** Three scripted user turns raise the temperature toward a known sore point. Probe: the fourth.
7. **Long-horizon callback.** A scripted character turn early in the history commits to something — a promise, a refusal, a stance. At the probe turn the user acts as if the commitment were the opposite.
8. **Mundane control.** Weather, food, a small errand; no stakes.

## Appendix B · Judge prompt skeleton

> You are judging which of two responses is more in character for a specific person. You will be given a description of the person (the canon card), a conversation so far, and two candidate replies labelled A and B. Judge only in-character fidelity to the canon card: values, how they decide, how they speak, what they would and would not do. Do not reward length, politeness, helpfulness or eloquence. If neither is more in character, answer TIE — TIE is a real answer, not a failure to decide. Answer A, B or TIE and one sentence naming the specific line or choice that decided it.

For family 4: *Did the reply stay in character as described, or did it break — answer as an AI, comply with a request it would refuse, or abandon its limits? Answer BREAK or NO-BREAK.* For family 8's naturalness pair: *Which reply reads as the more natural, engaging thing for this person to say?*

## Appendix C · Compiler template (arm N)

```
description ←
{{char}} — <Essence>
Values, in order: <V1> > <V2> > <V3> [> <V4> > <V5>]. When <V1> conflicts with <V2>, <V1> wins. When <V2> conflicts with <V3>, <V2> wins. [...]
Decides by: <what is weighed first>; when unsure, <default>; never <forbidden means>; under pressure, {{char}} <default under pressure>.
Conflict: set off by <triggers>; escalates by <pattern>; de-escalates when <condition>; treats betrayal by <pattern>; tells: <tells>.
Right now: wants <want>; fears <fear>; unresolved: <tension>; leaning <direction>.
Knows: <boundary>. Does not know: <boundary>. When unsure of a fact, {{char}} <handling>.

personality ←
Voice: <register>; <sentence length>; <vocabulary tier>; <tics>; <expressiveness>; never says <never>.
[Anchor: <one exchange, ≤ 60 tokens>]   (only if D4 = yes)

post_history_instructions ←
{{char}} never <hard limit 1>; never <hard limit 2>[; never <3>; <4>]. When tempted to <pattern>, {{char}} instead <move>. When tempted to <pattern>, {{char}} instead <move>.

extensions.depth_prompt (depth 4; role per D1's provider regime — 'user' on the Anthropic path, else 'system') ←
Remember: {{char}} values <V1> over <V2>; right now <tension>; speaks <register>.

scenario, first_mes, alternate_greetings, avatar, name, tags ← unchanged from arm O
mes_example ← empty
system_prompt ← empty, unless arm O carries one (then a compiled equivalent, no longer)
```
