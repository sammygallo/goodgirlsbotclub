// Source-hygiene guard for the avatar-provenance pre-gate's production
// wiring (2026-08-24 adversarial review, Finding 4).
//
// LivePortraitSetup and GenerateSceneModal both gate on an `avatarProvenance`
// prop that mirrors the server-side enforcement (the backend re-hashes the
// live avatar and 403s independently). CharacterEdit.tsx and ChatView.tsx are
// the only two call sites that wire that prop to a real character's
// `avatar_provenance` field — and neither host component is exercised by a
// component-level test (both live inside heavier character/chat views not
// currently rendered in tests). Nothing would catch a refactor that swapped
// the wiring for a hardcoded literal like `avatarProvenance={'generated'}`,
// which would silently clear the gate for every character rather than
// failing loudly. This pins the wiring at the SOURCE level instead.
//
// Lives in `tools/` for the same reason as sourceHygiene.test.ts: it needs
// node's `fs`, and `tsconfig.app.json` (the project covering `src/`) ships
// `types: ["vite/client"]` only, with no node lib — a `node:fs` import under
// `src/` fails `tsc -b` (confirmed: "Cannot find module 'node:fs'"), which is
// exactly the trap `npm run build`'s test-file typecheck exists to catch.
// `tsconfig.node.json` (which covers `tools/`) carries `types: ["node"]`.
//
// A different concern from sourceHygiene.test.ts's raw-control-byte guard
// (wiring intent vs. byte-level file hygiene), so kept as its own file.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CHARACTER_EDIT = new URL('../src/components/character/CharacterEdit.tsx', import.meta.url).pathname;
const CHAT_VIEW = new URL('../src/components/chat/ChatView.tsx', import.meta.url).pathname;

/**
 * Matches `avatarProvenance={<expr>}` with any amount of whitespace around
 * the braces — so an ordinary formatting change (prettier re-wrap, etc.)
 * doesn't false-positive this test. `expr` is passed in literally (its `.`
 * escaped), so a string literal (`'generated'`) or a differently-named
 * variable won't match, and a dropped prop won't either.
 */
function wiresProvenanceProp(source: string, expr: string): boolean {
  const escaped = expr.replace(/\./g, '\\.');
  const re = new RegExp(`avatarProvenance\\s*=\\s*\\{\\s*${escaped}\\s*\\}`);
  return re.test(source);
}

describe('avatar-provenance wiring (source-level guard)', () => {
  it('CharacterEdit.tsx wires LivePortraitSetup to the live character.avatar_provenance', () => {
    const source = readFileSync(CHARACTER_EDIT, 'utf8');
    expect(wiresProvenanceProp(source, 'character.avatar_provenance')).toBe(true);
  });

  it('ChatView.tsx wires GenerateSceneModal to the live selectedCharacter.avatar_provenance', () => {
    const source = readFileSync(CHAT_VIEW, 'utf8');
    expect(wiresProvenanceProp(source, 'selectedCharacter.avatar_provenance')).toBe(true);
  });

  it('detects a hardcoded literal in place of the real wiring', () => {
    // The two assertions above only ever pass, so on their own they cannot
    // tell us whether the detector still WORKS. This pins it against the
    // exact mutation it exists to catch — swapping the real prop access for
    // a hardcoded 'generated' — without it, a broken regex would look like
    // clean wiring. Same rationale as sourceHygiene.test.ts's self-check.
    const real = 'avatarProvenance={character.avatar_provenance}';
    const mutated = "avatarProvenance={'generated'}";
    expect(wiresProvenanceProp(real, 'character.avatar_provenance')).toBe(true);
    expect(wiresProvenanceProp(mutated, 'character.avatar_provenance')).toBe(false);
    expect(wiresProvenanceProp('', 'character.avatar_provenance')).toBe(false);
  });
});
