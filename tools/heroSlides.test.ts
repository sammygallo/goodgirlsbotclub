// E6-S2 guards that need node's `fs`: the shipped slide config, the service
// worker's entry for /hero/, the fixed hero colours and the geometry they depend
// on, and the places the hero is wired in.
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
// The service worker and /hero/

/** The paths in the fetch handler's network-only list: the first `if (...) { return; }`, whose requests the worker never answers. */
function networkOnlyPaths(source: string): string[] | null {
  const m = source.match(/if \(([^{}]*?)\)\s*\{\s*return;\s*\}/);
  return m ? Array.from(m[1].matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g), (p) => p[1]) : null;
}

describe('public/sw.js', () => {
  it('lists /hero/ among the paths the worker leaves to the browser', () => {
    expect(networkOnlyPaths(read('public/sw.js'))).toEqual(expect.arrayContaining(['/api', '/characters', '/hero/']));
  });

  it('has a detector that WOULD notice /hero/ missing from the list, or no list at all', () => {
    expect(networkOnlyPaths(`if (url.pathname.startsWith('/api')) { return; }`)).toEqual(['/api']);
    expect(networkOnlyPaths('no such block')).toBeNull();
  });
});

/** The slide config's fetch, with the option the curation guide's freshness sentence depends on. */
const REVALIDATING_FETCH = /fetch\(\s*FEATURE_SLIDES_URL\s*,\s*\{[^}]*\bcache:\s*'no-cache'[^}]*\}\s*\)/;

describe('useFeatureSlides.ts', () => {
  it('fetches FEATURE_SLIDES_URL with cache: \'no-cache\'', () => {
    expect(read('src/components/hero/useFeatureSlides.ts')).toMatch(REVALIDATING_FETCH);
  });

  it('has a detector that WOULD notice the option dropped, or another URL fetched', () => {
    expect(`await fetch(FEATURE_SLIDES_URL, { cache: 'no-cache', signal })`).toMatch(REVALIDATING_FETCH);
    expect(`await fetch(FEATURE_SLIDES_URL, { signal })`).not.toMatch(REVALIDATING_FETCH);
    expect(`await fetch(FEATURE_SLIDES_URL)`).not.toMatch(REVALIDATING_FETCH);
    expect(`await fetch('/other.json', { cache: 'no-cache' })`).not.toMatch(REVALIDATING_FETCH);
  });
});

// ---------------------------------------------------------------------------
// D-H20: fixed hero colours

/** How far into each scrim D-H20 holds alpha at .55 or more, in percent: the first 55% of the side scrim, the bottom 45% of the bottom one. */
const BAND = { side: 55, bottom: 45 } as const;

/**
 * The `rgb(0 0 0 / a) p%` colour stops of a scrim declaration, in order. It
 * throws on anything else in the declaration: a colour this cannot read is one
 * the guard cannot vouch for.
 */
function scrimStops(value: string): { alpha: number; at: number }[] {
  const stop = /rgb\(0 0 0 \/ ([\d.]+)\)\s+([\d.]+)%/g;
  const stops = Array.from(value.matchAll(stop), (m) => ({ alpha: Number(m[1]), at: Number(m[2]) }));
  const unread = value.replace(stop, '').replace(/^linear-gradient\(to \w+,/, '').replace(/[\s,)]/g, '');
  if (unread) throw new Error(`cannot read "${unread}" in: ${value}`);
  if (stops.some((s, i) => i > 0 && s.at < stops[i - 1].at)) throw new Error(`stops out of order in: ${value}`);
  return stops;
}

/** The weakest alpha in the first `band`% of a scrim. The band has to END on a stop, so no stretch of it lies unread between two. */
function weakestAlphaWithin(value: string, band: number): number {
  const inBand = scrimStops(value).filter((s) => s.at <= band);
  if (inBand[inBand.length - 1]?.at !== band) throw new Error(`no colour stop at ${band}% in: ${value}`);
  return Math.min(...inBand.map((s) => s.alpha));
}

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

  const side = () => decl('--scrim-hero-side') ?? '';
  const bottom = () => decl('--scrim-hero') ?? '';

  it('holds scrim alpha at .55 or more through the first 55% of the side scrim and the bottom 45% of the bottom scrim', () => {
    expect(side()).toMatch(/^linear-gradient\(to right,/);
    expect(bottom()).toMatch(/^linear-gradient\(to top,/);
    expect(weakestAlphaWithin(side(), BAND.side)).toBeGreaterThanOrEqual(0.55);
    expect(weakestAlphaWithin(bottom(), BAND.bottom)).toBeGreaterThanOrEqual(0.55);
  });

  it('keeps white text at 4.5:1 or better over a pure-white image under the weakest alpha in those bands (#737373: 4.74:1)', () => {
    const linear = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: number) => linear(c); // grey: r = g = b
    // The weakest alpha any hero text sits on, read from the CSS above.
    const alpha = Math.min(weakestAlphaWithin(side(), BAND.side), weakestAlphaWithin(bottom(), BAND.bottom));
    const whiteImageUnderScrim = Math.round(255 * (1 - alpha));
    expect(whiteImageUnderScrim).toBe(115); // #737373
    const ratio = (1 + 0.05) / (luminance(whiteImageUnderScrim) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeCloseTo(4.74, 1);
  });

  it('has a detector that WOULD notice a weak stop inside a band, a band that does not end on a stop, or a colour it cannot read', () => {
    const sideWith = (middle: string) =>
      `linear-gradient(to right, rgb(0 0 0 / .80) 0%, ${middle}rgb(0 0 0 / .55) 55%, rgb(0 0 0 / .25) 100%)`;
    expect(weakestAlphaWithin(sideWith(''), 55)).toBe(0.55);
    expect(weakestAlphaWithin(sideWith('rgb(0 0 0 / .10) 30%, '), 55)).toBe(0.1);
    expect(() => weakestAlphaWithin('linear-gradient(to right, rgb(0 0 0 / .80) 0%, rgb(0 0 0 / .25) 100%)', 55)).toThrow(
      /no colour stop at 55%/,
    );
    expect(() => weakestAlphaWithin(sideWith('rgba(0, 0, 0, .1) 30%, '), 55)).toThrow(/cannot read/);
    expect(() => weakestAlphaWithin(sideWith('rgb(0 0 0 / .1), '), 55)).toThrow(/cannot read/);
    expect(() => weakestAlphaWithin(sideWith('rgb(0 0 0 / .9) 70%, '), 55)).toThrow(/out of order/);
  });

  it('defines the contrast-safe focus ring (D-H19)', () => {
    expect(css).toMatch(/\.focus-ring-contrast:focus-visible\s*{[^}]*outline:\s*2px solid #ffffff[^}]*outline-offset:\s*2px[^}]*box-shadow:\s*0 0 0 6px #000000/);
  });
});

// ---------------------------------------------------------------------------
// D-H20 geometry: the phone text block against the bottom scrim's >= .55 band

describe('the phone text block sits inside the bottom scrim\'s >= .55 band (D-H20)', () => {
  const frame = read('src/components/hero/SlideFrame.tsx');
  const featureSlide = read('src/components/hero/FeatureSlide.tsx');
  const characterSlide = read('src/components/hero/CharacterSlide.tsx');

  // Everything the band has to cover is rem (Tailwind v4's text sizes and spacing
  // scale), so the block is summed at each root font size in ROOTS: the browser's
  // default, and its "Large" setting.
  const LINE_HEIGHT_REM: Record<string, number> = { 'text-sm': 1.25, 'text-base': 1.5, 'text-xl': 1.75 };
  const SPACING_REM = 0.25;
  const ROOTS = [16, 20];

  /** The classes of the element whose class list `tag` captures, minus responsive variants: what applies below 640px. */
  const phoneClasses = (source: string, tag: RegExp): string[] => {
    const m = source.match(tag);
    if (!m) throw new Error(`no element matches ${tag}`);
    return m[1].split(/\s+/).filter((c) => c && !c.includes(':'));
  };
  const spacing = (classes: string[], prefix: string, root: number) => {
    const c = classes.find((x) => new RegExp(`^${prefix}-[\\d.]+$`).test(x));
    if (!c) throw new Error(`no ${prefix}-N among: ${classes.join(' ')}`);
    return Number(c.slice(prefix.length + 1)) * SPACING_REM * root;
  };
  /** A text element's height: its lines (line-clamp-N, or truncate = one) times its line height. */
  const textHeight = (classes: string[], root: number) => {
    const size = classes.find((c) => c in LINE_HEIGHT_REM);
    const clamp = classes.find((c) => /^line-clamp-\d+$/.test(c));
    const lines = clamp ? Number(clamp.slice('line-clamp-'.length)) : classes.includes('truncate') ? 1 : NaN;
    if (!size || Number.isNaN(lines)) throw new Error(`cannot size: ${classes.join(' ')}`);
    return lines * LINE_HEIGHT_REM[size] * root;
  };

  /**
   * How far above the hero's bottom edge a slide's text block reaches below
   * 640px: its rows and the CTA row, the gaps between them, and the frame's
   * bottom padding. The kicker is `display: none` there (asserted below), so it
   * adds neither a row nor a gap.
   */
  function blockTop(rows: string[][], ctaRow: string[], ctaLines: number, root: number): number {
    const cta = phoneClasses(frame, /const CTA_BASE =\s*'([^']+)'/);
    const ctaHeight = Math.max(
      spacing(cta, 'min-h', root),
      ctaLines * LINE_HEIGHT_REM['text-sm'] * root + 2 * spacing(cta, 'py', root),
    );
    const column = phoneClasses(frame, /<div className="(flex w-full min-w-0 flex-col[^"]*)"/);
    const padded = phoneClasses(frame, /<div className="([^"]*\bitems-end\b[^"]*)"/);
    const text = rows.reduce((sum, r) => sum + textHeight(r, root), 0);
    return (
      text +
      ctaHeight +
      spacing(ctaRow, 'mt', root) +
      rows.length * spacing(column, 'gap', root) +
      spacing(padded, 'pb', root)
    );
  }

  /** Every <button> in a slide's source: its opening tag (braces tracked, so an arrow's `>` does not end it) and its children. */
  const buttonsOf = (source: string) => {
    const out: { open: string; children: string }[] = [];
    for (let at = source.indexOf('<button'); at !== -1; at = source.indexOf('<button', at + 1)) {
      const open = openingTagWith(source.slice(at), '<button') ?? '';
      out.push({ open, children: source.slice(at + open.length, source.indexOf('</button>', at)).trim() });
    }
    return out;
  };

  /**
   * The lines a slide's CTA labels can take. A label written as plain text in
   * the source is one line by construction. One that comes from config is one
   * line only if the classes say so: the button capped to its row (`max-w-full`)
   * around a label that truncates. Anything else is unbounded, and so is the
   * block above it.
   */
  const ctaLinesOf = (source: string): number => {
    const buttons = buttonsOf(source);
    if (buttons.length === 0) throw new Error('no CTA button found');
    const bounded = ({ open, children }: { open: string; children: string }) =>
      !children.includes('{') ||
      (/\bmax-w-full\b/.test(open) && /^<span className="[^"]*\btruncate\b[^"]*">\{[^}]*\}<\/span>$/.test(children));
    return buttons.every(bounded) ? 1 : Infinity;
  };

  const ctaRowOf = (source: string) => phoneClasses(source, /<div className="([^"]*\bflex-wrap\b[^"]*)"/);
  const featureTop = (source: string, root = 16) =>
    blockTop(
      [phoneClasses(source, /<h3 className="([^"]+)"/), phoneClasses(source, /<p className="([^"]+)"/)],
      ctaRowOf(source),
      ctaLinesOf(source),
      root,
    );
  // Worst case: both optional lines are present.
  const characterTop = (source: string, root = 16) =>
    blockTop(
      [
        phoneClasses(source, /<h3 className="([^"]+)"/),
        phoneClasses(source, /\{creator && <p className="([^"]+)"/),
        phoneClasses(source, /\{blurb && <p className="([^"]+)"/),
      ],
      ctaRowOf(source),
      ctaLinesOf(source),
      root,
    );

  /** The scrim layer's minimum height at a root font size: a rem minimum scales with it, a px one does not. */
  const layerMinPx = (source: string, root: number) => {
    const m = source.match(/h-\[max\(100%,([\d.]+)(px|rem)\)\]/);
    if (!m) throw new Error('no scrim layer minimum found');
    return Number(m[1]) * (m[2] === 'rem' ? root : 1);
  };
  const bandPx = (layerPx: number) => (layerPx * BAND.bottom) / 100;

  it('hides the kicker below 640px, where the block is sized without it', () => {
    expect(frame).toMatch(/<span className="hidden [^"]*\bsm:inline-block\b/);
  });

  it('bounds every CTA label to one line, which is all the block sum assumes about them', () => {
    // The feature CTA's label comes from config, so the classes are what bound it...
    expect(buttonsOf(featureSlide)[0].children).toContain('{config.cta.label}');
    expect(ctaLinesOf(featureSlide)).toBe(1);
    // ...and the character slide's labels are plain text in the source.
    expect(buttonsOf(characterSlide).map((b) => b.children)).toEqual(['Chat', 'About']);
    expect(ctaLinesOf(characterSlide)).toBe(1);
  });

  it('anchors the scrim layer to the bottom of a frame that clips it', () => {
    expect(phoneClasses(frame, /<div className="(relative h-full w-full overflow-hidden[^"]*)"/)).toContain('overflow-hidden');
    const layer = phoneClasses(frame, /className="([^"]*h-\[max\(100%,[^"]*)"/);
    for (const c of ['absolute', 'inset-x-0', 'bottom-0']) expect(layer, c).toContain(c);
  });

  it.each(ROOTS)('has a scrim layer tall enough that the >= .55 band covers the tallest slide at a %ipx root', (root) => {
    const band = bandPx(layerMinPx(frame, root));
    expect(band).toBeGreaterThan(0);
    expect(featureTop(featureSlide, root)).toBeLessThanOrEqual(band);
    expect(characterTop(characterSlide, root)).toBeLessThanOrEqual(band);
  });

  it('has a detector that WOULD notice a CTA label that is not clamped, or a character CTA that takes config text', () => {
    const unclamped = featureSlide.replace('<span className="truncate">', '<span>');
    expect(unclamped).not.toBe(featureSlide);
    expect(ctaLinesOf(unclamped)).toBe(Infinity);
    expect(ctaLinesOf(featureSlide.replace('max-w-full', ''))).toBe(Infinity);
    expect(featureTop(unclamped)).toBe(Infinity);
    expect(ctaLinesOf(characterSlide.replace(/>\s*Chat\s*<\/button>/, '>{label}</button>'))).toBe(Infinity);
  });

  it('has a detector that WOULD notice a fourth body line, the 400px layer this replaced, or a minimum in px at a larger root', () => {
    expect(featureTop(featureSlide.replace('line-clamp-3', 'line-clamp-4'))).toBeGreaterThan(bandPx(layerMinPx(frame, 16)));
    expect(featureTop(featureSlide)).toBeGreaterThan(bandPx(400));
    const inPx = frame.replace(/h-\[max\(100%,[\d.]+rem\)\]/, 'h-[max(100%,460px)]');
    expect(inPx).not.toBe(frame);
    expect(featureTop(featureSlide, 16)).toBeLessThanOrEqual(bandPx(layerMinPx(inPx, 16)));
    expect(featureTop(featureSlide, 20)).toBeGreaterThan(bandPx(layerMinPx(inPx, 20)));
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

/** The opening tag of the element carrying `needle`: from its `<` to the first `>` that is not inside braces. Null if absent. */
function openingTagWith(source: string, needle: string): string | null {
  const at = source.indexOf(needle);
  if (at === -1) return null;
  const start = source.lastIndexOf('<', at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    else if (source[i] === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

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

  // Below 1024px the character list is in the drawer, and Browse / See all can
  // only open it through this prop. Both ends of the seam have their own tests
  // (layoutContext.test.tsx, HeroPage.test.tsx); this is the link between them.
  const OPENER_PROP = /<HeroPage\s+onOpenSidebar=\{layout\?\.openSidebar\}/;

  it('ChatView hands HeroPage the layout\'s drawer opener (D-H11)', () => {
    const chatView = read('src/components/chat/ChatView.tsx');
    expect(blockAfter(chatView, NO_SELECTION)).toMatch(OPENER_PROP);
    expect(chatView).toMatch(/\bconst layout = useLayoutContext\(\);/);
  });

  it('detects a HeroPage rendered without the opener, or with a dead one', () => {
    for (const element of ['<HeroPage />', '<HeroPage onOpenSidebar={undefined} />', '<HeroPage onOpenSidebar={() => {}} />']) {
      expect(blockAfter(`${NO_SELECTION} return ${element}; }`, NO_SELECTION)).not.toMatch(OPENER_PROP);
    }
    expect(blockAfter(`${NO_SELECTION} return <HeroPage onOpenSidebar={layout?.openSidebar} />; }`, NO_SELECTION)).toMatch(OPENER_PROP);
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

  // A <div> takes focus only with a tabindex. HeroPage.test.tsx stands in its own
  // #character-list with one, so only this keeps the real element focusable.
  it('the sidebar\'s #character-list can take focus (tabIndex={-1}), or See all focuses nothing', () => {
    const tag = openingTagWith(read('src/components/layout/Sidebar.tsx'), 'id="character-list"');
    expect(tag).not.toBeNull();
    expect(tag).toMatch(/\btabIndex=\{-1\}/);
  });

  it('detects an element that cannot take focus, whichever order its attributes come in', () => {
    const needle = 'id="character-list"';
    expect(openingTagWith(`<div ref={r} ${needle} className="a">`, needle)).not.toMatch(/tabIndex/);
    expect(openingTagWith(`<div ${needle} tabIndex={-1} className="a">`, needle)).toMatch(/\btabIndex=\{-1\}/);
    expect(openingTagWith(`<div tabIndex={-1} ref={() => x()} ${needle}>`, needle)).toMatch(/\btabIndex=\{-1\}/);
    expect(openingTagWith('<div className="a">', needle)).toBeNull();
  });
});
