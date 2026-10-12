// E6-S2 — the hero's pure decisions: which configured slides survive for THIS
// user, what the category rows hold, and how to read a server timestamp.
//
// Pure on purpose (no React, no stores, no DOM): every rule the story's
// acceptance criteria turn on — "the requires permission is honored", "a
// character slide for an invisible avatar is dropped", "rows with no items are
// omitted", "New this week" — is decided here, where a node-environment unit
// test can pin each one without mounting anything.

import type { CharacterInfo, ProjectListItem } from '../../api/client';
import { hasPermission } from '../permissions';
import type { FeatureSlideConfig, SlideConfig } from './featureSlides';

/** D-H4: the hero carries at most this many slides. */
export const MAX_HERO_SLIDES = 5;

/** D-H21: "New this week" looks back this far from now. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type PermissionSubject = Parameters<typeof hasPermission>[0];

// ---------------------------------------------------------------------------
// Slides

/** A slide the carousel can render, already checked against this user. */
export type HeroSlide =
  | { type: 'character'; key: string; character: CharacterInfo }
  | {
      type: 'feature';
      key: string;
      config: FeatureSlideConfig;
      /** Set when the CTA opens CharacterPreviewModal; the character is known to exist. */
      modalCharacter: CharacterInfo | null;
    };

export interface ResolvedHero {
  /** At most MAX_HERO_SLIDES survivors, in configured order (D-H4). */
  heroSlides: HeroSlide[];
  /** Surviving kind:"character" entries' characters: deduped, ordered, uncapped. */
  featured: CharacterInfo[];
  /**
   * True when at least one character entry survived. False is D-H9: no
   * carousel, no controls, no feature slides — the welcome panel instead, even
   * if announcements survived (they are not a reason to show a hero).
   */
  hasCharacter: boolean;
}

export interface ResolveInput {
  slides: readonly SlideConfig[];
  characters: readonly CharacterInfo[];
  user: PermissionSubject;
}

/**
 * Drops, in configured order: disabled entries; entries whose `requires`
 * permission the user lacks; character entries (and feature entries whose CTA
 * opens a character) whose avatar is not among the characters this user can
 * see. Then removes repeated character entries (first wins).
 *
 * The `characters` lookup is the visibility check. A featured avatar is a
 * per-user filename, so a slide can name a card this user never had; showing
 * it would open an empty modal or select nothing.
 */
export function resolveHeroSlides({ slides, characters, user }: ResolveInput): ResolvedHero {
  const byAvatar = new Map<string, CharacterInfo>();
  for (const c of characters) byAvatar.set(c.avatar, c);

  const survivors: HeroSlide[] = [];
  const featured: CharacterInfo[] = [];
  const seenAvatars = new Set<string>();

  slides.forEach((slide, index) => {
    if (!slide.enabled) return;
    if (slide.requires !== undefined && !hasPermission(user, slide.requires)) return;

    if (slide.kind === 'character') {
      const character = byAvatar.get(slide.avatar);
      if (!character) return;
      if (seenAvatars.has(slide.avatar)) return;
      seenAvatars.add(slide.avatar);
      featured.push(character);
      survivors.push({ type: 'character', key: `character:${slide.avatar}`, character });
      return;
    }

    let modalCharacter: CharacterInfo | null = null;
    if (slide.cta.modal.kind === 'character') {
      modalCharacter = byAvatar.get(slide.cta.modal.avatar) ?? null;
      if (!modalCharacter) return;
    }
    // The index keeps keys unique even if a curator reuses an id.
    survivors.push({ type: 'feature', key: `feature:${slide.id}:${index}`, config: slide, modalCharacter });
  });

  return {
    heroSlides: survivors.slice(0, MAX_HERO_SLIDES),
    featured,
    hasCharacter: featured.length > 0,
  };
}

/** The visible name of a slide: the character's name, or the feature's title. */
export function slideTitle(slide: HeroSlide): string {
  return slide.type === 'character' ? slide.character.name : slide.config.title;
}

// ---------------------------------------------------------------------------
// Timestamps

const ISO_NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Milliseconds since the epoch for a timestamp the BACKEND wrote, or null.
 *
 * `create_date` is a tz-naive column whose wall-clock value IS UTC
 * (ggbc-backend app/models/character.py), so pydantic serialises it with no
 * zone suffix. `Date.parse` reads a suffix-less date-time as LOCAL time, which
 * skews the value by the viewer's UTC offset — up to 14 hours at the edge of
 * the 7-day "New this week" window. Appending `Z` pins it to UTC. A string
 * that already names a zone is trusted as written.
 *
 * Deliberately NOT done in api/client.ts: toCharacterInfo's `date_added`
 * (the same value, parsed local) feeds the sidebar's sort, which this story
 * does not own.
 */
export function parseServerUtc(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  if (ISO_NAIVE.test(s)) {
    // Date.parse is only specified for millisecond precision; the backend
    // sends microseconds.
    s = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (!HAS_ZONE.test(s)) s += 'Z';
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * True when the character was created within the last 7 days. A timestamp in
 * the future (the server clock running ahead of this device) still counts as
 * new; an unreadable one does not.
 */
export function isNewThisWeek(character: Pick<CharacterInfo, 'create_date'>, now: number): boolean {
  const created = parseServerUtc(character.create_date);
  return created !== null && now - created <= NEW_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Category rows (D-H21)

export interface CharacterRowModel {
  id: 'featured' | 'new';
  title: string;
  tag: 'CHARACTER' | 'NEW';
  items: CharacterInfo[];
}

export interface WorksRowModel {
  id: 'works';
  title: string;
  tag: 'WORK';
  items: ProjectListItem[];
}

export type RowModel = CharacterRowModel | WorksRowModel;

export interface BuildRowsInput {
  /** The Featured characters row's content (ResolvedHero.featured). */
  featured: readonly CharacterInfo[];
  /** Every character this user can see, for "New this week". */
  characters: readonly CharacterInfo[];
  works: readonly ProjectListItem[];
  /** project:view. Without it the Works row never exists, items or not. */
  canViewWorks: boolean;
  now: number;
}

/**
 * The rows, in the fixed D-H21 order — Featured, New this week, Works. A row
 * with no items is omitted, never rendered empty. ("Pick up where you left
 * off", row 1, is deferred until ggbc-backend#84 unblocks POST /chats/recency.)
 *
 * Works includes archived items: the sidebar's Works list does too, and a row
 * that hid them would disagree with it. "New this week" is uncapped, newest
 * first.
 */
export function buildRows({ featured, characters, works, canViewWorks, now }: BuildRowsInput): RowModel[] {
  const rows: RowModel[] = [];

  if (featured.length > 0) {
    rows.push({ id: 'featured', title: 'Featured characters', tag: 'CHARACTER', items: [...featured] });
  }

  const fresh = characters
    .filter((c) => isNewThisWeek(c, now))
    .sort((a, b) => (parseServerUtc(b.create_date) ?? 0) - (parseServerUtc(a.create_date) ?? 0));
  if (fresh.length > 0) {
    rows.push({ id: 'new', title: 'New this week', tag: 'NEW', items: fresh });
  }

  if (canViewWorks && works.length > 0) {
    rows.push({ id: 'works', title: 'Works', tag: 'WORK', items: [...works] });
  }

  return rows;
}
