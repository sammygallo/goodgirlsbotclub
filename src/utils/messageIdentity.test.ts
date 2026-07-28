import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  isValidMessageId,
  takeWireMessageId,
  ensureUniqueMessageIds,
  rekeyRestoredMessages,
} from './messageIdentity';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateMessageId', () => {
  it('mints v4 UUIDs', () => {
    expect(generateMessageId()).toMatch(UUID_V4);
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateMessageId()));
    expect(ids.size).toBe(1000);
  });
});

describe('isValidMessageId', () => {
  it('accepts non-empty strings up to 128 chars, including non-UUID foreign ids', () => {
    expect(isValidMessageId(generateMessageId())).toBe(true);
    expect(isValidMessageId('foreign-id-123')).toBe(true);
    expect(isValidMessageId('x'.repeat(128))).toBe(true);
  });

  it('rejects empty, oversized, and non-string values', () => {
    expect(isValidMessageId('')).toBe(false);
    expect(isValidMessageId('x'.repeat(129))).toBe(false);
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(isValidMessageId(bad)).toBe(false);
    }
  });
});

describe('takeWireMessageId', () => {
  it('reads a valid ggbc_id out of the extra bag', () => {
    const id = generateMessageId();
    expect(takeWireMessageId({ ggbc_id: id, images: ['data:x'] })).toBe(id);
  });

  it('returns null for missing/invalid extra or id', () => {
    expect(takeWireMessageId(undefined)).toBeNull();
    expect(takeWireMessageId(null)).toBeNull();
    expect(takeWireMessageId('string')).toBeNull();
    expect(takeWireMessageId([])).toBeNull();
    expect(takeWireMessageId({})).toBeNull();
    expect(takeWireMessageId({ ggbc_id: '' })).toBeNull();
    expect(takeWireMessageId({ ggbc_id: 42 })).toBeNull();
  });
});

describe('ensureUniqueMessageIds', () => {
  it('keeps first occurrence and re-mints later duplicates', () => {
    const dup = generateMessageId();
    const other = generateMessageId();
    const messages = [{ id: dup }, { id: other }, { id: dup }, { id: dup }];
    ensureUniqueMessageIds(messages);
    expect(messages[0].id).toBe(dup);
    expect(messages[1].id).toBe(other);
    expect(messages[2].id).not.toBe(dup);
    expect(messages[3].id).not.toBe(dup);
    expect(new Set(messages.map((m) => m.id)).size).toBe(4);
  });

  it('leaves an already-unique list untouched', () => {
    const messages = Array.from({ length: 5 }, () => ({ id: generateMessageId() }));
    const before = messages.map((m) => m.id);
    ensureUniqueMessageIds(messages);
    expect(messages.map((m) => m.id)).toEqual(before);
  });
});

describe('rekeyRestoredMessages', () => {
  const msg = (id: string, timestamp: number, isUser: boolean, name = 'Ivy') => ({
    id,
    timestamp,
    isUser,
    name,
  });

  it('adopts live ids for the shared prefix, keeps snapshot ids for the diverged tail', () => {
    const liveA = generateMessageId();
    const liveB = generateMessageId();
    const live = [msg(liveA, 100, true), msg(liveB, 200, false)];
    // pre-phase-1 checkpoint: counter ids, same underlying messages + one
    // snapshot-only message the live chat no longer has
    const restored = [
      msg('msg_1_100', 100, true),
      msg('msg_2_200', 200, false),
      msg('msg_3_300', 300, true),
    ];
    const out = rekeyRestoredMessages(restored, live);
    expect(out.map((m) => m.id)).toEqual([liveA, liveB, 'msg_3_300']);
  });

  it('matches on the (timestamp, isUser, name) triple even when content-era ids differ', () => {
    const liveId = generateMessageId();
    const out = rekeyRestoredMessages(
      [msg('stale', 100, false, 'Nyx')],
      [msg(liveId, 100, false, 'Nyx'), msg(generateMessageId(), 100, true, 'Nyx')]
    );
    expect(out[0].id).toBe(liveId);
  });

  it('consumes duplicate-signature live messages in order, once each', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    const live = [msg(a, 100, false), msg(b, 100, false)];
    const out = rekeyRestoredMessages(
      [msg('s1', 100, false), msg('s2', 100, false), msg('s3', 100, false)],
      live
    );
    expect(out.map((m) => m.id)).toEqual([a, b, 's3']);
  });

  it('clones — the snapshot objects (owned by the branch store) are never mutated', () => {
    const restored = [msg('snapshot-id', 100, true)];
    const out = rekeyRestoredMessages(restored, [msg(generateMessageId(), 100, true)]);
    expect(restored[0].id).toBe('snapshot-id');
    expect(out[0]).not.toBe(restored[0]);
  });

  it('composes with ensureUniqueMessageIds: an unmatched snapshot id colliding with an adopted id is re-minted', () => {
    const liveId = generateMessageId();
    // tail message's snapshot id happens to equal the id the prefix adopts
    const out = ensureUniqueMessageIds(
      rekeyRestoredMessages(
        [msg('old', 100, true), msg(liveId, 300, true)],
        [msg(liveId, 100, true)]
      )
    );
    expect(out[0].id).toBe(liveId);
    expect(out[1].id).not.toBe(liveId);
  });
});

describe('wire round-trip (Phase 1 acceptance)', () => {
  it('an id persisted at extra.ggbc_id survives serialize -> JSON -> normalize', () => {
    // Mirrors buildChatPayload's emit and normalizeMessage's adoption: the
    // in-memory id goes out as extra.ggbc_id and must come back as the id.
    const id = generateMessageId();
    const wire = JSON.parse(
      JSON.stringify({ mes: 'hi', extra: { ggbc_id: id, usage: { inputTokens: 1 } } })
    );
    expect(takeWireMessageId(wire.extra)).toBe(id);
  });

  it('a pre-phase-1 message (no extra) gets a fresh mint', () => {
    const wire = JSON.parse(JSON.stringify({ mes: 'hi' }));
    expect(takeWireMessageId(wire.extra)).toBeNull();
  });
});
