# Reference manager progress tracker

The single place that says what is done. Every line maps to the plan ([plan.md](plan.md)). A line is ticked only when its lane is merged into `references/integration` **and** its tests pass there.

Legend: ☐ not started · ◐ in progress · ☑ done and verified · ⏸ deferred (with reason)

## Branching

- Integration branch: `references/integration`, branched from `collaboration` at `0ae5bce`. Worktree: `.claude/worktrees/refs-integration`.
- Each lane works on `references/<lane>` in `.claude/worktrees/refs-<lane>`, branched from the integration tip at the start of its wave, and is merged with `--no-ff`.
- The collaboration work continues on `collaboration` in the main checkout. A single merge of `references/integration` into `collaboration` happens later (see “Big merge” below). No reference lane touches collab code.

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
| core | `references/core` | BibTeX/BibLaTeX, RIS, CSL-JSON parse and serialize; names; normalization; identifiers; dedupe scoring | ☐ |
| syntax | `references/syntax` | Citation grammar, scanner, serializer, trigger detection, key rewrite; micromark/mdast extension | ☐ |
| storage | `references/storage` | Library storage and transactions; library API; attachments follow renames, moves, copies, archive, delete; re-attach by hash; client store | ☐ |

## Wave 2: Markdown integration and panel

| Lane | Branch | Scope | Status |
|---|---|---|---|
| preview | `references/preview` | CSL styles, citeproc formatting, preview plugin and worker, renderer chips, bibliography block, hover card, open PDF at locator, Markdown PDF export | ☐ |
| interop | `references/interop` | Import/export API and document bibliography export; clipboard; text strippers; agent prompt syntax; LaTeX export placeholders | ☐ |
| panel | `references/panel` | Left rail tab, References panel, detail card with provenance, Manage references dialog, Add box (paste BibTeX/RIS/identifiers), Cite at cursor, Cited in this document, style picker | ☐ |

## Wave 3: editors, capture, agent runtime, moves

| Lane | Branch | Scope | Status |
|---|---|---|---|
| editors | `references/editors` | `@` popup in textarea, CodeMirror and Visual; TipTap citation node and popover; CodeMirror decoration; suggestion index | ☐ |
| resolution | `references/resolution` | Identifier lookups (Crossref, DataCite, arXiv, OpenAlex, PubMed, ISBN); PDF and Markdown resolution; LLM + web; AI preferences; background jobs; dedupe and merge UI; confirmation cards | ☐ |
| agent-runtime | `references/agent-runtime` | Child agent runs, nested events and usage; WebSearch tool; agent suggestions bucket and its review UI | ☐ |
| moves | `references/moves` | Cross-notebook copy-on-move; key rename with aliases and draft-aware citation rewrite | ☐ |

## Wave 4: fact-check and later items

| Lane | Branch | Scope | Status |
|---|---|---|---|
| factcheck | `references/factcheck` | `fact-check-citations` skill: ListCitations, CheckCitations fan-out, SubmitVerdicts, SuggestEdit, evidence verification, existence check, missing references, report, budget, buttons | ☐ |
| pdfcite | `references/pdfcite` | Quote and cite from the PDF viewer; drag into editors; semantic `@` search through Global Search | ☐ |
| scholarly | `references/scholarly` | Retraction and correction checks with badges; ISO 4 abbreviations; generated `.bib` mirror and LaTeX `\cite` completion; biblatex LaTeX export | ☐ |
| syntax2 | `references/syntax2` | Narrative citations in every layer; per-document style override; reference-list screenshot import through local OCR | ☐ |

## Deferred

- ⏸ Shared libraries for collaborative notebooks (plan §5 Phase 5). It needs the collab manifest and sync code, which this effort must not touch. Do it as part of the big merge, once the collab host and manifest are merged on `collaboration`.
- ⏸ GROBID extractor (D7: optional, not planned).

## Big merge notes

Files that both efforts edit, to review carefully when `references/integration` merges into `collaboration`:

- `src/components/libera/left-panel.tsx`, `src/components/libera/tiptap-markdown-editor.tsx`, `src/components/libera/use-libera-workspace.ts`, `src/lib/tiptap-changes.ts` (collab suggestions were landing there at 0ae5bce)
- `src/lib/storage/markdown-reviews.ts` / `src/lib/markdown-review.ts` (agent suggestions bucket vs collab `SuggestionRecord`)
