import { useOutletContext } from 'react-router-dom';

/**
 * What MainLayout hands to the routed page through `<Outlet context>`.
 *
 * `openSidebar` exists for the hero's Browse / See all (E6-S2): below 1024px
 * the character list lives in the sidebar DRAWER, whose open state is local
 * state in MainLayout, so a routed page can only ask for it to open through
 * this. (E6-S3 turns the sidebar into a drawer at every width; this is the
 * seam it keeps.)
 */
export interface LayoutOutletContext {
  openSidebar: () => void;
}

/**
 * The layout's shared actions, or undefined when the page is rendered outside
 * MainLayout (a test, a future standalone route) — callers must tolerate that.
 */
export function useLayoutContext(): LayoutOutletContext | undefined {
  return useOutletContext<LayoutOutletContext | undefined>();
}
