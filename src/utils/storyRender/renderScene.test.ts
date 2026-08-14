import { describe, it, expect, vi } from 'vitest';
import { checkContinuity, readFindings, renderSceneProse } from './renderScene';
import { PROSE_SYSTEM } from './prompts';
import type { RenderBrief } from './types';
import type { BibleFact } from '../../types/storyBible';
import type { GenerationResult } from '../llm/generate';

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2' as const, send_date: 0 },
});

function brief(over: Partial<RenderBrief> = {}): RenderBrief {
  return {
    scene: {
      id: 'sc1',
      sequence: 0,
      title: 'Arrival',
      summary: 'They arrive.',
      detailed_summary: 'They arrive at the Reach after dark.',
      setting: { location_ref: null, time_ref: null, atmosphere: 'cold' },
      participants: [],
      pov_character: null,
      function: null,
      source: {
        message_range: { start: MREF('m0'), end: MREF('m3') },
        total_messages: 4,
        swipe_resolutions: [],
        excluded_segments: [],
      },
      continuity_facts_established: [],
      transformations: null,
      annotations: {
        user_notes: '',
        author_intent: '',
        flagged_issues: [],
        stale_source: false,
      },
    },
    position: 1,
    totalScenes: 2,
    precedingSummary: '',
    participants: [],
    userVoice: null,
    facts: { own: [], sceneAttributed: [], unattributed: [] },
    rules: [],
    hints: {
      pov: null,
      povCharacterId: null,
      tense: null,
      compressionLevel: 'balanced',
      targetWordCount: null,
      styleAnchors: [],
    },
    caveats: { approximate: false, constantsOnly: false, unresolvedRules: 0 },
    drops: [],
    rulesNotActive: 0,
    estimatedTokens: 100,
    ...over,
  };
}

function reply(text: string, terminal: GenerationResult['terminal'] = 'stop'): GenerationResult {
  return { text, terminal, finishReason: terminal === 'absent' ? null : terminal };
}

const FACTS: BibleFact[] = [
  { id: 'fact-a', text: 'Ivy carries an iron key.', category: 'reveal', confidence: 'explicit' },
  { id: 'fact-b', text: 'The Reach floods at dusk.', category: 'world_rule', confidence: 'explicit' },
];

describe('renderSceneProse', () => {
  it('returns the prose with the stream’s terminal signal', async () => {
    const llm = vi.fn(async () => reply('  The door gave way.  '));
    const out = await renderSceneProse({ brief: brief(), llm });
    expect(out.prose).toBe('The door gave way.');
    expect(out.terminal).toBe('stop');
    expect(out.llmCalls).toBe(1);
  });

  it('surfaces a length cutoff rather than hiding it in the text', async () => {
    const llm = vi.fn(async () => reply('The door gave w', 'length'));
    const out = await renderSceneProse({ brief: brief(), llm });
    expect(out.terminal).toBe('length');
    expect(out.finishReason).toBe('length');
  });

  it('surfaces an absent terminal signal', async () => {
    // A severed stream. Indistinguishable from a finished one by the text
    // alone, which is why the signal is carried rather than inferred.
    const llm = vi.fn(async () => reply('half a sen', 'absent'));
    const out = await renderSceneProse({ brief: brief(), llm });
    expect(out.terminal).toBe('absent');
  });

  it('does NOT retry — one prose call, always', async () => {
    // A prose response cannot fail to parse; whatever comes back IS the
    // answer. A retry would re-bill the user for a second opinion they
    // did not ask for. Truncation is reported, and per-scene re-render is
    // the user's own cheap remedy.
    const llm = vi.fn(async () => reply('cut off', 'length'));
    await renderSceneProse({ brief: brief(), llm });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('sends the prose system prompt', async () => {
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return reply('x');
    });
    await renderSceneProse({ brief: brief(), llm });
    expect(llm.mock.calls[0][0][0].content).toBe(PROSE_SYSTEM);
  });
});

describe('readFindings', () => {
  const idByLabel = new Map([
    ['f1', 'fact-a'],
    ['f2', 'fact-b'],
  ]);

  it('distinguishes "read it, found nothing" from "could not read it"', () => {
    // Collapsing the two would report an unchecked scene as clean.
    expect(readFindings({ findings: [] }, idByLabel)).toEqual([]);
    expect(readFindings(null, idByLabel)).toBeNull();
    expect(readFindings({ nope: 1 }, idByLabel)).toBeNull();
  });

  it('maps labels back to real fact ids', () => {
    const out = readFindings(
      { findings: [{ fact: 'f2', claim: 'dry at dusk', canon: 'it floods', severity: 'major' }] },
      idByLabel
    )!;
    expect(out[0].factId).toBe('fact-b');
    expect(out[0].severity).toBe('major');
  });

  it('resolves an unrecognized label to null, never to a positional guess', () => {
    const out = readFindings(
      { findings: [{ fact: 'f99', claim: 'a', canon: 'b', severity: 'major' }] },
      idByLabel
    )!;
    expect(out[0].factId).toBeNull();
  });

  it('defaults an unknown severity to minor rather than major', () => {
    const out = readFindings(
      { findings: [{ fact: 'f1', claim: 'a', canon: 'b', severity: 'catastrophic' }] },
      idByLabel
    )!;
    expect(out[0].severity).toBe('minor');
  });

  it('drops a finding that says nothing at all', () => {
    const out = readFindings(
      { findings: [{ fact: 'f1', severity: 'major' }, { claim: 'real', canon: '' }] },
      idByLabel
    )!;
    expect(out).toHaveLength(1);
    expect(out[0].claim).toBe('real');
  });
});

describe('checkContinuity', () => {
  it('makes no call when there is nothing to check', async () => {
    const llm = vi.fn(async () => reply('{}'));
    expect((await checkContinuity({ prose: '', facts: FACTS, llm })).llmCalls).toBe(0);
    expect((await checkContinuity({ prose: 'x', facts: [], llm })).llmCalls).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns verdicts against the real fact ids', async () => {
    const llm = vi.fn(async () =>
      reply(
        JSON.stringify({
          findings: [
            { fact: 'f1', claim: 'she has no key', canon: 'Ivy carries an iron key', severity: 'major' },
          ],
        })
      )
    );
    const out = await checkContinuity({ prose: 'She had no key.', facts: FACTS, llm });
    expect(out.unreadable).toBe(false);
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0].factId).toBe('fact-a');
  });

  it('labels facts rather than sending UUIDs', async () => {
    // Models mangle UUIDs, and a mangled id that happens to resolve is
    // worse than one that obviously does not.
    // Typed params so `mock.calls` carries the prompt rather than an
    // empty tuple — `tsc -b` is stricter here than `tsc --noEmit`.
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return reply(JSON.stringify({ findings: [] }));
    });
    await checkContinuity({ prose: 'x', facts: FACTS, llm });
    const prompt = llm.mock.calls[0][0][1].content;
    expect(prompt).toContain('f1: Ivy carries an iron key.');
    expect(prompt).not.toContain('fact-a');
  });

  it('retries once with a repair instruction, then reports unreadable', async () => {
    const llm = vi.fn(async () => reply('I think it is mostly fine, honestly.'));
    const out = await checkContinuity({ prose: 'x', facts: FACTS, llm });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(out.unreadable).toBe(true);
    // Not "clean" — those are different claims.
    expect(out.verdicts).toEqual([]);
  });

  it('recovers on the repair retry', async () => {
    let call = 0;
    const llm = vi.fn(async () =>
      ++call === 1 ? reply('no json') : reply(JSON.stringify({ findings: [] }))
    );
    const out = await checkContinuity({ prose: 'x', facts: FACTS, llm });
    expect(out.unreadable).toBe(false);
    expect(out.verdicts).toEqual([]);
  });
});

describe('readFindings survives a weak model’s shape mistakes', () => {
  const idByLabel = new Map([['f1', 'fact-a']]);

  it('skips a null element instead of throwing', () => {
    // `(null as Record).claim` throws, aborting a continuity check the
    // user has already paid for, over one malformed array element.
    const out = readFindings(
      { findings: [null, { fact: 'f1', claim: 'a', canon: 'b', severity: 'major' }] },
      idByLabel
    );
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out![0].factId).toBe('fact-a');
  });

  it('skips primitives and arrays inside findings', () => {
    const out = readFindings(
      { findings: ['oops', 42, ['nested'], { claim: 'real', canon: 'x' }] },
      idByLabel
    );
    expect(out).toHaveLength(1);
    expect(out![0].claim).toBe('real');
  });
});
