# Related notebooks

Selecting a notebook highlights other notebooks referenced by its saved Markdown files. Highlighted rows have a tinted background, an accent edge, and a link icon. Relationships are outgoing: a link from Alpha to Beta highlights Beta while Alpha is selected. Existing visibility settings still apply.

## Backlinks

While a file is open, the panel highlights the files whose saved Markdown links to it — notes, PDFs and photos alike, across notebooks. Highlighted rows have a tinted background, an accent edge and a link icon. Collapsed notebooks and folders show how many backlinking files they contain. The server records each Markdown file's resolved targets as `linkedFilePaths` on its tree node, from the same link index; the panel inverts them for the open file. Image embeds (`![](…)`) don't count, and backlinks update when the tree refreshes after a save.

## Links dialog

The visual and source Markdown toolbars have a **Backlinks and forward links** button (network icon). It opens one dialog with two lists:

- **Backlinks**: saved notes that link to this one. Each linking note is read once when the dialog opens, and each link is listed with its line and the paragraph text around it. Choosing one opens that note at the link's line.
- **Forward links**: links in the note being edited, read from the current draft, so unsaved links are included. They are grouped by destination: library files, web links, and links whose target is not in the library. Choosing one follows the link.

The search box keeps the links whose note name, path, address or surrounding text contains every word typed, and marks the matches. ↑/↓ move through the results, Enter opens one, and Tab switches lists. Excerpts come from the same Markdown parse as the link index (`src/lib/markdown-link-occurrences.ts`), so both agree on what counts as a link.

The server stores a versioned link index in each notebook's `.libera/notebook-links.json`, inside the data directory so it travels with the notebook through the user's folder sync. The index contains destinations per Markdown file and its modification time and size. It is rebuilt for missing or changed entries when the file tree loads or refreshes after saving. Unchanged files are not read or parsed, and unchanged indexes are not rewritten. Older libraries are indexed on their first tree load.

Parsing happens on the server, outside the editor's typing/render path. Markdown links and reference links are supported; code examples and images do not create relationships. Resolution uses the same relative-path and workspace-path rules as opening links in the editor. Cached destinations are resolved against the current tree to exclude missing targets; self-links are ignored. Only files included in the tree contribute, including archived files when archives are included. Renaming or moving files does not rewrite their Markdown links.

Validation: `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/notebook-links.test.ts scripts/editor/note-links-dialog.test.ts scripts/editor/last-notebook.test.ts scripts/editor/markdown-link-input.test.ts`
