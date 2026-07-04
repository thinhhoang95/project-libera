const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

export const ADMIN_USER = "admin";
export const NOTEBOOK_METADATA_FILE = ".libera-notebook.json";
export const WORKSPACE_METADATA_FILE = ".libera-workspace.json";
export const PDF_ANNOTATIONS_SUFFIX = ".libera-pdf-annotations.json";
export const IMAGE_ANNOTATIONS_SUFFIX = ".libera-image-annotations.json";
export const LIBERA_SYSTEM_DIR = ".libera";
export const ANNOTATIONS_DIR = "annotations";
export const PDF_TEXT_CACHE_DIR = "pdf-text";
export const ARCHIVE_DIR = "_archive";
export const MARKDOWN_ASSETS_DIR = "_assets";
export const DEFAULT_NOTEBOOK_COLOR = "#64748b";
export const DEFAULT_NOTEBOOK_EMOJI = "📓";
export const IGNORED_DOWNLOAD_ENTRIES = new Set([".DS_Store", "__MACOSX"]);

export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ...MARKDOWN_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...PDF_EXTENSIONS,
]);

export { IMAGE_EXTENSIONS, MARKDOWN_EXTENSIONS, PDF_EXTENSIONS };
