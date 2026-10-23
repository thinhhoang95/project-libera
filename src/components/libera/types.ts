import type { FormEvent, RefObject } from "react";
import type { SynctexTextHint } from "@/lib/latex/synctex-text";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type {
  LiberaFileNode,
  LiberaFolderNode,
  LiberaNotebookGroup,
  LiberaNotebookViewOptions,
  LiberaNotebookNode,
  LiberaTree,
  PdfMarkupStyle,
  PdfShapeKind,
  PdfTextAnnotationFont,
} from "@/lib/types";

export type MarkdownEditorMode = "visual" | "source";

export type OpenTab = {
  id: string;
  file: LiberaFileNode;
  draft: string;
  saved: string;
  rawUrl?: string;
  /** Set on read-only tabs that show a gallery photo instead of a notebook file. */
  gallery?: { photoId: string };
  /** Set on the tab of a recording in progress, which is not a notebook file yet. */
  recording?: { id: string };
  untitled?: boolean;
  standaloneSaveId?: string;
  saveDirectory?: string;
  status: "clean" | "dirty" | "saving" | "error";
  error?: string;
  viewState?: OpenTabViewState;
};

export type MarkdownTabViewState = {
  editorMode?: MarkdownEditorMode;
  editorScrollLeft?: number;
  editorScrollTop?: number;
  line?: number;
  /** The highlighted passage in either editor, as source offsets, for "link to selection". */
  linkSelection?: { end: number; start: number };
  previewScrollLeft?: number;
  previewScrollTop?: number;
  selectionEnd?: number;
  selectionStart?: number;
  slideIndex?: number;
  visualScrollLeft?: number;
  visualScrollTop?: number;
  /** The block at the top of the Visual viewport (ProseMirror position) and its
   * pixel offset, so a restore survives content above it changing height.
   * Flat numbers keep unchanged positions shallow-equal. */
  visualScrollAnchorPos?: number;
  visualScrollAnchorOffset?: number;
  /** ProseMirror selection JSON, independent of source-text offsets. */
  visualSelection?: Record<string, unknown>;
  zoom?: number;
  /** One-shot request (Global Search) to show and select a passage, by source offsets. */
  reveal?: { start: number; end: number; nonce: number };
};

export type PdfTabViewState = {
  fontFamily?: PdfTextAnnotationFont;
  fontSize?: number;
  highlightColor?: string;
  /** Ink for pen strokes and shapes. */
  inkColor?: string;
  /** Ink for underline, strikethrough and squiggly markup. */
  markupColor?: string;
  markupStyle?: PdfMarkupStyle;
  scrollLeft?: number;
  scrollTop?: number;
  selectedAnnotationId?: string;
  shapeKind?: PdfShapeKind;
  strokeWidth?: number;
  /** One-shot request, cleared by the viewer: scroll to the selected annotation
   * instead of restoring the saved scroll position (set when following a link). */
  revealSelectedAnnotation?: boolean;
  textColor?: string;
  tool?: "select" | "highlight" | "text" | "draw" | "shape" | "eraser";
  zoom?: number;
  /** One-shot request (Global Search) to show a page and find a passage on it. */
  reveal?: { page: number; text?: string; nonce: number };
};

export type LatexTabViewState = {
  autoCompile?: boolean;
  /** "current" typesets the open file itself instead of its main file. */
  compileTarget?: "main" | "current";
  /** "auto" honors `% !TEX program` and the packages in the preamble. */
  engine?: "auto" | "pdflatex" | "xelatex" | "lualatex";
  editorScrollTop?: number;
  editorScrollLeft?: number;
  line?: number;
  logOpen?: boolean;
  pdfScrollLeft?: number;
  pdfScrollTop?: number;
  /** A number, or "width" to fit the page width to the pane. */
  pdfZoom?: number | "width";
  selectionEnd?: number;
  selectionStart?: number;
  /** One-shot request from another view (SyncTeX, outline) to reveal a line. */
  revealLine?: { line: number; column?: number; hint?: SynctexTextHint; nonce: number };
};

export type ImageTabViewState = {
  fontFamily?: PdfTextAnnotationFont;
  fontSize?: number;
  panX?: number;
  panY?: number;
  selectedAnnotationId?: string;
  /** One-shot request, cleared by the viewer: select and show the annotation. */
  revealSelectedAnnotation?: boolean;
  textColor?: string;
  tool?: "select" | "text";
  zoom?: number;
};

export type TextTabViewState = {
  editorScrollTop?: number;
  editorScrollLeft?: number;
  line?: number;
  selectionEnd?: number;
  selectionStart?: number;
  /** One-shot request (Global Search) to show and select lines. */
  reveal?: { line: number; endLine?: number; nonce: number };
};

export type AudioTabViewState = {
  /** Where playback was, in seconds. */
  currentTime?: number;
  playbackRate?: number;
  volume?: number;
  /** Audio Boost gain above 100%: 1 is off, up to 4. */
  boost?: number;
  transcriptOpen?: boolean;
  /** Width of the transcript panel in pixels. */
  transcriptWidth?: number;
  followPlayback?: boolean;
  /**
   * One-shot request (Global Search) to play a passage: from the first of its
   * segments with one of `terms`, or from `seconds` when none has.
   */
  reveal?: { seconds: number; end?: number; terms?: string[]; nonce: number };
};

export type OpenTabViewState = {
  audio?: AudioTabViewState;
  image?: ImageTabViewState;
  latex?: LatexTabViewState;
  markdown?: MarkdownTabViewState;
  pdf?: PdfTabViewState;
  text?: TextTabViewState;
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
  mode: "markdown" | "slides" | "latex";
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
      mode: "close-tabs";
      tabIds: string[];
      tabCount: number;
      dirtyTabCount: number;
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
      mode: "remove-folder";
      notebook: string;
      dirtyTabCount: number;
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

/** A link to the passage highlighted in another open Markdown tab. */
export type MarkdownSelectionLinkOption = {
  href: string;
  id: string;
  label: string;
  tabName: string;
  /** For example "Link to highlight in paper.pdf". */
  title: string;
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
  /** "image" inserts the snip as a picture; "markdown" reads it into Markdown with the local model. */
  mode: MarkdownScreenshotSnipMode;
  /** The visual editor inserts at its own saved selection instead of the source offsets above. */
  editor: "source" | "visual";
  /** Set while a Markdown snip is being read. */
  converting?: { startedAt: number };
};

export type MarkdownScreenshotSnipMode = "image" | "markdown";

/** Markdown waiting for the visual editor of a tab to insert at its selection. `inline` inserts at the caret instead of as a new block. */
export type PendingVisualInsertion = { id: string; markdown: string; inline?: boolean };

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
  fileTagsDialog: { file: LiberaFileNode; error: string; submitting: boolean } | null;
  workspaceError: string;
  closeOtherTabs: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeNotebookDialog: () => void;
  closeNotebookGroupDialog: () => void;
  closeNoteDialog: () => void;
  closeWorkspaceConfirmDialog: () => void;
  closeWorkspaceInputDialog: () => void;
  archiveFileNode: (file: LiberaFileNode) => Promise<void>;
  archiveFolderNode: (folder: LiberaFolderNode) => Promise<void>;
  cancelScreenshotSnip: () => void;
  completeScreenshotSnip: (file: File) => Promise<void>;
  createMarkdownFromPrompt: (notebook: string, parentPath?: string) => Promise<void>;
  createMarkdownSlidesFromPrompt: (notebook: string) => Promise<void>;
  createLatexFromPrompt: (notebook: string, parentPath?: string) => Promise<void>;
  createFolderFromPrompt: (parentPath: string) => Promise<void>;
  copyFileFromPrompt: (file: LiberaFileNode) => Promise<void>;
  deleteFileFromPrompt: (tab: OpenTab) => Promise<void>;
  deleteFolderFromPrompt: (folder: LiberaFolderNode) => Promise<void>;
  downloadAnnotatedPdf: (tab: OpenTab, mathMarkers?: MathMarkerSettings) => Promise<void>;
  downloadFile: (file: LiberaFileNode, content?: string) => void;
  duplicateMarkdown: (file: LiberaFileNode) => void;
  downloadMarkdownPdf: (tab: OpenTab) => Promise<void>;
  deleteNotebookFromPrompt: (notebook: string) => Promise<void>;
  downloadNotebook: (notebook: string) => void;
  convertImageToMarkdownWithAi: (image: MarkdownImageSelection) => Promise<void>;
  formatSelectionWithAi: (selection: { start: number; end: number }) => Promise<void>;
  rewriteSelectionWithAi: (
    selection: { start: number; end: number },
    prompt: string,
  ) => Promise<void>;
  writeWithAiAt: (offset: number, prompt: string) => Promise<void>;
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
  openFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTabViewState; placement?: "tab" | "right" | "bottom" },
  ) => Promise<void>;
  openMarkdownFileLink: (sourcePath: string, href: string) => Promise<boolean>;
  listMarkdownSelectionLinks: (sourcePath: string) => MarkdownSelectionLinkOption[];
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
  setActiveTabViewState: (viewState: OpenTabViewState, tabId?: string) => void;
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
  toggleFileStar: (file: LiberaFileNode, starred: boolean) => Promise<void>;
  toggleNotebook: (notebook: string) => void;
  openFileTagsDialog: (file: LiberaFileNode) => void;
  closeFileTagsDialog: () => void;
  saveFileTags: (tags: string[]) => Promise<void>;
};
