import { describe, it, expect } from 'vitest';
import {
  extendChunkPlan,
  planTranscriptChunks,
  sliceChunksFromPlan,
  WALK_CHUNK_SOFT_CAP,
  WALK_FORCE_SPLIT_MESSAGES,
} from './transcriptChunker';
import type { IngestMessage } from './types';

function msg(over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id: over.id ?? `m${Math.random()}`,
    name: 'Aria',
    isUser: false,
    isSystem: false,
    content: 'hello there',
    timestamp: 0,
    swipeIdx: 0,
    swipesCount: 1,
    ...over,
  };
}

function idSequence(n: number, prefix = 'm'): IngestMessage[] {
  return Array.from({ length: n }, (_, i) => msg({ id: `${prefix}${i}`, content: `line ${i}` }));
}

describe('planTranscriptChunks', () => {
  it('returns nothing for an empty transcript', () => {
    const plan = planTranscriptChunks([]);
    expect(plan.chunks).toEqual([]);
    expect(plan.chunkPlan).toEqual([]);
    expect(plan.exceedsSoftCap).toBe(false);
  });

  it('covers every message exactly once, in order, with no split message', () => {
    const messages = idSequence(500);
    const plan = planTranscriptChunks(messages);
    const flattened = plan.chunks.flatMap((c) => c.messages.map((m) => m.id));
    expect(flattened).toEqual(messages.map((m) => m.id));
  });

  it('force-splits at WALK_FORCE_SPLIT_MESSAGES even when token-light', () => {
    // Very short messages so the token budget alone would never split.
    const messages = idSequence(WALK_FORCE_SPLIT_MESSAGES * 3).map((m) => ({
      ...m,
      content: 'hi',
    }));
    const plan = planTranscriptChunks(messages);
    for (const chunk of plan.chunks) {
      expect(chunk.messages.length).toBeLessThanOrEqual(WALK_FORCE_SPLIT_MESSAGES);
    }
    expect(plan.chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('splits on the token budget for long messages well under the message-count cap', () => {
    const longContent = 'word '.repeat(3000); // far more than one chunk's budget
    const messages = [msg({ id: 'a', content: longContent }), msg({ id: 'b', content: longContent })];
    const plan = planTranscriptChunks(messages);
    // Each message alone blows the budget, so each gets its own chunk.
    expect(plan.chunks.length).toBe(2);
    expect(plan.chunks[0].messages).toHaveLength(1);
  });

  it('gives system messages a slot but zero token weight', () => {
    const messages = [
      msg({ id: 's1', isSystem: true, content: 'x'.repeat(50000) }),
      msg({ id: 'm1', content: 'hi' }),
    ];
    const plan = planTranscriptChunks(messages);
    // Both fit in one chunk because the system message contributed 0 tokens.
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].messages.map((m) => m.id)).toEqual(['s1', 'm1']);
  });

  it('flags exceedsSoftCap without truncating the transcript', () => {
    // Force one chunk per message so the count blows the soft cap.
    const longContent = 'word '.repeat(3000);
    const messages = idSequence(WALK_CHUNK_SOFT_CAP + 5).map((m) => ({
      ...m,
      content: longContent,
    }));
    const plan = planTranscriptChunks(messages);
    expect(plan.exceedsSoftCap).toBe(true);
    // Not truncated — every message still present.
    expect(plan.chunks.flatMap((c) => c.messages)).toHaveLength(messages.length);
  });

  it('produces a chunkPlan whose boundaries match the chunk message ids', () => {
    const messages = idSequence(150);
    const plan = planTranscriptChunks(messages);
    plan.chunkPlan.forEach((entry, i) => {
      const chunk = plan.chunks[i];
      expect(entry.start_msg_id).toBe(chunk.messages[0].id);
      expect(entry.end_msg_id).toBe(chunk.messages[chunk.messages.length - 1].id);
    });
  });
});

describe('sliceChunksFromPlan', () => {
  it('reconstructs the same chunks from a plan against an unchanged transcript', () => {
    const messages = idSequence(120);
    const original = planTranscriptChunks(messages);
    const rebuilt = sliceChunksFromPlan(messages, original.chunkPlan);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.map((c) => c.messages.map((m) => m.id))).toEqual(
      original.chunks.map((c) => c.messages.map((m) => m.id))
    );
  });

  it('returns null when a boundary message no longer exists', () => {
    const messages = idSequence(120);
    const plan = planTranscriptChunks(messages).chunkPlan;
    const withoutOne = messages.filter((m) => m.id !== plan[1].start_msg_id);
    expect(sliceChunksFromPlan(withoutOne, plan)).toBeNull();
  });

  it('returns null when a boundary pair is out of order', () => {
    const messages = idSequence(10);
    const badPlan = [{ start_msg_id: 'm5', end_msg_id: 'm2', est_tokens: 0 }];
    expect(sliceChunksFromPlan(messages, badPlan)).toBeNull();
  });
});

describe('extendChunkPlan', () => {
  it('plans nothing when the pinned plan already covers every message', () => {
    const messages = idSequence(120);
    const plan = planTranscriptChunks(messages).chunkPlan;
    const ext = extendChunkPlan(messages, plan);
    expect(ext.entries).toEqual([]);
    expect(ext.chunks).toEqual([]);
    expect(ext.lastPlannedIndex).toBe(messages.length - 1);
    expect(ext.exceedsSoftCap).toBe(false);
  });

  it('plans only the tail past the last pinned boundary', () => {
    const walked = idSequence(120);
    const plan = planTranscriptChunks(walked).chunkPlan;
    const appended = Array.from({ length: 5 }, (_, i) =>
      msg({ id: `new${i}`, content: `new line ${i}` })
    );
    const live = [...walked, ...appended];

    const ext = extendChunkPlan(live, plan);
    expect(ext.lastPlannedIndex).toBe(walked.length - 1);
    expect(ext.chunks.flatMap((c) => c.messages.map((m) => m.id))).toEqual(
      appended.map((m) => m.id)
    );
    // The pinned prefix is never rewritten — extension only appends.
    expect(ext.entries.length).toBeGreaterThan(0);
    expect(ext.entries[0].start_msg_id).toBe('new0');
  });

  it('produces a plan that slices cleanly once concatenated', () => {
    const walked = idSequence(80);
    const plan = planTranscriptChunks(walked).chunkPlan;
    const live = [...walked, ...idSequence(30, 'later')];

    const ext = extendChunkPlan(live, plan);
    const extended = [...plan, ...ext.entries];
    const sliced = sliceChunksFromPlan(live, extended);

    expect(sliced).not.toBeNull();
    // Every live message ends up in exactly one chunk, in order.
    expect(sliced!.flatMap((c) => c.messages.map((m) => m.id))).toEqual(
      live.map((m) => m.id)
    );
  });

  it('reports lastPlannedIndex -1 when the final boundary is gone (divergence, not extension)', () => {
    const walked = idSequence(60);
    const plan = planTranscriptChunks(walked).chunkPlan;
    const lastId = plan[plan.length - 1].end_msg_id;
    const live = walked.filter((m) => m.id !== lastId);

    const ext = extendChunkPlan(live, plan);
    expect(ext.lastPlannedIndex).toBe(-1);
    // Callers must check the index: empty entries here does NOT mean
    // "nothing new".
    expect(ext.entries).toEqual([]);
  });

  it('reports lastPlannedIndex -1 for an empty pinned plan', () => {
    expect(extendChunkPlan(idSequence(5), []).lastPlannedIndex).toBe(-1);
  });

  it('scopes exceedsSoftCap to the extension, not the cumulative total', () => {
    // A prior plan already far past the cap, plus a tiny tail.
    const walked = idSequence(WALK_FORCE_SPLIT_MESSAGES * (WALK_CHUNK_SOFT_CAP + 5));
    const plan = planTranscriptChunks(walked).chunkPlan;
    expect(plan.length).toBeGreaterThan(WALK_CHUNK_SOFT_CAP);

    const live = [...walked, msg({ id: 'tail', content: 'one more' })];
    const ext = extendChunkPlan(live, plan);

    expect(ext.chunks.length).toBe(1);
    // The user already paid for the prior chunks; do not re-prompt.
    expect(ext.exceedsSoftCap).toBe(false);
  });

  it('sets exceedsSoftCap when the extension alone is huge', () => {
    const walked = idSequence(10);
    const plan = planTranscriptChunks(walked).chunkPlan;
    const live = [
      ...walked,
      ...idSequence(WALK_FORCE_SPLIT_MESSAGES * (WALK_CHUNK_SOFT_CAP + 2), 'big'),
    ];
    expect(extendChunkPlan(live, plan).exceedsSoftCap).toBe(true);
  });
});
