// Drift-detection unit suite (story-state phase 11, plan §9
// "msgDrift.test.ts").
//
// Pure module, zero network and zero store. Two properties carry more
// weight than the rest:
//
//  - A cross-algorithm comparison must NEVER read as `drifted`. The
//    banner this feeds says "your chat history changed"; firing that on
//    a djb2-vs-sha256 mismatch — which disagrees on identical text by
//    construction — would train users to ignore it.
//  - The known false negative is PINNED as a test. Detection samples
//    scene boundaries and swipe resolutions (plan §3.2), so an edit
//    strictly interior to a scene is invisible. That is a documented
//    property of the design, and a test that fails when it changes is
//    the only way it stays documented.

import { describe, it, expect } from 'vitest';
import {
  checkMsgDrift,
  checkWatermark,
  indexById,
  localiseSceneDrift,
  newMessagesSince,
  type DriftMessage,
  type DriftScene,
} from './msgDrift';
import { hashText } from './sourceRefs';
import type { IngestWatermark, MsgRef } from '../../types/storyBible';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(
  id: string,
  content: string,
  extra: Partial<DriftMessage> = {}
): DriftMessage {
  return { id, content, swipeIdx: 0, timestamp: 1000, ...extra };
}

/** A ref that genuinely matches `m` — built the way the walk builds it. */
async function refFor(m: DriftMessage, swipeIdx = m.swipeIdx): Promise<MsgRef> {
  const text =
    Array.isArray(m.swipes) && m.swipes[swipeIdx] !== undefined
      ? m.swipes[swipeIdx]
      : m.content;
  const { sha, hash_alg } = await hashText(text);
  return {
    msg_id: m.id,
    swipe_idx: swipeIdx,
    fingerprint: { sha, hash_alg, send_date: m.timestamp },
  };
}

async function watermarkFor(
  messages: readonly DriftMessage[]
): Promise<IngestWatermark> {
  const last = messages[messages.length - 1];
  return { message_count: messages.length, last_msg: await refFor(last) };
}

function scene(
  id: string,
  sequence: number,
  start: MsgRef,
  end: MsgRef,
  swipeRefs: MsgRef[] = []
): DriftScene {
  return {
    id,
    sequence,
    source: {
      message_range: { start, end },
      swipe_resolutions: swipeRefs.map((m) => ({
        msg: m,
        alternate_swipes_available: 1,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// checkMsgDrift — the four verdicts
// ---------------------------------------------------------------------------

describe('checkMsgDrift', () => {
  it('reports live when the text is unchanged', async () => {
    const m = msg('a', 'hello there');
    expect(await checkMsgDrift(await refFor(m), m)).toBe('live');
  });

  it('reports drifted when the text changed under a stable id', async () => {
    const m = msg('a', 'hello there');
    const ref = await refFor(m);
    expect(await checkMsgDrift(ref, msg('a', 'hello THERE'))).toBe('drifted');
  });

  it('reports dangling when the message is gone', async () => {
    const m = msg('a', 'hello there');
    expect(await checkMsgDrift(await refFor(m), undefined)).toBe('dangling');
  });

  it('reports unverifiable — never drifted — across hash algorithms', async () => {
    const m = msg('a', 'hello there');
    const ref = await refFor(m);
    // Same text, but the ref was recorded under the non-secure-context
    // fallback. The digests cannot agree, and that says nothing.
    const crossAlg: MsgRef = {
      ...ref,
      fingerprint: { ...ref.fingerprint, hash_alg: 'djb2', sha: 'deadbeef' },
    };
    const verdict = await checkMsgDrift(crossAlg, m);
    expect(verdict).toBe('unverifiable');
    expect(verdict).not.toBe('drifted');
  });

  it('reports drifted when the named swipe no longer exists', async () => {
    const m = msg('a', 'second', { swipes: ['first', 'second'], swipeIdx: 1 });
    const ref = await refFor(m, 1);
    const shrunk = msg('a', 'first', { swipes: ['first'], swipeIdx: 0 });
    expect(await checkMsgDrift(ref, shrunk)).toBe('drifted');
  });

  it('resolves the swipe the ref names, not the active one', async () => {
    const m = msg('a', 'second', { swipes: ['first', 'second'], swipeIdx: 1 });
    const ref = await refFor(m, 0); // ref points at swipe 0
    // User has since swiped to index 1; swipe 0 is untouched.
    expect(await checkMsgDrift(ref, m)).toBe('live');
  });

  it('is unverifiable when the swipes array is unavailable and the ref names another swipe', async () => {
    const withSwipes = msg('a', 'second', {
      swipes: ['first', 'second'],
      swipeIdx: 1,
    });
    const ref = await refFor(withSwipes, 0);
    // The ingest shape drops `swipes`; only the active swipe is visible.
    const ingestShaped = msg('a', 'second', { swipeIdx: 1 });
    expect(await checkMsgDrift(ref, ingestShaped)).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

describe('checkWatermark (tier 1)', () => {
  it('never_walked when the watermark is absent or zero', async () => {
    const messages = [msg('a', 'one')];
    expect((await checkWatermark(null, messages)).kind).toBe('never_walked');
    expect(
      (await checkWatermark({ message_count: 0, last_msg: null }, messages)).kind
    ).toBe('never_walked');
  });

  it('unknown when the watermark has a count but no anchor', async () => {
    const v = await checkWatermark({ message_count: 3, last_msg: null }, [
      msg('a', 'one'),
    ]);
    expect(v).toEqual({ kind: 'unknown', reason: 'no_anchor' });
  });

  it('clean when nothing has been added', async () => {
    const messages = [msg('a', 'one'), msg('b', 'two')];
    const v = await checkWatermark(await watermarkFor(messages), messages);
    expect(v.kind).toBe('clean');
  });

  it('new_messages with an exact tail slice on a pure append', async () => {
    const walked = [msg('a', 'one'), msg('b', 'two')];
    const wm = await watermarkFor(walked);
    const live = [...walked, msg('c', 'three'), msg('d', 'four')];

    const v = await checkWatermark(wm, live);
    expect(v).toMatchObject({ kind: 'new_messages', count: 2, anchorIndex: 1 });
    expect(newMessagesSince(v, live).map((m) => m.id)).toEqual(['c', 'd']);
  });

  it('diverged/anchor_deleted when the last walked message is gone', async () => {
    const walked = [msg('a', 'one'), msg('b', 'two')];
    const wm = await watermarkFor(walked);
    const v = await checkWatermark(wm, [msg('a', 'one')]);
    expect(v).toMatchObject({ kind: 'diverged', reason: 'anchor_deleted' });
  });

  it('diverged/anchor_edited when the last walked message was edited', async () => {
    const walked = [msg('a', 'one'), msg('b', 'two')];
    const wm = await watermarkFor(walked);
    const v = await checkWatermark(wm, [msg('a', 'one'), msg('b', 'TWO!')]);
    expect(v).toMatchObject({ kind: 'diverged', reason: 'anchor_edited' });
  });

  it('diverged/count_mismatch when a message was inserted before the anchor', async () => {
    const walked = [msg('a', 'one'), msg('b', 'two')];
    const wm = await watermarkFor(walked);
    // Anchor intact and still last, but something appeared behind it.
    const live = [msg('a', 'one'), msg('x', 'inserted'), msg('b', 'two')];
    const v = await checkWatermark(wm, live);
    expect(v).toMatchObject({ kind: 'diverged', reason: 'count_mismatch' });
  });

  it('stays silent (unknown) rather than guessing on an unverifiable anchor', async () => {
    const walked = [msg('a', 'one'), msg('b', 'two')];
    const wm = await watermarkFor(walked);
    const crossAlg: IngestWatermark = {
      ...wm,
      last_msg: {
        ...wm.last_msg!,
        fingerprint: { ...wm.last_msg!.fingerprint, hash_alg: 'djb2', sha: 'ff' },
      },
    };
    const v = await checkWatermark(crossAlg, [...walked, msg('c', 'three')]);
    expect(v).toEqual({ kind: 'unknown', reason: 'unverifiable_anchor' });
    // Specifically: it must NOT claim new messages, because it cannot
    // trust the anchor it would measure them from.
    expect(v.kind).not.toBe('new_messages');
  });
});

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

describe('localiseSceneDrift (tier 2)', () => {
  it('finds nothing when every sampled ref still matches', async () => {
    const live = [msg('a', '1'), msg('b', '2'), msg('c', '3'), msg('d', '4')];
    const scenes = [
      scene('s1', 0, await refFor(live[0]), await refFor(live[1])),
      scene('s2', 1, await refFor(live[2]), await refFor(live[3])),
    ];
    const r = await localiseSceneDrift(scenes, live);
    expect(r.divergedSceneId).toBeNull();
    expect(r.downstreamSceneIds).toEqual([]);
    expect(r.checkedScenes).toBe(2);
  });

  it('localises to the first affected scene and returns it plus everything downstream', async () => {
    const orig = [msg('a', '1'), msg('b', '2'), msg('c', '3'), msg('d', '4')];
    const scenes = [
      scene('s1', 0, await refFor(orig[0]), await refFor(orig[1])),
      scene('s2', 1, await refFor(orig[2]), await refFor(orig[3])),
      scene('s3', 2, await refFor(orig[3]), await refFor(orig[3])),
    ];
    // Edit message c — the start boundary of s2.
    const live = [orig[0], orig[1], msg('c', 'THREE'), orig[3]];

    const r = await localiseSceneDrift(scenes, live);
    expect(r.divergedSceneId).toBe('s2');
    expect(r.divergedSequence).toBe(1);
    expect(r.downstreamSceneIds).toEqual(['s2', 's3']);
  });

  it('catches a scene whose only broken ref is a swipe resolution', async () => {
    const orig = [msg('a', '1'), msg('b', '2'), msg('c', '3')];
    const scenes = [
      scene('s1', 0, await refFor(orig[0]), await refFor(orig[2]), [
        await refFor(orig[1]),
      ]),
    ];
    // Boundaries a and c are untouched; the interior swipe-resolved
    // message b changed. This IS sampled, so it must be caught.
    const live = [orig[0], msg('b', 'TWO'), orig[2]];

    const r = await localiseSceneDrift(scenes, live);
    expect(r.divergedSceneId).toBe('s1');
  });

  it('KNOWN FALSE NEGATIVE: an interior edit with no sampled ref is not caught (plan §3.2)', async () => {
    const orig = [msg('a', '1'), msg('b', '2'), msg('c', '3')];
    // b is interior: not a boundary, and carries no swipe resolution.
    const scenes = [scene('s1', 0, await refFor(orig[0]), await refFor(orig[2]))];
    const live = [orig[0], msg('b', 'COMPLETELY DIFFERENT'), orig[2]];

    const r = await localiseSceneDrift(scenes, live);
    // Documented limit of boundary sampling. If this ever starts
    // failing, detection got stronger — update the plan's §3.2 and §10
    // rather than deleting the test.
    expect(r.divergedSceneId).toBeNull();
  });

  it('counts unverifiable refs instead of treating them as drift', async () => {
    const live = [msg('a', '1'), msg('b', '2')];
    const good = await refFor(live[0]);
    const crossAlg: MsgRef = {
      ...(await refFor(live[1])),
      fingerprint: {
        ...(await refFor(live[1])).fingerprint,
        hash_alg: 'djb2',
        sha: 'ff',
      },
    };
    const r = await localiseSceneDrift([scene('s1', 0, good, crossAlg)], live);
    expect(r.divergedSceneId).toBeNull();
    expect(r.unverifiableRefs).toBe(1);
  });

  it('treats a branch-restore rekey as id churn and flags nothing', async () => {
    const orig = [msg('a', '1'), msg('b', '2'), msg('c', '3')];
    const scenes = [
      scene('s1', 0, await refFor(orig[0]), await refFor(orig[1])),
      scene('s2', 1, await refFor(orig[2]), await refFor(orig[2])),
    ];
    // Same text throughout; every id re-minted, as rekeyRestoredMessages
    // can do when it adopts by (timestamp, isUser, name).
    const live = [msg('a2', '1'), msg('b2', '2'), msg('c2', '3')];

    const r = await localiseSceneDrift(scenes, live);
    expect(r.idChurnSuspected).toBe(true);
    expect(r.divergedSceneId).toBeNull();
    expect(r.downstreamSceneIds).toEqual([]);
  });

  it('does NOT call it id churn when content actually changed too', async () => {
    const orig = [msg('a', '1'), msg('b', '2')];
    const scenes = [scene('s1', 0, await refFor(orig[0]), await refFor(orig[1]))];
    const live = [msg('a2', '1'), msg('b2', 'SOMETHING ELSE')];

    const r = await localiseSceneDrift(scenes, live);
    expect(r.idChurnSuspected).toBe(false);
    expect(r.divergedSceneId).toBe('s1');
  });

  it('orders by sequence then id, not array order', async () => {
    const orig = [msg('a', '1'), msg('b', '2'), msg('c', '3')];
    const scenes = [
      scene('s3', 2, await refFor(orig[2]), await refFor(orig[2])),
      scene('s1', 0, await refFor(orig[0]), await refFor(orig[0])),
      scene('s2', 1, await refFor(orig[1]), await refFor(orig[1])),
    ];
    const live = [orig[0], msg('b', 'CHANGED'), orig[2]];

    const r = await localiseSceneDrift(scenes, live);
    expect(r.divergedSceneId).toBe('s2');
    expect(r.downstreamSceneIds).toEqual(['s2', 's3']);
  });

  it('skips scenes with no checkable refs without counting them', async () => {
    const live = [msg('a', '1')];
    const bare: DriftScene = { id: 'empty', sequence: 0, source: null };
    const r = await localiseSceneDrift(
      [bare, scene('s1', 1, await refFor(live[0]), await refFor(live[0]))],
      live
    );
    expect(r.checkedScenes).toBe(1);
    expect(r.divergedSceneId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// indexById
// ---------------------------------------------------------------------------

describe('indexById', () => {
  it('maps ids to positions and prefers the first occurrence', () => {
    const idx = indexById([msg('a', '1'), msg('b', '2'), msg('a', '3')]);
    expect(idx.get('a')).toBe(0);
    expect(idx.get('b')).toBe(1);
    expect(idx.get('nope')).toBeUndefined();
  });
});
