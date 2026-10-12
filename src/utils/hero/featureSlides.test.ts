// E6-S2 / D-H6 — pins the slide-config validator. The acceptance criterion this
// serves: "Invalid entries are skipped with a warning; a failed fetch gives zero
// feature slides without an error". The cost of getting it wrong is asymmetric:
// a validator that is too strict silently drops a curator's good slide, one that
// is too loose lets a half-edited entry render a blank headline or a CTA that
// opens nothing — and one that throws takes the whole hero down.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FEATURE_SLIDES_VERSION,
  parseFeatureSlides,
  validateFeatureSlides,
} from './featureSlides';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The D-H6 example from the design spec, verbatim: the pre-existing shape that must keep working. */
const SPEC_EXAMPLE = {
  version: 1,
  slides: [
    {
      id: 'selfie-mode',
      enabled: true,
      title: 'Take a selfie with your character',
      body: 'One or two sentences, plain text, ≤ 160 chars.',
      image: '/hero/selfie-mode.webp',
      imageAlt: '',
      requires: 'character:create',
      cta: {
        label: 'Learn more',
        modal: { kind: 'feature', heading: 'Selfie mode', image: '/hero/selfie-mode.webp', bodyMarkdown: '…' },
      },
    },
  ],
};

function feature(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    title: 'A feature',
    body: 'Plain text.',
    image: '/hero/f1.webp',
    cta: { label: 'Learn more', modal: { kind: 'feature', heading: 'Heading', bodyMarkdown: 'Body' } },
    ...overrides,
  };
}

describe('validateFeatureSlides — accepted shapes', () => {
  it('reads the D-H6 spec example with no problems (absent kind means feature)', () => {
    const r = validateFeatureSlides(SPEC_EXAMPLE);
    expect(r.rootProblem).toBeNull();
    expect(r.problems).toEqual([]);
    expect(r.slides).toHaveLength(1);
    expect(r.slides[0]).toMatchObject({
      kind: 'feature',
      id: 'selfie-mode',
      enabled: true,
      imageAlt: '',
      requires: 'character:create',
      cta: { label: 'Learn more', modal: { kind: 'feature', heading: 'Selfie mode' } },
    });
  });

  it('defaults a feature entry: enabled true, imageAlt "", no requires', () => {
    const [s] = validateFeatureSlides({ version: 1, slides: [feature()] }).slides;
    expect(s).toMatchObject({ kind: 'feature', enabled: true, imageAlt: '' });
    expect('requires' in s).toBe(false);
  });

  it('accepts a character entry that carries only an avatar', () => {
    const r = validateFeatureSlides({ version: 1, slides: [{ kind: 'character', avatar: 'ivy.png' }] });
    expect(r.problems).toEqual([]);
    expect(r.slides[0]).toMatchObject({ kind: 'character', avatar: 'ivy.png', enabled: true });
  });

  it('keeps an explicit enabled:false so the model can drop it (not the validator)', () => {
    const [s] = validateFeatureSlides({
      version: 1,
      slides: [feature({ enabled: false })],
    }).slides;
    expect(s.enabled).toBe(false);
  });

  it('accepts a feature CTA that opens a character', () => {
    const r = validateFeatureSlides({
      version: 1,
      slides: [feature({ cta: { label: 'Meet Ivy', modal: { kind: 'character', avatar: 'ivy.png' } } })],
    });
    expect(r.problems).toEqual([]);
    expect(r.slides[0]).toMatchObject({ cta: { modal: { kind: 'character', avatar: 'ivy.png' } } });
  });

  it('keeps configured order across both kinds', () => {
    const r = validateFeatureSlides({
      version: 1,
      slides: [
        { kind: 'character', avatar: 'a.png' },
        feature({ id: 'mid' }),
        { kind: 'character', avatar: 'b.png' },
      ],
    });
    expect(r.slides.map((s) => (s.kind === 'character' ? s.avatar : s.id))).toEqual(['a.png', 'mid', 'b.png']);
  });

  it('does not warn: validation is pure, warning is the caller\'s job', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateFeatureSlides({ version: 1, slides: [{ nope: true }] });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('validateFeatureSlides — the file as a whole', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'slides'],
    ['a number', 7],
    ['an array', []],
    ['an HTML page parsed as text', '<!doctype html><html></html>'],
  ])('yields zero slides for %s (a root that is not an object)', (_label, raw) => {
    const r = validateFeatureSlides(raw);
    expect(r.slides).toEqual([]);
    expect(r.rootProblem).not.toBeNull();
  });

  it('yields zero slides for an unknown version, even if every entry looks fine', () => {
    const r = validateFeatureSlides({ version: FEATURE_SLIDES_VERSION + 1, slides: [feature()] });
    expect(r.slides).toEqual([]);
    expect(r.rootProblem).toMatch(/version/);
  });

  it('yields zero slides when version is missing', () => {
    expect(validateFeatureSlides({ slides: [feature()] }).slides).toEqual([]);
  });

  it('yields zero slides when slides is not an array', () => {
    const r = validateFeatureSlides({ version: 1, slides: { 0: feature() } });
    expect(r.slides).toEqual([]);
    expect(r.rootProblem).toMatch(/slides/);
  });

  it('accepts the shipped empty config', () => {
    const r = validateFeatureSlides({ version: 1, slides: [] });
    expect(r).toEqual({ slides: [], problems: [], rootProblem: null });
  });
});

describe('validateFeatureSlides — each bad entry is skipped and the good ones survive', () => {
  const BAD: Array<[string, unknown, RegExp]> = [
    ['a non-object entry', 'oops', /not an object/],
    ['a null entry', null, /not an object/],
    ['a missing id', feature({ id: undefined }), /"id"/],
    ['an empty title', feature({ title: '   ' }), /"title"/],
    ['a missing body', feature({ body: undefined }), /"body"/],
    ['a missing image', feature({ image: undefined }), /"image"/],
    ['a missing cta', feature({ cta: undefined }), /cta/],
    ['a cta with no label', feature({ cta: { modal: { kind: 'character', avatar: 'x.png' } } }), /label/],
    ['a cta with no modal', feature({ cta: { label: 'Go' } }), /modal/],
    ['a modal of unknown kind', feature({ cta: { label: 'Go', modal: { kind: 'video' } } }), /kind/],
    [
      'a feature modal with no heading',
      feature({ cta: { label: 'Go', modal: { kind: 'feature', bodyMarkdown: 'x' } } }),
      /heading/,
    ],
    [
      'a feature modal with no body',
      feature({ cta: { label: 'Go', modal: { kind: 'feature', heading: 'x' } } }),
      /bodyMarkdown/,
    ],
    [
      'a character modal with no avatar',
      feature({ cta: { label: 'Go', modal: { kind: 'character' } } }),
      /avatar/,
    ],
    [
      'a non-string modal image',
      feature({ cta: { label: 'Go', modal: { kind: 'feature', heading: 'h', bodyMarkdown: 'b', image: 3 } } }),
      /image/,
    ],
    ['a non-string imageAlt', feature({ imageAlt: 5 }), /imageAlt/],
    ['a non-string requires', feature({ requires: 5 }), /requires/],
    ['an empty requires', feature({ requires: '' }), /requires/],
    ['a non-boolean enabled', feature({ enabled: 'yes' }), /enabled/],
    ['an unknown kind', feature({ kind: 'banner' }), /kind/],
    ['a character entry with no avatar', { kind: 'character' }, /avatar/],
    ['a character entry with a numeric avatar', { kind: 'character', avatar: 7 }, /avatar/],
    ['a character entry with a non-string requires', { kind: 'character', avatar: 'a.png', requires: ['x'] }, /requires/],
  ];

  it.each(BAD)('skips %s', (_label, entry, reason) => {
    const good = feature({ id: 'good' });
    const r = validateFeatureSlides({ version: 1, slides: [good, entry, good] });
    expect(r.slides).toHaveLength(2);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].index).toBe(1);
    expect(r.problems[0].reason).toMatch(reason);
  });

  it('names the skipped entry\'s id so a curator can find it', () => {
    const r = validateFeatureSlides({ version: 1, slides: [feature({ id: 'broken', title: '' })] });
    expect(r.problems[0]).toMatchObject({ index: 0, id: 'broken' });
  });
});

describe('parseFeatureSlides — the runtime entry point', () => {
  it('warns exactly ONCE per skipped entry (D-H6) and returns the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parseFeatureSlides({
      version: 1,
      slides: [
        feature({ id: 'ok-1' }),
        feature({ id: 'bad-1', title: '' }),
        { kind: 'character', avatar: 'ivy.png' },
        feature({ id: 'bad-2', cta: undefined }),
        { kind: 'character' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain('bad-1');
    expect(String(warn.mock.calls[1][0])).toContain('bad-2');
  });

  it('does not warn for a clean config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseFeatureSlides(SPEC_EXAMPLE);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, not per entry, when the whole file is unusable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseFeatureSlides({ version: 2, slides: [feature(), feature()] })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws on anything JSON.parse can produce, nor on non-JSON values', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hostile: unknown[] = [
      undefined,
      null,
      NaN,
      () => 1,
      Symbol('x'),
      { version: 1, slides: [undefined, null, 1, 'x', [], {}, { kind: {} }, { cta: 7 }] },
      { version: 1, slides: [{ kind: 'character', avatar: {}, requires: {} }] },
      { version: 1, slides: [{ id: 1, title: 2, body: 3, image: 4, cta: { label: 5, modal: null } }] },
    ];
    for (const raw of hostile) {
      expect(() => parseFeatureSlides(raw)).not.toThrow();
    }
  });
});
