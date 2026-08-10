// Reconcile judge unit suite (story-state phase 8, plan §9 "Unit").
//
// Pure module, zero network: every case here uses a fake LlmCall
// (vi.fn returning canned strings) or calls the parsing/merge helpers
// directly. No fake backend — that's the store-level suite's job.
//
// The single most load-bearing property tested here is id determinism
// (see "id determinism" below): Phase 7 shipped a bug where a scene/fact
// id was seeded from response POSITION rather than content, and a
// differently-shaped retry silently orphaned everything downstream. This
// file exists to make sure reconcile's contradiction/card-fact ids never
// repeat that mistake.

import { describe, it, expect, vi } from 'vitest';
import {
  CONTINUITY_BYTE_BUDGET,
  DESCRIPTION_CLAMP,
  FACT_TEXT_CLAMP,
  MAX_CONTRADICTIONS,
  MAX_GROUPS_PER_BATCH,
  buildCardCheckTargets,
  buildCardContradiction,
  buildCardFact,
  buildContradiction,
  cardFactId,
  contradictionId,
  continuityUnchanged,
  mergeContinuity,
  packGroups,
  parseJudgeResponse,
  readCardCharacters,
  readContinuitySection,
  renderBatch,
  runCardChecks,
  runGroupJudge,
  type DetectedCardConflict,
  type JudgeBatch,
  type PackedGroups,
} from './reconcileJudge';
import { WORLD_ENTITY, type FactGroup } from './reconcile';
import type { KnownCastMember } from './transcriptWalk';
import type { LlmCall } from './types';
import { deterministicUuid } from '../storyBible/sourceRefs';
import type { BibleFact, Contradiction } from '../../types/storyBible';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fact(id: string, text: string, over: Partial<BibleFact> = {}): BibleFact {
  return { id, text, category: 'reveal', confidence: 'explicit', ...over };
}

function fillerGroup(n: number): FactGroup {
  // Deliberately tiny (short text, generic entity) — exists only to push
  // a batch past the group-count cap without also tripping the token
  // budget, so the count-cap and budget-cap tests each isolate ONE
  // dimension of the packer.
  return {
    entity: `filler-${n}`,
    category: 'reveal',
    facts: [fact(`filler-${n}-a`, `Filler ${n} alpha.`), fact(`filler-${n}-b`, `Filler ${n} beta.`)],
  };
}

/** A group whose facts are clamped-length text, sized so N of them sit
 *  comfortably under BATCH_TOKEN_BUDGET but two of them together don't —
 *  used to force a token-budget split with only two groups (no reliance
 *  on the 12-group count cap, which is tested separately). */
function heavyGroup(entity: string, factCount: number): FactGroup {
  const longText = 'x'.repeat(FACT_TEXT_CLAMP + 50); // clamped down to FACT_TEXT_CLAMP anyway
  return {
    entity,
    category: 'reveal',
    facts: Array.from({ length: factCount }, (_, i) => fact(`${entity}-f${i}`, longText)),
  };
}

function fakeLlmSequence(responses: string[]): LlmCall {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  });
}

/** Map-bearing structures compare awkwardly with plain toEqual across two
 *  independently-built objects (chai's deep-eql handles Map, but a
 *  sorted-array projection makes a failing diff readable, which matters
 *  for the determinism tests where the whole point is "these must match
 *  exactly"). */
function serializeBatch(b: JudgeBatch) {
  return {
    groups: b.groups,
    labels: Array.from(b.labels.entries()).sort(),
    groupsByFact: Array.from(b.groupsByFact.entries()).sort(),
  };
}
function serializePacked(p: PackedGroups) {
  return { windowedGroups: p.windowedGroups, batches: p.batches.map(serializeBatch) };
}

function unresolvedResolution(): Contradiction['resolution'] {
  return { status: 'unresolved', canonical_choice: null, rationale: '', resolved_at: null };
}

function contradiction(over: Partial<Contradiction> = {}): Contradiction {
  const sources = over.sources ?? ['fact-a', 'fact-b'];
  return {
    id: over.id ?? contradictionId(sources),
    type: over.type ?? 'character_attribute',
    description: over.description ?? 'A conflict.',
    sources,
    detected_by: over.detected_by ?? 'agent',
    resolution: over.resolution ?? unresolvedResolution(),
  };
}

const CAST: KnownCastMember[] = [{ id: 'char-ivy', name: 'Ivy', aliases: [] }];

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

describe('packGroups', () => {
  it('is deterministic across two runs over identical input', () => {
    const groups: FactGroup[] = [
      { entity: 'e1', category: 'reveal', facts: [fact('a1', 'A.'), fact('a2', 'B.')] },
      { entity: WORLD_ENTITY, category: 'world_rule', facts: [fact('w1', 'Magic needs blood.'), fact('w2', 'Magic is free.')] },
      { entity: 'e2', category: 'change', facts: [fact('c1', 'X changed.'), fact('c2', 'X changed back.')] },
    ];
    const p1 = packGroups(groups, CAST);
    const p2 = packGroups(groups, CAST);
    expect(serializePacked(p1)).toEqual(serializePacked(p2));
  });

  it('caps groups per batch at MAX_GROUPS_PER_BATCH, independent of token budget', () => {
    // 13 tiny groups: each costs a handful of tokens, so 13 of them
    // together are nowhere near BATCH_TOKEN_BUDGET — the split has to be
    // the COUNT cap firing, not the budget.
    const groups = Array.from({ length: 13 }, (_, i) => fillerGroup(i));
    const packed = packGroups(groups, []);
    expect(packed.batches).toHaveLength(2);
    expect(packed.batches[0].groups).toHaveLength(MAX_GROUPS_PER_BATCH);
    expect(packed.batches[1].groups).toHaveLength(1);
  });

  it('splits into a new batch when the token budget is exceeded, even under the group-count cap', () => {
    // Two groups, well under the 12-group cap, but each alone is sized so
    // that TWO of them together would blow BATCH_TOKEN_BUDGET. Isolates
    // the budget dimension from the count dimension.
    const g1 = heavyGroup('heavy-1', 28);
    const g2 = heavyGroup('heavy-2', 28);
    const packed = packGroups([g1, g2], []);
    expect(packed.batches).toHaveLength(2);
    expect(packed.batches[0].groups).toHaveLength(1);
    expect(packed.batches[1].groups).toHaveLength(1);
    // Nothing lost across the split.
    expect(packed.batches[0].labels.size + packed.batches[1].labels.size).toBe(56);
  });

  it('windows an oversized group deterministically and reports the split count', () => {
    const bigGroup: FactGroup = {
      entity: 'e-big',
      category: 'reveal',
      facts: Array.from({ length: 85 }, (_, i) => fact(`big-${i}`, `Fact number ${i}.`)),
    };
    const p1 = packGroups([bigGroup], []);
    const p2 = packGroups([bigGroup], []);
    expect(p1.windowedGroups).toBe(1);
    expect(serializePacked(p1)).toEqual(serializePacked(p2));
    // All 85 facts still show up somewhere, just spread across windows.
    const allIds = new Set(p1.batches.flatMap((b) => Array.from(b.labels.values())));
    expect(allIds.size).toBe(85);
  });

  it('folds a single-fact trailing window back into its predecessor instead of shipping a call that can only return empty', () => {
    // 41 facts split naively into [40, 1]; a lone trailing fact cannot
    // contradict anything, so windowGroup merges it back rather than
    // paying for a call that can only ever say "no conflicts". The
    // resulting single window (41 facts) is NOT counted as "windowed" —
    // nothing was actually lost across a window boundary.
    const group: FactGroup = {
      entity: 'e-41',
      category: 'reveal',
      facts: Array.from({ length: 41 }, (_, i) => fact(`f41-${i}`, `Fact ${i}.`)),
    };
    const packed = packGroups([group], []);
    expect(packed.windowedGroups).toBe(0);
    const allIds = new Set(packed.batches.flatMap((b) => Array.from(b.labels.values())));
    expect(allIds.size).toBe(41);
  });

  it('gives a fact appearing in two groups of the same batch exactly ONE label', () => {
    // Mirrors how groupFacts puts a relationship fact in both parties'
    // groups — two labels for one fact id would let a model "contradict"
    // a fact with itself and cheat the >= 2-distinct-ids rule.
    const shared = fact('shared-1', 'Ivy resents Sam.');
    const groupIvy: FactGroup = { entity: 'char-ivy', category: 'reveal', facts: [shared, fact('ivy-2', 'Ivy has green eyes.')] };
    const groupSam: FactGroup = { entity: 'char-sam', category: 'reveal', facts: [shared, fact('sam-2', 'Sam is tall.')] };
    const packed = packGroups([groupIvy, groupSam], []);
    expect(packed.batches).toHaveLength(1);
    const batch = packed.batches[0];

    expect(batch.labels.size).toBe(3); // shared + ivy-2 + sam-2, not 4
    const labelInGroup0 = batch.groups[0].facts.find((f) => f.id === 'shared-1')!.label;
    const labelInGroup1 = batch.groups[1].facts.find((f) => f.id === 'shared-1')!.label;
    expect(labelInGroup0).toBe(labelInGroup1);
    expect(batch.groupsByFact.get('shared-1')).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Prompts (rendering)
// ---------------------------------------------------------------------------

describe('renderBatch', () => {
  it('never leaks a fact UUID into the rendered user message — only f-labels', () => {
    const group: FactGroup = {
      entity: 'char-ivy',
      category: 'reveal',
      facts: [
        fact(deterministicUuid('walk:fact:1'), 'Ivy has green eyes.'),
        fact(deterministicUuid('walk:fact:2'), 'Ivy has grey eyes.'),
      ],
    };
    const batch = packGroups([group], CAST).batches[0];
    const rendered = renderBatch(batch);
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(rendered).not.toMatch(uuidPattern);
    expect(rendered).toContain('f1:');
    expect(rendered).toContain('f2:');
  });

  it('labels the WORLD_ENTITY bucket "(world / unattributed)" so the model knows subjects may differ', () => {
    const group: FactGroup = {
      entity: WORLD_ENTITY,
      category: 'world_rule',
      facts: [fact('w1', 'Magic needs a blood price.'), fact('w2', 'Magic is free to cast.')],
    };
    const batch = packGroups([group], CAST).batches[0];
    expect(renderBatch(batch)).toContain('subject: (world / unattributed)');
  });

  it('carries a confidence marker on every fact line', () => {
    const group: FactGroup = {
      entity: 'char-ivy',
      category: 'reveal',
      facts: [
        fact('f1', 'Ivy said it plainly.', { confidence: 'explicit' }),
        fact('f2', 'Ivy implied it.', { confidence: 'inferred' }),
        fact('f3', 'Two witnesses disagree.', { confidence: 'contested' }),
      ],
    };
    const rendered = renderBatch(packGroups([group], CAST).batches[0]);
    expect(rendered).toContain('[explicit]');
    expect(rendered).toContain('[inferred]');
    expect(rendered).toContain('[contested]');
  });
});

// ---------------------------------------------------------------------------
// Parsing fixtures + repair round (through runGroupJudge)
// ---------------------------------------------------------------------------

describe('runGroupJudge — parsing fixtures and repair', () => {
  function simpleGroup(): FactGroup {
    return {
      entity: 'char-ivy',
      category: 'reveal',
      facts: [fact('id-a', 'Ivy has green eyes.'), fact('id-b', 'Ivy has grey eyes.')],
    };
  }
  const CLEAN_JSON = JSON.stringify({
    contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: 'Eye color conflict.' }],
  });

  it('reads a clean fixture on the first call, no repair spent', async () => {
    const llm = fakeLlmSequence([CLEAN_JSON]);
    const outcome = await runGroupJudge({ groups: [simpleGroup()], cast: CAST, llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(outcome.llmCalls).toBe(1);
    expect(outcome.unreadableBatches).toBe(0);
    expect(outcome.detected).toHaveLength(1);
  });

  it('reads a prose-wrapped / code-fenced fixture without needing repair', async () => {
    const wrapped = `Sure, here you go:\n\n\`\`\`json\n${CLEAN_JSON}\n\`\`\`\n\nLet me know if that helps!`;
    const llm = fakeLlmSequence([wrapped]);
    const outcome = await runGroupJudge({ groups: [simpleGroup()], cast: CAST, llm });
    expect(outcome.llmCalls).toBe(1);
    expect(outcome.detected).toHaveLength(1);
  });

  it('spends the one repair round on a truncated fixture and succeeds', async () => {
    const truncated = '{"contradictions":[{"facts":["f1","f2"],"type":"character_attribute","description":"unfinishe';
    const llm = fakeLlmSequence([truncated, CLEAN_JSON]);
    const outcome = await runGroupJudge({ groups: [simpleGroup()], cast: CAST, llm });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(outcome.llmCalls).toBe(2);
    expect(outcome.unreadableBatches).toBe(0);
    expect(outcome.detected).toHaveLength(1);
  });

  it('when repair also fails, counts the batch unreadable and STILL judges later batches', async () => {
    // Force two batches (12-group count cap): groupA + 11 fillers fill
    // batch 1, groupB alone lands in batch 2.
    const groupA: FactGroup = { entity: 'g-a', category: 'reveal', facts: [fact('a1', 'Ivy is a baker.'), fact('a2', 'Ivy is a duchess.')] };
    const groupB: FactGroup = { entity: 'g-b', category: 'reveal', facts: [fact('b1', 'Sam is alive.'), fact('b2', 'Sam is dead.')] };
    const groups = [groupA, ...Array.from({ length: 11 }, (_, i) => fillerGroup(i)), groupB];

    const validForBatch2 = JSON.stringify({
      contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: "Sam's fate is inconsistent." }],
    });
    const llm = fakeLlmSequence(['garbage', 'still garbage', validForBatch2]);
    const outcome = await runGroupJudge({ groups, cast: [], llm });

    expect(outcome.batches).toBe(2);
    expect(outcome.unreadableBatches).toBe(1); // batch 1 never recovered
    expect(outcome.llmCalls).toBe(3); // 2 wasted on batch 1, 1 for batch 2
    expect(outcome.detected).toHaveLength(1); // batch 2 still contributed
    expect(outcome.detected[0].sources).toEqual(['b1', 'b2'].sort());
  });

  it('a weak model that never emits JSON completes the run with zero detections, not an error', async () => {
    const llm = fakeLlmSequence(['not json', 'still not json']);
    const outcome = await runGroupJudge({ groups: [simpleGroup()], cast: CAST, llm });
    expect(outcome.unreadableBatches).toBe(1);
    expect(outcome.detected).toEqual([]);
  });
});

describe('AbortError and transport errors propagate rather than being swallowed', () => {
  const group: FactGroup = {
    entity: 'char-ivy',
    category: 'reveal',
    facts: [fact('id-a', 'Ivy has green eyes.'), fact('id-b', 'Ivy has grey eyes.')],
  };

  it('runGroupJudge rethrows an AbortError', async () => {
    const llm: LlmCall = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(runGroupJudge({ groups: [group], cast: CAST, llm })).rejects.toThrow(/aborted/);
  });

  it('runGroupJudge rethrows a plain transport error (not classified as unreadable)', async () => {
    const llm: LlmCall = vi.fn(async () => {
      throw new Error('network blip');
    });
    await expect(runGroupJudge({ groups: [group], cast: CAST, llm })).rejects.toThrow('network blip');
  });

  it('runCardChecks rethrows an AbortError from the card-vs-transcript call', async () => {
    const target = {
      character: { id: 'char-ivy', name: 'Ivy', avatar: 'ivy.png', cardText: 'A wry archivist.' },
      facts: [fact('id-a', 'Ivy has green eyes.')],
      omittedFacts: 0,
    };
    const llm: LlmCall = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(runCardChecks({ targets: [target], llm })).rejects.toThrow(/aborted/);
  });
});

// ---------------------------------------------------------------------------
// Tolerance (parseJudgeResponse, direct)
// ---------------------------------------------------------------------------

describe('parseJudgeResponse — tolerance', () => {
  function batchOf(groups: FactGroup[]): JudgeBatch {
    return packGroups(groups, []).batches[0];
  }

  it('drops an unknown label but keeps the entry if enough real ones remain', () => {
    const group: FactGroup = { entity: 'e1', category: 'reveal', facts: [fact('id1', 'A.'), fact('id2', 'B.'), fact('id3', 'C.')] };
    const batch = batchOf([group]); // f1=id1, f2=id2, f3=id3
    const raw = JSON.stringify({ contradictions: [{ facts: ['f1', 'f99', 'f2'], type: 'character_attribute', description: 'A vs B.' }] });
    const out = parseJudgeResponse(raw, batch)!;
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(['id1', 'id2'].sort());
  });

  it('drops an entry citing fewer than 2 distinct fact ids, including a duplicated label', () => {
    const group: FactGroup = { entity: 'e1', category: 'reveal', facts: [fact('id1', 'A.'), fact('id2', 'B.')] };
    const batch = batchOf([group]);
    const single = JSON.stringify({ contradictions: [{ facts: ['f1'], type: 'character_attribute', description: 'lonely' }] });
    expect(parseJudgeResponse(single, batch)).toEqual([]);
    const duped = JSON.stringify({ contradictions: [{ facts: ['f1', 'f1'], type: 'character_attribute', description: 'dup' }] });
    expect(parseJudgeResponse(duped, batch)).toEqual([]); // dedupes to 1 distinct id first
  });

  it('drops a citation that pairs facts from two different groups in the same call', () => {
    const groupX: FactGroup = { entity: 'ex', category: 'reveal', facts: [fact('x1', 'X1.'), fact('x2', 'X2.')] };
    const groupY: FactGroup = { entity: 'ey', category: 'reveal', facts: [fact('y1', 'Y1.'), fact('y2', 'Y2.')] };
    const batch = batchOf([groupX, groupY]); // f1=x1,f2=x2 (group0); f3=y1,f4=y2 (group1)
    const raw = JSON.stringify({ contradictions: [{ facts: ['f1', 'f3'], type: 'character_attribute', description: 'cross' }] });
    expect(parseJudgeResponse(raw, batch)).toEqual([]);
  });

  it('falls back on a bad "type" by the citing group\'s own category', () => {
    const worldGroup: FactGroup = { entity: WORLD_ENTITY, category: 'world_rule', facts: [fact('w1', 'Magic needs blood.'), fact('w2', 'Magic is free.')] };
    const revealGroup: FactGroup = { entity: 'e-r', category: 'reveal', facts: [fact('r1', 'Ivy has green eyes.'), fact('r2', 'Ivy has grey eyes.')] };
    const badTypeRaw = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'not-a-real-type', description: 'x' }] });

    expect(parseJudgeResponse(badTypeRaw, batchOf([worldGroup]))![0].type).toBe('world_rule');
    expect(parseJudgeResponse(badTypeRaw, batchOf([revealGroup]))![0].type).toBe('character_attribute');
  });

  it('synthesizes a non-empty description when the model gives none — the backend enforces min_length 1', () => {
    const revealGroup: FactGroup = { entity: 'e-r', category: 'reveal', facts: [fact('r1', 'Ivy has green eyes.'), fact('r2', 'Ivy has grey eyes.')] };
    const batch = batchOf([revealGroup]);
    const rawEmpty = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: '' }] });
    const rawMissing = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute' }] });
    const expected = `Conflicting ${revealGroup.category.replace(/_/g, ' ')} facts about ${batch.groups[0].subject}`;
    expect(parseJudgeResponse(rawEmpty, batch)![0].description).toBe(expected);
    expect(parseJudgeResponse(rawMissing, batch)![0].description).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('clamps an overlong description to DESCRIPTION_CLAMP', () => {
    const revealGroup: FactGroup = { entity: 'e-r', category: 'reveal', facts: [fact('r1', 'A.'), fact('r2', 'B.')] };
    const batch = batchOf([revealGroup]);
    const raw = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: 'Z'.repeat(500) }] });
    const out = parseJudgeResponse(raw, batch)!;
    expect(out[0].description).toBe('Z'.repeat(DESCRIPTION_CLAMP));
    expect(out[0].description.length).toBe(DESCRIPTION_CLAMP);
  });
});

// ---------------------------------------------------------------------------
// Id determinism — the Phase-7-lesson test
// ---------------------------------------------------------------------------

describe('id determinism (the Phase-7 lesson)', () => {
  it('buildContradiction ids depend ONLY on the sorted source set — not on type or description wording', () => {
    // A reworded retry that relabels the kind of conflict, or restates
    // the description in different words, must not orphan a resolution
    // keyed by id. `type` is deliberately excluded from the seed.
    const a = buildContradiction({ sources: ['id-b', 'id-a'], type: 'character_attribute', description: "Ivy's eyes are reported two ways." });
    const b = buildContradiction({ sources: ['id-a', 'id-b'], type: 'relationship', description: 'A completely different description.' });
    expect(a.id).toBe(b.id);
    expect(a.sources).toEqual(b.sources);
    expect(a.type).not.toBe(b.type); // the two DO differ where they're allowed to
  });

  it('two responses reporting the same finding via different order/grouping/wording of the JSON produce byte-identical Contradiction[]', () => {
    const group: FactGroup = { entity: 'e-ivy', category: 'reveal', facts: [fact('id-a', 'Ivy has green eyes.'), fact('id-b', 'Ivy has grey eyes.')] };
    const batch = packGroups([group], []).batches[0]; // f1=id-a, f2=id-b

    const responseA = JSON.stringify({
      contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: "Ivy's eye color is stated two different ways." }],
    });
    // Same finding: different key order, different label order within
    // "facts", wrapped in prose and a markdown fence.
    const responseB = `Here's my answer:\n\`\`\`json\n{"contradictions":[{"description":"Ivy's eye color is stated two different ways.","facts":["f2","f1"],"type":"character_attribute"}]}\n\`\`\``;

    const outA = parseJudgeResponse(responseA, batch)!.map(buildContradiction);
    const outB = parseJudgeResponse(responseB, batch)!.map(buildContradiction);
    expect(outA).toEqual(outB);
    expect(outA[0].id).toBe(outB[0].id);
  });

  it('the same pair surfacing from BOTH of a multi-entity fact\'s groups collapses to one entry', async () => {
    // A relationship fact naming two characters legitimately sits in
    // both their groups; if a weak/retried judge flags the same pair
    // from EITHER side, the run must not double-report it.
    const factA = fact('shared-a', 'Ivy resents Sam.');
    const factB = fact('shared-b', 'Ivy adores Sam.');
    const ivyGroup: FactGroup = { entity: 'char-ivy', category: 'reveal', facts: [factA, factB] };
    const samGroup: FactGroup = { entity: 'char-sam', category: 'reveal', facts: [factA, factB] };
    // Force ivyGroup and samGroup into two DIFFERENT batches (12-group
    // count cap) so this genuinely exercises cross-BATCH dedup, not just
    // within-call dedup.
    const groups = [ivyGroup, ...Array.from({ length: 11 }, (_, i) => fillerGroup(i)), samGroup];
    const packed = packGroups(groups, []);
    expect(packed.batches).toHaveLength(2); // sanity: the fixture actually splits as intended

    // Both responses cite THEIR OWN batch-local labels for factA/factB
    // (labels are per-call, so batch 2's f1/f2 differ from batch 1's
    // meaning, but resolve to the same underlying fact ids either way).
    const respIvy = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'character_attribute', description: "Ivy's feelings about Sam conflict." }] });
    const respSam = JSON.stringify({ contradictions: [{ facts: ['f1', 'f2'], type: 'relationship', description: 'Different wording, same underlying facts.' }] });
    const llm = fakeLlmSequence([respIvy, respSam]);

    const outcome = await runGroupJudge({ groups, cast: [], llm });
    expect(outcome.detected).toHaveLength(1); // collapsed, not 2
    expect(outcome.detected[0].sources).toEqual(['shared-a', 'shared-b'].sort());
  });

  it('the card fact id survives BOTH reworded claims and drifted citations', () => {
    // Seeded from the character alone. Wording-stability is the easy half
    // and was never in doubt; CITATION stability is the half that matters,
    // and the reason this deviates from the plan's §6 formula.
    const character = {
      id: 'char-ivy',
      name: 'Ivy',
      avatar: 'ivy.png',
      cardText: 'A wry archivist.',
    };
    const a = buildCardFact({
      character,
      citedFactIds: ['fact-1', 'fact-2'],
      cardClaim: 'The archive says Ivy never left the city.',
      description: 'x',
      type: 'character_attribute',
    });
    const b = buildCardFact({
      character,
      // The model dropped a citation on the re-judge — the exact drift
      // §7's dampener exists to absorb.
      citedFactIds: ['fact-1'],
      cardClaim: 'Per the card, Ivy is confined to the archive.',
      description: 'y',
      type: 'timeline',
    });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(cardFactId('char-ivy'));
    expect(a.text).not.toBe(b.text); // the wording DOES differ — only the id is stable

    // ...and BECAUSE the id is shared, the two contradictions are now a
    // clean strict subset, so the dampener can collapse them. Seeding the
    // card fact from the cited ids (the plan's literal formula) made each
    // set hold a card id the other lacked, which is mutually
    // incomparable — the dampener could never fire for a card conflict,
    // and every rebuild added another near-duplicate entry forever.
    const c1 = buildCardContradiction(
      { character, citedFactIds: ['fact-1', 'fact-2'], cardClaim: 'a', description: 'x', type: 'character_attribute' },
      a.id
    );
    const c2 = buildCardContradiction(
      { character, citedFactIds: ['fact-1'], cardClaim: 'b', description: 'y', type: 'character_attribute' },
      b.id
    );
    const merged = mergeContinuity([c1], [c2], new Set(['fact-1', 'fact-2', a.id]));
    expect(merged.contradictions).toHaveLength(1);
    expect(merged.contradictions[0].id).toBe(c1.id); // the superset wins
  });

  it('folds the card claim into the description when the model omits it', () => {
    // Load-bearing for the shared per-character fact row: two distinct
    // claims about one character reuse one row (whose text is whichever
    // claim was seen first), so the entry itself has to say which claim
    // THIS conflict is about.
    const character = { id: 'char-ivy', name: 'Ivy', avatar: 'ivy.png', cardText: 'x' };
    const vague = buildCardContradiction(
      {
        character,
        citedFactIds: ['fact-1'],
        cardClaim: 'Ivy has never left the Reach.',
        description: 'The card and the story disagree.',
        type: 'character_attribute',
      },
      'card-row'
    );
    expect(vague.description).toContain('Ivy has never left the Reach.');

    // Already specific — no redundant tail bolted on.
    const specific = buildCardContradiction(
      {
        character,
        citedFactIds: ['fact-1'],
        cardClaim: 'Ivy has never left the Reach.',
        description: 'The card says Ivy has never left the Reach., but she sails in scene 2.',
        type: 'character_attribute',
      },
      'card-row'
    );
    expect(specific.description).not.toContain('(card:');
  });
});

// ---------------------------------------------------------------------------
// Card-vs-transcript check
// ---------------------------------------------------------------------------

function rawCardChar(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    canonical_name: 'Ivy',
    provenance: [{ kind: 'card_field', ref: { character_avatar: `${id}.png`, field: 'description' }, captured_at: '2026-01-01T00:00:00Z' }],
    physical_description: { summary: 'A wry archivist with ink-stained hands.' },
    personality: { traits: [{ trait: 'guarded' }] },
    ...over,
  };
}

describe('card check eligibility', () => {
  it('a transcript-introduced NPC with no card_field provenance costs ZERO calls', async () => {
    const npcNoProvenance = { id: 'char-npc', canonical_name: 'A Stranger', provenance: [], physical_description: { summary: 'Tall.' }, personality: { traits: [] } };
    const npcOtherProvenance = {
      id: 'char-npc2',
      canonical_name: 'Another Stranger',
      provenance: [{ kind: 'chat_message', ref: {}, captured_at: 'x' }], // present, but not card_field
      physical_description: { summary: 'Short.' },
      personality: { traits: [] },
    };
    const cardChars = readCardCharacters([npcNoProvenance, npcOtherProvenance]);
    expect(cardChars).toEqual([]); // excluded before any fact-matching happens

    const cast: KnownCastMember[] = [{ id: 'char-npc', name: 'A Stranger', aliases: [] }];
    const targets = buildCardCheckTargets(cardChars, [fact('f1', 'A Stranger walked in.')], cast);
    expect(targets).toEqual([]);

    const llm: LlmCall = vi.fn(async () => '{"contradictions":[]}');
    const outcome = await runCardChecks({ targets, llm });
    expect(outcome.llmCalls).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it('a card-backed character with only a SINGLETON fact is still checked (groupFacts would have dropped it)', () => {
    const cardChars = readCardCharacters([rawCardChar('char-ivy')]);
    expect(cardChars).toHaveLength(1);

    // One fact — groupFacts requires >= 2 to form a judge-worthy group,
    // but a single fact can very much contradict the card, so the card
    // check must not go through groupFacts at all.
    const singleton = [fact('f1', 'Ivy has green eyes.')];
    const targets = buildCardCheckTargets(cardChars, singleton, CAST);
    expect(targets).toHaveLength(1);
    expect(targets[0].facts).toHaveLength(1);
    expect(targets[0].character.id).toBe('char-ivy');
    expect(targets[0].omittedFacts).toBe(0);
  });

  it('COUNTS the facts a big character loses to the one-call budget, and keeps the newest', async () => {
    // §6 buys a big cast's affordability with one call per character, so
    // a very talked-about character has to be trimmed. A trim nobody
    // counts is exactly the "silent cap" the plan forbids: it would
    // report "checked, clean" over facts that were never sent.
    const cardChars = readCardCharacters([rawCardChar('char-ivy')]);
    const many = Array.from({ length: 55 }, (_, i) =>
      fact(`f${i}`, `Ivy did thing number ${i}.`)
    );
    const targets = buildCardCheckTargets(cardChars, many, CAST);
    expect(targets[0].facts).toHaveLength(40);
    expect(targets[0].omittedFacts).toBe(15);
    // The TAIL, not the head: a card override is by definition something
    // the story established later, so the newest facts are where the
    // contradicting claim lives.
    expect(targets[0].facts[39].id).toBe('f54');
    expect(targets[0].facts[0].id).toBe('f15');

    const llm: LlmCall = vi.fn(async () => '{"contradictions":[]}');
    const outcome = await runCardChecks({ targets, llm });
    expect(outcome.truncatedCharacters).toBe(1);
    expect(outcome.llmCalls).toBe(1); // still ONE call, as §6 requires
  });

  it('readCardCharacters never returns an empty avatar, across every fallback path', () => {
    const withRefAvatar = rawCardChar('char-a'); // ref.character_avatar present
    const withSourceFallback = rawCardChar('char-b', {
      provenance: [{ kind: 'card_field', ref: { field: 'description' }, captured_at: 'x' }], // no character_avatar
      source: { kind: 'character', ref: 'source-avatar.png' },
    });
    const withNameFallback = rawCardChar('char-c', {
      provenance: [{ kind: 'card_field', ref: {}, captured_at: 'x' }], // no avatar, no source
    });
    const withIdFallback = rawCardChar('char-d', {
      canonical_name: '', // no name either — falls all the way to id
      provenance: [{ kind: 'card_field', ref: {}, captured_at: 'x' }],
    });

    const out = readCardCharacters([withRefAvatar, withSourceFallback, withNameFallback, withIdFallback]);
    expect(out).toHaveLength(4);
    for (const c of out) expect(c.avatar.length).toBeGreaterThan(0);

    expect(out.find((c) => c.id === 'char-a')!.avatar).toBe('char-a.png');
    expect(out.find((c) => c.id === 'char-b')!.avatar).toBe('source-avatar.png');
    expect(out.find((c) => c.id === 'char-c')!.avatar).toBe('Ivy'); // canonical_name
    expect(out.find((c) => c.id === 'char-d')!.avatar).toBe('char-d'); // id itself
  });
});

describe('buildCardFact shape', () => {
  it('produces an appendable fact row with the documented shape', () => {
    const conflict: DetectedCardConflict = {
      character: { id: 'char-ivy', name: 'Ivy', avatar: 'ivy.png', cardText: 'A wry archivist.' },
      citedFactIds: ['fact-1', 'fact-2'],
      cardClaim: 'The archive says Ivy has never left the city.',
      type: 'character_attribute',
      description: 'The card and the story disagree.',
    };
    const row = buildCardFact(conflict);

    expect(row.id).toBe(cardFactId('char-ivy'));
    expect(row.text).toBe(`Card: ${conflict.cardClaim}`);
    expect(row.category).toBe('introduction');
    expect(row.confidence).toBe('explicit');
    expect(row.established_in).toBeNull();
    expect(row.contradicts).toEqual(conflict.citedFactIds);
    const source = row.source!; // buildCardFact always sets it — never null
    expect(source.kind).toBe('card_field');
    if (source.kind === 'card_field') {
      expect(source.ref.character_avatar).toBe('ivy.png');
      expect(source.ref.field).toBe('description');
      expect(source.snapshot?.excerpt).toBe(conflict.cardClaim.slice(0, 500));
    }

    // And the contradiction built on top cites the card fact + transcript facts.
    const c = buildCardContradiction(conflict, row.id);
    expect(c.sources).toEqual([row.id, ...conflict.citedFactIds].sort());
  });
});

// ---------------------------------------------------------------------------
// mergeContinuity
// ---------------------------------------------------------------------------

describe('mergeContinuity', () => {
  it('existing wins on id collision, preserving a user_chose resolution across re-detection', () => {
    const sources = ['fact-a', 'fact-b'];
    const existingResolved = contradiction({
      sources,
      detected_by: 'user',
      resolution: { status: 'user_chose', canonical_choice: 'fact-a', rationale: 'Fact B was retconned.', resolved_at: '2026-08-01T00:00:00Z' },
    });
    const freshlyRedetected = contradiction({ sources, detected_by: 'agent', description: 'A freshly re-detected conflict.' });
    // Same sources -> same deterministic id, which is the whole point.
    expect(existingResolved.id).toBe(freshlyRedetected.id);

    const merge = mergeContinuity([existingResolved], [freshlyRedetected], new Set(sources));
    expect(merge.contradictions).toEqual([existingResolved]); // byte-identical to the ORIGINAL
  });

  it('keeps an existing entry that was not re-detected this run', () => {
    const old = contradiction({ id: 'old-1', sources: ['fact-x', 'fact-y'] });
    const merge = mergeContinuity([old], [], new Set(['fact-x', 'fact-y']));
    expect(merge.contradictions).toEqual([old]);
  });

  it('never collapses a transcript conflict into a card conflict that merely contains it', () => {
    // A card entry cites [cardFact, ...transcriptFacts], so a
    // transcript-only entry over those same facts is ALWAYS a strict
    // subset of it. Without the same-kind guard the dampener eats an
    // entirely unrelated finding — and whether it does depends only on
    // how widely the card check happened to cite, so the same bible loses
    // a different contradiction from one build to the next.
    //
    // Found by the manual smoke test, not by any unit test: it needs the
    // card check and the group judge to fire over an overlapping fact set,
    // which only happens end-to-end.
    const CARD = 'card-fact-id';
    const group = contradiction({ id: 'group', sources: ['f1', 'f2'] });
    const card = contradiction({ id: 'card', sources: [CARD, 'f1', 'f2'] });
    const live = new Set(['f1', 'f2', CARD]);

    const guarded = mergeContinuity([group], [card], live, new Set([CARD]));
    expect(guarded.contradictions.map((c) => c.id).sort()).toEqual(['card', 'group']);

    // ...while genuine citation drift WITHIN the card kind still collapses.
    const narrow = contradiction({ id: 'card-narrow', sources: [CARD, 'f1'] });
    const drifted = mergeContinuity([card], [narrow], live, new Set([CARD]));
    expect(drifted.contradictions.map((c) => c.id)).toEqual(['card']);
  });

  /** The dampener's survivorship must depend on CONTENT ONLY.
   *
   *  It briefly skipped any `b` already marked dropped — which looks like
   *  a free optimisation and is not: a protected entry breaks
   *  strict-subset's transitivity, so a dropped-but-suppressing entry
   *  could shield a third entry nothing else covered, and whether it did
   *  came down to array position. Found by permutation-fuzzing. */
  describe('drift dampener is order-independent', () => {
    // The exact shape that broke it: X is protected and a strict subset
    // of Y; Z is incomparable to X but a strict subset of Y.
    const X = contradiction({
      id: 'x',
      sources: ['f1', 'f2'],
      resolution: { status: 'user_chose', canonical_choice: 'f1', rationale: '', resolved_at: null },
    });
    const Y = contradiction({ id: 'y', sources: ['f1', 'f2', 'f3', 'f4'] });
    const Z = contradiction({ id: 'z', sources: ['f1', 'f3', 'f4'] });
    const LIVE = new Set(['f1', 'f2', 'f3', 'f4']);

    it('produces the same result for every permutation of its inputs', () => {
      const permutations: [Contradiction[], Contradiction[]][] = [
        [[X], [Y, Z]],
        [[X], [Z, Y]],
        [[X, Y], [Z]],
        [[X, Z], [Y]],
        [[X, Y, Z], []],
        [[X, Z, Y], []],
      ];
      const idSets = permutations.map((p) =>
        mergeContinuity(p[0], p[1], LIVE)
          .contradictions.map((c) => c.id)
          .sort()
      );
      for (const ids of idSets) expect(ids).toEqual(idSets[0]);
      // The protected entry always survives; both agent entries above it
      // are covered by it or by each other.
      expect(idSets[0]).toEqual(['x']);
    });

    it('converges: re-merging its own output changes nothing', () => {
      // The oscillation this pins: because an entry MOVES from the
      // detected half to the existing half once written, an
      // order-dependent dampener flips its verdict on alternate rebuilds
      // — so continuityUnchanged never short-circuits and every single
      // rebuild bumps server_ts, the exact churn the skip-PUT exists to
      // prevent.
      const first = mergeContinuity([X], [Y, Z], LIVE).contradictions;
      const second = mergeContinuity(first, [Y, Z], LIVE).contradictions;
      const third = mergeContinuity(second, [Y, Z], LIVE).contradictions;
      expect(continuityUnchanged(first, second)).toBe(true);
      expect(continuityUnchanged(second, third)).toBe(true);
    });
  });

  it('dangling-source prune drops an unresolved agent entry citing a missing fact, but NEVER a resolved or user entry', () => {
    const missingSources = ['fact-missing', 'fact-live'];
    const unresolvedDangling = contradiction({ id: 'u1', sources: missingSources, detected_by: 'agent' });
    const resolvedDangling = contradiction({
      id: 'r1',
      sources: missingSources,
      detected_by: 'agent',
      resolution: { status: 'agent_resolved', canonical_choice: 'fact-live', rationale: 'resolved anyway', resolved_at: '2026-01-01T00:00:00Z' },
    });
    const userDangling = contradiction({ id: 'us1', sources: missingSources, detected_by: 'user' });

    const liveFactIds = new Set(['fact-live']); // fact-missing is gone (hard-deleted)
    const merge = mergeContinuity([unresolvedDangling, resolvedDangling, userDangling], [], liveFactIds);
    const ids = merge.contradictions.map((c) => c.id);
    expect(ids).not.toContain('u1');
    expect(ids).toContain('r1');
    expect(ids).toContain('us1');
  });

  it('collapses a strict subset/superset drift pair to the superset, regardless of which side is "existing"', () => {
    const superset = contradiction({ sources: ['a', 'b', 'c'] });
    const subset = contradiction({ sources: ['a', 'b'] });
    const live = new Set(['a', 'b', 'c']);

    const m1 = mergeContinuity([superset], [subset], live);
    expect(m1.contradictions).toHaveLength(1);
    expect(m1.contradictions[0].sources).toEqual(['a', 'b', 'c']);

    const m2 = mergeContinuity([subset], [superset], live);
    expect(m2.contradictions).toHaveLength(1);
    expect(m2.contradictions[0].sources).toEqual(['a', 'b', 'c']);
  });

  it('a protected (resolved/user) entry always survives drift collapse, even as the smaller set', () => {
    const protectedSubset = contradiction({ sources: ['a', 'b'], detected_by: 'user' });
    const unprotectedSuperset = contradiction({ sources: ['a', 'b', 'c'], detected_by: 'agent' });
    const merge = mergeContinuity([protectedSubset], [unprotectedSuperset], new Set(['a', 'b', 'c']));
    expect(merge.contradictions).toHaveLength(1);
    expect(merge.contradictions[0].id).toBe(protectedSubset.id);
  });

  it('byte-bounds deterministically, never dropping user/resolved entries, even under an adversarial payload', () => {
    function bigSources(n: number, salt: string): string[] {
      return Array.from({ length: n }, (_, i) => deterministicUuid(`${salt}-src-${i}`));
    }
    function bigEntry(i: number, protectedEntry: boolean): Contradiction {
      const sources = bigSources(20, `big-${i}`);
      return contradiction({
        sources,
        description: 'X'.repeat(DESCRIPTION_CLAMP),
        detected_by: protectedEntry ? 'user' : 'agent',
        resolution: protectedEntry
          ? { status: 'user_chose', canonical_choice: sources[0], rationale: 'kept on purpose', resolved_at: '2026-01-01T00:00:00Z' }
          : unresolvedResolution(),
      });
    }
    const protectedEntries = [bigEntry(9001, true), bigEntry(9002, true)];
    const freshEntries = Array.from({ length: 200 }, (_, i) => bigEntry(i, false));
    const live = new Set([...protectedEntries, ...freshEntries].flatMap((c) => c.sources));

    const m1 = mergeContinuity(protectedEntries, freshEntries, live);
    const m2 = mergeContinuity(protectedEntries, freshEntries, live); // same inputs, must reproduce exactly
    expect(m1).toEqual(m2);

    const bytes = new TextEncoder().encode(JSON.stringify({ contradictions: m1.contradictions })).length;
    expect(bytes).toBeLessThanOrEqual(CONTINUITY_BYTE_BUDGET);
    expect(m1.contradictions.length).toBeLessThanOrEqual(MAX_CONTRADICTIONS);
    expect(m1.dropped).toBeGreaterThan(0); // this payload is deliberately oversized

    const survivingIds = m1.contradictions.map((c) => c.id);
    for (const p of protectedEntries) expect(survivingIds).toContain(p.id);
  });

  it('a literal 200-entry x 400-char-description adversarial payload stays under the byte and count budgets', () => {
    const entries: Contradiction[] = Array.from({ length: 200 }, (_, i) => {
      const sources = [deterministicUuid(`adv-${i}-a`), deterministicUuid(`adv-${i}-b`)];
      return contradiction({ sources, description: 'Y'.repeat(DESCRIPTION_CLAMP) });
    });
    const live = new Set(entries.flatMap((e) => e.sources));
    const merge = mergeContinuity([], entries, live);

    const bytes = new TextEncoder().encode(JSON.stringify({ contradictions: merge.contradictions })).length;
    expect(merge.contradictions.length).toBeLessThanOrEqual(MAX_CONTRADICTIONS);
    expect(bytes).toBeLessThanOrEqual(CONTINUITY_BYTE_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// readContinuitySection
// ---------------------------------------------------------------------------

describe('readContinuitySection', () => {
  it('THROWS on a non-object payload rather than treating it as empty', () => {
    expect(() => readContinuitySection(null)).toThrow();
    expect(() => readContinuitySection(undefined)).toThrow();
    expect(() => readContinuitySection([])).toThrow();
    expect(() => readContinuitySection('nope')).toThrow();
    expect(() => readContinuitySection(42)).toThrow();
  });

  it('THROWS when "contradictions" is present but not a well-formed array', () => {
    expect(() => readContinuitySection({ contradictions: 'nope' })).toThrow();
    expect(() => readContinuitySection({ contradictions: [{ id: 'x' }] })).toThrow(); // missing required fields
    expect(() =>
      readContinuitySection({ contradictions: [{ id: 'x', type: 'y', description: 'z', sources: 'not-an-array', detected_by: 'agent', resolution: { status: 'unresolved' } }] })
    ).toThrow();
  });

  it('returns [] for a legitimately empty or absent section — not every unread section is malformed', () => {
    expect(readContinuitySection({})).toEqual([]);
    expect(readContinuitySection({ contradictions: [] })).toEqual([]);
    expect(readContinuitySection({ contradictions: null })).toEqual([]);
  });

  it('round-trips a well-formed section', () => {
    const c = contradiction();
    expect(readContinuitySection({ contradictions: [c] })).toEqual([c]);
  });
});

describe('continuityUnchanged', () => {
  it('is true when nothing changed — the cue the store uses to skip a gratuitous PUT', () => {
    const existing = [contradiction({ id: 'a' })];
    const merge = mergeContinuity(existing, [], new Set(existing[0].sources));
    expect(continuityUnchanged(existing, merge.contradictions)).toBe(true);
  });

  it('is false once a genuinely new detection lands', () => {
    const fresh = contradiction({ id: 'b', sources: ['s1', 's2'] });
    const merge = mergeContinuity([], [fresh], new Set(['s1', 's2']));
    expect(continuityUnchanged([], merge.contradictions)).toBe(false);
  });
});
