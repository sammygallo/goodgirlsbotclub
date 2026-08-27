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
  productionCurrentTurn,
  resetStores,
} = await import('./promptGoldens.fixtures');

import type {
  GoldenWiScanOut,
  GroupFixture,
  SoloFixture,
} from './promptGoldens.fixtures';
import type { ChatMessage } from './chatStore';

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

/**
 * What the build reported back through its `wiTimerOut` in/out parameter.
 *
 * This is a THIRD golden per fixture, not a decoration. Every production call
 * site passes a real `wiOut`; round 1's fixtures all passed `undefined`, so
 * the ~40-line derivation at chatStore.ts:1704-1743 (which entries actually
 * reached the prompt, after section-disable filtering, macro-empty drops and
 * the history trim) and its group counterpart at :2420-2423 never executed in
 * a single golden build. Everything it derives is now pinned:
 *
 *   - `fired`     — the entries the WI telemetry will persist (utils/wiFired).
 *   - `trimmedAtDepth` — at-depth entries the history trim cut after the scan
 *                   passed them. Solo only; group has no history trim.
 *   - `activated` — the FRESH activations saveWiTimers stamps. A sticky
 *                   carry-over must never appear here (worldInfoStore.ts:1545)
 *                   or the carry-over becomes permanent.
 *   - `scanReport`— what the WI token budget evicted, and whether the
 *                   never-evictable pinned set alone busted it.
 *
 * Ids, never content: the content is already pinned byte-for-byte by the
 * prompt golden, and repeating it here would make this file diff on changes
 * that have nothing to do with the derivation.
 */
function renderFired(head: string[], out: GoldenWiScanOut): string {
  const ids = (list: { bookId: string; entry: { id: string } }[] | undefined) =>
    list === undefined
      ? '(not set by this build)'
      : list.length === 0
        ? '(none)'
        : list.map((m) => `${m.bookId}/${m.entry.id}`).join(', ');
  const report = out.scanReport;
  return (
    [
      ...head,
      HEAD_SEP,
      `fired          = ${ids(out.fired)}`,
      `trimmedAtDepth = ${ids(out.trimmedAtDepth)}`,
      `activated      = ${
        out.activated.size === 0
          ? '(none)'
          : Array.from(out.activated).sort().join(', ')
      }`,
      HEAD_SEP,
      report === undefined
        ? 'scanReport     = (not set by this build)'
        : [
            `scanReport.budget           = ${report.budget}`,
            `scanReport.pinnedTokens     = ${report.pinnedTokens}`,
            `scanReport.totalTokens      = ${report.totalTokens}`,
            `scanReport.pinnedOverBudget = ${report.pinnedOverBudget}`,
            `scanReport.dropped          = ${ids(report.dropped)}`,
          ].join('\n'),
    ].join('\n') + '\n'
  );
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
  fired: string;
  /** The same map the variables golden renders, unformatted — so the
   *  self-checks below assert on the DATA and can't be satisfied (or, as an
   *  earlier revision was, defeated) by the golden's own header prose. */
  vars: Record<string, string>;
}

/**
 * The `wiTimerOut` in/out parameter, built the way production builds it.
 *
 * `currentTurn` is derived from the fixture's own history by the same
 * expression every call site uses, and `timers` defaults to empty (a fresh
 * chat) — a fixture that wants a seeded sticky/cooldown clock supplies its own.
 * Not optional per fixture: passing `undefined` is a parameterization the app
 * never executes, and round 1 pinned exactly that in all 33 builds.
 */
function mkWiOut(
  messages: ChatMessage[],
  timers: Record<string, number> | undefined
): GoldenWiScanOut {
  return {
    currentTurn: productionCurrentTurn(messages),
    timers: { ...(timers ?? {}) },
    activated: new Set<string>(),
  };
}

/** Header lines describing the wiTimerOut this build was HANDED, so the
 *  `.fired.txt` golden records its inputs next to its outputs. */
function wiOutHead(out: GoldenWiScanOut, seeded: Record<string, number> | undefined): string[] {
  const timerKeys = Object.keys(seeded ?? {}).sort();
  return [
    `# wiTimerOut.currentTurn (in): ${out.currentTurn}`,
    `# wiTimerOut.timers (in): ${
      timerKeys.length === 0
        ? '(fresh chat — no seeded timers)'
        : timerKeys.map((k) => `${k}=${seeded![k]}`).join(', ')
    }`,
  ];
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
  const wiOut = mkWiOut(input.messages, input.wiTimers);
  const { context, overBudget } = buildConversationContext(
    input.messages,
    input.character,
    input.availableEmotions,
    wiOut,
    input.ragContext,
    input.serverMatchedEntries
  );
  // Read back off the chat file the build actually persisted to, not the
  // shared constant: two fixtures deliberately build against their own file so
  // the once-per-chat world-info budget warning can fire for both builders.
  const chatFile = useChatStore.getState().currentChatFile ?? GOLDEN_CHAT_FILE;
  const vars = { ...useChatStore.getState().getChatVariables(chatFile) };
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
    fired: renderFired(
      [
        ...head,
        ...wiOutHead(wiOut, input.wiTimers),
        `# serverMatchedEntries (in): ${
          input.serverMatchedEntries
            ? `${input.serverMatchedEntries.length} entr(ies) — the local scan is SKIPPED`
            : '(none — the local scan runs)'
        }`,
      ],
      wiOut
    ),
    vars,
  };
}

function runGroup(fx: GroupFixture): Run {
  resetStores();
  const input = fx.setup();
  const wiOut = mkWiOut(input.messages, input.wiTimers);
  const context = buildGroupConversationContext(
    input.messages,
    input.characters,
    input.currentCharacter,
    input.scenarioOverride,
    input.ragContext,
    input.cardMode,
    wiOut,
    input.attachmentsFolded
  );
  // Read back off the chat file the build actually persisted to, not the
  // shared constant: two fixtures deliberately build against their own file so
  // the once-per-chat world-info budget warning can fire for both builders.
  const chatFile = useChatStore.getState().currentChatFile ?? GOLDEN_CHAT_FILE;
  const vars = { ...useChatStore.getState().getChatVariables(chatFile) };
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
    fired: renderFired([...head, ...wiOutHead(wiOut, input.wiTimers)], wiOut),
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

      it('reports a stable world-info fired state', async () => {
        await expect(run.fired).toMatchFileSnapshot(
          `./__goldens__/solo-${fx.name}.fired.txt`
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

      it('reports a stable world-info fired state', async () => {
        await expect(run.fired).toMatchFileSnapshot(
          `./__goldens__/group-${fx.name}.fired.txt`
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
    //
    // Every macro-executing input in either builder carries a DISTINCT counter
    // named for its site, and the fixture that owns it lists the counter in
    // `counters`. That is what makes task 1b's "run the second half of the
    // builder twice" design self-defending: re-running any stage re-executes
    // whichever counters live in it, and the count goes to '2' here whether or
    // not the emitted text happens to differ.
    let asserted = 0;
    for (const [kind, fixtures, runs] of [
      ['solo', SOLO_FIXTURES, soloRuns],
      ['group', GROUP_FIXTURES, groupRuns],
    ] as const) {
      for (const fx of fixtures) {
        const vars = runs.get(fx.name)!.vars;
        for (const key of fx.counters ?? []) {
          expect(
            vars[key],
            `${kind}/${fx.name}: counter "${key}" did not write exactly once ` +
              `(got ${JSON.stringify(vars[key])})`
          ).toBe('1');
          asserted++;
        }
        for (const key of fx.absentCounters ?? []) {
          expect(
            vars,
            `${kind}/${fx.name}: counter "${key}" ran for text nothing emitted`
          ).not.toHaveProperty(key);
          asserted++;
        }
      }
    }
    // A refactor that dropped `counters` off every fixture would leave this
    // whole test vacuously green.
    expect(asserted, 'no macro counters were asserted at all').toBeGreaterThan(50);
  });

  it('every macro-executing input in the builders owns a named counter', () => {
    // The list is maintained by hand against chatStore.ts. It is the map from
    // "a place either builder calls sub()/processMacros()" to "the fixture
    // that would notice if it ran twice". Adding a macro-executed input to
    // either builder without adding a counter here is the regression this
    // guards: the review that prompted round 2 proved that rewriting an
    // uncovered site as `(sub(x), sub(x))` left the whole suite green.
    const declared = new Set<string>();
    for (const fx of [...SOLO_FIXTURES, ...GROUP_FIXTURES]) {
      for (const k of fx.counters ?? []) declared.add(k);
      for (const k of fx.absentCounters ?? []) declared.add(k);
    }
    const required = [
      // --- solo (chatStore.ts:966-1745) --------------------------------
      'day',            // :1183 description
      'shelf',          // :1184 personality
      'scenarioSub',    // :1185 scenario
      'mesExampleSub',  // :1186 mes_example
      'charSysPrompt',  // :1206 system_prompt
      'charPhiSub',     // :1209-1211 post_history_instructions
      'userMainPrompt', // :1214 genState.prompt.mainPrompt
      'userPhiSub',     // :1215 genState.prompt.postHistoryInstructions
      'userJailbreak',  // :1216 genState.prompt.jailbreakPrompt
      'depthPromptRuns',// :1425 depth_prompt.prompt
      'ledger',         // :1131 wrapWiContent (non-depth positions)
      'wiDepthInLoop',  // :1509 joinWi at an in-loop depth
      'wiDepthZero',    // :1571 joinWi at the depth-0 trailing slot
      'wiDepthOverflow',// :1616 joinWi on the overflow unshift
      'note',           // :1491 author's note, in-loop
      'anDepthZero',    // :1557 author's note, depth 0
      'anOverflow',     // :1604 author's note, overflow
      'anGuardRuns',    // :1491 the blank-content guard's own run count
      'soloUserTurn',   // :1524 sub(msg.content), user turn
      'soloAsstTurn',   // :1524 sub(msg.content), assistant turn
      // --- group (chatStore.ts:1747-2427) ------------------------------
      'cardSeraphina',  // :2056 join desc     / :2078 swap desc
      'cardMarcus',
      'persSeraphina',  // :2057 join pers     / :2079 swap pers
      'persMarcus',
      'scenarioRuns',   // :2037-2043 speakerScenario (lazy)
      'scenarioMarcus', // :2060 non-speaker scenario (join only)
      'exSeraphina',    // :2062 join examples / :2170-2173 swap mesExample
      'exMarcus',
      'overrideCount',  // :2143-2156 scenarioOverride
      'wiCount',        // :2030-2032 wrapWiContent
      'gWiDepthInLoop', // :2310 joinWi at an in-loop depth
      'gWiDepthZero',   // :2374 joinWi at the depth-0 trailing slot
      'gWiDepthOverflow', // :2405 joinWi on the overflow splice
      'anCount',        // :2299 group author's note, in-loop
      'gAnOverflow',    // :2389 group author's note, overflow
      'gAnGuardRuns',   // :2299/:2389 blank-content guard run count
      'userTurn',       // :2323 subSpeaker(msg.content)
      'asstTurn',       // :2324 subMember(authorOfTurn(msg), msg.content)
    ];
    const missing = required.filter((k) => !declared.has(k));
    expect(missing, 'macro sites with no counter declared by any fixture').toEqual([]);
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

  it('solo macro execution ORDER is pinned, not just the counts', () => {
    // Each stage overwrites `stage`, so the surviving value names whichever
    // ran last: card fields -> world info -> depth prompt -> author's note ->
    // history turns.
    expect(soloRuns.get('macro-writes')!.vars.stage).toBe('history');
  });

  it('every fixture hands the builder a wiTimerOut, as production does', () => {
    // C3: round 1 passed `undefined` in all 33 builds, so the fired /
    // trimmedAtDepth derivation never ran once. `fired = (not set by this
    // build)` in a golden means the out-parameter went unused — which for a
    // build that WAS handed one can only mean the derivation stopped running.
    for (const [kind, runs] of [
      ['solo', soloRuns],
      ['group', groupRuns],
    ] as const) {
      for (const [name, run] of runs) {
        expect(run.fired, `${kind}/${name} did not report a fired set`).not.toContain(
          'fired          = (not set by this build)'
        );
      }
    }
  });
});
