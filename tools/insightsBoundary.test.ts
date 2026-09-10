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
 * Finds every import-shaped edge in `source` — four distinct syntactic
 * forms, each matched by its own regex, tagging whether each is a
 * statement-level `import type` (verbatimModuleSyntax's form for a
 * type-only import — the only form this codebase writes; see File A/B's
 * own headers):
 *
 *   - `import '../x';`              (side-effect — no clause, no `from`,
 *                                     and the `;` itself is optional: ASI)
 *   - `import('../x')`              (dynamic — a call expression; a
 *                                     string or template-literal specifier)
 *   - `import (type)? ... from '../x'`      (static, with a clause)
 *   - `export (type)? { ... } | * from '../x'`  (re-export)
 *
 * The static-import regex uses a lazy `[^;]*?` (not `[\s\S]*?`) between
 * the keyword and `from` — restricted to exclude `;` so the clause can
 * span multiple lines (a multi-name named import wrapped across lines).
 * That restriction is what keeps a side-effect import directly above
 * another import from being swallowed into the SECOND statement's `from`
 * clause (matched instead, correctly, by the side-effect regex on its own
 * pass), PROVIDED the first statement ends in a real `;` — see I8's
 * swallowing self-check. It does nothing for a boundary made by ASI alone
 * (no `;` at all): a `[^;]` character class still matches a newline, so a
 * lazy scan can cross it. That is why the re-export regex below does not
 * use `[^;]*?` at all — its clause is syntactically restricted to `*`
 * (optionally `as name`) or a brace list, so it is matched explicitly
 * instead of scanned for, and cannot cross into an unrelated statement no
 * matter how that statement ends (CONF6).
 */
function extractImports(source: string): ImportStatement[] {
  const out: ImportStatement[] = [];

  // Side-effect import: a bare string specifier, no clause, no `from`. The
  // trailing `;` is OPTIONAL — ASI makes `import '../x'` (no semicolon)
  // legal TS, and there is no `semi` lint rule (eslint.config.js) forcing
  // one, so this must recognize the statement either way (CONF4).
  const sideEffectRe = /\bimport\s*(['"])([^'"]+)\1\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = sideEffectRe.exec(source))) {
    out.push({ raw: m[0], isTypeOnly: false, specifier: m[2] });
  }

  // Dynamic import: `import('../x')`, anywhere in an expression, specifier
  // quoted with `'`, `"`, or a template literal (CONF4). Always a
  // value-level import — there is no type-only dynamic-import syntax.
  const dynamicRe = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  while ((m = dynamicRe.exec(source))) {
    out.push({ raw: m[0], isTypeOnly: false, specifier: m[2] });
  }

  // Static `import (type)? ... from '../x'`.
  const fromRe = /\bimport\s+(type\s+)?[^;]*?\bfrom\s+(['"])([^'"]+)\2/g;
  while ((m = fromRe.exec(source))) {
    out.push({ raw: m[0], isTypeOnly: !!m[1], specifier: m[3] });
  }

  // Re-export: `export { x } from '../x'`, `export * from '../x'`,
  // `export type { x } from '../x'`. The clause is matched EXPLICITLY
  // (`*`, optionally `as name`, or a `{...}` list) rather than scanned for
  // with `[^;]*?` — see this function's own header for why (CONF6).
  const reExportRe = /\bexport\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*\bfrom\s+(['"])([^'"]+)\2/g;
  while ((m = reExportRe.exec(source))) {
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

  it('self-check: a side-effect import ("import \'x\';", no clause, no `from`) is detected', () => {
    const source = `import '../stores/chatStore';\nexport const x = 1;\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a side-effect import is never type-only').toBe(false);
  });

  it('self-check: a dynamic import ("await import(...)") is detected', () => {
    const source = `async function f() {\n  await import('../stores/chatStore');\n}\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a dynamic import is never type-only').toBe(false);
  });

  it('self-check: a re-export ("export { x } from \'...\'") is detected', () => {
    const source = `export { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a re-export ("export * from \'...\'") — the star alternative of the CONF6-rewritten regex — is detected', () => {
    // The rewritten reExportRe matches the clause explicitly (`*`,
    // optionally `as name`, or a brace list) instead of scanning for it —
    // this exercises the `*` arm specifically, which no other test in
    // this file reached even before the rewrite.
    const source = `export * from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a type-only re-export is detected as type-only', () => {
    const source = `export type { ChatMessage } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('self-check: a side-effect import directly above a type-only import produces TWO correct records, not one wrong one', () => {
    // This is the swallowing bug itself: the OLD `[\s\S]*?` clause matcher
    // would span from this statement's own "import" keyword all the way
    // to the SECOND statement's "from", producing one record with the
    // wrong specifier ('../other') and isTypeOnly:false — and reporting
    // ZERO records for '../stores/chatStore'.
    const source = `import '../stores/chatStore';\nimport type { Foo } from '../other';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(2);

    const sideEffect = imports.find((i) => i.specifier === '../stores/chatStore');
    expect(sideEffect, JSON.stringify(imports)).toBeTruthy();
    expect(sideEffect!.isTypeOnly).toBe(false);

    const typeOnly = imports.find((i) => i.specifier === '../other');
    expect(typeOnly, JSON.stringify(imports)).toBeTruthy();
    expect(typeOnly!.isTypeOnly).toBe(true);
  });

  it('self-check: a semicolon-less side-effect import (ASI, legal TS — no `semi` rule in eslint.config.js) is still detected (CONF4)', () => {
    const source = `import '../stores/chatStore'\nexport const x = 1;\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a side-effect import is never type-only').toBe(false);
  });

  it('self-check: a dynamic import with a template-literal specifier is detected (CONF4)', () => {
    const source = "async function f() {\n  await import(`../stores/chatStore`);\n}\n";
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a dynamic import is never type-only').toBe(false);
  });

  it('self-check: an unrelated statement directly above an import, with no semicolon between them (ASI), is not swallowed into a spurious re-export record (CONF6)', () => {
    // `export const A = 1` has no `;` before the next line's `import` — the
    // OLD reExportRe's lazy `[^;]*?` would cross that newline (a character
    // class excluding only `;` still matches `\n`) and misread the SECOND
    // statement's `from '../stores/chatStore'` as this `export`'s own
    // clause: one spurious record, `isTypeOnly: false`, and the real
    // type-only import lost entirely.
    const source = `export const A = 1\nimport type { b } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(true);
  });
});
