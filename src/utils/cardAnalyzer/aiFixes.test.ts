import { beforeEach, describe, expect, it, vi } from 'vitest';

// aiFixes.ts's only network-touching dependency is generateOnce — mock the
// module directly (same pattern worldInfoStore.test.ts/autoMemoryStore.test.ts
// use for their own directly-imported dependencies) rather than reaching
// further down into api/client. storyIngest's passes avoid mocking
// altogether via an injected `LlmCall` parameter, but runAiFix's signature
// is fixed by the shared type contract (no injection seam), so this is the
// established fallback for a module that calls generateOnce directly, same
// as aiCharacterHelper.ts does.
vi.mock('../llm/generate', () => ({
  generateOnce: vi.fn(),
}));

import { generateOnce } from '../llm/generate';
import { runAiFix, type AiFixResult } from './aiFixes';
import { findingId, type AnalyzableCardData, type Finding } from './types';

const mockGenerateOnce = vi.mocked(generateOnce);

function baseCard(): AnalyzableCardData {
  return {
    name: 'Aria',
    description: 'Aria is a brave knight who guards the old castle.',
    personality: 'Brave, loyal, a little stubborn',
    first_mes: '*Aria draws her sword.* "Stay behind me."',
    scenario: 'A castle under siege at dusk.',
    mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hello there.',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
  };
}

function findingFor(
  aiPass: Finding['aiPass'],
  field: Finding['field'] = 'description'
): Finding {
  return {
    id: findingId('format.wpp', field),
    code: 'format.wpp',
    field,
    severity: 'warning',
    fix: 'ai',
    aiPass,
    title: 'Test finding',
    detail: 'A finding used for testing.',
  };
}

beforeEach(() => {
  mockGenerateOnce.mockReset();
});

describe('runAiFix', () => {
  it('rewriteProse strips a markdown fence and returns a fieldDiffs result', async () => {
    mockGenerateOnce.mockResolvedValueOnce('```\nAria is bold, clever, and fiercely loyal.\n```');
    const card = baseCard();
    const finding = findingFor('rewriteProse', 'description');

    const result = await runAiFix(finding, card, 'Aria');

    const expected: AiFixResult = {
      kind: 'fieldDiffs',
      diffs: [
        {
          field: 'description',
          before: card.description!,
          after: 'Aria is bold, clever, and fiercely loyal.',
        },
      ],
    };
    expect(result).toEqual(expected);
    expect(mockGenerateOnce).toHaveBeenCalledTimes(1);
    const [messages, opts] = mockGenerateOnce.mock.calls[0];
    expect(messages[0]).toEqual(
      expect.objectContaining({ role: 'system', content: expect.stringContaining('House style') })
    );
    expect(opts).toEqual(expect.objectContaining({ maxTokens: 2048, label: 'Aria' }));
  });

  it('macroNormalize strips a "Here is the result:" preamble', async () => {
    mockGenerateOnce.mockResolvedValueOnce('Here is the result:\n{{char}} smiles warmly.');
    const card = baseCard();
    const finding = findingFor('macroNormalize', 'first_mes');

    const result = await runAiFix(finding, card, 'Aria');

    expect(result).toEqual<AiFixResult>({
      kind: 'fieldDiffs',
      diffs: [
        { field: 'first_mes', before: card.first_mes!, after: '{{char}} smiles warmly.' },
      ],
    });
    expect(mockGenerateOnce).toHaveBeenCalledTimes(1);
  });

  it('restructureExamples strips wrapping quotes from the rebuilt examples', async () => {
    mockGenerateOnce.mockResolvedValueOnce('"<START>\n{{user}}: hi\n{{char}}: hi back"');
    const card = baseCard();
    const finding = findingFor('restructureExamples', 'mes_example');

    const result = await runAiFix(finding, card, 'Aria');

    expect(result).toEqual<AiFixResult>({
      kind: 'fieldDiffs',
      diffs: [
        {
          field: 'mes_example',
          before: card.mes_example!,
          after: '<START>\n{{user}}: hi\n{{char}}: hi back',
        },
      ],
    });
  });

  it('generateField drafts content for an empty field with maxTokens 1024', async () => {
    mockGenerateOnce.mockResolvedValueOnce('```\nA grand hall lit by torches.\n```');
    const card = baseCard();
    card.scenario = '';
    const finding = findingFor('generateField', 'scenario');

    const result = await runAiFix(finding, card, 'Aria');

    expect(result).toEqual<AiFixResult>({
      kind: 'fieldDiffs',
      diffs: [{ field: 'scenario', before: '', after: 'A grand hall lit by torches.' }],
    });
    const [, opts] = mockGenerateOnce.mock.calls[0];
    expect(opts).toEqual(expect.objectContaining({ maxTokens: 1024 }));
  });

  it('extractLore parses valid JSON on the first attempt (no repair call)', async () => {
    mockGenerateOnce.mockResolvedValueOnce(
      JSON.stringify({
        revised_description: 'Aria is a knight who guards the castle.',
        entries: [
          { keys: ['castle', 'siege'], content: 'The castle has stood under siege for a decade.' },
        ],
      })
    );
    const card = baseCard();
    const finding = findingFor('extractLore', 'description');

    const result = await runAiFix(finding, card, 'Aria');

    expect(result).toEqual<AiFixResult>({
      kind: 'loreExtract',
      result: {
        originalDescription: 'Aria is a brave knight who guards the old castle.',
        revisedDescription: 'Aria is a knight who guards the castle.',
        entries: [
          { keys: ['castle', 'siege'], content: 'The castle has stood under siege for a decade.' },
        ],
      },
    });
    expect(mockGenerateOnce).toHaveBeenCalledTimes(1);
  });

  it('extractLore repairs once on invalid JSON, then succeeds from the second response', async () => {
    mockGenerateOnce
      .mockResolvedValueOnce('not json at all, sorry')
      .mockResolvedValueOnce(
        JSON.stringify({
          revised_description: 'Aria is a knight.',
          entries: [],
        })
      );
    const card = baseCard();
    const finding = findingFor('extractLore', 'description');

    const result = await runAiFix(finding, card, 'Aria');

    expect(result).toEqual<AiFixResult>({
      kind: 'loreExtract',
      result: {
        originalDescription: 'Aria is a brave knight who guards the old castle.',
        revisedDescription: 'Aria is a knight.',
        entries: [],
      },
    });
    expect(mockGenerateOnce).toHaveBeenCalledTimes(2);

    // The repair call must carry the original exchange plus the model's own
    // broken response plus the repair instruction as a new user turn.
    const secondCallMessages = mockGenerateOnce.mock.calls[1][0];
    expect(secondCallMessages.at(-2)).toEqual({
      role: 'assistant',
      content: 'not json at all, sorry',
    });
    expect(secondCallMessages.at(-1)?.role).toBe('user');
    expect(secondCallMessages.at(-1)?.content).toContain('could not be parsed');
  });

  it('extractLore throws when both the first attempt and the repair fail to parse', async () => {
    mockGenerateOnce.mockResolvedValueOnce('nope').mockResolvedValueOnce('still not json');
    const card = baseCard();
    const finding = findingFor('extractLore', 'description');

    await expect(runAiFix(finding, card, 'Aria')).rejects.toThrow();
    expect(mockGenerateOnce).toHaveBeenCalledTimes(2);
  });

  it('extractLore throws when the shape is missing required keys, even if it is valid JSON', async () => {
    mockGenerateOnce
      .mockResolvedValueOnce(JSON.stringify({ entries: [] })) // missing revised_description
      .mockResolvedValueOnce(JSON.stringify({ entries: [] })); // repair also missing it

    const card = baseCard();
    const finding = findingFor('extractLore', 'description');

    await expect(runAiFix(finding, card, 'Aria')).rejects.toThrow();
    expect(mockGenerateOnce).toHaveBeenCalledTimes(2);
  });

  it('rejects without calling generateOnce when fix is not "ai"', async () => {
    const card = baseCard();
    const finding: Finding = {
      id: findingId('macro.legacy_placeholder', 'description'),
      code: 'macro.legacy_placeholder',
      field: 'description',
      severity: 'issue',
      fix: 'deterministic',
      title: 'Legacy placeholder',
      detail: 'Uses <BOT> instead of {{char}}.',
    };

    await expect(runAiFix(finding, card, 'Aria')).rejects.toThrow();
    expect(mockGenerateOnce).not.toHaveBeenCalled();
  });

  it('rejects without calling generateOnce when fix is "ai" but aiPass is missing', async () => {
    const card = baseCard();
    const finding: Finding = {
      id: findingId('tokens.card_bloat', 'card'),
      code: 'tokens.card_bloat',
      field: 'card',
      severity: 'warning',
      fix: 'ai',
      title: 'Card over budget',
      detail: 'Total permanent tokens are over budget.',
    };

    await expect(runAiFix(finding, card, 'Aria')).rejects.toThrow();
    expect(mockGenerateOnce).not.toHaveBeenCalled();
  });
});
