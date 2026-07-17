/**
 * Quick chat styles — one-tap bundles of a prompt template (mainPrompt) and a
 * sampler preset for an individual chat session. Applying one creates (or
 * reuses, matched by exact name) a real PromptTemplate + GenerationPreset so
 * the user can inspect and tune them in Settings like any other, then links
 * both to the chat file.
 */
import { buildHypercodePrompt } from './hypercode';
import { DEFAULT_SAMPLER, type SamplerParams } from '../stores/generationStore';

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
- Stay {{char}} throughout — their voice, mood, humor, and quirks come through in how they write.
- React to what {{user}} just said. Ask things back sometimes, tease, drift between topics — like a real conversation.
- No narration, no scene-setting paragraphs, no describing your own actions in prose. An occasional short *action* is fine only if it reads like something someone would actually type.
- Never speak, act, or decide for {{user}}. Never mention being an AI or break character.`;

export const QUICK_CHAT_STYLES: QuickChatStyle[] = [
  {
    id: 'immersive',
    name: 'Immersive Narrator',
    emoji: '📖',
    description: 'Rich, verbose worldbuilding prose — long scene-driven replies (HYPERCODE Premium).',
    mainPrompt: buildHypercodePrompt({
      tier: 'premium',
      pov: 'third',
      tense: 'past',
      length: 'long',
      tone: 'cinematic',
      dialogue: 'standard',
      mature: 'unflinching',
    }),
    sampler: {
      ...DEFAULT_SAMPLER,
      temperature: 0.9,
      maxTokens: 1500,
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
    sampler: {
      ...DEFAULT_SAMPLER,
      temperature: 0.75,
      maxTokens: 300,
      topP: 0.9,
      minP: 0.05,
    },
  },
];
