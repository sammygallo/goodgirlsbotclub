// E6-S2 — pins the hero's pure decisions. Each describe maps to an acceptance
// criterion that a component test could only reach indirectly:
//
//   resolveHeroSlides  "the `requires` permission is honored; a `character`
//                       slide for an invisible avatar is dropped"; D-H4 cap;
//                       D-H9 (no character survivor -> welcome)
//   parseServerUtc     the timezone trap behind "New this week"
//   buildRows          "rows with no visible items are omitted"; fixed order;
//                       Works gated on project:view AND at least one work

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CharacterInfo, ProjectListItem } from '../../api/client';
import type { SlideConfig } from './featureSlides';
import {
  MAX_HERO_SLIDES,
  NEW_WINDOW_MS,
  buildRows,
  initialOf,
  isNewThisWeek,
  parseServerUtc,
  resolveHeroSlides,
  slideTitle,
} from './heroModel';

afterEach(() => {
  vi.unstubAllEnvs();
});

function character(avatar: string, extra: Partial<CharacterInfo> = {}): CharacterInfo {
  return { name: avatar.replace('.png', ''), avatar, ...extra } as CharacterInfo;
}

function charSlide(avatar: string, extra: Partial<SlideConfig> = {}): SlideConfig {
  return { kind: 'character', id: `c-${avatar}`, enabled: true, avatar, ...extra } as SlideConfig;
}

function featureSlide(id: string, extra: Record<string, unknown> = {}): SlideConfig {
  return {
    kind: 'feature',
    id,
    enabled: true,
    title: `Feature ${id}`,
    body: 'Body',
    image: `/hero/${id}.webp`,
    imageAlt: '',
    cta: { label: 'Learn more', modal: { kind: 'feature', heading: 'H', bodyMarkdown: 'B' } },
    ...extra,
  } as SlideConfig;
}

const ADMIN = { role: 'admin' as const, permissions: ['character:create', 'project:view'] };
const PLAIN = { role: 'end_user' as const, permissions: ['character:view'] };

function work(id: string, status: 'active' | 'archived' = 'active'): ProjectListItem {
  return {
    id,
    name: `Work ${id}`,
    description: '',
    deliverable_type: 'novel',
    status,
    character_count: 0,
    chat_count: 0,
    updated_at: '2026-10-01T00:00:00',
  };
}

describe('resolveHeroSlides', () => {
  const chars = [character('ivy.png'), character('rose.png'), character('fern.png')];

  it('keeps configured order across both kinds', () => {
    const r = resolveHeroSlides({
      slides: [charSlide('rose.png'), featureSlide('a'), charSlide('ivy.png')],
      characters: chars,
      user: PLAIN,
    });
    expect(r.heroSlides.map(slideTitle)).toEqual(['rose', 'Feature a', 'ivy']);
    expect(r.featured.map((c) => c.avatar)).toEqual(['rose.png', 'ivy.png']);
    expect(r.hasCharacter).toBe(true);
  });

  it('drops enabled:false entries', () => {
    const r = resolveHeroSlides({
      slides: [charSlide('ivy.png', { enabled: false }), featureSlide('off', { enabled: false }), charSlide('rose.png')],
      characters: chars,
      user: PLAIN,
    });
    expect(r.heroSlides.map(slideTitle)).toEqual(['rose']);
  });

  describe('requires', () => {
    it('keeps a slide whose permission the user holds', () => {
      const r = resolveHeroSlides({
        slides: [charSlide('ivy.png'), featureSlide('gated', { requires: 'character:create' })],
        characters: chars,
        user: ADMIN,
      });
      expect(r.heroSlides.map(slideTitle)).toEqual(['ivy', 'Feature gated']);
    });

    it('drops a slide whose permission the user lacks', () => {
      const r = resolveHeroSlides({
        slides: [charSlide('ivy.png'), featureSlide('gated', { requires: 'character:create' })],
        characters: chars,
        user: PLAIN,
      });
      expect(r.heroSlides.map(slideTitle)).toEqual(['ivy']);
    });

    it('drops a gated CHARACTER entry too, and keeps it out of the Featured row', () => {
      const r = resolveHeroSlides({
        slides: [charSlide('ivy.png', { requires: 'character:create' }), charSlide('rose.png')],
        characters: chars,
        user: PLAIN,
      });
      expect(r.heroSlides.map(slideTitle)).toEqual(['rose']);
      expect(r.featured.map((c) => c.avatar)).toEqual(['rose.png']);
    });

    it('drops every gated slide when there is no user at all', () => {
      const r = resolveHeroSlides({
        slides: [charSlide('ivy.png', { requires: 'character:view' })],
        characters: chars,
        user: null,
      });
      expect(r.heroSlides).toEqual([]);
    });

    it('does not gate an entry that names no permission', () => {
      const r = resolveHeroSlides({ slides: [charSlide('ivy.png')], characters: chars, user: null });
      expect(r.heroSlides).toHaveLength(1);
    });
  });

  describe('visibility: the characters lookup', () => {
    it('drops a character entry whose avatar this user cannot see', () => {
      const r = resolveHeroSlides({
        slides: [charSlide('ghost.png'), charSlide('ivy.png')],
        characters: chars,
        user: PLAIN,
      });
      expect(r.heroSlides.map(slideTitle)).toEqual(['ivy']);
      expect(r.featured.map((c) => c.avatar)).toEqual(['ivy.png']);
    });

    it('drops a FEATURE entry whose CTA opens an invisible character', () => {
      const ghostCta = { label: 'Meet', modal: { kind: 'character', avatar: 'ghost.png' } };
      const r = resolveHeroSlides({
        slides: [featureSlide('meet-ghost', { cta: ghostCta }), charSlide('ivy.png')],
        characters: chars,
        user: PLAIN,
      });
      expect(r.heroSlides.map(slideTitle)).toEqual(['ivy']);
    });

    it('keeps a feature entry whose CTA opens a visible character, handing over that character', () => {
      const cta = { label: 'Meet Ivy', modal: { kind: 'character', avatar: 'ivy.png' } };
      const r = resolveHeroSlides({ slides: [featureSlide('meet', { cta }), charSlide('rose.png')], characters: chars, user: PLAIN });
      const first = r.heroSlides[0];
      expect(first.type).toBe('feature');
      if (first.type === 'feature') expect(first.modalCharacter?.avatar).toBe('ivy.png');
    });

    it('does not count a feature slide as a featured CHARACTER', () => {
      const cta = { label: 'Meet Ivy', modal: { kind: 'character', avatar: 'ivy.png' } };
      const r = resolveHeroSlides({ slides: [featureSlide('meet', { cta })], characters: chars, user: PLAIN });
      expect(r.featured).toEqual([]);
      expect(r.hasCharacter).toBe(false);
    });
  });

  it('removes a repeated character entry (first wins), in the hero and in the row', () => {
    const r = resolveHeroSlides({
      slides: [charSlide('ivy.png'), charSlide('rose.png'), charSlide('ivy.png', { id: 'again' })],
      characters: chars,
      user: PLAIN,
    });
    expect(r.heroSlides.map(slideTitle)).toEqual(['ivy', 'rose']);
    expect(r.featured.map((c) => c.avatar)).toEqual(['ivy.png', 'rose.png']);
  });

  describe('cap 5 after filtering (D-H4)', () => {
    const many = Array.from({ length: 8 }, (_, i) => character(`c${i}.png`));

    it('takes the first five SURVIVORS, not the first five configured', () => {
      const r = resolveHeroSlides({
        // c0 and c1 are dropped (disabled / invisible); the cap must not have been spent on them.
        slides: [
          charSlide('c0.png', { enabled: false }),
          charSlide('nobody.png'),
          ...many.slice(1).map((c) => charSlide(c.avatar)),
        ],
        characters: many,
        user: PLAIN,
      });
      expect(MAX_HERO_SLIDES).toBe(5);
      expect(r.heroSlides.map((s) => (s.type === 'character' ? s.character.avatar : ''))).toEqual([
        'c1.png',
        'c2.png',
        'c3.png',
        'c4.png',
        'c5.png',
      ]);
    });

    it('leaves the Featured row uncapped', () => {
      const r = resolveHeroSlides({ slides: many.map((c) => charSlide(c.avatar)), characters: many, user: PLAIN });
      expect(r.heroSlides).toHaveLength(5);
      expect(r.featured).toHaveLength(8);
    });
  });

  describe('hasCharacter (D-H9: the welcome panel)', () => {
    it('is false when no slides are configured', () => {
      expect(resolveHeroSlides({ slides: [], characters: chars, user: PLAIN }).hasCharacter).toBe(false);
    });

    it('is false when only announcements survive: they do not earn a hero on their own', () => {
      const r = resolveHeroSlides({ slides: [featureSlide('a'), featureSlide('b')], characters: chars, user: PLAIN });
      expect(r.heroSlides).toHaveLength(2);
      expect(r.hasCharacter).toBe(false);
    });

    it('is false when every character entry was filtered out', () => {
      const r = resolveHeroSlides({ slides: [charSlide('ghost.png')], characters: chars, user: PLAIN });
      expect(r.hasCharacter).toBe(false);
    });

    it('is true even when the only character sits past the 5-slide cap', () => {
      const slides = [...['a', 'b', 'c', 'd', 'e'].map((id) => featureSlide(id)), charSlide('ivy.png')];
      const r = resolveHeroSlides({ slides, characters: chars, user: PLAIN });
      expect(r.heroSlides.every((s) => s.type === 'feature')).toBe(true);
      expect(r.hasCharacter).toBe(true);
    });
  });

  it('gives every slide a unique key, even when a curator reuses an id', () => {
    const r = resolveHeroSlides({
      slides: [featureSlide('dup'), featureSlide('dup'), charSlide('ivy.png')],
      characters: chars,
      user: PLAIN,
    });
    const keys = r.heroSlides.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseServerUtc', () => {
  it('reads a tz-naive backend timestamp as UTC', () => {
    expect(parseServerUtc('2026-10-12T14:23:45')).toBe(Date.UTC(2026, 9, 12, 14, 23, 45));
  });

  it('handles the backend\'s microsecond precision', () => {
    expect(parseServerUtc('2026-10-12T14:23:45.123456')).toBe(Date.UTC(2026, 9, 12, 14, 23, 45, 123));
  });

  it('accepts a space separator', () => {
    expect(parseServerUtc('2026-10-12 14:23:45')).toBe(Date.UTC(2026, 9, 12, 14, 23, 45));
  });

  it('trusts a string that already names its zone', () => {
    const utc = Date.UTC(2026, 9, 12, 14, 0, 0);
    expect(parseServerUtc('2026-10-12T14:00:00Z')).toBe(utc);
    expect(parseServerUtc('2026-10-12T14:00:00+00:00')).toBe(utc);
    expect(parseServerUtc('2026-10-12T16:00:00+02:00')).toBe(utc);
    expect(parseServerUtc('2026-10-12T09:00:00-05:00')).toBe(utc);
  });

  it.each([undefined, null, '', '   ', 'yesterday', '2026-13-45T99:99:99'])('returns null for %j', (v) => {
    expect(parseServerUtc(v as string | null | undefined)).toBeNull();
  });

  // The reason this function exists. Date.parse reads a zone-less date-time as
  // LOCAL time, so the same backend string means a different instant on every
  // device. The stubbed zones sit at the extremes (UTC+14 / UTC-11); the
  // sanity assertion proves the stub took effect, so a runtime that ignored
  // TZ would fail loudly here instead of passing for the wrong reason.
  describe.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('in %s', (tz) => {
    it('gives the same instant as UTC, unlike a naive Date.parse', () => {
      vi.stubEnv('TZ', tz);
      const naive = '2026-10-12T00:00:00.123456';
      expect(Date.parse('2026-10-12T00:00:00.123')).not.toBe(Date.UTC(2026, 9, 12, 0, 0, 0, 123));
      expect(parseServerUtc(naive)).toBe(Date.UTC(2026, 9, 12, 0, 0, 0, 123));
    });

    it('decides "new this week" on the UTC edge, not the local one', () => {
      vi.stubEnv('TZ', tz);
      const now = Date.UTC(2026, 9, 12, 12, 0, 0);
      const justInside = new Date(now - NEW_WINDOW_MS + 60_000).toISOString().replace('Z', '');
      const justOutside = new Date(now - NEW_WINDOW_MS - 60_000).toISOString().replace('Z', '');
      expect(isNewThisWeek({ create_date: justInside }, now)).toBe(true);
      expect(isNewThisWeek({ create_date: justOutside }, now)).toBe(false);
    });
  });
});

describe('isNewThisWeek', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const at = (msAgo: number) => ({ create_date: new Date(now - msAgo).toISOString().replace('Z', '') });

  it('is true for a character created now', () => {
    expect(isNewThisWeek(at(0), now)).toBe(true);
  });

  it('includes exactly seven days ago and excludes one millisecond more', () => {
    expect(isNewThisWeek(at(NEW_WINDOW_MS), now)).toBe(true);
    expect(isNewThisWeek(at(NEW_WINDOW_MS + 1), now)).toBe(false);
  });

  it('counts a timestamp in the future (server clock ahead of this device)', () => {
    expect(isNewThisWeek(at(-3_600_000), now)).toBe(true);
  });

  it('is false for a missing or unreadable create_date', () => {
    expect(isNewThisWeek({}, now)).toBe(false);
    expect(isNewThisWeek({ create_date: 'not a date' }, now)).toBe(false);
  });
});

describe('buildRows', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString().replace('Z', '');
  const base = { featured: [], characters: [], works: [], canViewWorks: true, now };

  it('omits every row that has no items (nothing is rendered empty)', () => {
    expect(buildRows(base)).toEqual([]);
  });

  it('omits a row whose only items fall outside its rule', () => {
    const rows = buildRows({ ...base, characters: [character('old.png', { create_date: daysAgo(30) })] });
    expect(rows).toEqual([]);
  });

  it('puts rows in the fixed order Featured, New this week, Works', () => {
    const ivy = character('ivy.png', { create_date: daysAgo(1) });
    const rows = buildRows({ ...base, featured: [ivy], characters: [ivy], works: [work('w1')] });
    expect(rows.map((r) => r.id)).toEqual(['featured', 'new', 'works']);
    expect(rows.map((r) => r.title)).toEqual(['Featured characters', 'New this week', 'Works']);
    expect(rows.map((r) => r.tag)).toEqual(['CHARACTER', 'NEW', 'WORK']);
  });

  it('keeps the order when only some rows exist', () => {
    const ivy = character('ivy.png', { create_date: daysAgo(1) });
    expect(buildRows({ ...base, characters: [ivy], works: [work('w1')] }).map((r) => r.id)).toEqual(['new', 'works']);
    expect(buildRows({ ...base, featured: [ivy], works: [work('w1')] }).map((r) => r.id)).toEqual(['featured', 'works']);
  });

  describe('Works is gated on project:view AND at least one work', () => {
    it('shows with the permission and a work', () => {
      expect(buildRows({ ...base, works: [work('w1')] }).map((r) => r.id)).toEqual(['works']);
    });

    it('is absent without the permission, even when works exist', () => {
      expect(buildRows({ ...base, works: [work('w1')], canViewWorks: false })).toEqual([]);
    });

    it('is absent with the permission but no works', () => {
      expect(buildRows({ ...base, works: [], canViewWorks: true })).toEqual([]);
    });

    it('includes archived works, as the sidebar list does', () => {
      const rows = buildRows({ ...base, works: [work('w1', 'archived')] });
      expect(rows).toHaveLength(1);
      expect(rows[0].items).toHaveLength(1);
    });
  });

  describe('New this week', () => {
    it('lists only characters created within seven days, newest first', () => {
      const a = character('a.png', { create_date: daysAgo(5) });
      const b = character('b.png', { create_date: daysAgo(1) });
      const c = character('c.png', { create_date: daysAgo(8) });
      const d = character('d.png', { create_date: daysAgo(3) });
      const rows = buildRows({ ...base, characters: [a, b, c, d] });
      expect(rows).toHaveLength(1);
      expect((rows[0].items as CharacterInfo[]).map((x) => x.avatar)).toEqual(['b.png', 'd.png', 'a.png']);
    });

    it('is uncapped', () => {
      const many = Array.from({ length: 40 }, (_, i) => character(`n${i}.png`, { create_date: daysAgo(i / 10) }));
      const rows = buildRows({ ...base, characters: many });
      expect(rows[0].items).toHaveLength(40);
    });

    it('ignores characters with no readable create_date', () => {
      const rows = buildRows({ ...base, characters: [character('x.png'), character('y.png', { create_date: 'garbage' })] });
      expect(rows).toEqual([]);
    });
  });

  it('does not mutate the arrays it was handed', () => {
    const characters = [
      character('a.png', { create_date: daysAgo(5) }),
      character('b.png', { create_date: daysAgo(1) }),
    ];
    const snapshot = characters.map((c) => c.avatar);
    buildRows({ ...base, characters });
    expect(characters.map((c) => c.avatar)).toEqual(snapshot);
  });
});

describe('initialOf', () => {
  it('is the first letter, upper-cased', () => {
    expect(initialOf('ivy')).toBe('I');
    expect(initialOf('  rose ')).toBe('R');
  });

  it('keeps a leading emoji whole instead of splitting its surrogate pair', () => {
    expect(initialOf('\u{1F338} Bloom')).toBe('\u{1F338}');
    expect('\u{1F338} Bloom'.charAt(0)).not.toBe('\u{1F338}'); // what charAt would have done
  });

  it('falls back to a question mark for an empty name', () => {
    expect(initialOf('')).toBe('?');
    expect(initialOf('   ')).toBe('?');
  });
});
