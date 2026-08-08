// Card analyzer — AI fix passes.
//
// Each `Finding` whose `fix === 'ai'` names an `aiPass` (see types.ts);
// runAiFix dispatches on it and runs exactly one model call (extractLore
// gets a single repair re-ask on top, matching the storyIngest WALK_REPAIR
// pattern). Every pass goes through the shared generateOnce() — never
// api.generateMessage directly — so it rides the same BYO-key proxy path
// as chat and every other utility feature.
//
// Kept network-free at the boundary the same way storyIngest's passes are:
// this module takes a card + a finding and returns data, it never touches
// a store or persists anything. The caller decides whether to apply the
// resulting FieldDiff(s) / LoreExtractResult.

import { generateOnce, type ChatMessage } from '../llm/generate';
import { asString, asStringList, firstJsonObject } from '../llm/json';
import { stripWrappingMarkers } from '../aiCharacterHelper';
import {
  EXTRACT_LORE_REPAIR_INSTRUCTION,
  EXTRACT_LORE_SYSTEM,
  GENERATE_FIELD_SYSTEM,
  MACRO_NORMALIZE_SYSTEM,
  REWRITE_PROSE_SYSTEM,
  RESTRUCTURE_EXAMPLES_SYSTEM,
  extractLorePrompt,
  generateFieldPrompt,
  macroNormalizePrompt,
  restructureExamplesPrompt,
  rewriteProsePrompt,
} from './prompts';
import type {
  AnalyzableCardData,
  CardTextField,
  DraftLoreEntry,
  FieldDiff,
  Finding,
  LoreExtractResult,
} from './types';

export type AiFixResult =
  | { kind: 'fieldDiffs'; diffs: FieldDiff[] }
  | { kind: 'loreExtract'; result: LoreExtractResult };

export interface RunAiFixOptions {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}

/** Entries this platform's lorebook standard allows per entry (see
 *  lorebookFromTranscript.ts's SYSTEM_PROMPT — the same cap). */
const MAX_LORE_ENTRY_KEYS = 6;
/** Generous ceiling on the revised description — this is a full card
 *  field, not a short summary. */
const MAX_REVISED_DESCRIPTION_CHARS = 8000;

/** Dispatch a `Finding`'s AI pass and return the resulting diff(s).
 *
 * Throws synchronously (before any network call) if `finding` isn't an
 * AI-fixable finding at all — that's a caller bug (checking `fix === 'ai'`
 * is the caller's job before ever reaching here), not a condition to
 * degrade gracefully for. */
export async function runAiFix(
  finding: Finding,
  card: AnalyzableCardData,
  characterName: string,
  opts: RunAiFixOptions = {}
): Promise<AiFixResult> {
  if (finding.fix !== 'ai' || !finding.aiPass) {
    throw new Error(
      `runAiFix: finding "${finding.id}" is not AI-fixable (fix=${finding.fix}, aiPass=${finding.aiPass ?? 'none'})`
    );
  }

  const { provider, model, signal } = opts;
  const label = characterName || 'CardFix';
  const genOpts = { provider, model, signal, label };

  switch (finding.aiPass) {
    case 'rewriteProse': {
      const field = finding.field as CardTextField;
      const before = card[field] ?? '';
      const raw = await generateOnce(
        [
          { role: 'system', content: REWRITE_PROSE_SYSTEM },
          { role: 'user', content: rewriteProsePrompt(field, before, { name: card.name }) },
        ],
        { ...genOpts, maxTokens: 2048 }
      );
      return {
        kind: 'fieldDiffs',
        diffs: [{ field, before, after: stripWrappingMarkers(raw) }],
      };
    }

    case 'macroNormalize': {
      const field = finding.field as CardTextField;
      const before = card[field] ?? '';
      const raw = await generateOnce(
        [
          { role: 'system', content: MACRO_NORMALIZE_SYSTEM },
          { role: 'user', content: macroNormalizePrompt(field, before, characterName) },
        ],
        { ...genOpts, maxTokens: 2048 }
      );
      return {
        kind: 'fieldDiffs',
        diffs: [{ field, before, after: stripWrappingMarkers(raw) }],
      };
    }

    case 'restructureExamples': {
      const field = finding.field as CardTextField; // always mes_example in practice
      const before = card[field] ?? '';
      const raw = await generateOnce(
        [
          { role: 'system', content: RESTRUCTURE_EXAMPLES_SYSTEM },
          { role: 'user', content: restructureExamplesPrompt(before, characterName) },
        ],
        { ...genOpts, maxTokens: 2048 }
      );
      return {
        kind: 'fieldDiffs',
        diffs: [{ field, before, after: stripWrappingMarkers(raw) }],
      };
    }

    case 'generateField': {
      const field = finding.field as CardTextField;
      const before = card[field] ?? '';
      const raw = await generateOnce(
        [
          { role: 'system', content: GENERATE_FIELD_SYSTEM },
          { role: 'user', content: generateFieldPrompt(field, card) },
        ],
        { ...genOpts, maxTokens: 1024 }
      );
      return {
        kind: 'fieldDiffs',
        diffs: [{ field, before, after: stripWrappingMarkers(raw) }],
      };
    }

    case 'extractLore':
      return runExtractLore(card, characterName, genOpts);

    default: {
      // Exhaustiveness guard: a new AiPassId that forgets a case here
      // throws loudly instead of the switch silently falling through.
      const unhandled: never = finding.aiPass;
      throw new Error(`runAiFix: unhandled AI pass "${unhandled as string}"`);
    }
  }
}

interface GenOpts {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  label: string;
}

function isValidLoreShape(
  obj: Record<string, unknown> | null
): obj is Record<string, unknown> & { revised_description: string; entries: unknown[] } {
  return (
    !!obj &&
    typeof obj.revised_description === 'string' &&
    Array.isArray(obj.entries)
  );
}

function toLoreEntries(value: unknown[]): DraftLoreEntry[] {
  const entries: DraftLoreEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const content = asString(record.content, 2000);
    const keys = asStringList(record.keys, MAX_LORE_ENTRY_KEYS);
    if (!content || keys.length === 0) continue;
    entries.push({ keys, content });
  }
  return entries;
}

async function runExtractLore(
  card: AnalyzableCardData,
  characterName: string,
  opts: GenOpts
): Promise<AiFixResult> {
  const description = card.description ?? '';
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_LORE_SYSTEM },
    { role: 'user', content: extractLorePrompt(description, characterName) },
  ];
  const callOpts = { provider: opts.provider, model: opts.model, signal: opts.signal, label: opts.label };

  const firstRaw = await generateOnce(baseMessages, { ...callOpts, maxTokens: 3072 });
  let parsed = firstJsonObject(firstRaw);

  if (!isValidLoreShape(parsed)) {
    const repairMessages: ChatMessage[] = [
      ...baseMessages,
      { role: 'assistant', content: firstRaw },
      { role: 'user', content: EXTRACT_LORE_REPAIR_INSTRUCTION },
    ];
    const secondRaw = await generateOnce(repairMessages, { ...callOpts, maxTokens: 3072 });
    parsed = firstJsonObject(secondRaw);
  }

  if (!isValidLoreShape(parsed)) {
    throw new Error(
      'runAiFix: extractLore response could not be parsed as JSON matching the required shape, even after a repair re-ask'
    );
  }

  const revisedDescription = asString(parsed.revised_description, MAX_REVISED_DESCRIPTION_CHARS);
  const entries = toLoreEntries(parsed.entries);

  return {
    kind: 'loreExtract',
    result: { originalDescription: description, revisedDescription, entries },
  };
}
