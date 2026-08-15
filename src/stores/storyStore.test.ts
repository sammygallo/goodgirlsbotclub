import { describe, it, expect, vi, beforeEach } from 'vitest';

const manifest = vi.fn();
const getSection = vi.fn();
const putSection = vi.fn();
const listScenes = vi.fn();
const listScenesFull = vi.fn();
const listFacts = vi.fn();
const reset = vi.fn();
const listArchives = vi.fn();
const restoreArchiveApi = vi.fn();
const deleteFactApi = vi.fn();
const appendEdit = vi.fn();
const getScene = vi.fn();
const putScene = vi.fn();
const deleteScene = vi.fn();

class FakeConflict extends Error {
  currentTs: number;
  current: unknown;
  constructor(currentTs: number, current: unknown) {
    super('conflict');
    this.name = 'StoryConflictError';
    this.currentTs = currentTs;
    this.current = current;
  }
}

class FakeRestoreConflict extends Error {
  current: unknown;
  constructor(current: unknown) {
    super('restore conflict');
    this.name = 'StoryRestoreConflictError';
    this.current = current;
  }
}

vi.mock('../api/client', () => ({
  storyApi: {
    manifest: (...a: unknown[]) => manifest(...a),
    getSection: (...a: unknown[]) => getSection(...a),
    putSection: (...a: unknown[]) => putSection(...a),
    listScenes: (...a: unknown[]) => listScenes(...a),
    listScenesFull: (...a: unknown[]) => listScenesFull(...a),
    listFacts: (...a: unknown[]) => listFacts(...a),
    listEdits: vi.fn(),
    reset: (...a: unknown[]) => reset(...a),
    listArchives: (...a: unknown[]) => listArchives(...a),
    restoreArchive: (...a: unknown[]) => restoreArchiveApi(...a),
    deleteFact: (...a: unknown[]) => deleteFactApi(...a),
    appendEdit: (...a: unknown[]) => appendEdit(...a),
    getScene: (...a: unknown[]) => getScene(...a),
    putScene: (...a: unknown[]) => putScene(...a),
    deleteScene: (...a: unknown[]) => deleteScene(...a),
  },
  StoryConflictError: FakeConflict,
  StoryRestoreConflictError: FakeRestoreConflict,
}));

vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));

// The build-active gate reads storyIngestStore's checkpoint lazily.
// Mocking it lets a test set the checkpoint on a per-case basis without
// pulling the real ingest module (with its ambient store subscriptions)
// into the test env.
const ingestCheckpoint = { current: null as null | { status: string } };
vi.mock('./storyIngestStore', () => ({
  useStoryIngestStore: {
    getState: () => ({ checkpoint: ingestCheckpoint.current }),
  },
}));

const { useStoryStore, hasBible } = await import('./storyStore');
const { showToastGlobal } = await import('../components/ui/Toast');
const { STORY_SCHEMA_VERSION } = await import('../types/storyBible');

const CHAT = { character_avatar: 'Ivy.png', file_name: 'Ivy - 1' };

const emptyManifest = {
  project_id: 'p1',
  sections: [],
  scene_count: 0,
  fact_count: 0,
  edit_count: 0,
};

function metaSection(serverTs: number, extra: Record<string, unknown> = {}) {
  return {
    section: 'meta',
    server_ts: serverTs,
    updated_at: '2026-07-28T12:00:00Z',
    data: {
      schema_version: '1.0',
      bible_id: 'bible-1',
      created_at: '2026-07-28T10:00:00Z',
      updated_at: '2026-07-28T10:00:00Z',
      source: { platform: 'ggbc', chat: { kind: 'chat', ref: CHAT } },
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStoryStore.getState().clear();
  manifest.mockResolvedValue(emptyManifest);
  listScenes.mockResolvedValue({ items: [], next_after_sequence: null, next_after_id: null, has_more: false });
  listFacts.mockResolvedValue({ items: [], next_after_seq: null, has_more: false });
  listScenesFull.mockResolvedValue({
    items: [],
    next_after_sequence: null,
    next_after_id: null,
    has_more: false,
    truncated_by_bytes: false,
  });
  listArchives.mockResolvedValue({
    archives: [],
    next_after_created_at: null,
    next_after_id: null,
    has_more: false,
  });
  deleteFactApi.mockResolvedValue(undefined);
  appendEdit.mockResolvedValue({ seq: 1, id: 'e1', data: {}, created_at: 'x' });
  deleteScene.mockResolvedValue(undefined);
  ingestCheckpoint.current = null;
});

describe('hasBible', () => {
  it('is true only once meta exists', () => {
    expect(hasBible(null)).toBe(false);
    expect(hasBible(emptyManifest)).toBe(false);
    expect(
      hasBible({
        ...emptyManifest,
        sections: [
          { section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' },
        ],
      })
    ).toBe(true);
  });
});

describe('load', () => {
  it('only fetches sections the manifest says exist', async () => {
    manifest.mockResolvedValue({
      ...emptyManifest,
      sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
    });
    getSection.mockResolvedValue(metaSection(1));

    await useStoryStore.getState().load('p1');

    expect(getSection).toHaveBeenCalledTimes(1);
    expect(getSection).toHaveBeenCalledWith('p1', 'meta');
    expect(useStoryStore.getState().sections.meta?.server_ts).toBe(1);
  });

  it('skips scene/fact reads when the counts are zero', async () => {
    await useStoryStore.getState().load('p1');
    expect(listScenes).not.toHaveBeenCalled();
    expect(listFacts).not.toHaveBeenCalled();
  });

  it('does not land a stale works manifest on the current work', async () => {
    let release: (v: unknown) => void = () => {};
    manifest.mockImplementationOnce(() => new Promise((r) => { release = r; }));

    const slow = useStoryStore.getState().load('p1');
    // User opens a different Work before p1's manifest lands.
    useStoryStore.setState({ projectId: 'p2', manifest: null });
    release({ ...emptyManifest, project_id: 'p1', fact_count: 99 });
    await slow;

    expect(useStoryStore.getState().projectId).toBe('p2');
    // The guard must run BEFORE the write — otherwise p1's counts render
    // under p2's name.
    expect(useStoryStore.getState().manifest).toBeNull();
  });

  it('clear() releases the loading flag an aborted load would strand', async () => {
    let release: (v: unknown) => void = () => {};
    manifest.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const slow = useStoryStore.getState().load('p1');
    useStoryStore.getState().clear();
    release(emptyManifest);
    await slow;
    expect(useStoryStore.getState().isLoading).toBe(false);
  });
});

describe('designateSourceChat', () => {
  it('creates meta with base_ts 0 and a full source block', async () => {
    putSection.mockResolvedValue(metaSection(1));
    useStoryStore.setState({ projectId: 'p1' });

    const ok = await useStoryStore
      .getState()
      .designateSourceChat(CHAT, {
        characters: [{ avatar: 'Ivy.png', name: 'Ivy' }],
        title: 'Our Manga',
      });

    expect(ok).toBe(true);
    const [projectId, name, data, baseTs] = putSection.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(name).toBe('meta');
    expect(baseTs).toBe(0);
    expect(data.schema_version).toBe(STORY_SCHEMA_VERSION);
    expect(data.bible_id).toBeTruthy();
    expect(data.source.platform).toBe('ggbc');
    expect(data.source.chat.kind).toBe('chat');
    expect(data.source.chat.ref).toEqual(CHAT);
    expect(data.source.characters[0].ref).toBe('Ivy.png');
    expect(data.title).toBe('Our Manga');
    // A fresh designation starts the watermark at zero.
    expect(data.ingest_watermark).toEqual({ message_count: 0, last_msg: null });
  });

  it('re-designation keeps bible identity and creation time', async () => {
    putSection.mockResolvedValue(metaSection(2));
    useStoryStore.setState({ projectId: 'p1', sections: { meta: metaSection(1) } });

    const other = { character_avatar: 'Nyx.png', file_name: 'Nyx - 2' };
    await useStoryStore.getState().designateSourceChat(other);

    const [, , data, baseTs] = putSection.mock.calls[0];
    expect(baseTs).toBe(1);
    expect(data.bible_id).toBe('bible-1');
    expect(data.created_at).toBe('2026-07-28T10:00:00Z');
    expect(data.updated_at).not.toBe('2026-07-28T10:00:00Z');
    expect(data.source.chat.ref).toEqual(other);
  });

  it('adopts the winner and retries once on a conflict', async () => {
    useStoryStore.setState({ projectId: 'p1', sections: { meta: metaSection(1) } });
    const winner = metaSection(7, { title: 'Winner' });
    putSection
      .mockRejectedValueOnce(new FakeConflict(7, winner))
      .mockResolvedValueOnce(metaSection(8));

    const ok = await useStoryStore.getState().designateSourceChat(CHAT);

    expect(ok).toBe(true);
    expect(putSection).toHaveBeenCalledTimes(2);
    // The retry carries the winner's token, not our stale one...
    expect(putSection.mock.calls[0][3]).toBe(1);
    expect(putSection.mock.calls[1][3]).toBe(7);
    // ...and is rebuilt from the winner's DATA, not ours. A section PUT
    // is a full replace, so retrying with our own body would silently
    // revert whatever the winner wrote.
    expect(putSection.mock.calls[1][2].title).toBe('Winner');
  });

  it('gives up after one failed retry rather than looping', async () => {
    useStoryStore.setState({ projectId: 'p1', sections: { meta: metaSection(1) } });
    putSection
      .mockRejectedValueOnce(new FakeConflict(7, metaSection(7)))
      .mockRejectedValueOnce(new FakeConflict(9, metaSection(9)));

    const ok = await useStoryStore.getState().designateSourceChat(CHAT);

    expect(ok).toBe(false);
    expect(putSection).toHaveBeenCalledTimes(2);
    expect(useStoryStore.getState().isSaving).toBe(false);
  });

  it('reports a plain failure without retrying', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    putSection.mockRejectedValue(new Error('network down'));

    const ok = await useStoryStore.getState().designateSourceChat(CHAT);

    expect(ok).toBe(false);
    expect(putSection).toHaveBeenCalledTimes(1);
  });
});

describe('loadMoreFacts', () => {
  it('pages with the per-project seq cursor', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      facts: [{ seq: 2, id: 'f2', data: {}, created_at: 'x' }],
      factsCursor: 2,
      factsHasMore: true,
    });
    listFacts.mockResolvedValue({
      items: [{ seq: 3, id: 'f3', data: {}, created_at: 'x' }],
      next_after_seq: null,
      has_more: false,
    });

    await useStoryStore.getState().loadMoreFacts();

    expect(listFacts).toHaveBeenCalledWith('p1', { afterSeq: 2, limit: 50 });
    expect(useStoryStore.getState().facts.map((f) => f.id)).toEqual(['f2', 'f3']);
    expect(useStoryStore.getState().factsHasMore).toBe(false);
  });

  it('is a no-op when there is nothing more', async () => {
    useStoryStore.setState({ projectId: 'p1', factsHasMore: false });
    await useStoryStore.getState().loadMoreFacts();
    expect(listFacts).not.toHaveBeenCalled();
  });
});

describe('loadMoreScenes', () => {
  it('sends BOTH cursor halves — sequence alone drops tied scenes', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      scenes: [
        {
          id: 'scene-b',
          sequence: 4,
          title: '',
          summary: '',
          server_ts: 1,
          updated_at: 'x',
        },
      ],
      scenesHasMore: true,
    });
    listScenes.mockResolvedValue({
      items: [],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
    });

    await useStoryStore.getState().loadMoreScenes();

    expect(listScenes).toHaveBeenCalledWith('p1', {
      afterSequence: 4,
      afterId: 'scene-b',
      limit: 100,
    });
  });
});

describe('meta is a full round-trip (section PUT replaces everything)', () => {
  it('preserves fields this action does not own', async () => {
    const rich = metaSection(3, {
      content_rating: 'explicit',
      logline: 'A long-running slow burn.',
      genre_hints: ['romance'],
      derivative_flags: { derived_from_known_ip: true, derived_ip_notes: 'AU' },
      word_count_actual: 12000,
      canon_locked_at: '2026-07-28T11:30:00Z',
    });
    putSection.mockResolvedValue(metaSection(4));
    useStoryStore.setState({ projectId: 'p1', sections: { meta: rich } });

    await useStoryStore.getState().designateSourceChat(CHAT);

    const body = putSection.mock.calls[0][2];
    expect(body.content_rating).toBe('explicit');
    expect(body.logline).toBe('A long-running slow burn.');
    expect(body.genre_hints).toEqual(['romance']);
    expect(body.derivative_flags.derived_from_known_ip).toBe(true);
    expect(body.word_count_actual).toBe(12000);
    expect(body.canon_locked_at).toBe('2026-07-28T11:30:00Z');
    // ...while the fields designation DOES own are refreshed.
    expect(body.source.chat.ref).toEqual(CHAT);
    expect(body.ingest_watermark).toEqual({ message_count: 0, last_msg: null });
  });
});

describe('stale-project safety', () => {
  it('does not drag the store back to a work the user left', async () => {
    // The reload after a successful write must not re-point projectId at
    // the old Work — every later write reads it.
    putSection.mockImplementation(async () => {
      useStoryStore.setState({ projectId: 'p2' });
      return metaSection(1);
    });
    useStoryStore.setState({ projectId: 'p1' });

    const ok = await useStoryStore.getState().designateSourceChat(CHAT);

    // A remotely-successful write against a Work the caller already left
    // is not "success" from that caller's point of view — a caller like
    // confirmChange() must not chain further action off this.
    expect(ok).toBe(false);
    expect(useStoryStore.getState().projectId).toBe('p2');
    expect(manifest).not.toHaveBeenCalled();
  });

  it('does not clobber a different projects meta section', async () => {
    // p2 has its own real meta AND its own save genuinely in flight — p1's
    // designateSourceChat resolving late must not touch any of it.
    putSection.mockImplementation(async () => {
      useStoryStore.setState({
        projectId: 'p2',
        sections: { meta: metaSection(5) },
        isSaving: true,
      });
      return metaSection(1);
    });
    useStoryStore.setState({ projectId: 'p1' });

    await useStoryStore.getState().designateSourceChat(CHAT);

    const state = useStoryStore.getState();
    expect(state.projectId).toBe('p2');
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
  });

  it('resetBible does not re-point a switched-away store either', async () => {
    reset.mockImplementation(async () => {
      useStoryStore.setState({ projectId: 'p2' });
    });
    useStoryStore.setState({ projectId: 'p1' });

    const ok = await useStoryStore.getState().resetBible();

    // Same reasoning as designateSourceChat above: confirmChange chains
    // `if (await resetBible(...)) await designate(chat)` off this exact
    // return value, so a stale `true` here would write Work A's newly
    // picked chat into whatever Work is current by the time this resolves.
    expect(ok).toBe(false);
    expect(useStoryStore.getState().projectId).toBe('p2');
    expect(manifest).not.toHaveBeenCalled();
  });

  it('resetBible does not clobber a different projects sections or isSaving flag', async () => {
    // p2 has its own real state AND its own save genuinely in flight —
    // p1's reset resolving late must not touch any of it.
    reset.mockImplementation(async () => {
      useStoryStore.setState({
        projectId: 'p2',
        sections: { meta: metaSection(5) },
        isSaving: true,
      });
    });
    useStoryStore.setState({ projectId: 'p1' });

    await useStoryStore.getState().resetBible();

    const state = useStoryStore.getState();
    expect(state.projectId).toBe('p2');
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
  });

  it('restoreArchive does not clobber a different projects sections or isSaving flag', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      manifest: {
        project_id: 'p1',
        sections: [],
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      },
    });
    restoreArchiveApi.mockImplementation(async () => {
      useStoryStore.setState({
        projectId: 'p2',
        sections: { meta: metaSection(5) },
        isSaving: true,
      });
      return {
        sections_restored: 0,
        scenes_restored: 0,
        facts_restored: 0,
        edits_restored: 0,
        pre_restore_archive_id: 'backup-1',
      };
    });

    const ok = await useStoryStore.getState().restoreArchive('archive-1');

    expect(ok).toBe(false);
    const state = useStoryStore.getState();
    expect(state.projectId).toBe('p2');
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
  });
});

describe('success is reported against the work that is still current', () => {
  it('resetBible does not report success when the user leaves during the reload', async () => {
    // The window the epoch guard alone misses: `stillCurrent` is sampled
    // right after the reset call, but reloadIfStillOn and loadArchives are
    // two more awaits during which the user can switch Works. A stale
    // `true` here is what lets confirmChange chain designate() into the
    // wrong bible.
    useStoryStore.setState({ projectId: 'p1' });
    manifest.mockImplementation(async () => {
      useStoryStore.getState().clear();
      useStoryStore.setState({ projectId: 'p2' });
      return emptyManifest;
    });

    const ok = await useStoryStore.getState().resetBible();

    expect(ok).toBe(false);
    expect(showToastGlobal).not.toHaveBeenCalledWith('Story reset', 'success');
  });

  it('designateSourceChat refuses to write into a work it was not asked for', async () => {
    putSection.mockResolvedValue(metaSection(1));
    useStoryStore.setState({ projectId: 'p2' });

    // The caller decided this designation was for p1 (confirmChange picked
    // the chat there), but the store is on p2 by the time it runs.
    const ok = await useStoryStore
      .getState()
      .designateSourceChat(CHAT, { projectId: 'p1' });

    expect(ok).toBe(false);
    expect(putSection).not.toHaveBeenCalled();
    // And p2's own saving flag is untouched — the bail happens before the
    // claim.
    expect(useStoryStore.getState().isSaving).toBe(false);
  });
});

describe('same-work revisit safety (store epoch)', () => {
  // The projectId guard alone can't see a leave-and-return: navigate away
  // from Work A and back to Work A while a mutation is in flight, and by
  // the time it resolves projectId reads 'p1' again — so the guard passes
  // and the stale call wipes the SECOND visit's freshly loaded state.
  // clear() (which the Story tab calls on unmount) bumps an epoch that
  // makes "same project" mean "same visit".

  /** Simulate the tab unmounting and immediately remounting on the same
   *  Work, with its own state loaded and its own save in flight. */
  const leaveAndReturn = () => {
    useStoryStore.getState().clear();
    useStoryStore.setState({
      projectId: 'p1',
      sections: { meta: metaSection(5) },
      isSaving: true,
    });
  };

  it('resetBible does not wipe the second visit to the same work', async () => {
    reset.mockImplementation(async () => leaveAndReturn());
    useStoryStore.setState({ projectId: 'p1' });

    const ok = await useStoryStore.getState().resetBible();

    expect(ok).toBe(false);
    const state = useStoryStore.getState();
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
    expect(manifest).not.toHaveBeenCalled();
  });

  it('restoreArchive does not wipe the second visit to the same work', async () => {
    useStoryStore.setState({ projectId: 'p1', manifest: emptyManifest });
    restoreArchiveApi.mockImplementation(async () => {
      leaveAndReturn();
      return {
        sections_restored: 0,
        scenes_restored: 0,
        facts_restored: 0,
        edits_restored: 0,
        pre_restore_archive_id: null,
      };
    });

    const ok = await useStoryStore.getState().restoreArchive('archive-1');

    expect(ok).toBe(false);
    const state = useStoryStore.getState();
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
  });

  it('designateSourceChat does not write meta into the second visit', async () => {
    putSection.mockImplementation(async () => {
      leaveAndReturn();
      return metaSection(1);
    });
    useStoryStore.setState({ projectId: 'p1' });

    const ok = await useStoryStore.getState().designateSourceChat(CHAT);

    expect(ok).toBe(false);
    const state = useStoryStore.getState();
    // The second visit's meta (server_ts 5) survives; the stale write's
    // server_ts 1 never lands.
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
    expect(manifest).not.toHaveBeenCalled();
  });

  it('a late load() does not repopulate the second visit with stale rows', async () => {
    let release: (v: unknown) => void = () => {};
    manifest.mockImplementation(
      () => new Promise((r) => { release = r as (v: unknown) => void; })
    );

    const inFlight = useStoryStore.getState().load('p1');
    leaveAndReturn();
    release(emptyManifest);
    await inFlight;

    const state = useStoryStore.getState();
    expect(state.sections.meta?.server_ts).toBe(5);
    expect(state.isSaving).toBe(true);
  });
});

describe('re-entrancy guard', () => {
  it('resetBible is a no-op while a save is already in flight', async () => {
    useStoryStore.setState({ projectId: 'p1', isSaving: true });
    const ok = await useStoryStore.getState().resetBible();
    expect(ok).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('restoreArchive is a no-op while a save is already in flight', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      isSaving: true,
      manifest: {
        project_id: 'p1',
        sections: [],
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      },
    });
    const ok = await useStoryStore.getState().restoreArchive('archive-1');
    expect(ok).toBe(false);
    expect(restoreArchiveApi).not.toHaveBeenCalled();
  });
});

describe('loadArchives sequencing', () => {
  it('a slower earlier call does not overwrite a faster later calls result', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    let releaseFirst: (v: unknown) => void = () => {};
    listArchives
      .mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }))
      .mockResolvedValueOnce({
        archives: [
          {
            id: 'fresh',
            reason: 'reset',
            source_label: null,
            scene_count: 0,
            fact_count: 0,
            edit_count: 0,
            size_bytes: 1,
            created_at: 'x',
          },
        ],
      });

    const firstCall = useStoryStore.getState().loadArchives();
    const secondCall = useStoryStore.getState().loadArchives();
    await secondCall;
    expect(useStoryStore.getState().archives.map((a) => a.id)).toEqual(['fresh']);

    releaseFirst({
      archives: [
        {
          id: 'stale',
          reason: 'reset',
          source_label: null,
          scene_count: 0,
          fact_count: 0,
          edit_count: 0,
          size_bytes: 1,
          created_at: 'x',
        },
      ],
    });
    await firstCall;

    // The stale first call resolving after the fresh one must not revert
    // the list back to what it saw.
    expect(useStoryStore.getState().archives.map((a) => a.id)).toEqual(['fresh']);
  });

  it('a stale calls failure does not toast an error over an already-fresh list', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    let rejectFirst: (e: unknown) => void = () => {};
    listArchives
      .mockImplementationOnce(() => new Promise((_r, rej) => { rejectFirst = rej; }))
      .mockResolvedValueOnce({ archives: [] });

    const firstCall = useStoryStore.getState().loadArchives();
    await useStoryStore.getState().loadArchives();

    rejectFirst(new Error('stale network blip'));
    await firstCall.catch(() => {});

    // The newer call already succeeded and populated the list correctly —
    // the older, superseded call failing afterward must not pop a
    // misleading error toast over data the user already sees is fine.
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

describe('pagination against concurrent mutation', () => {
  it('does not resurrect facts a reset cleared mid-request', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      facts: [{ seq: 1, id: 'f1', data: {}, created_at: 'x' }],
      factsCursor: 1,
      factsHasMore: true,
    });
    listFacts.mockImplementation(async () => {
      // A reset lands while the page is in flight.
      useStoryStore.setState({ facts: [], factsCursor: null, factsHasMore: false });
      return {
        items: [{ seq: 2, id: 'f2', data: {}, created_at: 'x' }],
        next_after_seq: null,
        has_more: false,
      };
    });

    await useStoryStore.getState().loadMoreFacts();

    expect(useStoryStore.getState().facts).toEqual([]);
  });
});

describe('resetBible reason', () => {
  // clearAllMocks() (in the file-level beforeEach) clears call history but
  // NOT a mock's implementation — an earlier test's
  // reset.mockImplementation(...) would otherwise leak into these.
  beforeEach(() => {
    reset.mockResolvedValue(undefined);
  });

  it('defaults to no explicit reason, letting the API default apply', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    await useStoryStore.getState().resetBible();
    expect(reset).toHaveBeenCalledWith('p1', undefined);
  });

  it('threads a caller-supplied reason through to the API', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    await useStoryStore.getState().resetBible('change_source_chat');
    expect(reset).toHaveBeenCalledWith('p1', 'change_source_chat');
  });

  it('refreshes an already-open archive list after a reset', async () => {
    useStoryStore.setState({ projectId: 'p1', archivesLoaded: true });
    await useStoryStore.getState().resetBible();
    expect(listArchives).toHaveBeenCalledWith('p1', { limit: 25 });
  });

  it('does not fetch archives when the panel was never opened', async () => {
    useStoryStore.setState({ projectId: 'p1', archivesLoaded: false });
    await useStoryStore.getState().resetBible();
    expect(listArchives).not.toHaveBeenCalled();
  });
});

describe('loadArchives', () => {
  it('populates archives and marks them loaded', async () => {
    listArchives.mockResolvedValue({
      archives: [
        {
          id: 'a1',
          reason: 'reset',
          source_label: 'Ivy - 1',
          scene_count: 2,
          fact_count: 3,
          edit_count: 0,
          size_bytes: 500,
          created_at: '2026-07-30T00:00:00Z',
        },
      ],
    });
    useStoryStore.setState({ projectId: 'p1' });

    await useStoryStore.getState().loadArchives();

    expect(useStoryStore.getState().archives).toHaveLength(1);
    expect(useStoryStore.getState().archivesLoaded).toBe(true);
  });

  it('is a no-op without a current project', async () => {
    await useStoryStore.getState().loadArchives();
    expect(listArchives).not.toHaveBeenCalled();
  });

  it('does not land on a Work the user already left', async () => {
    let release: (v: unknown) => void = () => {};
    listArchives.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    useStoryStore.setState({ projectId: 'p1' });

    const slow = useStoryStore.getState().loadArchives();
    useStoryStore.setState({ projectId: 'p2', archives: [] });
    release({ archives: [{ id: 'stale', reason: 'reset', source_label: null, scene_count: 0, fact_count: 0, edit_count: 0, size_bytes: 1, created_at: 'x' }] });
    await slow;

    expect(useStoryStore.getState().archives).toEqual([]);
  });
});

describe('loadMoreArchives', () => {
  const archive = (id: string, createdAt: string) => ({
    id,
    reason: 'reset' as const,
    source_label: null,
    scene_count: 0,
    fact_count: 0,
    edit_count: 0,
    size_bytes: 1,
    created_at: createdAt,
  });

  it('appends the next page and carries the keyset cursor forward', async () => {
    listArchives.mockResolvedValueOnce({
      archives: [archive('a1', 't1')],
      next_after_created_at: 't1',
      next_after_id: 'a1',
      has_more: true,
    });
    useStoryStore.setState({ projectId: 'p1' });
    await useStoryStore.getState().loadArchives();

    expect(useStoryStore.getState().archivesHasMore).toBe(true);
    expect(useStoryStore.getState().archivesCursor).toEqual({
      createdAt: 't1',
      id: 'a1',
    });

    listArchives.mockResolvedValueOnce({
      archives: [archive('a2', 't2')],
      next_after_created_at: null,
      next_after_id: null,
      has_more: false,
    });
    await useStoryStore.getState().loadMoreArchives();

    // The cursor is the (created_at, id) PAIR — a cursor on created_at
    // alone drops rows tied at a page boundary.
    expect(listArchives).toHaveBeenLastCalledWith('p1', {
      afterCreatedAt: 't1',
      afterId: 'a1',
      limit: 25,
    });
    expect(useStoryStore.getState().archives.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(useStoryStore.getState().archivesHasMore).toBe(false);
    expect(useStoryStore.getState().archivesCursor).toBeNull();
  });

  it('is a no-op when there is no further page', async () => {
    useStoryStore.setState({ projectId: 'p1', archivesHasMore: false });
    await useStoryStore.getState().loadMoreArchives();
    expect(listArchives).not.toHaveBeenCalled();
  });

  it('a page landing after a reload does not resurrect replaced rows', async () => {
    // resetBible/restoreArchive call loadArchives() on success. A page
    // still in flight from before that must not append onto the fresh
    // first page — both share archivesFetchSeq so the newer call wins.
    useStoryStore.setState({
      projectId: 'p1',
      archives: [archive('old', 't1')],
      archivesCursor: { createdAt: 't1', id: 'old' },
      archivesHasMore: true,
    });
    let release: (v: unknown) => void = () => {};
    listArchives.mockImplementationOnce(
      () => new Promise((r) => { release = r as (v: unknown) => void; })
    );

    const slow = useStoryStore.getState().loadMoreArchives();
    listArchives.mockResolvedValueOnce({
      archives: [archive('fresh', 't9')],
      next_after_created_at: null,
      next_after_id: null,
      has_more: false,
    });
    await useStoryStore.getState().loadArchives();
    release({
      archives: [archive('stale', 't0')],
      next_after_created_at: null,
      next_after_id: null,
      has_more: false,
    });
    await slow;

    expect(useStoryStore.getState().archives.map((a) => a.id)).toEqual(['fresh']);
  });
});

describe('restoreArchive', () => {
  const richManifest = {
    project_id: 'p1',
    sections: [
      { section: 'meta', server_ts: 3, bytes: 10, updated_at: 'x' },
      { section: 'world', server_ts: 1, bytes: 5, updated_at: 'x' },
    ],
    scene_count: 2,
    fact_count: 4,
    edit_count: 1,
  };

  it('builds the guard from the current manifest and restores on success', async () => {
    useStoryStore.setState({ projectId: 'p1', manifest: richManifest });
    restoreArchiveApi.mockResolvedValue({
      sections_restored: 1,
      scenes_restored: 1,
      facts_restored: 1,
      edits_restored: 0,
      pre_restore_archive_id: 'backup-1',
    });

    const ok = await useStoryStore.getState().restoreArchive('archive-1');

    expect(ok).toBe(true);
    expect(restoreArchiveApi).toHaveBeenCalledWith('p1', 'archive-1', {
      sections: { meta: 3, world: 1 },
      sceneCount: 2,
      factCount: 4,
      editCount: 1,
    });
  });

  it('reflects the freshly-loaded state after a successful restore, not stale pre-restore data', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      manifest: richManifest,
      sections: { meta: metaSection(3) },
      scenes: [{ id: 's1', sequence: 0, title: '', summary: '', server_ts: 1, updated_at: 'x' }],
      facts: [{ seq: 1, id: 'f1', data: {}, created_at: 'x' }],
    });
    restoreArchiveApi.mockResolvedValue({
      sections_restored: 0,
      scenes_restored: 0,
      facts_restored: 0,
      edits_restored: 0,
      pre_restore_archive_id: 'backup-1',
    });
    manifest.mockResolvedValue(emptyManifest);

    await useStoryStore.getState().restoreArchive('archive-1');

    expect(useStoryStore.getState().manifest).toEqual(emptyManifest);
    expect(useStoryStore.getState().isSaving).toBe(false);
  });

  it('does nothing without a project or a loaded manifest', async () => {
    useStoryStore.setState({ projectId: null, manifest: richManifest });
    expect(await useStoryStore.getState().restoreArchive('a1')).toBe(false);

    useStoryStore.setState({ projectId: 'p1', manifest: null });
    expect(await useStoryStore.getState().restoreArchive('a1')).toBe(false);
    expect(restoreArchiveApi).not.toHaveBeenCalled();
  });

  it('adopts the fresh manifest a conflict carries, so the next attempt is not built on stale data', async () => {
    useStoryStore.setState({ projectId: 'p1', manifest: richManifest });
    const fresher = { ...richManifest, fact_count: 99 };
    restoreArchiveApi.mockRejectedValue(new FakeRestoreConflict(fresher));

    const ok = await useStoryStore.getState().restoreArchive('archive-1');

    expect(ok).toBe(false);
    expect(useStoryStore.getState().manifest).toEqual(fresher);
    expect(useStoryStore.getState().isSaving).toBe(false);
  });

  it('reports a plain failure without touching the manifest', async () => {
    useStoryStore.setState({ projectId: 'p1', manifest: richManifest });
    restoreArchiveApi.mockRejectedValue(new Error('network down'));

    const ok = await useStoryStore.getState().restoreArchive('archive-1');

    expect(ok).toBe(false);
    expect(useStoryStore.getState().manifest).toEqual(richManifest);
  });

  it('refreshes an already-open archive list after restoring', async () => {
    useStoryStore.setState({ projectId: 'p1', manifest: richManifest, archivesLoaded: true });
    restoreArchiveApi.mockResolvedValue({
      sections_restored: 0,
      scenes_restored: 0,
      facts_restored: 0,
      edits_restored: 0,
      pre_restore_archive_id: 'backup-1',
    });

    await useStoryStore.getState().restoreArchive('archive-1');

    expect(listArchives).toHaveBeenCalledWith('p1', { limit: 25 });
  });
});

// ---------------------------------------------------------------------------
// Review checkpoint (phase 10)
// ---------------------------------------------------------------------------

const CONTRADICTION = {
  id: 'c1',
  type: 'character_attribute',
  description: 'Eye colour disagrees',
  sources: ['f1', 'f2'],
  detected_by: 'agent',
  resolution: { status: 'unresolved', canonical_choice: null, rationale: '' },
};

function continuitySection(serverTs: number, entries: unknown[] = [CONTRADICTION]) {
  return {
    section: 'continuity',
    server_ts: serverTs,
    updated_at: '2026-08-10T12:00:00Z',
    data: { contradictions: entries },
  };
}

function factRow(id: string, text = 'a fact', seq = 1) {
  return {
    seq,
    id,
    created_at: '2026-08-10T12:00:00Z',
    data: { id, text, category: 'reveal', confidence: 'explicit' },
  };
}

describe('load — the tombstone-aware fact gate', () => {
  it('still fetches facts when every fact has been deleted', async () => {
    // fact_count counts LIVE facts, so an all-deleted log reports 0 — but
    // the rows are still on the wire and the review list must show them.
    manifest.mockResolvedValue({
      ...emptyManifest,
      sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
      fact_count: 0,
    });
    getSection.mockResolvedValue(metaSection(1));

    await useStoryStore.getState().load('p1');

    expect(listFacts).toHaveBeenCalledWith('p1', { limit: 50 });
  });
});

describe('patchContinuity', () => {
  beforeEach(() => {
    useStoryStore.setState({
      projectId: 'p1',
      sections: { continuity: continuitySection(3) as never },
    });
  });

  it('writes the patched entries and appends an edit row', async () => {
    putSection.mockResolvedValue(continuitySection(4));

    const ok = await useStoryStore.getState().patchContinuity(
      (entries) =>
        entries.map((e) => ({
          ...e,
          resolution: { ...e.resolution, status: 'deferred' as const },
        })),
      { target: { type: 'contradiction' }, classification: 'contradiction' }
    );

    expect(ok).toBe(true);
    const [, name, data, baseTs] = putSection.mock.calls[0];
    expect(name).toBe('continuity');
    expect(baseTs).toBe(3);
    expect((data as { contradictions: { resolution: { status: string } }[] })
      .contradictions[0].resolution.status).toBe('deferred');
    expect(appendEdit).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the patch returns null — no PUT, no edit row', async () => {
    const ok = await useStoryStore.getState().patchContinuity(() => null, {
      target: { type: 'contradiction' },
      classification: 'contradiction',
    });

    expect(ok).toBe(true);
    expect(putSection).not.toHaveBeenCalled();
    expect(appendEdit).not.toHaveBeenCalled();
  });

  it('re-applies the intent to the WINNER on conflict, not the local copy', async () => {
    // Another tab resolved a DIFFERENT entry first. Both must survive:
    // merging detections would drop this one's resolution silently.
    const otherEntry = { ...CONTRADICTION, id: 'c2', sources: ['f3', 'f4'] };
    putSection
      .mockRejectedValueOnce(
        new FakeConflict(9, continuitySection(9, [CONTRADICTION, otherEntry]).data
          ? continuitySection(9, [CONTRADICTION, otherEntry])
          : null)
      )
      .mockResolvedValueOnce(continuitySection(10));

    const ok = await useStoryStore.getState().patchContinuity(
      (entries) =>
        entries.map((e) =>
          e.id === 'c1'
            ? { ...e, resolution: { ...e.resolution, status: 'deferred' as const } }
            : e
        ),
      { target: { type: 'contradiction' }, classification: 'contradiction' }
    );

    expect(ok).toBe(true);
    expect(putSection).toHaveBeenCalledTimes(2);
    const [, , retryData, retryBaseTs] = putSection.mock.calls[1];
    expect(retryBaseTs).toBe(9);
    const entries = (retryData as { contradictions: { id: string; resolution: { status: string } }[] }).contradictions;
    // The winner's other entry survived AND this call's intent applied.
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === 'c1')?.resolution.status).toBe('deferred');
  });

  it('gives up after a second conflict instead of blind-overwriting', async () => {
    putSection
      .mockRejectedValueOnce(new FakeConflict(9, continuitySection(9)))
      .mockRejectedValueOnce(new FakeConflict(11, continuitySection(11)));

    const ok = await useStoryStore.getState().patchContinuity(
      (entries) => [...entries],
      { target: { type: 'contradiction' }, classification: 'contradiction' }
    );

    expect(ok).toBe(false);
    expect(putSection).toHaveBeenCalledTimes(2);
    expect(useStoryStore.getState().isSaving).toBe(false);
  });

  it('does not write or toast for a work the user has left', async () => {
    let release: (v: unknown) => void = () => {};
    putSection.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = useStoryStore.getState().patchContinuity(
      (entries) => [...entries],
      { target: { type: 'contradiction' }, classification: 'contradiction' }
    );
    useStoryStore.getState().clear();
    release(continuitySection(4));

    expect(await pending).toBe(false);
    expect(useStoryStore.getState().sections.continuity).toBeUndefined();
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

describe('deleteFact', () => {
  beforeEach(() => {
    useStoryStore.setState({
      projectId: 'p1',
      facts: [factRow('f1'), factRow('f2', 'another', 2)],
      sections: { continuity: continuitySection(3) as never },
    });
    putSection.mockResolvedValue(continuitySection(4));
  });

  it('tombstones the row locally instead of dropping it from the list', async () => {
    // The reload at the end reads fresh state from the server, so the
    // wire keeps returning the tombstone rather than dropping the row —
    // the mock must mirror that (the reason for §4.2's cursor-stability
    // rule on GET /facts).
    manifest.mockResolvedValue({
      ...emptyManifest,
      sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
      fact_count: 1,
    });
    getSection.mockResolvedValue(metaSection(1));
    listFacts.mockResolvedValue({
      items: [
        {
          seq: 1,
          id: 'f1',
          created_at: '2026-08-10T12:00:00Z',
          data: { id: 'f1', deleted_at: '2026-08-10T12:00:00Z' },
        },
        factRow('f2', 'another', 2),
      ],
      next_after_seq: null,
      has_more: false,
    });

    await useStoryStore.getState().deleteFact('f1');

    const { facts } = useStoryStore.getState();
    expect(facts).toHaveLength(2);
    const deleted = facts.find((f) => f.id === 'f1');
    expect(deleted?.data.text).toBeUndefined();
    expect(typeof deleted?.data.deleted_at).toBe('string');
    // The untouched row is left exactly as it was.
    expect(facts.find((f) => f.id === 'f2')?.data.text).toBe('another');
  });

  it('treats an already-deleted fact as success, not an error', async () => {
    deleteFactApi.mockRejectedValueOnce(new Error('fact not found'));

    const ok = await useStoryStore.getState().deleteFact('f1');

    expect(ok).toBe(true);
    expect(showToastGlobal).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed'),
      'error'
    );
  });

  it('cleans up contradictions that cited the fact', async () => {
    await useStoryStore.getState().deleteFact('f1');

    // Only two sources, so removing one drops the entry entirely.
    const [, , data] = putSection.mock.calls[0];
    expect((data as { contradictions: unknown[] }).contradictions).toEqual([]);
  });

  it('never reports failure when the delete landed but cleanup did not', async () => {
    putSection.mockRejectedValue(new Error('boom'));
    putSection.mockRejectedValue(new Error('boom'));

    const ok = await useStoryStore.getState().deleteFact('f1');

    expect(deleteFactApi).toHaveBeenCalledWith('p1', 'f1');
    expect(ok).toBe(true);
    expect(showToastGlobal).toHaveBeenCalledWith(
      expect.stringContaining("couldn't be cleaned"),
      'warning'
    );
  });

  it('does not touch state for a work the user has left', async () => {
    let release: (v: unknown) => void = () => {};
    deleteFactApi.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = useStoryStore.getState().deleteFact('f1');
    useStoryStore.getState().clear();
    release(undefined);

    expect(await pending).toBe(false);
    expect(useStoryStore.getState().facts).toEqual([]);
  });
});

describe('loadAllFactsById', () => {
  it('pages the whole log and keeps tombstones in the index', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    listFacts
      .mockResolvedValueOnce({
        items: [factRow('f1'), { seq: 2, id: 'f2', created_at: 'x', data: { id: 'f2', deleted_at: '2026-08-10T12:00:00Z' } }],
        next_after_seq: 2,
        has_more: true,
      })
      .mockResolvedValueOnce({ items: [factRow('f3', 'third', 3)], next_after_seq: null, has_more: false });

    const index = await useStoryStore.getState().loadAllFactsById();

    expect(index?.size).toBe(3);
    // A deleted source must stay resolvable so a card can say so.
    expect(index?.get('f2')?.data.deleted_at).toBeTruthy();
    expect(listFacts).toHaveBeenCalledTimes(2);
  });

  it('serves the cache instead of re-paging', async () => {
    useStoryStore.setState({ projectId: 'p1', factIndex: new Map([['f1', factRow('f1')]]) });

    const index = await useStoryStore.getState().loadAllFactsById();

    expect(index?.size).toBe(1);
    expect(listFacts).not.toHaveBeenCalled();
  });
});

describe('loadAllScenesFull', () => {
  const row = (id: string, sequence: number) => ({
    id,
    sequence,
    server_ts: sequence,
    updated_at: 'x',
    data: { id, sequence, participants: [`p${sequence}`] },
  });

  beforeEach(() => {
    useStoryStore.setState({ projectId: 'p1' });
  });

  it('pages on has_more, NOT on page length', async () => {
    // The server can end a page early on its own byte budget, so a short
    // page is not a last page. The callers here — the drift localiser and
    // the lock-canon check — read a partial set as scenes that are MISSING
    // their refs, which is how a truncated fetch manufactures errors.
    listScenesFull
      .mockResolvedValueOnce({
        items: [row('s1', 0)],
        next_after_sequence: 0,
        next_after_id: 's1',
        has_more: true,
        truncated_by_bytes: true,
      })
      .mockResolvedValueOnce({
        items: [row('s2', 1)],
        next_after_sequence: null,
        next_after_id: null,
        has_more: false,
        truncated_by_bytes: false,
      });

    const scenes = await useStoryStore.getState().loadAllScenesFull();

    expect(scenes?.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(listScenesFull).toHaveBeenCalledTimes(2);
    // Resumes from the last row INCLUDED.
    expect(listScenesFull.mock.calls[1][1]).toMatchObject({
      afterSequence: 0,
      afterId: 's1',
    });
    // One request per page, not one per scene.
    expect(getScene).not.toHaveBeenCalled();
  });

  it('is deliberately uncached — a second call re-fetches', async () => {
    listScenesFull.mockResolvedValue({
      items: [row('s1', 0)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });

    await useStoryStore.getState().loadAllScenesFull();
    await useStoryStore.getState().loadAllScenesFull();

    // Both callers act on the answer — flagging scenes stale, locking the
    // canon — so a cached bible from an earlier visit is the wrong input.
    expect(listScenesFull).toHaveBeenCalledTimes(2);
  });

  it('reports a failed fetch as null, not as an empty bible', async () => {
    listScenesFull.mockRejectedValue(new Error('boom'));

    expect(await useStoryStore.getState().loadAllScenesFull()).toBeNull();
    expect(showToastGlobal).toHaveBeenCalled();
  });
});

describe('mergeSceneIntoPrevious', () => {
  const sceneData = (id: string, seq: number, extra: Record<string, unknown> = {}) => ({
    id,
    sequence: seq,
    title: `Scene ${seq}`,
    summary: `Summary ${seq}`,
    detailed_summary: `Detail ${seq}`,
    setting: { location_ref: null, time_ref: null, atmosphere: '' },
    participants: [`p${seq}`],
    continuity_facts_established: [`f${seq}`],
    source: {
      message_range: {
        start: { msg_id: `s${seq}`, swipe_idx: 0, fingerprint: { sha: 'a', hash_alg: 'sha256', send_date: 1 } },
        end: { msg_id: `e${seq}`, swipe_idx: 0, fingerprint: { sha: 'b', hash_alg: 'sha256', send_date: 2 } },
      },
      total_messages: 10,
      swipe_resolutions: [],
      excluded_segments: [],
    },
    annotations: { user_notes: '', author_intent: '', flagged_issues: [], stale_source: false },
    ...extra,
  });

  beforeEach(() => {
    useStoryStore.setState({
      projectId: 'p1',
      scenes: [
        { id: 'sc1', sequence: 0, title: 'Scene 0', summary: 'Summary 0', server_ts: 5, updated_at: 'x' },
        { id: 'sc2', sequence: 1, title: 'Scene 1', summary: 'Summary 1', server_ts: 6, updated_at: 'x' },
      ],
    });
    getScene.mockImplementation((_p: string, id: string) =>
      Promise.resolve({
        id,
        sequence: id === 'sc1' ? 0 : 1,
        server_ts: id === 'sc1' ? 5 : 6,
        updated_at: 'x',
        data: sceneData(id, id === 'sc1' ? 0 : 1),
      })
    );
    putScene.mockResolvedValue({ id: 'sc1', sequence: 0, server_ts: 7, updated_at: 'y', data: {} });
  });

  it('writes the survivor BEFORE deleting the victim', async () => {
    const order: string[] = [];
    putScene.mockImplementation(() => { order.push('put'); return Promise.resolve({ id: 'sc1', sequence: 0, server_ts: 7, updated_at: 'y', data: {} }); });
    deleteScene.mockImplementation(() => { order.push('delete'); return Promise.resolve(); });

    await useStoryStore.getState().mergeSceneIntoPrevious('sc2');

    // PUT-then-crash duplicates content (visible, retryable); the other
    // order would destroy the victim with no archive behind it.
    expect(order).toEqual(['put', 'delete']);
    expect(deleteScene).toHaveBeenCalledWith('p1', 'sc2', 6);
  });

  it('unions the fact and participant indexes and spans the message range', async () => {
    await useStoryStore.getState().mergeSceneIntoPrevious('sc2');

    const [, , merged] = putScene.mock.calls[0];
    const m = merged as ReturnType<typeof sceneData>;
    expect(m.participants).toEqual(['p0', 'p1']);
    expect(m.continuity_facts_established).toEqual(['f0', 'f1']);
    expect(m.source.message_range.start.msg_id).toBe('s0');
    expect(m.source.message_range.end.msg_id).toBe('e1');
    expect(m.source.total_messages).toBe(20);
    expect(m.title).toBe('Scene 0');
  });

  it('refuses before writing anything when the merge would exceed the cap', async () => {
    getScene.mockImplementation((_p: string, id: string) =>
      Promise.resolve({
        id,
        sequence: id === 'sc1' ? 0 : 1,
        server_ts: id === 'sc1' ? 5 : 6,
        updated_at: 'x',
        data: sceneData(id, id === 'sc1' ? 0 : 1, { detailed_summary: 'x'.repeat(40000) }),
      })
    );

    const ok = await useStoryStore.getState().mergeSceneIntoPrevious('sc2');

    expect(ok).toBe(false);
    expect(putScene).not.toHaveBeenCalled();
    expect(deleteScene).not.toHaveBeenCalled();
  });

  it('refuses to merge the first scene', async () => {
    const ok = await useStoryStore.getState().mergeSceneIntoPrevious('sc1');
    expect(ok).toBe(false);
    expect(getScene).not.toHaveBeenCalled();
  });

  it('clears the survivor’s annotation — a widened scene loses it', async () => {
    // Step-3 plan §3.9c. The survivor is spread wholesale while its range
    // is rewritten to span both scenes, so a kept `function` described
    // roughly half the material the scene ends up holding — and a render
    // read that stale beat and compression target as canon.
    getScene.mockImplementation((_p: string, id: string) =>
      Promise.resolve({
        id,
        sequence: id === 'sc1' ? 0 : 1,
        server_ts: id === 'sc1' ? 5 : 6,
        updated_at: 'x',
        data: sceneData(id, id === 'sc1' ? 0 : 1, {
          function: { beat: 'midpoint', tension: 7, mood: 'tense', stakes: 'the door' },
          transformations: {
            compression_recommendation: 'preserve',
            compression_ratio_target: 1,
            pacing_notes: 'hold',
            dialogue_density: 0.6,
          },
          annotations: {
            user_notes: 'keep me',
            author_intent: '',
            flagged_issues: ['annotation_stale', 'user flag'],
            stale_source: false,
          },
        }),
      })
    );

    await useStoryStore.getState().mergeSceneIntoPrevious('sc2');

    const [, , merged] = putScene.mock.calls[0];
    const m = merged as Record<string, unknown>;
    expect(m.function).toBeNull();
    expect(m.transformations).toBeNull();
    // The stale marker goes with the annotation it described; the user's
    // own flag and notes do not.
    const annotations = m.annotations as { flagged_issues: string[]; user_notes: string };
    expect(annotations.flagged_issues).toEqual(['user flag', 'user flag']);
    expect(annotations.user_notes).toBe('keep me');
  });
});

describe('relinkSourceChat', () => {
  const NEW_CHAT = { character_avatar: 'Ivy.png', file_name: 'Ivy - renamed' };

  it('moves only the pointer — snapshot, captured_at and watermark survive', async () => {
    const snapshot = { name: 'Ivy - 1' };
    const watermark = { message_count: 42, last_msg: null };
    useStoryStore.setState({
      projectId: 'p1',
      sections: {
        meta: metaSection(3, {
          source: {
            platform: 'ggbc',
            chat: { kind: 'chat', ref: CHAT, snapshot, captured_at: '2026-07-01T00:00:00Z' },
            characters: [{ kind: 'character', ref: 'Ivy.png' }],
          },
          ingest_watermark: watermark,
        }) as never,
      },
    });
    putSection.mockResolvedValue(metaSection(4));

    const ok = await useStoryStore.getState().relinkSourceChat(NEW_CHAT);

    expect(ok).toBe(true);
    const [, , data] = putSection.mock.calls[0];
    const meta = data as {
      source: { chat: { ref: unknown; snapshot: unknown; captured_at: string }; characters: unknown[] };
      ingest_watermark: unknown;
    };
    expect(meta.source.chat.ref).toEqual(NEW_CHAT);
    // Relink asserts "same roleplay, new identity": re-stamping the
    // snapshot would lose what was true at capture time, and zeroing the
    // watermark would make phase 11 re-walk from scratch.
    expect(meta.source.chat.snapshot).toEqual(snapshot);
    expect(meta.source.chat.captured_at).toBe('2026-07-01T00:00:00Z');
    expect(meta.ingest_watermark).toEqual(watermark);
    expect(meta.source.characters).toHaveLength(1);
  });
});

describe('appendSamplePassage', () => {
  function voiceSection(serverTs: number, passages: unknown[] = []) {
    return {
      section: 'user_voice',
      server_ts: serverTs,
      updated_at: 'x',
      data: {
        style_summary: 's',
        register: 'literary',
        diction: {},
        rhetorical_devices: [],
        pov_preferences: { in_chat: null, likely_target_for_prose: null },
        interaction_style: {},
        sample_passages: passages,
        confidence: 0.3,
      },
    };
  }

  beforeEach(() => {
    useStoryStore.setState({
      projectId: 'p1',
      sections: { user_voice: voiceSection(2) as never },
    });
    putSection.mockResolvedValue(voiceSection(3));
  });

  it('appends with a user_annotation source and leaves confidence alone', async () => {
    await useStoryStore.getState().appendSamplePassage('  My own prose.  ');

    const [, , data] = putSection.mock.calls[0];
    const voice = data as { sample_passages: { text: string; source: { kind: string } }[]; confidence: number };
    expect(voice.sample_passages).toHaveLength(1);
    expect(voice.sample_passages[0].text).toBe('My own prose.');
    expect(voice.sample_passages[0].source.kind).toBe('user_annotation');
    // The model's self-assessment is not ours to inflate.
    expect(voice.confidence).toBe(0.3);
  });

  it('refuses a whitespace-only paste before hitting the wire', async () => {
    const ok = await useStoryStore.getState().appendSamplePassage('   \n  ');
    expect(ok).toBe(false);
    expect(putSection).not.toHaveBeenCalled();
  });

  it('evicts the oldest USER passage only, never a captured one', async () => {
    const captured = { text: 'walk captured', source: { kind: 'chat_message' } };
    const mine = Array.from({ length: 10 }, (_, i) => ({
      text: `mine ${i}`,
      source: { kind: 'user_annotation' },
    }));
    useStoryStore.setState({
      projectId: 'p1',
      sections: { user_voice: voiceSection(2, [captured, ...mine]) as never },
    });

    await useStoryStore.getState().appendSamplePassage('newest');

    const [, , data] = putSection.mock.calls[0];
    const passages = (data as { sample_passages: { text: string }[] }).sample_passages;
    expect(passages[0].text).toBe('walk captured');
    expect(passages.some((p) => p.text === 'mine 0')).toBe(false);
    expect(passages.some((p) => p.text === 'newest')).toBe(true);
  });
});

describe('lockCanon / unlockCanon', () => {
  beforeEach(() => {
    useStoryStore.setState({ projectId: 'p1', sections: { meta: metaSection(3) as never } });
    putSection.mockResolvedValue(metaSection(4));
  });

  it('stamps canon_locked_at and appends a substantive edit', async () => {
    const ok = await useStoryStore.getState().lockCanon();

    expect(ok).toBe(true);
    const [, name, data] = putSection.mock.calls[0];
    expect(name).toBe('meta');
    expect(typeof (data as { canon_locked_at: string }).canon_locked_at).toBe('string');
    const edit = appendEdit.mock.calls[0][1] as { classification: string; target: { type: string } };
    expect(edit.classification).toBe('substantive');
    expect(edit.target.type).toBe('meta');
  });

  it('clears it on unlock', async () => {
    await useStoryStore.getState().unlockCanon();
    const [, , data] = putSection.mock.calls[0];
    expect((data as { canon_locked_at: string | null }).canon_locked_at).toBeNull();
  });

  it('does not toast for a work the user has left', async () => {
    let release: (v: unknown) => void = () => {};
    putSection.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = useStoryStore.getState().lockCanon();
    useStoryStore.getState().clear();
    release(metaSection(4));

    expect(await pending).toBe(false);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Review findings — regression pins (phase 10)
// ---------------------------------------------------------------------------

describe('lock and build gates', () => {
  function lockedMeta(serverTs: number) {
    return metaSection(serverTs, { canon_locked_at: '2026-08-10T12:00:00Z' });
  }

  it('refuses fact deletes while canon is locked', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      sections: { meta: lockedMeta(3) as never },
    });

    const ok = await useStoryStore.getState().deleteFact('f1');

    expect(ok).toBe(false);
    expect(deleteFactApi).not.toHaveBeenCalled();
  });

  it('refuses fact deletes while a build is running', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    ingestCheckpoint.current = { status: 'running' };

    const ok = await useStoryStore.getState().deleteFact('f1');

    expect(ok).toBe(false);
    expect(deleteFactApi).not.toHaveBeenCalled();
  });

  it('lets contradiction resolutions through during a build', async () => {
    // Resolutions are safe against reconcile's existing-wins merge, so
    // §3.3 carves them out of the build gate.
    useStoryStore.setState({
      projectId: 'p1',
      sections: { continuity: continuitySection(3) as never },
    });
    ingestCheckpoint.current = { status: 'running' };
    putSection.mockResolvedValue(continuitySection(4));

    const ok = await useStoryStore.getState().patchContinuity(
      (entries) => [...entries],
      { target: { type: 'contradiction' }, classification: 'contradiction' }
    );

    expect(ok).toBe(true);
    expect(putSection).toHaveBeenCalledTimes(1);
  });

  it('unlock works while locked, but lock refuses when already locked', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      sections: { meta: lockedMeta(3) as never },
    });
    putSection.mockResolvedValue(metaSection(4));

    // A second lock is a no-op — nothing to write and nothing to say.
    const lockAgain = await useStoryStore.getState().lockCanon();
    expect(lockAgain).toBe(false);
    expect(putSection).not.toHaveBeenCalled();

    const unlocked = await useStoryStore.getState().unlockCanon();
    expect(unlocked).toBe(true);
    const [, , data] = putSection.mock.calls[0];
    expect((data as { canon_locked_at: string | null }).canon_locked_at).toBeNull();
  });
});

describe('deleteFact edit-row diff', () => {
  it('carries the original fact text — not the tombstone placeholder', async () => {
    // The tombstone lands in local state before the edit row is written,
    // so the text has to be captured BEFORE that set — otherwise every
    // delete's diff reads 'deleted: (text unavailable)' and the audit
    // log stops answering "what did that delete actually remove?".
    useStoryStore.setState({
      projectId: 'p1',
      facts: [factRow('f1', 'Sara wore the blue coat')],
      sections: { continuity: continuitySection(3, []) as never },
    });
    listFacts.mockResolvedValue({
      items: [
        {
          seq: 1,
          id: 'f1',
          created_at: 'x',
          data: { id: 'f1', deleted_at: '2026-08-10T12:00:00Z' },
        },
      ],
      next_after_seq: null,
      has_more: false,
    });

    await useStoryStore.getState().deleteFact('f1');

    const edit = appendEdit.mock.calls[0][1] as { diff: string };
    expect(edit.diff).toBe('deleted: Sara wore the blue coat');
    expect(edit.diff).not.toContain('text unavailable');
  });
});

describe('loadAllFactsById fetch-seq ordering', () => {
  it('does not stamp a stale index over a fresh load()', async () => {
    // The specific hazard the review caught: loadAllFactsById's paging
    // beats load()'s facts fetch, then lands its old map on top and
    // hides freshly-appended facts as '(deleted fact)' in cards.
    useStoryStore.setState({ projectId: 'p1' });

    // A slow first (and only) page for the index.
    let release: (v: unknown) => void = () => {};
    listFacts.mockImplementationOnce(
      () => new Promise((r) => { release = r; })
    );

    const pending = useStoryStore.getState().loadAllFactsById();

    // A load() runs while the index is in flight — its listFacts mock
    // returns the fresh row list and the seq bump invalidates the
    // index paging.
    manifest.mockResolvedValueOnce({
      ...emptyManifest,
      sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
    });
    getSection.mockResolvedValueOnce(metaSection(1));
    listFacts.mockResolvedValueOnce({
      items: [factRow('f1', 'fresh')],
      next_after_seq: null,
      has_more: false,
    });
    await useStoryStore.getState().load('p1');

    // Now the stale index resolves. It must NOT overwrite factIndex.
    release({ items: [], next_after_seq: null, has_more: false });
    const result = await pending;

    expect(result).toBeNull();
    expect(useStoryStore.getState().factIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stale-source flagging (phase 11)
// ---------------------------------------------------------------------------

describe('flagScenesStale / clearSceneStale', () => {
  function sceneRow(id: string, serverTs: number, extra: Record<string, unknown> = {}) {
    return {
      id,
      sequence: 0,
      server_ts: serverTs,
      updated_at: 'x',
      data: {
        id,
        sequence: 0,
        title: 'A scene',
        summary: 's',
        annotations: {
          user_notes: 'keep me',
          author_intent: '',
          flagged_issues: [],
          stale_source: false,
        },
        ...extra,
      },
    };
  }

  it('sets stale_source while PRESERVING the rest of annotations', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    getScene.mockResolvedValue(sceneRow('s1', 5));
    putScene.mockResolvedValue({ ...sceneRow('s1', 6), sequence: 0 });

    const result = await useStoryStore.getState().flagScenesStale(['s1']);

    expect(result).toEqual({ flagged: 1, alreadyFlagged: 0, failed: 0 });
    const [, , data] = putScene.mock.calls[0];
    const annotations = (data as { annotations: Record<string, unknown> }).annotations;
    expect(annotations.stale_source).toBe(true);
    // A full-replace PUT drops whatever the patch didn't spread.
    expect(annotations.user_notes).toBe('keep me');
  });

  it('is a no-op on an already-flagged scene — no PUT, no server_ts churn', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    getScene.mockResolvedValue(
      sceneRow('s1', 5, {
        annotations: {
          user_notes: '',
          author_intent: '',
          flagged_issues: [],
          stale_source: true,
        },
      })
    );

    const result = await useStoryStore.getState().flagScenesStale(['s1']);

    expect(result).toEqual({ flagged: 0, alreadyFlagged: 1, failed: 0 });
    expect(putScene).not.toHaveBeenCalled();
  });

  it('keeps going when one scene fails — flagging is advisory, not atomic', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    getScene.mockImplementation(async (_p: string, id: string) => {
      if (id === 's2') throw new Error('boom');
      return sceneRow(id, 5);
    });
    putScene.mockResolvedValue(sceneRow('s1', 6));

    const result = await useStoryStore.getState().flagScenesStale(['s1', 's2', 's3']);

    expect(result.flagged).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('flags while a build is parked in error — the state divergence creates', async () => {
    // patchScene's default gate treats running|paused|error as
    // build-active, and divergence itself parks the checkpoint in error.
    // Without the carve-out, "Mark affected scenes" would refuse in
    // exactly the situation that produces the button.
    useStoryStore.setState({ projectId: 'p1' });
    ingestCheckpoint.current = { status: 'error' };
    getScene.mockResolvedValue(sceneRow('s1', 5));
    putScene.mockResolvedValue(sceneRow('s1', 6));

    const result = await useStoryStore.getState().flagScenesStale(['s1']);

    expect(result.flagged).toBe(1);
    expect(putScene).toHaveBeenCalledTimes(1);
  });

  it('refuses to flag while canon is locked', async () => {
    useStoryStore.setState({
      projectId: 'p1',
      sections: {
        meta: metaSection(3, { canon_locked_at: '2026-08-10T12:00:00Z' }) as never,
      },
    });
    getScene.mockResolvedValue(sceneRow('s1', 5));

    const result = await useStoryStore.getState().flagScenesStale(['s1']);

    expect(result).toEqual({ flagged: 0, alreadyFlagged: 0, failed: 1 });
    expect(putScene).not.toHaveBeenCalled();
  });

  it('refuses clearSceneStale while canon is locked', async () => {
    // The row's Dismiss button gates on this too — an optimistic hide
    // over a still-true stale_source is the one state to avoid.
    useStoryStore.setState({
      projectId: 'p1',
      sections: {
        meta: metaSection(3, { canon_locked_at: '2026-08-10T12:00:00Z' }) as never,
      },
    });
    getScene.mockResolvedValue(sceneRow('s1', 5));

    const ok = await useStoryStore.getState().clearSceneStale('s1');

    expect(ok).toBe(false);
    expect(putScene).not.toHaveBeenCalled();
  });

  it('writes no edit row for a machine-driven flag, but does for a user dismissal', async () => {
    useStoryStore.setState({ projectId: 'p1' });
    getScene.mockResolvedValue(sceneRow('s1', 5));
    putScene.mockResolvedValue(sceneRow('s1', 6));

    await useStoryStore.getState().flagScenesStale(['s1']);
    // `recordEdit` hardcodes actor: 'user'; a derived flag is not
    // authorship, so flagging opts out.
    expect(appendEdit).not.toHaveBeenCalled();

    getScene.mockResolvedValue(
      sceneRow('s1', 6, {
        annotations: {
          user_notes: '',
          author_intent: '',
          flagged_issues: [],
          stale_source: true,
        },
      })
    );
    putScene.mockResolvedValue(sceneRow('s1', 7));
    await useStoryStore.getState().clearSceneStale('s1');
    // Dismissing IS a user judgement, so it keeps its audit row.
    expect(appendEdit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Beat map (step 3 phase 2 — reading the annotate pass's output)
// ---------------------------------------------------------------------------

describe('loadBeatMap', () => {
  const MREF = (id: string) => ({
    msg_id: id,
    swipe_idx: 0,
    fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
  });

  function fullRow(
    id: string,
    sequence: number,
    over: Record<string, unknown> = {}
  ) {
    return {
      id,
      sequence,
      server_ts: 5,
      updated_at: 'x',
      data: {
        id,
        sequence,
        title: `Scene ${sequence}`,
        summary: '',
        detailed_summary: '',
        setting: { location_ref: null, time_ref: null, atmosphere: '' },
        participants: [],
        pov_character: null,
        function: null,
        source: {
          message_range: { start: MREF('m0'), end: MREF('m3') },
          total_messages: 4,
          swipe_resolutions: [],
          excluded_segments: [],
        },
        continuity_facts_established: [],
        transformations: null,
        annotations: {
          user_notes: '',
          author_intent: '',
          flagged_issues: [],
          stale_source: false,
        },
        ...over,
      },
    };
  }

  const ANNOTATED = {
    function: { beat: 'crisis', tension: 9, mood: 'tight', stakes: 'the door' },
    transformations: {
      compression_recommendation: 'compress',
      compression_ratio_target: 0.4,
      pacing_notes: 'move',
      dialogue_density: 0.6,
    },
  };

  it('flattens annotated and unannotated scenes', async () => {
    listScenesFull.mockResolvedValue({
      items: [fullRow('s1', 0, ANNOTATED), fullRow('s2', 1)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    await useStoryStore.getState().loadBeatMap();

    const map = useStoryStore.getState().beatMap!;
    expect(map).toHaveLength(2);
    expect(map[0]).toMatchObject({
      id: 's1',
      beat: 'crisis',
      tension: 9,
      compression: 'compress',
      compressionRatio: 0.4,
      stale: false,
    });
    // An unannotated scene is a null beat, NOT an omitted row — the panel
    // says "N of M annotated", which needs the unannotated ones present.
    expect(map[1]).toMatchObject({ id: 's2', beat: null, tension: null });
    expect(useStoryStore.getState().beatMapLoading).toBe(false);
  });

  it('surfaces the walk’s stale marker', async () => {
    listScenesFull.mockResolvedValue({
      items: [
        fullRow('s1', 0, {
          ...ANNOTATED,
          annotations: {
            user_notes: '',
            author_intent: '',
            flagged_issues: ['annotation_stale'],
            stale_source: false,
          },
        }),
      ],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    await useStoryStore.getState().loadBeatMap();
    expect(useStoryStore.getState().beatMap![0].stale).toBe(true);
  });

  it('pages on has_more, NOT on page length', async () => {
    // The server can end a page early on its own byte budget, so a short
    // page is not a last page. Treating length as the signal would drop
    // every scene past the first cut.
    listScenesFull
      .mockResolvedValueOnce({
        items: [fullRow('s1', 0, ANNOTATED)],
        next_after_sequence: 0,
        next_after_id: 's1',
        has_more: true,
        truncated_by_bytes: true,
      })
      .mockResolvedValueOnce({
        items: [fullRow('s2', 1, ANNOTATED)],
        next_after_sequence: null,
        next_after_id: null,
        has_more: false,
        truncated_by_bytes: false,
      });
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    await useStoryStore.getState().loadBeatMap();

    expect(listScenesFull).toHaveBeenCalledTimes(2);
    expect(useStoryStore.getState().beatMap).toHaveLength(2);
    // Resumes from the last row INCLUDED.
    expect(listScenesFull.mock.calls[1][1]).toMatchObject({
      afterSequence: 0,
      afterId: 's1',
    });
  });

  it('is cached — a second call does not re-fetch', async () => {
    listScenesFull.mockResolvedValue({
      items: [fullRow('s1', 0, ANNOTATED)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    await useStoryStore.getState().loadBeatMap();
    await useStoryStore.getState().loadBeatMap();
    expect(listScenesFull).toHaveBeenCalledTimes(1);
  });

  it('a reload drops the cache, so a re-annotate is visible', async () => {
    // The whole reason the beat map needs no invalidation hook of its
    // own: runAnnotate ends with load(). If that stopped dropping the
    // cache, a user would annotate, watch it succeed, and still see the
    // pre-annotate beats.
    listScenesFull.mockResolvedValue({
      items: [fullRow('s1', 0)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    useStoryStore.setState({ projectId: 'p1', beatMap: null });
    await useStoryStore.getState().loadBeatMap();
    expect(useStoryStore.getState().beatMap![0].beat).toBeNull();

    await useStoryStore.getState().load('p1');
    expect(useStoryStore.getState().beatMap).toBeNull();

    listScenesFull.mockResolvedValue({
      items: [fullRow('s1', 0, ANNOTATED)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    await useStoryStore.getState().loadBeatMap();
    expect(useStoryStore.getState().beatMap![0].beat).toBe('crisis');
  });

  it('a run that outlives the visit does not land (epoch guard)', async () => {
    let release: (v: unknown) => void = () => {};
    listScenesFull.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    const inFlight = useStoryStore.getState().loadBeatMap();
    useStoryStore.getState().clear();
    release({
      items: [fullRow('s1', 0, ANNOTATED)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    await inFlight;

    expect(useStoryStore.getState().beatMap).toBeNull();
  });

  it('a run that a reload superseded does not land (ordering guard)', async () => {
    // The case the EPOCH guard cannot catch: `load()` stays inside the
    // same visit, so the epoch is unchanged. An annotate run ends with a
    // load(), so this is exactly the live sequence — open the beat map,
    // annotate, and the pre-annotate paging run resolves late. Without the
    // seq guard it stamps its stale, unannotated rows over the fresh ones
    // and the user sees "0 of N annotated" after a successful run.
    let release: (v: unknown) => void = () => {};
    listScenesFull.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    useStoryStore.setState({ projectId: 'p1', beatMap: null });

    const stale = useStoryStore.getState().loadBeatMap();
    await useStoryStore.getState().load('p1');

    // A fresh run lands the annotated rows.
    listScenesFull.mockResolvedValue({
      items: [fullRow('s1', 0, ANNOTATED)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    await useStoryStore.getState().loadBeatMap();
    expect(useStoryStore.getState().beatMap![0].beat).toBe('crisis');

    // Now the pre-reload run finally answers, with unannotated rows.
    release({
      items: [fullRow('s1', 0)],
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    });
    await stale;

    expect(useStoryStore.getState().beatMap![0].beat).toBe('crisis');
  });
});
