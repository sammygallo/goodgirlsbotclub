# Settings cascade semantics — global → character → chat

**Status:** DRAFT for red-team (E3-S1) · **Date:** 2026-09-25
**Scope note:** §6.4 persistence + migration is an OPEN design — see that section; everything else is the spec.
**Base:** frontend `1e6a555f` (origin/main) · ggbc-backend `fb26a80` (origin/main). Line numbers cite these two commits; every `:line` below was read with `grep -n`/`sed -n` on 2026-09-25. Symbol names are the stable reference; lines are given only where a symbol is ambiguous.
**Story:** E3-S1 (`docs/product-roadmap-10.2-12.md`, E3 epic). Consumers: E3-S2/S3/S4 implement this; E7-S2 builds wizard pages on its rails; E4-S2 reads two values from it.

**Summary.** Today there is no precedence rule. Two settings (sampler, main prompt) already cascade chat > character > global, but by a React effect that *overwrites the global store* while a chat is open — and the template half persists that overwrite to the server. A third cascade (persona locks) is wired in the store and reachable from nowhere. Everything else is global-only, and roughly half of it is silently ignored in group chats, dropped by a provider translator, or replaced by a fixed server constant on some turns of the same chat. This doc specifies one rule (§2), one resolver (§6), the levels each setting may be customized at (§3), what the UI must say when the resolved value is not the value that ran (§2.3, §7), and the migration from the two existing mechanisms. Lore-book composition stays its own path (§4). Worlds are not settings containers in v1 (§5). Persona is not a level (§2.1).

---

## 0 · Vocabulary (a decision)

The app already uses **"override"** for two other things: the Generation page's **"Prompt Overrides"** section (`GenerationSettingsPage.tsx:347` — the user's text replacing a built-in default) and the card field **"System Prompt Override"** (`AdvancedCardFields.tsx:151`, an ST field name). The roadmap uses "override" for the cascade. Three meanings in one word is what E3 is meant to end.

**Decision:** in user-facing copy and in code, a lower-level value is a **customization**; a level is **customized** or **inherits**. This reuses the word the per-chat lore panel already ships (`LoreEntryRow.tsx` chip `Customized`; `ChatLorePanel.tsx` "Reset all customizations"), so no new vocabulary is introduced. Roadmap card titles ("Character Overrides page") are not user-facing and need no rename. The card field keeps its ST name. The Generation page section is relabeled **"Prompts"** in E3-S2 (one string). *Alternative:* keep "override" and rename the two colliding labels instead — same cost, but it leaves "override" meaning both "beats a built-in default" and "beats a higher level" in the roadmap and the audit.

| Term | Meaning |
|---|---|
| **Level** | A place a value can be set: **Global** (per user), **Character** (per character avatar), **Chat** (per chat row). Ordered Global < Character < Chat; lower in the list is more specific and wins. |
| **Base** | For a field at a level, the value the level above resolves to. The chat level's base is the character level's effective value; the character level's base is the global value. |
| **Customization** | An explicit value stored at the Character or Chat level for one field. Absence means *inherit*. |
| **Effective value** | The value the resolver returns for a field in a given (character, chat) context: the most specific customization, else the global value. |
| **Applied this turn** | Whether the effective value was actually used by the turn that ran. A resolved value can be *not applied* for two reasons: it was **inert** or **server-fixed**. |
| **Inert** | The effective value exists but the code path that served this turn never reads it (group builder), drops it (provider translator), or only reads it on some actions (fallback provider on `send` only). |
| **Server-fixed** | On a server-retrieval turn the backend substitutes a constant for the resolved value (scan depth 4, recursion none, generic tokenizer profile). |
| **Source** | Which level (or card field) produced the effective value. Shown in the UI as provenance. |
| **Fill-in source** | A named bundle the user can copy *into* a level: generation preset, prompt template, connection profile. Not a level (§3.1). |

---

## 1 · As-is: how precedence works today

### 1.1 The link-overwrite mechanism

`ChatView.tsx` runs two `useEffect`s on `[selectedCharacter?.avatar, currentChatFile, chatLinked*Id]` (`:833-849` preset, `:855-871` template). Each resolves `chatLink === CHAT_STYLE_NONE ? undefined : chatLink ?? linkedByAvatar[avatar]` and then **writes the winner into the global store**:

- Preset: `generationStore.loadPresetTransient(id)` sets `sampler` and `activePresetId` in memory only (comment above it explains why persisting would clobber the user's sampler). On unmount, `restoreDefault()` reloads `defaultPresetId`'s sampler or the persisted `samplerSnapshot`.
- Template: `promptTemplateStore.loadTemplateMainPromptTransient(id)` calls `gen.setPrompt({ mainPrompt })`, and `setPrompt` calls `persist()` (`generationStore.ts:768-774`, `:429-447`), which PUTs the whole `stm_generation` section. **Opening a styled chat uploads the template text to the server as the user's global main prompt** until switch-away restores the snapshot. A second device fetching prefs in that window receives the template as its global prompt (by reading; not reproduced).

Consumers never resolve anything: `prepareConversationContext` reads `useGenerationStore.getState()` (`chatStore.ts:1305`), and `getGenerationOptions()` (`utils/llm/resolve.ts`) reads `sampler`/`instruct` at every seam. "Effective" and "global" are the same slot. Resolution happens only while `ChatView` is mounted.

Two consequences the research found by reading (not reproduced): while a linked preset is active, `setSampler` mirrors every Settings edit into *that preset* (`generationStore.ts:514-532`) — a connection-profile apply does the same (`AISettingsPage.tsx:337`, `:734`, where `loadGenerationPreset` is an alias of `setSampler`); and while a linked template is active, a main-prompt edit in Settings is undone on chat exit by the snapshot restore.

### 1.2 The 21 existing mechanisms (compact)

| # | Mechanism | Levels | Solo | Group | Server retrieval |
|---|---|---|---|---|---|
| 1 | Card `system_prompt` over global main prompt (gated by `respectCharacterOverride`) | C | yes | **no** | n/a |
| 2 | Card `post_history_instructions` (gated by `respectCharacterPHI`; suppressed by linked style / pure chat) | C | yes | **no** | n/a |
| 3 | Card `extensions.depth_prompt` (Character's Note) | C | yes | **no** | n/a |
| 4 | Card `extensions.talkativeness` + group `talkativenessOverrides` | C, Grp | n/a | speaker choice only | n/a |
| 5 | Linked **preset** Ch > C > G, `CHAT_STYLE_NONE` = force G | C, Ch | yes | sampler yes; character link **not applied** (`selectedCharacter` is null in group, `characterStore.ts:660`, `:698`) | n/a |
| 6 | Linked **template** Ch > C > G (main prompt only) | C, Ch | yes; beats card `system_prompt`, suppresses card PHI | **no** | n/a |
| 7 | Pure-chat mode | Ch | yes | **no** | n/a |
| 8 | Author's Note | Ch | yes | yes (depth 0 dropped, #466) | n/a |
| 9 | Chat variables | Ch | yes | yes | n/a |
| 10 | Persona locks: chat lock > character lock > active | C, Ch | character yes / chat **never passed** | same | character only |
| 11 | Persona-linked books | P | yes | speaker's persona only | **no → chat ineligible** |
| 12 | Character-linked books | C | yes | all members | **no → ineligible** |
| 13 | Character-owned books | C | yes | all members | yes |
| 14 | Per-chat lore config (linked / excluded / overlays / local) | Ch | yes | yes | **no → ineligible while non-vacuous** |
| 15 | Per-entry `scanDepth` (null = inherit) | B | yes | yes | yes |
| 16 | Overlay patch of an entry | Ch×B | yes | yes | **no → ineligible** |
| 17 | Group `scenarioOverride` over card scenario | Grp | n/a | yes | n/a |
| 18 | Group `cardMode` | Grp | n/a | yes | n/a |
| 19 | Lovense character profile over default (whole object) | C | yes | no | n/a |
| 20 | Regex script `characterScope` | C | yes | scope ignored (no avatar passed) | n/a |
| 21 | Engine selection: server result **replaces** the client scan (`chatStore.ts:1377`, `serverMatchedEntries ?? scanMessagesForEntries(...)`) | per turn | send / impersonate / edit-regenerate only | never | — |

Levels: G global · C character · Ch chat · Grp group record · P persona · B entry. Full inventory with code locations: Appendix A.

### 1.3 Three things the research found that the cards did not say

- **The persona cascade is dormant.** `getPersonaForContext(characterAvatar?, chatFileName?)` implements chat lock > character lock > active (`personaStore.ts:248-263`), both lock maps are persisted in `stm_personas`, and `lockPersonaToCharacter` / `lockPersonaToChat` / `unlockCharacter` / `unlockChat` exist — with **zero callers outside `personaStore.ts`** (grep of `src/`, 2026-09-25; the API landed store-only in `ea8e3d6d`, 2026-04-04). Every prompt-path caller passes only the avatar (`chatStore.ts:100`, `:1300`, `:2421`; `serverRetrieval.ts:112`); only `ingestSources.ts:92` and `StoryTab.tsx:730` pass the chat file.
- **The group builder reads nothing from `generationStore`.** `buildGroupConversationContext` (`chatStore.ts:2382-3304`) contains no read of `genState`, `promptOrder`, `context.*`, `prompt.*`, `chatCompanionModeByChatFile`, `depth_prompt` or `runContextHooks` — the only mentions are comments saying so (`:2859`, `:2897`, `:3184`, `:3194`) and `breakdownOut.responseReserve = null` (`:3300`). Its history is `groupHistoryWindow(messages)` (`:3017`), a fixed `GROUP_HISTORY_WINDOW = 30` (`utils/groupHistoryWindow.ts`). Its system prompt is a hard-coded template (`:2878-2892`).
- **The backend reads two synced sections directly.** `stm_rag_settings.enabled` gates recall and the embedding enqueue (`chats.py` `_is_rag_enabled`, called from `retrieval.py:531`, `:637`, `chats.py:305`); `stm_worldinfo.tokenBudget` drives the pinned-budget warning (`lorebooks.py` `_world_info_token_budget`, which reads a `0` as 1024 at `:179`). `stm_worldinfo.scanDepth` and `maxRecursionSteps` are stored (`snapshotForServer`, synced since `99081129`, 2026-05-20) and **never read** by the backend. `stm_generation` is stored and never read.

---

## 2 · The precedence rule

### 2.1 Levels

**Global → Character → Chat.** Three levels, one rule:

> For a field *f* with allowed levels *L(f)* ⊆ {Global, Character, Chat}: the effective value is the customization at the most specific level in *L(f)* that has one for the current (character, chat); if none, the global value. A customization is present or absent; absent means inherit. At the Chat level only, a field may also hold the marker **`global`**, meaning "skip the character level, use the global value" (the existing `CHAT_STYLE_NONE` semantics, needed for a lossless migration — §6.4).

Within the Character level, **the main prompt** has two sources: the card's `system_prompt` and a character customization. Order for `mainPrompt`: **character customization > card `system_prompt` (when `respectCharacterOverride` is on) > global** — today's order (`chatStore.ts:1558-1562`: linked style > card override > user prompt > fallback), so migration preserves behaviour. **Post-history instructions are not a chain.** The builder emits the card PHI (`char_phi`) and the user PHI (`user_phi`, the resolved `postHistoryInstructions`) as two independent sections (`:1510-1517`, `:1618-1623`); the card PHI is withheld whenever a linked style or pure-chat mode is active, and the `char_phi` slot then carries a style note instead. Under this spec `linkedStyleActive` is true whenever `mainPrompt` is customized at character or chat level, so **a main-prompt customization suppresses the card PHI and injects the style note** — today's linked-template semantics, preserved (§6.1 `cardPhiSuppressed`).

**Persona is not a level.** A persona is *who the user is*, chosen per chat; its description, position, depth and role are persona-intrinsic values, not customizations of a global default. The dormant lock cascade is persona *selection* precedence, not settings precedence. Decision: v1 does not adopt it into the rule and does not delete it (deleting `locks.byChat` changes a persisted shape — a "hard to reverse" §8 trigger — for no user-visible gain). It stays dormant and documented (§9 D6). *Alternative:* adopt "character-pinned persona" as a character-level customization in E3-S3; deferred to v2 with the wizard's persona page.

**Worlds are not a level** in v1 (§5).

### 2.2 Per-turn applicability is not a level

Two things decide what actually ran, and neither is a rung on the ladder. The resolver reports them alongside every value (§6.1).

**(a) Engine selection — per chat AND per action.** `tryServerRetrieval` is called only from `sendMessage` (`chatStore.ts:5771`), `impersonate` (`:5506`) and `editMessageAndRegenerate` (`:6219`). `swipeRight` (`:5129-5140`) and `continueMessage` (`:5341-5350`) are always client; **the Regenerate button is `regenerateMessage` → `swipeRight`** (`:5306-5312`), so it is client too; group never calls it (`serverRetrieval.ts` header comment, `:32-34`). Eligibility (`isChatEligibleForServerRetrieval`, `serverRetrieval.ts:102-161`) is recomputed on every attempt, twice (`:537`, `:556`), and any network failure falls back to the client. So on one eligible chat, a *send* scans at depth 4 with no recursion, and *Regenerate* of the same turn scans at the user's depth with recursion.

**Answer to the card's question (task 3b):** on a server-path turn the server-fixed values sit **above every level, including chat** — they replace the resolved value. But engine selection is not "above chat" in the data flow: the chat's lore config is an *input* to eligibility (a non-empty config forces the client engine). The precise statement is: **levels resolve a value; the engine, chosen per turn from chat state plus the action, decides whether that value is applied.** The resolver returns both the value and the applicability, never a merged number.

**(b) Inertness.** The effective value exists but this turn never used it. Reasons the resolver must name: `group-builder` (never read in group); `provider-dropped` (Anthropic keeps only temperature / top_k / stop and drops `top_p` whenever temperature is present, `anthropic.py:144-152`; Google keeps max / temperature / top_p / top_k / stop, `google.py:130-141`); `model-omitted` (client omits every sampler for Claude ≥ 4.7, `client.ts` `modelRejectsSamplers`, applied at `:1566-1574`); `action` (fallback provider is used only by `generateWithFallback`, called only from `send`, `:5812`); `tokenAware-off` (`responseReserve`/`maxTokens` bind only inside `if (ctxConfig.tokenAware)`, `:2100`); `text-mode-broken` (#513 / ggbc-backend#86, both OPEN: no text-mode request produces a token).

### 2.3 Task 3b decision: scan depth on server-path turns

Four options existed, not three (R2 §5.2 found the fourth):

| Option | Repos | Contract? | Carries a future chat-level value? | Self-describing per turn? |
|---|---|---|---|---|
| A. Send the resolved value in `POST /retrieval/context` (beside `budgetTokens`) | both | soft: backend first; `RetrievalContextIn` sets no `extra=` config (`schemas/retrieval.py`), so pydantic's default ignores the field until then | yes | yes (client knows what it sent) |
| B. Server reads the already-synced `stm_worldinfo.scanDepth` (precedent: `_world_info_token_budget`) | backend | none | no (a chat value is not in that section) | no (depends on sync timing; 300 ms debounce) |
| C. Mirror: UI shows 4 | frontend | none | — | lies on client-path turns |
| D. Badge "server-controlled" only | frontend | none | — | honest, changes nothing |

**Recommendation: A, with D as the v1 UI state until A ships.** Rationale: `budgetTokens` is already the precedent for "client sends the resolved value"; A makes the request pin the turn's inputs (E5-S2's replay needs that); B cannot see a chat-level value if v2 adds one and silently depends on the sync section being current. Cost: backend `RetrievalContextIn.scan_depth: int | None` (alias `scanDepth`, `ge=1, le=50` matching `setScanDepth`'s clamp), `_activation` uses it in place of `DEFAULT_SCAN_DEPTH` for the per-entry fallback (`:511`) — **lore activation only**: the recall-leg window (`retrieval.py:280`, the text `_embed_chat_tail_best_effort` embeds on server-path sends that have candidates and a non-empty tail, `:285-288`) is **not** changed by E3-S3b — and the DTO **echoes `appliedScanDepth`**, the activation depth; frontend sends `wi.scanDepth.value`, records it on `ServerActivationFacts` (`promptBreakdown.ts`), and renders "applied (server)" only when the echo is present — an older backend returns no echo, so the UI keeps saying "server uses 4". Two PRs, backend first. **This is a cross-repo contract and is a §8 escalation trigger for the implementing story** (`run-story` §8 "Cross-repo contract"); it should be its own small story (proposed E3-S3b, §9 D8), not folded into E3-S3's store refactor. *Alternative:* B — one backend PR, no contract, and the UI stays at D forever for chat-level values.

**`maxRecursionSteps` cannot be sent:** the server engine has no recursion (`_activation.py:54-58`). Its v1 state is permanently "server-fixed: none" on server-path turns. The default is 3 (`worldInfoStore.ts:264`), so **default users get recursion on Regenerate/swipe/continue and none on send** today. The UI says so (§7.5).

**Tokenizer profile** is not user-settable (the roadmap's own note under E3-S1) and stays out of the cascade; the budget preview is labelled a client-side estimate (§7.5).

---

## 3 · Setting inventory and level matrix

Columns: **v1** = customizable in v1 · **Levels** = where a customization may live (G = global only) · **Solo / Group / Server** = honoured by that path · **Honest-state rule** = what the UI must say when the effective value is not what ran. Row order follows the Generation page's tabs, then the rest.

| Group · field(s) | v1 | Levels | Solo | Group | Server-path turn | Honest-state rule / why a level is not allowed |
|---|---|---|---|---|---|---|
| **Sampler:** temperature, maxTokens, topP, topK, minP, frequency/presence/repetition penalty, stopStrings | yes | G, C, Ch (per field) | yes | yes | n/a | Badge `provider-dropped` per field for the active family (§2.2b); `model-omitted` for Claude ≥ 4.7. `maxTokens` here is the `max_tokens` sent, distinct from `context.maxTokens`. |
| **Prompts:** mainPrompt, jailbreakPrompt, postHistoryInstructions | yes | G, C, Ch | yes | **inert** (`group-builder`) | n/a | Group: badge inert. `mainPrompt`: customization > card `system_prompt` (if respected) > global. PHI: `char_phi` (card, if respected and no style active) and `user_phi` (the resolved value) are emitted independently; a `mainPrompt` customization suppresses the card PHI (§2.1). |
| **Prompts:** respectCharacterOverride, respectCharacterPHI | no | G | yes | inert | n/a | They gate a *card* source; a per-character "respect my own card" is the same as setting the customization. |
| **Prompt order** (18 sections + flags, `generationStore.ts` `PromptSectionId`) | no | G | yes | **all 18 inert** | n/a | A list, not a field; template bundles carry one but the transient link never applied it. v2 candidate. Group: badge inert on the whole editor. |
| **Context:** maxTokens, responseReserve, tokenAware, messageCount | yes | G, C, Ch | yes | **inert** (fixed 30-message window) | n/a | Group: inert. `responseReserve`/`maxTokens` also inert when `tokenAware` is off; `messageCount` inert when it is on. `getProviderAndModel`'s 32768 bump (`resolve.ts:44-46`) writes the **global** value only. |
| **Instruct:** enabled, templateId, extraStopStrings, completionMode | no | G | dispatch | dispatch | n/a | Read inside `maybeApplyInstructMode`, which runs inside the frozen `dispatchWithCapture` (E2-S3, `chatStore.ts:3617-3653`); a level here reopens six seams. Text mode is broken end-to-end (#513, be#86): badge `text-mode-broken`. |
| **showExactPrompt** | no | G | — | — | — | Debug toggle inside the frozen helper. |
| **Provider / model / custom URL** | no | G | all seams | all seams | — | Every seam calls `getProviderAndModel`, which can silently switch to Claude and write context size; credentials are per provider; #515 (seven un-routable providers). A per-character provider is v2 (§9 D5). **Connection profiles are fill-in sources, not a level** (§3.1). |
| **Fallback provider / model** | no | G | `send` only | no | — | Badge `action`: "used on Send only". |
| **WI:** scanDepth, maxRecursionSteps, tokenBudget | no | G (+ per-entry `scanDepth`) | yes | yes | **server-fixed** (4 / none / generic profile) | The two values E4-S2 displays. In v1 the cascade-resolved value **is** the global value. Server turns: `server-fixed` state (§7.5); per-entry overrides *are* honoured by both engines, so the state is scoped to the global value. `tokenBudget: 0` means unlimited in the UI (`WorldInfoPage.tsx:548`) but 1024 to the backend warning (`lorebooks.py:179`). |
| **Chat recall (RAG) enabled** | no | G | 5 solo seams + group | yes | — | The backend re-reads the **global** section (`_is_rag_enabled`); a level would be a lie on the server side. |
| **Summary:** autoSummarize, autoTriggerEvery, injectionDepth/Role, compactWhenSummarized | no | G | yes | injection inert (no context hooks); compaction inert | — | Extension-owned; out of v1. |
| **Author's Note** (content, depth, role) | — | Ch only (chat content) | yes | yes (depth 0 dropped, #466) | — | Not a cascade field: it has no global to inherit from. Displayed in the "in effect" panel; stays in its own panel. The card's Character's Note is the character-level analogue and stays a card field. |
| **Pure-chat mode** | yes | Ch only | yes | inert | — | Moves into the chat slot (§6.4) so one panel edits every chat-level value. A character-level "always pure chat" is v2. |
| **Card fields:** system_prompt, post_history_instructions, depth_prompt, talkativeness | sources | C (card) | yes | inert (except talkativeness) | — | Stay builder-side (the builder substitutes them and keeps its precedence chain); the resolver only annotates `source: 'card'` in the display view (§6.1); not duplicated into the map. |
| **Group record:** scenarioOverride, cardMode, talkativenessOverrides, strategy, mute, auto-mode | — | Grp | n/a | yes | — | Group-specific chat state edited by `GroupChatControls`; outside the cascade. |
| **Persona:** active persona, description position/depth/role, linked books | — | P | yes (`in_prompt` dropped, #476) | description → macros only | linked books → ineligible | Not a level (§2.1). |
| **Lore composition:** active books, character links, chat lore config, entry overlays | — | separate path | yes | yes | ineligibility inputs | §4. |
| **Extensions:** enabled flags, Lovense profile (C over G, whole object), regex `characterScope`, selfie enabled | — | own mechanisms | yes | mostly inert | — | **Outside the v1 inventory.** Named here so the epic's "no parallel mechanisms *within the inventory*" claim is bounded honestly. |

**Not settable today (constants the panel must not present as settings):** `stream: true` (`client.ts:1568`); group window 30; `MIN_RAW_TAIL = 6` (`chatStore.ts:1707`); recall `k = 3` (`chatStore.ts:973`); the group emotion list; server `DEFAULT_SCAN_DEPTH = 4` and `_CHARS_PER_TOKEN_GENERIC = 3.8` (`_activation.py:86`, `:91`).

### 3.1 Presets, templates and connection profiles are fill-in sources

A **generation preset** (`generationStore.presets`), a **prompt template** (`promptTemplateStore.templates`, carrying `prompt`, `context`, `instruct`, `promptOrder`, optional `sampler`) and a **connection profile** (`connectionProfileStore`, carrying provider, model, customUrl, `sampler`) are named bundles. Applying one **copies its values** into a level: into the global stores today (`loadPreset`, `applyTemplate`, the profile apply in `AISettingsPage.tsx:732-734`), and into a Character or Chat level under this spec ("Apply preset here" writes each field as a customization at that level). They are never resolved by reference at generation time. Consequence: editing a preset later does not change a level that copied from it (§9 D3 names the alternative).

---

## 4 · Lore composition: a separate path, left alone in v1

`resolveEffectiveBooks(books, activeBookIds, chatConfig)` (`utils/worldInfoComposition.ts:160`) is pure and applies **only the per-chat layer** (linked books, exclusions, overlays, local entries → synthetic `wibook_chatlocal__<file>` book). The `world ∪ character ∪ persona` union is assembled by its callers.

**Corrected count.** `resolveEffectiveBooks` has **five** production call sites (`chatStore.ts:1356` solo, `:2500` group, `utils/chatLoreView.ts:159`, `components/chat/lore/ChatLorePanel.tsx:337`, `components/works/ingestSources.ts:103`). The union is assembled at **four** of them (`chatStore.ts:1342-1352`, `:2485-2496`, `ChatLorePanel.tsx:199-232`, `ingestSources.ts:93-99`); `chatLoreView.ts` receives the panel's union and is a consumer. The epic's "duplicated across five" counts the consumer. The four assemblers differ: group uses only the speaker's persona; the panel unions every member's persona; `ingestSources` passes the chat file to `getPersonaForContext` (honouring a chat lock nothing writes); the builders and eligibility do not.

**Decision: v1 does not absorb lore composition into the settings cascade.** The cascade only **displays** the two values E4-S2 needs (WI budget, scan depth) with their applicability; lore scope stays book composition (audit §6.3; E4-S2's badges read `resolveEffectiveBooks()` truth). The four assemblers and the persona-arity drift are recorded as out-of-scope debt (§9, risks). Absorbing them would mean owning four call sites plus the engine-switch disclosure inside a story sized for generation settings.

**E3-S4 scoping: chat-level customization covers generation settings only** (sampler, prompts, context, pure-chat). Lore stays in `ChatLorePanel`, which is already a shipped per-chat lore customization UI (`src/components/chat/lore/ChatLorePanel.tsx` — the brief's `src/components/chat/ChatLorePanel.tsx` does not exist). The panel gains the engine-switch disclosure (E3-S4 acceptance). The facts it must state, corrected against the E3-S4 card:

- A non-empty chat lore config makes the chat ineligible for server retrieval **while it is non-empty** (`serverRetrieval.ts:119-128`). Not "permanently": eligibility is recomputed per call, and `mutateConfig` deletes a config that becomes vacuous (`chatLoreConfigStore.ts:215-226`). Clearing every customization *and* every linked book restores eligibility.
- The panel's **"Reset all customizations" keeps linked books** (`resetCustomizations`, `chatLoreConfigStore.ts:576-583`), so a chat with a linked book stays ineligible after reset. The disclosure must say what remains.
- On the **client** engine, keyless / `semanticOnly` entries — every Data Bank chunk — **cannot fire** (`entryMatchCount` returns 0 for empty keys, `worldInfoStore.ts:1171-1173`; #450 OPEN). On the client engine the user's scan depth and recursion **apply** (`chatStore.ts:1382-1383`). The E3-S4 card attributes "a fixed scan depth of 4 vs the user's setting" to the client engine; that is the server's property (`_activation.py:86`), inverted.
- The card's "timer/sticky defects of #452": #452 is **CLOSED** (E4-S0); drop that clause.
- Disclosure placement: in the panel header, computed from `isChatEligibleForServerRetrieval` (prospective, per chat) with the reason; the last turn's engine comes from `PromptBreakdown.wi.activationSource` (E2-S2). Wording in §7.6. Today no UI component calls `isChatEligibleForServerRetrieval` (callers: `dataBankStore.ts`, `serverRetrieval.ts`, tests).

---

## 5 · Worlds as first-class settings containers

**Recommendation: not in v1.** The trade:

- *Power:* a world (a `scope: 'world'` book, or a future container) carrying its own sampler/prompt defaults lets a whole setting — a campaign, a shared universe — ship its tone. It is the natural home for "this universe is always dark and terse".
- *Complexity:* it inserts a fourth level whose *membership* is not a fact about the chat. A chat's world is today `activeBookIds ∩ world books` — a set, toggled globally, that can be empty or plural. A level needs exactly one owner per chat or an explicit tie-break, and world books are also eligibility inputs (an inactive world book forces the client engine, `serverRetrieval.ts:142-143`). Two chats with the same character and different active worlds would resolve different samplers with nothing in the chat row explaining why.
- *Cost of deferring:* none for E7-S2 or E4-S2. A v2 needs: a per-chat "world" selection stored in the chat slot (a single id), a world-settings slot on the book or a new container, the level inserted between Global and Character (a character is more specific than the setting it lives in), and the "in effect" panel showing four rows.

*Alternative:* let a world book carry `settings` as fill-in defaults the chat panel can "apply from world" — no level, no ambiguity, most of the power. Recommend that as the v2 shape.

---

## 6 · `resolveEffectiveSettings()` seam and the store-refactor plan

This section is the design-level statement of the seam. The file-level plan — modules and exports, per-store symbol changes, the per-seam change table and the PR split — is `docs/research/e3-s1-refactor-plan.md`, task 2's file-level deliverable; where the two differ this section wins. **§6.4 (persistence slots and migration) is an OPEN design after two red-team rounds** — it pins constraints and candidates, not a design, and E3-S3 task 1's PLAN decides it with Sammy. §6.1–§6.3 and §6.5–§6.7 are the spec, with the persistence-dependent sentences pointed at §6.4.

### 6.1 Signature and return shape

```ts
// src/utils/settingsCascade.ts (new)
interface ResolveContext {
  characterAvatar?: string;        // solo: the character; group: the speaking member (v1 ignores it for customizations, §6.3)
  chatFile?: string | null;
  chatKind: 'solo' | 'group';
  seam: PromptCaptureSeam | 'preview';   // 'send'|'swipe'|'continue'|'impersonate'|'regenerate'|'group' (utils/promptCapture.ts)
  provider: string; model: string;       // from useSettingsStore.getState() — the read prepare already makes (chatStore.ts:1306); never getProviderAndModel()
  character?: CharacterInfo;             // only for the 'card' annotation in the display view
}
type Level = 'global' | 'character' | 'chat';
type Source = Level | 'card';            // 'card' appears ONLY in the annotated view, never in `plain`
const GLOBAL_MARKER = '__global__';      // the chat-level "skip character" marker (§2.1); resolves with source 'global'
type Applicability =
  | { kind: 'applies' }
  | { kind: 'inert'; reason: 'group-builder' | 'provider-dropped' | 'model-omitted' | 'action' | 'tokenAware-off' | 'text-mode-broken' }
  | { kind: 'server-fixed'; serverValue: number | 'none'; when: 'predicted' };  // only meaningful for wi.* on eligible solo chats
interface Resolved<T> { value: T; source: Source; applicability: Applicability }
interface EffectiveSettings {
  sampler:  { [K in keyof SamplerParams]: Resolved<SamplerParams[K]> };
  prompt:   { mainPrompt: Resolved<string>; jailbreakPrompt: Resolved<string>; postHistoryInstructions: Resolved<string>;
              cardPhiSuppressed: boolean };   // true when mainPrompt is customized at character/chat level, or pureChat (§2.1)
  context:  { [K in keyof ContextConfig]: Resolved<ContextConfig[K]> };
  pureChat: Resolved<boolean>;
  wi:       { scanDepth: Resolved<number>; maxRecursionSteps: Resolved<number>; tokenBudget: Resolved<number> };  // source is always 'global' in v1
  engine:   { predicted: 'server' | 'client' | 'n/a'; reasons: string[] };   // from isChatEligibleForServerRetrieval + seam; 'n/a' for group
  // Level-resolved projections for the builders — identity-by-reference when nothing is customized (§6.6):
  plain: { sampler: SamplerParams; prompt: PromptConfig; context: ContextConfig; instruct: InstructConfig };
  meta:  { characterLevel: 'hydrated' | 'pending'; chatLevel: 'hydrated' | 'pending' | 'none' };   // what 'pending' means is decided with §6.4 (constraint 10)
}
export function resolveFromInputs(inputs: CascadeInputs): EffectiveSettings;      // pure: no store access; the precedence tests run here
export function resolveEffectiveSettings(ctx: ResolveContext): EffectiveSettings; // reads store snapshots once, delegates to resolveFromInputs
```

Rules the implementation keeps:

- **`plain.prompt.*` is the level-resolved customization only. Card fields never enter `plain`.** The builder keeps substituting `system_prompt` / `post_history_instructions` itself and keeps its main-prompt precedence chain (`chatStore.ts:1558-1562`) with `userMainPrompt = sub(eff.plain.prompt.mainPrompt)`. Folding card text into `plain` would double-apply in that chain and break the goldens' macro counters, which pin that `charSysPrompt` runs exactly once even when the card loses and that `charPhiSub` is absent when suppressed (`promptGoldens.fixtures.ts:1042-1045`, `:1184-1190`).
- **The `'card'` annotation is for `mainPrompt` only:** `source: 'card'` when `respectCharacterOverride` is on, the card `system_prompt` is non-empty and no customization exists (computed from `ctx.character`). **PHI is not a chain** (§2.1): `postHistoryInstructions.source` is the level of the user value, and `prompt.cardPhiSuppressed` is true exactly when the builder withholds the card PHI — mainPrompt customized at character or chat level, or `pureChat` — so the panel can say so (§7.10 `phi.cardSuppressed`).
- **The chat-level `global` marker resolves with `source: 'global'`**, so `linkedStyleActive` is false for a chat that skipped the character's template — today's behaviour: `CHAT_STYLE_NONE` maps to `restoreDefaultMainPrompt` in the `ChatView` effect (`ChatView.tsx:855-866`), so `mainPromptSnapshot` stays null.
- **`provider` / `model` come from `useSettingsStore.getState()`, never from `getProviderAndModel()`.** That function has side effects (`useSettingsStore.setState` and a `setContext({ maxTokens: 32768 })` bump, `utils/llm/resolve.ts:36`, `:43-46`) and four seams call it **after** the build (`chatStore.ts:5175`, `:5371`, `:5542`, `:6238`); hoisting it would move those writes ahead of `prepare`'s reads. Every existing `getProviderAndModel()` call stays where it is.
- **Identity:** with no customization touching a group, `plain.sampler` **is** the store's `sampler` object (same for `prompt`, `context`; `instruct` always).
- `plain.prompt.respectCharacterOverride` / `respectCharacterPHI` are always the global values (§3).
- G-only fields with no slot in the type (`promptOrder`, `showExactPrompt`, provider/model, the WI, RAG and summary toggles): **E3-S2 reads them from their stores directly.** The resolver carries no display bag for them.
- **Hydration and the pre-migration read path are persistence-design-dependent.** What `meta.*: 'pending'` means, whether an empty local mirror counts as hydrated, and what the resolver reads before a migration marker exists are decided with §6.4's open design, against its constraints 6, 8 and 10. A pending level resolves as global, is badged as pending, and **never persists anything** — that part is decided.

### 6.2 Where it is called — once per turn

Each of the six seam functions resolves **once**, before anything reads settings, and threads the snapshot:

| Seam function | Today reads | Under this spec |
|---|---|---|
| `sendMessage`, `impersonate`, `editMessageAndRegenerate`, `swipeRight`, `continueMessage` | `prepareConversationContext` reads `useGenerationStore.getState()` (`:1305`) and `wiState.scanDepth/maxRecursionSteps/tokenBudget` (`:1382-1384`); `finishConversationContext` reads `genState.context` (`:2037`); `getGenerationOptions()` reads `sampler`/`instruct`; `tryServerRetrieval` reads `tokenBudget` (`serverRetrieval.ts:558`) | `const eff = resolveEffectiveSettings(ctx)` at the top; `prepareConversationContext(..., eff)` (trailing optional parameter) stores it on `PreparedConversation` beside `genState` (`chatStore.ts:1194`), so both `finishConversationContext` passes (probe `commit:false` + commit) read `prepared.eff` and `finish`'s signature is untouched; `getGenerationOptions(eff.plain)`; `tryServerRetrieval(avatar, file, eff.wi.tokenBudget.value)` (and `eff.wi.scanDepth.value` once §2.3-A ships) |
| `generateGroupTurn` | `buildGroupConversationContext` reads `wiState.*` (`:2518-2520`); `getGenerationOptions()` (`:3397`) | same shape; `chatKind: 'group'`; the builder takes a trailing optional `eff` after `breakdownOut` — its only cascade reads are the three `wiState.*` lines |

When the trailing parameter is absent the builder resolves internally with `seam: 'preview'`. That is what keeps the goldens harness green: it calls the exported wrappers `buildConversationContext` and `buildGroupConversationContext` directly (`promptGoldens.test.ts:125-126`), and the solo wrapper stays E8-S4's byte-equivalence seam (`chatStore.ts:1238-1244`).

**Snapshot rule.** Resolve exactly once per seam invocation. Reuse across the two `finish` passes is required; reuse across turns (a module cache, or `regenerateMessage → swipeRight` sharing one) is the bug. A group round resolves once per `generateGroupTurn`, so a chat edit made mid-round applies to later speakers of that round.

`maybeApplyInstructMode` and `dispatchWithCapture` are **untouched** (E2-S3 seams stay closed). `getGenerationOptions` lives in `utils/llm/resolve.ts`, outside the frozen helper, and takes the snapshot as an argument; its only callers are the six seams (grep of `src/`, 2026-09-25), so the no-argument form goes away.

`PromptBreakdown` fields that E2-S4's `insightsApi.ts` consumes (`wi.budget`, `wi.activationSource`, `wi.server.*`, `flags.*`) keep their meaning: `wi.budget` stays "the value the scan used", which is why the resolver must *feed* the builder rather than run beside it. New fields are additive: `wi.scanDepth` (client turns), `ServerActivationFacts.scanDepthRequested` and, after §2.3-A, `appliedScanDepth`.

### 6.3 What replaces the `ChatView` overwrite effects

- Both effects (`ChatView.tsx:833-871`) are deleted, together with the selectors that exist only to re-trigger them (`:317-321`). `loadPresetTransient`, `restoreDefault`, `loadTemplateMainPromptTransient`, `restoreDefaultMainPrompt` have no callers outside those effects and their own stores (grep of `src/` excluding tests, 2026-09-25) and are removed. So is the **`mainPromptSnapshot !== null` branch of `ensureTemplate`** (`promptTemplateStore.ts:417-419`), a third in-store reader that pushes a re-ensured quick-style template's text into the global prompt. `samplerSnapshot` and `mainPromptSnapshot` stay as legacy persisted keys until a follow-up removal story (`stm_generation`'s key set is pinned by `generationStore.promptCapture.test.ts:186-210`); how they are healed is §6.4 constraint 7.
- **The builder's two legacy-field reads move to the resolver.** `linkedStyleActive = mainPromptSnapshot !== null` (`chatStore.ts:1497-1498`) — which makes a linked style beat the card's `system_prompt` and withhold the card PHI in favour of the style note (`:1511`, `:1558-1560`, `:1618-1623`) — becomes `eff.prompt.mainPrompt.source === 'character' || eff.prompt.mainPrompt.source === 'chat'`; `pureChatMode` (`:1503-1505`, from `chatCompanionModeByChatFile`) becomes `eff.pureChat.value`. With the chat `global` marker resolving `source: 'global'` (§6.1), the truth table is today's. **Which PR performs the swap is provisional (§6.7):** the swap is not byte-neutral while any transitional read of the legacy maps is live (§6.4 constraint 8).
- **Task 1 re-points every live reader and writer of the legacy keys**, so no story window leaves a UI writing to a map the resolver has stopped reading: `ChatStyleModal` (reads `:28-29`, `:32`, `:37`, `:39`; writes `:58-63`, `:149`, `:173`, `:199`) reads the chat level and writes `setChatCustomization` — preset/template values copied, "None" → markers; `ChatView`'s `chatStyleActive` (`:2223`) reads the chat level; `CharacterEdit`'s Unlink chips (`:103-112`, `:570`, `:599`) read the character level and call `clear`. Whether a pick made before migration applies to turns, and what a later migration does with it, is §6.4 constraint 6.
- `setSampler`'s mirroring into `activePresetId` **stays**; the hazard §1.1 describes disappears once no transient load sets `activePresetId` to a linked preset **and** the persisted `activePresetId` states that §6.4 constraint 7 names (a linked id with no default; a linked id when a default exists) have been healed. Generation-page behaviour for a user with no customizations is unchanged. `savePresetAndLink` loses its only caller with the wizard rewrite (§6.4), and its `activePresetId` write goes with it. `loadPreset` keeps setting `activePresetId`/`defaultPresetId`; `defaultPresetId` is no longer read at resolution.
- **Group:** v1 resolves Global + Chat only in group (`characterAvatar` ignored for customizations; card sources are not read in group today either). Character links do not apply in group today (`selectedCharacter` null), so this is behaviour-preserving. Per-speaker character customization is v2 (§9 D4).
- The golden fixtures that simulate a linked style / pure chat by setting `mainPromptSnapshot` / `chatCompanionModeByChatFile` directly (`promptGoldens.fixtures.ts:1232`, `:1193`) are re-expressed as chat-level customizations in the PR that performs the swap, with the same expected output; until then they run un-rewritten.

### 6.4 Persistence slots and migration — OPEN DESIGN (not converged; decided at E3-S3 task 1's PLAN)

Two red-team rounds converged everything in §6 except this subsection: where character- and chat-level customizations persist, how the existing links migrate, and how the legacy snapshot fields are healed. Round 2 falsified round 1's design on the points the constraints below carry. Rather than a third design under review, this subsection pins **what any design must satisfy** and names the candidates; E3-S3 task 1's PLAN decides it with Sammy (§9 D1, D7). Nothing below is a design claim.

**Decided and unchanged by this subsection:** the customization shape (per field, `Partial<CustomizationFields>` per level, the chat-level `global` marker resolving `source: 'global'`, §2.1 / §6.1); presets, templates and connection profiles as fill-in sources (§3.1); the wizard writing through the character rails whatever the slot (§6.5, §8.1). Card fields (`system_prompt`, `post_history_instructions`, `extensions.depth_prompt`, `extensions.talkativeness`) stay on the card, are consumed by the builder (not the resolver, §6.1) and round-trip as today: `CharacterEdit.tsx:263` passes `extensions` through; `buildCardData` (`client.ts:302-348`) spreads unknown extension keys and recomputes only `depth_prompt`/`talkativeness`; `characterToCardV2` spreads `data.extensions`; V2/V3 import spreads them back (`cardToCharacterInfo`), while **`cardToCharacterInfo`'s V1 / simple-JSON branch rebuilds `extensions` from only `depth_prompt` and `talkativeness`** (`characterCard.ts:468-471`).

**Constraints any persistence design must satisfy** — each a checkable requirement derived from a review finding, with the evidence in one clause:

1. **Keys must be storable in Postgres JSONB.** `user_documents.data` is `JSONB` (`app/models/user_document.py:30`), `PUT /sync/section` stores the body as-is (`sync.py:236`, `row.data = data`), and jsonb rejects U+0000 in keys and strings. *(round 2 C1)*
2. **A 409 merge result must be adopted into the store**, or the next write drops the other device's keys: `patchServerKey` retries with `{ ...current, ...local }` but never adopts the merged payload into the store (`serverSettings.ts:291-311`), and the settings stores' `fetchPrefs` run only from the three `authStore` fan-outs (§6.5). *(C5)*
3. **A map nested under one top-level key is replaced wholesale on a 409 or a stale PUT** (the merge is per top-level key, `serverSettings.ts:300`; the PUT stores the body as-is, `sync.py:236`); a design that nests must show the nested data is write-once or otherwise safe. *(C6, C10)*
4. **One tombstone rule for both new levels.** A cleared entry must survive a 409 retry (a deleted key is resurrected from the server copy), and a present-but-empty value must be distinguishable from "never written". *(C12)*
5. **Migration must not silently de-share colliding bare-name chats.** Today every same-named chat of every character gets the legacy link — the readers key by bare file name only (`ChatView.tsx:836`, `:858`; `chatStore.ts:1504`). A first-loader or first-writer rule is a behaviour change and must be stated as one, or avoided. *(C11)*
6. **A pre-migration write from the re-pointed UI (§6.3) must apply to turns and must not be overwritten by a later one-shot migration.** *(C4)*
7. **The legacy snapshot heals must run on every `fetchPrefs` branch of every store that holds a legacy field**, including the branches that return without applying server state. Three heals: `mainPromptSnapshot !== null` → restore the global `mainPrompt` and null it; no `defaultPresetId` → restore `sampler` from `samplerSnapshot` and clear `activePresetId`, including when there is no snapshot (`restoreDefault`'s no-snapshot branch, `:634`, because `savePresetAndLink` persists `activePresetId` without a default); `defaultPresetId` set and `activePresetId !== defaultPresetId` → `sampler = presets[defaultPresetId].sampler`, `activePresetId = defaultPresetId` (`restoreDefault`'s second branch, `:637-640`). The heals exist because `loadPresetTransient` sets `sampler` / `activePresetId` without persisting (`:618`) and the template effect's `setPrompt → persist()` then writes them and the template text to `stm_generation` (`promptTemplateStore.ts:321` → `generationStore.ts:768-774`); older bundles keep doing so during skew (`main.tsx:39-41`). *(C8, C9; round 1 C4; round 3 C5)*
8. **The PR that swaps the builder's `linkedStyleActive` / `pureChatMode` reads (§6.3) is not byte-neutral while any transitional read of the legacy maps is live**: today a Settings edit made over an open styled chat changes the global `mainPrompt` the builder reads (`chatStore.ts:1516`); a resolver-level legacy customization would not follow it. *(C14)*
9. **Rollback must be stated, not asserted.** Any design must say what a pre-rollout bundle does with rows the new bundle wrote, what roll-forward does with legacy writes made during a rollback, and whether a link cleared through the new UI resurrects under the old bundle when its legacy key is kept. *(C7, C13)*
10. **Hydration must distinguish an empty local mirror (post-logout wipe under the `stm:` prefix; a new device) from "no customizations"**, or a failed settings GET resolves global with no pending badge. *(P2; round 1 C8)*
11. **A migrated `CHAT_STYLE_NONE` link must resolve `source: 'global'`** (§6.1) whatever the slot stores. *(P1 — decidable now, decided)*
12. **Older bundles are live during skew and re-PUT their own copies of the legacy keys** (#536-class; the service worker above); a design must say what makes those writes inert, and must not rely on a header key an older bundle rebuilds without (`buildChatPayload` rebuilds `messages[0]` from scratch). *(round 1 C4/C5)*
13. **A chat-level key must survive a group roster reorder:** group chats keyed by file, not by roster slot 0 — `loadGroupChat` keys by `characterAvatars[0]` (`chatStore.ts:4904`) and `buildChatPayload` emits under `groupCharacters[0].avatar` (`:3729-3731`); #458. *(round 1 D10; round 3 C4)*

**Candidate slot designs** — listed neutrally, each with the hazard the reviews found:

- *Character level:* **(i)** a user-scoped sync section keyed by avatar — 1:1 with the legacy avatar maps, no ownership rule, invisible to older bundles; subject to constraints 2–4 and 10; the avatar key is name-derived (`createCharacter` → `sanitizeAvatarName`, `client.ts`) and `characterStore.deleteCharacter` does not clean the legacy `linkedPresetByAvatar` / `linkedTemplateByAvatar` maps, so a re-created character with the same name inherits the old customizations. **(ii)** the card's `data.extensions.ggbc.*` — travels with export and is shared by every user of a global character (per `characterOwnershipStore.ts`'s header comment, not re-verified against the current backend), so it needs an ownership/permission rule; `api.editCharacter` (`client.ts`) sends no `base_ts` and `update_character` (`characters.py`) replaces `data` last-writer-wins, so a stale save of any card field replaces the whole `extensions.ggbc` object; a V2/V3 import spreads `card.data.extensions` wholesale (`cardToCharacterInfo`) and `CharacterImport` preserves pre-existing `ggbc.*` keys, so a third-party card's `extensions.ggbc` arrives as stored character-level customizations that outrank the card fields and are not gated by the respect toggles, and a global character's owner customizations reach every user; the wizard can ride the create payload instead of staging.
- *Chat level:* **(a)** the chat header, `Chat.messages[0]` — row-keyed, no new section; but `saveChatToBackend`'s 409 retry resends **our** header whenever the local message count ≥ the server's, merging only `wi_fired` (`chatStore.ts:4019-4040`), `reconcileServerState` re-adopts only `wi_fired` (`:3939-3963`), older bundles rebuild the header without the key, and a settings write needs a chat-row save the store cannot target before a send (`lastSaveContext` is assigned only inside `saveChatToBackend`, `:3985`). **(b)** a per-chat sync section with a JSONB-safe key, a read-time `__pending` fallback instead of load-time materialization, and one tombstone rule — round 2's "simpler" lens.
**Migration facts that survive** (sources and targets, not a mechanism): `linkedPresetByAvatar` / `linkedTemplateByAvatar` → character-level sampler / `mainPrompt` values copied from `presets` / `templates`; `linkedPresetByChatFile`, `linkedTemplateByChatFile`, `chatCompanionModeByChatFile` → chat-level values, `CHAT_STYLE_NONE` → the `global` marker; the wizard's `handleSaveAndLink` (`CharacterSetupWizard.tsx`: global `setSampler` first, then `savePresetAndLink`) is rewritten to write the character level only — "Apply globally instead" keeps calling `setSampler`, "Save & link template" writes the character `mainPrompt`, "Set on card" keeps writing the card field; the legacy keys stay in `PersistedShape` (their key sets are test-pinned) until a follow-up removal story.

### 6.5 What each store changes

| Store / module | Change |
|---|---|
| `generationStore` | Stops being overwritten. Remove `loadPresetTransient`, `restoreDefault`. Keep `presets`, `loadPreset`, `setSampler` (with mirroring), `defaultPresetId` (unused at resolution), `samplerSnapshot` as a legacy key. `linkedPresetByAvatar/ByChatFile` and their setters lose every writer after task 1. The heal rule is §6.4 constraint 7. |
| `promptTemplateStore` | Remove `loadTemplateMainPromptTransient`, `restoreDefaultMainPrompt` and the `mainPromptSnapshot` branch of `ensureTemplate`; `mainPromptSnapshot` stays a legacy key (heal: §6.4 constraint 7); `chatCompanionModeByChatFile` and `linkedTemplateBy*` lose every writer. Templates remain fill-in sources. |
| `characterSettingsStore` (new) | Owns the character level: `set(avatar, patch)`, `clear(avatar, field)`, `clearAll(avatar)`, `initForUser`, `fetchPrefs`. Section / slot shape, tombstone and hydration semantics: **OPEN (§6.4)**. `stage(patch)` / `commitStaged(avatar)` as a thin holder for E7-S2's creation wizard — **shipped by task 1 untested by any caller** (`CharacterSetupWizard` is mounted only from `CharacterEdit.tsx:869`, with an existing avatar) — needed only if the chosen slot cannot ride the create payload. |
| `chatSettingsStore` (new) | Owns the chat level: `get` / `set` / `clear` / `clearAll` / `rekey` / `drop` and the key function; no `chatStore` import (every `chatStore` test already mocks `lovenseStore` because of one module-scope import cycle, `promptGoldens.test.ts:88-90`). Slot, key, tombstone, fallback: **OPEN (§6.4)**. |
| `chatStore` | `loadedChatIdentity` set on load success (#530: `currentChatFile` is set before the fetch, `:4878`); `renameChat` (which receives `avatarUrl`) / `deleteChat` call `rekey` / `drop`; `setChatCustomization` / `clearChatCustomization` / `clearAllChatCustomization` operate on `loadedChatIdentity`; `PreparedConversation.eff`; `prepare` and the group builder take the trailing optional snapshot; the six seams resolve once. `buildChatPayload` unchanged unless §6.4 chooses candidate (a). |
| `authStore` | **Three** identical prefs fan-outs — `checkAuth` (`:130`), `register` (`:214`), `login` (`:288`) — each gains `initForUser` and `fetchPrefs` for each new store (every existing sync store is wired in all three, e.g. `useChatLoreConfigStore` at `:146` / `:234` / `:306` and `:186` / `:276` / `:348`); each collects the prefs promises and runs whatever migration §6.4 decides after them. |
| `utils/llm/resolve.ts` | `getGenerationOptions(plain)`; `getProviderAndModel` untouched. |
| `utils/serverRetrieval.ts` | `tryServerRetrieval(avatar, file, tokenBudget)`; `budgetRequested` keeps its meaning. |
| `ContextMeter` (E3-S2) | Its denominator and "· trimming" gate read `resolveEffectiveSettings(ctx).context.maxTokens.value` for the open chat instead of the global `context.maxTokens` (`ContextMeter.tsx:30`), which is no longer overwritten while a chat is open (§7.7). |
| `worldInfoStore` | No storage change. `scanDepth`/`maxRecursionSteps`/`tokenBudget` are read *through* the resolver so the display can annotate them. |
| `personaStore`, `settingsStore` | Untouched (§2.1; provider/model stay global). |

### 6.6 Test plan

Converged (stand as written):

- **Golden neutrality (identity):** with no customization anywhere, `resolveEffectiveSettings(ctx).plain.sampler` **is** (`toBe`) `useGenerationStore.getState().sampler`, and likewise `prompt`, `context`; the 133 goldens under `src/stores/__goldens__/` (driven by `promptGoldens.test.ts`, which calls the exported wrappers directly and sets `generationStore` directly) must stay byte-identical with the resolver wired in. The two legacy-state fixtures (`mainPromptSnapshot` at `promptGoldens.fixtures.ts:1232`; `chatCompanionModeByChatFile` at `:1193`) run **un-rewritten** until the PR that performs the §6.3 swap, which rewrites them to set the equivalent customization; the expected files and the fixtures' `pins` strings are never touched. **`PINS_ANCHORS` must be re-fingerprinted:** its entries name the constructs this refactor rewrites verbatim (`linkedStyleActive`, `genState.prompt.*`, `genState.context`, `wiState.scanDepth/tokenBudget`), and the "every anchor names a construct that still exists" test (`promptGoldens.test.ts:558`) asserts them with occurrence counts. The README's mutation drill (`src/stores/__goldens__/README.md` "The mutation drill") gains the rows named below. This is the E3 epic's "zero regressions" gate.
- **Precedence, deterministic, on the pure core:** for each customizable field × {G, C, Ch, Ch=marker} truth table: chat beats character beats global; the marker skips character and resolves `source: 'global'`; `source: 'card'` only for `mainPrompt`, only when `respectCharacterOverride` is on, the card `system_prompt` is non-empty and no customization exists; `plain.prompt.mainPrompt` never equals the card text. **PHI:** with a card that has `post_history_instructions` and `respectCharacterPHI` on, (a) a character PHI customization resolves `source: 'character'` with `cardPhiSuppressed: false` and the builder emits both `char_phi` and `user_phi`; (b) a character mainPrompt customization only → `cardPhiSuppressed: true` and the builder's `char_phi` is the style note; (c) a character mainPrompt customization plus a chat `global` marker, pure-chat off → `linkedStyleActive` false, `cardPhiSuppressed: false`, `char_phi` is the card PHI — the annotated view must agree with `buildConversationContext`'s output for the same inputs. Group: a character customization resolves `source: 'global'`; a chat one `source: 'chat'`.
- **Single-snapshot-per-turn:** a store mutation between `prepare` and the committing `finish` does not change the emitted prompt; `prepared.eff` is the same object across both passes.
- **Applicability:** `provider-dropped` table pinned per family (a client-side mirror of `anthropic.py` / `google.py`'s accepted keys, dated in a comment — drift risk, so pin it); `model-omitted` mirrors `modelRejectsSamplers`; `engine.predicted` agrees with `isChatEligibleForServerRetrieval` for each disqualifier, is `'client'` for `swipe`/`continue`, `'n/a'` for group; `server-fixed` for `wi.*` only when predicted server.
- **Seam wiring:** extend `chatStore.callSites.test.ts`: `getGenerationOptions` receives `prepared.eff.plain` (same object) at all six sites; `tryServerRetrieval` receives `eff.wi.tokenBudget.value` and `wi.server.budgetRequested` equals it.
- **Mutation-verify** (house rule): "always return global" must fail the precedence table; "resolve per read" must fail the single-snapshot test; "marker resolves `source: 'chat'`" must fail PHI case (c).

Provisional — re-derived against the design §6.4 chooses; the constraints in §6.4 name kill tests: round-trip at character and chat level (set → persist → reload → apply; a two-device 409 whose second write must still carry the other device's key — constraint 2; a cleared entry surviving a 409 — constraint 4; a JSONB-safe key round-tripped through a real PUT — constraint 1); migration (each legacy source → its target; idempotent; colliding bare names — constraint 5; a pre-migration UI write surviving the migration — constraint 6); heals (every `fetchPrefs` branch, and the no-default `activePresetId` clear — constraint 7); hydration (empty mirror ≠ no customizations — constraint 10); the swap's byte-neutrality claim, whichever PR makes it — constraint 8.

### 6.7 Rollout order and the E3-S3 risk list

**Provisional four-PR split, re-derived at E3-S3 task 1's PLAN once §6.4 is decided:** PR1 resolver (S) · PR2 stores (M) · PR3 seam wiring (L, prompt-assembly class) · PR4 migration + effect deletion + builder-read swap + UI re-point (M) — details in the plan file's §5. PR1 and PR3 stand as scoped (the pure resolver; the six seams, `prepare`/`finish`/group, `getGenerationOptions(plain)`, the `tryServerRetrieval` budget argument, `PINS_ANCHORS` for the reads PR3 touches). PR2 and PR4's contents, sizes and the PR in which the §6.3 swap lands depend on §6.4 — in particular constraint 8: no PR may claim byte-neutrality while a transitional read of the legacy maps is live. After task 1: **E3-S2** (indicators + "in effect" panel, now truthful) → **E3-S3 task 2** (character page) → **E3-S3b** (scan-depth contract, §2.3) → **E3-S4** (chat panel + lore disclosure). This re-sequences the cards (§9 D2); shipping E3-S2 first, on top of the overwrite mechanism, would make its indicators show transient values as global. Rollback is §6.4 constraint 9.

Task 1 hits three §6.1 triggers — spread/layering refactor, async store orchestration, user-writable storage — and not the backend-contract or safety-gate ones (E3-S3b is the contract story). Failure modes the design and tests must cover, beyond §6.4's constraints: a cold store on the first turn resolves global (visible as `meta.*: 'pending'`, never persisted); a failed `loadChat` (#530) must not re-key the chat level to the un-loaded file; a resolved object reused across turns; `getProviderAndModel`'s side effects stay where they are (§6.1); the wizard rewrite must stop `savePresetAndLink` setting `activePresetId`, or `setSampler` keeps mirroring into a "linked" preset; and the Settings page now edits **only** global while a chat with customizations is open — a change from today's linked-preset mirroring, stated as a fix, not a regression, and shown by the §7.7 markers.

---

## 7 · UI patterns (AC2)

### 7.1 Badge vocabulary

One set, used on the Settings page, the character page, the chat panel and the "in effect" panel. Reuses the lore rows' chip styling (`LoreEntryRow.tsx` `PROVENANCE_CHIP`).

| Badge | Tint | When | Names the level? |
|---|---|---|---|
| `Inherited` | neutral | the effective value comes from a higher level | yes, as suffix: "Inherited · global" / "Inherited · Ivy (character)" — the `ChatStyleModal` precedent ("Default — X (character)") |
| `Customized` | primary | set at the level being viewed | — |
| `Customized · chat` / `· character` | primary | on a page for a *higher* level, the value is beaten below | yes |
| `From card` | neutral | the character-level source is the card field | — |
| `Global (skips character)` | neutral, italic | chat-level `global` marker | — |
| `Not used here` | dim, `opacity-60` | inert; tooltip carries the reason string (§7.8) | — |
| `Server-fixed` | amber (the `Base changed` tint) | `wi.scanDepth` / `maxRecursionSteps` on an eligible solo chat: "yours 10 · server uses 4 on Send" | — |
| `Estimate` | neutral | any budget preview: "client-side estimate (claude profile); the server prices with a generic 3.8 chars/token" | — |
| `*` after a value + `reset` | primary | the `GroupChatControls` talkativeness precedent — used inside compact rows where a chip does not fit | — |

The `Base changed` drift chip is not reused: a customization is a value, not a fork, so it has no base to drift from.

### 7.2 Nesting and indent (new — no precedent exists)

- **Level pages (E3-S2 Settings, E3-S3 character page, E3-S4 chat panel) edit one level.** Each field is a row: `[☐ Customize]` label · value control · badge · (`reset` when customized). Unchecked: the control is disabled and shows the inherited value with its `Inherited · <level>` badge. Checked: the control becomes editable, **seeded with the inherited value at that moment, and does not follow the base afterwards**; the editor sits in an indented block using the app's disclosure idiom (`pl-2 border-l-2 border-[var(--color-border)]`, `AdvancedCardFields.tsx:95`).
- **The "in effect" panel (§7.4) is read-only and shows all three levels per field** as a nested disclosure: the row shows the effective value + source badge; expanding indents three sub-rows `Global · Character · Chat`, each showing its value or "—" (inherits), the winner highlighted. Group chats show `Global · Chat` (character sub-row reads "not applied in group chats").
- Generation settings stay tabbed (Samplers / Prompts / Context …); the level pages reuse the tab ids so a field is found in the same place at every level.

### 7.3 Reset granularity

| Scope | Control | Semantics |
|---|---|---|
| Per field | `reset` next to the value (title "Clear customization, use <level> value") | remove the customization → inherit |
| Per level | "Reset all customizations" at the top of a level page, behind a ConfirmDialog (the `ChatLorePanel` precedent) | clears every field at that level, nothing above it |
| All levels | none | a chat panel never clears character customizations; a character page never clears chat ones |
| Factory | Generation page's existing `Reset` (aria-label "Reset to defaults") | global only; relabelled "Reset to defaults"; unchanged |

"Reset" always means **inherit**, never factory, except on the Global page where there is nothing to inherit.

### 7.4 The ≤2-click "what's in effect now" surface

**Home:** `ChatOptionsMenu` gains a row **"Settings in effect"** (click 1 opens the menu, click 2 opens the panel). The panel is the read-only mode of one component, **`ChatSettingsPanel`**, whose second tab, "Customize this chat", is E3-S4's editor and retires `ChatStyleModal`'s two selects (pure-chat and the quick styles move with them; quick styles become "apply preset/template to this chat"). Modal at every width (the `ChatStyleModal` / `ChatLorePanel` precedent; §7.9).

**Content:** the resolver's output for the **next** turn (a prediction: the engine line says "Next Send: server retrieval (eligible) — Regenerate / swipe / continue always use the client scan"), plus one header line from the **last** turn when `generationStore.lastPromptBreakdown` is for this chat: "Last turn: client scan · budget 1024 · claude profile" or "Last turn: server retrieval · budget 1024 (generic estimate) · scan depth 4". The two are labelled *Next* and *Last*; neither is presented as the other. `insightsApi.getTurnWiInsight` (E2-S4) is the read path for the last-turn facts; the panel does not import `breakdownBuckets`. When `prompt.cardPhiSuppressed` is true the PHI row says so (§7.10 `phi.cardSuppressed`) instead of showing a card value that did not run.

### 7.5 The "not applied on this turn (server retrieval)" state and the estimate label

Scoped to the **global** `scanDepth` and `maxRecursionSteps` (per-entry overrides are honoured by both engines). Two displays:

- *Prospective* (chat panel, Settings page when a chat is open): `Server-fixed` badge with "On Send in this chat the server uses scan depth 4 and no recursion; your values apply on Regenerate, swipe and continue." Shown only when `engine.predicted === 'server'`; on ineligible chats the values show `Inherited · global` and a one-line "client scan (reason: <first disqualifier>)".
- *Factual* (last-turn line, E4-S2 explainer): from `wi.activationSource` and, after §2.3-A, `wi.server.appliedScanDepth`; until then "server used its default (4)".
- **Budget preview** anywhere (ChatLorePanel header "~P / B pinned tokens", the chat panel): badge `Estimate` with the profile named; the last-turn line names `budgetEstimator: 'generic'` when the server ran (`ServerActivationFacts`).

### 7.6 Engine-switch disclosure (ChatLorePanel, E3-S4)

Header line under the budget: **"This chat uses the local scan"** + reason (first true disqualifier, in `isChatEligibleForServerRetrieval` order) + "Documents (Data Bank) cannot fire on the local scan; your scan depth and recursion apply." On the first customization that flips eligibility, the same text appears as a toast. When the last linked book and customization are removed: "This chat is eligible for server retrieval again." After "Reset all customizations": "Linked books kept — still local scan" when any remain.

### 7.7 Settings page opened over a chat

Settings → Generation edits **global** values only. When a chat is open, each row shows a marker when the effective value differs: `Customized · chat` / `Customized · Ivy (character)`, with a link "edit there". It never shows the resolved value in the control (that was the overwrite bug). The `ContextMeter` reads the resolver's `context.maxTokens` for the open chat as its denominator and "· trimming" gate (today the global `context.maxTokens`, `ContextMeter.tsx:30`); "· trimming" is hidden in group chats and when `tokenAware` is off (today it shows regardless, `:68`).

### 7.8 Inert and provider-dropped display

Inert settings are **shown, disabled, badged `Not used here`** — never hidden, so the user does not conclude the setting is missing. Reason strings (tooltip): "Group chats use a fixed prompt and a 30-message window" (`group-builder`); "Not sent to Claude when temperature is set" / "Not sent to Gemini" (`provider-dropped`); "Claude 4.7+ ignores samplers; none are sent" (`model-omitted`); "Used on Send only" (`action`); "Only used when token-aware trimming is on" (`tokenAware-off`); "Text-completion mode cannot generate today (#513)" (`text-mode-broken`). In `ChatSettingsPanel` in a group chat, prompts and context are disabled with the first string; `ChatStyleModal`'s template/pure-chat controls, which are offered in group today (`ChatView.tsx:2222`), inherit the badge until retired.

### 7.9 Mobile

`ChatSettingsPanel` is a centred `Modal` at every width, like `ChatStyleModal` and `ChatLorePanel` (`p-4`, `max-h-[90vh]`); `ChatOptionsMenu` stays a `BottomSheet` below 1024 px (`useIsMobile`). The Settings page-stack is full-width below 640 px (`SettingsPanel.tsx:111`) and unchanged; the character page is a page in that stack. Two breakpoints coexist today (640 / 1024); this spec does not unify them (E3-S5 may).

### 7.10 Wording table

| Key | String |
|---|---|
| badge.inherited | Inherited · {level} |
| badge.customized | Customized |
| badge.customizedBelow | Customized · {level} |
| badge.card | From card |
| badge.global | Global (skips character) |
| badge.inert | Not used here |
| badge.serverFixed | Server-fixed |
| badge.estimate | Estimate |
| reset.field | Clear customization, use {level} value |
| reset.level | Reset all customizations |
| reset.confirm | Reset every customization at this level? Values return to the inherited ones. |
| engine.next.server | Next Send: server retrieval. Regenerate, swipe and continue use the client scan. |
| engine.next.client | Next turn: client scan ({reason}). |
| engine.last.server | Last turn: server retrieval · budget {n} (generic estimate) · scan depth {d} |
| engine.last.client | Last turn: client scan · budget {n} ({profile} profile) · scan depth {d} |
| wi.serverFixed.scanDepth | On Send in this chat the server uses scan depth 4. Your value ({d}) applies on Regenerate, swipe and continue. |
| wi.serverFixed.recursion | The server engine has no recursion. Your value ({n}) applies on Regenerate, swipe and continue. |
| wi.estimate | Client-side estimate ({profile} profile). The server prices with a generic 3.8 chars/token. |
| phi.cardSuppressed | Card post-history instructions suppressed by your main-prompt customization — a style note is sent instead. |
| lore.local | This chat uses the local scan: {reason}. Documents (Data Bank) cannot fire here; your scan depth and recursion apply. |
| lore.eligible | This chat is eligible for server retrieval again. |
| lore.resetKeptLinks | Linked books kept — still local scan. |
| menu.inEffect | Settings in effect |
| panel.tab.inEffect / panel.tab.customize | In effect / Customize this chat |
| settings.section.prompts | Prompts *(was "Prompt Overrides")* |

### 7.11 R3's twelve decisions, answered

1. Vocabulary: §7.1, one set; diverges from `Inherited/Customized/Chat-only/Off` only by adding level suffixes and the four applicability badges. 2. Badges name the winning level (suffix). 3. Toggle = per-field "Customize" checkbox seeded with the inherited value (E3-S3's card); selects with a "Default" option are retired with `ChatStyleModal`; link chips in `CharacterEdit` become a "Customized (n fields)" chip linking to the character page. 4. Reset: §7.3 — per field, per level, never cross-level; reset = inherit. 5. Indent: nested disclosure per §7.2, not tabs per level. 6. Home: `ChatOptionsMenu` → `ChatSettingsPanel`; shows *Next* and *Last*, labelled. 7. Server-fixed: prospective from eligibility + factual from `activationSource`; scoped to the global value; extended to recursion; `Estimate` on every preview. 8. Inert: shown-disabled-badged, including `ChatStyleModal` and `ContextMeter`. 9. Disclosure: §7.6, in `ChatLorePanel`'s header + first-flip toast + return message. 10. Word: "customization"; Generation section relabelled. 11. Settings over a chat: global values + markers, never resolved values. 12. Mobile: centred Modal.

---

## 8 · Consumer sign-off

### 8.1 E7-S2 (advanced-settings wizard pages)

| E7-S2 need (card, verbatim) | Answered in | One-line answer |
|---|---|---|
| "per-character generation settings **via cascade override rails**" · "wizard-set generation settings are literally character overrides (visible in E3's UI)" | §6.4, §6.5 | The sampler / prompt pages call `characterSettingsStore.set(avatar, patch)` (staged before `createCharacter` returns if the slot §6.4 chooses needs it). What they write is what the character page (E3-S3) shows, badge `Customized`. |
| "Wizard P2 contains **zero** override mechanism of its own — it writes through E3's rails" | §6.4 migration row | The existing `CharacterSetupWizard` **is** a mechanism today (global `setSampler` then `savePresetAndLink`; `saveTemplateWithPromptAndLink`; card `system_prompt`). E3-S3 rewrites its two link paths onto the rails and removes the global write; "Set on card" stays a card write; "Apply globally instead" stays an explicit global write. E7-S2 copies that shape and adds nothing. |
| "connection profile" page | §3, §3.1, §9 D5 | Provider/model are global-only in v1; a profile applied in the wizard writes its **sampler** as character customizations and the page says "provider and model are global settings". If D5 goes the other way, the page also writes a character `provider`/`model` customization — but that needs every seam to honour it (v2). |
| "avatar/media settings" | §3 (extensions row) | Outside the cascade: those live in their own avatar-keyed stores (`motionModeStore`, `livePortraitStore`, `lovenseStore`). The wizard writes them through those stores; they are not "overrides" in E3's sense, so the zero-mechanism criterion does not cover them. |
| "lorebook defaults" | §4 | Book composition (`characterStore.setLinkedBookIds` / the owned book), not the cascade. #450 is OPEN, so the card's E4-S0 gate note stands only for the client engine's inability to fire keyless entries; the first-match claim it cites is stale (Appendix C-9). |
| "skipping every advanced page still yields a valid character" | §2.1 rule | Absence = inherit. The wizard must write **only fields the user touched**, never defaults as customizations; a skipped page writes nothing. |
| creation-time writes | §6.4, §6.5 | Slot-dependent (§6.4 is open): a user-scoped section needs `stage(patch)` before the avatar exists and `commitStaged(avatar)` after `createCharacter` — the `InterviewReview` staged-lore precedent; a card slot rides the create payload. If staging is needed, E3-S3 task 1 ships the pair as a thin holder **untested by any caller**: the only wizard mount today is `CharacterEdit.tsx:869`, with an existing avatar. E7-S2 is its first caller and owns its tests. |

### 8.2 E4-S2 (scope + non-firing explainer)

- **Values:** `resolveEffectiveSettings(ctx).wi.tokenBudget` and `.wi.scanDepth` — `{ value, source: 'global', applicability }`. In v1 the source is always `global`; E4-S2 is not waiting on a level that will never exist.
- **Applied-this-turn:** `applicability.kind === 'server-fixed'` (prospective); for the served turn, `PromptBreakdown.wi.activationSource` and `wi.server.budgetEstimator` (existing), plus `scanDepthRequested` / `appliedScanDepth` (§6.2 additions). Reason strings are §7.10's `wi.serverFixed.*` and `wi.estimate`.
- The explainer's own cite `serverRetrieval.ts:100-159` / `:113-115` is drifted (Appendix C-7).

### 8.3 E3-S2 / E3-S3 / E3-S4

| Story AC | Section |
|---|---|
| E3-S2 "every default shows its active/overridden state" · "indicators update live" · "inert shown as inert" | §7.1, §7.7, §7.8 (reads the resolver with the open chat's context; group-inert list in §3) |
| E3-S3 "overrides beat globals, lose to chat overrides, exactly per spec" | §2.1 rule, §6.6 truth table |
| E3-S3 "disabling an override reverts cleanly" | §7.3 (reset = inherit), §6.6 round-trip |
| E3-S3 "existing characters unaffected until an override is explicitly set" | §6.4: characters with a linked preset/template already have one; migration carries it as values, behaviour-identical on day one |
| E3-S3 "E7-S2 can consume the rails without new mechanism code" | §8.1 |
| E3-S4 "per-chat overrides survive reload" | §6.4 — OPEN: the chat slot is decided at E3-S3 task 1's PLAN |
| E3-S4 "visibly badged in the chat UI" | §7.4 menu row + `Customized · chat` badges; `ChatOptionsMenu`'s "(custom)" label switches to the resolver's "any chat customization" (today it ignores pure-chat, `ChatView.tsx:2223`) |
| E3-S4 "reset restores the character/global value" | §7.3 |
| E3-S4 "setting a lore-scoped override discloses the engine switch, and clearing every lore override restores eligibility (test-pinned against `isChatEligibleForServerRetrieval`)" | §4, §7.6 — with the corrected facts (not permanent; Reset keeps links) |

### 8.4 E5-S1 / E5-S2

A finding about the WI budget names the level that owns the value (always `global` in v1 — the resolver's `source`). `EffectiveSettings.plain` is a serialisable snapshot E5-S2's replay rig can pin per turn; `clear(level, field)` is the revert operation distinct from "set to the inherited value".

---

## 9 · Decisions for Sammy, out of scope, risks

**Decisions** (each: recommendation → alternative):

1. **Character-level slot — decided at E3-S3 task 1's PLAN with Sammy, against the §6.4 constraints.** Candidates: (i) a user-scoped sync section keyed by avatar · (ii) the card's `data.extensions.ggbc.*` (travels with export, shared by every user of a global character, no staging at create; needs an ownership/permission rule and an export-format change).
2. **Rollout order.** E3-S3 task 1 first, then E3-S2 → *alt:* keep the card order and let E3-S2 ship a read-only resolver over the legacy maps (a second resolver to delete later).
3. **Presets/templates as fill-in sources (values copied).** → *alt:* by-reference links (`{ ref: id }`) resolved at read time — preserves "edit the preset, every linked chat follows", keeps the deleted-id case, and keeps the setSampler-mirroring hazard.
4. **Group = Global + Chat in v1.** → *alt:* per-speaker character customizations in group (new behaviour; sampler is the only group-honoured customizable group).
5. **Provider/model stay global in v1.** → *alt:* character-level provider/model (touches every seam, credentials, `getProviderAndModel`'s auto-switch, #515).
6. **Persona locks stay dormant, not adopted, not deleted.** → *alt:* delete `locks.byChat` + the four lock actions (persisted-shape change).
7. **Chat-level slot — decided at E3-S3 task 1's PLAN with Sammy, against the §6.4 constraints.** Candidates: (a) the chat header (row-keyed; hazards in §6.4) · (b) a per-chat sync section with a JSONB-safe key, read-time pending fallback and one tombstone rule.
8. **Scan depth: send it (§2.3-A) as a separate small story E3-S3b**, backend first; UI badge until then → *alt:* backend reads `stm_worldinfo.scanDepth` (no contract, no chat-level future).
9. **Vocabulary: "customization"**, relabel "Prompt Overrides" → "Prompts" → *alt:* keep "override", rename the two colliding labels.
10. **Chat-level `global` marker kept** for lossless `CHAT_STYLE_NONE` migration → *alt:* drop the three-state; migrate NONE by materializing today's global values (they then stop following the global).

**Out of scope for E3 v1:** lore composition and its four assemblers; worlds as containers; persona as a level; per-character provider/model; prompt order, instruct, RAG, summary, extension settings at lower levels; author's note and group-record settings (own panels); avatar/media stores; unifying the 640/1024 breakpoints; removing the legacy link maps from `PersistedShape` (follow-up).

**Risks:** the persistence + migration design is open (§6.4) — its constraints are the risk register for E3-S3 task 1's PLAN; the `provider-dropped` table is a client mirror of backend code (pin + date it); chat-level reads key off `loadedChatIdentity` (#530), and the group **row** still forks on reorder / re-selection / delete (#458/#506/#507, be#84); any existing settings section edited by an older bundle can still drop keys (#536, §6.4 constraint 12); `characterOwnershipStore`'s global-visibility comment was not re-verified against the current backend; provider-family sampler tolerance for the openai family is an unverified external claim (`generation.py:95-96` asserts it).

---

## Appendix A · Inventory (condensed from R1; code locations at `1e6a555f` / `fb26a80`)

| Setting | Store · field | Persisted (section) | Levels today | Consumed by |
|---|---|---|---|---|
| Active provider / model / custom URL | `settingsStore.activeProvider/activeModel/customUrl` | `stm_oai_settings` via `POST /api/settings/save` (shallow merge, no `base_ts` — #539) | G | `getProviderAndModel` at all six seams; token profile via `profileForProvider` |
| Fallback provider / model | `settingsStore.fallbackProvider/Model` (`persistFallback`) | `stm_oai_settings` | G | `generateWithFallback`, `send` seam only |
| Connection profile | `connectionProfileStore.profiles/activeProfileId` | `stm_connection_profiles` | bundle | apply copies into G (`AISettingsPage.tsx:732-734`) |
| Sampler (9 fields) | `generationStore.sampler` | `stm_generation` | G + C/Ch by link | `getGenerationOptions` at `chatStore.ts:3397, 5192, 5383, 5543, 5798, 6242` |
| Presets, links | `presets`, `activePresetId`, `defaultPresetId`, `samplerSnapshot`, `linkedPresetByAvatar`, `linkedPresetByChatFile` | `stm_generation` | bundle / C / Ch | `ChatView` effects |
| Context (4) | `generationStore.context` | `stm_generation` | G | solo prepare `:1641-1645`, finish `:2100-2122` |
| Prompt text (3) + respect toggles (2) | `generationStore.prompt` | `stm_generation` | G (+ card, + template link for mainPrompt) | solo `:1507-1518`, `:1558-1562` |
| Prompt order (18) | `generationStore.promptOrder` | `stm_generation` | G | solo `:1628`, finish Stage A/C |
| Instruct (4) | `generationStore.instruct` | `stm_generation` | G | `maybeApplyInstructMode` (in `dispatchWithCapture`), `getGenerationOptions` stops when `enabled` |
| showExactPrompt | `generationStore.showExactPrompt` | `stm_generation` | G | `dispatchWithCapture` |
| Templates, links, pure chat, snapshot | `promptTemplateStore.templates`, `linkedTemplateByAvatar/ByChatFile`, `chatCompanionModeByChatFile`, `mainPromptSnapshot` | `stm_prompt_templates` | bundle / C / Ch | `ChatView` effects; solo `:1497-1505` |
| Card fields | `system_prompt`, `post_history_instructions`, `extensions.depth_prompt`, `extensions.talkativeness` | `characters.data` (card) | C | solo `:1507-1513`, `getDepthPrompt` `:1719`; `getTalkativeness` (group selection) |
| Persona | `personaStore.personas/activePersonaId/locks` | `stm_personas` | G, C/Ch locks (dormant) | `getPersonaForContext(avatar)` |
| Author's note | `chatStore.authorNotes[file]` | `stm_chat_state` + `sillytavern_author_notes` (+ write-only header copy) | Ch | solo `:1724`, group `:2980` |
| Chat variables | `chatStore.chatVariables[file]` | `stm_chat_state` | Ch | macros |
| Group record | `GroupChatInfo` (`chatStore.ts:199-224`) | `stm_chat_state.groupChats` | Grp | group builder, `sendGroupMessage` |
| WI scan settings | `worldInfoStore.scanDepth/maxRecursionSteps/tokenBudget` (defaults 4 / 3 / 1024; clamps 1–50 / 0–10 / 0–32768) | `stm_worldinfo` (`snapshotForServer`) | G (+ entry `scanDepth`) | solo `:1382-1384`, group `:2518-2520`, `tryServerRetrieval` (budget only) |
| Book activation / links / chat config / overlays | `activeBookIds`, `characterStore.linkedBookIdsByAvatar`, `chatLoreConfigStore.configs` | `stm_worldinfo`, `stm_character_links`, `stm_chat_lore_configs` | G / C / Ch | `resolveEffectiveBooks` (5 sites, §4) |
| RAG enabled | `chatHistoryRagStore.enabled` | `stm_rag_settings` (server reads) | G | `resolveRagContext`; backend `_is_rag_enabled` |
| Summary settings | `summarizeStore` (`autoSummarize`, `autoTriggerEvery`, `injectionDepth` 999, `injectionRole`, `compactWhenSummarized` true) | `stm_summarize` (merge-on-write) | G | summarize extension `onBuildContext`; solo compaction |
| Extension flags, Lovense profiles, regex scripts, selfie | `extensionStore`, `lovenseStore.profilesByAvatar`, `regexScriptStore`, `selfieStore` (device-only) | `stm_extensions`, `stm_lovense`, `stm_regex_scripts`, — | G / C | `runContextHooks` (solo), `applyUserInputRegex`, `selfieEligibleForCurrentChat` |

Existing reset affordances: samplers/prompts factory `Reset` (Generation page); `resetPromptOrder`; context "provider default" (`applyProviderDefaults`, `maxTokens` only); `Unlink` chips in `CharacterEdit`; `ChatStyleModal` "Default" / "None" (the only three-state control today); pure-chat off deletes the key; entry "Override scan depth" checkbox (`WorldInfoEntryForm`, `ForkEntryEditor`); `ChatLorePanel` "Reset all customizations" (keeps linked books); group talkativeness `reset`. No "use global" exists for author's note, persona position, WI scan settings, RAG, summary, context or instruct fields — none has a lower level to fall back from.

## Appendix B · Settable but ignored / overridden downstream (from R2, re-verified), ranked by user impact

| # | Setting | What happens | Evidence |
|---|---|---|---|
| 1 | Completion mode = text | no request produces a token: `chat_completion_source` never sent in the text branch (`client.ts:1579-1591`), backend defaults to openai (`generation.py:320`) and forwards a `messages` body to `/completions` | #513, be#86, be#85 (all OPEN) |
| 2 | `maxRecursionSteps` (default 3), entry `relatedIds` / recursion flags | server engine has neither recursion nor co-firing → server-path turns behave as 0 for **default** users; the same chat recurses on Regenerate/swipe/continue | `_activation.py:54-58` |
| 3 | Any lore customization / character link / persona book / inactive world book | forces the client engine, where Data Bank / keyless entries can never fire | `serverRetrieval.ts:112-158`; `worldInfoStore.ts:1173` vs `_activation.py:527`; #450 |
| 4 | `scanDepth` (global) | fixed 4 on server-path turns (per-entry fallback `:510-512` and recall window `retrieval.py:280`); the value sits unread in `stm_worldinfo` | `client.ts:1277` body; `_activation.py:86` |
| 5 | Seven catalog providers | 501 from the relay | `generation.py:268-274`; #515 |
| 6 | `top_p` on Claude | dropped whenever `temperature` is present, which chat seams always send below 4.7 | `anthropic.py:144-149` |
| 6 | `min_p`, frequency / presence / repetition penalty on Claude and Gemini | not read by either translator | `anthropic.py:145`; `google.py:130-141` |
| 6 | every sampler on Claude ≥ 4.7 | omitted client-side, no UI signal | `client.ts` `modelRejectsSamplers`, `:1566-1574` |
| 7 | temperature > 1 on Claude | not clamped; upstream rejects (docstring `anthropic.py:11` says "clamped"; code comment `:134-137` says pass through) | slider max 2, `GenerationSettingsPage.tsx:208` |
| 8 | `tokenBudget: 0` ("unlimited") | backend warning reads it as 1024 → false "exceeds budget (1024)" toast | `lorebooks.py:179`; `worldInfoStore.ts` `maybeWarnPinnedBudget` |
| 9 | Fallback provider | `send` only | `chatStore.ts:5812` |
| 10 | WI budget pricing | generic 3.8 chars/token server-side vs provider profile client-side (gpt 4.0 / claude 3.6 / gemini 4.0 / llama 3.5, `tokenizer.ts`) | `_activation.py:91`; `budgetEstimator: 'generic'` |
| 11 | User sampler on utility generations; a connection profile's sampler on story ingest/render | constants 0.9 / 1024; profile sampler dropped | R2 §1.3, §1.7(a)8 (not re-verified here) |
| 12 | System-role placement | later system messages re-shipped as `[System note: …]` user turns on Claude/Gemini | `system_placement.py:46` |
| 13 | `custom_url` | forwarded upstream in the body; images dropped in text mode | R2 §1.1, §1.2 (not re-verified here) |
| 14 | Persona locks | dormant; 1-arg vs 2-arg `getPersonaForContext` drift | §1.3 |

Rows 11 and 13 carry R2's qualifier: found by reading, not reproduced, and not re-checked for this doc.

## Appendix C · Corrections to roadmap / audit / brief claims

| # | Claim (carrier) | Evidence at `1e6a555f` / `fb26a80` | Remedy |
|---|---|---|---|
| C-1 | "Any non-empty chat lore config makes that chat **permanently** ineligible for server retrieval (`serverRetrieval.ts:117-126`)" (E3-S4 card; brief) | Eligibility is recomputed per attempt (`:537`, `:556`); a vacuous config is deleted (`chatLoreConfigStore.ts:215-226`); the block is `:119-128`. The sticky part is that `resetCustomizations` keeps `linkedBookIds` (`:576-583`). | Replace "permanently" with "while non-empty"; add the Reset caveat; fix the cite |
| C-2 | The client engine has "a **fixed scan depth of 4 vs the user's setting**" (E3-S4 card) | The client uses the user's value (`chatStore.ts:1382` → `worldInfoStore.ts:1466`); the fixed 4 is the server's (`_activation.py:86`) | Move the clause to the server-engine description |
| C-3 | "the timer/sticky defects of #452" (E3-S4 card) | #452 is CLOSED (E4-S0) | Delete the clause |
| C-4 | "Expand the in-chat quick-settings panel" (E3-S4 card) | No such component (`grep -ri "quick.settings" src` → nothing). The per-chat settings editor is `ChatStyleModal` | Name `ChatStyleModal` / the new `ChatSettingsPanel` |
| C-5 | "`buildConversationContext` is *not exported* (`chatStore.ts:966`)" (roadmap §6.4); "~:966 unexported" (brief) | `export function buildConversationContext` at `:1245`; split into `prepareConversationContext` (`:1273`) / `finishConversationContext` (`:2007`) by `d18f3194` (2026-08-27); production no longer calls the wrapper (comment `:1238-1244`; no production caller found) | §6.4 is historical (E2-S2 task 0 resolved it); mark it |
| C-6 | "duplicated across **five** of them (`chatStore.ts:1058`, `:1818`, `chatLoreView.ts:159`, `ChatLorePanel.tsx:334`, `ingestSources.ts:102`)" (E3 epic) | 5 `resolveEffectiveBooks` call sites (`:1356`, `:2500`, `:159`, `:337`, `:103`), **4** union assemblers; `chatLoreView.ts` is a consumer | Say "four assemblers, five call sites"; fix cites |
| C-7 | `serverRetrieval.ts:485-492` (card 3b, epic); `~:485` (brief); eligibility `:100-159` (E4-S2, brief), `:113-115` (E4-S2, audit §1) | budget read/call `:558-565`; `tryServerRetrieval` `:525`; eligibility `:102-161`; character-link clause `:115-117` | Fix cites |
| C-8 | Group builder `:1746-2121`, comments `:1997/:2022/:2112`, window `:2045` (E3-S2 card); `~:1746` (brief) | builder `:2382-3304`; comments `:2859/:2897/:3184/:3194`; window call `:3017` | Fix cites |
| C-9 | "Avatar-owned books resolve first-match only (`getCharacterBook` → `books.find`, `worldInfoStore.ts:3385-3389`)" (E7-S2 card) | `getCharacterBook` is `findEmbeddedBook` (`:3686-3688`); the scan unions **every** owned book via `getActiveBookIdsForCharacter` (`characterStore.ts`, since `4196478a`, 2026-08-25). #450 (client engine cannot fire keyless entries) is still OPEN | Rewrite the gate note around #450 |
| C-10 | "`_activation.py:80-85`: this app has no server-side equivalent of the frontend's per-user scan-depth setting yet" (backend comment; audit §3b repeats "never sent") | The setting has synced to `stm_worldinfo.scanDepth` since `99081129` (2026-05-20); the comment dates to `e66a02d` (2026-08-06). "Never sent" is true; "no server-side equivalent" was false when written | Correct the comment in the §2.3 story |
| C-11 | "`swipeRight`/`continueMessage` are always local" (audit §1) | Also `regenerateMessage` → `swipeRight` (`chatStore.ts:5306-5312`) | Add Regenerate |
| C-12 | Audit cites `serverRetrieval.ts:452`, `chatStore.ts:1071-1079`, `:3695-3707`, `retrieval.py:401-402`, `:494`, `_activation.py:466-468` | now `:525`, `:1377`, `:5129-5140`/`:5341-5350`, `:409-410`, `:531`, `:527` (`_activation.py:86`/`:91`, `_retrieval.py:95`/`:102` still hold) | Audit's own header says re-verify; note drift |
| C-13 | `src/components/chat/ChatLorePanel.tsx` (brief) | `src/components/chat/lore/ChatLorePanel.tsx` | Fix path |
| C-14 | "#530/#531 class" for bare-file-name keying (brief) | Neither issue describes the collision; the collision is real (backend uniqueness `(user, character_avatar, file_name)`, `models/chat.py:56-62`; rename re-keys only `wiFiredByFile`) and unfiled | File it; cite it, not #530/#531 |
| C-15 | "`worldStore`" (E3-S1 task 2) | `worldInfoStore` | Fix name |
| C-16 | "unused params are ignored by the backend" (`generationStore.ts:12-13`) | True for the anthropic/google families (they drop them); the openai family forwards everything, tolerance unverified | Reword the comment in E3-S3 |
| C-17 | "the chat panel" (E3 epic) | `ChatStyleModal` today; `ChatSettingsPanel` under this spec | Name it |
| C-18 | "connection profile" page implies per-character provider (E7-S2) | provider/model are global-only; profiles are fill-in sources (§3.1, D5) | Card to say sampler-only unless D5 flips |
