/**
 * The prompt-assembly golden harness (E2-S2 task 0).
 *
 * WHAT THIS IS: a byte-for-byte pin on what `buildConversationContext` and
 * `buildGroupConversationContext` hand the provider, plus the chat variables
 * each build persists. Same fixture, same bytes, checked on every run.
 *
 * WHY IT EXISTS: E2-S2's AC 8 is "zero diff in assembled prompts before vs
 * after instrumentation". These goldens ARE that evidence, which is why they
 * are cut and merged BEFORE a line of instrumentation exists — goldens taken
 * from already-instrumented code prove nothing about what the instrumentation
 * changed.
 *
 * WHAT IT DELIBERATELY PINS THAT IS NOT PROMPT TEXT:
 *   - `overBudget` (solo only) — the trim's verdict, one of the two numbers
 *     task 4 has to reconcile.
 *   - `lastTokenEstimate` — written on BOTH solo paths from two different
 *     definitions (:1676 excludes Stage C, :1694-1696 includes it) and never
 *     written at all by group. The fixtures seed it with a sentinel, so a
 *     golden that reads -1 is recording "this build reported no total".
 *   - the persisted `variables` map — the double-execution canary. Task 1b
 *     splits this builder in two and runs the second half twice; the only
 *     thing standing between that design and a double-executed {{setvar}} is
 *     these files.
 *
 * WHAT IT IS NOT: a test of whether the prompt is GOOD. A golden cannot tell
 * you the model was told the right thing, only that it was told the same thing
 * as last time.
 *
 * REGENERATE after an intended change:
 *
 *   npx vitest run src/stores/promptGoldens -u
 *
 * Then READ THE DIFF. The golden diff is the whole signal: it is the complete
 * list of everything your change altered about what the model is sent. An
 * update committed without reading it throws away the only thing this harness
 * does. See ./__goldens__/README.md.
 */

import { describe, it, expect, vi } from 'vitest';

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

// This runtime's global `localStorage` is an inert `{}` (Node's Web Storage
// implementation needs `--localstorage-file` to actually work). Several stores
// in the builders' dependency graph write through it unguarded — zustand's
// `persist` middleware in extensionStore/selfieStore throws outright. Install a
// working in-memory Storage BEFORE the first store import, mirroring
// chatLoreConfigStore.test.ts / chatLoreFork.integration.test.ts.
//
// Deliberately NOT reset between fixtures: nothing the builders read comes back
// out of storage mid-run (every store is reset in memory by `resetStores`), and
// clearing it would only hide a store that started depending on it.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
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
globalThis.localStorage = new MemoryStorage() as unknown as Storage;

const { buildConversationContext, buildGroupConversationContext, useChatStore } =
  await import('./chatStore');
const { useGenerationStore } = await import('./generationStore');
// Imported dynamically, AFTER chatStore, so the fixtures' own store imports
// can never win the race into the require cycle above.
const {
  GOLDEN_CHAT_FILE,
  GROUP_FIXTURES,
  SOLO_FIXTURES,
  resetStores,
} = await import('./promptGoldens.fixtures');

import type { GroupFixture, SoloFixture } from './promptGoldens.fixtures';

type ContextEntry = { role: 'user' | 'assistant' | 'system'; content: string };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const ENTRY_SEP = '─'.repeat(74);
const HEAD_SEP = '═'.repeat(74);

/**
 * A diff-readable rendering of one assembled context. Deliberately not
 * JSON.stringify: the point is that a reviewer can read what changed about
 * what the model is told, not decode an escaped structure dump.
 *
 * Two details are load-bearing:
 *   - An empty entry renders as an explicit `∅ (empty content)`. The Stage-A
 *     push at chatStore.ts:1335 is unconditional and can emit an empty system
 *     message, and blank turns survive the group's image-carrier exemption —
 *     a blank REGION in a golden file is invisible to a reviewer, a marker is
 *     not.
 *   - Every entry carries `len=`. Trailing and doubled whitespace is exactly
 *     as invisible on the page as an empty entry, and the group's flat system
 *     template is built almost entirely out of conditional newlines.
 */
function renderContext(head: string[], entries: ContextEntry[]): string {
  const lines: string[] = [...head, HEAD_SEP];
  entries.forEach((entry, i) => {
    lines.push(`[${i}] ${entry.role}  len=${entry.content.length}`);
    if (entry.content === '') {
      lines.push('∅ (empty content)');
    } else if (entry.content.trim() === '') {
      lines.push(`∅ (whitespace only: ${JSON.stringify(entry.content)})`);
    } else {
      lines.push(entry.content);
    }
    lines.push(ENTRY_SEP);
  });
  if (entries.length === 0) lines.push('∅ (no entries at all)');
  return lines.join('\n') + '\n';
}

/**
 * The chat variables ONE build persisted.
 *
 * Sorted by key rather than left in insertion order: insertion order encodes
 * which stage wrote first, which the fixtures pin far more legibly with an
 * explicit `stage` variable than a reviewer could read out of an ordering.
 */
function renderVariables(head: string[], vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort();
  const lines: string[] = [...head, HEAD_SEP];
  if (keys.length === 0) {
    lines.push('(no variables written by this build)');
  } else {
    for (const k of keys) lines.push(`${k} = ${JSON.stringify(vars[k])}`);
  }
  lines.push(HEAD_SEP);
  lines.push(`${keys.length} key(s)`);
  return lines.join('\n') + '\n';
}

/** Wrap long fixture prose so the golden header stays readable in a diff. */
function comment(label: string, text: string): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = `# ${label}: `;
  for (const w of words) {
    if (line.length + w.length + 1 > 78 && line.trim() !== `# ${label}:`) {
      out.push(line.trimEnd());
      line = '#   ';
    }
    line += w + ' ';
  }
  out.push(line.trimEnd());
  return out;
}

// ---------------------------------------------------------------------------
// Running a fixture — exactly once, at collection time
// ---------------------------------------------------------------------------

interface Run {
  prompt: string;
  variables: string;
  /** The same map the variables golden renders, unformatted — so the
   *  self-checks below assert on the DATA and can't be satisfied (or, as an
   *  earlier revision was, defeated) by the golden's own header prose. */
  vars: Record<string, string>;
}

/**
 * ONE build per fixture, full stop.
 *
 * Not inside the `it` bodies: two `it`s would mean two builds, and a second
 * build re-runs every macro in the fixture. The variables golden would then be
 * pinning "what the second build wrote", which is precisely the double
 * execution it exists to detect.
 */
function runSolo(fx: SoloFixture): Run {
  resetStores();
  const input = fx.setup();
  const { context, overBudget } = buildConversationContext(
    input.messages,
    input.character,
    input.availableEmotions,
    undefined,
    input.ragContext
  );
  const vars = { ...useChatStore.getState().getChatVariables(GOLDEN_CHAT_FILE) };
  const head = [
    `# solo/${fx.name}   [${fx.matrix}]`,
    ...comment('what', fx.what),
    ...comment('pins', fx.pins),
  ];
  return {
    prompt: renderContext(
      [
        ...head,
        `# entries: ${context.length}`,
        `# overBudget: ${overBudget}`,
        `# lastTokenEstimate: ${useGenerationStore.getState().lastTokenEstimate}`,
      ],
      context
    ),
    variables: renderVariables(
      [...head, '# A count above 1 here means a macro executed more than once.'],
      vars
    ),
    vars,
  };
}

function runGroup(fx: GroupFixture): Run {
  resetStores();
  const input = fx.setup();
  const context = buildGroupConversationContext(
    input.messages,
    input.characters,
    input.currentCharacter,
    input.scenarioOverride,
    input.ragContext,
    input.cardMode,
    undefined,
    input.attachmentsFolded
  );
  const vars = { ...useChatStore.getState().getChatVariables(GOLDEN_CHAT_FILE) };
  const head = [
    `# group/${fx.name}   [${fx.matrix}]`,
    ...comment('what', fx.what),
    ...comment('pins', fx.pins),
  ];
  return {
    prompt: renderContext(
      [
        ...head,
        `# entries: ${context.length}`,
        // Group never writes it — see the fixtures' NOT_WRITTEN docstring.
        `# lastTokenEstimate: ${useGenerationStore.getState().lastTokenEstimate}`,
      ],
      context
    ),
    variables: renderVariables(
      [...head, '# A count above 1 here means a macro executed more than once.'],
      vars
    ),
    vars,
  };
}

// ---------------------------------------------------------------------------
// The goldens
// ---------------------------------------------------------------------------

const soloRuns = new Map<string, Run>();
const groupRuns = new Map<string, Run>();

describe('prompt goldens — solo', () => {
  for (const fx of SOLO_FIXTURES) {
    describe(fx.name, () => {
      const run = runSolo(fx);
      soloRuns.set(fx.name, run);

      it('assembles a stable prompt', async () => {
        await expect(run.prompt).toMatchFileSnapshot(
          `./__goldens__/solo-${fx.name}.prompt.txt`
        );
      });

      it('persists a stable variables map', async () => {
        await expect(run.variables).toMatchFileSnapshot(
          `./__goldens__/solo-${fx.name}.variables.txt`
        );
      });
    });
  }
});

describe('prompt goldens — group', () => {
  for (const fx of GROUP_FIXTURES) {
    describe(fx.name, () => {
      const run = runGroup(fx);
      groupRuns.set(fx.name, run);

      it('assembles a stable prompt', async () => {
        await expect(run.prompt).toMatchFileSnapshot(
          `./__goldens__/group-${fx.name}.prompt.txt`
        );
      });

      it('persists a stable variables map', async () => {
        await expect(run.variables).toMatchFileSnapshot(
          `./__goldens__/group-${fx.name}.variables.txt`
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The harness is honest about itself
// ---------------------------------------------------------------------------
//
// A golden suite that pins nothing passes every fixture. These are the cheap
// structural guards against the ways this one could quietly become decorative;
// the expensive guard is the mutation drill in ./__goldens__/README.md, which
// a human runs.

describe('prompt goldens — the harness pins what it claims to', () => {
  it('every fixture has a unique golden stem', () => {
    const solo = SOLO_FIXTURES.map((f) => f.name);
    const group = GROUP_FIXTURES.map((f) => f.name);
    expect(new Set(solo).size, 'duplicate solo fixture name').toBe(solo.length);
    expect(new Set(group).size, 'duplicate group fixture name').toBe(group.length);
  });

  it('every fixture says what it pins', () => {
    for (const f of [...SOLO_FIXTURES, ...GROUP_FIXTURES]) {
      expect(f.what.length, `${f.name} has no description`).toBeGreaterThan(20);
      expect(f.pins, `${f.name} names no anchor`).toMatch(/:\d+/);
    }
  });

  it('the goldens carry real prompt text, not just a shape', () => {
    // The failure mode the story's risk register names: a harness that
    // snapshots entry counts and the role sequence passes every fixture and
    // pins nothing. Every solo golden must contain the actual card text.
    const minimal = soloRuns.get('minimal')!;
    expect(minimal.prompt).toContain('A quiet archivist who never throws anything away.');
    expect(minimal.prompt).toContain('IMPORTANT: Begin each response with an emotion tag');
  });

  it('renders an empty entry as an explicit marker, never as blank space', () => {
    // chatStore.ts:1335 pushes the Stage-A system message unconditionally.
    expect(soloRuns.get('empty-system-block')!.prompt).toContain('∅ (empty content)');
    // The group image-carrier exemption ships a blank user turn on purpose.
    expect(soloRuns.get('image-only-and-blank-assistant')!.prompt).toContain('∅ (empty content)');
    expect(groupRuns.get('blank-user-turn-folded-kept')!.prompt).toContain('∅ (empty content)');
  });

  it('the macro canaries record every write exactly once', () => {
    // Not a substitute for reading the golden — a guard so that a future
    // double-execution fails a NAMED test as well as an anonymous file diff.
    const solo = soloRuns.get('macro-writes')!.vars;
    for (const key of ['day', 'shelf', 'ledger', 'note']) {
      expect(solo[key], `solo ${key} did not write exactly once`).toBe('1');
    }
    // Execution ORDER, not just count: card fields, then world info, then the
    // author's note. Each stage overwrites `stage`, so the surviving value
    // names whichever ran last.
    expect(solo.stage, 'solo macro stage order changed').toBe('authornote');
    const group = groupRuns.get('macro-writes')!.vars;
    for (const key of [
      'cardSeraphina',
      'cardMarcus',
      'scenarioRuns',
      'wiCount',
      'anCount',
      'overrideCount',
      'userTurn',
      'asstTurn',
    ]) {
      expect(group[key], `group ${key} did not write exactly once`).toBe('1');
    }
  });

  it('a scenario nothing emits is never executed', () => {
    // The lazy speakerScenario memo (chatStore.ts:2036-2044). In swap mode WITH
    // an override, neither site renders the speaker's scenario, so its
    // {{incvar}} must not run at all.
    expect(groupRuns.get('swap-scenario-override')!.vars).not.toHaveProperty('scenarioRuns');
    expect(groupRuns.get('swap')!.vars.scenarioRuns).toBe('1');
    expect(groupRuns.get('join')!.vars.scenarioRuns).toBe('1');
    expect(groupRuns.get('join-scenario-override')!.vars.scenarioRuns).toBe('1');
  });
});
