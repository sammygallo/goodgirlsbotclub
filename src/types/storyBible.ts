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
