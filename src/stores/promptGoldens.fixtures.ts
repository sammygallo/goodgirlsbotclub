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
import type { WorldInfoBook, WorldInfoEntry } from './worldInfoStore';

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

function withBooks(books: WorldInfoBook[]): void {
  useWorldInfoStore.setState({ books, activeBookIds: books.map((b) => b.id) });
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
}

export interface SoloFixture {
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
}

export interface GroupFixture {
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
      'plus all four Stage-C sections.',
    pins: ':1285-1322 all 18 keys, :1337 the join, :1684-1690 Stage C',
    setup: () => {
      withPersona({
        description: 'A night-shift cataloguer with ink on both cuffs.',
        descriptionPosition: 'before_char',
      });
      withBooks([
        mkBook('b-pos', [
          mkEntry('e-bc', { content: 'Lore: the stacks run four floors down.', position: 'before_char' }),
          mkEntry('e-ac', { content: 'Lore: the catalogue is not alphabetical.', position: 'after_char' }),
          mkEntry('e-ba', { content: 'Lore: the lift only stops on even floors.', position: 'before_an' }),
          mkEntry('e-aa', { content: 'Lore: nobody signs the ledger out.', position: 'after_an' }),
        ]),
      ]);
      withExtensions(
        { content: '[ext] before_char contribution', role: 'system', position: 'before_char' },
        { content: '[ext] after_char contribution', role: 'system', position: 'after_char' },
        { content: '[ext] before_an contribution', role: 'system', position: 'before_an' },
        { content: '[ext] after_an contribution', role: 'system', position: 'after_an' }
      );
      useGenerationStore.setState({
        prompt: { ...DEFAULT_PROMPT_CONFIG, postHistoryInstructions: '[User PHI: end on an image, not a question.]' },
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
      'two sections disabled — one pre-history (jailbreak), one Stage C (char_phi).',
    pins: ':1328-1332 pre-history filter, :1684-1688 Stage-C filter',
    setup: () => {
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
      'unconditional, so the prompt still opens with an EMPTY system message.',
    pins: ':1327-1338 — the unconditional push (audit §4.4)',
    setup: () => {
      withPromptOrder((order) =>
        order.map((e) =>
          e.id === 'char_phi' || e.id === 'user_phi' || e.id === 'wi_after_an' || e.id === 'ext_after_an'
            ? e
            : { ...e, enabled: false }
        )
      );
      return { messages: HELLO, character: IVY_MINIMAL };
    },
  },

  {
    name: 'trim-bites',
    matrix: 'S5',
    what: 'A long chat against a small budget: the token-aware trim drops older turns.',
    pins: ':1644-1681 trimHistoryToBudget, kept-set object identity',
    setup: () => {
      withContext({ maxTokens: 1600, responseReserve: 256, tokenAware: true });
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
      'estimate comes from the NON-token-aware path, which counts Stage C.',
    pins: ':1678-1680 else-branch, :1694-1696 estimateConversationTokens',
    setup: () => {
      withContext({ tokenAware: false, messageCount: 3 });
      useGenerationStore.setState({
        prompt: { ...DEFAULT_PROMPT_CONFIG, postHistoryInstructions: '[User PHI: stay in the room.]' },
      });
      return { messages: bulkHistory(9, 6), character: IVY_FULL };
    },
  },

  {
    name: 'at-depth-interleave',
    matrix: 'S8',
    what:
      'All five at-depth classes at ONE depth: character note, author note, ' +
      'persona, world info, extension — in the documented order.',
    pins: ':1480-1523 in-loop insertion order',
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: { extensions: { depth_prompt: { prompt: '[Character note at depth 2.]', depth: 2, role: 'system' } } },
      });
      withAuthorNote("[Author's note at depth 2.]", 2);
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 2,
      });
      withBooks([
        mkBook('b-depth', [
          mkEntry('e-d2', { content: 'Lore at depth 2.', position: 'at_depth', depth: 2 }),
        ]),
      ]);
      withExtensions({
        content: '[ext] at depth 2',
        role: 'system',
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
    what: 'All five at-depth classes at depth 0 — the trailing slot after the newest turn.',
    pins: ':1548-1588 depth-0 branches',
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: { extensions: { depth_prompt: { prompt: '[Character note at depth 0.]', depth: 0, role: 'system' } } },
      });
      withAuthorNote("[Author's note at depth 0.]", 0);
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 0,
      });
      withBooks([
        mkBook('b-depth0', [
          mkEntry('e-d0', { content: 'Lore at depth 0.', position: 'at_depth', depth: 0 }),
        ]),
      ]);
      withExtensions({
        content: '[ext] at depth 0',
        role: 'system',
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
      'world-info depths, so the unshift order is pinned.',
    pins: ':1591-1641 overflow unshifts',
    setup: () => {
      const char = mkChar({
        ...IVY_MINIMAL,
        data: { extensions: { depth_prompt: { prompt: '[Character note, depth 9.]', depth: 9, role: 'system' } } },
      });
      withAuthorNote("[Author's note, depth 8.]", 8);
      withPersona({
        description: 'A night-shift cataloguer.',
        descriptionPosition: 'at_depth',
        descriptionDepth: 7,
      });
      withBooks([
        mkBook('b-of', [
          mkEntry('e-d10', { content: 'Lore at depth 10.', position: 'at_depth', depth: 10 }),
          mkEntry('e-d11', { content: 'Lore at depth 11.', position: 'at_depth', depth: 11 }),
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
      'An image-only user turn (kept, and it ships EMPTY content) next to a ' +
      'blank assistant turn (dropped).',
    pins: ':1531-1540 the image-only keep exemption',
    setup: () => ({
      messages: [
        mkMsg('i1', 'Look at this.'),
        mkMsg('i2', '', { isUser: false, name: 'Ivy' }),
        mkMsg('i3', '', { isUser: true, images: ['data:image/png;base64,iVBORw0KGgo='] }),
      ],
      character: IVY_MINIMAL,
    }),
  },

  {
    name: 'macro-writes',
    matrix: 'S12',
    what:
      'THE DOUBLE-EXECUTION CANARY. {{setvar}} in a card field, a world-info ' +
      'entry and the author\'s note, plus {{incvar}} counters whose RETURNED ' +
      'value is emitted into the prompt. A second execution of any stage shows ' +
      'up twice: as a changed number in the prompt golden, and as a changed ' +
      'count in the variables golden. `stage` records execution ORDER — card ' +
      'fields, then world info, then the author\'s note.',
    pins: ':1130-1143 wrapWiContent, :1205-1215 card fields, :1487-1497 author note',
    setup: () => {
      const char = mkChar({
        name: 'Ivy',
        avatar: 'ivy.png',
        description:
          'A quiet archivist. Day {{incvar::day}} of the audit.{{setvar::stage::card}}',
        personality: 'Dry. Shelf {{incvar::shelf}}.',
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
      return { messages: [mkMsg('mw1', 'Hello.')], character: char };
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
    what: 'Same build with no ragContext — rag_context renders empty and is filtered out.',
    pins: ':1305-1307 / :1330-1332',
    setup: () => ({ messages: HELLO, character: IVY_MINIMAL }),
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
      'block, the greeting trimmed off the front of history, and char_phi ' +
      'replaced by the no-narration style note.',
    pins: ':1195-1199 pureChatMode, :1240-1247 charInfoParts, :1314-1318 char_phi, :1360-1372 greeting trim',
    setup: () => {
      usePromptTemplateStore.setState({
        chatCompanionModeByChatFile: { [GOLDEN_CHAT_FILE]: true },
      });
      return {
        messages: [
          mkMsg('g1', '*The reading room is dark but for one lamp.*', { isUser: false, name: 'Ivy' }),
          mkMsg('g2', 'Hi Ivy.'),
          mkMsg('g3', 'Late again?', { isUser: false, name: 'Ivy' }),
        ],
        character: IVY_FULL,
      };
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
    what: 'Join mode: a full section per member, [SPEAKING NOW] on the speaker, joined by \\n\\n---\\n\\n.',
    pins: ':2054-2074 join card block',
    setup: () => groupBase({ cardMode: 'join' }),
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
      'neither pushes a blank context entry.',
    pins: ':2300 in-loop AN guard, :2312 wi at-depth guard',
    setup: () => {
      withAuthorNote('{{setvar::anGuard::inloop}}', 1);
      withBooks([
        mkBook('b-blank', [
          mkEntry('e-blank', {
            content: '{{setvar::wiGuard::rendered-empty}}',
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
      'and the world-info entry both configured deeper than the history.',
    pins: ':2388 overflow AN guard, :2404-2408 wi overflow',
    setup: () => {
      withAuthorNote('{{setvar::anGuard::overflow}}', 5);
      withBooks([
        mkBook('b-blank-of', [
          mkEntry('e-blank-of', {
            content: '{{setvar::wiGuard::rendered-empty}}',
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
      'THE GROUP DOUBLE-EXECUTION CANARY: counters in both member cards, the ' +
      'scenarioOverride, a world-info entry, the author\'s note, a USER turn ' +
      'and an ASSISTANT turn. Every count must read 1. The assistant turn also ' +
      'pins authorOfTurn — its {{char}} resolves to Marcus, not the speaker.',
    pins: ':1975-1976 subMember, :2324-2326 history substitution, :2411-2413 persist',
    setup: () => {
      const sera = mkChar({
        name: 'Seraphina',
        avatar: 'seraphina.png',
        description: 'Host. Deal {{incvar::cardSeraphina}}.',
        personality: 'Warm.',
        scenario: 'A back-room card game, hour {{incvar::scenarioRuns}}.',
      });
      const marc = mkChar({
        name: 'Marcus',
        avatar: 'marcus.png',
        description: 'Counter. Deal {{incvar::cardMarcus}}.',
        personality: 'Quiet.',
        scenario: 'Marcus never sets the scene.',
      });
      withBooks([
        mkBook('b-gmacro', [
          mkEntry('e-gmacro', {
            content: 'House rule {{incvar::wiCount}}: no talking about the game.',
            position: 'before_char',
          }),
        ]),
      ]);
      withAuthorNote("[Author's note {{incvar::anCount}}.]", 1);
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
    matrix: 'SHOULD: persona-book + owned-book attribution',
    what:
      'Three books in one build: one owned by a non-speaking member (gets the ' +
      '"another character" header AND resolves its macros against that owner), ' +
      'one persona-linked (gets the user header), one room-shared (unlabelled).',
    pins: ':1978-1984 memberByOwnedBookId, :1986-2043 wrapWiContent',
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
            mkEntry('e-shared', { content: 'The back room has no clock.', position: 'before_char' }),
          ]),
        ],
        activeBookIds: ['b-marcus', 'b-persona', 'b-shared'],
      });
      useCharacterStore.setState({ characters: GROUP_ROSTER });
      return groupBase();
    },
  },
];
