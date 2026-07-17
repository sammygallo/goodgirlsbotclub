/**
 * Quick chat styles — one-tap bundles of a prompt template (mainPrompt) and a
 * sampler preset for an individual chat session. Applying one creates (or
 * reuses, matched by exact name) a real PromptTemplate + GenerationPreset so
 * the user can inspect and tune them in Settings like any other, then links
 * both to the chat file.
 */
import { buildHypercodePrompt } from './hypercode';
import { DEFAULT_SAMPLER, type SamplerParams } from '../stores/generationStore';

/**
 * Sentinel stored in a chat's template/preset link map meaning "no style for
 * this chat — use global settings", explicitly bypassing any character-linked
 * template/preset. Never collides with real ids (`tpl_*` / `preset_*`), and
 * survives delete-cleanup loops since it never equals a deleted id.
 */
export const CHAT_STYLE_NONE = '__none__';

export interface QuickChatStyle {
  id: string;
  /** Shared name for the created template and preset. */
  name: string;
  emoji: string;
  description: string;
  mainPrompt: string;
  sampler: SamplerParams;
}

export const NATURAL_CHAT_PROMPT = `You are {{char}}, messaging with {{user}} in real time. This is a casual conversation, not a story.

- Reply the way a real person texts: short, natural, in the moment. Usually 1–3 sentences.
- Hard limit: never write more than one short paragraph (about 4 sentences). If a longer reply is forming, send the short version instead — you can always say more next message.
- Stay {{char}} throughout — their voice, mood, humor, and quirks come through in how they write.
- React to what {{user}} just said. Ask things back sometimes, tease, drift between topics — like a real conversation.
- No narration, no scene-setting paragraphs, no describing your own actions in prose. An occasional short *action* is fine only if it reads like something someone would actually type.
- Never speak, act, or decide for {{user}}. Never mention being an AI or break character.`;

export const QUICK_CHAT_STYLES: QuickChatStyle[] = [
  {
    id: 'immersive',
    name: 'Immersive Narrator',
    emoji: '📖',
    description: 'Rich worldbuilding prose that scales with the scene (HYPERCODE Premium).',
    // 'adaptive' (not 'long') — "6–10 paragraphs" walls of text routinely
    // blew past the token cap and got truncated mid-scene. Adaptive matches
    // depth to scene intensity, and 2048 gives big scenes room to finish.
    mainPrompt: buildHypercodePrompt({
      tier: 'premium',
      pov: 'third',
      tense: 'past',
      length: 'adaptive',
      tone: 'cinematic',
      dialogue: 'standard',
      mature: 'unflinching',
    }),
    sampler: {
      ...DEFAULT_SAMPLER,
      temperature: 0.9,
      maxTokens: 2048,
      topP: 0.97,
      minP: 0.05,
    },
  },
  {
    id: 'natural',
    name: 'Natural Chat',
    emoji: '💬',
    description: 'Quick, short replies that feel like texting someone in real life.',
    mainPrompt: NATURAL_CHAT_PROMPT,
    // 400 (not 300) — enough cushion that a reply running slightly past the
    // brevity instruction still ends on its own instead of getting chopped.
    sampler: {
      ...DEFAULT_SAMPLER,
      temperature: 0.75,
      maxTokens: 400,
      topP: 0.9,
      minP: 0.05,
    },
  },
];
