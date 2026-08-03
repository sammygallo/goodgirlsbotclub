// User-voice synthesis (story-state phase 7, post-walk pass).
//
// Sentence-length distribution, paragraph density, the dialogue/narration
// ratio and typical input length are all computed MECHANICALLY here, in
// TS, from the user's own chat messages — not asked of the model. The
// model is called once, for the one thing a regex genuinely can't do:
// a qualitative read of register, rhetorical devices, and a prose style
// summary (see USER_VOICE_SYSTEM in prompts.ts).
//
// "Don't fabricate voice" (schema doc): a user who mostly typed `*nods*`
// has given this pass almost nothing to work with, and `confidence`
// exists precisely so the UI can say so rather than presenting a guess
// as a read.

import type { ProjectChatRef } from '../../api/client';
import { buildMsgRef, chatMessageSourceRef } from '../storyBible/sourceRefs';
import { estimateTokens } from '../tokenizer';
import type { PovPreferences, UserVoiceSection } from '../../types/storyBible';
import { USER_VOICE_SYSTEM, firstJsonObject, userVoicePrompt } from './prompts';
import type { IngestMessage, LlmCall } from './types';

export interface UserVoiceInput {
  messages: IngestMessage[];
  chat: ProjectChatRef;
  llm?: LlmCall;
  signal?: AbortSignal;
}

export interface UserVoiceResult {
  section: UserVoiceSection;
  llmCalls: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Rough sentence split — good enough for length-distribution stats,
 *  not meant to be a real sentence tokenizer. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Blocks separated by a blank line — a cheap proxy for "how many
 *  paragraphs does a typical message contain". */
function paragraphBlocks(text: string): number {
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  return Math.max(1, blocks.length);
}

/** Fraction of non-whitespace characters that fall inside `*asterisk*`
 *  spans — a common RP convention for narration/action versus plain
 *  dialogue or OOC text. 0 = pure dialogue, 1 = pure narration, matching
 *  the schema's `direction_to_narration_ratio` framing. */
function asteriskRatio(text: string): number {
  const total = text.replace(/\s/g, '').length;
  if (total === 0) return 0;
  const matches = text.match(/\*[^*]+\*/g) ?? [];
  const inside = matches.reduce((n, m) => n + m.replace(/\s/g, '').length, 0);
  return clamp(inside / total, 0, 1);
}

function detectInChatPov(messages: string[]): PovPreferences['in_chat'] {
  let second = 0;
  let firstPast = 0;
  for (const text of messages) {
    second += (text.match(/\byou(r|'re)?\b/gi) ?? []).length;
    firstPast += (text.match(/\bI\s+\w+ed\b/g) ?? []).length;
    firstPast += (text.match(/\b(was|had|felt|saw|knew)\b/gi) ?? []).length;
  }
  if (second === 0 && firstPast === 0) return null;
  if (second > firstPast * 1.5) return 'second-present';
  if (firstPast > second * 1.5) return 'first-past';
  return 'third-mixed';
}

const ALLOWED_REGISTERS: UserVoiceSection['register'][] = [
  'literary',
  'commercial',
  'pulp',
  'experimental',
  'mixed',
];
const ALLOWED_TENDENCIES: UserVoiceSection['interaction_style']['tendency'][] = [
  'directive',
  'collaborative',
  'reactive',
];

function emptySection(): UserVoiceSection {
  return {
    style_summary: '',
    register: 'mixed',
    diction: {
      preferred_vocabulary: [],
      avoided_vocabulary: [],
      sentence_length: { mean: 0, distribution: 'balanced' },
      paragraph_density: 'medium',
    },
    rhetorical_devices: [],
    pov_preferences: { in_chat: null, likely_target_for_prose: null },
    interaction_style: {
      tendency: 'reactive',
      direction_to_narration_ratio: 0,
      typical_input_length: 0,
    },
    sample_passages: [],
    confidence: 0,
  };
}

/** Run the mechanical half plus (if an LLM is available) the one
 *  qualitative call. Never throws on a failed/aborted model call except
 *  for a genuine abort — a synthesis with no LLM read is still useful. */
export async function runUserVoiceSynthesis(
  input: UserVoiceInput
): Promise<UserVoiceResult> {
  const userMessages = input.messages.filter((m) => m.isUser && m.content.trim());
  const section = emptySection();
  let llmCalls = 0;

  if (userMessages.length === 0) {
    return { section, llmCalls };
  }

  const allSentences = userMessages.flatMap((m) => splitSentences(m.content));
  const sentenceLengths = allSentences.map(wordCount).filter((n) => n > 0);
  const totalWords = userMessages.reduce((n, m) => n + wordCount(m.content), 0);

  if (sentenceLengths.length > 0) {
    const mean =
      sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
    const variance =
      sentenceLengths.reduce((a, b) => a + (b - mean) ** 2, 0) /
      sentenceLengths.length;
    const stdev = Math.sqrt(variance);
    const distribution =
      stdev / Math.max(mean, 1) > 0.6
        ? 'varied'
        : mean < 8
          ? 'short-dominant'
          : mean > 20
            ? 'long-dominant'
            : 'balanced';
    section.diction.sentence_length = { mean, distribution };
  }

  const avgBlocks =
    userMessages.reduce((n, m) => n + paragraphBlocks(m.content), 0) /
    userMessages.length;
  section.diction.paragraph_density =
    avgBlocks <= 1.2 ? 'tight' : avgBlocks <= 3 ? 'medium' : 'loose';

  const avgAsterisk =
    userMessages.reduce((n, m) => n + asteriskRatio(m.content), 0) /
    userMessages.length;
  section.interaction_style.direction_to_narration_ratio = clamp(avgAsterisk, 0, 1);

  const avgTokens =
    userMessages.reduce((n, m) => n + estimateTokens(m.content), 0) /
    userMessages.length;
  section.interaction_style.typical_input_length = Math.round(avgTokens);

  section.pov_preferences.in_chat = detectInChatPov(userMessages.map((m) => m.content));

  // Confidence: scales with how much material there is, capped well
  // short of 1.0 — this is a self-assessment, not a measurement. Heavily
  // discounted when messages are mostly very short (the schema doc's
  // "*nods* 400 times" case has plenty of MESSAGES but almost no voice).
  const avgWordsPerMessage = totalWords / userMessages.length;
  let confidence = clamp(totalWords / 2000, 0.1, 0.85);
  if (avgWordsPerMessage < 4) confidence *= 0.4;
  section.confidence = Math.round(confidence * 100) / 100;

  // Sample passages: the longest turns, kept in original chat order so a
  // reviewer reads them as they occurred.
  const withIndex = userMessages.map((m, i) => ({ m, i }));
  const longest = [...withIndex]
    .sort((a, b) => wordCount(b.m.content) - wordCount(a.m.content))
    .slice(0, 8)
    .sort((a, b) => a.i - b.i);
  section.sample_passages = await Promise.all(
    longest.map(async ({ m }) => {
      const ref = await buildMsgRef(m);
      return {
        text: m.content.slice(0, 2000),
        source: chatMessageSourceRef(input.chat, ref, m.content),
      };
    })
  );

  if (!input.llm) {
    return { section, llmCalls };
  }

  const prompt = userVoicePrompt(section.sample_passages.map((p) => p.text));
  try {
    const raw = await input.llm(
      [
        { role: 'system', content: USER_VOICE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 600, signal: input.signal }
    );
    llmCalls++;
    const obj = firstJsonObject(raw);
    if (obj) {
      const register = String(obj.register ?? '').toLowerCase();
      section.register = (
        ALLOWED_REGISTERS.includes(register as UserVoiceSection['register'])
          ? register
          : 'mixed'
      ) as UserVoiceSection['register'];
      const tendency = String(obj.tendency ?? '').toLowerCase();
      section.interaction_style.tendency = (
        ALLOWED_TENDENCIES.includes(
          tendency as UserVoiceSection['interaction_style']['tendency']
        )
          ? tendency
          : 'reactive'
      ) as UserVoiceSection['interaction_style']['tendency'];
      section.style_summary =
        typeof obj.style_summary === 'string' ? obj.style_summary.trim().slice(0, 1000) : '';
      section.rhetorical_devices = Array.isArray(obj.rhetorical_devices)
        ? obj.rhetorical_devices
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map((v) => v.trim().slice(0, 120))
            .slice(0, 12)
        : [];
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    // A failed read leaves the mechanical stats intact — strictly less
    // information, never wrong information.
  }

  return { section, llmCalls };
}
