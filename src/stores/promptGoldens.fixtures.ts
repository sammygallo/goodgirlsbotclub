/**
 * Fixtures for the golden-prompt harness (E2-S2 task 0).
 *
 * WHAT THIS FILE IS: the complete store state + build inputs for every prompt
 * the goldens pin. One exported fixture = one call to the real builder =
 * two golden files (the assembled prompt, and the `variables` map that build
 * persisted).
 *
 * WHY TYPESCRIPT AND NOT JSON: copied from
 * `src/utils/storyRender/__calibration__/fixtures.ts`. A JSON corpus rots
 * silently when a type moves under it — a `WorldInfoEntry` field renamed, a
 * `PromptSectionId` retired. Written as TypeScript, `tsc -b` fails loudly
 * instead, which is the whole reason `npm run build` is a gate on this repo
 * (PR CI does not typecheck test files; only the Dockerfile runs `tsc -b`).
 *
 * DETERMINISM RULES for anything added here:
 *   - No `{{time}}`/`{{date}}`/`{{roll}}`/`{{random}}` macros. `utils/macros.ts`
 *     resolves those against `new Date()` / `Math.random()`, so a fixture using
 *     one produces a different golden on every run.
 *   - No `Date.now()`. Every timestamp is a fixed literal.
 *   - Explicit ids everywhere (books, entries, messages). An auto-incrementing
 *     counter would make a fixture's content depend on how many fixtures ran
 *     before it.
 *   - `resetStores()` before every build, so fixture order cannot leak.
 */

import type { LucideIcon } from 'lucide-react';
import type { CharacterInfo } from '../api/client';
import type { ContextContribution } from '../extensions/types';
import type { ChatMessage, GroupCardMode } from './chatStore';
import type {
  MatchedEntry,
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoScanReport,
} from './worldInfoStore';

import { extensionRegistry } from '../extensions/registry';
import { useAuthStore } from './authStore';
import { useChatLoreConfigStore } from './chatLoreConfigStore';
import { useChatStore } from './chatStore';
import { useCharacterStore } from './characterStore';
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_PROMPT_CONFIG,
  DEFAULT_PROMPT_ORDER,
  useGenerationStore,
} from './generationStore';
import type { PromptSectionEntry, PromptSectionId } from './generationStore';
import { usePersonaStore } from './personaStore';
import { usePromptTemplateStore } from './promptTemplateStore';
import { useSelfieStore } from './selfieStore';
import { useSettingsStore } from './settingsStore';
import { useSummarizeStore } from './summarizeStore';
import { DEFAULT_ENTRY, useWorldInfoStore } from './worldInfoStore';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Every fixture builds against this chat file. */
export const GOLDEN_CHAT_FILE = 'prompt-goldens.jsonl';

/**
 * Sentinel written into `generationStore.lastTokenEstimate` by `resetStores()`.
 *
 * Solo overwrites it on BOTH paths (:1676 token-aware, :1694-1696 not), so a
 * solo golden reading -1 would mean the builder stopped reporting a total.
 * Group never writes it at all — the group goldens read -1, and that is the
 * point: it pins the brief's gotcha G (group chats display a STALE estimate
 * from the last solo send). When that is fixed, these goldens change.
 */
export const NOT_WRITTEN = -1;

/**
 * Structural twin of chatStore's module-private `WiScanOut`.
 *
 * Declared here rather than imported because the production diff for this task
 * is exactly ONE word (the `export` on chatStore.ts:966) — exporting a second
 * symbol to satisfy a test would break that. TypeScript is structural, so a
 * value of this type is accepted wherever `WiScanOut` is expected, and `tsc -b`
 * still fails loudly if the real interface gains a required field or changes a
 * type under us.
 *
 * WHY EVERY FIXTURE PASSES ONE: all six production call sites
 * (chatStore.ts:4019, :4168, :4291, :4523, :4923 solo; :2474 group) pass a real
 * `wiOut`. Round 1's fixtures all passed `undefined`, which meant the goldens
 * pinned a parameterization the app never executes and the ~40-line
 * fired/trimmedAtDepth derivation at :1704-1743 never ran once.
 */
export interface GoldenWiScanOut {
  currentTurn: number;
  timers: Record<string, number>;
  activated: Set<string>;
  fired?: MatchedEntry[];
  scanReport?: WorldInfoScanReport;
  trimmedAtDepth?: MatchedEntry[];
}

/**
 * `currentTurn` exactly as every production call site computes it — the count
 * of non-user, non-system messages in the array being handed to the builder
 * (chatStore.ts:2465-2467 and the five solo sites). Derived rather than
 * hand-written per fixture so a fixture cannot drift into a turn number the
 * app could never produce for that history.
 */
export function productionCurrentTurn(messages: ChatMessage[]): number {
  return messages.filter((m) => !m.isUser && !m.isSystem).length;
}

// ---------------------------------------------------------------------------
// Builders for the raw shapes the stores hold
// ---------------------------------------------------------------------------

export function mkChar(over: Partial<CharacterInfo>): CharacterInfo {
  return { name: 'Ivy', avatar: 'ivy.png', ...over } as CharacterInfo;
}

export function mkMsg(
  id: string,
  content: string,
  over: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    name: over.isUser === false ? 'Ivy' : 'User',
    isUser: true,
    isSystem: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
    ...over,
  } as ChatMessage;
}

export function mkEntry(id: string, over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    ...DEFAULT_ENTRY,
    id,
    content: `lore ${id}`,
    constant: true,
    keys: [],
    keysSecondary: [],
    relatedIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

export function mkBook(
  id: string,
  entries: WorldInfoEntry[],
  over: Partial<WorldInfoBook> = {}
): WorldInfoBook {
  return {
    id,
    name: `Book ${id}`,
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

// ---------------------------------------------------------------------------
// The extension contribution source
// ---------------------------------------------------------------------------

/**
 * Extension contributions the next build should see.
 *
 * A REAL registered extension rather than a mocked `runContextHooks`: the
 * registry's own `order` sort and per-extension try/catch are part of what
 * lands in `ext_*`, and a stub would pin the fixture's array instead of the
 * registry's output.
 */
let extContributions: ContextContribution[] = [];
let goldenExtensionRegistered = false;

function ensureGoldenExtension(): void {
  if (goldenExtensionRegistered) return;
  extensionRegistry.register({
    id: '__prompt_goldens__',
    displayName: 'Prompt goldens fixture source',
    description: 'Test-only: feeds ContextContributions to the golden harness.',
    version: '0.0.0',
    // Never rendered — `runContextHooks` only reads `onBuildContext`. Typed as
    // LucideIcon without importing lucide-react so this module (and therefore
    // the node-environment test that imports it) never pulls in React.
    icon: null as unknown as LucideIcon,
    defaultEnabled: true,
    onBuildContext: () => extContributions,
  });
  goldenExtensionRegistered = true;
}

function withExtensions(...items: ContextContribution[]): void {
  extContributions = items;
}

// ---------------------------------------------------------------------------
// resetStores
// ---------------------------------------------------------------------------

/**
 * Put every store either builder reads back to a known baseline.
 *
 * Called by the harness before each fixture's `setup()`, never by a fixture
 * itself — a fixture that forgot to reset would silently inherit the previous
 * one's lore, persona and promptOrder, and the resulting golden would encode
 * file order rather than the branch it claims to pin.
 */
export function resetStores(): void {
  ensureGoldenExtension();
  extContributions = [];

  useWorldInfoStore.setState({
    books: [],
    sharedBooks: [],
    activeBookIds: [],
    chatLinkedBookIds: {},
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 0,
  });
  useChatLoreConfigStore.setState({ configs: {} });
  useCharacterStore.setState({
    characters: [],
    linkedBookIdsByAvatar: {},
    selectedCharacter: null,
    groupChatCharacters: [],
    isGroupChatMode: false,
  });
  usePersonaStore.setState({
    personas: [],
    activePersonaId: null,
    locks: { byCharacter: {}, byChat: {} },
  });
  useSettingsStore.setState({
    activeProvider: 'openai',
    activeModel: 'gpt-4',
    secrets: {},
    globalSecrets: {},
    globalSharingEnabled: false,
  });
  useGenerationStore.setState({
    prompt: { ...DEFAULT_PROMPT_CONFIG },
    context: { ...DEFAULT_CONTEXT_CONFIG },
    promptOrder: DEFAULT_PROMPT_ORDER.map((e) => ({ ...e })),
    lastTokenEstimate: NOT_WRITTEN,
  });
  usePromptTemplateStore.setState({
    mainPromptSnapshot: null,
    chatCompanionModeByChatFile: {},
  });
  useSummarizeStore.setState({ summaries: {}, compactWhenSummarized: true });
  useSelfieStore.setState({ enabled: true });
  useAuthStore.setState({ currentUser: null });
  useChatStore.setState({
    currentChatFile: GOLDEN_CHAT_FILE,
    authorNotes: {},
    chatVariables: {},
    groupChats: [],
  });
}

// ---------------------------------------------------------------------------
// Small state helpers used by the fixtures below
// ---------------------------------------------------------------------------

/** Install books. `activeIds` defaults to "all of them"; pass a narrower list
 *  to leave a book inactive so only a persona/character link can pull it in. */
function withBooks(books: WorldInfoBook[], activeIds?: string[]): void {
  useWorldInfoStore.setState({
    books,
    activeBookIds: activeIds ?? books.map((b) => b.id),
  });
}

function withPersona(over: {
  description: string;
  descriptionPosition: 'in_prompt' | 'before_char' | 'after_char' | 'at_depth';
  descriptionDepth?: number;
  descriptionRole?: 'system' | 'user' | 'assistant';
  linkedBookIds?: string[];
}): void {
  usePersonaStore.setState({
    personas: [
      {
        id: 'p1',
        name: 'Wren',
        description: over.description,
        descriptionPosition: over.descriptionPosition,
        descriptionDepth: over.descriptionDepth ?? 4,
        descriptionRole: over.descriptionRole ?? 'system',
        linkedBookIds: over.linkedBookIds,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    activePersonaId: 'p1',
  });
}

function withAuthorNote(
  content: string,
  depth: number,
  role: 'system' | 'user' | 'assistant' = 'system'
): void {
  useChatStore.setState({
    authorNotes: { [GOLDEN_CHAT_FILE]: { content, depth, role } },
  });
}

/**
 * Build against a chat file other than the shared one.
 *
 * Needed by exactly the two fail-loud world-info budget fixtures: the
 * pinned-over-budget warning is suppressed after the first time it fires for a
 * chat (`wiPinnedWarnedChats`, chatStore.ts:962), and that Set is module-level
 * and never cleared — so with every fixture on one chat file, the FIRST
 * over-budget build would be the only one to reach the branch and the second
 * builder's copy of it (:1884-1895) would never execute at all.
 *
 * The harness reads the persisted variables back off `currentChatFile`, not
 * off the constant, so this stays transparent to the goldens.
 */
function withChatFile(fileName: string): void {
  useChatStore.setState({ currentChatFile: fileName });
}

function withContext(over: Partial<typeof DEFAULT_CONTEXT_CONFIG>): void {
  useGenerationStore.setState({ context: { ...DEFAULT_CONTEXT_CONFIG, ...over } });
}

function withPromptOrder(
  mutate: (order: PromptSectionEntry[]) => PromptSectionEntry[]
): void {
  useGenerationStore.setState({
    promptOrder: mutate(DEFAULT_PROMPT_ORDER.map((e) => ({ ...e }))),
  });
}

/** Turn the selfie safety gate's preconditions on for a fixture.
 *  Sets up the state a genuinely cleared character has — it does not weaken
 *  any check: provenance, permission and key are all still evaluated. */
function withSelfieEligible(character: CharacterInfo): void {
  useCharacterStore.setState({
    selectedCharacter: character,
    characters: [character],
    isGroupChatMode: false,
  });
  useAuthStore.setState({
    currentUser: {
      handle: 'golden',
      name: 'Sam',
      role: 'end_user',
      permissions: ['generation:image'],
    },
  });
  useSettingsStore.setState({
    secrets: { api_key_replicate: [{ id: 'k1', label: 'golden', active: true }] },
  });
}

/** `n` alternating turns of predictable bulk, for the trim fixtures. */
function bulkHistory(n: number, wordsPerTurn: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    const isUser = i % 2 === 0;
    out.push(
      mkMsg(`b${i}`, `Turn ${i}. ${'ledger '.repeat(wordsPerTurn).trim()}`, {
        isUser,
        name: isUser ? 'User' : 'Ivy',
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

export interface SoloInput {
  messages: ChatMessage[];
  character: CharacterInfo;
  availableEmotions?: string[];
  ragContext?: string;
  /**
   * Seeded WI timer state (entry id -> the turn it last activated on), handed
   * to the builder inside the `wiTimerOut` the harness always constructs.
   * Production loads this from `loadWiTimers(chatFile)`.
   */
  wiTimers?: Record<string, number>;
  /**
   * Pre-resolved activation result from the server retrieval path. When set,
   * chatStore.ts:1080 takes the `serverMatchedEntries ??` branch and the local
   * `scanMessagesForEntries` call never runs.
   */
  serverMatchedEntries?: MatchedEntry[];
}

/**
 * Macro counters a fixture declares, asserted by name in the harness.
 *
 * `counters` must each read exactly `'1'` after the build; `absentCounters`
 * must not exist in the persisted map at all (text nothing emitted must not
 * have executed).
 *
 * WHY `{{incvar}}`/`{{addvar}}` AND NEVER `{{setvar}}`: setvar is IDEMPOTENT.
 * Writing the same literal twice is byte-identical to writing it once, so a
 * setvar canary is structurally incapable of detecting double execution — the
 * exact thing these fixtures exist to detect. `{{incvar::k}}` counts AND emits
 * its new value into the prompt; `{{addvar::k::1}}` counts and renders to ''
 * (macros.ts:442-453), which is what the blank-content guards need.
 */
export interface MacroCounters {
  counters?: string[];
  absentCounters?: string[];
}

export interface SoloFixture extends MacroCounters {
  /** Golden file stem. */
  name: string;
  /** Matrix id from the task-0 spec, so a reviewer can map the two. */
  matrix: string;
  /** One line: what this fixture exists to pin. */
  what: string;
  /** chatStore.ts anchors the fixture walks. */
  pins: string;
  setup: () => SoloInput;
}

export interface GroupInput {
  messages: ChatMessage[];
  characters: CharacterInfo[];
  currentCharacter: CharacterInfo;
  scenarioOverride?: string;
  ragContext?: string;
  cardMode?: GroupCardMode;
  attachmentsFolded?: boolean;
  wiTimers?: Record<string, number>;
}

export interface GroupFixture extends MacroCounters {
  name: string;
  matrix: string;
  what: string;
  pins: string;
  setup: () => GroupInput;
}

/** Reuse another fixture's setup BY NAME. An array index would silently
 *  re-point at a different fixture the moment one is inserted above it, and
 *  the golden that depended on it would keep passing while pinning something
 *  else entirely. Split in two rather than made generic so the return type
 *  stays concrete — `tsc -b` cannot infer it through the fixture interface. */
function reuseSolo(name: string): SoloInput {
  const fx = SOLO_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`promptGoldens: no solo fixture named "${name}"`);
  return fx.setup();
}

function reuseGroup(name: string): GroupInput {
  const fx = GROUP_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`promptGoldens: no group fixture named "${name}"`);
  return fx.setup();
}

// ---------------------------------------------------------------------------
// Reusable card material
// ---------------------------------------------------------------------------

const IVY_MINIMAL = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  description: 'A quiet archivist who never throws anything away.',
});

const IVY_FULL = mkChar({
  name: 'Ivy',
  avatar: 'ivy.png',
  avatar_provenance: 'fictional-declared',
  description: 'A quiet archivist who never throws anything away.',
  personality: 'Dry, exact, allergic to small talk.',
  scenario: 'The reading room, an hour after closing.',
  mes_example: '<START>\n{{user}}: Is it late?\n{{char}}: *does not look up* It is always late here.',
  system_prompt: 'You are Ivy, keeper of the closed stacks.',
  post_history_instructions: '[Keep replies under four sentences.]',
});

const HELLO: ChatMessage[] = [mkMsg('m1', 'Hello.')];

// ---------------------------------------------------------------------------
// SOLO fixtures
// ---------------------------------------------------------------------------

export const SOLO_FIXTURES: SoloFixture[] = [
  {
    name: 'minimal',
    matrix: 'S1',
    what: 'The baseline: default promptOrder, no lore, no persona, one turn.',
    pins: ':1285-1322 sectionContent, :1327-1338 Stage A',
    setup: () => ({ messages: HELLO, character: IVY_MINIMAL }),
  },

  {
    name: 'all-sections',
    matrix: 'S2',
    what:
      'Every pre-history section non-empty EXCEPT persona_after_char (see ' +
      'persona-after-char — the two persona slots are mutually exclusive), ' +
      'plus all four Stage-C sections. Also carries three deliberate details: ' +
      'a persona-LINKED book that is not globally active (so only the ' +
      'persona-book union can pull it in, and its entry gets the user-context ' +
      'wrapper), a world-info entry ending in a blank line and a jailbreak ' +
      'padded with spaces (both stages push content UNTRIMMED), and a macro ' +
      'inside an extension contribution (extension text is NOT substituted).',
    pins:
      ':1046 persona-book union, :1133-1136 persona wrapper, :1285-1322 all 18 keys, ' +
      ':1336-1338 the untrimmed push + join, :1684-1690 Stage C',
    counters: [],
    // joinExt emits `c.content` verbatim (:1178-1181) — an extension is a
    // third-party contributor, and running its text through the chat's macro
    // engine would let it write the user's chat variables. Absent here is the
    // pin on that; the literal survives in the prompt golden.
    absentCounters: ['extRaw'],
    setup: () => {
      withPersona({
        description: 'A night-shift cataloguer with ink on both cuffs.',
        descriptionPosition: 'before_char',
        linkedBookIds: ['b-persona-linked'],
      });
      withBooks(
        [
          mkBook('b-pos', [
            // Trailing blank line is deliberate: wrapWiContent returns the
            // substituted content untrimmed, joinWi joins it untrimmed, and
            // :1336 pushes the section untrimmed. `.trim()` anywhere along
            // that path shows up here.
            mkEntry('e-bc', { content: 'Lore: the stacks run four floors down.\n\n', position: 'before_char' }),
            mkEntry('e-ac', { content: 'Lore: the catalogue is not alphabetical.', position: 'after_char' }),
            mkEntry('e-ba', { content: 'Lore: the lift only stops on even floors.', position: 'before_an' }),
            mkEntry('e-aa', { content: 'Lore: nobody signs the ledger out.', position: 'after_an' }),
          ]),
          mkBook('b-persona-linked', [
            mkEntry('e-persona-linked', {
              content: 'Wren keeps the night key on a bootlace.',
              position: 'before_char',
            }),
          ]),
        ],
        // b-persona-linked is deliberately NOT active. It reaches the scan
        // only through `personaBookIds` (:1046), and its entry only gets the
        // "[Information about …, the user you're talking to]" header because
        // `personaBookIdSet` recognises it (:1133-1136).
        ['b-pos']
      );
      withExtensions(
        { content: '[ext] before_char contribution — {{incvar::extRaw}} stays literal', role: 'system', position: 'before_char' },
        { content: '[ext] after_char contribution', role: 'system', position: 'after_char' },
        { content: '[ext] before_an contribution', role: 'system', position: 'before_an' },
        { content: '[ext] after_an contribution', role: 'system', position: 'after_an' }
      );
      useGenerationStore.setState({
        prompt: {
          ...DEFAULT_PROMPT_CONFIG,
          postHistoryInstructions: '[User PHI: end on an image, not a question.]\n',
          jailbreakPrompt: '  [Jailbreak: the padding spaces are deliberate.]  ',
        },
      });
      withSelfieEligible(IVY_FULL);
      return {
        messages: HELLO,
        character: IVY_FULL,
        availableEmotions: ['joy', 'sadness', 'curiosity'],
        ragContext: '[Earlier in chat — User]\nI asked about the closed stacks.',
      };
    },
  },

  {
    name: 'promptorder-reordered-two-disabled',
    matrix: 'S3',
    what:
      'The all-sections state with emotion_instruction hoisted to the top and ' +
      'two sections disabled — one pre-history (jailbreak), one Stage C ' +
      '(char_phi). all-sections now sets a non-default jailbreakPrompt, so ' +
      'disabling it is actually observable here; before that it was a no-op ' +
      'and this fixture only ever pinned the Stage-C half of the filter.',
    pins: ':1328-1332 pre-history filter, :1684-1688 Stage-C filter',
    absentCounters: ['extRaw'],
    setup: () => {
      // Reuses all-sections' whole state, jailbreak included.
      const input = reuseSolo('all-sections');
      withPromptOrder((order) => {
        const disabled = new Set<PromptSectionId>(['jailbreak', 'char_phi']);
        const emotion = order.find((e) => e.id === 'emotion_instruction')!;
        const rest = order.filter((e) => e.id !== 'emotion_instruction');
        return [emotion, ...rest].map((e) =>
          disabled.has(e.id) ? { ...e, enabled: false } : e
        );
      });
      return input;
    },
  },

  {
    name: 'empty-system-block',
    matrix: 'S4',
    what:
      'Every pre-history section disabled. The Stage-A push at :1335 is ' +
      'unconditional, so the prompt still opens with an EMPTY system message. ' +
      "Also carries a macro-only author's note at DEPTH 0, which renders to " +
      "'' and must be swallowed by the depth-0 blank guard — an empty content " +
      'block 400s Claude.',
    pins: ':1327-1338 the unconditional push (audit §4.4), :1556-1562 depth-0 AN blank guard',
    counters: ['anGuardRuns'],
    setup: () => {
      withPromptOrder((order) =>
        order.map((e) =>
          e.id === 'char_phi' || e.id === 'user_phi' || e.id === 'wi_after_an' || e.id === 'ext_after_an'
            ? e
            : { ...e, enabled: false }
        )
      );
      // {{addvar}} rather than {{incvar}}: addvar returns '' (macros.ts:453),
      // so the note still renders blank and still exercises the guard, while
      // the counter makes the RUN COUNT observable. A pure {{setvar}} could
      // not: writing the same literal twice is byte-identical to writing it
      // once, so a setvar-only guard fixture cannot detect double execution.
      withAuthorNote('{{setvar::anGuard::depth-0}}{{addvar::anGuardRuns::1}}', 0);
      return { messages: HELLO, character: IVY_MINIMAL };
    },
  },

  {
    name: 'trim-bites',
    matrix: 'S5',
    what:
      'A long chat against a small budget: the token-aware trim drops older ' +
      'turns. A NON-critical world-info entry sits at a deep at-depth slot so ' +
      'the trim cuts it after the scan passed it — the only fixture that puts ' +
      'anything in `wiTimerOut.trimmedAtDepth`.',
    pins: ':1644-1681 trimHistoryToBudget, kept-set object identity, :1737-1743 trimmedAtDepth',
    setup: () => {
      withContext({ maxTokens: 1600, responseReserve: 256, tokenAware: true });
      withBooks([
        mkBook('b-trim', [
          mkEntry('e-trim-deep', {
            content: 'Lore at depth 20 — old enough that the trim reaches it.',
            position: 'at_depth',
            depth: 20,
          }),
        ]),
      ]);
      return { messages: bulkHistory(24, 20), character: IVY_MINIMAL };
    },
  },

  {
    name: 'trim-overbudget',
    matrix: 'S6',
    what:
      'A critical at-depth entry (pinned, never evictable) plus an oversized ' +
      'newest turn against a 256-token floor: remaining goes negative and ' +
      'overBudget comes back true.',
    pins: ':1648-1665 pinnedMessages, :1676 overBudget, tokenizer.ts:180',
    setup: () => {
      withContext({ maxTokens: 512, responseReserve: 256, tokenAware: true });
      withBooks([
        mkBook('b-crit', [
          mkEntry('e-crit', {
            content: 'CRITICAL: the ledger must never leave the reading room.',
            position: 'at_depth',
            depth: 1,
            critical: true,
          }),
        ]),
      ]);
      const history = bulkHistory(6, 15);
      history.push(
        mkMsg('big', `And finally: ${'ledger '.repeat(400).trim()}`, { isUser: true })
      );
      return { messages: history, character: IVY_MINIMAL };
    },
  },

  {
    name: 'token-aware-off',
    matrix: 'S7',
    what:
      'tokenAware off: history is a fixed message-count window and the token ' +
      'estimate comes from the NON-token-aware path, which counts Stage C. ' +
      'TWO of the last five raw messages are SYSTEM turns, and :1350 slices ' +
      'the raw list BEFORE filtering them out — so a five-message window ' +
      'emits three turns. Group got a dedicated fixture for that ordering; ' +
      'solo had none, and filtering before slicing was green. (It cannot be ' +
      'folded into fixed-window-summary-skew: once a summary is present the ' +
      'offset rebase makes the KEPT COUNT algebraically independent of the ' +
      'window size, so the two orderings produce the same tail.)',
    pins: ':1345-1350 slice-before-filter, :1678-1680 else-branch, :1694-1696 estimateConversationTokens',
    setup: () => {
      withContext({ tokenAware: false, messageCount: 5 });
      useGenerationStore.setState({
        prompt: { ...DEFAULT_PROMPT_CONFIG, postHistoryInstructions: '[User PHI: stay in the room.]' },
      });
      const messages = bulkHistory(9, 6);
      // Indices 6 and 8 — both inside the last five raw slots (4..8).
      for (const i of [6, 8]) {
        messages[i] = mkMsg(`b${i}`, `[system marker ${i}]`, {
          isUser: false,
          isSystem: true,
          name: 'System',
        });
      }
      return { messages, character: IVY_FULL };
    },
  },

  {
    name: 'at-depth-interleave',
    matrix: 'S8',
    what:
      'All five at-depth classes at ONE depth: character note, author note, ' +
      'persona, world info, extension — in the documented order. Every ' +
      'insertion carries a NON-system role from a user-settable field ' +
      "(CharacterEdit's depth_prompt role, AuthorNote's ROLE_OPTIONS, the " +
      "persona's descriptionRole, the extension's own role) and no two " +
      'classes share one, so rewriting any of them to a literal shows up here.',
    pins: ':1480-1523 in-loop insertion order and roles',
    counters: ['depthPromptRuns', 'note', 'wiDepthInLoop'],
    // Extension at-depth content is pushed RAW at :1520 while world info at
    // the same depth is substituted — this is the pin on that asymmetry.
    absentCounters: ['extRawAtDepth'],
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: {
          extensions: {
            depth_prompt: {
              prompt: '[Character note at depth 2, pass {{incvar::depthPromptRuns}}.]',
              depth: 2,
              role: 'user',
            },
          },
        },
      });
      withAuthorNote("[Author's note at depth 2, pass {{incvar::note}}.]", 2, 'assistant');
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 2,
        descriptionRole: 'user',
      });
      withBooks([
        mkBook('b-depth', [
          mkEntry('e-d2', {
            content: 'Lore at depth 2, pass {{incvar::wiDepthInLoop}}.',
            position: 'at_depth',
            depth: 2,
          }),
        ]),
      ]);
      // `ContextContribution.role` is 'system' | 'user' — an extension
      // contribution can never be an assistant turn (extensions/types.ts:19),
      // so the four `{ role: c.role }` sites rotate between those two across
      // the three at-depth fixtures instead of all three roles.
      withExtensions({
        content: '[ext] at depth 2 — {{incvar::extRawAtDepth}} stays literal',
        role: 'user',
        position: 'at_depth',
        depth: 2,
      });
      return {
        messages: [mkMsg('d1', 'First.'), mkMsg('d2', 'Second.', { isUser: false, name: 'Ivy' }), mkMsg('d3', 'Third.')],
        character: char,
      };
    },
  },

  {
    name: 'at-depth-zero',
    matrix: 'S9',
    what:
      'All five at-depth classes at depth 0 — the trailing slot after the ' +
      'newest turn. Roles are rotated against at-depth-interleave (depth ' +
      "prompt system, author's note user, persona assistant, extension user) " +
      'so no single literal role satisfies both fixtures.',
    pins: ':1548-1588 depth-0 branches and roles',
    counters: ['depthPromptRuns', 'anDepthZero', 'wiDepthZero'],
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: {
          extensions: {
            depth_prompt: {
              prompt: '[Character note at depth 0, pass {{incvar::depthPromptRuns}}.]',
              depth: 0,
              role: 'system',
            },
          },
        },
      });
      withAuthorNote("[Author's note at depth 0, pass {{incvar::anDepthZero}}.]", 0, 'user');
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 0,
        descriptionRole: 'assistant',
      });
      withBooks([
        mkBook('b-depth0', [
          mkEntry('e-d0', {
            content: 'Lore at depth 0, pass {{incvar::wiDepthZero}}.',
            position: 'at_depth',
            depth: 0,
          }),
        ]),
      ]);
      withExtensions({
        content: '[ext] at depth 0',
        role: 'user',
        position: 'at_depth',
        depth: 0,
      });
      return {
        messages: [mkMsg('z1', 'First.'), mkMsg('z2', 'Second.', { isUser: false, name: 'Ivy' })],
        character: char,
      };
    },
  },

  {
    name: 'at-depth-overflow',
    matrix: 'S10',
    what:
      'Every at-depth class configured deeper than the history, including TWO ' +
      'world-info depths, so the unshift order is pinned. Roles rotate again ' +
      "(depth prompt assistant, author's note system, persona user, extension " +
      'system — extension roles are system|user only): across the three ' +
      'at-depth fixtures every one of the twelve role-carrying sites is ' +
      'checked, and no uniform rewrite to a single literal survives.',
    pins: ':1591-1641 overflow unshifts and roles',
    counters: ['depthPromptRuns', 'anOverflow', 'wiDepthOverflow', 'wiDepthOverflowB'],
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: {
          extensions: {
            depth_prompt: {
              prompt: '[Character note, depth 9, pass {{incvar::depthPromptRuns}}.]',
              depth: 9,
              role: 'assistant',
            },
          },
        },
      });
      withAuthorNote("[Author's note, depth 8, pass {{incvar::anOverflow}}.]", 8, 'system');
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 7,
        descriptionRole: 'user',
      });
      withBooks([
        mkBook('b-of', [
          // One counter per DEPTH, not one shared: the overflow loop calls
          // joinWi once per depth key (:1616), so a shared counter would read
          // '2' on a correct build and hide the very thing it checks for.
          mkEntry('e-d10', {
            content: 'Lore at depth 10, pass {{incvar::wiDepthOverflow}}.',
            position: 'at_depth',
            depth: 10,
          }),
          mkEntry('e-d11', {
            content: 'Lore at depth 11, pass {{incvar::wiDepthOverflowB}}.',
            position: 'at_depth',
            depth: 11,
          }),
        ]),
      ]);
      withExtensions({
        content: '[ext] at depth 12',
        role: 'system',
        position: 'at_depth',
        depth: 12,
      });
      return {
        messages: [mkMsg('o1', 'First.'), mkMsg('o2', 'Second.', { isUser: false, name: 'Ivy' })],
        character: char,
      };
    },
  },

  {
    name: 'image-only-and-blank-assistant',
    matrix: 'S11',
    what:
      'The blank-content fixture. An image-only user turn (kept, and it ships ' +
      'EMPTY content) next to a blank assistant turn (dropped); a character ' +
      "note that renders to WHITESPACE ONLY (pushed anyway — the in-loop " +
      'guard at :1481 tests `depthPromptContent`, not `.trim()`); and a ' +
      "macro-only author's note at the same depth that renders to '' and IS " +
      'swallowed by its own guard, which tests `.trim()`. The two guards ' +
      'disagree on purpose and both are pinned here.',
    pins: ':1481 depth-prompt guard, :1490-1497 in-loop AN blank guard, :1531-1540 image-only keep',
    counters: ['depthPromptRuns', 'anGuardRuns'],
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: {
          extensions: {
            depth_prompt: {
              // Renders to '    ' — truthy, so :1481 pushes it. Tightening
              // that guard to `.trim()` drops a whole context entry.
              prompt: '  {{addvar::depthPromptRuns::1}}  ',
              depth: 2,
              role: 'system',
            },
          },
        },
      });
      withAuthorNote('{{setvar::anGuard::in-loop}}{{addvar::anGuardRuns::1}}', 2);
      return {
        messages: [
          mkMsg('i1', 'Look at this.'),
          mkMsg('i2', '', { isUser: false, name: 'Ivy' }),
          mkMsg('i3', '', { isUser: true, images: ['data:image/png;base64,iVBORw0KGgo='] }),
        ],
        character: char,
      };
    },
  },

  {
    name: 'macro-writes',
    matrix: 'S12',
    what:
      'THE DOUBLE-EXECUTION CANARY. A DISTINCT {{incvar}} counter at every ' +
      'macro-executed input the solo builder has outside the at-depth stages ' +
      '(which the three at-depth fixtures cover): all four card fields, the ' +
      "card's system_prompt and post_history_instructions, all three " +
      "generation-settings prompts, the character note, a world-info entry, " +
      "the author's note, and BOTH a user and an assistant history turn. Each " +
      'counter emits its returned value into the prompt, so a second ' +
      'execution of any stage shows up twice — as a changed number in the ' +
      'prompt golden and as a changed count in the variables golden. `stage` ' +
      'records execution ORDER: card fields, world info, the note, history.',
    pins:
      ':1131 wrapWiContent, :1183-1216 card + generation-settings fields, ' +
      ':1425 depth prompt, :1490-1497 author note, :1524 history turns',
    counters: [
      'day',
      'shelf',
      'scenarioSub',
      'mesExampleSub',
      'charSysPrompt',
      'charPhiSub',
      'userMainPrompt',
      'userPhiSub',
      'userJailbreak',
      'depthPromptRuns',
      'ledger',
      'note',
      'soloUserTurn',
      'soloAsstTurn',
    ],
    setup: () => {
      const char = mkChar({
        name: 'Ivy',
        avatar: 'ivy.png',
        description:
          'A quiet archivist. Day {{incvar::day}} of the audit.{{setvar::stage::card}}',
        personality: 'Dry. Shelf {{incvar::shelf}}.',
        scenario: 'The reading room, pass {{incvar::scenarioSub}}.',
        mes_example: '<START>\n{{user}}: Late?\n{{char}}: Always. Take {{incvar::mesExampleSub}}.',
        system_prompt: 'You are Ivy, keeper of the closed stacks. Draft {{incvar::charSysPrompt}}.',
        post_history_instructions: '[Keep replies short. Reminder {{incvar::charPhiSub}}.]',
        data: {
          extensions: {
            depth_prompt: {
              prompt: '[Character note, pass {{incvar::depthPromptRuns}}.]',
              depth: 2,
              role: 'system',
            },
          },
        },
      });
      // `userMainPrompt` is substituted unconditionally at :1214 and then
      // LOSES the mainPrompt precedence chain to the card's system_prompt
      // (:1257-1261). Its counter still reads 1 — that is the point: a macro
      // that executes for text the prompt never shows still writes the user's
      // chat variables, and only a counter makes it visible.
      useGenerationStore.setState({
        prompt: {
          ...DEFAULT_PROMPT_CONFIG,
          mainPrompt: 'You are {{char}}. Main prompt render {{incvar::userMainPrompt}}.',
          postHistoryInstructions: '[User PHI render {{incvar::userPhiSub}}.]',
          jailbreakPrompt: '[Jailbreak render {{incvar::userJailbreak}}.]',
        },
      });
      withBooks([
        mkBook('b-macro', [
          mkEntry('e-macro', {
            content:
              'The stacks smell of dust. Ledger line {{incvar::ledger}}.{{setvar::stage::worldinfo}}',
            position: 'before_char',
          }),
        ]),
      ]);
      withAuthorNote(
        "[Author's note: day {{getvar::day}}, ledger {{getvar::ledger}}, note {{incvar::note}}.{{setvar::stage::authornote}}]",
        1
      );
      return {
        messages: [
          mkMsg('mw1', 'Hello — user turn {{incvar::soloUserTurn}}.'),
          mkMsg('mw2', '*looks up* Assistant turn {{incvar::soloAsstTurn}}.{{setvar::stage::history}}', {
            isUser: false,
            name: 'Ivy',
          }),
        ],
        character: char,
      };
    },
  },

  {
    name: 'recall-present',
    matrix: 'S13',
    what: 'ragContext supplied — the rag_context section renders its wrapper.',
    pins: ':1305-1307 rag_context (the phase boundary task 1b splits at)',
    setup: () => ({
      messages: HELLO,
      character: IVY_MINIMAL,
      ragContext:
        '[Earlier in chat — User]\nWhere is the ledger kept?\n\n---\n\n[Earlier in chat — Character]\nBehind the grille.',
    }),
  },

  {
    name: 'recall-absent',
    matrix: 'S13',
    what:
      'Same build with no ragContext — rag_context renders empty and is ' +
      "filtered out. Also carries a macro-only author's note at an OVERFLOW " +
      'depth (5 > 1 message), the third and last of solo\'s three blank-AN ' +
      'guards.',
    pins: ':1305-1307 / :1330-1332, :1603-1610 overflow AN blank guard',
    counters: ['anGuardRuns'],
    setup: () => {
      withAuthorNote('{{setvar::anGuard::overflow}}{{addvar::anGuardRuns::1}}', 5);
      return { messages: HELLO, character: IVY_MINIMAL };
    },
  },

  // --- SHOULD tier -------------------------------------------------------

  {
    name: 'persona-after-char',
    matrix: 'SHOULD: persona positions',
    what:
      'The 14th pre-history section, unreachable from all-sections: persona ' +
      'position after_char fills persona_after_char and leaves ' +
      'persona_before_char empty.',
    pins: ':1287-1290 / :1295-1298',
    setup: () => {
      withPersona({
        description: 'A night-shift cataloguer with ink on both cuffs.',
        descriptionPosition: 'after_char',
      });
      return { messages: HELLO, character: IVY_MINIMAL };
    },
  },

  {
    name: 'persona-in-prompt',
    matrix: 'SHOULD: persona positions',
    what:
      'Position in_prompt. personaBlock IS computed at :1266 but no section ' +
      'key emits it, so the description reaches nothing. This golden pins ' +
      'that drop deliberately — when it is fixed, this file changes.',
    pins: ':1263-1271 personaBlock vs :1287-1290 persona_before_char',
    setup: () => {
      withPersona({
        description: 'A night-shift cataloguer with ink on both cuffs.',
        descriptionPosition: 'in_prompt',
      });
      return { messages: HELLO, character: IVY_MINIMAL };
    },
  },

  {
    name: 'pure-chat-mode',
    matrix: 'SHOULD: pure-chat-mode + char_phi branch 1',
    what:
      'Companion mode: scenario and example dialogue withheld from the card ' +
      'block, the TWO leading assistant turns trimmed off the front of ' +
      'history, and char_phi replaced by the no-narration style note. A ' +
      'summary covering the first 10 turns is present, so `pureChatRemoved` ' +
      'is non-zero AND is actually subtracted from the compaction offset — ' +
      'the rebase at :1409 that a ~25-line comment attributes to a bug that ' +
      'shipped zero-conversation-message requests and got 400s from ' +
      'Anthropic. Numbers are chosen so the MIN_RAW_TAIL cap does NOT bind: ' +
      'offset 10-2=8 keeps 12 turns, and dropping the rebase would keep 10.',
    pins:
      ':1195-1199 pureChatMode, :1240-1247 charInfoParts, :1314-1318 char_phi, ' +
      ':1367-1372 greeting trim, :1406-1409 pureChatRemoved rebase',
    setup: () => {
      usePromptTemplateStore.setState({
        chatCompanionModeByChatFile: { [GOLDEN_CHAT_FILE]: true },
      });
      useSummarizeStore.setState({
        compactWhenSummarized: true,
        summaries: {
          [GOLDEN_CHAT_FILE]: {
            text: 'Ivy and the user talked past closing.',
            generatedAt: 0,
            messageCount: 10,
          },
        },
      });
      const messages: ChatMessage[] = [
        mkMsg('g0', '*The reading room is dark but for one lamp.*', { isUser: false, name: 'Ivy' }),
        mkMsg('g1', '*She does not look up.*', { isUser: false, name: 'Ivy' }),
      ];
      for (let i = 0; i < 20; i++) {
        const isUser = i % 2 === 0;
        messages.push(
          mkMsg(`g${i + 2}`, `Line ${i}.`, { isUser, name: isUser ? 'User' : 'Ivy' })
        );
      }
      return { messages, character: IVY_FULL };
    },
  },

  {
    name: 'linked-style-active',
    matrix: 'SHOULD: linked-style + char_phi branch 2',
    what:
      'A linked style template is active: the user main prompt beats the ' +
      "card's system_prompt, and char_phi becomes the style reinforcement " +
      "instead of the card's post-history instructions.",
    pins: ':1189-1191 linkedStyleActive, :1257-1261 mainPrompt, :1314-1318 char_phi',
    setup: () => {
      usePromptTemplateStore.setState({ mainPromptSnapshot: 'snapshot of the user prompt' });
      useGenerationStore.setState({
        prompt: { ...DEFAULT_PROMPT_CONFIG, mainPrompt: 'You are {{char}}. Answer in exactly two sentences.' },
      });
      return { messages: HELLO, character: IVY_FULL };
    },
  },

  {
    name: 'summary-compaction-floor',
    matrix: 'SHOULD: summary compaction at MIN_RAW_TAIL',
    what:
      'A summary that claims to cover the whole chat: compaction is clamped ' +
      'by the MIN_RAW_TAIL=6 floor rather than emptying history.',
    pins: ':1406-1419 cappedOffset / MIN_RAW_TAIL',
    setup: () => {
      useSummarizeStore.setState({
        compactWhenSummarized: true,
        summaries: {
          [GOLDEN_CHAT_FILE]: {
            text: 'Ivy showed the user the closed stacks.',
            generatedAt: 0,
            messageCount: 40,
          },
        },
      });
      return { messages: bulkHistory(12, 5), character: IVY_MINIMAL };
    },
  },

  {
    name: 'hidden-messages',
    matrix: 'SHOULD: hidden-message filter',
    what:
      'A hidden turn reaches neither the history nor the {{lastusermessage}} ' +
      'macro, and does not consume a fixed-window slot.',
    pins: ':993-997 visibleMessages, :1345-1350 historyPool',
    setup: () => {
      withAuthorNote('[Last user message was: {{lastusermessage}}]', 1);
      return {
        messages: [
          mkMsg('h1', 'Visible one.'),
          mkMsg('h2', 'Answer.', { isUser: false, name: 'Ivy' }),
          mkMsg('h3', 'SECRET — hidden from the model.', { hidden: true }),
        ],
        character: IVY_MINIMAL,
      };
    },
  },

  // --- ROUND 2: gaps a 68-agent adversarial review proved -----------------

  {
    name: 'wi-scan-options',
    matrix: 'R2: C10 — the world-info scan option bag',
    what:
      'The only fixture whose entries are NOT all `constant: true`. Six ' +
      'entries exercise the option bag handed to scanMessagesForEntries: a ' +
      'keyword entry that matches; the same keyword with a narrow per-entry ' +
      'scanDepth so the match falls outside its window; an entry blocked by ' +
      'its cooldown against a seeded timer; a sticky carry-over that matches ' +
      'nothing this turn and rides in on its timer anyway; an entry still ' +
      'inside its delay; and a probability-gated entry at 0% (deterministic — ' +
      'Math.random()*100 < 0 is never true). The .fired.txt golden is where ' +
      'the outcome is legible, including that the sticky carry-over does NOT ' +
      'appear in `activated`.',
    pins:
      ':1082-1093 the option bag, worldInfoStore.ts:1420-1427 timedEffectsAllow, ' +
      ':1441-1446 per-entry scanDepth, :1494-1506 sticky carry-over',
    setup: () => {
      // currentTurn is derived from the history below: 3 assistant turns -> 3.
      withBooks([
        mkBook('b-scan', [
          mkEntry('e-key-hit', {
            content: 'Lore: the grille key hangs behind the desk.',
            constant: false,
            keys: ['grille'],
          }),
          mkEntry('e-key-too-deep', {
            content: 'Lore: this should NOT fire — its keyword is out of range.',
            constant: false,
            keys: ['thurible'],
            // The store-wide scanDepth is 4, and 'thurible' IS inside that
            // window (three turns back). This entry overrides it down to 1,
            // so only the newest turn is scanned and the keyword falls
            // outside. Ignoring the per-entry override makes it fire —
            // which is the point: a fixture whose keyword sits outside BOTH
            // windows would pin nothing about the override at all.
            scanDepth: 1,
          }),
          mkEntry('e-cooldown', {
            content: 'Lore: this should NOT fire — cooling down until turn 5.',
            constant: false,
            keys: ['grille'],
            cooldown: 2,
          }),
          mkEntry('e-sticky', {
            content: 'Lore: carried over on its sticky window, not on a keyword.',
            constant: false,
            keys: ['nothing-in-this-chat'],
            sticky: 4,
          }),
          mkEntry('e-delayed', {
            content: 'Lore: this should NOT fire — delayed until turn 9.',
            constant: false,
            keys: ['grille'],
            delay: 9,
          }),
          mkEntry('e-never', {
            content: 'Lore: this should NOT fire — probability 0.',
            constant: false,
            keys: ['grille'],
            useProbability: true,
            probability: 0,
          }),
        ]),
      ]);
      return {
        // Seeded the way loadWiTimers would return it: the turn each entry
        // last activated on. e-cooldown activated on turn 3 with cooldown 2,
        // so it is blocked while currentTurn <= 5; e-sticky activated on turn
        // 2 with sticky 4, so it carries to turn 6.
        wiTimers: { 'e-cooldown': 3, 'e-sticky': 2 },
        messages: [
          mkMsg('sc1', 'Is there a reliquary case?'),
          mkMsg('sc2', 'There was.', { isUser: false, name: 'Ivy' }),
          mkMsg('sc3', 'And the grille?'),
          // 'thurible' sits here — three turns from the end, inside the
          // store-wide scanDepth of 4 and outside e-key-too-deep's own 1.
          mkMsg('sc4', 'Locked. The thurible went with it.', { isUser: false, name: 'Ivy' }),
          mkMsg('sc5', 'Open the grille, then.'),
          mkMsg('sc6', '*sighs*', { isUser: false, name: 'Ivy' }),
        ],
        character: IVY_MINIMAL,
      };
    },
  },

  {
    name: 'wi-budget-eviction',
    matrix: 'R2: C3 — the world-info token budget',
    what:
      'A non-zero `worldInfoStore.tokenBudget`, which every other fixture ' +
      'leaves at 0 (applyTokenBudget returns early on 0 and evicts nothing). ' +
      'Two constant entries are pinned and alone exceed the budget, so ' +
      '`pinnedOverBudget` comes back true — the fail-loud signal solo raises ' +
      'at :1101-1110 and group at :1884-1895. A third, budgetable entry with ' +
      'the worst priority is evicted and lands in `scanReport.dropped`.',
    pins: ':1084 tokenBudget, worldInfoStore.ts:1319-1358 applyTokenBudget, :1101-1110 fail-loud',
    setup: () => {
      withChatFile('prompt-goldens-solo-budget.jsonl');
      useWorldInfoStore.setState({ tokenBudget: 40 });
      withBooks([
        mkBook('b-budget', [
          mkEntry('e-pinned-a', {
            content:
              'PINNED A: the reading room closes at six, the stacks at seven, ' +
              'and the grille is locked by whoever leaves last.',
            constant: true,
            order: 10,
          }),
          mkEntry('e-pinned-b', {
            content:
              'PINNED B: the catalogue cards are ordered by acquisition, never ' +
              'by title, and nobody has ever agreed to change that.',
            critical: true,
            constant: false,
            keys: ['catalogue'],
            order: 20,
          }),
          mkEntry('e-evicted', {
            content:
              'EVICTED: a low-priority note about the lift that the budget ' +
              'cannot afford once the pinned pair is counted.',
            constant: false,
            keys: ['catalogue'],
            order: 900,
          }),
        ]),
      ]);
      return {
        messages: [mkMsg('bd1', 'Where is the catalogue kept?')],
        character: IVY_MINIMAL,
      };
    },
  },

  {
    name: 'server-matched-entries',
    matrix: 'R2: C3 — the server-retrieval branch of :1080',
    what:
      'The other half of `serverMatchedEntries ?? scanMessagesForEntries(...)`, ' +
      'which three of the five production solo call sites take (:4291, :4523, ' +
      ':4923). A local book holds a constant entry that WOULD have matched; ' +
      'it must be absent from the prompt, because the local scan never runs. ' +
      'The server entries carry backend-scheme UUID ids, so `fired` reports ' +
      'ids the local store cannot resolve — exactly the case captureWiFired ' +
      'filters at :2795-2801 — and `scanReport` stays at its zeroed default ' +
      'because the server returns no eviction list.',
    pins: ':1080 the ?? branch, :1094-1110 the skipped scan report',
    setup: () => {
      withBooks([
        mkBook('b-local', [
          mkEntry('e-local', {
            content: 'LOCAL SCAN RAN — this text must never reach the prompt.',
            position: 'before_char',
          }),
        ]),
      ]);
      return {
        messages: [mkMsg('sm1', 'What does the server know?')],
        character: IVY_MINIMAL,
        serverMatchedEntries: [
          {
            entry: mkEntry('3f1c9a20-0000-4000-8000-000000000001', {
              content: 'Server lore: the annex was sealed in 1974.',
              position: 'before_char',
            }),
            bookId: '7b2e4d10-0000-4000-8000-000000000002',
            bookName: 'Server-side lorebook',
          },
          {
            entry: mkEntry('3f1c9a20-0000-4000-8000-000000000003', {
              content: 'Server lore at depth 1: the annex key is not on the ring.',
              position: 'at_depth',
              depth: 1,
            }),
            bookId: '7b2e4d10-0000-4000-8000-000000000002',
            bookName: 'Server-side lorebook',
          },
        ],
      };
    },
  },

  {
    name: 'card-overrides-disabled',
    matrix: 'R2: C21 — respectCharacterOverride / respectCharacterPHI',
    what:
      'The only fixture with either flag off. The full card ships both a ' +
      "system_prompt and post_history_instructions; with both flags false the " +
      "user's own main prompt wins the mainPrompt chain instead and char_phi " +
      'renders empty. Ignoring EITHER flag is green without this.',
    pins: ':1205-1211 the two flag gates, :1257-1261 the mainPrompt chain',
    setup: () => {
      useGenerationStore.setState({
        prompt: {
          ...DEFAULT_PROMPT_CONFIG,
          respectCharacterOverride: false,
          respectCharacterPHI: false,
          mainPrompt: "You are {{char}}. The user's own main prompt is in force.",
          postHistoryInstructions: '[User PHI: the only post-history text here.]',
        },
      });
      return { messages: HELLO, character: IVY_FULL };
    },
  },

  {
    name: 'fixed-window-summary-skew',
    matrix: 'R2: C15 + C4 — the non-token-aware window',
    what:
      'Thirty messages with three SYSTEM turns inside the last twelve, ' +
      'tokenAware off with messageCount 12, and a summary covering the first ' +
      'twenty non-system turns. Two things are pinned that nothing else ' +
      'reaches. (1) :1350 slices the last twelve RAW messages and only then ' +
      'filters system turns, so nine reach the prompt — group got a dedicated ' +
      'fixture for this, solo did not. (2) `windowSkew` is 27-9=18, so the ' +
      'compaction offset rebases to 2 and keeps seven turns; without the ' +
      'rebase the offset would be 20, the MIN_RAW_TAIL cap would clamp it to ' +
      '3, and six would remain. Every other build has windowSkew 0.',
    pins: ':1345-1350 slice-before-filter, :1359 windowSkew, :1406-1419 cappedOffset',
    setup: () => {
      withContext({ tokenAware: false, messageCount: 12 });
      useSummarizeStore.setState({
        compactWhenSummarized: true,
        summaries: {
          [GOLDEN_CHAT_FILE]: {
            text: 'The first twenty turns are already summarized.',
            generatedAt: 0,
            messageCount: 20,
          },
        },
      });
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 30; i++) {
        // 20, 24, 28 — all inside the last twelve raw slots (18..29).
        const isSystem = i >= 20 && i % 4 === 0;
        messages.push(
          mkMsg(`fw${i}`, isSystem ? `[system marker ${i}]` : `Turn ${i}.`, {
            isUser: !isSystem && i % 2 === 0,
            isSystem,
            name: isSystem ? 'System' : i % 2 === 0 ? 'User' : 'Ivy',
          })
        );
      }
      return { messages, character: IVY_MINIMAL };
    },
  },
];

// ---------------------------------------------------------------------------
// GROUP fixtures
// ---------------------------------------------------------------------------

/**
 * Shared roster. Every member's `scenario` carries {{incvar::scenarioRuns}},
 * whose persisted count is the group harness's phantom/double execution
 * canary: the speaker's scenario must render exactly ONCE per build when it is
 * emitted, and ZERO times when a scenarioOverride means nothing emits it
 * (the lazy `speakerScenario` memo at :2036-2044).
 */
const SERAPHINA = mkChar({
  name: 'Seraphina',
  avatar: 'seraphina.png',
  description: 'The room\'s host, always mid-sentence.',
  personality: 'Warm, relentless.',
  scenario: 'A back-room card game, hour {{incvar::scenarioRuns}}.',
  mes_example: '<START>\n{{char}}: *deals* Ante up.',
});

const MARCUS = mkChar({
  name: 'Marcus',
  avatar: 'marcus.png',
  description: 'Counts cards and denies it.',
  personality: 'Quiet, watchful.',
  scenario: 'Marcus never sets the scene.',
  mes_example: '<START>\n{{char}}: *says nothing*',
});

const GROUP_ROSTER = [SERAPHINA, MARCUS];

const GROUP_HELLO: ChatMessage[] = [
  mkMsg('gm1', 'Deal me in.'),
  mkMsg('gm2', '*shuffles* Sit down then.', { isUser: false, name: 'Seraphina', characterAvatar: 'seraphina.png' }),
];

function groupBase(over: Partial<GroupInput> = {}): GroupInput {
  return {
    messages: GROUP_HELLO,
    characters: GROUP_ROSTER,
    currentCharacter: SERAPHINA,
    ...over,
  };
}

export const GROUP_FIXTURES: GroupFixture[] = [
  {
    name: 'swap',
    matrix: 'G1',
    what: 'DEFAULT_GROUP_CARD_MODE: the flat one-liner-per-member roster.',
    pins: ':2076-2086 swap card block, :2213-2237 flat system template',
    setup: () => groupBase({ cardMode: 'swap' }),
  },

  {
    name: 'join',
    matrix: 'G2',
    what:
      'Join mode: a full section per member, [SPEAKING NOW] on the speaker, ' +
      'joined by \\n\\n---\\n\\n. This is also the group RECALL-PRESENT case: ' +
      'a ragContext is supplied, so the `[Relevant background information]` ' +
      'tail at :2233-2235 is appended to the flat system message. Every other ' +
      'group fixture is the recall-ABSENT case, so replacing that ternary with ' +
      '`const finalSystemPrompt = systemPrompt;` was green before this.',
    pins: ':2054-2074 join card block, :2233-2237 the RAG concat',
    setup: () =>
      groupBase({
        cardMode: 'join',
        ragContext:
          '[Earlier in chat — User]\nWho else is at the table?\n\n---\n\n' +
          '[Earlier in chat — Character]\nOnly the ones who can pay.',
      }),
  },

  {
    name: 'swap-scenario-override',
    matrix: 'G3',
    what:
      'Swap + scenarioOverride. NEITHER site renders the speaker\'s scenario, ' +
      'so `scenarioRuns` must be ABSENT from the variables golden — that ' +
      'absence is the phantom-execution guard.',
    pins: ':2036-2044 lazy speakerScenario, :2141-2155 override branch',
    setup: () =>
      groupBase({
        cardMode: 'swap',
        scenarioOverride: 'The game has moved to the roof. {{char}} deals.',
      }),
  },

  {
    name: 'join-scenario-override',
    matrix: 'G4',
    what:
      'Join + scenarioOverride: the override wins the `Current scenario:` slot ' +
      'while the speaker\'s own card block still renders their scenario, so ' +
      '`scenarioRuns` reads exactly 1.',
    pins: ':2054-2074 + :2141-2155',
    setup: () =>
      groupBase({
        cardMode: 'join',
        scenarioOverride: 'The game has moved to the roof. {{char}} deals.',
      }),
  },

  {
    name: 'blank-user-turn-folded-kept',
    matrix: 'G5',
    what:
      'attachmentsFolded true and the blank image-carrying turn IS the last ' +
      'user turn: kept, shipping empty content for client.ts to fold into.',
    pins: ':2353-2354 keepForAttachment',
    setup: () =>
      groupBase({
        attachmentsFolded: true,
        messages: [
          mkMsg('ga1', 'Deal me in.'),
          mkMsg('ga2', '*shuffles*', { isUser: false, name: 'Seraphina', characterAvatar: 'seraphina.png' }),
          mkMsg('ga3', '', { isUser: true, images: ['data:image/png;base64,iVBORw0KGgo='] }),
        ],
      }),
  },

  {
    name: 'blank-user-turn-unfolded-dropped',
    matrix: 'G6',
    what: 'Identical history, attachmentsFolded FALSE: nothing will be folded, so the blank turn is dropped.',
    pins: ':2353-2354 attachmentsFolded half of the test',
    setup: () => {
      const base = reuseGroup('blank-user-turn-folded-kept');
      return { ...base, attachmentsFolded: false };
    },
  },

  {
    name: 'blank-user-turn-not-last-dropped',
    matrix: 'G7',
    what:
      'attachmentsFolded true but the blank image-carrying turn is NOT at ' +
      'lastUserIndexInRecent — the fold cannot land on it, so it is dropped.',
    pins: ':2280-2287 lastUserIndexInRecent, :2337-2341',
    setup: () =>
      groupBase({
        attachmentsFolded: true,
        messages: [
          mkMsg('gb1', '', { isUser: true, images: ['data:image/png;base64,iVBORw0KGgo='] }),
          mkMsg('gb2', '*shuffles*', { isUser: false, name: 'Seraphina', characterAvatar: 'seraphina.png' }),
          mkMsg('gb3', 'Still in.'),
        ],
      }),
  },

  {
    name: 'blank-guards-in-loop',
    matrix: 'G8 (a)',
    what:
      'A macro-only author\'s note at the IN-LOOP depth and a world-info ' +
      'at-depth entry that renders to \'\': both write their variables and ' +
      'neither pushes a blank context entry. The {{setvar}} is what drives ' +
      'the blank-content branch; the {{addvar}} beside it is what makes the ' +
      'RUN COUNT observable — setvar alone is idempotent, so a setvar-only ' +
      'version of this fixture could not tell one execution from two, which ' +
      'is precisely what its placement implies it guards.',
    pins: ':2298-2306 in-loop AN guard, :2308-2313 wi at-depth guard',
    counters: ['gAnGuardRuns', 'gWiGuardRuns'],
    setup: () => {
      withAuthorNote('{{setvar::anGuard::inloop}}{{addvar::gAnGuardRuns::1}}', 1);
      withBooks([
        mkBook('b-blank', [
          mkEntry('e-blank', {
            content: '{{setvar::wiGuard::rendered-empty}}{{addvar::gWiGuardRuns::1}}',
            position: 'at_depth',
            depth: 2,
          }),
        ]),
      ]);
      return groupBase();
    },
  },

  {
    name: 'blank-guards-overflow',
    matrix: 'G8 (b)',
    what:
      'The same two guards on their OVERFLOW branches — the author\'s note ' +
      'and the world-info entry both configured deeper than the history — ' +
      'with the same {{addvar}} run counters.',
    pins: ':2386-2395 overflow AN guard, :2400-2408 wi overflow',
    counters: ['gAnGuardRuns', 'gWiGuardRuns'],
    setup: () => {
      withAuthorNote('{{setvar::anGuard::overflow}}{{addvar::gAnGuardRuns::1}}', 5);
      withBooks([
        mkBook('b-blank-of', [
          mkEntry('e-blank-of', {
            content: '{{setvar::wiGuard::rendered-empty}}{{addvar::gWiGuardRuns::1}}',
            position: 'at_depth',
            depth: 9,
          }),
        ]),
      ]);
      return groupBase({ messages: [mkMsg('gc1', 'Only message.')] });
    },
  },

  {
    name: 'window-slice-before-filter',
    matrix: 'G9',
    what:
      'Forty messages, five of them system turns inside the last thirty. ' +
      '.slice(-30) runs BEFORE the isSystem filter, so fewer than thirty turns ' +
      'reach the prompt.',
    pins: ':2275 slice-before-filter',
    setup: () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 40; i++) {
        const isSystem = i >= 12 && i % 6 === 0; // 12,18,24,30,36 — all inside the last 30
        messages.push(
          mkMsg(`gw${i}`, isSystem ? `[system marker ${i}]` : `Turn ${i}.`, {
            isUser: !isSystem && i % 2 === 0,
            isSystem,
            name: isSystem ? 'System' : i % 2 === 0 ? 'User' : 'Seraphina',
            characterAvatar: !isSystem && i % 2 === 1 ? 'seraphina.png' : undefined,
          })
        );
      }
      return groupBase({ messages });
    },
  },

  {
    name: 'macro-writes',
    matrix: 'G10',
    what:
      'THE GROUP DOUBLE-EXECUTION CANARY (join mode). A DISTINCT counter at ' +
      'every macro-executed input the join path has: description, personality, ' +
      'scenario and mes_example on BOTH members, the scenarioOverride, a ' +
      "world-info entry, the author's note, a USER turn and an ASSISTANT " +
      'turn. Every count must read 1. The assistant turn also pins ' +
      "authorOfTurn — its {{char}} resolves to Marcus, not the speaker — and " +
      "the author's note carries a non-system role.",
    pins:
      ':1975-1976 subMember, :2054-2074 join card block, :2143-2156 override, ' +
      ':2298-2306 author note, :2323-2326 history substitution, :2411-2413 persist',
    counters: [
      'cardSeraphina',
      'cardMarcus',
      'persSeraphina',
      'persMarcus',
      'scenarioRuns',
      'scenarioMarcus',
      'exSeraphina',
      'exMarcus',
      'wiCount',
      'anCount',
      'overrideCount',
      'userTurn',
      'asstTurn',
    ],
    setup: () => {
      const sera = mkChar({
        name: 'Seraphina',
        avatar: 'seraphina.png',
        description: 'Host. Deal {{incvar::cardSeraphina}}.',
        personality: 'Warm, take {{incvar::persSeraphina}}.',
        scenario: 'A back-room card game, hour {{incvar::scenarioRuns}}.',
        mes_example: '<START>\n{{char}}: *deals* Ante up, round {{incvar::exSeraphina}}.',
      });
      const marc = mkChar({
        name: 'Marcus',
        avatar: 'marcus.png',
        description: 'Counter. Deal {{incvar::cardMarcus}}.',
        personality: 'Quiet, take {{incvar::persMarcus}}.',
        // Only join mode renders a NON-speaker's scenario and examples
        // (:2060, :2062); swap emits description and personality only. The
        // swap counterpart fixture declares these two absent.
        scenario: 'Marcus never sets the scene, watch {{incvar::scenarioMarcus}}.',
        mes_example: '<START>\n{{char}}: *says nothing*, beat {{incvar::exMarcus}}.',
      });
      withBooks([
        mkBook('b-gmacro', [
          mkEntry('e-gmacro', {
            content: 'House rule {{incvar::wiCount}}: no talking about the game.',
            position: 'before_char',
          }),
        ]),
      ]);
      withAuthorNote("[Author's note {{incvar::anCount}}.]", 1, 'user');
      return {
        characters: [sera, marc],
        currentCharacter: sera,
        cardMode: 'join',
        scenarioOverride: 'Round {{incvar::overrideCount}} on the roof.',
        messages: [
          mkMsg('gx1', 'My turn — bet {{incvar::userTurn}}.'),
          mkMsg('gx2', '*{{char}} folds, hand {{incvar::asstTurn}}*', {
            isUser: false,
            name: 'Marcus',
            characterAvatar: 'marcus.png',
          }),
        ],
      };
    },
  },

  {
    name: 'macro-writes-swap',
    matrix: 'R2: C2 — the swap-mode macro sites',
    what:
      'The swap-mode counterpart of macro-writes. Swap emits description and ' +
      'personality only (:2078-2084), so the two members\' scenario and ' +
      'mes_example counters must be ABSENT — except the SPEAKER\'s, which ' +
      'reach the prompt by two different routes swap alone exercises: the ' +
      '`Current scenario:` fallback through speakerScenario() and the ' +
      'swap-only `mesExample = subSpeaker(...)` at :2170-2173, which join ' +
      'forces to \'\'. cardMode is mutually exclusive with the join fixture, ' +
      'so this is one of the few genuinely new builds round 2 adds.',
    pins: ':2076-2086 swap card block, :2036-2044 speakerScenario, :2170-2174 swap mesExample',
    counters: [
      'cardSeraphina',
      'cardMarcus',
      'persSeraphina',
      'persMarcus',
      'scenarioRuns',
      'exSeraphina',
      'wiCount',
      'anCount',
      'userTurn',
      'asstTurn',
    ],
    absentCounters: ['scenarioMarcus', 'exMarcus', 'overrideCount'],
    setup: () => {
      const base = reuseGroup('macro-writes');
      return { ...base, cardMode: 'swap', scenarioOverride: undefined };
    },
  },

  // --- SHOULD tier -------------------------------------------------------

  {
    name: 'author-note-depth-zero-dropped',
    matrix: 'SHOULD: pins the known #466 bug',
    what:
      'A group author\'s note at depth 0 matches NEITHER branch (the loop only ' +
      'reaches depthFromEnd >= 1, the overflow test is strictly >) and is ' +
      'dropped. Solo emits it. Pinned deliberately so the future fix arrives as ' +
      'a golden diff, not a surprise.',
    pins: ':2288-2306 loop, :2386-2395 overflow, comment at :2379-2385',
    setup: () => {
      withAuthorNote("[Author's note at depth 0 — solo would emit this.]", 0);
      return groupBase();
    },
  },

  {
    name: 'wi-attribution',
    matrix: 'SHOULD: persona-book + owned-book attribution; R2: C11/C19/C12',
    what:
      'The every-world-info-slot fixture. Attribution: one book owned by a ' +
      'non-speaking member (gets the "another character" header AND resolves ' +
      'its macros against that owner), one persona-linked (gets the user ' +
      'header), one room-shared (unlabelled). Placement: a fourth book puts ' +
      'an entry at EVERY remaining slot — after_char, before_an, after_an, ' +
      'at_depth in-loop, at_depth 0, and at_depth beyond the history — so all ' +
      'four flat-template interpolations and all three at-depth emission ' +
      'sites are pinned. Deleting the wiAfterChar or wiBeforeAn ' +
      'interpolation, or the depth-0 trailing push, was green before this.',
    pins:
      ':1978-1984 memberByOwnedBookId, :1986-2043 wrapWiContent, ' +
      ':2213-2218 the four template slots, :2308-2313 / :2371-2376 / :2400-2408 at-depth',
    counters: ['wiCount', 'gWiDepthInLoop', 'gWiDepthZero', 'gWiDepthOverflow'],
    setup: () => {
      withPersona({
        description: 'A stranger who wandered in.',
        descriptionPosition: 'before_char',
        linkedBookIds: ['b-persona'],
      });
      useWorldInfoStore.setState({
        books: [
          mkBook(
            'b-marcus',
            [mkEntry('e-marcus', { content: '{{char}} never blinks at a raise.', position: 'before_char' })],
            { ownerCharacterAvatar: 'marcus.png' }
          ),
          mkBook('b-persona', [
            mkEntry('e-persona', { content: 'Carries a losing streak and a good coat.', position: 'before_char' }),
          ]),
          mkBook('b-shared', [
            mkEntry('e-shared', {
              content: 'The back room has no clock, count {{incvar::wiCount}}.',
              position: 'before_char',
            }),
          ]),
          mkBook('b-slots', [
            mkEntry('e-after-char', { content: 'Slot after_char: the deck is short a nine.', position: 'after_char' }),
            mkEntry('e-before-an', { content: 'Slot before_an: the pot is never counted aloud.', position: 'before_an' }),
            mkEntry('e-after-an', { content: 'Slot after_an: losers leave by the stairs.', position: 'after_an' }),
            // GROUP_HELLO is two turns, so depth 1 lands in the loop, depth 0
            // in the trailing slot, and depth 9 in the overflow splice.
            mkEntry('e-depth-1', {
              content: 'Slot at_depth 1, pass {{incvar::gWiDepthInLoop}}.',
              position: 'at_depth',
              depth: 1,
            }),
            mkEntry('e-depth-0', {
              content: 'Slot at_depth 0, pass {{incvar::gWiDepthZero}}.',
              position: 'at_depth',
              depth: 0,
            }),
            mkEntry('e-depth-9', {
              content: 'Slot at_depth 9 (overflow), pass {{incvar::gWiDepthOverflow}}.',
              position: 'at_depth',
              depth: 9,
            }),
          ]),
        ],
        activeBookIds: ['b-marcus', 'b-persona', 'b-shared', 'b-slots'],
      });
      useCharacterStore.setState({ characters: GROUP_ROSTER });
      return groupBase();
    },
  },

  // --- ROUND 2 ------------------------------------------------------------

  {
    name: 'hidden-and-overflow-note',
    matrix: 'R2: C13 + C1',
    what:
      'A HIDDEN turn plus an overflow-depth author\'s note with role ' +
      "'assistant'. Three things at once: the note's role is not 'system', so " +
      'a literal rewrite at :2391 fails here; the note interpolates ' +
      '{{lastusermessage}}, which must resolve to the visible turn and never ' +
      'to the hidden one (:1770); and a keyword entry whose key appears ONLY ' +
      'in the hidden turn must not fire. The hidden turn is also the newest, ' +
      'so dropping the :2275 filter would change both the emitted history and ' +
      'every depthFromEnd in the loop.',
    pins: ':1770 visibleMessages, :2275 the hidden filter, :2386-2395 overflow AN',
    counters: ['gAnOverflow'],
    setup: () => {
      withAuthorNote(
        "[Last user message was: {{lastusermessage}} — pass {{incvar::gAnOverflow}}.]",
        9,
        'assistant'
      );
      withBooks([
        mkBook('b-hidden', [
          mkEntry('e-hidden-key', {
            content: 'LEAK: a hidden turn reached the world-info scan.',
            constant: false,
            keys: ['classified'],
          }),
        ]),
      ]);
      return groupBase({
        messages: [
          mkMsg('gh1', 'Deal me in.'),
          mkMsg('gh2', '*shuffles*', { isUser: false, name: 'Seraphina', characterAvatar: 'seraphina.png' }),
          mkMsg('gh3', 'SECRET — classified, hidden from the model.', { hidden: true }),
        ],
      });
    },
  },

  {
    name: 'wi-budget-eviction',
    matrix: 'R2: C3 — the group world-info token budget',
    what:
      'The group half of the world-info budget. Group has no history trim, so ' +
      'the WI budget is the ONLY budget it enforces — and round 1 covered ' +
      'neither the eviction nor the fail-loud branch at :1884-1895. Builds ' +
      'against its own chat file, because the once-per-chat warning is ' +
      'suppressed after the solo fixture fires it.',
    pins: ':1866-1895 group WI budget + fail-loud, worldInfoStore.ts:1319-1358',
    setup: () => {
      withChatFile('prompt-goldens-group-budget.jsonl');
      useWorldInfoStore.setState({ tokenBudget: 40 });
      withBooks([
        mkBook('b-gbudget', [
          mkEntry('e-gpinned', {
            content:
              'PINNED: the house takes five percent of every pot, and has ' +
              'since before any of the current players were dealt in.',
            constant: true,
            order: 10,
          }),
          mkEntry('e-gcritical', {
            content:
              'CRITICAL: nobody at this table is allowed to name the man who ' +
              'owns the building, however far the conversation drifts.',
            critical: true,
            constant: false,
            keys: ['building'],
            order: 20,
          }),
          mkEntry('e-gevicted', {
            content:
              'EVICTED: a low-priority note about the stairwell that the ' +
              'budget cannot afford once the pinned pair is counted.',
            constant: false,
            keys: ['building'],
            order: 900,
          }),
        ]),
      ]);
      return groupBase({
        messages: [mkMsg('gbd1', 'Who owns the building?')],
      });
    },
  },
];
