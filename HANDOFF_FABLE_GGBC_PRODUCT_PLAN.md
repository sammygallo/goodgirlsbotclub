# Handoff Document: GGBC Product Planning & Roadmap Organization

**Date:** 2026-08-24  
**From:** Sammy (via Haiku)  
**To:** Fable  
**Task:** Plan next phase of GGBC; organize work into Epics/Stories/Tasks on Kanban board; delegate to Agent teams

---

## Context: Session Goals

Sammy brainstormed six major feature initiatives and one architectural deep-dive. Goal: consolidate into a coherent product roadmap with clear phasing, dependencies, and ownership model for multi-agent execution.

---

## Currently Active Work (In Flight / Open)

**Important:** The roadmap should account for and sequence around these active initiatives:

### Phase 6.1: Theme Customization (Pickup)
- **Status:** 8 CSS vars + 6 presets exist; partial implementation complete
- **Remaining:** Color picker editor, custom theme CRUD, import/export, gallery UI
- **Recommendation:** Could ship in parallel with new initiatives or be deferred; lowest priority on current roadmap

### Phase 10.1: Local Model Support
- **Status:** In flight; PR #58 on `claude/local-models` branch
- **Details:** Frontend UX polish (5 preset buttons, test connection, model-list auto-fetch, CORS-aware help)
- **Recommendation:** Complete + merge before Phase 10.2 begins; clean up any loose ends

### Character Selfies Feature
- **Status:** Phase A MERGED + DEPLOYED 2026-08-19 (#67/#428/#426)
- **Phase A:** Gate + both tiers + in-chat trigger + manual modal + fal nano-banana BYO + closeup-only auto-trigger
- **Phase B:** Needs output-side gate (NCII compliance for real-person detection)
- **Phase C:** LoRA build + attested upload
- **Recommendation:** Phase B is compliance-critical; should be prioritized alongside Phase 10.2+ work or fast-tracked as separate track

### Phase 5.3: Swap vs Join Card-Handling
- **Status:** Not started; small, isolated feature
- **Details:** No `cardMode`/`swapMode`/`joinMode` in codebase
- **Recommendation:** Quick win; can be added to any phase as filler work or combined with another small initiative

---

## New Feature Initiatives (This Session)

All documented in `/Users/sammy/.claude/projects/-Users-sammy-Documents-GitHub-goodgirlsbotclub/memory/`:

### 1. **Character Creator Wizard — Advanced Settings** (`project_character_wizard_advanced.md`)
- Extend wizard to cover advanced settings
- **Primary focus:** Creator Notes HTML editor with live preview
- Phases: Rich-text editor → Advanced settings coverage → Optional AI suggestions
- **Why:** Better Creator Notes → more engaging user experience, premium tier opportunity
- **Dependencies:** Builds on existing character creation flow (PR #369–#371, deployed 2026-08-09)

### 2. **Token Breakdown Analysis** (`project_token_breakdown_analysis.md`)
- Per-turn visualization of token spend (pie chart: system/WI/history/character/etc.)
- "Show prompt" toggle for transparency
- **Why:** Make token spending transparent; help users debug and optimize
- **Depends on:** Extends existing token usage feature (PR from 2026-06-28)
- **Tied to:** Settings Optimization Agent (below)

### 3. **Settings Optimization Agent** (`project_settings_optimization_agent.md`)
- Client-side AI agent audits character + world + chat settings
- Detects: unused WI, redundant entries, oversized prompts, budget misalignment
- Suggests trade-offs with impact estimates (e.g., "Archive this WI (save 450 tokens)")
- Iterative loop: user feedback → setting tweaks → A/B comparison
- **Why:** Power users want data-driven optimization; reduces token waste
- **Pairs with:** Token Breakdown Analysis

### 4. **Memory Pane Consolidation** (`project_memory_pane_consolidation.md`)
- Unified `/settings/memory` combining World Info + Lorebooks + Data Bank
- Shared search, unified CRUD, clearer scoping
- Phases: Unified pane → Scope clarity → Advanced organization (folders, cross-linking)
- **Why:** Scattered memory settings confuse users; consolidation clarifies mental model
- **Dependencies:** Lorebook v2 (shipped 2026-08-05); Data Bank RAG (PR #57, shipped)

### 5. **Settings Cascade Redesign** (`project_settings_cascade_redesign.md`)
- Clarify hierarchy: Global defaults → Character overrides → Chat-level overrides
- New UI in Settings, Character editor, and in-chat
- Phases: Clarify hierarchy & defaults → Character overrides → Chat overrides → Optional: visual restructuring
- **Why:** Users confused about which setting "wins"; this makes precedence explicit
- **Enables:** Character-specific tuning without recreating characters; easier debugging

### 6. **UI Redesign — Hero Banner + Sidebar + Chat** (`project_ui_redesign_hero_sidebar.md`)
- Landing page hero carousel (4–5 recent characters + feature highlights)
- Persistent collapsible left sidebar (My Characters / Works / Personal / Log out)
- Desktop chat layout: character avatar 1/3 left, chat 2/3 right (full bleed, no margins)
- **Why:** Engagement (hero highlights fresh content), navigation (sidebar keeps library accessible), visual presence (avatar as anchor)
- **Design note:** Sammy will workshop in Fable (design tool)
- **Responsive:** Sidebar → hamburger/drawer on mobile

### 7. **Character Architecture v2 — Beyond SillyTavern** (`project_character_architecture_v2.md`)
- **Major strategic initiative:** Rethink character building methodology
- Goal: Rich, multidimensional characters with high behavior predictability + efficient token use
- Exploration areas:
  - Behavioral Definition (Core Values, Decision Framework, Conflict Patterns, Voice Markers, Growth Arc)
  - Behavioral Testing & Scoring (pre-deployment validator, confidence scoring)
  - Modular Character Stack (Archetype + Personal + Relational + Context layers)
  - Adversarial Prompt Design (guardrails against drift)
  - World-Character Binding (world-specific overrides without duplication)
  - Interaction Archetypes (mentor-student, rivals, etc. for group chats)
- **Phase 0:** Research & prototype (current)
- **Why:** Competitive moat; SillyTavern model unreliable; GGBC needs higher fidelity for production platform
- **Timeline:** Exploratory; blocks Phase 1+ until design is validated

---

## Audit Needs (Not Full Features Yet)

### **Chat RAG + Lorebook Injection** (`reference_rag_lorebook_injection.md`)
- **Problem:** RAG (chat history) + Lorebook (world facts) inject independently; no deduplication
- **Open questions:**
  - When user asks about something from long ago, are both pipelines queried efficiently?
  - Is there semantic overlap detection?
  - What's the actual prompt order/precedence?
  - User visibility of what's injected?
- **Action:** Code audit of `buildConversationContext()` + real-world trace
- **Pairs with:** Token Breakdown Analysis (make injection visible)

---

## Current Roadmap Status

Reference: `project_roadmap_status.md` (audited 2026-04-12; note: may be stale on recent work)

**DONE (Phases 1–9 + segments):**
- Phase 1–3: Chat, character, prompt engineering
- Phase 4–5: World Info, group chat
- Phase 6.2, 6.5: Chat display, markdown
- Phase 7.1–7.5: Extensions, TTS, image gen, translation, summarization
- Phase 8.1–8.7: Author's Note, regex, quick replies, profiles, RAG, chat branching, STscript
- Phase 9: Prompt Manager UI, templates, macros
- Phase 10.1: Local model support (in flight; PR #58)

**Partial/Next:**
- Phase 6.1: Theme customization (8 CSS vars exist; need color picker UI, import/export)
- Phase 6.3: Mobile UX (base layout exists; gestures/PWA/haptics not audited)
- Phase 10.2–10.3: Additional cloud providers, text completion API

**Not Started:**
- Phase 5.3: Swap vs join card-handling

---

## High-Level Synthesis (What Fable Should Produce)

As Product Manager, synthesize the above into:

1. **Next Phase Definition**
   - Which initiatives are Phase 10.2+, 11, etc.?
   - What's the logical sequence/dependencies?
   - What's critical path vs. optional?
   - How do active/in-flight work (Phase 6.1, 10.1, Selfies B, etc.) fit into the new roadmap?

2. **Phased Roadmap (2–3 quarters)**
   - Recommend sequencing (e.g., "Complete Phase 10.1 first; then Phase 10.2 UI Redesign + Phase 0 Architecture research in parallel; Selfies Phase B as separate track due to compliance criticality")
   - Flag architectural decisions that gate other work
   - Note design-first projects (Character Architecture v2, UI redesign need design/prototyping before implementation)
   - Call out quick wins (Phase 5.3, Theme customization) for filler slots

3. **Epic/Story/Task Breakdown**
   - Each major initiative → Epic
   - Each Epic → 3–5 Stories (e.g., "Advanced Settings → Creator Notes Editor Story, Advanced Generation Settings Story")
   - Each Story → 2–5 Tasks (e.g., "Creator Notes Editor → HTML sanitization, live preview, style templates")
   - **Kanban columns:** Backlog | Design | Ready for Dev | In Progress | In Review | Deployed
   - Account for currently active work (show what needs completion before new phases start)

4. **Ownership & Delegation Model**
   - Which work goes to which Agent team?
     - **Fable** (design, architecture, product strategy)
     - **Opus/Sonnet** (complex implementation, tricky refactors)
     - **Haiku** (straightforward implementation, tests, small fixes)
     - **Specialized agents** (Explore for code search, code-reviewer for review, Plan for architecture)
   - Note: Sammy wants to see visible per-agent reasoning and per-phase token spend

5. **Success Criteria per Epic**
   - What does "done" look like?
   - Metrics: user engagement, token efficiency, creator confidence, etc.

---

## Key Constraints & Preferences

From memory (`user_model_effort_delegation.md`, `feedback_adversarial_review_catches_real_bugs.md`):

- **Review BEFORE merge, not after** (Phase 5's findings shipped as bugs; do adversarial review before PR)
- **Adversarial review catches real bugs** (run before spread refactors, async work, backend contracts, model swaps, user-writable storage)
- **Token visibility matters** (per-phase token spend, visible tier reasoning)
- **Design-first for big initiatives** (Character Architecture v2, UI redesign → prototype/validate before full impl)
- **Break from SillyTavern if better** (Character Architecture v2 isn't constrained to ST paradigm)
- **Compliance-critical work (NCII)** should be prioritized alongside or ahead of feature development

---

## Dependencies & Gotchas

- **Phase 10.1 completion** gates Phase 10.2 (finish local models before starting new phases)
- **Character Selfies Phase B** is compliance-critical; may need fast-track or parallel track
- **Character wizard** builds on successful character creation (Phase 1, shipped) and Character Architecture v2 Phase 0
- **Token breakdown** needs prompt assembly visibility (`buildConversationContext()`)
- **Settings cascade** should unblock character-level overrides (character editor refactor)
- **Memory consolidation** depends on cascade design (needs clear scoping)
- **Hero banner** is frontend-only; can ship independently
- **Character Architecture v2** is foundational; impacts wizard, creator experience, optimization agent; needs design validation first
- **RAG + Lorebook audit** informs token breakdown visibility
- **Theme customization** could be deferred or packaged as Phase 10.2 filler

---

## Output Format for Kanban Board

Fable should produce:

```markdown
# GGBC Roadmap — Phases 10.1–12+ (Q3–Q4 2026 & Beyond)

## Critical Path & Execution Order

### Sequential Dependencies (Must finish before next starts)
1. **Phase 10.1 completion** (Local Models) → unblocks Phase 10.2
2. **Character Architecture v2 Phase 0** (Research & Prototype) → gates Character Wizard phase 1
3. **Settings Cascade Redesign** (Design + Impl) → gates Memory Consolidation
4. **UI Redesign Phase 1** (Hero Banner) → gates Phase 2 (Sidebar)

### Parallel Tracks (Can work simultaneously)
- **Track A (UI):** Hero Banner → Sidebar → Chat Layout (3 phases, sequential within track)
- **Track B (Settings):** Cascade Redesign + Memory Consolidation (parallel after Cascade design)
- **Track C (Token/Optimization):** Token Breakdown + Optimization Agent (parallel, independent)
- **Track D (Wizard):** Character Wizard Advanced (after Character Architecture v2 phase 0)
- **Track E (Compliance):** Character Selfies Phase B (output-side NCII gate) — may be fast-tracked

## Phase Sequencing with Parallelization

- **Phase 10.1 (Weeks 1–2, Pre-existing):**
  - `[CLEANUP]` Complete PR #58 (local models) + merge to main
  
- **Phase 10.2 (Weeks 3–5, Parallel):**
  - `[UI-TRACK]` Hero Banner: Design + Impl
  - `[ARCH-TRACK]` Character Architecture v2 Phase 0: Research
  - `[COMPLIANCE-TRACK]` Character Selfies Phase B: Design (NCII output gate)
  
- **Phase 10.3 (Weeks 6–8, Parallel):**
  - `[UI-TRACK]` Sidebar: Design + Impl
  - `[SETTINGS-TRACK]` Cascade Redesign: Design
  - `[TOKEN-TRACK]` Token Breakdown: Impl
  - `[COMPLIANCE-TRACK]` Selfies Phase B: Impl (parallel if capacity allows)
  
- **Phase 11.1 (Weeks 9–11, Parallel):**
  - `[UI-TRACK]` Chat Layout: Impl + Review
  - `[SETTINGS-TRACK]` Cascade Redesign: Impl + Memory Consolidation: Parallel impl
  - `[TOKEN-TRACK]` Optimization Agent: Impl
  
- **Phase 11.2 (Weeks 12–14, Sequential):**
  - `[WIZARD-TRACK]` Character Wizard Advanced: Design (gates on Arch v2 phase 0 complete)
  
- **Phase 12 (Weeks 15+, Sequential):**
  - `[WIZARD-TRACK]` Character Wizard Advanced: Impl + Review + Deploy

[Epics and Kanban board follow same structure as template above...]
```

---

## Next Steps

1. **Fable receives this document**
2. **Fable synthesizes into:**
   - Phased roadmap (2–3 quarters) accounting for active work + new initiatives
   - Dependency graph showing what unblocks what
   - Epic/Story/Task Kanban breakdown
   - Recommended Agent team assignments
   - Design work needed before implementation
   - Compliance work prioritization (Selfies Phase B)
3. **Output published** (artifact or markdown file)
4. **Sammy reviews & approves**
5. **Agent teams begin execution** (each Story/Task assigned with clear acceptance criteria)

---

## Memory References

All supporting details in Sammy's memory at `/Users/sammy/.claude/projects/-Users-sammy-Documents-GitHub-goodgirlsbotclub/memory/`:

**New Features (this session):**
- `project_character_wizard_advanced.md`
- `project_token_breakdown_analysis.md`
- `project_settings_optimization_agent.md`
- `project_memory_pane_consolidation.md`
- `project_settings_cascade_redesign.md`
- `project_ui_redesign_hero_sidebar.md`
- `project_character_architecture_v2.md`

**Audits & References:**
- `reference_rag_lorebook_injection.md`
- `project_roadmap_status.md` (older but authoritative)

**Active Work:**
- `project_phase61_pickup.md` (Theme customization)
- `project_character_selfies.md` (Phases A/B/C status)
- `project_extensions_pickup.md`, `project_phase87_pickup.md` (recent completed work)

**Constraints & Preferences:**
- `user_model_effort_delegation.md`
- `feedback_adversarial_review_catches_real_bugs.md`
- `feedback_review_before_merge_not_after.md`
- `project_monetization_direction.md`

---

## Notes for Fable

- This is a **high-level planning session**; Sammy wants you to synthesize and structure, not design in detail yet
- **Design projects** (Character Architecture v2, UI redesign) need workshops/prototypes before implementation; you'll handle design; implementation delegated to Agent teams
- **Be opinionated:** Recommend sequencing, highlight risks, flag quick wins, prioritize compliance work
- **Visible reasoning:** Explain your phasing decisions; Sammy values understanding the "why"
- **Token-aware:** This will be handed to Agent teams; estimate per-phase complexity and token spend
- **Compliance awareness:** Character Selfies Phase B (NCII output gate) is a business blocker; weight it appropriately in sequencing
- Goal is a **clear, actionable roadmap** that Agent teams can execute against autonomously
