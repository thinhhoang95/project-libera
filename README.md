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

Run the desktop app in development with:

```bash
npm run electron:dev
```

Electron development starts Next.js with webpack because Turbopack's persistent
dev cache can fail on external macOS volumes that create `._*` sidecar files.

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

Use **Source** to access the existing source/preview workflow, screenshot insertion, file-link picker, and slide controls. Slide decks continue using the source editor. Both modes edit the same Markdown draft; use the save button or Cmd/Ctrl+S to save. TipTap may normalize Markdown whitespace and delimiters after a visual edit; simply opening a note does not rewrite it.

Libera highlights (`y>>>text<<<`) and text colors (`[color=#2563eb]text[/color]`) retain their existing syntax. Underlines use `<u>text</u>`. Font size and line spacing use safe numeric span attributes, for example `<span data-font-size="24" data-line-height="2">text</span>`, supported by both the visual editor and Markdown preview/export. Other Markdown viewers may ignore these presentation attributes.

Run the editor's Markdown round-trip regression tests with `npm run test:editor`.
