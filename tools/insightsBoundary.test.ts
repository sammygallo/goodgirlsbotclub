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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as ts from 'typescript';

const TYPES_PATH = new URL('../src/utils/insights/types.ts', import.meta.url).pathname;
const WI_INSIGHTS_PATH = new URL('../src/utils/insights/wiInsights.ts', import.meta.url).pathname;
const INSIGHTS_API_PATH = new URL('../src/stores/insightsApi.ts', import.meta.url).pathname;
const CHAT_STORE_PATH = new URL('../src/stores/chatStore.ts', import.meta.url).pathname;
const GENERATION_STORE_PATH = new URL('../src/stores/generationStore.ts', import.meta.url).pathname;

interface ImportStatement {
  isTypeOnly: boolean;
  specifier: string | null;
}

// Type-only-ness is decided at the DECLARATION level ONLY — `clause.isTypeOnly`
// / `node.isTypeOnly` — never by whether every individual
// binding happens to carry an inline `type` modifier. Both tsconfigs set
// `verbatimModuleSyntax: true`, under which `import { type A } from './m'`
// still emits `import {} from './m';` (a real runtime module edge) while
// only a declaration-level `import type { A } from './m'` elides entirely
// — confirmed by compiling both forms with `ts.createProgram` under
// `verbatimModuleSyntax: true` and reading the emitted JS. Treating an
// inline `{ type A }` as type-only would let a real value edge to
// chatStore/generationStore through this guard undetected.
function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  return clause ? clause.isTypeOnly : false;
}

function exportDeclIsTypeOnly(node: ts.ExportDeclaration): boolean {
  return node.isTypeOnly;
}

function extractImports(source: string, fileName = 'source.ts'): ImportStatement[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ImportStatement[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push({ isTypeOnly: importClauseIsTypeOnly(node.importClause), specifier: node.moduleSpecifier.text });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push({ isTypeOnly: exportDeclIsTypeOnly(node), specifier: node.moduleSpecifier.text });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      out.push({ isTypeOnly: false, specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : null });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isMetaProperty(node.expression.expression) &&
      node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      // `import.meta.glob(...)` / `import.meta.globEager(...)` — Vite's
      // build-time module-graph import mechanism, real per this repo's own
      // `tsconfig.app.json` `types: ["vite/client"]`. A bare property
      // access with no call (`import.meta.env`, `import.meta.hot`) never
      // reaches this branch — only an invocation on `import.meta` does.
      const arg = node.arguments[0];
      out.push({ isTypeOnly: false, specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : null });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return out;
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
  return { path, imports: extractImports(readFileSync(path, 'utf8'), path) };
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
      if (imp.specifier === null) continue;
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

/** Asserts every VALUE import in `file` resolves to `boundary`. Fails
 *  CLOSED (throws) on a value import this guard cannot resolve statically
 *  — a specifier of `null` — rather than silently skipping it, since an
 *  unresolvable value import is exactly the case where a real edge to
 *  chatStore/generationStore could be hiding. */
function assertValueImportsResolveInto(file: ScannedFile, boundary: string): void {
  const valueImports = file.imports.filter((i) => !i.isTypeOnly);
  for (const imp of valueImports) {
    if (imp.specifier === null) {
      throw new Error(`${file.path} has an unresolvable dynamic import — cannot verify it stays inside {File A}`);
    }
    const resolved = resolveSpecifier(file.path, imp.specifier);
    expect(resolved, `${file.path} has a non-type import of ${imp.specifier}`).toBe(boundary);
  }
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
    assertValueImportsResolveInto(wiInsights, KNOWN.types);
  });

  it('self-check: assertValueImportsResolveInto fails CLOSED (throws) on an unresolvable value import instead of silently skipping it', () => {
    const scanned: ScannedFile = { path: WI_INSIGHTS_PATH, imports: [{ isTypeOnly: false, specifier: null }] };
    expect(() => assertValueImportsResolveInto(scanned, KNOWN.types)).toThrow(
      'has an unresolvable dynamic import'
    );
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
    // A real parser treats comments as trivia, never as candidate
    // statements — this pins that a header saying "every import is
    // `import type`..." inside a `/** ... */` block does not itself
    // register as an import.
    const source = `
/**
 * Every import here is \`import type\`, never a real value import like
 * \`import { useChatStore } from '../stores/chatStore'\` would be.
 */
import type { TokenizerProfile } from '../tokenizer';
`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../tokenizer');
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('self-check: a `//` / `/* */`-shaped sequence living INSIDE A STRING LITERAL, directly above a real import, does not hide or corrupt that import', () => {
    // A comment-stripping preprocessor (the previous implementation) has
    // no way to tell a real comment from these bytes appearing inside a
    // string's contents, and can delete part of a real statement as a
    // result. A real parser never has this failure mode — string-literal
    // contents are never comment trivia. The two string halves below form
    // an unterminated `/* ... */` pair that BRACKETS the import — a
    // strip-then-regex preprocessor's lazy block-comment regex would scan
    // from the first `/*` to the first `*/` found anywhere afterward and
    // delete everything between them, import included.
    const source = `
const a = 'x /* y';
import { useChatStore } from '../stores/chatStore';
const b = '*/';
`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a side-effect import ("import \'x\';", no clause, no `from`) is detected', () => {
    const source = `import '../stores/chatStore';\nexport const x = 1;\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a side-effect import is never type-only').toBe(false);
  });

  it('self-check: a semicolon-less side-effect import (ASI, legal TS — no `semi` rule in eslint.config.js) is still detected', () => {
    const source = `import '../stores/chatStore'\nexport const x = 1;\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
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

  it('self-check: a dynamic import with a template-literal specifier is detected', () => {
    const source = 'async function f() {\n  await import(`../stores/chatStore`);\n}\n';
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a dynamic import is never type-only').toBe(false);
  });

  it('self-check: a dynamic import whose argument is NOT a string literal is recorded as unresolvable, not dropped', () => {
    // `import(pathVar)` cannot be resolved statically — this must still
    // produce a record (so a caller can see the edge exists and refuse
    // to certify it as safe) rather than silently vanishing.
    const source = `async function f(pathVar: string) {\n  await import(pathVar);\n}\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier, 'a non-literal dynamic import specifier cannot be resolved').toBeNull();
    expect(imports[0].isTypeOnly, 'a dynamic import is never type-only').toBe(false);
  });

  it('self-check: `import.meta.env` (a bare property access, no call) is not an import edge — it must produce nothing, even directly above a real import', () => {
    const source = `const mode = import.meta.env.MODE;\nimport { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
  });

  it('self-check: `import.meta.glob(...)` and `import.meta.globEager(...)` ARE import edges — Vite resolves the glob against the module graph at build time (`tsconfig.app.json` ships `types: ["vite/client"]`)', () => {
    const globSource = `const g = import.meta.glob('../stores/chatStore.ts', { eager: true });\nvoid g;\n`;
    const globImports = extractImports(globSource);
    expect(globImports.length, JSON.stringify(globImports)).toBe(1);
    expect(globImports[0].specifier).toBe('../stores/chatStore.ts');
    expect(globImports[0].isTypeOnly, 'an import.meta.glob edge is never type-only').toBe(false);

    const globEagerSource = `const g = import.meta.globEager('../stores/chatStore.ts');\nvoid g;\n`;
    const globEagerImports = extractImports(globEagerSource);
    expect(globEagerImports.length, JSON.stringify(globEagerImports)).toBe(1);
    expect(globEagerImports[0].specifier).toBe('../stores/chatStore.ts');
    expect(globEagerImports[0].isTypeOnly, 'an import.meta.globEager edge is never type-only').toBe(false);
  });

  it('self-check: `import.meta.glob(pathVar)` with a non-literal argument is recorded as unresolvable, not dropped', () => {
    const source = `function f(pathVar: string) {\n  return import.meta.glob(pathVar);\n}\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier, 'a non-literal import.meta.glob argument cannot be resolved').toBeNull();
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a re-export ("export { x } from \'...\'") is detected', () => {
    const source = `export { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a re-export ("export * from \'...\'") is detected', () => {
    const source = `export * from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a tight bare-star re-export ("export*from\'...\';", no spaces) is detected', () => {
    const source = `export*from'../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a re-export with a namespace alias ("export * as ns from \'...\'") is detected', () => {
    const source = `export * as ns from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a tight namespace-alias re-export ("export*as ns from\'...\';", no spaces around `*`) is detected', () => {
    const source = `export*as ns from'../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
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

  it('self-check: a tight type-only re-export ("export type{A}from\'...\';", no spaces) is detected as type-only', () => {
    const source = `export type{A}from'../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('self-check: an inline `{ type A }` named-import specifier is a VALUE edge, not type-only — under `verbatimModuleSyntax: true` only a declaration-level `import type` elides the statement entirely', () => {
    const inlineType = `import { type A } from '../stores/chatStore';\n`;
    const declType = `import type { A } from '../stores/chatStore';\n`;

    const inlineImports = extractImports(inlineType);
    expect(inlineImports.length, JSON.stringify(inlineImports)).toBe(1);
    expect(inlineImports[0].isTypeOnly, 'an inline `{ type A }` specifier must NOT make the statement type-only').toBe(
      false
    );

    const declImports = extractImports(declType);
    expect(declImports.length, JSON.stringify(declImports)).toBe(1);
    expect(declImports[0].isTypeOnly, 'a declaration-level `import type` must be type-only').toBe(true);
  });

  it('self-check: an inline `{ type A }` re-export specifier is a VALUE edge, and a declaration-level `export type` re-export is type-only', () => {
    const inlineType = `export { type A } from '../stores/chatStore';\n`;
    const declType = `export type { A } from '../stores/chatStore';\n`;

    const inlineImports = extractImports(inlineType);
    expect(inlineImports.length, JSON.stringify(inlineImports)).toBe(1);
    expect(
      inlineImports[0].isTypeOnly,
      'an inline `{ type A }` re-export specifier must NOT make the statement type-only'
    ).toBe(false);

    const declImports = extractImports(declType);
    expect(declImports.length, JSON.stringify(declImports)).toBe(1);
    expect(declImports[0].isTypeOnly, 'a declaration-level `export type` re-export must be type-only').toBe(true);
  });

  it('self-check: `import type * as ns` (namespace) and `import type X` (default) are both type-only', () => {
    const namespaceType = `import type * as ns from '../stores/chatStore';\n`;
    const defaultType = `import type X from '../stores/chatStore';\n`;

    const namespaceImports = extractImports(namespaceType);
    expect(namespaceImports.length, JSON.stringify(namespaceImports)).toBe(1);
    expect(namespaceImports[0].isTypeOnly, 'a type-only namespace import must be type-only').toBe(true);

    const defaultImports = extractImports(defaultType);
    expect(defaultImports.length, JSON.stringify(defaultImports)).toBe(1);
    expect(defaultImports[0].isTypeOnly, 'a type-only default import must be type-only').toBe(true);
  });

  it('self-check: a side-effect import directly above a type-only import produces TWO correct records, not one merged one', () => {
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

  it('self-check: an unrelated statement directly above an import, with no semicolon between them (ASI), produces one correct record', () => {
    const source = `export const A = 1\nimport type { b } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(true);
  });

  it('self-check: a multi-line import statement (named import list spanning several lines) is detected', () => {
    const source = `import {\n  useChatStore,\n  isWiFiredCoveragePartial,\n} from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a whitespace-less static import ("import{x}from\'...\';", legal TS — no spacing rule in eslint.config.js) is detected', () => {
    const source = `import{useChatStore}from'../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: a whitespace-less `import type{X}from\'...\';` is still detected as type-only', () => {
    const source = `import type{TokenizerProfile}from'../tokenizer';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../tokenizer');
    expect(imports[0].isTypeOnly, 'a tight `import type{...}` must still be type-only').toBe(true);
  });

  it('self-check: a whitespace-less side-effect import ("import\'x\';") is detected', () => {
    const source = `import'../stores/chatStore';\nexport const x = 1;\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly, 'a side-effect import is never type-only').toBe(false);
  });

  it('self-check: a whitespace-less re-export ("export{x}from\'...\';") is detected', () => {
    const source = `export{useChatStore}from'../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: an identifier beginning with "import" is not mistaken for the import keyword', () => {
    const source = `const importantFlag = true;\nimport { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: an identifier beginning with "export" is not mistaken for the export keyword', () => {
    const source = `const exportedFlag = true;\nexport { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it('self-check: an identifier containing "from" (`fromEntries`) is not mistaken for the `from` keyword', () => {
    const source = `const result = Object.fromEntries(pairs);\nimport { useChatStore } from '../stores/chatStore';\n`;
    const imports = extractImports(source);
    expect(imports.length, JSON.stringify(imports)).toBe(1);
    expect(imports[0].specifier).toBe('../stores/chatStore');
    expect(imports[0].isTypeOnly).toBe(false);
  });
});
