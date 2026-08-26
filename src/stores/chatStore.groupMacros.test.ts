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

// E9-S6: group macro substitution + blank-user-turn guard. Every test below
// pins one of the story's acceptance criteria (AC1-AC8) against the real
// buildGroupConversationContext, not a reimplementation of it.

describe('buildGroupConversationContext — AC1: card fields are macro-substituted', () => {
  it('substitutes a card field macro in join mode', () => {
    const nova: CharacterInfo = {
      name: 'Nova',
      avatar: 'nova.png',
      description: 'Friends with {{user}}.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, nova],
      seraphina,
      undefined,
      undefined,
      'join'
    );

    expect(textOf(ctx)).toContain('Friends with User.');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  it('substitutes a card field macro in swap mode', () => {
    const nova: CharacterInfo = {
      name: 'Nova',
      avatar: 'nova.png',
      description: 'Friends with {{user}}.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, nova],
      seraphina,
      undefined,
      undefined,
      'swap'
    );

    expect(textOf(ctx)).toContain('Friends with User.');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });
});

describe('buildGroupConversationContext — AC2: scenario fallback is macro-substituted', () => {
  it('substitutes {{user}} in the fallback scenario (no scenarioOverride)', () => {
    const speaker: CharacterInfo = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      scenario: 'A quiet cafe with {{user}}.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [speaker, marcus],
      speaker
    );

    expect(textOf(ctx)).toContain('Current scenario: A quiet cafe with User.');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  it("leaves scenarioOverride's char-scrubbing semantics alone", () => {
    // Regression guard for the brief's explicit "do not change" instruction:
    // the override path scrubs char-specific fields, so {{char}} inside an
    // override must render empty, not the speaker's name.
    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcus],
      seraphina,
      'Scene starring {{char}}.'
    );

    expect(textOf(ctx)).toContain('Current scenario: Scene starring .');
  });
});

describe('buildGroupConversationContext — AC3: speaker mes_example substituted in swap mode', () => {
  it('substitutes {{user}} in the current speaker mes_example block', () => {
    const speaker: CharacterInfo = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      mes_example: 'Example with {{user}}.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [speaker, marcus],
      speaker,
      undefined,
      undefined,
      'swap'
    );

    expect(textOf(ctx)).toContain(
      'Example dialogue for Seraphina:\nExample with User.'
    );
  });
});

describe('buildGroupConversationContext — AC4: group author\'s note substitution + trim guard', () => {
  it('substitutes the author\'s note at the in-loop depth match', () => {
    useChatStore.setState({
      authorNotes: {
        [CHAT_FILE]: { content: 'Remember {{user}}.', depth: 1, role: 'system' },
      },
    });

    const ctx = buildGroupConversationContext(
      [mkMsg('first'), mkMsg('second')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Remember User.');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  it('trim-guards a macro-only author\'s note at the in-loop depth match', () => {
    const messages = [mkMsg('first'), mkMsg('second')];
    const baseline = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina
    );

    useChatStore.setState({
      authorNotes: {
        [CHAT_FILE]: { content: '{{setvar::anGuardA::1}}', depth: 1, role: 'system' },
      },
    });
    const ctx = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina
    );

    // The guard must have suppressed the now-empty note entirely — no extra
    // (blank) context entry versus the no-note baseline.
    expect(ctx.length).toBe(baseline.length);
    expect(ctx.every((c) => c.content.trim() !== '')).toBe(true);
    // The macro still ran (its write survives) even though its rendered
    // content was withheld from the prompt.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).anGuardA).toBe('1');
  });

  it('substitutes the author\'s note at the overflow (depth > history) site', () => {
    useChatStore.setState({
      authorNotes: {
        [CHAT_FILE]: { content: 'Remember {{user}}.', depth: 5, role: 'system' },
      },
    });

    const ctx = buildGroupConversationContext(
      [mkMsg('only message')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Remember User.');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  it('trim-guards a macro-only author\'s note at the overflow site', () => {
    const messages = [mkMsg('only message')];
    const baseline = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina
    );

    useChatStore.setState({
      authorNotes: {
        [CHAT_FILE]: { content: '{{setvar::anGuardB::1}}', depth: 5, role: 'system' },
      },
    });
    const ctx = buildGroupConversationContext(
      messages,
      [seraphina, marcus],
      seraphina
    );

    expect(ctx.length).toBe(baseline.length);
    expect(ctx.every((c) => c.content.trim() !== '')).toBe(true);
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).anGuardB).toBe('1');
  });
});

describe('buildGroupConversationContext — AC5+AC6: history turns substituted; blank user-turn guard', () => {
  it('substitutes a history turn and applies the [Name]: prefix after substitution', () => {
    const ctx = buildGroupConversationContext(
      [mkMsg('hello {{user}}', false, 'Marcus')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('[Marcus]: hello User');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  it('skips a user turn whose post-macro content is blank and has no images', () => {
    const ctx = buildGroupConversationContext(
      [mkMsg('{{setvar::skipMarker::1}}', true, 'User')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx.some((c) => c.role === 'user')).toBe(false);
    // The macro still ran even though the (now-empty) turn was dropped.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).skipMarker).toBe('1');
  });

  it('keeps an image-only user turn even though its post-macro text is blank', () => {
    const imageMsg = {
      ...mkMsg('{{setvar::skipMarker2::1}}', true, 'User'),
      images: ['data:image/png;base64,AAAA'],
    } as ChatMessage;

    const ctx = buildGroupConversationContext(
      [imageMsg],
      [seraphina, marcus],
      seraphina
    );

    const userTurn = ctx.find((c) => c.role === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn?.content).toBe('');
  });
});

describe('buildGroupConversationContext — AC7: variables map is shared and written exactly once', () => {
  it('persists {{setvar}} writes from BOTH a world-info entry and a member card field', () => {
    const wiEntry = mkEntry({ constant: true, content: '{{setvar::wiVar::1}}' });
    useBooks([mkBook([wiEntry])]);
    const nova: CharacterInfo = {
      name: 'Nova',
      avatar: 'nova.png',
      description: '{{setvar::cardVar::2}}',
    } as CharacterInfo;

    buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, nova],
      seraphina,
      undefined,
      undefined,
      'join'
    );

    const vars = useChatStore.getState().getChatVariables(CHAT_FILE);
    expect(vars.wiVar).toBe('1');
    expect(vars.cardVar).toBe('2');
  });

  it('increments a variable exactly once per rendered occurrence, not twice', () => {
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { count: '0' } } });
    const nova: CharacterInfo = {
      name: 'Nova',
      avatar: 'nova.png',
      description: '{{incvar::count}}',
    } as CharacterInfo;

    buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, nova],
      seraphina,
      undefined,
      undefined,
      'join'
    );

    // A double-substitution bug (the same occurrence run through
    // processMacros twice) would land this at '2', not '1'.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).count).toBe('1');
  });
});

describe('buildGroupConversationContext — AC8: {{char}} inside a member\'s own card block is member-relative', () => {
  it("resolves {{char}} in a non-speaking member's own description to that member, not the speaker", () => {
    const marcusWithCharMacro: CharacterInfo = {
      name: 'Marcus',
      avatar: 'marcus.png',
      description: 'I am {{char}}.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcusWithCharMacro],
      seraphina,
      undefined,
      undefined,
      'join'
    );

    expect(textOf(ctx)).toContain('I am Marcus.');
    expect(textOf(ctx)).not.toContain('I am Seraphina.');
  });

  it("resolves {{description}} inside a member's own personality to that member's own description", () => {
    const marcusSelfRef: CharacterInfo = {
      name: 'Marcus',
      avatar: 'marcus.png',
      description: 'A stern knight.',
      personality: 'Known for: {{description}}',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcusSelfRef],
      seraphina,
      undefined,
      undefined,
      'join'
    );

    expect(textOf(ctx)).toContain('Known for: A stern knight.');
  });

  it('keeps {{char}} speaker-relative OUTSIDE per-member card blocks (world info)', () => {
    const speakerTag = mkEntry({
      constant: true,
      content: 'Speaker is {{char}}.',
    });
    useBooks([mkBook([speakerTag])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Speaker is Seraphina.');
    expect(textOf(ctx)).not.toContain('Speaker is Marcus.');
  });
});
