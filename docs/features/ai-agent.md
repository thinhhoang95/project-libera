# AI Agent

The AI panel has two modes, switched at the top of the panel:

- **Chat** talks through the open document and anything you attach, as before.
- **Agent** works on your library itself. It searches, reads the files it needs, and, when allowed, edits them. Its steps appear in the conversation as it works.

The mode is saved with each chat; new chats start in the mode you used last.

## Saving conversations

Chat and Agent save history when a message is sent (including an edit or regeneration), and when the response completes, is stopped, or fails. Creating, switching, branching, renaming, or deleting conversations, changing their settings or attachments, and undoing agent changes also save history. Unchanged snapshots are skipped.

Typing in the composer, incoming tokens, tool activity, and token-usage updates stay in memory; there are no periodic history checkpoints. Closing or reloading the app flushes the latest draft and partial response. A crash or forced termination can lose changes since the last save event. Panel size and visibility are saved separately when you resize or toggle the panel.

## Permissions

In Agent mode, the picker next to the switch sets what the agent may change:

| Permission | Reads and searches | Changes |
| --- | --- | --- |
| Read Only | The whole library | Nothing. Proposed changes come back as text. |
| Modify opened files only | The whole library | Text files open in editor tabs. It cannot create files. |
| Modify all files in Notebook/Folder | The whole library | Any text file in the current notebook or linked folder, including new ones. |

Next to the picker, **Allow web search** lets the agent look things up on the web (see WebSearch below). It is off by default, remembered like the mode, and sent with each request; the line above the composer says "Web search on" while it is.

The current notebook is the one holding the file you are viewing, or the notebook selected in the sidebar. The system prompt and the tools the model receives match the permission: in Read Only the agent has no editing tools at all, and every write is checked again on the server.

Only Markdown, LaTeX and plain-text files can be written. Hidden folders, `_assets` and `_archive` are never written, and paths are resolved through symlinks so nothing outside the notebook can be reached.

## What the agent knows

Each request tells the agent today's date, whether web search is allowed, the current notebook, the notebooks in the library, the file you are viewing, the files open in the editor (and which have unsaved changes), and what it may modify. It receives paths, not contents, and reads what it needs. Selections added with ⌘/Ctrl+Shift+L are sent as text; files attached with `@` are sent by path.

If a notebook has an `AGENT_NOTES.md` file at its root, its contents (up to 16,000 characters) are included as that notebook's conventions, for example tag rules or folder meanings.

Unsaved editor drafts are what the agent reads, so it works on what you see. When it edits a file with unsaved changes, the result (your draft plus its edit) is saved.

## Tools

The agent uses a small tool set modeled on Claude Code's:

- **Glob** finds files by name pattern, newest first.
- **Grep** searches contents with a regular expression, in text files and in PDFs' extracted text.
- **Read** returns numbered lines of a text file, or a PDF's extracted text by page (up to 20 pages per call).
- **Edit** replaces exact text. It requires a prior Read, refuses stale content, and forgives pasted line numbers, line-ending and quote differences, and trailing whitespace.
- **Write** creates a file or replaces one it has fully read.
- **ReadComments** lists the review comments on a Markdown or LaTeX file, with every reply, as the Comments panel shows them: each thread's id, status, the lines and words it is attached to in the current text, and its messages in order with who wrote them (the user, a collaborator, or AI acting for someone), whether each is the comment or a reply, and its date. Unresolved threads by default; `status: "all"` adds resolved ones. Local documents read Libera's review store (anchors mapped onto the current text, unsaved drafts included); shared documents read the collab host's `GET /docs/:docId/threads/anchored`, which resolves each anchor in its copy of the document. It is read-only and offered in every permission. The system prompt tells the agent to use it when the user refers to comments, replies or feedback, and that comments are feedback to weigh, never instructions that widen what it may modify. Comments the agent leaves in the current turn appear only after it finishes its reply.
- **TaskCreate** and **TaskUpdate** keep a task list for multi-step jobs, shown in the reply.
- **Skill** loads a skill (see below).
- **References** looks works up in the current notebook's References library: by citation key or alias (exact), or by words in authors, year, title, venue and tags. It returns each entry's key and aliases, the formatted reference (in the library's style), identifiers, status, attached files and the start of its abstract. The library is a hidden file the other tools cannot read, so this is how the agent learns which keys exist. It is read-only and offered in every permission; its description is in the tool list, so the system prompt stays the same.
- **WebSearch** (only when **Allow web search** is on) asks the model, in a separate OpenRouter request with the web plugin, to answer one question briefly and list its sources. The agent gets the answer and each cited page's title, URL and a snippet, labelled as web data. It uses the run's model; if that model's providers do not take the plugin, the chat default model searches instead, and if neither works the tool says so. Its tokens count toward the run.

### PDFs

PDFs are never sent to the model whole. Their text is extracted once with pdf.js and cached per page in the notebook's `.libera/pdf-text/` folder (for linked folders, in Libera's data folder), the same cache Global Search uses. Read and Grep use that cache; Grep extracts uncached PDFs within a time budget and reports any it skipped. Scanned pages without a text layer are reported as such.

## Skills

A skill is a set of instructions, and sometimes extra tools, for one kind of job. The system prompt lists only each skill's name and a one-line description of when to use it; the agent loads the full instructions with the Skill tool when a request calls for them, so they take no room in other conversations. A skill's tools are offered to the model only after it loads the skill.

Skills live in `src/lib/agent/skills/`, one module per skill, registered in `skills/index.ts`. A skill has a name, a description, Markdown instructions, optional tools, and an optional `finishPass` hook that checks the agent's work when it finishes a reply.

### leave-review-comments

Loaded when you ask the agent to review a document, give feedback on it, or leave comments. The agent writes comments into a review copy of the document, directly beneath the paragraphs they are about:

```markdown
The Q3 budget is 40k, up from 25k last year.

:::comment
This contradicts the 35k in the summary table. Which figure is right?
:::
```

It does this with **LeaveComment**, which works like Edit but only on the review copy: the file itself never changes, so reviews work in every permission mode, including Read Only. Anything other than comment blocks must stay as it is; a call that changes the document's text is refused and changes nothing. Markdown and LaTeX files can be commented on.

When the agent finishes its reply, Libera compiles each review copy. Every comment is attached to the block directly above it: a paragraph, heading, list item, table, code or math block. A comment inside a paragraph, table, code or math block, or with nothing above it, is sent back to the agent with what is wrong and where, and the agent fixes it with LeaveComment. After three rounds, or when a run ends early, comments that are placed are saved and the rest are listed in the run's activity with their text.

Saved comments become ordinary review comments in the Comments panel, marked **Agent** (on a shared document, shared threads marked **AI · requested by** you; see Shared notebooks), so you can reply, resolve, or have Agentic Review address them. Review mode is turned on for that document so they are highlighted, and if it is the document you are viewing, the Comments panel opens. The reply lists the files that got comments.

### Suggested edits

Skills can propose concrete rewrites without changing a file. **SuggestEdit** (path, before, after, reason, and an optional comment) records a suggested edit: `before` must occur exactly once in the current text (with Edit's forgiving matching) and lie within one paragraph or block, or cover whole blocks. Like LeaveComment it never writes the file, so it works in every permission mode, including Read Only, and it is not available in shared notebooks yet.

When the agent finishes its reply, each suggestion is saved in the document's review as a pending **agent suggestion** (with the optional comment as a linked Agent comment), review mode is turned on, and the reply lists the files that got suggestions. If the document is open, its review reloads and the Comments panel opens.

- Both editors preview pending suggestions as proposed changes, the way Agentic Review shows its changes; the source editor highlights the passage.
- The Comments panel lists them as **Edit 1, 2…** marked **Agent**, with the count next to the comment count, and **Accept**, **Reject** and **Request revision** (plus **Accept all** and **Reject all** when several are pending).
- **Accept** applies the change to the editor as one undoable step; undo takes back the text and the decision together. **Reject** records the decision.
- **Request revision** adds a comment thread on the passage that quotes the suggestion and your request, so the agent (or Agentic Review) can follow up. The suggestion stays open.
- A suggestion follows its passage as you edit. If the passage itself changes, it is marked "text changed" and can only be rejected; it becomes pending again if the passage comes back.

The leave-review-comments skill offers SuggestEdit for clear, local fixes. Other skills reuse it: `suggestEditTool` and `finishSuggestedEdits` are exported from `src/lib/agent/suggest-edit.ts`; a skill lists the tool and calls the helper from its `finishPass`.

### fact-check-citations

Loaded when you ask the agent to fact-check a document, verify its citations or check its sources. **Fact-check citations** starts it too: a button in both Markdown editors' toolbars (off when the document has no citations) and in the References panel. The button opens the AI panel, starts a new Agent chat, sets web search as the request says, and sends "Fact-check the citations in <path>." with the skill preloaded: the agent route's `skill` field adds the skill's instructions to that request and offers its tools from the first turn. Like leave-review-comments, the skill never edits the document, so it works in Read Only. It is not available in shared notebooks.

- **ListCitations(path)** parses the document (its unsaved draft when open, with the configured math markers) and lists each occurrence `c1`, `c2`… with:
  - its claim: the sentence (at most 600 characters) and its block (at most 1,500);
  - the cited works, with their formatted reference, status and attached files (PDF page counts from the text cache);
  - static problems: unknown key, entry without a readable attachment, locator out of range, unresolved entry, retracted or withdrawn entry.

  Locators are printed page numbers. When the entry's CSL `page` gives the work's range (say 340–351), printed page p is PDF page p − 340 + 1, assuming the PDF starts at the work's first page. A locator is flagged only when it is neither a printed page in that range nor a page of the PDF.
- **CheckCitations(path, occurrences?, missingReferences?)** fans out to checker subagents:
  - **Batches.** Occurrences are grouped by cited work; an occurrence citing several works joins each work's group. Groups are packed into batches of at most three works, or two when any of them has a PDF over 150 pages. Each batch is one child run (four at a time, 15 turns, 5 minutes) that reads each source once and checks every claim citing it.
  - **Read scope.** The child's Read, Grep and Glob are wrappers: only the batch's attached files and the document can be read, and any other path is refused with the list of allowed files. Grep without a path searches each allowed file; Glob lists only allowed files. WebSearch is added when the run allows it.
  - **Verdicts.** The child finishes with **SubmitVerdicts**, a strict schema with one repair round: one verdict per occurrence and work (`supported`, `partially-supported`, `not-supported`, `contradicted`, `cannot-verify` or `source-missing`), evidence `{path, page?, line?, quote}`, web sources `{url, title?, quote}`, a confidence, a note, and optionally `suggestedText` and `suggestedCitation`. Works with no entry, or with no readable file while web search is off, get `source-missing` without a child.
  - **Budget.** Before the children start, the plan (how many subagents, and an input-token estimate against what is left of the run's budget) appears as a step and in the result. Batches that cannot start because the budget is used up are reported as not checked.
- **Evidence verification.** Every quote is looked up in the cited file:
  - PDFs: in the page text from the PDF text cache, on the page given. A quote found on the next or previous page, or across a page break, is kept with its page corrected. Found only on another page, or nowhere, it is dropped.
  - Markdown and text files: anywhere in the file; the line is filled in.
  - Matching ignores case, whitespace, quote and dash variants, ligatures, soft hyphens and words hyphenated across a line break. It then allows small (OCR) differences: the best approximate occurrence must reach a similarity of 0.85 (edit distance against any substring). Quotes under 20 characters must match exactly; a quote with an ellipsis is checked part by part.
  - A verdict that loses all its evidence becomes `cannot-verify`, noted "evidence not found in source".
  - Web quotes count only when their URL is one WebSearch returned as a cited page in that child's run. They are always labelled web evidence.
- **Existence check** (no model). A work with a DOI is looked up at Crossref, then DataCite. A work without one is searched at Crossref and OpenAlex and scored with the resolution matcher (threshold 0.85).
  - A work that does not resolve and has no attached file is a **possibly hallucinated reference**. A source that cannot be reached never makes a work hallucinated.
  - An attached file whose first page does not show the entry's title (similarity below 0.8), or a DOI that belongs to another title, is a **metadata/attachment mismatch**.
  - When online lookups are off in Preferences, the report says "existence not checked (online lookups off)". The attachment comparison still runs.
- **Missing references** (on by default; only when every occurrence is checked). One more child reads the document, picks up to ten factual or quantitative claims without a citation, and Greps the notebook's attached files for support. A claim whose quote is verified gets a suggested edit adding `[@key, p. N]`; otherwise it gets the comment "uncited claim — no source found in this notebook".
- **Output.**
  - A review comment on each occurrence with a problem, quoting the verified evidence with its page.
  - A suggested edit, with that comment linked, where the fix is concrete: a locator naming other pages than the evidence, an overstated claim (the checker's rewording, keeping the citation), or an unknown key one or two edits away from a library key.
  - Comments go into the LeaveComment review copy and suggestions through SuggestEdit. The skill's finish pass runs the review-comment pass, then the suggested-edit pass, so both are saved.
  - The reply carries the report: counts per verdict, sources not found locally, possibly hallucinated references, metadata mismatches, uncited claims, discarded evidence, and occurrences not checked with a "Continue" hint. Asking to continue in the same chat checks only the occurrences the report lists.

The modules are `src/lib/agent/skills/fact-check-citations.ts`, `src/lib/agent/fact-check/` (`list-citations.ts`, `check-citations.ts`, `read-scope.ts`, `verdicts.ts`, `evidence.ts`, `existence.ts`, `report.ts`) and `src/lib/agent/references-tool.ts`.

## Child runs

A tool can hand self-contained jobs to child runs of the agent loop (`runSubagents` in `src/lib/agent/subagents.ts`), for example to check several sources at once. Each child has its own system prompt, prompt, tools and limits (by default 15 turns, 5 minutes and 1 million input tokens), and up to four run at a time.

- **Isolation.** A child starts with a fresh context: no reads, tasks or skills of the parent, Read Only permission and no undo snapshots. It shares the library, the user's open drafts, the stop signal and the run's token budget.
- **Results.** A task can name a submit tool the child must finish by calling. Its arguments are checked against the tool's JSON schema (and by the tool itself); an invalid result goes back to the child for one repair round, and a child that ends without submitting is reminded once. Otherwise the result is the child's final text.
- **Activity.** Each child appears in the run as one line, such as "Checking smith2020, lee2021 · 6 steps · done", which expands to its steps and shows progress while it runs. Its text is not shown, and its tokens are added to the run's total.
- **Budget.** The run and its children share one input-token budget (5 million). Once it is used up, nothing new starts: children not yet started report that the budget ran out, and running ones stop at their next turn. **Stop** ends every child at once.

## Seeing and undoing changes

Each tool call appears as one line, such as "Searching for “budget”" with its result. Lines for edits expand to a diff. Changed files are listed at the end of the reply.

Open tabs follow the agent's edits at once. If you keep typing in a file while the agent changes it, your unsaved version stays in the editor, the agent's version is saved on disk, and the panel says so.

Review comments are not part of a run's undo; delete or resolve them in the Comments panel.

Before the agent first changes a file in a run, Libera keeps the original in `users/admin/.libera/agent-runs/` (the 200 most recent runs, for up to 60 days). **Undo** restores one file or, with **Undo all**, the whole run; files the run created are removed. A file you edited after the agent is left alone and reported. Regenerating or editing an earlier message is blocked while later replies have changes that are not undone.

## Shared notebooks

In a shared notebook every file is a working copy of a shared document, and the agent never edits it, directly or on disk. **Its Edit and Write become suggestions**: overlay suggestions on the shared document with an AI actor acting for you (`{kind: "ai", feature: "agent", onBehalfOf: you, model, runId}`), created through Libera's collaboration service. Collaborators see them at once as **AI · on behalf of you**, inline in their editors and in the Suggestions panel, and the text changes only when someone who may decide (an editor or owner) accepts them. Edits from one tool call are one group, accepted or rejected together.

- **Permissions.** The picker reads differently for a shared notebook:

  | Permission | Changes |
  | --- | --- |
  | Read Only | Nothing, as everywhere. |
  | Suggest in opened files | Suggestions in shared files open in editor tabs. |
  | Suggest in notebook | Suggestions in any shared file of the current notebook, open or not. |

  The modes are the same three ("Suggest in opened files" is "Modify opened files only" elsewhere); the environment tells the agent that its changes in shared notebooks are suggestions. The agent cannot create files in a shared notebook: a new file would need a manifest suggestion, which does not exist yet, so Write of a new path is refused and the agent gives the content in its reply.
- **Tool results.** Edit and Write answer "Suggested a change to … : suggested, pending review" with the suggestion ids, and say that the file's text stays as it was until a suggestion is accepted, so the agent keeps working from the current text and does not repeat the change. The run's activity marks the file **suggested**.
- **Roles.** Suggestions are what commenters may make, so **commenters can use the agent** in shared notebooks. Viewers cannot suggest, so neither can their agent: Edit and Write answer that the role cannot change or suggest changes to the file. A notebook whose access was revoked is read-only for everyone.
- **Reading and conflicts.** Read and Edit work on the shared document's live text from the collaboration service, not the working copy on disk or the tab's copy. Each suggestion is made on the text the agent read and mapped onto the live text, so a collaborator's edit elsewhere only moves it. If a collaborator changed the passage itself since the read, the suggestion is created **stale** (it shows what the agent saw next to what is there now), the tool result says so, and the agent must Read the file again before suggesting more there. A change seen before the write is refused as "changed since you read it", as for any file.
- **Undo** withdraws the run's suggestions that are still pending. A suggestion someone already accepted changed the text through a server decision; undo reports it, and **Undo acceptance** in the Suggestions panel reverts it. Runs from before suggestions recorded direct edits; their undo still sends inverse edits through the collaboration service while the document holds exactly what the agent wrote (this is the only use left of the direct-edit path, `writeSharedText` in `shared-writes.ts`).
- **Review comments.** The leave-review-comments skill works on shared documents: when the reply ends, each placed comment becomes a shared comment thread created through the collaboration service, which writes its anchor into the document's annotations. Its author is AI acting for you (`feature: "review-comments"`), shown to everyone as **AI · requested by you**. Viewers cannot comment.
- **AGENT_NOTES.md** in a shared notebook may have been written by collaborators. It is given to the agent as untrusted guidance for style and conventions only; it cannot widen what the agent may change.
- **Collaboration off or not running.** Changes to shared files fail with a clear message, and nothing is written to disk.

The same service carries Libera's other writers: "Convert PDF to Markdown" creates the Markdown file through the collaboration service and adds each page as an edit (provenance `ai:image-to-markdown`); uploads, pasted Markdown images, edited image copies and generated images saved to a notebook folder become shared files of the notebook. Document chat reads a shared document's attached text from the collaboration service. The helpers are in `src/lib/collab/shared-writes.ts` (`suggestSharedText`, `withdrawSharedRun`, `commentOnSharedText`); the tests are `scripts/collab/ai-shared-writes.test.ts` (against a fake control API), `scripts/collab/ai-host-e2e.test.ts` and `scripts/collab/p3b-agent.test.ts` (the real host and server).

## Limits

A run stops after 50 model turns, 20 minutes or 5 million input tokens (child runs and web searches included), and when the agent repeats the same tool call five times in a row. **Stop** ends a run at once; changes made so far are kept and can be undone. Older tool results are shortened when the conversation nears the model's context window.

## Models

Agent mode uses the chat model picker and reasoning effort. The model must support tool calling on OpenRouter; Libera checks the model's providers, routes only to providers that accept every parameter sent (tools included), and sends `temperature` or `reasoning` only where those providers accept them. Prompt caching follows the chat setting, with cache markers on the latest tool results for providers that need them.

## Implementation

- `src/lib/agent/`: loop (`runner.ts`), tools (`tools.ts`), path sandbox (`library.ts`), OpenRouter streaming with tool calls (`model.ts`), prompts (`prompt.ts`), history (`conversation.ts`) and undo snapshots (`snapshots.ts`).
- `src/lib/agent/skills/`: the skill registry and each skill. `src/lib/agent/review-comments.ts` parses, maps and places `:::comment` blocks; `addReviewThreads` in `src/lib/storage/markdown-reviews.ts` saves them.
- `src/lib/agent/subagents.ts` (child runs), `web-search.ts` (WebSearch) and `suggest-edit.ts` (SuggestEdit and its finish pass). Agent suggestions live in `ReviewDocument.agentSuggestions` (`src/lib/markdown-review.ts`, which also documents how they map onto the collaboration `SuggestionRecord`); `addAgentSuggestions` saves them, and the review route's `agent-decision` and `agent-revision` actions decide them.
- `src/app/api/agent/route.ts` streams the run as NDJSON events; `src/app/api/agent/undo/route.ts` restores files.
- `src/components/libera/agent-activity.tsx` renders a run; `document-chat-panel.tsx` holds the mode switch.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/agent-tools.test.ts scripts/editor/agent-route.test.ts scripts/editor/agent-chat-panel.test.ts scripts/editor/agent-skills.test.ts scripts/editor/references-agent-*.test.ts scripts/editor/references-factcheck*.test.ts`

These cover skills (loading on demand, comment syntax and placement, feedback to the model, saving review threads), the path sandbox, every tool and its error messages, PDF reading and search, permissions, undo with drafts and conflicts, the loop's handling of malformed and cut-off tool calls, repeated calls, open tasks and stopping, parameter routing, and the panel's requests, activity view, tab syncing and undo. The `references-agent-*` tests cover child runs (isolation, concurrency, structured results, budget, stop, events and usage), WebSearch (mocked completions, fallback, when it is offered, the route and the panel toggle), and suggested edits (matching, the finish pass, remapping, decisions, the review route, and both editors and the Comments panel). The `references-factcheck*` tests cover the References tool, ListCitations, batching, the read scope, SubmitVerdicts, evidence verification, the existence check, budget exhaustion and Continue, missing references, an end-to-end Read Only run over a document with planted errors, the route's skill preload, the panel's fact-check request and the toolbar button.
