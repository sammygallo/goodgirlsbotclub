import { create } from 'zustand';
import {
  projectsApi,
  ProjectConflictError,
  type Project,
  type ProjectChatRef,
  type ProjectDeliverableType,
  type ProjectListItem,
  type ProjectPatch,
} from '../api/client';
import { showToastGlobal } from '../components/ui/Toast';

/**
 * Projects ("Works") — productization step 1.
 *
 * Server-authoritative (real /projects rows, not an stm_* settings blob):
 * a Work is a first-class primitive the production pipeline steps build
 * on, so it lives beside chats/characters rather than in the synced
 * client-state stopgap. The store also owns the Works panel UI state,
 * since the panel is the only surface that reads project data.
 */

interface ProjectState {
  // Panel UI
  isOpen: boolean;
  /** Project shown in the detail view; null = list view. */
  openProjectId: string | null;

  // Data
  items: ProjectListItem[];
  selected: Project | null;
  isLoading: boolean;
  error: string | null;

  /** Chat the Works panel wants opened once ChatView finishes switching
   * characters — consumed by ChatView instead of its latest-chat default. */
  pendingChatFile: { avatar: string; fileName: string } | null;

  openPanel: (projectId?: string) => void;
  closePanel: () => void;
  backToList: () => void;

  fetchProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  createProject: (
    name: string,
    deliverableType: ProjectDeliverableType,
    description?: string
  ) => Promise<Project | null>;
  /** Apply a partial update to the selected project with optimistic
   * concurrency. `patchFn` computes the patch from the latest known state
   * so a conflict retry re-derives member arrays instead of clobbering. */
  updateSelected: (
    patchFn: (current: Project) => Omit<ProjectPatch, 'base_ts'>
  ) => Promise<boolean>;
  deleteSelected: () => Promise<boolean>;

  attachCharacter: (avatar: string) => Promise<boolean>;
  detachCharacter: (avatar: string) => Promise<boolean>;
  attachChat: (ref: ProjectChatRef) => Promise<boolean>;
  detachChat: (ref: ProjectChatRef) => Promise<boolean>;

  /** Open a member chat in the main chat view (closes the panel). */
  openChatRef: (ref: ProjectChatRef) => Promise<void>;
  /** Called by ChatView: returns and clears the pending chat for `avatar`. */
  consumePendingChat: (avatar: string) => string | null;
}

const sameRef = (a: ProjectChatRef, b: ProjectChatRef) =>
  a.character_avatar === b.character_avatar && a.file_name === b.file_name;

export const useProjectStore = create<ProjectState>((set, get) => ({
  isOpen: false,
  openProjectId: null,
  items: [],
  selected: null,
  isLoading: false,
  error: null,
  pendingChatFile: null,

  openPanel: (projectId) => {
    set({ isOpen: true, openProjectId: projectId ?? null, error: null });
    if (projectId) {
      void get().openProject(projectId);
    } else {
      void get().fetchProjects();
    }
  },

  closePanel: () => set({ isOpen: false }),

  backToList: () => {
    set({ openProjectId: null, selected: null, error: null });
    void get().fetchProjects();
  },

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const items = await projectsApi.list();
      set({ items, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load works',
      });
    }
  },

  openProject: async (id) => {
    set({ openProjectId: id, isLoading: true, error: null });
    try {
      const selected = await projectsApi.get(id);
      set({ selected, isLoading: false });
    } catch (error) {
      set({
        openProjectId: null,
        selected: null,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load work',
      });
    }
  },

  createProject: async (name, deliverableType, description) => {
    set({ error: null });
    try {
      const created = await projectsApi.create({
        name,
        deliverable_type: deliverableType,
        ...(description ? { description } : {}),
      });
      set({ selected: created, openProjectId: created.id });
      void get().fetchProjects();
      return created;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create work' });
      return null;
    }
  },

  updateSelected: async (patchFn) => {
    const current = get().selected;
    if (!current) return false;
    try {
      const updated = await projectsApi.update(current.id, {
        ...patchFn(current),
        base_ts: current.server_ts,
      });
      set({ selected: updated });
      void get().fetchProjects();
      return true;
    } catch (error) {
      if (error instanceof ProjectConflictError && error.current) {
        // Another device wrote first: adopt its state, re-derive the patch
        // from it, and retry once.
        const winner = error.current;
        set({ selected: winner });
        try {
          const updated = await projectsApi.update(winner.id, {
            ...patchFn(winner),
            base_ts: winner.server_ts,
          });
          set({ selected: updated });
          void get().fetchProjects();
          showToastGlobal('Work was updated on another device — changes merged', 'warning');
          return true;
        } catch {
          showToastGlobal('Failed to save work — it changed on another device', 'error');
          return false;
        }
      }
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to save work',
        'error'
      );
      return false;
    }
  },

  deleteSelected: async () => {
    const current = get().selected;
    if (!current) return false;
    try {
      await projectsApi.remove(current.id);
      set({ selected: null, openProjectId: null });
      void get().fetchProjects();
      return true;
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to delete work',
        'error'
      );
      return false;
    }
  },

  attachCharacter: (avatar) =>
    get().updateSelected((p) => ({
      characters: p.characters.includes(avatar) ? p.characters : [...p.characters, avatar],
    })),

  detachCharacter: (avatar) =>
    get().updateSelected((p) => ({
      characters: p.characters.filter((a) => a !== avatar),
    })),

  attachChat: (ref) =>
    get().updateSelected((p) => ({
      chats: p.chats.some((c) => sameRef(c, ref)) ? p.chats : [...p.chats, ref],
    })),

  detachChat: (ref) =>
    get().updateSelected((p) => ({
      chats: p.chats.filter((c) => !sameRef(c, ref)),
    })),

  openChatRef: async (ref) => {
    // Lazy store imports: chatStore sits inside a fragile import cycle with
    // authStore/lovenseStore (lovenseStore subscribes to useChatStore at
    // module scope), so this store must not add static edges into it.
    const [{ useCharacterStore }, { useChatStore }] = await Promise.all([
      import('./characterStore'),
      import('./chatStore'),
    ]);
    const characterStore = useCharacterStore.getState();
    set({ isOpen: false });

    if (characterStore.selectedCharacter?.avatar === ref.character_avatar) {
      await useChatStore.getState().loadChat(ref.character_avatar, ref.file_name);
      return;
    }

    // ChatView reacts to selectCharacter by fetching chat files and loading
    // the most recent one; the pending marker makes it load this ref's file
    // instead (see ChatView's chatFiles effect).
    set({ pendingChatFile: { avatar: ref.character_avatar, fileName: ref.file_name } });
    await characterStore.selectCharacter(ref.character_avatar);
    if (useCharacterStore.getState().selectedCharacter?.avatar !== ref.character_avatar) {
      set({ pendingChatFile: null });
      showToastGlobal('Character for this chat no longer exists', 'error');
    }
  },

  consumePendingChat: (avatar) => {
    const pending = get().pendingChatFile;
    if (!pending || pending.avatar !== avatar) return null;
    set({ pendingChatFile: null });
    return pending.fileName;
  },
}));
