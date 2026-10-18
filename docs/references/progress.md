# Reference manager progress tracker

The single place that says what is done. Every line maps to the plan ([plan.md](plan.md)). A line is ticked only when its lane is merged into `references/integration` **and** its tests pass there.

Legend: ☐ not started · ◐ in progress · ☑ done and verified · ⏸ deferred (with reason)

## Branching

- Integration branch: `references/integration`, branched from `collaboration` at `0ae5bce`. Worktree: `.claude/worktrees/refs-integration`.
- Each lane works on `references/<lane>` in `.claude/worktrees/refs-<lane>`, branched from the integration tip at the start of its wave, and is merged with `--no-ff`.
- The collaboration work continues on `collaboration` in the main checkout. A single merge of `references/integration` into `collaboration` happens later (see “Big merge” below). No reference lane touches collab code.

## Resume here (all lanes merged; final verification in progress)

**Latest state (supersedes the older notes below):**

- **Merged on integration (`03fc2dd`):** core, syntax, storage, preview, interop, panel, agent-runtime, resolution (server + UI), moves (server), factcheck, scholarly. The reference + LaTeX tests pass, 370 in all. tsc shows the baseline errors only.
- **In progress, told to commit a WIP checkpoint and stop:**
  - editors (`refs-editors`, `references/editors`)
  - moves-ui (`refs-moves-ui`, `references/moves-ui`)

  Resume each agent with SendMessage, or start a fresh agent with its brief and the WIP commit.
- **Not started:**
  - pdfcite: quote and cite from the PDF viewer, drag into editors, semantic `@` search. Waits for editors.
  - syntax2: narrative citations, per-document style, reference-list screenshot OCR. Waits for editors.
- **Small follow-ups:**
  - ☑ `RetractionBadge` on panel rows and cards, and the `check-retractions` job text (ab117fa).
  - Investigate the intermittent "PDF export waits for the library…" test in `references-preview.test.ts`. It fails only when many files run in parallel. The suspect is the main-thread citeproc fallback under CPU contention, plus the new abbreviation-table load.
- **Final step:** full suite, `npm run test:editor-worker-bundle`, browser checks with `next dev --webpack` in refs-integration (chips, hover cards, panel, `@` popup, fact-check, LaTeX hint, export dialog), and the feature doc `docs/features/references.md`.

- Wave 0 and Wave 1 are merged and verified on `references/integration`.
- Wave 2 worktrees exist, branched from the integration tip, but no agent has started:
  - `.claude/worktrees/refs-preview` on `references/preview` (dev port 3101)
  - `.claude/worktrees/refs-interop` on `references/interop` (port 3102)
  - `.claude/worktrees/refs-panel` on `references/panel` (port 3103)
- The Wave 1 worktrees (`refs-core`, `refs-syntax`, `refs-storage`) are merged and can be removed with `git worktree remove`.
- The Wave 2 contracts are in [lanes.md](lanes.md): rendered citation DOM, reference render context, citation index, import and export, plus `REFERENCES_ADD_REQUEST_EVENT` / `REFERENCES_REVEAL_EVENT` and `FieldAlternative` conflicts in `types.ts`.
- Scope moved out of Wave 2 into Wave 3's `moves` lane: formatted reference-list export and the LaTeX export placeholder path (both need `format.ts` from the preview lane).
- Notes for Wave 3 briefs:
  - `citationTriggerAt` re-analyses the whole document, at about 90 ms per MB, so editors should call it only around `@`.
  - `remarkCitations` must be `.use`d after remark-parse.
  - The storage `merge` op should be checked against `mergeEntryFields` (core) semantics.
  - Interop's import route decides the status of imported entries: `confirmed` when title, creator and date are present, otherwise `needs-review`.

### Handoffs for the fact-check lane (from agent-runtime)

- `ToolContext` has no read scope. To restrict child Read, Grep and Glob to a batch's attachments plus the document, either wrap those tools or add a read-scope field.
- A child given SuggestEdit keeps its suggestions in its own `skillState`, which is never saved. The parent records suggestions from the children's structured results instead.
- The agent prompt (interop) says to cite only keys that are in the library, but the library is a hidden file the agent's tools cannot read. Fact-check adds a read-only `References` tool (search and look up the notebook library by key, author, title or year) for every agent run, not just inside the skill.
- Search index: unchanged files keep their pre-citation embeddings until edited, because there is no embedding-text version. This is acceptable; record it in the feature doc.
- Preview: Turbopack can't start from the shared `node_modules`, so lanes use `next dev --webpack`. Check `npm run test:editor-worker-bundle` at final integration: the preview worker check reported `structuredClone is not defined` in its VM scope, possibly pre-existing.
- The APIs to use are `runSubagents`, `SubagentTask`, `suggestEditTool` + `finishSuggestedEdits`, and `webSearchTool` (see `src/lib/agent/subagents.ts`, `suggest-edit.ts`, `web-search.ts`).

### Known limits (editors)

- In the visual editor, bold or italic that wraps a citation is split around it on save (`**a [@c]**` becomes `**a** [@c]`), because `@tiptap/markdown` marks only text nodes.
- The textarea editor has no inline chip styling, which would need a whole-document scan per keystroke. Hover and Ctrl/Cmd+click work.

### Build environment notes

- `next build` cannot run from the `D:` drive at all, at the base commit `0ae5bce` too: webpack's `readlink` gets EISDIR on exFAT. Build verification therefore runs from a detached worktree on `C:` (the scratchpad `refs-build`) with its own copy of `node_modules`.
- `npm ci` in the shared install skipped three Windows native packages, because the lockfile was generated on macOS and has no entries for them: `lightningcss-win32-x64-msvc` 1.32.0, `@tailwindcss/oxide-win32-x64-msvc` 4.3.0 and `@unrs/resolver-binding-win32-x64-msvc` 1.12.2. Matching versions were copied from the main checkout's `node_modules` into the shared install and the build copy. Without them Tailwind CSS fails to compile, so lane dev-server checks before this point may have run without styles.
- The production webpack build of the integration tip at pdfcite (`8c37892`) succeeds, including every `/api/references/*` route.

### Watch list

- `workspace-panel-performance.test.ts` ("pane bodies skip unrelated drafts…") failed once under full-suite load with a render count 1 too high. It passes alone. The suspect is the reference render provider's async library load landing mid-test. Re-check at final integration.
- Fact-check source toolbar: the source-mode toolbar has no `untitled` prop, so its Fact-check button isn't disabled for untitled drafts (the route answers "file does not exist"). Tidy this in moves-ui or the editors follow-up.

### Other test baselines

- `node --test scripts/lib/*.test.cjs`: 44 tests, 4 fail at the base commit `0ae5bce` (`session-shutdown.test.cjs`, "collabHost is not defined"). This is collaboration code. Reference lanes add none.

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

- ⏸ Shared libraries for collaborative notebooks (plan §5 Phase 5). It needs the collab manifest and sync code, which this effort must not touch. Do it as part of the big merge, once the collab host and manifest are merged on `collaboration`.
- ⏸ GROBID extractor (D7: optional, not planned).

## Big merge notes

Files that both efforts edit, to review carefully when `references/integration` merges into `collaboration`:

- `src/components/libera/left-panel.tsx`, `src/components/libera/tiptap-markdown-editor.tsx`, `src/components/libera/use-libera-workspace.ts`, `src/lib/tiptap-changes.ts` (collab suggestions were landing there at 0ae5bce)
- `src/lib/storage/markdown-reviews.ts` / `src/lib/markdown-review.ts` (agent suggestions bucket vs collab `SuggestionRecord`)
