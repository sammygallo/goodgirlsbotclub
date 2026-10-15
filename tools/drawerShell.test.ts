// E6-S3 drawer motion guards that need node's `fs`: the four keyframes and the
// four classes that slide the drawer and fade its scrim (D-S4), and the
// reduced-motion block that switches them off.
//
// Lives in `tools/` for the same reason as heroSlides.test.ts: it reads a file,
// and tsconfig.app.json carries no node lib.
//
// The stylesheet is read as text. A rule is found by its literal selector, and a
// block by counting its braces to the matching close, so a renamed or dropped
// rule fails here and nothing parses Tailwind class syntax.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/index.css', import.meta.url).pathname, 'utf8');

/** The body of the rule whose selector is `selector`, up to its first closing brace, whitespace collapsed. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  const open = start + selector.length + 2;
  return css.slice(open, css.indexOf('}', open)).replace(/\s+/g, ' ').trim();
}

/** The whole block that begins with `opener`, through its matching closing brace. */
function blockOf(opener: string): string {
  const start = css.indexOf(opener);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start + opener.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return '';
}

const drawerClasses: Array<[string, string]> = [
  ['.animate-drawer-in', 'animation: drawer-in 200ms ease-in-out;'],
  ['.animate-drawer-out', 'animation: drawer-out 200ms ease-in-out forwards;'],
  ['.animate-drawer-scrim-in', 'animation: drawer-scrim-in 200ms ease-in-out;'],
  ['.animate-drawer-scrim-out', 'animation: drawer-scrim-out 200ms ease-in-out forwards;'],
];

describe('navigation drawer motion (E6-S3, D-S4)', () => {
  it.each(['drawer-in', 'drawer-out', 'drawer-scrim-in', 'drawer-scrim-out'])('defines the @keyframes %s', (name) => {
    expect(css).toContain(`@keyframes ${name} {`);
  });

  it.each(drawerClasses)('gives %s the 200 ms ease-in-out animation it names', (selector, body) => {
    expect(ruleBody(selector)).toBe(body);
  });

  it('lists all four drawer classes inside the prefers-reduced-motion block', () => {
    const block = blockOf('@media (prefers-reduced-motion: reduce) {');
    expect(block).toContain('animation: none;');
    for (const [selector] of drawerClasses) {
      expect(block.includes(`${selector},`) || block.includes(`${selector} {`)).toBe(true);
    }
  });
});
