// Canon check unit suite (story-state phase 10, plan §9 "canonCheck.test.ts").
//
// Pure module, zero network and zero store: every case here builds a
// bible-shaped fixture by hand and calls the functions directly.
//
// Two properties carry the most weight:
//
//  - The §5.2 cleanup rules are shared between `deleteFact` and lock
//    canon's auto-fix, so every branch is pinned HERE rather than in
//    either caller's suite — a rule that drifted between the two would
//    mean a delete and a lock disagreed about what a clean bible is.
//  - The check must never fabricate a finding out of state it simply
//    hasn't loaded. Errors drive a fix that strips ids; a check that
//    read an unfetched `entities` section as "no characters exist"
//    would auto-fix every participant off every scene.

import { describe, it, expect } from 'vitest';
import {
  CANON_REOPEN_RATIONALE_PREFIX,
  checkCanon,
  cleanupFactRefs,
  cleanupSceneRefs,
  planCanonFixes,
  type CanonCheckState,
  type FactIndex,
  type SceneRow,
} from './canonCheck';
import type { BibleFact, Contradiction } from '../../types/storyBible';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function contradiction(
  id: string,
  sources: string[],
  over: Partial<Contradiction> = {}
): Contradiction {
  return {
    id,
    type: 'character_attribute',
    description: `Entry ${id}`,
    sources,
    detected_by: 'agent',
    resolution: {
      status: 'unresolved',
      canonical_choice: null,
      rationale: '',
      resolved_at: null,
    },
    ...over,
  };
}

/** A resolved entry — the kind reconcile's own prune refuses to touch,
 *  which is exactly why the cleanup rules have to. */
function resolved(
  id: string,
  sources: string[],
  choice: string,
  over: Partial<Contradiction> = {}
): Contradiction {
  return contradiction(id, sources, {
    resolution: {
      status: 'user_chose',
      canonical_choice: choice,
      rationale: 'Ivy is the one who seals it.',
      resolved_at: '2026-08-10T12:00:00.000Z',
    },
    ...over,
  });
}

function fact(id: string, over: Partial<BibleFact> = {}): BibleFact {
  return {
    id,
    text: `Fact ${id}`,
    category: 'reveal',
    confidence: 'explicit',
    ...over,
  };
}

/** The §5.7 index as the store builds it: raw row payloads, live rows
 *  and tombstones side by side. */
function factIndex(
  rows: Record<string, BibleFact | Record<string, unknown>>
): FactIndex {
  return new Map(Object.entries(rows).map(([id, data]) => [id, { data: { ...data } }]));
}

/** The wire shape the delete endpoint leaves behind: `data` replaced
 *  wholesale by exactly these two keys. */
function tombstone(id: string): Record<string, unknown> {
  return { id, deleted_at: '2026-08-10T12:34:56.000Z' };
}

function sceneRow(id: string, over: Record<string, unknown> = {}): SceneRow {
  return {
    id,
    data: {
      id,
      sequence: 1,
      title: `Scene ${id}`,
      summary: '',
      participants: [],
      pov_character: null,
      continuity_facts_established: [],
      ...over,
    },
  };
}

const CHAT = { character_avatar: 'ivy.png', file_name: 'chat-1.jsonl' };

function meta(chatRef = CHAT): Record<string, unknown> {
  return {
    schema_version: '1.0',
    bible_id: 'bible-1',
    source: {
      platform: 'ggbc',
      chat: {
        kind: 'chat',
        ref: chatRef,
        snapshot: { name: 'The north wing' },
        captured_at: '2026-08-01T00:00:00.000Z',
      },
    },
  };
}

/** A bible with nothing wrong with it: every id resolves, in every
 *  section the check looks at. Every error/warning fixture below is this
 *  one with a single thing broken. */
function cleanBible(): CanonCheckState {
  return {
    facts: factIndex({
      'fact-a': fact('fact-a', { established_in: 'scene-1' }),
      'fact-b': fact('fact-b', {
        established_in: 'scene-1',
        supersedes: 'fact-a',
        contradicts: ['fact-a'],
      }),
    }),
    scenes: [
      sceneRow('scene-1', {
        participants: ['char-ivy'],
        pov_character: 'char-ivy',
        continuity_facts_established: ['fact-a', 'fact-b'],
      }),
    ],
    continuity: { contradictions: [contradiction('entry-1', ['fact-a', 'fact-b'])] },
    meta: meta(),
    entities: { characters: [{ id: 'char-ivy', canonical_name: 'Ivy' }] },
    narrative: {
      structure: { acts: [{ id: 'act-1', label: 'Setup', scene_range: ['scene-1', 'scene-1'] }] },
    },
    renderingHints: {
      novel: {
        pov_character: 'char-ivy',
        chapter_breaks: ['scene-1'],
        chapter_titles: [{ scene_id: 'scene-1', title: 'One' }],
      },
    },
    liveRefs: { chats: [CHAT] },
  };
}

function kinds(findings: { kind: string }[]): string[] {
  return findings.map((f) => f.kind);
}

// ---------------------------------------------------------------------------
// The §5.2 cleanup rules
// ---------------------------------------------------------------------------

describe('cleanupFactRefs — the §5.2 rules', () => {
  it('returns null when nothing cites the dead fact, so the PUT is skipped entirely', () => {
    const entries = [contradiction('e1', ['fact-a', 'fact-b'])];
    expect(cleanupFactRefs(entries, new Set(['fact-z']))).toBeNull();
    expect(cleanupFactRefs(entries, new Set())).toBeNull();
  });

  it('removes the dead id from every entry that cites it, keeping entries with 2 sources left', () => {
    const patched = cleanupFactRefs(
      [
        contradiction('e1', ['fact-a', 'fact-b', 'fact-dead']),
        contradiction('e2', ['fact-b', 'fact-dead', 'fact-c']),
      ],
      new Set(['fact-dead'])
    );
    expect(patched?.map((e) => e.sources)).toEqual([
      ['fact-a', 'fact-b'],
      ['fact-b', 'fact-c'],
    ]);
  });

  it('drops an entry left with fewer than 2 sources — INCLUDING resolved and user-detected ones', () => {
    const patched = cleanupFactRefs(
      [
        contradiction('agent-unresolved', ['fact-a', 'fact-dead']),
        resolved('agent-resolved', ['fact-b', 'fact-dead'], 'fact-b'),
        contradiction('user-detected', ['fact-c', 'fact-dead'], { detected_by: 'user' }),
        contradiction('survivor', ['fact-a', 'fact-b', 'fact-dead']),
      ],
      new Set(['fact-dead'])
    );
    expect(patched?.map((e) => e.id)).toEqual(['survivor']);
  });

  it('reopens an entry whose canonical_choice was the deleted fact, prefixing the rationale', () => {
    const patched = cleanupFactRefs(
      [resolved('e1', ['fact-a', 'fact-b', 'fact-dead'], 'fact-dead')],
      new Set(['fact-dead'])
    );
    const entry = patched![0];
    expect(entry.sources).toEqual(['fact-a', 'fact-b']);
    expect(entry.resolution.status).toBe('unresolved');
    expect(entry.resolution.canonical_choice).toBeNull();
    expect(entry.resolution.resolved_at).toBeNull();
    expect(entry.resolution.rationale).toBe(
      `${CANON_REOPEN_RATIONALE_PREFIX}Ivy is the one who seals it.`
    );
  });

  it('reopens on a canonical_choice that was never in sources — write-my-own points outside the citation list', () => {
    const patched = cleanupFactRefs(
      [resolved('e1', ['fact-a', 'fact-b'], 'fact-mine')],
      new Set(['fact-mine'])
    );
    // Sources were never touched; the entry still reopens, because the
    // fact the user picked is the one that is gone.
    expect(patched![0].sources).toEqual(['fact-a', 'fact-b']);
    expect(patched![0].resolution.status).toBe('unresolved');
    expect(patched![0].resolution.rationale.startsWith(CANON_REOPEN_RATIONALE_PREFIX)).toBe(true);
  });

  it('does not stack the rationale prefix when a second write-my-own fact is deleted', () => {
    const once = cleanupFactRefs(
      [resolved('e1', ['fact-a', 'fact-b'], 'fact-mine-1')],
      new Set(['fact-mine-1'])
    )!;
    const reResolved = [
      { ...once[0], resolution: { ...once[0].resolution, status: 'user_chose' as const, canonical_choice: 'fact-mine-2' } },
    ];
    const twice = cleanupFactRefs(reResolved, new Set(['fact-mine-2']))!;
    expect(twice[0].resolution.rationale).toBe(
      `${CANON_REOPEN_RATIONALE_PREFIX}Ivy is the one who seals it.`
    );
  });

  it('keeps entry ids stable even where the sources shrank — ids are the resolution key', () => {
    const before = [
      contradiction('keep-me', ['fact-a', 'fact-b', 'fact-dead']),
      resolved('keep-me-too', ['fact-a', 'fact-b', 'fact-dead'], 'fact-dead'),
    ];
    const after = cleanupFactRefs(before, new Set(['fact-dead']))!;
    expect(after.map((e) => e.id)).toEqual(['keep-me', 'keep-me-too']);
  });

  it('leaves an entry that already had a single source alone — it cites nothing dead, so it is not this pass to delete', () => {
    const entries = [contradiction('pre-existing', ['fact-a'])];
    expect(cleanupFactRefs(entries, new Set(['fact-dead']))).toBeNull();
  });

  it('does not mutate the entries it was given', () => {
    const entries = [resolved('e1', ['fact-a', 'fact-b', 'fact-dead'], 'fact-dead')];
    const snapshot = JSON.stringify(entries);
    cleanupFactRefs(entries, new Set(['fact-dead']));
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

describe('cleanupSceneRefs — §6.6 lazy heal', () => {
  it('strips dead facts, unknown participants, and nulls an unknown POV in one patch', () => {
    const patched = cleanupSceneRefs(
      {
        continuity_facts_established: ['fact-a', 'fact-dead'],
        participants: ['char-ivy', 'char-gone'],
        pov_character: 'char-gone',
      },
      { factIds: new Set(['fact-dead']), characterIds: new Set(['char-gone']) }
    );
    expect(patched).toEqual({
      continuity_facts_established: ['fact-a'],
      participants: ['char-ivy'],
      pov_character: null,
    });
  });

  it('preserves fields it does not understand — patchScene full-replaces the row', () => {
    const patched = cleanupSceneRefs(
      {
        participants: ['char-gone'],
        annotations: { user_notes: 'keep me', stale_source: false },
        some_future_field: { nested: true },
      },
      { characterIds: new Set(['char-gone']) }
    );
    expect(patched?.annotations).toEqual({ user_notes: 'keep me', stale_source: false });
    expect(patched?.some_future_field).toEqual({ nested: true });
  });

  it('returns null when nothing on the scene is dead', () => {
    expect(
      cleanupSceneRefs(
        { participants: ['char-ivy'], continuity_facts_established: ['fact-a'] },
        { factIds: new Set(['fact-dead']), characterIds: new Set(['char-gone']) }
      )
    ).toBeNull();
    expect(cleanupSceneRefs({ participants: ['char-gone'] }, {})).toBeNull();
  });

  it('leaves a malformed list alone rather than rewriting a shape it cannot read', () => {
    expect(
      cleanupSceneRefs(
        { participants: ['char-gone', 42] },
        { characterIds: new Set(['char-gone']) }
      )
    ).toBeNull();
  });

  it('does not mutate the payload it was given', () => {
    const data = { participants: ['char-ivy', 'char-gone'] };
    cleanupSceneRefs(data, { characterIds: new Set(['char-gone']) });
    expect(data.participants).toEqual(['char-ivy', 'char-gone']);
  });
});

describe('planCanonFixes', () => {
  it('collapses every contradiction finding into ONE set of dead facts and groups the rest per scene', () => {
    const state = cleanBible();
    const plan = planCanonFixes(
      checkCanon({
        ...state,
        continuity: {
          contradictions: [
            contradiction('e1', ['fact-a', 'fact-gone']),
            resolved('e2', ['fact-a', 'fact-b'], 'fact-also-gone'),
          ],
        },
        scenes: [
          sceneRow('scene-1', {
            continuity_facts_established: ['fact-gone'],
            participants: ['char-nobody'],
            pov_character: 'char-nobody',
          }),
        ],
      }).errors
    );
    expect([...plan.deadFactIds].sort()).toEqual(['fact-also-gone', 'fact-gone']);
    expect([...plan.scenes.keys()]).toEqual(['scene-1']);
    expect([...(plan.scenes.get('scene-1')!.factIds ?? [])]).toEqual(['fact-gone']);
    expect([...(plan.scenes.get('scene-1')!.characterIds ?? [])]).toEqual(['char-nobody']);
  });
});

// ---------------------------------------------------------------------------
// checkCanon
// ---------------------------------------------------------------------------

describe('checkCanon — a clean bible', () => {
  it('returns empty errors AND empty warnings', () => {
    expect(checkCanon(cleanBible())).toEqual({ errors: [], warnings: [] });
  });

  it('says nothing about a bible that is merely empty', () => {
    expect(checkCanon({ facts: new Map(), scenes: [] })).toEqual({ errors: [], warnings: [] });
  });
});

describe('checkCanon — errors (the auto-fixable class)', () => {
  it('flags a contradiction source citing a tombstoned fact, and names it as deleted', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      facts: factIndex({ 'fact-a': fact('fact-a'), 'fact-b': tombstone('fact-b') }),
    });
    const entry = errors.find((e) => e.kind === 'contradiction_source')!;
    expect(entry).toMatchObject({ class: 'error', contradictionId: 'entry-1', factId: 'fact-b' });
    expect(entry.message).toContain('was deleted');
  });

  it('flags a contradiction source citing a fact that is not in the log at all', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      continuity: { contradictions: [contradiction('entry-1', ['fact-a', 'fact-never'])] },
    });
    const entry = errors.find((e) => e.kind === 'contradiction_source')!;
    expect(entry).toMatchObject({ factId: 'fact-never' });
    expect(entry.message).toContain('no longer in the bible');
  });

  it('flags a canonical_choice pointing at a deleted fact separately from the citation itself', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      facts: factIndex({ 'fact-a': fact('fact-a'), 'fact-b': tombstone('fact-b') }),
      continuity: { contradictions: [resolved('entry-1', ['fact-a', 'fact-b'], 'fact-b')] },
      scenes: [sceneRow('scene-1', { participants: ['char-ivy'], pov_character: 'char-ivy' })],
    });
    // Two different problems on one entry: a stale citation and a
    // resolution that resolved onto nothing.
    expect(kinds(errors).sort()).toEqual(['contradiction_choice', 'contradiction_source']);
  });

  it('flags a canonical_choice the entry never cited — the write-my-own case', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      continuity: { contradictions: [resolved('entry-1', ['fact-a', 'fact-b'], 'fact-mine')] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'contradiction_choice', factId: 'fact-mine' });
  });

  it("flags a scene's continuity_facts_established citing a deleted fact, addressed by the scene ROW id", () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      scenes: [sceneRow('scene-1', { continuity_facts_established: ['fact-a', 'fact-gone'] })],
    });
    expect(errors).toEqual([
      expect.objectContaining({ kind: 'scene_fact', sceneId: 'scene-1', refId: 'fact-gone' }),
    ]);
  });

  it('flags an unknown participant and an unknown pov_character on a scene', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      scenes: [
        sceneRow('scene-1', {
          participants: ['char-ivy', 'char-ghost'],
          pov_character: 'char-ghost',
          continuity_facts_established: ['fact-a'],
        }),
      ],
    });
    expect(kinds(errors)).toEqual(['scene_participant', 'scene_pov']);
    expect(errors.every((e) => 'refId' in e && e.refId === 'char-ghost')).toBe(true);
  });

  it('reports nothing about a fact id that resolves to a live row', () => {
    const state = cleanBible();
    expect(checkCanon(state).errors).toEqual([]);
  });
});

describe('checkCanon — warnings (never block a lock)', () => {
  it('warns on a fact whose established_in scene is gone (the merge consequence)', () => {
    const state = cleanBible();
    const { errors, warnings } = checkCanon({
      ...state,
      facts: factIndex({ 'fact-a': fact('fact-a', { established_in: 'scene-merged-away' }) }),
      continuity: { contradictions: [] },
      scenes: [sceneRow('scene-1', { continuity_facts_established: [], participants: ['char-ivy'], pov_character: 'char-ivy' })],
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({
        class: 'warning',
        kind: 'fact_established_in',
        ownerId: 'fact-a',
        refId: 'scene-merged-away',
      }),
    ]);
  });

  it('warns on dangling supersedes and contradicts, which dangle by design', () => {
    const state = cleanBible();
    const { errors, warnings } = checkCanon({
      ...state,
      facts: factIndex({
        'fact-a': fact('fact-a', {
          established_in: 'scene-1',
          supersedes: 'fact-old',
          contradicts: ['fact-old', 'fact-older'],
        }),
      }),
      continuity: { contradictions: [] },
      scenes: [sceneRow('scene-1', { participants: ['char-ivy'], pov_character: 'char-ivy' })],
    });
    expect(errors).toEqual([]);
    expect(kinds(warnings)).toEqual(['fact_supersedes', 'fact_contradicts', 'fact_contradicts']);
  });

  it('warns when the source chat ref no longer resolves against the Work', () => {
    const state = cleanBible();
    const { warnings } = checkCanon({
      ...state,
      liveRefs: { chats: [{ character_avatar: 'ivy.png', file_name: 'renamed.jsonl' }] },
    });
    const found = warnings.find((w) => w.kind === 'source_chat')!;
    expect(found).toMatchObject({ ownerId: null, refId: null });
    // Named by its snapshot, so a chat that is gone still reads as
    // something other than a filename.
    expect(found.message).toContain('The north wing');
  });

  it('warns on act ranges, chapter breaks and chapter titles citing scenes that no longer exist', () => {
    const state = cleanBible();
    const { errors, warnings } = checkCanon({
      ...state,
      narrative: {
        structure: { acts: [{ id: 'act-1', label: 'Setup', scene_range: ['scene-gone', 'scene-gone'] }] },
      },
      renderingHints: {
        novel: {
          pov_character: 'char-ivy',
          chapter_breaks: ['scene-gone'],
          chapter_titles: [{ scene_id: 'scene-gone', title: 'One' }],
        },
      },
    });
    expect(errors).toEqual([]);
    // The act's range names one scene twice — one warning, not two.
    expect(kinds(warnings)).toEqual(['act_scene', 'chapter_break', 'chapter_title']);
    expect(warnings[0]).toMatchObject({ ownerId: 'act-1', refId: 'scene-gone' });
  });

  it("warns — never errors — on rendering_hints' pov_character naming an unknown character", () => {
    const state = cleanBible();
    const { errors, warnings } = checkCanon({
      ...state,
      renderingHints: { novel: { pov_character: 'char-ghost', chapter_breaks: [], chapter_titles: [] } },
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'hints_pov_character', refId: 'char-ghost' }),
    ]);
  });

  it('says nothing about a tombstoned fact\'s own refs — a deleted row is not a dangling one', () => {
    const state = cleanBible();
    const { warnings } = checkCanon({
      ...state,
      facts: factIndex({ 'fact-a': fact('fact-a', { established_in: 'scene-1' }), 'fact-b': tombstone('fact-b') }),
      continuity: { contradictions: [] },
      scenes: [sceneRow('scene-1', { participants: ['char-ivy'], pov_character: 'char-ivy' })],
    });
    expect(warnings).toEqual([]);
  });
});

describe('checkCanon — "not loaded" is never read as "not there"', () => {
  it('skips every character check when entities was not loaded', () => {
    const state = cleanBible();
    const dirtyScenes = [
      sceneRow('scene-1', {
        participants: ['char-ghost'],
        pov_character: 'char-ghost',
        continuity_facts_established: ['fact-a'],
      }),
    ];
    expect(checkCanon({ ...state, entities: undefined, scenes: dirtyScenes }).errors).toEqual([]);
    // ...and fires the moment the cast is actually in hand.
    expect(kinds(checkCanon({ ...state, scenes: dirtyScenes }).errors)).toEqual([
      'scene_participant',
      'scene_pov',
    ]);
  });

  it('skips every character check when entities is loaded but holds no cast', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      entities: { characters: [] },
      scenes: [sceneRow('scene-1', { participants: ['char-ghost'], continuity_facts_established: ['fact-a'] })],
    });
    expect(errors).toEqual([]);
  });

  it('skips every fact check when the fact index is empty — an unpaged index would auto-fix the whole section away', () => {
    const state = cleanBible();
    const { errors } = checkCanon({
      ...state,
      facts: new Map(),
      scenes: [
        sceneRow('scene-1', {
          continuity_facts_established: ['fact-a'],
          participants: ['char-ivy'],
          pov_character: 'char-ivy',
        }),
      ],
    });
    expect(errors).toEqual([]);
  });

  it('skips every scene-id check when no scenes were loaded', () => {
    const state = cleanBible();
    const { warnings } = checkCanon({ ...state, scenes: [] });
    expect(warnings).toEqual([]);
  });

  it('skips the source-chat check when the Work\'s chat list is not in hand', () => {
    const state = cleanBible();
    expect(checkCanon({ ...state, liveRefs: undefined }).warnings).toEqual([]);
  });

  it('reads no section as empty rather than malformed, and judges nothing it cannot parse', () => {
    const state = cleanBible();
    const bare: CanonCheckState = { facts: state.facts, scenes: state.scenes };
    expect(checkCanon(bare)).toEqual({ errors: [], warnings: [] });
    expect(
      checkCanon({
        ...state,
        narrative: { structure: { acts: 'nonsense' } },
        renderingHints: { novel: { chapter_breaks: 7, chapter_titles: [{}] } },
        meta: { source: { chat: { kind: 'chat', ref: {} } } },
      }).warnings
    ).toEqual([]);
  });

  it('propagates readContinuitySection\'s throw — an unreadable list must not be locked or auto-fixed', () => {
    const state = cleanBible();
    expect(() => checkCanon({ ...state, continuity: { contradictions: [{ id: 1 }] } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The auto-fix, end to end
// ---------------------------------------------------------------------------

describe('checkCanon → planCanonFixes → cleanup is idempotent', () => {
  /** One bible carrying every error class at once. */
  function dirtyBible(): CanonCheckState {
    return {
      ...cleanBible(),
      facts: factIndex({
        'fact-a': fact('fact-a', { established_in: 'scene-1' }),
        'fact-b': fact('fact-b', { established_in: 'scene-1' }),
        'fact-dead': tombstone('fact-dead'),
      }),
      continuity: {
        contradictions: [
          // Left with one source: removed outright.
          contradiction('doomed', ['fact-a', 'fact-dead']),
          // Keeps two sources but loses its winner: reopened.
          resolved('reopened', ['fact-a', 'fact-b', 'fact-dead'], 'fact-dead'),
          // Write-my-own, resolved onto a fact that never made the log.
          resolved('reopened-too', ['fact-a', 'fact-b'], 'fact-mine'),
          contradiction('untouched', ['fact-a', 'fact-b']),
        ],
      },
      scenes: [
        sceneRow('scene-1', {
          continuity_facts_established: ['fact-a', 'fact-dead'],
          participants: ['char-ivy', 'char-ghost'],
          pov_character: 'char-ghost',
        }),
      ],
    };
  }

  /** Exactly what the footer's "Fix and lock" does: one continuity
   *  patch, one scene PUT each, both driven by the FINDINGS. */
  function applyFixes(state: CanonCheckState, errors: ReturnType<typeof checkCanon>['errors']) {
    const plan = planCanonFixes(errors);
    const entries = (state.continuity?.contradictions ?? []) as Contradiction[];
    const patchedEntries = cleanupFactRefs(entries, plan.deadFactIds);
    const scenes = state.scenes.map((row) => {
      const dead = plan.scenes.get(row.id);
      const patched = dead ? cleanupSceneRefs(row.data, dead) : null;
      return patched ? { id: row.id, data: patched } : row;
    });
    return {
      next: {
        ...state,
        continuity: { contradictions: patchedEntries ?? entries },
        scenes,
      },
      patchedEntries,
      sceneWrites: [...plan.scenes.keys()],
    };
  }

  it('fixes every error class in one pass, and the recheck comes back clean', () => {
    const state = dirtyBible();
    const first = checkCanon(state);
    expect(new Set(kinds(first.errors))).toEqual(
      new Set([
        'contradiction_source',
        'contradiction_choice',
        'scene_fact',
        'scene_participant',
        'scene_pov',
      ])
    );

    const { next } = applyFixes(state, first.errors);
    expect(checkCanon(next).errors).toEqual([]);
  });

  it('applying the same fixes again is a no-op — both cleanups report nothing to write', () => {
    const state = dirtyBible();
    const first = checkCanon(state);
    const { next } = applyFixes(state, first.errors);

    const plan = planCanonFixes(first.errors);
    expect(
      cleanupFactRefs(next.continuity!.contradictions as Contradiction[], plan.deadFactIds)
    ).toBeNull();
    expect(cleanupSceneRefs(next.scenes[0].data, plan.scenes.get('scene-1')!)).toBeNull();
  });

  it('leaves the warnings alone — they are not what the fix is for', () => {
    const state = {
      ...dirtyBible(),
      facts: factIndex({
        'fact-a': fact('fact-a', { established_in: 'scene-gone', supersedes: 'fact-old' }),
        'fact-b': fact('fact-b', { established_in: 'scene-1' }),
        'fact-dead': tombstone('fact-dead'),
      }),
    };
    const first = checkCanon(state);
    expect(first.warnings.length).toBeGreaterThan(0);
    const { next } = applyFixes(state, first.errors);
    expect(checkCanon(next).warnings).toEqual(first.warnings);
  });

  it('keeps every surviving entry id, and touches only the scenes that had a finding', () => {
    const state = dirtyBible();
    const { next, sceneWrites } = applyFixes(state, checkCanon(state).errors);
    expect((next.continuity!.contradictions as Contradiction[]).map((e) => e.id)).toEqual([
      'reopened',
      'reopened-too',
      'untouched',
    ]);
    expect(sceneWrites).toEqual(['scene-1']);
  });
});

describe('stale source scenes (phase 11)', () => {
  it('warns — not errors — for a scene whose source drifted upstream', () => {
    const state: CanonCheckState = {
      scenes: [
        {
          id: 's1',
          data: {
            title: 'The rooftop',
            annotations: { stale_source: true },
          },
        } as unknown as SceneRow,
      ],
      facts: new Map(),
    };

    const { errors, warnings } = checkCanon(state);

    // The bible is still internally consistent — nothing dangles. The
    // problem is upstream, and there is no mechanical fix, so it must not
    // block a lock.
    expect(errors).toHaveLength(0);
    const stale = warnings.filter((w) => w.kind === 'scene_stale_source');
    expect(stale).toHaveLength(1);
    expect(stale[0].ownerId).toBe('s1');
    expect(stale[0].message).toContain('The rooftop');
  });

  it('says nothing for an unflagged scene or a pre-phase-11 row', () => {
    const state: CanonCheckState = {
      scenes: [
        {
          id: 's1',
          data: { title: 'A', annotations: { stale_source: false } },
        } as unknown as SceneRow,
        // Rows written before the flag existed carry no annotations at
        // all; absent must read as "fine", never throw.
        { id: 's2', data: { title: 'B' } } as unknown as SceneRow,
      ],
      facts: new Map(),
    };

    const { warnings } = checkCanon(state);
    expect(warnings.filter((w) => w.kind === 'scene_stale_source')).toHaveLength(0);
  });
});
