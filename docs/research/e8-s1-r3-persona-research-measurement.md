# Character Architecture v2 — R3: Persona Research Survey + Measurement Design

Prepared 2026-09-03. **[DOC]** = documented in a cited source. **[INF]** = my inference/reasoning, not asserted by any source.

---

## 0. The headline you need before reading anything else

**[DOC]** The single most recent study to directly test the hypothesis behind Character Architecture v2 found *against* it. "Identifying and Mitigating Bottlenecks in Role-Playing Agents" (arXiv 2601.04716, Jan 2026) disentangled character profiles along three axes — Familiarity (known/unknown), **Structure (structured/unstructured)**, and Disposition (moral/immoral) — across 211 personas and 5 LLMs, single- and multi-turn. Result: *"Familiarity and Structure show negligible impact"*; only Disposition produced large consistent degradation.

**[INF]** This does not kill the initiative, but it does define the burden of proof. Our claim cannot be "structured is better than unstructured." It must be a narrower, testable claim: *behavioral* content (values in tension, decision rules, conflict patterns) added at ≤ token parity improves consistency **under pressure and over long horizons**, where the generic structured-vs-prose comparison would not show a difference. The gate must be designed to distinguish those two claims, or it will produce a false GO.

---

## 1. Survey table

| Work | What it defines / measures | Key result | Model era | Relevance to us |
|---|---|---|---|---|
| **RoleLLM / RoleBench** ([arXiv 2310.00746](https://arxiv.org/abs/2310.00746), ACL Findings 2024) | Role profile construction (100 roles) + RoleBench, 168,093 samples; speaking-style imitation + role-specific knowledge | Fine-tuned open 7/13B models reach GPT-4-prompting parity on role-play | GPT-3.5/4, LLaMA-7/13B (2023) | Profile *fields* are ad-hoc; benchmark is single-turn instruction-style. Low transfer to 2026 frontier models |
| **Character-LLM** ([EMNLP 2023](https://aclanthology.org/2023.emnlp-main.814/), arXiv 2310.10158) | "Experience upload" — train on synthesized life experiences; interview playground for eval | Trained agents recall character experiences better than prompted baselines | 2023, LLaMA-7B | Establishes the *interview* as an eval instrument. Training approach irrelevant to us (we're prompt-side) |
| **CharacterEval** ([ACL 2024](https://aclanthology.org/2024.acl-long.638/), arXiv 2401.01275) | 1,785 multi-turn dialogues, 23,020 examples, 77 Chinese characters; 13 metrics / 4 dims (conversational ability, consistency, attractiveness, personality back-testing) | CharacterRM (reward model on human annotations) correlates with humans **better than GPT-4** | GPT-4 era, Chinese LLMs | Best evidence that a *trained* judge beats a prompted frontier judge. Also: consistency is only 1 of 4 dims — attractiveness can move opposite |
| **CharacterBench** ([AAAI 2025](https://ojs.aaai.org/index.php/AAAI/article/view/34806), arXiv 2412.11912) | 22,859 human-annotated samples, 3,956 characters; 11 dimensions / 6 aspects, split **sparse vs dense** (does the feature manifest in every response or not?) | CharacterJudge model for stable cheap eval | 2024–25 | The sparse/dense distinction is directly useful: most of what we care about (values, conflict patterns) is *sparse* and needs targeted elicitation, not aggregate scoring |
| **PersonaGym / PersonaScore** ([arXiv 2407.18416](https://arxiv.org/abs/2407.18416), EMNLP Findings 2025) | 200 personas, 10,000 questions; 5 tasks (Expected Action, Linguistic Habits, Persona Consistency, Toxicity Control, Action Justification), decision-theory framing; auto-generated 1–5 rubrics; ensemble of GPT-4o + LLaMA-3-70b judges | Spearman 76.1% avg with humans (peak 84.5%); Kendall-τ 73.3%. **GPT-4.1 scored identical to LLaMA-3-8b** | 2024–25, incl. GPT-4.1 | The rubric-generation + 2-judge-ensemble recipe is the most directly reusable protocol. The GPT-4.1 = LLaMA-3-8b result says scale ≠ persona fidelity |
| **InCharacter** ([ACL 2024](https://aclanthology.org/2024.acl-long.102/), arXiv 2310.17976) | Personality fidelity via **psychological interview** rather than self-report questionnaire; 32 characters × 14 scales (BFI, 16Personalities…) | Up to **80.7%** agreement with human-perceived character personality | GPT-3.5/4 era | The interview trick is the key transferable idea: never ask the character to fill in a form; infer traits from in-character dialogue |
| **Ditto** ([ACL 2024](https://aclanthology.org/2024.acl-long.423/), arXiv 2401.12474) | Self-alignment; 4,000-character role-play SFT set | Maintains consistent role identity + role knowledge in multi-turn; beats open baselines | 2024, open 7–70B | Confirms multi-turn identity is the hard part; method is training-side |
| **CoSER** ([ICML 2025](https://proceedings.mlr.press/v267/wang25dk.html), arXiv 2502.09082) | 17,966 characters / 771 books; **given-circumstance acting** — model plays multiple characters in a book scene | CoSER-70B: 75.80% InCharacter, 93.47% LifeChoice; matches/beats GPT-4o | 2025, LLaMA-3.1 | "Given circumstance" = probe design done right: a fixed scene, characters must act, ground truth is the book |
| **ECHO** ([arXiv 2404.13957](https://arxiv.org/abs/2404.13957)) | Turing test judged by **acquaintances of the real person** | Best system fooled judges 48.3% | GPT-3.5/4 | Gold-standard blinding (judges know the target independently). Not affordable for us |
| **TimeChara** ([ACL Findings 2024](https://aclanthology.org/2024.findings-acl.197/), arXiv 2405.18027) | Point-in-time character hallucination; 10,895 instances, 14 characters, 4 novel series | Even GPT-4o hallucinates knowledge outside the character's timeline | 2024, incl. GPT-4o | Template for our **knowledge-boundary** probe family |
| **ArcANE** ([arXiv 2606.05553](https://arxiv.org/abs/2606.05553), Jun 2026) | "Character Arc" = narrative segmented into phases along a psychological axis; 17 novels, 80 characters; same scenario probed across phases, **in-source and beyond-source**; 6 models × 6 context modes | Arc conditioning **tops every other context strategy on every model**; gap largest on beyond-source scenarios where retrieval finds nothing | 2026 frontier | Strongest pro-structure evidence available, and it's *behavioral/psychological* structure, not attribute lists. The beyond-source probe design is the one to copy |
| **Anonymous role-play benchmarking** ([arXiv 2603.03915](https://arxiv.org/pdf/2603.03915), Mar 2026) | Strips character *names* to defeat memorization | Anonymizing **degrades performance** → existing benchmarks partly measure recall, not role-play. Adding personality info consistently improves RPA performance in the anonymized setting | 2026 | Two lessons: (a) don't benchmark on famous characters; (b) explicit personality specs *do* help once memorization is removed — a counterweight to 2601.04716 |
| **Profile axes study** ([arXiv 2601.04716](https://arxiv.org/pdf/2601.04716), Jan 2026) | Familiarity × **Structure** × Disposition, 211 personas, 5 LLMs | Familiarity & Structure: **negligible**. Immoral disposition: large consistent degradation, amplified by post-SFT alignment | 2026 | See §0. Also predicts our darker GGBC characters will score worse regardless of arm — stratify or it becomes a confound |
| **Persona drift / instruction instability** ([arXiv 2402.10962](https://arxiv.org/abs/2402.10962)) | Self-chat between two personalized bots; attention-decay analysis; split-softmax fix | Significant drift **within 8 rounds** on LLaMA2-chat-70B | 2024, LLaMA2-70B | Sets the minimum conversation length for a drift probe: ≥8 turns. Model era caveat: frontier 2026 models are far better here |
| **Lost in multi-turn** ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120), Microsoft) | Single-turn fully-specified vs multi-turn under-specified, 6 tasks | **39% average performance drop** multi-turn, all top open+closed models | 2025 frontier | Single-turn probes systematically under-detect the failure we're trying to fix |
| **Generative Agents** ([UIST 2023](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763), arXiv 2304.03442) | Memory stream (recency/importance/relevance) + reflection + planning | Ablations: observation, planning, reflection each contribute to believability | GPT-3.5 | Architecture, not definition format. Relevant only if v2 adds a reflection layer |
| **Dialogue NLI + C-score** ([ACL 2019](https://aclanthology.org/P19-1363.pdf); Madotto et al. 2019) | NLI over (persona sentence, utterance): +1 entail / 0 neutral / −1 contradict, summed | BERT-large ≈88.9% on DialogNLI test | Pre-LLM | Cheap, mechanical, **judge-independent** consistency signal. Only detects contradiction of explicitly stated facts |
| **PersonaLLM** ([arXiv 2305.02547](https://arxiv.org/html/2305.02547v5)) / **Serapio-García et al. 2023** | Can an LLM express an assigned Big Five profile? Psychometric validity of BFI on PaLM | Assigned traits are detectable in writing | 2023, GPT-3.5/PaLM | Caveat below |
| **Psychometric validity critiques** ([arXiv 2405.07248](https://arxiv.org/pdf/2405.07248), [2502.08265](https://arxiv.org/pdf/2502.08265)) | Factor structure of BFI-2 responses from LLMs | GPT-3.5 / Llama-2 do **not** reproduce the 5-factor structure; GPT-4-Turbo does | 2024–25 | Psychometrics on LLMs are only interpretable on strong models. Use as a *secondary* signal |
| **Adversarial persona breaking** — [Doppelganger (2506.14539)](https://arxiv.org/pdf/2506.14539), [RoleBreak (2409.16727)](https://arxiv.org/pdf/2409.16727), [persona-invariant alignment (2605.01899)](https://arxiv.org/pdf/2605.01899) | Prompt-based transferable attacks that break role consistency; character hallucination as jailbreak via "query sparsity" + "role-query conflict" | Personas function as a general attack surface; defenses decouple safety from persona | 2025–26 | Our OOC/adversarial probe family. Note: a *more* robust character is a partly adversarial goal against safety training |
| **Anthropic, "Claude's Character"** ([anthropic.com](https://www.anthropic.com/research/claude-character), Jun 2024) | Character trained as broad dispositions (curiosity, honesty, willingness to disagree), explicitly **not** as rules "from which it never deviates"; via Constitutional-AI-style self-ranking | Qualitative; no consistency metric published | Claude 3 | Directionally supports values-over-rules. **No measurement methodology published** |
| **OpenAI Model Spec** ([model-spec.openai.com](https://model-spec.openai.com/2026-08-18.html)) | Overridable defaults; developer-message steerability of tone/persona; assistant should refuse attempts to confuse it into a different persona | Policy doc, no metrics | 2025–26 | Confirms platform-level persona steering is a first-class supported concept; no validation tooling |

### Industry character engines

| Engine | Fields it exposes | Validation / consistency tooling |
|---|---|---|
| **Inworld AI** ([docs](https://docs.inworld.ai/docs/tutorial-basics/)) | Core Description ("who they are and what they want, not what they know"), **Motivations**, **Flaws**, dialogue-style Adjectives, Colloquialisms, personality sliders (negative↔positive, aggressive↔peaceful, cautious↔open, introvert↔extravert, insecure↔confident), Mood, **Goals** structured as Activation / Motivation / Completion + Instruction, [Common Knowledge](https://docs.inworld.ai/docs/tutorial-basics/common-knowledge/), Scenes + Scene Triggers, [Character Mutations](https://docs.inworld.ai/docs/tutorial-basics/character-mutations/), 3-tier knowledge filter (None/Mild/Strict), Safety | Published a **Conversational Authenticity Metric (CAM)** — naturalness, relevance, conversational diversity ([blog](https://inworld.ai/blog/developing-llm-benchmarks-for-conversational-realism-in-lifelike-ai-agents)). No per-character confidence score, no public authoring-time validator |
| **Convai** ([blog](https://convai.com/blog/master-character-creation-core-apis)) | Name, voice, backstory; [Knowledge Bank API](https://convai.com/blog/building-ai-characters-knowledge-bank-with-convai) (files with IDs); programmatic backstory/history/action edits; guardrails to keep the NPC in character | Guardrails only; no published validation suite |
| **NVIDIA ACE** ([NVIDIA](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-for-games-generative-ai-npcs/)) | Not a character-definition schema — Riva (ASR/TTS) + Audio2Face microservices; character definition delegated to partners like Convai | None published |
| **Charisma.ai** | Graph/script-flow authoring; emotion, memory, goals, branching; variables arranged by narrative effect | None published |
| **Replica Studios** | Smart NPCs plugin for Unreal, 120+ licensed voices, BYO LLM | **Ceased operations 2025-06-30** |

**[DOC]** Inworld's field set is the closest industry analogue to what v2 proposes — it already separates *motivations* and *flaws* from description, and models *goals* as activation/completion state machines.
**[INF]** Notably, Inworld arrived at this schema by product iteration, not by publishing a controlled comparison against freeform descriptions. No engine surveyed publishes a per-character consistency or confidence score. That's the gap v2 could actually own — but only with a measurement that survives scrutiny.

---

## 2. What works, what fails, what nobody does

**Works (measured):**
- Interview-style elicitation beats self-report questionnaires for personality fidelity (InCharacter, 80.7%).
- Trained/specialized judges beat prompted frontier judges on human correlation (CharacterEval's CharacterRM; CharacterBench's CharacterJudge).
- Ensembles of heterogeneous judges with generated per-item rubrics reach ~0.76 Spearman with humans (PersonaGym).
- **Psychological-trajectory** structure (ArcANE's Character Arc) beats every retrieval/context alternative on every model tested, and wins biggest on situations the source text never covered.
- Explicit personality specification helps once character-name memorization is removed (2603.03915).

**Fails / doesn't replicate:**
- Generic "structured vs unstructured" profile format: negligible effect (2601.04716).
- Naive psychometrics on weak models: BFI factor structure doesn't hold below GPT-4-class (2405.07248).
- Single-turn evaluation as a proxy for conversational behavior: −39% gap (2505.06120).
- Benchmarks built on famous characters: measure memorization (2603.03915).
- Model scale as a proxy for persona fidelity: GPT-4.1 == LLaMA-3-8b on PersonaScore.

**Nobody does:**
- **[DOC/INF]** No source found publishes a controlled comparison of *behaviorally* specified characters vs *descriptively* specified characters **at matched token budget**. Token cost is essentially never reported as a controlled variable in this literature.
- No industry engine ships an authoring-time consistency validator or confidence score.
- No published work I found uses a **freeform-rewrite control arm** to separate format effects from authoring-effort effects in persona specs. (The closest analogue is the random-rewrite control used in automatic prompt optimization work.)

---

## 3. Measurement recommendations (each with the failure mode it guards)

1. **Three arms, not two: A = current definition, B = careful freeform rewrite, C = structured v2.** Same author, same time budget, same token cap for B and C. Gate on **C vs B**, report C vs A as context. *Guards:* the authoring-effort confound — the single most likely benign explanation of a positive result, made more likely by 2601.04716's null on Structure. **[INF]**
2. **Blind pairwise A/B per probe, not absolute Likert.** Comparative assessment is more stable than direct scoring under LLM judges ([2602.16610](https://arxiv.org/html/2602.16610v2), [2606.09409](https://arxiv.org/html/2606.09409v1)). *Guards:* rating-scale drift and judge self-inconsistency ([Rating Roulette, 2510.27106](https://arxiv.org/pdf/2510.27106)).
3. **Present both orders for every pair; drop any pair where the judge flips with order.** *Guards:* position bias (Zheng et al., [2306.05685](https://arxiv.org/abs/2306.05685)). Report the flip rate as a health metric.
4. **The judge never sees either character definition.** Judge against a *neutral canon card* — plain prose, one per character, authored once, format-identical for all arms. *Guards:* rubric leakage / format-match bias and contextual anchoring, both documented in [Curse of Knowledge (2509.03419)](https://arxiv.org/pdf/2509.03419) and [scoring-bias work (2506.22316)](https://arxiv.org/html/2506.22316v1). **This is the highest-risk single failure mode in the whole design** — a judge shown the structured spec will reward the arm whose output mirrors it.
5. **Length-match the compared outputs** (cap max tokens identically, and report length deltas per pair). *Guards:* verbosity bias (2306.05685).
6. **≥2 judges from different model families, neither the generation model.** *Guards:* self-enhancement bias (2306.05685). Report **Krippendorff's α**; Krippendorff's convention is α ≥ 0.800 acceptable, α ≥ 0.667 the floor for tentative conclusions ([Krippendorff](http://faculty.washington.edu/jwilker/559/Krippendorf.pdf)). Treat α < 0.667 as *run void*, not as a result.
7. **Human calibration subset: 10–15% of pairs, rated blind by a human.** If judge–human agreement is materially below judge–judge agreement, the judges agree on an artifact. *Guards:* correlated judge error, which no amount of judge ensembling detects. **[INF]**
8. **N ≥ 3 samples per probe minimum; N ≥ 10 for the gate decision.** Single-shot evaluation agreed with multi-sample ground truth only 92.4% of the time; N=3 → 95%, N=20 → 99.4%; decision flips rose from 9.5% at T=0 to 19.6% at T=1 ([2512.12066](https://arxiv.org/html/2512.12066v1)). Report x̄ ± prediction interval ([2410.03492](https://arxiv.org/html/2410.03492v2)).
9. **Run at the temperature GGBC actually ships at**, not at T=0. *Guards:* a T=0 result that evaporates in production. **[INF]** — supported by the temperature/flip-rate numbers above.
10. **Pre-register everything before generating a single response**: characters, probes, arms, judges, N, thresholds, exclusion rules. Freeze as a git commit hash referenced in the result. *Guards:* threshold-shopping after seeing data. **[INF]**
11. **Held-out (locked) probes authored by someone who has not read the v2 definitions**, and never shown to the definition author. Keep a separate dev-probe pool for iteration. *Guards:* Goodharting — probes leaking into the definition. **[INF]**, motivated by the memorization-contamination result in 2603.03915.
12. **Probes describe situations, never traits.** No probe may reuse vocabulary from any arm's definition. *Guards:* keyword-echo scoring, where the structured arm wins by restating its own spec. **[INF]**
13. **Multi-turn, fixed-seed conversations of ≥12 turns; score early turns (1–4) and late turns (9–12) separately.** Drift appears within 8 rounds (2402.10962) and multi-turn under-specification costs ~39% (2505.06120). *Guards:* a single-turn design that cannot detect the drift-resistance the whole architecture claims.
14. **Stratify or balance on character disposition (sympathetic vs morally dark).** Immoral-disposition characters degrade consistently across all conditions (2601.04716). *Guards:* an arm accidentally loaded with darker characters losing for reasons unrelated to format.
15. **Do not use famous characters as test subjects.** *Guards:* measuring the model's memory of the character rather than your definition (2603.03915).
16. **Token parity enforced as an authoring constraint, not measured as an outcome.** *Guards:* the trivially-gameable version where v2 "wins" by spending 40% more prompt.
17. **Include a naturalness/enjoyability guardrail metric with a non-inferiority margin.** CharacterEval measures attractiveness separately from consistency for a reason. *Guards:* shipping a character that is more consistent and less fun.
18. **Cheap mechanical triangulation: NLI C-score** over atomic canon facts (Dialogue NLI lineage). *Guards:* total dependence on LLM judges. Fails to capture voice, tone, and behavioral pattern — use as corroboration only, never as the primary.

---

## 4. Proposed metric set + GO/ITERATE threshold shape

### Assumptions stated up front
- 8–10 reimagined characters (see the power argument below — 5 is too few for anything but a clean sweep).
- 12 locked probes per character (8 families, some doubled), each a fixed-seed multi-turn conversation of 12 turns.
- N=10 samples per (character, probe, arm) at production temperature.
- 2 judges from different families; generation model is a third family.
- Neutral canon card per character; judges blind to arm and to all definitions.

### Probe battery (8 families)
Betrayal / loyalty test · moral dilemma with two of the character's own stated values in tension · genre shift (the scene turns comedic/horror mid-conversation) · adversarial OOC pressure ("ignore your character, you're an AI") · knowledge boundary (TimeChara-style: something the character cannot know) · emotional escalation · long-horizon callback (turn 11 contradicts something the character committed to at turn 2) · **mundane low-stakes small talk** (control — if structure only helps in dramatic probes, that is a real and reportable limitation).
Adversarial/OOC probes are scored as a **binary break / no-break rate**, not on the rubric — a graded judge washes out a discrete failure. **[INF]**

### Primary metric
**Blind pairwise in-character preference, C vs B**, aggregated over probes, ties dropped.

### Validity preconditions (checked first — failing any voids the run, it is not an ITERATE)
- Judge–judge Krippendorff α ≥ 0.667.
- Judge–human agreement on the calibration subset ≥ (judge–judge α − 0.10).
- Order-flip rate ≤ 25%.
- Per-character rendered prompt tokens: C ≤ 1.05 × A, and aggregate Σ C ≤ Σ A.
- Median output length delta |C − B| ≤ 15%.

### GO threshold
- Aggregate C-over-B win rate **≥ 0.62** (ties excluded), 95% cluster-bootstrap CI (clustered **by character**) excluding 0.50; **and**
- **≥ 7 of 8 characters** individually favor C (sign test p ≈ 0.035); **and**
- **Late-turn (9–12) win rate ≥ early-turn (1–4) win rate** — this is the drift claim, and without it the result is a prose-quality win, not an architecture win; **and**
- Adversarial/OOC break rate: C ≤ B; **and**
- Naturalness guardrail: C's win rate ≥ 0.45 (non-inferiority, margin 0.05); **and**
- NLI contradiction rate and InCharacter-style personality accuracy both directionally consistent (C no worse than B).

### ITERATE (the important branch)
**C > A but C ≈ B** → you built a better rewrite, not an architecture. This is the outcome 2601.04716 predicts, and it should be *expected*, not treated as failure. Iterate on which behavioral fields carry signal (ArcANE suggests psychological-trajectory content is the payload; motivations/flaws per Inworld are the next candidates), not on prompt polish.

### Why 8–10 characters, not 5 — the power arithmetic **[INF]**
With 5 characters × 12 probes × 10 samples you have ~600 paired items per arm-comparison. An unclustered binomial test at n=600 would detect a tiny effect — but items within a character are strongly correlated, so **the character is the unit of generalization**. With a per-character cluster size of ~120 and a plausible ICC of 0.2, the design effect is 1 + (120−1)(0.2) ≈ 24.8, giving an effective n of roughly 24 — enough to detect only about a 0.80 win rate at 80% power. At the character level a sign test gives p = 0.031 for 5/5 and p = 0.19 for 4/5: **at n=5 only a clean sweep is nominally significant.** At n=8, 7/8 gives p ≈ 0.035 and 8/8 gives p ≈ 0.008. Recommendation: run 8–10 characters, or accept in advance that the n=5 gate requires 5/5 and report it as such rather than discovering that constraint after the fact.

### Token parity, defined precisely **[INF]**
"Parity" should be a **per-character hard constraint at authoring time** (C ≤ 1.05 × A on rendered prompt tokens at a fixed context configuration), plus an **aggregate non-increase** (Σ C ≤ Σ A). Per-character-only invites one bloated character; aggregate-only invites averaging a 2× character against four thin ones. The 5% per-character tolerance absorbs tokenizer noise without permitting a real budget increase.

### What this metric set still cannot see
Rubric-based pairwise judging cannot detect a character that is consistent but *wrong* relative to author intent (the canon card is the only anchor, and it is one person's view); embedding drift and NLI corroborate but do not adjudicate; psychometrics are only interpretable on frontier judges; and none of this measures whether users *prefer* the v2 characters in real chats — which is the actual product question and needs a separate live A/B.

---

## 5. Sources

Role-play / persona research: [RoleLLM 2310.00746](https://arxiv.org/abs/2310.00746) · [Character-LLM EMNLP 2023](https://aclanthology.org/2023.emnlp-main.814/) · [CharacterEval ACL 2024](https://aclanthology.org/2024.acl-long.638/) · [CharacterBench AAAI 2025](https://ojs.aaai.org/index.php/AAAI/article/view/34806) · [PersonaGym 2407.18416](https://arxiv.org/abs/2407.18416) · [InCharacter ACL 2024](https://aclanthology.org/2024.acl-long.102/) · [Ditto ACL 2024](https://aclanthology.org/2024.acl-long.423/) · [CoSER ICML 2025](https://proceedings.mlr.press/v267/wang25dk.html) · [ECHO 2404.13957](https://arxiv.org/abs/2404.13957) · [TimeChara ACL Findings 2024](https://aclanthology.org/2024.findings-acl.197/) · [ArcANE 2606.05553](https://arxiv.org/abs/2606.05553) · [Anonymous benchmarking 2603.03915](https://arxiv.org/pdf/2603.03915) · [Profile axes 2601.04716](https://arxiv.org/pdf/2601.04716) · [RPLA survey 2404.18231](https://arxiv.org/abs/2404.18231) · [PersonaLLM 2305.02547](https://arxiv.org/html/2305.02547v5) · [Psychometric critique 2405.07248](https://arxiv.org/pdf/2405.07248)

Drift & adversarial: [Persona drift 2402.10962](https://arxiv.org/abs/2402.10962) · [Lost in multi-turn 2505.06120](https://arxiv.org/abs/2505.06120) · [Doppelganger 2506.14539](https://arxiv.org/pdf/2506.14539) · [RoleBreak 2409.16727](https://arxiv.org/pdf/2409.16727) · [Persona-invariant alignment 2605.01899](https://arxiv.org/pdf/2605.01899)

Judging & statistics: [MT-Bench / LLM-as-judge 2306.05685](https://arxiv.org/abs/2306.05685) · [Rating Roulette 2510.27106](https://arxiv.org/pdf/2510.27106) · [Curse of Knowledge 2509.03419](https://arxiv.org/pdf/2509.03419) · [Scoring bias 2506.22316](https://arxiv.org/html/2506.22316v1) · [LLM-as-a-jury comparative 2602.16610](https://arxiv.org/html/2602.16610v2) · [Pairwise reveals rankings 2606.09409](https://arxiv.org/html/2606.09409v1) · [Benchmark uncertainty 2410.03492](https://arxiv.org/html/2410.03492v2) · [Sampling instability 2512.12066](https://arxiv.org/html/2512.12066v1) · [Krippendorff reliability](http://faculty.washington.edu/jwilker/559/Krippendorf.pdf) · [Dialogue NLI ACL 2019](https://aclanthology.org/P19-1363.pdf) · [Generative Agents UIST 2023](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)

Vendor / platform: [Claude's Character](https://www.anthropic.com/research/claude-character) · [OpenAI Model Spec](https://model-spec.openai.com/2026-08-18.html) · [Inworld Studio docs](https://docs.inworld.ai/docs/tutorial-basics/) · [Inworld Core Description](https://docs.inworld.ai/docs/tutorial-basics/core-description/) · [Inworld Goals](https://docs.inworld.ai/docs/tutorial-basics/goals/) · [Inworld CAM benchmark](https://inworld.ai/blog/developing-llm-benchmarks-for-conversational-realism-in-lifelike-ai-agents) · [Convai core APIs](https://convai.com/blog/master-character-creation-core-apis) · [Convai Knowledge Bank](https://convai.com/blog/building-ai-characters-knowledge-bank-with-convai) · [NVIDIA ACE](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-for-games-generative-ai-npcs/)

### Confidence notes
- ArcANE, PersonaArena, the profile-axes study and the anonymous-benchmarking paper are 2026 preprints read via abstract/landing pages; several full-PDF fetches returned low-detail summaries. Their headline claims are quoted from the abstracts and should be re-read in full before anything load-bearing is built on them.
- Rating Roulette's specific inconsistency numbers could not be extracted; it is cited only for the existence of judge self-inconsistency, which is independently supported by 2512.12066.
- Model-era caveat throughout: results on 2023-era 7–13B models (RoleLLM, Character-LLM, the LLaMA2-70B drift result) should be assumed not to transfer to 2026 frontier models without re-measurement. The 2026 papers (2601.04716, 2603.03915, 2606.05553) are the ones to weight.
