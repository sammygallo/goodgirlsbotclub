// Story-bible wire types (story-state phase 5).
//
// These mirror ggbc-backend's app/schemas/story.py exactly — that module
// is normative (docs/story-state-schema-v1.md, v1.1 amendments), and it
// validates with extra="forbid", so a field that drifts here becomes a
// 422 rather than a silent mismatch.
//
// Identity rules worth keeping in mind while using these:
//   * Every `*_id` inside a bible is a bible-local UUID, minted client
//     side. It is never resolved against a backend table.
//   * Links back to source material go through SourceRef, whose `ref`
//     uses the platform's string identity (character avatar filename,
//     `(character_avatar, file_name)` for chats) and MAY DANGLE after a
//     rename or delete. Snapshots keep the bible readable when it does.

import type { ProjectChatRef } from '../api/client';

export const STORY_SCHEMA_VERSION = '1.0';

export type HashAlg = 'sha256' | 'djb2';

export type Confidence = 'explicit' | 'inferred' | 'contested';
export type FactCategory = 'reveal' | 'introduction' | 'change' | 'world_rule';
export type ChatPov = 'second-present' | 'first-past' | 'third-mixed';
export type RenderPov = 'first' | 'third_limited' | 'third_omniscient';
export type ContentRating = 'general' | 'teen' | 'mature' | 'explicit';

/** The eight bible sections, in the order the Story tab shows them. */
export const STORY_SECTIONS = [
  'meta',
  'world',
  'entities',
  'user_voice',
  'narrative',
  'continuity',
  'rendering_hints',
  'ingestion',
] as const;
export type StorySectionName = (typeof STORY_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Message references
// ---------------------------------------------------------------------------

export interface MsgFingerprint {
  sha: string;
  hash_alg: HashAlg;
  send_date: number;
}

/** A message address inside the bible's single source chat. `msg_id` is
 *  the permanent `extra.ggbc_id` minted in phases 1–2. */
export interface MsgRef {
  msg_id: string;
  swipe_idx: number;
  fingerprint: MsgFingerprint;
}

// ---------------------------------------------------------------------------
// SourceRef envelope
// ---------------------------------------------------------------------------

export interface SourceSnapshot {
  name?: string | null;
  excerpt?: string | null;
  /** sha and hash_alg must travel together — the backend rejects one
   *  without the other, since a hash whose algorithm is unknown can't be
   *  re-verified (the frontend legitimately emits djb2 off-HTTPS). */
  sha?: string | null;
  hash_alg?: HashAlg | null;
}

interface SourceRefBase {
  snapshot?: SourceSnapshot;
  /** ISO-8601 WITH timezone — the backend uses AwareDatetime. */
  captured_at: string;
}

export interface CharacterSourceRef extends SourceRefBase {
  kind: 'character';
  ref: string; // character avatar filename
}

export interface CardFieldSourceRef extends SourceRefBase {
  kind: 'card_field';
  ref: { character_avatar: string; field: string };
}

export interface ChatSourceRef extends SourceRefBase {
  kind: 'chat';
  ref: ProjectChatRef;
}

export interface ChatMessageSourceRef extends SourceRefBase {
  kind: 'chat_message';
  ref: { chat: ProjectChatRef; msg: MsgRef };
}

export interface PersonaSourceRef extends SourceRefBase {
  kind: 'persona';
  ref: string; // persona name — personas have no backend identity
}

export interface LorebookEntrySourceRef extends SourceRefBase {
  kind: 'lorebook_entry';
  ref: { book_id: string; entry_id: string };
}

export interface UserAnnotationSourceRef extends SourceRefBase {
  kind: 'user_annotation';
  ref?: null;
}

export interface AgentInferenceSourceRef extends SourceRefBase {
  kind: 'agent_inference';
  ref?: null;
}

export type SourceRef =
  | CharacterSourceRef
  | CardFieldSourceRef
  | ChatSourceRef
  | ChatMessageSourceRef
  | PersonaSourceRef
  | LorebookEntrySourceRef
  | UserAnnotationSourceRef
  | AgentInferenceSourceRef;

/** How a ref stands against live state, computed at display time and
 *  never persisted:
 *   - `live`     — the referent exists and matches the snapshot
 *   - `drifted`  — it exists but changed since capture (renamed, edited)
 *   - `dangling` — it is gone (deleted, or renamed on another device) */
export type RefState = 'live' | 'drifted' | 'dangling';

// ---------------------------------------------------------------------------
// meta section (the only section phase 5 writes)
// ---------------------------------------------------------------------------

export interface IngestWatermark {
  message_count: number;
  last_msg?: MsgRef | null;
}

export interface MetaSource {
  platform: 'ggbc';
  /** Exactly one source chat per bible — the v1 single-session cut,
   *  honored inside the multi-chat Work container. */
  chat: ChatSourceRef;
  characters?: CharacterSourceRef[];
  persona?: PersonaSourceRef | null;
  lorebook_ids?: string[];
}

export interface MetaSection {
  schema_version: string;
  bible_id: string;
  created_at: string;
  updated_at: string;
  source: MetaSource;
  title?: string;
  logline?: string;
  genre_hints?: string[];
  content_rating?: ContentRating;
  derivative_flags?: { derived_from_known_ip: boolean; derived_ip_notes: string };
  word_count_actual?: number;
  word_count_target?: number | null;
  ingest_watermark?: IngestWatermark;
  canon_locked_at?: string | null;
}

// ---------------------------------------------------------------------------
// Row shapes the read-only viewers render
// ---------------------------------------------------------------------------

export interface BibleFact {
  id: string;
  text: string;
  category: FactCategory;
  established_in?: string | null;
  source?: SourceRef | null;
  confidence: Confidence;
  contradicts?: string[];
  supersedes?: string | null;
}

// ---------------------------------------------------------------------------
// Sections the cold-start pass writes (phase 6). Field-for-field mirrors of
// WorldSection / EntitiesSection / RenderingHintsSection in the backend's
// app/schemas/story.py — which forbids unknown keys, so an extra field here
// is a 422, not a type error.
// ---------------------------------------------------------------------------

export type VoiceRegister = 'formal' | 'casual' | 'vulgar' | 'archaic' | 'mixed';

export interface HairAttributes {
  color: string;
  length: string;
  style: string;
}

export interface EyeAttributes {
  color: string;
  shape: string;
}

export interface PhysicalAttributes {
  age_apparent: string;
  gender_presentation: string;
  hair: HairAttributes;
  eyes: EyeAttributes;
  skin: string;
  build: string;
  height: string;
  distinguishing_features: string[];
  typical_attire: string;
}

export interface PhysicalDescription {
  summary: string;
  attributes: PhysicalAttributes;
}

export interface CharacterTrait {
  trait: string;
  evidence?: SourceRef | null;
}

export interface DialogueExample {
  text: string;
  source?: SourceRef | null;
}

export interface VoiceProfile {
  register: VoiceRegister;
  speech_patterns: string;
  verbal_tics: string[];
  dialogue_examples: DialogueExample[];
  vocabulary_signals: { favored: string[]; avoided: string[] };
}

export interface Personality {
  traits: CharacterTrait[];
  voice_profile?: VoiceProfile;
  motivations: string[];
  fears: string[];
  values: string[];
}

export interface CharacterArc {
  starting_state: string;
  current_state: string;
  target_state: string | null;
  beats: { scene_ref: string; change: string }[];
}

export interface BibleCharacter {
  id: string;
  canonical_name: string;
  aliases: string[];
  role: 'protagonist' | 'antagonist' | 'supporting' | 'mentioned' | 'user_persona';
  is_user_persona: boolean;
  source?: SourceRef | null;
  physical_description?: PhysicalDescription;
  personality?: Personality;
  background: string;
  relationships: unknown[];
  arc: CharacterArc;
  provenance?: SourceRef[];
}

export interface EntitiesSection {
  characters: BibleCharacter[];
  objects: unknown[];
  factions: unknown[];
}

export interface WorldRule {
  id: string;
  text: string;
  category: 'magic' | 'tech' | 'social' | 'physics' | 'other';
  source: SourceRef;
  confidence: Confidence;
  established_in: string | null;
}

export interface WorldSection {
  name: string;
  setting_summary: string;
  setting_attributes: {
    time_period: string;
    technology_level: string;
    magic_or_supernatural: string;
    society: { political: string; cultural: string; economic: string };
  };
  geography: unknown[];
  rules?: WorldRule[];
  timeline: { anchors: unknown[] };
}

// ---------------------------------------------------------------------------
// user_voice section (story-state phase 7). Field-for-field mirror of
// UserVoiceSection in app/schemas/story.py.
// ---------------------------------------------------------------------------

export interface SentenceLength {
  mean: number;
  distribution: 'short-dominant' | 'balanced' | 'long-dominant' | 'varied';
}

export interface Diction {
  preferred_vocabulary: string[];
  avoided_vocabulary: string[];
  sentence_length: SentenceLength;
  paragraph_density: 'tight' | 'medium' | 'loose';
}

export interface PovPreferences {
  in_chat: ChatPov | null;
  likely_target_for_prose: RenderPov | null;
}

export interface InteractionStyle {
  tendency: 'directive' | 'collaborative' | 'reactive';
  direction_to_narration_ratio: number;
  typical_input_length: number;
}

export interface SamplePassage {
  text: string;
  source?: SourceRef | null;
}

export interface UserVoiceSection {
  style_summary: string;
  register: 'literary' | 'commercial' | 'pulp' | 'experimental' | 'mixed';
  diction: Diction;
  rhetorical_devices: string[];
  pov_preferences: PovPreferences;
  interaction_style: InteractionStyle;
  sample_passages: SamplePassage[];
  /** Model self-assessment (float, not Confidence — D6). Low values mean
   *  "don't fabricate voice — ask the user for prose instead". */
  confidence: number;
}

// ---------------------------------------------------------------------------
// scenes (story_scenes rows — the workhorse object, story-state phase 7).
// Field-for-field mirror of Scene in app/schemas/story.py.
// ---------------------------------------------------------------------------

export interface SceneSetting {
  location_ref?: string | null;
  time_ref?: string | null;
  atmosphere: string;
}

/** Filled by the deferred step-3 annotate pass — always null in v1. */
export interface SceneFunction {
  beat:
    | 'inciting'
    | 'rising'
    | 'midpoint'
    | 'crisis'
    | 'climax'
    | 'denouement'
    | 'interlude';
  tension: number;
  mood: string;
  stakes: string;
}

export interface MessageRange {
  start: MsgRef;
  end: MsgRef;
}

/** `msg.swipe_idx` IS the chosen swipe — there is no separate
 *  `chosen_swipe_idx` (v1.1 amendment, drops the doc's original field). */
export interface SwipeResolution {
  msg: MsgRef;
  alternate_swipes_available: number;
}

export interface ExcludedSegment {
  range: MessageRange;
  reason: 'ooc' | 'system' | 'regen_artifact' | 'user_marked';
}

export interface SceneSource {
  message_range: MessageRange;
  total_messages: number;
  swipe_resolutions: SwipeResolution[];
  excluded_segments: ExcludedSegment[];
}

/** Filled by the deferred step-3 annotate pass — always null in v1. */
export interface SceneTransformations {
  compression_recommendation: 'cut' | 'compress' | 'preserve' | 'expand';
  compression_ratio_target: number;
  pacing_notes: string;
  dialogue_density: number;
}

export interface SceneAnnotations {
  user_notes: string;
  author_intent: string;
  flagged_issues: string[];
  /** Set when upstream history diverged (phase 10). */
  stale_source: boolean;
}

export interface Scene {
  id: string;
  sequence: number;
  title: string;
  summary: string;
  detailed_summary: string;
  setting: SceneSetting;
  participants: string[];
  pov_character?: string | null;
  function?: SceneFunction | null;
  source: SceneSource;
  /** Derived index into the canonical story_facts rows (D4). */
  continuity_facts_established: string[];
  transformations?: SceneTransformations | null;
  annotations: SceneAnnotations;
}

export interface RenderingHintsSection {
  novel: {
    pov: RenderPov | null;
    pov_character: string | null;
    tense: 'past' | 'present' | null;
    chapter_breaks: string[];
    chapter_titles: { scene_id: string; title: string }[];
    compression_level: 'tight' | 'balanced' | 'loose';
    target_word_count: number | null;
    style_anchors: string[];
  };
  screenplay: {
    format: 'fountain' | 'final_draft';
    sluglines_inferred: boolean;
    page_target: number | null;
  };
  graphic_novel: {
    pages_per_scene: number;
    panel_density: 'sparse' | 'standard' | 'dense';
    art_style_brief: string;
    character_consistency_refs: { character_ref: string; asset_ref: string }[];
  };
  storyboard: {
    aspect_ratio: '2.39:1' | '16:9' | '4:3';
    panels_per_scene: number;
  };
}

// ---------------------------------------------------------------------------
// continuity section (phase 8 — reconcile)
//
// Mirrors ggbc-backend `app/schemas/story.py` Contradiction /
// ContradictionResolution / ContinuitySection, which have existed since
// phase 3a but were never added on this side. Same gap phase 7 had to
// close for Scene and UserVoiceSection: the backend validates these with
// extra="forbid", so a field that drifts here is a 422 at write time, not
// a type error at build time. Keep them in step.
// ---------------------------------------------------------------------------

export type ContradictionType =
  | 'character_attribute'
  | 'world_rule'
  | 'timeline'
  | 'relationship'
  | 'object_state';

export interface ContradictionResolution {
  status: 'unresolved' | 'user_chose' | 'agent_resolved' | 'deferred';
  /** The winning fact id once something has actually been chosen. */
  canonical_choice?: string | null;
  rationale: string;
  resolved_at?: string | null;
}

export interface Contradiction {
  id: string;
  type: ContradictionType;
  description: string;
  /** The competing fact ids. Reconcile always emits at least two — a
   *  single fact cannot contradict anything. */
  sources: string[];
  detected_by: 'agent' | 'user';
  resolution: ContradictionResolution;
}

export interface ContinuitySection {
  contradictions: Contradiction[];
}

// ---------------------------------------------------------------------------
// Edit log (phase 10)
//
// Mirrors ggbc-backend `Edit` / `EditTarget`. The log has been writable
// since phase 4 and readable since phase 5, but nothing on this side ever
// built a row — phase 8 §11 left the client helper to phase 10, so these
// types are new here even though the backend models are old. Same
// extra="forbid" rule as every other section: a drifted field name is a
// 422 at append time, invisible to tsc.
// ---------------------------------------------------------------------------

export type EditClassification =
  | 'cosmetic'
  | 'substantive'
  | 'voice_shift'
  | 'contradiction';

export interface EditTarget {
  type:
    | 'scene'
    | 'character'
    | 'fact'
    | 'voice'
    | 'rule'
    | 'meta'
    | 'world'
    | 'hints'
    | 'contradiction';
  /** A real UUID for scene/fact/contradiction/character targets; null for
   *  the whole-section ones (`meta`, `voice`, `world`, `hints`) which have
   *  no row id to point at. A non-UUID string is a 422. */
  id?: string | null;
}

export interface Edit {
  id: string;
  occurred_at: string;
  actor: 'user' | 'agent';
  surface: 'rendered_output' | 'bible_direct';
  target: EditTarget;
  diff?: string;
  classification: EditClassification;
  propagated_to_bible?: boolean;
  propagation_notes?: string;
}

// ---------------------------------------------------------------------------
// Fact tombstones (phase 10)
// ---------------------------------------------------------------------------

/** A deleted fact's row payload. The backend replaces `data` wholesale with
 *  exactly these two keys, keeping `seq`/`id`/`created_at` on the row — see
 *  the delete endpoint's docstring for why the row must survive. */
export interface FactTombstone {
  id: string;
  deleted_at: string;
}

/** The live-vs-deleted discriminator, in one place.
 *
 *  `BibleFact` is `extra="forbid"` server-side, so no appended fact can
 *  ever carry a `deleted_at` key — presence of the key IS the tombstone.
 *  Every consumer of a raw `StoryLogEntry.data` (the review index, the
 *  accordion, reconcile's `loadAllFacts`, the card-fact append) must go
 *  through this rather than inlining the check, so there is exactly one
 *  definition of "deleted" to keep in step with the server. */
export function isFactTombstone(
  data: Record<string, unknown> | null | undefined
): data is Record<string, unknown> & FactTombstone {
  return (
    !!data && typeof data === 'object' && typeof data.deleted_at === 'string'
  );
}
