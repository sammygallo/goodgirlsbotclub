import { describe, it, expect, vi, beforeEach } from 'vitest';

const manifest = vi.fn();
const getSection = vi.fn();
const putSection = vi.fn();
const listScenes = vi.fn();
const listFacts = vi.fn();
const reset = vi.fn();
const listArchives = vi.fn();
const restoreArchiveApi = vi.fn();

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
    listFacts: (...a: unknown[]) => listFacts(...a),
    listEdits: vi.fn(),
    reset: (...a: unknown[]) => reset(...a),
    listArchives: (...a: unknown[]) => listArchives(...a),
    restoreArchive: (...a: unknown[]) => restoreArchiveApi(...a),
  },
  StoryConflictError: FakeConflict,
  StoryRestoreConflictError: FakeRestoreConflict,
}));

vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));

const { useStoryStore, hasBible } = await import('./storyStore');
const { showToastGlobal } = await import('../components/ui/Toast');

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
  listArchives.mockResolvedValue({
    archives: [],
    next_after_created_at: null,
    next_after_id: null,
    has_more: false,
  });
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
    expect(data.schema_version).toBe('1.0');
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
