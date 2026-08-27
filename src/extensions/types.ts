import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Context injection types — extensions contribute prompt content via these
// ---------------------------------------------------------------------------

/** Passed to every enabled extension's `onBuildContext` hook. */
export interface ContextBuildEvent {
  messages: { name: string; isUser: boolean; isSystem: boolean; content: string }[];
  characterName: string;
  characterAvatar: string;
  currentChatFile: string;
}

/** A single piece of content an extension wants injected into the prompt. */
export interface ContextContribution {
  content: string;
  role: 'system' | 'user';
  position: 'before_char' | 'after_char' | 'before_an' | 'after_an' | 'at_depth';
  /** Required when position is 'at_depth'. Distance from the end of history. */
  depth?: number;
  /** Sort priority within the same position (lower = earlier). Default 100. */
  order?: number;
  /**
   * Which extension produced this contribution. Stamped by the registry
   * (`runContextHooks`), never by the extension itself, so it cannot be
   * spoofed or forgotten.
   *
   * Read only by E2-S2's token breakdown, which has to name the at-depth
   * insertion class: `summarize` is the one extension whose output is a chat
   * SUMMARY rather than an instruction, and without this field it is
   * indistinguishable from any other at-depth contributor. The builders read
   * content/role/position/depth/order and nothing else, so adding it changes
   * zero emitted bytes.
   */
  sourceExtensionId?: string;
}

// ---------------------------------------------------------------------------
// UI slot props — extensions can provide React components for these slots
// ---------------------------------------------------------------------------

export interface MessageActionSlotProps {
  messageId: string;
  content: string;
  isUser: boolean;
  isSystem: boolean;
  characterAvatar?: string;
}

export interface ChatInputSlotProps {
  characterName: string;
  characterAvatar: string;
}

// ---------------------------------------------------------------------------
// Extension manifest — the complete interface an extension implements
// ---------------------------------------------------------------------------

export interface ExtensionManifest {
  /** Unique ID, e.g. 'tts', 'summarize'. */
  id: string;
  displayName: string;
  description: string;
  version: string;
  icon: LucideIcon;
  /** Default enabled state when the user has never toggled this extension. */
  defaultEnabled?: boolean;

  // -- Lifecycle --
  onInit?(): void;
  onDestroy?(): void;

  // -- Context injection --
  /** Return prompt contributions. Called synchronously during context build. */
  onBuildContext?(event: ContextBuildEvent): ContextContribution[];

  // -- Message pipeline hooks --
  /** Transform user text before it's stored. Return the (possibly modified) text. */
  onBeforeUserMessage?(text: string, charAvatar: string): string;
  /** Transform AI text after generation finishes. Return the (possibly modified) text. */
  onAfterAIMessage?(text: string, charAvatar: string): string;

  // -- UI slots --
  /** Settings panel rendered inside the extension card on ExtensionsPage. */
  settingsPanel?: ComponentType;
  /** Buttons/icons rendered next to each AI message (TTS, translate, etc.). */
  messageActions?: ComponentType<MessageActionSlotProps>;
  /** Buttons/icons rendered in or near the chat input area. */
  chatInputActions?: ComponentType<ChatInputSlotProps>;
}
