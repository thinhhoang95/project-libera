# Reference manager lanes: rules and contracts

Every lane agent reads this file, [plan.md](plan.md) and `AGENTS.md` before writing code.

## Rules for every lane

1. **Stay in your worktree.** Work only inside the worktree path in your brief, on the branch in your brief. Never `cd` into `D:\project-libera` (the main checkout, where other agents are building collaboration on `collaboration`), into another lane's worktree, or into `refs-integration`. Never check out, merge, rebase, reset or push any other branch. Never use `git stash`, because the stash is shared across worktrees. Use WIP commits instead.
2. **Stay in your lane.** Change only the files your brief owns, plus the small wiring edits it names. If you must touch anything else, keep the edit minimal and list it under “Outside lane” in your report.
3. **Never touch collaboration code:** `src/lib/collab/`, `src/components/libera/collab/`, `electron/collab/`, `electron/collab-host.cjs`, `server/`, `ops/`, `scripts/collab/`, `docs/collaboration/`, `SETUP.md`.
4. **Dependencies.** All reference worktrees share one install at `D:/project-libera/.claude/worktrees/node_modules`. The `D:` drive is exFAT, which has no junctions, so Node, tsc and eslint find it by walking up from the worktree. Your worktree has no `node_modules` of its own and must not get one. Never run `npm install`, `npm ci`, `npm update` or `deps:*`, and never edit `package.json` or `package-lock.json`. If you need a package, stop and say so in your report. `citeproc` and `@tiptap/suggestion` are already installed. Git needs no extra configuration: the worktrees folder is a trusted `safe.directory`.
5. **Next.js.** This is Next 16.2.6, which differs from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing route handlers or other Next code.
6. **Tests.**
   - Put tests in `scripts/editor/references-<area>.test.ts`, using the existing `node:test` style and harness.
   - Run your tests: `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/references-<area>.test.ts`.
   - Also run the existing tests for every module you changed, `npx tsc --noEmit -p .` and `npx eslint <changed files>`. Fix everything you introduced.
   - Known baseline failures in the full suite are listed in `progress.md`. Do not try to fix them.
   - Tests never call live network services or models. Use recorded fixtures and mocked `fetch` and model responses, as the review-mode and agent tests do.
7. **Manual checks.**
   - Use a data directory inside your worktree, for example `LIBERA_DATA_DIR=<worktree>/data/manual`. `/data` is gitignored. Never point at the user's real library.
   - A dev server must use a port unique to your lane (given in your brief): `npx next dev -p <port>`. The development password is `LIBERA_DEV_PASSWORD`, which defaults to `libera`.
   - If the dev server cannot start from a junctioned `node_modules`, say so and rely on jsdom tests. The orchestrator runs the browser checks on the integration branch.
8. **Quality.**
   - Match the surrounding code: naming, comment density, idioms.
   - Implement the whole brief. No TODO stubs, no placeholder behavior, no silently skipped cases.
   - If something in the brief turns out to be wrong or impossible, do the closest sound thing and explain it in your report.
9. **Commits.** Commit on your lane branch in logical steps, with messages like `feat(references): …`, `test(references): …`. End every commit message with:

   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```

   Leave the worktree clean at the end.
10. **Report.** Finish with:
    - a summary,
    - files added and changed,
    - the exact test commands run and their results (pass and fail counts),
    - any deviations from the brief,
    - anything outside your lane,
    - open issues the orchestrator must handle.

## Shared contracts

These are fixed. A lane that implements one must match it exactly. A lane that consumes one may rely on it even before it is merged; integration checks happen at merge.

### Types and keys (Wave 0, merged)

- `src/lib/references/types.ts`: `ReferenceLibrary`, `ReferenceEntry`, `ReferenceEntryInput`, `ReferenceLibraryOp`, `Citation`, `CitationItem`, `CitationOccurrence`, `BUNDLED_CSL_STYLES`, `DEFAULT_CSL_STYLE`, `REFERENCES_UPDATED_EVENT`.
- `src/lib/references/keys.ts`: `CITATION_KEY_SOURCE` (the key regex source, `u` flag), `isValidCitationKey`, `generateCitationKey(csl, taken)`, `takenCitationKeys(entries)`, `asciiKeyPart`.
- `src/lib/openrouter.ts`: `createOpenRouterCompletion(messages, { webSearch: { maxResults } })` returns `webCitations?: { url, title?, content? }[]`.

### Library API (storage lane)

All routes check `requireAuth`. `notebook` is the notebook name.

- `GET /api/references?notebook=N` → `{ library: ReferenceLibrary }`. A missing library is returned as an empty library at revision 0, without writing.
- `PATCH /api/references` with `{ notebook, revision, ops: ReferenceLibraryOp[] }`:
  - Success → `{ library }`.
  - Revision conflict → status 409 with `{ error, library }`.
  - Invalid op → status 400 with `{ error }`. All ops in a request apply atomically, or none do.
- `src/lib/storage/references.ts` exports:
  - `readReferenceLibrary(notebook)`
  - `updateReferenceLibrary(notebook, expectedRevision | null, ops)`, where `null` means apply on the latest revision (for server-side jobs)
  - `applyLibraryOps(library, ops, now)` (pure, also exported from `src/lib/references/library-ops.ts`)
  - plus the move, copy and delete helpers that `storage/files.ts` calls
- Client: `src/components/libera/references/use-reference-library.ts` exports:
  - `useReferenceLibrary(notebook: string | null)`, returning `{ library, loading, error, apply(ops): Promise<ReferenceLibrary>, reload() }`
  - `fetchReferenceLibrary(notebook)` and `applyReferenceOps(notebook, ops)`. These retry once on 409 by reloading and re-applying the ops against the new revision.
  - It dispatches `REFERENCES_UPDATED_EVENT` and syncs across windows through a `BroadcastChannel("libera-references")`.

### Citation syntax (syntax lane)

`src/lib/references/citation-syntax.ts` exports:

- `scanCitations(markdown): CitationOccurrence[]`. It skips fenced and indented code, code spans, inline and display math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), link destinations, autolinks and HTML comments.
- `parseCitationToken(raw): Citation | null`
- `serializeCitation(citation): string` (canonical form)
- `citationTriggerAt(text, offset)` → `{ from, query, insideCitation: boolean } | null`, for the `@` popup
- `rewriteCitationKeys(markdown, map: Map<string, string>)` → `{ text, count }`
- `citedKeys(markdown): string[]`, in document order, unique
- `CITATION_SYNTAX_CASES`, the shared table of `{ name, source, expected }` cases that every parser layer's tests run

`src/lib/remark-citations.ts` exports `remarkCitations()`, which produces mdast nodes `{ type: "liberaCitation", citation, position }` with `data.hName = "libera-cite"`.

### Formatting (preview lane)

`src/lib/references/format.ts` exports:

```ts
formatCitations(input: {
  citations: Citation[];                       // in document order
  entries: Record<string, ReferenceEntry>;     // by key AND by alias
  style: string;                               // CSL XML
  locale?: string;                             // default "en-US"
  format?: "html" | "text";                    // default "html"
}): { citations: string[]; bibliography: string; unresolvedKeys: string[] }
```

- `loadCslStyle(styleId | xml)` returns the bundled styles.
- `citationEntriesForDocument(library, keys)` returns the key-and-alias map.

### Resolution (resolution lane)

- `POST /api/references/resolve` with `{ notebook, input: string, webSearch?: boolean }` → `{ candidates: ReferenceEntryInput[], duplicates: { candidateIndex, entryId }[] }`. It does not write.
- `POST /api/references/jobs` with `{ notebook, action: "resolve-pdfs" | "resolve-paths" | "cancel", paths?, jobId?, webSearch? }`.
- `GET /api/references/jobs?notebook=N` → `{ jobs: ReferenceJobStatus[] }`.

### Rendered citation DOM (preview lane renders; interop and editors lanes read)

- A citation renders as `<span class="libera-citation" data-libera-citation="RAW">FORMATTED</span>`. `RAW` is the exact source token, such as `[@a, p. 3]`, HTML-escaped. An unresolved key adds the class `libera-citation-unresolved`. A resolved narrative citation (`@key`) also carries `data-libera-narrative=""`; an unresolved narrative candidate renders as plain text.
- The bibliography renders as `<section class="libera-bibliography" data-libera-bibliography="">…</section>`. Copying it to the clipboard drops it; it is generated, not source.
- A `:::bibliography` line followed by a `:::` line (a paragraph whose text is exactly that) marks where the bibliography goes. Without one, the bibliography is appended at the end when the document has at least one citation.

### Reference render context (preview lane)

`src/components/libera/references/reference-render-context.tsx` exports:

- `ReferenceRenderProvider({ notebook, children, onOpenAttachment? })`. It loads the notebook's library with `useReferenceLibrary` and the style XML.
- `useReferenceRender()` → `{ notebook, library, styleXml, locale, entriesByKey, onOpenAttachment?(attachment, locator?) } | null`.

Components that render citations call `useReferenceRender()`. Without a provider (chat messages, for example) they render the raw token styled as a chip.

### Citation index (interop lane)

- `src/lib/storage/reference-citations.ts` builds a per-notebook index at `<notebook system dir>/references/citations.json`. It holds the keys cited by each Markdown file, keyed by mtime and size like `notebook-links.json`, and is rebuilt incrementally on request.
- `GET /api/references/citations?notebook=N` → `{ byFile: Record<path, string[]>, byKey: Record<key, path[]> }`. Paths are library-relative. Only saved files count; the client merges in open drafts itself.

### Import and export (interop lane)

- `POST /api/references/import` with `{ notebook, format: "auto" | "bibtex" | "ris" | "csl-json", text }` or `{ notebook, path }` (a `.bib`, `.ris` or `.json` file in the library) → `{ library, added: string[] /* entry ids */, errors: { line, message }[], duplicates: { entryId, existingId, reason }[] }`.
  - Entries are normalized before they are added.
  - Exact-identifier duplicates of existing entries are not added again. They are reported in `duplicates`.
- `POST /api/references/export` with `{ notebook, format: "bibtex" | "biblatex" | "csl-json" | "ris", ids?: string[], documentText?: string, abbreviateJournals?: boolean }` → a file download (`Content-Disposition`).
  - With `documentText`, only the keys it cites are exported, aliases resolved.
  - Formatted reference lists are added in Wave 3.

### Background jobs (resolution lane)

- `src/lib/references/jobs-types.ts` exports `ReferenceJobStatus`:
  `{ id, notebook, kind: "resolve-pdfs" | "resolve-paths", state: "queued" | "running" | "done" | "failed" | "cancelled", total, done, failed, current?: string, createdEntryIds: string[], updatedEntryIds: string[], errors: { path: string; message: string }[], webSearch: boolean, createdAt, startedAt?, finishedAt? }`.
- Candidates returned by `/api/references/resolve` and created by jobs carry full provenance and `conflicts` where sources disagree.

### Fact-check request (resolution-ui dispatches; factcheck lane listens)

- `FACT_CHECK_REQUEST_EVENT` (`types.ts`), with `{ path, webSearch? }`. The References panel and the Markdown toolbar dispatch it.
- The AI panel switches to Agent mode, opens a new chat, and starts a run whose first message asks to fact-check `path`, with the `fact-check-citations` skill preloaded.
