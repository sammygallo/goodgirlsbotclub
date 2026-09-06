import { useEffect, useState } from 'react';
import { Loader2, UserCircle } from 'lucide-react';
import { api, type CharacterInfo, type UserHandleSummary } from '../../api/client';
import { useCharacterOwnershipStore } from '../../stores/characterOwnershipStore';
import { Modal, Button, Input } from '../ui';
import { showToastGlobal } from '../ui/Toast';

interface TransferOwnershipModalProps {
  isOpen: boolean;
  onClose: () => void;
  character: CharacterInfo;
  /** Called after a successful transfer so the parent can close itself / refetch. */
  onTransferred?: () => void;
}

export function TransferOwnershipModal({
  isOpen,
  onClose,
  character,
  onTransferred,
}: TransferOwnershipModalProps) {
  const transferOwnership = useCharacterOwnershipStore((s) => s.transferOwnership);
  const [users, setUsers] = useState<UserHandleSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset transient state every open and load users.
  useEffect(() => {
    if (!isOpen) return;
    setFilter('');
    setSelectedHandle(null);
    setConfirming(false);
    setSubmitting(false);
    setLoadError(null);
    setUsers(null);
    let cancelled = false;
    api
      .listUserHandles()
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load users');
          setUsers([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const filtered = (users ?? []).filter((u) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return u.name.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q);
  });

  const selected = users?.find((u) => u.handle === selectedHandle) ?? null;

  const handleConfirm = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await transferOwnership(character.avatar, selected.handle);
      showToastGlobal(`Transferred ${character.name} to ${selected.name}`, 'success');
      onTransferred?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transfer failed';
      showToastGlobal(msg, 'error');
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Transfer Ownership" size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Hand <span className="font-semibold text-[var(--color-text-primary)]">{character.name}</span> off
          to another user. They become the new owner; the character stays global so everyone keeps
          seeing it.
        </p>

        {!confirming && (
          <>
            <Input
              type="text"
              id="transfer-ownership-user-search"
              name="transfer-ownership-user-search"
              autoComplete="off"
              placeholder="Search users…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />

            <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] divide-y divide-[var(--color-border)]">
              {users === null && (
                <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-[var(--color-text-secondary)]">
                  <Loader2 size={14} className="animate-spin" />
                  Loading users…
                </div>
              )}
              {users !== null && filtered.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-[var(--color-text-secondary)]">
                  {loadError ?? (filter ? 'No users match.' : 'No other users on this server.')}
                </p>
              )}
              {filtered.map((u) => {
                const isSelected = u.handle === selectedHandle;
                return (
                  <button
                    key={u.handle}
                    type="button"
                    onClick={() => setSelectedHandle(u.handle)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'bg-[var(--color-primary)]/15'
                        : 'hover:bg-[var(--color-bg-secondary)]'
                    }`}
                  >
                    <UserCircle
                      size={20}
                      className={`shrink-0 ${
                        isSelected
                          ? 'text-[var(--color-primary)]'
                          : 'text-[var(--color-text-secondary)]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                        {u.name}
                      </p>
                      <p className="text-xs text-[var(--color-text-secondary)] truncate">
                        @{u.handle}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setConfirming(true)}
                disabled={!selected}
              >
                Continue
              </Button>
            </div>
          </>
        )}

        {confirming && selected && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-3">
              <p className="text-sm text-[var(--color-text-primary)]">
                Transfer <span className="font-semibold">{character.name}</span> to{' '}
                <span className="font-semibold">{selected.name}</span>{' '}
                <span className="text-[var(--color-text-secondary)]">(@{selected.handle})</span>?
              </p>
              <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
                You will no longer be able to edit this character. They will see it as theirs on
                their next refresh.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={submitting}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
                Confirm Transfer
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
