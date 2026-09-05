import { useEffect, useState } from 'react';
import { ArrowLeft, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useGenerationStore, DEFAULT_SAMPLER } from '../../stores/generationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getDefaultContextSize } from '../../utils/tokenizer';
import { INSTRUCT_TEMPLATES } from '../../utils/instructTemplates';
import { Button, Input, TextArea, HelpTip } from '../ui';
import { PromptOrderEditor } from './PromptOrderEditor';

type TabId = 'samplers' | 'prompts' | 'order' | 'context' | 'instruct';

const RESPONSE_LENGTH_PRESETS = [
  { label: 'Short', tokens: 400 },
  { label: 'Balanced', tokens: 1024 },
  { label: 'Long', tokens: 2048 },
  { label: 'Extended', tokens: 4096 },
] as const;

const TABS: { id: TabId; label: string }[] = [
  { id: 'samplers', label: 'Samplers' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'order', label: 'Order' },
  { id: 'context', label: 'Context' },
  { id: 'instruct', label: 'Instruct' },
];

export function GenerationSettingsPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    sampler,
    presets,
    activePresetId,
    prompt,
    context,
    instruct,
    lastTokenEstimate,
    setSampler,
    resetSampler,
    savePreset,
    loadPreset,
    deletePreset,
    setPrompt,
    resetPrompt,
    setContext,
    applyProviderDefaults,
    setInstruct,
  } = useGenerationStore();
  const { activeProvider } = useSettingsStore();

  const [tab, setTab] = useState<TabId>('samplers');
  const [newPresetName, setNewPresetName] = useState('');

  // Keep the UI aware of the active provider's default context size
  useEffect(() => {
    // Only seed once if context.maxTokens is still the default
    if (context.maxTokens === 8192) {
      const providerDefault = getDefaultContextSize(activeProvider);
      if (providerDefault !== context.maxTokens) {
        setContext({ maxTokens: providerDefault });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider]);

  const handleSavePreset = () => {
    if (!newPresetName.trim()) return;
    savePreset(newPresetName.trim());
    setNewPresetName('');
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goBack()}
          className="p-2"
          aria-label="Back"
        >
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)] flex-1">
          Generation Settings
        </h1>
        {lastTokenEstimate > 0 && (
          <span className="text-xs px-2 py-1 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
            ~{lastTokenEstimate.toLocaleString()} tok
          </span>
        )}
      </header>

      {/* Tabs */}
      <nav
        className="sticky top-0 z-10 flex gap-1 px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] overflow-x-auto"
        aria-label="Settings sections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`
              flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors
              ${
                tab === t.id
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }
            `}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {tab === 'samplers' && (
          <>
            {/* Presets */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Presets
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetSampler}
                  className="text-xs"
                  aria-label="Reset to defaults"
                >
                  <RotateCcw size={14} className="mr-1" />
                  Reset
                </Button>
              </div>

              <div className="flex gap-2 mb-3">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Preset name..."
                  className="flex-1"
                />
                <Button
                  onClick={handleSavePreset}
                  disabled={!newPresetName.trim()}
                  className="shrink-0"
                  size="sm"
                >
                  <Save size={14} className="mr-1" />
                  Save
                </Button>
              </div>

              {presets.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  No presets yet. Adjust samplers below and save.
                </p>
              ) : (
                <ul className="space-y-1">
                  {presets.map((p) => (
                    <li
                      key={p.id}
                      className={`
                        flex items-center justify-between px-3 py-2 rounded-lg
                        ${
                          activePresetId === p.id
                            ? 'bg-[var(--color-primary)]/20 border border-[var(--color-primary)]/40'
                            : 'bg-[var(--color-bg-tertiary)]'
                        }
                      `}
                    >
                      <button
                        onClick={() => loadPreset(p.id)}
                        className="flex-1 text-left text-sm text-[var(--color-text-primary)]"
                      >
                        {p.name}
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deletePreset(p.id)}
                        className="p-1 text-red-400 hover:text-red-300"
                        aria-label={`Delete preset ${p.name}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Sampler params */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Sampler Parameters
              </h2>

              <SliderField
                label="Temperature"
                value={sampler.temperature}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setSampler({ temperature: v })}
                hint={`Randomness. Lower = more deterministic. Default: ${DEFAULT_SAMPLER.temperature}`}
                helpTip="Controls creativity and randomness. 0.1 = very predictable, robotic. 0.7 = natural and varied. 1.0+ = highly creative but may drift or hallucinate. For roleplay, 0.75–0.9 is a sweet spot. For task-focused assistants, try 0.3–0.6."
              />

              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="text-sm font-medium text-[var(--color-text-secondary)]">
                    Response Length
                  </span>
                  <HelpTip tip="Controls how long each AI reply can be. Values that are too low cut responses mid-sentence, forcing 'Continue' clicks — each one re-sends the full context and multiplies your token cost. Match this to the natural length of your character's replies." />
                </div>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  {RESPONSE_LENGTH_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => setSampler({ maxTokens: preset.tokens })}
                      className={`flex flex-col items-center py-2 px-1 rounded-lg text-xs font-medium transition-all ${
                        sampler.maxTokens === preset.tokens
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                      }`}
                    >
                      <span>{preset.label}</span>
                      <span className={`text-[10px] mt-0.5 ${sampler.maxTokens === preset.tokens ? 'text-white/70' : 'text-[var(--color-text-secondary)]'}`}>
                        {preset.tokens.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
                <SliderField
                  label="Max Response Tokens"
                  value={sampler.maxTokens}
                  min={64}
                  max={8192}
                  step={64}
                  onChange={(v) => setSampler({ maxTokens: v })}
                  hint="Fewer 'Continue' clicks = lower total cost. Each click re-sends the full context."
                  helpTip="Caps how long each AI reply can be. ~400 = 1–2 paragraphs. ~1024 = 3–4 paragraphs. ~2048 = 6–8 paragraphs. ~4096 = a full scene. This doesn't affect how much context the AI reads — only how much it writes back."
                />
              </div>

              <SliderField
                label="Top P"
                value={sampler.topP}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setSampler({ topP: v })}
                hint="Nucleus sampling. 1.0 disables it"
                helpTip="Nucleus sampling — the AI only picks from tokens whose combined probability reaches this threshold. 0.9 = top 90% of likely tokens. Lower = more conservative, less surprising. Set to 1.0 to disable and rely on Temperature alone. Most users keep this at 0.9–1.0."
              />

              <SliderField
                label="Top K"
                value={sampler.topK}
                min={0}
                max={200}
                step={1}
                onChange={(v) => setSampler({ topK: v })}
                hint="Top-K sampling. 0 disables it"
                helpTip="Limits the AI to choosing from only the K most likely next tokens. 40–100 is common for local models. 0 disables it. Works alongside Top P — both limits apply. Cloud models (OpenAI, Anthropic) often ignore this; it's most useful for local models like llama.cpp."
              />

              <SliderField
                label="Min P"
                value={sampler.minP}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setSampler({ minP: v })}
                hint="Minimum probability threshold. 0 disables it"
                helpTip="Filters out tokens that are much less probable than the top choice. E.g., 0.05 cuts any token less than 5% as likely as the best token. Helps prevent garbage output at high temperatures without making responses feel restricted. 0 disables it."
              />

              <SliderField
                label="Frequency Penalty"
                value={sampler.frequencyPenalty}
                min={-2}
                max={2}
                step={0.1}
                onChange={(v) => setSampler({ frequencyPenalty: v })}
                hint="Penalize frequent tokens"
                helpTip="Reduces repetition by penalizing tokens based on how many times they've already appeared. Higher values = more varied vocabulary. 0 = off. Negative values can actually encourage repetition (rarely useful). Supported by OpenAI and Anthropic."
              />

              <SliderField
                label="Presence Penalty"
                value={sampler.presencePenalty}
                min={-2}
                max={2}
                step={0.1}
                onChange={(v) => setSampler({ presencePenalty: v })}
                hint="Encourage new topics"
                helpTip="Penalizes any token that has appeared at all, regardless of how often. Encourages the AI to introduce new topics and concepts. Unlike Frequency Penalty, it doesn't scale with repetition count — a single mention is enough to trigger the penalty."
              />

              <SliderField
                label="Repetition Penalty"
                value={sampler.repetitionPenalty}
                min={1}
                max={2}
                step={0.01}
                onChange={(v) => setSampler({ repetitionPenalty: v })}
                hint="1.0 disables it (text completion only)"
                helpTip="Alternative repetition control used by local/text-completion models (llama.cpp, KoboldCpp, etc.). 1.0 = off. 1.1–1.3 is a common range. Penalizes recently-used tokens. Not supported by most cloud providers — use Frequency Penalty instead for those."
              />

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                  Stop Strings (one per line)
                </label>
                <TextArea
                  value={sampler.stopStrings.join('\n')}
                  onChange={(e) =>
                    setSampler({
                      stopStrings: e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={3}
                  placeholder="e.g. ### Instruction:"
                />
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  The model stops generating when any of these strings is produced.
                </p>
              </div>
            </section>
          </>
        )}

        {tab === 'prompts' && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Prompt Overrides
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={resetPrompt}
                className="text-xs"
              >
                <RotateCcw size={14} className="mr-1" />
                Reset
              </Button>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Main Prompt
              </label>
              <TextArea
                value={prompt.mainPrompt}
                onChange={(e) => setPrompt({ mainPrompt: e.target.value })}
                rows={5}
                placeholder='Leave blank for default "You are {{char}}. Stay in character."'
              />
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Overrides the default system prompt. Supports{' '}
                <code>{'{{char}}'}</code>, <code>{'{{user}}'}</code>,{' '}
                <code>{'{{time}}'}</code>, etc.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Jailbreak / Auxiliary Prompt
              </label>
              <TextArea
                value={prompt.jailbreakPrompt}
                onChange={(e) => setPrompt({ jailbreakPrompt: e.target.value })}
                rows={3}
                placeholder="Additional system instructions..."
              />
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Added to the end of the system block.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Post-History Instructions
              </label>
              <TextArea
                value={prompt.postHistoryInstructions}
                onChange={(e) =>
                  setPrompt({ postHistoryInstructions: e.target.value })
                }
                rows={3}
                placeholder='Final nudge before the AI responds...'
              />
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Inserted after the chat history, right before the AI responds. On Claude and Gemini it arrives as a bracketed system note inside a regular turn rather than a separate system message.
              </p>
            </div>

            <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={prompt.respectCharacterOverride}
                  onChange={(e) =>
                    setPrompt({ respectCharacterOverride: e.target.checked })
                  }
                  className="accent-[var(--color-primary)]"
                />
                Honor character's System Prompt override
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={prompt.respectCharacterPHI}
                  onChange={(e) =>
                    setPrompt({ respectCharacterPHI: e.target.checked })
                  }
                  className="accent-[var(--color-primary)]"
                />
                Honor character's Post-History Instructions
              </label>
            </div>

            <div className="pt-2 border-t border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)] mb-2">
                <strong className="text-[var(--color-text-primary)]">Available macros:</strong>{' '}
                <code>{'{{char}}'}</code>, <code>{'{{user}}'}</code>,{' '}
                <code>{'{{persona}}'}</code>, <code>{'{{description}}'}</code>,{' '}
                <code>{'{{personality}}'}</code>, <code>{'{{scenario}}'}</code>,{' '}
                <code>{'{{time}}'}</code>, <code>{'{{date}}'}</code>,{' '}
                <code>{'{{weekday}}'}</code>, <code>{'{{random:a,b,c}}'}</code>,{' '}
                <code>{'{{pick:a,b,c}}'}</code>, <code>{'{{roll:d6}}'}</code>,{' '}
                <code>{'{{lastMessage}}'}</code>, <code>{'{{model}}'}</code>
              </p>
            </div>
          </section>
        )}

        {tab === 'order' && <PromptOrderEditor />}

        {tab === 'context' && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Context Size Management
            </h2>

            <div className="flex items-center gap-2 p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
              <span className="text-xs text-[var(--color-text-secondary)]">
                Last estimate:
              </span>
              <span className="text-sm font-mono text-[var(--color-text-primary)]">
                ~{lastTokenEstimate.toLocaleString()} tokens
              </span>
              <span className="text-xs text-[var(--color-text-secondary)] ml-auto">
                /{context.maxTokens.toLocaleString()}
              </span>
            </div>

            <SliderField
              label="Max Context Tokens"
              value={context.maxTokens}
              min={1024}
              max={200000}
              step={512}
              onChange={(v) => setContext({ maxTokens: v })}
              hint="Total token budget for the prompt"
              helpTip="The total number of tokens your AI provider will see per request — chat history, character card, world info, and system prompt combined. Set this to match your model's actual context window. Going over causes older messages to be trimmed. Check your provider's docs for the correct value."
            />

            <SliderField
              label="Response Reserve"
              value={context.responseReserve}
              min={128}
              max={8192}
              step={64}
              onChange={(v) => setContext({ responseReserve: v })}
              hint="Tokens held back for the AI response"
              helpTip="Tokens reserved exclusively for the AI's reply. This is subtracted from Max Context before fitting history. If your Max Response Tokens is 1000, set this to at least 1000 so the AI always has room to write a full response without being cut off mid-sentence."
            />

            <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={context.tokenAware}
                onChange={(e) => setContext({ tokenAware: e.target.checked })}
                className="accent-[var(--color-primary)]"
              />
              Fill context to token budget
            </label>

            {!context.tokenAware && (
              <SliderField
                label="Message Count"
                value={context.messageCount}
                min={5}
                max={200}
                step={1}
                onChange={(v) => setContext({ messageCount: v })}
                hint="Fixed number of recent messages to include"
              />
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyProviderDefaults(activeProvider)}
            >
              Use {activeProvider} defaults
            </Button>
          </section>
        )}

        {tab === 'instruct' && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Instruct Mode
            </h2>

            <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={instruct.enabled}
                onChange={(e) => setInstruct({ enabled: e.target.checked })}
                className="accent-[var(--color-primary)]"
              />
              Enable instruct mode (text-completion formatting)
            </label>

            <p className="text-xs text-[var(--color-text-secondary)]">
              When enabled, chat messages are flattened into a single prompt
              using the chosen template. Best for local text-completion models.
            </p>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Template
              </label>
              <select
                value={instruct.templateId}
                onChange={(e) => setInstruct({ templateId: e.target.value })}
                disabled={!instruct.enabled}
                className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:opacity-50"
              >
                {INSTRUCT_TEMPLATES.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {
                  INSTRUCT_TEMPLATES.find((t) => t.id === instruct.templateId)
                    ?.description
                }
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Extra Stop Strings (one per line)
              </label>
              <TextArea
                value={instruct.extraStopStrings.join('\n')}
                onChange={(e) =>
                  setInstruct({
                    extraStopStrings: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                disabled={!instruct.enabled}
                rows={3}
              />
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Added on top of the template's built-in stop strings.
              </p>
            </div>

            {/* Phase 10.3: Completion Mode */}
            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                Completion Mode
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'chat' as const, label: 'Chat' },
                  { value: 'text' as const, label: 'Text' },
                ]).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setInstruct({ completionMode: opt.value });
                      // Text mode requires instruct formatting
                      if (opt.value === 'text' && !instruct.enabled) {
                        setInstruct({ enabled: true, completionMode: opt.value });
                      }
                    }}
                    className={`p-2.5 rounded-lg text-center text-xs font-medium transition-all ${
                      instruct.completionMode === opt.value
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
                {instruct.completionMode === 'text'
                  ? 'Sends a single prompt string to the text completion endpoint. Best for local models (llama.cpp, KoboldCpp).'
                  : 'Sends a messages array to the chat completion endpoint. Works with all cloud providers.'}
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
  helpTip?: string;
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  helpTip,
}: SliderFieldProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium text-[var(--color-text-secondary)]">
            {label}
          </label>
          {helpTip && <HelpTip tip={helpTip} />}
        </div>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
          className="w-20 px-2 py-1 text-sm text-right bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
        />
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[var(--color-primary)]"
      />
      {hint && (
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{hint}</p>
      )}
    </div>
  );
}
