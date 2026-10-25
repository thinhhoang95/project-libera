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

Real-time collaboration lives on the `collaboration` branch. The collaboration server, desktop host, shared notebooks, shared gallery albums, comments, suggestions, and reviews are implemented and tested; the first production deploy, the private beta, and some manual checks (IME input, macOS and ExFAT file watching, restore drill) are still open. See [SETUP.md](SETUP.md) to run and deploy the collaboration server, [docs/collaboration/README.md](docs/collaboration/README.md) for the architecture, and [docs/collaboration/progress.md](docs/collaboration/progress.md) for status.

- **Shared notebooks.** The owner shares an existing notebook (**Share notebook…**) and invites members by email or link. Members join from the invitation and get the notebook as a normal folder under their master directory. Markdown, LaTeX (`.tex`, `.bib`, `.sty`, `.cls`), and other text files are collaborative documents; images, PDFs, and other binaries sync as content-addressed blobs. File and folder changes (create, rename, move, delete) sync for everyone, and removed files go to `_archive`.
- **Live editing.** Edit together in the Visual, Source, and LaTeX editors. Edits never wait on the network: they are saved to a local SQLite log first and synced in the background, and you can keep editing offline and reconnect later. Each shared tab shows a status pill (Saved on this device, Syncing…, Saved to workspace, Offline, Read-only, Access changed) in place of Save.
- **Presence.** See collaborators' avatars, cursors, and sections, with a quiet mode, and follow a collaborator (follow mode works in the Source and LaTeX editors only).
- **Roles.** Owner, Editor, Commenter, and Viewer, enforced on the server for every update and command. Only owners invite members, change roles, or delete the notebook.
- **Comments.** The Comments panel works on shared documents with replies, resolve, `@` mentions of members, and comments that stay anchored as the text changes. A comment whose text was deleted shows as detached and can be reattached to a new selection. Comments made offline are queued and sent when you reconnect. Notifications (bell, optional desktop notifications, and an email digest) cover mentions, replies, and invitations.
- **Suggestions.** Propose edits as tracked changes without changing the text, with author colors. The Suggestions panel offers filters, grouping, stepping, accept or reject (one or all), and undo of an acceptance. Suggest mode is available in the Source and LaTeX editors, is forced for Commenters, and the Visual editor has **Suggest edit** on a selection. The server applies each decision exactly once and marks suggestions stale when the text underneath changed.
- **Reviews.** Request a review of a whole document or a selection. Reviewers approve a specific revision, approvals are marked outdated when the document changes, and the Reviews tab tracks them.
- **History.** Automatic and named revisions with a viewer that colors changes by author. Restore a whole document or just a selection as a new edit, so nothing in the history is rewritten. An owner-only Activity log lists who did what.
- **Shared albums and photos.** Share a gallery album, or a single photo, from the gallery (**Share**). Members join from the invitation and get the album in their gallery, where contributors add, edit, caption and remove photos and commenters comment on a photo or a marked area of it. Location and camera details are removed from shared photos unless the owner keeps them, and prompts are shared only when the owner chooses. Deleting a photo removes it from every member's computer; **Save to my gallery** keeps a copy. See [Image Gallery](#shared-albums) and [docs/features/shared-albums.md](docs/features/shared-albums.md).
- **AI in shared notebooks.** AI runs on your machine with your OpenRouter key and appears as an attributed author ("AI · requested by …"). It can edit what you could edit, comment, and suggest, but it can never accept, reject, or approve. In shared notebooks, AI Rewrite, Write with AI, AI Format, Agentic review, and the Agent produce attributed edits or suggestions, and the agent's undo withdraws its pending suggestions.
- **Editing outside Libera.** Shared files are a working copy on disk, so search, backlinks, LaTeX builds, and other programs keep working. Edits made in other programs are merged into the shared document, with a reconciliation view when they collide with remote changes.
- **Accounts.** Collaboration accounts live on the collaboration server (email, display name, color), separate from the local app password. Registration is invitation-only: an admin creates a registration code with the admin CLI (`signup-code create`) unless the server enables open sign-up. Sign in under Preferences → Collaboration; devices stay signed in until unused for 90 days.
- **Self-hosting.** The server runs on Postgres with disk or S3-compatible blob storage and deploys to a VPS with Docker and nginx (`npm run collab:deploy`). It includes an admin recovery CLI (inspect, export, rebuild, verify, account management), nightly backups with a restore drill, Prometheus metrics and alerts, and scrubbed error reporting.
- **Not shared yet.** PDF and image annotations, tags, stars, AI chat history, the Protected Archive, linked folders, and the reference library stay local. Shared albums have no public links and download every photo when joined. The Agent cannot create new files in shared notebooks, and shared notebooks have a few other limits, listed in the progress file.

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

Libera keeps its own per-notebook state in a hidden `.libera/` folder inside each notebook, for example the reference library (`references/`), the Where Was I session records (`where-was-i/<device>.json`) and the cards of the Definitions tab (`definitions/`). Linked folders keep this state in the data directory instead of the folder.

Images in the Image Gallery are kept separately, in `${LIBERA_DATA_DIR}/gallery`. See [Image Gallery](#image-gallery).

In the desktop app, each [user](#users) has their own master directory, so `LIBERA_DATA_DIR` is the running user's folder.

## Users

Several people who share one computer (and one operating-system account) can each have their own user in the desktop app. A user has their own master directory, search index, preferences, master password, collaboration sign-in, and browser storage. One user runs at a time.

- **Signing in.** Libera opens the sign-in screen of the last user who signed in. **Switch user**, under the password field, swaps the logo for a bubble of initials per user. Choosing another person restarts Libera as them, and the sign-in screen then asks for their password. The choice holds for one start: if they never sign in, the next start is back to the last user who did.
- **Switching safely.** Before restarting, Libera saves the workspace and pending PDF and image annotations in every window, pop-outs included. If an unsaved document cancels closing, the switch is cancelled.
- **Managing users.** Preferences → **Users** adds, renames, switches to, and removes users, and only works while signed in. Renaming or removing someone else needs their master password. Removing a user moves their settings aside and never touches their notebooks. The first user cannot be removed. At most 8 users.
- **Separate folders.** Two users cannot share a master directory or search index, or put one inside the other's, even through symlinks or junctions. Libera checks this when settings are saved, when a backup is loaded, and at every start.
- **Existing installs.** The first user keeps the original settings files and browser session, so a single-user install needs no migration and an older Libera still opens it. Other users live in `profiles/<id>/` in Electron's `userData` folder, listed in `profiles.json`. A damaged `profiles.json` or a user's broken settings are recovered from, not overwritten.

See [docs/features/users.md](docs/features/users.md) for the full guide.

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

Both editors can snip a region of an open image or PDF tab, either as a picture or read into Markdown (see [PDF to Markdown](#pdf-to-markdown)). Use **Source** to access the existing source/preview workflow and file-link picker. Slide decks always use the source editor (see [Markdown Slides](#markdown-slides)). Both modes edit the same Markdown draft; use the save button or Cmd/Ctrl+S to save. TipTap may normalize Markdown whitespace and delimiters after a visual edit; simply opening a note does not rewrite it.

Libera highlights (`y>>>text<<<`) and text colors (`[color=#2563eb]text[/color]`) retain their existing syntax. Underlines use `<u>text</u>`. Font size and line spacing use safe numeric span attributes, for example `<span data-font-size="24" data-line-height="2">text</span>`, supported by both the visual editor and Markdown preview/export. Other Markdown viewers may ignore these presentation attributes.

Preferences → Markdown → **Accent color** colors headings, list bullets and numbers, and bold text that opens a paragraph or list item (`**Term:** …`, `- **Step** …`) in the Visual editor and rendered previews: one of seven colors, **Spectrum** (a color per heading level), or **Custom…** with your own colors, each with a lighter shade in the dark theme. **Color bold lead-ins** turns the bold text off separately, and **None** leaves headings plain. Colors are display only; the Markdown, PDF export and hand-colored text are unchanged. See [docs/features/heading-colors.md](docs/features/heading-colors.md) for the full guide.

Run the editor's Markdown round-trip regression tests with `npm run test:editor`.

### Charts and live HTML in notes

Notes can hold the same charts and interactive HTML as slides. A fenced block tagged `chart` draws a chart from a few lines of settings, one tagged `mermaid` draws a Mermaid diagram (flowcharts, sequence diagrams, Gantt charts, mind maps and more), and one tagged `html live` runs its HTML, CSS, and JavaScript in a sandboxed frame, with Chart.js loaded. In the Visual editor the drawing appears under the block's code, which stays editable; **Insert chart**, **Insert diagram** and **Insert interactive HTML** in the toolbar add a starter block. The Source editor shows them in its preview, and they print in PDF exports. In notes they follow the app's light or dark theme. Shared notebooks get the same protection as slides: a live block waits for **Run** and never has network access. The AI chat and search results show these blocks as code.

````markdown
```chart
type: line
title: Weekly sign-ups
labels: [W1, W2, W3, W4]
series: [32, 41, 38, 57]
```
````

See [Charts and live HTML in slides](#charts-and-live-html-in-slides) for the settings, and [docs/features/charts-and-live-html.md](docs/features/charts-and-live-html.md) for the full guide.

### Markdown macros

Define LaTeX-style macros in a note's own ```` ```libera-macro ```` block, and use them anywhere in the note. A body wrapped in `$…$` is math: `$\fset$` and a bare `\fset` both render as $\mathcal{F}$. `\newcommand` macros take arguments and expand to Markdown, and `\counter-name` numbers itself in document order with no definition needed:

````markdown
```libera-macro
\fset = $\mathcal{F}$
\norm = $\lVert #1 \rVert$
\newcommand{\theorem}[2]{**Theorem \counter-theorem (#1).** *#2*}
```

Let \fset be closed under $\norm{\cdot}$.

\theorem{Pythagoras}{Given a right triangle with legs $a, b$ and hypotenuse $c$, $a^2 + b^2 = c^2$.}
````

The file keeps the macros as written; the preview, slides, PDF and LaTeX exports show them expanded. In the Visual editor a macro shows its expansion until the caret reaches it, and the macro block folds to **Macros: 3 definitions**. **Expand macros** (the `{}` button in both toolbars) opens a plain-Markdown copy, with every macro replaced and the definitions removed, in a new unsaved tab. AI Chat and the AI Agent render their replies with the macros of the open note and the documents in the conversation, and the Agent keeps a note's macros as written when it edits it. See [docs/features/markdown-macros.md](docs/features/markdown-macros.md) for the full guide.

## Markdown Slides

A file named `*.slides.md` is a slide deck. **New slides** in a notebook's menu creates one. Decks open in the source editor with the slides beside it. The preview follows the caret, and clicking a slide puts the caret on it. Each slide is laid out on a fixed 16:9 canvas and scaled to fit, so the preview, the presentation, and the PDF all show the same slide. When a slide has too much content, its body shrinks to fit, down to about half size. Past that, the preview flags the slide. Slides render math, citations, highlights, and links like notes do, using the same inline and display math markers as your notes.

```markdown
$title = Results from the field
$subtitle = Spring survey, $n = 412$
$author = ["Ada Lovelace", "Grace Hopper"]
$affiliation = Analytical Engine Lab
$date = October 2026
$theme = light
---
## What we measured

- Response time
- Error rate

--

- This appears on the next click

???
Speaker notes: only you see these.
---
## Side by side
$columns = [3, 2]

Left column

|||

Right column
```

- A line with only `---` starts a new slide. The part above the first `---` is the deck's metadata and title slide. A deck may instead open with YAML-style front matter (`---`, then `title: ...` lines, then `---`).
- `$key = value` lines go at the top of a slide, or right under its title heading. A value is a JSON literal (`"text"`, `21`, `true`, `["a", "b"]`) or plain text.
- A leading `#` or `##` heading becomes the slide title (`$title` works too).
- `--` on its own line, after a blank line, is a build step: what follows appears on the next click. Hidden steps keep their space, so nothing jumps.
- `|||` on its own line starts a new column. `$columns = [2, 1]` sets relative widths.
- `???` on its own line starts the speaker notes. Notes show under each slide in the preview, and in speaker view while presenting.
- Slide markers inside code fences and multi-line HTML comments are ignored, so a slide can be commented out with `<!-- ... -->`.

Deck settings: `$theme` (`light`, `dark`, `paper`, `night`), `$accent` (any CSS color), `$aspect` (`16:9`, `16:10`, `4:3`), `$fontsize` (body size in canvas pixels, 21 by default), `$footer` (text, or `false` to hide it; author and title by default), `$paginate` (`false` hides slide numbers), `$transition` (`fade`, `slide`, `none`), `$fit` (`false` turns off shrink-to-fit), and `citation-style`. Slide settings: `$title`, `$layout` (`default`, `top`, `center`, `section` for a divider, `blank` for a full-bleed image), `$columns`, `$fontsize`, `$background` (a CSS color), `$fit`, and `$hidden = true`, which keeps a backup slide in the file but out of the presentation and the PDF. Unknown values are listed above the preview.

### Charts and live HTML in slides

A fenced code block tagged `chart` draws a chart from a few lines of settings, in YAML or JSON. Charts use the slide's theme and a colorblind-safe palette. They have hover tooltips, show a legend when there are two or more series, and include a table of the data for screen readers. They render in every notebook, shared ones included, because they contain only data.

````markdown
```chart
type: bar
title: Revenue by quarter ($k)
labels: [Q1, Q2, Q3, Q4]
series:
  2025: [12, 19, 8, 15]
  2026: [14, 22, 11, 18]
```
````

- `type`: `bar` (default), `line`, `area`, `pie`, `doughnut`, `scatter`, `bubble`, `radar`, or `polarArea`.
- Data comes from `labels` plus `series` (a name for each list of values, or one plain list), or from `data`. `data` can be CSV text (use `data: |` and indent the rows) or the path of a `.csv`/`.tsv` file next to the deck, such as `data: sales.csv`. In CSV, the first column labels the points and each other column is a series; empty or non-numeric cells are gaps. For `scatter`, the first column is x.
- Settings: `title`, `x` and `y` (axis titles), `stacked`, `horizontal`, `smooth`, `legend` (`top`, `bottom`, `left`, `right`, or `none`), `height` (canvas pixels, 300 by default), `min`/`max`, `beginAtZero` (`false` to let the axis start elsewhere), and `colors` (a list of CSS colors; quote hex values, as in `["#0d9488"]`, because YAML reads `#` as a comment).
- For anything else, `options` is merged into Chart.js's own options, and `datasets` replaces `series` with Chart.js datasets.
- A mistake in the settings, or a data file that can't be read, shows a message on the slide in place of the chart.

A fenced block tagged `html live` runs its HTML, CSS, and JavaScript like a small web page inside the slide. Chart.js is already loaded as `Chart`. `libera.colors` holds the slide's series palette, and `libera.theme` its colors and whether it is dark. The block grows to fit its content; add `height=400` after `live` for a fixed height. The code runs in a sandboxed frame with no access to Libera, your files, or your session. In your own notebooks it may load scripts, images, and data over https; it cannot reach other addresses, so pictures from the notebook need an https or `data:` URL. Each block starts when it first scrolls into view. Keys pressed inside the frame still move the presentation, unless focus is in a text field. Script errors show under the block in the editor preview.

A responsive Chart.js canvas is half as tall as it is wide, so a full-width one can make the slide shrink to fit. Wrap the canvas in a `<div style="height:300px">` and pass `maintainAspectRatio: false` to set its height yourself.

````markdown
```html live
<canvas id="growth"></canvas>
<script>
  new Chart(document.getElementById("growth"), {
    type: "line",
    data: { labels: [1, 2, 3, 4], datasets: [{ label: "Users", data: [3, 7, 12, 20], borderColor: libera.colors[0] }] },
  });
</script>
```
````

A fenced block tagged `mermaid` draws a [Mermaid](https://mermaid.js.org/intro/) diagram in the slide's theme: flowcharts, sequence, class, state and ER diagrams, Gantt charts, pies, mind maps, timelines and more. Mermaid runs in strict mode (no scripted clicks or HTML labels), so diagrams render in every notebook, shared ones included.

In a shared notebook, a live block shows a **Run** button instead of running on its own. Once run, it still has no network access. Charts and live blocks print in PDF exports; Libera waits for them to finish drawing first. The same blocks work in notes (see [Charts and live HTML in notes](#charts-and-live-html-in-notes) and [docs/features/charts-and-live-html.md](docs/features/charts-and-live-html.md)).

**Present slides** in the toolbar, or **Present from here** above any slide, starts the presentation in full screen. Advance with →, Space, PageDown, N, or a click; go back with ←, PageUp, P, or a right-click. ↓/↑ skip build steps, and Home/End jump to the first and last slide. Type a number and press Enter to jump to that slide. G opens an overview of every slide, S switches to speaker view (current slide, next step, notes, timer, and clock; T resets the timer), B or `.` blanks the screen black, W or `,` blanks it white, and ? lists the shortcuts. Esc closes an overlay or ends the presentation.

**Download → PDF file** (in the file actions menu, desktop app) prints a deck one slide per page, at the slide's own size, with every build step shown and hidden slides left out. Citations are numbered across the whole deck; put `:::bibliography` on a slide to place the reference list.

## LaTeX PDF export

Use the optional **Custom instructions** textarea to guide the model (for example, add a table of contents or style section headings). Instructions are saved with the other export settings and applied during generation and automatic repairs. The field accepts up to 10,000 characters; selected page settings take precedence.

Click **LATEX** in either the WYSIWYG or Source Editor toolbar to configure and export the current draft. Set an optional author and a date (today by default); choose A4 (default), Letter, or A5 paper; margins in inches (left/right 1, top/bottom 1 by default); image width as a fraction of text width (0.75 by default); and optional header/footer text. Choose a 10pt, 11pt, or 12pt (default) article font size. Custom headers are centered. An empty footer shows the current page number / total pages in the same footer position. Custom footers are left-aligned unless **Show app name** is checked, which centers the custom footer and places “Libera for Vy Tran” on the right. Click **Generate PDF** to save these settings and begin. The settings persist on disk across app restarts and are shared by both editors. Libera uses the configured OpenRouter API key and LaTeX model settings (default: `openai/gpt-5.6-luna` with low reasoning). It splits the Markdown into ordered chunks sized to about 10,000 output tokens each (roughly 30,000 characters of English; less for CJK and other dense scripts), leaving headroom under the 16,000-token response limit. The whole export runs as one conversation with a single session id, so the growing prompt prefix can be served from the provider's prompt cache: the model first writes the shared preamble, then converts each chunk in order with the preamble and earlier chunks in view. A reply cut off by the token limit is continued in place. Chunks may request extra `\usepackage` lines, which Libera moves into the shared preamble. Block end comments verify that every block was converted once, in order; a rejected reply is sent back in the same conversation (up to three attempts), and on a chunk's last attempt a complete-looking response with garbled comments is accepted. Libera then joins the pieces and compiles them with `pdflatex`. Each compiler error is returned to the same conversation with numbered source lines around the failure, and the model answers with small SEARCH/REPLACE edits, repeated until the PDF compiles (at most eight rounds). The dialog shows progress, supports cancellation, and provides a PDF preview plus **Save PDF** and **Save LaTeX** downloads.

Install TeX Live or MiKTeX on the computer running Libera. `pdflatex` is discovered from `PATH` or the standard macOS TeX location; set `LIBERA_PDFLATEX_PATH` to an executable path and restart Libera if needed. In the desktop app, compilation runs on the user's computer; a remotely hosted web instance compiles on its server. Exports use temporary directories, disable shell escape, and restrict TeX file access. Documents are limited to 200,000 characters and exports time out after 15 minutes. Local Markdown images are resolved using the document’s notebook asset paths, converted to PNG, and copied into the temporary compilation directory. Embedded PNG/JPEG/GIF/WebP images are supported. Unreadable or nonlocal image sources produce an explicit error. Image exports include a LaTeX ZIP download with all referenced image files. External bibliography tools are not used. Long paragraphs split at plain-text whitespace, code at complete lines, lists at item boundaries, and tables at whole rows with repeated headers. Inline syntax and display equations stay intact, and reference links/footnotes retain their definitions across chunks. An indivisible block longer than two chunks fails with a request to split it manually. Block tracking detects missing or empty blocks but cannot guarantee sentence-level fidelity; review the generated PDF when content accuracy matters.

Libera remembers the last selected notebook in the workspace data and reopens its home page on startup. Opening a file or switching tabs also updates this selection. If that notebook no longer exists, Libera opens the first available notebook.

## Split panels

Work on several files side by side by splitting the editor area into panels. Choose **Split Right** or **Split Down** in the file actions menu (Cmd/Ctrl+\ and Cmd/Ctrl+Shift+\), or right-click a tab and choose **Open to the Right** or **Open Below**. You can also drag a tab onto a panel: the highlighted zone shows whether it will split left, right, up, or down, or replace the panel's file. Panels can be split again in either direction. Drag a divider to resize panels, or double-click it to even them out. **Close Panel** and **Close Other Panels** are in the same menu. Each file shows in one panel at a time, so two editors never change the same draft. The layout is saved with the workspace.

## Command palette

Press Cmd/Ctrl+P to jump to any file by name. The palette lists your recent files first; type to fuzzy-search the notebooks (files in the selected notebook rank higher), then press Enter to open the file, or Cmd/Ctrl+Enter to open it beside the current panel.

Press Cmd/Ctrl+Shift+P, or type `>` at the start of the box, to switch to commands. The palette lists the tools of the focused editor or viewer, including every toolbar button, tab, and option, along with app-wide actions, each with its keyboard shortcut. The **Definitions** commands have the AI Agent generate (or regenerate) the definitions and notation of the document in view, or open its Definitions tab. In a PDF, **Generate PDF outline** has it outline a PDF without bookmarks, and **Show PDF annotations** opens the Annotations tab. In a PDF, the annotation styles are listed whatever tool is in use (for example **Markup style: Underline**, **Highlight color: Green**, **Shape: Arrow**, **Ink color: Blue**, **Stroke width: Thick stroke**, **Note font: …** and **Note font size: larger**); a style applies to the selected annotation, or to the next one you make. The PDF also offers **Add comment**, **Next page**, **Previous page**, **First page** and **Last page**, and, while Find is open, **Next match** and **Previous match**. The gallery and photo viewer have their own commands (see [docs/features/gallery-timeline.md](docs/features/gallery-timeline.md)). Commands you used recently appear at the top. Delete the `>` to go back to files. Use ↑/↓ to move, Enter to run, and Esc to close.

## Where Was I

Open a notebook's home to see **Where you left off**: two to four AI bullet points about what you did there in your last session, the files you edited, created, or viewed (hover for a short excerpt of each change), including uploads and other files added without being opened, and the files added or changed since you left, such as a collaborator's edits in a shared notebook or files copied in or synced from another computer.

Libera keeps the session in memory and writes it only when you close a file you edited and when the app quits, never while you type. It keeps at most 12 files per notebook and two short excerpts per file, in the notebook's `.libera/where-was-i/` folder, one file per computer so synced folders never conflict. In shared notebooks, your record stays on your computer, and changes from collaborators are labelled as theirs. Each finished session is summarized once, with only file paths, change sizes, and the excerpts sent to the model.

Preferences → AI → **Where Was I** turns the card off entirely (nothing is recorded) or just the AI summary, and sets the model (`deepseek/deepseek-v4.1-flash` by default) and reasoning effort. Changes apply without a restart. See [docs/features/where-was-i.md](docs/features/where-was-i.md) for details.

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
- **Command palette.** ⌘/Ctrl+Shift+P lists the reference manager's actions from anywhere: **Cite a reference…**, **Add references…**, **Insert bibliography here**, **Manage references…**, citation styles, filters, copy, export, generate, fact-check and undo.

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

### Definitions and notation

Math documents introduce many symbols and terms before the interesting part. **Outlines → Definitions** collects a Markdown, LaTeX or PDF document's definitions, notation and conventions as searchable cards with typeset math.

- **Generate definitions** has the AI Agent read the whole document and save the cards as it goes; they appear while it works. The document never changes, so it works in Read Only. The command palette (⌘/Ctrl+Shift+P) offers **Generate definitions** and **Show definitions** too.
- Each card has the term or symbol, its kind, its meaning in this document, aliases, and where it is introduced.
- The cards look like the comment cards; click one to jump to where it is introduced.
- Search lists matching terms first, then aliases, then meanings, and matches math the way it reads: `Qfg` finds $\mathcal{Q}_{f,g}$, `PiK` or `πK` finds $\Pi_K$, and `mathcal` finds every $\mathcal{…}$. **Show** narrows the list to one kind.
- The agent's cards are checked and sent back when wrong: math must typeset in KaTeX, excerpts must be in the document, and passages that look like definitions need a card.
- The cards are a side-car file that follows the document. The tab tells you when the document has changed, and you can regenerate or delete the cards at any time.

See [docs/features/definitions.md](docs/features/definitions.md) for the full guide.

## Global Search

Open **Search** in the left rail (Cmd/Ctrl+6), or press Cmd/Ctrl+Shift+F anywhere, to search every notebook, linked folder and the Image Gallery. Describe what you are looking for in your own words, put words in quotes for an exact phrase, or paste, drop or pick an image to find similar photos. Images sit in the box between words, so “photos like [image] but at night” searches by both. Results show the matching passage with its page, section or lines and a preview, and open at that passage in the editor or PDF viewer.

Search combines meaning and exact words. Meaning comes from Google's EmbeddingGemma 2, which runs on this computer through Transformers.js in a background worker process; the Search panel offers to download its 8-bit text model and vision encoder (about 540 MB) into Libera's application data, outside the Master directory. Other weights can be chosen in Preferences → Search, or downloaded with `npm run search:download-model`. Every local model can also be downloaded on request with `npm run models:download -- [search|reading|read-aloud|speech|all]` (or `npm run models:download:search`, `:reading`, `:read-aloud`, `:speech`), into the same folder the app uses. Without weights, Search still finds exact words. The index is a single SQLite file (full-text and sqlite-vec vector tables) kept on this computer in Libera's application data, outside the Master directory so a synced notes folder never uploads it (or in a file chosen in Preferences). The first index is built only when you click **Build index**, so you can instead choose an index built before with **Use existing index…**. After that it is kept up to date in the background: only changed passages are embedded again.

See [docs/features/global-search.md](docs/features/global-search.md) for details and measured speeds.

## Voice memos

Upload recordings (M4A, MP3, WAV, OGG, FLAC, …) to a notebook and open them in a player with a waveform, transport controls and, beside it, a timestamped transcript with who said what. Transcribe on this computer with NVIDIA Parakeet TDT 0.6B v3, or with an OpenRouter speech-to-text model such as `openai/whisper-large-v3`; speakers are told apart on this computer with pyannote either way. Long recordings are cut at quiet moments into pieces and joined back on one timeline. Transcripts are sidecars that follow their recording, are found by Global Search (the audio itself is never indexed) and can be searched within the panel. Like the other models, the transcript panel offers to download the speech models into Libera's application data, or into a folder chosen in Preferences → Speech, which also sets the voice memo and dictation engines.

AI Chat reads the transcript of the memo you are playing; quote lines from the transcript with ⌘/Ctrl+Shift+L. Search within a transcript or in Global Search with `speaker:Name`. Export transcripts as Markdown (a new note, a note beside the recording, or a file), plain text, SRT or WebVTT, and link a note to a moment (`memo.m4a#t=185`). In shared notebooks, recordings sync as blobs and transcripts as companion files every member sees. AI Chat, the Agent, Agentic Review, Write with AI and AI Rewrite also take dictated prompts through the same speech-to-text engines, and the agent finds memos by searching their transcripts.

See [docs/features/voice-memos.md](docs/features/voice-memos.md) for details.

## Recording meetings

**New → Audio recording** on a notebook's cover (or **New audio recording** in a notebook's or folder's menu) opens a recording tab, laid out like the voice memo player: a live waveform and clock, Pause/Resume, Stop & save, the Live Recap in the middle and the live transcript at the side. The recording goes on while you work in other tabs, with a small bar to come back to it. Turn on **Live transcribe** to see the transcript a few seconds behind the speaker, made on this computer by Parakeet, which hears the recording in short pieces cut at pauses. Without the Parakeet model the switch is off and the recorder offers to download it. Turn on **Live recap** to keep a bullet-point summary with an AI model (the Formatting model in Preferences → AI, through OpenRouter). Each update adds a bullet or changes one, so the recap is never rewritten under you. **Stop** saves the recording as an `.m4a` voice memo, with the live transcript as its transcript and a `<name> recap.md` note whose bullets link to the moment they were said.

While recording, the audio is saved to disk every few seconds outside your notes, so a crash loses at most the last few seconds. The next time Libera opens, it offers to save the unfinished recording, record on, or delete it.

See [docs/features/meeting-recorder.md](docs/features/meeting-recorder.md) for details.

## Read aloud

Have Libera read text out loud: a selection in any editor or PDF, or the AI's replies. Markup is cleaned up first, so headings, emphasis, list bullets, link URLs and citations are not spoken, code blocks are said as "code omitted" and math as "equation".

- **Editors.** Select text and choose **Read Out Loud** from the right-click menu in the Visual (TipTap) editor, both Markdown Source editors (textarea and CodeMirror), the LaTeX editor, and the code editor used for every other text file. In `.tex` files, comments, `\cite`/`\ref`/`\label` and markup commands are dropped and wrapped source lines are read as one paragraph; code and plain text are read as written. The code editor's right-click menu also has Cut, Copy and Paste.
- **PDFs.** Select text and press the speaker button (**Read out loud**) in the selection toolbar, next to Copy and Quote and cite. The selection is read as the same clean text that Copy produces.
- **AI Chat and Agent.** Each finished reply has a speaker button beside Copy, which becomes a stop button while that reply is read. **Auto Read** in the chat's ⋯ menu reads every reply aloud as soon as the model finishes; stopped or failed replies are skipped. The setting is remembered on this computer.
- **Playback bar.** While something is read, a bar at the bottom of the window shows progress with **Pause** and **Stop**, and explains any failure (no API key, missing model folder, provider error). Starting something new stops what was playing. Speech starts after the first sentence: the text is read in short passages while the next ones are prepared.

Choose the engine in Preferences → **Read Aloud**:

- **OpenRouter** (default). Any OpenRouter text-to-speech model; the default `hexgrad/kokoro-82m` costs well under a dollar per million characters. The voice field suggests the chosen model's voices (`af_heart` by default).
- **This computer.** Kokoro 82M (Apache-2.0) through sherpa-onnx, the runtime voice memos already use; nothing leaves the computer. The first time you read aloud, Libera offers to download sherpa-onnx's `kokoro-int8-multi-lang-v1_0` (about 190 MB) into its application data; or extract another release (`kokoro-multi-lang-v1_0` or `kokoro-en-v0_19`) and choose its folder. 53 voices across American and British English, Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese.
- **Speed** from 0.75× to 2×. Changes apply without restarting. Web deployments use the `LIBERA_TTS_*` variables instead.

See [docs/features/read-aloud.md](docs/features/read-aloud.md) for the user guide and [docs/read-aloud/implementation.md](docs/read-aloud/implementation.md) for how it is built and how to extend it.

## PDF outlines and annotations

For a PDF, **Outlines → Outline** shows its table of contents, and its highlights, notes and drawings move to their own **Annotations** tab in the left rail.

- **Bookmarks.** A PDF's own bookmarks show as a tree. Choose how many levels are open, search closed branches too, and click an entry to go to its page and spot.
- **AI outlines.** When a PDF has no bookmarks, **Generate outline** (also in the command palette) has the AI Agent outline it. The PDF is split into chunks of 12 pages that are outlined in parallel, each with the PDF's printed table of contents if it has one and with larger-type lines marked as likely headings. Every heading is checked against the page text, the chunks are stitched together with consistent levels, and the whole outline is verified: page order, level jumps, numbering under the right parent, repeats, gaps. The agent fixes what verification finds with an amend tool until no errors are left. Scanned PDFs without a text layer are refused.
- **A side-car that follows the PDF.** The outline is saved beside the notebook's other Libera data, with the PDF's size and hash. Renaming, moving, copying or deleting the PDF in Libera does the same to it, and a rename during generation saves the outline under the new name. The tab says when the PDF has changed since, and the outline can be regenerated or deleted.
- **Annotations tab.** It appears in the rail only while a PDF tab is active, lists the annotations in page order with their count, and filters them by text or page (`p. 4`). Click one to show it, or right-click a highlight to **Quote and cite** it.
- **Renamed or deleted outside Libera.** A PDF's annotations, outline and definitions are re-attached to the PDF with the same bytes after a rename in Finder, Explorer or a sync client. When the PDF is gone they are set aside, not deleted, so a new PDF under the old name does not inherit them, and they come back if the original returns within 90 days. In shared notebooks they follow the collab host's moves and removals.

See [docs/features/pdf-outlines.md](docs/features/pdf-outlines.md) for the full guide.

## Create space in PDFs

The **Space** tool (`G`) opens blank room inside a PDF page to write or draw next to what you are reading. Put the cursor on a line and drag down: what is below slides down as you drag, and a note opens in the new space when you let go.

- **Clean cuts.** The cut snaps to blank rows, so it never splits a line, an equation or a figure. Hold `Shift` to place it freely; a click without dragging opens a space three lines tall.
- **Two-column papers.** Only the column under the cursor opens; `Alt` opens the whole width where the page allows it. The other columns end early with blank paper, hatched while the tool is on.
- **Things stay attached.** Notes, drawings and shapes made in a space move with it. Highlights, comments, search matches and selection stay on their text.
- **Editing.** Drag a space's bottom grip to resize it, or its × to delete it with what it holds. Each change is one undo step.
- **The PDF is untouched.** Spaces are annotations, saved and synced with the PDF's others. Pages are shown as moved pieces of one rendering, so opening a space never re-renders the page, and pages without spaces cost nothing extra. Exports leave spaces out for now.

In every PDF tool (highlight, text, pen, shape, eraser, space), `Esc` returns to Select. See [docs/features/create-space.md](docs/features/create-space.md) for the full guide.

## PDF to Markdown

Read PDF pages, scanned books, and images into Markdown on this computer, with no cloud service. Line breaks, page numbers, running headers, and words hyphenated across lines or pages are cleaned up. Tables, formulas (with your math markers), lists, code, and figures come out as Markdown.

- **Snip as Markdown.** In either editor, click the text-scan button next to the snipping tool, then drag a rectangle over a PDF or image tab. The Markdown is inserted at the cursor, and figures inside the snip are saved as images next to the note.
- **Convert PDF to Markdown.** In a PDF tab, click the text-scan button in the toolbar and choose the pages. Libera writes `<PDF name>.md` next to the PDF and saves after every page. The conversion keeps running while you switch tabs, and **Stop** keeps what was read so far.

The model is IBM's granite-docling-258M (Apache-2.0), run on the CPU through Transformers.js in a background worker process. The first time you use either feature, Libera offers to download it (about 600 MB) into its application data, or into a folder chosen in Preferences → Search → **PDF reading model**, where you can also put the files from Hugging Face yourself. Expect several seconds for a small snip and one to three minutes for a full page. Small print such as footnotes can be missed; pages the model could not finish are listed when the conversion ends.

See [docs/features/pdf-to-markdown.md](docs/features/pdf-to-markdown.md) for setup, file layout, and how it works.

## Python in notes

Ask the AI agent to compute something, such as a statistic, a fit, a simulation or a plot of a CSV. It writes Python into the note's sidecar (`growth.md` → `growth.py`, cells marked `# %% [id]`), runs it, and puts the figures in the note as ordinary images. In the Visual editor, hover a figure for **Re-run** and **Code**. Python is part of Libera: on a new computer it installs a private Python 3.12 with NumPy, SciPy, pandas, Matplotlib and more (about 450 MB, by uv, into Libera's application data) in the background after opening. On macOS, code runs without network access and can write only to its scratch folder. Set `LIBERA_PYTHON` to use your own interpreter.

See [docs/features/python-in-notes.md](docs/features/python-in-notes.md) for the sidecar format, the runtime and how runs are contained.

## Detection and Segmentation

Find, outline, and count objects in photos with Ultralytics' YOLOE-26, on this computer. Open it with the scan button in an image tab or the Image Gallery's photo viewer.

- **Prompts.** Describe what to find in words (several at once, separated by commas), box examples on the photo, or box them in an uploaded reference image. Each prompt is a class, and prompts with the same label are counted together. Text and visual prompts mix in one run.
- **Results.** Masks, boxes, labels, centroids, and quadrat density drawn over the photo, with zoom and pan. A sortable table filters by confidence without running again.
- **Statistics.** Counts, density, and coverage per label. Area, equivalent diameter, perimeter, circularity, and aspect ratio (mean ± SD, median and IQR, histograms). Spatial distribution: nearest-neighbour distances, the Clark–Evans index with edge correction, and quadrat variance/mean, χ², and Morisita's index. Set a scale by typing it or by measuring a scale bar, and sizes switch to nm, µm, mm, cm, or m.
- **Tag and edit by hand.** Tag missed objects with a box, a polygon, or a freehand stroke smoothed into a curve. Reshape any object by dragging the control points of its outline (a smooth curve through at most 24 points) or the corners of its box; add and remove points, move, relabel, delete, revert, and undo. Hand-tagged objects are marked **Manual** and corrected ones **Edited**, keeping what the model found. A new run keeps both, and deleted detections stay deleted.
- **Save and load.** A JSON file holds the model and its settings, the prompts (with reference images), the date, the image, the scale, every object with its outline and origin, removed detections, and the statistics. Opening it shows the results again. The table also exports as CSV.

The first time, Libera offers to download a private Python runtime with PyTorch and Ultralytics (about 1 GB, installed by uv into Libera's application data, nothing system-wide), the MobileCLIP2-B text encoder (254 MB), and the chosen variant's weights (YOLOE-26n to YOLOE-26x, 12–172 MB). A runtime is needed because YOLOE-26 accepts new prompts only through Ultralytics in Python. Preferences → **Detection and Segmentation** sets the default variant, CPU or GPU, the confidence and IoU thresholds, the inference size, and the model folder. Ultralytics and the YOLOE-26 weights are licensed AGPL-3.0.

See [docs/features/detection-and-segmentation.md](docs/features/detection-and-segmentation.md) for the full guide, the file format, and how it works.

## Image Gallery

Open the **Image Gallery** tab in the left rail (Cmd/Ctrl+5). The left panel generates images and the main area shows the gallery. Open documents stay as they were while the gallery is in front.

### Generating images

Describe the image and press **Generate** (Cmd/Ctrl+Enter). Libera uses OpenRouter's Images API with the configured OpenRouter API key. The model list comes from OpenRouter, and each model shows only the settings it supports: aspect ratio, resolution, quality, background, format, compression, number of images, and seed. The default model is `google/gemini-3.1-flash-image`; set `LIBERA_AI_IMAGE_MODEL` to change it. The model, its settings (remembered per model), and the save destination persist across restarts in `.libera/image-generation.json`.

Add **Reference photos** for models that edit or build on photos: use **Add**, drop photos on the panel, or paste them into the prompt. Photos larger than 2048 px are scaled down before they are sent, and the panel shows how many photos the chosen model accepts. In the gallery, **Use as reference** sends photos to the panel.

Under **Save to**, choose the gallery (optionally an album) or a **Notebook folder**. Images saved to a notebook folder stay with the notebook and do not appear in the gallery.

### Browsing

**Photos** shows every photo grouped by day, **Starred** collects starred photos, **Albums** lists albums, and **Shared** lists albums and photos shared with you or by you. Sort newest or oldest first. Change the thumbnail size with the zoom buttons, the slider, `+`/`-`, or pinch (Cmd/Ctrl+scroll), and switch between a square grid and a layout that keeps each photo's shape. Hover a photo to select it or star it; Shift-click selects a range, a day's checkbox selects the whole day, Cmd/Ctrl+A selects everything, and Esc clears the selection. With photos selected you can star them, add them to an album, use them as references, or delete them. Deleting removes the files from disk.

### Albums

Albums are folders inside the gallery folder; photos outside any album sit at its top level. Creating an album creates a folder with its name and moves the chosen photos into it. This is the only time photos move on disk. Adding photos to an existing album, removing them, and deleting an album only change the gallery's index (`.libera-gallery.json`), so a photo can belong to several albums and deleting an album never deletes photos. Renaming an album renames its folder when that name is free. Folders and photos added in Finder or Explorer are picked up: a new folder becomes an album, and photos moved by hand keep their stars and albums. In **Starred**, **Create album** turns the starred photos into an album.

### Shared albums

With collaboration signed in, an album's **Share** button invites people by email as contributors (add, edit, caption and remove photos), commenters, or viewers, and a photo's **Share** shares a copy of it on its own. Sharing gathers the album's photos into its folder, copying those that also belong to another album, and removes location and camera details unless you turn that off; prompts are shared only if you choose. Invited people get the album in their gallery, and everyone sees each other's changes as they arrive.

In a shared album, the viewer's Info panel shows the photo's caption, who added it, and its comments; **Mark an area** comments on part of the photo. **Remove from album** takes photos out of the album for everyone and keeps them in your gallery; **Delete** removes them from every member's computer. **Save to my gallery** copies photos out of the album so they stay whatever happens to it. Viewers and commenters cannot change the album's photos, and shared photos cannot go to the Protected Archive. Leaving an album removes the photos others added, unless you saved them, and keeps your own. See [docs/features/shared-albums.md](docs/features/shared-albums.md).

### Viewing and editing

Click a photo to open the viewer. Zoom with the scroll wheel, pinch, double-click, `+`/`-`/`0`, or the zoom buttons, and drag to pan. Use the arrow keys for the previous and next photo, S to star, Space for a slideshow, F for full screen, and I for info (date, size, albums, location on disk, model, and prompt, with **Reuse prompt**). Photos can also be downloaded or copied. The scan button opens [Detection and Segmentation](#detection-and-segmentation) for the photo.

Press E (or **Edit**) to rotate, flip, and crop (Free, Original, Square, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16), adjust brightness, contrast, saturation, warmth, tint, and vignette, or apply a filter preset. **Save** (Cmd/Ctrl+S) replaces the photo and keeps the original, so **Revert to original** in the info panel can undo it; **Save as copy** adds a new photo beside the original, in the same albums. The saved photo uses the same calculations as the preview. SVG images cannot be edited.

To view a photo next to notes and PDFs, right-click it (or select one photo, or use the viewer's button) and choose **Open in tab**, **Open to the right**, or **Open below**. Gallery photos open as read-only image tabs and work with split right and split down.
