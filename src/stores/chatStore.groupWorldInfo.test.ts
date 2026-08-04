import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { buildGroupConversationContext, useChatStore } = await import('./chatStore');
const { useWorldInfoStore, DEFAULT_ENTRY } = await import('./worldInfoStore');
const { useCharacterStore } = await import('./characterStore');
const { usePersonaStore } = await import('./personaStore');
const { useSettingsStore } = await import('./settingsStore');

import type { WorldInfoBook, WorldInfoEntry } from './worldInfoStore';
import type { CharacterInfo } from '../api/client';
import type { ChatMessage } from './chatStore';

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

function mkChar(name: string, avatar: string): CharacterInfo {
  return { name, avatar, description: `${name} description` } as CharacterInfo;
}

let msgId = 0;
function mkMsg(content: string, isUser = true, name = 'User'): ChatMessage {
  msgId += 1;
  return {
    id: `m${msgId}`,
    name,
    isUser,
    isSystem: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
  } as ChatMessage;
}

const CHAT_FILE = 'group-chat.jsonl';
const seraphina = mkChar('Seraphina', 'seraphina.png');
const marcus = mkChar('Marcus', 'marcus.png');

/** Install books and point the world-info store at them as globally active. */
function useBooks(books: WorldInfoBook[], activeBookIds?: string[]) {
  useWorldInfoStore.setState({
    books,
    activeBookIds: activeBookIds ?? books.map((b) => b.id),
    chatLinkedBookIds: {},
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 0,
  });
}

const textOf = (
  ctx: { role: string; content: string }[]
) => ctx.map((c) => c.content).join('\n');

beforeEach(() => {
  useWorldInfoStore.setState({
    books: [],
    activeBookIds: [],
    chatLinkedBookIds: {},
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 0,
  });
  useCharacterStore.setState({ linkedBookIdsByAvatar: {}, characters: [] });
  usePersonaStore.setState({ personas: [], activePersonaId: null });
  useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4' });
  useChatStore.setState({
    currentChatFile: CHAT_FILE,
    authorNotes: {},
    chatVariables: {},
  });
});

describe('buildGroupConversationContext — world info reaches group chats', () => {
  it('injects a matched entry instead of dropping world info entirely', () => {
    const entry = mkEntry({ keys: ['dragon'], content: 'Dragons hoard salt.' });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('tell me about the dragon')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Dragons hoard salt.');
  });

  it('keeps a critical entry present even when it never matches a key', () => {
    // `critical` is the never-silently-absent guarantee: constant lore must
    // survive into the group prompt exactly as it does in a solo chat.
    const critical = mkEntry({
      constant: true,
      critical: true,
      content: 'The tower fell in the third age.',
    });
    useBooks([mkBook([critical])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('hello everyone')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('The tower fell in the third age.');
  });
});

describe('buildGroupConversationContext — book scoping across members', () => {
  it("scans every member's embedded book, not just the speaker's", () => {
    const sera = mkEntry({ keys: ['dragon'], content: 'Seraphina fears dragons.' });
    const marc = mkEntry({ keys: ['dragon'], content: 'Marcus hunts dragons.' });
    useBooks(
      [
        mkBook([sera], { ownerCharacterAvatar: seraphina.avatar }),
        mkBook([marc], { ownerCharacterAvatar: marcus.avatar }),
      ],
      [] // nothing globally active — membership alone must pull these in
    );

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    const text = textOf(ctx);
    expect(text).toContain('Seraphina fears dragons.');
    expect(text).toContain('Marcus hunts dragons.');
  });

  it("does not pull in a non-member character's owned book", () => {
    const outsider = mkEntry({ keys: ['dragon'], content: 'Outsider lore.' });
    useBooks([mkBook([outsider], { ownerCharacterAvatar: 'stranger.png' })], []);

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).not.toContain('Outsider lore.');
  });

  it('includes books linked to the group chat file', () => {
    const chatEntry = mkEntry({ keys: ['dragon'], content: 'Chat-scoped lore.' });
    const book = mkBook([chatEntry]);
    useBooks([book], []);
    useWorldInfoStore.setState({ chatLinkedBookIds: { [CHAT_FILE]: [book.id] } });

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Chat-scoped lore.');
  });
});

describe('buildGroupConversationContext — attribution labels', () => {
  it("tags lore from a non-speaking member's own book with their name", () => {
    const marc = mkEntry({ keys: ['dragon'], content: 'Marcus hunts dragons.' });
    useBooks([mkBook([marc], { ownerCharacterAvatar: marcus.avatar })], []);

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain(
      '[Information about Marcus, another character in this conversation]'
    );
  });

  it("tags lore from an owner who isn't a member of this room, when their book was manually made globally active", () => {
    // Marcus owns this book but is NOT passed as a member below — the book
    // only reaches the scan because it's globally active (a user can flip
    // that toggle on any book regardless of ownership). Attribution must
    // still resolve Marcus's name from the full roster, not just the room's
    // members, or this lore would render unlabelled and read as Seraphina's
    // own — the identity-bleed attribution exists to prevent.
    const marc = mkEntry({ keys: ['dragon'], content: 'Marcus hunts dragons.' });
    useBooks([mkBook([marc], { ownerCharacterAvatar: marcus.avatar })]);
    useCharacterStore.setState({ characters: [seraphina, marcus] });

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina],
      seraphina
    );

    expect(textOf(ctx)).toContain(
      '[Information about Marcus, another character in this conversation]'
    );
  });

  it("leaves the speaker's own lore unlabelled", () => {
    const sera = mkEntry({ keys: ['dragon'], content: 'Seraphina fears dragons.' });
    useBooks([mkBook([sera], { ownerCharacterAvatar: seraphina.avatar })], []);

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Seraphina fears dragons.');
    expect(textOf(ctx)).not.toContain('another character in this conversation');
  });

  it('labels persona-book lore as describing the user', () => {
    const personaEntry = mkEntry({ keys: ['dragon'], content: 'Ash is a smith.' });
    const book = mkBook([personaEntry]);
    useBooks([book], []);
    usePersonaStore.setState({
      personas: [
        {
          id: 'p1',
          name: 'Ash',
          description: 'A wandering smith.',
          linkedBookIds: [book.id],
        },
      ],
      activePersonaId: 'p1',
    } as never);

    const ctx = buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain(
      "[Information about Ash, the user you're talking to]"
    );
  });
});

describe('buildGroupConversationContext — positions', () => {
  it('puts before_char lore ahead of the character block', () => {
    const entry = mkEntry({
      constant: true,
      position: 'before_char',
      content: 'WORLD PREAMBLE',
    });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcus],
      seraphina
    );

    const system = ctx[0].content;
    expect(system.indexOf('WORLD PREAMBLE')).toBeGreaterThan(-1);
    expect(system.indexOf('WORLD PREAMBLE')).toBeLessThan(
      system.indexOf('Characters in this conversation')
    );
  });

  it('injects at_depth lore as a system message at the matching depth', () => {
    const entry = mkEntry({
      constant: true,
      position: 'at_depth',
      depth: 2,
      content: 'DEPTH LORE',
    });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('first'), mkMsg('second', false, 'Seraphina'), mkMsg('third')],
      [seraphina, marcus],
      seraphina
    );

    const loreIdx = ctx.findIndex((c) => c.content === 'DEPTH LORE');
    expect(loreIdx).toBeGreaterThan(-1);
    expect(ctx[loreIdx].role).toBe('system');
    // depth 2 = before the second-from-last history message.
    expect(ctx[loreIdx + 1].content).toContain('second');
  });

  it('puts depth-0 lore after the newest message', () => {
    const entry = mkEntry({
      constant: true,
      position: 'at_depth',
      depth: 0,
      content: 'TRAILING LORE',
    });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('first'), mkMsg('newest')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx[ctx.length - 1].content).toBe('TRAILING LORE');
    expect(ctx[ctx.length - 2].content).toContain('newest');
  });

  it('puts after_an lore after the whole history', () => {
    const entry = mkEntry({
      constant: true,
      position: 'after_an',
      content: 'POST HISTORY LORE',
    });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('first'), mkMsg('newest')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx[ctx.length - 1].content).toBe('POST HISTORY LORE');
  });

  it('prepends at_depth lore whose depth exceeds the history length', () => {
    const entry = mkEntry({
      constant: true,
      position: 'at_depth',
      depth: 50,
      content: 'OVERFLOW LORE',
    });
    useBooks([mkBook([entry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('only message')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx[1].content).toBe('OVERFLOW LORE');
  });
});

describe('buildGroupConversationContext — timers and telemetry', () => {
  it('reports fired entries and activated ids through the scan-out param', () => {
    const hit = mkEntry({ keys: ['dragon'], sticky: 3, content: 'Dragon lore.' });
    const miss = mkEntry({ keys: ['kraken'], content: 'Kraken lore.' });
    useBooks([mkBook([hit, miss])]);

    const wiOut = {
      currentTurn: 4,
      timers: {} as Record<string, number>,
      activated: new Set<string>(),
      fired: undefined as unknown,
    };

    buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      wiOut as never
    );

    const fired = wiOut.fired as { entry: WorldInfoEntry }[];
    expect(fired.map((m) => m.entry.id)).toEqual([hit.id]);
    expect(wiOut.activated.size).toBeGreaterThan(0);
  });

  it('omits entries whose macros render to nothing from the fired set', () => {
    const empty = mkEntry({ keys: ['dragon'], content: '{{setvar::seen::1}}' });
    useBooks([mkBook([empty])]);

    const wiOut = {
      currentTurn: 1,
      timers: {} as Record<string, number>,
      activated: new Set<string>(),
      fired: undefined as unknown,
    };

    buildGroupConversationContext(
      [mkMsg('a dragon lands')],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      wiOut as never
    );

    expect(wiOut.fired as unknown[]).toEqual([]);
    // The macro still ran, and its write was persisted to the chat.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).seen).toBe('1');
  });
});
