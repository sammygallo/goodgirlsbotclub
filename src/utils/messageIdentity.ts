// Message identity (story-state phase 1).
//
// Every chat message gets a permanent UUID, minted client-side at creation
// and persisted on the ST wire shape at `extra.ggbc_id` (ST's extension bag,
// passed through raw by transcript importers). The story bible's provenance
// model (docs/story-state-step2-plan.md) addresses messages by this id; the
// backend heals missing/duplicate ids on every save from phase 2 onward.
// Before phase 1, in-memory ids were `msg_<counter>_<timestamp>` — unique
// within a session but regenerated on every load, which is also why
// branch/translation bookkeeping keyed by message id never survived reloads.

export function generateMessageId(): string {
  // Secure contexts only; LAN-dev over plain http lacks crypto.randomUUID.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Math.random v4 fallback — collision odds are irrelevant at chat scale,
  // and the backend heal re-mints duplicates anyway.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * A usable wire id: non-empty string of sane length. Deliberately NOT
 * restricted to UUID format — third-party writers may use their own scheme,
 * and a stable foreign id beats a re-minted one for provenance.
 */
export function isValidMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Read a persisted message id out of a wire message's `extra` bag. */
export function takeWireMessageId(extra: unknown): string | null {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const id = (extra as Record<string, unknown>).ggbc_id;
  return isValidMessageId(id) ? id : null;
}

/**
 * Enforce id uniqueness across a freshly normalized message list, in place:
 * keep the first occurrence, re-mint later duplicates. Mirrors the backend
 * heal's keep-first semantics so both sides converge on the same ids.
 * Duplicates appear when a chat file was copied/branched or a foreign
 * import reused ids.
 */
export function ensureUniqueMessageIds<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  for (const msg of messages) {
    if (seen.has(msg.id)) {
      msg.id = generateMessageId();
    }
    seen.add(msg.id);
  }
  return messages;
}

/** The identity triple that survives edits, swipes, and regenerations —
 *  content changes on all of those, but creation time/author don't. */
interface MessageIdentitySignature {
  id: string;
  timestamp: number;
  isUser: boolean;
  name: string;
}

/**
 * Re-key a restored message snapshot (branch checkpoint) against the live
 * chat. Snapshots carry whatever ids existed at checkpoint time — session
 * ids from before permanent UUIDs shipped, or freshly minted UUIDs that
 * never reached disk — and restoring them verbatim would persist those
 * stale ids over the chat's real ones on the next save. For each restored
 * message, adopt the id of the first unconsumed live message with the same
 * (timestamp, isUser, name); messages with no live counterpart (the
 * diverged tail) keep their snapshot id. Returns cloned messages — the
 * snapshot objects belong to the branch store and must not be mutated.
 * Callers should follow with ensureUniqueMessageIds.
 */
export function rekeyRestoredMessages<T extends MessageIdentitySignature>(
  restored: T[],
  live: ReadonlyArray<MessageIdentitySignature>
): T[] {
  const signature = (m: MessageIdentitySignature) =>
    `${m.timestamp}:${m.isUser ? 'u' : 'a'}:${m.name}`;
  const liveIdsBySignature = new Map<string, string[]>();
  for (const m of live) {
    const key = signature(m);
    const ids = liveIdsBySignature.get(key) ?? [];
    ids.push(m.id);
    liveIdsBySignature.set(key, ids);
  }
  return restored.map((msg) => {
    const ids = liveIdsBySignature.get(signature(msg));
    const adopted = ids && ids.length > 0 ? ids.shift() : undefined;
    return { ...msg, id: adopted ?? msg.id };
  });
}
