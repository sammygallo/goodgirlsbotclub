import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, MessageSquare, Download, Upload, Pencil, Check, X } from 'lucide-react';
import { Modal, ConfirmDialog } from '../ui';
import { useChatStore } from '../../stores/chatStore';
import { useCharacterStore } from '../../stores/characterStore';
import { api } from '../../api/client';

interface ChatHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChatHistoryPanel({ isOpen, onClose }: ChatHistoryPanelProps) {
  const { selectedCharacter } = useCharacterStore();
  const { chatFiles, currentChatFile, fetchChatFiles, loadChat, startNewChat, deleteChat, renameChat, importChat } =
    useChatStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && selectedCharacter) {
      fetchChatFiles(selectedCharacter.avatar);
    }
  }, [isOpen, selectedCharacter, fetchChatFiles]);

  const handleLoadChat = async (fileName: string) => {
    if (!selectedCharacter || renamingFile) return;
    await loadChat(selectedCharacter.avatar, fileName);
    onClose();
  };

  const handleNewChat = async () => {
    if (!selectedCharacter) return;
    await startNewChat(selectedCharacter);
    onClose();
  };

  const handleDeleteChat = async (fileName: string) => {
    if (!selectedCharacter) return;
    await deleteChat(selectedCharacter.avatar, fileName);
  };

  const handleExportChat = async (fileName: string) => {
    if (!selectedCharacter) return;
    setExportError(null);
    try {
      const { messages } = await api.getChatMessages(selectedCharacter.avatar, fileName);
      if (!messages.length) {
        setExportError('This chat has no messages to export.');
        return;
      }
      const jsonl = messages.map((entry) => JSON.stringify(entry)).join('\n');
      const blob = new Blob([jsonl], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Export] Failed:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const handleStartRename = (fileName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingFile(fileName);
    setRenameValue(fileName);
  };

  const handleConfirmRename = async () => {
    if (!selectedCharacter || !renamingFile || !renameValue.trim() || renameValue === renamingFile) {
      setRenamingFile(null);
      return;
    }
    await renameChat(selectedCharacter.avatar, renamingFile, renameValue.trim());
    setRenamingFile(null);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedCharacter || !e.target.files?.length) return;
    const file = e.target.files[0];
    setImportError(null);
    setImporting(true);
    try {
      await importChat(selectedCharacter.avatar, selectedCharacter.name, file);
      const storeError = useChatStore.getState().error;
      if (storeError) setImportError(storeError);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  if (!selectedCharacter) return null;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Chat History" size="md">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={handleNewChat}
              className="flex-1 flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity"
            >
              <Plus size={18} />
              <span className="font-medium">New Chat</span>
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 px-3 py-3 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
              title="Import chat transcript (.jsonl or .json)"
            >
              <Upload size={18} />
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".jsonl,.json,application/json"
              className="hidden"
              onChange={handleImport}
            />
          </div>

          {exportError && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              Export failed: {exportError}
            </div>
          )}

          {importError && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              Import failed: {importError}
            </div>
          )}

          {chatFiles.length === 0 ? (
            <div className="text-center py-8 text-sm text-[var(--color-text-secondary)]">
              No saved chats yet
            </div>
          ) : (
            <div className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
              {chatFiles.map((chat) => {
                const isActive = chat.fileName === currentChatFile;
                const isRenaming = renamingFile === chat.fileName;
                return (
                  <div
                    key={chat.fileName}
                    className={`
                      group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors
                      ${isActive
                        ? 'bg-[var(--color-primary)]/20 border border-[var(--color-primary)]/40'
                        : 'hover:bg-[var(--color-bg-tertiary)]'}
                    `}
                  >
                    {isRenaming ? (
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        <MessageSquare size={16} className="text-[var(--color-text-secondary)] flex-shrink-0" />
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirmRename();
                            if (e.key === 'Escape') setRenamingFile(null);
                          }}
                          className="flex-1 min-w-0 text-sm bg-[var(--color-bg-primary)] border border-[var(--color-primary)] rounded px-2 py-0.5 outline-none"
                        />
                        <button
                          onClick={handleConfirmRename}
                          className="p-1 rounded text-green-400 hover:bg-green-500/20"
                          title="Confirm rename"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setRenamingFile(null)}
                          className="p-1 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => handleLoadChat(chat.fileName)}
                          className="flex-1 flex items-center gap-3 min-w-0 text-left"
                        >
                          <MessageSquare
                            size={16}
                            className="text-[var(--color-text-secondary)] flex-shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                              {chat.fileName}
                            </div>
                            {chat.lastMessage && (
                              <div className="text-xs text-[var(--color-text-secondary)] truncate">
                                {chat.lastMessage}
                              </div>
                            )}
                          </div>
                        </button>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => handleStartRename(chat.fileName, e)}
                            className="p-1.5 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                            title="Rename chat"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => handleExportChat(chat.fileName)}
                            className="p-1.5 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                            title="Export as JSONL"
                          >
                            <Download size={14} />
                          </button>
                          <button
                            onClick={() => setConfirmDelete(chat.fileName)}
                            className="p-1.5 rounded hover:bg-red-500/20 text-[var(--color-text-secondary)] hover:text-red-400"
                            title="Delete chat"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDeleteChat(confirmDelete)}
        title="Delete Chat"
        message={`Delete "${confirmDelete}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </>
  );
}
