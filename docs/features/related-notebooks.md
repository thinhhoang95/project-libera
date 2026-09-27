# Related notebooks

Selecting a notebook highlights other notebooks referenced by its saved Markdown files. Highlighted rows have a tinted background, an accent edge, and a link icon. Relationships are outgoing: a link from Alpha to Beta highlights Beta while Alpha is selected. Existing visibility settings still apply.

The server stores a versioned link index in each notebook's `.libera/notebook-links.json`, inside the data directory so it travels with the notebook through the user's folder sync. The index contains destinations per Markdown file and its modification time and size. It is rebuilt for missing or changed entries when the file tree loads or refreshes after saving. Unchanged files are not read or parsed, and unchanged indexes are not rewritten. Older libraries are indexed on their first tree load.

Parsing happens on the server, outside the editor's typing/render path. Markdown links and reference links are supported; code examples and images do not create relationships. Resolution uses the same relative-path and workspace-path rules as opening links in the editor. Cached destinations are resolved against the current tree to exclude missing targets; self-links are ignored. Only files included in the tree contribute, including archived files when archives are included. Renaming or moving files does not rewrite their Markdown links.

Validation: `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/notebook-links.test.ts scripts/editor/last-notebook.test.ts scripts/editor/markdown-link-input.test.ts`
