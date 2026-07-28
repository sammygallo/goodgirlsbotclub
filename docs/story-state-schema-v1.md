# GoodGirlsBotClub — Canonical Story State Schema (v1)

**Purpose:** Single source of truth that sits between the SillyTavern-style chat session and any format-specific renderer (novel, screenplay, comic script, storyboard). This document defines the schema, how it ingests from ST primitives, how renderers consume it, and how user edits round-trip back into it.

---

## Design principles

These constrain every decision below. Worth agreeing on before debating fields.

1. **Format-agnostic core.** The unit of structure is the **scene**, not the chapter, page, or panel. Chapters and pages are renderer-specific framings of the same underlying scenes.
2. **Provenance everywhere.** Every canonical fact links back to its source — a character card field, a lorebook entry ID, a chat message ID, a user annotation, or an agent inference. Without provenance, round-trip editing is impossible and contradictions can't be adjudicated.
3. **Confidence is a first-class field.** Facts are `explicit` (stated in source), `inferred` (derived by an agent), or `contested` (multiple sources disagree). Renderers and critics treat these differently.
4. **Hints aren't truth.** `rendering_hints` informs format-specific output (default POV, tense, chapter breaks) but doesn't constrain canon. Two renderers can disagree on hints; they cannot disagree on facts.
5. **Contradictions are surfaced, not silently resolved.** The continuity layer holds them as objects until a user or agent makes a canonical choice.
6. **Voice is separated from character.** A character's in-fiction voice (how they speak in dialogue) is distinct from the user's authorial voice (how they narrate, what register they prefer in their inputs) is distinct from the model's default narrator voice. The renderer's job is to amplify the user's voice, not average them all.
7. **Incremental enrichment.** A starter bible is built cheaply from ST primitives at session import. The full bible accretes as the transcript is walked. Anything in the bible can be updated, but provenance survives updates.
8. **Stable IDs.** Every entity, scene, fact, and rendering decision gets a UUID at creation and keeps it. This is what makes round-trip editing tractable.

---

## Top-level structure

```yaml
story_bible:
  meta: { ... }              # versioning, identity, source links
  world: { ... }              # setting, rules, timeline
  entities: { ... }           # characters, locations, objects, factions
  user_voice: { ... }         # the user's authorial profile
  narrative: { ... }          # structural shape (acts, themes, POV defaults)
  scenes: [ ... ]             # the ordered list of scenes
  continuity: { ... }         # facts log + contradictions
  rendering_hints: { ... }    # per-format defaults, not canon
  edit_log: [ ... ]           # round-trip edit history
```

---

## `meta`

```yaml
meta:
  id: uuid
  schema_version: "1.0"
  created_at: iso8601
  updated_at: iso8601
  source:
    platform: "sillytavern" | "ggbc" | "import"
    session_ids: [array]                # ST chat IDs / GGBC session IDs
    character_card_ids: [array]
    lorebook_ids: [array]
    persona_id: string
  title: string                          # user-provided or inferred
  logline: string                        # one-sentence summary, agent-generated
  genre_hints: [array of strings]
  content_rating: "general" | "teen" | "mature" | "explicit"
  derivative_flags:                      # IP risk surface
    derived_from_known_ip: bool
    derived_ip_notes: string             # "Character card derived from <work>"
  word_count_actual: int                 # of canonical chat content
  word_count_target: int                 # for rendering
```

**Why `derivative_flags` is in v1:** A real fraction of ST cards are derived from existing IP. The renderer needs to know to soften promotional language ("write your novel!") when the input is, e.g., a Witcher-derived character. This is also the field your ToS / publishing-assist UX hangs off.

---

## `world`

```yaml
world:
  name: string
  setting_summary: string                # synthesized prose, ~2 paragraphs
  setting_attributes:
    time_period: string
    technology_level: string
    magic_or_supernatural: string
    geography: 
      - id: place_uuid
        name: string
        parent: place_uuid | null        # hierarchy: "the bedroom" inside "the manor"
        description: string
    society:
      political: string
      cultural: string
      economic: string
  rules:                                  # canonical truths the world enforces
    - id: rule_uuid
      text: "Magic requires verbal incantation"
      category: "magic" | "tech" | "social" | "physics" | "other"
      source:
        type: "card_scenario" | "lorebook_entry" | "chat_msg" | "user_annotation" | "agent_inference"
        ref: string                       # the actual ID
      confidence: "explicit" | "inferred" | "contested"
      established_in_scene: scene_uuid | null
  timeline:
    anchors:
      - id: timeline_uuid
        label: string                     # "the war ended"
        relative_to: timeline_uuid | "story_start" | null
        offset: string                    # "10 years before"
        absolute: iso8601 | null
```

---

## `entities.characters`

The richest object. Designed to satisfy both prose generation and (via `physical_description.attributes`) image generation downstream.

```yaml
characters:
  - id: char_uuid
    canonical_name: string
    aliases: [array]
    role: "protagonist" | "antagonist" | "supporting" | "mentioned" | "user_persona"
    is_user_persona: bool
    source_card_id: string | null         # link back to ST character card
    
    physical_description:
      summary: string                     # for prose
      attributes:                         # structured for image gen / consistency
        age_apparent: string
        gender_presentation: string
        hair: { color, length, style }
        eyes: { color, shape }
        skin: string
        build: string
        height: string
        distinguishing_features: [array]
        typical_attire: string
    
    personality:
      traits: [array of {trait, evidence_ref}]
      voice_profile:
        register: "formal" | "casual" | "vulgar" | "archaic" | "mixed"
        speech_patterns: string           # "speaks in short clipped sentences"
        verbal_tics: [array]              # "trails off mid-sentence"
        dialogue_examples: [array]        # representative lines pulled from transcript
        vocabulary_signals:
          favored: [array]
          avoided: [array]
      motivations: [array]
      fears: [array]
      values: [array]
    
    background: string
    
    relationships:
      - target: char_uuid
        type: string                      # "mother" | "lover" | "rival" | "former-employer"
        current_dynamic: string
        history: string
        arc_beats: [scene_uuid]           # scenes where this relationship shifts
    
    arc:
      starting_state: string
      current_state: string
      target_state: string | null         # if user has stated intent
      beats: 
        - scene_ref: scene_uuid
          change: string                  # "decides to leave"
    
    provenance:
      card_fields: [array]                # "description", "personality", "first_mes"
      lorebook_entries: [array]
      chat_evidence: [msg_id]
      agent_inferences: [array]
```

**Two notes:**
- `voice_profile.dialogue_examples` is what makes character voice survive transformation. Pull 5–10 representative lines from the transcript at ingestion; the renderer uses them as in-context examples when rewriting dialogue.
- `arc.beats` is what lets the structural critic tell whether the character has actually changed across the story or is just running in place. RP transcripts often have low arc velocity; flagging this honestly matters more than papering over it.

---

## `user_voice`

The most undervalued object in the schema. This is what makes outputs feel like *the user's* work rather than the model's.

```yaml
user_voice:
  style_summary: string                   # synthesized 1-paragraph profile
  register: "literary" | "commercial" | "pulp" | "experimental" | "mixed"
  
  diction:
    preferred_vocabulary: [array]
    avoided_vocabulary: [array]
    sentence_length:
      mean: float
      distribution: "short-dominant" | "balanced" | "long-dominant" | "varied"
    paragraph_density: "tight" | "medium" | "loose"
  
  rhetorical_devices: [array]             # "parenthetical asides", "fragments-for-emphasis", "anaphora"
  pov_preferences:
    in_chat: "second-present" | "first-past" | "third-mixed"
    likely_target_for_prose: "third-limited" | "first-past" | "third-omniscient"
  
  interaction_style:
    tendency: "directive" | "collaborative" | "reactive"
    direction_to_narration_ratio: float   # 0.0 = pure dialogue, 1.0 = pure description
    typical_input_length: int             # tokens
  
  sample_passages: [array]                # 5–10 unmodified user inputs that best represent voice
  
  confidence: float                       # 0.0–1.0 — low if the user typed mostly short reactive inputs
```

**The confidence field matters.** A user who typed "*nods*" 400 times has not given the Voice Profiler much to work with. The renderer should know that and lean more heavily on the user's *explicit narrative inputs* (when they exist) and on neutral-but-clean default prose otherwise. Don't fabricate voice; flag low-confidence and let the UX handle it (e.g., "we don't have a strong read on your voice — paste 1–2 paragraphs you've written elsewhere").

---

## `narrative`

```yaml
narrative:
  structure:
    detected_type: "three_act" | "kishōtenketsu" | "episodic" | "slice_of_life" | "none_yet"
    detection_confidence: float
    acts:
      - id: act_uuid
        label: string                     # "Setup" | "Confrontation" | "Resolution"
        scene_range: [scene_uuid, scene_uuid]
        beat_function: string             # "establishing world", "rising tension"
  themes: [array of {theme, evidence_refs}]
  motifs: [array]
  unresolved_threads: [array]             # plot threads opened but not closed
  pov_default: enum
  tense_default: "past" | "present"
```

---

## `scenes` — the workhorse

This is the object every renderer actually touches.

```yaml
scenes:
  - id: scene_uuid
    sequence: int                         # order in transcript
    title: string                         # auto-generated, user-editable
    
    summary: string                       # 1–2 sentences
    detailed_summary: string              # paragraph
    
    setting:
      location_ref: place_uuid
      time_ref: timeline_uuid | string    # "evening", "two days later"
      atmosphere: string
    
    participants: [char_uuid]
    pov_character: char_uuid | null       # if scene has a clear POV anchor
    
    function:
      beat: "inciting" | "rising" | "midpoint" | "crisis" | "climax" | "denouement" | "interlude"
      tension: int                        # 1–10
      mood: string
      stakes: string
    
    source:
      message_range: [msg_id_start, msg_id_end]
      total_messages: int
      swipe_resolutions:
        - msg_id: chat_msg_id
          chosen_swipe_idx: int
          alternate_swipes_available: int
      excluded_segments:                  # OOC, system messages, regeneration noise
        - msg_id_start: chat_msg_id
          msg_id_end: chat_msg_id
          reason: "ooc" | "system" | "regen_artifact" | "user_marked"
    
    continuity_facts_established:         # what this scene puts on the record
      - fact_id: fact_uuid
        text: "Sara reveals she's the duke's daughter"
        category: "reveal" | "introduction" | "change" | "world_rule"
    
    transformations:
      compression_recommendation: "cut" | "compress" | "preserve" | "expand"
      compression_ratio_target: float     # e.g., 0.3 = 70% reduction
      pacing_notes: string                # "drags in the middle"
      dialogue_density: float             # 0.0 (none) to 1.0 (all dialogue)
    
    annotations:
      user_notes: string
      author_intent: string
      flagged_issues: [array]
```

---

## `continuity`

```yaml
continuity:
  fact_log:                               # append-only, every established fact
    - id: fact_uuid
      text: string
      category: enum
      established_in: scene_uuid
      source_msg: msg_id
      confidence: enum
      contradicts: [fact_uuid]            # null until auditor finds conflict
  
  contradictions:
    - id: contradiction_uuid
      type: "character_attribute" | "world_rule" | "timeline" | "relationship" | "object_state"
      description: string
      sources: [fact_uuid]
      detected_by: "agent" | "user"
      resolution:
        status: "unresolved" | "user_chose" | "agent_resolved" | "deferred"
        canonical_choice: fact_uuid | null
        rationale: string
        resolved_at: iso8601 | null
```

**Practical note:** RP transcripts accumulate contradictions like dust. Don't try to resolve them all up front. Surface only the ones that affect the requested render — if the user is exporting Act 1, don't bother flagging contradictions in Act 3 yet.

---

## `rendering_hints`

```yaml
rendering_hints:
  novel:
    pov: "first" | "third_limited" | "third_omniscient"
    pov_character: char_uuid | null       # for limited POV
    tense: "past" | "present"
    chapter_breaks: [scene_uuid]          # which scenes start new chapters
    chapter_titles: { scene_uuid: string }
    compression_level: "tight" | "balanced" | "loose"
    target_word_count: int | null
    style_anchors:                        # author voices to lean toward
      - "Le Guin"
      - "early Gibson"
  
  screenplay:
    format: "fountain" | "final_draft"
    sluglines_inferred: bool
    page_target: int
  
  graphic_novel:
    pages_per_scene: float
    panel_density: "sparse" | "standard" | "dense"
    art_style_brief: string
    character_consistency_refs: { char_uuid: image_url }  # for downstream image gen
  
  storyboard:
    aspect_ratio: "2.39:1" | "16:9" | "4:3"
    panels_per_scene: int
```

---

## `edit_log`

The round-trip mechanism. Without this, the user edits prose and the bible drifts.

```yaml
edit_log:
  - id: edit_uuid
    timestamp: iso8601
    actor: "user" | "agent"
    surface: "rendered_output" | "bible_direct"
    target: 
      type: "scene" | "character" | "fact" | "voice" | "rule"
      id: uuid
    diff: string                          # the actual change
    classification: "cosmetic" | "substantive" | "voice_shift" | "contradiction"
    propagated_to_bible: bool
    propagation_notes: string
```

**Edit classification matters.** A user changing "she said" to "she murmured" in chapter three is cosmetic and shouldn't update the character's voice profile. The user changing "he hated his father" to "he loved his father" is substantive and should update both the character relationship and the fact log. A pipeline that doesn't distinguish these will either over-update (treating every typo as a canonical revision) or under-update (treating real plot changes as cosmetic).

---

## Ingestion: SillyTavern primitives → schema fields

| ST primitive | Maps to | Notes |
|---|---|---|
| Character card `name` | `entities.characters[].canonical_name` | Direct |
| Character card `description` | `physical_description.summary` + parsed into `.attributes` | Heuristic + LLM extraction for structured attrs |
| Character card `personality` | `personality.traits` + `voice_profile.register` | LLM classifier |
| Character card `scenario` | `world.setting_summary` (initial) | First write, can be enriched |
| Character card `first_mes` | First scene's `source.message_range[0]` | Treated as scene 1 opening |
| Character card `mes_example` | `voice_profile.dialogue_examples` (initial) | Augmented from transcript |
| Character card `system_prompt` | Excluded from canon, captured in `meta.source` for reference | Often contains directives, not facts |
| Lorebook entry (constant) | `world.rules` with high confidence | All ingested at start |
| Lorebook entry (selective, fired) | `world.rules` with `confidence: explicit` | Ingest if keys triggered in transcript |
| Lorebook entry (selective, never fired) | `world.rules` with `confidence: inferred` | Ingest as latent canon; promote if corroborated |
| Persona name + description | `entities.characters[]` with `is_user_persona: true` | Treated as a character with the user as voice donor |
| Author's notes | `narrative` directives + excluded from canon | Often meta ("be descriptive"), not canon |
| Chat message (user) | Source for `user_voice` profiling + persona dialogue | Stripped of OOC |
| Chat message (character) | Source for scene content + character dialogue | Active swipe is canonical |
| Chat message (system) | Excluded from canon | |
| Group chat | Multiple characters merged; lorebooks unioned | Conflict resolution required (auditor flags) |

### Ingestion order

1. **Cold-start bible.** Parse all cards, lorebooks, persona. Populate `entities`, `world.rules`, `world.setting_summary`. Confidence: `explicit` for stated card fields, `inferred` for unfired lorebook entries.
2. **Walk transcript chronologically.** For each message:
   - Strip OOC/system noise via combined regex + LLM classifier.
   - Resolve to active swipe (default: latest active).
   - Detect scene boundaries.
   - Extract continuity facts (declarative statements about world/characters).
   - Sample for `user_voice` (user messages only).
3. **Reconcile.** Run continuity auditor: detect contradictions between cold-start bible and transcript-derived facts (RPs frequently override their own card scenarios).
4. **Annotate.** Beat classifier on each scene; tension/mood scoring; narrative structure detection.
5. **User review checkpoint.** Surface contradictions and any low-confidence facts. Lock canon.

This is five distinct agent passes, not one. Don't try to do them all in a mega-prompt.

---

## Renderer consumption

A novel-chapter renderer pulls:
- The target `scenes[]` (usually a contiguous range)
- The `entities.characters` referenced in `participants` for each scene
- `user_voice` (always)
- `world.rules` filtered to those relevant to the scenes (RAG over rule text vs. scene content)
- `narrative.pov_default`, `tense_default`, and `rendering_hints.novel`
- The fact log for the scene range

It does **not** pull the entire bible. RAG selectivity matters here for both cost and focus.

The transformation chain inside the renderer (each stage = a specialist agent):

```
canonical scene + context  
  → POV/tense transformer  
  → dramatic compressor (per scene's compression_recommendation)  
  → dialogue polisher (using character voice_profiles)  
  → narration voice-matcher (using user_voice)  
  → continuity validator (cross-check against fact log)  
  → output
```

A screenplay renderer reuses the bible but its transformation chain is shorter:

```
canonical scene + context  
  → slugline generator (from setting + time)  
  → action-line compressor  
  → dialogue extractor + parenthetical inferrer  
  → Fountain formatter  
  → output
```

A comic-script renderer adds page/panel allocation as the first transformation stage and image-prompt generation as the last. Same bible.

---

## Round-trip editing

When a user edits rendered prose:

1. **Diff.** Compute structural diff against the renderer's expected output.
2. **Classify.** A classifier agent labels each edit as cosmetic, substantive, voice-shift, or contradiction.
3. **Propose propagation.** For substantive and voice-shift edits, the agent proposes a bible update with explicit before/after.
4. **User confirms.** UI shows "we noticed you changed X — should we update the canonical state to reflect this?" Default to off; require explicit opt-in to keep the bible from drifting under the user.
5. **Apply.** Update the bible with new fact, new voice signal, or contradiction entry. Log to `edit_log`.
6. **Re-render affected downstream scenes.** If a character trait changed in chapter 3, ask whether to re-render chapters 4+ (or just flag them).

The under-the-hood power move here: this is what turns the product from "a one-shot exporter" into "an authoring environment." It's also the feature competitors will copy last because they don't have the chat-as-input modality.

---

## v1 cuts and deferrals

To keep v1 buildable, defer:

- **Branched / forked chat threads.** Single linear thread only.
- **Multi-session merging.** Single source session per bible.
- **Real-time collaborative editing.** Single author at a time.
- **Image consistency models** for graphic novel renderer. Use prompt-only for v1; LoRA/IP-Adapter pipelines come later.
- **Story bible export to other tools** (Scrivener, etc.). Internal-only initially.

Worth a separate doc.

---

## Open decisions

1. **Storage.** Document store (Mongo, Firestore) vs. relational with JSONB (Postgres) vs. hybrid (Postgres for entities + vector store for embedding-based retrieval over rules and scenes). My lean: Postgres + pgvector. Familiar to you, transactional integrity matters for the edit log, and pgvector handles the RAG side adequately at the scale a single user generates.
2. **Embedding strategy.** Embed scenes, rules, character profiles, fact log. Re-embed on substantive edits. Decide chunk size and overlap based on your model's context window.
3. **Provenance granularity.** Per-field or per-object? Per-field is more accurate but explodes table size. Per-object is cheaper but loses fidelity. I'd start per-object and tighten where it bites.
4. **Confidence model.** Discrete (`explicit/inferred/contested`) or continuous (`0.0–1.0`)? Discrete is simpler and sufficient for v1. Continuous gives you finer ranking later.
5. **Critic agent calibration set.** You'll need a benchmark of human-rated transcripts → outputs to evaluate the renderer chain. Build this early; it pays for itself on every change.

---

## Schema validation note

Treat this YAML as conceptual. The implementation should be a JSON Schema (or Zod / Pydantic / TypeBox depending on stack) that enforces required fields, enum values, and reference integrity (e.g., `pov_character` must reference a valid `char_uuid`). Schema validation is the first quality gate; without it, agents will produce structurally invalid bibles and downstream renderers will fail in confusing ways.

---

## Amendments — v1.1 (2026-07-27, step-2 phase 3a)

The sections above are the original conceptual schema. The normative
implementation is **`app/schemas/story.py` in ggbc-backend** (Pydantic,
`extra="forbid"`); where this document and that module disagree, the module
wins. These amendments record every resolution, per the
[step-2 plan](story-state-step2-plan.md) and
[compatibility audit](story-state-schema-v1-audit.md).

### Storage shape (plan Decision 2)

The bible is **not** one document. It is decomposed into:

- `story_sections` — one row per section: `meta`, `world`, `entities`,
  `user_voice`, `narrative`, `continuity`, `rendering_hints`, plus a new
  **`ingestion`** section (pipeline checkpoint state; not part of the
  original schema). The top-level `story_bible:` envelope is gone — the
  section name is the envelope; `schema_version` lives in `meta`.
- `story_scenes` — one row per scene.
- `story_facts` / `story_edits` — append-only tables. **`continuity.fact_log`
  is no longer a section field**: fact rows are the single source of truth,
  and `scenes[].continuity_facts_established` holds fact-id refs only (D4).
  `edit_log` likewise becomes rows; ordering is the server's insert cursor,
  and the entry's `timestamp` field is renamed `occurred_at` (client wall
  clock, informational).

Size budgets (D10): section ≤256KB, scene ≤64KB, fact ≤8KB, edit ≤16KB —
enforced at the API with 413s naming the cap.

### Identity & provenance (plan Decision 4; audit C1/C2/C6/D2)

- Every `*_uuid` in this doc is a **bible-local UUID**, minted client-side,
  never resolved against backend tables. Server validation is shape-only;
  referential integrity is checked client-side at **lock canon**.
- Every link back to source material is a **`SourceRef`** envelope:
  `{kind, ref, snapshot, captured_at}`, a discriminated union over
  `character | card_field | chat | chat_message | persona | lorebook_entry |
  user_annotation | agent_inference`. `ref` uses platform string identity
  (avatar filename; `{character_avatar, file_name}` for chats) and **may
  dangle** after rename/delete; `snapshot` (name/excerpt/hash) keeps the
  bible self-sufficient. Ref state (live/drifted/dangling) is computed
  client-side at display time, never persisted.
- **`msg_id` is now defined** (resolving D2): the permanent
  `extra.ggbc_id` UUID minted by phases 1–2. Message references are
  `MsgRef = {msg_id, swipe_idx, fingerprint {sha, hash_alg, send_date}}`.
  Drift rule: edit-and-regenerate keeps a stable `msg_id` while replacing
  content and resetting swipes, so every consumer must check the swipe
  fingerprint, not just the id. `scenes[].source.message_range`,
  `swipe_resolutions`, `excluded_segments`, and fact sources all use
  `MsgRef`.
- **`meta.source` is respecified** (C6/D1): scalar `chat` SourceRef (one
  bible = one source chat, honoring the v1 single-session cut inside the
  multi-chat Work container), `characters` as avatar-string refs with
  snapshots, `persona` by name + snapshot (personas have no backend
  identity), and `lorebook_ids`. `source.platform` narrows to the literal
  `"ggbc"` (imports arrive as GGBC chats before ingestion ever sees
  them). `session_ids` (plural) and `character_card_ids`/`persona_id`
  are gone. The `ingest_watermark` `{message_count, last_msg}` for
  incremental re-ingestion sits on **`meta` itself, not `meta.source`**.

### Enum & type resolutions (D3–D6, D9)

- **D3 — one fact enum.** `FactCategory = reveal | introduction | change |
  world_rule` lives on fact rows only — scenes reference facts by bare id
  (per D4), so the doc's second category vocabulary is removed rather
  than unified. `narrative.acts[].beat_function` stays free text
  (annotate-pass output, step 3).
- **D5 — two POV vocabularies, not three.** `ChatPov` (`second-present |
  first-past | third-mixed`) describes observed chat style
  (`user_voice.pov_preferences.in_chat`); `RenderPov` (`first |
  third_limited | third_omniscient`) is the render target
  (`narrative.pov_default`, `rendering_hints.novel.pov`,
  `pov_preferences.likely_target_for_prose`). `pov_default`'s enum is
  `RenderPov`.
- **D4 — no duplicated canon.** Facts: rows are canonical (above).
  POV/tense: `narrative.pov_default`/`tense_default` are canonical;
  `rendering_hints.novel.pov`/`tense` are nullable overrides (None =
  inherit). Relationship `arc_beats` remain scene-id refs (an index, not a
  copy of `arc.beats`).
- **D6 — confidence is both, by role.** Discrete
  `explicit | inferred | contested` on canon claims (facts, world rules);
  floats 0–1 only on model self-assessments (`user_voice.confidence`,
  `narrative.structure.detection_confidence`). Open decision 4 is closed.
- **D9 — no UUID-keyed JSON maps.** `chapter_titles` is
  `[{scene_id, title}]`; `character_consistency_refs` is
  `[{character_ref, asset_ref}]` where `asset_ref` is a self-hosted asset
  path, not an external URL.
- `content_rating`, `derivative_flags` ship in `meta` as specified; policy
  interplay with rendering/publishing (D8) remains an open product
  question for step 3.

### Field renames, moves, and strictness (vs the v1.0 text above)

- `meta.id` → **`bible_id`**; `world.rules[].established_in_scene` →
  **`established_in`** (matching the fact rows' field name).
- **`geography` is hoisted** out of `world.setting_attributes` to
  `world.geography`. Entity "locations" live there too: the `entities`
  section carries `characters`, `objects`, `factions` only.
- `detected_type` uses the ASCII value **`kishotenketsu`** (enum values
  stay ASCII; display strings may differ).
- `swipe_resolutions[]` drops `chosen_swipe_idx`: **`msg.swipe_idx` IS
  the chosen swipe** and the fingerprint hashes that swipe's text — a
  second index invited the two to disagree.
- Every timestamp is **timezone-aware** (naive datetimes are rejected);
  `edit_log`'s `timestamp` is renamed `occurred_at` (client wall clock,
  informational — row order is the server cursor).
- `Infinity`/`NaN` are rejected on all float fields (JSON that Postgres
  jsonb would refuse anyway); message ids are counted in **UTF-16 code
  units** (1..128), matching the phases-1/2 predicate exactly;
  `snapshot.sha` and `snapshot.hash_alg` must travel together;
  `asset_ref` must be a self-hosted absolute path (`/...`), enforced;
  `Fact.confidence` is required, never defaulted — an extraction that
  lost the field must not silently canonize at "explicit".

### Deferred to step 3 (annotate pass has no step-2 consumer)

`narrative.structure` detection, `scenes[].function` (beat/tension/mood/
stakes), and `scenes[].transformations` are **optional and empty in v1.1**
— the ingestion pipeline does not populate them; the first renderer's
annotate pass does. The `ingestion` section's pass enum deliberately
excludes `annotate`.

### Version gate

Servers accept `schema_version` major `1` only (`1.x` / `1.x.y`). Additive
changes bump the minor and deploy backend-first (`extra="forbid"` rejects
unknown fields from newer clients).
