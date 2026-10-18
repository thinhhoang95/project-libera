// Shared types for the reference manager: the per-notebook library, its
// entries (CSL-JSON plus Libera fields), and the citation token AST. Pure
// types and constants only, safe to import from the server, the client and
// workers. See docs/references/plan.md §2.

export const REFERENCE_LIBRARY_VERSION = 1;

/** CSL-JSON name. */
export type CslName = {
  family?: string;
  given?: string;
  "dropping-particle"?: string;
  "non-dropping-particle"?: string;
  suffix?: string;
  /** Institutional or otherwise unparsed name. */
  literal?: string;
};

/** CSL-JSON date. `date-parts` holds [year, month?, day?] tuples; a second tuple makes a range. */
export type CslDate = {
  "date-parts"?: Array<[number, number?, number?]>;
  literal?: string;
  raw?: string;
  season?: number | string;
  circa?: boolean;
};

export const CSL_ITEM_TYPES = [
  "article", "article-journal", "article-magazine", "article-newspaper", "bill", "book", "broadcast",
  "chapter", "classic", "collection", "dataset", "document", "entry", "entry-dictionary",
  "entry-encyclopedia", "event", "figure", "graphic", "hearing", "interview", "legal_case",
  "legislation", "manuscript", "map", "motion_picture", "musical_score", "pamphlet",
  "paper-conference", "patent", "performance", "periodical", "personal_communication", "post",
  "post-weblog", "regulation", "report", "review", "review-book", "software", "song", "speech",
  "standard", "thesis", "treaty", "webpage",
] as const;
export type CslItemType = typeof CSL_ITEM_TYPES[number];

/** A CSL-JSON item. Unknown CSL variables are kept as they are. */
export type CslItem = {
  type: CslItemType;
  title?: string;
  "title-short"?: string;
  author?: CslName[];
  editor?: CslName[];
  translator?: CslName[];
  "container-author"?: CslName[];
  "collection-editor"?: CslName[];
  issued?: CslDate;
  accessed?: CslDate;
  "original-date"?: CslDate;
  "container-title"?: string;
  "container-title-short"?: string;
  "collection-title"?: string;
  "event-title"?: string;
  "event-place"?: string;
  publisher?: string;
  "publisher-place"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  "number-of-pages"?: string;
  edition?: string;
  number?: string;
  genre?: string;
  medium?: string;
  status?: string;
  language?: string;
  abstract?: string;
  note?: string;
  DOI?: string;
  URL?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  [variable: string]: unknown;
};

/** Every CSL variable name that provenance can describe. */
export type CslField = Exclude<keyof CslItem, number | symbol> | string;

export type ReferenceIdentifiers = {
  doi?: string;          // lowercase, without the https://doi.org/ prefix
  arxiv?: string;        // e.g. "2101.00001" or "hep-th/9901001", without version suffix
  isbn?: string[];       // ISBN-13, digits only
  pmid?: string;
  pmcid?: string;        // with the "PMC" prefix
  openalex?: string;     // e.g. "W2741809807"
};

export const PROVENANCE_SOURCES = [
  "crossref", "datacite", "openalex", "arxiv", "pubmed", "isbn",
  "pdf-metadata", "pdf-text", "llm", "llm-web", "import", "user",
] as const;
export type ProvenanceSource = typeof PROVENANCE_SOURCES[number];

/** Sources whose metadata counts as authoritative for confirmation. */
export const AUTHORITATIVE_SOURCES: readonly ProvenanceSource[] = ["crossref", "datacite", "openalex", "arxiv", "pubmed", "isbn"];

export type FieldProvenance = {
  source: ProvenanceSource;
  /** 0..1 */
  confidence: number;
  /** Where the value came from. Always set for `llm-web`. */
  url?: string;
  retrievedAt: string;
};

export type ReferenceStatus = "confirmed" | "needs-review" | "unresolved";

/** A competing value for a field, from a source that disagrees with the entry's current value. */
export type FieldAlternative = { value: unknown; provenance: FieldProvenance };

export type ReferenceAttachment =
  | {
    kind: "pdf" | "markdown";
    /** Library-relative path, e.g. "Notebook/papers/smith.pdf". */
    path: string;
    /** SHA-256 of the file's bytes, hex, and its size in bytes, recorded when attached. Used to re-attach files moved outside Libera. */
    sha256?: string;
    size?: number;
  }
  | { kind: "url"; url: string };

export type ReferenceVersionLink = {
  relation: "preprint-of" | "published-as" | "erratum" | "retraction" | "correction";
  identifier: string;    // DOI, arXiv ID or URL
};

export type RetractionStatus = {
  state: "none" | "retracted" | "corrected" | "expression-of-concern" | "withdrawn";
  checkedAt: string;
  notice?: { doi?: string; url?: string; date?: string; label?: string };
};

export type ReferenceEntry = {
  /** Stable internal id. Never changes, never shown. */
  id: string;
  /** Citation key, generated once (see keys.ts). */
  key: string;
  /** Retired keys that still resolve to this entry. */
  aliases: string[];
  csl: CslItem;
  identifiers: ReferenceIdentifiers;
  provenance: Partial<Record<CslField, FieldProvenance>>;
  /** Fields whose sources disagree: the alternatives to the current value, shown on the confirmation card. */
  conflicts?: Partial<Record<CslField, FieldAlternative[]>>;
  status: ReferenceStatus;
  attachments: ReferenceAttachment[];
  versions?: ReferenceVersionLink[];
  retraction?: RetractionStatus;
  /** Markdown. */
  notes?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  /** Field-level clocks (ISO strings) for a later collaborative merge. */
  fieldUpdatedAt: Partial<Record<string, string>>;
};

export type ReferenceLibrarySettings = {
  /** Create entries automatically for PDFs added to this notebook. Unset follows the preference. */
  autoCreateForPdfs?: boolean;
};

/** A `set-settings` change: a value sets that setting, null clears it (back to the preference). */
export type ReferenceLibrarySettingsPatch = { [K in keyof ReferenceLibrarySettings]?: ReferenceLibrarySettings[K] | null };

export type ReferenceLibrary = {
  version: typeof REFERENCE_LIBRARY_VERSION;
  /** Incremented by every committed transaction. */
  revision: number;
  /** A bundled CSL style id (see BUNDLED_CSL_STYLES) or a library-relative path to a .csl file. */
  style: string;
  entries: Record<string, ReferenceEntry>;
  settings?: ReferenceLibrarySettings;
};

export const BUNDLED_CSL_STYLES = [
  { id: "apa", label: "APA 7th edition" },
  { id: "chicago-author-date", label: "Chicago (author-date)" },
  { id: "ieee", label: "IEEE" },
  { id: "vancouver", label: "Vancouver" },
  { id: "nature", label: "Nature" },
  { id: "harvard-cite-them-right", label: "Harvard (Cite Them Right)" },
] as const;
export type BundledCslStyleId = typeof BUNDLED_CSL_STYLES[number]["id"];
export const DEFAULT_CSL_STYLE: BundledCslStyleId = "apa";

// ---------------------------------------------------------------------------
// Citation tokens in Markdown: [@key], [@key, p. 12], [see @a; -@b, ch. 3]
// ---------------------------------------------------------------------------

/** CSL locator labels. */
export const CITATION_LOCATOR_LABELS = [
  "act", "appendix", "article-locator", "book", "canon", "chapter", "column", "elocation", "equation",
  "figure", "folio", "issue", "line", "note", "opus", "page", "paragraph", "part", "rule", "scene",
  "section", "sub-verbo", "supplement", "table", "timestamp", "title-locator", "verse", "volume",
] as const;
export type CitationLocatorLabel = typeof CITATION_LOCATOR_LABELS[number];

export type CitationItem = {
  key: string;
  /** Text before the key inside the brackets, e.g. "see". */
  prefix?: string;
  /** e.g. "12" or "12-14". */
  locator?: string;
  /** Defaults to "page" when a locator is present. */
  label?: CitationLocatorLabel;
  /** Text after the locator, e.g. "emphasis added". */
  suffix?: string;
  /** `-@key`: omit the author ("Smith says (2020)"). */
  suppressAuthor?: boolean;
};

export type Citation = {
  items: CitationItem[];
  /** The exact source text of the token, brackets included. */
  raw: string;
  /** Narrative (in-text) citation: `@key` outside brackets. */
  narrative?: boolean;
};

/** A citation found in a Markdown source, with UTF-16 offsets. */
export type CitationOccurrence = {
  citation: Citation;
  start: number;
  end: number;
};

// ---------------------------------------------------------------------------
// Library API (src/app/api/references)
// ---------------------------------------------------------------------------

/** Fields a caller may supply when adding an entry. The server assigns id, key (unless given and free), timestamps. */
export type ReferenceEntryInput = {
  key?: string;
  csl: CslItem;
  identifiers?: ReferenceIdentifiers;
  provenance?: Partial<Record<CslField, FieldProvenance>>;
  conflicts?: Partial<Record<CslField, FieldAlternative[]>>;
  status?: ReferenceStatus;
  attachments?: ReferenceAttachment[];
  versions?: ReferenceVersionLink[];
  notes?: string;
  tags?: string[];
};

export type ReferenceLibraryOp =
  | { op: "add"; entry: ReferenceEntryInput }
  | { op: "update"; id: string; csl?: Partial<CslItem>; removeFields?: string[]; identifiers?: ReferenceIdentifiers; provenance?: Partial<Record<CslField, FieldProvenance>>; /** Per field; null or [] clears that field's conflict. */ conflicts?: Partial<Record<CslField, FieldAlternative[] | null>>; status?: ReferenceStatus; notes?: string; tags?: string[]; versions?: ReferenceVersionLink[]; retraction?: RetractionStatus }
  | { op: "rename-key"; id: string; key: string }
  | { op: "delete"; id: string }
  | { op: "merge"; keepId: string; mergeIds: string[] }
  | { op: "attach"; id: string; attachment: ReferenceAttachment }
  | { op: "detach"; id: string; attachment: ReferenceAttachment }
  /** Insert or replace a whole entry by id (used by undo). The key must be valid and free of other entries' keys and aliases. */
  | { op: "put"; entry: ReferenceEntry }
  | { op: "set-style"; style: string }
  | { op: "set-settings"; settings: ReferenceLibrarySettingsPatch };

/** Window event dispatched after any library change this window knows about. */
export const REFERENCES_UPDATED_EVENT = "libera:references-updated";
export type ReferencesUpdatedDetail = { notebook: string; revision: number };

/** Window event asking the References panel to open its Add box for `query` (e.g. an unresolved key or a pasted DOI). */
export const REFERENCES_ADD_REQUEST_EVENT = "libera:references-add-request";
export type ReferencesAddRequestDetail = { notebook: string; query: string };

/** Window event asking the References panel to show an entry, by id or by key/alias. */
export const REFERENCES_REVEAL_EVENT = "libera:references-reveal";
export type ReferencesRevealDetail = { notebook: string; entryId?: string; key?: string };

/** Window event asking the AI panel to start a fact-check agent run on a Markdown document. */
export const FACT_CHECK_REQUEST_EVENT = "libera:fact-check-request";
export type FactCheckRequestDetail = { path: string; webSearch?: boolean };
