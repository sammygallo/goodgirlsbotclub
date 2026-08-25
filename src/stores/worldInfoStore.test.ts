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

// Phase 3.2 of the memory-consolidation plan: the pinned-budget toast.
const showToastGlobal = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  showToastGlobal: (...args: unknown[]) => showToastGlobal(...args),
}));

// worldInfoStore's mutators now fire native /lorebooks network calls in the
// background (Phase 3a) — mock the whole CRUD surface so tests never depend
// on a real fetch() (which would reject on Node's inability to resolve a
// bare relative URL anyway, but relying on that accident rather than an
// explicit deterministic mock is exactly the kind of thing that turns into
// a flaky suite later). Everything else in api/client stays real via
// importOriginal, per the autoMemoryStore.test.ts pattern.
const listSharedWorldInfoBooks = vi.fn();
const importLorebooksFromBlob = vi.fn();
const listLorebooks = vi.fn();
const getLorebook = vi.fn();
const createLorebook = vi.fn();
const updateLorebook = vi.fn();
const deleteLorebook = vi.fn();
const createLorebookEntry = vi.fn();
const updateLorebookEntry = vi.fn();
const deleteLorebookEntry = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSharedWorldInfoBooks: (...args: unknown[]) => listSharedWorldInfoBooks(...args),
      importLorebooksFromBlob: (...args: unknown[]) => importLorebooksFromBlob(...args),
      listLorebooks: (...args: unknown[]) => listLorebooks(...args),
      getLorebook: (...args: unknown[]) => getLorebook(...args),
      createLorebook: (...args: unknown[]) => createLorebook(...args),
      updateLorebook: (...args: unknown[]) => updateLorebook(...args),
      deleteLorebook: (...args: unknown[]) => deleteLorebook(...args),
      createLorebookEntry: (...args: unknown[]) => createLorebookEntry(...args),
      updateLorebookEntry: (...args: unknown[]) => updateLorebookEntry(...args),
      deleteLorebookEntry: (...args: unknown[]) => deleteLorebookEntry(...args),
    },
  };
});

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

import {
  setDocumentBookIds,
  resetDocumentBookRegistry,
} from './documentBookRegistry';

import type {
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoScanOptions,
  WorldInfoScanReport,
} from './worldInfoStore';

// Imported as raw text, not as a JSON module, for two reasons: the app
// project does not enable resolveJsonModule (and widening it for one test
// would be the wrong trade), and the shared fixture's whole point is that
// both repos hold the same BYTES — see tools/e4s0LockstepFixture.test.ts,
// which hashes the same file and is what actually pins them.
import lockstepVectorsRaw from './__fixtures__/e4s0_lockstep_vectors.json?raw';

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
    scope: 'world',
    ownerHandle: '',
    visibility: 'private',
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

// vi.restoreAllMocks() above resets every mock to a no-op (undefined
// return) after every test — reinstall harmless defaults before each so
// tests that don't care about server sync (i.e. most of this file) don't
// trip a "not iterable"/thenable-of-undefined crash when a mutator's
// background sync or fetchPrefs fires fire-and-forget. Create/update echo
// the payload back with a fabricated server_ts so applyServer*Meta has
// something sane to apply; none of these defaults are awaited by the tests
// that don't explicitly care about them (see the "store actions" describe
// block: it asserts on the synchronous optimistic-local result only).
let mockServerTs = 0;
beforeEach(() => {
  mockServerTs = 0;
  showToastGlobal.mockReset();
  listSharedWorldInfoBooks.mockReset();
  listSharedWorldInfoBooks.mockResolvedValue([]);
  importLorebooksFromBlob.mockReset();
  importLorebooksFromBlob.mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
  listLorebooks.mockReset();
  listLorebooks.mockResolvedValue([]);
  getLorebook.mockReset();
  getLorebook.mockResolvedValue({ id: '', ownerHandle: '', server_ts: 0, entries: [] });
  createLorebook.mockReset();
  createLorebook.mockImplementation(async (payload: Record<string, unknown>) => ({
    ownerHandle: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    server_ts: ++mockServerTs,
  }));
  updateLorebook.mockReset();
  updateLorebook.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
    ownerHandle: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    id,
    server_ts: ++mockServerTs,
  }));
  deleteLorebook.mockReset();
  deleteLorebook.mockResolvedValue(undefined);
  createLorebookEntry.mockReset();
  createLorebookEntry.mockImplementation(async (bookId: string, payload: Record<string, unknown>) => ({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    lorebook_id: bookId,
    server_ts: ++mockServerTs,
  }));
  updateLorebookEntry.mockReset();
  updateLorebookEntry.mockImplementation(
    async (bookId: string, entryId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      id: entryId,
      lorebook_id: bookId,
      server_ts: ++mockServerTs,
    })
  );
  deleteLorebookEntry.mockReset();
  deleteLorebookEntry.mockResolvedValue(undefined);
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

  // E4-S0 / #452 S1 — timers used to be stamped before applyTokenBudget ran.
  it('does not register a timer for an entry the token budget evicted', () => {
    const big = 'x'.repeat(400); // ~100 tokens generic
    const survivor = mkEntry({ keys: ['dragon'], order: 1, content: 'tiny' });
    const evicted = mkEntry({ keys: ['dragon'], order: 500, content: big });
    const activated = new Set<string>();
    const result = scan(
      mkBook([survivor, evicted]),
      msgs('dragon'),
      opts({ tokenBudget: 40 }),
      activated
    );
    // The evicted entry never reached the prompt, so it must not start its
    // cooldown/sticky windows — doing so also blocked it from firing next turn.
    expect(resultIds(result)).toEqual([survivor.id]);
    expect(activated.has(survivor.id)).toBe(true);
    expect(activated.has(evicted.id)).toBe(false);
  });

  // The landmine in the S1 fix: populating from the post-budget survivor set
  // directly would sweep sticky carry-overs in, and a sticky that re-stamps
  // its own window every turn is permanent.
  it('never registers a timer for a sticky carry-over that survives the budget', () => {
    const sticky = mkEntry({ keys: ['dragon'], sticky: 3, content: 'tiny' });
    const activated = new Set<string>();
    const result = scan(
      mkBook([sticky]),
      msgs('nothing relevant'),
      opts({ tokenBudget: 512, currentTurn: 2, wiTimers: { [sticky.id]: 1 } }),
      activated
    );
    expect(resultIds(result)).toEqual([sticky.id]);
    expect([...activated]).toEqual([]);
  });

  it('does not register a timer for a relatedIds pull-in the budget evicted', () => {
    const big = 'x'.repeat(400);
    const target = mkEntry({ keys: ['never-said'], order: 900, content: big });
    const source = mkEntry({
      keys: ['dragon'],
      order: 1,
      content: 'tiny',
      relatedIds: [target.id],
    });
    const activated = new Set<string>();
    const result = scan(
      mkBook([source, target]),
      msgs('dragon'),
      opts({ tokenBudget: 40 }),
      activated
    );
    expect(resultIds(result)).toEqual([source.id]);
    expect(activated.has(target.id)).toBe(false);
  });
});

// E4-S0 / #452 S2 — sticky matches used to be concatenated straight past
// resolveGroups, so they never faced the one-entry-per-group contract.
describe('scanMessagesForEntries — sticky carry-overs and inclusion groups', () => {
  it("keeps a sticky carry-over out when its own group already has a fresh winner", () => {
    const fresh = mkEntry({ keys: ['dragon'], group: 'g', order: 1 });
    const stickySibling = mkEntry({
      keys: ['kraken'],
      group: 'g',
      order: 2,
      sticky: 3,
    });
    const result = scan(
      mkBook([fresh, stickySibling]),
      msgs('dragon'),
      opts({ currentTurn: 2, wiTimers: { [stickySibling.id]: 1 } })
    );
    expect(resultIds(result)).toEqual([fresh.id]);
  });

  it('admits only the lowest-order of two sticky siblings when neither freshly matched', () => {
    const low = mkEntry({ keys: ['kraken'], group: 'g', order: 10, sticky: 3 });
    const high = mkEntry({ keys: ['wyvern'], group: 'g', order: 99, sticky: 3 });
    const result = scan(
      // Book order deliberately puts the loser first: admission is decided by
      // the comparator, not by whichever candidate is seen first.
      mkBook([high, low]),
      msgs('nothing relevant'),
      opts({ currentTurn: 2, wiTimers: { [low.id]: 1, [high.id]: 1 } })
    );
    expect(resultIds(result)).toEqual([low.id]);
  });

  it('breaks a sticky group tie on the lowercased label when orders match', () => {
    const alpha = mkEntry({
      keys: ['kraken'],
      comment: 'Alpha',
      group: 'g',
      order: 10,
      sticky: 3,
    });
    const beta = mkEntry({
      keys: ['wyvern'],
      comment: 'beta',
      group: 'g',
      order: 10,
      sticky: 3,
    });
    const result = scan(
      mkBook([beta, alpha]),
      msgs('nothing relevant'),
      opts({ currentTurn: 2, wiTimers: { [alpha.id]: 1, [beta.id]: 1 } })
    );
    expect(resultIds(result)).toEqual([alpha.id]);
  });

  // The landmine S2 opened: excluding group-losers from `allMatched` also
  // took them out of the `included` set that guards the relatedIds pull-in,
  // so a loser could be dragged back in, land in matchedIds, and re-stamp
  // its own sticky window every single turn — permanent injection.
  it('never lets relatedIds resurrect a sticky group-loser or stamp its timer', () => {
    const winner = mkEntry({ constant: true, group: 'g', order: 1 });
    const loser = mkEntry({ keys: ['never'], group: 'g', order: 5, sticky: 3 });
    const puller = mkEntry({
      keys: ['dragon'],
      order: 9,
      relatedIds: [loser.id],
    });
    const activated = new Set<string>();
    const result = scan(
      mkBook([winner, loser, puller]),
      msgs('dragon'),
      opts({ currentTurn: 2, wiTimers: { [loser.id]: 1 } }),
      activated
    );
    expect(resultIds(result)).toEqual([winner.id, puller.id]);
    expect(activated.has(loser.id)).toBe(false);
  });

  it('leaves ungrouped sticky carry-overs competing with nobody', () => {
    const a = mkEntry({ keys: ['kraken'], sticky: 3 });
    const b = mkEntry({ keys: ['wyvern'], sticky: 3 });
    const result = scan(
      mkBook([a, b]),
      msgs('nothing relevant'),
      opts({ currentTurn: 2, wiTimers: { [a.id]: 1, [b.id]: 1 } })
    );
    expect(resultIds(result).sort()).toEqual([a.id, b.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Cross-engine decision vectors (E4-S0).
//
// The activation rules are implemented twice — here, and in ggbc-backend's
// app/routers/_activation.py — and until this table existed the only thing
// holding the two in lockstep was a claim in two docstrings. Each vector is
// a fixture plus the two decisions BOTH engines make: which entries are
// admitted, and which of them register a timer. The backend suite
// (tests/test_retrieval_context.py) mirrors this table verbatim, so a
// one-sided change to either engine turns a test red instead of shipping as
// "the server gave me different lore than the local scan did on the very
// next turn".
//
// Scope is deliberate: relatedIds is a documented backend scope cut, so this
// table stays on admission and timer registration. Sticky EMISSION order (and
// with it token-budget eviction among equal-order entries) used to be a second
// exclusion — an open divergence between the engines — and is now settled; it
// is pinned by the shared fixture suite below, which also covers eviction.
// ---------------------------------------------------------------------------
interface VectorEntry {
  comment: string;
  keys?: string[];
  constant?: boolean;
  group?: string;
  groupOverride?: boolean;
  order?: number;
  sticky?: number;
  cooldown?: number;
  delay?: number;
}

interface DecisionVector {
  name: string;
  entries: VectorEntry[];
  timers: Record<string, number>;
  turn: number;
  message: string;
  admitted: string[];
  registered: string[];
}

const DECISION_VECTORS: DecisionVector[] = [
  {
    name: 'a fresh keyword match is admitted and registers its timer',
    entries: [{ comment: 'lore', keys: ['dragon'], sticky: 3 }],
    timers: {},
    turn: 1,
    message: 'a dragon appears',
    admitted: ['lore'],
    registered: ['lore'],
  },
  {
    name: 'a sticky carry-over is admitted and registers nothing',
    entries: [{ comment: 'lore', keys: ['dragon'], sticky: 3 }],
    timers: { lore: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['lore'],
    registered: [],
  },
  {
    name: 'a cooldown blocks the fresh match entirely',
    entries: [{ comment: 'lore', keys: ['dragon'], cooldown: 3 }],
    timers: { lore: 5 },
    turn: 6,
    message: 'a dragon appears',
    admitted: [],
    registered: [],
  },
  {
    name: 'a delay blocks activation until its turn',
    entries: [{ comment: 'lore', keys: ['dragon'], delay: 5 }],
    timers: {},
    turn: 2,
    message: 'a dragon appears',
    admitted: [],
    registered: [],
  },
  {
    name: "a group's fresh winner turns away its sticky sibling",
    entries: [
      { comment: 'fresh', keys: ['dragon'], group: 'g', order: 1 },
      { comment: 'carry', keys: ['kraken'], group: 'g', order: 2, sticky: 5 },
    ],
    timers: { carry: 5 },
    turn: 6,
    message: 'a dragon appears',
    admitted: ['fresh'],
    registered: ['fresh'],
  },
  {
    name: 'two sticky siblings of one group: the lower order wins',
    entries: [
      { comment: 'high', keys: ['wyvern'], group: 'g', order: 99, sticky: 3 },
      { comment: 'low', keys: ['kraken'], group: 'g', order: 10, sticky: 3 },
    ],
    timers: { high: 1, low: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['low'],
    registered: [],
  },
  {
    name: 'equal orders break on the lowercased label',
    entries: [
      { comment: 'beta', keys: ['wyvern'], group: 'g', order: 10, sticky: 3 },
      { comment: 'Alpha', keys: ['kraken'], group: 'g', order: 10, sticky: 3 },
    ],
    timers: { beta: 1, Alpha: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['Alpha'],
    registered: [],
  },
  {
    // A deliberate divergence from the fresh path, where groupOverride buys
    // an exclusive pool. Pinned so that "fix" landing in one engine alone
    // shows up as a red test rather than as two chats' worth of
    // contradictory lore.
    name: 'groupOverride is ignored on the sticky path',
    entries: [
      { comment: 'plain', keys: ['kraken'], group: 'camp', order: 1, sticky: 3 },
      {
        comment: 'override',
        keys: ['wyvern'],
        group: 'camp',
        order: 5,
        groupOverride: true,
        sticky: 3,
      },
    ],
    timers: { plain: 1, override: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['plain'],
    registered: [],
  },
  {
    name: 'ungrouped sticky carry-overs never compete',
    entries: [
      { comment: 'one', keys: ['kraken'], sticky: 3 },
      { comment: 'two', keys: ['wyvern'], sticky: 3 },
    ],
    timers: { one: 1, two: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['one', 'two'],
    registered: [],
  },
  {
    name: 'a constant entry claims its group ahead of a sticky sibling',
    entries: [
      { comment: 'always', constant: true, group: 'g', order: 1 },
      { comment: 'carry', keys: ['never'], group: 'g', order: 5, sticky: 3 },
    ],
    timers: { carry: 1 },
    turn: 2,
    message: 'nothing relevant',
    admitted: ['always'],
    registered: ['always'],
  },
];

describe('cross-engine decision vectors', () => {
  for (const vector of DECISION_VECTORS) {
    it(vector.name, () => {
      // comment doubles as the vector's stable name: it is the one entry
      // field both engines carry, so expectations read the same in both
      // suites without sharing generated ids.
      const entries = vector.entries.map((spec) =>
        mkEntry({
          comment: spec.comment,
          keys: spec.keys ?? [],
          constant: spec.constant ?? false,
          group: spec.group ?? '',
          groupOverride: spec.groupOverride ?? false,
          order: spec.order ?? 100,
          sticky: spec.sticky ?? 0,
          cooldown: spec.cooldown ?? 0,
          delay: spec.delay ?? 0,
        })
      );
      const idOf = (comment: string) =>
        entries.find((e) => e.comment === comment)!.id;
      const wiTimers: Record<string, number> = {};
      for (const [comment, turn] of Object.entries(vector.timers)) {
        wiTimers[idOf(comment)] = turn;
      }

      const activated = new Set<string>();
      const result = scan(
        mkBook(entries),
        msgs(vector.message),
        opts({ currentTurn: vector.turn, wiTimers, maxRecursionSteps: 0 }),
        activated
      );

      const nameOf = (id: string) => entries.find((e) => e.id === id)!.comment;
      expect(resultIds(result).map(nameOf).sort()).toEqual(
        [...vector.admitted].sort()
      );
      expect([...activated].map(nameOf).sort()).toEqual(
        [...vector.registered].sort()
      );
    });
  }
});

// ---------------------------------------------------------------------------
// E4-S0 shared lockstep fixture.
//
// The table above is this repo's own; the one below is a file both repos
// commit BYTE-IDENTICALLY (ggbc-backend holds it at tests/
// e4s0_lockstep_vectors.json). Same twelve cases, same expectations, run here
// against scanMessagesForEntries and there against run_activation_engine.
// It carries what the local table deliberately left out: eviction, and the
// equal-order sticky ordering that decides it.
//
// Its `_readme.semantics` block is the spec for this harness: `entries` is in
// CANONICAL CANDIDATE ORDER and is seeded into the book in that array order,
// every expectation is compared as a SET, and relatedIds stays empty so the
// run needs maxRecursionSteps: 0.
//
// The seeding order is honoured because the fixture specifies it and because
// the backend genuinely needs it (its candidate order is SQL, so the rows have
// to be seeded to produce it). On THIS side it is no longer load-bearing, and
// that is the point: with sticky emission moved onto the shared comparator,
// reversing the seed order leaves all ten vectors green (mutation-verified).
// Candidate order no longer reaches the result at all, which is precisely why
// the two engines can now agree without sharing one.
//
// Do not edit the fixture here alone. tools/e4s0LockstepFixture.test.ts
// asserts its sha256 against the same constant the backend suite asserts, so
// a one-sided edit turns this repo red rather than silently un-pairing the
// two engines.
// ---------------------------------------------------------------------------
interface LockstepVectorEntry {
  id: string;
  comment: string;
  order: number;
  group: string;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  keys: string[];
  relatedIds: string[];
  constant: boolean;
  critical: boolean;
  content: string;
}

interface LockstepVector {
  id: string;
  name: string;
  pins: string;
  turn: number;
  budgetTokens: number;
  message: string;
  entries: LockstepVectorEntry[];
  timers: Record<string, number>;
  expect: { injected: string[]; activated: string[]; evicted: string[] };
}

const LOCKSTEP_VECTORS: LockstepVector[] = (
  JSON.parse(lockstepVectorsRaw) as { vectors: LockstepVector[] }
).vectors;

/** Every expectation in the fixture is a SET; ids sort lexicographically. */
const asSet = (ids: string[]) => [...ids].sort();

describe('E4-S0 shared lockstep vectors', () => {
  for (const vector of LOCKSTEP_VECTORS) {
    it(`${vector.id} — ${vector.name}`, () => {
      // Seeded in the fixture's array order, with the fixture's own ids —
      // the ids matter here, since every expectation is expressed in them.
      const entries = vector.entries.map((spec) =>
        mkEntry({
          id: spec.id,
          comment: spec.comment,
          order: spec.order,
          group: spec.group,
          groupOverride: spec.groupOverride,
          sticky: spec.sticky,
          cooldown: spec.cooldown,
          keys: spec.keys,
          relatedIds: spec.relatedIds,
          constant: spec.constant,
          critical: spec.critical,
          content: spec.content,
        })
      );

      const activated = new Set<string>();
      const report = emptyReport();
      const result = scan(
        mkBook(entries),
        msgs(vector.message),
        opts({
          currentTurn: vector.turn,
          wiTimers: { ...vector.timers },
          tokenBudget: vector.budgetTokens,
          maxRecursionSteps: 0,
        }),
        activated,
        report
      );

      expect(asSet(resultIds(result))).toEqual(asSet(vector.expect.injected));
      expect(asSet([...activated])).toEqual(asSet(vector.expect.activated));
      expect(asSet(report.dropped.map((m) => m.entry.id))).toEqual(
        asSet(vector.expect.evicted)
      );
    });
  }
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

  it('createBookWithEntries creates a book with all entries default-filled', () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBookWithEntries('Data Bank Doc', [
      { content: 'chunk one', comment: 'chunk 1 of Data Bank Doc', keys: [], semanticOnly: true, source: 'import' },
      { content: 'chunk two', comment: 'chunk 2 of Data Bank Doc', keys: [], semanticOnly: true, source: 'import' },
    ]);
    expect(book.name).toBe('Data Bank Doc');
    expect(book.ownerCharacterAvatar).toBeNull();
    expect(book.scope).toBe('world');
    expect(book.entries).toHaveLength(2);
    expect(book.entries[0].content).toBe('chunk one');
    expect(book.entries[0].semanticOnly).toBe(true);
    expect(book.entries[0].keys).toEqual([]);
    expect(book.entries[0].id).toBeTruthy();
    expect(book.entries[0].id).not.toBe(book.entries[1].id);
    expect(book.entries[0].revisions).toHaveLength(1);
    expect(book.entries[0].revisions[0].action).toBe('create');
    // Unset fields fall back to DEFAULT_ENTRY, same as a plain createEntry call.
    expect(book.entries[0].position).toBe(DEFAULT_ENTRY.position);
    expect(book.entries[0].enabled).toBe(true);
    expect(book.entries[0].critical).toBe(false);
  });

  it('createBookWithEntries scopes to a character when ownerCharacterAvatar is given', () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBookWithEntries('Char Doc', [{ content: 'x' }], 'ivy.png');
    expect(book.ownerCharacterAvatar).toBe('ivy.png');
    expect(book.scope).toBe('character');
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

  it('setBookVisibility mutates visibility and bumps updatedAt', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const book = useWorldInfoStore.getState().createBook('Shareable');
      expect(book.visibility).toBe('private');

      vi.setSystemTime(2000);
      useWorldInfoStore.getState().setBookVisibility(book.id, 'shared');

      const after = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
      expect(after.visibility).toBe('shared');
      expect(after.updatedAt).toBe(2000);
      expect(after.updatedAt).toBeGreaterThan(book.updatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setBookVisibility no-ops when trying to share an autoExtracted book', () => {
    const book = useWorldInfoStore.getState().createBook('Auto Memory');
    // autoExtracted isn't settable through createBook — patch it directly,
    // mirroring autoMemoryStore.test.ts's own setup for this flag.
    useWorldInfoStore.setState((s) => ({
      books: s.books.map((b) => (b.id === book.id ? { ...b, autoExtracted: true } : b)),
    }));

    useWorldInfoStore.getState().setBookVisibility(book.id, 'shared');

    const after = useWorldInfoStore.getState().books.find((b) => b.id === book.id)!;
    expect(after.visibility).toBe('private');
  });

  it('duplicateBook always produces a private copy, even from a shared original', () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBook('Shared Original');
    store.createEntry(book.id, { comment: 'entry' });
    useWorldInfoStore.getState().setBookVisibility(book.id, 'shared');
    expect(
      useWorldInfoStore.getState().books.find((b) => b.id === book.id)!.visibility
    ).toBe('shared');

    const copy = useWorldInfoStore.getState().duplicateBook(book.id)!;
    expect(copy.visibility).toBe('private');
  });
});

// E4-S0 / #450 F2+F3. A character can own more than one book: its card's
// embedded lorebook, plus any character-scoped Data Bank document. Every
// resolver used to take `books.find(ownerCharacterAvatar === avatar)` — first
// match only — so a document could be mistaken for the card's book (and
// destroyed by an unrelated delete), while itself staying invisible to the
// chat scan.
describe('character-owned book resolution', () => {
  const AVATAR = 'ivy.png';

  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
    resetDocumentBookRegistry();
  });

  afterEach(() => {
    resetDocumentBookRegistry();
  });

  /** A character-scoped document: keyless, semantic-only chunks. */
  function addDocumentBook(name: string) {
    return useWorldInfoStore
      .getState()
      .createBookWithEntries(
        name,
        [
          { content: 'chunk one', comment: `chunk 1 of ${name}`, keys: [], semanticOnly: true, source: 'import' },
          { content: 'chunk two', comment: `chunk 2 of ${name}`, keys: [], semanticOnly: true, source: 'import' },
        ],
        AVATAR
      );
  }

  it('getCharacterBook skips a document book that would otherwise shadow the card book', () => {
    const doc = addDocumentBook('Ivy Dossier');
    const embedded = useWorldInfoStore
      .getState()
      .createCharacterBook(AVATAR, 'Ivy Lorebook');
    // The document was created first, so the old first-match resolver returned it.
    expect(useWorldInfoStore.getState().books[0].id).toBe(doc.id);
    expect(embedded.id).not.toBe(doc.id);
    expect(useWorldInfoStore.getState().getCharacterBook(AVATAR)!.id).toBe(embedded.id);
  });

  it('getCharacterBooks returns every book the character owns', () => {
    const doc = addDocumentBook('Ivy Dossier');
    const embedded = useWorldInfoStore
      .getState()
      .createCharacterBook(AVATAR, 'Ivy Lorebook');
    useWorldInfoStore.getState().createBook('Unrelated World Book');

    const owned = useWorldInfoStore.getState().getCharacterBooks(AVATAR);
    expect(owned.map((b) => b.id).sort()).toEqual([doc.id, embedded.id].sort());
  });

  it('upsertCharacterBook replaces the card book, never a shadowing document', () => {
    const doc = addDocumentBook('Ivy Dossier');
    const embedded = useWorldInfoStore
      .getState()
      .createCharacterBook(AVATAR, 'Ivy Lorebook');

    const cardRaw = bookToCharacterBookV2(
      mkBook([mkEntry({ keys: ['ivy'], content: 'card lore' })], { name: 'From Card' })
    );
    const upserted = useWorldInfoStore
      .getState()
      .upsertCharacterBook(AVATAR, cardRaw, 'From Card');

    expect(upserted.id).toBe(embedded.id);
    const after = useWorldInfoStore.getState().books.find((b) => b.id === doc.id)!;
    expect(after.entries).toHaveLength(2);
    expect(after.entries.every((e) => e.semanticOnly)).toBe(true);
  });

  it('deleteBook removes only the targeted book, leaving the character\'s others', () => {
    const doc = addDocumentBook('Ivy Dossier');
    const embedded = useWorldInfoStore
      .getState()
      .createCharacterBook(AVATAR, 'Ivy Lorebook');

    useWorldInfoStore.getState().deleteBook(embedded.id);

    const remaining = useWorldInfoStore.getState().books.map((b) => b.id);
    expect(remaining).toEqual([doc.id]);
  });

  // The heuristic this replaced ("every entry is semanticOnly") was pure
  // content, and content is exactly what the user is invited to change:
  // AddDocumentModal tells them to add keywords to a chunk. Registry
  // membership is written at creation, synced, and untouchable from the
  // lorebook editor.
  it('keeps treating a registered document as one after an ordinary entry is added', () => {
    const doc = addDocumentBook('Ivy Dossier');
    setDocumentBookIds([doc.id]);
    useWorldInfoStore.getState().createEntry(doc.id, {
      keys: ['rain'],
      content: 'Ivy hates rain',
    });

    expect(useWorldInfoStore.getState().getCharacterBook(AVATAR)).toBeNull();
    const upserted = useWorldInfoStore
      .getState()
      .upsertCharacterBook(
        AVATAR,
        bookToCharacterBookV2(
          mkBook([mkEntry({ keys: ['ivy'], content: 'card lore' })], {
            name: 'From Card',
          })
        ),
        'From Card'
      );
    expect(upserted.id).not.toBe(doc.id);
    const after = useWorldInfoStore.getState().books.find((b) => b.id === doc.id)!;
    expect(after.name).toBe('Ivy Dossier');
    expect(after.entries).toHaveLength(3);
  });

  it('deleteCharacterBooks removes every book the character owns and nothing else', () => {
    const doc = addDocumentBook('Ivy Dossier');
    const embedded = useWorldInfoStore
      .getState()
      .createCharacterBook(AVATAR, 'Ivy Lorebook');
    const otherChar = useWorldInfoStore
      .getState()
      .createCharacterBook('marcus.png', 'Marcus Lorebook');
    const world = useWorldInfoStore.getState().createBook('World Book');
    useWorldInfoStore.getState().setBookActive(world.id, true);

    useWorldInfoStore.getState().deleteCharacterBooks(AVATAR);

    const remaining = useWorldInfoStore.getState().books.map((b) => b.id);
    expect(remaining.sort()).toEqual([otherChar.id, world.id].sort());
    expect(remaining).not.toContain(doc.id);
    expect(remaining).not.toContain(embedded.id);
    expect(useWorldInfoStore.getState().activeBookIds).toEqual([world.id]);
  });
});

// E4-S0. Deactivating a world book is an account-wide decision wearing a
// per-book checkbox: server-side retrieval requires EVERY world book active
// (serverRetrieval.ts condition 4). The user gets to make that trade; they
// don't get to make it unknowingly.
describe('toggleBookActive — telling the user what off costs', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
    showToastGlobal.mockReset();
  });

  it('warns on the toggle that switches server retrieval off', () => {
    const alpha = useWorldInfoStore.getState().createBook('Alpha');
    const beta = useWorldInfoStore.getState().createBook('Beta');
    useWorldInfoStore.getState().setBookActive(alpha.id, true);
    useWorldInfoStore.getState().setBookActive(beta.id, true);
    showToastGlobal.mockReset();

    useWorldInfoStore.getState().toggleBookActive(alpha.id);

    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(String(showToastGlobal.mock.calls[0][0])).toContain('Alpha');
    expect(String(showToastGlobal.mock.calls[0][0])).toContain('keyword scan');

    // Retrieval is already off — a second warning would be noise, not news.
    showToastGlobal.mockReset();
    useWorldInfoStore.getState().toggleBookActive(beta.id);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('stays quiet when a book is switched back ON', () => {
    const alpha = useWorldInfoStore.getState().createBook('Alpha');
    useWorldInfoStore.getState().toggleBookActive(alpha.id);
    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('stays quiet for a character-owned book, which condition 4 never reads', () => {
    const owned = useWorldInfoStore
      .getState()
      .createCharacterBook('ivy.png', 'Ivy Lorebook');
    useWorldInfoStore.getState().setBookActive(owned.id, true);
    showToastGlobal.mockReset();

    useWorldInfoStore.getState().toggleBookActive(owned.id);

    expect(showToastGlobal).not.toHaveBeenCalled();
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

// A full, valid LorebookEntryDTO fixture — every field normalizeNativeEntry
// reads, so tests that only care about a couple of overridden fields don't
// have to restate the other ~25.
function mkEntryDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-entry',
    lorebook_id: 'dto-book',
    server_ts: 1,
    keys: [],
    content: '',
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
    sticky: 0,
    cooldown: 0,
    delay: 0,
    critical: false,
    category: '',
    relatedIds: [],
    source: 'manual',
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function mkBookDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-book',
    ownerHandle: 'alice',
    server_ts: 1,
    name: 'DTO Book',
    ownerCharacterAvatar: null,
    autoExtracted: false,
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('fetchPrefs — native lorebook bootstrap (Phase 3a)', () => {
  it('applies activeBookIds/chatLinkedBookIds/scan settings from the blob, and books/entries from the native API', async () => {
    const serverSettings = await import('../utils/serverSettings');
    vi.mocked(serverSettings.getSettingsBlob).mockResolvedValueOnce({
      stm_worldinfo: {
        activeBookIds: ['native-book-1'],
        chatLinkedBookIds: { 'chat.jsonl': ['native-book-1'] },
        scanDepth: 6,
        maxRecursionSteps: 2,
        tokenBudget: 2048,
        _ts: 123,
      },
    });
    listLorebooks.mockResolvedValueOnce([
      mkBookDto({ id: 'native-book-1', name: 'Native Book' }),
    ]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'native-book-1', name: 'Native Book' }),
      entries: [
        mkEntryDto({
          id: 'native-entry-1',
          lorebook_id: 'native-book-1',
          keys: ['dragon'],
          content: 'lore',
        }),
      ],
    });

    useWorldInfoStore.getState().resetUser();
    await useWorldInfoStore.getState().fetchPrefs();

    const state = useWorldInfoStore.getState();
    // Blob-backed fields — unchanged mechanism.
    expect(state.activeBookIds).toEqual(['native-book-1']);
    expect(state.chatLinkedBookIds).toEqual({ 'chat.jsonl': ['native-book-1'] });
    expect(state.scanDepth).toBe(6);
    expect(state.maxRecursionSteps).toBe(2);
    expect(state.tokenBudget).toBe(2048);

    // Books/entries — native API, NOT the blob (the blob has no `books` key
    // at all in this fixture, and even if it did, it must never be read).
    expect(state.books).toHaveLength(1);
    expect(state.books[0].id).toBe('native-book-1');
    const entry = state.books[0].entries[0];
    expect(entry.id).toBe('native-entry-1');
    expect(entry.relatedIds).toEqual([]);
    expect(entry.critical).toBe(false);

    // The scanner must not crash on the native-sourced book.
    const result = scanMessagesForEntries(
      state.books,
      ['native-book-1'],
      msgs('a dragon appears'),
      opts()
    );
    expect(resultIds(result)).toEqual(['native-entry-1']);
  });

  it('degrades a malformed/partial entry DTO to safe defaults instead of crashing', async () => {
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'b1' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'b1' }),
      // Only the required identifiers — every other field missing/malformed,
      // the shape a future backend rollback or a corrupt response could
      // produce. normalizeNativeEntry must default, never throw.
      entries: [{ id: 'e1', lorebook_id: 'b1', server_ts: 1, position: 'not-a-real-position' }],
    });
    useWorldInfoStore.getState().resetUser();
    await useWorldInfoStore.getState().fetchPrefs();
    const entry = useWorldInfoStore.getState().books[0].entries[0];
    expect(entry.keys).toEqual([]);
    expect(entry.relatedIds).toEqual([]);
    expect(entry.critical).toBe(false);
    expect(entry.category).toBe('');
    expect(entry.sticky).toBe(0);
    expect(entry.position).toBe('before_char');
  });
});

describe('legacy id remap (Phase 3a migration)', () => {
  it('maps an old-id book/entry onto its native-fetched counterpart by (scope, name) and content signature', async () => {
    const { remapLegacyBookId, remapLegacyEntryId } = await import('./worldInfoStore');
    useWorldInfoStore.getState().resetUser();
    // Simulate the pre-cutover local snapshot initForUser would have
    // hydrated from the localStorage cache — old, non-UUID ids that
    // predate this cutover shipping.
    useWorldInfoStore.setState({
      books: [
        mkBook(
          [mkEntry({ id: 'wi_old_1', comment: 'c', content: 'text', keys: ['a'] })],
          { id: 'wibook_old_1', name: 'Shared Lore', ownerCharacterAvatar: null }
        ),
      ],
    });
    listLorebooks.mockResolvedValueOnce([
      mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
    ]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
      entries: [
        mkEntryDto({
          id: 'uuid-entry-1',
          lorebook_id: 'uuid-book-1',
          comment: 'c',
          content: 'text',
          keys: ['a'],
        }),
      ],
    });

    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyBookId('wibook_old_1')).toBe('uuid-book-1');
    expect(remapLegacyEntryId('wi_old_1')).toBe('uuid-entry-1');
    expect(remapLegacyBookId('never-seen-id')).toBeNull();
    expect(remapLegacyEntryId('never-seen-id')).toBeNull();
  });

  it('leaves a book unmapped when no native book matches its (scope, name)', async () => {
    useWorldInfoStore.getState().resetUser();
    useWorldInfoStore.setState({
      books: [mkBook([], { id: 'wibook_orphan', name: 'Never Imported' })],
    });
    listLorebooks.mockResolvedValueOnce([mkBookDto({ id: 'uuid-1', name: 'Unrelated' })]);
    getLorebook.mockResolvedValueOnce({
      ...mkBookDto({ id: 'uuid-1', name: 'Unrelated' }),
      entries: [],
    });

    const { remapLegacyBookId } = await import('./worldInfoStore');
    await useWorldInfoStore.getState().fetchPrefs();

    expect(remapLegacyBookId('wibook_orphan')).toBeNull();
  });
});

describe('fetchSharedBooks', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
  });

  it('normalizes well-formed DTOs and drops a malformed one without throwing', async () => {
    const wellFormed = mkBook([mkEntry({ comment: 'shared entry' })], {
      id: 'shared-book-1',
      name: "Alice's Book",
      ownerHandle: 'stale-handle', // must be overwritten by the DTO's owner_handle
      visibility: 'private', // must be forced to 'shared'
      scope: 'character', // wrong on purpose — scope must be re-derived, not trusted
      ownerCharacterAvatar: null,
    });
    const malformed = { id: 'broken-book', name: 'Broken' }; // no entries array at all

    listSharedWorldInfoBooks.mockResolvedValueOnce([
      { owner_handle: 'alice', owner_name: 'Alice A.', book: wellFormed },
      { owner_handle: 'bob', owner_name: null, book: malformed },
    ]);

    await expect(useWorldInfoStore.getState().fetchSharedBooks()).resolves.toBeUndefined();

    const state = useWorldInfoStore.getState();
    expect(state.sharedBooksStatus).toBe('loaded');
    expect(state.sharedBooksError).toBeNull();
    expect(state.sharedBooks).toHaveLength(1);
    const [got] = state.sharedBooks;
    expect(got.id).toBe('shared-book-1');
    expect(got.visibility).toBe('shared');
    expect(got.ownerHandle).toBe('alice');
    expect(got.scope).toBe('world');
    // Bob's malformed entry never made it in, so it never populates a name either.
    expect(state.sharedOwnerNameByHandle).toEqual({ alice: 'Alice A.' });
  });

  it('sets sharedBooksStatus to error and does not throw when the API call rejects', async () => {
    listSharedWorldInfoBooks.mockRejectedValueOnce(new Error('404 Not Found'));

    await expect(useWorldInfoStore.getState().fetchSharedBooks()).resolves.toBeUndefined();

    const state = useWorldInfoStore.getState();
    expect(state.sharedBooksStatus).toBe('error');
    expect(state.sharedBooksError).toBe('404 Not Found');
    expect(state.sharedBooks).toEqual([]);
  });
});

describe('getComposableBooks', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
  });

  it('dedupes by id, with the caller\'s own book winning on collision', () => {
    const store = useWorldInfoStore.getState();
    const ownBook = store.createBook('Mine');
    store.createEntry(ownBook.id, { comment: 'mine' });

    const collidingShared = mkBook([mkEntry({ comment: 'not mine' })], {
      id: ownBook.id, // collides with the viewer's own book id
      name: 'Impostor',
      ownerHandle: 'alice',
      visibility: 'shared',
    });
    const uniqueShared = mkBook([mkEntry({ comment: 'shared-only' })], {
      id: 'unique-shared-book',
      name: 'Alice Lore',
      ownerHandle: 'alice',
      visibility: 'shared',
    });
    useWorldInfoStore.setState({ sharedBooks: [collidingShared, uniqueShared] });

    const composed = useWorldInfoStore.getState().getComposableBooks();
    expect(composed.map((b) => b.id).sort()).toEqual(
      [ownBook.id, 'unique-shared-book'].sort()
    );
    const winner = composed.find((b) => b.id === ownBook.id)!;
    // The viewer's own book wins the collision — its own entry, not the impostor's.
    expect(winner.entries.map((e) => e.comment)).toEqual(['mine']);
    expect(winner.name).toBe('Mine');
  });
});

describe('copySharedBook', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
  });

  it('copies a shared book into books as a fresh private, world-scope, "(copy)"-suffixed book', () => {
    const target = mkEntry({ comment: 'target' });
    const source = mkEntry({ comment: 'source', relatedIds: [target.id] });
    const shared = mkBook([target, source], {
      id: 'shared-book-1',
      name: "Alice's Lore",
      ownerHandle: 'alice',
      visibility: 'shared',
      ownerCharacterAvatar: 'alice-char.png',
      scope: 'character',
      autoExtracted: true, // defensive: even if somehow set, the copy must clear it
    });
    useWorldInfoStore.setState({ sharedBooks: [shared] });

    const copy = useWorldInfoStore.getState().copySharedBook('shared-book-1');

    expect(copy).not.toBeNull();
    expect(copy!.name).toBe("Alice's Lore (copy)");
    expect(copy!.visibility).toBe('private');
    expect(copy!.scope).toBe('world');
    expect(copy!.ownerCharacterAvatar).toBeNull();
    expect(copy!.autoExtracted).toBeUndefined();
    // ownerHandle becomes the copier's own handle, not the original owner's.
    expect(copy!.ownerHandle).not.toBe('alice');

    // relatedIds were remapped onto the copy's fresh entry ids, not left
    // pointing at the original (still-shared) entries.
    const copiedSource = copy!.entries.find((e) => e.comment === 'source')!;
    const copiedTarget = copy!.entries.find((e) => e.comment === 'target')!;
    expect(copiedSource.id).not.toBe(source.id);
    expect(copiedSource.relatedIds).toEqual([copiedTarget.id]);

    // Persisted into the caller's own books, not just returned.
    const stateBooks = useWorldInfoStore.getState().books;
    expect(stateBooks.map((b) => b.id)).toContain(copy!.id);
    // The original shared book is untouched.
    expect(useWorldInfoStore.getState().sharedBooks[0]).toEqual(shared);
  });

  it('returns null and makes no changes when the shared book id is not found', () => {
    useWorldInfoStore.setState({ sharedBooks: [] });
    const before = useWorldInfoStore.getState().books;

    const copy = useWorldInfoStore.getState().copySharedBook('does-not-exist');

    expect(copy).toBeNull();
    expect(useWorldInfoStore.getState().books).toBe(before);
  });
});

describe('resetUser — sharing state', () => {
  it('clears sharedBooks/sharedOwnerNameByHandle/sharedBooksStatus/sharedBooksError to defaults', async () => {
    useWorldInfoStore.getState().resetUser();
    listSharedWorldInfoBooks.mockResolvedValueOnce([
      {
        owner_handle: 'alice',
        owner_name: 'Alice A.',
        book: mkBook([mkEntry()], { id: 'sb1', ownerHandle: 'alice', visibility: 'shared' }),
      },
    ]);
    await useWorldInfoStore.getState().fetchSharedBooks();
    expect(useWorldInfoStore.getState().sharedBooks).toHaveLength(1);

    useWorldInfoStore.getState().resetUser();

    const state = useWorldInfoStore.getState();
    expect(state.sharedBooks).toEqual([]);
    expect(state.sharedOwnerNameByHandle).toEqual({});
    expect(state.sharedBooksStatus).toBe('idle');
    expect(state.sharedBooksError).toBeNull();
  });
});

describe('Phase 3.2 — pinned-budget warning toast', () => {
  beforeEach(() => {
    useWorldInfoStore.getState().resetUser();
  });

  it('shows a warning toast when createEntry\'s server response carries pinnedBudgetWarning', async () => {
    createLorebookEntry.mockImplementation(async (bookId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      lorebook_id: bookId,
      server_ts: ++mockServerTs,
      pinnedBudgetWarning: { pinnedTokens: 1200, budgetTokens: 1024 },
    }));

    const store = useWorldInfoStore.getState();
    const book = store.createBook('Book');
    store.createEntry(book.id, { comment: 'entry', critical: true });

    await createLorebookEntry.mock.results[0].value;
    await Promise.resolve();

    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    const [message, variant] = showToastGlobal.mock.calls[0];
    expect(message).toContain('1200');
    expect(message).toContain('1024');
    expect(variant).toBe('warning');
  });

  it('shows a warning toast when updateEntry\'s server response carries pinnedBudgetWarning', async () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBook('Book');
    const entry = store.createEntry(book.id, { comment: 'entry' })!;
    await Promise.resolve();

    updateLorebookEntry.mockImplementation(
      async (bookId: string, entryId: string, payload: Record<string, unknown>) => ({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...payload,
        id: entryId,
        lorebook_id: bookId,
        server_ts: ++mockServerTs,
        pinnedBudgetWarning: { pinnedTokens: 50, budgetTokens: 10 },
      })
    );
    store.updateEntry(book.id, entry.id, { critical: true });

    await updateLorebookEntry.mock.results[0].value;
    await Promise.resolve();

    expect(showToastGlobal).toHaveBeenCalledTimes(1);
    expect(showToastGlobal.mock.calls[0][1]).toBe('warning');
  });

  it('does not toast when no pinnedBudgetWarning is present', async () => {
    const store = useWorldInfoStore.getState();
    const book = store.createBook('Book');
    store.createEntry(book.id, { comment: 'entry' });

    await createLorebookEntry.mock.results[0].value;
    await Promise.resolve();

    expect(showToastGlobal).not.toHaveBeenCalled();
  });

  it('only warns once per book per session, not on every subsequent write', async () => {
    createLorebookEntry.mockImplementation(async (bookId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      lorebook_id: bookId,
      server_ts: ++mockServerTs,
      pinnedBudgetWarning: { pinnedTokens: 1200, budgetTokens: 1024 },
    }));

    const store = useWorldInfoStore.getState();
    const book = store.createBook('Book');
    store.createEntry(book.id, { comment: 'first', critical: true });
    await createLorebookEntry.mock.results[0].value;
    await Promise.resolve();
    expect(showToastGlobal).toHaveBeenCalledTimes(1);

    store.createEntry(book.id, { comment: 'second', critical: true });
    await createLorebookEntry.mock.results[1].value;
    await Promise.resolve();
    expect(showToastGlobal).toHaveBeenCalledTimes(1); // still just the one
  });

  it('does not toast on bulk book-import sync (only the two interactive single-entry paths do)', async () => {
    createLorebook.mockImplementation(async (payload: Record<string, unknown>) => ({
      ownerHandle: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      server_ts: ++mockServerTs,
    }));
    createLorebookEntry.mockImplementation(async (bookId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      lorebook_id: bookId,
      server_ts: ++mockServerTs,
      pinnedBudgetWarning: { pinnedTokens: 1200, budgetTokens: 1024 },
    }));

    const store = useWorldInfoStore.getState();
    // createBookWithEntries drives syncNewBookWithEntries — the bulk path,
    // shared with import/duplicate/copy flows — not the interactive one.
    store.createBookWithEntries('Bulk Book', [
      { content: 'one', critical: true },
      { content: 'two', critical: true },
    ]);

    // Let every in-flight mocked call (book create + both entry creates)
    // settle, plus the store's own .then() chains.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(showToastGlobal).not.toHaveBeenCalled();
  });
});
