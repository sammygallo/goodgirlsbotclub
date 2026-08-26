# Good Girls Bot Club — Feature Roadmap (historical)

> **Status: complete.** This document tracked the original feature build-out
> against the desktop character-chat ecosystem GGBC was originally inspired
> by. Phases 1–10 below are all shipped. The architectural follow-on —
> moving the app to its own backend (Option A: sync layer, then Option B:
> standalone full-stack) — is tracked separately under
> [`docs/v2/ROADMAP.md`](docs/v2/ROADMAP.md) and is also complete.

## Current State Summary

**Good Girls Bot Club** is a standalone full-stack character chat app:
- Auth + invitations + permission groups
- Character CRUD + import/export (character card v2/v3 PNG spec, JSON)
- Single & group chat with streaming (SSE)
- 6+ AI providers (OpenAI-compatible, Claude/Anthropic, Gemini, Mistral, Groq, OpenRouter, …)
- Expression/sprite system with emotion parsing
- Live-portrait MP4 generation via Replicate
- Extension SDK compatible with community-authored extensions (Live2d ships installed)
- World Info / Lorebooks with recursive scanning, timed effects, character-embedded books
- STscript slash-command engine
- Data Bank / RAG with embeddings
- Mobile-first dark theme

The "vs. ST" framing in older sections below reflects the original design constraints — the v2 sections (which are how new features get planned now) drop it.

---

## Gap Analysis & Roadmap (historical)

Features are grouped into **phases** ordered by user impact and dependency. Each phase builds on the previous.

---

## Phase 1: Chat Experience Foundations
*Goal: Make the chat feel complete and usable for daily use.*

### 1.1 Message Swiping (Alternate Responses)
- **Gap:** Mobile has no swipe/alternate response support.
- **ST Feature:** Generate alternative AI responses, navigate between them with arrows.
- **Work:** Store swipe array per message. Add swipe left/right UI (touch gesture + arrows). Hook into generate endpoint to append swipes. Persist swipes in chat JSONL.

### 1.2 Regenerate / Continue / Impersonate
- **Gap:** Mobile has basic `editMessageAndRegenerate` but no dedicated regenerate, continue, or impersonate.
- **ST Feature:** Ctrl+Enter regenerate, Alt+Enter continue (extend last AI message), impersonate (AI writes as user).
- **Work:** Add regenerate button (re-sends context, replaces last AI message). Add continue action (sends with last AI message as prefix, appends result). Add impersonate action (generates as user persona). Wire into chat input bar as action buttons.

### 1.3 Message Editing Improvements
- **Gap:** Basic edit exists but no inline editing, no edit-last-with-keyboard.
- **ST Feature:** Click-to-edit any message, up-arrow edits last, auto-save edits.
- **Work:** Inline edit mode on message tap. Add edit/delete per-message action menu. Save edits immediately to backend.

### 1.4 Streaming Improvements
- **Gap:** Basic SSE parsing works but no configurable streaming display.
- **ST Feature:** Configurable streaming FPS, smooth fade-in, token-by-token rendering.
- **Work:** Add smooth token rendering with configurable speed. Typing indicator while generating.

### 1.5 Chat File Management
- **Gap:** Can list/load/save chats but no rename, delete, export, or import chats.
- **ST Feature:** Full chat CRUD, export as JSONL/plaintext, import from multiple formats.
- **Work:** Add chat rename, delete, export (JSONL + plaintext). Import JSONL chats. UI for chat history browser.

---

## Phase 2: Character & Persona Depth
*Goal: Support the full character card spec and user personas.*

### 2.1 Advanced Character Fields
- **Gap:** Mobile has basic fields (name, description, personality, first_mes, scenario, mes_example, creator_notes, tags). Missing many advanced fields.
- **ST Feature:** Alternate greetings, character's note (with depth/role config), main prompt override, post-history instructions override, talkativeness, creator, version.
- **Work:** Add alternate greetings array with swipe UI on first message. Add character's note with depth/role selector. Add system prompt override fields. Store in Character Card V2 `data.extensions` properly.

### 2.2 User Personas
- **Gap:** No persona system. User is just "You" with a default avatar.
- **ST Feature:** Named personas with avatar, description, and description position. Persona locking to characters/chats. Default persona.
- **Work:** Create persona store. Persona CRUD UI. Persona selector in sidebar/header. Description injection into prompt at configurable position. Persona-character locking.

### 2.3 Character Tags & Organization
- **Gap:** Tags exist on characters but no filtering/organization UI.
- **ST Feature:** Tag-based filtering, tags-as-folders view, favorites, bulk operations.
- **Work:** Tag filter bar on character list. Favorite toggle. Sort options (name, date, recent chat). Search/filter characters.

### 2.4 Character Duplicate & Convert
- **Gap:** No duplicate or convert-to-persona.
- **ST Feature:** One-click duplicate, convert character to persona.
- **Work:** Add duplicate action. Add convert-to-persona action. Wire into character action menu.

---

## Phase 3: Prompt Engineering & Generation Control ✅ DONE
*Goal: Give users control over how prompts are built and how the AI generates.*

### 3.1 Sampler Parameters ✅
- Full sampler panel: temperature, max tokens, top P, top K, min P, frequency/presence/repetition penalty, stop strings.
- Presets: save named presets, load, delete. Persist in localStorage (`generationStore`).
- Params are sent through `generateMessage` to the backend; unused fields are stripped.

### 3.2 System Prompt / Main Prompt Editing ✅
- User-editable main prompt, jailbreak/auxiliary prompt, post-history instructions — all in Generation Settings.
- Character card overrides are still honored (togglable via checkboxes).
- All fields support the macro system.

### 3.3 Basic Macro System ✅
- `src/utils/macros.ts`: `{{char}}`, `{{user}}`, `{{persona}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{time}}`, `{{date}}`, `{{weekday}}`, `{{month}}`, `{{random[:a,b,c]}}`, `{{pick:a,b,c}}`, `{{roll:d6}}`, `{{lastMessage}}`, `{{lastUserMessage}}`, `{{lastCharMessage}}`, `{{model}}`, `{{newline}}`, `{{noop}}`.
- Applied in system prompt, all character card fields, and user prompt overrides.

### 3.4 Context Size Management ✅
- `src/utils/tokenizer.ts` with per-provider char-per-token heuristics (GPT ≈ 4.0, Claude ≈ 3.6, Llama ≈ 3.5, generic ≈ 3.8).
- Configurable max context tokens + response reserve.
- Token-aware trimming: keeps system prompts, drops oldest history to fit budget.
- Fixed-message-count fallback still available.
- Live token estimate surfaced in the Generation Settings header.

### 3.5 Instruct Mode (Text Completion APIs) ✅
- `src/utils/instructTemplates.ts` with 7 built-in templates: Alpaca, ChatML, Llama 3, Mistral, Vicuna, Metharme/Pygmalion, Raw.
- Toggle + template selector + extra stop strings in the Instruct tab.
- When enabled, chat messages are flattened into a single text-completion prompt with role prefixes/suffixes.

---

## Phase 4: World Info / Lorebook
*Goal: Enable persistent world-building context injection.*

### 4.1 Basic World Info ✅
- `src/stores/worldInfoStore.ts`: lorebook store with full CRUD for books and entries. Per-entry fields: keys, content, comment, enabled, constant, caseSensitive, position, depth, order. Configurable scan depth. Multiple books can be active at once.
- Keyword scanner (`scanMessagesForEntries`): joins the last N non-system messages into a haystack and matches entry keys (case-(in)sensitive). Constant entries bypass matching.
- `buildConversationContext` in `chatStore.ts` groups matched entries by position and injects into the prompt: `before_char`, `after_char`, `before_an`, `after_an`, and `at_depth` (interleaved with history). Macros (`{{char}}` etc.) run on entry content.
- UI at `/settings/worldinfo`: lorebook list with active toggle, rename, duplicate, delete, create, import, export; dedicated book editor with per-entry create/edit/enable/disable/delete.
- JSON import/export uses the community lorebook format (`{ entries: { uid: { key, content, position, order, ... } } }`) with position codes 0-4 mapped round-trip.

### 4.2 Advanced World Info ✅
- Secondary keys (AND/ANY/ALL/NOT logic) with per-entry selective toggle.
- Regex keys (keys wrapped in `/pattern/flags`).
- Configurable global scan depth + per-entry override.
- Probability activation (0–100% roll per entry).
- Token budget management (drop lowest-priority entries when over budget).
- Inclusion groups with weighted random selection and override flag.
- Recursive scanning (up to configurable max steps; prevent/exclude flags per entry).
- Timed effects: sticky (stay active N turns after trigger), cooldown (block re-trigger for N turns), delay (don't activate until N turns into chat). Timers persisted per chat in localStorage.

### 4.3 Character-Embedded Lorebooks
- **Gap:** N/A.
- **ST Feature:** Lorebooks embedded in character cards, auto-loaded on character select.
- **Work:** Read/write `data.character_book` from Character Card V2. Auto-activate character lore on selection. Support additional lorebook linking.

---

## Phase 5: Group Chat Enhancements
*Goal: Bring group chats to ST-level functionality.*

### 5.1 Activation Strategies ✅
- Three strategies selectable per group chat, persisted on the `GroupChatInfo` record:
  - **List** (default, legacy): every member replies in order on each user turn.
  - **Natural**: scans the last non-system message for a member name mention (word-boundary, case-insensitive). On match, that member replies; on multi-match, a weighted roll within the matches. With no mention, falls back to a weighted roll across the full pool. Weights come from `character.data.extensions.talkativeness` (string "0"–"1", default 0.5 when absent/invalid/out-of-range).
  - **Pooled**: weighted random pick, excluding the N most-recent distinct AI speakers (N configurable via slider, default 1). Pool-empty falls back to the full candidate set.
- Per-member **mute toggle** ships with 5.1 (partner to 5.2). Muted avatars are filtered out before speaker selection in every strategy.
- UI: collapsible controls panel in the group chat header with segmented strategy picker, pooled exclude-recent slider, and per-member mute list showing each member's current talkativeness.
- Manual trigger is deferred (tracked as a follow-up).

### 5.2 Group Chat Controls
- **Gap:** Can add characters, and mute toggle ships with 5.1. No reorder, force-talk, or auto-mode yet.
- **ST Feature:** Mute/unmute members, force individual response, auto-mode (continuous generation), character reordering, allow self-responses toggle.
- **Work:** Mute toggle per member ✅ (landed with 5.1). Force-talk button. Auto-mode with configurable delay. Drag-to-reorder member list. Group scenario override.

### 5.3 Character Card Handling in Groups ✅
- **SHIPPED 2026-04-11** in PR #59 (`b5938390`). `GroupCardMode = 'swap' | 'join'` on `GroupChatInfo`, legacy chats migrating to `'swap'`, the two-branch card block in `buildGroupConversationContext`, and a "Card mode" segmented picker in `GroupChatControls`.
- **Not built:** the "configurable prefix/suffix" half — join's `## ` header, `[SPEAKING NOW]` speaker marker and `---` separator are hard-coded. Deliberately not scheduled (roadmap v3 §1/§5); it would edit the group prompt builder ahead of E2-S2's golden fixtures.
- ⚠️ This section read "Gap: no join mode" for **four and a half months after it shipped**, and that claim reached roadmap v3 as story E9-S1, which blocked at intake on 2026-08-26.

---

## Phase 6: UI/UX Polish & Theming
*Goal: Match ST's customization depth while staying mobile-first.*

### 6.1 Theme System
- **Gap:** Single hardcoded dark theme.
- **ST Feature:** Full color customization, multiple themes, import/export themes, custom CSS editor.
- **Work:** CSS variable-based theme system. Light/dark mode toggle. Theme presets. Color customization UI. Theme import/export.

### 6.2 Chat Display Styles
- **Gap:** Single message display style.
- **ST Feature:** Flat (log), Bubbles (messenger), Document (compact). Avatar shapes. Font scale. Chat width.
- **Work:** Add style selector (flat/bubbles/document). Configurable avatar shape. Font size slider. Chat width control.

### 6.3 Mobile-Specific UX
- **Gap:** Basic mobile layout exists but needs refinement.
- **ST Feature:** Responsive panels, gesture navigation, mobile-optimized controls.
- **Work:** Swipe gestures for sidebar toggle. Pull-to-refresh. Bottom sheet for actions. Haptic feedback. Better keyboard handling. Landscape mode support. PWA install prompt.

### 6.4 Visual Novel Mode
- **Gap:** Sprites show in a small area during chat.
- **ST Feature:** Full visual novel mode with central sprite display, backgrounds, multi-character layout.
- **Work:** VN mode toggle. Full-screen sprite display behind chat. Background image support. Multi-character sprite positioning in group chats. Sprite costume system (`/costume` command equivalent).

### 6.5 Message Formatting & Markdown ✅
- `src/components/chat/MarkdownContent.tsx`: `marked` (GFM + breaks) → DOMPurify → dangerouslySetInnerHTML pipeline. `highlight.js/lib/common` for fenced code syntax highlighting with copy button. RP segment parser shelters `*action*` / `{{thought}}` from the markdown pass so they render as italic/tinted spans rather than markdown emphasis.
- Both user and AI messages now route through `MarkdownContent` — bold, italic, strikethrough, code, blockquotes, tables, headings all work in both directions.
- Streaming: unclosed code fences auto-closed before parse; blinking cursor appended to last segment.
- CSS in `index.css`: paragraph spacing, headers, blockquotes, lists, inline/fenced code, GitHub-Dark hljs theme, streaming cursor animation.

---

## Phase 7: Extensions Core
*Goal: Build the extension infrastructure and implement high-value extensions.*

### 7.1 Extension System Architecture
- **Gap:** No extension system.
- **ST Feature:** Modular extension loading, enable/disable, install from URL.
- **Work:** Design extension interface (hooks, slots, settings). Extension registry and loader. Extension settings UI. Enable/disable toggles.

### 7.2 TTS (Text-to-Speech)
- **Gap:** No TTS.
- **ST Feature:** 18+ TTS providers, per-character voice, auto-narrate.
- **Work:** Start with browser SpeechSynthesis API + Edge TTS + ElevenLabs. Per-character voice assignment. Play/stop controls on messages. Auto-narrate toggle.

### 7.3 Image Generation
- **Gap:** No image generation.
- **ST Feature:** 20+ backends, multiple generation modes (character portrait, scene, background).
- **Work:** Start with OpenAI DALL-E + Stable Diffusion API. Generate from message context. Display inline in chat. Save to gallery.

### 7.4 Chat Translation
- **Gap:** No translation.
- **ST Feature:** Translate messages to/from different languages.
- **Work:** Add translation via LLM or dedicated translation API. Per-message translate button. Auto-translate incoming/outgoing toggle.

### 7.5 Summarization
- **Gap:** No summarization.
- **ST Feature:** Auto-summarize chat history for context compression.
- **Work:** Periodic summary generation using active LLM. Summary injection at configurable depth. Manual trigger. Summary display in UI.

---

## Phase 8: Advanced Features
*Goal: Power-user features that complete the parity picture.*

### 8.1 Author's Note
- **Gap:** No Author's Note.
- **ST Feature:** Persistent instruction injected at configurable depth in context. Editable per-chat.
- **Work:** Author's Note input field. Configurable insertion depth and role. Persist per-chat. Quick-edit access.

### 8.2 Regex Scripts
- **Gap:** No regex processing.
- **ST Feature:** Find/replace regex on input/output, display-only or permanent, per-character scoping.
- **Work:** Regex script store. CRUD UI. Scope selection (user input, AI output, display-only, permanent). Ordering and enable/disable. Import/export.

### 8.3 Quick Replies
- **Gap:** No quick replies.
- **ST Feature:** Configurable single-click responses, automation triggers, STscript integration.
- **Work:** Quick reply preset system. Button bar above chat input. Support text macros in quick replies. Auto-execute triggers (on AI message, on chat load).

### 8.4 Connection Profiles ✅
- `src/stores/connectionProfileStore.ts`: localStorage-backed profile store (`stm:connection-profiles`). Each profile captures provider, model, optional customUrl, and full sampler params. CRUD: save current config, delete, rename.
- Settings → Connection Profiles section: saved profiles listed with one-tap apply (writes to settingsStore + generationStore simultaneously), inline rename, delete. Name input + Save button to snapshot current config.

### 8.5 Data Bank / RAG
- **Gap:** No RAG/vector storage.
- **ST Feature:** Document upload, vectorization, semantic retrieval, multi-scope data banks.
- **Work:** Document upload and chunking. Embedding via API (OpenAI embeddings). Vector similarity search. Inject relevant chunks into context. Per-character and global scopes.

### 8.6 Chat Branching & Checkpoints
- **Gap:** No branching.
- **ST Feature:** Create checkpoint at any message, branch into alternate story paths, navigate between branches.
- **Work:** Branch data model (tree structure). Create branch action on messages. Branch navigator UI. Branch naming.

### 8.7 Basic STscript / Slash Commands
- **Gap:** No scripting.
- **ST Feature:** Full STscript language with 100+ commands.
- **Work:** Implement command parser for `/` prefix. Start with core commands: `/sys`, `/send`, `/sendas`, `/trigger`, `/gen`, `/continue`, `/swipe`, `/persona`, `/go`, `/bg`. Pipe system for chaining. Variable get/set.

---

## Phase 9: Prompt Manager & Advanced Prompt Control
*Goal: Full prompt engineering capabilities.*

### 9.1 Prompt Manager UI
- **Gap:** No prompt manager. Fixed prompt structure.
- **ST Feature:** Drag-and-drop ordering of all prompt elements, toggle visibility, custom prompt slots.
- **Work:** Visual prompt order editor. Drag-and-drop reordering. Enable/disable per prompt section. Custom prompt insertion points.

### 9.2 Prompt Templates & Presets
- **Gap:** No presets.
- **ST Feature:** Save/load prompt configurations, share presets.
- **Work:** Preset save/load system. Import/export presets. Built-in starter presets.

### 9.3 Full Macro System
- **Gap:** Only core macros from Phase 3.
- **ST Feature:** 100+ macros including conditionals, variables, math, chat history queries.
- **Work:** Extend macro parser with: `{{if}}`/`{{else}}`/`{{/if}}`, `{{getvar}}`/`{{setvar}}`, `{{random}}` with full syntax, `{{lastMessage}}`, `{{lastCharMessage}}`, `{{lastUserMessage}}`, `{{maxPrompt}}`, `{{model}}`, `{{isMobile}}`.

---

## Phase 10: Additional API Backend Support
*Goal: Support the full range of AI backends that ST users expect.*

### 10.1 Local Model Support
- **Gap:** No local model support.
- **ST Feature:** KoboldCpp, llama.cpp, Ollama, Oobabooga, TabbyAPI.
- **Work:** Add OpenAI-compatible custom endpoint configuration (covers Ollama, LM Studio, llama.cpp server, KoboldCpp, etc.). URL + optional API key input. Model list auto-fetch where supported.

### 10.2 Additional Cloud Providers — mostly shipped
- **SHIPPED 2026-04-11** in `ecf1f90e` (nineteen minutes after the 5.3 commit): DeepSeek, Cohere and Perplexity. `src/api/providerCatalog.ts` now carries 44 provider entries including `deepseek`, `cohere`, `perplexity` and `fireworks`.
- **Actually remaining, and it is not "add providers":** none of the shipped providers has a `profileForProvider` case (`src/utils/tokenizer.ts:33-46` maps only `openai`/`groq`/`mistralai`/`openrouter`/`claude`/`makersuite`), so every one of them silently falls through to the `generic` 3.8 chars-per-token profile — over-pricing history and shrinking the usable context window with no visible error. AI Horde exists only as an image backend. Tracked as roadmap v3 **E9-S3**, re-scoped accordingly.

### 10.3 Text Completion API Support ✅
- **SHIPPED before roadmap v3** (verified in code 2026-08-24): `CompletionMode = 'chat' | 'text'` (`generationStore.ts:94`), `isTextCompletionMode()` through all six generate paths, client posting `body.prompt`, backend route live.
- ⚠️ The stale "Gap" line below is what carried into roadmap v3 as story E9-S4 and had to be withdrawn.
- **Superseded Gap:** Only chat completion format.
- **ST Feature:** Full text completion support for local models.
- **Work:** Text completion request builder. Instruct mode integration. Context template system. Model-specific tokenizer selection.

---

## Priority Matrix

| Phase | Impact | Effort | Priority |
|-------|--------|--------|----------|
| 1. Chat Experience | Very High | Medium | **P0 - Do First** |
| 2. Character & Persona | High | Medium | **P0 - Do First** |
| 3. Prompt Engineering | High | Medium | **P1 - Essential** |
| 4. World Info | High | Large | **P1 - Essential** |
| 5. Group Chat | Medium | Medium | **P2 - Important** |
| 6. UI/UX Polish | High | Medium | **P1 - Essential** |
| 7. Extensions | Medium | Large | **P2 - Important** |
| 8. Advanced Features | Medium | Large | **P3 - Nice to Have** |
| 9. Prompt Manager | Medium | Medium | **P2 - Important** |
| 10. API Backends | Medium | Medium | **P2 - Important** |

---

## Recommended Execution Order

```
Phase 1 (Chat Experience) ──────────┐
Phase 2 (Characters & Personas) ────┤── Sprint 1-3: Core UX
Phase 6.5 (Markdown Rendering) ─────┘

Phase 3 (Prompt & Generation) ──────┐
Phase 6.1-6.2 (Themes & Styles) ────┤── Sprint 4-6: Customization
Phase 10.1 (Custom Endpoints) ──────┘

Phase 4 (World Info) ───────────────┐
Phase 5 (Group Chat) ───────────────┤── Sprint 7-9: Depth Features
Phase 8.1-8.2 (Author's Note, Regex)┘

Phase 7 (Extensions) ──────────────┐
Phase 8.3-8.6 (Quick Replies, RAG) ┤── Sprint 10-12: Extensions
Phase 9 (Prompt Manager) ──────────┘

Phase 8.7 (STscript) ──────────────┐
Phase 10.2-10.3 (More APIs) ───────┤── Sprint 13+: Power User
Phase 6.3-6.4 (Mobile UX, VN Mode) ┘
```

---

## What Mobile Should NOT Replicate

Some ST features are desktop-specific or inappropriate for mobile:

- **MovingUI drag-and-drop panels** - Not suited for touch interfaces
- **Server plugins (Node.js)** - Mobile is a client-only app
- **Custom CSS editor** - Too complex for mobile; use theme presets instead
- **Full STscript IDE** - Support running scripts, but editing is better on desktop
- **Server administration** - Config.yaml editing, user management should stay server-side
- **Extension installation from URL** - Security risk on mobile; curate a built-in set

---

## Metrics for "Feature Parity"

True 100% parity is neither achievable nor desirable for mobile. Target:

- **Core Parity (Phases 1-4):** Users can have the same quality conversations with the same characters using the same context/lore. **Target: 100%**
- **Customization Parity (Phases 5-6):** Users can personalize their experience. **Target: 80%**
- **Extension Parity (Phase 7):** Most-used extensions work. **Target: 60%** (TTS, image gen, translation, summarization)
- **Power User Parity (Phases 8-10):** Advanced features available. **Target: 50%** (regex, quick replies, connection profiles, RAG)
- **Scripting Parity (STscript):** Basic command execution. **Target: 30%** (run scripts, not write them)
