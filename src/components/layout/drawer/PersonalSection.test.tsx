/**
 * @vitest-environment jsdom
 *
 * The drawer's Personal block (D-S9): the items and their order, the Settings /
 * My API Keys permission split (copied from the old header, so it is pinned with
 * `can` mocked as well as with the real one), the install row appearing only
 * once the browser offers it, and every navigating or panel-opening item closing
 * the drawer first (D-S14).
 *
 * With the real `can()`, 'settings:personal' maps to the same permission as
 * 'settings:view', so for every role Settings shows and My API Keys never does;
 * the My API Keys branch is only reachable with `can` mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../../stores/authStore';
import { usePersonaStore } from '../../../stores/personaStore';
import { useSettingsPanelStore } from '../../../stores/settingsPanelStore';
import { can } from '../../../utils/permissions';
import { PersonalSection } from './PersonalSection';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('../../../utils/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/permissions')>();
  return { ...actual, can: vi.fn(actual.can) };
});

const realCan = (await vi.importActual<typeof import('../../../utils/permissions')>('../../../utils/permissions')).can;

const initial = {
  auth: useAuthStore.getState(),
  persona: usePersonaStore.getState(),
  settings: useSettingsPanelStore.getState(),
};

function signIn(role: 'end_user' | 'contributor' | 'admin' | 'owner') {
  useAuthStore.setState({ currentUser: { handle: 'u', name: 'U', role } as never });
}

function mount(props: { open?: boolean; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <PersonalSection
      open={props.open ?? true}
      onToggle={() => {}}
      onClose={onClose}
      onPersonaSurfaceChange={() => {}}
    />,
  );
  return { ...utils, onClose };
}

const region = () => document.getElementById('sidebar-sec-personal') as HTMLElement;
const rowNames = () =>
  within(region())
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);
/** Fires the browser's one-shot install offer; `prompt` is what the Install app row ends up calling. */
function fireInstallPrompt() {
  const prompt = vi.fn(async () => {});
  const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
  });
  act(() => {
    window.dispatchEvent(offer);
  });
  return prompt;
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  navigate.mockReset();
  vi.mocked(can).mockImplementation(realCan);
  usePersonaStore.setState({ personas: [], activePersonaId: null });
  signIn('end_user');
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(initial.auth, true);
  usePersonaStore.setState(initial.persona, true);
  useSettingsPanelStore.setState(initial.settings, true);
  vi.unstubAllGlobals();
});

describe('items and order', () => {
  it('lists Profile, Persona, Settings, Install app and Logout, in that order, with a rule above Logout', () => {
    mount();
    fireInstallPrompt();

    expect(rowNames()).toEqual(['Profile', 'Persona: none', 'Settings', 'Install app', 'Logout']);
    const logout = screen.getByRole('button', { name: 'Logout' });
    expect(logout.closest('li')?.classList.contains('border-t')).toBe(true);
  });

  it('puts the section toggle ahead of the items, under an h2', () => {
    mount();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(within(heading).getByRole('button', { name: 'Personal' })).toBeTruthy();
    expect(region().parentElement?.id).toBe('app-drawer-personal');
  });

  it('omits Install app when the browser has not offered it', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
    expect(rowNames()).toEqual(['Profile', 'Persona: none', 'Settings', 'Logout']);
  });
});

describe('Settings / My API Keys', () => {
  it.each(['end_user', 'contributor', 'admin', 'owner'] as const)(
    'shows Settings and not My API Keys for %s with the real can()',
    (role) => {
      signIn(role);
      mount();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'My API Keys' })).toBeNull();
    },
  );

  it('shows My API Keys, and not Settings, when only settings:personal is allowed, and opens the keys page', async () => {
    const user = userEvent.setup();
    vi.mocked(can).mockImplementation((_role, action) => action === 'settings:personal');
    const openToPage = vi.fn();
    useSettingsPanelStore.setState({ openToPage });
    mount();

    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'My API Keys' }));
    expect(openToPage).toHaveBeenCalledWith('my-keys');
  });

  it('shows neither when neither is allowed', () => {
    vi.mocked(can).mockImplementation(() => false);
    mount();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'My API Keys' })).toBeNull();
  });

  it('shows Settings and not My API Keys when settings:view is allowed', () => {
    vi.mocked(can).mockImplementation(() => true);
    mount();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'My API Keys' })).toBeNull();
  });
});

describe('Install app', () => {
  it('appears once beforeinstallprompt fires', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();

    fireInstallPrompt();
    expect(screen.getByRole('button', { name: 'Install app' })).toBeTruthy();
  });

  it('appears after the event even if the section was collapsed when it fired', () => {
    const props = { onToggle: () => {}, onClose: () => {}, onPersonaSurfaceChange: () => {} };
    const { rerender } = render(<PersonalSection open={false} {...props} />);
    expect(region().hasAttribute('hidden')).toBe(true);

    fireInstallPrompt();
    rerender(<PersonalSection open {...props} />);
    expect(screen.getByRole('button', { name: 'Install app' })).toBeTruthy();
  });
});

describe('closing the drawer first (D-S14)', () => {
  it('Profile closes the drawer, then navigates', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    navigate.mockImplementation((to: string) => calls.push(`navigate:${to}`));
    mount({ onClose: () => calls.push('close') });

    await user.click(screen.getByRole('button', { name: 'Profile' }));
    expect(calls).toEqual(['close', 'navigate:/profile']);
  });

  it('Settings closes the drawer, then opens the panel', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    useSettingsPanelStore.setState({ open: () => calls.push('open') });
    mount({ onClose: () => calls.push('close') });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(calls).toEqual(['close', 'open']);
  });

  it('My API Keys closes the drawer, then opens the keys page', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.mocked(can).mockImplementation((_role, action) => action === 'settings:personal');
    useSettingsPanelStore.setState({ openToPage: (page) => calls.push(`openToPage:${page}`) });
    mount({ onClose: () => calls.push('close') });

    await user.click(screen.getByRole('button', { name: 'My API Keys' }));
    expect(calls).toEqual(['close', 'openToPage:my-keys']);
  });

  it('Install app shows the browser\'s prompt and does not close the drawer', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    const prompt = fireInstallPrompt();

    await user.click(screen.getByRole('button', { name: 'Install app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Logout', () => {
  it('calls the auth store\'s logout', async () => {
    const user = userEvent.setup();
    const logout = vi.fn(async () => {});
    useAuthStore.setState({ logout });
    mount();

    await user.click(screen.getByRole('button', { name: 'Logout' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
