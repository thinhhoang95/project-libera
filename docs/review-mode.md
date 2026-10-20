# Using Review Mode

Open a Markdown file and click the comment icon beside Save. Review Mode works in both Visual and Source modes.

1. Select a passage, then choose **Add comment** in the floating passage panel. You can also press **⌘/Ctrl+Alt+M** at the current paragraph. The highlighted selection expands to complete Markdown blocks; a list or table is reviewed as a block.
2. Use the **Comments** tab in the left sidebar (beside Notebook and Outlines, or **⌘/Ctrl+3**) to navigate comment cards, reply, edit, resolve, reopen, delete, or reattach a thread. Enabling Review Mode or opening a passage's comment reveals this panel automatically. Comments autosave as Libera metadata and stay out of the Markdown file.
3. Choose **Agentic review** in the Comments panel. Select the open comments to address, attach Markdown references with **@**, and choose **Plan review**. The model receives the full current draft, including unsaved changes. The same sidebar button toggles back to regular chat; the AI panel has no duplicate mode-switch buttons.
   The plan reads each selected thread whole: the comment and every reply in order, with who wrote each (on shared documents, collaborators' names, and "AI for …" for AI actors). Not every comment is an edit request. A step (an edit) is planned only when the thread asks for or clearly implies a change to the text, including a fix agreed in a reply. Questions the text or references answer, praise, notes, requests a later reply withdrew or rejected, and problems already fixed get a disposition instead, listed under **No edit needed** with the reason (and, for a question, the answer when the model can give it). A request in your own message that explicitly asks for an edit on a comment overrides this.
4. Send follow-up instructions to revise the plan. Choose **Confirm plan & generate changes**, or type **I confirm this plan**. This creates proposals without changing the document, only for the plan's steps: a proposal for a comment the plan settled with a disposition is refused. When the plan has no steps the button reads **Confirm plan (no edits)** and completes the round without another model request.
5. Inspect each original/replacement diff. **Accept** applies that proposal; **Reject** preserves the original text; **Request revision** asks for a replacement proposal. Linked edits are shown together and accepted as a group. You can also say **Accept change 2**, **Reject changes 1 and 3**, or **Accept all remaining**.
6. **Undo acceptance** reverses the most recent accepted change or batch. Independent rejections remain recorded. Use normal **Save** when ready; pending and rejected suggestions are never written to the file.

Use the **+** button in the Agentic review header to start a new round. It keeps the current draft and all comments, archives the earlier plan and decisions under **Previous rounds**, and opens a fresh composer with open comments selected. Attach references again for the new round. No model request is sent until you choose **Plan review**. Acceptance undo/redo applies within a round; earlier proposals are read-only in history.

Editing a passage while its proposal is pending can cause a conflict. Request a revision instead of applying outdated text. Changes to plan inputs require a new plan confirmation. Missing or ambiguous comment passages remain in the comments list with their original quotes and can be reattached to a new selection.

Review history is stored locally under `.libera/markdown-reviews.json` in the Libera user-data directory. File and folder moves preserve it. Copying only a Markdown file to another app does not copy comments. The AI panel provides recovery for unsaved review drafts; reopening a saved file never automatically replaces it with a different review snapshot.

AI review uses the configured Chat model and OpenRouter connection from AI preferences. It checks context capacity before sending the complete review. Large targets or attachments may require a model with a larger context or fewer references. Cancelled, malformed, or invalid generation does not partially apply changes.

## Review comments on PDFs

Open a PDF, select text on a page and choose **Add comment** (the speech-bubble button in the floating selection menu, or **⌘/Ctrl+Alt+M**). Write the comment in the box that opens beside the passage; **⌘/Ctrl+Enter** saves it and **Esc** cancels. A selection that runs over several pages is one comment.

- Commented passages are washed in amber with a dotted rule and a numbered badge at their end. Clicking the passage or the badge opens its card in the **Comments** tab; choosing a card scrolls the PDF to its passage. The comment button in the PDF toolbar shows how many are open and opens the tab.
- Cards are numbered in reading order (page, then down the page) and show the page and the quoted text. Reply, edit your own messages, resolve, reopen and delete as on a Markdown document. Resolved comments leave the page until their card is opened. Search covers the page ("page 3"), the passage and every message.
- The AI agent reads a PDF's comments with ReadComments and replies to them with ReplyToComment; its replies show as **Agent**. It never starts comments on a PDF. See [the AI agent](features/ai-agent.md#review-comments-on-pdfs).
- Comments are outside the PDF viewer's undo, like comments on Markdown documents, and are never written into the PDF itself or into annotated exports.
- They are stored in the PDF's annotation sidecar (`.libera/annotations/pdf/by-path/<path>.json`, under `comments`) beside its highlights and notes, so renaming, moving, copying, archiving and deleting the PDF or its folders carry them exactly as they carry its markup, and a synced notebook carries them to other computers. A copy's comments are its own. Each change rewrites one thread under a lock on the sidecar, so saving markup in the viewer and the agent replying never overwrite each other. In a shared notebook, PDF comments stay with the PDF's other annotations on this computer; they are not collaboration-server threads.

Agentic review, suggested edits and **Request review…** are for Markdown and LaTeX documents only.

## Shared documents

In a shared notebook, Review Mode works the same way, but comments, suggestions and reviews are shared with everyone in the notebook.

### Comments

- Comments are threads on the collaboration server. Their anchors live in the document itself (as Yjs positions in its annotations), so they follow everyone's edits without remapping. Each card shows its author with their colour; comments left by AI show **AI · requested by** the person it acted for.
- Type **@** in a comment to mention a member; they are notified. Comments made offline wait in a queue with a **pending** chip and are sent when the connection returns; a refused one offers Retry and Discard.
- When the commented text is deleted the thread is **detached**. Reattach it to a selection, or to the similar text Libera finds.
- The **Suggestions** and **Reviews** tabs sit beside **Comments** in the rail.

### Suggestions

- Collaborators' proposed changes show inline in every editor and in the **Suggestions** tab: what they replace, by whom (AI marked), and whether the text changed since (**stale**). Editors and owners **Accept** or **Reject**, one group at a time or all at once (a checkpoint is saved first). Accepting is a server decision, so two people deciding at once cannot apply a change twice; offline decisions are queued.
- Commenters always suggest; editors switch **Suggesting** on in Source and LaTeX, or use **Suggest edit** on a selection in Visual. Authors can edit or withdraw their own pending suggestions.
- **Reply** on a suggestion opens a box on its card; the reply is a comment thread on the suggestion's text (its paragraph, for a pure insertion), linked to the suggestion so the server lists the thread as one it addresses.

### Agentic review on a shared document

- The plan addresses the document's shared comments. The plan conversation stays private: it is kept in your local review history and nobody else sees it.
- **Confirm plan & generate changes** turns each proposal into a suggestion group that collaborators see as **AI · on behalf of** you, with the proposal's title and reason and the comments it addresses. Linked edits in one proposal are one group. A proposal whose passage someone changed while it was being generated is created **stale**, showing what the AI saw.
- **Accept** and **Reject** in the review chat and on the cards are server decisions on those groups, the same as in the Suggestions tab, so you must be an editor or owner (a commenter's proposals wait for an editor). The cards show each group's status as decided by anyone. A decided proposal cannot be reopened; ask for a revision.
- **Request revision** withdraws the proposal's group and creates the revised one.

### Reviews

- **Request review…** in the tab bar (editors and owners) asks members to review the whole document or the passage selected in the editor. The passage is anchored like a comment, so it follows edits. Add an optional note, and optionally **Run AI review first**, which starts agentic review as you on the open comments.
- The **Reviews** tab lists the document's reviews: who asked, the scope and note, each reviewer's decision, how many changes in scope since the review started, and **Close review** for the requester and editors.
- Reviewers **Approve** or **Request changes**. A decision is bound to the revision the reviewer read; when the reviewed text changes afterwards it is marked **outdated** ("changed since you approved"), while edits outside the passage leave it current. Decisions made offline are queued and sent on reconnect.
- **Open review** (also from a review notification) shows the review in checkpoint mode: the document frozen as it was when the review was requested, a banner with **N changes since this revision**, and **Show changes since** for a diff to the live text, while everyone keeps editing. Decisions made there are bound to that revision.
- Owners see every decision, review and restore in **Activity log** in the notebook's sharing dialog, filterable by kind.

## Validation

The implementation passes 94 editor/API tests, TypeScript checking through the production build, and the Next.js production build. ESLint reports no errors and one pre-existing `refreshTree` hook-dependency warning in the workspace controller. Browser checks exercised manual comments in both editors, individual acceptance/rejection, mode switching, and undo using isolated local fixtures. The automated test suite mocks model requests for deterministic plan/revision/validation checks, including starting new rounds without losing accepted text or earlier comment outcomes.

### Opt-in live API check

Run `node --import tsx scripts/editor/review-live.ts` to test the configured model with real API requests. This incurs provider usage. The script loads local environment settings, uses synthetic Markdown and an `@` reference, and isolates review metadata in a temporary directory that it removes afterward. It checks planning, plan revision, confirmed proposal generation, individual proposal revision, acceptance/rejection, undo/redo, and persistence. It never prints credentials or edits existing notebooks.

To use the desktop application's saved key and Chat model instead of the project's environment settings, append `--config "/absolute/path/to/libera-electron-config.json"`. This only changes settings inside the test process. The live script is excluded from `test:editor` so ordinary tests never make paid calls.

Live validation on September 11, 2026 passed using the desktop-configured `deepseek/deepseek-v4.1-flash` through OpenRouter. Four successful completions covered the initial plan, revised plan, two independent proposals, and revision of one proposal while preserving the other. Assertions verified full draft/reference delivery, no draft mutation before acceptance, independent acceptance/rejection, preservation of unrelated text, comment outcomes, undo/redo, and persisted state. Provider-reported usage was 7,864 tokens and $0.003058846 total. Stage durations were approximately 166, 60, 13, and 14 seconds; the first response approached the existing 180-second request timeout. The project's environment credential was rejected with “User not found”; the separately saved desktop credential worked. No credentials or notebook files were changed.
