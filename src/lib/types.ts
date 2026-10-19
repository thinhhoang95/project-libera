import type { ReferenceMoveResult } from "@/lib/references/moves";

export type LiberaFileType = "markdown" | "latex" | "text" | "image" | "pdf" | "audio";

/** File types whose content is edited as text in a tab. */
export function isTextFileType(fileType: LiberaFileType | undefined): fileType is "markdown" | "latex" | "text" {
  return fileType === "markdown" || fileType === "latex" || fileType === "text";
}

export type PdfAnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** How a text markup is drawn over its quote. */
export type PdfMarkupStyle = "highlight" | "underline" | "strikethrough" | "squiggly";

export type PdfHighlightAnnotation = {
  id: string;
  type: "highlight";
  pageNumber: number;
  color: string;
  rects: PdfAnnotationRect[];
  quote?: string;
  /** Older annotations, and plain highlights, have none. */
  markup?: Exclude<PdfMarkupStyle, "highlight">;
  createdAt: string;
  updatedAt: string;
};

/** A point as fractions of the page. */
export type PdfAnnotationPoint = {
  x: number;
  y: number;
};

export type PdfShapeKind = "rectangle" | "ellipse" | "line" | "arrow";

export type PdfShapeAnnotation = {
  id: string;
  type: "shape";
  pageNumber: number;
  shape: PdfShapeKind;
  color: string;
  /** Stroke width in PDF points; it scales with zoom. */
  strokeWidth: number;
  /** Line endpoints, or opposite corners of a rectangle or ellipse's box. */
  from: PdfAnnotationPoint;
  to: PdfAnnotationPoint;
  createdAt: string;
  updatedAt: string;
};

/** One freehand pen stroke. */
export type PdfInkAnnotation = {
  id: string;
  type: "ink";
  pageNumber: number;
  color: string;
  strokeWidth: number;
  points: PdfAnnotationPoint[];
  createdAt: string;
  updatedAt: string;
};

export type PdfTextAnnotationFont = "sans" | "serif" | "hand" | "mono";

export type PdfTextAnnotation = {
  id: string;
  type: "text";
  pageNumber: number;
  /** Markdown source (Libera's TipTap Markdown dialect). */
  text: string;
  fontSize: number;
  /** Ink color; older annotations without one render in the default ink. */
  color?: string;
  fontFamily?: PdfTextAnnotationFont;
  rect: PdfAnnotationRect;
  createdAt: string;
  updatedAt: string;
};

export type PdfAnnotation =
  | PdfHighlightAnnotation
  | PdfTextAnnotation
  | PdfShapeAnnotation
  | PdfInkAnnotation;

export type LiberaFileNode = {
  kind: "file";
  name: string;
  path: string;
  notebook: string;
  fileType: LiberaFileType;
  createdAt: string;
  size: number;
  updatedAt: string;
  /** Files this saved Markdown file links to, resolved against the tree. */
  linkedFilePaths?: string[];
};

export type LiberaFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  notebook: string;
  createdAt: string;
  updatedAt: string;
  children: LiberaTreeNode[];
};

export type LiberaTreeNode = LiberaFileNode | LiberaFolderNode;

export type LiberaNotebookMetadata = {
  illustration?: import("@/lib/notebook-illustrations").NotebookIllustration;
  createdAt: string;
  color: string;
  emoji: string;
  groupId: string | null;
};

export type LiberaNotebookGroup = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type LiberaNotebookViewOptions = {
  hiddenGroupIds: string[];
  hiddenNotebookNames: string[];
  showArchive: boolean;
};

export type LiberaLinkedFolderInfo = {
  /** Absolute path of the folder on disk. */
  path: string;
  /** Very large folders only show part of their contents. */
  truncated: boolean;
  /** The folder was moved or its drive is unplugged. It stays linked. */
  missing?: boolean;
};

export type LiberaNotebookNode = {
  relatedNotebookNames?: string[];
  /** Present when this entry is an external folder linked into the library. */
  folder?: LiberaLinkedFolderInfo;
  illustration?: import("@/lib/notebook-illustrations").NotebookIllustration;
  kind: "notebook";
  name: string;
  path: string;
  createdAt: string;
  color: string;
  emoji: string;
  groupId: string | null;
  updatedAt: string;
  children: LiberaTreeNode[];
};

export type LiberaTree = {
  archiveIncluded?: boolean;
  lastNotebookName?: string;
  root: string;
  notebookPanelExpandedPaths: string[] | null;
  notebookGroups: LiberaNotebookGroup[];
  notebookViewOptions: LiberaNotebookViewOptions;
  starredFilePaths: string[];
  /** Manual tags keyed by file path; files without tags are absent. */
  fileTags: Record<string, string[]>;
  notebooks: LiberaNotebookNode[];
};

export type LiberaFilePayload = {
  file: LiberaFileNode;
  content?: string;
  rawUrl?: string;
};

/**
 * PATCH /api/files after a move or rename. Markdown moved to another notebook
 * also reports the references copied along (src/lib/references/moves.ts).
 */
export type LiberaFileMovePayload = LiberaFilePayload & {
  references?: ReferenceMoveResult;
};

export type PdfAnnotationsPayload = {
  path: string;
  annotations: PdfAnnotation[];
};

export type ImageAnnotationsPayload = {
  path: string;
  annotations: PdfTextAnnotation[];
};

export type PdfTextPage = {
  pageNumber: number;
  text: string;
};

export type PdfTextCachePayload = {
  path: string;
  pdfUpdatedAt: string;
  pdfSize: number;
  generatedAt: string;
  pages: PdfTextPage[];
};

export type MarkdownImageAssetPayload = {
  assetPath: string;
  markdown: string;
  rawUrl: string;
};

export type DeepSearchResultSource =
  | "markdown"
  | "latex"
  | "text"
  | "pdf-text"
  | "pdf-annotation"
  | "image-annotation";

export type DeepSearchResult = {
  id: string;
  source: DeepSearchResultSource;
  notebook: string;
  file: LiberaFileNode;
  title: string;
  sourceLabel: string;
  excerpt: string;
  matchCount: number;
  pageNumber?: number;
  annotationId?: string;
};

export type DeepSearchPayload = {
  query: string;
  searchedFiles: number;
  results: DeepSearchResult[];
};

export type ApiError = {
  error: string;
};
