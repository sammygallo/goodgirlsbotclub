// Provider/model + sampler resolution shared by the chat path and one-off
// generation utilities (AI helpers, ingestion, card tooling).
//
// Moved verbatim out of chatStore so non-chat callers resolve generation
// settings the same way a chat turn does, without importing chatStore's
// init cycle. Behavior is unchanged, including the deliberate side effect:
// `getProviderAndModel` silently switches an unconfigured/OpenAI-less user
// onto Claude when a Claude key is the only one present, persisting that
// choice via settingsStore and bumping a legacy-small context budget once.

import { useSettingsStore } from '../../stores/settingsStore';
import { useGenerationStore } from '../../stores/generationStore';
import { getInstructTemplate } from '../instructTemplates';
import type { GenerationOptions } from '../../api/client';

/** Get provider/model with auto-switch to Claude when it holds the only key. */
export function getProviderAndModel(): { provider: string; model: string } {
  const { activeProvider, activeModel, secrets, globalSecrets, globalSharingEnabled } = useSettingsStore.getState();

  let provider = activeProvider;
  let model = activeModel;

  // Helper: check if a key exists in personal or global secrets
  const hasKey = (key: string) => {
    if (Array.isArray(secrets[key]) && secrets[key].length > 0) return true;
    if (globalSharingEnabled && Array.isArray(globalSecrets[key]) && globalSecrets[key].length > 0) return true;
    return false;
  };

  if (!provider || provider === 'openai') {
    const hasOpenAI = hasKey('api_key_openai');
    const hasClaude = hasKey('api_key_claude');
    if (!hasOpenAI && hasClaude) {
      provider = 'claude';
      model = 'claude-sonnet-4-20250514';
      useSettingsStore.setState({ activeProvider: provider, activeModel: model });
      // Rescue the context budget. Users land on Claude (200k window) via this
      // silent auto-switch but keep the legacy 8192-token default, which on a
      // long thread trims away the whole conversation and yields empty/failed
      // turns. Raise it to a sane-but-cost-conscious window — only when still
      // at/below the old default, so a user's own larger choice is untouched.
      // The guard self-clears after the first bump, so this runs at most once.
      const gen = useGenerationStore.getState();
      if (gen.context.maxTokens <= 8192) {
        gen.setContext({ maxTokens: 32768 });
      }
    }
  }

  return { provider, model };
}

/** Build generation options from the current sampler + instruct config. */
export function getGenerationOptions(): GenerationOptions {
  const { sampler, instruct } = useGenerationStore.getState();
  const combinedStops = [...sampler.stopStrings];

  if (instruct.enabled) {
    const tpl = getInstructTemplate(instruct.templateId);
    if (tpl) {
      for (const s of tpl.stopStrings) {
        if (!combinedStops.includes(s)) combinedStops.push(s);
      }
    }
    for (const s of instruct.extraStopStrings) {
      if (s && !combinedStops.includes(s)) combinedStops.push(s);
    }
  }

  return {
    temperature: sampler.temperature,
    maxTokens: sampler.maxTokens,
    topP: sampler.topP,
    topK: sampler.topK,
    minP: sampler.minP,
    frequencyPenalty: sampler.frequencyPenalty,
    presencePenalty: sampler.presencePenalty,
    repetitionPenalty: sampler.repetitionPenalty,
    stopStrings: combinedStops,
  };
}
