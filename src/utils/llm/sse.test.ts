import { describe, it, expect } from 'vitest';
import {
  classifyFinishReason,
  collectStream,
  parseSSEStream,
  type SSEStreamMeta,
} from './sse';

/** A ReadableStream of SSE frames, as the generation proxy emits them. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** An OpenAI-family content chunk — note `finish_reason: null` on every
 *  one of them, which is what the capture's falsy guard has to survive. */
function openAiChunk(content: string): string {
  return dataFrame({
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function openAiTerminal(reason: string): string {
  return dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

describe('classifyFinishReason', () => {
  it('folds the stop vocabularies together', () => {
    expect(classifyFinishReason('stop')).toBe('stop');
    // Raw Anthropic, reachable through a `custom` profile pointed at an
    // Anthropic endpoint — the backend's normalisation is not in that path.
    expect(classifyFinishReason('end_turn')).toBe('stop');
    expect(classifyFinishReason('stop_sequence')).toBe('stop');
    expect(classifyFinishReason('STOP')).toBe('stop');
  });

  it('folds the length vocabularies together', () => {
    expect(classifyFinishReason('length')).toBe('length');
    expect(classifyFinishReason('max_tokens')).toBe('length');
  });

  it('reports absence distinctly from stopping', () => {
    expect(classifyFinishReason(null)).toBe('absent');
    expect(classifyFinishReason(undefined)).toBe('absent');
    expect(classifyFinishReason('')).toBe('absent');
    expect(classifyFinishReason('   ')).toBe('absent');
  });

  it('never guesses "stop" for an unrecognized value', () => {
    // Guessing "it probably finished" is how a content-filter cutoff gets
    // stored as a finished piece of work.
    expect(classifyFinishReason('content_filter')).toBe('other');
    expect(classifyFinishReason('tool_calls')).toBe('other');
    expect(classifyFinishReason('something_new_in_2027')).toBe('other');
  });
});

describe('finish reason capture', () => {
  it('captures an OpenAI-family terminal chunk', async () => {
    const meta: SSEStreamMeta = { finishReason: null };
    const text = await collectStream(
      sseStream([openAiChunk('Hello '), openAiChunk('world'), openAiTerminal('length')]),
      meta
    );
    expect(text).toBe('Hello world');
    expect(meta.finishReason).toBe('length');
  });

  it('is not erased by the null finish_reason on every content chunk', async () => {
    // If the capture dropped its falsy guard, the trailing content chunk's
    // `null` would overwrite the reason that already arrived.
    const meta: SSEStreamMeta = { finishReason: null };
    await collectStream(
      sseStream([openAiChunk('a'), openAiTerminal('length'), openAiChunk('b')]),
      meta
    );
    expect(meta.finishReason).toBe('length');
  });

  it('captures a terminal chunk that carries NO content', async () => {
    // The terminal chunk is content-free by definition, so a capture that
    // ran only alongside emitted content would miss every one of them.
    const meta: SSEStreamMeta = { finishReason: null };
    const text = await collectStream(
      sseStream([openAiChunk('done'), openAiTerminal('stop')]),
      meta
    );
    expect(text).toBe('done');
    expect(meta.finishReason).toBe('stop');
  });

  it('captures Anthropic-shaped stop_reason on the delta', async () => {
    const meta: SSEStreamMeta = { finishReason: null };
    await collectStream(
      sseStream([
        dataFrame({ type: 'content_block_delta', delta: { text: 'hi' } }),
        dataFrame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      ]),
      meta
    );
    expect(meta.finishReason).toBe('max_tokens');
  });

  it('captures a top-level stop_reason', async () => {
    const meta: SSEStreamMeta = { finishReason: null };
    await collectStream(
      sseStream([dataFrame({ content: 'x' }), dataFrame({ stop_reason: 'end_turn' })]),
      meta
    );
    expect(meta.finishReason).toBe('end_turn');
  });

  it('leaves the reason NULL when the stream just ends', async () => {
    // The severed-stream case, and the reason `absent` exists at all:
    // collectStream returns whatever accumulated when the reader reported
    // done, with no completeness check of its own.
    const meta: SSEStreamMeta = { finishReason: null };
    const text = await collectStream(
      sseStream([openAiChunk('half a sen')]),
      meta
    );
    expect(text).toBe('half a sen');
    expect(meta.finishReason).toBeNull();
    expect(classifyFinishReason(meta.finishReason)).toBe('absent');
  });

  it('leaves the reason null after a [DONE] sentinel with no reason', async () => {
    const meta: SSEStreamMeta = { finishReason: null };
    await collectStream(sseStream([openAiChunk('x'), 'data: [DONE]\n\n']), meta);
    expect(meta.finishReason).toBeNull();
  });

  it('still streams text when no meta is passed', async () => {
    // Every existing caller omits it; the out-param must stay optional.
    const out: string[] = [];
    for await (const t of parseSSEStream(sseStream([openAiChunk('a'), openAiChunk('b')]))) {
      out.push(t);
    }
    expect(out.join('')).toBe('ab');
  });

  it('still throws on a mid-stream provider error', async () => {
    const meta: SSEStreamMeta = { finishReason: null };
    await expect(
      collectStream(sseStream([dataFrame({ error: { message: 'rate limited' } })]), meta)
    ).rejects.toThrow(/rate limited/);
  });
});
