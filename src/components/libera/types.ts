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

export type MarkdownImageSelection = {
  alt: string;
  end: number;
  src: string;
  start: number;
};

export type LiberaWorkspace = {
  activeTab?: OpenTab;
  activeTabId: string;
  authError: string;
  aiFormatting: boolean;
  busy: boolean;
  imageMarkdownConverting: boolean;
  expanded: Set<string>;
  firstNotebook: string;
  notebookDialog: NotebookDialogState | null;
  notebookDialogSubmitting: boolean;
  password: string;
  query: string;
  searchResults: SearchResult[];
  tabs: OpenTab[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  tree: LiberaTree;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  workspaceError: string;
  closeTab: (tabId: string) => void;
  closeNotebookDialog: () => void;
  createMarkdownFromPrompt: (notebook: string) => Promise<void>;
  createFolderFromPrompt: (parentPath: string) => Promise<void>;
  copyFileFromPrompt: (file: LiberaFileNode) => Promise<void>;
  deleteFileFromPrompt: (tab: OpenTab) => Promise<void>;
  deleteFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  deleteNotebookFromPrompt: (notebook: string) => Promise<void>;
  downloadNotebook: (notebook: string) => void;
  convertImageToMarkdownWithAi: (image: MarkdownImageSelection) => Promise<void>;
  formatSelectionWithAi: (selection: { start: number; end: number }) => Promise<void>;
  handleLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleUploadChange: () => Promise<void>;
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
  setActiveDraft: (value: string) => void;
  setActiveTabId: (tabId: string) => void;
  setPassword: (password: string) => void;
  setQuery: (query: string) => void;
  startUpload: (notebook: string) => void;
  submitNotebookDialog: (values: NotebookFormValues) => Promise<void>;
  toggleNotebook: (notebook: string) => void;
};
