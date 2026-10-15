/**
 * @vitest-environment jsdom
 *
 * SidebarSection against D-S16: a heading holding a toggle button that names the
 * region it controls, the region leaving the accessibility tree when collapsed
 * while its children stay mounted, and header actions that outlive a collapse.
 */
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarSection } from './SidebarSection';

function Harness({
  level = 2,
  initiallyOpen = true,
  actions,
}: {
  level?: 2 | 3;
  initiallyOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <SidebarSection id="works" label="Works" level={level} open={open} onToggle={() => setOpen((o) => !o)} count={3} actions={actions}>
      <button type="button">Inner</button>
    </SidebarSection>
  );
}

const toggle = () => screen.getByRole('button', { name: /^Works/ });
const region = () => document.getElementById('sidebar-sec-works') as HTMLElement;

afterEach(cleanup);

describe('markup', () => {
  it('is an h2 holding a toggle that names the region by id, with aria-expanded', () => {
    render(<Harness />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(within(heading).getByRole('button', { name: /^Works/ })).toBe(toggle());
    expect(toggle().getAttribute('aria-controls')).toBe('sidebar-sec-works');
    expect(region()).not.toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('renders an h3 at level 3', () => {
    render(<Harness level={3} />);
    expect(screen.getByRole('heading', { level: 3 })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('puts the count in the toggle\'s name', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Works (3)' })).toBe(toggle());
  });
});

describe('collapsing', () => {
  it('hides the region from the accessibility tree and display, and keeps its children mounted', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Inner' })).toBeTruthy();

    await user.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(region().hasAttribute('hidden')).toBe(true);
    expect(getComputedStyle(region()).display).toBe('none');
    expect(screen.queryByRole('button', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inner', hidden: true })).toBeTruthy();
  });

  it('starts collapsed when told to, with the region hidden', () => {
    render(<Harness initiallyOpen={false} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(region().hasAttribute('hidden')).toBe(true);
  });

  it('opens again on a second click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    await user.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(region().hasAttribute('hidden')).toBe(false);
  });
});

describe('keyboard', () => {
  it('flips on Enter and on Space', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(toggle());

    await user.keyboard('{Enter}');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('header actions', () => {
  it('sit in the heading row, outside the region, and stay reachable when collapsed', async () => {
    const user = userEvent.setup();
    render(<Harness actions={<button type="button">Add</button>} />);
    const add = screen.getByRole('button', { name: 'Add' });
    const headingRow = screen.getByRole('heading', { level: 2 }).parentElement as HTMLElement;
    expect(headingRow.contains(add)).toBe(true);
    expect(region().contains(add)).toBe(false);

    await user.click(toggle());
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});
