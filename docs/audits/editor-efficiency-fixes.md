# Editor efficiency fixes

Implemented on `codex/editor-efficiency-fixes`, created before implementation. The changes reduce repeated work while preserving native editing and review behavior.

| Area | Implemented change |
| --- | --- |
| Source highlighting | Cache line/fence analysis; propagate changes until fence state converges; retain suffix DOM nodes through line insertions/deletions; reuse unchanged highlight chunks; sweep merged review ranges. |
| Source preview | Reuse semantic content independently of source coordinates. Update exact source attributes during layout commit without converting unchanged content again. Keep worker replies and source maps paired, including stale-response handling. |
| Parsing and equations | Reuse configured processors and bounded KaTeX output caches. Map heading offsets directly for a deliberately narrow class of ordinary prose edits; keep the full parser for Markdown syntax changes. |
| Review projection | Compute one change map and one candidate index per block count. Share bounded semantic parse results while preserving orphan reattachment, ambiguity detection, and resolved-thread behavior. |
| Review storage | Existing-record loads are read-only. Concurrent record creation still takes the lock and checks again before creating. Actual mutations retain atomic writes, fsync, and revision checks. |
| Scrolling | Cache TipTap heading positions/line starts; index preview source ranges with immediate mutation invalidation; reuse measured source positions; skip redundant reverse measurements for programmatic preview scrolling. |
| Find | Replace backtracking wildcards with bounded dynamic programming; retain Unicode/escaping/greedy behavior; cache matches in immutable TipTap blocks; change only active decorations during Next/Previous; share Source search results and disable closed-Find scanning; construct Replace All output in one pass. |
| Workspace and chat | Preserve unchanged tab arrays; memoize review context; keep scroll updates from restarting review sync; memoize chat preprocessing and avoid saving an already-persisted chat snapshot. |

**Synthetic before/after evidence**

| Workload | Before | After |
| --- | --- | --- |
| Edit first heading in 47 KB preview | 1,000 element blocks replaced | 1 replaced, 999 reused |
| Source first-heading edit, 2,001 lines | Recomputed all line highlighting | Retained 2,000 line records |
| Ten resolved orphaned comments, 9 KB document | 303.70 ms | 10.20 ms |
| Preview preparation with 100 equations | 88.91 ms | 33.15 ms |
| Adversarial wildcard, 80 characters | Exceeded 500 ms | 0.33 ms |

See `editor-efficiency-benchmark.json` for the original measurements and `editor-efficiency-benchmark.after.json` for the new run. Timing results are synthetic Node measurements and vary with warm-up and host load. They do not establish battery-life improvements in watts or hours. The preview timing benchmark retains the original full-tree patch-signature stage for comparability; the element-reuse checks exercise the new production patch protocol.

**Regression verification**

- `npm run test:editor`: 151 tests passed, including saving exact pending drafts, external edits, IME, undo/redo, tab/mode changes, review generation/acceptance/recovery, worker cleanup and stale replies, formatting, clipboard, and exports.
- Added coverage for greedy wildcard equivalence (including Unicode, escaping and line boundaries), a 20,000-character adversarial input, incremental highlighting versus full highlighting through randomized edits, retained Source DOM nodes, exact preview coordinates after early edits and typography changes, references/tables/math/repeated paragraphs, cached invalid equations, read-only review loads and concurrent creation, orphan ambiguity, indexed source lookup versus the original scan, and Find offsets after edits.
- `npx tsc --noEmit`: passed. Removed an obsolete generated type for the already-absent `source-typing-check` route from `.next/dev/types`; no application route was removed.
- `npm run build`: passed. The sandboxed build stalled; the successful production build ran outside the sandbox.
- `node scripts/editor/check-production-editor-workers.cjs`: both generated Turbopack workers passed in an isolated VM without a DOM, including KaTeX, heading parsing, content reuse, and changed source coordinates.
- ESLint on changed implementation files: no errors; one existing `refreshTree` dependency warning in `use-libera-workspace.ts`.
- `git diff --check`: passed.

**Remaining limits**

The source line index still splits/compares the document to identify edits; the improvement removes repeated tokenization, chunk allocation, and suffix DOM rewrites rather than promising constant-time editing. Preview Markdown parsing remains complete to preserve reference and block semantics. Changes involving Markdown syntax still use the heading parser. Active Find still gathers absolute matches and rebuilds decorations on document changes, although unchanged blocks are no longer searched again. Genuine review mutations still rewrite the existing database format; this change does not migrate user storage. Scroll geometry, large mounted documents, images, and native vibrancy retain browser/OS costs.

A packaged-app typing/scrolling energy trace is still needed to quantify battery savings. No GPU configuration, spellchecking behavior, storage durability, document virtualization, or user-facing preview policy was changed.
