/**
 * @vitest-environment jsdom
 *
 * MainLayout with the real Header and drawer around a routed child (E6-S3): the
 * drawer is closed in the first render with no class token that offsets the
 * content (D-S2, D-S3), opens and closes by every route the spec lists (D-S12),
 * makes the page behind it inert and gives it back (D-G5), ignores the edge
 * swipe over a right panel (D-S14), does not open from the menu button or the
 * `openSidebar` seam while one is up, is never open together with the onboarding
 * dialog (it refuses to open under the dialog, and closes when the walkthrough
 * starts or returns), binds that swipe even on a fresh load that began at the
 * auth spinner (#557), and keeps the `openSidebar` seam the hero uses.
 *
 * The three right panels are marker stubs, and the onboarding walkthrough is the
 * real component beside a marker; Help and the character editor are stubbed out
 * of the header. jsdom ignores `inert`, so containment is asserted on the
 * attribute: an `inert` ancestor, or none. The real Tab walk, the slide, the
 * stacking and the computed width of the content are QA's, in a browser.
 *
 * `localStorage` is replaced before any app module loads: the onboarding store
 * reads it at import, and under Node 25 the global is Node's experimental one,
 * which has no methods.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { MainLayout } from './MainLayout';
import { useLayoutContext } from './layoutContext';

vi.hoisted(() => {
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
});

vi.mock('../settings/SettingsPanel', () => ({ SettingsPanel: () => <div data-testid="settings-panel" /> }));
vi.mock('../guides/GuidesPanel', () => ({ GuidesPanel: () => <div data-testid="guides-panel" /> }));
vi.mock('../works/WorksPanel', () => ({ WorksPanel: () => <div data-testid="works-panel" /> }));
vi.mock('../onboarding/OnboardingWalkthrough', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onboarding/OnboardingWalkthrough')>();
  return {
    OnboardingWalkthrough: () => (
      <>
        <div data-testid="onboarding" />
        <actual.OnboardingWalkthrough />
      </>
    ),
  };
});
vi.mock('../help/HelpChat', () => ({ HelpChat: () => null }));
vi.mock('../character/CharacterEdit', () => ({ CharacterEdit: () => null }));

const initial = {
  auth: useAuthStore.getState(),
  character: useCharacterStore.getState(),
  chat: useChatStore.getState(),
  guides: useGuidesPanelStore.getState(),
  onboarding: useOnboardingStore.getState(),
  project: useProjectStore.getState(),
  settingsPanel: useSettingsPanelStore.getState(),
  settings: useSettingsStore.getState(),
};

function Probe() {
  const layout = useLayoutContext();
  return (
    <button type="button" onClick={() => layout?.openSidebar()}>
      Probe opens the drawer
    </button>
  );
}

function mountLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="*" element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
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

const menuButton = () => screen.getByRole('button', { name: 'Open menu' });
const drawerRoot = () => document.getElementById('app-drawer') as HTMLElement;
const scrim = () => document.querySelector('[class~="z-[999]"]') as HTMLElement;
const layoutRoot = () => drawerRoot().parentElement as HTMLElement;
const inertAncestor = (el: Element | null) => el?.closest('[inert]') ?? null;
const isOpen = () => menuButton().getAttribute('aria-expanded') === 'true';

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    currentUser: { handle: 'u', name: 'U', role: 'end_user', permissions: ['project:view'] } as never,
  });
  useSettingsStore.setState({
    fetchSettings: vi.fn(async () => {}),
    fetchSecrets: vi.fn(async () => {}),
    fetchGlobalSecrets: vi.fn(async () => {}),
  });
  useOnboardingStore.setState({ hasCompleted: true });
  useCharacterStore.setState({
    characters: [],
    charactersLoaded: true,
    isLoading: false,
    selectedCharacter: null,
    isGroupChatMode: false,
    groupChatCharacters: [],
    fetchCharacters: vi.fn(async () => {}),
    loadManualDraft: vi.fn(async () => {}),
  });
  useProjectStore.setState({ items: [], isOpen: false, fetchProjects: vi.fn(async () => {}) });
  useSettingsPanelStore.setState({ isOpen: false });
  useGuidesPanelStore.setState({ isOpen: false });
  useChatStore.setState({ groupChats: [], isSending: false, isStreaming: false });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(initial.auth, true);
  useCharacterStore.setState(initial.character, true);
  useChatStore.setState(initial.chat, true);
  useGuidesPanelStore.setState(initial.guides, true);
  useOnboardingStore.setState(initial.onboarding, true);
  useProjectStore.setState(initial.project, true);
  useSettingsPanelStore.setState(initial.settingsPanel, true);
  useSettingsStore.setState(initial.settings, true);
});

describe('first render (D-S2, D-S3)', () => {
  it('has the drawer closed, with the header and <main> inside the content wrapper beside it', () => {
    mountLayout();

    const root = drawerRoot();
    expect(root.hasAttribute('hidden')).toBe(true);
    expect(getComputedStyle(root).display).toBe('none');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');

    const content = root.nextElementSibling as HTMLElement;
    expect(content.contains(document.querySelector('header'))).toBe(true);
    expect(content.contains(document.querySelector('main'))).toBe(true);
  });

  // jsdom applies no Tailwind CSS, so this reads class tokens in the markup and
  // nothing else; the computed width of the content at 1100 and 1400 px is a
  // check in a browser.
  it('gives the content wrapper and the layout root exactly their expected classes, with no breakpoint prefix in the shell', () => {
    mountLayout();

    const root = layoutRoot();
    const content = drawerRoot().nextElementSibling as HTMLElement;
    expect(content.parentElement).toBe(root);

    // Exact strings, not a ban list.
    expect(content.className).toBe('flex flex-col min-w-0 h-full');
    expect(root.className).toBe('bg-[var(--color-bg-primary)] overflow-hidden');

    const BREAKPOINTS = ['sm:', 'md:', 'lg:', 'xl:', '2xl:', 'min-[', 'max-['];
    expect(BREAKPOINTS.filter((prefix) => root.outerHTML.includes(prefix))).toEqual([]);
  });

  it('stays closed whatever the browser has stored', () => {
    localStorage.setItem('stm:sidebar-expanded', 'true');
    localStorage.setItem('stm:sidebar-sections', JSON.stringify({ characters: true, groups: true, works: true, personal: true }));
    mountLayout();

    expect(drawerRoot().hasAttribute('hidden')).toBe(true);
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('has the menu button unhidden: no hiding class token on it, no hidden ancestor', () => {
    mountLayout();

    const tokens = menuButton().className.split(/\s+/);
    expect(tokens).not.toContain('hidden');
    expect(tokens).not.toContain('lg:hidden');
    expect(menuButton().closest('[hidden]')).toBeNull();
  });

  it('still renders the three right panels and the onboarding walkthrough', () => {
    mountLayout();
    for (const id of ['settings-panel', 'guides-panel', 'works-panel', 'onboarding']) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
  });
});

describe('open (D-S12, D-G5)', () => {
  it('makes the header, <main> and the panels inert, and leaves the dialog and its scrim live', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());

    expect(isOpen()).toBe(true);
    expect(drawerRoot().hasAttribute('hidden')).toBe(false);
    for (const el of [
      document.querySelector('header'),
      document.querySelector('main'),
      screen.getByTestId('settings-panel'),
      screen.getByTestId('guides-panel'),
      screen.getByTestId('works-panel'),
    ]) {
      expect(inertAncestor(el)).not.toBeNull();
    }
    expect(inertAncestor(drawerRoot())).toBeNull();
    expect(inertAncestor(scrim())).toBeNull();
    expect(inertAncestor(screen.getByRole('button', { name: 'Close menu' }))).toBeNull();
  });

  it('puts first focus inside the drawer', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());
    expect(drawerRoot().contains(document.activeElement)).toBe(true);
  });

  it('opens from a routed child through the layout context', async () => {
    const user = userEvent.setup();
    mountLayout();
    expect(isOpen()).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Probe opens the drawer' }));
    expect(isOpen()).toBe(true);
    expect(drawerRoot().hasAttribute('hidden')).toBe(false);
  });
});

describe('close (D-S12)', () => {
  const CLOSERS: [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void> | void][] = [
    ['Escape', (user) => user.keyboard('{Escape}')],
    ['a click on the scrim', (user) => user.click(scrim())],
    ['the Close button', (user) => user.click(screen.getByRole('button', { name: 'Close menu' }))],
    ['a leftward swipe', () => swipe(layoutRoot(), [250, 100], [100, 100])],
  ];

  it.each(CLOSERS)('closes on %s, gives the page back, and returns focus to the menu button', async (_name, close) => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());
    expect(isOpen()).toBe(true);

    await close(user);
    expect(isOpen()).toBe(false);
    expect(inertAncestor(document.querySelector('main'))).toBeNull();
    expect(inertAncestor(document.querySelector('header'))).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(true));
  });

  it('collapses on opening Settings from Personal, and opens the panel', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useSettingsPanelStore.getState().isOpen).toBe(true);
    expect(isOpen()).toBe(false);
  });
});

describe('the edge swipe (#557, D-S14)', () => {
  it('opens on a fresh load that began at the auth spinner, with no toggle first', () => {
    useAuthStore.setState({ isAuthenticated: false, isLoading: true });
    mountLayout();
    expect(document.getElementById('app-drawer')).toBeNull();

    act(() => {
      useAuthStore.setState({ isAuthenticated: true, isLoading: false });
    });
    expect(isOpen()).toBe(false);

    swipe(layoutRoot(), [10, 100], [140, 100]);
    expect(isOpen()).toBe(true);
  });

  it.each([
    ['Settings', () => useSettingsPanelStore.setState({ isOpen: true })],
    ['Guides', () => useGuidesPanelStore.setState({ isOpen: true })],
    ['Works', () => useProjectStore.setState({ isOpen: true })],
  ] as const)('is ignored while the %s panel is open', (_name, openPanel) => {
    mountLayout();
    act(() => {
      openPanel();
    });

    swipe(layoutRoot(), [10, 100], [140, 100]);
    expect(isOpen()).toBe(false);
  });
});

describe('the menu button and the context opener with a right panel open (D-S14)', () => {
  const PANELS = [
    ['Settings', () => useSettingsPanelStore.getState().open()],
    ['Guides', () => useGuidesPanelStore.getState().open()],
    ['Works', () => useProjectStore.getState().openPanel()],
  ] as const;

  it('leaves the drawer shut when the menu button is pressed again after the Settings row closed it', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(useSettingsPanelStore.getState().isOpen).toBe(true);
    await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(true));
    expect(document.activeElement).toBe(menuButton());

    await user.click(menuButton());
    expect(drawerRoot().hasAttribute('hidden')).toBe(true);
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it.each(PANELS)('leaves the drawer shut when the menu button is pressed with the %s panel open', async (_name, openPanel) => {
    const user = userEvent.setup();
    mountLayout();
    act(() => {
      openPanel();
    });

    await user.click(menuButton());
    expect(isOpen()).toBe(false);
    expect(drawerRoot().hasAttribute('hidden')).toBe(true);
  });

  it.each(PANELS)('leaves the drawer shut when a routed child asks through the layout context with the %s panel open', async (_name, openPanel) => {
    const user = userEvent.setup();
    mountLayout();
    act(() => {
      openPanel();
    });

    await user.click(screen.getByRole('button', { name: 'Probe opens the drawer' }));
    expect(isOpen()).toBe(false);
    expect(drawerRoot().hasAttribute('hidden')).toBe(true);
  });
});

describe('the onboarding dialog and the drawer (D-S14)', () => {
  const ONBOARDING_DONE_KEY = 'sillytavern_onboarding_completed';
  const onboardingDialog = () => {
    const dialog = screen.getByRole('button', { name: 'Next' }).closest<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  };
  const chip = () => screen.getByRole('button', { name: 'Return to setup walkthrough' });
  const dock = () => useOnboardingStore.setState({ isOpen: false, isDocked: true, currentStep: 3 });

  const OPENERS: [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void> | void][] = [
    ['the menu button', (user) => user.click(menuButton())],
    ['a routed child through the layout context', (user) => user.click(screen.getByRole('button', { name: 'Probe opens the drawer' }))],
    ['an edge swipe', () => swipe(layoutRoot(), [10, 100], [140, 100])],
  ];

  it.each(OPENERS)('leaves the drawer shut, and the dialog live, when %s asks for it with the dialog open', async (_name, open) => {
    const user = userEvent.setup();
    mountLayout();
    act(() => {
      useOnboardingStore.getState().start();
    });

    await open(user);
    expect(isOpen()).toBe(false);
    expect(drawerRoot().hasAttribute('hidden')).toBe(true);
    expect(inertAncestor(onboardingDialog())).toBeNull();
  });

  it('opens the drawer while the walkthrough is docked as a chip, and leaves the chip live', async () => {
    const user = userEvent.setup();
    dock();
    mountLayout();

    await user.click(menuButton());
    expect(isOpen()).toBe(true);
    expect(inertAncestor(chip())).toBeNull();
  });

  it('closes an open drawer when the walkthrough starts, and leaves the dialog live', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());
    expect(isOpen()).toBe(true);

    act(() => {
      useOnboardingStore.getState().start();
    });

    expect(isOpen()).toBe(false);
    await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(true));
    expect(inertAncestor(onboardingDialog())).toBeNull();
  });

  it('closes an open drawer when the chip returns to the walkthrough, and leaves the dialog live', async () => {
    const user = userEvent.setup();
    dock();
    mountLayout();
    await user.click(menuButton());
    expect(isOpen()).toBe(true);

    await user.click(chip());

    expect(isOpen()).toBe(false);
    await waitFor(() => expect(drawerRoot().hasAttribute('hidden')).toBe(true));
    expect(inertAncestor(onboardingDialog())).toBeNull();
  });

  it('lets one Escape close the drawer without skipping the walkthrough', async () => {
    const user = userEvent.setup();
    mountLayout();
    await user.click(menuButton());

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
    expect(localStorage.getItem(ONBOARDING_DONE_KEY)).toBeNull();
  });

  it('does the same with the walkthrough docked, and leaves the chip in place', async () => {
    const user = userEvent.setup();
    dock();
    mountLayout();
    await user.click(menuButton());

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
    expect(localStorage.getItem(ONBOARDING_DONE_KEY)).toBeNull();
    expect(chip()).toBeTruthy();
  });
});
