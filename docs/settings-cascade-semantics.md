# Settings cascade semantics — global → character → chat

**Status:** DRAFT for red-team (E3-S1) · **Date:** 2026-09-25
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

Within the Character level, two sources can exist for the same field (a card field and a character customization). Order: **character customization > card field (when its `respectCharacter*` toggle is on) > global.** This is today's order for the main prompt (`chatStore.ts:1558-1562`: linked style > card override > user prompt > fallback), so migration preserves behaviour.

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

**Recommendation: A, with D as the v1 UI state until A ships.** Rationale: `budgetTokens` is already the precedent for "client sends the resolved value"; A makes the request pin the turn's inputs (E5-S2's replay needs that); B cannot see a chat-level value if v2 adds one and silently depends on the sync section being current. Cost: backend `RetrievalContextIn.scan_depth: int | None` (alias `scanDepth`, `ge=1, le=50` matching `setScanDepth`'s clamp), `_activation` uses it in place of `DEFAULT_SCAN_DEPTH` for the per-entry fallback (`:511`) and the recall window (`retrieval.py:280`), and the DTO **echoes `appliedScanDepth`**; frontend sends `wi.scanDepth.value`, records it on `ServerActivationFacts` (`promptBreakdown.ts`), and renders "applied (server)" only when the echo is present — an older backend returns no echo, so the UI keeps saying "server uses 4". Two PRs, backend first. **This is a cross-repo contract and is a §8 escalation trigger for the implementing story** (`run-story` §8 "Cross-repo contract"); it should be its own small story (proposed E3-S3b, §9 D8), not folded into E3-S3's store refactor. *Alternative:* B — one backend PR, no contract, and the UI stays at D forever for chat-level values.

**`maxRecursionSteps` cannot be sent:** the server engine has no recursion (`_activation.py:54-58`). Its v1 state is permanently "server-fixed: none" on server-path turns. The default is 3 (`worldInfoStore.ts:264`), so **default users get recursion on Regenerate/swipe/continue and none on send** today. The UI says so (§7.5).

**Tokenizer profile** is not user-settable (the roadmap's own note under E3-S1) and stays out of the cascade; the budget preview is labelled a client-side estimate (§7.5).

---

## 3 · Setting inventory and level matrix

Columns: **v1** = customizable in v1 · **Levels** = where a customization may live (G = global only) · **Solo / Group / Server** = honoured by that path · **Honest-state rule** = what the UI must say when the effective value is not what ran. Row order follows the Generation page's tabs, then the rest.

| Group · field(s) | v1 | Levels | Solo | Group | Server-path turn | Honest-state rule / why a level is not allowed |
|---|---|---|---|---|---|---|
| **Sampler:** temperature, maxTokens, topP, topK, minP, frequency/presence/repetition penalty, stopStrings | yes | G, C, Ch (per field) | yes | yes | n/a | Badge `provider-dropped` per field for the active family (§2.2b); `model-omitted` for Claude ≥ 4.7. `maxTokens` here is the `max_tokens` sent, distinct from `context.maxTokens`. |
| **Prompts:** mainPrompt, jailbreakPrompt, postHistoryInstructions | yes | G, C, Ch | yes | **inert** (`group-builder`) | n/a | Group: badge inert. Character level has two sources for mainPrompt/PHI: customization > card field (if respected). |
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
| **Card fields:** system_prompt, post_history_instructions, depth_prompt, talkativeness | sources | C (card) | yes | inert (except talkativeness) | — | Read by the resolver as character-level *sources*; not duplicated into the map. |
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

### 6.1 Signature and return shape

```ts
// src/utils/settingsCascade.ts (new; pure over store snapshots)
interface ResolveContext {
  characterAvatar?: string;        // solo: the character; group: the speaking member (v1 ignores it in group, §6.3)
  chatFile?: string | null;
  chatKind: 'solo' | 'group';
  seam: PromptCaptureSeam | 'preview';   // 'send'|'swipe'|'continue'|'impersonate'|'regenerate'|'group' (utils/promptCapture.ts)
  provider: string; model: string;       // from getProviderAndModel(), passed in — the resolver must not call it (it has side effects)
}
type Level = 'global' | 'character' | 'chat';
type Source = Level | 'card';
type Applicability =
  | { kind: 'applies' }
  | { kind: 'inert'; reason: 'group-builder' | 'provider-dropped' | 'model-omitted' | 'action' | 'tokenAware-off' | 'text-mode-broken' }
  | { kind: 'server-fixed'; serverValue: number | 'none'; when: 'predicted' };  // only meaningful for wi.* on eligible solo chats
interface Resolved<T> { value: T; source: Source; applicability: Applicability }
interface EffectiveSettings {
  sampler:  { [K in keyof SamplerParams]: Resolved<SamplerParams[K]> };
  prompt:   { mainPrompt: Resolved<string>; jailbreakPrompt: Resolved<string>; postHistoryInstructions: Resolved<string> };
  context:  { [K in keyof ContextConfig]: Resolved<ContextConfig[K]> };
  pureChat: Resolved<boolean>;
  wi:       { scanDepth: Resolved<number>; maxRecursionSteps: Resolved<number>; tokenBudget: Resolved<number> };  // source is always 'global' in v1
  engine:   { predicted: 'server' | 'client' | 'n/a'; reasons: string[] };   // from isChatEligibleForServerRetrieval + seam; 'n/a' for group
  // Plain, un-annotated projections for the builders (identity-by-reference when nothing is customized — §6.6):
  plain: { sampler: SamplerParams; prompt: PromptConfig; context: ContextConfig; instruct: InstructConfig };
}
export function resolveEffectiveSettings(ctx: ResolveContext): EffectiveSettings;
```

`instruct`, `promptOrder`, `showExactPrompt`, provider/model and every G-only field are returned as `source: 'global'` for display; the builders keep reading them from the store because they are not customizable in v1 and one of them (`instruct`) is read inside the frozen helper.

### 6.2 Where it is called — once per turn

Each of the six seam functions resolves **once**, before anything reads settings, and threads the snapshot:

| Seam function | Today reads | Under this spec |
|---|---|---|
| `sendMessage`, `impersonate`, `editMessageAndRegenerate`, `swipeRight`, `continueMessage` | `prepareConversationContext` reads `useGenerationStore.getState()` (`:1305`) and `wiState.scanDepth/maxRecursionSteps/tokenBudget` (`:1382-1384`); `finishConversationContext` reads `genState.context` (`:2037`); `getGenerationOptions()` reads `sampler`/`instruct`; `tryServerRetrieval` reads `tokenBudget` (`serverRetrieval.ts:558`) | `const eff = resolveEffectiveSettings(ctx)` at the top; `prepareConversationContext(..., eff)` and both `finishConversationContext` passes (probe `commit:false` + commit) receive the **same** `eff`; `getGenerationOptions(eff.plain)`; `tryServerRetrieval(avatar, file, eff.wi.tokenBudget.value)` (and `eff.wi.scanDepth.value` once §2.3-A ships) |
| `generateGroupTurn` | `buildGroupConversationContext` reads `wiState.*` (`:2518-2520`); `getGenerationOptions()` (`:3397`) | same shape; `chatKind: 'group'` |

R3 §4's requirement is met: solo seams run `prepare` once and `finish` twice; both passes and the server budget read see one snapshot, so a store change mid-turn cannot split a turn. `maybeApplyInstructMode` and `dispatchWithCapture` are **untouched** (E2-S3 seams stay closed). `getGenerationOptions` lives in `utils/llm/resolve.ts`, outside the frozen helper, and takes the snapshot as an argument; its only callers are the six seams (grep of `src/`, 2026-09-25), so the no-argument form goes away.

`PromptBreakdown` fields that E2-S4's `insightsApi.ts` consumes (`wi.budget`, `wi.activationSource`, `wi.server.*`, `flags.*`) keep their meaning: `wi.budget` stays "the value the scan used", which is why the resolver must *feed* the builder rather than run beside it. New fields are additive: `wi.scanDepth` (client turns), `ServerActivationFacts.scanDepthRequested` and, after §2.3-A, `appliedScanDepth`.

### 6.3 What replaces the `ChatView` overwrite effects

Both effects (`ChatView.tsx:833-871`) are deleted. `loadPresetTransient`, `restoreDefault`, `samplerSnapshot`, `loadTemplateMainPromptTransient`, `restoreDefaultMainPrompt` and `mainPromptSnapshot` have no callers outside those effects and their own stores (grep of `src/` excluding tests, 2026-09-25); they are removed after migration (§6.4). The builder's `linkedStyleActive = mainPromptSnapshot !== null` (`chatStore.ts:1497-1498`) — which makes a linked style beat the card's `system_prompt` and suppress the card PHI (`:1511`, `:1558-1560`) — becomes "`prompt.mainPrompt.source` is `character` or `chat`". Same truth table, one source of truth. The golden fixture that simulates a linked style by setting `mainPromptSnapshot` directly (`promptGoldens.fixtures.ts:1232`) is re-expressed as a chat-level `mainPrompt` customization; its expected output does not change. `setSampler`'s mirroring into `activePresetId` **stays**: with no transient load setting `activePresetId` to a linked preset, the hazard R3 §1.5 describes disappears while Generation-page behaviour for a user with no customizations is unchanged. `loadPreset` keeps setting `activePresetId`/`defaultPresetId`; `defaultPresetId` is no longer read at resolution.

**Group:** v1 resolves Global + Chat only in group (`characterAvatar` ignored for customizations; card sources are not read in group today either). Character links do not apply in group today (`selectedCharacter` null), so this is behaviour-preserving. Per-speaker character customization is v2 (§9 D4).

### 6.4 Persistence slots and migration

**Character level → new section `stm_character_settings`**, a user-scoped map `{ [avatar]: Partial<CustomizationFields> }` owned by a new `characterSettingsStore`. Rationale (§9 D1 gives the alternative): 1:1 with the existing user-scoped link maps (`linkedPresetByAvatar`, `linkedTemplateByAvatar`) so migration needs no ownership rule; a **new** section is invisible to older bundles, which never PUT it, so it does not inherit #536; no export-format or permission surface (a global-visibility character is seen by every user per `characterOwnershipStore.ts`'s header comment — not re-verified against the current backend; a card slot would make one user's settings everyone's). Cost: does not travel with export; the wizard must **stage** writes until `createCharacter` returns (precedent: `InterviewReview.tsx` stages lore and commits after create). Card-carried settings are deferred to E8-S3's schema design.

Card fields (`system_prompt`, `post_history_instructions`, `extensions.depth_prompt`, `extensions.talkativeness`) stay on the card and round-trip as today: `CharacterEdit.tsx:263` passes `extensions` through; `buildCardData` (`client.ts:302-348`) spreads unknown extension keys and recomputes only `depth_prompt`/`talkativeness`; `characterToCardV2` spreads `data.extensions`; V2/V3 import spreads them back (`cardToCharacterInfo`), while **`cardToCharacterInfo`'s V1 / simple-JSON branch rebuilds `extensions` from only `depth_prompt` and `talkativeness`** (`characterCard.ts:468-471`).

**Chat level → the chat header**, `Chat.messages[0]`, key `settings` beside `author_note` and `wi_fired`. It is the only per-chat slot keyed by the real row `(user, character_avatar, file_name)` (`app/models/chat.py:56-62`); every other per-chat slot is keyed by bare file name, unique only per character. Pattern: hydrate on `loadChat` / `loadGroupChat` (as `wi_fired` is, `chatStore.ts:4888`, `:4911`) into an in-memory `chatSettingsByKey` map keyed `${avatar}\u0000${file}`; re-emit in `buildChatPayload` (`:3690-3696`); re-key in `renameChat` (which today re-keys only `wiFiredByFile`, `:5621-5624`); drop in `deleteChat`. The backend treats `messages` as opaque JSONB — no backend change. Costs to state: a customization on a chat with no saved row needs a save (`saveChat` exists; E3-S4 triggers it on write); #530 (a failed load leaves `currentChatFile` naming a chat whose data never loaded — reads must key off the loaded row's identity, not `currentChatFile`); group rows are keyed by roster slot 0 (#458, #506, #507, be#84 all OPEN), so a header-stored group customization forks with the row. `author_note` is written to the header and **never read back** (`loadChat` hydrates only `wi_fired`) — the new read path is the first one, and E3-S4 should hydrate `author_note` through it too (§9 D7). *Alternative:* a new section `stm_chat_settings` keyed `${avatar}::${file}` — fixes the cross-character collision, not rename orphaning or group identity, and merges at whole-map granularity across devices.

**Migration (runs once per client after all three stores' `fetchPrefs` resolve; idempotent; legacy keys read as a fallback until removed):**

| Legacy | Becomes |
|---|---|
| `linkedPresetByAvatar[a] = id` | `stm_character_settings[a].sampler = { ...presets[id].sampler }` (values copied; the id is dropped) |
| `linkedTemplateByAvatar[a] = id` | `stm_character_settings[a].prompt.mainPrompt = templates[id].prompt.mainPrompt` |
| `linkedPresetByChatFile[f] = id` / `= CHAT_STYLE_NONE` | chat slot sampler fields = preset values / every sampler field = `global` marker — **lazily, on the first `loadChat(avatar, f)`** that finds a legacy key and no header `settings` (the client cannot map a bare file name to a row otherwise); first loader wins; the legacy key is deleted after materialization |
| `linkedTemplateByChatFile[f]` (id / NONE) | chat slot `mainPrompt` = template text / `global`, same lazy rule |
| `chatCompanionModeByChatFile[f] = true` | chat slot `pureChat = true`, same lazy rule |
| `mainPromptSnapshot !== null` | `prompt.mainPrompt = snapshot`, then null — the transient was persisted mid-chat |
| `samplerSnapshot !== null` and no `defaultPresetId` | `sampler = snapshot`, then null (today's `restoreDefault` semantics) |
| Card `system_prompt` / PHI | no migration; read as character-level sources |
| Wizard "Save preset & link" (`CharacterSetupWizard.tsx` `handleSaveAndLink`: global `setSampler` first, then `savePresetAndLink`) | rewritten to write `characterSettingsStore.set(avatar, { sampler })` only; the global write is removed. "Apply globally instead" keeps calling `setSampler`. "Save & link template" writes the character `mainPrompt`; "Set on card" keeps writing the card field |

The legacy maps stay in `PersistedShape` during the transition so an older bundle's whole-section PUT (#536) cannot resurrect a migrated link as new; a follow-up story removes them.

### 6.5 What each store changes

| Store | Change |
|---|---|
| `generationStore` | Stops being overwritten. Remove `loadPresetTransient`, `restoreDefault`, `samplerSnapshot` after migration. Keep `presets`, `loadPreset`, `setSampler` (with mirroring), `defaultPresetId` (unused at resolution). `linkedPresetByAvatar/ByChatFile` become read-only legacy until removed. |
| `promptTemplateStore` | Remove `loadTemplateMainPromptTransient`, `restoreDefaultMainPrompt`, `mainPromptSnapshot`; `chatCompanionModeByChatFile` and `linkedTemplateBy*` become legacy. Templates remain fill-in sources. |
| `characterSettingsStore` (new) | `set(avatar, patch)`, `clear(avatar, field)`, `clearAll(avatar)`, `stage(patch)` / `commitStaged(avatar)` for creation-time writes; own section, own `fetchPrefs`. |
| `chatStore` | `chatSettingsByKey` map + hydrate / emit / re-key / drop; `setChatCustomization(key, patch)` / `clear` / `clearAll`; `prepare`/`finish`/group builder take the snapshot; the six seams resolve once. |
| `worldInfoStore` | No storage change. `scanDepth`/`maxRecursionSteps`/`tokenBudget` are read *through* the resolver so the display can annotate them. |
| `personaStore` | Untouched (§2.1). |
| `settingsStore` | Untouched; provider/model stay global. |

### 6.6 Test plan

- **Golden neutrality (identity):** with no customization anywhere, `resolveEffectiveSettings(ctx).plain.sampler` **is** (`toBe`) `useGenerationStore.getState().sampler`, and likewise `prompt`, `context`; the 133 goldens under `src/stores/__goldens__/` (driven by `promptGoldens.test.ts`, which sets `generationStore` directly) must stay byte-identical with the resolver wired in. Fixtures that set a legacy mechanism's state directly (`mainPromptSnapshot` at `promptGoldens.fixtures.ts:1232`; `chatCompanionModeByChatFile` at `:1193`) are rewritten to set the equivalent customization; the expected files are not touched. This is the E3 epic's "zero regressions" gate.
- **Precedence, deterministic:** for each customizable field × {G, C, Ch, Ch=`global`} truth table: chat beats character beats global; `global` marker skips character; card `system_prompt` loses to a character `mainPrompt` customization and to a chat one, wins over global only when `respectCharacterOverride` is on.
- **Single-snapshot-per-turn:** a store mutation between `prepare` and the committing `finish` does not change the emitted prompt (pin with a fake store write in the test).
- **Round-trip:** set → `persist` → reload store from the persisted shape / from a saved chat payload → resolve → same value; at character level across the new section; at chat level through `buildChatPayload` → `loadChat` hydration; `renameChat` carries it; `deleteChat` drops it.
- **Migration:** each legacy row above → expected slot; idempotent on a second run; `CHAT_STYLE_NONE` → `global` marker; a chat whose header already has `settings` is not re-migrated.
- **Applicability:** `provider-dropped` table pinned per family (a client-side mirror of `anthropic.py` / `google.py`'s accepted keys, dated in a comment — drift risk, so pin it); `model-omitted` mirrors `modelRejectsSamplers`; `engine.predicted` agrees with `isChatEligibleForServerRetrieval` for each disqualifier.
- **Mutation-verify** (house rule): the cheapest wrong resolver — "always return global" — must fail the precedence table; "resolve per read" must fail the single-snapshot test.

### 6.7 Rollout order and the E3-S3 risk list

Recommended order (re-sequences the cards; §9 D2): **E3-S3 task 1** (resolver + character-level store + migration + effect removal; Opus; trigger-tier review) → **E3-S2** (indicators + "in effect" panel, now truthful) → **E3-S3 task 2** (character page) → **E3-S3b** (scan-depth contract, §2.3) → **E3-S4** (chat panel + header slot + lore disclosure). Shipping E3-S2 first, on top of the overwrite mechanism, would make its indicators show transient values as global.

E3-S3 task 1 hits the §6.1 trigger "async store orchestration": the migration waits on three stores' `fetchPrefs` (order is not guaranteed; `authStore` fans them out) and writes three sections in three PUTs (not atomic — a partial migration must be re-runnable, hence idempotency and the legacy-read fallback); the character-level `fetchPrefs` must land before the first turn resolves or that turn silently resolves global (acceptable, must be tested, must not persist anything); `getProviderAndModel`'s side effects still write the global `context.maxTokens`; the Settings page now edits **only** global while a chat with customizations is open — a change from today's linked-preset mirroring, stated as a fix, not a regression, and shown by the §7.7 markers.

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

**Content:** the resolver's output for the **next** turn (a prediction: the engine line says "Next Send: server retrieval (eligible) — Regenerate / swipe / continue always use the client scan"), plus one header line from the **last** turn when `generationStore.lastPromptBreakdown` is for this chat: "Last turn: client scan · budget 1024 · claude profile" or "Last turn: server retrieval · budget 1024 (generic estimate) · scan depth 4". The two are labelled *Next* and *Last*; neither is presented as the other. `insightsApi.getTurnWiInsight` (E2-S4) is the read path for the last-turn facts; the panel does not import `breakdownBuckets`.

### 7.5 The "not applied on this turn (server retrieval)" state and the estimate label

Scoped to the **global** `scanDepth` and `maxRecursionSteps` (per-entry overrides are honoured by both engines). Two displays:

- *Prospective* (chat panel, Settings page when a chat is open): `Server-fixed` badge with "On Send in this chat the server uses scan depth 4 and no recursion; your values apply on Regenerate, swipe and continue." Shown only when `engine.predicted === 'server'`; on ineligible chats the values show `Inherited · global` and a one-line "client scan (reason: <first disqualifier>)".
- *Factual* (last-turn line, E4-S2 explainer): from `wi.activationSource` and, after §2.3-A, `wi.server.appliedScanDepth`; until then "server used its default (4)".
- **Budget preview** anywhere (ChatLorePanel header "~P / B pinned tokens", the chat panel): badge `Estimate` with the profile named; the last-turn line names `budgetEstimator: 'generic'` when the server ran (`ServerActivationFacts`).

### 7.6 Engine-switch disclosure (ChatLorePanel, E3-S4)

Header line under the budget: **"This chat uses the local scan"** + reason (first true disqualifier, in `isChatEligibleForServerRetrieval` order) + "Documents (Data Bank) cannot fire on the local scan; your scan depth and recursion apply." On the first customization that flips eligibility, the same text appears as a toast. When the last linked book and customization are removed: "This chat is eligible for server retrieval again." After "Reset all customizations": "Linked books kept — still local scan" when any remain.

### 7.7 Settings page opened over a chat

Settings → Generation edits **global** values only. When a chat is open, each row shows a marker when the effective value differs: `Customized · chat` / `Customized · Ivy (character)`, with a link "edit there". It never shows the resolved value in the control (that was the overwrite bug). The `ContextMeter`'s "· trimming" is hidden in group chats and when `tokenAware` is off (today it shows regardless, `ContextMeter.tsx:68`).

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
| "per-character generation settings **via cascade override rails**" · "wizard-set generation settings are literally character overrides (visible in E3's UI)" | §6.4, §6.5 | The sampler / prompt pages call `characterSettingsStore.set(avatar, patch)` (staged before `createCharacter` returns). What they write is what the character page (E3-S3) shows, badge `Customized`. |
| "Wizard P2 contains **zero** override mechanism of its own — it writes through E3's rails" | §6.4 migration row | The existing `CharacterSetupWizard` **is** a mechanism today (global `setSampler` then `savePresetAndLink`; `saveTemplateWithPromptAndLink`; card `system_prompt`). E3-S3 rewrites its two link paths onto the rails and removes the global write; "Set on card" stays a card write; "Apply globally instead" stays an explicit global write. E7-S2 copies that shape and adds nothing. |
| "connection profile" page | §3, §3.1, §9 D5 | Provider/model are global-only in v1; a profile applied in the wizard writes its **sampler** as character customizations and the page says "provider and model are global settings". If D5 goes the other way, the page also writes a character `provider`/`model` customization — but that needs every seam to honour it (v2). |
| "avatar/media settings" | §3 (extensions row) | Outside the cascade: those live in their own avatar-keyed stores (`motionModeStore`, `livePortraitStore`, `lovenseStore`). The wizard writes them through those stores; they are not "overrides" in E3's sense, so the zero-mechanism criterion does not cover them. |
| "lorebook defaults" | §4 | Book composition (`characterStore.setLinkedBookIds` / the owned book), not the cascade. #450 is OPEN, so the card's E4-S0 gate note stands only for the client engine's inability to fire keyless entries; the first-match claim it cites is stale (Appendix C-9). |
| "skipping every advanced page still yields a valid character" | §2.1 rule | Absence = inherit. The wizard must write **only fields the user touched**, never defaults as customizations; a skipped page writes nothing. |
| creation-time writes | §6.4 | `stage(patch)` before the avatar exists, `commitStaged(avatar)` after `createCharacter` — the `InterviewReview` staged-lore precedent. |

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
| E3-S4 "per-chat overrides survive reload" | §6.4 chat header hydrate/emit |
| E3-S4 "visibly badged in the chat UI" | §7.4 menu row + `Customized · chat` badges; `ChatOptionsMenu`'s "(custom)" label switches to the resolver's "any chat customization" (today it ignores pure-chat, `ChatView.tsx:2223`) |
| E3-S4 "reset restores the character/global value" | §7.3 |
| E3-S4 "setting a lore-scoped override discloses the engine switch, and clearing every lore override restores eligibility (test-pinned against `isChatEligibleForServerRetrieval`)" | §4, §7.6 — with the corrected facts (not permanent; Reset keeps links) |

### 8.4 E5-S1 / E5-S2

A finding about the WI budget names the level that owns the value (always `global` in v1 — the resolver's `source`). `EffectiveSettings.plain` is a serialisable snapshot E5-S2's replay rig can pin per turn; `clear(level, field)` is the revert operation distinct from "set to the inherited value".

---

## 9 · Decisions for Sammy, out of scope, risks

**Decisions** (each: recommendation → alternative):

1. **Character-level slot.** User-scoped section `stm_character_settings` → *alt:* card `data.extensions.ggbc.settings` (travels with export, shared by every user of a global character, no staging at create; needs an ownership/permission rule for shared characters and an export-format change).
2. **Rollout order.** E3-S3 task 1 first, then E3-S2 → *alt:* keep the card order and let E3-S2 ship a read-only resolver over the legacy maps (a second resolver to delete later).
3. **Presets/templates as fill-in sources (values copied).** → *alt:* by-reference links (`{ ref: id }`) resolved at read time — preserves "edit the preset, every linked chat follows", keeps the deleted-id case, and keeps the setSampler-mirroring hazard.
4. **Group = Global + Chat in v1.** → *alt:* per-speaker character customizations in group (new behaviour; sampler is the only group-honoured customizable group).
5. **Provider/model stay global in v1.** → *alt:* character-level provider/model (touches every seam, credentials, `getProviderAndModel`'s auto-switch, #515).
6. **Persona locks stay dormant, not adopted, not deleted.** → *alt:* delete `locks.byChat` + the four lock actions (persisted-shape change).
7. **Chat slot = chat header**, and E3-S4 also starts reading `author_note` back from it → *alt:* new `stm_chat_settings` section keyed `(avatar, file)`.
8. **Scan depth: send it (§2.3-A) as a separate small story E3-S3b**, backend first; UI badge until then → *alt:* backend reads `stm_worldinfo.scanDepth` (no contract, no chat-level future).
9. **Vocabulary: "customization"**, relabel "Prompt Overrides" → "Prompts" → *alt:* keep "override", rename the two colliding labels.
10. **Chat-level `global` marker kept** for lossless `CHAT_STYLE_NONE` migration → *alt:* drop the three-state; migrate NONE by materializing today's global values (they then stop following the global).

**Out of scope for E3 v1:** lore composition and its four assemblers; worlds as containers; persona as a level; per-character provider/model; prompt order, instruct, RAG, summary, extension settings at lower levels; author's note and group-record settings (own panels); avatar/media stores; unifying the 640/1024 breakpoints; removing the legacy link maps from `PersistedShape` (follow-up).

**Risks:** the migration is three non-atomic PUTs (§6.7); the `provider-dropped` table is a client mirror of backend code (pin + date it); the chat header slot inherits #530 and the group-identity issues (#458/#506/#507, be#84); any settings section edited by an older bundle can still drop keys (#536) — the new section avoids it only because older bundles never write it; the lazy chat migration assigns a colliding bare-name key to the first loader; `characterOwnershipStore`'s global-visibility comment was not re-verified against the current backend; provider-family sampler tolerance for the openai family is an unverified external claim (`generation.py:95-96` asserts it).

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
