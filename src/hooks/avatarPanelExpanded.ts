import { useCallback, useState } from 'react';

/**
 * Whether the desktop chat avatar panel is expanded (D-C2, §5.3 Collapse). A
 * device-level layout preference: localStorage only, not user-scoped and not
 * synced to the server. It sits under the `stm:` prefix, so
 * `clearAllAppStorage()` removes it on logout with every other app key.
 *
 * Expanded is the default, and only the exact string "false" collapses it, so
 * a garbled value can never hide the panel for good. Every storage access is
 * in try/catch (blocked storage, private mode); on failure the default is used
 * and a toggle still works for the session.
 */

export const AVATAR_PANEL_EXPANDED_KEY = 'stm:chat-avatar-panel-expanded';

export function readAvatarPanelExpanded(): boolean {
  try {
    return localStorage.getItem(AVATAR_PANEL_EXPANDED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeAvatarPanelExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(AVATAR_PANEL_EXPANDED_KEY, expanded ? 'true' : 'false');
  } catch { /* the toggle still works for this session */ }
}

export function useAvatarPanelExpanded(): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpandedState] = useState<boolean>(readAvatarPanelExpanded);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    writeAvatarPanelExpanded(next);
  }, []);

  return [expanded, setExpanded];
}
