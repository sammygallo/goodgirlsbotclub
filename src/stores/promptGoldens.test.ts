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
// Raw-source imports (the house `?raw` pattern — tsconfig.app types only
// vite/client, so node:fs is unavailable in src and would break the
// Dockerfile's `tsc -b`, which — unlike PR CI — typechecks test files).
import goldensReadmeRaw from './__goldens__/README.md?raw';
import chatStoreRaw from './chatStore.ts?raw';
import worldInfoStoreRaw from './worldInfoStore.ts?raw';
import tokenizerRaw from '../utils/tokenizer.ts?raw';

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

/**
 * Every toast raised during the build currently running.
 *
 * The two world-info budget fixtures are the only builds that reach a
 * `showToastGlobal` call (chatStore.ts:1106 solo, :1892 group — the fail-loud
 * "constant + critical lore alone busts the WI budget" warning). That branch
 * emits NOTHING into the context, so without capturing the toast, deleting
 * both blocks outright left all 132 tests green: the fixtures' `pins` named a
 * branch they could not see. Rendered into `.fired.txt` — the same golden that
 * carries the `scanReport` the toast is derived from.
 *
 * Mocking the module (rather than reading a real toast queue) follows
 * worldInfoStore.test.ts: `showToastGlobal` dispatches to a module-level
 * callback that only ToastProvider ever installs, so in a node test it is a
 * silent no-op.
 */
const capturedToasts: { message: string; variant: string }[] = [];
vi.mock('../components/ui/Toast', () => ({
  showToastGlobal: (message: string, variant?: string) => {
    capturedToasts.push({ message, variant: variant ?? 'info' });
  },
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
  PINS_ANCHORS,
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
 * reached the prompt) and its group counterpart at :2420-2423 never executed
 * in a single golden build.
 *
 * That derivation applies THREE filters. Round 2's version of this docstring
 * named all three; only the last was reachable by a mutation. Each now has a
 * fixture that goes red when its filter is deleted:
 *   - section-disable (:1722) .................. `solo-wi-sections-disabled`
 *   - macro-empty (:1512 :1577 :1626 :1724) .... `solo-wi-blank-guards`
 *   - the history trim (:1725-1728) ............ `solo-trim-bites`
 *
 * Everything it derives is pinned:
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
  /** Toasts this build raised, and the chat file it raised them against —
   *  the once-per-chat suppression below is asserted on these, not on prose. */
  toasts: { message: string; variant: string }[];
  chatFile: string;
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

/**
 * The toasts one build raised, as `.fired.txt` header lines.
 *
 * The full message text, not just a count: it is the only user-visible output
 * of the fail-loud branch, and its numbers (`pinnedTokens`, `budget`) are
 * re-derived from the same `scanReport` printed below it — so a golden where
 * the two disagree is reporting a real bug.
 */
function toastHead(toasts: { message: string; variant: string }[]): string[] {
  if (toasts.length === 0) return ['# toasts: (none raised by this build)'];
  return [
    `# toasts: ${toasts.length}`,
    ...toasts.map((t) => `# toast[${t.variant}]: ${t.message}`),
  ];
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
  capturedToasts.length = 0;
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
        ...toastHead(capturedToasts),
      ],
      wiOut
    ),
    vars,
    toasts: [...capturedToasts],
    chatFile,
  };
}

function runGroup(fx: GroupFixture): Run {
  resetStores();
  const input = fx.setup();
  const wiOut = mkWiOut(input.messages, input.wiTimers);
  capturedToasts.length = 0;
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
    fired: renderFired(
      [...head, ...wiOutHead(wiOut, input.wiTimers), ...toastHead(capturedToasts)],
      wiOut
    ),
    vars,
    toasts: [...capturedToasts],
    chatFile,
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
  it('the fixture counts the README quotes are the ones that exist', () => {
    // The README states a count per builder and a total. Those numbers were
    // wrong (it claimed 17 group fixtures against 16) from the moment round 2
    // added fixtures without re-counting, and nothing could tell. Update these
    // when you add a fixture — and update the README in the same commit.
    expect(SOLO_FIXTURES.length, 'README "Solo (N fixtures)"').toBe(27);
    expect(GROUP_FIXTURES.length, 'README "Group (N fixtures)"').toBe(16);
    // Round-3 review: the literals above alone let the README's prose drift —
    // a dev bumps toBe(N) per the failure message and never opens the README.
    // So the README itself is part of the assertion.
    const readme = goldensReadmeRaw;
    expect(readme, 'README solo count is out of sync with SOLO_FIXTURES').toContain(
      `Solo (${SOLO_FIXTURES.length} fixtures)`
    );
    expect(readme, 'README group count is out of sync with GROUP_FIXTURES').toContain(
      `Group (${GROUP_FIXTURES.length} fixtures)`
    );
  });

  it('every :NNNN anchor in a fixture pins line names a construct that still exists', () => {
    // WHAT REPLACED WHAT. Task 0 resolved each anchor against `chatStore.ts`
    // and asserted the line was code rather than a blank or a comment. That
    // check could not survive E2-S2's own instrumentation: splitting the solo
    // builder and tagging sixteen insertion sites moves hundreds of lines, and
    // the only way to keep the NUMBERS true is to edit `pins` — which every
    // golden header renders verbatim, so all 129 golden files would be
    // rewritten for a documentation change, in the story whose acceptance
    // criterion is that they do not change.
    //
    // The number is therefore a stable KEY now, and `PINS_ANCHORS` records the
    // construct behind it. Strictly stronger than what it replaces, which said
    // of itself that it "cannot verify an anchor points at the RIGHT code" —
    // and it can no longer be satisfied by an anchor that drifted onto some
    // unrelated statement. It also fixes a live flaw: `worldInfoStore.ts:1319`,
    // `:1420` and `tokenizer.ts:180` were all being validated against
    // `chatStore.ts`, where they landed on unrelated code and passed.
    //
    // The failure modes it catches, each of which the old check missed:
    //   - an anchored construct deleted or renamed out of the builder;
    //   - a fixture citing a line nobody recorded a meaning for;
    //   - an entry left behind after the fixture that cited it was removed.
    //
    // The first of those needs the OCCURRENCE COUNT, not just presence: a
    // substring test over the whole file is satisfied by any copy, so a
    // fingerprint that exists twice proves only that at least one of the two
    // survives. Sixteen entries were in that state, and two of them shared one
    // fingerprint outright — deleting the group builder's hidden-message strip
    // left both green against the solo builder's identical line. Entries are
    // unique by default; `[fingerprint, n]` is how a construct that genuinely
    // exists n times (once per builder) declares it, and n is asserted.
    const sources: Record<string, string> = {
      'chatStore.ts': chatStoreRaw,
      'worldInfoStore.ts': worldInfoStoreRaw,
      'tokenizer.ts': tokenizerRaw,
    };
    const cited = new Set<number>();
    const bad: string[] = [];
    for (const f of [...SOLO_FIXTURES, ...GROUP_FIXTURES]) {
      for (const m of (f.pins ?? '').matchAll(/:(\d{3,4})/g)) {
        const ln = Number(m[1]);
        cited.add(ln);
        const entry = PINS_ANCHORS[ln];
        if (!entry) {
          bad.push(`${f.name} pins :${ln} — no PINS_ANCHORS entry says what it names`);
          continue;
        }
        const [declared, expected]: [string, number] = Array.isArray(entry)
          ? entry
          : [entry, 1];
        // Only a leading `<name>.ts|` is a file prefix — fingerprints contain
        // `|` of their own (`||`, `string | null`), so a bare indexOf would
        // shred them.
        const prefixed = /^([A-Za-z]+\.ts)\|([\s\S]*)$/.exec(declared);
        const file = prefixed ? prefixed[1] : 'chatStore.ts';
        const text = prefixed ? prefixed[2] : declared;
        // A fingerprint like `{` or `} else {` survives anything and proves
        // nothing — the same emptiness the old blank/comment test was aimed at.
        if (text.length < 12) {
          bad.push(`${f.name} pins :${ln} — fingerprint ${JSON.stringify(text)} is too generic to prove anything`);
          continue;
        }
        if (!sources[file]) {
          bad.push(`${f.name} pins :${ln} — unknown source file ${JSON.stringify(file)}`);
          continue;
        }
        const found = sources[file].split(text).length - 1;
        if (found === 0) {
          bad.push(`${f.name} pins :${ln} — ${file} no longer contains ${JSON.stringify(text.slice(0, 60))}`);
        } else if (found !== expected) {
          bad.push(
            `${f.name} pins :${ln} — ${JSON.stringify(text.slice(0, 60))} occurs ${found}x in ${file}, not ${expected}x, ` +
              `so it cannot prove the construct this anchor names still exists (lengthen the fingerprint, or declare the count)`
          );
        }
      }
    }
    const orphans = Object.keys(PINS_ANCHORS)
      .map(Number)
      .filter((n) => !cited.has(n));
    expect(orphans, 'PINS_ANCHORS entries no fixture cites').toEqual([]);
    expect(bad, `stale pins anchors:\n${bad.join('\n')}`).toEqual([]);
  });

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
        let perFixture = 0;
        for (const key of fx.counters ?? []) {
          expect(
            vars[key],
            `${kind}/${fx.name}: counter "${key}" did not write exactly once ` +
              `(got ${JSON.stringify(vars[key])})`
          ).toBe('1');
          asserted++;
          perFixture++;
        }
        for (const key of fx.absentCounters ?? []) {
          expect(
            vars,
            `${kind}/${fx.name}: counter "${key}" ran for text nothing emitted`
          ).not.toHaveProperty(key);
          asserted++;
          perFixture++;
        }
        // A fixture that declares either key must actually assert something.
        // `counters: []` is how a declaration silently becomes decorative.
        if (fx.counters !== undefined || fx.absentCounters !== undefined) {
          expect(
            perFixture,
            `${kind}/${fx.name} declares counters but asserts none`
          ).toBeGreaterThan(0);
        }
      }
    }
    // EXACT, not a floor. The floor this replaced (`> 50`) carried 16 of
    // slack, so deleting group/macro-writes-swap's entire ten-counter array
    // was green — the required-list below only needs each NAME declared
    // somewhere, and every one of those ten is also declared by
    // group/macro-writes. An exact count makes any net loss a red test rather
    // than budget. Raise it deliberately when you add counters.
    expect(asserted, 'the macro-counter assertion count moved').toBe(81);
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

  it('the fail-loud world-info budget warning fires once per chat file', () => {
    // Round 2 gave the two budget fixtures their own chat files so that BOTH
    // builders would reach their fail-loud branch — `wiPinnedWarnedChats`
    // (chatStore.ts:963) is module-level and never cleared, so on one shared
    // file the second build is suppressed. That apparatus pinned nothing
    // until the toasts were captured: deleting either branch, or both
    // `withChatFile` calls, left all 132 tests green.
    //
    // Three invariants, each with its own kill:
    //  1. Exactly the two budget fixtures toast (the hardcoded list) — kills
    //     a NEW fixture toasting unexpectedly.
    //  2. Every run whose scanReport went pinnedOverBudget raised exactly one
    //     toast — kills SUPPRESSION: a future over-budget fixture landing on
    //     an already-warned chat file reports pinnedOverBudget with zero
    //     toasts and fails here BY NAME. (The round-3 review proved the
    //     hardcoded list alone cannot see that case — a suppressed build
    //     contributes nothing to `fired`, so the list stays equal.)
    //  3. Neither fail-loud build runs on GOLDEN_CHAT_FILE — kills deleting
    //     EITHER withChatFile() call (round-3 review: each single deletion
    //     was green before this assertion, because the two builds still sat
    //     on two distinct files).
    const fired = [
      ...[...soloRuns].map(([n, r]) => [`solo/${n}`, r] as const),
      ...[...groupRuns].map(([n, r]) => [`group/${n}`, r] as const),
    ].filter(([, r]) => r.toasts.length > 0);
    expect(fired.map(([n]) => n)).toEqual([
      'solo/wi-budget-eviction',
      'group/wi-budget-eviction',
    ]);
    for (const [name, run] of fired) {
      expect(run.toasts.length, `${name} raised more than one toast`).toBe(1);
      expect(run.toasts[0].variant).toBe('warning');
      expect(run.toasts[0].message).toContain('exceeds the World Info budget');
    }
    const files = fired.map(([, r]) => r.chatFile);
    expect(new Set(files).size, 'the two fail-loud builds share a chat file').toBe(2);
    for (const [name, r] of fired) {
      // Kill for deleting either withChatFile() alone: that build falls back
      // to the shared golden file, which this rejects by name.
      expect(r.chatFile, `${name} warns on the shared golden chat file`).not.toBe(
        GOLDEN_CHAT_FILE
      );
    }
    // The suppression invariant (2): pinnedOverBudget without a toast means a
    // warning the user never saw. Derived from the runs, not hardcoded, so it
    // fires for any FUTURE over-budget fixture too.
    for (const [kind, runs] of [
      ['solo', soloRuns],
      ['group', groupRuns],
    ] as const) {
      for (const [name, run] of runs) {
        if (run.fired.includes('scanReport.pinnedOverBudget = true')) {
          expect(
            run.toasts.length,
            `${kind}/${name} went pinned-over-budget but raised ${run.toasts.length} toasts — ` +
              'a fail-loud warning was suppressed (same chat file as an earlier build?) or doubled'
          ).toBe(1);
        }
      }
    }

    // The suppression half: build the solo budget fixture AGAIN, against the
    // same chat file it already warned for. No second toast.
    const fx = SOLO_FIXTURES.find((f) => f.name === 'wi-budget-eviction')!;
    resetStores();
    const input = fx.setup();
    capturedToasts.length = 0;
    buildConversationContext(
      input.messages,
      input.character,
      input.availableEmotions,
      mkWiOut(input.messages, input.wiTimers),
      input.ragContext,
      input.serverMatchedEntries
    );
    expect(
      capturedToasts,
      'the once-per-chat suppression stopped suppressing'
    ).toEqual([]);
  });

  it('token-aware-off still holds an input that can tell the two window orders apart', () => {
    // `solo-fixed-window-summary-skew` used to CLAIM :1350's
    // slice-before-filter ordering and could not pin it: once a summary is
    // present, the offset rebase subtracts `windowSkew` again and both
    // orderings emit the same tail. `token-aware-off` is the only fixture
    // that pins it, and only because system turns sit inside its raw window.
    // Edit that fixture's history and the coverage the README now attributes
    // to it can vacate silently — unless this fails.
    resetStores();
    const input = SOLO_FIXTURES.find((f) => f.name === 'token-aware-off')!.setup();
    const { tokenAware, messageCount } = useGenerationStore.getState().context;
    expect(tokenAware, 'token-aware-off stopped being token-aware-off').toBe(false);
    const rawWindow = input.messages.slice(-messageCount);
    expect(
      rawWindow.filter((m) => m.isSystem).length,
      'no system turns inside the raw window — the two orderings now agree'
    ).toBeGreaterThan(0);
    const sliceThenFilter = rawWindow.filter((m) => !m.isSystem).map((m) => m.id);
    const filterThenSlice = input.messages
      .filter((m) => !m.isSystem)
      .slice(-messageCount)
      .map((m) => m.id);
    expect(
      sliceThenFilter,
      'the two orderings produce the same history — the mutation is unobservable'
    ).not.toEqual(filterThenSlice);
  });
});
