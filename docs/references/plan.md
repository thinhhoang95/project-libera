# Reference manager implementation plan

Status: in implementation on `references/integration` (branched from `collaboration` at 0ae5bce). Progress: [progress.md](progress.md). Lane rules: [lanes.md](lanes.md). Decisions D1–D8 are accepted as recommended (§6).

Each notebook gets its own reference library. A **References** panel in the left rail and a full **Manage references** dialog sit on top of it. Markdown documents cite entries with a Libera citation token that the user inserts by typing `@`. The first milestone is the Markdown integration: library, panel, citation syntax, `@` autocomplete, rendered citations and bibliography. Capture automation (DOI/PDF/LLM resolution in the background) and agent fact-checking follow on the same data model.

Design goals, taken from what people dislike about existing reference managers:

- **No manual entry.** Capture anything and resolve it against authoritative sources. The user only confirms. Fields carry provenance and confidence, and editable fields appear only where sources disagree or nothing authoritative exists.
- **Citations never break.** Documents cite stable keys, not file paths, so renames and moves never touch document text. Key changes leave aliases behind. There is no hand-maintained `.bib`.
- **Cite as you write.** `@` autocomplete in all three editors, hover cards, and later quote-with-locator from the PDF viewer.
- **PDFs, highlights, notes and citations in one place.** The entry links its PDF (and the PDF's converted Markdown). PDF highlights and notes stay where they already live.
- **Verifiable.** An agent skill checks every citation against the cited source, with deterministic evidence verification so its verdicts cannot be hallucinated.

---

## 1. Product behavior

### 1.1 References panel (left rail)

A new rail tab, **References** (book icon, ⌘/Ctrl+7), shows the library of the current notebook, meaning `selectedNotebookName` (the notebook of the file being viewed, or the one selected in the sidebar). Contents:

- **Search box.** Matches key, authors, year, title, venue, tags and notes. ↑/↓ and Enter work as in the other panels.
- **Filters:** All · Cited in this document · Needs review · Uncited · Duplicates · Missing PDF.
- **Rows:** `Author et al. (Year)`, title, venue, key in monospace, plus icons for an attached PDF or Markdown, a status badge (needs review, duplicate, unresolved) and a count of documents citing the entry. Entries cited by the active document are highlighted with the same tint and accent edge as backlinks.
- **Row actions:** Cite at cursor, Open PDF, Copy key, Copy formatted reference, Show citing documents, Edit, Delete (blocked while cited, unless confirmed).
- **Header actions:**
  - **Add** opens a single input that takes a DOI, arXiv ID, ISBN, PMID, URL, BibTeX/RIS text, a free-text reference, or a whole pasted bibliography. PDFs and Markdown files can also be dropped from the notebook tree, which already sets `application/x-libera-file-path`, or from the OS.
  - **Generate entries for PDFs without one** (Phase 3) runs in the background with progress in the panel header.
  - **Import** and **Export**.
  - **Manage…** opens the dialog.

Selecting a row opens a **detail card** in the panel. It is a confirmation card, not a form. It shows the formatted reference, abstract, identifiers, attachments, citing documents, notes and per-field provenance chips (“Crossref”, “PDF”, “LLM + web”, “You”). Conflicting or low-confidence fields show as editable with the competing values side by side. **Edit all fields** is always available as an escape hatch.

### 1.2 Manage references dialog

A large `ModalDialog` with a sortable, multi-select table. It is for bulk work that does not fit a sidebar:

- Columns: key, authors, year, title, venue, type, status, cited-by count, attachment, last changed.
- Bulk actions:
  - **Merge duplicates.** Keep one key and turn the others into aliases.
  - **Re-resolve** against sources.
  - **Mark confirmed.**
  - **Change type.**
  - **Delete.**
  - **Export selection.**
- Inline field correction with undo (the last 20 library transactions, as in review mode).
- A **Duplicates** view that groups candidates, including preprint and published pairs, with a **Merge** action per group.

### 1.3 Citations in Markdown

**Syntax (decision D1).** The citation is a bracketed token with Pandoc-compatible grammar, parsed by Libera's own micromark construct:

| Source | Meaning |
| --- | --- |
| `[@smith2020sparse]` | Parenthetical citation |
| `[@smith2020sparse, p. 12]` | With locator |
| `[@smith2020sparse; @lee2021]` | Several works |
| `[see @smith2020sparse, ch. 3]` | Prefix and locator |
| `[-@smith2020sparse]` | Suppress author: “Smith says (2020)” |

Only the bracketed form is a citation. A bare `@word` stays text, so email addresses, social handles and future `@mentions` in collab comments are never misread. Narrative citations (bare `@key says …`) are deferred; see D4. We keep Pandoc's grammar rather than inventing one so that an exported `.md` still works with Pandoc, Quarto and Obsidian citation plugins, and so the user-facing gesture is simply “type `@`”.

**Typing `@`** opens a citation popup when the `@` follows the start of a line, whitespace, `[`, `(` or `;`, and is not inside code, math, a link destination or a word (`name@host`). The popup:

- Ranks library entries by key, author, year, title, tags and notes, with entries already cited in this document first.
- Shows a two-line preview: authors and year, then the title.
- **Enter** inserts `[@key]`. If the caret is already inside a citation, it appends `; @key` instead. **Tab** inserts and puts the caret at the locator position (`[@key, |]`).
- Ends with footer rows:
  - **Add reference from “10.1145/…”** when the query looks like an identifier. It resolves the reference, adds it, then cites it.
  - **Search all notebooks** (Phase 5).
- Behaves the same in the textarea editor, the CodeMirror Source editor and the Visual (TipTap) editor.

**Rendering (preview, Visual editor, PDF export).**

- Citations are formatted with citeproc-js using the notebook's CSL style: “(Smith et al., 2020, p. 12)” for author-date styles, “[3]” for numeric ones.
- A **References** section is generated at the end of the document. A `:::bibliography` / `:::` block, if present, sets where it goes.
- A key that is not in the library renders as a red `@key?` chip. Its hover offers **Add to library** and lists close matches. The token is never rewritten silently.
- **Hover card:** the formatted reference, abstract, your notes, PDF highlights count, citing documents, and **Open PDF at p. 12**, which uses the existing `viewState.pdf.reveal`.
- **Click** in the Visual editor opens a small popover to edit the locator, prefix, suppress-author flag, or swap the work.

**Styles.** Bundle APA 7, Chicago author-date, IEEE, Vancouver, Nature and Harvard, plus the `en-US` locale. A notebook can add any `.csl` file; `.csl` is already an allowed text type. The style is a notebook setting, shown in the References panel menu. A per-document override comes later.

### 1.4 Renames, moves and key changes

- **File rename or move** (PDF or Markdown attachment). The entry's attachment pointer is updated in the same metadata transaction that moves PDF annotations today. Document text is never touched, because citations name keys, not paths. Files moved outside Libera are re-attached on the next tree load by content hash, using the SHA-256 that the PDF text cache already computes.
- **Document moved to another notebook.** The entries it cites that the destination library lacks are copied over:
  - An entry is matched by DOI, arXiv ID or ISBN first, then by fuzzy title + first author + year.
  - If the key is taken by a different work in the destination, the copy gets a new key, and the moved document's citations are rewritten in the same transaction. The toast reports it.
- **Key change** (rare; keys are generated once). The old key becomes an alias, so existing documents keep rendering. The panel offers **Update N citations in M documents**. That rewrite is draft-aware, like agent edits: open tabs get the change in their draft. It is listed for review before it is applied.
- **Notebook rename.** The library lives inside the notebook's `.libera/`, so it moves with the folder.

### 1.5 Import and export

- **Import:** BibTeX/BibLaTeX, RIS, CSL-JSON, and the `.bib` files already in the notebook (reusing `readBibEntries`). Imported keys are kept when they are valid and unique.
- **Export:** the whole library or a selection as BibTeX/BibLaTeX (correct escaping, protected capitalization with `{}` around acronyms and proper nouns, consistent journal abbreviations), CSL-JSON or RIS.
- **Export document bibliography:** only the works the document cites, in the same formats. Also a formatted reference list in the current style, as text or Markdown.
- **Markdown PDF export:** works automatically, because it prints `MarkdownRenderer`.
- **LaTeX export:** see §4.6.

---

## 2. Data model

The authoritative TypeScript shapes live in `src/lib/references/types.ts`; the sketch below is a summary.

A library is one versioned JSON database per notebook. Entries use **CSL-JSON** as the field schema, because citeproc-js consumes it natively, plus Libera fields:

```ts
type ReferenceLibrary = {
  version: 1;
  revision: number;            // incremented by every transaction
  style: string;               // CSL style id or a notebook-relative .csl path
  entries: Record<string, ReferenceEntry>;   // keyed by entry id
};

type ReferenceEntry = {
  id: string;                  // "ref_" + crypto.randomUUID(); never changes, never shown
  key: string;                 // citation key, generated once
  aliases: string[];           // retired keys that still resolve
  csl: CslItem;                // type, title, author[], issued, container-title, DOI, URL, page, …
  identifiers: { doi?: string; arxiv?: string; isbn?: string[]; pmid?: string; pmcid?: string; openalex?: string };
  provenance: Partial<Record<CslField, FieldProvenance>>;
  status: "confirmed" | "needs-review" | "unresolved";
  attachments: ReferenceAttachment[];
  versions?: { relation: "preprint-of" | "published-as" | "erratum" | "retraction"; identifier: string }[];
  notes?: string;              // Markdown
  tags?: string[];
  createdAt: string; updatedAt: string;
  fieldUpdatedAt: Partial<Record<CslField, string>>;   // field-level clocks for future collab merge
};

type FieldProvenance = {
  source: "crossref" | "datacite" | "openalex" | "arxiv" | "pubmed" | "isbn" | "pdf-metadata" | "pdf-text" | "llm" | "llm-web" | "import" | "user";
  confidence: number;          // 0..1
  url?: string;                // where it came from (web sources always carry one)
  retrievedAt: string;
};

type ReferenceAttachment = { kind: "pdf" | "markdown" | "url"; path?: string; sha256?: string; url?: string };
```

**Key generation.** The key is `lastname` + `year` + the first significant title word, lowercased and transliterated to ASCII (for example `smith2020sparse`), with `a`/`b`/… suffixes on collision. It is generated once when the entry is first confirmed or cited and is never regenerated when metadata changes. Editing a key is allowed and leaves an alias.

**Storage (decision D2).** The library lives at `<notebook system dir>/references/library.json`, through `notebookSystemDirectoryPath`, so linked folders work automatically. Writes go through a locked, revision-checked transaction copied from `src/lib/storage/markdown-reviews.ts`, with atomic replace. Background jobs live in a sibling `jobs.json` (§4.4). The `.libera/` folder travels with folder sync and with notebook zip downloads.

Trade-off: collab v1 does not share `.libera/`, so a shared notebook's library is per-machine until Phase 5 (§6). That is acceptable for the first milestone and better than the alternatives:

- A visible `references.bib` cannot hold provenance or status.
- A visible JSON file shared as a CRDT *text* document can be corrupted by concurrent edits.

Entries are id-keyed records with field-level clocks precisely so they map one-to-one onto a `Y.Map` later.

**Citation token AST.** All parsers produce the same shape:

```ts
type Citation = { items: { key: string; prefix?: string; locator?: string; label?: string; suffix?: string; suppressAuthor?: boolean }[]; raw: string };
```

The Visual editor keeps `raw` so that a round trip reproduces the source byte for byte unless the user edits the citation.

---

## 3. Existing integration points

| Area | File(s) | Integration |
| --- | --- | --- |
| Left rail | `src/components/libera/left-panel.tsx` | Add `"references"` to `LeftPanelTab`, `LEFT_PANEL_TABS`, the ⌘/Ctrl+7 shortcut and the render chain. Props already carry `tree`, `selectedNotebookName`, `onOpenFile`, `activeTab`. |
| App wiring | `src/components/libera-app.tsx` | Pass the insert-citation callback and the active document's cited keys. Optionally persist `activeLeftPanel`, which today resets to Notebook. |
| Panel template | `outline-panel.tsx` (`PdfOutline`), `global-search/search-store.ts` | Sidecar fetch plus update event; module store with `useSyncExternalStore` for job progress. |
| Dialog | `src/components/libera/modal-dialog.tsx` | Manage references dialog, confirmation cards. |
| Storage | `src/lib/storage/paths.ts` (`notebookSystemDirectoryPath`), `json-state.ts`, `markdown-reviews.ts` | Library location, atomic writes, the transaction pattern. |
| Rename/move hooks | `src/lib/storage/files.ts`: `moveFile`, `moveFileToDirectory`, `renameFolder`, `archiveFile`, `archiveFolder`, `deleteFile`, `deleteFolder`, `moveRelatedMetadata`, `copyRelatedMetadata`; `storage/notebooks.ts` | Update attachment pointers; copy cited entries on cross-notebook moves. There is no event bus, so each function gets an explicit call, as annotations do. |
| Preview | `src/lib/markdown-rendering.ts` (`markdownRemarkPlugins`), `markdown-preview.ts`, `markdown-preview.worker.ts`, `markdown-preview-patch.ts`, `src/components/markdown-renderer.tsx`, `markdown-source-map.ts` | New micromark construct `remark-citations.ts`, citeproc formatting, a `cite` component and the bibliography block. Preview cache keys include the library revision. |
| Visual editor | `src/lib/tiptap-markdown.ts`, `src/lib/tiptap-math.ts` (atomic inline node template), `tiptap-markdown-editor.tsx` | `tiptap-citation.ts` atom node with a Marked tokenizer, `renderMarkdown`, `parseHTML`, popover and `@` suggestion. |
| Source editor (CodeMirror) | `src/lib/markdown-codemirror/libera-syntax.ts`, `commands.ts`, `markdown-source/markdown-codemirror-editor.tsx` | New `LiberaSyntaxKind` `citation`, decoration, and the `@` popup using the file-link popup's trigger and keymap pattern. |
| Classic textarea | `src/components/libera/markdown-editor.tsx` (`getFileLinkPopupContext`, `MarkdownFileLinkPopup`) | Same `@` popup, same trigger rules. No inline highlighting layer is needed. |
| Popup UI | `markdown-file-link-popup.tsx`, `src/lib/file-suggestions.ts` | Model for a shared `citation-popup.tsx` and `reference-suggestions.ts`. |
| Clipboard | `src/lib/markdown-clipboard.ts` | Map the preview `cite` element back to `[@…]` for round-trip copy. |
| Text strippers | `search/chunking.ts` (`embeddingText`), `markdown-outline-navigation.ts`, `markdown-word-count.ts`, `agent/prompt.ts` (syntax list) | Treat citations as their formatted text, or strip them; tell the agent the syntax exists. |
| LaTeX export | `src/lib/latex-chunks.ts`, `latex-generation.ts`, `latex-export.ts` | Protect citation tokens from chunk splitting and from the LLM (§4.6). |
| LaTeX editor | `src/lib/latex/project.ts` (`readBibEntries`), `latex-workspace.tsx`, `latex/codemirror/editing.ts` (`\cite` completion) | Import source now; generated `.bib` mirror later. |
| PDF text | `src/lib/storage/pdf-text-cache.ts` (`readPdfTextCache`) | First-page text and SHA-256 for resolution and re-attachment. |
| AI | `src/lib/openrouter.ts`, `src/lib/ai-preferences.ts`, `electron/ai-preferences.cjs`, `electron/setup.html` | New `AiFunction` `"references"`; web-search option; Preferences section. |
| Agent | `src/lib/agent/runner.ts`, `tools.ts`, `model.ts`, `skills/`, `review-comments.ts`, `storage/markdown-reviews.ts`, `markdown-review.ts` | Fact-check skill, fan-out tool, WebSearch tool, agent suggestion bucket. |
| Background jobs | `src/lib/search/indexer.ts` (globalThis singleton, status endpoint), `document-ocr/pdf-markdown-jobs.ts` | Model for the server-side reference job runner and its client store. |
| Collab | `docs/collaboration/README.md`, `src/lib/collab/suggestions/model.ts` | Phase 5 library sharing; align agent suggestions with `SuggestionRecord` and AI actors. |

Before writing route handlers or other Next code, read the relevant guide in `node_modules/next/dist/docs/` (Next 16.2.6; see `AGENTS.md`).

---

## 4. Technical design

### 4.1 Library service and API

- `src/lib/references/`: types, key generation, CSL normalization, BibTeX/RIS/CSL-JSON parse and serialize, dedupe scoring, citation token parser. Shared by server and client, with no React or Node imports in the pure modules.
- `src/lib/storage/references.ts`: `readLibrary(notebook)`, `updateLibrary(notebook, revision, fn)`, `moveAttachmentPaths`, `copyEntriesForMove`, `reattachByHash`.
- Routes:
  - `src/app/api/references/route.ts`: GET library; PATCH entry operations with a revision check; POST add/import; DELETE.
  - `…/export/route.ts`.
  - `…/resolve/route.ts` (Phase 3).
  - `…/jobs/route.ts` (Phase 3).
  - All guarded by `requireAuth`.
- Client: `src/components/libera/references/` holds `references-panel.tsx`, `reference-card.tsx`, `manage-references-dialog.tsx`, `use-reference-library.ts` (a module store with a `REFERENCES_UPDATED_EVENT` and a BroadcastChannel across windows, like `annotation-sync.ts`) and `citation-popup.tsx`.

### 4.2 Citation parsing and rendering

- **One grammar, three implementations, one shared test table.**
  - The micromark text construct parses for the preview. It must run before link-reference parsing, or `[@key]` is read as a shortcut reference link.
  - The Marked inline tokenizer parses for TipTap.
  - A regex scanner in `libera-syntax.ts` parses for CodeMirror.
  - The scanner logic and its test cases live in `src/lib/references/citation-syntax.ts`. All three layers call it, so they cannot drift. Cases include code spans, math, links, escaped `\[@`, emails and nested brackets.
- **Formatting.**
  - `src/lib/references/format.ts` wraps citeproc-js. Its inputs are the document's ordered citations, the cited entries (CSL-JSON) and the style XML.
  - Outputs are formatted text per citation (numeric styles need document order) and the bibliography HTML.
  - It runs in the preview worker. The main thread posts only the cited entries and style, keyed by library revision, so typing never re-sends the whole library.
  - citeproc-js and its styles are loaded lazily the first time a document contains a citation.
- **Visual editor.** The editor shows formatted text inside the atom node. Formatting is recomputed per document after edits, debounced, so it stays off the keystroke path.
- **Source editors.** These show the raw token, styled as a chip. The key is underlined red when unresolved, and a hover tooltip shows the formatted reference.

### 4.3 Autocomplete

- `reference-suggestions.ts`: an in-memory index over the current notebook's library (key, family names, year, title words, tags, notes). It uses the prefix-then-substring ranking of `file-suggestions.ts`, and boosts entries already cited in this document and entries cited recently.
- Trigger detection is shared, in `citation-syntax.ts` (`citationTriggerAt(text, offset)`), so the textarea and CodeMirror behave identically.
- **TipTap:** add `@tiptap/suggestion` at the installed TipTap version (3.31.x), or write a small ProseMirror plugin if the package's API does not fit. It renders the same `citation-popup.tsx`.
- **Phase 5:** semantic queries such as “that paper about sparse attention I highlighted” fall through to Global Search's hybrid index, restricted to the notebook's attachments and their PDF highlights. The matched file is then mapped back to its entry.

### 4.4 Capture and resolution (Phase 3)

The pipeline for each input is: **identify → fetch authoritative metadata → normalize → dedupe → confirmation card.**

1. **Identify.**
   - Regexes for DOI, arXiv (old and new style), ISBN-10/13 with checksum, PMID/PMCID, and URLs. URLs are fetched once to read `citation_doi` / `citation_*` meta tags.
   - Text that is not an identifier is treated as a reference string, or split into one reference per line or numbered item when it is a pasted bibliography.
2. **Fetch.**
   - Sources: Crossref (`/works/{doi}`; `query.bibliographic` for strings), DataCite, arXiv API, OpenAlex (also links preprints with their published versions), PubMed E-utilities, and Open Library for ISBNs.
   - Each host has its own rate limiter and response cache, keyed by identifier.
   - Crossref's polite pool needs a contact email, which Preferences can set. It is empty by default, and Libera never fills it with the account email on its own.
3. **PDFs.**
   - Read `readPdfTextCache` pages 1–2 and the pdf.js document metadata.
   - Find a DOI or arXiv ID in that text and resolve it.
   - With no identifier: the LLM extracts `{title, authors, year, venue}` as validated JSON from the first-page text; Crossref/OpenAlex are searched bibliographically; candidates are scored on title similarity, author overlap and year.
   - Above the threshold the entry becomes `needs-review` with the candidate filled in. Below it the entry stays `unresolved` with the LLM fields at low confidence.
   - GROBID is not required. It can be an optional extractor later (D7).
4. **LLM with web search.** Used when no authoritative source exists: reports, theses, web pages, books outside the catalogues, Markdown notes. It is enabled by the **Allow web search** option (per job, defaulting to the Preference).
   - Uses OpenRouter's web plugin (`plugins: [{ id: "web" }]`), added as an option to `requestOpenRouterCompletion`. The `:online` model suffix is avoided because it changes the endpoint lookups that `getModelProfile` keys on.
   - The model must return a source URL for every field. Fields get `llm-web` provenance and the entry is always `needs-review`.
5. **Markdown documents.** A Markdown file can be an attachment, for example a PDF converted with PDF to Markdown, or the user's own note. A converted `<PDF name>.md` is attached to the PDF's existing entry rather than creating a new one. For other notes, the LLM proposes an entry (type `manuscript` / `webpage` / `report`) from the heading, front matter and first section.
6. **Normalize.**
   - Name parsing with particles (`van der`, `de la`) and suffixes.
   - Titles stored as published. Case conversion happens in CSL and the BibTeX exporter, which protects acronyms and proper nouns.
   - En-dash page ranges.
   - Journal abbreviations from Crossref's `short-container-title`. An ISO 4 / LTWA table comes later.
   - Every field records its provenance and confidence.
7. **Dedupe.**
   - Exact match on any identifier.
   - Otherwise a fuzzy score on normalized title + first author family name + year (±1).
   - Preprint and published versions (OpenAlex locations, Crossref `relation`, arXiv `journal_ref`/DOI) are offered as **one work**: the published version's metadata, the preprint kept in `versions`, one key.
   - Merging keeps the older key, and the other key becomes an alias, so no document breaks.
8. **Confirm.** A new entry's confirmation card shows the result and the disagreements. **Confirm** sets `confirmed`. Bulk confirmation is available in the dialog for entries whose fields all have confidence ≥ 0.9 from an authoritative source.

**Background jobs.**

- `src/lib/references/jobs.ts` is a server-side runner held as a `globalThis` singleton, like `SearchIndexer`. Its queue persists in the notebook's `references/jobs.json`, so jobs resume after a restart.
- Concurrency limits: 2 for network lookups, 2 for LLM calls, one notebook at a time.
- Each job reports state, progress and errors. There is cancellation, and every result is written as its own library transaction, so a stopped job keeps what it finished.
- Triggers:
  - The panel's **Generate entries for PDFs without one**.
  - Dropping a file on the panel.
  - An optional Preference: **Create entries for new PDFs automatically**, hooked where uploads call `notifySearchChanges`.
- The panel polls `/api/references/jobs` only while a job is active, and shows a progress line plus a **Review N new entries** shortcut.

**Privacy.** The online lookup and LLM steps each have a Preference toggle. Lookups send only identifiers or title/author strings. The LLM step sends the first-page text with the user's own OpenRouter key. Nothing is sent without an explicit action unless the automatic Preference is on.

### 4.5 Fact-check skill (Phase 4)

A new agent skill, `fact-check-citations` (`src/lib/agent/skills/fact-check-citations.ts`, registered in `skills/index.ts`). It loads when the user asks the agent to fact-check or verify citations, or from a **Fact-check citations** button in the References panel and the Markdown toolbar, which starts an Agent run with the skill preloaded. Like `leave-review-comments`, it never edits the document. It produces review comments and suggested edits, so it works in every permission mode, including Read Only.

**Tools added by the skill:**

- **ListCitations(path).** Deterministic. Parses the draft and returns every citation occurrence:
  - an occurrence id (`c1`…),
  - the claim (the sentence, plus the paragraph for context),
  - keys, locators and resolved entry summaries,
  - attachment paths with page counts,
  - static problems: unknown key, entry without attachment, locator beyond the PDF's last page, entry `unresolved`.
- **CheckCitations(groups).** The fan-out (below).
- **LeaveComment.** Reused from `leave-review-comments`, with the same review copy and `finishPass` placement checks.
- **SuggestEdit(path, before, after, reason, commentIds?).** New. Records a pending suggested edit (see “Suggested edits” below).
- **WebSearch(query).** Offered only when the run has **Allow web search** on. It is a separate OpenRouter call with the web plugin, returning results with URLs and snippets.

**Fan-out.**

1. The parent groups occurrences by cited source, then packs groups into batches of **at most 3 sources** (2 when a source's attachment is longer than about 150 pages). A subagent then reads each source once and checks every claim that cites it. Batching keeps each child's context small, so it does not hit max turns, and it isolates mistakes.
2. `CheckCitations` runs one child `runAgent` per batch, at most 4 at once, each with its own `ToolContext` that shares nothing mutable with the parent:
   - **Tools:** Read, Grep and Glob, restricted to the batch's attachments plus the document. WebSearch is added when enabled.
   - **Limits:** 15 turns, 5 minutes, and a token cap.
   - **System prompt:** a short verifier prompt that says to quote, not paraphrase.
   - **Output:** the child must finish by calling `SubmitVerdicts`. Its JSON schema is validated, and the child gets one repair round. This is structured output through a tool call, so free text is never parsed.
3. Verdicts per occurrence: `supported` · `partially-supported` · `not-supported` · `contradicted` · `cannot-verify` · `source-missing`. Each verdict carries:
   - evidence `{path, page | line, quote}[]` and `webSources {url, title, quote}[]`,
   - a confidence,
   - an optional `suggestedText` and `suggestedCitation`.
4. **Evidence verification (anti-hallucination).** The parent checks every evidence quote deterministically: normalized-whitespace, quote-insensitive fuzzy match against the PDF text cache or the file. It also checks that the page matches.
   - A quote that cannot be found is dropped.
   - A verdict that loses all its evidence is downgraded to `cannot-verify — evidence not found in source`.
   - Web quotes are kept only with a URL and are always labelled as web evidence.
5. **Reference existence check.** Deterministic, no LLM. An entry with a DOI is checked against Crossref/DataCite. Without one, a bibliographic search is run. An entry that does not resolve and has no attachment is reported as **possibly hallucinated reference**. An entry with an attachment whose first page does not match its metadata is reported as **metadata/attachment mismatch**.
6. **Missing references** (optional, on by default). One extra child scans paragraphs that make factual or quantitative claims without a citation. It Greps the notebook's attachments for supporting passages and proposes `[@key, p. N]` as a suggested edit, or comments “uncited claim — no source found in this notebook”.
7. The parent writes the results:
   - A comment on each problem occurrence, quoting the evidence with the page.
   - A suggested edit where the fix is concrete: wrong locator, overstated claim, wrong key.
   - A final report in the reply:
     - counts per verdict,
     - sources not found locally,
     - possibly hallucinated references,
     - occurrences not checked because of limits, with a **Continue** action that runs only those.

**Runner changes.**

- `runAgent` returns the final assistant text and the summed usage.
- Child runs emit nested `subagent_started` / `subagent_finished` events, rendered in `agent-activity.tsx` as collapsible “Checking smith2020sparse, lee2021 (3 claims)” lines.
- Child token usage is added to the parent's usage requests.
- A whole-run budget (total input tokens across children) is shown before the run starts, as an estimate from the number of batches, and is enforced.

**Suggested edits.** The agent can create comment threads today, but `ReviewSuggestion`s exist only inside an Agentic Review session. Add an **agent suggestions** bucket to `ReviewDocument`, separate from `session`. Its records have the same `ReviewSuggestion` shape, anchored with `anchorAt` and remapped by `syncReview`. They render with the existing review-change UI (`tiptap-review.ts` / `codemirror-review.ts`), with Accept, Reject and Request revision. The model should match the collab `SuggestionRecord` (AI actor, `commentIds`, `baseQuote`), so Phase 3 collab suggestions can absorb it.

### 4.6 LaTeX export

The Markdown → LaTeX export is LLM-driven and currently forbids bibliography tools.

- **Phase 2:** replace each citation with its formatted text and append the formatted bibliography before chunking. Each citation is wrapped in an opaque placeholder so `latex-chunks.ts` cannot split it and the LLM cannot alter it. This exactly matches the Markdown PDF output.
- **Later:** emit `\parencite[p.~12]{key}` / `\textcite`, write the cited entries to a `.bib` next to the generated `.tex`, and run biber through the existing `latex/build.ts` path.

---

## 5. Delivery phases

The first milestone (Phases 1–2) is the Markdown integration. Each phase ends with its tests passing on `npm run test:editor` (against the known baseline in `docs/collaboration/progress.md`) and a browser check in the dev preview.

**Phase 1: Library core and panel**

- Types, key generation, CSL-JSON, and BibTeX/RIS/CSL-JSON import and export.
- Storage transaction, API routes and the client store.
- References panel: list, search, filters, detail card, manual add by pasting BibTeX/RIS or an identifier stub, edit, delete.
- Manage references dialog (table, merge, bulk delete, export).
- Attachment pointer updates in every `files.ts` / `notebooks.ts` mutation, plus re-attachment by hash on tree load.
- Tests: parse and serialize round trips (escaping, accents, `&`, braces), key stability under metadata edits, rename/move/copy/archive/delete of attachments, revision conflicts.

**Phase 2: Citations in Markdown (first usable milestone)**

- Citation grammar in `citation-syntax.ts`, with the shared case table.
- Micromark construct, TipTap atom node, CodeMirror decoration, clipboard mapping, text strippers and agent prompt syntax.
- citeproc-js formatting in the preview worker; bundled styles; bibliography block; unresolved-key chip; hover card; open PDF at the locator page.
- `@` popup in the textarea, CodeMirror and TipTap editors; **Cite at cursor** from the panel; “Cited in this document” filter and highlighting.
- Cross-notebook move copies cited entries; key change leaves an alias plus an optional rewrite; Markdown PDF export bibliography; LaTeX export placeholder path.
- Tests: grammar table across all three parsers, Visual round trip byte-identical, numeric style ordering, popup trigger rules (email, code, math, link destinations), preview cache invalidation by library revision, move/copy scenarios.

**Phase 3: Zero manual entry**

- Identifier detection; Crossref, DataCite, arXiv, OpenAlex, PubMed and ISBN clients with rate limits and a cache.
- PDF resolution from text and metadata; LLM extraction with validated JSON; web-search option in `openrouter.ts`; `AiFunction` `"references"` plus Preferences UI.
- Background job runner, persisted queue and panel progress.
- Normalization, dedupe, preprint/published grouping, confirmation cards with provenance and conflicts.
- Paste-a-reference in the add box and the `@` popup's **Add reference from…** row.
- Tests: recorded HTTP fixtures (never live services in CI), mocked model responses as in review mode, job resume after restart, cancellation.

**Phase 4: Fact-check**

- Runner support for child runs (final text, usage, nested events); `CheckCitations`, `SubmitVerdicts`, `ListCitations`, `SuggestEdit`, `WebSearch`.
- Agent suggestions bucket in the review DB plus UI; evidence verification; reference existence check; missing-reference pass; report; budget estimate.
- Tests: seeded documents with planted errors (wrong page, overstated claim, fabricated reference, uncited claim), mocked children returning fabricated quotes, which must be downgraded; batching rules; limits; Read Only mode.

**Phase 5: Later**

- Quote with locator. A PDF selection menu action **Quote and cite** (in `pdf-viewer.tsx`, next to Copy) and drag from the PDF into an editor. Both insert `> quote` plus `[@key, p. N]` using the selection's page number. Dragging uses a new `application/x-libera-citation` MIME type.
- Semantic `@` search through Global Search; references indexed as their own search source, like the gallery.
- Retraction and correction checks: Crossref `update-to` / Retraction Watch data, a periodic check, and a badge on entries and citations.
- Generated `references.bib` mirror for LaTeX projects in the notebook, wired into the LaTeX editor's `\cite` completion.
- Shared libraries for collab notebooks: the library as a `Y.Map` sub-document of the project manifest, one record per entry, with field-level merge.
- Screenshot or photo of a reference list through the local OCR model, then the pasted-bibliography path.
- Narrative citations; per-document styles; ISO 4 abbreviations; optional GROBID.

---

## 6. Decisions to confirm

| # | Decision | Recommendation | Alternative |
| --- | --- | --- | --- |
| D1 | Citation syntax | Pandoc-compatible bracketed `[@key, p. 12]`, parsed by Libera's own construct; bare `@word` is never a citation | A Libera-only form such as `[cite=key p=12]`: no collision with link syntax, but not portable to Pandoc, Quarto or Obsidian |
| D2 | Library storage | Hidden `.libera/references/library.json` per notebook; collab sharing in Phase 5 | Visible `references.json` / `.bib` in the notebook: syncs today, but loses provenance or risks CRDT-corrupted JSON |
| D3 | Default CSL style | APA 7 (author-date) | Chicago author-date or IEEE |
| D4 | Narrative citations (`@key says`) | Deferred; use `[-@key]` for now | Support bare `@key` in v1, with email/handle exclusions |
| D5 | Scope of citations | A document cites only its own notebook's library; cross-notebook moves copy entries | One library-wide store with per-notebook views |
| D6 | Web search mechanism | OpenRouter web plugin inside a dedicated WebSearch tool / resolution step | `:online` model suffix, or a provider's native web search |
| D7 | PDF metadata extractor | pdf.js text + identifiers + LLM fallback | Bundle or require GROBID (Java service) |
| D8 | Fan-out batch size and concurrency | ≤ 3 sources per subagent, 4 concurrent, 15 turns each | User-configurable in Preferences |
