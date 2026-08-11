// Source-hygiene guard: no raw control bytes in tracked source files.
//
// WHY THIS EXISTS. Two files in this repo once held a literal NUL byte
// (U+0000) as a composite-key delimiter — written as the raw byte rather
// than the `\u0000` escape. The strings were correct at runtime and the
// code worked, so nothing failed. What broke was TOOLING:
//
//   - `file(1)` classifies such a file as `data`, not text.
//   - `grep` and `ripgrep` therefore treat it as BINARY and silently
//     return no matches unless `-a`/`--text` is passed.
//   - `git diff` renders it as `Bin <n> -> <m> bytes` instead of a diff.
//
// A silent no-match is the dangerous part. During the phase-11 research a
// grep concluded that `run()` and `gatherIngestInputs` had no production
// callers — they had several — and a plan was drafted on that false
// premise before the contradiction was caught. Any future codemod,
// refactor or search-based review would skip these files the same way,
// and would have no idea it had.
//
// The escape compiles to the identical string, so this costs nothing at
// runtime and buys back every grep-shaped tool.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Lives in `tools/` rather than `src/` on purpose: it needs node's fs,
// and `tsconfig.app.json` deliberately ships browser libs with
// `types: ["vite/client"]` only. Widening the app project to carry node
// globals so one test can read files would be the wrong trade — this
// belongs with the build tooling, which already has them.
const SRC = new URL('../src/', import.meta.url).pathname;

/** Extensions worth policing — the ones people grep and codemod. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md'];

/**
 * Control characters that make a file "binary" to the usual tools.
 *
 * Tab (0x09), newline (0x0A) and carriage return (0x0D) are ordinary
 * text and excluded. Everything else below 0x20, plus DEL (0x7F), is
 * flagged: NUL is the one that has actually bitten us, but a stray
 * vertical tab or form feed would confuse the same tools.
 */
function controlByteOffsets(buf: Buffer): number[] {
  const hits: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) hits.push(i);
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

describe('source hygiene', () => {
  it('no source file contains a raw control byte', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const buf = readFileSync(file);
      const hits = controlByteOffsets(buf);
      if (hits.length === 0) continue;

      // Report the first hit with its line and a readable byte name, so
      // the failure says what to fix rather than just that something is
      // wrong somewhere.
      const at = hits[0];
      const line = buf.subarray(0, at).toString('utf8').split('\n').length;
      const code = buf[at].toString(16).padStart(2, '0');
      offenders.push(
        `${file.replace(SRC, 'src/')}:${line} — 0x${code} (${hits.length} total). ` +
          `Use the escape (e.g. \\u0000) instead of the raw byte.`
      );
    }

    expect(offenders).toEqual([]);
  });

  it('detects a raw control byte when one is present', () => {
    // The guard above only ever passes, so it cannot tell us whether it
    // still WORKS. This pins the detector itself against a synthetic
    // buffer — without it, a broken scan would look like a clean repo.
    const clean = Buffer.from('const key = `${a}\\u0000${b}`;\n\ttabs fine\r\n');
    expect(controlByteOffsets(clean)).toEqual([]);

    const dirty = Buffer.concat([
      Buffer.from('const key = `${a}'),
      Buffer.from([0x00]),
      Buffer.from('${b}`;'),
    ]);
    expect(controlByteOffsets(dirty)).toEqual([17]);
  });
});
