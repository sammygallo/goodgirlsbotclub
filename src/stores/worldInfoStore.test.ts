import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// worldInfoStore pulls serverSettings (and through it the api layer) at
// module load — neutralize before importing, per the storyStore.test.ts
// pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
}));

const {
  useWorldInfoStore,
  scanMessagesForEntries,
  bookToStFormat,
  bookFromStFormat,
  entryFromStFormat,
  bookToCharacterBookV2,
  bookFromCharacterBookV2,
  auditBookHealth,
  DEFAULT_ENTRY,
} = await import('./worldInfoStore');

import type {
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoScanOptions,
  WorldInfoScanReport,
} from './worldInfoStore';

let idCounter = 0;
function mkEntry(over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  idCounter += 1;
  return {
    ...DEFAULT_ENTRY,
    id: `e${idCounter}`,
    content: 'lore content',
    keys: [],
    keysSecondary: [],
    relatedIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkBook(
  entries: WorldInfoEntry[],
  over: Partial<WorldInfoBook> = {}
): WorldInfoBook {
  idCounter += 1;
  return {
    id: `b${idCounter}`,
    name: 'Test Book',
    entries,
    ownerCharacterAvatar: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function opts(over: Partial<WorldInfoScanOptions> = {}): WorldInfoScanOptions {
  return {
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 0,
    profile: 'generic',
    ...over,
  };
}

function emptyReport(): WorldInfoScanReport {
  return {
    dropped: [],
    pinnedTokens: 0,
    totalTokens: 0,
    budget: 0,
    pinnedOverBudget: false,
  };
}

const msgs = (...contents: string[]) => contents.map((content) => ({ content }));

function scan(
  book: WorldInfoBook,
  messages: { content: string; isSystem?: boolean }[],
  options: WorldInfoScanOptions,
  outActivatedIds?: Set<string>,
  outScanReport?: WorldInfoScanReport
) {
  return scanMessagesForEntries(
    [book],
    [book.id],
    messages,
    options,
    outActivatedIds,
    outScanReport
  );
}

const resultIds = (r: { entry: WorldInfoEntry }[]) => r.map((m) => m.entry.id);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanMessagesForEntries — activation basics', () => {
  it('fires on a primary key match and stays quiet otherwise', () => {
    const hit = mkEntry({ keys: ['dragon'] });
    const miss = mkEntry({ keys: ['kraken'] });
    const result = scan(mkBook([hit, miss]), msgs('a dragon appears'), opts());
    expect(resultIds(result)).toEqual([hit.id]);
  });

  it('returns matches sorted by order', () => {
    const late = mkEntry({ keys: ['dragon'], order: 300 });
    const early = mkEntry({ keys: ['dragon'], order: 10 });
    const result = scan(mkBook([late, early]), msgs('dragon'), opts());
    expect(resultIds(result)).toEqual([early.id, late.id]);
  });
});

describe('scanMessagesForEntries — critical entries', () => {
  it('never evicts critical entries under budget pressure and reports drops', () => {
    const big = 'x'.repeat(400); // ~100 tokens generic
    const critical = mkEntry({ keys: ['dragon'], critical: true, order: 999, content: big });
    const cheapSurvivor = mkEntry({ keys: ['dragon'], order: 1, content: 'tiny' });
    const evicted = mkEntry({ keys: ['dragon'], order: 500, content: big });
    const report = emptyReport();
    const result = scan(
      mkBook([critical, cheapSurvivor, evicted]),
      msgs('dragon'),
      opts({ tokenBudget: 120 }),
      undefined,
      report
    );
    expect(resultIds(result)).toContain(critical.id);
    expect(resultIds(result)).toContain(cheapSurvivor.id);
    expect(resultIds(result)).not.toContain(evicted.id);
    expect(report.dropped.map((m) => m.entry.id)).toEqual([evicted.id]);
    expect(report.pinnedTokens).toBeGreaterThan(0);
    expect(report.budget).toBe(120);
  });

  it('flags pinnedOverBudget when constant+critical alone exceed the budget', () => {
    const big = 'x'.repeat(400);
    const critical = mkEntry({ keys: ['dragon'], critical: true, content: big });
    const constant = mkEntry({ constant: true, content: big });
    const report = emptyReport();
    const result = scan(
      mkBook([critical, constant]),
      msgs('dragon'),
      opts({ tokenBudget: 50 }),
      undefined,
      report
    );
    // Both still injected — pinned entries are never dropped.
    expect(resultIds(result)).toEqual(
      expect.arrayContaining([critical.id, constant.id])
    );
    expect(report.pinnedOverBudget).toBe(true);
    expect(report.dropped).toEqual([]);
  });

  it('cannot be triggered by recursion, only by real chat text', () => {
    const source = mkEntry({ constant: true, content: 'the shattered crystal throne' });
    const criticalTarget = mkEntry({ keys: ['crystal'], critical: true });
    const normalTarget = mkEntry({ keys: ['crystal'] });
    const result = scan(
      mkBook([source, criticalTarget, normalTarget]),
      msgs('hello there'),
      opts()
    );
    // The normal entry cascades off the constant's content; the critical one must not.
    expect(resultIds(result)).toContain(normalTarget.id);
    expect(resultIds(result)).not.toContain(criticalTarget.id);

    // But real chat text triggers the critical entry as usual.
    const direct = scan(
      mkBook([source, criticalTarget]),
      msgs('she touches the crystal'),
      opts()
    );
    expect(resultIds(direct)).toContain(criticalTarget.id);
  });
});

describe('scanMessagesForEntries — deterministic groups', () => {
  it('picks the lowest-order entry when group weights are equal, every time', () => {
    const a = mkEntry({ keys: ['dragon'], group: 'season', order: 10 });
    const b = mkEntry({ keys: ['dragon'], group: 'season', order: 5 });
    const c = mkEntry({ keys: ['dragon'], group: 'season', order: 20 });
    const book = mkBook([a, b, c]);
    for (let i = 0; i < 20; i++) {
      const result = scan(book, msgs('dragon'), opts());
      expect(resultIds(result)).toEqual([b.id]);
    }
  });

  it('breaks order ties by matched-key count, then alphabetically', () => {
    const oneKey = mkEntry({ keys: ['dragon'], group: 'g', order: 10, comment: 'aaa' });
    const twoKeys = mkEntry({ keys: ['dragon', 'cave'], group: 'g', order: 10, comment: 'zzz' });
    const result = scan(mkBook([oneKey, twoKeys]), msgs('a dragon in a cave'), opts());
    expect(resultIds(result)).toEqual([twoKeys.id]);

    const alphaA = mkEntry({ keys: ['dragon'], group: 'g2', order: 10, comment: 'alpha' });
    const alphaB = mkEntry({ keys: ['dragon'], group: 'g2', order: 10, comment: 'beta' });
    const tie = scan(mkBook([alphaB, alphaA]), msgs('dragon'), opts());
    expect(resultIds(tie)).toEqual([alphaA.id]);
  });

  it('still honors groupOverride ahead of priority', () => {
    const strong = mkEntry({ keys: ['dragon'], group: 'g', order: 1 });
    const override = mkEntry({ keys: ['dragon'], group: 'g', order: 999, groupOverride: true });
    const result = scan(mkBook([strong, override]), msgs('dragon'), opts());
    expect(resultIds(result)).toEqual([override.id]);
  });

  it('keeps the weighted-random draw when weights differ', () => {
    const light = mkEntry({ keys: ['dragon'], group: 'g', order: 1, groupWeight: 10 });
    const heavy = mkEntry({ keys: ['dragon'], group: 'g', order: 999, groupWeight: 90 });
    const book = mkBook([light, heavy]);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const result = scan(book, msgs('dragon'), opts());
    expect(spy).toHaveBeenCalled();
    // roll = 0.99 * 100 lands past light(10) into heavy(90).
    expect(resultIds(result)).toEqual([heavy.id]);

    spy.mockReturnValue(0.01);
    const other = scan(book, msgs('dragon'), opts());
    expect(resultIds(other)).toEqual([light.id]);
  });
});

describe('scanMessagesForEntries — related entries', () => {
  it('co-fires related entries that would never match on their own', () => {
    const target = mkEntry({ keys: ['never-said'] });
    const source = mkEntry({ keys: ['dragon'], relatedIds: [target.id] });
    const activated = new Set<string>();
    const result = scan(
      mkBook([source, target]),
      msgs('dragon'),
      opts(),
      activated
    );
    expect(resultIds(result)).toEqual(
      expect.arrayContaining([source.id, target.id])
    );
    // Pull-ins count as fresh activations (their timers start).
    expect(activated.has(target.id)).toBe(true);
  });

  it('follows chains transitively and survives cycles', () => {
    const c = mkEntry({ keys: ['no-c'] });
    const b = mkEntry({ keys: ['no-b'], relatedIds: [c.id] });
    const a = mkEntry({ keys: ['dragon'], relatedIds: [b.id] });
    // Close the cycle: c points back at a.
    c.relatedIds = [a.id];
    const result = scan(mkBook([a, b, c]), msgs('dragon'), opts());
    expect(resultIds(result).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('ignores dangling related ids', () => {
    const a = mkEntry({ keys: ['dragon'], relatedIds: ['ghost-id'] });
    const result = scan(mkBook([a]), msgs('dragon'), opts());
    expect(resultIds(result)).toEqual([a.id]);
  });

  it('respects the pulled-in entry cooldown', () => {
    const target = mkEntry({ keys: ['no'], cooldown: 5 });
    const source = mkEntry({ keys: ['dragon'], relatedIds: [target.id] });
    const result = scan(
      mkBook([source, target]),
      msgs('dragon'),
      opts({ currentTurn: 3, wiTimers: { [target.id]: 2 } })
    );
    expect(resultIds(result)).toEqual([source.id]);
  });

  it('pulls in an entry even when it lost its group competition', () => {
    const winner = mkEntry({ keys: ['dragon'], group: 'g', order: 1 });
    const loser = mkEntry({ keys: ['dragon'], group: 'g', order: 99 });
    const linker = mkEntry({ keys: ['dragon'], relatedIds: [loser.id] });
    const result = scan(
      mkBook([winner, loser, linker]),
      msgs('dragon'),
      opts()
    );
    expect(resultIds(result)).toEqual(
      expect.arrayContaining([winner.id, loser.id, linker.id])
    );
  });
});

describe('scanMessagesForEntries — timed-effect regressions', () => {
  it('keeps sticky carry-overs injected without keyword matches', () => {
    const sticky = mkEntry({ keys: ['dragon'], sticky: 3 });
    const result = scan(
      mkBook([sticky]),
      msgs('nothing relevant'),
      opts({ currentTurn: 2, wiTimers: { [sticky.id]: 1 } })
    );
    expect(resultIds(result)).toEqual([sticky.id]);
  });
});

describe('ST-format round trip', () => {
  it('preserves critical/category and remaps relatedIds onto fresh ids', () => {
    const target = mkEntry({ keys: ['b'], comment: 'target' });
    const source = mkEntry({
      keys: ['a'],
      comment: 'source',
      critical: true,
      category: 'continuity_note',
      relatedIds: [target.id, 'dangling-id'],
    });
    const book = mkBook([source, target]);
    const imported = bookFromStFormat('roundtrip', bookToStFormat(book));

    const newSource = imported.entries.find((e) => e.comment === 'source');
    const newTarget = imported.entries.find((e) => e.comment === 'target');
    expect(newSource).toBeDefined();
    expect(newTarget).toBeDefined();
    expect(newSource!.critical).toBe(true);
    expect(newSource!.category).toBe('continuity_note');
    // Fresh ids, remapped link, dangling id dropped.
    expect(newSource!.id).not.toBe(source.id);
    expect(newSource!.relatedIds).toEqual([newTarget!.id]);
  });

  it('defaults the new fields when importing a foreign ST book', () => {
    const entry = entryFromStFormat({ key: ['x'], content: 'y' });
    expect(entry.critical).toBe(false);
    expect(entry.category).toBe('');
    expect(entry.relatedIds).toEqual([]);
  });
});

describe('Character Book V2 round trip', () => {
  it('preserves critical/category and remaps relatedIds through extensions', () => {
    const target = mkEntry({ keys: ['b'], comment: 'target' });
    const source = mkEntry({
      keys: ['a'],
      comment: 'source',
      critical: true,
      category: 'world_rule',
      relatedIds: [target.id],
    });
    const book = mkBook([source, target]);
    const imported = bookFromCharacterBookV2(
      bookToCharacterBookV2(book),
      'fallback',
      null
    );
    const newSource = imported.entries.find((e) => e.comment === 'source');
    const newTarget = imported.entries.find((e) => e.comment === 'target');
    expect(newSource!.critical).toBe(true);
    expect(newSource!.category).toBe('world_rule');
    expect(newSource!.relatedIds).toEqual([newTarget!.id]);
  });
});

describe('store actions', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
  });

  it('duplicateBook remaps relatedIds onto the copied entries', () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBook('Originals');
    const target = store.createEntry(book.id, { comment: 'target' })!;
    store.createEntry(book.id, { comment: 'source', relatedIds: [target.id] });
    const copy = useWorldInfoStore.getState().duplicateBook(book.id)!;
    const copiedSource = copy.entries.find((e) => e.comment === 'source')!;
    const copiedTarget = copy.entries.find((e) => e.comment === 'target')!;
    expect(copiedTarget.id).not.toBe(target.id);
    expect(copiedSource.relatedIds).toEqual([copiedTarget.id]);
  });

  it('deleteEntry strips related links pointing at the deleted entry', () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBook('Cleanup');
    const target = store.createEntry(book.id, { comment: 'target' })!;
    const source = store.createEntry(book.id, {
      comment: 'source',
      relatedIds: [target.id],
    })!;
    useWorldInfoStore.getState().deleteEntry(book.id, target.id);
    const after = useWorldInfoStore
      .getState()
      .books.find((b) => b.id === book.id)!;
    expect(after.entries.map((e) => e.id)).toEqual([source.id]);
    expect(after.entries[0].relatedIds).toEqual([]);
  });
});

describe('auditBookHealth', () => {
  it('counts pinned lore, shares, and dangling links over enabled entries', () => {
    const constant = mkEntry({ constant: true, content: 'x'.repeat(40) });
    const critical = mkEntry({
      keys: ['k'],
      critical: true,
      content: 'x'.repeat(40),
    });
    const normal = mkEntry({ keys: ['k'], relatedIds: ['gone'] });
    const disabled = mkEntry({ keys: ['k'], enabled: false, constant: true });
    const health = auditBookHealth(
      mkBook([constant, critical, normal, disabled]),
      'generic'
    );
    expect(health.entryCount).toBe(3); // disabled excluded
    expect(health.constantCount).toBe(1);
    expect(health.criticalCount).toBe(1);
    expect(health.pinnedTokens).toBeGreaterThan(0);
    expect(health.constantShare).toBeCloseTo(1 / 3);
    expect(health.danglingRelated).toEqual([
      { entryId: normal.id, missingIds: ['gone'] },
    ]);
  });

  it('flags related links pointing at disabled or empty entries', () => {
    const disabledTarget = mkEntry({ keys: ['k'], enabled: false });
    const emptyTarget = mkEntry({ keys: ['k'], content: '   ' });
    const liveTarget = mkEntry({ keys: ['k'] });
    const source = mkEntry({
      keys: ['k'],
      relatedIds: [disabledTarget.id, emptyTarget.id, liveTarget.id],
    });
    const health = auditBookHealth(
      mkBook([source, disabledTarget, emptyTarget, liveTarget]),
      'generic'
    );
    expect(health.danglingRelated).toEqual([]);
    expect(health.inactiveRelated).toEqual([
      {
        entryId: source.id,
        inactiveIds: [disabledTarget.id, emptyTarget.id],
      },
    ]);
  });
});

describe('fetchPrefs server-sync normalization', () => {
  it('backfills new fields on books written by a pre-update client', async () => {
    const serverSettings = await import('../utils/serverSettings');
    const oldShapeEntry = {
      id: 'legacy1',
      keys: ['dragon'],
      content: 'legacy lore',
      comment: '',
      enabled: true,
      constant: false,
      caseSensitive: false,
      position: 'before_char',
      depth: 4,
      order: 100,
      keysSecondary: [],
      selective: false,
      selectiveLogic: 'AND_ANY',
      scanDepth: null,
      probability: 100,
      useProbability: false,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      preventRecursion: false,
      excludeRecursion: false,
      // No sticky/cooldown/delay/critical/category/relatedIds — the shape an
      // older client synced to the server.
      createdAt: 0,
      updatedAt: 0,
    };
    vi.mocked(serverSettings.getSettingsBlob).mockResolvedValueOnce({
      stm_worldinfo: {
        books: [
          {
            id: 'legacybook',
            name: 'Legacy',
            entries: [oldShapeEntry],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        activeBookIds: ['legacybook'],
        chatLinkedBookIds: {},
        scanDepth: 4,
        maxRecursionSteps: 3,
        tokenBudget: 1024,
        _ts: 123,
      },
    });
    useWorldInfoStore.getState().resetUser();
    await useWorldInfoStore.getState().fetchPrefs();
    const entry = useWorldInfoStore.getState().books[0].entries[0];
    expect(entry.relatedIds).toEqual([]);
    expect(entry.critical).toBe(false);
    expect(entry.category).toBe('');
    expect(entry.sticky).toBe(0);
    // And the scanner must not crash on the normalized book.
    const result = scanMessagesForEntries(
      useWorldInfoStore.getState().books,
      ['legacybook'],
      msgs('a dragon appears'),
      opts()
    );
    expect(resultIds(result)).toEqual(['legacy1']);
  });
});
