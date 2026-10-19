# Libera

A liberal notetaking app built with Next.js, TypeScript, Tailwind CSS, filesystem storage, password authentication, and KaTeX-backed Markdown math rendering.

## Getting Started

Copy the example environment file and choose local settings:

```bash
cp .env.example .env.local
```

For development, the app accepts `LIBERA_DEV_PASSWORD` when `LIBERA_PASSWORD_HASH` is not set. The default development password is `libera`.

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

The app uses the Next.js App Router in `src/app`.

## Collaboration

Real-time collaboration lives on the `collaboration` branch. The collaboration server, desktop host, shared notebooks, comments, suggestions, and reviews are implemented and tested; the first production deploy, the private beta, and some manual checks (IME input, macOS and ExFAT file watching, restore drill) are still open. See [SETUP.md](SETUP.md) to run and deploy the collaboration server, [docs/collaboration/README.md](docs/collaboration/README.md) for the architecture, and [docs/collaboration/progress.md](docs/collaboration/progress.md) for status.

- **Shared notebooks.** The owner shares an existing notebook (**Share notebook…**) and invites members by email or link. Members join from the invitation and get the notebook as a normal folder under their master directory. Markdown, LaTeX (`.tex`, `.bib`, `.sty`, `.cls`), and other text files are collaborative documents; images, PDFs, and other binaries sync as content-addressed blobs. File and folder changes (create, rename, move, delete) sync for everyone, and removed files go to `_archive`.
- **Live editing.** Edit together in the Visual, Source, and LaTeX editors. Edits never wait on the network: they are saved to a local SQLite log first and synced in the background, and you can keep editing offline and reconnect later. Each shared tab shows a status pill (Saved on this device, Syncing…, Saved to workspace, Offline, Read-only, Access changed) in place of Save.
- **Presence.** See collaborators' avatars, cursors, and sections, with a quiet mode, and follow a collaborator (follow mode works in the Source and LaTeX editors only).
- **Roles.** Owner, Editor, Commenter, and Viewer, enforced on the server for every update and command. Only owners invite members, change roles, or delete the notebook.
- **Comments.** The Comments panel works on shared documents with replies, resolve, `@` mentions of members, and comments that stay anchored as the text changes. A comment whose text was deleted shows as detached and can be reattached to a new selection. Comments made offline are queued and sent when you reconnect. Notifications (bell, optional desktop notifications, and an email digest) cover mentions, replies, and invitations.
- **Suggestions.** Propose edits as tracked changes without changing the text, with author colors. The Suggestions panel offers filters, grouping, stepping, accept or reject (one or all), and undo of an acceptance. Suggest mode is available in the Source and LaTeX editors, is forced for Commenters, and the Visual editor has **Suggest edit** on a selection. The server applies each decision exactly once and marks suggestions stale when the text underneath changed.
- **Reviews.** Request a review of a whole document or a selection. Reviewers approve a specific revision, approvals are marked outdated when the document changes, and the Reviews tab tracks them.
- **History.** Automatic and named revisions with a viewer that colors changes by author. Restore a whole document or just a selection as a new edit, so nothing in the history is rewritten. An owner-only Activity log lists who did what.
- **AI in shared notebooks.** AI runs on your machine with your OpenRouter key and appears as an attributed author ("AI · requested by …"). It can edit what you could edit, comment, and suggest, but it can never accept, reject, or approve. In shared notebooks, AI Rewrite, Write with AI, AI Format, Agentic review, and the Agent produce attributed edits or suggestions, and the agent's undo withdraws its pending suggestions.
- **Editing outside Libera.** Shared files are a working copy on disk, so search, backlinks, LaTeX builds, and other programs keep working. Edits made in other programs are merged into the shared document, with a reconciliation view when they collide with remote changes.
- **Accounts.** Collaboration accounts live on the collaboration server (email, display name, color), separate from the local app password. Registration is invitation-only: an admin creates a registration code with the admin CLI (`signup-code create`) unless the server enables open sign-up. Sign in under Preferences → Collaboration; devices stay signed in until unused for 90 days.
- **Self-hosting.** The server runs on Postgres with disk or S3-compatible blob storage and deploys to a VPS with Docker and nginx (`npm run collab:deploy`). It includes an admin recovery CLI (inspect, export, rebuild, verify, account management), nightly backups with a restore drill, Prometheus metrics and alerts, and scrubbed error reporting.
- **Not shared yet.** PDF and image annotations, tags, stars, AI chat history, linked folders, and the reference library stay local. The Agent cannot create new files in shared notebooks, and shared notebooks have a few other limits, listed in the progress file.

## Storage

Libera stores files under `LIBERA_DATA_DIR`, with `./data/libera` as the local fallback. The single-admin master directory is:

```text
${LIBERA_DATA_DIR}/users/admin
```

Direct child folders are notebooks. Files inside notebooks currently support:

- Markdown: `.md`, `.markdown`
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`
- PDFs: `.pdf`

The API rejects unsafe paths that escape the admin master directory.

Images in the Image Gallery are kept separately, in `${LIBERA_DATA_DIR}/gallery`. See [Image Gallery](#image-gallery).

## Math Rendering

Markdown rendering is wired through:

- `react-markdown`
- `remark-math`
- `rehype-katex`
- `katex`

Use `$...$` for inline math and `$$...$$` for block math.

Use `[color=#dc2626]colored text[/color]` for inline text color.
Use `>>>highlight<<<` or `y>>>highlight<<<` for yellow highlights, and
prefix other highlight colors by shortcut, such as `r>>>red highlight<<<`.

Use `y> Box text` for a yellow box. Boxes share the highlight palette:
`y` yellow, `r` red, `o` orange, `a` amber, `g` green, `t` teal,
`b` blue, `v` violet, `p` pink, and `s` slate. Plain `>` keeps the default grey box.
Repeat the prefix on each line, including blank lines between paragraphs:

```markdown
y> **Remember**
y>
y> - First item
y> - Second item
```

Choose **Box color** in either editor toolbar to apply a box or change its color.
In Source, it applies to the current line or all selected lines; on narrow panels,
expand the toolbar to find it. In Visual, use **Quote** to remove the box.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run electron:dev
npm run electron:start
npm run electron:dist
npm run electron:dist:mac:unsigned
```

`electron:dist:mac:unsigned` builds the Apple Silicon DMG and ZIP without
discovering a signing identity or submitting the app for notarization. It is
intended for local/testing distribution and does not support macOS automatic
updates.

## Electron App

### Dependencies shared between macOS and Windows

Native packages in `node_modules` cannot be shared directly between operating
systems. Electron and Next.js both install platform-specific binaries. Set up
the dependency cache once on each machine instead:

```bash
npm run deps:setup
```

This creates a separate ignored cache for the current OS and CPU architecture
(for example, `.platform-deps/win32-x64` or
`.platform-deps/darwin-arm64`) and moves the active dependency directory into
the project. Running the command again reuses that cache immediately. It only runs `npm ci` again when
`package.json` or `package-lock.json` changes. The first run preserves an
existing real `node_modules` directory under `.platform-deps/legacy-*`.

Check which cache is active with `npm run deps:status`. On Windows, the complete
safe setup-and-build command is:

```powershell
npm run electron:dist:win:safe
```

The Windows installer is written to `dist-electron/`. Build macOS packages on
macOS and Windows packages on Windows; the caches avoid reinstalling dependencies
but do not make native code-signing tools cross-platform.

Electron production builds use Next.js' supported Webpack build mode and start
from a clean `.next` directory. This also supports Windows workspaces on shared
or removable filesystems that do not implement junctions or `readlink` with
standard NTFS behavior.

Run the desktop app in development with:

```bash
npm run electron:dev
```

On macOS arm64, `electron:dev` automatically starts Electron and Next.js from a
local temporary app directory, avoiding compilation stalls on external ExFAT
volumes. `npm run dev:mac` also starts this launcher directly. It uses the macOS
dependencies from either the platform cache or the active `node_modules`, even
when Windows dependencies are active in the project. Source edits are mirrored
into that directory for development; the active dependencies and the project's
`.next` output are left unchanged. The temporary directory is removed when the
app exits. If the macOS cache is missing or stale, run `npm run deps:setup` on
macOS first.

Electron development starts Next.js with webpack because Turbopack's persistent
dev cache can fail on external macOS volumes that create `._*` sidecar files.
Startup allows up to 90 seconds for an HTTP response, with 30 seconds per request
so the initial page can compile. Server exits are reported immediately. Quitting
or interrupting the app stops the Next.js CLI and its server subprocesses.

Run it against a production Next.js build with:

```bash
npm run electron:start
```

On first launch, Electron requires a fixed `LIBERA_DATA_DIR`, an `OPENAI_API_KEY`,
and an app password. These values are stored in the Electron user-data directory
instead of `.env`, then injected into the local Next.js server at startup. The
desktop shell clears the Libera session cookie on every launch, so the password
login screen is shown each time the app starts.

## Electron automatic updates

Packaged macOS ARM64 and Windows x64 applications check the platform-specific
feed at `https://libera.intuelle.com/stable/`, download newer versions in the
background, and offer to restart after the download finishes. Update restarts
are disabled while an open Markdown document has unsaved edits.

Configure nginx and the Let's Encrypt certificate once from a machine with the
server SSH key:

```bash
npm run electron:update-server:setup
```

The command defaults to `root@185.214.135.181`, `~/.ssh/id_ed25519`, and
`/srv/libera-updates`. Override those values when needed:

```bash
LIBERA_UPDATE_SSH_TARGET=root@example.com \
LIBERA_UPDATE_SSH_KEY=/path/to/id_ed25519 \
LIBERA_UPDATE_REMOTE_ROOT=/srv/libera-updates \
npm run electron:update-server:setup
```

Before releasing, bump the stable semantic version in `package.json` and commit
the release. The release scripts reject dirty tracked files and versions that
are not newer than their respective remote feed.

Build, sign, notarize, and publish Apple Silicon macOS from the Mac build
machine:

```bash
export CSC_LINK=/path/to/developer-id-application.p12
export CSC_KEY_PASSWORD='certificate password'
export APPLE_API_KEY=/path/to/AuthKey_KEYID.p8
export APPLE_API_KEY_ID=KEYID
export APPLE_API_ISSUER=ISSUER_UUID
export APPLE_TEAM_ID=TEAMID
npm run electron:release:mac
```

Build, sign, and publish Windows x64 from the Windows build machine:

```powershell
$env:WIN_CSC_LINK = "C:\secure\authenticode.pfx"
$env:WIN_CSC_KEY_PASSWORD = "certificate password"
npm run electron:release:win
```

Append `-- --dry-run` to build and verify without contacting the update server.
Append `-- --allow-dirty` only when intentionally releasing uncommitted tracked
changes. Both machines require OpenSSH/SCP and must trust the server host key.
Certificates, passwords, API keys, and SSH keys must remain outside the repo.

Release artifacts are uploaded to a staging directory. Binaries and blockmaps
are installed first and updater metadata is replaced atomically last. The five
most recently activated releases for each platform are retained on the server.

Existing macOS users must manually install one signed and notarized baseline
release before automatic updates can work; Squirrel.Mac cannot update an
unsigned application. After that baseline, keep using the same signing identity.

## Tooling

- Next.js
- TypeScript
- Tailwind CSS
- ESLint

## Password Hashes

Production should set `LIBERA_PASSWORD_HASH` and `LIBERA_SESSION_SECRET`. Password hashes use:

```text
scrypt:<salt>:<hash>
```

You can generate one from the project with:

```bash
node -e "const { randomBytes, scryptSync } = require('crypto'); const password = process.argv[1]; const salt = randomBytes(16).toString('hex'); console.log(`scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`);" "your-password"
```

### Visual Markdown editing

Markdown notes open in the **Visual** editor, powered by the open-source TipTap editor. Select text to apply bold, italic, underline, text colors, colored highlights, or font sizes. **Line spacing** formats the selected text, or the current paragraph when the caret is collapsed. The editor respects the workspace's default font size and line spacing.

Drop or paste PNG, JPEG, GIF, or WebP photos into a note, or use **Insert image**. Images are saved through the existing Markdown asset API and keep relative asset paths in the Markdown file. Upload errors appear above the editor. Click a rendered equation or use **Insert or edit equation** to edit LaTeX with a live KaTeX preview; both inline and display equations are supported.

Use **Enumerate Headings** in the visual toolbar to number all headings or selected headings with a custom starting value. The same actions are available in the right-click menu, along with **Indent Headings**, **Unindent Headings**, **AI Format**, and **AI Rewrite**. Right-click a photo for **AI Image to Markdown**. Numbering preserves heading formatting and supports undo. AI results replace the original selection while preserving edits elsewhere; if that selection changes during the request, retry on the updated text.

Turn on **Smart Paste** in Preferences → General to paste Markdown with headings into either editor so it fits the document: the pasted text's highest heading is moved to the document's highest heading level (the highest numbered level, in a numbered document), and if any heading is numbered, every heading is renumbered so the numbering continues through the pasted text (`1.1` or `1.1.` style is kept). Unnumbered headings above the numbered level, such as a title, are left alone. The paste is a single undo step; pastes without headings, or into code, are unchanged. Restart Libera after toggling it.

Both editors can snip a region of an open image or PDF tab, either as a picture or read into Markdown (see [PDF to Markdown](#pdf-to-markdown)). Use **Source** to access the existing source/preview workflow, file-link picker, and slide controls. Slide decks continue using the source editor. Both modes edit the same Markdown draft; use the save button or Cmd/Ctrl+S to save. TipTap may normalize Markdown whitespace and delimiters after a visual edit; simply opening a note does not rewrite it.

Libera highlights (`y>>>text<<<`) and text colors (`[color=#2563eb]text[/color]`) retain their existing syntax. Underlines use `<u>text</u>`. Font size and line spacing use safe numeric span attributes, for example `<span data-font-size="24" data-line-height="2">text</span>`, supported by both the visual editor and Markdown preview/export. Other Markdown viewers may ignore these presentation attributes.

Run the editor's Markdown round-trip regression tests with `npm run test:editor`.

## LaTeX PDF export

Use the optional **Custom instructions** textarea to guide the model (for example, add a table of contents or style section headings). Instructions are saved with the other export settings and applied during generation and automatic repairs. The field accepts up to 10,000 characters; selected page settings take precedence.

Click **LATEX** in either the WYSIWYG or Source Editor toolbar to configure and export the current draft. Set an optional author and a date (today by default); choose A4 (default), Letter, or A5 paper; margins in inches (left/right 1, top/bottom 1 by default); image width as a fraction of text width (0.75 by default); and optional header/footer text. Choose a 10pt, 11pt, or 12pt (default) article font size. Custom headers are centered. An empty footer shows the current page number / total pages in the same footer position. Custom footers are left-aligned unless **Show app name** is checked, which centers the custom footer and places “Libera for Vy Tran” on the right. Click **Generate PDF** to save these settings and begin. The settings persist on disk across app restarts and are shared by both editors. Libera uses the configured OpenRouter API key and LaTeX model settings (default: `openai/gpt-5.6-luna` with low reasoning). It splits the Markdown into ordered chunks sized to about 10,000 output tokens each (roughly 30,000 characters of English; less for CJK and other dense scripts), leaving headroom under the 16,000-token response limit. The whole export runs as one conversation with a single session id, so the growing prompt prefix can be served from the provider's prompt cache: the model first writes the shared preamble, then converts each chunk in order with the preamble and earlier chunks in view. A reply cut off by the token limit is continued in place. Chunks may request extra `\usepackage` lines, which Libera moves into the shared preamble. Block end comments verify that every block was converted once, in order; a rejected reply is sent back in the same conversation (up to three attempts), and on a chunk's last attempt a complete-looking response with garbled comments is accepted. Libera then joins the pieces and compiles them with `pdflatex`. Each compiler error is returned to the same conversation with numbered source lines around the failure, and the model answers with small SEARCH/REPLACE edits, repeated until the PDF compiles (at most eight rounds). The dialog shows progress, supports cancellation, and provides a PDF preview plus **Save PDF** and **Save LaTeX** downloads.

Install TeX Live or MiKTeX on the computer running Libera. `pdflatex` is discovered from `PATH` or the standard macOS TeX location; set `LIBERA_PDFLATEX_PATH` to an executable path and restart Libera if needed. In the desktop app, compilation runs on the user's computer; a remotely hosted web instance compiles on its server. Exports use temporary directories, disable shell escape, and restrict TeX file access. Documents are limited to 200,000 characters and exports time out after 15 minutes. Local Markdown images are resolved using the document’s notebook asset paths, converted to PNG, and copied into the temporary compilation directory. Embedded PNG/JPEG/GIF/WebP images are supported. Unreadable or nonlocal image sources produce an explicit error. Image exports include a LaTeX ZIP download with all referenced image files. External bibliography tools are not used. Long paragraphs split at plain-text whitespace, code at complete lines, lists at item boundaries, and tables at whole rows with repeated headers. Inline syntax and display equations stay intact, and reference links/footnotes retain their definitions across chunks. An indivisible block longer than two chunks fails with a request to split it manually. Block tracking detects missing or empty blocks but cannot guarantee sentence-level fidelity; review the generated PDF when content accuracy matters.

Libera remembers the last selected notebook in the workspace data and reopens its home page on startup. Opening a file or switching tabs also updates this selection. If that notebook no longer exists, Libera opens the first available notebook.

## Split panels

Work on several files side by side by splitting the editor area into panels. Choose **Split Right** or **Split Down** in the file actions menu (Cmd/Ctrl+\ and Cmd/Ctrl+Shift+\), or right-click a tab and choose **Open to the Right** or **Open Below**. You can also drag a tab onto a panel: the highlighted zone shows whether it will split left, right, up, or down, or replace the panel's file. Panels can be split again in either direction. Drag a divider to resize panels, or double-click it to even them out. **Close Panel** and **Close Other Panels** are in the same menu. Each file shows in one panel at a time, so two editors never change the same draft. The layout is saved with the workspace.

## Links between notes

Libera follows the Markdown links between your files, so you can see how notes, PDFs, and photos connect.

- **Backlinks in the Notebooks panel.** When a file is open, every note that links to it is highlighted in the left panel with a link icon. A collapsed notebook or folder shows how many linking notes it contains.
- **Related notebooks.** Selecting a notebook highlights the other notebooks its notes link to.
- **Links dialog.** Click **Backlinks and forward links** (the network icon) in the Visual or Source toolbar to see both directions in one place. **Backlinks** lists the saved notes that link to this one. **Forward links** lists every link in the note, including ones you haven't saved yet, grouped into library files, web links, and links whose target is missing. Each link shows its line and the text around it. Type in the search box to filter by note name, path, or surrounding text, then use ↑/↓ and Enter to open a result. Tab switches between the two lists. Opening a backlink jumps to the line that holds the link.

Links count when they are written as Markdown links (`[text](path)` or reference links). Images embedded with `![](…)` and links inside code are not counted. Backlinks update when the linking note is saved. See [docs/features/related-notebooks.md](docs/features/related-notebooks.md) for details.

## Reference manager

Every notebook has its own reference library. Notes cite its entries with Pandoc-style citations, and Libera formats them in the notebook's citation style and builds the bibliography. See [docs/features/references.md](docs/features/references.md) for the full guide, and [docs/references/](docs/references/) for the plan and progress.

- **References panel.** Open **References** in the left rail (Cmd/Ctrl+7). Search by key, author, year, title, venue, tags, and notes, and filter by All, Cited in this document, Needs review, Uncited, Duplicates, or Missing PDF. Each entry has a card showing the formatted reference, abstract, identifiers, attachments, citing notes, and where every field came from (Crossref, PDF, LLM + web, You).
- **Manage references.** A table of the whole library for bulk work: sort, edit in place, merge duplicates, delete, confirm, change type, re-resolve, and export a selection. The last 20 changes can be undone.
- **Add almost anything.** Paste or drop a DOI, arXiv ID, ISBN, PubMed ID, URL, BibTeX/BibLaTeX/RIS/CSL-JSON text or file, a plain-text reference or whole bibliography, a PDF or Markdown note, or a screenshot of a reference list. Libera looks each one up in Crossref, DataCite, arXiv, OpenAlex, PubMed, or Open Library and asks you only to confirm. Preprints and their published versions are treated as one work, and duplicates offer Attach, Merge, or Add anyway.
- **Generate entries for PDFs.** Create entries for every unattached PDF in a notebook as a background job, or automatically for new PDFs. AI can optionally search the web for reports, theses, and pages the databases miss, and those entries always need review.
- **Cite as you write.** Type `@` in the Visual, Source, or classic editor to pick a reference, including by meaning through Global Search. Use `[@key]`, `[@key, p. 12]`, `[@a; @b]`, `[see @key, ch. 3]`, `[-@key]`, or narrative `@key`. Hover a citation for its reference, notes, and **Open PDF at p. 12**; unknown keys show in red.
- **Citation styles and bibliography.** APA 7, Chicago author-date, IEEE, Vancouver, Nature, and Harvard are bundled, and any `.csl` file in the notebook works. A note can override the style in its front matter. The bibliography is generated at the end of the note, or at a `:::bibliography` block.
- **Quote and cite from PDFs.** Insert a selection as a quote with its citation and printed page number, from the PDF's selection menu or by dragging it into a note.
- **Citations that never break.** Notes cite keys, not file paths, so renaming or moving a PDF changes nothing. Renamed keys leave aliases and can update citing notes after a preview, and moving a note to another notebook copies the references it cites.
- **Import and export.** Export the library, a selection, or just the works a note cites as BibTeX, BibLaTeX, CSL-JSON, or RIS, with optional ISO 4 journal abbreviations, or as a formatted list. Markdown PDF export includes citations and the bibliography. LaTeX export keeps citations as formatted text, or can use biblatex with a generated `.bib`, and LaTeX projects can keep a `references.bib` mirror with `\cite{…}` completion.
- **Retraction checks.** Entries with DOIs are checked weekly against Crossref's retraction and correction notices, and affected works are marked in the panel, on citations, and in the bibliography.
- **Fact-check citations.** Start an Agent run that checks every citation against its source, verifies each quote against the source text, confirms that cited references exist, and flags uncited factual claims. It leaves review comments and suggested edits and never changes the note itself.
- **Global Search.** References and your PDF highlights are searchable under the References filter.

Lookups send only identifiers, titles, and author names. When AI is used, the first pages of a PDF go to your AI provider with your own OpenRouter key. Preferences → AI → **References** controls the model, online lookups, AI fallback, web search, and automatic entries. The library is stored in the notebook's `.libera/references/` folder. Shared collaborative notebooks do not share their library yet.

## AI writing and editing

### AI Rewrite and Write with AI

Right-click selected text in either editor and describe the change under **AI Rewrite**. Right-click without a selection to use **Write with AI**, which writes new text at that spot as its own paragraph, so existing paragraphs and lists are never split. In either prompt, type `/` to pick a saved quick prompt (configured as `quickPrompts` in the config file, or in `LIBERA_QUICK_PROMPTS`). **Include whole document as context** sends the full document along with the selection; it is on by default and remembered on each device.

### Live previews of AI edits

In the Visual and LaTeX editors, AI Rewrite, Write with AI, AI Format, AI Image to Markdown, and Agentic review show their results in place as a diff, like a code review: removed text is struck through next to the new text, and unchanged text stays as it is. Each change has its own **Accept** and **Reject** buttons, and a bar at the top of the editor counts the changes, steps through them with **Previous change** and **Next change**, and offers **Accept all** (Cmd/Ctrl+Shift+Enter) and **Reject all** (Cmd/Ctrl+Shift+Backspace).

### Agentic review

Comment on a document, then let the AI work through the comments. Turn on **Review mode** with its button in the tab bar of a Markdown or LaTeX document, select a passage in either editor, and add a comment (Cmd/Ctrl+Alt+M). Comments appear in the **Comments** panel of the left rail, where you can reply, edit, resolve, reattach a comment to a new selection, delete, and search them. Comments work in Markdown and LaTeX documents.

Click **Agentic review** in the Comments panel to open the review in the chat panel. The AI first writes a plan that covers each selected comment, notes conflicts and open questions, and explains when no edit is needed. Discuss and revise the plan in the conversation, and type `@` to include reference files. **Confirm plan & generate changes** then turns the plan into separate proposals, each showing the original and proposed text with its reason. Accept or reject each proposal, or use **Request revision** to have one redone. Changes that only work together are marked as linked and accepted together. **Accept all remaining**, **Reject all remaining**, and **Undo acceptance** are also available. Nothing changes in the document until you accept it.

### Copy and paste from AI services

Paste answers from ChatGPT, Claude, Gemini, or other AI chats straight into either editor. Rich text is converted into Libera's Markdown, keeping headings, lists, tables, and formatting, and equations rendered with KaTeX paste as their LaTeX source. If a pasted answer writes math as `\(...\)` or `\[...\]`, click **Fix ChatGPT equations** in the Source toolbar to switch it to the math markers Libera uses. Copying rendered text from Libera, including AI chat answers, puts Markdown on the clipboard, with equations as LaTeX.

### AI Agent

Switch the AI panel from **Chat** to **Agent** to have the AI work on your library itself: it searches notes and PDFs, reads what it needs, and edits files, showing each step as it goes. Choose what it may change next to the switch: **Read Only**, **Modify opened files only**, or **Modify all files in Notebook/Folder**. PDFs are read from their cached extracted text, page by page, never sent whole. Edits appear in open tabs at once, and every changed file can be undone from the reply. Put conventions for the agent in an `AGENT_NOTES.md` file at a notebook's root.

See [docs/features/ai-agent.md](docs/features/ai-agent.md) for permissions, tools, undo and limits.

## Global Search

Open **Search** in the left rail (Cmd/Ctrl+6), or press Cmd/Ctrl+Shift+F anywhere, to search every notebook, linked folder and the Image Gallery. Describe what you are looking for in your own words, put words in quotes for an exact phrase, or paste, drop or pick an image to find similar photos. Images sit in the box between words, so “photos like [image] but at night” searches by both. Results show the matching passage with its page, section or lines and a preview, and open at that passage in the editor or PDF viewer.

Search combines meaning and exact words. Meaning comes from Google's EmbeddingGemma 2, which runs on this computer through Transformers.js in a background worker process; its weights stay outside the app. Choose the text model and vision encoder files in Preferences → Search, or run `npm run search:download-model` to download them. Without weights, Search still finds exact words. The index is a single SQLite file (full-text and sqlite-vec vector tables) kept on this computer in Libera's application data, outside the Master directory so a synced notes folder never uploads it (or in a file chosen in Preferences). The first index is built only when you click **Build index**, so you can instead choose an index built before with **Use existing index…**. After that it is kept up to date in the background: only changed passages are embedded again.

See [docs/features/global-search.md](docs/features/global-search.md) for details and measured speeds.

## Voice memos

Upload recordings (M4A, MP3, WAV, OGG, FLAC, …) to a notebook and open them in a player with a waveform, transport controls and, beside it, a timestamped transcript with who said what. Transcribe on this computer with NVIDIA Parakeet TDT 0.6B v3, or with an OpenRouter speech-to-text model such as `openai/whisper-large-v3`; speakers are told apart on this computer with pyannote either way. Long recordings are cut at quiet moments into pieces and joined back on one timeline. Transcripts are sidecars that follow their recording, are found by Global Search (the audio itself is never indexed) and can be searched within the panel. Like the other models, the speech models stay outside the app, in a folder chosen in Preferences → Speech, which also sets the voice memo and dictation engines.

AI Chat reads the transcript of the memo you are playing; quote lines from the transcript with ⌘/Ctrl+Shift+L. Search within a transcript or in Global Search with `speaker:Name`. Export transcripts as Markdown (a new note, a note beside the recording, or a file), plain text, SRT or WebVTT, and link a note to a moment (`memo.m4a#t=185`). In shared notebooks, recordings sync as blobs and transcripts as companion files every member sees. AI Chat, the Agent, Agentic Review, Write with AI and AI Rewrite also take dictated prompts through the same speech-to-text engines, and the agent finds memos by searching their transcripts.

See [docs/features/voice-memos.md](docs/features/voice-memos.md) for details.

## Read aloud

Have Libera read text out loud: a selection in any editor or PDF, or the AI's replies. Markup is cleaned up first, so headings, emphasis, list bullets, link URLs and citations are not spoken, code blocks are said as "code omitted" and math as "equation".

- **Editors.** Select text and choose **Read Out Loud** from the right-click menu in the Visual (TipTap) editor, both Markdown Source editors (textarea and CodeMirror), the LaTeX editor, and the code editor used for every other text file. In `.tex` files, comments, `\cite`/`\ref`/`\label` and markup commands are dropped and wrapped source lines are read as one paragraph; code and plain text are read as written. The code editor's right-click menu also has Cut, Copy and Paste.
- **PDFs.** Select text and press the speaker button (**Read out loud**) in the selection toolbar, next to Copy and Quote and cite. The selection is read as the same clean text that Copy produces.
- **AI Chat and Agent.** Each finished reply has a speaker button beside Copy, which becomes a stop button while that reply is read. **Auto Read** in the chat's ⋯ menu reads every reply aloud as soon as the model finishes; stopped or failed replies are skipped. The setting is remembered on this computer.
- **Playback bar.** While something is read, a bar at the bottom of the window shows progress with **Pause** and **Stop**, and explains any failure (no API key, missing model folder, provider error). Starting something new stops what was playing. Speech starts after the first sentence: the text is read in short passages while the next ones are prepared.

Choose the engine in Preferences → **Read Aloud**:

- **OpenRouter** (default). Any OpenRouter text-to-speech model; the default `hexgrad/kokoro-82m` costs well under a dollar per million characters. The voice field suggests the chosen model's voices (`af_heart` by default).
- **This computer.** Kokoro 82M (Apache-2.0) through sherpa-onnx, the runtime voice memos already use; nothing leaves the computer. Like the other models, the weights stay outside the app: extract a sherpa-onnx Kokoro release (`kokoro-multi-lang-v1_0`, its int8 variant, or `kokoro-en-v0_19`) and choose the folder. 53 voices across American and British English, Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese.
- **Speed** from 0.75× to 2×. Changes apply without restarting. Web deployments use the `LIBERA_TTS_*` variables instead.

See [docs/features/read-aloud.md](docs/features/read-aloud.md) for the user guide and [docs/read-aloud/implementation.md](docs/read-aloud/implementation.md) for how it is built and how to extend it.

## PDF to Markdown

Read PDF pages, scanned books, and images into Markdown on this computer, with no cloud service. Line breaks, page numbers, running headers, and words hyphenated across lines or pages are cleaned up. Tables, formulas (with your math markers), lists, code, and figures come out as Markdown.

- **Snip as Markdown.** In either editor, click the text-scan button next to the snipping tool, then drag a rectangle over a PDF or image tab. The Markdown is inserted at the cursor, and figures inside the snip are saved as images next to the note.
- **Convert PDF to Markdown.** In a PDF tab, click the text-scan button in the toolbar and choose the pages. Libera writes `<PDF name>.md` next to the PDF and saves after every page. The conversion keeps running while you switch tabs, and **Stop** keeps what was read so far.

The model is IBM's granite-docling-258M (Apache-2.0), run on the CPU through Transformers.js in a background worker process. Like the Global Search weights, it lives in a folder you choose in Preferences → Search → **PDF reading model**. The first time you use either feature, Libera offers to download it there (about 600 MB), or you can put the files from Hugging Face there yourself. Expect several seconds for a small snip and one to three minutes for a full page. Small print such as footnotes can be missed; pages the model could not finish are listed when the conversion ends.

See [docs/features/pdf-to-markdown.md](docs/features/pdf-to-markdown.md) for setup, file layout, and how it works.

## Image Gallery

Open the **Image Gallery** tab in the left rail (Cmd/Ctrl+5). The left panel generates images and the main area shows the gallery. Open documents stay as they were while the gallery is in front.

### Generating images

Describe the image and press **Generate** (Cmd/Ctrl+Enter). Libera uses OpenRouter's Images API with the configured OpenRouter API key. The model list comes from OpenRouter, and each model shows only the settings it supports: aspect ratio, resolution, quality, background, format, compression, number of images, and seed. The default model is `google/gemini-3.1-flash-image`; set `LIBERA_AI_IMAGE_MODEL` to change it. The model, its settings (remembered per model), and the save destination persist across restarts in `.libera/image-generation.json`.

Add **Reference photos** for models that edit or build on photos: use **Add**, drop photos on the panel, or paste them into the prompt. Photos larger than 2048 px are scaled down before they are sent, and the panel shows how many photos the chosen model accepts. In the gallery, **Use as reference** sends photos to the panel.

Under **Save to**, choose the gallery (optionally an album) or a **Notebook folder**. Images saved to a notebook folder stay with the notebook and do not appear in the gallery.

### Browsing

**Photos** shows every photo grouped by day, **Starred** collects starred photos, and **Albums** lists albums. Sort newest or oldest first. Change the thumbnail size with the zoom buttons, the slider, `+`/`-`, or pinch (Cmd/Ctrl+scroll), and switch between a square grid and a layout that keeps each photo's shape. Hover a photo to select it or star it; Shift-click selects a range, a day's checkbox selects the whole day, Cmd/Ctrl+A selects everything, and Esc clears the selection. With photos selected you can star them, add them to an album, use them as references, or delete them. Deleting removes the files from disk.

### Albums

Albums are folders inside the gallery folder; photos outside any album sit at its top level. Creating an album creates a folder with its name and moves the chosen photos into it. This is the only time photos move on disk. Adding photos to an existing album, removing them, and deleting an album only change the gallery's index (`.libera-gallery.json`), so a photo can belong to several albums and deleting an album never deletes photos. Renaming an album renames its folder when that name is free. Folders and photos added in Finder or Explorer are picked up: a new folder becomes an album, and photos moved by hand keep their stars and albums. In **Starred**, **Create album** turns the starred photos into an album.

### Viewing and editing

Click a photo to open the viewer. Zoom with the scroll wheel, pinch, double-click, `+`/`-`/`0`, or the zoom buttons, and drag to pan. Use the arrow keys for the previous and next photo, S to star, Space for a slideshow, F for full screen, and I for info (date, size, albums, location on disk, model, and prompt, with **Reuse prompt**). Photos can also be downloaded or copied.

Press E (or **Edit**) to rotate, flip, and crop (Free, Original, Square, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16), adjust brightness, contrast, saturation, warmth, tint, and vignette, or apply a filter preset. **Save** (Cmd/Ctrl+S) replaces the photo and keeps the original, so **Revert to original** in the info panel can undo it; **Save as copy** adds a new photo beside the original, in the same albums. The saved photo uses the same calculations as the preview. SVG images cannot be edited.

To view a photo next to notes and PDFs, right-click it (or select one photo, or use the viewer's button) and choose **Open in tab**, **Open to the right**, or **Open below**. Gallery photos open as read-only image tabs and work with split right and split down.
