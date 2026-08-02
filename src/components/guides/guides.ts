import characterGuideMd from '../../../docs/character-guide.md?raw';
import hypercodeGuideMd from '../../../docs/hypercode-guide.md?raw';
import lorebookGuideMd from '../../../docs/lorebook-guide.md?raw';
import type { Permission } from '../../types';

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  source: string;
  /** If set, the user must hold this permission to view the guide. */
  requiredPermission?: Permission;
}

export const GUIDES: Guide[] = [
  {
    slug: 'character-guide',
    title: 'Character Building',
    summary:
      'How character fields, embedded lorebooks, and entry settings shape behavior — and how to keep token usage low.',
    source: characterGuideMd,
    requiredPermission: 'character:edit',
  },
  {
    slug: 'hypercode-guide',
    title: 'HYPERCODE Prompt Framework',
    summary:
      'Pick a tier and six dials to compose the narrator system prompt — what each option does, and when to skip it.',
    source: hypercodeGuideMd,
    requiredPermission: 'character:edit',
  },
  {
    slug: 'lorebook-guide',
    title: 'Lorebook Authoring',
    summary:
      'Craft entries that fire when they should — one fact per card, honest keys, Critical vs Constant, and placement bands.',
    source: lorebookGuideMd,
    requiredPermission: 'character:edit',
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
