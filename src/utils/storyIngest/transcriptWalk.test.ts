import { describe, it, expect, vi } from 'vitest';
import { processChunk, deterministicUuid } from './transcriptWalk';
import type { KnownCastMember, OpenSceneCarry, ProcessChunkParams } from './transcriptWalk';
import type { WalkChunk } from './transcriptChunker';
import type { IngestMessage } from './types';

function msg(over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id: over.id ?? `m${Math.random()}`,
    name: 'Aria',
    isUser: false,
    isSystem: false,
    content: 'hello there',
    timestamp: 1000,
    swipeIdx: 0,
    swipesCount: 1,
    ...over,
  };
}

function chunkOf(messages: IngestMessage[]): WalkChunk {
  return {
    messages,
    startMsgId: messages[0].id,
    endMsgId: messages[messages.length - 1].id,
    estTokens: 100,
  };
}

const CAST: KnownCastMember[] = [
  { id: 'char-aria', name: 'Aria', aliases: [] },
  { id: 'char-user', name: 'Sam', aliases: ['Sammy'] },
];

const CHAT = { character_avatar: 'aria.png', file_name: 'chat1.jsonl' };

function baseParams(overrides: Partial<ProcessChunkParams> = {}): ProcessChunkParams {
  return {
    chunk: chunkOf([
      msg({ id: 'm1', isUser: true, name: 'Sam', content: 'I walk into the tavern.' }),
      msg({ id: 'm2', name: 'Aria', content: 'Aria looks up and smiles.' }),
    ]),
    previousTailMessages: [],
    openScene: null,
    nextSequence: 0,
    knownCast: CAST,
    recentFactsDigest: [],
    chat: CHAT,
    signal: undefined,
    // Every real test overrides this with its own fake — this default
    // only exists so the object literal satisfies the required field.
    llm: vi.fn(async () => '{"scenes":[]}'),
    ...overrides,
  };
}

function fakeLlmSequence(responses: string[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  });
}

const VALID_SCENE_JSON = JSON.stringify({
  scenes: [
    {
      continues_open_scene: false,
      title: 'The Tavern',
      summary: 'Sam meets Aria at the tavern.',
      detailed_summary: 'Sam walks in; Aria greets them.',
      participants: ['Sam', 'Aria'],
      start_local_idx: 0,
      end_local_idx: 1,
      closed: true,
      excluded_local_idxs: [],
      facts: [{ text: 'Aria works at the tavern.', category: 'introduction', local_idx: 1 }],
    },
  ],
});

describe('processChunk', () => {
  it('produces a fully-formed scene and fact from a valid model response', async () => {
    const llm = fakeLlmSequence([VALID_SCENE_JSON]);
    const result = await processChunk(baseParams({ llm }));

    expect(result.parseFailed).toBe(false);
    expect(result.llmCalls).toBe(1);
    expect(result.scenes).toHaveLength(1);
    const scene = result.scenes[0];
    expect(scene.baseTs).toBe(0);
    expect(scene.data.title).toBe('The Tavern');
    expect(scene.data.participants.sort()).toEqual(['char-aria', 'char-user']);
    expect(scene.data.source.message_range.start.msg_id).toBe('m1');
    expect(scene.data.source.message_range.end.msg_id).toBe('m2');
    expect(scene.data.sequence).toBe(0);
    expect(result.nextSequence).toBe(1);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].established_in).toBe(scene.data.id);
    expect(result.facts[0].category).toBe('introduction');
    expect(result.facts[0].confidence).toBe('explicit');
    expect(scene.data.continuity_facts_established).toEqual([result.facts[0].id]);
    expect(result.openScene).toBeNull();
  });

  it('retries once on invalid JSON and succeeds on the repair attempt', async () => {
    const llm = fakeLlmSequence(['not json at all', VALID_SCENE_JSON]);
    const result = await processChunk(baseParams({ llm }));
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.parseFailed).toBe(false);
    expect(result.scenes).toHaveLength(1);
  });

  it('gives up after the repair retry also fails, without throwing', async () => {
    const llm = fakeLlmSequence(['garbage', 'still garbage']);
    const result = await processChunk(baseParams({ llm }));
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.parseFailed).toBe(true);
    expect(result.scenes).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  it('drops a participant name that matches no known character', async () => {
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'X',
          summary: 'x',
          detailed_summary: '',
          participants: ['Sam', 'Nobody'],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ llm }));
    expect(result.scenes[0].data.participants).toEqual(['char-user']);
  });

  it('skips a malformed scene entry (out-of-range indices) without crashing the chunk', async () => {
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          start_local_idx: 99,
          end_local_idx: 100,
          closed: true,
          participants: [],
          excluded_local_idxs: [],
          facts: [],
        },
        {
          continues_open_scene: false,
          title: 'Real scene',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ llm }));
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].data.title).toBe('Real scene');
  });

  it('marks a system-message run inside the scene range as an excluded segment', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, name: 'Sam', content: 'Hi' }),
      msg({ id: 'sys1', isSystem: true, content: '[system note]' }),
      msg({ id: 'm2', name: 'Aria', content: 'Hello!' }),
    ]);
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'T',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1, // local indices skip the system message
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ chunk, llm }));
    const segs = result.scenes[0].data.source.excluded_segments;
    expect(segs).toHaveLength(1);
    expect(segs[0].reason).toBe('system');
    expect(segs[0].range.start.msg_id).toBe('sys1');
  });

  it('records alternate_swipes_available from swipesCount, mechanically', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, name: 'Sam', content: 'Hi' }),
      msg({ id: 'm2', name: 'Aria', content: 'Hello!', swipesCount: 3 }),
    ]);
    const llm = fakeLlmSequence([VALID_SCENE_JSON]);
    const result = await processChunk(baseParams({ chunk, llm }));
    const swipes = result.scenes[0].data.source.swipe_resolutions;
    expect(swipes).toHaveLength(1);
    expect(swipes[0].msg.msg_id).toBe('m2');
    expect(swipes[0].alternate_swipes_available).toBe(2);
  });

  it('reuses the open scene id, sequence and base_ts when continuing', async () => {
    const openScene: OpenSceneCarry = {
      sceneId: 'existing-scene-id',
      sequence: 5,
      title: 'Ongoing',
      summary: 'so far...',
      detailedSummary: '',
      participantIds: ['char-aria'],
      factIds: ['fact-1'],
      rangeStart: {
        msg_id: 'earlier',
        swipe_idx: 0,
        fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
      },
      excludedSegments: [],
      swipeResolutions: [],
      totalMessages: 3,
      serverTs: 7,
    };
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: true,
          title: 'Ongoing, continued',
          summary: 'still going',
          detailed_summary: '',
          participants: ['Sam'],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: false,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ llm, openScene, nextSequence: 6 }));

    expect(result.scenes[0].id).toBe('existing-scene-id');
    expect(result.scenes[0].baseTs).toBe(7);
    expect(result.scenes[0].data.sequence).toBe(5);
    expect(result.scenes[0].data.participants.sort()).toEqual(['char-aria', 'char-user']);
    expect(result.nextSequence).toBe(6); // no NEW scene minted, counter untouched
    expect(result.openScene).not.toBeNull();
    expect(result.openScene!.sceneId).toBe('existing-scene-id');
    expect(result.openScene!.rangeStart.msg_id).toBe('earlier'); // start never moves
  });

  it('forces every scene but the last to closed:true regardless of model output', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, content: 'a' }),
      msg({ id: 'm2', content: 'b' }),
      msg({ id: 'm3', isUser: true, content: 'c' }),
      msg({ id: 'm4', content: 'd' }),
    ]);
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'First',
          summary: 's1',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: false, // model lies — must be forced true, it's not last
          excluded_local_idxs: [],
          facts: [],
        },
        {
          continues_open_scene: false,
          title: 'Second',
          summary: 's2',
          detailed_summary: '',
          participants: [],
          start_local_idx: 2,
          end_local_idx: 3,
          closed: false,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ chunk, llm }));
    expect(result.scenes).toHaveLength(2);
    // First scene closed (not carried); only the (actually last) second
    // scene's open/closed state is honored.
    expect(result.openScene).not.toBeNull();
    expect(result.openScene!.sceneId).toBe(result.scenes[1].id);
  });

  it('is deterministic: the same chunk boundary + position yields the same scene/fact ids across calls', async () => {
    const llm1 = fakeLlmSequence([VALID_SCENE_JSON]);
    const llm2 = fakeLlmSequence([VALID_SCENE_JSON]);
    const r1 = await processChunk(baseParams({ llm: llm1 }));
    const r2 = await processChunk(baseParams({ llm: llm2 }));
    expect(r1.scenes[0].id).toBe(r2.scenes[0].id);
    expect(r1.facts[0].id).toBe(r2.facts[0].id);
  });

  it('scene id is stable even when a retry reshapes the response around it (not ordinal-position seeded)', async () => {
    // Both responses agree a scene starts at local idx 0 ("m1") — but the
    // SECOND response splits the chunk into two scenes instead of one.
    // An ordinal-position seed would mint a DIFFERENT id for the scene at
    // "m1" here (still position 0, so it'd coincidentally match) — the
    // real risk is the INVERSE: two responses that disagree on how many
    // scenes come BEFORE a given one. Verify by seeding from a chunk
    // whose first scene covers only message 0, so position and content
    // agree in both shapes and the id must derive from the message id.
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, name: 'Sam', content: 'Hi' }),
      msg({ id: 'm2', name: 'Aria', content: 'Hello' }),
      msg({ id: 'm3', isUser: true, name: 'Sam', content: 'Bye' }),
    ]);
    const oneSceneJson = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'A',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 0,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const twoSceneJson = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'A redux',
          summary: 's2',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 0,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
        {
          continues_open_scene: false,
          title: 'B',
          summary: 's3',
          detailed_summary: '',
          participants: [],
          start_local_idx: 1,
          end_local_idx: 2,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const r1 = await processChunk(baseParams({ chunk, llm: fakeLlmSequence([oneSceneJson]) }));
    const r2 = await processChunk(baseParams({ chunk, llm: fakeLlmSequence([twoSceneJson]) }));
    // The scene starting at message m1 gets the SAME id in both shapes.
    expect(r1.scenes[0].id).toBe(r2.scenes[0].id);
  });

  it('fact ids differ when the fact text differs, even at the same source message (no cross-content collision)', async () => {
    const jsonA = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'A',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [{ text: 'Aria is a baker.', category: 'reveal', local_idx: 1 }],
        },
      ],
    });
    const jsonB = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'A',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [{ text: 'Aria is a duchess.', category: 'reveal', local_idx: 1 }],
        },
      ],
    });
    const r1 = await processChunk(baseParams({ llm: fakeLlmSequence([jsonA]) }));
    const r2 = await processChunk(baseParams({ llm: fakeLlmSequence([jsonB]) }));
    expect(r1.facts[0].id).not.toBe(r2.facts[0].id);
  });

  it('preserves the open scene untouched when the model never explicitly continues it', async () => {
    const openScene: OpenSceneCarry = {
      sceneId: 'existing-scene-id',
      sequence: 5,
      title: 'Ongoing',
      summary: 'so far...',
      detailedSummary: '',
      participantIds: ['char-aria'],
      factIds: ['fact-1'],
      rangeStart: {
        msg_id: 'earlier',
        swipe_idx: 0,
        fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
      },
      excludedSegments: [],
      swipeResolutions: [],
      totalMessages: 3,
      serverTs: 7,
    };
    // The model returns a scene at position 0 but does NOT claim
    // continuation (a model that just ignores the open-scene note).
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Unrelated new scene',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ llm, openScene, nextSequence: 6 }));

    // The unrelated new scene was still recorded...
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0].id).not.toBe('existing-scene-id');
    // ...but the ORIGINAL open scene comes back completely unchanged,
    // not silently dropped or replaced by the new scene's bookkeeping.
    expect(result.openScene).toEqual(openScene);
  });

  it('preserves the open scene when the continuing entry is malformed (out-of-range indices)', async () => {
    const openScene: OpenSceneCarry = {
      sceneId: 'existing-scene-id',
      sequence: 2,
      title: 'Ongoing',
      summary: 'so far...',
      detailedSummary: '',
      participantIds: [],
      factIds: [],
      rangeStart: {
        msg_id: 'earlier',
        swipe_idx: 0,
        fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
      },
      excludedSegments: [],
      swipeResolutions: [],
      totalMessages: 1,
      serverTs: 3,
    };
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: true,
          start_local_idx: 99, // malformed — out of range
          end_local_idx: 100,
          closed: true,
          participants: [],
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ llm, openScene, nextSequence: 3 }));
    expect(result.scenes).toHaveLength(0);
    expect(result.openScene).toEqual(openScene);
  });

  it('attaches a system-message run in a gap between two scenes to the nearest scene, not dropped', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, content: 'a' }),
      msg({ id: 'm2', content: 'b' }),
      msg({ id: 'sys1', isSystem: true, content: '[note]' }),
      msg({ id: 'm3', isUser: true, content: 'c' }),
      msg({ id: 'm4', content: 'd' }),
    ]);
    // Scenes cover local indices 0-1 (m1,m2) and 2-3 (m3,m4) — the system
    // message between them (full index 2) isn't inside EITHER scene's
    // full-index range ([0,1] and [3,4]).
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'First',
          summary: 's1',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
        {
          continues_open_scene: false,
          title: 'Second',
          summary: 's2',
          detailed_summary: '',
          participants: [],
          start_local_idx: 2,
          end_local_idx: 3,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ chunk, llm }));
    const allExcluded = result.scenes.flatMap((s) => s.data.source.excluded_segments);
    expect(allExcluded).toHaveLength(1);
    expect(allExcluded[0].reason).toBe('system');
    expect(allExcluded[0].range.start.msg_id).toBe('sys1');
  });

  it('drops (rather than misattributes) a model-flagged exclusion index outside the current scene range', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, content: 'a' }),
      msg({ id: 'm2', content: 'b' }),
      msg({ id: 'm3', isUser: true, content: 'c' }),
      msg({ id: 'm4', content: 'd' }),
    ]);
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'First',
          summary: 's1',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          // idx 3 belongs to the SECOND scene, not this one.
          excluded_local_idxs: [{ idx: 3, reason: 'ooc' }],
          facts: [],
        },
        {
          continues_open_scene: false,
          title: 'Second',
          summary: 's2',
          detailed_summary: '',
          participants: [],
          start_local_idx: 2,
          end_local_idx: 3,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ chunk, llm }));
    expect(result.scenes[0].data.source.excluded_segments).toEqual([]);
  });

  it('clamps a fact local_idx outside the current scene range into that scene rather than misattributing it', async () => {
    const chunk = chunkOf([
      msg({ id: 'm1', isUser: true, content: 'a' }),
      msg({ id: 'm2', content: 'b' }),
      msg({ id: 'm3', isUser: true, content: 'c' }),
      msg({ id: 'm4', content: 'd' }),
    ]);
    const json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'First',
          summary: 's1',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          // local_idx 3 belongs to the SECOND scene, not this one.
          facts: [{ text: 'Something established.', category: 'reveal', local_idx: 3 }],
        },
        {
          continues_open_scene: false,
          title: 'Second',
          summary: 's2',
          detailed_summary: '',
          participants: [],
          start_local_idx: 2,
          end_local_idx: 3,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = fakeLlmSequence([json]);
    const result = await processChunk(baseParams({ chunk, llm }));
    expect(result.facts).toHaveLength(1);
    // Clamped to m2 (end of scene 1's own range), not m4 (scene 2's).
    expect(result.facts[0].source?.kind).toBe('chat_message');
    if (result.facts[0].source?.kind === 'chat_message') {
      expect(result.facts[0].source.ref.msg.msg_id).toBe('m2');
    }
  });
});

describe('deterministicUuid', () => {
  it('is stable for the same seed and looks like a UUID', () => {
    const a = deterministicUuid('chunk:0-5:scene:0');
    const b = deterministicUuid('chunk:0-5:scene:0');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('differs for different seeds', () => {
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });
});
