import { generateOnce } from './llm/generate';
import { useSettingsStore } from '../stores/settingsStore';

export type AIHelperAction = 'polish' | 'reformat' | 'suggest';

/** Snapshot of all character-creation fields. The "suggest" action uses the
 *  other (non-target) fields as context so the AI can draft something that
 *  fits the rest of the profile. */
export interface CharacterFieldsSnapshot {
  name?: string;
  description?: string;
  personality?: string;
  firstMessage?: string;
  scenario?: string;
  exampleMessages?: string;
}

const FIELD_LABELS: Record<keyof CharacterFieldsSnapshot, string> = {
  name: 'Name',
  description: 'Description',
  personality: 'Personality',
  firstMessage: 'First Message',
  scenario: 'Scenario',
  exampleMessages: 'Example Messages',
};

async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // Pin the raw active provider/model rather than leaving them for
  // generateOnce to resolve. Omitting them would opt this single-field
  // helper into the resolver's Claude-only-key auto-switch (a persisted,
  // app-wide settings change) as a side effect of clicking "Polish" on a
  // form field — this helper never had that behavior before the move to
  // the shared generation utility, and this phase isn't meant to add any
  // new AI-affecting behavior anywhere.
  const { activeProvider, activeModel } = useSettingsStore.getState();
  const text = await generateOnce(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { provider: activeProvider, model: activeModel, label: 'CharacterHelper', signal }
  );
  return stripWrappingMarkers(text.trim());
}

/** Models sometimes echo the field label, surround the answer in quotes, or
 *  prepend "Here is the polished version:". Trim those defensive wrappers so
 *  the result drops cleanly into a textarea. Exported for reuse by other
 *  plain-text card-editing passes (import fixes, wizard refinements). */
export function stripWrappingMarkers(text: string): string {
  let out = text;
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
  out = out.replace(/^(here(?:\s+is|'s)|sure|certainly|of course)[^\n]*[:.]\s*\n?/i, '');
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

function buildOtherFieldsContext(
  fields: CharacterFieldsSnapshot,
  exclude: keyof CharacterFieldsSnapshot,
): string {
  const lines: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as (keyof CharacterFieldsSnapshot)[]) {
    if (key === exclude) continue;
    const value = fields[key]?.trim();
    if (value) lines.push(`${FIELD_LABELS[key]}:\n${value}`);
  }
  return lines.join('\n\n');
}

/** Run an AI helper action against a single character-creation field.
 *  Returns the rewritten / generated text, ready to drop back into the form. */
export async function runAIHelperAction(
  action: AIHelperAction,
  field: keyof CharacterFieldsSnapshot,
  fields: CharacterFieldsSnapshot,
  signal?: AbortSignal,
): Promise<string> {
  const fieldLabel = FIELD_LABELS[field];
  const currentValue = (fields[field] ?? '').trim();

  if (action === 'polish') {
    if (!currentValue) {
      throw new Error('Field is empty — nothing to polish.');
    }
    const system =
      'You are an editor refining character profile text. Lightly polish the user\'s draft for grammar, spelling, and clarity while preserving their voice, intent, and content. Do not add new facts or change the meaning. Output ONLY the revised text — no preamble, no quotes, no commentary.';
    const user = `Field: ${fieldLabel}\n\nDraft:\n${currentValue}`;
    return generateCompletion(system, user, signal);
  }

  if (action === 'reformat') {
    if (!currentValue) {
      throw new Error('Field is empty — nothing to reformat.');
    }
    const system =
      'You are an editor reformatting character profile text into a structured, prompt-friendly form. When useful, convert prose traits into compact bracketed blocks like [Trait= "value", "value"]. Keep narrative form for fields that need it (first message, scenario). Preserve all factual content. Output ONLY the reformatted text — no preamble, no commentary.';
    const user = `Field: ${fieldLabel}\n\nCurrent draft:\n${currentValue}`;
    return generateCompletion(system, user, signal);
  }

  // suggest from other fields
  const context = buildOtherFieldsContext(fields, field);
  if (!context) {
    throw new Error(
      'No other fields are filled in yet — fill in at least the Name and Description first.',
    );
  }
  const system =
    'You are a creative collaborator helping draft a character profile. Generate the requested field, drawing on the other fields the author has already filled in. Match their tone and voice. If the author already has a partial draft for this field, refine it rather than starting over. Output ONLY the field\'s content — no preamble, no field labels, no commentary.';
  const user = currentValue
    ? `Generate the **${fieldLabel}** for this character.\n\nOther fields:\n${context}\n\nExisting draft to refine:\n${currentValue}`
    : `Generate the **${fieldLabel}** for this character.\n\nOther fields:\n${context}`;
  return generateCompletion(system, user, signal);
}
