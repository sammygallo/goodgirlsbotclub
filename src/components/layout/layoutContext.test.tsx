/**
 * @vitest-environment jsdom
 *
 * The seam between MainLayout's drawer state and the routed hero page
 * (E6-S2): MainLayout hands `openSidebar` down through `<Outlet context>`, and
 * the page reads it with useLayoutContext(). tools/heroSlides.test.ts pins that
 * MainLayout passes a context at all; this pins that the other end receives
 * exactly what was passed, and survives the page being rendered without one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { useLayoutContext, type LayoutOutletContext } from './layoutContext';

afterEach(cleanup);

function Page() {
  const layout = useLayoutContext();
  return <button onClick={() => layout?.openSidebar()}>{layout ? 'wired' : 'unwired'}</button>;
}

describe('useLayoutContext', () => {
  it('returns what the layout passed through Outlet context', () => {
    const openSidebar = vi.fn();
    const context: LayoutOutletContext = { openSidebar };
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route index element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'wired' }));
    expect(openSidebar).toHaveBeenCalledTimes(1);
  });

  it('is undefined, and does not throw, when the page is rendered outside any layout', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route index element={<Page />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'unwired' })).toBeTruthy();
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow();
  });
});
