import type { ReferenceMoveResult } from "@/lib/references/moves";
import type { MovedPathRewrite } from "@/lib/move-rewrites";

/**
 * What a file is. "page" is never a file on disk: it marks an app page that
 * opens in a tab of its own, such as Spending (components/libera/page-tabs.ts),
 * so that nothing that handles files by type treats the tab as one.
 */
export type LiberaFileType = "markdown" | "latex" | "text" | "image" | "pdf" | "audio" | "page";

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
  /**
   * The space this annotation sits in. Its y coordinates are then measured
   * from the top of that space, in page-height fractions; x is unchanged.
   */
  space?: string;
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
  /**
   * The space this annotation sits in. Its y coordinates are then measured
   * from the top of that space, in page-height fractions; x is unchanged.
   */
  space?: string;
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
  /**
   * The space this annotation sits in. Its y coordinates are then measured
   * from the top of that space, in page-height fractions; x is unchanged.
   */
  space?: string;
  createdAt: string;
  updatedAt: string;
};

/** A column block's layout, in page fractions, recorded when its first space was made. */
export type PdfSpaceBand = {
  top: number;
  bottom: number;
  /** x boundaries between columns, ascending; empty for one full-width column. */
  splits: number[];
};

/**
 * Blank room opened in the page as displayed; the PDF itself is unchanged.
 * A full-width space has a band of zero height at its cut.
 */
export type PdfSpaceAnnotation = {
  id: string;
  type: "space";
  pageNumber: number;
  /** The cut: a page fraction, normally at a blank row of the column. */
  y: number;
  /** Inserted height, as a fraction of the page height. */
  height: number;
  band: PdfSpaceBand;
  /** Index of the column (between `band.splits`) that opens. */
  column: number;
  /** Page background sampled at creation, used to fill the space. */
  fill?: string;
  createdAt: string;
  updatedAt: string;
};

export type PdfAnnotation =
  | PdfHighlightAnnotation
  | PdfTextAnnotation
  | PdfShapeAnnotation
  | PdfInkAnnotation
  | PdfSpaceAnnotation;

export type LiberaFileNode = {
  kind: "file";
  name: string;
  path: string;
  notebook: string;
  fileType: LiberaFileType;
  createdAt: string;
  size: number;
  updatedAt: string;
  /**
   * The inode change time (ctime): also moves when a file is copied, moved or
   * synced in with its original dates kept. Where Was I uses it to notice files
   * that arrived while you were away.
   */
  changedAt?: string;
  /** Files this saved Markdown file links to, resolved against the tree. */
  linkedFilePaths?: string[];
  /**
   * The shared notebook's file id for this path, when the host listed it at
   * the time the tree was built. Rename and delete send it so a path that
   * another file has taken over is refused instead of acted on.
   */
  fileId?: string;
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
  /** A cover the user picked: a copy kept beside the metadata, overriding `illustration`. */
  illustrationPath?: string;
  createdAt: string;
  color: string;
  emoji: string;
  groupId: string | null;
  /** Whether edits to LaTeX files recompile on their own; unset means on. */
  latexAutoCompile?: boolean;
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
  /** The edited-age and tag chips line under each file name. */
  showFileDetails: boolean;
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
  illustrationPath?: string;
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
  /** Some folder could not be read in full (it raced away, was unreadable or lay beyond a linked folder's cap): the rest is shown, and upkeep that needs the whole picture waits. */
  incomplete?: boolean;
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
  /** A text file's content version (src/lib/storage/files.ts textVersion). */
  version?: string;
  rawUrl?: string;
};

/**
 * A step after the file itself moved (its records following it) that did not
 * finish: `failed` threw (`message` says what), `held` was left at the old
 * path on purpose (a review whose destination already has comments).
 */
export type LiberaMoveStep = { step: "images" | "reviews" | "attachments" | "metadata" | "references" | "history" | "links"; status: "failed" | "held"; message: string };

/**
 * Why a path that pointed at a moved file, or that a moved note wrote, was
 * not rewritten (docs/features/move-link-refactor.md): another file would
 * answer it (`shadowed`), a reference definition read by a link and an image
 * that would need two paths, chart data in another notebook, a LaTeX chapter
 * whose builds would need two paths, a spelling that can't be written back,
 * a note that could not be read or written, a shared notebook's note, a note
 * a migration is moving.
 */
export type LiberaLinkSkipReason = "shadowed" | "shared-definition" | "chart-notebook" | "latex-builds" | "unwritable" | "unreadable" | "shared-notebook" | "migrating";

/** What a move did to the paths notes write (src/lib/storage/move-links.ts). */
export type LiberaLinkRewrites = {
  /** Each file whose text was rewritten, by its path after the move, and the rewrite (src/lib/move-rewrites.ts) to apply to texts the server did not see. */
  rewritten: { path: string; rewrite: MovedPathRewrite }[];
  /** Paths left as written although the move changed what they open: the file that writes it, the path as written, why. */
  skipped: { path: string; written: string; reason: LiberaLinkSkipReason }[];
  /** Notebooks whose notes could not all be read, so some links there may not have followed. */
  unchecked: string[];
};

/**
 * PATCH /api/files after a move or rename. Markdown moved to another notebook
 * also reports the references copied along (src/lib/references/moves.ts).
 */
export type LiberaFileMovePayload = LiberaFilePayload & {
  /** Set with `unfinished`: the move that did happen, for a caller that retargets what it has open. */
  moved?: { from: string; to: string };
  /** What did not finish after the file moved; absent when everything did. Check Notebook, then Try to fix, completes it. */
  unfinished?: LiberaMoveStep[];
  references?: ReferenceMoveResult;
  /** Image URLs rewritten when moving Markdown into another notebook. */
  imageSources?: Record<string, string>;
  /** Paths in notes rewritten to follow the move, and those that could not be. */
  links?: LiberaLinkRewrites;
};

/** PATCH /api/folders after a rename or an archive: the tree, and what the move did to links. */
export type LiberaFolderMovePayload = LiberaTree & {
  moved?: { from: string; to: string };
  unfinished?: LiberaMoveStep[];
  links?: LiberaLinkRewrites;
};

export type PdfAnnotationsPayload = {
  path: string;
  annotations: PdfAnnotation[];
};

/** Where a PDF comment is: the selected text's boxes on each page it spans, in page fractions. */
export type PdfCommentSegment = {
  pageNumber: number;
  rects: PdfAnnotationRect[];
};

export type PdfCommentAnchor = {
  segments: PdfCommentSegment[];
  quote: string;
};

/** `author` is "agent" for replies the AI agent posted; the user's own have none. */
export type PdfCommentMessage = {
  id: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  author?: "agent";
  /** On a live PDF: who wrote it. */
  authorName?: string;
  /** On a live PDF: this person wrote it. Absent on a local PDF, where all of them are. */
  own?: boolean;
  /** Written offline and waiting to reach the server. */
  pending?: boolean;
  /** Written offline, then refused by the server (why). Deleting it discards it. */
  notSent?: string;
};

/**
 * A review comment thread on a PDF passage, kept in the PDF's annotation
 * sidecar beside its markup (src/lib/storage/pdf-comments.ts). PDFs do not
 * change, so anchors never need remapping the way Markdown ones do.
 */
export type PdfCommentThread = {
  id: string;
  anchor: PdfCommentAnchor;
  status: "open" | "resolved";
  messages: PdfCommentMessage[];
  createdAt: string;
  updatedAt: string;
  /** Written offline and waiting to reach the server. */
  pending?: boolean;
  /** Written offline, then refused by the server (why). Deleting it discards it. */
  notSent?: string;
};

export type PdfCommentsPayload = {
  path: string;
  threads: PdfCommentThread[];
  /** On a live PDF: this person can read comments, not write them. */
  readOnly?: boolean;
  /** On a live PDF: who is reading, and the notebook whose members can be mentioned. */
  live?: { projectId: string; accountId: string };
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
