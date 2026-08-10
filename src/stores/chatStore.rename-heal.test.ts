import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// chatStore pulls serverSettings (and through it the api layer) at module
// load — neutralize before importing, per the worldInfoStore.test.ts pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

// chatStore -> authStore -> lovenseStore -> chatStore is a require cycle, and
// lovenseStore calls useChatStore.subscribe() at module scope. Importing
// chatStore first (as this test does) leaves that binding undefined, so stub
// the leaf out of the cycle.
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));

const renameChatApi = vi.fn();
const getChats = vi.fn();
const projectsList = vi.fn();
const projectsGet = vi.fn();
const projectsUpdate = vi.fn();
const storyManifest = vi.fn();
const storyGetSection = vi.fn();
const storyPutSection = vi.fn();
const storyAppendEdit = vi.fn();

// Spread the REAL module: the heal does `instanceof ProjectConflictError` /
// `StoryConflictError` on lazily-imported classes, and half of chatStore's
// static import graph reaches into this module at load time.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      renameChat: (...a: unknown[]) => renameChatApi(...a),
      getChats: (...a: unknown[]) => getChats(...a),
    },
    projectsApi: {
      ...actual.projectsApi,
      list: (...a: unknown[]) => projectsList(...a),
      get: (...a: unknown[]) => projectsGet(...a),
      update: (...a: unknown[]) => projectsUpdate(...a),
    },
    storyApi: {
      ...actual.storyApi,
      manifest: (...a: unknown[]) => storyManifest(...a),
      getSection: (...a: unknown[]) => storyGetSection(...a),
      putSection: (...a: unknown[]) => storyPutSection(...a),
      appendEdit: (...a: unknown[]) => storyAppendEdit(...a),
    },
  };
});

const { useChatStore } = await import('./chatStore');
const { useProjectStore } = await import('./projectStore');
const { showToastGlobal } = await import('../components/ui/Toast');
const { ProjectConflictError, StoryConflictError } = await import('../api/client');

import type { Project, ProjectChatRef } from '../api/client';

const AVATAR = 'Ivy.png';
const OLD = 'Ivy - 2026-08-01';
/** What the server stored. The raw input below differs on purpose. */
const NEW = 'The Long Way Home';
const RAW_INPUT = 'The Long Way Home!!';

const oldRef: ProjectChatRef = { character_avatar: AVATAR, file_name: OLD };
const newRef: ProjectChatRef = { character_avatar: AVATAR, file_name: NEW };
const otherRef: ProjectChatRef = { character_avatar: AVATAR, file_name: 'Ivy - side quest' };
const remoteRef: ProjectChatRef = { character_avatar: 'Rook.png', file_name: 'Rook - 1' };

// ---- stateful fake backend -------------------------------------------------

let projects: Record<string, Project>;
let bibles: Record<string, { data: Record<string, unknown>; server_ts: number }>;
let appendedEdits: { projectId: string; edit: Record<string, unknown> }[];

function project(id: string, chats: ProjectChatRef[], serverTs = 10): Project {
  return {
    id,
    name: `Work ${id}`,
    description: '',
    deliverable_type: 'freeform',
    status: 'active',
    characters: [],
    chats,
    story_state: {},
    server_ts: serverTs,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const SNAPSHOT = {
  name: OLD,
  excerpt: 'She was already at the door when he woke.',
  sha: 'a1b2c3d4',
  hash_alg: 'sha256',
};
const CAPTURED_AT = '2026-08-01T09:30:00.000Z';
const WATERMARK = { message_count: 42, last_msg: { id: 'm-42', role: 'assistant' } };

function metaData(ref: ProjectChatRef = oldRef, extra: Record<string, unknown> = {}) {
  return {
    schema_version: '1.0',
    bible_id: 'bible-1',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:30:00.000Z',
    source: {
      platform: 'ggbc',
      chat: { kind: 'chat', ref, snapshot: SNAPSHOT, captured_at: CAPTURED_AT },
      characters: [{ kind: 'character', ref: AVATAR, captured_at: CAPTURED_AT }],
    },
    title: 'Our Manga',
    ingest_watermark: WATERMARK,
    canon_locked_at: null,
    ...extra,
  };
}

function section(projectId: string) {
  const bible = bibles[projectId];
  return {
    section: 'meta',
    data: structuredClone(bible.data),
    server_ts: bible.server_ts,
    updated_at: '2026-08-01T09:30:00.000Z',
  };
}

/** The heal's own view of the written bible (what the last PUT landed). */
function writtenMeta(projectId: string) {
  return bibles[projectId].data as ReturnType<typeof metaData>;
}

beforeEach(() => {
  vi.clearAllMocks();
  projects = {};
  bibles = {};
  appendedEdits = [];

  useChatStore.setState({ error: null, currentChatFile: null, chatFiles: [] });
  useProjectStore.setState({ selected: null, items: [] });

  renameChatApi.mockResolvedValue(NEW);
  getChats.mockResolvedValue([]);

  projectsList.mockImplementation(async () =>
    Object.values(projects).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      deliverable_type: p.deliverable_type,
      status: p.status,
      character_count: p.characters.length,
      chat_count: p.chats.length,
      updated_at: p.updated_at,
    }))
  );
  projectsGet.mockImplementation(async (id: string) => structuredClone(projects[id]));
  projectsUpdate.mockImplementation(
    async (id: string, patch: Record<string, unknown> & { base_ts?: number }) => {
      const current = projects[id];
      if (patch.base_ts !== current.server_ts) {
        throw new ProjectConflictError(current.server_ts, structuredClone(current));
      }
      const fields = { ...patch };
      delete fields.base_ts;
      projects[id] = { ...current, ...fields, server_ts: current.server_ts + 1 } as Project;
      return structuredClone(projects[id]);
    }
  );

  storyManifest.mockImplementation(async (projectId: string) => ({
    project_id: projectId,
    sections: bibles[projectId]
      ? [{ section: 'meta', server_ts: bibles[projectId].server_ts, bytes: 512, updated_at: 'x' }]
      : [],
    scene_count: 0,
    fact_count: 0,
    edit_count: appendedEdits.length,
  }));
  storyGetSection.mockImplementation(async (projectId: string) => {
    if (!bibles[projectId]) throw new Error('section not written yet');
    return section(projectId);
  });
  storyPutSection.mockImplementation(
    async (projectId: string, _name: string, data: Record<string, unknown>, baseTs: number) => {
      const bible = bibles[projectId];
      if (baseTs !== bible.server_ts) {
        throw new StoryConflictError(bible.server_ts, section(projectId));
      }
      bible.data = data;
      bible.server_ts += 1;
      return { section: 'meta', data, server_ts: bible.server_ts, updated_at: 'x' };
    }
  );
  storyAppendEdit.mockImplementation(async (projectId: string, edit: Record<string, unknown>) => {
    appendedEdits.push({ projectId, edit });
    return { seq: appendedEdits.length, id: edit.id, data: edit, created_at: 'x' };
  });
});

const rename = () => useChatStore.getState().renameChat(AVATAR, OLD, RAW_INPUT);

describe('renameChat healing — project rows', () => {
  it('repoints every Work naming the old file, selected or not', async () => {
    projects.p1 = project('p1', [oldRef, otherRef]);
    projects.p2 = project('p2', [remoteRef]);
    projects.p3 = project('p3', [oldRef]);
    useProjectStore.setState({ selected: structuredClone(projects.p1) });

    await rename();

    // The SERVER-sanitized name lands in the refs, not the raw input.
    expect(projects.p1.chats).toEqual([newRef, otherRef]);
    expect(projects.p3.chats).toEqual([newRef]);
    // A Work that never named this chat is not written at all.
    expect(projects.p2.chats).toEqual([remoteRef]);
    expect(projectsUpdate.mock.calls.map((c) => c[0])).toEqual(['p1', 'p3']);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('refreshes the selected Work and leaves it alone when another Work is patched', async () => {
    projects.p1 = project('p1', [oldRef]);
    projects.p2 = project('p2', [oldRef]);
    useProjectStore.setState({ selected: structuredClone(projects.p2) });

    await rename();

    const selected = useProjectStore.getState().selected;
    expect(selected?.id).toBe('p2');
    expect(selected?.chats).toEqual([newRef]);
    // Patching p1 must not swap the panel onto a Work the user never opened.
    expect(selected?.server_ts).toBe(projects.p2.server_ts);
  });

  it('adopt-retries a project conflict re-derived from the winner', async () => {
    projects.p1 = project('p1', [oldRef]);
    // Another device attaches a chat between our read and our write.
    projectsGet.mockImplementationOnce(async (id: string) => {
      const stale = structuredClone(projects[id]);
      projects[id] = {
        ...projects[id],
        chats: [...projects[id].chats, remoteRef],
        server_ts: projects[id].server_ts + 1,
      };
      return stale;
    });

    await rename();

    expect(projectsUpdate).toHaveBeenCalledTimes(2);
    // Re-derived from the winner: the rename applies AND the other device's
    // attach survives.
    expect(projects.p1.chats).toEqual([newRef, remoteRef]);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('does not re-write when the conflict winner already carries the new name', async () => {
    projects.p1 = project('p1', [oldRef]);
    projectsGet.mockImplementationOnce(async (id: string) => {
      const stale = structuredClone(projects[id]);
      projects[id] = { ...projects[id], chats: [newRef], server_ts: projects[id].server_ts + 1 };
      return stale;
    });

    await rename();

    expect(projectsUpdate).toHaveBeenCalledTimes(1);
    expect(projects.p1.chats).toEqual([newRef]);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

describe('renameChat healing — bible', () => {
  it('moves the pointer while keeping snapshot, captured_at and watermark verbatim', async () => {
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(), server_ts: 7 };
    const before = structuredClone(writtenMeta('p1'));

    await rename();

    const after = writtenMeta('p1');
    expect(after.source.chat.ref).toEqual(newRef);
    // Byte-identical, not merely deep-equal: the snapshot records what was
    // true at capture and a rename does not change that.
    expect(JSON.stringify(after.source.chat.snapshot)).toBe(
      JSON.stringify(before.source.chat.snapshot)
    );
    expect(after.source.chat.captured_at).toBe(CAPTURED_AT);
    // Zeroing the watermark would make the transcript walk re-read an
    // unchanged chat.
    expect(after.ingest_watermark).toEqual(WATERMARK);
    expect(after.source.characters).toEqual(before.source.characters);
    expect(after.title).toBe(before.title);
    expect(after.bible_id).toBe(before.bible_id);
    expect(after.canon_locked_at).toBeNull();
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('appends the §5.6 edit row for the heal', async () => {
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(), server_ts: 7 };

    await rename();

    expect(appendedEdits).toHaveLength(1);
    const { projectId, edit } = appendedEdits[0];
    expect(projectId).toBe('p1');
    expect(edit.actor).toBe('user');
    expect(edit.surface).toBe('bible_direct');
    expect(edit.target).toEqual({ type: 'meta', id: null });
    expect(edit.classification).toBe('cosmetic');
    expect(edit.diff).toBe(`source chat renamed: ${OLD} → ${NEW}`);
    expect(edit.propagated_to_bible).toBe(true);
    expect(edit.propagation_notes).toBe('');
    expect(edit.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(Number.isNaN(Date.parse(String(edit.occurred_at)))).toBe(false);
  });

  it('skips the bible read entirely for a Work that has none', async () => {
    projects.p1 = project('p1', [oldRef]);

    await rename();

    expect(projects.p1.chats).toEqual([newRef]);
    expect(storyGetSection).not.toHaveBeenCalled();
    expect(storyPutSection).not.toHaveBeenCalled();
    expect(appendedEdits).toHaveLength(0);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('leaves a bible pointed at a different chat untouched', async () => {
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(remoteRef), server_ts: 7 };

    await rename();

    expect(projects.p1.chats).toEqual([newRef]);
    expect(storyPutSection).not.toHaveBeenCalled();
    expect(appendedEdits).toHaveLength(0);
  });

  it('adopt-retries a section conflict re-derived from the winner', async () => {
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(), server_ts: 7 };
    // Another device retitles the bible between our read and our write.
    storyGetSection.mockImplementationOnce(async (projectId: string) => {
      const stale = section(projectId);
      bibles[projectId] = {
        data: metaData(oldRef, { title: 'Retitled Elsewhere' }),
        server_ts: bibles[projectId].server_ts + 1,
      };
      return stale;
    });

    await rename();

    expect(storyPutSection).toHaveBeenCalledTimes(2);
    const after = writtenMeta('p1');
    expect(after.source.chat.ref).toEqual(newRef);
    expect(after.title).toBe('Retitled Elsewhere');
    expect(appendedEdits).toHaveLength(1);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('logs no edit when the conflict winner was already relinked', async () => {
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(), server_ts: 7 };
    storyGetSection.mockImplementationOnce(async (projectId: string) => {
      const stale = section(projectId);
      bibles[projectId] = {
        data: metaData(remoteRef),
        server_ts: bibles[projectId].server_ts + 1,
      };
      return stale;
    });

    await rename();

    expect(storyPutSection).toHaveBeenCalledTimes(1);
    expect(writtenMeta('p1').source.chat.ref).toEqual(remoteRef);
    expect(appendedEdits).toHaveLength(0);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});

describe('renameChat healing — failure tolerance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isolates a failing Work, finishes the rest, and toasts once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    projects.p1 = project('p1', [oldRef]);
    projects.p2 = project('p2', [oldRef]);
    projects.p3 = project('p3', [oldRef]);
    bibles.p2 = { data: metaData(), server_ts: 7 };
    projectsUpdate.mockImplementationOnce(async () => {
      throw new Error('network down');
    });

    await rename();

    expect(projects.p1.chats).toEqual([oldRef]);
    // The failure did not stop the loop.
    expect(projects.p2.chats).toEqual([newRef]);
    expect(projects.p3.chats).toEqual([newRef]);
    expect(writtenMeta('p2').source.chat.ref).toEqual(newRef);
    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(showToastGlobal).toHaveBeenCalledWith(
      'Chat renamed — a Work still points at the old name; use Relink in its Story tab',
      'warning'
    );
    expect(warn).toHaveBeenCalled();
  });

  it('toasts once even when several Works fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    projects.p1 = project('p1', [oldRef]);
    projects.p2 = project('p2', [oldRef]);
    projectsUpdate.mockImplementation(async () => {
      throw new Error('network down');
    });

    await rename();

    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('never reports the rename itself as failed when the heal blows up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    projects.p1 = project('p1', [oldRef]);
    projectsList.mockRejectedValue(new Error('projects endpoint gone'));
    useChatStore.setState({ currentChatFile: OLD });

    await rename();

    expect(useChatStore.getState().error).toBeNull();
    // Everything the rename itself owns still happened.
    expect(useChatStore.getState().currentChatFile).toBe(NEW);
    expect(getChats).toHaveBeenCalledWith(AVATAR);
    expect(showToastGlobal).toHaveBeenCalledTimes(1);
  });

  it('surfaces a bible failure without undoing the project patch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    projects.p1 = project('p1', [oldRef]);
    bibles.p1 = { data: metaData(), server_ts: 7 };
    storyAppendEdit.mockRejectedValue(new Error('edit log unavailable'));

    await rename();

    expect(projects.p1.chats).toEqual([newRef]);
    expect(writtenMeta('p1').source.chat.ref).toEqual(newRef);
    expect(useChatStore.getState().error).toBeNull();
    expect(showToastGlobal).toHaveBeenCalledTimes(1);
  });
});
