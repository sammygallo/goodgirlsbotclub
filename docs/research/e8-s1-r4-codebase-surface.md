# R4 — Character-attributable prompt surface & pinnable switches (Explore agent, 2026-09-03; saved by the PM verbatim — the agent runs read-only)

## 1. SOLO builder — `src/stores/chatStore.ts`
`buildConversationContext` is now only a thin wrapper (`prepareConversationContext` + one committing `finishConversationContext`); production uses the pair directly. All card reads go through `getCharacterField(character, field)` and every one is wrapped in `sub()` = `processMacros(text, macroCtx)`.

| Card field | Section id | Where | Gate |
|---|---|---|---|
| description, personality | char_info_block | Stage A | always |
| scenario, mes_example | char_info_block | Stage A | dropped when pureChatMode |
| system_prompt | main_prompt | Stage A | genState.prompt.respectCharacterOverride; loses to linkedStyleActive && userMainPrompt |
| post_history_instructions | char_phi | Stage C | respectCharacterPHI && !linkedStyleActive && !pureChatMode; when suppressed the slot carries a canned style note — char_phi is never empty in those modes |
| data.extensions.depth_prompt | not a section id — Stage-B insertion {cls:'characters_note'} | interleaved in history | getDepthPrompt: default depth 4, role system |
| embedded character_book | wi_before_char / wi_after_char / wi_before_an / wi_after_an + Stage-B wi_at_depth | both | via useCharacterStore.getActiveBookIdsForCharacter(avatar) → resolveEffectiveBooks |
| first_mes / alternate_greetings | none | — | greeting reaches the model only as ordinary history |

Character-conditional but not card-derived: emotion_instruction (character.name + availableEmotions) and selfie_instruction (selfieEligibleForCurrentChat()). Persona sections come from personaStore.
Section ids/defaults: PromptSectionId, DEFAULT_PROMPT_ORDER, POST_HISTORY_SECTIONS (char_phi, user_phi, wi_after_an, ext_after_an), PROMPT_SECTION_LABELS — src/stores/generationStore.ts. Stage A joins enabled sections with '\n\n' into ONE system message; Stage C emits one system message per section.

## 2. GROUP builder — `buildGroupConversationContext`
One flat template, no promptOrder. swap (default): description + personality per member. join: description + personality + scenario + examples per member, `## [SPEAKING NOW] Name` header. Dropped vs solo: card system_prompt, card PHI, depth_prompt/Character's Note, persona description block, jailbreak, selfie instruction, promptOrder, the token-aware trim. Emotion instruction hardcoded with a fixed list. Macros: yes since E9-S6 (subSpeaker / subMember / char-scrubbed inline context). Group slot ids: GroupSlotId in src/utils/promptBreakdown.ts.

## 3. Macro substitution & the measurement seam
processMacros(text, ctx) in src/utils/macros.ts; context from buildMacroContext (chatStore). Substitution happens strictly BEFORE measurement — every addSlice in finishConversationContext measures the post-macro string. Re-rendering to measure is forbidden ({{setvar}} double-execution).
Seam: createPromptBreakdown / beginBreakdownPass / addSlice / recordCallSiteTurn / recordAttachments in src/utils/promptBreakdown.ts; view model computeBreakdownView + SECTION_BUCKET / GROUP_SLOT_BUCKET / STAGE_B_BUCKET in src/utils/breakdownBuckets.ts. Published via useGenerationStore.setLastPromptBreakdown.
Bucketing is by emitted slot: char_info_block is the only thing in bucket `character`; card system_prompt → main_prompt → bucket `instructions`; card PHI → char_phi → `instructions`; Character's Note → Stage-B characters_note → `summary_notes`. A naive Character-bucket comparison misses three surfaces. Sum the slices by id: char_info_block + main_prompt (when respectCharacterOverride and the card supplies one) + char_phi + characters_note, plus WI slices attributable to the embedded book.

## 4. Token estimator — src/utils/tokenizer.ts
charsPerToken: gpt 4.0, claude 3.6, gemini 4.0, llama 3.5, generic 3.8. estimateTokens(text, profile) = ceil(len/cpt) + floor(whitespaceRuns*0.05) — non-additive (stageAJoinResidual exists for that). MESSAGE_OVERHEAD_TOKENS = 4; CONVERSATION_PRIMING_TOKENS = 2. profileForProvider: openai|groq|mistralai|openrouter → gpt; claude → claude; makersuite → gemini; everything else (custom, local, cohere) → generic; llama never selected. Images contribute zero: recordAttachments records count/bytes and pushes a 0-token slice.

## 5. Real provider usage — NONE available in-app
src/api/client.ts never reads usage/prompt_tokens/input_tokens; generateMessage returns a raw SSE stream; backend generation.py is a pass-through relay recording nothing. recordTurnUsage builds TokenUsage {inputTokens, outputTokens, source:'estimated'|'measured', provider, model} — always 'estimated'. useUsageStore.recordGeneration keeps scalar accumulators only (lifetime, budgetUsed, generations); no per-turn array, no per-provider split, no export.

## 6. Deterministic render-without-send — exists
Probe pass: prepareConversationContext(...) then finishConversationContext(prepared, undefined, {commit:false}) — pure; prepare is the side-effecting half and must run exactly once ({{random}}, WI activations, {{setvar}}).
Golden harness: src/stores/promptGoldens.test.ts + promptGoldens.fixtures.ts (resetStores, SOLO_FIXTURES/GroupFixture, SoloInput/GroupInput) render full prompts from fixed store state through the exported buildConversationContext / buildGroupConversationContext to src/stores/__goldens__/*.prompt.txt (+ .variables.txt, .fired.txt). src/stores/chatStore.breakdown.test.ts runs the same fixtures with a PromptBreakdown attached. This is the E8-S2 rig: add a character fixture, call the builder, read computeBreakdownView(breakdown).

## 7. Switches to pin
| Switch | Symbol | Pin |
|---|---|---|
| Instruct mode | maybeApplyInstructMode, instruct.enabled, instruct.completionMode (DEFAULT_INSTRUCT_CONFIG) | enabled:false, completionMode:'chat' |
| Generate interceptors | runGenerateInterceptors | none installed |
| Linked style | usePromptTemplateStore.mainPromptSnapshot | null |
| Pure chat | chatCompanionModeByChatFile[chatFile] | false |
| Card overrides | respectCharacterOverride, respectCharacterPHI (DEFAULT_PROMPT_CONFIG) | true both |
| Section order | promptOrder | DEFAULT_PROMPT_ORDER |
| Persona | persona.descriptionPosition/Depth/Role | none active (fixtures: personas: []) |
| Summary | useSummarizeStore.compactWhenSummarized (default true), MIN_RAW_TAIL = 6 | no summary |
| Chat recall | useChatHistoryRagStore.enabled → resolveRagContext | false |
| World Info OFF | activeBookIds: [] PLUS the character's owned books (getActiveBookIdsForCharacter unions the embedded character_book regardless of activeBookIds), persona.linkedBookIds, linkedBookIdsByAvatar, chatLoreConfigStore overlays | fixture character with no embedded book, empty books, activeBookIds: [], no persona |
| Client vs server scan | isChatEligibleForServerRetrieval (src/utils/serverRetrieval.ts), 8 conditions; group never uses server retrieval | call the builder directly (tests do) |
| Scan depth | worldInfoStore.scanDepth (DEFAULT_SCAN_DEPTH = 4); fixtures pin scanDepth 4, maxRecursionSteps 2, tokenBudget 0 | same |
| Sampling | DEFAULT_SAMPLER (temp 0.9, maxTokens 2048, topP 1.0). NO seed field anywhere — determinism must come from N-sample repetition | — |
| History trim | trimHistoryToBudget(...); DEFAULT_CONTEXT_CONFIG {maxTokens 8192, responseReserve 2048, tokenAware true, messageCount 20} | maxTokens large enough that nothing trims |
| Group window | GROUP_HISTORY_WINDOW = 30 / groupHistoryWindow (src/utils/groupHistoryWindow.ts) | fixed |
Also pin useSettingsStore.activeProvider — sole input to profileForProvider; the breakdown stamps PromptBreakdown.profile.

## 8. Character interview wizard
src/utils/characterInterview/types.ts: TopicId = concept, identity, appearance, personality, voice, scenario, relationship, greeting, examples, world, tags. FieldPatch allowlist = name, description, personality, first_mes, scenario, mes_example, alternate_greetings, tags, creator_notes, lore (applyPatch in patch.ts). Card fields + staged lore only — no structured behavioral fields today.
Only typed behavioral home: src/types/storyBible.ts — Personality { traits: CharacterTrait[]; voice_profile?: VoiceProfile; motivations: string[]; fears: string[]; values: string[] }, CharacterArc, BibleCharacter — story-ingest/story-render pipeline, not read by buildConversationContext.

## 9. Backend
app/models/character.py: Character.data JSONB holds the whole card; typed columns are mirrors/metadata (avatar, name, fav, tags, visibility, server_ts, avatar_provenance, avatar_cleared_sha256, embedding cache). app/routers/_activation.py: DEFAULT_SCAN_DEPTH = 4; _CHARS_PER_TOKEN_GENERIC = 3.8, estimate_tokens() a port of tokenizer.ts generic — always generic.

## Two things that bite the measurement
1. char_phi is not empty when the card PHI is suppressed (pureChatMode / linkedStyleActive → app-authored style note).
2. Card-attributable tokens are spread across four buckets — sum the slices by id, not the buckets.
