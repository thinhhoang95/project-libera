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
  size: number;
  updatedAt: string;
};

export type LiberaFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  notebook: string;
  updatedAt: string;
  children: LiberaTreeNode[];
};

export type LiberaTreeNode = LiberaFileNode | LiberaFolderNode;

export type LiberaNotebookMetadata = {
  createdAt: string;
  color: string;
  emoji: string;
};

export type LiberaNotebookNode = {
  kind: "notebook";
  name: string;
  path: string;
  createdAt: string;
  color: string;
  emoji: string;
  updatedAt: string;
  children: LiberaTreeNode[];
};

export type LiberaTree = {
  root: string;
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

export type MarkdownImageAssetPayload = {
  assetPath: string;
  markdown: string;
  rawUrl: string;
};

export type ApiError = {
  error: string;
};
