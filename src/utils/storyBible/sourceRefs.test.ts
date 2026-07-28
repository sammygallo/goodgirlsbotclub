import { describe, it, expect, afterEach } from 'vitest';
import {
  bibleUuid,
  capturedAt,
  characterSourceRef,
  chatSourceRef,
  describeRef,
  hashText,
  personaSourceRef,
  resolveRefState,
} from './sourceRefs';
import type { SourceRef } from '../../types/storyBible';

const CHAT = { character_avatar: 'Ivy.png', file_name: 'Ivy - 2026-07-17' };

describe('hashText', () => {
  it('produces a stable sha256 in a secure context', async () => {
    const a = await hashText('the duke has a daughter');
    const b = await hashText('the duke has a daughter');
    expect(a.hash_alg).toBe('sha256');
    expect(a.sha).toBe(b.sha);
    expect(a.sha).toHaveLength(64);
  });

  it('distinguishes different text', async () => {
    const a = await hashText('green eyes');
    const b = await hashText('gray eyes');
    expect(a.sha).not.toBe(b.sha);
  });

  describe('without crypto.subtle (plain-http LAN dev)', () => {
    const real = globalThis.crypto;
    afterEach(() => {
      Object.defineProperty(globalThis, 'crypto', {
        value: real,
        configurable: true,
      });
    });

    it('falls back to djb2 and says so', async () => {
      Object.defineProperty(globalThis, 'crypto', {
        value: { randomUUID: real.randomUUID?.bind(real) },
        configurable: true,
      });
      const out = await hashText('green eyes');
      expect(out.hash_alg).toBe('djb2');
      expect(out.sha).toMatch(/^[0-9a-f]+$/);
      // Deterministic, so drift detection still works within one algorithm.
      expect((await hashText('green eyes')).sha).toBe(out.sha);
      expect((await hashText('gray eyes')).sha).not.toBe(out.sha);
    });

    it('falls back when subtle.digest throws (stubbed webviews)', async () => {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          subtle: {
            digest: () => {
              throw new Error('not implemented');
            },
          },
        },
        configurable: true,
      });
      expect((await hashText('x')).hash_alg).toBe('djb2');
    });
  });
});

describe('capturedAt', () => {
  it('emits a timezone-qualified stamp (the backend rejects naive)', () => {
    const stamp = capturedAt(new Date('2026-07-28T12:00:00Z'));
    expect(stamp).toBe('2026-07-28T12:00:00.000Z');
    expect(stamp.endsWith('Z')).toBe(true);
  });
});

describe('ref constructors', () => {
  it('builds a chat ref with a snapshot naming the file', () => {
    const ref = chatSourceRef(CHAT);
    expect(ref.kind).toBe('chat');
    expect(ref.ref).toEqual(CHAT);
    expect(ref.snapshot?.name).toBe(CHAT.file_name);
    expect(ref.captured_at.endsWith('Z')).toBe(true);
  });

  it('snapshots the character display name, not just the avatar', () => {
    const ref = characterSourceRef('Ivy.png', 'Ivy');
    expect(ref.ref).toBe('Ivy.png');
    expect(ref.snapshot?.name).toBe('Ivy');
  });

  it('keeps a persona excerpt — personas have no backend identity', () => {
    const ref = personaSourceRef('Sammy', 'A tired dev'.repeat(200));
    expect(ref.ref).toBe('Sammy');
    expect(ref.snapshot?.excerpt?.length).toBeLessThanOrEqual(500);
  });
});

describe('resolveRefState', () => {
  it('reports a live chat ref when the chat is still attached', () => {
    expect(resolveRefState(chatSourceRef(CHAT), { chats: [CHAT] })).toBe('live');
  });

  it('reports dangling when the chat is gone', () => {
    expect(resolveRefState(chatSourceRef(CHAT), { chats: [] })).toBe('dangling');
  });

  it('reports drifted when a character was renamed under the bible', () => {
    const ref = characterSourceRef('Ivy.png', 'Ivy');
    expect(
      resolveRefState(ref, {
        characterAvatars: ['Ivy.png'],
        characterNameByAvatar: new Map([['Ivy.png', 'Ivy Reborn']]),
      })
    ).toBe('drifted');
  });

  it('reports live when the character name still matches', () => {
    const ref = characterSourceRef('Ivy.png', 'Ivy');
    expect(
      resolveRefState(ref, {
        characterAvatars: ['Ivy.png'],
        characterNameByAvatar: new Map([['Ivy.png', 'Ivy']]),
      })
    ).toBe('live');
  });

  it('reports dangling when the character file is gone', () => {
    expect(
      resolveRefState(characterSourceRef('Gone.png'), { characterAvatars: [] })
    ).toBe('dangling');
  });

  it('never cries wolf while the live list is still unknown', () => {
    // Nothing loaded: every ref must read as fine, or the badge becomes
    // noise the user learns to ignore.
    expect(resolveRefState(chatSourceRef(CHAT), {})).toBe('live');
    expect(resolveRefState(characterSourceRef('Ivy.png'), {})).toBe('live');
  });

  it('treats provenance terminators as always live', () => {
    const annotation: SourceRef = {
      kind: 'user_annotation',
      captured_at: capturedAt(),
    };
    const inference: SourceRef = {
      kind: 'agent_inference',
      captured_at: capturedAt(),
    };
    expect(resolveRefState(annotation, { chats: [] })).toBe('live');
    expect(resolveRefState(inference, { chats: [] })).toBe('live');
  });

  it('checks the containing chat for a message ref', () => {
    const ref: SourceRef = {
      kind: 'chat_message',
      ref: {
        chat: CHAT,
        msg: {
          msg_id: 'abc',
          swipe_idx: 0,
          fingerprint: { sha: 'x', hash_alg: 'sha256', send_date: 1 },
        },
      },
      captured_at: capturedAt(),
    };
    expect(resolveRefState(ref, { chats: [CHAT] })).toBe('live');
    expect(resolveRefState(ref, { chats: [] })).toBe('dangling');
  });
});

describe('describeRef', () => {
  it('prefers the snapshot so a deleted referent still reads', () => {
    expect(describeRef(characterSourceRef('Ivy.png', 'Ivy'))).toBe('Ivy');
    expect(describeRef(chatSourceRef(CHAT))).toBe(CHAT.file_name);
    expect(
      describeRef({ kind: 'user_annotation', captured_at: capturedAt() })
    ).toBe('you');
  });
});

describe('bibleUuid', () => {
  it('mints unique v4 ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => bibleUuid()));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});
