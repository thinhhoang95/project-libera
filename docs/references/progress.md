# Reference manager progress tracker

The single place that says what is done. Every line maps to the plan ([plan.md](plan.md)). A line is ticked only when its lane is merged into `references/integration` **and** its tests pass there.

Legend: ☐ not started · ◐ in progress · ☑ done and verified · ⏸ deferred (with reason)

## Branching

- Integration branch: `references/integration`, branched from `collaboration` at `0ae5bce`. Worktree: `.claude/worktrees/refs-integration`.
- Each lane works on `references/<lane>` in `.claude/worktrees/refs-<lane>`, branched from the integration tip at the start of its wave, and is merged with `--no-ff`.
- The collaboration work continues on `collaboration` in the main checkout. A single merge of `references/integration` into `collaboration` happens later (see “Big merge” below). No reference lane touches collab code.

## Merge into collaboration (19 Oct 2026)

- **Branch:** `references/merge-collaboration` = `collaboration` at `d211e51` + `references/integration` (merge `e00c9c8`) + a shared SuggestEdit test (`0533488`). It is a fast-forward of `collaboration` as long as `collaboration` stays at `d211e51`.
- **Conflicts (6 files, 10 hunks), resolved to keep both sides:**
  - agent run-record validation;
  - the review-comments skill: collab's shared threads plus SuggestEdit;
  - SuggestEdit and fact-check on shared documents, which now make collaborative suggestions and shared threads instead of refusing;
  - local agent suggestions are previewed only on documents that are not shared;
  - `retargetOpenTab` applies a cross-notebook move's citation rewrite, and both move paths use it;
  - imports, and the review popover.
- **Verification against `collaboration`'s own tip in this environment:**
  - `test:collab` and `scripts/lib`: identical failure sets. The 60 collab failures need a real collab server, Postgres or the host; the convergence fuzzer fails with a random seed in both.
  - `test:editor`: the merge adds only the two load-sensitive tests on the watch list (PDF export readiness; the workspace-panel render count). Both pass in 3 of 3 runs alone.
  - tsc shows the 4 baseline errors.
  - A dev-server smoke test of the merged app rendered citations correctly.
- **Landed (19 Oct 2026).** The main checkout's pending collab work was committed as `933c985` (shared link refresh, accent bar cleanup) and merged into the branch (`da5b5d4`). The reference rows' accent bars were dropped to match (`859cb25`). `collaboration` was then fast-forwarded to `859cb25`. Suites at that tip are identical to the collaboration baseline (test:editor 1,040 tests, test:collab, scripts/lib), and tsc shows the 4 baseline errors. The two new packages (`citeproc`, `@tiptap/suggestion`) were copied into the main checkout's `node_modules` at their locked versions. `npm run deps:setup` or a fresh install picks them up from `package.json`.
- **Watch item for the collab team:** `workspace-panel-performance.test.ts` can count one extra render under heavy CPU load since the reference work. It is benign in the app (at most one render when a library loads), but the test is timing-sensitive.

## Status (19 Oct 2026): complete on `references/integration`

Every lane of plan.md is merged, apart from the two items deferred below.

**Verification at `3490eaf`:**
- `npm run test:editor`: 1,027 tests. The only failures are the baseline set (4 fail, 2 cancelled).
- `npx tsc --noEmit -p .`: the 4 baseline errors.
- The production webpack build (run from an NTFS copy, see "Build environment notes") and the worker-bundle check both pass.

**Browser check** on the dev server, against a seeded throwaway library:
- The Visual editor formats citations: author-date, a narrative citation, prefix and locators, an unresolved key in red, an email left alone.
- Hover cards show the retraction badge.
- The References panel shows rows, badges, the cited tint and the document style picker.
- The card shows provenance, and choosing a conflict alternative commits it.
- The `@` popup offers matches and inserts `[@key]`.
- **Quote and cite** from the PDF inserts the quote with the printed page.

**Two bugs found by the browser check, now fixed:**
- Retraction styling was missing in the Visual editor (`d5513fe`).
- A `flushSync` warning when inserting citations through a pending visual insertion (`932d9ff`).

**Not checked live:**
- Fact-check and AI resolution, which need an OpenRouter key; they are covered by mocked tests.
- The CodeMirror Source editor, which is reachable only from the Electron menu; covered by jsdom tests.
- Typing in a hidden browser pane doesn't register, so the `@` trigger was exercised through the editor API.

User guide: [docs/features/references.md](../features/references.md).

## Baseline

`npm run test:editor` on `references/integration` before any lane: 559 tests, 552 pass, 4 fail, 2 cancelled, 1 skipped. The failures and cancellations are pre-existing (global search index tests 132, 158, 159, 180; PDF worker resolution 415; atomic-write cleanup 455), the same set `docs/collaboration/progress.md` records. Lanes must not add to this list.

`npx tsc --noEmit -p .` before any lane: 4 errors, all pre-existing, in `scripts/editor/document-ocr-loop.test.ts` (1) and `scripts/editor/pdf-text-layer-styles.test.ts` (3). Lanes add none.

## Wave 0: contracts (orchestrator)

- ☑ `src/lib/references/types.ts`: library, entry, provenance, attachment, citation AST, library ops
- ☑ `src/lib/references/keys.ts` + `scripts/editor/references-keys.test.ts`: key grammar and generation
- ☑ `src/lib/openrouter.ts`: `webSearch` option (OpenRouter web plugin) and `webCitations` in completions
- ☑ Plan, tracker and lane rules in `docs/references/`
- ☑ Dependencies: `citeproc`, `@tiptap/suggestion`

## Wave 1: foundations

| Lane | Branch | Scope | Status |
|---|---|---|---|
| core | `references/core` | BibTeX/BibLaTeX, RIS, CSL-JSON parse and serialize; names; normalization; identifiers; dedupe scoring | ☑ merged 58eae11; 57 tests |
| syntax | `references/syntax` | Citation grammar, scanner, serializer, trigger detection, key rewrite; micromark/mdast extension | ☑ merged 894fa1b; 91 shared cases, fuzzed against micromark |
| storage | `references/storage` | Library storage and transactions; library API; attachments follow renames, moves, copies, archive, delete; re-attach by hash; client store | ☑ merged 1678274; suite 585 tests, only the baseline 4 fail + 2 cancelled |

## Wave 2: Markdown integration and panel

| Lane | Branch | Scope | Status |
|---|---|---|---|
| preview | `references/preview` | CSL styles, citeproc formatting, preview plugin and worker, renderer chips, bibliography block, hover card, open PDF at locator, Markdown PDF export | ☑ merged d0bc068 (formatting runs in its own worker) |
| interop | `references/interop` | Import/export API and document bibliography export; clipboard; text strippers; agent prompt syntax; LaTeX export placeholders | ☑ merged 084ba5c |
| panel | `references/panel` | Left rail tab, References panel, detail card with provenance, Manage references dialog, Add box (paste BibTeX/RIS/identifiers), Cite at cursor, Cited in this document, style picker | ☑ merged 6f6414a |

## Wave 3: editors, capture, agent runtime, moves

| Lane | Branch | Scope | Status |
|---|---|---|---|
| editors | `references/editors` | `@` popup in textarea, CodeMirror and Visual; TipTap citation node and popover; CodeMirror decoration; suggestion index | ☑ merged 3e6e194 |
| resolution | `references/resolution` (server half, started early) + `references/resolution-ui` (after panel) | Identifier lookups (Crossref, DataCite, arXiv, OpenAlex, PubMed, ISBN); PDF and Markdown resolution; LLM + web; AI preferences; background jobs; dedupe and merge UI; confirmation cards | ☑ server merged 0b544fe · ☑ resolution-ui merged f1b5afd |
| agent-runtime | `references/agent-runtime` | Child agent runs, nested events and usage; WebSearch tool; agent suggestions bucket and its review UI | ☑ merged 8332ba7 |
| moves | `references/moves` | Cross-notebook copy-on-move; key rename with aliases and draft-aware citation rewrite | ☑ server merged d9469b2 · ☑ moves-ui merged 89cde8a |

## Wave 4: fact-check and later items

| Lane | Branch | Scope | Status |
|---|---|---|---|
| factcheck | `references/factcheck` | `fact-check-citations` skill: ListCitations, CheckCitations fan-out, SubmitVerdicts, SuggestEdit, evidence verification, existence check, missing references, report, budget, buttons | ☑ merged 7208feb |
| pdfcite | `references/pdfcite` | Quote and cite from the PDF viewer; drag into editors; semantic `@` search through Global Search | ☑ merged 9821326; suite 981 tests, baseline failures only |
| scholarly | `references/scholarly` | Retraction and correction checks with badges; ISO 4 abbreviations; generated `.bib` mirror and LaTeX `\cite` completion; biblatex LaTeX export | ☑ merged 03fc2dd |
| syntax2 | `references/syntax2` | Narrative citations in every layer; per-document style override; reference-list screenshot import through local OCR | ☑ merged (narrative + pageLocator conflicts unified; panel placements applied) |

## Deferred

- ⏸ Shared libraries for collaborative notebooks. Design note: entries are id-keyed records with field-level clocks (`fieldUpdatedAt`), so they map one-to-one onto a `Y.Map`. Agent suggestions (`AgentSuggestion` in `markdown-review.ts`) document their mapping to the collab `SuggestionRecord`. (plan §5 Phase 5). It needs the collab manifest and sync code, which this effort must not touch. Do it as part of the big merge, once the collab host and manifest are merged on `collaboration`.
- ⏸ GROBID extractor (D7: optional, not planned).

## Big merge notes

Files that both efforts edit, to review carefully when `references/integration` merges into `collaboration`:

- `src/components/libera/left-panel.tsx`, `src/components/libera-app.tsx`, `src/components/libera/use-libera-workspace.ts` (insertCitation, move notices, citation rewrite into tabs, quote-and-cite target)
- `src/components/libera/tiptap-markdown-editor.tsx` (citation node and layer, fact-check button, inline and deferred pending insertion), `src/lib/tiptap-markdown.ts` (LiberaLink, citation and front-matter nodes), `markdown-editor.tsx`, `markdown-source/markdown-codemirror-editor.tsx`, `src/lib/markdown-codemirror/` (citations)
- `src/components/libera/workspace-panel.tsx` (ReferenceRenderProvider, untitled prop), `src/components/markdown-renderer.tsx`, `src/lib/markdown-rendering.ts` (citation, bibliography and front-matter plugins)
- `src/lib/storage/files.ts`, `notebooks.ts`, `tree.ts`, `annotations.ts`, `search-updates.ts` (reference side effects); `src/lib/search/*` (references source, highlights, `within`)
- `src/lib/agent/*` (subagents, WebSearch, SuggestEdit, References tool, fact-check skill), `document-chat-panel.tsx`, `agent-activity.tsx`
- `src/lib/tiptap-changes.ts` was not touched by this effort
- `src/lib/storage/markdown-reviews.ts` / `src/lib/markdown-review.ts` (agent suggestions bucket vs collab `SuggestionRecord`)
