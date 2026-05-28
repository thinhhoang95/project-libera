import type { FormEvent, RefObject } from "react";
import type {
  LiberaFileNode,
  LiberaFolderNode,
  LiberaNotebookNode,
  LiberaTree,
} from "@/lib/types";

export type OpenTab = {
  id: string;
  file: LiberaFileNode;
  draft: string;
  saved: string;
  rawUrl?: string;
  status: "clean" | "dirty" | "saving" | "error";
  error?: string;
};

export type SearchResult =
  | { type: "notebook"; notebook: string; label: string }
  | { type: "file"; notebook: string; file: LiberaFileNode; label: string };

export type NotebookFormValues = {
  name: string;
  color: string;
  emoji: string;
};

export type NotebookDialogState =
  | {
      mode: "create";
      error?: string;
    }
  | {
      mode: "edit";
      notebook: LiberaNotebookNode;
      error?: string;
    };

export type NoteFormValues = {
  name: string;
};

export type NoteDialogState = {
  notebook: string;
  error?: string;
};

export type WorkspaceInputDialogState =
  | {
      mode: "create-folder";
      parentPath: string;
      error?: string;
    }
  | {
      mode: "copy-file";
      file: LiberaFileNode;
      error?: string;
    }
  | {
      mode: "move-file";
      file: LiberaFileNode;
      error?: string;
    }
  | {
      mode: "rename-file";
      file: LiberaFileNode;
      error?: string;
    }
  | {
      mode: "rename-folder";
      folder: LiberaFolderNode;
      error?: string;
    };

export type WorkspaceInputDialogValues = {
  destinationDirectory: string;
  destinationName: string;
  name: string;
};

export type WorkspaceConfirmDialogState =
  | {
      mode: "close-tab";
      tabId: string;
      fileName: string;
    }
  | {
      mode: "delete-file";
      file: LiberaFileNode;
    }
  | {
      mode: "delete-folder";
      folder: LiberaFolderNode;
    }
  | {
      mode: "delete-notebook";
      notebook: string;
    }
  | {
      mode: "move-file-node";
      destinationName: string;
      destinationNotebook: string;
      file: LiberaFileNode;
    }
  | {
      mode: "move-file-folder";
      destinationPath: string;
      file: LiberaFileNode;
    };

export type MarkdownImageSelection = {
  alt: string;
  end: number;
  src: string;
  start: number;
};

export type MarkdownScreenshotSnipSession = {
  scrollLeft: number;
  scrollTop: number;
  selectionEnd: number;
  selectionStart: number;
  sourceTabId: string;
  targetTabId: string;
};

export type LiberaWorkspace = {
  activeTab?: OpenTab;
  activeTabId: string;
  authError: string;
  aiFormatting: boolean;
  busy: boolean;
  canStartScreenshotSnip: boolean;
  imageMarkdownConverting: boolean;
  expanded: Set<string>;
  firstNotebook: string;
  screenshotSnipSession: MarkdownScreenshotSnipSession | null;
  notebookDialog: NotebookDialogState | null;
  notebookDialogSubmitting: boolean;
  noteDialog: NoteDialogState | null;
  noteDialogSubmitting: boolean;
  password: string;
  query: string;
  fileInteractions: Record<string, string>;
  searchResults: SearchResult[];
  selectedNotebook?: LiberaNotebookNode;
  selectedNotebookName: string;
  tabs: OpenTab[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  tree: LiberaTree;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  workspaceConfirmDialog: WorkspaceConfirmDialogState | null;
  workspaceConfirmDialogSubmitting: boolean;
  workspaceInputDialog: WorkspaceInputDialogState | null;
  workspaceInputDialogSubmitting: boolean;
  workspaceError: string;
  closeTab: (tabId: string) => void;
  closeNotebookDialog: () => void;
  closeNoteDialog: () => void;
  closeWorkspaceConfirmDialog: () => void;
  closeWorkspaceInputDialog: () => void;
  cancelScreenshotSnip: () => void;
  completeScreenshotSnip: (file: File) => Promise<void>;
  createMarkdownFromPrompt: (notebook: string) => Promise<void>;
  createFolderFromPrompt: (parentPath: string) => Promise<void>;
  copyFileFromPrompt: (file: LiberaFileNode) => Promise<void>;
  deleteFileFromPrompt: (tab: OpenTab) => Promise<void>;
  deleteFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  downloadFile: (file: LiberaFileNode, content?: string) => void;
  deleteNotebookFromPrompt: (notebook: string) => Promise<void>;
  downloadNotebook: (notebook: string) => void;
  convertImageToMarkdownWithAi: (image: MarkdownImageSelection) => Promise<void>;
  formatSelectionWithAi: (selection: { start: number; end: number }) => Promise<void>;
  handleLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleUploadChange: () => Promise<void>;
  insertExistingMarkdownImage: (file: LiberaFileNode) => Promise<void>;
  insertMarkdownImage: (file: File) => Promise<void>;
  insertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  moveFileFromPrompt: (tab: OpenTab) => Promise<void>;
  moveFileToFolder: (file: LiberaFileNode, destinationPath: string) => Promise<void>;
  openFile: (file: LiberaFileNode) => Promise<void>;
  openCreateNotebookDialog: () => void;
  openEditNotebookDialog: (notebook: LiberaNotebookNode) => void;
  deleteFileNodeFromPrompt: (file: LiberaFileNode) => Promise<void>;
  renameFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  renameFileNodeFromPrompt: (file: LiberaFileNode) => Promise<void>;
  renameFileFromPrompt: (tab: OpenTab) => Promise<void>;
  saveActiveTab: () => Promise<void>;
  selectSearchResult: (result: SearchResult) => void;
  selectNotebook: (notebook: string) => void;
  setActiveDraft: (value: string) => void;
  setActiveTabId: (tabId: string) => void;
  setPassword: (password: string) => void;
  setQuery: (query: string) => void;
  startScreenshotSnip: () => void;
  swapTabs: (sourceTabId: string, targetTabId: string) => void;
  startUpload: (notebook: string) => void;
  submitNotebookDialog: (values: NotebookFormValues) => Promise<void>;
  submitNoteDialog: (values: NoteFormValues) => Promise<void>;
  submitWorkspaceConfirmDialog: () => Promise<void>;
  submitWorkspaceInputDialog: (values: WorkspaceInputDialogValues) => Promise<void>;
  toggleNotebook: (notebook: string) => void;
};
