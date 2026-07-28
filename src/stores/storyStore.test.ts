import { describe, it, expect, vi, beforeEach } from 'vitest';

const manifest = vi.fn();
const getSection = vi.fn();
const putSection = vi.fn();
const listScenes = vi.fn();
const listFacts = vi.fn();
const reset = vi.fn();

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

vi.mock('../api/client', () => ({
  storyApi: {
    manifest: (...a: unknown[]) => manifest(...a),
    getSection: (...a: unknown[]) => getSection(...a),
    putSection: (...a: unknown[]) => putSection(...a),
    listScenes: (...a: unknown[]) => listScenes(...a),
    listFacts: (...a: unknown[]) => listFacts(...a),
    listEdits: vi.fn(),
    reset: (...a: unknown[]) => reset(...a),
  },
  StoryConflictError: FakeConflict,
}));

vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));

const { useStoryStore, hasBible } = await import('./storyStore');

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

    await useStoryStore.getState().designateSourceChat(CHAT);

    expect(useStoryStore.getState().projectId).toBe('p2');
    expect(manifest).not.toHaveBeenCalled();
  });

  it('resetBible does not re-point a switched-away store either', async () => {
    reset.mockImplementation(async () => {
      useStoryStore.setState({ projectId: 'p2' });
    });
    useStoryStore.setState({ projectId: 'p1' });

    await useStoryStore.getState().resetBible();

    expect(useStoryStore.getState().projectId).toBe('p2');
    expect(manifest).not.toHaveBeenCalled();
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
