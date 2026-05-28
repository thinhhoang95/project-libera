export type LiberaFileType = "markdown" | "image" | "pdf";

export type LiberaFileNode = {
  kind: "file";
  name: string;
  path: string;
  notebook: string;
  fileType: LiberaFileType;
  size: number;
  updatedAt: string;
};

export type LiberaNotebookNode = {
  kind: "notebook";
  name: string;
  path: string;
  updatedAt: string;
  children: LiberaFileNode[];
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

export type ApiError = {
  error: string;
};
