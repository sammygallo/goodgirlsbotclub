/**
 * STscript display commands — /costume, /bg
 * Phase 6.4: programmatic control of VN mode visuals.
 */

import { registerCommand } from '../registry';
import type { ParsedArg } from '../types';

function getUnnamedArgs(args: ParsedArg[]): string {
  return args.filter(a => !a.key).map(a => a.value).join(' ');
}

// ---------------------------------------------------------------------------
// /costume — set or clear the active sprite costume folder
// ---------------------------------------------------------------------------

registerCommand({
  name: 'costume',
  description: 'Set or clear the sprite costume folder for the current character. Use without args to clear.',
  category: 'character',
  usage: '/costume [folder_name]  — e.g. /costume Alice_swimsuit  or  /costume  (to reset)',
  async handler(args, _rawArgs, ctx) {
    const { useCharacterStore } = await import('../../../stores/characterStore');
    const character = useCharacterStore.getState().selectedCharacter;
    if (!character) {
      ctx.showToast('/costume: no character selected', 'error');
      return '';
    }

    const { getCostume } = await import('../../../hooks/displayPreferences');
    const { useDisplayPreferencesStore } = await import('../../../stores/displayPreferencesStore');
    const folderName = getUnnamedArgs(args).trim();

    if (folderName) {
      useDisplayPreferencesStore.getState().setCostume(character.avatar, folderName);
      ctx.showToast(`Costume set to "${folderName}"`, 'success');
      return folderName;
    } else {
      const current = getCostume(character.avatar);
      useDisplayPreferencesStore.getState().clearCostume(character.avatar);
      if (current) ctx.showToast('Costume reset to default', 'success');
      return '';
    }
  },
});

// ---------------------------------------------------------------------------
// /bg — set or clear the VN background image
// ---------------------------------------------------------------------------

registerCommand({
  name: 'bg',
  description: 'Set or clear the VN background image. Accepts a URL or data URI. Use "clear" to remove.',
  category: 'character',
  usage: '/bg [url]  — e.g. /bg https://example.com/forest.jpg  or  /bg clear',
  async handler(args, _rawArgs, ctx) {
    const { useCharacterStore } = await import('../../../stores/characterStore');
    const character = useCharacterStore.getState().selectedCharacter;

    const {
      setVnBgForCharacter, clearVnBgForCharacter,
      setVnBgGlobal, clearVnBgGlobal,
    } = await import('../../../hooks/displayPreferences');

    const arg = getUnnamedArgs(args).trim();

    if (!arg || arg === 'clear') {
      // Clear background
      if (character) {
        clearVnBgForCharacter(character.avatar);
      }
      clearVnBgGlobal();
      ctx.showToast('Background cleared', 'success');
      return '';
    }

    // Set background — if a character is selected, set per-character; otherwise global
    if (character) {
      setVnBgForCharacter(character.avatar, arg);
      ctx.showToast('Background set for ' + character.name, 'success');
    } else {
      setVnBgGlobal(arg);
      ctx.showToast('Global background set', 'success');
    }
    return arg;
  },
});
