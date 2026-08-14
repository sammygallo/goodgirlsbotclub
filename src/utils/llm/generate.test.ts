import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateMessage = vi.fn();
vi.mock('../../api/client', () => ({
  api: { generateMessage: (...a: unknown[]) => generateMessage(...a) },
}));
vi.mock('./resolve', () => ({
  getProviderAndModel: () => ({ provider: 'openai', model: 'gpt-x' }),
}));

const { generateOnce, generateOnceDetailed } = await import('./generate');

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
}

function terminal(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateOnceDetailed', () => {
  it('returns the text with an explicit stop', async () => {
    generateMessage.mockResolvedValue(sseStream([chunk('All done.'), terminal('stop')]));
    const res = await generateOnceDetailed([{ role: 'user', content: 'hi' }]);
    expect(res).toEqual({
      text: 'All done.',
      finishReason: 'stop',
      terminal: 'stop',
    });
  });

  it('reports a length cutoff rather than returning bare text', async () => {
    // The failure this exists to prevent: prose has no parser, so a
    // chapter cut mid-sentence at the output cap is indistinguishable
    // from a finished one by looking at the text.
    generateMessage.mockResolvedValue(
      sseStream([chunk('The door swung ope'), terminal('length')])
    );
    const res = await generateOnceDetailed([{ role: 'user', content: 'hi' }]);
    expect(res.terminal).toBe('length');
    expect(res.text).toBe('The door swung ope');
  });

  it('reports `absent` when the stream ends without saying why', async () => {
    generateMessage.mockResolvedValue(sseStream([chunk('half a sen')]));
    const res = await generateOnceDetailed([{ role: 'user', content: 'hi' }]);
    expect(res.terminal).toBe('absent');
    expect(res.finishReason).toBeNull();
  });

  it('keeps the raw reason alongside the classification', async () => {
    // So an unexpected value can be reported verbatim rather than
    // flattened into "other" with no way to say what happened.
    generateMessage.mockResolvedValue(
      sseStream([chunk('x'), terminal('content_filter')])
    );
    const res = await generateOnceDetailed([{ role: 'user', content: 'hi' }]);
    expect(res.terminal).toBe('other');
    expect(res.finishReason).toBe('content_filter');
  });

  it('throws when there is no stream at all', async () => {
    generateMessage.mockResolvedValue(null);
    await expect(generateOnceDetailed([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /No response/
    );
  });

  it('passes the custom endpoint only for the custom provider', async () => {
    generateMessage.mockResolvedValue(sseStream([chunk('a'), terminal('stop')]));
    await generateOnceDetailed([{ role: 'user', content: 'hi' }], {
      provider: 'openai',
      model: 'm',
      customUrl: 'https://elsewhere.example',
    });
    expect(generateMessage.mock.calls[0][5]).not.toHaveProperty('customUrl');

    generateMessage.mockResolvedValue(sseStream([chunk('a'), terminal('stop')]));
    await generateOnceDetailed([{ role: 'user', content: 'hi' }], {
      provider: 'custom',
      model: 'm',
      customUrl: 'https://elsewhere.example',
    });
    expect(generateMessage.mock.calls[1][5]).toMatchObject({
      customUrl: 'https://elsewhere.example',
    });
  });
});

describe('generateOnce', () => {
  it('still returns a bare string — every existing caller is unchanged', async () => {
    generateMessage.mockResolvedValue(sseStream([chunk('plain'), terminal('stop')]));
    expect(await generateOnce([{ role: 'user', content: 'hi' }])).toBe('plain');
  });

  it('does NOT throw on a truncation, as before', async () => {
    // Deliberate: the JSON passes tolerate a cut because their output has
    // to parse. Changing that here would turn a recoverable chunk into a
    // failed build for every ingestion pass.
    generateMessage.mockResolvedValue(sseStream([chunk('cut'), terminal('length')]));
    expect(await generateOnce([{ role: 'user', content: 'hi' }])).toBe('cut');
  });
});
