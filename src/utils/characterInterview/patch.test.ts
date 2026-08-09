import { describe, expect, it } from 'vitest';
import { applyPatch, normalizeLoreEntry, parseInterviewTurn } from './patch';
import { emptyDraft } from './types';
import type { FieldPatch, InterviewDraft } from './types';

describe('parseInterviewTurn', () => {
  it('parses a well-formed turn', () => {
    const raw = JSON.stringify({
      say: 'What kind of character do you have in mind?',
      patch: { name: 'Aria' },
      coverage: { concept: 'partial' },
      suggestions: ['A knight', 'A witch'],
      done: false,
    });
    const turn = parseInterviewTurn(raw);
    expect(turn).toEqual({
      say: 'What kind of character do you have in mind?',
      patch: { name: 'Aria' },
      coverage: { concept: 'partial' },
      suggestions: ['A knight', 'A witch'],
      done: false,
    });
  });

  it('tolerates prose wrapping the JSON object', () => {
    const raw = `Sure thing! Here you go:\n${JSON.stringify({ say: 'Tell me more.' })}\nHope that helps.`;
    const turn = parseInterviewTurn(raw);
    expect(turn?.say).toBe('Tell me more.');
  });

  it('returns null when no JSON object is present', () => {
    expect(parseInterviewTurn('just a plain sentence, no braces')).toBeNull();
  });

  it('returns null when say is missing', () => {
    expect(parseInterviewTurn(JSON.stringify({ patch: { name: 'Aria' } }))).toBeNull();
  });

  it('returns null when say is an empty or whitespace-only string', () => {
    expect(parseInterviewTurn(JSON.stringify({ say: '' }))).toBeNull();
    expect(parseInterviewTurn(JSON.stringify({ say: '   ' }))).toBeNull();
  });

  it('trims say', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: '  Hello there.  ' }));
    expect(turn?.say).toBe('Hello there.');
  });

  it('drops a non-object patch rather than throwing', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi', patch: 'not an object' }));
    expect(turn?.say).toBe('Hi');
    expect(turn?.patch).toBeUndefined();
  });

  it('drops a non-object coverage rather than throwing', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi', coverage: ['concept'] }));
    expect(turn?.coverage).toBeUndefined();
  });

  it('filters non-string entries out of suggestions', () => {
    const turn = parseInterviewTurn(
      JSON.stringify({ say: 'Hi', suggestions: ['A knight', 42, null, 'A witch'] })
    );
    expect(turn?.suggestions).toEqual(['A knight', 'A witch']);
  });

  it('omits suggestions entirely when nothing survives filtering', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi', suggestions: [1, 2, 3] }));
    expect(turn?.suggestions).toBeUndefined();
  });

  it('coerces a truthy non-boolean done to false', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi', done: 'true' }));
    expect(turn?.done).toBe(false);
  });

  it('coerces a missing done to false', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi' }));
    expect(turn?.done).toBe(false);
  });

  it('accepts a literal boolean true for done', () => {
    const turn = parseInterviewTurn(JSON.stringify({ say: 'Hi', done: true }));
    expect(turn?.done).toBe(true);
  });
});

describe('applyPatch', () => {
  it('returns the same draft reference (no-op) when patch is undefined', () => {
    const draft = emptyDraft();
    const result = applyPatch(draft, undefined);
    expect(result.draft).toBe(draft);
    expect(result.newLore).toEqual([]);
  });

  it('overwrites string fields with non-empty trimmed values', () => {
    const draft: InterviewDraft = { ...emptyDraft(), name: 'Old Name' };
    const result = applyPatch(draft, { name: 'New Name', description: 'A brave knight.' });
    expect(result.draft.name).toBe('New Name');
    expect(result.draft.description).toBe('A brave knight.');
    expect(result.draft).not.toBe(draft);
  });

  it('never blanks a field the patch omits', () => {
    const draft: InterviewDraft = { ...emptyDraft(), name: 'Aria', description: 'A knight.' };
    const result = applyPatch(draft, { personality: 'Brave.' });
    expect(result.draft.name).toBe('Aria');
    expect(result.draft.description).toBe('A knight.');
    expect(result.draft.personality).toBe('Brave.');
  });

  it('never blanks a field the patch sends as an empty string', () => {
    const draft: InterviewDraft = { ...emptyDraft(), name: 'Aria' };
    const result = applyPatch(draft, { name: '' });
    expect(result.draft.name).toBe('Aria');
  });

  it('never blanks a field the patch sends as a whitespace-only string', () => {
    const draft: InterviewDraft = { ...emptyDraft(), name: 'Aria' };
    const result = applyPatch(draft, { name: '   ' });
    expect(result.draft.name).toBe('Aria');
  });

  it('replaces (not merges) array fields when the patch provides a non-empty array', () => {
    const draft: InterviewDraft = { ...emptyDraft(), tags: ['old', 'tags'] };
    const result = applyPatch(draft, { tags: ['new', 'tags', 'only'] });
    expect(result.draft.tags).toEqual(['new', 'tags', 'only']);
  });

  it('leaves an array field untouched when the patch omits it', () => {
    const draft: InterviewDraft = { ...emptyDraft(), tags: ['keep', 'me'] };
    const result = applyPatch(draft, { name: 'Aria' });
    expect(result.draft.tags).toEqual(['keep', 'me']);
  });

  it('leaves an array field untouched when the patch sends an empty array', () => {
    const draft: InterviewDraft = { ...emptyDraft(), tags: ['keep', 'me'] };
    const result = applyPatch(draft, { tags: [] });
    expect(result.draft.tags).toEqual(['keep', 'me']);
  });

  it('ignores keys not on FieldPatch, defense in depth', () => {
    const draft = emptyDraft();
    const patch = { name: 'Aria', notAField: 'sneaky' } as FieldPatch;
    const result = applyPatch(draft, patch);
    expect(result.draft.name).toBe('Aria');
    expect((result.draft as unknown as Record<string, unknown>).notAField).toBeUndefined();
  });

  it('does not mutate the input draft', () => {
    const draft: InterviewDraft = { ...emptyDraft(), name: 'Old' };
    const snapshot = { ...draft };
    applyPatch(draft, { name: 'New' });
    expect(draft).toEqual(snapshot);
  });

  it('stages valid lore entries into newLore, never merged into the draft', () => {
    const draft = emptyDraft();
    const result = applyPatch(draft, {
      lore: [{ title: 'The Old Keep', keys: ['keep', 'castle'], content: 'A ruined keep on the hill.' }],
    });
    expect(result.newLore).toEqual([
      { title: 'The Old Keep', keys: ['keep', 'castle'], content: 'A ruined keep on the hill.' },
    ]);
    expect((result.draft as unknown as Record<string, unknown>).lore).toBeUndefined();
  });

  it('filters out malformed lore entries rather than throwing', () => {
    const draft = emptyDraft();
    const result = applyPatch(draft, {
      lore: [
        { keys: [], content: 'missing keys' },
        { keys: ['ok'], content: '' },
        { keys: ['ok'], content: '   ' },
        { content: 'missing keys entirely' } as unknown as { keys: string[]; content: string },
        { keys: ['ok'], content: 'A valid entry.' },
      ],
    });
    expect(result.newLore).toEqual([{ keys: ['ok'], content: 'A valid entry.' }]);
  });

  it('handles a missing lore array', () => {
    const draft = emptyDraft();
    const result = applyPatch(draft, { name: 'Aria' });
    expect(result.newLore).toEqual([]);
  });
});

describe('normalizeLoreEntry', () => {
  it('trims content and title', () => {
    const entry = normalizeLoreEntry({ title: '  The Keep  ', keys: ['keep'], content: '  A ruin.  ' });
    expect(entry).toEqual({ title: 'The Keep', keys: ['keep'], content: 'A ruin.' });
  });

  it('omits title when absent', () => {
    const entry = normalizeLoreEntry({ keys: ['keep'], content: 'A ruin.' });
    expect(entry).toEqual({ keys: ['keep'], content: 'A ruin.' });
  });

  it('rejects a non-object value', () => {
    expect(normalizeLoreEntry('nope')).toBeNull();
    expect(normalizeLoreEntry(null)).toBeNull();
  });

  it('rejects keys containing non-string entries', () => {
    expect(normalizeLoreEntry({ keys: ['ok', 42], content: 'text' })).toBeNull();
  });
});
