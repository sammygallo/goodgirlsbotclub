import { useEffect } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, Database, Edit3, FileText, Gauge, Image, Languages, Loader2, MessageSquare, Mic, Palette, Plus, Replace, Shield, Sliders, Sparkles, Trash2, UserPlus, Users, Volume2, Zap } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useAuthStore } from '../../stores/authStore';
import { hasPermission } from '../../utils/permissions';
// PROVIDERS moved to AISettingsPage
import { Button } from '../ui';
import { SPEECH_LANGUAGES } from '../../hooks/speechLanguage';
import { type EnterToSendMode } from '../../hooks/displayPreferences';
import { useDisplayPreferencesStore } from '../../stores/displayPreferencesStore';
import { useSpeechPreferencesStore } from '../../stores/speechPreferencesStore';
import {
  THEME_PRESETS,
  PRESET_SWATCHES,
  type ThemePreset,
} from '../../hooks/themePreferences';
import { useThemeStore } from '../../stores/themeStore';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis';
import { useTranslateStore } from '../../stores/translateStore';
import { TRANSLATE_PROVIDERS, TRANSLATE_LANGUAGES, type TranslateProvider } from '../../api/translateApi';
export function SettingsPage(_props?: { params?: Record<string, string> }) {
  const { pushPage, goBack } = useSettingsPanelStore();
  const { currentUser } = useAuthStore();
  const canManageInvitations = hasPermission(currentUser, 'admin:invitations:manage');
  const canManageUsers = hasPermission(currentUser, 'admin:users:view');
  const canManageGroups = hasPermission(currentUser, 'admin:groups:manage');
  const {
    isLoading,
    error,
    successMessage,
    fetchSecrets,
    fetchSettings,
    clearMessages,
  } = useSettingsStore();

  const { isSupported: isSpeechSupported } = useSpeechRecognition();

  // Phase 7.4 + 6.1: Theme preferences (server-synced via themeStore)
  const themeMode = useThemeStore(s => s.mode);
  const activePreset = useThemeStore(s => s.activePreset);
  const customThemes = useThemeStore(s => s.customThemes);
  const setThemeMode = useThemeStore(s => s.setMode);
  const setThemePreset = useThemeStore(s => s.setPreset);
  const deleteCustomTheme = useThemeStore(s => s.deleteCustomTheme);
  // Derived: built-in preset name for seeding the theme editor's base colors.
  const themePresetVal = (activePreset.startsWith('custom:') ? 'cyberpunk' : activePreset) as ThemePreset;

  // Display preferences (server-synced)
  const layoutMode = useDisplayPreferencesStore(s => s.chatLayoutMode);
  const avatarShapePref = useDisplayPreferencesStore(s => s.avatarShape);
  const fontSizePref = useDisplayPreferencesStore(s => s.chatFontSize);
  const chatWidthPref = useDisplayPreferencesStore(s => s.chatMaxWidth);
  const vnModeOn = useDisplayPreferencesStore(s => s.vnMode);
  const standardizeFmt = useDisplayPreferencesStore(s => s.standardizeMessageFormatting);
  const enterToSendMode = useDisplayPreferencesStore(s => s.enterToSendMode);
  const storeSetLayoutMode = useDisplayPreferencesStore(s => s.setChatLayoutMode);
  const storeSetAvatarShape = useDisplayPreferencesStore(s => s.setAvatarShape);
  const storeSetFontSize = useDisplayPreferencesStore(s => s.setChatFontSize);
  const storeSetChatWidth = useDisplayPreferencesStore(s => s.setChatMaxWidth);
  const storeSetVnMode = useDisplayPreferencesStore(s => s.setVnMode);
  const storeSetStandardize = useDisplayPreferencesStore(s => s.setStandardizeMessageFormatting);
  const storeSetEnterToSend = useDisplayPreferencesStore(s => s.setEnterToSendMode);

  // Speech & TTS preferences (server-synced)
  const { isSupported: isTtsSupported, voices: ttsVoices } = useSpeechSynthesis();
  const speechLang = useSpeechPreferencesStore(s => s.speechLang);
  const ttsVoiceUri = useSpeechPreferencesStore(s => s.ttsVoiceUri);
  const ttsRate = useSpeechPreferencesStore(s => s.ttsRate);
  const ttsPitch = useSpeechPreferencesStore(s => s.ttsPitch);
  const ttsAutoReadOn = useSpeechPreferencesStore(s => s.ttsAutoRead);
  const storeSetSpeechLang = useSpeechPreferencesStore(s => s.setSpeechLang);
  const storeSetTtsVoice = useSpeechPreferencesStore(s => s.setTtsVoiceUri);
  const storeSetTtsRate = useSpeechPreferencesStore(s => s.setTtsRate);
  const storeSetTtsPitch = useSpeechPreferencesStore(s => s.setTtsPitch);
  const storeSetTtsAutoRead = useSpeechPreferencesStore(s => s.setTtsAutoRead);

  // Phase 7.2: Translation settings
  const translateProvider = useTranslateStore((s) => s.provider);
  const translateLang = useTranslateStore((s) => s.targetLang);
  const setTranslateProvider = useTranslateStore((s) => s.setProvider);
  const setTranslateLang = useTranslateStore((s) => s.setTargetLang);

  useEffect(() => {
    fetchSecrets();
    fetchSettings();
  }, [fetchSecrets, fetchSettings]);

  useEffect(() => {
    if (successMessage || error) {
      const timer = setTimeout(clearMessages, 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage, error, clearMessages]);

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
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
          Settings
        </h1>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {/* Status Messages */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
        {successMessage && (
          <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">{successMessage}</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--color-primary)]" />
          </div>
        ) : (
          <>
            {/* AI Settings Link */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('ai')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Zap size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">AI Settings</p>
                  <p className="text-xs text-[var(--color-text-secondary)] truncate">
                    Provider, model, API keys, connection profiles
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* --- AI settings content moved to AISettingsPage --- */}

            {/* Generation Settings Link */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('generation')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Sliders size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Generation Settings
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Samplers, prompts, context, and instruct mode
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Usage Link */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('usage')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Gauge size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Usage
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Token spend, budget, and per-turn costs
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Prompt Templates Link */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('prompts')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <FileText size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Prompt Templates
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Save and share full prompt setups
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* World Info Link */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('worldinfo')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <BookOpen size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    World Info
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Lorebooks with keyword-triggered context injection
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Regex Scripts Link (Phase 8.2) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('regex')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Replace size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Regex Scripts
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Find/replace patterns for message processing
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Invitations */}
            {canManageInvitations && (
              <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
                <button
                  onClick={() => pushPage('invitations')}
                  className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                    <UserPlus size={20} className="text-[var(--color-primary)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      Invitations
                    </h3>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Create invite links for new users
                    </p>
                  </div>
                  <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
                </button>
              </section>
            )}

            {/* Users (Phase 3.1) */}
            {canManageUsers && (
              <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
                <button
                  onClick={() => pushPage('users')}
                  className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                    <Users size={20} className="text-[var(--color-primary)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      Users
                    </h3>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Manage accounts, groups, and access
                    </p>
                  </div>
                  <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
                </button>
              </section>
            )}

            {/* Permission Groups (owner-only) */}
            {canManageGroups && (
              <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
                <button
                  onClick={() => pushPage('permission-groups')}
                  className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                    <Shield size={20} className="text-[var(--color-primary)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      Permission Groups
                    </h3>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Create custom roles with fine-grained permissions
                    </p>
                  </div>
                  <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
                </button>
              </section>
            )}

            {/* Character Management */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('characters')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Image size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Character Management
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    View, edit, and manage character ownership
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Quick Replies (Phase 10.2) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('quickreplies')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Zap size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Quick Replies</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Saved prompt shortcuts
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Extensions (Phase 7.1) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('extensions')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <MessageSquare size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Extensions</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    TTS, image gen, translation, summarization
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Image Gallery (Phase 7.3) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('gallery')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Image size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Image Gallery</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Browse previously generated images
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Data Bank (Phase 8.5) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => pushPage('databank')}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Database size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Data Bank</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    RAG — upload documents and inject relevant chunks into context
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Appearance (Phase 7.4 + 6.1) */}
            <section id="appearance-section" className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
              <div className="flex items-center gap-2 mb-3">
                <Palette size={16} className="text-[var(--color-text-secondary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Appearance
                </h2>
              </div>

              {/* Theme Mode */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                Theme
              </label>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {([
                  { value: 'light' as const, label: 'Light' },
                  { value: 'dark' as const, label: 'Dark' },
                  { value: 'auto' as const, label: 'Auto' },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setThemeMode(opt.value)}
                    className={`p-2.5 rounded-lg text-center text-xs font-medium transition-all ${
                      themeMode === opt.value
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-zinc-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Accent Color — Built-in Presets */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                Accent Color
              </label>
              <div className="flex gap-3 mb-4">
                {THEME_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setThemePreset(preset)}
                    className={`w-8 h-8 rounded-full transition-all ${
                      activePreset === preset
                        ? 'ring-2 ring-offset-2 ring-offset-[var(--color-bg-secondary)] ring-[var(--color-primary)] scale-110'
                        : 'hover:scale-110'
                    }`}
                    style={{
                      ...(PRESET_SWATCHES[preset].includes('gradient')
                        ? { background: PRESET_SWATCHES[preset] }
                        : { backgroundColor: PRESET_SWATCHES[preset] }),
                    }}
                    title={preset.charAt(0).toUpperCase() + preset.slice(1)}
                    aria-label={`${preset} theme`}
                  />
                ))}
              </div>

              {/* Custom Themes */}
              {customThemes.length > 0 && (
                <>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                    Custom Themes
                  </label>
                  <div className="space-y-2 mb-4">
                    {customThemes.map((ct) => (
                      <div
                        key={ct.id}
                        className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all ${
                          activePreset === `custom:${ct.id}`
                            ? 'bg-[var(--color-bg-tertiary)] ring-1 ring-[var(--color-primary)]'
                            : 'hover:bg-[var(--color-bg-tertiary)]'
                        }`}
                        onClick={() => setThemePreset(`custom:${ct.id}`)}
                      >
                        {/* Mini swatch preview */}
                        <div className="flex gap-0.5 shrink-0">
                          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: ct.dark.primary }} />
                          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: ct.dark.bgPrimary }} />
                          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: ct.dark.textPrimary }} />
                        </div>
                        <span className="text-xs text-[var(--color-text-primary)] flex-1 truncate">{ct.name}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); pushPage('themes', { id: ct.id }); }}
                          className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                          title="Edit"
                        >
                          <Edit3 size={14} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCustomTheme(ct.id);
                          }}
                          className="p-1 text-[var(--color-text-secondary)] hover:text-red-400"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Create custom theme */}
              <button
                onClick={() => pushPage('themes', { from: themePresetVal })}
                className="flex items-center gap-2 text-xs text-[var(--color-primary)] hover:underline"
              >
                <Plus size={14} />
                Create Custom Theme
              </button>
            </section>

            {/* Chat Display (Phase 7.3) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
              <div className="flex items-center gap-2 mb-3">
                <MessageSquare size={16} className="text-[var(--color-text-secondary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Chat Display
                </h2>
              </div>

              {/* Layout Mode */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                Layout
              </label>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {([
                  { value: 'bubbles' as const, label: 'Bubbles', desc: 'Rounded colored bubbles' },
                  { value: 'flat' as const, label: 'Flat', desc: 'Full-width, dividers' },
                  { value: 'document' as const, label: 'Document', desc: 'Compact, inline names' },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => storeSetLayoutMode(opt.value)}
                    className={`p-2.5 rounded-lg text-center transition-all ${
                      layoutMode === opt.value
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-zinc-700'
                    }`}
                  >
                    <span className="text-xs font-medium block">{opt.label}</span>
                    <span className={`text-[10px] block mt-0.5 ${
                      layoutMode === opt.value ? 'text-white/70' : 'text-[var(--color-text-secondary)]'
                    }`}>
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>

              {/* Avatar Shape */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                Avatar Shape
              </label>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {([
                  { value: 'circle' as const, label: 'Circle', cls: 'rounded-full' },
                  { value: 'square' as const, label: 'Square', cls: 'rounded-none' },
                  { value: 'rounded-square' as const, label: 'Rounded', cls: 'rounded-md' },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => storeSetAvatarShape(opt.value)}
                    className={`flex items-center justify-center gap-2 p-2.5 rounded-lg transition-all ${
                      avatarShapePref === opt.value
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-zinc-700'
                    }`}
                  >
                    <span className={`w-4 h-4 ${opt.cls} ${
                      avatarShapePref === opt.value ? 'bg-white/80' : 'bg-[var(--color-text-secondary)]'
                    }`} />
                    <span className="text-xs font-medium">{opt.label}</span>
                  </button>
                ))}
              </div>

              {/* Font Size */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                Font Size: {fontSizePref}px
              </label>
              <input
                type="range"
                min={12}
                max={20}
                step={1}
                value={fontSizePref}
                onChange={(e) => storeSetFontSize(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)] mb-1"
              />
              <p className="text-[var(--color-text-secondary)] mb-4" style={{ fontSize: `${fontSizePref}px` }}>
                Sample text Aa
              </p>

              {/* Chat Width */}
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                Message Width: {chatWidthPref}%
                {layoutMode !== 'bubbles' && (
                  <span className="ml-1 text-[var(--color-text-secondary)]">(bubbles only)</span>
                )}
              </label>
              <input
                type="range"
                min={60}
                max={100}
                step={5}
                value={chatWidthPref}
                onChange={(e) => storeSetChatWidth(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />

              {/* Standardize Message Formatting */}
              <div className="flex items-center justify-between mt-4">
                <div className="flex-1 min-w-0 pr-3">
                  <p className="text-xs font-medium text-[var(--color-text-primary)]">Standardize Message Formatting</p>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    Normalize curly quotes, typewriter dashes, and highlight dialogue at display time. Original messages unchanged.
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={standardizeFmt}
                  onClick={() => storeSetStandardize(!standardizeFmt)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                    standardizeFmt ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      standardizeFmt ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Enter Key Behavior */}
              <div className="mt-4">
                <p className="text-xs font-medium text-[var(--color-text-primary)]">Enter Key Sends Message</p>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 mb-2">
                  Auto: send on desktop, newline on phones/tablets. Always: Enter sends everywhere (Shift+Enter for newline). Never: Enter is always a newline; tap the send button to send.
                </p>
                <select
                  value={enterToSendMode}
                  onChange={(e) => storeSetEnterToSend(e.target.value as EnterToSendMode)}
                  className="w-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] text-xs rounded px-2 py-1.5 border border-[var(--color-border)]"
                >
                  <option value="auto">Auto (device-aware)</option>
                  <option value="always">Always send on Enter</option>
                  <option value="never">Never send on Enter</option>
                </select>
              </div>

              {/* Visual Novel Mode */}
              <div className="flex items-center justify-between mt-4">
                <div>
                  <p className="text-xs font-medium text-[var(--color-text-primary)]">Visual Novel Mode</p>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    Full-screen sprite behind chat with semi-transparent message overlay
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={vnModeOn}
                  onClick={() => storeSetVnMode(!vnModeOn)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                    vnModeOn ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      vnModeOn ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </section>

            {/* Voice Input Language */}
            {isSpeechSupported && (
              <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
                <div className="flex items-center gap-2 mb-2">
                  <Mic size={16} className="text-[var(--color-text-secondary)]" />
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Voice Input Language
                  </h2>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                  Language used for speech-to-text dictation in the chat input.
                </p>
                <select
                  value={speechLang}
                  onChange={(e) => storeSetSpeechLang(e.target.value)}
                  className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                >
                  {SPEECH_LANGUAGES.some((l) => l.code === speechLang) ? null : (
                    <option value={speechLang}>{speechLang} (current)</option>
                  )}
                  {SPEECH_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label} ({lang.code})
                    </option>
                  ))}
                </select>
              </section>
            )}

            {/* Text-to-Speech (Phase 6.3) */}
            {isTtsSupported && (
              <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
                <div className="flex items-center gap-2 mb-2">
                  <Volume2 size={16} className="text-[var(--color-text-secondary)]" />
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Text-to-Speech
                  </h2>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                  Voice used when reading AI messages aloud.
                </p>

                {/* Voice picker */}
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                  Voice
                </label>
                <select
                  value={ttsVoiceUri}
                  onChange={(e) => storeSetTtsVoice(e.target.value)}
                  className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] mb-4"
                >
                  <option value="">System default</option>
                  {ttsVoices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>

                {/* Rate slider */}
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                  Rate: {ttsRate.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={ttsRate}
                  onChange={(e) => storeSetTtsRate(parseFloat(e.target.value))}
                  className="w-full mb-4 accent-[var(--color-primary)]"
                />

                {/* Pitch slider */}
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                  Pitch: {ttsPitch.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={ttsPitch}
                  onChange={(e) => storeSetTtsPitch(parseFloat(e.target.value))}
                  className="w-full mb-4 accent-[var(--color-primary)]"
                />

                {/* Auto-read toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-[var(--color-text-primary)]">Auto-read new messages</p>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Automatically read each new AI message aloud
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={ttsAutoReadOn}
                    onClick={() => storeSetTtsAutoRead(!ttsAutoReadOn)}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                      ttsAutoReadOn ? 'bg-[var(--color-primary)]' : 'bg-zinc-600'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                        ttsAutoReadOn ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </section>
            )}

            {/* Translation (Phase 7.2) */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
              <div className="flex items-center gap-2 mb-3">
                <Languages size={16} className="text-[var(--color-text-secondary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  Translation
                </h2>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                Per-message translate button on AI messages. Google and Bing work without extra config.
              </p>

              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                Provider
              </label>
              <select
                value={translateProvider}
                onChange={(e) => setTranslateProvider(e.target.value as TranslateProvider)}
                className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] mb-4"
              >
                {TRANSLATE_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.free ? '' : ' (requires config)'}
                  </option>
                ))}
              </select>

              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                Target Language
              </label>
              <select
                value={translateLang}
                onChange={(e) => setTranslateLang(e.target.value)}
                className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              >
                {TRANSLATE_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </section>

            {/* Replay Walkthrough */}
            <section className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
              <button
                onClick={() => {
                  useOnboardingStore.getState().start();
                  useSettingsPanelStore.getState().close();
                }}
                className="w-full flex items-center gap-3 p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center">
                  <Sparkles size={20} className="text-[var(--color-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">Replay Walkthrough</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    Review the getting started guide
                  </p>
                </div>
                <ChevronRight size={20} className="text-[var(--color-text-secondary)]" />
              </button>
            </section>

            {/* Help Text */}
            <section className="text-center py-4">
              <p className="text-xs text-[var(--color-text-secondary)]">
                API keys are stored securely on the server and never exposed to the frontend.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
