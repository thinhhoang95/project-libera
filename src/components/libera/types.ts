import type { FormEvent, RefObject } from "react";
import type {
  LiberaFileNode,
  LiberaFolderNode,
  LiberaNotebookGroup,
  LiberaNotebookViewOptions,
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
  viewState?: OpenTabViewState;
};

export type MarkdownTabViewState = {
  editorScrollLeft?: number;
  editorScrollTop?: number;
  line?: number;
  previewScrollLeft?: number;
  previewScrollTop?: number;
  selectionEnd?: number;
  selectionStart?: number;
  slideIndex?: number;
  zoom?: number;
};

export type PdfTabViewState = {
  fontSize?: number;
  scrollLeft?: number;
  scrollTop?: number;
  selectedAnnotationId?: string;
  tool?: "select" | "highlight" | "text";
  zoom?: number;
};

export type ImageTabViewState = {
  fontSize?: number;
  panX?: number;
  panY?: number;
  selectedAnnotationId?: string;
  tool?: "select" | "text";
  zoom?: number;
};

export type OpenTabViewState = {
  image?: ImageTabViewState;
  markdown?: MarkdownTabViewState;
  pdf?: PdfTabViewState;
};

export type SearchResult =
  | { type: "notebook"; notebook: string; label: string }
  | { type: "file"; notebook: string; file: LiberaFileNode; label: string };

export type NotebookFormValues = {
  name: string;
  color: string;
  emoji: string;
  groupId: string;
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

export type NotebookGroupFormValues = {
  title: string;
  description: string;
  notebookNames: string[];
};

export type NotebookGroupDialogState =
  | {
      mode: "create";
      error?: string;
    }
  | {
      mode: "edit";
      group: LiberaNotebookGroup;
      error?: string;
    };

export type NoteFormValues = {
  name: string;
};

export type NoteDialogState = {
  mode: "markdown" | "slides";
  notebook: string;
  parentPath?: string;
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

export type MarkdownFileLinkSelection = {
  file: LiberaFileNode;
  source: "file" | "tab";
  tabId?: string;
  viewState?: OpenTabViewState;
};

export type MarkdownFileLinkRange = {
  end: number;
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
  notebookGroupDialog: NotebookGroupDialogState | null;
  notebookGroupDialogSubmitting: boolean;
  noteDialog: NoteDialogState | null;
  noteDialogSubmitting: boolean;
  password: string;
  query: string;
  fileInteractions: Record<string, string>;
  files: LiberaFileNode[];
  recentFiles: LiberaFileNode[];
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
  closeNotebookGroupDialog: () => void;
  closeNoteDialog: () => void;
  closeWorkspaceConfirmDialog: () => void;
  closeWorkspaceInputDialog: () => void;
  cancelScreenshotSnip: () => void;
  completeScreenshotSnip: (file: File) => Promise<void>;
  createMarkdownFromPrompt: (notebook: string, parentPath?: string) => Promise<void>;
  createMarkdownSlidesFromPrompt: (notebook: string) => Promise<void>;
  createFolderFromPrompt: (parentPath: string) => Promise<void>;
  copyFileFromPrompt: (file: LiberaFileNode) => Promise<void>;
  deleteFileFromPrompt: (tab: OpenTab) => Promise<void>;
  deleteFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  downloadFile: (file: LiberaFileNode, content?: string) => void;
  downloadMarkdownPdf: (tab: OpenTab) => Promise<void>;
  deleteNotebookFromPrompt: (notebook: string) => Promise<void>;
  downloadNotebook: (notebook: string) => void;
  convertImageToMarkdownWithAi: (image: MarkdownImageSelection) => Promise<void>;
  formatSelectionWithAi: (selection: { start: number; end: number }) => Promise<void>;
  rewriteSelectionWithAi: (
    selection: { start: number; end: number },
    prompt: string,
  ) => Promise<void>;
  handleLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleUploadChange: () => Promise<void>;
  uploadFilesToNotebook: (
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) => Promise<void>;
  insertMarkdownFileLink: (
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) => void;
  insertMarkdownFileLinkPlaceholder: () => void;
  insertExistingMarkdownImage: (file: LiberaFileNode) => Promise<void>;
  insertMarkdownImage: (
    file: File,
    selection?: { end: number; start: number },
  ) => Promise<void>;
  insertMarkdown: (before: string, after?: string, placeholder?: string) => void;
  moveFileFromPrompt: (tab: OpenTab) => Promise<void>;
  moveFileToFolder: (file: LiberaFileNode, destinationPath: string) => Promise<void>;
  openFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
  openMarkdownFileLink: (sourcePath: string, href: string) => Promise<boolean>;
  openCreateNotebookDialog: () => void;
  openCreateNotebookGroupDialog: () => void;
  openEditNotebookDialog: (notebook: LiberaNotebookNode) => void;
  openEditNotebookGroupDialog: (group: LiberaNotebookGroup) => void;
  deleteNotebookGroup: (group: LiberaNotebookGroup) => Promise<void>;
  deleteFileNodeFromPrompt: (file: LiberaFileNode) => Promise<void>;
  renameFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  renameFileNodeFromPrompt: (file: LiberaFileNode) => Promise<void>;
  renameFileFromPrompt: (tab: OpenTab) => Promise<void>;
  saveActiveTab: () => Promise<void>;
  selectSearchResult: (result: SearchResult) => void;
  selectNotebook: (notebook: string) => void;
  setActiveDraft: (value: string) => void;
  setActiveTabId: (tabId: string) => void;
  setActiveTabViewState: (viewState: OpenTabViewState) => void;
  setPassword: (password: string) => void;
  setQuery: (query: string) => void;
  startScreenshotSnip: () => void;
  swapTabs: (sourceTabId: string, targetTabId: string) => void;
  startUpload: (notebook: string) => void;
  submitNotebookDialog: (values: NotebookFormValues) => Promise<void>;
  submitNotebookGroupDialog: (values: NotebookGroupFormValues) => Promise<void>;
  updateNotebookViewOptions: (viewOptions: LiberaNotebookViewOptions) => Promise<void>;
  submitNoteDialog: (values: NoteFormValues) => Promise<void>;
  submitWorkspaceConfirmDialog: () => Promise<void>;
  submitWorkspaceInputDialog: (values: WorkspaceInputDialogValues) => Promise<void>;
  toggleNotebook: (notebook: string) => void;
};
