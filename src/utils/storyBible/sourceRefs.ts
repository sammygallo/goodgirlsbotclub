// SourceRef construction and drift detection (story-state phase 5).
//
// The bible links back to source material through SourceRef envelopes
// whose `ref` uses the platform's string identity — which may dangle
// after a rename or delete, by contract. The server validates SHAPE ONLY
// and never checks referential integrity, so classifying a ref as
// live / drifted / dangling is entirely this module's job, done at
// display time against whatever the app currently holds.

import type { ProjectChatRef } from '../../api/client';
import type {
  CharacterSourceRef,
  ChatSourceRef,
  HashAlg,
  PersonaSourceRef,
  RefState,
  SourceRef,
  SourceSnapshot,
} from '../../types/storyBible';

/** Non-cryptographic fallback for non-secure contexts (LAN dev over
 *  plain http has no crypto.subtle). Recorded as `hash_alg: 'djb2'` so a
 *  consumer never compares hashes across algorithms. */
function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export interface HashResult {
  sha: string;
  hash_alg: HashAlg;
}

/** Hash text for a snapshot/fingerprint. Prefers SHA-256; falls back to
 *  djb2 when crypto.subtle is unavailable, and always reports which one
 *  it used — the backend rejects a sha without its hash_alg precisely so
 *  this can't be lost. */
export async function hashText(text: string): Promise<HashResult> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text)
      );
      const sha = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return { sha, hash_alg: 'sha256' };
    } catch {
      // Fall through — some embedded webviews expose a stub that throws.
    }
  }
  return { sha: djb2(text), hash_alg: 'djb2' };
}

/** ISO-8601 with an explicit offset. `toISOString()` always yields `Z`,
 *  which satisfies the backend's AwareDatetime; a naive local string
 *  would be rejected. */
export function capturedAt(now: Date = new Date()): string {
  return now.toISOString();
}

export function chatSourceRef(
  ref: ProjectChatRef,
  snapshot?: SourceSnapshot
): ChatSourceRef {
  return {
    kind: 'chat',
    ref,
    snapshot: snapshot ?? { name: ref.file_name },
    captured_at: capturedAt(),
  };
}

export function characterSourceRef(
  avatar: string,
  displayName?: string
): CharacterSourceRef {
  return {
    kind: 'character',
    ref: avatar,
    snapshot: { name: displayName ?? avatar },
    captured_at: capturedAt(),
  };
}

export function personaSourceRef(
  name: string,
  description?: string
): PersonaSourceRef {
  return {
    kind: 'persona',
    ref: name,
    // Personas have no backend identity at all, so the snapshot is the
    // only durable record of what the persona was at ingest time.
    snapshot: { name, excerpt: description?.slice(0, 500) },
    captured_at: capturedAt(),
  };
}

/** Everything the ref-state check compares against. Callers pass what
 *  the app already has loaded; anything omitted is treated as unknown
 *  rather than missing, so a not-yet-loaded list can't make every ref
 *  look dangling. */
export interface LiveRefs {
  characterAvatars?: readonly string[];
  characterNameByAvatar?: ReadonlyMap<string, string>;
  chats?: readonly ProjectChatRef[];
  personaNames?: readonly string[];
}

function sameChat(a: ProjectChatRef, b: ProjectChatRef): boolean {
  return a.character_avatar === b.character_avatar && a.file_name === b.file_name;
}

/**
 * Classify a ref against live state.
 *
 * Returns `live` when we cannot tell (the relevant list isn't loaded):
 * flagging every ref as broken because a fetch hasn't landed would train
 * users to ignore the badge, which is the one thing it must not do.
 */
export function resolveRefState(ref: SourceRef, live: LiveRefs): RefState {
  switch (ref.kind) {
    case 'chat': {
      if (!live.chats) return 'live';
      return live.chats.some((c) => sameChat(c, ref.ref)) ? 'live' : 'dangling';
    }
    case 'character': {
      if (!live.characterAvatars) return 'live';
      if (!live.characterAvatars.includes(ref.ref)) return 'dangling';
      const snapshotName = ref.snapshot?.name;
      const liveName = live.characterNameByAvatar?.get(ref.ref);
      // Same avatar file, different display name: the card was edited
      // under the bible. Not broken, but not what was captured either.
      if (snapshotName && liveName && snapshotName !== liveName) return 'drifted';
      return 'live';
    }
    case 'card_field': {
      if (!live.characterAvatars) return 'live';
      return live.characterAvatars.includes(ref.ref.character_avatar)
        ? 'live'
        : 'dangling';
    }
    case 'chat_message': {
      if (!live.chats) return 'live';
      // Only the containing chat is checkable here; whether the MESSAGE
      // still matches is a fingerprint comparison the caller does with
      // the message in hand (see MsgRef.fingerprint).
      return live.chats.some((c) => sameChat(c, ref.ref.chat)) ? 'live' : 'dangling';
    }
    case 'persona': {
      if (!live.personaNames) return 'live';
      return live.personaNames.includes(ref.ref) ? 'live' : 'dangling';
    }
    case 'lorebook_entry':
      // Books can be unlinked without being deleted; treating that as
      // dangling would cry wolf. Left unresolved until an ingestion pass
      // has a reason to care.
      return 'live';
    case 'user_annotation':
    case 'agent_inference':
      // Provenance terminators: the user or an agent said so. There is
      // no external referent that could break.
      return 'live';
    default:
      return 'live';
  }
}

/** Human-readable label for a ref, preferring the snapshot so a deleted
 *  referent still reads as something other than a filename. */
export function describeRef(ref: SourceRef): string {
  switch (ref.kind) {
    case 'chat':
      return ref.snapshot?.name || ref.ref.file_name;
    case 'character':
      return ref.snapshot?.name || ref.ref;
    case 'card_field':
      return `${ref.ref.character_avatar} · ${ref.ref.field}`;
    case 'chat_message':
      return `message ${ref.ref.msg.msg_id.slice(0, 8)}`;
    case 'persona':
      return ref.snapshot?.name || ref.ref;
    case 'lorebook_entry':
      return `lorebook ${ref.ref.entry_id}`;
    case 'user_annotation':
      return 'you';
    case 'agent_inference':
      return 'inferred';
    default:
      return 'unknown source';
  }
}

/** Mint a bible-local UUID (character/scene/fact/edit ids, bible_id).
 *  Same crypto.randomUUID-with-fallback shape as message identity. */
export function bibleUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
