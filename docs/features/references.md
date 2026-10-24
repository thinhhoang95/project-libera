# References

Every notebook has its own reference library. Notes cite its entries with Pandoc-style citations. Libera formats them in the notebook's citation style and builds the bibliography for you. You add references by pasting or dropping almost anything. Libera looks each one up in scholarly databases and asks you only to confirm.

## The References panel

Open **References** in the left rail (⌘/Ctrl+7). It shows the library of the notebook you are working in.

- **Search** matches keys, authors, years, titles, venues, tags and notes, regardless of case and accents. Every word must match.
- **Filters**:
  - **All**
  - **Cited in this document**: the open note, including unsaved text. Keys the note cites but the library lacks appear at the top in red, with **Add to library…**.
  - **Needs review**
  - **To read**
  - **Uncited**
  - **Duplicates**
  - **Missing PDF**
- **Tags** filter the list too, together with the filter above: choose one in the tag menu next to the filters, or click a `#tag` on a row or in a card. The active tag shows as a chip; × clears it.
- **Sort** by author, year, title, **Recently added** or **Recently cited** (the latest change to a note that cites the entry; uncited entries last).
- Search, filter, tag and sort are remembered per notebook, also after Libera restarts.
- **Rows** show authors and year, title, venue, key, up to two tags, attachments, status, the reading flag and how many notes cite the entry. Entries cited by the open note are tinted like backlinks.

### Keyboard

In the list:

| Key | Action |
| --- | --- |
| ↑/↓ | Move through the list |
| Shift+↑/↓ | Extend the selection |
| Enter or Space | Open the entry |
| ⌘/Ctrl+Enter | Cite the entry, or the selection, at the cursor |
| ⌘/Ctrl+A | Select every listed entry |
| ⌘/Ctrl+C | Copy the key (or keys) |
| ⌘/Ctrl+Shift+C | Copy the formatted reference (or references) |
| E | Edit all fields |
| Delete | Delete the entry or the selection, after confirming when anything cites it |
| Esc | Clear the selection |
| / or ⌘/Ctrl+F | Search |

In a card, ↑/↓ open the previous and next entry of the list, Esc or Space returns to the list, and ⌘/Ctrl+Shift+Enter confirms the entry and opens the next one to review.

### Command palette

The command palette (⌘/Ctrl+Shift+P) has the panel's actions under **References**, from anywhere in the app. They act on the library of the active document's notebook, or the selected notebook, and show the panel when it is closed:

- **Cite a reference…** puts the cursor in the panel's search. Type, press ↓ to pick an entry, and ⌘/Ctrl+Enter cites it at the cursor of the Markdown document you were in. In the editor itself, typing `@` does the same. With an empty library it opens the Add box instead.
- **Add references…**, **Insert bibliography here**, **Manage references…**, **Generate entries for PDFs without one**, **Fact-check citations…** and **Undo last reference change**.
- **Copy reference list**, **Copy bibliography of this document**, **Export library as** BibTeX, BibLaTeX, CSL-JSON or RIS, **Export reference list as** plain text, Markdown or HTML, and **Export bibliography of this document as** any of these.
- **Citation style:** each bundled style. A notebook's own `.csl` styles are in the panel's menu.
- **References: show** all, cited in this document, needs review, to read, uncited, duplicates or missing PDF.

Actions that need a citing document, such as **Copy bibliography of this document**, say in the panel why they cannot run.

### Selecting several entries

⌘/Ctrl-click adds or removes an entry, and Shift-click selects a range. A bar above the list then acts on the whole selection:

- cite all of them at the cursor as one citation, `[@a; @b]`;
- copy them as `[@a; @b]`, as `\cite{a,b}` or formatted;
- add a tag to all of them, or remove a tag they carry;
- mark them **To read** or **Read**;
- confirm or delete them.

### The card

Selecting an entry opens its card. It shows:

- the reference formatted in the notebook's style;
- the abstract, identifiers as links and attachments;
- the notes that cite it. The arrow next to a note lists each citation with the text around it; clicking one opens the note with that citation selected;
- your own notes and tags. The tag field suggests the library's tags;
- the reading flag: **To read** or **Read**, or neither;
- where every field came from ("Crossref", "PDF", "LLM + web", "You"), with confidence on hover.

The arrows at the top move to the previous and next entry of the list, with its position ("3/17"). When sources disagree, the card shows each alternative and you choose one. Fields with low confidence can be edited in place. **Confirm** marks the entry as checked. While others in the list still need review, **Confirm & next** confirms it and opens the next one. **Edit all fields** opens the full form.

**Attach file…** picks a PDF or note of the notebook to attach, and **Add link** attaches a web address. × next to an attachment removes it; the file itself is kept. Next to the key, buttons copy the key, the citation `[@key]` and `\cite{key}`.

**Manage…** opens a table of the whole library for bulk work:

- sort and filter columns;
- select ranges;
- edit titles, years and venues in place;
- merge, delete, confirm, change type, re-resolve or export the selection;
- add a tag to the selection, or remove one;
- review duplicates.

**Undo** reverses the last 20 changes made in this window.

## Adding references

Paste into the **Add** box or drop onto the panel:

- **A DOI, arXiv ID, ISBN, PubMed ID or URL.** Libera looks it up on Crossref, DataCite, arXiv, OpenAlex, PubMed or Open Library. For a URL it reads the page's citation tags.
- **BibTeX, BibLaTeX, RIS or CSL-JSON text, or such a file.** It is imported directly. `.bib`, `.ris`, `.nbib` and `.json` files dropped from your computer are imported from their text, without being added to the notebook. Such files in a notebook can also be imported from the file's context menu (**Import into References**).
- **A reference as text, or a whole bibliography.** Each reference is matched against the databases.
- **A PDF or Markdown note.** Libera reads the PDF's first pages and metadata, finds its DOI or arXiv ID, and checks that the identifier belongs to this paper rather than to one in its reference list. Without an identifier, AI reads the title and authors from the first page, and the databases are searched for them. Several dropped files are processed as one background job.
- **A screenshot or photo of a reference list.** It is read with the local OCR model, then handled like a pasted bibliography.

Each result appears as a confirmation card, with its provenance and any disagreements. A reference that is already in the library offers **Attach to existing**, **Merge into existing** or **Add anyway**. A preprint and its published version are treated as one work. **Add & confirm** is available only when every field comes from an authoritative source.

**Generate entries for PDFs without one** processes every unattached PDF in the notebook in the background. You can keep working, cancel, and review the new entries when it finishes. A notebook can also create entries automatically for new PDFs. This setting is in the panel menu and defaults to the Preference.

**Search the web** lets AI look for sources the databases don't cover, such as reports, theses and web pages. Every field it finds must name the page it came from, and such entries always need review.

### Privacy

Lookups send only identifiers, titles and author names, to Crossref, DataCite, OpenAlex, arXiv, PubMed and Open Library. When AI is used, the first pages of a PDF go to your AI provider with your own OpenRouter key.

Preferences → AI → **References** sets:

- the model;
- whether to look up metadata online;
- whether to use AI when no source is found;
- the default for web search;
- an optional contact email for the Crossref and OpenAlex polite pools;
- automatic entries for new PDFs.

## Citing

Type `@` in any editor (Visual, Source or the classic editor) to open the citation picker.

- It searches the library by key, author, year, title and notes, and lists the note's existing citations first.
- Descriptions of three or more words (in the picker's search field, or joined with `-` after `@`) also search the meaning of your references, their PDFs and your highlights, under **From your library's meaning**. Choosing a PDF page or highlight cites that page. This needs a Global Search index; without one, keyword matches are shown.
- **Enter** inserts `[@key]`. **Tab** inserts it and moves to the page number. **Shift+Enter** inserts a narrative citation, `@key`.
- When you type a DOI or another identifier after `@`, **Add reference from…** looks it up, adds it and cites it.

The syntax:

| Source | Meaning |
| --- | --- |
| `[@smith2020sparse]` | Parenthetical citation |
| `[@smith2020sparse, p. 12]` | With a page or another locator (`ch.`, `sec.`, `fig.`, …) |
| `[@smith2020sparse; @lee2021]` | Several works |
| `[see @smith2020sparse, ch. 3]` | With a prefix |
| `[-@smith2020sparse]` | Without the author: "Smith says (2020)" |
| `@smith2020sparse` or `@smith2020sparse [p. 12]` | Narrative: "Smith (2020)" |

- A bare `@word` is a citation only when the word is a key in the library. Email addresses and handles stay text.
- Citations are formatted in the notebook's style, chosen in the panel menu. The bundled styles are APA 7, Chicago author-date, IEEE, Vancouver, Nature and Harvard; any `.csl` file in the notebook also works.
- A note can choose its own style with **Document style** at the top of the References panel. This writes `citation-style: ieee` into the note's front matter; slide decks use a `$citation-style = "ieee"` line instead. **Notebook default** removes it.
- The bibliography is generated at the end of the note, or wherever a `:::bibliography` line followed by `:::` appears. **Insert bibliography here**, in the panel menu, adds that marker after the paragraph at the cursor.
- Hover a citation to see the reference, abstract, notes, how many highlights its PDF has, and **Open PDF at p. 12**. Keys missing from the library are shown in red.
- **Quote and cite**, in a PDF's selection menu or a highlight's menu, inserts the passage as a quote with its citation into the last note you edited. The page is the printed page number, taken from the PDF's page labels or from the entry's page range. You can also drag a selection from the PDF into a note. If the note is in another notebook, the entry is copied into that notebook's library first.
- References are also part of **Global Search**, under the References filter. Your PDF highlights are indexed with their PDFs.

## Citations that never break

- Notes cite keys, not file paths, so renaming or moving a PDF never changes a note. Libera updates the entry's attachment. Files moved outside Libera are found again by their content.
- Keys are generated once (family name, year and first title word) and never change on their own.
- When you rename a key, the old key keeps working as an alias. **Update citations…** rewrites the notes that use it, after a preview, and can be undone. Merging duplicates works the same way.
- Moving a note to another notebook copies the references it cites into that notebook's library, renaming keys only when they would clash.

## Exporting

- **Library:** the whole library or a selection, as BibTeX, BibLaTeX, CSL-JSON or RIS. Journal names can be abbreviated (ISO 4). A formatted reference list is available as text, Markdown or HTML.
- **This note:** only the works it cites, in the same formats.
- **Markdown PDF export:** includes formatted citations and the bibliography.
- **LaTeX export:** keeps citations as formatted text by default. Alternatively, **Citations: biblatex** writes `\parencite`/`\textcite`, a `.bib` file and `\printbibliography`, and compiles with biber.
- **LaTeX projects:** a notebook can keep a generated `references.bib`. It is off by default, set in the panel menu, and never overwrites a hand-edited file. The LaTeX editor offers library keys in `\cite{…}` and can add the bibliography to a project.

## Checking citations

- **Retractions.** Libera checks entries with DOIs against Crossref's retraction and correction notices, including Retraction Watch, once a week while online lookups are on. Retracted, withdrawn, corrected and expression-of-concern works are marked in the panel, on citations and in the bibliography preview.
- **Fact-check citations**, in the Markdown toolbar and the References panel menu, starts an Agent run with the `fact-check-citations` skill. The agent:
  - lists every citation and the claim it supports;
  - gives each group of up to three sources to a separate checker that may read only those sources;
  - checks every quote the checkers return against the source text, discarding quotes that aren't there;
  - checks that each cited reference exists;
  - looks for factual claims that cite nothing.

  It leaves review comments and suggested edits, never changing the note itself. Its reply reports what is supported, what isn't, what couldn't be checked, and references that may be invented. With web search allowed, sources that aren't in the notebook are checked on the web.

Any agent run can also look up the library with the **References** tool.

## Storage

- Each notebook's library is `.libera/references/library.json`, with linked folders keeping theirs in Libera's data folder. It travels with the notebook through folder sync. Shared (collaborative) notebooks don't share their library yet.
- Every change is a revision-checked transaction, so two windows never overwrite each other.
- The citation index (`references/citations.json`), background jobs, rewrite backups and the `.bib` mirror state sit next to the library.

## Known limits

- In the Visual editor, bold or italic around a citation is split at the citation when saved.
- The classic editor shows citations as plain text, without chips. Hover and ⌘/Ctrl+click work.
- Notes indexed by Global Search before citations existed keep their old search text until they are next edited.

## Implementation

- Library model, formats and syntax: `src/lib/references/`. The plan and lane history are in `docs/references/`.
- Storage and the citation index: `src/lib/storage/references.ts` and `src/lib/storage/reference-citations.ts`.
- Lookups and jobs: `src/lib/references/resolve/` and `src/lib/references/jobs.ts`.
- Routes: `src/app/api/references/`.
- UI: `src/components/libera/references/`.
- Agent: `src/lib/agent/references-tool.ts`, `src/lib/agent/skills/fact-check-citations.ts` and `src/lib/agent/fact-check/`.
- Tests: `scripts/editor/references-*.test.ts`.
