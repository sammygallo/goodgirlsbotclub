import { describe, it, expect, vi } from 'vitest';
import { dialogueExamplesFrom, runColdStart } from './coldStart';
import { firstJsonObject, extractJsonObjects } from './prompts';
import type { ColdStartSources } from './types';

function sources(over: Partial<ColdStartSources> = {}): ColdStartSources {
  return {
    characterName: 'Ivy',
    characterAvatar: 'Ivy.png',
    description: 'A wry archivist with ink-stained hands.',
    personality: 'Dry, watchful, slow to trust.',
    scenario: 'The drowned archive beneath the Reach.',
    mesExample: '',
    firstMessage: 'You again.',
    persona: null,
    lorebooks: [],
    ...over,
  };
}

describe('mechanical mapping (no model)', () => {
  it('maps card fields to the bible without calling a model', async () => {
    const out = await runColdStart(sources());
    expect(out.llmCalls).toBe(0);

    const char = out.entities.characters[0];
    expect(char.canonical_name).toBe('Ivy');
    expect(char.is_user_persona).toBe(false);
    expect(char.physical_description?.summary).toContain('archivist');
    expect(out.world.setting_summary).toContain('drowned archive');
  });

  it('carries provenance back to the exact card field', async () => {
    const out = await runColdStart(sources());
    const char = out.entities.characters[0];
    const refs = char.provenance ?? [];
    const fields = refs
      .filter((r) => r.kind === 'card_field')
      .map((r) => (r as { ref: { field: string } }).ref.field);
    expect(fields).toContain('description');
    expect(fields).toContain('personality');
    // The character itself points at the card that produced it.
    expect(char.source?.kind).toBe('character');
  });

  it('adds the persona as a user_persona character', async () => {
    const out = await runColdStart(
      sources({ persona: { name: 'Sammy', description: 'A tired dev.' } })
    );
    const persona = out.entities.characters.find((c) => c.is_user_persona);
    expect(persona?.canonical_name).toBe('Sammy');
    expect(persona?.role).toBe('user_persona');
    // Personas have no backend identity, so the snapshot must carry it.
    expect(persona?.source?.kind).toBe('persona');
  });

  it('falls back to the avatar when the card has no name', async () => {
    const out = await runColdStart(
      sources({ characterName: '', characterAvatar: 'Ivy.png' })
    );
    expect(out.entities.characters[0].canonical_name).toBe('Ivy.png');
  });
});

describe('lorebook entries become world rules', () => {
  it('trusts constant entries and doubts selective ones', async () => {
    const out = await runColdStart(
      sources({
        lorebooks: [
          {
            bookId: 'b1',
            bookName: 'Reach lore',
            entries: [
              { id: 'e1', keys: ['magic'], content: 'Magic needs words.', constant: true, enabled: true },
              { id: 'e2', keys: ['duke'], content: 'The duke is dead.', constant: false, enabled: true },
            ],
          },
        ],
      })
    );
    const rules = out.world.rules ?? [];
    expect(rules).toHaveLength(2);
    // A constant entry was in every prompt, so the story was demonstrably
    // played under it; a selective one may never have fired.
    expect(rules.find((r) => r.text.includes('Magic'))?.confidence).toBe('explicit');
    expect(rules.find((r) => r.text.includes('duke'))?.confidence).toBe('inferred');
    expect(rules[0].source.kind).toBe('lorebook_entry');
  });

  it('skips empty entries', async () => {
    const out = await runColdStart(
      sources({
        lorebooks: [
          {
            bookId: 'b1',
            bookName: 'x',
            entries: [{ id: 'e1', keys: [], content: '   ', constant: true, enabled: true }],
          },
        ],
      })
    );
    expect(out.world.rules).toHaveLength(0);
  });
});

describe('dialogueExamplesFrom', () => {
  it("keeps the character's lines and drops the user's", () => {
    const out = dialogueExamplesFrom(
      `<START>\n{{user}}: Hello?\n{{char}}: You again.\n{{user}}: Miss me?\n{{char}}: Never.`,
      'Ivy'
    );
    expect(out).toEqual(['You again.', 'Never.']);
  });

  it('handles named speakers and ignores other characters', () => {
    const out = dialogueExamplesFrom(`Ivy: Mine.\nNyx: Not yours.`, 'Ivy');
    expect(out).toEqual(['Mine.']);
  });

  it('returns nothing for empty input', () => {
    expect(dialogueExamplesFrom('', 'Ivy')).toEqual([]);
  });
});

describe('model-assisted fields', () => {
  it('fills structured attributes and stamps an inference ref', async () => {
    const llm = vi.fn(async (msgs: { content: string }[]) =>
      msgs[0].content.includes('attributes')
        ? '{"age_apparent":"30s","hair":{"color":"black","length":"short","style":"cropped"},"eyes":{"color":"grey","shape":""},"skin":"","build":"lean","height":"","distinguishing_features":["ink stains"],"typical_attire":"archivist robes","gender_presentation":"femme"}'
        : '{"register":"casual","speech_patterns":"Short, clipped.","verbal_tics":["trails off"],"favored_words":[],"avoided_words":[]}'
    );

    const out = await runColdStart(sources(), llm);

    expect(out.llmCalls).toBe(2);
    const char = out.entities.characters[0];
    expect(char.physical_description?.attributes.hair.color).toBe('black');
    expect(char.physical_description?.attributes.distinguishing_features).toEqual([
      'ink stains',
    ]);
    expect(char.personality?.voice_profile?.register).toBe('casual');
    expect(char.personality?.voice_profile?.speech_patterns).toBe('Short, clipped.');
    const inferred = (char.provenance ?? []).filter(
      (r) => r.kind === 'agent_inference'
    );
    expect(inferred).toHaveLength(2);
  });

  it('survives a failing model with the mechanical bible intact', async () => {
    const llm = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const out = await runColdStart(sources(), llm);
    // A starter bible missing eye colour beats no bible at all.
    expect(out.entities.characters[0].canonical_name).toBe('Ivy');
    expect(out.world.setting_summary).toContain('drowned archive');
  });

  it('survives garbage output without inventing fields', async () => {
    const llm = vi.fn(async () => 'Sure! Here you go: not actually json');
    const out = await runColdStart(sources(), llm);
    expect(out.entities.characters[0].physical_description?.attributes.hair.color).toBe('');
  });

  it('rejects an out-of-vocabulary register rather than storing it', async () => {
    const llm = vi.fn(async (msgs: { content: string }[]) =>
      msgs[0].content.includes('SPEAKS')
        ? '{"register":"sultry","speech_patterns":"x"}'
        : '{}'
    );
    const out = await runColdStart(sources(), llm);
    expect(out.entities.characters[0].personality?.voice_profile?.register).toBe(
      'mixed'
    );
  });

  it('propagates an abort instead of swallowing it', async () => {
    const llm = vi.fn(async () => {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(runColdStart(sources(), llm)).rejects.toThrow('Aborted');
  });
});

describe('JSON recovery', () => {
  it('recovers an object from prose-wrapped output', () => {
    expect(firstJsonObject('Here: {"a": 1} — hope that helps')).toEqual({ a: 1 });
  });

  it('ignores a truncated trailing object', () => {
    const objs = extractJsonObjects('{"a":1} {"b":');
    expect(objs).toEqual(['{"a":1}']);
  });

  it('is not fooled by braces inside strings', () => {
    expect(firstJsonObject('{"a":"} not the end {"}')).toEqual({
      a: '} not the end {',
    });
  });

  it('returns null when there is no object at all', () => {
    expect(firstJsonObject('nope')).toBeNull();
  });
});
