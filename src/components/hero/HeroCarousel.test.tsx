/**
 * @vitest-environment jsdom
 *
 * The hero carousel against the design spec's behaviour contract: D-H8 (image
 * loading), D-H12 (6 s clock, wrap, reset), D-H14 (what stops it and what only
 * pauses it), D-H15/H17 (control order, labels, inert, aria-live), D-H16
 * (keyboard) and D-H16a (swipe, layered with the real drawer edge-swipe).
 *
 * Timing is driven with fake timers. jsdom ignores the `inert` attribute — it
 * does not actually make anything unfocusable — so inertness is asserted on the
 * attribute; the real Tab walk is QA's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { CharacterInfo } from '../../api/client';
import { useSwipeSidebar } from '../../hooks/useSwipeSidebar';
import type { HeroSlide } from '../../utils/hero/heroModel';
import { HeroCarousel } from './HeroCarousel';

const SLIDE_MS = 6000;

function character(name: string, extra: Partial<CharacterInfo> = {}): CharacterInfo {
  return { name, avatar: `${name.toLowerCase()}.png`, creator_notes: `${name} notes. More.`, ...extra } as CharacterInfo;
}

const charSlide = (name: string): HeroSlide => ({
  type: 'character',
  key: `character:${name}`,
  character: character(name),
});

const featureSlide = (id: string, title: string): HeroSlide => ({
  type: 'feature',
  key: `feature:${id}`,
  modalCharacter: null,
  config: {
    kind: 'feature',
    id,
    enabled: true,
    title,
    body: 'A plain-text body.',
    image: `/hero/${id}.webp`,
    imageAlt: '',
    cta: { label: 'Learn more', modal: { kind: 'feature', heading: 'H', bodyMarkdown: 'B' } },
  },
});

const SLIDES = [charSlide('Ivy'), charSlide('Rose'), featureSlide('selfie', 'Selfie mode')];

function mount(props: Partial<ComponentProps<typeof HeroCarousel>> = {}) {
  const handlers = { onChat: vi.fn(), onAbout: vi.fn(), onFeatureCta: vi.fn() };
  const utils = render(<HeroCarousel slides={SLIDES} paused={false} {...handlers} {...props} />);
  return { ...utils, ...handlers };
}

const region = () => document.querySelector('section[aria-roledescription="carousel"]') as HTMLElement;
const slideEls = () => Array.from(document.querySelectorAll('[aria-roledescription="slide"]')) as HTMLElement[];
const activeIndex = () => slideEls().findIndex((s) => !s.hasAttribute('inert'));
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const rotationLabel = () => region().querySelector('button')!.getAttribute('aria-label');
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

function touch(el: Element, type: 'touchstart' | 'touchend', x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const point = [{ clientX: x, clientY: y }];
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : point });
  Object.defineProperty(ev, 'changedTouches', { value: point });
  act(() => {
    el.dispatchEvent(ev);
  });
}
const swipe = (el: Element, from: [number, number], to: [number, number]) => {
  touch(el, 'touchstart', ...from);
  touch(el, 'touchend', ...to);
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const originalMatchMedia = window.matchMedia;
/** Installs a matchMedia reporting the reduced-motion preference; the returned setter flips it live. */
function reduceMotion(initial: boolean) {
  let reduced = initial;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return reduced && query.includes('prefers-reduced-motion');
    },
    media: query,
    onchange: null,
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    reduced = next;
    act(() => listeners.forEach((l) => l()));
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  delete (document as unknown as { hidden?: boolean }).hidden;
});

describe('markup (D-H17)', () => {
  it('is an APG carousel region with a name', () => {
    mount();
    expect(region().tagName).toBe('SECTION');
    expect(region().getAttribute('aria-label')).toBe('Featured characters and updates');
  });

  it('labels each slide "n of m: title" as a group with the slide role description', () => {
    mount();
    expect(slideEls().map((s) => s.getAttribute('aria-label'))).toEqual([
      '1 of 3: Ivy',
      '2 of 3: Rose',
      '3 of 3: Selfie mode',
    ]);
    for (const s of slideEls()) expect(s.getAttribute('role')).toBe('group');
  });

  it('makes every slide but the active one inert, and only those', () => {
    mount();
    expect(slideEls().map((s) => s.hasAttribute('inert'))).toEqual([false, true, true]);
    fireEvent.click(button('Next slide'));
    expect(slideEls().map((s) => s.hasAttribute('inert'))).toEqual([true, false, true]);
  });

  it('points Previous and Next at the slides container', () => {
    mount();
    const target = document.getElementById('hero-slides');
    expect(target).not.toBeNull();
    expect(button('Previous slide').getAttribute('aria-controls')).toBe('hero-slides');
    expect(button('Next slide').getAttribute('aria-controls')).toBe('hero-slides');
    expect(target!.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(3);
  });

  it('is aria-live=off while rotating and polite once it is not', () => {
    mount();
    const live = () => document.getElementById('hero-slides')!.getAttribute('aria-live');
    expect(live()).toBe('off');
    fireEvent.click(button('Stop slide rotation'));
    expect(live()).toBe('polite');
    fireEvent.click(button('Start slide rotation'));
    expect(live()).toBe('off');
  });

  it('is aria-live=polite while merely paused (hover, hidden tab, open modal)', () => {
    const { rerender, onChat, onAbout, onFeatureCta } = mount();
    const live = () => document.getElementById('hero-slides')!.getAttribute('aria-live');
    fireEvent.pointerEnter(region(), { pointerType: 'mouse' });
    expect(live()).toBe('polite');
    fireEvent.pointerLeave(region(), { pointerType: 'mouse' });
    expect(live()).toBe('off');
    setHidden(true);
    expect(live()).toBe('polite');
    setHidden(false);
    rerender(<HeroCarousel slides={SLIDES} paused onChat={onChat} onAbout={onAbout} onFeatureCta={onFeatureCta} />);
    expect(live()).toBe('polite');
  });
});

describe('controls: order and labels (D-H15)', () => {
  const tabStops = () =>
    Array.from(region().querySelectorAll('button'))
      .filter((b) => !b.closest('[inert]'))
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('is rotation, Previous, Next, the indicators, then the VISIBLE slide\'s CTAs', () => {
    mount();
    expect(tabStops()).toEqual([
      'Stop slide rotation',
      'Previous slide',
      'Next slide',
      'Go to slide 1: Ivy',
      'Go to slide 2: Rose',
      'Go to slide 3: Selfie mode',
      'Chat with Ivy',
      'About Ivy',
    ]);
  });

  it('contributes no tab stops from hidden slides: the CTAs follow the active slide', () => {
    mount();
    fireEvent.click(button('Go to slide 3: Selfie mode'));
    expect(tabStops().slice(-1)).toEqual(['Learn more']);
    expect(tabStops()).not.toContain('Chat with Ivy');
  });

  it('names the rotation button for its ACTION and swaps it', () => {
    mount();
    expect(rotationLabel()).toBe('Stop slide rotation');
    fireEvent.click(button('Stop slide rotation'));
    expect(rotationLabel()).toBe('Start slide rotation');
  });

  it('marks only the active indicator aria-current', () => {
    mount();
    const current = () =>
      screen
        .getAllByRole('button', { name: /^Go to slide/ })
        .map((b) => b.getAttribute('aria-current'));
    expect(current()).toEqual(['true', null, null]);
    fireEvent.click(button('Go to slide 2: Rose'));
    expect(current()).toEqual([null, 'true', null]);
  });

  it('gives every control a target of at least 24x24 (2.5.8): 40px controls, 24px indicators', () => {
    mount();
    for (const name of ['Stop slide rotation', 'Previous slide', 'Next slide']) {
      expect(button(name).className).toContain('h-10');
      expect(button(name).className).toContain('w-10');
    }
    for (const b of screen.getAllByRole('button', { name: /^Go to slide/ })) {
      expect(b.className).toContain('h-6');
      expect(b.className).toContain('w-6');
    }
  });
});

describe('rotation (D-H12)', () => {
  it('advances after 6000 ms and not before', () => {
    mount();
    expect(activeIndex()).toBe(0);
    advance(SLIDE_MS - 1);
    expect(activeIndex()).toBe(0);
    advance(1);
    expect(activeIndex()).toBe(1);
  });

  it('keeps going, and wraps from the last slide to the first', () => {
    mount();
    advance(SLIDE_MS);
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(2);
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(0);
  });

  it('resets the timer on a manual move: the full 6 s starts over', () => {
    mount();
    advance(5000);
    fireEvent.click(button('Next slide'));
    expect(activeIndex()).toBe(1);
    advance(5000);
    expect(activeIndex()).toBe(1);
    advance(1000);
    expect(activeIndex()).toBe(2);
  });

  it('restarts the clock even when the chosen indicator is the slide already showing', () => {
    mount();
    advance(5000);
    fireEvent.click(button('Go to slide 1: Ivy'));
    advance(5000);
    expect(activeIndex()).toBe(0);
    advance(1000);
    expect(activeIndex()).toBe(1);
  });

  it('wraps Previous from the first slide to the last, and Next from the last to the first', () => {
    mount();
    fireEvent.click(button('Previous slide'));
    expect(activeIndex()).toBe(2);
    fireEvent.click(button('Next slide'));
    expect(activeIndex()).toBe(0);
  });
});

describe('what pauses it (resumes by itself) (D-H14)', () => {
  it('a mouse over the region pauses it; leaving resumes with a fresh 6 s', () => {
    mount();
    fireEvent.pointerEnter(region(), { pointerType: 'mouse' });
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
    fireEvent.pointerLeave(region(), { pointerType: 'mouse' });
    advance(SLIDE_MS - 1);
    expect(activeIndex()).toBe(0);
    advance(1);
    expect(activeIndex()).toBe(1);
  });

  it('a TOUCH does not pause it (hover sticks on touch screens)', () => {
    mount();
    fireEvent.pointerEnter(region(), { pointerType: 'touch' });
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(1);
  });

  it('a hidden tab pauses it; coming back resumes', () => {
    mount();
    setHidden(true);
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
    setHidden(false);
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(1);
  });

  it('starts paused when the tab is already hidden on mount', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    mount();
    advance(SLIDE_MS * 2);
    expect(activeIndex()).toBe(0);
  });

  it('an open modal or right panel (the paused prop) pauses it; closing resumes', () => {
    const { rerender, onChat, onAbout, onFeatureCta } = mount({ paused: true });
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
    rerender(<HeroCarousel slides={SLIDES} paused={false} onChat={onChat} onAbout={onAbout} onFeatureCta={onFeatureCta} />);
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(1);
  });

  it('does not rotate a single slide at all', () => {
    mount({ slides: [charSlide('Ivy')] });
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
  });
});

describe('what STOPS it (only the rotation button restarts it) (D-H14)', () => {
  const tabInto = (name: string) => {
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => button(name).focus());
  };

  it('keyboard focus entering the region stops it', () => {
    mount();
    tabInto('Next slide');
    expect(rotationLabel()).toBe('Start slide rotation');
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
  });

  it('stays stopped when focus leaves the region again', () => {
    mount();
    tabInto('Next slide');
    act(() => (document.activeElement as HTMLElement).blur());
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
    expect(rotationLabel()).toBe('Start slide rotation');
  });

  it('is started again only by the rotation button, with a fresh 6 s', () => {
    mount();
    tabInto('Next slide');
    advance(SLIDE_MS);
    fireEvent.click(button('Start slide rotation'));
    expect(rotationLabel()).toBe('Stop slide rotation');
    advance(SLIDE_MS - 1);
    expect(activeIndex()).toBe(0);
    advance(1);
    expect(activeIndex()).toBe(1);
  });

  it('focus that arrives by mouse click does NOT stop it (one click on Next must not freeze the hero)', () => {
    mount();
    const next = button('Next slide');
    fireEvent.pointerDown(next);
    act(() => next.focus());
    fireEvent.click(next);
    expect(rotationLabel()).toBe('Stop slide rotation');
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(2);
  });

  it('focus placed with no prior input (a script, an assistive technology) counts as keyboard', () => {
    mount();
    act(() => button('Previous slide').focus());
    expect(rotationLabel()).toBe('Start slide rotation');
  });

  it('the rotation button stops it from the mouse as well', () => {
    mount();
    fireEvent.click(button('Stop slide rotation'));
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(0);
  });

  it('a Tab after a mouse click is keyboard again', () => {
    mount();
    fireEvent.pointerDown(button('Next slide'));
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => button('Previous slide').focus());
    expect(rotationLabel()).toBe('Start slide rotation');
  });
});

describe('reduced motion (D-H14, D-G6)', () => {
  it('starts stopped and never advances on its own', () => {
    reduceMotion(true);
    mount();
    expect(rotationLabel()).toBe('Start slide rotation');
    advance(SLIDE_MS * 4);
    expect(activeIndex()).toBe(0);
  });

  it('lets the user opt in with play', () => {
    reduceMotion(true);
    mount();
    fireEvent.click(button('Start slide rotation'));
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(1);
  });

  it('is rotating by default without the preference', () => {
    reduceMotion(false);
    mount();
    expect(rotationLabel()).toBe('Stop slide rotation');
  });

  it('stops if the OS preference is switched on while the carousel is up, but does not restart when it is switched off', () => {
    const setReduced = reduceMotion(false);
    mount();
    advance(SLIDE_MS);
    expect(activeIndex()).toBe(1);
    setReduced(true);
    expect(rotationLabel()).toBe('Start slide rotation');
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(1);
    setReduced(false);
    advance(SLIDE_MS * 3);
    expect(activeIndex()).toBe(1);
  });

  it('cross-fades over 300 ms with the transition removed under motion-reduce', () => {
    mount();
    const cls = slideEls()[0].className;
    expect(cls).toContain('duration-300');
    expect(cls).toContain('ease-out');
    expect(cls).toContain('motion-reduce:transition-none');
  });
});

describe('keyboard (D-H16)', () => {
  const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

  it('ArrowRight / ArrowLeft on Next and Previous move between slides', () => {
    mount();
    key(button('Next slide'), 'ArrowRight');
    expect(activeIndex()).toBe(1);
    key(button('Previous slide'), 'ArrowLeft');
    expect(activeIndex()).toBe(0);
    key(button('Previous slide'), 'ArrowRight');
    expect(activeIndex()).toBe(1);
  });

  it('on an indicator, arrows move the slide AND move focus to the new active indicator', () => {
    mount();
    const first = button('Go to slide 1: Ivy');
    act(() => first.focus());
    key(first, 'ArrowRight');
    expect(activeIndex()).toBe(1);
    expect(document.activeElement).toBe(button('Go to slide 2: Rose'));
    key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(button('Go to slide 1: Ivy'));
    key(document.activeElement!, 'ArrowLeft');
    expect(activeIndex()).toBe(2);
    expect(document.activeElement).toBe(button('Go to slide 3: Selfie mode'));
  });

  it('Home and End on an indicator go to the first and last slide, focus following', () => {
    mount();
    const second = button('Go to slide 2: Rose');
    act(() => second.focus());
    key(second, 'End');
    expect(activeIndex()).toBe(2);
    expect(document.activeElement).toBe(button('Go to slide 3: Selfie mode'));
    key(document.activeElement!, 'Home');
    expect(activeIndex()).toBe(0);
    expect(document.activeElement).toBe(button('Go to slide 1: Ivy'));
  });

  it('arrows do nothing on the rotation button', () => {
    mount();
    const rotation = button('Stop slide rotation');
    key(rotation, 'ArrowRight');
    expect(activeIndex()).toBe(0);
    key(rotation, 'ArrowLeft');
    expect(activeIndex()).toBe(0);
  });

  it('Home and End do nothing on Previous / Next (they are indicator keys)', () => {
    mount();
    key(button('Next slide'), 'End');
    expect(activeIndex()).toBe(0);
  });

  it('does NOT capture arrows inside slide content', () => {
    mount();
    key(button('Chat with Ivy'), 'ArrowRight');
    key(button('About Ivy'), 'ArrowLeft');
    key(slideEls()[0], 'ArrowRight');
    expect(activeIndex()).toBe(0);
  });

  it('prevents the default of a key it handles (so the page does not scroll) and only those', () => {
    mount();
    const handled = fireEvent.keyDown(button('Next slide'), { key: 'ArrowRight' });
    const other = fireEvent.keyDown(button('Next slide'), { key: 'a' });
    expect(handled).toBe(false);
    expect(other).toBe(true);
  });
});

describe('swipe (D-H16a)', () => {
  const area = () => document.getElementById('hero-slides')!;

  it('a left swipe past 50px goes to the next slide, a right swipe to the previous', () => {
    mount();
    swipe(area(), [200, 100], [100, 100]);
    expect(activeIndex()).toBe(1);
    swipe(area(), [100, 100], [200, 100]);
    expect(activeIndex()).toBe(0);
  });

  it('ignores a swipe of 50px or less', () => {
    mount();
    swipe(area(), [200, 100], [150, 100]);
    expect(activeIndex()).toBe(0);
  });

  it('ignores a mostly vertical gesture (a scroll)', () => {
    mount();
    swipe(area(), [200, 100], [130, 220]);
    expect(activeIndex()).toBe(0);
  });

  it('resets the clock like any manual move', () => {
    mount();
    advance(5000);
    swipe(area(), [200, 100], [100, 100]);
    advance(5000);
    expect(activeIndex()).toBe(1);
    advance(1000);
    expect(activeIndex()).toBe(2);
  });

  it('ignores a touch that starts within the 30px left edge zone; 30px itself is ours', () => {
    mount();
    swipe(area(), [29, 100], [160, 100]);
    expect(activeIndex()).toBe(0);
    swipe(area(), [30, 100], [160, 100]);
    expect(activeIndex()).toBe(2);
  });

  it('forgets a cancelled touch', () => {
    mount();
    touch(area(), 'touchstart', 200, 100);
    act(() => {
      area().dispatchEvent(new Event('touchcancel', { bubbles: true }));
    });
    touch(area(), 'touchend', 100, 100);
    expect(activeIndex()).toBe(0);
  });

  describe('layered with the drawer edge-swipe (the real useSwipeSidebar)', () => {
    function Page({ onOpen, onClose }: { onOpen: () => void; onClose: () => void }) {
      const ref = useSwipeSidebar(false, onOpen, onClose);
      return (
        <div ref={ref}>
          <HeroCarousel slides={SLIDES} paused={false} onChat={() => {}} onAbout={() => {}} onFeatureCta={() => {}} />
        </div>
      );
    }

    it('an edge swipe opens the drawer and leaves the slide alone', () => {
      const onOpen = vi.fn();
      render(<Page onOpen={onOpen} onClose={() => {}} />);
      swipe(area(), [10, 100], [160, 100]);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(activeIndex()).toBe(0);
    });

    it('a swipe from further in changes the slide and does not open the drawer', () => {
      const onOpen = vi.fn();
      render(<Page onOpen={onOpen} onClose={() => {}} />);
      swipe(area(), [100, 100], [10, 100]);
      expect(onOpen).not.toHaveBeenCalled();
      expect(activeIndex()).toBe(1);
    });
  });
});

describe('images and geometry (D-H2, D-H7, D-H8)', () => {
  const imgs = () => Array.from(region().querySelectorAll('img')) as HTMLImageElement[];

  it('loads the first two slides\' images eagerly and the rest lazily', () => {
    mount();
    expect(imgs().map((i) => i.getAttribute('loading'))).toEqual(['eager', 'eager', 'lazy']);
  });

  it('draws a character\'s art from the blob URL, decorative', () => {
    mount();
    const [ivy] = imgs();
    expect(ivy.getAttribute('src')).toBe('/blobs/character/ivy.png');
    expect(ivy.getAttribute('alt')).toBe('');
    expect(ivy.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the slide and shows an initial in its place when the image fails (D-H8)', () => {
    mount();
    const [ivy] = imgs();
    fireEvent.error(ivy);
    expect(imgs()).toHaveLength(2);
    const slide = slideEls()[0];
    expect(slide.textContent).toContain('I');
    // The text content is untouched.
    expect(slide.querySelector('h3')?.textContent).toBe('Ivy');
    expect(button('Chat with Ivy')).toBeTruthy();
  });

  it('gives the hero its D-H2 height', () => {
    mount();
    expect(region().className).toContain('h-[clamp(320px,58dvh,460px)]');
    expect(region().className).toContain('sm:h-[clamp(300px,45dvh,440px)]');
  });

  it('caps the text block at min(620px, 55%) so it stays inside the D-H20 scrim guarantee', () => {
    mount();
    expect(slideEls()[0].innerHTML).toContain('sm:max-w-[min(620px,55%)]');
  });

  it('uses the fixed D-H20 scrims, not theme tokens', () => {
    mount();
    const html = slideEls()[0].innerHTML;
    expect(html).toContain('var(--scrim-hero)');
    expect(html).toContain('var(--scrim-hero-side)');
    expect(html).toContain('var(--on-scrim-text)');
    expect(html).not.toContain('--color-text');
  });
});

describe('slide content', () => {
  it('shows a character\'s name as an h3, with Chat and About wired to the character', () => {
    const { onChat, onAbout } = mount();
    expect(slideEls()[0].querySelector('h3')?.textContent).toBe('Ivy');
    fireEvent.click(button('Chat with Ivy'));
    expect(onChat).toHaveBeenCalledWith('ivy.png');
    fireEvent.click(button('About Ivy'));
    expect(onAbout).toHaveBeenCalledWith(expect.objectContaining({ avatar: 'ivy.png' }));
  });

  it('calls the feature handler with the slide when its CTA is pressed', () => {
    const { onFeatureCta } = mount();
    fireEvent.click(button('Go to slide 3: Selfie mode'));
    fireEvent.click(button('Learn more'));
    expect(onFeatureCta).toHaveBeenCalledTimes(1);
    expect(onFeatureCta.mock.calls[0][0]).toMatchObject({ type: 'feature' });
  });

  it('renders a feature slide\'s title and body as plain text', () => {
    mount({
      slides: [
        charSlide('Ivy'),
        {
          ...featureSlide('x', '<b>Not bold</b>'),
          config: { ...(featureSlide('x', 'T') as Extract<HeroSlide, { type: 'feature' }>).config, title: '<b>Not bold</b>', body: '<i>nor italic</i>' },
        } as HeroSlide,
      ],
    });
    const slide = slideEls()[1];
    expect(slide.querySelector('b, i')).toBeNull();
    expect(slide.textContent).toContain('<b>Not bold</b>');
    expect(slide.textContent).toContain('<i>nor italic</i>');
  });
});
