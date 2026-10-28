# Markdown Source editor parity — 2026-10-25

The classic editor remains the behavioral reference. Its code was moved into shared policy and UI without intentionally changing its behavior. The supplied, uncommitted first-pass fixes were retained. No protected list-indent or chat files were edited, and nothing was committed or pushed.

## Evidence conventions

The divergence tables cite **the working tree at the start of this audit**, including the supplied first-pass edits. Refactoring moved the cited code; these are before-refactor line numbers, not links to the resulting implementation.

- **C** = `src/components/libera/markdown-editor.tsx`.
- **M** = `src/components/libera/markdown-source/markdown-codemirror-editor.tsx`.
- **Menu** / **Bar** = `src/components/libera/markdown-source/markdown-source-{context-menu,find-bar}.tsx`.
- **CM/** = `src/lib/markdown-codemirror/`.
- **Review** = `src/components/libera/use-editor-review.ts`.

## Confirmed divergences fixed

| ID | Divergence | Classic evidence | CodeMirror evidence | Resolution |
|---|---|---|---|---|
| F01 | Formatting accepted either Ctrl or Cmd, with Shift, on every platform; CM's `Mod` bindings restricted the platform modifier and Shift. Find also differed for Alt/Shift modifiers. | C:1861–1890 | M:372–409 | Both call `handleSourceKey` and `sourceShortcut`. |
| F02 | File-link keys ignored modifiers in classic; CM keymaps required exact modifiers. Citation Shift+Arrow/Escape variants were also omitted by the CM bindings. | C:1826–1858; citation popup's `handleKey` | M:393–404 | Both pass the real key/modifier object through the shared dispatcher, citation handle and file-link policy. |
| F03 | CM retained selection undo/redo shortcuts, notably Alt+U; classic had no such binding. | C:1861–1891 | CM/setup.ts:77–84; installed `@codemirror/commands/dist/index.js`:569–575 | Filter `undoSelection` and `redoSelection` by function identity; preserve document history keys. |
| F04 | CM Home/Shift+Home and macOS Cmd+Left toggled indentation and wrap/logical boundaries. Classic delegates these keys to native textarea navigation. | C:1826–1891 | CM/setup.ts:80–82; installed commands:841–871 | Use the visual line boundary without the indentation toggle. Wrapped layout and macOS still need a browser check. |
| F05 | `#` destinations offered headings in the current document only in classic. | C:1109–1123, 1332–1367, 2295–2301 | M:286–307, 779–808, 942–949 | Shared destination/headings context, filtering, insertion edit and heading popup. |
| F06 | Pending popup refreshes could use a textarea caret after blur; CM required `hasFocus`. | C:1080–1084, 1186–1210 | M:255, 289 | Shared trigger policy has no additional focus gate. Focus/click/input remain DOM glue. |
| F07 | Moving the selection refreshed CM popups even for vertical arrow navigation and find selections; classic suppresses refresh on ArrowUp/Down/Enter/Escape keyup and does not refresh from selection alone. | C:1894–1908, 2064 | M:426–431 | Shared keyup rule; CM selection-only updates emit selection without reopening popups. |
| F08 | Entering a file-link destination or a non-trigger selection cleared classic's inserted-citation dismissal; CM could retain it and suppress a later query on that key. | C:1186–1211 | M:255–279 | Shared citation context and dismissal reset. |
| F09 | Reopening a menu at the same coordinates/range reset classic's prompts; CM's identical React key could retain old prompts. | C:1437–1438 | M:903; Menu:67–68 | Shared menu resets its prompt state for each new menu object and runs the same focus rule. |
| F10 | Heading action enablement followed classic's current displayed document; CM stored flags only when opening the menu. | C:879–901 | M:515–522 | Shared menu derives and memoizes capabilities from current text/range; CM refreshes menu text on edits. |
| F11 | More than 20 publications could evict a still-pending CM echo and let it overwrite newer typing. Classic retained all unacknowledged publications. | C:747–756, 903–910 | M:193–198, 625–628 | Shared draft publication and echo list; no arbitrary 20-draft cutoff. |
| F12 | CM's publication guard used `composing`, which can be false before the first IME change. Classic blocks from composition start. | C:718, 1919–1922, 2042–2043 | M:207–209 | Shared publisher; CM supplies `compositionStarted`. |
| F13 | After a match disappeared, CM normalized its active index for the counter and Replace action; classic retained the raw active index, clamped the counter, and could leave Replace with no target. | C:1066–1068, 2011–2013 | M:686, 878–889 | Shared find state/navigation preserves classic semantics. |
| F14 | After replacement triggered numbering, CM navigated matches in the renumbered document; classic used the immediate replacement result. | C:1039–1061 | M:768–773 | Shared replacement/navigation algorithm uses classic's replacement result. Caret mapping remains the deliberate exception I02. |
| F15 | Several CM-local programmatic edits bypassed the textarea edit surface: formatting, heading changes, rich/Smart/menu paste, citations, PDF quotes and document style could differ in input events, focus, scroll preservation or prompt selection emission. | C:1230–1248, 1299–1310, 1537–1562, 1595–1606, 1712–1730, 1796–1822 | M:374–385, 459, 489–491, 656–657, 760–774, 826–834, 851–853, 911–916 | CM routes these edits through its existing textarea adapter. Shared find uses that same interface. Immediate selection callbacks now accompany formatting, headings, citations and converted pastes. |
| F16 | Document-style insertion at a selection boundary used classic's explicit offset affinity; CM's automatic mapping could move a caret at offset zero past the inserted front matter. | C:1297–1304 | M:656 | Shared `sourceSelectionAfterChange` and adapter edit. |
| F17 | CM Enter/delete/undo commands change state without a native input event, leaving a pending review passage selected. Classic input clears it. | C:1927–1932; Review:94–96 | CM/setup.ts:78–83; Review:135–137 | CM clears review selection for local document changes, excluding outside value/review synchronization. |
| F18 | Review comment shortcuts used the pane corner in classic and caret coordinates in CM. Classic also accepted right-button mouseup; CM rejected it. CM's review composition guard started late. | Review:82–90; composition listeners:80, 96 | Review:107–125 | Source review shares comment-point policy and uses source-specific mouse/composition rules; other CodeMirror editors keep their existing behavior. |
| F19 | CM's native citation tooltip lacked the shared card's Escape/leave behavior. Its nearest-token fallback could Ctrl+click the preceding citation from trailing whitespace. | C:1253–1284; `references/citation-popup.tsx`: `useEditorCitationHover`; `citation-hover-card.tsx`:403–412 | CM/citations.ts:128–189; M:545–553 | Source panes use `useEditorCitationHover` and shared citation hit rules. Optional native tooltip API remains available to other hosts and existing tests. |
| F20 | CM explicitly disabled autocorrection and capitalization, and its base view disabled writing suggestions and translation. Classic only disabled spellcheck. | C:2028–2066 | CM/setup.ts:84; installed view:8307–8312 | Shared spellcheck/label policy; CM restores the current app's textarea defaults for the other attributes. Native OS effects remain unverified. |
| F21 | CM inherited 16px top padding and 40vh bottom padding from the LaTeX editor, instead of classic's `p-5`. | C:2020, 2032 | M:866; `src/app/globals.css`:2976 | Both use the common 1.25rem vertical pane padding. |
| F22 | A CRLF replacement could request a CM caret beyond its normalized new document and throw. | C:1712–1721; native textarea value/range clamping | CM/commands.ts:29–32 | Clamp against `state.toText(replacement).length`. |
| F23 | CM diffed incoming CRLF/CR strings against an LF document; an initial CRLF value could add blank lines. Detached adapter values were also raw. | C:918, 2039 (native textarea normalization) | M:354–358, 630–635; CM/textarea-adapter.ts:73–75, 132–138; CM/value-sync.ts:65–68 | Normalize before incoming diffs and in detached storage; normalize `valueChangeSpec` through the state's text parser. |
| F24 | `setSelectionRange(start, end)` with end before start selected a range in CM; native textarea collapses at end. | Native textarea surface, used at C:957, 1559 | CM/textarea-adapter.ts:159–169 | Adapter clamps end first, then start to end. |
| F25 | A detached CM adapter lost its last scroll position; the detached textarea retains it for capture/inspection. | C:740–745; native textarea scroll surface | CM/textarea-adapter.ts:103–111, 229–244 | Save scroll on detach, alongside value and selection. |
| F26 | Menu paste could use newly changed CM preferences after the asynchronous clipboard read; classic used the settings captured when the action started. | C:1735–1747 | M:840–848 | Capture CM options before awaiting; both use `sourcePasteMode`. |

## Deliberate improvements retained

| ID | Difference and evidence on both sides | Recommendation |
|---|---|---|
| I01 | Outside values, including AI results and image insertion, preserve CM text history and map selection through a minimal change. Classic assigns `.value`. C:765–771, 903–920; M:320–359; workspace AI paths:2495–2520, 2553–2583, 2617–2638. CM incoming `value` changes can join adjacent history within its normal grouping interval; review changes explicitly isolate history. | Keep undoable minimal edits and collaboration rebasing. Do not imitate native `.value` history loss. Consider separately isolating incoming AI operations if their grouping is changed. |
| I02 | Appended numbering maps a CM programmatic caret through the renumbering. Classic's native edit helper subsequently restores the requested raw caret. C:1712–1721; `textarea-editing.ts`:55–67; CM/commands.ts:25–35; CM/heading-numbering.ts; supplied component test “typing and adapter edits renumber in a separate undo step”. | Keep the supplied CM caret mapping and its existing test. The new numbered-replacement scenario explicitly documents both caret outcomes. |
| I03 | A CM popup claims Escape before review exits; classic's native review listener runs before React's delegated Source key handler, so the same key can also exit Review. Review:87–96 versus 119–137; C:1833–1836; M:394–400. Confirmed by the paired review scenario. | Keep CM's popup-first behavior. Changing classic's event ordering should be an explicit follow-up behavior change. |
| I04 | CM adds inline syntax colors, unresolved citation chips, active-line highlighting and viewport-based rendering; classic uses the line overlay. CM review also includes agent-suggestion anchors and suppresses shared proposal highlights supplied by collaboration overlays; classic's ranges include local session suggestions only. C:776–780, 796–850; CM/setup.ts:23–75, CM/libera-syntax.ts:221–382, CM/citations.ts:72–125; M:675 and Review:154–163. | Keep these intentional CodeMirror/review features and its geometry adapter. They do not imply pixel-identical layout. |
| I05 | CM defers outside values during IME and completes deferred numbering after composition; classic applies prop values immediately and relies on native post-composition input. C:903–920, 1753–1755, 2042–2043; M:323–326, 526–540. | Keep the supplied composition protection; verify real IME before considering changes to classic. |
| I06 | CM consistently reads its canonical LF document. Classic can return the original CRLF prop through `readDraft` until an input replaces its raw draft ref, even though its textarea DOM is LF. C:703, 750, 917–918; M:192, 356. | Keep CM's canonical offsets/publications. Normalizing classic's raw draft storage would be a separate classic behavior change. |
| I07 | `documentSource="external"`, extension reconfiguration and whole-document replacement refusal exist only on CM's collaboration seam. Classic's props/value effect have no equivalent. C:132–165, 903–920; M:331–352, 638–644; source/types.ts:41–57. | Keep this explicit engine capability; local parity scenarios use the common value-mode interface. |
| I08 | CM's delayed selection emission reads the latest callback ref. Classic's pending selection timer closes over the callback from the render that scheduled it; its separate latest ref is used for unmount. C:738–744, 1935–1965; M:161–169, 213–232. | Keep CM's callback freshness. Routing classic through a latest-callback selection hook would be a separate classic behavior change. Callback replacement during the debounce interval was established from the implementations, not a real-browser check. |

No other confirmed divergence is left unfixed. Native browser/OS behavior that cannot be established by these implementations and jsdom is listed under verification limits, rather than asserted as parity.

## Shared surface

| Module | Delegation |
|---|---|
| `src/lib/markdown-source.ts` (new) | Existing heading, image and compact-edit helpers moved out of the classic component, with compatibility re-exports. Both editors now use its keyboard dispatcher/format table/Tab rule, formatting edits, paste priority/conversion/Smart Paste modes, drag kind, link and citation trigger/dismissal rules, heading-link edits, hit testing, selection affinity, and pane/input constants. It imports CodeMirror edit types only. |
| `markdown-source/use-markdown-source-find.ts` (new) | Common find state, cached case/wildcard matching, active index, navigation, replacements, caret/scroll/focus restoration. DOM operations use the existing textarea ref/CM adapter. |
| `markdown-source/use-markdown-source-draft.ts` (new) | Common live reader, 250ms debounce, composition deferral, echo bookkeeping, draft registration, pagehide/unmount publication and canvas/tab-switch capture. |
| `markdown-source/markdown-source-context-menu.tsx` | The classic JSX copy is removed. Both use the same state/position factory, capabilities, prompts, focus/reset/closing rules, labels, enablement, AI busy states and spinner icons. |
| `markdown-source/markdown-source-find-bar.tsx` | The classic JSX/key-handler copy is removed. Both use the same labels, controls and Enter/Shift+Enter/Escape behavior. |
| Existing citation popup/hover and review modules | Both reuse the shared citation hover/card and Source comment-point policy. Engine geometry, transactions, native ranges and review/collaboration bridges remain separate. |
| Existing CM adapter/value-sync modules | Lightweight line-ending normalization, corrected range clamping and detached scroll; callers still use the established textarea interface. |

Resulting entry points: classic draft/find hooks at `markdown-editor.tsx:343,365`, keyboard at `:994`, menu at `:1166`; CM draft/find hooks at `markdown-codemirror-editor.tsx:164,573`, keyboard at `:633`, menu at `:737`. These line numbers describe the completed implementation.

## Additional audit coverage

- Right-click selection movement remains DOM-specific: CM keeps the explicit pointer correction that existing tests require; classic receives the browser's selection. Menu selection/image detection, item visibility, all enablement, dimensions, closing events, prompt focus, busy states and icons are shared. Review locking adds no new menu-disable rule; that matches classic.
- Find inputs retain Enter → next, Shift+Enter → previous, Escape → close; replacement inputs retain Enter and Shift+Enter → replace current, Escape → close. F3 has no app binding in either editor. Both use the existing case-insensitive `text-find.ts` implementation, wildcard escaping/Unicode matching and literal replacement text.
- Image paste precedes rich/Markdown/plain paste. PDF quote drop precedes image drop; dragover offers copy. HTML conversion, malformed-HTML fallback, Markdown preference, child/peer Smart Paste and selection use shared helpers. Existing PDF quote and image suites exercise the common callback/quote paths.
- Toolbar wrapping/boxes/tables/file-link insertion already use the workspace textarea interface and `replaceTextareaSelectionWithUndo`; see `use-libera-workspace.ts:1591–1640,1745–1757,1787–1793,1956–2024`. All CM adapter edits isolate history; document style, rich/Smart paste, citations, heading links and find replacements use that same route. Heading numbering remains its own supplied undo step. Native typing/plain paste/native undo grouping still needs browser verification.
- Selection callbacks retain the 120ms debounce and flush on blur/unmount. Draft capture remains registered for pagehide and canvas/tab/mode layout changes. Preview scroll synchronization still goes through `textarea-position.ts` and the adapter's geometry methods; the classic highlight overlay continues synchronizing its own scroll.
- Both wrap lines and use four-column tabs. Tab/Shift+Tab change selected headings only; a plain Tab keeps focus traversal. No indentation or HTML auto-completion keymap was added. Accessibility names and spellcheck policy are shared; native textarea and contenteditable retain their respective accessibility/selection implementations.

## Files changed by this task

- Added `src/lib/markdown-source.ts`, `src/components/libera/markdown-source/use-markdown-source-{draft,find}.ts`, `scripts/editor/markdown-source-parity.test.ts`, and this audit.
- Changed `src/components/libera/markdown-editor.tsx`, `src/components/libera/markdown-source/markdown-{codemirror-editor,source-context-menu,source-find-bar}.tsx`, `src/components/libera/use-editor-review.ts`.
- Changed `src/lib/markdown-codemirror/{commands,setup,citations,textarea-adapter,value-sync}.ts`.
- Extended `scripts/editor/{markdown-codemirror-commands,markdown-codemirror-editor,references-editors-source}.test.ts`. The existing find test now waits for the focus-restoration frame before dispatching synthetic Escape, matching the classic timing.

The existing heading-numbering implementation/tests and all excluded chat/list-indent changes were preserved.

## Verification

The package's standard Windows-compatible invocation works in the current dependency state: `node --require ./scripts/editor/setup.cjs --import tsx --test`. `sharp` loads as 0.34.5; no dependency cache, loader, NODE_PATH, or package changes were necessary. Test concurrency was limited to two for the broad runs.

- Full `scripts/editor/*.test.ts` run during implementation: **1,542 tests; 1,506 passed, 17 failed, 2 cancelled, 17 skipped**. This includes every suite touching either editor. The broad-run failures are listed below; they were not changed as part of this task.
- Final focused run: **190/190 passed** across CodeMirror commands/components/syntax, the paired source scenarios, numbering, citations/narrative/PDF quotes/agent suggestions, Markdown/boxes/link insertion, review lifecycle, source performance and workspace performance. The paired source/citation suites cover 52 scenarios in the final tree, including explicit composition-publication and CRLF synchronization regressions.
- Targeted ESLint on every changed TS/TSX file: **passed, no warnings**.
- `npx tsc --noEmit`: **the same eight known errors, no new errors**. They remain in `document-chat-panel.test.ts` (1), `document-ocr-loop.test.ts` (1), `pdf-outline-panel.test.ts` (1), `pdf-text-layer-styles.test.ts` (3), `tab-lifecycle.test.ts` (1), and `workspace-panel-performance.test.ts` (1).
- Whitespace checked with `core.whitespace=cr-at-eol` to respect this checkout's existing CRLF files. Test logs are in `.next/editor-parity-{all,final-targeted,final-lint,final-tsc}.log`.

Full-run failures/cancellations: `agent-route`, `document-chat-panel`, `global-search-cache`, `global-search`, `global-search-triggers` (2 cancelled), `ink-pen` (6 Electron failures), `latex-editor`, `openrouter-prompt-cache`, `pdf-chat-route`, `references-agent-panel`, `references-scholarly-biblatex`, `tab-editor-state`, and `workspace-panel-performance`. Causes include sandbox process-launch/rename failures, the PDF worker environment, unrelated assertion/mock failures, and a transient workspace render count. `workspace-panel-performance` subsequently passed in the focused run. The protected chat file and associated test were left alone. A clean-baseline run for every unrelated failure was not performed, so this report does not classify every failure as pre-existing.

Verification limits: no real browser/Electron interaction, native undo stack, actual system clipboard/drag source, screen reader, macOS navigation, pixel/scroll-sync comparison, or real IME session was exercised. jsdom composition and transaction/history scenarios passed; they are not substitutes for real IME validation.
