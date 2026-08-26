import { describe, it, expect, vi } from 'vitest';
import { dialogueExamplesFrom, mergeRenderingHints, runColdStart } from './coldStart';
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
              { id: 'e1', keys: ['magic'], content: 'Magic needs words.', constant: true, critical: false, category: '', enabled: true },
              { id: 'e2', keys: ['duke'], content: 'The duke is dead.', constant: false, critical: false, category: '', enabled: true },
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

  // E4-S0: activating document books put Data Bank chunks into this ingest's
  // book set for the first time. A big upload is hundreds of chunks and the
  // rule budget is 180KB, so without a ranking rule the chunks spend it all
  // and the character's authored lore is what lands in rulesDropped.
  it('never lets document chunks evict authored lore from the budget', async () => {
    const chunk = (i: number) => ({
      id: `c${i}`,
      keys: [],
      content: `chunk ${i} ${'x'.repeat(2000)}`,
      constant: false,
      critical: false,
      category: '',
      enabled: true,
      semanticOnly: true,
    });
    const out = await runColdStart(
      sources({
        lorebooks: [
          {
            // Document book FIRST, which is the order that used to decide it.
            bookId: 'doc',
            bookName: 'Uploaded reference',
            entries: Array.from({ length: 120 }, (_, i) => chunk(i)),
          },
          {
            bookId: 'authored',
            bookName: "Ivy's lorebook",
            // Full-length authored entries, deliberately: the budget loop
            // `continue`s past an entry it cannot afford rather than
            // breaking, so a one-line entry would slip into the leftover
            // headroom and the test would pass with or without the fix.
            entries: [
              { id: 'a1', keys: ['duke'], content: `The duke is dead. ${'y'.repeat(2000)}`, constant: false, critical: false, category: '', enabled: true },
              { id: 'a2', keys: ['reach'], content: `The Reach floods yearly. ${'y'.repeat(2000)}`, constant: false, critical: false, category: '', enabled: true },
            ],
          },
        ],
      })
    );
    const rules = out.world.rules ?? [];
    expect(rules.some((r) => r.text.includes('The duke is dead.'))).toBe(true);
    expect(rules.some((r) => r.text.includes('The Reach floods yearly.'))).toBe(true);
    // The budget did bind — this is a displacement test, not a "everything
    // fits" test.
    expect(out.rulesDropped).toBeGreaterThan(0);
  });

  it('skips empty entries', async () => {
    const out = await runColdStart(
      sources({
        lorebooks: [
          {
            bookId: 'b1',
            bookName: 'x',
            entries: [{ id: 'e1', keys: [], content: '   ', constant: true, critical: false, category: '', enabled: true }],
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

describe('id stability across reruns', () => {
  // The whole point: cold_start reruns on a "Rebuild the groundwork" and
  // (before the resume gate was fixed) on an interrupted walk. It then
  // FULL-REPLACES the entities section. With random ids, every rerun
  // renamed the character, leaving every scene already on the server
  // pointing at a participant that no longer existed anywhere in the
  // bible — a dangling ref nothing downstream could notice.
  it('re-derives identical ids for the same card, persona and lorebook', async () => {
    const input = sources({
      persona: { name: 'Sam', description: 'A tired archivist.' },
      lorebooks: [
        {
          bookId: 'book-1',
          entries: [
            { id: 'e1', content: 'The Reach floods at dusk.', constant: true },
            { id: 'e2', content: 'Ink is currency.', constant: false },
          ],
        },
      ],
    } as Partial<ColdStartSources>);

    const first = await runColdStart(input);
    const second = await runColdStart(input);

    expect(second.entities.characters.map((c) => c.id)).toEqual(
      first.entities.characters.map((c) => c.id)
    );
    expect(second.world.rules?.map((r) => r.id)).toEqual(
      first.world.rules?.map((r) => r.id)
    );
    // Sanity: the run actually produced the things we just compared.
    expect(first.entities.characters).toHaveLength(2);
    expect(first.world.rules?.length).toBeGreaterThan(0);
  });

  it('gives the character and the persona different ids', async () => {
    // Same string on both sides — the seed prefixes are what separate
    // them, and a collision here would merge the user into the character.
    const out = await runColdStart(
      sources({
        characterName: 'Ivy',
        characterAvatar: 'Ivy',
        persona: { name: 'Ivy', description: 'Also Ivy.' },
      } as Partial<ColdStartSources>)
    );
    const [character, persona] = out.entities.characters;
    expect(character.id).not.toBe(persona.id);
    expect(persona.is_user_persona).toBe(true);
  });

  it('keeps rule ids distinct when a lorebook repeats an entry id', async () => {
    const out = await runColdStart(
      sources({
        lorebooks: [
          {
            bookId: 'book-1',
            entries: [
              { id: 'dupe', content: 'First rule.', constant: true },
              { id: 'dupe', content: 'Second rule.', constant: true },
            ],
          },
        ],
      } as Partial<ColdStartSources>)
    );
    const ids = (out.world.rules ?? []).map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('renaming a lorebook entry does not remint its rule id', async () => {
    // Seeded on book+entry id, not on the text — otherwise editing an
    // entry orphans any fact that cited the rule it produced.
    const withText = (content: string) =>
      sources({
        lorebooks: [
          { bookId: 'book-1', entries: [{ id: 'e1', content, constant: true }] },
        ],
      } as Partial<ColdStartSources>);

    const before = await runColdStart(withText('The Reach floods at dusk.'));
    const after = await runColdStart(withText('The Reach floods at dawn.'));

    expect(after.world.rules?.[0].id).toBe(before.world.rules?.[0].id);
    expect(after.world.rules?.[0].text).not.toBe(before.world.rules?.[0].text);
  });
});

describe('mergeRenderingHints (step 3 §3.9b)', () => {
  const defaults = {
    novel: {
      pov: null,
      pov_character: null,
      tense: null,
      chapter_breaks: [],
      chapter_titles: [],
      compression_level: 'balanced' as const,
      target_word_count: null,
      style_anchors: [],
    },
    screenplay: {
      format: 'fountain' as const,
      sluglines_inferred: true,
      page_target: null,
    },
    graphic_novel: {
      pages_per_scene: 1,
      panel_density: 'standard' as const,
      art_style_brief: '',
      character_consistency_refs: [],
    },
    storyboard: { aspect_ratio: '16:9' as const, panels_per_scene: 4 },
  };

  it('returns the defaults when nothing is stored', () => {
    expect(mergeRenderingHints(defaults, null)).toEqual(defaults);
    expect(mergeRenderingHints(defaults, 'not an object')).toEqual(defaults);
    expect(mergeRenderingHints(defaults, [])).toEqual(defaults);
  });

  it('keeps every stored value and fills only what is absent', () => {
    const merged = mergeRenderingHints(defaults, {
      novel: { pov: 'first', style_anchors: ['spare'] },
    });
    expect(merged.novel.pov).toBe('first');
    expect(merged.novel.style_anchors).toEqual(['spare']);
    // Absent keys take the default rather than vanishing — the section is
    // `extra="forbid"` AND fully required on the backend.
    expect(merged.novel.compression_level).toBe('balanced');
    expect(merged.storyboard).toEqual(defaults.storyboard);
  });

  it('keeps falsy user choices — false, 0 and empty string are answers', () => {
    const merged = mergeRenderingHints(defaults, {
      screenplay: { sluglines_inferred: false, page_target: 0 },
      graphic_novel: { art_style_brief: '' },
      novel: { style_anchors: [] },
    });
    expect(merged.screenplay.sluglines_inferred).toBe(false);
    expect(merged.screenplay.page_target).toBe(0);
    expect(merged.graphic_novel.art_style_brief).toBe('');
    expect(merged.novel.style_anchors).toEqual([]);
  });

  it('treats an explicit null as absent', () => {
    const merged = mergeRenderingHints(defaults, { novel: { compression_level: null } });
    expect(merged.novel.compression_level).toBe('balanced');
  });

  it('drops unknown stored keys rather than echoing a 422 back', () => {
    const merged = mergeRenderingHints(defaults, {
      novel: { pov: 'first', from_an_older_build: 'x' },
      comic_script: { anything: 1 },
    }) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.novel.from_an_older_build).toBeUndefined();
    expect(merged.comic_script).toBeUndefined();
  });
});
