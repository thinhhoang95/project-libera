# Using Review Mode

Open a Markdown file and click the comment icon beside Save. Review Mode works in both Visual and Source modes.

1. Select a passage, then choose **Add comment** in the floating passage panel. You can also press **⌘/Ctrl+Alt+M** at the current paragraph. The highlighted selection expands to complete Markdown blocks; a list or table is reviewed as a block.
2. Use the **Comments** tab in the left sidebar (beside Notebook and Outlines, or **⌘/Ctrl+3**) to navigate comment cards, reply, edit, resolve, reopen, delete, or reattach a thread. Enabling Review Mode or opening a passage's comment reveals this panel automatically. Comments autosave as Libera metadata and stay out of the Markdown file.
3. Choose **Agentic review** in the Comments panel. Select the open comments to address, attach Markdown references with **@**, and choose **Plan review**. The model receives the full current draft, including unsaved changes. The same sidebar button toggles back to regular chat; the AI panel has no duplicate mode-switch buttons.
4. Send follow-up instructions to revise the plan. Choose **Confirm plan & generate changes**, or type **I confirm this plan**. This creates proposals without changing the document.
5. Inspect each original/replacement diff. **Accept** applies that proposal; **Reject** preserves the original text; **Request revision** asks for a replacement proposal. Linked edits are shown together and accepted as a group. You can also say **Accept change 2**, **Reject changes 1 and 3**, or **Accept all remaining**.
6. **Undo acceptance** reverses the most recent accepted change or batch. Independent rejections remain recorded. Use normal **Save** when ready; pending and rejected suggestions are never written to the file.

Use the **+** button in the Agentic review header to start a new round. It keeps the current draft and all comments, archives the earlier plan and decisions under **Previous rounds**, and opens a fresh composer with open comments selected. Attach references again for the new round. No model request is sent until you choose **Plan review**. Acceptance undo/redo applies within a round; earlier proposals are read-only in history.

Editing a passage while its proposal is pending can cause a conflict. Request a revision instead of applying outdated text. Changes to plan inputs require a new plan confirmation. Missing or ambiguous comment passages remain in the comments list with their original quotes and can be reattached to a new selection.

Review history is stored locally under `.libera/markdown-reviews.json` in the Libera user-data directory. File and folder moves preserve it. Copying only a Markdown file to another app does not copy comments. The AI panel provides recovery for unsaved review drafts; reopening a saved file never automatically replaces it with a different review snapshot.

AI review uses the configured Chat model and OpenRouter connection from AI preferences. It checks context capacity before sending the complete review. Large targets or attachments may require a model with a larger context or fewer references. Cancelled, malformed, or invalid generation does not partially apply changes.

## Validation

The implementation passes 94 editor/API tests, TypeScript checking through the production build, and the Next.js production build. ESLint reports no errors and one pre-existing `refreshTree` hook-dependency warning in the workspace controller. Browser checks exercised manual comments in both editors, individual acceptance/rejection, mode switching, and undo using isolated local fixtures. The automated test suite mocks model requests for deterministic plan/revision/validation checks, including starting new rounds without losing accepted text or earlier comment outcomes.

### Opt-in live API check

Run `node --import tsx scripts/editor/review-live.ts` to test the configured model with real API requests. This incurs provider usage. The script loads local environment settings, uses synthetic Markdown and an `@` reference, and isolates review metadata in a temporary directory that it removes afterward. It checks planning, plan revision, confirmed proposal generation, individual proposal revision, acceptance/rejection, undo/redo, and persistence. It never prints credentials or edits existing notebooks.

To use the desktop application's saved key and Chat model instead of the project's environment settings, append `--config "/absolute/path/to/libera-electron-config.json"`. This only changes settings inside the test process. The live script is excluded from `test:editor` so ordinary tests never make paid calls.

Live validation on September 11, 2026 passed using the desktop-configured `deepseek/deepseek-v4.1-flash` through OpenRouter. Four successful completions covered the initial plan, revised plan, two independent proposals, and revision of one proposal while preserving the other. Assertions verified full draft/reference delivery, no draft mutation before acceptance, independent acceptance/rejection, preservation of unrelated text, comment outcomes, undo/redo, and persisted state. Provider-reported usage was 7,864 tokens and $0.003058846 total. Stage durations were approximately 166, 60, 13, and 14 seconds; the first response approached the existing 180-second request timeout. The project's environment credential was rejected with “User not found”; the separately saved desktop credential worked. No credentials or notebook files were changed.
