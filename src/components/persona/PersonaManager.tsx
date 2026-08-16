import { useState } from 'react';
import { Plus, Edit2, Trash2, Star, User, Check } from 'lucide-react';
import { usePersonaStore, type Persona } from '../../stores/personaStore';
import { Modal, Button, ConfirmDialog } from '../ui';
import { PersonaForm } from './PersonaForm';

interface PersonaManagerProps {
  isOpen: boolean;
  onClose: () => void;
  initialPersona?: { name?: string; description?: string } | null;
  /** When provided, the list's "New Persona" button launches the AI wizard
   *  (owned by the host) instead of the inline blank form. The inline form
   *  is still reached via the wizard's "Use the simple form instead" escape
   *  hatch and by editing an existing persona. */
  onCreateWithWizard?: () => void;
}

export function PersonaManager({ isOpen, onClose, initialPersona, onCreateWithWizard }: PersonaManagerProps) {
  const {
    personas,
    activePersonaId,
    deletePersona,
    setActivePersona,
    setDefaultPersona,
  } = usePersonaStore();

  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [isCreating, setIsCreating] = useState(!!initialPersona);
  const [confirmDelete, setConfirmDelete] = useState<Persona | null>(null);

  const handleCreate = () => {
    if (onCreateWithWizard) {
      onCreateWithWizard();
      return;
    }
    setEditingPersona(null);
    setIsCreating(true);
  };

  const handleEdit = (persona: Persona) => {
    setEditingPersona(persona);
    setIsCreating(true);
  };

  const handleFormClose = () => {
    setEditingPersona(null);
    setIsCreating(false);
  };

  // Reset internal form state whenever the manager modal is closed, so
  // reopening it always lands on the persona list — not stale form contents
  // from a previous edit session that the user dismissed via the X button.
  const handleManagerClose = () => {
    setEditingPersona(null);
    setIsCreating(false);
    onClose();
  };

  const handleDelete = (persona: Persona) => {
    setConfirmDelete(persona);
  };

  const confirmDeleteAction = () => {
    if (confirmDelete) {
      deletePersona(confirmDelete.id);
      setConfirmDelete(null);
    }
  };

  const title = isCreating
    ? editingPersona
      ? `Edit ${editingPersona.name}`
      : 'Create Persona'
    : 'Personas';

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleManagerClose} title={title} size="lg">
        {isCreating ? (
          <PersonaForm
            persona={editingPersona}
            onClose={handleFormClose}
            initialValues={!editingPersona ? initialPersona || undefined : undefined}
          />
        ) : (
          <div className="space-y-3">
            {personas.length === 0 ? (
              <div className="text-center py-10">
                <User
                  size={48}
                  className="mx-auto text-[var(--color-text-secondary)] mb-3"
                />
                <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                  No personas yet
                </h3>
                <p className="text-xs text-[var(--color-text-secondary)] mb-4">
                  Create a persona to define who you are in conversations.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {personas.map((persona) => {
                  const isActive = persona.id === activePersonaId;
                  return (
                    <li
                      key={persona.id}
                      className={`
                        flex items-center gap-3 p-3 rounded-lg border transition-colors
                        ${
                          isActive
                            ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]'
                            : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
                        }
                      `}
                    >
                      {/* Avatar */}
                      <div className="w-12 h-12 rounded-full overflow-hidden bg-[var(--color-bg-primary)] flex items-center justify-center flex-shrink-0">
                        {persona.avatarDataUrl ? (
                          <img
                            src={persona.avatarDataUrl}
                            alt={persona.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <User
                            size={24}
                            className="text-[var(--color-text-secondary)]"
                          />
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                            {persona.name}
                          </p>
                          {persona.isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-medium">
                              DEFAULT
                            </span>
                          )}
                          {isActive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        {persona.description && (
                          <p className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">
                            {persona.description}
                          </p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {!isActive && (
                          <button
                            onClick={() => setActivePersona(persona.id)}
                            className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10"
                            title="Set as active persona"
                          >
                            <Check size={16} />
                          </button>
                        )}
                        <button
                          onClick={() =>
                            setDefaultPersona(persona.isDefault ? null : persona.id)
                          }
                          className={`p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] ${
                            persona.isDefault
                              ? 'text-yellow-400'
                              : 'text-[var(--color-text-secondary)] hover:text-yellow-400'
                          }`}
                          title={
                            persona.isDefault ? 'Unset as default' : 'Set as default'
                          }
                        >
                          <Star
                            size={16}
                            fill={persona.isDefault ? 'currentColor' : 'none'}
                          />
                        </button>
                        <button
                          onClick={() => handleEdit(persona)}
                          className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                          title="Edit persona"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => handleDelete(persona)}
                          className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10"
                          title="Delete persona"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <Button
              variant="primary"
              onClick={handleCreate}
              className="w-full"
            >
              <Plus size={18} className="mr-2" />
              New Persona
            </Button>
          </div>
        )}
      </Modal>

      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={confirmDeleteAction}
          title="Delete Persona"
          message={`Delete persona "${confirmDelete.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
        />
      )}
    </>
  );
}
