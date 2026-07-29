import { describe, it, expect, vi } from 'vitest';
import { runUserVoiceSynthesis } from './userVoice';
import type { IngestMessage } from './types';

function msg(over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id: over.id ?? `m${Math.random()}`,
    name: 'Sam',
    isUser: true,
    isSystem: false,
    content: 'hi',
    timestamp: 1000,
    swipeIdx: 0,
    swipesCount: 1,
    ...over,
  };
}

const CHAT = { character_avatar: 'aria.png', file_name: 'chat1.jsonl' };

describe('runUserVoiceSynthesis', () => {
  it('returns an empty, zero-confidence section when there are no user messages', async () => {
    const result = await runUserVoiceSynthesis({
      messages: [msg({ isUser: false, content: 'not the user' })],
      chat: CHAT,
    });
    expect(result.section.confidence).toBe(0);
    expect(result.section.sample_passages).toEqual([]);
    expect(result.llmCalls).toBe(0);
  });

  it('computes sentence-length distribution and paragraph density mechanically', async () => {
    const longSentences =
      'This is a fairly long sentence with quite a few words in it, deliberately padded out for testing purposes so the mean sentence length comes out well above the threshold. ' +
      'Here is another long sentence that also has many words in it, again padded further to push the average sentence length comfortably past twenty words this time.';
    const messages = Array.from({ length: 20 }, () => msg({ content: longSentences }));
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT });
    expect(result.section.diction.sentence_length.mean).toBeGreaterThan(15);
    expect(result.section.diction.sentence_length.distribution).toBe('long-dominant');
  });

  it('detects tight paragraph density for single-line messages', async () => {
    const messages = Array.from({ length: 10 }, () => msg({ content: 'A short line.' }));
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT });
    expect(result.section.diction.paragraph_density).toBe('tight');
  });

  it('scales confidence down for very short average message length', async () => {
    const messages = Array.from({ length: 50 }, () => msg({ content: '*nods*' }));
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT });
    expect(result.section.confidence).toBeLessThan(0.3);
  });

  it('picks the longest messages as sample passages, in original chat order', async () => {
    const messages = [
      msg({ id: 'a', content: 'short' }),
      msg({ id: 'b', content: 'a considerably longer message with more words in it' }),
      msg({ id: 'c', content: 'medium length message here' }),
    ];
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT });
    const ids = result.section.sample_passages.map((p) => p.text);
    // 'b' (longest) and 'c' should both appear; original order preserved
    // (b comes before c in the transcript).
    const bIdx = ids.findIndex((t) => t.includes('considerably'));
    const cIdx = ids.findIndex((t) => t.includes('medium length'));
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThan(bIdx);
    expect(result.section.sample_passages[0].source?.kind).toBe('chat_message');
  });

  it('applies a valid LLM response to register/tendency/style_summary/devices', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        style_summary: 'Terse and direct.',
        register: 'pulp',
        rhetorical_devices: ['fragments-for-emphasis'],
        tendency: 'directive',
      })
    );
    const messages = [msg({ content: 'A reasonably long message to give it something to read.' })];
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT, llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.section.register).toBe('pulp');
    expect(result.section.interaction_style.tendency).toBe('directive');
    expect(result.section.style_summary).toBe('Terse and direct.');
    expect(result.section.rhetorical_devices).toEqual(['fragments-for-emphasis']);
  });

  it('falls back to safe defaults when the model returns an invalid enum value', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({ register: 'not-a-real-register', tendency: 'nonsense' })
    );
    const messages = [msg({ content: 'Some message content here for the test.' })];
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT, llm });
    expect(result.section.register).toBe('mixed');
    expect(result.section.interaction_style.tendency).toBe('reactive');
  });

  it('keeps mechanical stats when the model call fails (non-abort)', async () => {
    const llm = vi.fn(async () => {
      throw new Error('network blip');
    });
    const messages = [msg({ content: 'Some message content here for the test.' })];
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT, llm });
    expect(result.section.diction.sentence_length.mean).toBeGreaterThan(0);
    expect(result.section.register).toBe('mixed'); // default, not fabricated
  });

  it('propagates an AbortError rather than swallowing it', async () => {
    const llm = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const messages = [msg({ content: 'Some message content here for the test.' })];
    await expect(runUserVoiceSynthesis({ messages, chat: CHAT, llm })).rejects.toThrow();
  });

  it('produces a mechanical-only result when no llm is provided', async () => {
    const messages = [msg({ content: 'Some message content here for the test.' })];
    const result = await runUserVoiceSynthesis({ messages, chat: CHAT });
    expect(result.llmCalls).toBe(0);
    expect(result.section.register).toBe('mixed');
    expect(result.section.diction.sentence_length.mean).toBeGreaterThan(0);
  });
});
