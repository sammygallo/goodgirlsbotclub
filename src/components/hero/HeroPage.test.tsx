/**
 * @vitest-environment jsdom
 *
 * HeroPage is where the story's acceptance criteria meet: the fetched config
 * becomes slides ("slide config editable without code changes"), the rows omit
 * themselves when empty, a character slide shows creator_notes and never
 * description, and Browse / See all reach today's sidebar.
 *
 * Everything runs on fake timers. The fetch is a stub that resolves on the next
 * microtask, so `settle()` flushes it without relying on RTL's `waitFor`, which
 * cannot advance vitest's fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CharacterInfo, ProjectListItem } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { HeroPage } from './HeroPage';

const NOW = new Date('2026-10-12T12:00:00Z');
const SLIDE_MS = 6000;

const initial = {
  character: useCharacterStore.getState(),
  auth: useAuthStore.getState(),
  project: useProjectStore.getState(),
  settings: useSettingsPanelStore.getState(),
  guides: useGuidesPanelStore.getState(),
};

const naive = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().replace('Z', '');

function character(name: string, extra: Partial<CharacterInfo> = {}): CharacterInfo {
  return {
    name,
    avatar: `${name.toLowerCase()}.png`,
    creator: `${name}'s maker`,
    creator_notes: `${name} is a test character. A second sentence.`,
    description: `PROMPT-ONLY description for ${name}`,
    ...extra,
  } as CharacterInfo;
}

function work(id: string, status: 'active' | 'archived' = 'active'): ProjectListItem {
  return {
    id,
    name: `Work ${id}`,
    description: '',
    deliverable_type: 'novel',
    status,
    character_count: 1,
    chat_count: 1,
    updated_at: naive(1),
  };
}

const user = (permissions: string[]) => ({ handle: 'u', name: 'U', role: 'end_user' as const, permissions });

const selectCharacter = vi.fn();
const openPanel = vi.fn();

function seed({
  characters = [] as CharacterInfo[],
  loaded = true,
  failed = false,
  permissions = ['character:view'],
  works = [] as ProjectListItem[],
} = {}) {
  useCharacterStore.setState({
    characters,
    charactersLoaded: loaded,
    charactersFetchFailed: failed,
    isLoading: false,
    error: failed ? 'Failed to fetch characters' : null,
    selectedCharacter: null,
    selectCharacter,
  });
  useAuthStore.setState({ currentUser: user(permissions) });
  useProjectStore.setState({ items: works, isOpen: false, openPanel });
}

/** Stubs the config fetch; the returned spy shows what was asked for. */
function config(body: unknown) {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function mount(onOpenSidebar?: () => void) {
  const utils = render(<HeroPage onOpenSidebar={onOpenSidebar} />);
  await settle();
  return utils;
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const slides = () => Array.from(document.querySelectorAll('[aria-roledescription="slide"]')) as HTMLElement[];
const activeSlide = () => slides().find((s) => !s.hasAttribute('inert'));
const charSlideCfg = (avatar: string, extra: Record<string, unknown> = {}) => ({ kind: 'character', avatar, ...extra });
const featureCfg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Feature ${id}`,
  body: 'Body copy.',
  image: `/hero/${id}.webp`,
  cta: { label: `Learn ${id}`, modal: { kind: 'feature', heading: `Heading ${id}`, bodyMarkdown: 'Hello **world**' } },
  ...extra,
});

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  selectCharacter.mockReset();
  openPanel.mockReset();
  setWidth(1280);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCharacterStore.setState(initial.character, true);
  useAuthStore.setState(initial.auth, true);
  useProjectStore.setState(initial.project, true);
  useSettingsPanelStore.setState(initial.settings, true);
  useGuidesPanelStore.setState(initial.guides, true);
});

describe('loading', () => {
  it('holds a placeholder instead of flashing the welcome panel while the config is in flight', async () => {
    seed({ characters: [character('Ivy')] });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<HeroPage />);
    await settle();
    expect(screen.queryByText('Start a new conversation')).toBeNull();
    expect(screen.queryByRole('region', { name: /Featured/ })).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('holds the placeholder until the characters have loaded, even with the config in hand', async () => {
    seed({ characters: [], loaded: false });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    expect(screen.queryByText('Start a new conversation')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    act(() => {
      useCharacterStore.setState({ characters: [character('Ivy')], charactersLoaded: true });
    });
    expect(screen.getByRole('heading', { level: 3, name: 'Ivy' })).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('shows no rows while the config is in flight: Featured would arrive above them and shove them down', async () => {
    seed({ characters: [character('Ivy', { create_date: naive(1) })] });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<HeroPage />);
    await settle();
    expect(screen.queryByRole('region', { name: 'New this week' })).toBeNull();
  });

  it('stops waiting when the characters fetch FAILED (loaded never rises then)', async () => {
    seed({ characters: [], loaded: false, failed: true });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
  });

  it('shows the welcome panel when it mounts after the failed fetch and another action has already cleared the error', async () => {
    seed({ characters: [], loaded: false, failed: true });
    useCharacterStore.setState({ error: null });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it.each([
    ['another characterStore action clears the shared error', { error: null }],
    ['a retry begins', { isLoading: true, error: null }],
  ])('keeps the welcome panel once the failed fetch has been seen, even after %s', async (_name, change) => {
    seed({ characters: [], loaded: false, failed: true });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();

    act(() => {
      useCharacterStore.setState(change);
    });
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('fetches the config once on mount', async () => {
    seed();
    const fetchFn = config({ version: 1, slides: [] });
    await mount();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe('/hero/feature-slides.json');
  });

  it('has a page-level heading for the h3s beneath it', async () => {
    seed();
    config({ version: 1, slides: [] });
    await mount();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Discover characters');
  });
});

describe('the empty state (D-H9)', () => {
  it('shows the welcome panel when nothing is configured: no carousel, no controls', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [] });
    await mount();
    const panel = screen.getByRole('region', { name: 'Welcome' });
    expect(within(panel).getByRole('heading', { name: 'Start a new conversation' })).toBeTruthy();
    expect(within(panel).getByText('Pick a character to chat with, or create your own.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Browse characters' })).toBeTruthy();
    expect(document.querySelector('[aria-roledescription="carousel"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /slide/i })).toBeNull();
    expect(document.querySelector('[aria-live]')).toBeNull();
  });

  it('shows it when the config cannot be read at all', async () => {
    seed({ characters: [character('Ivy')] });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
  });

  it('shows it when every featured avatar is one this user cannot see', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [charSlideCfg('someone-elses-card.png')] });
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
  });

  it('shows it (not the announcement) when only announcements survive', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [featureCfg('news')] });
    await mount();
    expect(screen.getByText('Start a new conversation')).toBeTruthy();
    expect(screen.queryByText('Feature news')).toBeNull();
  });
});

describe('slides come from the fetched file (editable without code)', () => {
  it('renders exactly the slide the JSON names, and a different one when the JSON changes', async () => {
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    const first = await mount();
    expect(screen.getByRole('heading', { level: 3, name: 'Ivy' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3, name: 'Rose' })).toBeNull();
    first.unmount();

    config({ version: 1, slides: [charSlideCfg('rose.png')] });
    await mount();
    expect(screen.getByRole('heading', { level: 3, name: 'Rose' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3, name: 'Ivy' })).toBeNull();
  });

  it('draws a feature slide from config alone', async () => {
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png'), featureCfg('news', { title: 'Brand new thing' })] });
    await mount();
    expect(screen.getByRole('group', { name: '2 of 2: Brand new thing' })).toBeTruthy();
  });

  it('skips a malformed entry with a warning and still shows the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png'), { id: 'broken' }, charSlideCfg('rose.png')] });
    await mount();
    expect(slides()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('honours a requires permission: shown to a user who has it, dropped for one who does not', async () => {
    const cfg = {
      version: 1,
      slides: [charSlideCfg('ivy.png'), charSlideCfg('rose.png', { requires: 'character:create' })],
    };
    seed({ characters: [character('Ivy'), character('Rose')], permissions: ['character:view'] });
    config(cfg);
    const denied = await mount();
    expect(screen.queryByRole('heading', { level: 3, name: 'Rose' })).toBeNull();
    denied.unmount();

    seed({ characters: [character('Ivy'), character('Rose')], permissions: ['character:view', 'character:create'] });
    config(cfg);
    await mount();
    expect(screen.getAllByRole('heading', { level: 3, name: 'Rose' }).length).toBeGreaterThan(0);
  });

  it('drops a character slide for an avatar this user cannot see and keeps the others', async () => {
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({ version: 1, slides: [charSlideCfg('ghost.png'), charSlideCfg('ivy.png'), charSlideCfg('rose.png')] });
    await mount();
    expect(slides().map((s) => s.getAttribute('aria-label'))).toEqual(['1 of 2: Ivy', '2 of 2: Rose']);
  });

  it('takes at most five slides, from the survivors (D-H4)', async () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => character(n));
    seed({ characters: names });
    config({
      version: 1,
      slides: [charSlideCfg('nobody.png'), ...names.map((c) => charSlideCfg(c.avatar))],
    });
    await mount();
    expect(slides()).toHaveLength(5);
    // ...while the Featured row keeps all seven.
    const row = screen.getByRole('region', { name: 'Featured characters' });
    expect(within(row).getAllByRole('listitem')).toHaveLength(7);
  });
});

describe('one slide is static (D-H10)', () => {
  it('draws it with no rotation, controls, indicators or live region', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    expect(document.querySelector('[aria-roledescription="carousel"]')).toBeNull();
    expect(document.querySelector('[aria-roledescription="slide"]')).toBeNull();
    expect(document.querySelector('[aria-live]')).toBeNull();
    expect(screen.queryByRole('button', { name: /slide/i })).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Ivy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chat with Ivy' })).toBeTruthy();
  });

  it('does not rotate', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    advance(SLIDE_MS * 3);
    expect(screen.getByRole('heading', { level: 3, name: 'Ivy' })).toBeTruthy();
  });
});

describe('a character slide (D-H5)', () => {
  async function mountIvy(extra: Partial<CharacterInfo> = {}) {
    seed({ characters: [character('Ivy', extra)] });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    return mount();
  }

  it('shows name, creator and the FIRST SENTENCE of creator_notes', async () => {
    await mountIvy();
    expect(screen.getByRole('heading', { level: 3, name: 'Ivy' })).toBeTruthy();
    expect(screen.getByText("by Ivy's maker")).toBeTruthy();
    expect(screen.getByText('Ivy is a test character.')).toBeTruthy();
    expect(screen.queryByText(/second sentence/)).toBeNull();
  });

  it('NEVER shows description: that is model-facing prompt text', async () => {
    await mountIvy({ description: 'SECRET PROMPT TEXT', creator_notes: 'Public blurb. More.' });
    expect(document.body.textContent).not.toContain('SECRET PROMPT TEXT');
    expect(screen.getByText('Public blurb.')).toBeTruthy();
  });

  it('shows no blurb at all, rather than description, when there are no creator notes', async () => {
    await mountIvy({ description: 'SECRET PROMPT TEXT', creator_notes: undefined });
    expect(document.body.textContent).not.toContain('SECRET PROMPT TEXT');
  });

  it('falls back to the card\'s nested data.* fields, as the preview modal does', async () => {
    await mountIvy({
      creator: undefined,
      creator_notes: undefined,
      data: { creator: 'Nested Maker', creator_notes: 'Nested notes. Rest.' },
    });
    expect(screen.getByText('by Nested Maker')).toBeTruthy();
    expect(screen.getByText('Nested notes.')).toBeTruthy();
  });

  it('flattens HTML in creator_notes to text and never builds elements from it', async () => {
    await mountIvy({ creator_notes: '<b>Bold</b> opening <img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>. More.' });
    const slide = screen.getByRole('region', { name: 'Welcome' });
    expect(slide.querySelector('b, script')).toBeNull();
    expect(slide.querySelectorAll('img')).toHaveLength(1); // only the artwork
    expect(slide.textContent).toContain('Bold opening');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('renders already-escaped markup literally, as text', async () => {
    await mountIvy({ creator_notes: '&lt;img src=x onerror=alert(1)&gt; stays text. More.' });
    const slide = screen.getByRole('region', { name: 'Welcome' });
    expect(slide.textContent).toContain('&lt;img src=x onerror=alert(1)&gt; stays text.');
    expect(slide.querySelectorAll('img')).toHaveLength(1);
  });

  it('Chat selects the character', async () => {
    await mountIvy();
    fireEvent.click(screen.getByRole('button', { name: 'Chat with Ivy' }));
    expect(selectCharacter).toHaveBeenCalledWith('ivy.png');
  });

  it('About opens the preview modal, and its own Chat button selects too', async () => {
    await mountIvy();
    fireEvent.click(screen.getByRole('button', { name: 'About Ivy' }));
    const dialog = screen.getByRole('dialog', { name: 'Ivy' });
    expect(selectCharacter).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Chat with Ivy' }));
    expect(selectCharacter).toHaveBeenCalledWith('ivy.png');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hands focus back to About when the preview modal closes', async () => {
    await mountIvy();
    const about = screen.getByRole('button', { name: 'About Ivy' });
    about.focus();
    fireEvent.click(about);
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]);
    expect(document.activeElement).toBe(about);
  });
});

describe('a feature slide', () => {
  it('Learn more opens FeatureInfoModal with the configured heading and Markdown body', async () => {
    seed({ characters: [character('Ivy')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png'), featureCfg('selfie')] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Go to slide 2: Feature selfie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Learn selfie' }));
    const dialog = screen.getByRole('dialog', { name: 'Heading selfie' });
    expect(dialog.querySelector('strong')?.textContent).toBe('world');
  });

  it('a CTA that opens a character shows that character\'s preview', async () => {
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({
      version: 1,
      slides: [
        charSlideCfg('ivy.png'),
        featureCfg('meet', { cta: { label: 'Meet Rose', modal: { kind: 'character', avatar: 'rose.png' } } }),
      ],
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Go to slide 2: Feature meet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Meet Rose' }));
    expect(screen.getByRole('dialog', { name: 'Rose' })).toBeTruthy();
  });
});

describe('what pauses the carousel (D-H14)', () => {
  async function mountTwo() {
    seed({ characters: [character('Ivy'), character('Rose')] });
    config({ version: 1, slides: [charSlideCfg('ivy.png'), charSlideCfg('rose.png')] });
    await mount();
  }
  const slideName = () => activeSlide()!.getAttribute('aria-label');

  it('rotates when nothing is open', async () => {
    await mountTwo();
    advance(SLIDE_MS);
    expect(slideName()).toBe('2 of 2: Rose');
  });

  it.each([
    ['the Settings panel', () => useSettingsPanelStore.setState({ isOpen: true }), () => useSettingsPanelStore.setState({ isOpen: false })],
    ['the Guides panel', () => useGuidesPanelStore.setState({ isOpen: true }), () => useGuidesPanelStore.setState({ isOpen: false })],
    ['the Works panel', () => useProjectStore.setState({ isOpen: true }), () => useProjectStore.setState({ isOpen: false })],
  ])('pauses while %s is open and resumes when it closes', async (_name, open, close) => {
    await mountTwo();
    act(() => {
      open();
    });
    advance(SLIDE_MS * 3);
    expect(slideName()).toBe('1 of 2: Ivy');
    act(() => {
      close();
    });
    advance(SLIDE_MS);
    expect(slideName()).toBe('2 of 2: Rose');
  });

  it('pauses while a modal opened from the hero is open and resumes when it closes', async () => {
    await mountTwo();
    fireEvent.click(screen.getByRole('button', { name: 'About Ivy' }));
    advance(SLIDE_MS * 3);
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]);
    expect(slideName()).toBe('1 of 2: Ivy');
    advance(SLIDE_MS);
    expect(slideName()).toBe('2 of 2: Rose');
  });

  it('opening a modal does not stop the carousel for good: focus moving into the dialog is not "keyboard focus entering the hero"', async () => {
    await mountTwo();
    fireEvent.click(screen.getByRole('button', { name: 'About Ivy' }));
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.getByRole('button', { name: 'Stop slide rotation' })).toBeTruthy();
  });

  it('a modal the mouse opened and Escape closed only paused the carousel: the focus restore is not keyboard navigation', async () => {
    await mountTwo();
    const about = screen.getByRole('button', { name: 'About Ivy' });
    fireEvent.pointerDown(about);
    about.focus();
    fireEvent.click(about);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Stop slide rotation' })).toBeTruthy();
    advance(SLIDE_MS);
    expect(slideName()).toBe('2 of 2: Rose');
  });

  it('a modal the keyboard opened leaves the carousel stopped after Escape', async () => {
    await mountTwo();
    const about = screen.getByRole('button', { name: 'About Ivy' });
    // Focus arrives by pointer, so the carousel is still rotating when Enter opens the modal.
    fireEvent.pointerDown(about);
    act(() => about.focus());
    expect(screen.getByRole('button', { name: 'Stop slide rotation' })).toBeTruthy();

    fireEvent.keyDown(about, { key: 'Enter' });
    fireEvent.click(about);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Start slide rotation' })).toBeTruthy();
    advance(SLIDE_MS * 2);
    expect(slideName()).toBe('1 of 2: Ivy');
  });
});

describe('category rows (D-H21)', () => {
  const rowNames = () => screen.queryAllByRole('region').map((r) => r.getAttribute('aria-label') ?? r.querySelector('h3')?.textContent);

  it('shows no rows at all when there is nothing to put in them', async () => {
    seed({ characters: [character('Ivy', { create_date: naive(30) })] });
    config({ version: 1, slides: [] });
    await mount();
    expect(screen.queryByRole('heading', { level: 3, name: 'Featured characters' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'New this week' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'Works' })).toBeNull();
  });

  it('omits "New this week" when no character is that new, and lists the ones that are, newest first', async () => {
    seed({
      characters: [
        character('Old', { create_date: naive(20) }),
        character('Mid', { create_date: naive(3) }),
        character('Fresh', { create_date: naive(0.5) }),
      ],
    });
    config({ version: 1, slides: [] });
    await mount();
    const row = screen.getByRole('region', { name: 'New this week' });
    // Card names are the titles alone (the tag is decoration); DOM order is newest first.
    expect(within(row).getAllByRole('button', { name: /^(Old|Mid|Fresh)$/ }).map((b) => b.textContent?.replace('NEW', ''))).toEqual([
      'Fresh',
      'Mid',
    ]);
  });

  it('treats the backend\'s tz-naive create_date as UTC', async () => {
    // 7 days and 1 hour before NOW, written the way the backend writes it.
    seed({ characters: [character('Edge', { create_date: naive(7 + 1 / 24) })] });
    config({ version: 1, slides: [] });
    await mount();
    expect(screen.queryByRole('region', { name: 'New this week' })).toBeNull();
  });

  it('puts Featured, New this week and Works in that order', async () => {
    seed({
      characters: [character('Ivy', { create_date: naive(1) })],
      permissions: ['character:view', 'project:view'],
      works: [work('w1')],
    });
    config({ version: 1, slides: [charSlideCfg('ivy.png')] });
    await mount();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(headings.indexOf('Featured characters'))).toEqual([
      'Featured characters',
      'New this week',
      'Works',
    ]);
    expect(rowNames()).toContain('Works');
  });

  describe('Works', () => {
    it('is absent without project:view even when works exist', async () => {
      seed({ permissions: ['character:view'], works: [work('w1')] });
      config({ version: 1, slides: [] });
      await mount();
      expect(screen.queryByRole('region', { name: 'Works' })).toBeNull();
    });

    it('is absent with project:view but no works', async () => {
      seed({ permissions: ['project:view'], works: [] });
      config({ version: 1, slides: [] });
      await mount();
      expect(screen.queryByRole('region', { name: 'Works' })).toBeNull();
    });

    it('lists works (archived too) as 16:9 cards, and a card opens that work in the Works panel', async () => {
      seed({ permissions: ['project:view'], works: [work('w1'), work('w2', 'archived')] });
      config({ version: 1, slides: [] });
      await mount();
      const row = screen.getByRole('region', { name: 'Works' });
      expect(within(row).getAllByRole('listitem')).toHaveLength(2);
      expect(row.querySelector('.aspect-video')).not.toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: 'Work w2' }));
      expect(openPanel).toHaveBeenCalledWith('w2');
    });

    it('See all opens the Works panel', async () => {
      seed({ permissions: ['project:view'], works: [work('w1')] });
      config({ version: 1, slides: [] });
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'See all Works' }));
      expect(openPanel).toHaveBeenCalledWith();
    });
  });

  describe('cards', () => {
    it('are real buttons that open the preview modal; its Start chat selects', async () => {
      seed({ characters: [character('Ivy', { create_date: naive(1) })] });
      config({ version: 1, slides: [] });
      await mount();
      const row = screen.getByRole('region', { name: 'New this week' });
      const card = within(row).getByRole('button', { name: 'Ivy' });
      expect(card.tagName).toBe('BUTTON');
      fireEvent.click(card);

      const dialog = screen.getByRole('dialog', { name: 'Ivy' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Chat with Ivy' }));
      expect(selectCharacter).toHaveBeenCalledWith('ivy.png');
    });

    it('carry their tag and title, and load the first six images eagerly and the rest lazily', async () => {
      const many = Array.from({ length: 8 }, (_, i) => character(`N${i}`, { create_date: naive(1) }));
      seed({ characters: many });
      config({ version: 1, slides: [] });
      await mount();
      const row = screen.getByRole('region', { name: 'New this week' });
      expect(within(row).getAllByText('NEW')).toHaveLength(8);
      const loading = Array.from(row.querySelectorAll('img')).map((i) => i.getAttribute('loading'));
      expect(loading).toEqual(['eager', 'eager', 'eager', 'eager', 'eager', 'eager', 'lazy', 'lazy']);
    });

    it('show an initial in place of art that fails to load', async () => {
      seed({ characters: [character('Ivy', { create_date: naive(1) })] });
      config({ version: 1, slides: [] });
      await mount();
      const row = screen.getByRole('region', { name: 'New this week' });
      fireEvent.error(row.querySelector('img')!);
      expect(row.querySelector('img')).toBeNull();
      // The placeholder node itself: the card's title "Ivy" already holds an 'I'.
      expect(row.querySelector('[aria-hidden="true"] .text-\\[64px\\]')?.textContent).toBe('I');
    });
  });

  describe('scrolling', () => {
    it('has real scroll buttons named for the row, that scroll by most of the visible width', async () => {
      seed({ characters: [character('Ivy', { create_date: naive(1) })] });
      config({ version: 1, slides: [] });
      await mount();
      const row = screen.getByRole('region', { name: 'New this week' });
      const list = row.querySelector('ul') as HTMLElement;
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: 1000 });
      const scrollBy = vi.fn();
      list.scrollBy = scrollBy as unknown as typeof list.scrollBy;

      fireEvent.click(within(row).getByRole('button', { name: 'Scroll New this week right' }));
      expect(scrollBy).toHaveBeenLastCalledWith({ left: 800, behavior: 'smooth' });
      fireEvent.click(within(row).getByRole('button', { name: 'Scroll New this week left' }));
      expect(scrollBy).toHaveBeenLastCalledWith({ left: -800, behavior: 'smooth' });
    });

    it('scrolls instantly under reduced motion', async () => {
      window.matchMedia = ((q: string) => ({
        matches: q.includes('prefers-reduced-motion'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;
      try {
        seed({ characters: [character('Ivy', { create_date: naive(1) })] });
        config({ version: 1, slides: [] });
        await mount();
        const row = screen.getByRole('region', { name: 'New this week' });
        const list = row.querySelector('ul') as HTMLElement;
        Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
        const scrollBy = vi.fn();
        list.scrollBy = scrollBy as unknown as typeof list.scrollBy;
        fireEvent.click(within(row).getByRole('button', { name: 'Scroll New this week right' }));
        expect(scrollBy).toHaveBeenCalledWith({ left: 400, behavior: 'auto' });
      } finally {
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      }
    });

    it('snaps horizontally and keeps its scrollbar out of the way', async () => {
      seed({ characters: [character('Ivy', { create_date: naive(1) })] });
      config({ version: 1, slides: [] });
      await mount();
      const list = screen.getByRole('region', { name: 'New this week' }).querySelector('ul')!;
      expect(list.className).toContain('snap-x');
      expect(list.className).toContain('snap-mandatory');
      expect(list.className).toContain('overflow-x-auto');
    });
  });
});

describe('Browse and See all act on today\'s sidebar (D-H11)', () => {
  function Sidebar() {
    return (
      <>
        <input id="character-search" aria-label="Search characters" />
        <div id="character-list" tabIndex={-1} />
      </>
    );
  }

  async function mountWithSidebar(onOpenSidebar: () => void, characters: CharacterInfo[] = []) {
    seed({ characters });
    config({ version: 1, slides: [] });
    render(
      <>
        <Sidebar />
        <HeroPage onOpenSidebar={onOpenSidebar} />
      </>,
    );
    await settle();
    advance(0);
  }

  it('below 1024px Browse opens the drawer, then focuses the search box', async () => {
    setWidth(800);
    const open = vi.fn();
    await mountWithSidebar(open);
    fireEvent.click(screen.getByRole('button', { name: 'Browse characters' }));
    expect(open).toHaveBeenCalledTimes(1);
    advance(0);
    expect(document.activeElement?.id).toBe('character-search');
  });

  it('from 1024px the sidebar is already a column: Browse only focuses, and does not open a drawer', async () => {
    setWidth(1024);
    const open = vi.fn();
    await mountWithSidebar(open);
    fireEvent.click(screen.getByRole('button', { name: 'Browse characters' }));
    expect(open).not.toHaveBeenCalled();
    advance(0);
    expect(document.activeElement?.id).toBe('character-search');
  });

  it('draws the 1023px / 1024px line exactly where the sidebar does', async () => {
    const open = vi.fn();
    await mountWithSidebar(open);
    setWidth(1023);
    fireEvent.click(screen.getByRole('button', { name: 'Browse characters' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a character row\'s See all focuses the character list (below 1024 it opens the drawer first)', async () => {
    setWidth(600);
    const open = vi.fn();
    await mountWithSidebar(open, [character('Ivy', { create_date: naive(1) })]);
    fireEvent.click(screen.getByRole('button', { name: 'See all New this week' }));
    expect(open).toHaveBeenCalledTimes(1);
    advance(0);
    expect(document.activeElement?.id).toBe('character-list');
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('does not throw when the sidebar is not there to focus', async () => {
    seed({ characters: [] });
    config({ version: 1, slides: [] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Browse characters' }));
    expect(() => advance(0)).not.toThrow();
  });
});
