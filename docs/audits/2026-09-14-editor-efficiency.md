# Editor efficiency audit — 14 September 2026

The main opportunities are to eliminate repeated document-wide computation and synchronous storage work. The editor code does not show an unconditional idle polling/render loop. Most identified costs are triggered by editing, scrolling, search, tab switches, or review history. Background AI activity is a separate, conditional source of consumption.

This is a source audit with synthetic CPU benchmarks and targeted lifecycle tests. It establishes expensive execution paths, not measured watts, battery-life loss, or a diagnosis of a particular running session. Browser layout, rasterization, GPU consumption, OS spelling services, and packaged-app energy use were not measured. Application behavior was not modified. Existing unrelated working-tree changes were preserved.

**Scope and evidence**

Inspected Source and TipTap input handling, draft publication and saving, toolbar subscriptions, search, math/image extensions, preview workers and renderer reuse, outline tracking, text measurement and scroll synchronization, review projection and persistence, tab state propagation, detached preview windows, chat persistence, CSS animations, and Electron window settings. Checked installed TipTap implementation details and the bundled Next.js Strict Mode guide rather than assuming library behavior.

Seventeen targeted tests passed: `tiptap-performance`, `source-performance`, `markdown-preview`, `markdown-heading-index`, `review-editor-lifecycle`, and `markdown-windows`. Their JSDOM geometry is stubbed; passing them does not establish good browser layout performance. Expected heading-worker fallback warnings occurred in test harnesses without a browser Worker.

The synthetic [benchmark](/Volumes/CrucialX/project-libera/docs/audits/editor-efficiency-benchmark.cjs) and [raw results](/Volumes/CrucialX/project-libera/docs/audits/editor-efficiency-benchmark.json) are reproducible with:

```sh
node docs/audits/editor-efficiency-benchmark.cjs
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/tiptap-performance.test.ts scripts/editor/source-performance.test.ts scripts/editor/markdown-preview.test.ts scripts/editor/markdown-heading-index.test.ts scripts/editor/review-editor-lifecycle.test.ts scripts/editor/markdown-windows.test.ts
```

Measurements use Node v22.23.1 on arm64, one warm-up and five timed samples, except review cases which use three. They call the production parsing functions directly, without browser rendering or worker message transfer. Process CPU time includes runtime background work and can exceed elapsed time; it is not an energy reading. The wildcard probe runs in an isolated worker and is terminated after 500 ms.

| Synthetic workload | Median elapsed time / observed result |
| --- | --- |
| Preview preparation and patch signatures, 500 sections / 46,780 bytes | 84.72 ms |
| Heading-worker parser, same document | 58.14 ms |
| Preview preparation, 100 equations / 14,280 bytes | 88.91 ms |
| Word count, 46,780 bytes | 0.79 ms |
| Edit first heading, 500-section preview | 1,000 of 1,000 element blocks replaced in patch |
| Append one character at end, same preview | 1 of 1,000 element blocks replaced in patch |
| Review disabled, ten resolved orphaned comments, 9,180-byte document | 303.70 ms per sync |
| Wildcard `*a*a*a*a*a*a*a*a*b` against 80 `a` characters | Exceeded 500 ms; worker terminated |

The existing TipTap test also measured a 13,990-byte document: 60 synthetic insertions had 0.82 ms median and 3.56 ms p95, with zero immediate serializations or React commits and one deferred serialization taking 3.13 ms. This is encouraging for ordinary editing, but excludes the complete application and real browser layout.

**High-impact findings and fixes**

1. **Source highlighting rescans the entire document synchronously on every input. High priority for long-document typing.**

   [commitEditorValue](/Volumes/CrucialX/project-libera/src/components/libera/markdown-editor.tsx:1331) immediately calls `refreshHighlightLayer`. [renderHighlightedMarkdown](/Volumes/CrucialX/project-libera/src/components/libera/markdown-editor.tsx:483) splits every line, walks fence state from the beginning, allocates chunks, and checks review ranges for each line. [The refresh loop](/Volumes/CrucialX/project-libera/src/components/libera/markdown-editor.tsx:637) then compares every line against the previous result. DOM reuse saves mutations, but the computation remains document-wide. With L lines and R review ranges, overlap checks can approach L × R per edit. Publishing the draft also updates `editorValue`, triggering another highlight refresh after the pause.

   Newlines inserted near the start additionally shift the index of later lines: the cache is indexed by line number, so many different downstream lines are rewritten. The full textarea and full highlight layer remain mounted; neither is virtualized.

   **Fix:** derive the changed range from input events or a text diff, cache line tokens and incoming/outgoing fence state, and propagate highlighting only until state converges. Splice retained line nodes when lines are inserted. Sweep sorted review intervals rather than testing every range against every line. Avoid an identical rehighlight on draft publication. For very large files, offer a reduced-highlighting mode or a viewport-aware editor model. Preserve native undo, IME, wrapping, and selection behavior.

   **Verify:** compare equal-length edits and newline insertions at top/middle/end in 10 KB, 100 KB, and 1 MB files. Record lines tokenized, allocations, DOM mutations, input CPU time, and real browser layout time.

2. **Source preview patches lose reuse when source offsets shift. High priority for editing existing prose.**

   [createMarkdownPreviewPatch](/Volumes/CrucialX/project-libera/src/lib/markdown-preview.ts:16) compares `JSON.stringify(node)` by array index, including source positions and `data-source-*` attributes. Inserting one character in the first heading changed every heading/paragraph block signature in the 500-section fixture. All 1,000 element blocks were resent, versus one when appending at the end. The 999 reused top-level nodes were whitespace, not the document's heading/paragraph elements.

   These changed object identities defeat [PreparedMarkdownBlock's memoization](/Volumes/CrucialX/project-libera/src/components/markdown-renderer.tsx:132), causing conversion and reconciliation across the document. This does not necessarily remount every DOM element, but it removes the intended computational reuse.

   **Fix:** separate stable semantic/render identity from changing source-position metadata. Reconcile blocks using stable identities or a block diff, and update source maps independently. Preserve reference-link resolution and exact source navigation: simply stripping offsets from equality while retaining stale offsets would be incorrect.

   **Verify:** repeat the benchmark's first-heading edit and assert unchanged content blocks retain render identity while all source offsets remain accurate. Include inserted/deleted blocks, repeated paragraphs, references, tables, and equations.

3. **Workers still perform complete preview and heading parses after editing pauses. High priority for math-heavy and long documents.**

   [prepareMarkdownPreview](/Volumes/CrucialX/project-libera/src/lib/markdown-preview.ts:22) constructs a processor and reparses the full document through Markdown, HAST conversion, and KaTeX before patch comparison. Moving this work to a worker protects input responsiveness but does not remove its CPU cost. One 47 KB prose fixture took about 85 ms per preparation; a 14 KB fixture with 100 equations took about 89 ms. This cost persists even when a final patch contains only one changed block.

   TipTap independently sends each published draft to [useMarkdownHeadingIndex](/Volumes/CrucialX/project-libera/src/components/libera/tiptap-markdown-editor.tsx:209). Its [heading-offset parser](/Volumes/CrucialX/project-libera/src/lib/markdown-review.ts:37) builds a complete Markdown AST, even for edits that cannot change headings. It took about 58 ms on the prose fixture. The visible outline also has its own cheaper [line scanner](/Volumes/CrucialX/project-libera/src/components/libera/outline-panel.tsx:80). TipTap's heading index is requested regardless of whether the sidebar is visible.

   Both drafts publish after 250 ms; Source adds another 250 ms preview debounce. These are pause-triggered costs, not work that necessarily runs after every keystroke. Slow typing and frequent pauses can still repeatedly activate them. Workers coalesce requests but cannot interrupt an already-running synchronous parse.

   **Fix:** cache unchanged equation output and block parsing where Markdown dependencies allow it; reuse processor configuration; consolidate outline data. Maintain TipTap heading positions from ProseMirror document changes and update source mapping only when needed. Add adaptive preview scheduling and an optional manual/reduced preview mode for large documents. Suspend dispensable preparation when its view is hidden. Preserve exact draft reads for Save, export, review, and tab closing.

   **Verify:** measure total worker CPU per minute of realistic typing, not only main-thread latency. Count parses and KaTeX calls for a non-math edit in a math-heavy document. Processor reuse alone will not remove the dominant full parse.

4. **Orphaned review comments repeatedly trigger expensive semantic recovery—even when resolved or review is disabled. High priority whenever review history exists.**

   [syncReview](/Volumes/CrucialX/project-libera/src/lib/markdown-review.ts:114) maps every thread. Each [mapAnchor](/Volumes/CrucialX/project-libera/src/lib/markdown-review.ts:79) recomputes the document diff and can search the entire document. If the quote is absent, it reparses the document into blocks and reparses candidate blocks to compare semantic signatures. Previously orphaned and resolved threads are not excluded. Ten synthetic resolved orphaned comments took about 304 ms to sync a 9 KB document with `enabled: false`.

   [The provider](/Volumes/CrucialX/project-libera/src/components/libera/markdown-review-context.tsx:166) calls this projection synchronously during render for changed drafts, and the server repeats synchronization when saving review metadata. Active TipTap decorations add [source-to-ProseMirror block mapping](/Volumes/CrucialX/project-libera/src/lib/tiptap-review.ts:41). That mapping is cached per document/source pair, so it is not reparsed once per comment, but edits invalidate the cache.

   **Fix:** compute the change map once, share a parsed block/signature index across anchors, and cache failed reattachment attempts. Keep cheap offset mapping for retained history, but defer exhaustive orphan recovery to explicit reattachment or bounded background work. Avoid repeatedly running semantic recovery for resolved/disabled annotations. Preserve ambiguity handling and review undo/redo semantics.

   **Verify:** measure 0/10/100 attached, resolved, and orphaned threads, with review enabled and disabled. Assert normal typing does not trigger a full semantic search per orphan.

5. **Review storage rewrites and synchronously flushes the entire database. High priority for larger review histories and frequent tab switching.**

   [transaction](/Volumes/CrucialX/project-libera/src/lib/storage/markdown-reviews.ts:20) reads and parses one database containing all reviewed documents, serializes it, writes a temporary file, calls `handle.sync()`, and renames it. [loadReview](/Volumes/CrucialX/project-libera/src/lib/storage/markdown-reviews.ts:50) uses this transaction even when the document already exists and nothing changes.

   [The provider loads review metadata](/Volumes/CrucialX/project-libera/src/components/libera/markdown-review-context.tsx:55) for Markdown tabs whether review is enabled or not. Once comments/session data exist, [900 ms background sync](/Volumes/CrucialX/project-libera/src/components/libera/markdown-review-context.tsx:148) can rewrite the database after editing pauses. The database includes document snapshots, undo snapshots, and previous review sessions, so one small note can incur work proportional to the entire accumulated history. This is distinct from Markdown autosaving; there is no ordinary document autosave timer in the inspected editor path.

   **Fix:** make existing-document loads read-only, create review records lazily where compatible with recovery, skip unchanged transactions, and persist per-document updates with a transactional store or journal. Batch background anchor saves while keeping user actions durable and maintaining cross-window revision checks. Do not merely remove durability guarantees.

   **Verify:** instrument bytes read/written, fsync calls, and request latency for repeated tab switches and one-character edits with a populated synthetic database. Hardware I/O energy was not measured here.

6. **Scroll tracking performs document scans and repeated geometry reads at frame rate. High priority for long reading/scrolling sessions.**

   TipTap's [scroll handler](/Volumes/CrucialX/project-libera/src/components/libera/tiptap-markdown-editor.tsx:313) uses `posAtCoords` and [markdownLineForTiptapPosition](/Volumes/CrucialX/project-libera/src/lib/markdown-outline-navigation.ts:12), which walks nodes from the document start to the viewport anchor and splits the Markdown prefix to calculate the line. Near the end of a long document this is substantial repeated traversal.

   Source [scroll synchronization](/Volumes/CrucialX/project-libera/src/components/libera/workspace-panel.tsx:776) uses a full-document textarea mirror, repeated Range measurements, and [a scan of preview source elements](/Volumes/CrucialX/project-libera/src/lib/markdown-source-map.ts:123). Preview user scrolls calculate source position and can recalculate it through the reverse-sync call. Programmatic preview scrolling still performs geometry work for view-state reporting.

   The [mirror](/Volumes/CrucialX/project-libera/src/lib/textarea-position.ts:137) already caches text and styles: unchanged scrolling does **not** rewrite the full mirror every time. However, measurements remain, and changed text/width requires fresh layout. Frame coalescing caps frequency at the display rate; it does not make each frame cheap.

   **Fix:** cache heading positions and line starts for binary search; maintain an indexed preview source map; reuse geometry within each frame; avoid duplicate reverse-sync measurements. Record raw scroll offsets cheaply and update outline tracking at a lower rate or on scroll completion. Invalidate layout caches on content/font/width/image changes.

   **Verify:** use Chromium traces to measure script, layout, and paint during identical scroll gestures at 60/120 Hz. Preserve wrapped-line precision and prevent scroll feedback loops. The size of actual layout savings remains unmeasured.

7. **Find repeatedly scans/rebuilds matches, and wildcard regexes can consume excessive CPU on tiny inputs. High priority for robustness; conditional on search use.**

   [TipTap Find](/Volumes/CrucialX/project-libera/src/lib/tiptap-find.ts:89) rescans every text block and reconstructs all decorations after each document edit while a query is active. Changing only the active match also takes the same full-search path. Source computes matches inside its immediate highlighting path and again through [textMatches/useLayoutEffect](/Volumes/CrucialX/project-libera/src/components/libera/markdown-editor.tsx:633) when Find is open. A retained Source query still gets scanned by the memo after Find is closed because that memo is not gated by `findOpen`.

   [Wildcard conversion](/Volumes/CrucialX/project-libera/src/lib/text-find.ts:11) concatenates greedy regex repetitions. Alternating stars and literals can produce severe backtracking when the final literal is absent. The benchmark exceeded 500 ms for 80 characters. Both editors invoke this matcher synchronously on the UI thread; debouncing alone cannot bound its execution time once started.

   **Fix:** use a wildcard matcher with a predictable runtime bound and preserve existing escaping/case/Unicode semantics. Maintain search results incrementally or in cancellable worker jobs. Switching active matches should update only the old/new active decorations. Gate closed Source search and eliminate duplicate scans. Bound rendered highlights for extremely common queries.

   **Verify:** add adversarial wildcard cases with enforceable time budgets, large match counts, editing with Find open, repeated Next/Previous actions, and typing after closing Source Find.

8. **Scroll/selection state updates spread through the entire workspace. Medium-to-high priority after the direct hot paths.**

   [setActiveTabViewState](/Volumes/CrucialX/project-libera/src/components/libera/use-libera-workspace.ts:780) writes scroll and selection state into React tab state. [updateTab](/Volumes/CrucialX/project-libera/src/components/libera/use-libera-workspace.ts:522) always returns a new tabs array—even if its updater returns the original tab. Source publishes selections after 120 ms; TipTap and Source scroll persistence can update at frame cadence. This creates root state updates and work across the workspace.

   [The review context value](/Volumes/CrucialX/project-libera/src/components/libera/markdown-review-context.tsx:174) is newly allocated on each provider render, notifying consumers even when review data has not changed. Visible chat also normalizes each assistant message before the memoized renderer can bail out. Thus unrelated UI adds work to an editor scroll or caret movement.

   **Fix:** retain the original tabs array for no-op updates, keep high-frequency view state in a per-tab store/ref, and publish only semantic changes or batched persistence. Memoize/split review context and memoize stable chat message preprocessing. Preserve exact view state on tab/mode switch.

   **Verify:** profile the complete app, including populated outline/chat/review panels. Existing zero-commit editor tests do not include all these parents and consumers.

**Additional conditional costs**

- **AI chat beside either editor:** [streaming publication](/Volumes/CrucialX/project-libera/src/components/libera/document-chat-panel.tsx:206) can update every 50 ms, re-rendering the growing reply through Markdown/KaTeX. [Persistence](/Volumes/CrucialX/project-libera/src/components/libera/document-chat-panel.tsx:97) serializes all chat history once per second while a request is pending, including unchanged snapshots during a long wait. The component's hooks remain active when collapsed. Save only dirty revisions, persist changed conversations, and render streaming tails incrementally. This is not idle polling when no request is pending.
- **Media-heavy documents:** [Source preview images](/Volumes/CrucialX/project-libera/src/components/markdown-renderer.tsx:425) and [TipTap image node views](/Volumes/CrucialX/project-libera/src/lib/tiptap-markdown.ts:141) lack explicit lazy loading/async decoding. All content is mounted. Large images, animated GIF/WebP, many equations, and base64 image strings can increase decode, layout, memory, serialization, and paint work. Consider lazy decoding/loading with stable dimensions, image resizing, asset-backed drafts, and explicit animation controls. Do not remove offscreen editable content without preserving selection/IME and scroll geometry.
- **Large selections and math dialogs:** TipTap's toolbar calls many `isActive` checks on transactions; installed helpers traverse selected ranges for nonempty selections. This is more relevant to Select All/drag-selection than ordinary caret typing. The math dialog renders KaTeX on each formula change. Consolidate selected-range analysis and debounce complex formula previews if profiling confirms material cost.
- **GPU/OS candidates requiring measurement:** Electron's [macOS window](/Volumes/CrucialX/project-libera/electron/main.cjs:1430) uses active vibrancy; Windows adds CSS backdrop blur. These could add compositing work, but no GPU trace establishes their contribution here. Source explicitly disables spellcheck; TipTap does not, so compare effective spellchecking settings before attributing OS spelling work. Test an opaque-window option and static media as controlled experiments.

**What is already working well**

TipTap has `shouldRerenderOnTransaction: false`, selective toolbar subscriptions, and 250 ms Markdown publication. Source uses a native uncontrolled textarea with retained highlight DOM nodes. Both flush exact drafts for explicit consumers and defer normal publication during IME composition. Preview and heading workers keep one job in flight and discard stale output; they terminate on unmount. Ordinary inactive Find avoids TipTap document scans. Word counts are memoized/debounced at 750 ms and were cheap in these fixtures, so they are a lower priority than parsing/review work. Detached Markdown windows are manual-refresh snapshots. The updater checks every six hours, not continuously. No `backgroundThrottling: false` override or power-save blocker was found in the inspected Electron code.

**Recommended implementation sequence and acceptance criteria**

First bound wildcard execution, remove writes from unchanged review loads, and prevent repeated orphan recovery. These address severe, well-isolated costs. Next make Source highlighting incremental and decouple preview identity from positions. Then reduce repeated parser work, index scroll mapping, and isolate high-frequency workspace state. Adjust this ordering toward review first for users with many annotations, or Source highlighting/preview first for mostly unannotated writing.

Before claiming battery improvements, profile a production packaged build with DevTools closed during energy measurement. Use synthetic 10 KB, 100 KB, and 1 MB documents; prose/math/images; top/middle/end edits; continuous typing and realistic pauses; 60/120 Hz scrolling; Find closed/open/adversarial; review disabled/attached/orphaned; and chat idle/streaming/collapsed. Include two-minute idle and hidden/minimized runs after pending work settles. Keep brightness, power mode, display refresh rate, background apps, and thermal conditions consistent.

Capture renderer/main/worker CPU, long tasks, layout/paint, allocation/GC pressure, disk bytes/fsync, request counts, and OS energy metrics. Compare repeated runs before/after. Require exact Save/export snapshots, stable IME/undo, accurate source navigation, and review integrity alongside reductions in total CPU and I/O. A smoother UI alone is insufficient evidence of reduced battery consumption.
