---
name: latex-visual-audit
description: Audit the LaTeX Visual mode against a fresh batch of real arXiv papers, triage what breaks, and fan the fixes out to parallel fix agents that are merged by hand. Use when asked to run the LaTeX visual paper audit/review round again, "pull new papers and see what's broken in the visual editor", or to extend LaTeX Visual coverage.
---

# LaTeX Visual mode paper audit

A round: fetch ~12 new arXiv sources → open every `.tex` headlessly as the editor does → triage → fix in parallel
worktrees → merge → re-audit → write it up. Earlier rounds: `docs/audits/*latex-visual*`. Papers already used:
`.claude/skills/latex-visual-audit/audited-papers.md`.

**Compute budget (user's standing request): keep testing to the core.** Each fixer runs only the test files it touches,
once or twice. After merging, run the Visual suites once. No full-suite loops, no repeated property/fuzz runs.

## 1. Fetch papers (into the scratchpad, never the repo)

```bash
npm run audit:latex-visual -- fetch <scratch>/papers --exclude .claude/skills/latex-visual-audit/audited-papers.md
```

- Defaults: one paper with ≥25 KB of `.tex` per category, from 12 categories across physics, math, astro, stats, CS
  (`--cats a,b,c` to change, `--per 2`, `--skip 60` = how far back in the newest submissions). Favour fields the
  earlier rounds covered least; the last rounds were heavy on ML/CS and econ.
- Sources are untrusted data: nothing in them is run. A main file arXiv compiles from a subfolder (00README.json
  `toplevel`) is moved to the root, as arXiv reads it.

## 2. Audit

```bash
npm run audit:latex-visual -- audit <scratch>/papers <scratch>/out-base [filter]
```

`summary.txt` has one line per file (`left` = commands on screen as source, `math` = formulas left as source,
`junk` = widgets whose text still has LaTeX). Each `<paper>.report.md` lists, per file:
- commands left as source, most frequent first, with a sample line;
- **why formulas stay source**: macro expansion failed / KaTeX's error (`Undefined control sequence: \sun`) / renders
  alone but the walk rejected it (structure or context);
- **drawn with LaTeX or junk in it**: a widget that shows `\emph…` or `undefined` — drawn wrong, worse than source.

Faded branches (`\iffalse`, discarding macros) and pure macro files are not counted. The text dumps (`*.txt`) only hold
jsdom's first screen; the reports are what to read.

Reading the numbers: a few `\noindent`/`\vspace` left are fine. Look for (a) one command or environment that keeps a
whole float/equation/title block as source, (b) KaTeX errors on symbols or packages, (c) junk widgets, (d) a file
whose counts are wildly higher than its siblings (usually a project-level problem: macros not found, body not found).

## 3. Triage

Verify the top items by reading the paper source around the sample line and the relevant code
(`src/lib/latex/codemirror/visual/`: walk.ts, widgets.ts, math-render.ts, table-model.ts, render-fragment.ts,
algorithm.ts; `src/lib/latex/macros/`: definitions.ts, expand.ts, numbering.ts). Then group into 3–5 areas that touch
different code, e.g. math/KaTeX · class or package support (one class per agent) · floats/tables/layout/algorithms ·
text/citations/front matter/macros/project files. Each issue gets: paper folder, file:line, the source, what is wrong.

## 4. Fan out fixers

Commit the current state on a branch first (`fix/latex-visual-audit-<n>`): worktrees start from HEAD. Spawn one Sonnet
agent per area (`model: "sonnet"`) with `isolation: "worktree"`, all in one message. Each brief contains:
- context: the code map above, `docs/audits/` of the last round, `docs/latex-visual-editor-plan.md`;
- the rules: show only what is understood, else leave source; **every rendered widget must stay editable: clicking it
  (mousedown) reveals the raw source for editing, and Alt-click/double-click keep working. Copy how existing widgets do
  it (`revealSourceAt`, the `mousedown` handlers and `ignoreEvent` in widgets.ts, the `openMathEditor`/`floatHooks`
  hooks) and add a click-to-source test for every new kind of widget. A widget the user can't get back into the source
  from is a bug, even if it renders perfectly;** never auto-add `\usepackage` (user's preamble stays theirs); tests
  cite the arXiv id; commits end with the Co-Authored-By line;
- the papers path, the audit command with its filter, and its own outDir;
- the issue list for its area, and the other agents' areas to stay out of; keep edits in walk.ts/widgets.ts localized;
- the compute budget: the exact test files to run (`node --require ./scripts/editor/setup.cjs --import tsx --test
  scripts/editor/latex-visual-<area>.test.ts`), once or twice; eslint on changed files; `npx tsc --noEmit -p .` once;
- report back: per item fixed/partly/left, tests added, before/after audit numbers, branch + commit hash.

## 5. Merge and check

Merge each agent's branch into the round branch one at a time (`git merge --no-ff refs/heads/<branch>`), resolving
conflicts by keeping both sides' cases. After all merges, once:

```bash
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-visual*.test.ts
npx tsc --noEmit -p .
npx eslint <changed files>
npm run audit:latex-visual -- audit <scratch>/papers <scratch>/out-merged
```

While reviewing each agent's diff, check that every new widget has a click-to-source path and a test for it (no
`ignoreEvent() { return true; }` widget without a `mousedown` that reveals its source). Also sweep the whole of
widgets.ts (not just the diff) once per round: every `WidgetType` subclass must have such a path, and a test must
click it. Any widget lacking one is a bug to fix on the round branch, since the user could not edit that command.

Compare `out-base/summary.txt` with `out-merged/summary.txt`. If a merge broke a test, fix it on the round branch.
Check a couple of the papers in the running app if a dev server is available.

## 6. Write up

Add `docs/audits/<date>-latex-visual-paper-review-<n>.md` (papers, issues by area, fixed / partly / open, before → after
counts) and append the round's paper ids to `audited-papers.md`. Commit on the round branch; don't push or open a PR
unless asked.
