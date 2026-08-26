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
  // Renamed from 'substitutes a history turn and applies the [Name]: prefix
  // after substitution'. This fixture only ever proved the FIRST half: with an
  // ordinary member name, substitute-then-prefix and prefix-then-substitute
  // emit the identical string, so the ordering claim in the old title was not
  // pinned by anything. The ordering assertion now lives in its own test below,
  // with a fixture that can actually tell the two orders apart.
  it('substitutes a history turn and prefixes it with its author name', () => {
    const ctx = buildGroupConversationContext(
      [mkMsg('hello {{user}}', false, 'Marcus')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('[Marcus]: hello User');
    expect(textOf(ctx)).not.toContain('{{user}}');
  });

  // E9-S6 review-fix (FIX 6c): the ordering test that actually bites. The
  // `[Name]: ` label is assembled from raw stored data, so if the prefix were
  // applied BEFORE substitution the label itself would be fed to processMacros
  // and a member whose name contains macro-looking text would have it executed.
  // Substitute-then-prefix leaves the label untouched. That difference is
  // observable; a plain name's is not.
  it('applies the [Name]: prefix AFTER substitution, so a macro-shaped name is never executed', () => {
    const ctx = buildGroupConversationContext(
      [mkMsg('hello {{user}}', false, '{{user}}Bot')],
      [seraphina, marcus],
      seraphina
    );

    // Content substituted, label left verbatim.
    expect(textOf(ctx)).toContain('[{{user}}Bot]: hello User');
    // Prefix-then-substitute would have emitted this instead.
    expect(textOf(ctx)).not.toContain('[UserBot]:');
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

// ---------------------------------------------------------------------------
// E9-S6 REVIEW-FIX ROUND. Everything below pins a defect the 45-agent
// adversarial review found in the first cut of this story, or a gap it found in
// the first cut of this suite. Each one is mutation-verified: the production
// behavior it names was broken, the test was watched go red, and the break was
// reverted.
// ---------------------------------------------------------------------------

describe('review-fix 1: the speaker scenario is substituted exactly ONCE per build', () => {
  // In join mode the speaker's scenario reaches the prompt twice: once in the
  // speaker's own card block (`Scenario: …`) and once in the shared
  // `Current scenario: …` line. Substituting the field at each site ran every
  // write macro inside it twice per build. Split into two tests so both halves
  // of the symptom — the runaway counter and the two disagreeing renderings in
  // one prompt — fail visibly and independently.
  //
  // cardMode is explicit in both: DEFAULT_GROUP_CARD_MODE is 'swap', whose card
  // block emits no scenario at all, so the default never reaches the two-site
  // branch these tests exist for.
  const buildWithCountingScenario = () => {
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { day: '0' } } });
    const speaker: CharacterInfo = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      scenario: 'Day {{incvar::day}}',
    } as CharacterInfo;
    return buildGroupConversationContext(
      [mkMsg('hi')],
      [speaker, marcus],
      speaker,
      undefined,
      undefined,
      'join'
    );
  };

  it('runs the scenario write macro once per build, not once per emission site', () => {
    buildWithCountingScenario();
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).day).toBe('1');
  });

  it('does not execute the scenario at all when no site renders it (swap + override)', () => {
    // The other half of "exactly once": in swap mode with a scenarioOverride
    // neither the card block nor the `Current scenario:` line carries the
    // speaker's own scenario, so its write macros must not run. An eager
    // shared const would trade the double-execution bug for a phantom one.
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { day: '0' } } });
    const speaker: CharacterInfo = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      scenario: 'Day {{incvar::day}}',
    } as CharacterInfo;

    buildGroupConversationContext(
      [mkMsg('hi')],
      [speaker, marcus],
      speaker,
      'An override scene.',
      undefined,
      'swap'
    );

    expect(useChatStore.getState().getChatVariables(CHAT_FILE).day).toBe('0');
  });

  it('emits a byte-identical value at the card-block and Current-scenario sites', () => {
    const text = textOf(buildWithCountingScenario());
    const cardScenario = text.match(/^Scenario: (.*)$/m)?.[1];
    const currentScenario = text.match(/^Current scenario: (.*)$/m)?.[1];
    expect(cardScenario).toBe('Day 1');
    expect(currentScenario).toBe(cardScenario);
  });
});

describe('review-fix 2: history turns substitute against their AUTHOR', () => {
  it("resolves a stored assistant turn's macros against its author, not the current speaker", () => {
    // The reported bleed: Marcus's stored greeting rendered under Marcus's own
    // label but with Seraphina's identity, and the SAME stored line rendered
    // differently depending on who spoke next.
    const marcusGreeting = {
      ...mkMsg('*{{char}} looks up as {{user}} walks in.*', false, 'Marcus'),
      characterAvatar: 'marcus.png',
    } as ChatMessage;

    const ctx = buildGroupConversationContext(
      [marcusGreeting],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('[Marcus]: *Marcus looks up as User walks in.*');
    expect(textOf(ctx)).not.toContain('*Seraphina looks up');
  });

  it('falls back to a name match when the turn predates characterAvatar', () => {
    // Chats written before ChatMessage.characterAvatar existed carry only the
    // author's display name.
    const legacyTurn = mkMsg('I am {{char}}.', false, 'Marcus');
    expect(legacyTurn.characterAvatar).toBeUndefined();

    const ctx = buildGroupConversationContext(
      [legacyTurn],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('[Marcus]: I am Marcus.');
  });

  it('falls back to the speaker (never throws, never undefined) when the author left the room', () => {
    const orphanTurn = {
      ...mkMsg('I am {{char}}.', false, 'Nobody'),
      characterAvatar: 'departed.png',
    } as ChatMessage;

    expect(() =>
      buildGroupConversationContext([orphanTurn], [seraphina, marcus], seraphina)
    ).not.toThrow();

    const ctx = buildGroupConversationContext(
      [orphanTurn],
      [seraphina, marcus],
      seraphina
    );
    expect(textOf(ctx)).toContain('[Nobody]: I am Seraphina.');
  });

  it('keeps USER turns speaker-relative', () => {
    // {{char}} in a line the user typed means "the character I'm talking to",
    // which in a group is whoever is about to speak.
    // The persona is deliberately named after a MEMBER: with a non-colliding
    // name the author lookup falls through to the speaker anyway, so dropping
    // the `msg.isUser` branch would be invisible. Personas are free-text, so a
    // persona sharing a member's name is a real configuration.
    const ctx = buildGroupConversationContext(
      [mkMsg('Tell me, {{char}}.', true, 'Marcus')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Tell me, Seraphina.');
    expect(textOf(ctx)).not.toContain('Tell me, Marcus.');
  });
});

describe('review-fix 3: card fields substitute BEFORE world info, matching solo', () => {
  it('makes a card-field {{setvar}} visible to a world-info {{getvar}} in the SAME build', () => {
    // Group used to render world info first, so a card-field write landed one
    // stage too late: build 1 read the old (empty) value and every later build
    // stayed exactly one behind, never self-correcting. Solo emits the fresh
    // value on build 1.
    const moodEntry = mkEntry({
      constant: true,
      content: 'Mood is [{{getvar::mood}}].',
    });
    useBooks([mkBook([moodEntry])]);
    const host: CharacterInfo = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      description: '{{setvar::mood::furious}}A calm host.',
    } as CharacterInfo;

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [host, marcus],
      host,
      undefined,
      undefined,
      'join'
    );

    expect(textOf(ctx)).toContain('Mood is [furious].');
    expect(textOf(ctx)).not.toContain('Mood is [].');
  });
});

describe("review-fix 4: the blank-user-turn image exemption tracks whether THIS build folds the attachments", () => {
  const imageOnlyMsg = () =>
    ({
      ...mkMsg('{{setvar::imgGuard::1}}', true, 'User'),
      images: ['data:image/png;base64,AAAA'],
    }) as ChatMessage;

  it('KEEPS the blank turn when this build receives the attachments', () => {
    // api.generateMessage folds the caller's images into the LAST user turn, so
    // the turn has to survive or the image gets attached to an earlier message.
    const ctx = buildGroupConversationContext(
      [imageOnlyMsg()],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    const userTurn = ctx.find((c) => c.role === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn?.content).toBe('');
  });

  it('DROPS the same blank turn when this build receives no attachments', () => {
    // sendGroupMessage passes images to the FIRST speaker of a round only, so
    // every later speaker had nothing to fold and shipped `content: ''`
    // verbatim — the empty content block that 400s Claude and then keeps
    // 400ing that speaker while the image message stays in the last 30.
    const ctx = buildGroupConversationContext(
      [imageOnlyMsg()],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );

    expect(ctx.some((c) => c.role === 'user')).toBe(false);
    expect(ctx.every((c) => c.content.trim() !== '')).toBe(true);
    // The message's macros still ran — only its (empty) rendering was withheld.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).imgGuard).toBe('1');
  });

  it('a turn with real text plus an attachment survives either way', () => {
    const withText = {
      ...mkMsg('look at this', true, 'User'),
      images: ['data:image/png;base64,AAAA'],
    } as ChatMessage;

    for (const folded of [true, false]) {
      const ctx = buildGroupConversationContext(
        [withText],
        [seraphina, marcus],
        seraphina,
        undefined,
        undefined,
        undefined,
        undefined,
        folded
      );
      expect(ctx.find((c) => c.role === 'user')?.content).toBe('look at this');
    }
  });
});

describe('review-fix 6a: every substituted card field is pinned in BOTH modes', () => {
  // C13: three of the six card fields this story substitutes had no test that
  // would go red. One test per (mode, field) pair, each using a non-speaking
  // member so the per-member substitution path is the one under test.
  const memberWith = (field: string, value: string): CharacterInfo =>
    ({ name: 'Nova', avatar: 'nova.png', [field]: value }) as CharacterInfo;

  const buildWith = (member: CharacterInfo, mode: 'join' | 'swap') =>
    textOf(
      buildGroupConversationContext(
        [mkMsg('hi')],
        [seraphina, member],
        seraphina,
        undefined,
        undefined,
        mode
      )
    );

  it('join: description', () => {
    const text = buildWith(memberWith('description', 'Friend of {{user}}.'), 'join');
    expect(text).toContain('Description: Friend of User.');
    expect(text).not.toContain('{{user}}');
  });

  it('join: personality', () => {
    const text = buildWith(memberWith('personality', 'Fond of {{user}}.'), 'join');
    expect(text).toContain('Personality: Fond of User.');
    expect(text).not.toContain('{{user}}');
  });

  it('join: scenario', () => {
    const text = buildWith(memberWith('scenario', 'Waiting for {{user}}.'), 'join');
    expect(text).toContain('Scenario: Waiting for User.');
    expect(text).not.toContain('{{user}}');
  });

  it('join: mes_example', () => {
    const text = buildWith(memberWith('mes_example', 'Nova: hello {{user}}'), 'join');
    expect(text).toContain('Example dialogue:\nNova: hello User');
    expect(text).not.toContain('{{user}}');
  });

  it('swap: description', () => {
    const text = buildWith(memberWith('description', 'Friend of {{user}}.'), 'swap');
    expect(text).toContain('Description: Friend of User.');
    expect(text).not.toContain('{{user}}');
  });

  it('swap: personality', () => {
    const text = buildWith(memberWith('personality', 'Fond of {{user}}.'), 'swap');
    expect(text).toContain('Personality: Fond of User.');
    expect(text).not.toContain('{{user}}');
  });
});

describe("review-fix 6b: the author's note runs its macros exactly once per build", () => {
  // C12: AC7's exactly-once claim was pinned for card fields only. A write
  // macro in the note is the observable version of the claim.
  it('at the in-loop depth match', () => {
    useChatStore.setState({
      chatVariables: { [CHAT_FILE]: { anRuns: '0' } },
      authorNotes: {
        [CHAT_FILE]: { content: 'Note {{incvar::anRuns}}.', depth: 1, role: 'system' },
      },
    });

    const ctx = buildGroupConversationContext(
      [mkMsg('first'), mkMsg('second')],
      [seraphina, marcus],
      seraphina
    );

    expect(useChatStore.getState().getChatVariables(CHAT_FILE).anRuns).toBe('1');
    expect(ctx.filter((c) => c.content.includes('Note 1.')).length).toBe(1);
  });

  it('at the overflow (depth > history) site', () => {
    useChatStore.setState({
      chatVariables: { [CHAT_FILE]: { anRuns: '0' } },
      authorNotes: {
        [CHAT_FILE]: { content: 'Note {{incvar::anRuns}}.', depth: 5, role: 'system' },
      },
    });

    const ctx = buildGroupConversationContext(
      [mkMsg('only message')],
      [seraphina, marcus],
      seraphina
    );

    expect(useChatStore.getState().getChatVariables(CHAT_FILE).anRuns).toBe('1');
    expect(ctx.filter((c) => c.content.includes('Note 1.')).length).toBe(1);
  });
});

describe('review-fix 6d + 7: deliberately-unfixed behaviors, pinned so they cannot be reverted silently', () => {
  // These two pin behavior this story chose NOT to change. Neither is a claim
  // that the behavior is right. If you intend to change one, change its test in
  // the same commit — that is what these exist to force.

  it('renders a blank ASSISTANT turn as "[Name]: " (known parity gap, filed separately)', () => {
    // Solo drops blank assistant turns entirely (chatStore.ts:1521-1538); group
    // emits the label, which is non-empty and so does not 400, but it does feed
    // the model an empty line under a member's name. Out of E9-S6's scope by
    // the story brief; the blank-USER guard next to it is in scope and is
    // tested above.
    const ctx = buildGroupConversationContext(
      [mkMsg('', false, 'Marcus')],
      [seraphina, marcus],
      seraphina
    );

    const assistantTurn = ctx.find((c) => c.role === 'assistant');
    expect(assistantTurn?.content).toBe('[Marcus]: ');
  });

  it('can emit a prompt whose only entry is the system message (open question)', () => {
    // P2/FIX 7. Reachable from the real UI: ChatInput gates on RAW text
    // (`message.trim().length > 0`), so a macro-only line like
    // `{{setvar::mood::calm}}` sends; in a group whose members have no
    // first_mes, startNewGroupChat leaves only an isSystem message, which the
    // history filter drops. The blank-user guard then skips the one remaining
    // turn and the request carries no user/assistant message at all.
    // NOT guarded here: solo's identical skip produces the identical shape
    // (there is no zero-turn guard anywhere in buildConversationContext), so a
    // group-only guard would create a fresh group/solo divergence in a story
    // whose purpose is closing them. Whether the SillyTavern backend's Claude
    // converter rejects or backfills an empty messages array is not knowable
    // from this repo. Flagged to the PM as a cross-builder issue.
    const ctx = buildGroupConversationContext(
      [mkMsg('{{setvar::mood::calm}}', true, 'User')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx.every((c) => c.role === 'system')).toBe(true);
    expect(ctx.some((c) => c.role === 'user' || c.role === 'assistant')).toBe(false);
  });
});
