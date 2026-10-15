import { useCallback, useState } from 'react';

/**
 * Which drawer sections are expanded (D-S16, D-G7). A device-level layout
 * preference: localStorage only, not user-scoped and not synced to the server.
 * It sits under the `stm:` prefix, so `clearAllAppStorage()` removes it on
 * logout with every other app key.
 *
 * The value is user-writable JSON that is parsed at load, so it is read
 * defensively: anything that is not an object of booleans falls back, key by
 * key, to the default. Every storage access is in try/catch (blocked storage,
 * private mode); on failure the defaults are used and a toggle still works for
 * the session.
 */

export const SIDEBAR_SECTIONS_KEY = 'stm:sidebar-sections';

export interface SidebarSections {
  characters: boolean;
  groups: boolean;
  works: boolean;
  personal: boolean;
}

export type SectionId = keyof SidebarSections;

export const DEFAULT_SECTIONS: Readonly<SidebarSections> = {
  characters: true,
  groups: false,
  works: true,
  personal: true,
};

const SECTION_IDS = Object.keys(DEFAULT_SECTIONS) as SectionId[];

export function readSections(): SidebarSections {
  const sections = { ...DEFAULT_SECTIONS };
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (raw === null) return sections;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return sections;
    // Read the four known keys one by one. Spreading the parsed object would
    // carry across whatever else the stored JSON holds.
    const stored = parsed as Record<string, unknown>;
    for (const id of SECTION_IDS) {
      if (typeof stored[id] === 'boolean') sections[id] = stored[id];
    }
  } catch {
    return { ...DEFAULT_SECTIONS };
  }
  return sections;
}

export function writeSections(sections: SidebarSections): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(sections));
  } catch { /* the toggle still works for this session */ }
}

export function useSidebarSections() {
  const [sections, setSections] = useState<SidebarSections>(readSections);

  const toggle = useCallback(
    (id: SectionId) => {
      const next = { ...sections, [id]: !sections[id] };
      setSections(next);
      writeSections(next);
    },
    [sections],
  );

  return { sections, toggle };
}
