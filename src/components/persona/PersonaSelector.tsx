import { useState, useRef, useEffect } from 'react';
import { User, ChevronDown, ChevronUp, Check, Plus, Settings, X } from 'lucide-react';
import { usePersonaStore } from '../../stores/personaStore';
import { PersonaManager } from './PersonaManager';
import { PersonaInterview } from './interview/PersonaInterview';

interface PersonaSelectorProps {
  className?: string;
  /**
   * `icon` (default) is the compact avatar button. `row` is the full-width row the
   * drawer's Personal section uses (E6-S3, D-S9): it shows the active persona's name
   * and its list opens upward, because the row sits at the bottom of the drawer.
   */
  variant?: 'icon' | 'row';
  /**
   * Reports whether a surface this selector launched (the manager, the interview
   * wizard, the simple form) is open. The drawer closes itself once one is up
   * (D-E6S3-1). Pass a stable function: the report is re-sent when its identity changes.
   */
  onSurfaceOpenChange?: (open: boolean) => void;
}

// Stable seed for the escape-hatch create form. A fresh `{}` literal in JSX
// would change identity on every PersonaSelector re-render, and PersonaForm's
// `[persona, initialValues]` effect would then reset every field mid-edit —
// so the reference must be constant across renders.
const CREATE_FORM_SEED = {};

export function PersonaSelector({ className = '', variant = 'icon', onSurfaceOpenChange }: PersonaSelectorProps) {
  const { personas, activePersonaId, setActivePersona, getActivePersona } =
    usePersonaStore();
  const [isOpen, setIsOpen] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [showInterview, setShowInterview] = useState(false);
  // Escape-hatch: the wizard's "Use the simple form instead" opens the plain
  // PersonaForm. Rendered as a fresh create-mode manager (conditional mount,
  // same pattern as Header's convert-to-persona flow) so it lands directly on
  // the blank form rather than the persona list.
  const [showCreateForm, setShowCreateForm] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isRow = variant === 'row';

  const activePersona = getActivePersona();

  const surfaceOpen = showManager || showInterview || showCreateForm;
  useEffect(() => {
    onSurfaceOpenChange?.(surfaceOpen);
  }, [surfaceOpen, onSurfaceOpenChange]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // The list item that was clicked unmounts the moment the list closes, so focus
  // would drop to <body>, and a Modal opened from here would capture no opener
  // to return to. Put focus on the trigger first; it outlives the list.
  const handleManage = () => {
    triggerRef.current?.focus();
    setIsOpen(false);
    setShowManager(true);
  };

  // "New Persona" defaults to the AI interview wizard; the plain form stays
  // reachable via the wizard's "Use the simple form instead" escape hatch.
  const handleCreate = () => {
    triggerRef.current?.focus();
    setIsOpen(false);
    setShowInterview(true);
  };

  const handleSelect = (id: string | null) => {
    triggerRef.current?.focus();
    setActivePersona(id);
    setIsOpen(false);
  };

  // Escape closes the list and nothing behind it: stopping the event here keeps
  // it from reaching the drawer's document-level handler, which would close the
  // whole drawer and leave the list open for when it comes back.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !isOpen) return;
    e.stopPropagation();
    triggerRef.current?.focus();
    setIsOpen(false);
  };

  return (
    <>
      <div ref={dropdownRef} className={`relative ${className}`} onKeyDown={isRow ? handleKeyDown : undefined}>
        {isRow ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]"
            aria-label={`Persona: ${activePersona?.name ?? 'none'}`}
            aria-expanded={isOpen}
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              {activePersona?.avatarDataUrl ? (
                <img src={activePersona.avatarDataUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <User size={14} className="text-[var(--color-text-secondary)]" />
              )}
            </span>
            <span className="flex-1">Persona</span>
            <span className="min-w-0 max-w-[45%] truncate text-xs text-[var(--color-text-secondary)]">
              {activePersona?.name ?? 'None'}
            </span>
            <ChevronUp size={14} className="flex-shrink-0 text-[var(--color-text-secondary)]" />
          </button>
        ) : (
          <button
            ref={triggerRef}
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
            aria-label="Persona selector"
            title={activePersona ? `Persona: ${activePersona.name}` : 'Select persona'}
          >
            <div className="w-7 h-7 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
              {activePersona?.avatarDataUrl ? (
                <img
                  src={activePersona.avatarDataUrl}
                  alt={activePersona.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <User size={16} className="text-[var(--color-text-secondary)]" />
              )}
            </div>
            <ChevronDown size={14} className="text-[var(--color-text-secondary)]" />
          </button>
        )}

        {isOpen && (
          <div
            className={
              isRow
                ? 'absolute bottom-full left-3 right-3 z-10 mb-1 flex max-h-[min(20rem,60dvh)] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl'
                : 'fixed right-2 top-[3.75rem] w-[calc(100vw-1rem)] max-h-[calc(100vh-4.5rem)] sm:absolute sm:right-0 sm:top-full sm:mt-1 sm:w-auto sm:min-w-[240px] sm:max-w-[calc(100vw-1rem)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50 flex flex-col'
            }
          >
            <div className="px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] border-b border-[var(--color-border)] flex-shrink-0">
              Persona
            </div>
            {personas.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-[var(--color-text-secondary)] mb-2">
                  No personas yet
                </p>
                <button
                  onClick={handleCreate}
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  Create your first persona
                </button>
              </div>
            ) : (
              <ul className="flex-1 min-h-0 max-h-[300px] overflow-y-auto">
                {personas.map((persona) => {
                  const isActive = persona.id === activePersonaId;
                  return (
                    <li key={persona.id}>
                      <button
                        onClick={() => handleSelect(persona.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[var(--color-bg-tertiary)] ${
                          isActive ? 'bg-[var(--color-primary)]/10' : ''
                        }`}
                      >
                        <div className="w-8 h-8 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
                          {persona.avatarDataUrl ? (
                            <img
                              src={persona.avatarDataUrl}
                              alt={persona.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <User
                              size={16}
                              className="text-[var(--color-text-secondary)]"
                            />
                          )}
                        </div>
                        <span className="flex-1 text-sm text-[var(--color-text-primary)] truncate">
                          {persona.name}
                        </span>
                        {isActive && (
                          <Check size={16} className="text-[var(--color-primary)]" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="border-t border-[var(--color-border)] flex-shrink-0">
              {activePersonaId && (
                <button
                  onClick={() => handleSelect(null)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border)]"
                >
                  <X size={14} />
                  Clear active persona
                </button>
              )}
              <button
                onClick={handleCreate}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                <Plus size={14} />
                New Persona
              </button>
              <button
                onClick={handleManage}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] border-t border-[var(--color-border)]"
              >
                <Settings size={14} />
                Manage Personas
              </button>
            </div>
          </div>
        )}
      </div>

      <PersonaManager
        isOpen={showManager}
        onClose={() => setShowManager(false)}
        onCreateWithWizard={() => {
          setShowManager(false);
          setShowInterview(true);
        }}
      />

      <PersonaInterview
        isOpen={showInterview}
        onClose={() => setShowInterview(false)}
        onUseSimpleForm={() => {
          setShowInterview(false);
          setShowCreateForm(true);
        }}
      />

      {/* Escape-hatch simple form — a fresh create-mode manager so it opens
          straight on the blank PersonaForm. */}
      {showCreateForm && (
        <PersonaManager isOpen initialPersona={CREATE_FORM_SEED} onClose={() => setShowCreateForm(false)} />
      )}
    </>
  );
}
