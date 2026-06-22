export type LiberaFileType = "markdown" | "image" | "pdf";

export type PdfAnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfHighlightAnnotation = {
  id: string;
  type: "highlight";
  pageNumber: number;
  color: string;
  rects: PdfAnnotationRect[];
  createdAt: string;
  updatedAt: string;
};

export type PdfTextAnnotation = {
  id: string;
  type: "text";
  pageNumber: number;
  text: string;
  fontSize: number;
  rect: PdfAnnotationRect;
  createdAt: string;
  updatedAt: string;
};

export type PdfAnnotation = PdfHighlightAnnotation | PdfTextAnnotation;

export type LiberaFileNode = {
  kind: "file";
  name: string;
  path: string;
  notebook: string;
  fileType: LiberaFileType;
  createdAt: string;
  size: number;
  updatedAt: string;
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
};

export type LiberaNotebookNode = {
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
  root: string;
  notebookPanelExpandedPaths: string[] | null;
  notebookGroups: LiberaNotebookGroup[];
  notebookViewOptions: LiberaNotebookViewOptions;
  starredFilePaths: string[];
  notebooks: LiberaNotebookNode[];
};

export type LiberaFilePayload = {
  file: LiberaFileNode;
  content?: string;
  rawUrl?: string;
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
