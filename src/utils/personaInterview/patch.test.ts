import { describe, expect, it } from 'vitest';
import { applyPatch, lenientSay, parseInterviewTurn } from './patch';
import { emptyDraft } from './types';

describe('parseInterviewTurn', () => {
  it('parses a well-formed turn', () => {
    const raw = JSON.stringify({
      say: 'What should I call you?',
      patch: { name: 'Mara' },
      coverage: { identity: 'partial' },
      suggestions: ['Mara', 'skip'],
      done: false,
    });
    const turn = parseInterviewTurn(raw);
    expect(turn).not.toBeNull();
    expect(turn?.say).toBe('What should I call you?');
    expect(turn?.patch).toEqual({ name: 'Mara' });
    expect(turn?.coverage).toEqual({ identity: 'partial' });
    expect(turn?.suggestions).toEqual(['Mara', 'skip']);
    expect(turn?.done).toBe(false);
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const raw = 'Sure! {"say":"Who are you?","done":false} hope that helps';
    expect(parseInterviewTurn(raw)?.say).toBe('Who are you?');
  });

  it('returns null when there is no usable say', () => {
    expect(parseInterviewTurn('{"patch":{"name":"X"}}')).toBeNull();
    expect(parseInterviewTurn('{"say":""}')).toBeNull();
    expect(parseInterviewTurn('not json at all')).toBeNull();
  });

  it('drops non-string suggestions and a non-object patch', () => {
    const raw = JSON.stringify({ say: 'Hi', patch: 'nope', suggestions: ['a', 3, 'b'] });
    const turn = parseInterviewTurn(raw);
    expect(turn?.patch).toBeUndefined();
    expect(turn?.suggestions).toEqual(['a', 'b']);
  });
});

describe('applyPatch', () => {
  it('applies only allowlisted, non-empty fields', () => {
    const draft = emptyDraft();
    const next = applyPatch(draft, {
      name: 'Mara',
      description: 'a wry field medic',
      // @ts-expect-error — extra keys are ignored by the allowlist
      personality: 'should be ignored',
    });
    expect(next).toEqual({ name: 'Mara', description: 'a wry field medic' });
  });

  it('ignores blank/whitespace values and returns the same ref on a no-op', () => {
    const draft = { name: 'Mara', description: 'x' };
    expect(applyPatch(draft, { name: '   ' })).toBe(draft);
    expect(applyPatch(draft, undefined)).toBe(draft);
    expect(applyPatch(draft, { name: 'Mara' })).toBe(draft); // identical value → no change
  });

  it('does not mutate the input draft', () => {
    const draft = emptyDraft();
    const next = applyPatch(draft, { name: 'Mara' });
    expect(draft.name).toBe('');
    expect(next).not.toBe(draft);
  });
});

describe('lenientSay', () => {
  it('recovers say from JSON truncated mid-patch', () => {
    const raw = '{"say":"Nice to meet you!","patch":{"name":"Ma';
    expect(lenientSay(raw)).toBe('Nice to meet you!');
  });

  it('decodes escaped characters', () => {
    const raw = '{"say":"Line one\\nLine \\"two\\""}';
    expect(lenientSay(raw)).toBe('Line one\nLine "two"');
  });

  it('returns null when there is no say field', () => {
    expect(lenientSay('{"patch":{"name":"X"}}')).toBeNull();
  });
});
