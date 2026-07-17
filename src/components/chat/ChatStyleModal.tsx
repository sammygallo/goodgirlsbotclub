import { Palette } from 'lucide-react';
import { useGenerationStore } from '../../stores/generationStore';
import { usePromptTemplateStore } from '../../stores/promptTemplateStore';
import { QUICK_CHAT_STYLES } from '../../utils/chatStyles';
import { Modal } from '../ui';

interface ChatStyleModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Chat file name — same key author's notes and chat lorebooks use. */
  chatFile: string;
  /** Active character avatar — used to show what "Default" resolves to. */
  characterAvatar?: string;
}

const selectClass =
  'w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]';

/**
 * Per-chat style picker. A chat session can carry its own prompt template
 * (HYPERCODE / writing style) and generation preset (sampler). Precedence is
 * chat > character link > global settings, applied transiently while the
 * chat is open — switching chats switches styles automatically.
 */
export function ChatStyleModal({ isOpen, onClose, chatFile, characterAvatar }: ChatStyleModalProps) {
  const templates = usePromptTemplateStore((s) => s.templates);
  const chatTemplateId = usePromptTemplateStore((s) => s.linkedTemplateByChatFile[chatFile]);
  const charTemplateId = usePromptTemplateStore((s) =>
    characterAvatar ? s.linkedTemplateByAvatar[characterAvatar] : undefined
  );
  const setChatLinkedTemplate = usePromptTemplateStore((s) => s.setChatLinkedTemplate);

  const presets = useGenerationStore((s) => s.presets);
  const chatPresetId = useGenerationStore((s) => s.linkedPresetByChatFile[chatFile]);
  const charPresetId = useGenerationStore((s) =>
    characterAvatar ? s.linkedPresetByAvatar[characterAvatar] : undefined
  );
  const setChatLinkedPreset = useGenerationStore((s) => s.setChatLinkedPreset);

  const charTemplate = charTemplateId ? templates.find((t) => t.id === charTemplateId) : undefined;
  const charPreset = charPresetId ? presets.find((p) => p.id === charPresetId) : undefined;

  const effectivePreset = presets.find((p) => p.id === (chatPresetId ?? charPresetId));

  const applyQuickStyle = (styleId: string) => {
    const style = QUICK_CHAT_STYLES.find((s) => s.id === styleId);
    if (!style) return;
    const templateId = usePromptTemplateStore.getState().ensureTemplate(style.name, style.mainPrompt);
    const presetId = useGenerationStore.getState().ensurePreset(style.name, style.sampler);
    setChatLinkedTemplate(chatFile, templateId);
    setChatLinkedPreset(chatFile, presetId);
  };

  const quickStyleActive = (styleName: string): boolean => {
    const t = chatTemplateId ? templates.find((x) => x.id === chatTemplateId) : undefined;
    const p = chatPresetId ? presets.find((x) => x.id === chatPresetId) : undefined;
    return t?.name === styleName && p?.name === styleName;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Chat Style" size="md">
      <div className="space-y-4">
        <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
          <Palette size={14} className="shrink-0 mt-0.5" />
          <p>
            Give this chat its own writing style and generation settings. Other
            chats with this character are unaffected — switching chats switches
            styles automatically.
          </p>
        </div>

        {/* Quick styles */}
        <div>
          <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
            Quick styles
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {QUICK_CHAT_STYLES.map((style) => {
              const active = quickStyleActive(style.name);
              return (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => applyQuickStyle(style.id)}
                  className={`text-left px-3 py-2 rounded-lg border transition-colors
                    ${active
                      ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40'
                      : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] hover:border-[var(--color-text-secondary)]/40'
                    }`}
                >
                  <span className="block text-sm text-[var(--color-text-primary)]">
                    {style.emoji} {style.name}
                  </span>
                  <span className="block text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {style.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Prompt style */}
        <div>
          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
            Prompt style (HYPERCODE / template)
          </label>
          <select
            value={chatTemplateId ?? ''}
            onChange={(e) => setChatLinkedTemplate(chatFile, e.target.value || null)}
            className={selectClass}
          >
            <option value="">
              Default — {charTemplate ? `${charTemplate.name} (character)` : 'global settings'}
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        {/* Generation preset */}
        <div>
          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
            Generation preset
          </label>
          <select
            value={chatPresetId ?? ''}
            onChange={(e) => setChatLinkedPreset(chatFile, e.target.value || null)}
            className={selectClass}
          >
            <option value="">
              Default — {charPreset ? `${charPreset.name} (character)` : 'global settings'}
            </option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {effectivePreset && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              temp {effectivePreset.sampler.temperature} · max {effectivePreset.sampler.maxTokens} tokens
            </p>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-secondary)]">
          Create more styles in Settings → Prompt Templates (HYPERCODE builder)
          and Settings → Generation.
        </p>
      </div>
    </Modal>
  );
}
