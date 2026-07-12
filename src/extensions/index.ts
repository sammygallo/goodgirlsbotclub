// Register all built-in extensions.
// Import order determines registration order (and thus display order).
import './builtins/tts';
import './builtins/imageGen';
import './builtins/translate';
import './builtins/summarize';
import './builtins/autoMemory';
import './builtins/expressions';
import './builtins/lovense';

// Re-export for external consumption.
export { extensionRegistry } from './registry';
export type {
  ExtensionManifest,
  ContextBuildEvent,
  ContextContribution,
  MessageActionSlotProps,
  ChatInputSlotProps,
} from './types';
