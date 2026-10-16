/**
 * @vitest-environment jsdom
 *
 * The desktop avatar panel (§5) mounted against the real chat, motion-mode,
 * expressions and portrait-position stores. Only the two asset-discovery hooks
 * are replaced, so each case states which clips and sprites exist:
 *
 *  - source resolution (D-C5), reduced motion and Pause/Play (D-C6);
 *  - image fit (D-C4) and the 404 → default avatar → placeholder fallbacks;
 *  - toolbar order and labels, the motion-mode popover (§5.3);
 *  - framing mode (D-C8): keys, Reset, Enter/Escape, separate desktop map;
 *  - a11y labels (D-C11–D-C14) and group focus without writes (D-C7, #458).
 *
 * `localStorage` is an in-memory stub (under Node 25 the global is Node's
 * experimental one, which has no methods), `fetch` is refused, jsdom gets a
 * matchMedia whose reduced-motion answer each case sets, and media playback is
 * spied on the prototype.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CharacterInfo } from '../../../api/client';
// characterStore before chatStore: the reverse order trips a module cycle.
import { useCharacterStore } from '../../../stores/characterStore';
import { useChatStore, type ChatMessage } from '../../../stores/chatStore';
import { useMotionModeStore } from '../../../stores/motionModeStore';
import { usePortraitPositionStore } from '../../../stores/portraitPositionStore';
import { DesktopAvatarPanel } from './DesktopAvatarPanel';

const env = vi.hoisted(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  });
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch refused')));
  return {
    reducedMotion: false,
    /** avatar → clip map; absent means no clips. */
    clips: {} as Record<string, Record<string, string>>,
    /** avatar → emotion → sprite path. */
    sprites: {} as Record<string, Record<string, string>>,
  };
});

vi.mock('../../../hooks/useLivePortraitDiscovery', () => ({
  useLivePortraitDiscovery: (avatar: string | null) => {
    const clips = avatar ? env.clips[avatar] ?? null : null;
    return { clips, hasClips: !!clips?.idle, loading: false };
  },
}));
vi.mock('../../../hooks/useCharacterSprites', () => ({
  useCharacterSprites: (avatar: string | undefined) => {
    const map = avatar ? env.sprites[avatar] ?? {} : {};
    return {
      availableEmotions: Object.keys(map),
      getSpritePath: (e: string | null) => (e ? map[e] ?? null : null),
    };
  },
}));

window.matchMedia = ((query: string) => ({
  matches: query.includes('prefers-reduced-motion') ? env.reducedMotion : false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const initialChat = useChatStore.getState();
const ava = { name: 'Ava', avatar: 'a.png' } as CharacterInfo;
const bea = { name: 'Bea', avatar: 'b.png' } as CharacterInfo;
const cat = { name: 'Cat', avatar: 'c.png' } as CharacterInfo;

function ai(id: string, emotion: string | null, characterAvatar?: string): ChatMessage {
  return { id, name: 'x', isUser: false, isSystem: false, content: 'x', timestamp: 0, emotion, characterAvatar, swipes: ['x'], swipeId: 0 };
}

function renderSolo(over: Partial<React.ComponentProps<typeof DesktopAvatarPanel>> = {}) {
  const props = {
    kind: 'solo' as const,
    character: ava,
    failedExpressions: new Set<string>(),
    onExpressionFailed: vi.fn(),
    onHide: vi.fn(),
    ...over,
  };
  const view = render(<DesktopAvatarPanel {...props} />);
  return { ...view, props };
}

function renderGroup(over: Partial<React.ComponentProps<typeof DesktopAvatarPanel>> = {}) {
  return render(
    <DesktopAvatarPanel
      kind="group"
      members={[ava, bea, cat]}
      failedExpressions={new Set()}
      onExpressionFailed={() => {}}
      onHide={() => {}}
      {...over}
    />,
  );
}

const toolbar = () => screen.getByRole('group', { name: 'Portrait controls' });

beforeEach(() => {
  env.reducedMotion = false;
  env.clips = {};
  env.sprites = {};
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  useMotionModeStore.setState({ modesByAvatar: {} });
  usePortraitPositionStore.setState({ positionsByAvatar: {}, desktopPositionsByAvatar: {} });
  useChatStore.setState({ messages: [ai('1', 'joy')], isStreaming: false, currentChatFile: 'chat-1' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChatStore.setState(initialChat, true);
});

describe('source resolution (D-C5)', () => {
  it('explicit Live Portrait without clips shows the static avatar', () => {
    useMotionModeStore.setState({ modesByAvatar: { 'a.png': 'liveportrait' } });
    env.sprites['a.png'] = { joy: '/sprites/a/joy.png' };
    const { container } = renderSolo();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img', { name: 'Ava' }).getAttribute('src')).toBe('/blobs/character/a.png');
  });

  it('auto with sprites shows the latest emotion\'s sprite and the emotion chip', () => {
    env.sprites['a.png'] = { joy: '/sprites/a/joy.png' };
    renderSolo();
    expect(screen.getByRole('img', { name: 'Ava' }).getAttribute('src')).toBe('/sprites/a/joy.png');
    const chip = screen.getByText('joy');
    expect(chip.closest('[aria-live]')).toBeNull();
  });

  it('auto with clips plays Live Portrait, aria-hidden, filling the panel with cover', () => {
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    const { container } = renderSolo();
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.style.objectFit).toBe('cover');
    expect(video.closest('[aria-hidden="true"]')).not.toBeNull();
    // No emotion chip outside expressions mode.
    expect(screen.queryByText('joy')).toBeNull();
  });

  it('a static avatar that fails shows the placeholder initial', () => {
    renderSolo();
    fireEvent.error(screen.getByRole('img', { name: 'Ava' }));
    const placeholder = screen.getByRole('img', { name: 'Ava' });
    expect(placeholder.tagName).toBe('DIV');
    expect(placeholder.textContent).toBe('A');
  });

  it('a sprite 404 reports the failed key, and the shared failed set falls back to the default avatar', () => {
    env.sprites['a.png'] = { joy: '/sprites/a/joy.png' };
    const onExpressionFailed = vi.fn();
    const { rerender, props } = renderSolo({ onExpressionFailed });
    fireEvent.error(screen.getByRole('img', { name: 'Ava' }));
    expect(onExpressionFailed).toHaveBeenCalledWith('a.png-joy');

    rerender(<DesktopAvatarPanel {...props} failedExpressions={new Set(['a.png-joy'])} />);
    expect(screen.getByRole('img', { name: 'Ava' }).getAttribute('src')).toBe('/blobs/character/a.png');
  });
});

describe('reduced motion and Pause/Play (D-C6)', () => {
  it('Pause shows only while Live Portrait plays, flips its label, and pauses the video', () => {
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    renderSolo();
    const button = screen.getByRole('button', { name: 'Pause animation' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Play animation' })).toBe(button);
    expect(pause).toHaveBeenCalled();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Pause animation' })).toBe(button);
  });

  it('no Pause button when the panel shows a still', () => {
    env.sprites['a.png'] = { joy: '/sprites/a/joy.png' };
    renderSolo();
    expect(screen.queryByRole('button', { name: /animation/ })).toBeNull();
  });

  it('under reduced motion, auto skips Live Portrait for the sprite', () => {
    env.reducedMotion = true;
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    env.sprites['a.png'] = { joy: '/sprites/a/joy.png' };
    const { container } = renderSolo();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img', { name: 'Ava' }).getAttribute('src')).toBe('/sprites/a/joy.png');
  });

  it('under reduced motion, an explicit Live Portrait still plays with its Pause button', () => {
    env.reducedMotion = true;
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    useMotionModeStore.setState({ modesByAvatar: { 'a.png': 'liveportrait' } });
    const { container } = renderSolo();
    expect(container.querySelector('video')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Pause animation' })).toBeTruthy();
  });
});

describe('toolbar (§5.3)', () => {
  it('has the four controls in order, 32×32, with explicit labels', () => {
    env.clips['a.png'] = { idle: '/clips/a/idle.mp4' };
    renderSolo();
    const buttons = within(toolbar()).getAllByRole('button').filter((b) => !b.closest('[hidden]'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Motion mode',
      'Adjust framing',
      'Pause animation',
      'Hide portrait',
    ]);
    for (const b of buttons) {
      expect(b.className).toContain('h-8');
      expect(b.className).toContain('w-8');
    }
  });

  it('Motion mode opens the picker popover; Escape closes it, refocuses the toggle and stops there', () => {
    renderSolo();
    const toggle = screen.getByRole('button', { name: 'Motion mode' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const popover = document.getElementById(toggle.getAttribute('aria-controls') as string) as HTMLElement;
    expect(popover.hidden).toBe(false);
    expect(within(popover).getByRole('radiogroup', { name: 'Avatar motion mode' })).toBeTruthy();

    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape);
    fireEvent.keyDown(within(popover).getByRole('radio', { name: 'Auto' }), { key: 'Escape' });
    document.removeEventListener('keydown', documentEscape);
    expect(documentEscape).not.toHaveBeenCalled();
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it('Hide portrait calls onHide', () => {
    const { props } = renderSolo();
    fireEvent.click(screen.getByRole('button', { name: 'Hide portrait' }));
    expect(props.onHide).toHaveBeenCalledTimes(1);
  });

  it('focusHideOnMount puts focus on Hide portrait', () => {
    renderSolo({ focusHideOnMount: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide portrait' }));
  });
});

describe('image fit (D-C4)', () => {
  it('the still covers the panel at the stored desktop framing, with no intrinsic size', () => {
    usePortraitPositionStore.setState({
      positionsByAvatar: { 'a.png': { x: 10, y: 90 } },
      desktopPositionsByAvatar: { 'a.png': { x: 30, y: 40 } },
    });
    renderSolo();
    const img = screen.getByRole('img', { name: 'Ava' });
    expect(img.className).toContain('object-cover');
    expect(img.className).toContain('w-full');
    expect(img.className).toContain('h-full');
    expect(img.hasAttribute('width')).toBe(false);
    expect(img.hasAttribute('height')).toBe(false);
    expect(img.style.objectPosition).toBe('30% 40%');
    expect(img.style.transition).toBe('');
  });

  it('defaults to 50% 0% framing', () => {
    renderSolo();
    expect(screen.getByRole('img', { name: 'Ava' }).style.objectPosition).toBe('50% 0%');
  });
});

describe('framing mode (D-C8)', () => {
  function enterFraming() {
    const toggle = screen.getByRole('button', { name: 'Adjust framing' });
    fireEvent.click(toggle);
    return { toggle, surface: screen.getByRole('group', { name: 'Portrait framing' }) };
  }
  const position = () => screen.getByRole('img', { name: 'Ava' }).style.objectPosition;
  const stored = () => usePortraitPositionStore.getState().desktopPositionsByAvatar['a.png'];

  it('toggles aria-pressed, shows the instruction and focuses the framing surface', () => {
    renderSolo();
    const { toggle, surface } = enterFraming();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Drag or use arrow keys to reposition')).toBeTruthy();
    expect(document.activeElement).toBe(surface);
  });

  it('arrows move 5%, Shift+arrow 1%, clamped to 0–100, into the desktop map only', () => {
    usePortraitPositionStore.setState({ positionsByAvatar: { 'a.png': { x: 10, y: 90 } } });
    const mobileBefore = usePortraitPositionStore.getState().positionsByAvatar;
    renderSolo();
    const { surface } = enterFraming();

    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    expect(position()).toBe('55% 0%');
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    expect(position()).toBe('45% 0%');
    fireEvent.keyDown(surface, { key: 'ArrowUp', shiftKey: true });
    expect(position()).toBe('45% 1%');
    fireEvent.keyDown(surface, { key: 'ArrowDown' });
    expect(position()).toBe('45% 0%');
    expect(stored()).toEqual({ x: 45, y: 0 });
    expect(usePortraitPositionStore.getState().positionsByAvatar).toBe(mobileBefore);
  });

  it('arrow keys do nothing outside framing mode', () => {
    renderSolo();
    const img = screen.getByRole('img', { name: 'Ava' });
    fireEvent.keyDown(img.parentElement as HTMLElement, { key: 'ArrowLeft' });
    expect(position()).toBe('50% 0%');
    expect(stored()).toBeUndefined();
  });

  it('Reset framing restores 50% 0% and clears the stored entry', () => {
    renderSolo();
    const { surface } = enterFraming();
    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset framing' }));
    expect(position()).toBe('50% 0%');
    expect(stored()).toBeUndefined();
  });

  it('Enter exits framing and refocuses Adjust framing', () => {
    renderSolo();
    const { toggle, surface } = enterFraming();
    fireEvent.keyDown(surface, { key: 'Enter' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Drag or use arrow keys to reposition')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('Escape exits framing without reaching document listeners', () => {
    renderSolo();
    const { toggle, surface } = enterFraming();
    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape);
    fireEvent.keyDown(surface, { key: 'Escape' });
    document.removeEventListener('keydown', documentEscape);
    expect(documentEscape).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });
});

describe('a11y labels (D-C11)', () => {
  it('solo: <aside id="chat-avatar-panel"> named "{name} portrait", image alt is the name', () => {
    renderSolo();
    const aside = screen.getByRole('complementary', { name: 'Ava portrait' });
    expect(aside.id).toBe('chat-avatar-panel');
    expect(screen.getByRole('img', { name: 'Ava' })).toBeTruthy();
  });

  it('full-bleed: no padding or radius on the aside; 1/3 wide with a right border', () => {
    renderSolo();
    const cls = screen.getByRole('complementary').className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['w-1/3', 'flex-none', 'border-r', 'hidden', '@min-[600px]/main:flex']));
    expect(cls.some((c) => /^(p|px|py|pt|pb|pl|pr)-/.test(c) || c.startsWith('rounded'))).toBe(false);
  });
});

describe('group mode (D-C7)', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [ai('1', 'joy', 'b.png')] });
  });

  it('labels the aside with the focused member and shows the strip, not the chip', () => {
    env.sprites['b.png'] = { joy: '/sprites/b/joy.png' };
    renderGroup();
    expect(screen.getByRole('complementary', { name: 'Group portrait: Bea' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Group members' })).toBeTruthy();
    expect(screen.queryByText('joy')).toBeNull();
    expect(screen.getByRole('img', { name: 'Bea' }).getAttribute('src')).toBe('/sprites/b/joy.png');
  });

  it('uses the focused member\'s own motion mode', () => {
    env.clips['b.png'] = { idle: '/clips/b/idle.mp4' };
    env.clips['c.png'] = { idle: '/clips/c/idle.mp4' };
    useMotionModeStore.setState({ modesByAvatar: { 'b.png': 'none' } });
    const { container } = renderGroup();
    expect(container.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Cat' }));
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('pins a member on click and follows the next AI message after', () => {
    renderGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Show Ava' }));
    expect(screen.getByRole('complementary', { name: 'Group portrait: Ava' })).toBeTruthy();
    act(() => useChatStore.setState({ messages: [ai('1', 'joy', 'b.png'), ai('2', null, 'c.png')] }));
    expect(screen.getByRole('complementary', { name: 'Group portrait: Cat' })).toBeTruthy();
  });

  it('cross-fades speaker changes over 200ms, and 0ms under reduced motion', () => {
    renderGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Show Cat' }));
    expect(screen.getByTestId('portrait-layer').style.transition).toBe('opacity 200ms ease-out');
    cleanup();

    env.reducedMotion = true;
    renderGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Show Cat' }));
    const layer = screen.getByTestId('portrait-layer');
    expect(layer.style.transition).toBe('opacity 0ms ease-out');
    expect(layer.style.opacity).toBe('1');
  });

  it('only reads chat state: thumbnails and arrow keys leave both stores untouched', () => {
    const chatBefore = useChatStore.getState();
    const characterBefore = useCharacterStore.getState();
    renderGroup();
    const strip = screen.getByRole('list', { name: 'Group members' });
    for (const b of within(strip).getAllByRole('button')) {
      fireEvent.click(b);
      fireEvent.keyDown(b, { key: 'ArrowRight' });
    }
    expect(useChatStore.getState()).toBe(chatBefore);
    expect(useCharacterStore.getState()).toBe(characterBefore);
  });
});
