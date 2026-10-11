const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const LATEX_EXTENSIONS = new Set([".tex", ".bib", ".sty", ".cls"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
/** Other plain-text files (code, data, configuration) opened in the code editor. */
const TEXT_EXTENSIONS = new Set([
  // Plain text, data and configuration
  ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".jsonc", ".json5", ".jsonl", ".ndjson", ".geojson",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".svg", ".xsl", ".xsd", ".dtd",
  ".rst", ".adoc", ".org", ".textile", ".mdx", ".qmd", ".rmd", ".ipynb",
  // TeX companions and bibliography formats
  ".bst", ".bbl", ".dtx", ".ins", ".ris", ".nbib", ".enw", ".csl", ".typ",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
  ".vue", ".svelte", ".graphql", ".gql",
  // Programming languages
  ".py", ".pyw", ".pyi", ".pyx", ".r", ".jl", ".m", ".wl", ".wls", ".nb", ".sas", ".stan", ".do",
  ".java", ".kt", ".kts", ".scala", ".groovy", ".gradle", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx",
  ".cu", ".cuh", ".cs", ".fs", ".fsx", ".go", ".rs", ".swift", ".dart", ".rb", ".php", ".pl", ".pm", ".lua",
  ".hs", ".ml", ".mli", ".clj", ".cljs", ".cljc", ".edn", ".el", ".lisp", ".scm", ".erl", ".ex", ".exs", ".elm",
  ".tcl", ".vb", ".vbs", ".f", ".f77", ".f90", ".f95", ".for", ".sv", ".svh", ".vhd", ".vhdl", ".asm", ".lean",
  ".sql", ".sparql", ".rq", ".ttl", ".nt", ".jsonld", ".proto",
  // Shell and build
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".ps1", ".psm1", ".bat", ".cmd", ".cmake", ".mk", ".tf", ".hcl", ".nix",
  ".dockerfile", ".diff", ".patch",
]);
/** Larger plain-text files (logs, data dumps) are not loaded into the editor. */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
/** Extensionless text files recognised by their whole (lower-cased) name. */
const TEXT_FILE_NAMES = new Set([
  "dockerfile", "makefile", "gnumakefile", "jenkinsfile", "gemfile", "rakefile", "procfile", "vagrantfile",
  "license", "licence", "readme", "changelog", "authors", "contributors", "copying", "notice", "todo", "latexmkrc",
]);

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
  ...LATEX_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...TEXT_EXTENSIONS,
]);

export { IMAGE_EXTENSIONS, LATEX_EXTENSIONS, MARKDOWN_EXTENSIONS, PDF_EXTENSIONS, TEXT_EXTENSIONS, TEXT_FILE_NAMES };
