// E6-S2 guards that need node's `fs`: the shipped slide config, the fixed hero
// colours, and the places the hero is wired in.
//
// Lives in `tools/` for the same reason as provenanceWiring.test.ts: it reads
// files, and `tsconfig.app.json` (the project covering `src/`) carries no node
// lib, so a `node:fs` import under `src/` fails `tsc -b`.
//
// What each guard stands in for:
//
//   shipped config   "slide config editable without code changes" is only
//                    worth anything if a typo in the file cannot reach
//                    production silently. The runtime skips a bad entry with a
//                    console.warn, which nobody is watching; this fails CI
//                    instead. It runs the REAL validator (zero-import by
//                    design), not a copy.
//   hero colours     D-H20's contrast guarantee is arithmetic over the scrim
//                    stops. Edit a stop and the guarantee silently goes; this
//                    recomputes it from the CSS that ships.
//   wiring           D-H1: the hero replaces ChatView's no-selection branch
//                    and nothing else. ChatView has no component test (it is
//                    far too heavy to mount), so the branch is pinned at the
//                    source level, as provenanceWiring.test.ts does for its
//                    props.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { validateFeatureSlides, type SlideConfig } from '../src/utils/hero/featureSlides';

const root = (rel: string) => new URL(`../${rel}`, import.meta.url).pathname;
const read = (rel: string) => readFileSync(root(rel), 'utf8');

// ---------------------------------------------------------------------------
// The shipped config

/** Local image paths a config refers to (feature art and modal art); external URLs are not ours to check. */
function localImagePaths(slides: SlideConfig[]): string[] {
  const out: string[] = [];
  for (const s of slides) {
    if (s.kind !== 'feature') continue;
    out.push(s.image);
    if (s.cta.modal.kind === 'feature' && s.cta.modal.image) out.push(s.cta.modal.image);
  }
  return out.filter((p) => p.startsWith('/') && !p.startsWith('//'));
}

describe('public/hero/feature-slides.json (as shipped)', () => {
  const raw = read('public/hero/feature-slides.json');

  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('is accepted by the runtime validator with zero skipped entries and no root problem', () => {
    const result = validateFeatureSlides(JSON.parse(raw));
    expect(result.rootProblem).toBeNull();
    expect(result.problems).toEqual([]);
  });

  it('is version 1, the only version this build reads', () => {
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('refers only to images that exist under public/', () => {
    const { slides } = validateFeatureSlides(JSON.parse(raw));
    const missing = localImagePaths(slides).filter((p) => !existsSync(root(`public${p}`)));
    expect(missing).toEqual([]);
  });

  it('has a detector that WOULD notice a bad entry or a missing image (the checks above are otherwise vacuous on an empty file)', () => {
    const bad = validateFeatureSlides({
      version: 1,
      slides: [
        { id: 'half-edited', title: 'Oops' },
        {
          id: 'ghost-art',
          title: 'T',
          body: 'B',
          image: '/hero/definitely-not-a-file.webp',
          cta: { label: 'Go', modal: { kind: 'feature', heading: 'H', bodyMarkdown: 'B' } },
        },
      ],
    });
    expect(bad.problems).toHaveLength(1);
    const missing = localImagePaths(bad.slides).filter((p) => !existsSync(root(`public${p}`)));
    expect(missing).toEqual(['/hero/definitely-not-a-file.webp']);
  });

  it('ships a curation guide, so "editable without code" has instructions', () => {
    const guide = read('docs/hero-feature-slides.md');
    expect(guide).toContain('public/hero/feature-slides.json');
    expect(guide).toContain('"version": 1');
  });
});

// ---------------------------------------------------------------------------
// D-H20: fixed hero colours

describe('index.css hero colours (D-H20)', () => {
  const css = read('src/index.css');
  const decl = (name: string) => {
    const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };

  it('defines the four fixed variables in :root', () => {
    for (const v of ['--scrim-hero', '--scrim-hero-side', '--on-scrim-text', '--on-scrim-text-muted']) {
      expect(decl(v), v).not.toBeNull();
    }
    expect(decl('--on-scrim-text')).toBe('#ffffff');
    expect(decl('--on-scrim-text-muted')).toBe('rgb(255 255 255 / .85)');
  });

  it('holds scrim alpha at .55 or more through the first 55% of the side scrim and the bottom 45% of the bottom scrim', () => {
    expect(decl('--scrim-hero-side')).toMatch(/rgb\(0 0 0 \/ \.80\) 0%.*rgb\(0 0 0 \/ \.55\) 55%/);
    expect(decl('--scrim-hero')).toMatch(/rgb\(0 0 0 \/ \.80\) 0%.*rgb\(0 0 0 \/ \.55\) 45%/);
  });

  it('keeps white text at 4.5:1 or better over a pure-white image under that scrim (#737373: 4.74:1)', () => {
    const linear = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: number) => linear(c); // grey: r = g = b
    const alpha = 0.55; // the weakest stop any hero text sits on
    const whiteImageUnderScrim = Math.round(255 * (1 - alpha));
    expect(whiteImageUnderScrim).toBe(115); // #737373
    const ratio = (1 + 0.05) / (luminance(whiteImageUnderScrim) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeCloseTo(4.74, 1);
  });

  it('defines the contrast-safe focus ring (D-H19)', () => {
    expect(css).toMatch(/\.focus-ring-contrast:focus-visible\s*{[^}]*outline:\s*2px solid #ffffff[^}]*outline-offset:\s*2px[^}]*box-shadow:\s*0 0 0 6px #000000/);
  });
});

// ---------------------------------------------------------------------------
// D-H1 and the Browse / See all targets

/** The text of the `{ ... }` block that opens at the first `{` after `marker`, or null. */
function blockAfter(source: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const open = source.indexOf('{', at + marker.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return null;
}

const countOf = (source: string, needle: string) => source.split(needle).length - 1;

describe('where the hero is wired in', () => {
  const NO_SELECTION = 'if (!selectedCharacter && !isGroupChatMode) {';

  it('ChatView renders HeroPage exactly once, and only inside the no-selection branch (D-H1)', () => {
    const chatView = read('src/components/chat/ChatView.tsx');
    expect(countOf(chatView, '<HeroPage')).toBe(1);
    const branch = blockAfter(chatView, NO_SELECTION);
    expect(branch).not.toBeNull();
    expect(branch).toContain('<HeroPage');
  });

  it('detects a HeroPage moved out of the branch, or a second one', () => {
    const moved = `${NO_SELECTION} return null; }\nfunction Other() { return <HeroPage />; }`;
    expect(blockAfter(moved, NO_SELECTION)).not.toContain('<HeroPage');
    expect(countOf(`${NO_SELECTION} return <HeroPage />; }\n<HeroPage />`, '<HeroPage')).toBe(2);
    expect(blockAfter('no such branch', NO_SELECTION)).toBeNull();
  });

  it('MainLayout hands the page its drawer opener through the Outlet context', () => {
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(layout).toMatch(/<Outlet\s+context=\{outletContext\}\s*\/>/);
    expect(layout).toMatch(/\{\s*openSidebar\s*\}/);
  });

  it('the sidebar still has the two elements HeroPage focuses; if E6-S3 removes them, HeroPage must change with it', () => {
    const sidebar = read('src/components/layout/Sidebar.tsx');
    const hero = read('src/components/hero/HeroPage.tsx');
    for (const id of ['character-search', 'character-list']) {
      expect(sidebar, `Sidebar.tsx id="${id}"`).toMatch(new RegExp(`id="${id}"`));
      expect(hero, `HeroPage.tsx focuses #${id}`).toContain(`'${id}'`);
    }
  });
});
