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

const { buildGroupConversationContext, useChatStore } = await import('./chatStore');
const { useWorldInfoStore, DEFAULT_ENTRY } = await import('./worldInfoStore');
const { useCharacterStore } = await import('./characterStore');
const { usePersonaStore } = await import('./personaStore');
const { useSettingsStore } = await import('./settingsStore');
const { api } = await import('../api/client');

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

  it('resolves the fallback scenario through getCharacterField (deliberate, reviewed change)', () => {
    // Round 2, ACCEPT-AND-PIN. Sharing ONE substituted string between the card
    // block and the `Current scenario:` line meant both sites had to resolve the
    // field the same way, so the fallback moved from
    //   `currentCharacter.scenario || currentCharacter.data?.scenario || ''`
    // to `getCharacterField(currentCharacter, 'scenario')`. That is not a no-op:
    // for a card whose top-level `scenario` is whitespace-only and whose
    // `data.scenario` is real, the OLD expression took the whitespace (it is
    // truthy) and emitted `Current scenario:` followed by blanks; the NEW one
    // skips whitespace-only values and emits data.scenario. The new behavior is
    // what the join card block already emitted for that same card and what solo
    // does at :1186, and emitting whitespace was never intended. Reviewed and
    // accepted rather than reverted — this test pins the CHOSEN behavior.
    const splitCard = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      scenario: '   ',
      data: { scenario: 'The library at dusk.' },
    } as unknown as CharacterInfo;

    const text = textOf(
      buildGroupConversationContext([mkMsg('hi')], [splitCard, marcus], splitCard)
    );

    expect(text).toContain('Current scenario: The library at dusk.');
    // The pre-E9-S6 expression emitted the whitespace instead.
    expect(text).not.toMatch(/^Current scenario: +$/m);
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

  it('prefers characterAvatar over a `name` that matches a DIFFERENT member', () => {
    // Round 2. Every other fixture in this suite has msg.name agreeing with the
    // roster, so the name fallback covered for the avatar branch and deleting
    // the branch outright left every group test green. Here the two DISAGREE,
    // which is exactly the case avatar-first exists for: the member was renamed
    // after this turn was stored, so `name` is the stale display string and the
    // avatar is the durable identity. Marcus's avatar under Seraphina's stored
    // name; Seraphina is also the speaker, so BOTH fallbacks would say
    // Seraphina — resolving to Marcus can only come from the avatar branch.
    const renamedTurn = {
      ...mkMsg('I am {{char}}.', false, 'Seraphina'),
      characterAvatar: 'marcus.png',
    } as ChatMessage;

    const ctx = buildGroupConversationContext(
      [renamedTurn],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('[Seraphina]: I am Marcus.');
    expect(textOf(ctx)).not.toContain('I am Seraphina.');
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

describe('review-fix A: the image exemption is per-TURN, not per-build', () => {
  // Round 2. `attachmentsFolded` is one fact about the whole build, but the
  // exemption is evaluated per message, so it used to keep EVERY blank
  // image-carrying user turn in the last-30 window. api.generateMessage folds
  // the caller's attachments into ONE turn — the last message with role 'user',
  // found by a backwards scan at client.ts:1485-1507 — so every older kept turn
  // shipped `{ role: 'user', content: '' }` with nothing ever folded into it.
  const imgUser = (content: string, b64: string) =>
    ({
      ...mkMsg(content, true, 'User'),
      images: [`data:image/png;base64,${b64}`],
    }) as ChatMessage;

  it('DROPS an older blank image turn even when this build folds attachments', () => {
    // The reproduction from the re-review: two image-carrying user turns, the
    // older one blank. Only the newest can receive the fold.
    const ctx = buildGroupConversationContext(
      [
        imgUser('', 'AAAA'),
        mkMsg('a reply', false, 'Marcus'),
        imgUser('what about this one', 'BBBB'),
      ],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    // Nothing empty ships. Without the index condition the older turn survives
    // as `{ role: 'user', content: '' }` and this is the assertion that catches it.
    expect(ctx.every((c) => c.content.trim() !== '')).toBe(true);
    const userTurns = ctx.filter((c) => c.role === 'user');
    expect(userTurns.map((c) => c.content)).toEqual(['what about this one']);
  });

  it('still KEEPS the newest blank image turn when it is not the only message', () => {
    // The other side of the index condition: it must not over-drop. This turn
    // IS the one client.ts folds into, so it has to survive even though the
    // history in front of it is what makes the index non-trivial.
    const ctx = buildGroupConversationContext(
      [
        mkMsg('earlier line', true, 'User'),
        mkMsg('a reply', false, 'Marcus'),
        imgUser('', 'BBBB'),
      ],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    const userTurns = ctx.filter((c) => c.role === 'user');
    expect(userTurns.map((c) => c.content)).toEqual(['earlier line', '']);
    // And it is the LAST user-role entry, i.e. the one the backwards fold scan
    // in client.ts will land on.
    const lastUserIdx = ctx.map((c) => c.role).lastIndexOf('user');
    expect(ctx[lastUserIdx].content).toBe('');
  });

  it('KEEPS a blank image turn that is the last USER turn but not the last message', () => {
    // Round 3. The two tests above cannot tell `i === lastUserIndexInRecent`
    // from `i === recentMessages.length - 1`: in both fixtures the newest
    // message IS the user's, so the two expressions agree and the length-based
    // mutant is silent. It is not harmless — it drops the attachment carrier
    // in any round where a member has already replied, which is the ordinary
    // state of a group chat.
    //
    // This is the forceGroupMemberTalk shape: imagesFromLastUserMessage
    // (chatStore.ts:2969) scans BACKWARDS for the last user message, so the
    // build really does carry this turn's attachment even though an assistant
    // turn sits after it — and client.ts's own backwards `lastUserIdx` scan
    // will fold into it. Dropping it loses the image.
    const ctx = buildGroupConversationContext(
      [imgUser('', 'AAAA'), mkMsg('a reply', false, 'Marcus')],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    const userTurns = ctx.filter((c) => c.role === 'user');
    expect(userTurns.map((c) => c.content)).toEqual(['']);
    expect(ctx.map((c) => c.role)).toEqual(['system', 'user', 'assistant']);
  });
});

describe('review-fix B: after_an world info is joined BEFORE the history loop', () => {
  // Round 2. FIX 3 moved the card block above three of the four non-depth WI
  // joins; after_an was still joined at its emission site, after the history
  // loop. Solo joins all four at chatStore.ts:1276-1283 and only then runs its
  // history loop at :1476, so group inverted solo for this one position: a
  // {{setvar}} in a history turn was visible to a {{getvar}} in after_an lore
  // in group and not in solo.
  it('does NOT let a history-turn write reach an after_an {{getvar}}', () => {
    const afterAnEntry = mkEntry({
      constant: true,
      position: 'after_an',
      content: 'Seen [{{getvar::histVar}}].',
    });
    useBooks([mkBook([afterAnEntry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('Look {{setvar::histVar::yes}} here')],
      [seraphina, marcus],
      seraphina
    );

    expect(textOf(ctx)).toContain('Seen [].');
    expect(textOf(ctx)).not.toContain('Seen [yes].');
    // The write itself still happened — this is an ordering claim, not a claim
    // that the history turn's macros stopped running.
    expect(useChatStore.getState().getChatVariables(CHAT_FILE).histVar).toBe('yes');
  });

  it('emits the after_an block in the same place as before (layout untouched)', () => {
    // FIX B moves COMPUTATION only. The push stays at the post-history slot.
    const afterAnEntry = mkEntry({
      constant: true,
      position: 'after_an',
      content: 'Tail lore.',
    });
    useBooks([mkBook([afterAnEntry])]);

    const ctx = buildGroupConversationContext(
      [mkMsg('hello'), mkMsg('a reply', false, 'Marcus')],
      [seraphina, marcus],
      seraphina
    );

    expect(ctx[ctx.length - 1]).toEqual({ role: 'system', content: 'Tail lore.' });
    expect(ctx.map((c) => c.role)).toEqual(['system', 'user', 'assistant', 'system']);
  });

  it('drops the now-empty after_an render out of the fired set as well', () => {
    // Round 3. "Layout untouched" above is a claim about SLOT ORDER, not about
    // emitted bytes: moving the join changes what an after_an entry renders TO,
    // so an entry that is nothing but a {{getvar}} of a history-turn write now
    // renders empty, its system message disappears from the prompt entirely,
    // and joinWi never records it in wiRendered — so it leaves `fired` too.
    // That is solo's behavior and the point of the fix, but it is a real change
    // to `wi_fired` telemetry (captureWiFired -> recordWiFired -> header.wi_fired
    // -> storyIngest/wiReplay), so it is pinned rather than left to a comment.
    // Restoring the old join position turns 'Seen [yes].'-style content back on
    // and reddens this.
    const afterAnEntry = mkEntry({
      constant: true,
      position: 'after_an',
      content: '{{getvar::histVar}}',
    });
    useBooks([mkBook([afterAnEntry])]);

    const wiOut = {
      currentTurn: 1,
      timers: {} as Record<string, number>,
      activated: new Set<string>(),
      fired: undefined as unknown,
    };

    const ctx = buildGroupConversationContext(
      [mkMsg('Look {{setvar::histVar::yes}} here')],
      [seraphina, marcus],
      seraphina,
      undefined,
      undefined,
      undefined,
      wiOut as never
    );

    expect(wiOut.fired as unknown[]).toEqual([]);
    expect(textOf(ctx)).not.toContain('yes');
    // Only the last emitted slot could have carried it, and nothing was pushed.
    expect(ctx.map((c) => c.role)).toEqual(['system', 'user']);
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

describe('review-fix C: the PRODUCTION call site passes the real attachmentsFolded', () => {
  // Round 2. The builder's behavior was pinned but its wiring was not:
  // neutralizing generateGroupTurn's `attachmentsFolded` argument left the whole
  // suite green, because the parameter DEFAULTS to `true`. So a test that only
  // exercises the true direction proves nothing about the wiring — a removed
  // argument still reads as `true`. These two drive the real
  // forceGroupMemberTalk -> generateGroupTurn -> api.generateMessage path and
  // differ in ONE input, the active model, whose only effect on this fixture is
  // whether `imagesFromLastUserMessage` returns images for the call site's
  // `Boolean(images && images.length > 0)` to read.
  //
  // Round 3: that pair alone is NOT enough. `activeModel` is also what drives
  // supportsVision, so on those two fixtures "carries images" and "can see
  // images" always agree, and swapping the production expression for
  // `supportsVision(provider, model)` passes both while reintroducing the
  // original FIX 4 bug. The third test below is the discriminator: a
  // vision-capable model on a speaker that genuinely receives no attachments —
  // the later-speaker-in-a-round case FIX 4 exists for. It drives
  // sendGroupMessage rather than forceGroupMemberTalk because that per-speaker
  // withholding is where the two answers come apart in production.
  //
  // currentChatFile is deliberately null: forceGroupMemberTalk's finally-block
  // flush is gated on it, so the whole saveChatToBackend path stays out of the
  // test, and buildGroupConversationContext's chat-variable persistence is a
  // no-op. Neither is under test here.
  const blankImageTurn = () =>
    ({
      ...mkMsg('', true, 'User'),
      images: ['data:image/png;base64,AAAA'],
    }) as ChatMessage;

  /** Run one forced group turn and return the context handed to the API. */
  const contextSentWithModel = async (model: string) => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockResolvedValue(null);
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: model });
    useChatStore.setState({
      currentChatFile: null,
      isSending: false,
      messages: [blankImageTurn()],
      groupChats: [],
    });

    await useChatStore
      .getState()
      .forceGroupMemberTalk(seraphina, [seraphina, marcus]);

    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0] as { role: string; content: string }[];
  };

  // A round that streams to completion reaches recordTurnUsage -> the usage
  // store's persist middleware, which writes localStorage UNGUARDED (unlike
  // saveWiTimers' try/catch). This runtime's global `localStorage` is an inert
  // `{}` — Node's Web Storage needs --localstorage-file — so `setItem` is not a
  // function and the throw is swallowed by sendGroupMessage's catch, ending the
  // round after one speaker. Same in-memory Storage the store suites use
  // (chatLoreConfigStore.test.ts et al), installed only for this describe and
  // restored after so the rest of the file keeps the runtime it was written for.
  const realLocalStorage = globalThis.localStorage;
  class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    clear(): void {
      this.store.clear();
    }
  }

  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  });

  afterEach(() => {
    globalThis.localStorage = realLocalStorage;
    vi.restoreAllMocks();
  });

  it('passes TRUE when this turn really carries the attachments', async () => {
    // gpt-4o is a vision model, so imagesFromLastUserMessage resolves the
    // stored attachment and generateGroupTurn hands it to api.generateMessage.
    // The blank carrier turn therefore has to survive.
    const sent = await contextSentWithModel('gpt-4o');

    const userTurns = sent.filter((c) => c.role === 'user');
    expect(userTurns.map((c) => c.content)).toEqual(['']);
  });

  it('passes FALSE when this turn carries no attachments', async () => {
    // gpt-4 is not a vision model, so imagesFromLastUserMessage returns
    // undefined, nothing is folded, and the carrier turn must be dropped rather
    // than shipping an empty content block. This is the direction that catches a
    // removed/hardcoded-true argument, since the parameter's default is `true`.
    const sent = await contextSentWithModel('gpt-4');

    expect(sent.some((c) => c.role === 'user')).toBe(false);
    expect(sent.every((c) => c.content.trim() !== '')).toBe(true);
  });

  /** One SSE content frame, as the generation proxy emits them. A real stream
   *  is needed here (not a null return) because generateGroupTurn bails on a
   *  null stream and sendGroupMessage's round loop breaks with it — the second
   *  speaker is the whole point of the test below. */
  const sseOnce = (text: string): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
          )
        );
        controller.close();
      },
    });
  };

  it('passes FALSE for the SECOND speaker of a round on a VISION model', async () => {
    // The discriminating case. gpt-4o CAN see images, and the round really does
    // carry one — but sendGroupMessage hands `resolvedImages` to the first
    // speaker only ("We'd re-send the same bytes to each character otherwise",
    // chatStore.ts:4685-4696). So for speaker two, supportsVision says TRUE and
    // "this call carries images" says FALSE, and only the second is the right
    // answer: nothing will be folded into that build, so a blank carrier turn
    // left in it ships `{ role: 'user', content: '' }` and 400s Claude.
    //
    // Mutating the production expression at chatStore.ts:2399 to
    // `supportsVision(provider, model)` passes both tests above and reddens
    // exactly this one.
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => sseOnce('[emotion:neutral] ok'));
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4o' });
    useChatStore.setState({
      currentChatFile: null,
      isSending: false,
      messages: [],
      groupChats: [],
    });

    // Empty text + one attachment: the image-only send ChatInput permits.
    // No groupChats record, so the activation strategy falls back to 'list' —
    // every member speaks once, in order.
    await useChatStore
      .getState()
      .sendGroupMessage('', [seraphina, marcus], ['data:image/png;base64,AAAA']);

    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0][0] as { role: string; content: string }[];
    const second = spy.mock.calls[1][0] as { role: string; content: string }[];

    // Speaker one DOES carry the attachment, so the blank carrier survives for
    // client.ts to fold into.
    expect(spy.mock.calls[0][6]).toHaveLength(1);
    expect(first.filter((c) => c.role === 'user').map((c) => c.content)).toEqual(['']);

    // Speaker two carries nothing, so the same blank turn must be dropped.
    expect(spy.mock.calls[1][6]).toBeUndefined();
    expect(second.some((c) => c.role === 'user')).toBe(false);
    expect(second.every((c) => c.content.trim() !== '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E9-S6 SCOPE WIDENING (authorized by Sammy after the review round). Two
// defects the review found and the PM had deferred as pre-existing are fixed
// here instead. Same standard as everything above: each test below was
// mutation-verified against the production code it names.
// ---------------------------------------------------------------------------

describe("scope-widening 1: a scenarioOverride shares the build's variables map", () => {
  // The override branch builds its own inline MacroContext (to scrub {{char}},
  // which is ambiguous in a group) and used to omit `variables` along with the
  // char-specific fields. {{getvar}} therefore always rendered empty and
  // {{setvar}} writes were computed and dropped — on this path only.

  it('reads a seeded chat variable through {{getvar}} in an override', () => {
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { mood: 'furious' } } });

    const text = textOf(
      buildGroupConversationContext(
        [mkMsg('hi')],
        [seraphina, marcus],
        seraphina,
        'The room is {{getvar::mood}}.'
      )
    );

    expect(text).toContain('Current scenario: The room is furious.');
  });

  it('persists a {{setvar}} written from inside an override', () => {
    // The half a `{ ...variables }` copy would fail: a copy makes the write
    // visible for the rest of the build and then loses it at the
    // setChatVariables persist, so only this assertion separates "same object
    // reference" from "a copy that looked like it worked".
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: {} } });

    buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcus],
      seraphina,
      'A cellar.{{setvar::place::cellar}}'
    );

    expect(useChatStore.getState().getChatVariables(CHAT_FILE).place).toBe('cellar');
  });

  it("makes an override's write visible to a world-info {{getvar}} in the SAME build", () => {
    // Pins the ORDER decision as well as the shared reference: the override is
    // substituted after the card blocks and BEFORE the joinWi calls, so lore
    // reads the value this build wrote rather than the previous build's.
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { place: 'nowhere' } } });
    useBooks([
      mkBook([mkEntry({ constant: true, content: 'They meet at [{{getvar::place}}].' })]),
    ]);

    const text = textOf(
      buildGroupConversationContext(
        [mkMsg('hi')],
        [seraphina, marcus],
        seraphina,
        'A cellar.{{setvar::place::cellar}}'
      )
    );

    expect(text).toContain('They meet at [cellar].');
    expect(text).not.toContain('They meet at [nowhere].');
  });

  it("sees a card field's write from earlier in the same build", () => {
    // The other side of the ordering decision: card blocks are computed above
    // the scenario branch, so an override's {{getvar}} reads a card-field
    // {{setvar}} from this build, not the last one.
    const host = {
      name: 'Seraphina',
      avatar: 'seraphina.png',
      description: '{{setvar::mood::furious}}A calm host.',
    } as CharacterInfo;
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { mood: 'calm' } } });

    const text = textOf(
      buildGroupConversationContext(
        [mkMsg('hi')],
        [host, marcus],
        host,
        'The room is {{getvar::mood}}.'
      )
    );

    expect(text).toContain('Current scenario: The room is furious.');
    expect(text).not.toContain('Current scenario: The room is calm.');
  });

  it('runs an override write macro exactly once per build', () => {
    // {{setvar}} in an override is a REAL persisted write now, so the
    // exactly-once claim has to be pinned here too: the override branch is the
    // `if` half of an if/else and nothing downstream re-substitutes the
    // resulting string.
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { day: '0' } } });

    const ctx = buildGroupConversationContext(
      [mkMsg('hi')],
      [seraphina, marcus],
      seraphina,
      'Day {{incvar::day}}.'
    );

    expect(useChatStore.getState().getChatVariables(CHAT_FILE).day).toBe('1');
    expect(textOf(ctx)).toContain('Current scenario: Day 1.');
    expect(ctx.filter((c) => c.content.includes('Day 1.')).length).toBe(1);
  });

  it('still scrubs {{char}} while sharing the variables map', () => {
    // The cheapest wrong fix is to delete the inline context and reuse
    // subSpeaker's, which would hand the override a `variables` map AND the
    // speaker's identity. This is the same assertion as the AC2 test above,
    // repeated here so the widened-scope section fails on its own if someone
    // takes that shortcut.
    useChatStore.setState({ chatVariables: { [CHAT_FILE]: { mood: 'furious' } } });

    const text = textOf(
      buildGroupConversationContext(
        [mkMsg('hi')],
        [seraphina, marcus],
        seraphina,
        '{{char}} is {{getvar::mood}}.'
      )
    );

    // The override result is trimmed, so the empty {{char}} leaves one space
    // rather than two — the point is that no name lands there.
    expect(text).toContain('Current scenario: is furious.');
    expect(text).not.toContain('Seraphina is furious.');
  });
});
