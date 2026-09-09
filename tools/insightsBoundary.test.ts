// AC1's mechanical proof for the E2-S4 PR2 insights API: "E5-S1 consumes it
// without touching prompt-assembly internals."
//
// Three files make up the module:
//   src/utils/insights/types.ts     (File A) — every public type, ZERO
//     runtime imports (import type only).
//   src/utils/insights/wiInsights.ts (File B) — pure projection. Its
//     runtime (value) imports are a subset of {File A} — in practice zero,
//     since every type it needs is erased at compile time.
//   src/stores/insightsApi.ts       (File C) — the store binder, the ONLY
//     file of the three allowed a value import of chatStore/generationStore.
//
// Lives in `tools/` for the same reason as sourceHygiene.test.ts /
// provenanceWiring.test.ts: it needs node's `fs`/`path`, and
// tsconfig.app.json ships `types: ["vite/client"]` only, with no node lib.
//
// Regex-based, not a real TS parser — same trade `provenanceWiring.test.ts`
// makes. Kept simple and self-checked (I8) rather than exact: a
// `verbatimModuleSyntax` codebase writes `import type ...` as its own
// statement form, which is exactly what this guard keys off.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const TYPES_PATH = new URL('../src/utils/insights/types.ts', import.meta.url).pathname;
const WI_INSIGHTS_PATH = new URL('../src/utils/insights/wiInsights.ts', import.meta.url).pathname;
const INSIGHTS_API_PATH = new URL('../src/stores/insightsApi.ts', import.meta.url).pathname;
const CHAT_STORE_PATH = new URL('../src/stores/chatStore.ts', import.meta.url).pathname;
const GENERATION_STORE_PATH = new URL('../src/stores/generationStore.ts', import.meta.url).pathname;

interface ImportStatement {
  raw: string;
  isTypeOnly: boolean;
  specifier: string;
}

/**
 * Finds every `import ... from '...'` statement in `source`, tagging
 * whether it is a statement-level `import type` (verbatimModuleSyntax's
 * form for a type-only import — the only form this codebase writes; see
 * File A/B's own headers). The lazy `[\s\S]*?` lets the import clause span
 * multiple lines (a multi-name named import wrapped across lines), and
 * stops at the first `from '...'` it reaches, which is correct for any
 * well-formed single import statement.
 */
function extractImports(source: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  const re = /import\s+(type\s+)?[\s\S]*?\bfrom\s+(['"])([^'"]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push({ raw: m[0], isTypeOnly: !!m[1], specifier: m[3] });
  }
  return out;
}

/**
 * Strips `/* ... *\/` block comments (doc comments included) and `// ...`
 * line comments before import-extraction ever runs. Necessary because this
 * very file's own doc comments talk ABOUT imports in prose ("every import
 * is `import type`...") — without stripping, `extractImports`'s lazy
 * `[\s\S]*?\bfrom` would happily treat a comment's prose "import" as the
 * start of a real statement and swallow everything up to the next `from`
 * keyword, real or not.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function stripExt(path: string): string {
  return path.replace(/\.tsx?$/, '');
}

/** Resolves a relative import specifier against the importing file's own
 *  directory into a canonical (extension-stripped) absolute path. A bare
 *  (package) specifier is returned unchanged — it can never match one of
 *  the local KNOWN targets below anyway. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return stripExt(resolve(dirname(fromFile), specifier));
}

interface ScannedFile {
  path: string;
  imports: ImportStatement[];
}

function scanFile(path: string): ScannedFile {
  return { path, imports: extractImports(stripComments(readFileSync(path, 'utf8'))) };
}

const KNOWN = {
  types: stripExt(TYPES_PATH),
  wiInsights: stripExt(WI_INSIGHTS_PATH),
  insightsApi: stripExt(INSIGHTS_API_PATH),
  chatStore: stripExt(CHAT_STORE_PATH),
  generationStore: stripExt(GENERATION_STORE_PATH),
} as const;

type KnownTarget = keyof typeof KNOWN;

interface ResolvedEdge {
  from: string;
  to: KnownTarget;
  isTypeOnly: boolean;
}

function resolveEdges(files: ScannedFile[]): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  for (const file of files) {
    for (const imp of file.imports) {
      const resolved = resolveSpecifier(file.path, imp.specifier);
      for (const [name, target] of Object.entries(KNOWN) as [KnownTarget, string][]) {
        if (resolved === target) {
          edges.push({ from: file.path, to: name, isTypeOnly: imp.isTypeOnly });
        }
      }
    }
  }
  return edges;
}

describe('insights API import boundary (AC1)', () => {
  const scannedFiles = [scanFile(TYPES_PATH), scanFile(WI_INSIGHTS_PATH), scanFile(INSIGHTS_API_PATH)];
  const resolvedEdges = resolveEdges(scannedFiles);

  it('non-vacuity: real files were actually scanned and at least one import edge actually resolved', () => {
    // A guard whose path resolution silently yields nothing (a typo'd
    // relative-path join, a wrong `dirname`) would otherwise pass forever
    // — every rule below is phrased as "no bad edge exists," which a
    // scanner that finds NO edges at all satisfies trivially.
    expect(scannedFiles.length).toBeGreaterThanOrEqual(2);
    expect(resolvedEdges.length).toBeGreaterThan(0);
  });

  it('types.ts (File A) has ZERO runtime imports — every import statement is `import type`', () => {
    const types = scannedFiles.find((f) => f.path === TYPES_PATH)!;
    expect(types.imports.length).toBeGreaterThan(0); // non-vacuous: it does import something (TokenizerProfile).
    const valueImports = types.imports.filter((i) => !i.isTypeOnly);
    expect(valueImports, JSON.stringify(valueImports)).toEqual([]);
  });

  it("wiInsights.ts (File B)'s runtime imports are a subset of {File A} — none reach chatStore/generationStore/insightsApi", () => {
    const wiInsights = scannedFiles.find((f) => f.path === WI_INSIGHTS_PATH)!;
    const valueImports = wiInsights.imports.filter((i) => !i.isTypeOnly);
    for (const imp of valueImports) {
      const resolved = resolveSpecifier(WI_INSIGHTS_PATH, imp.specifier);
      expect(resolved, `wiInsights.ts has a non-type import of ${imp.specifier}`).toBe(KNOWN.types);
    }
  });

  it('only insightsApi.ts (File C) has a value edge to chatStore or generationStore', () => {
    const forbidden = resolvedEdges.filter(
      (e) => !e.isTypeOnly && (e.to === 'chatStore' || e.to === 'generationStore') && e.from !== INSIGHTS_API_PATH
    );
    expect(forbidden, JSON.stringify(forbidden)).toEqual([]);
    // And insightsApi.ts really does — this module has a reason to exist.
    const real = resolvedEdges.filter(
      (e) => !e.isTypeOnly && e.from === INSIGHTS_API_PATH && (e.to === 'chatStore' || e.to === 'generationStore')
    );
    expect(real.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // I8 — the guard's own self-check
  // -------------------------------------------------------------------

  it('self-check: a planted VALUE import of chatStore is flagged, and a planted `import type` of it is not', () => {
    const withValueImport = `
import { useChatStore } from '../stores/chatStore';
export const x = 1;
`;
    const withTypeImport = `
import type { ChatMessage } from '../stores/chatStore';
export const y = 2;
`;
    const clean = `
import type { TokenizerProfile } from '../tokenizer';
export const z = 3;
`;

    const valueImports = extractImports(withValueImport);
    expect(valueImports.length).toBe(1);
    expect(valueImports[0].isTypeOnly, 'a planted value import must be detected as NOT type-only').toBe(false);

    const typeImports = extractImports(withTypeImport);
    expect(typeImports.length).toBe(1);
    expect(typeImports[0].isTypeOnly, 'a planted `import type` must be detected as type-only').toBe(true);

    expect(extractImports(clean).every((i) => i.isTypeOnly)).toBe(true);
  });

  it('self-check: a doc comment that talks ABOUT a value import in prose is not mistaken for a real one', () => {
    // This is what actually bit the guard once during development: a
    // header comment saying "every import is `import type` only" contains
    // the bare word `import` with nothing after it but prose, and without
    // comment-stripping the lazy `[\s\S]*?\bfrom` regex swallowed the
    // ENTIRE rest of the file looking for a `from` to close on.
    const source = `
/**
 * Every import here is \`import type\`, never a real value import like
 * \`import { useChatStore } from '../stores/chatStore'\` would be.
 */
import type { TokenizerProfile } from '../tokenizer';
`;
    const imports = extractImports(stripComments(source));
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../tokenizer');
    expect(imports[0].isTypeOnly).toBe(true);
  });
});
