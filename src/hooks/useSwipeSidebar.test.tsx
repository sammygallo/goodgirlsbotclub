/**
 * @vitest-environment jsdom
 *
 * useSwipeSidebar driven through a small component that stands in for
 * MainLayout: an edge swipe opens the drawer, a leftward swipe closes it, a
 * swipe is not taken while a right panel is up (D-S14), and the listeners bind
 * when the layout root mounts, even when that is after the first render (#557).
 *
 * The three panel stores are the real ones, flipped through setState; haptics
 * are mocked so "no buzz for a swipe that does nothing" can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useGuidesPanelStore } from '../stores/guidesPanelStore';
import { useProjectStore } from '../stores/projectStore';
import { useSettingsPanelStore } from '../stores/settingsPanelStore';
import { hapticMedium } from '../utils/haptics';
import { EDGE_ZONE, SWIPE_THRESHOLD, useSwipeSidebar } from './useSwipeSidebar';

vi.mock('../utils/haptics');

const initial = {
  settings: useSettingsPanelStore.getState(),
  guides: useGuidesPanelStore.getState(),
  project: useProjectStore.getState(),
};

interface HarnessProps {
  isOpen?: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** False renders the spinner MainLayout shows while auth resolves: no layout root yet. */
  ready?: boolean;
}

function Harness({ isOpen = false, onOpen, onClose, ready = true }: HarnessProps) {
  const ref = useSwipeSidebar(isOpen, onOpen, onClose);
  if (!ready) return <div data-testid="spinner" />;
  return <div ref={ref} data-testid="root" />;
}

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

function mount(props: Partial<HarnessProps> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const utils = render(<Harness onOpen={onOpen} onClose={onClose} {...props} />);
  return { ...utils, onOpen, onClose };
}

const root = () => document.querySelector('[data-testid="root"]') as HTMLElement;

beforeEach(() => {
  vi.mocked(hapticMedium).mockClear();
});

afterEach(() => {
  cleanup();
  useSettingsPanelStore.setState(initial.settings, true);
  useGuidesPanelStore.setState(initial.guides, true);
  useProjectStore.setState(initial.project, true);
});

describe('the gestures themselves', () => {
  it('opens on a rightward swipe that starts inside the edge zone', () => {
    const { onOpen, onClose } = mount();
    swipe(root(), [EDGE_ZONE - 1, 100], [EDGE_ZONE - 1 + SWIPE_THRESHOLD + 1, 100]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(hapticMedium).toHaveBeenCalledTimes(1);
  });

  it('ignores a swipe that starts at or past the edge zone', () => {
    const { onOpen } = mount();
    swipe(root(), [EDGE_ZONE, 100], [EDGE_ZONE + 200, 100]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores a rightward swipe shorter than the threshold', () => {
    const { onOpen } = mount();
    swipe(root(), [5, 100], [5 + SWIPE_THRESHOLD, 100]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores a swipe whose vertical movement dominates', () => {
    const { onOpen } = mount();
    swipe(root(), [10, 100], [70, 300]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('closes on a leftward swipe while open, from anywhere on the page', () => {
    const { onOpen, onClose } = mount({ isOpen: true });
    swipe(root(), [200, 100], [200 - SWIPE_THRESHOLD - 1, 100]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not close on a leftward swipe while closed', () => {
    const { onClose } = mount();
    swipe(root(), [10, 100], [10 - 80, 100]);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('binding when the layout root mounts (#557)', () => {
  it('works on a root that mounts after the first render, with no prior toggle', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<Harness onOpen={onOpen} onClose={onClose} ready={false} />);
    rerender(<Harness onOpen={onOpen} onClose={onClose} ready />);

    swipe(root(), [10, 100], [120, 100]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('removes both listeners when the root unmounts', () => {
    const { onOpen, unmount } = mount();
    const el = root();
    unmount();

    swipe(el, [10, 100], [120, 100]);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('mutual exclusion with the right panels (D-S14)', () => {
  const PANELS: [string, () => void][] = [
    ['Settings', () => useSettingsPanelStore.setState({ isOpen: true })],
    ['Guides', () => useGuidesPanelStore.setState({ isOpen: true })],
    ['Works', () => useProjectStore.setState({ isOpen: true })],
  ];

  it.each(PANELS)('ignores an edge swipe while the %s panel is open, with no haptic', (_name, openPanel) => {
    const { onOpen } = mount();
    act(() => openPanel());

    swipe(root(), [10, 100], [120, 100]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(hapticMedium).not.toHaveBeenCalled();
  });

  it('opens again once the panel has closed', () => {
    const { onOpen } = mount();
    act(() => {
      useSettingsPanelStore.setState({ isOpen: true });
    });
    swipe(root(), [10, 100], [120, 100]);
    expect(onOpen).not.toHaveBeenCalled();

    act(() => {
      useSettingsPanelStore.setState({ isOpen: false });
    });
    swipe(root(), [10, 100], [120, 100]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
