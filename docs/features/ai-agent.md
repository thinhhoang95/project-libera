# AI Agent

The AI panel has two modes, switched at the top of the panel:

- **Chat** talks through the open document and anything you attach, as before.
- **Agent** works on your library itself. It searches, reads the files it needs, and, when allowed, edits them. Its steps appear in the conversation as it works.

The mode is saved with each chat; new chats start in the mode you used last.

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
- **TaskCreate** and **TaskUpdate** keep a task list for multi-step jobs, shown in the reply.
- **Skill** loads a skill (see below).
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

Saved comments become ordinary review comments in the Comments panel, marked **Agent**, so you can reply, resolve, or have Agentic Review address them. Review mode is turned on for that document so they are highlighted, and if it is the document you are viewing, the Comments panel opens. The reply lists the files that got comments.

### Suggested edits

Skills can propose concrete rewrites without changing a file. **SuggestEdit** (path, before, after, reason, and an optional comment) records a suggested edit: `before` must occur exactly once in the current text (with Edit's forgiving matching) and lie within one paragraph or block, or cover whole blocks. Like LeaveComment it never writes the file, so it works in every permission mode, including Read Only, and it is not available in shared notebooks yet.

When the agent finishes its reply, each suggestion is saved in the document's review as a pending **agent suggestion** (with the optional comment as a linked Agent comment), review mode is turned on, and the reply lists the files that got suggestions. If the document is open, its review reloads and the Comments panel opens.

- Both editors preview pending suggestions as proposed changes, the way Agentic Review shows its changes; the source editor highlights the passage.
- The Comments panel lists them as **Edit 1, 2…** marked **Agent**, with the count next to the comment count, and **Accept**, **Reject** and **Request revision** (plus **Accept all** and **Reject all** when several are pending).
- **Accept** applies the change to the editor as one undoable step; undo takes back the text and the decision together. **Reject** records the decision.
- **Request revision** adds a comment thread on the passage that quotes the suggestion and your request, so the agent (or Agentic Review) can follow up. The suggestion stays open.
- A suggestion follows its passage as you edit. If the passage itself changes, it is marked "text changed" and can only be rejected; it becomes pending again if the passage comes back.

The leave-review-comments skill offers SuggestEdit for clear, local fixes. Other skills reuse it: `suggestEditTool` and `finishSuggestedEdits` are exported from `src/lib/agent/suggest-edit.ts`; a skill lists the tool and calls the helper from its `finishPass`.

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

In a shared notebook every file is a working copy of a shared document, so the agent never writes it directly. Its changes go through Libera's collaboration service, as the user's edits, attributed to **AI on behalf of you** with the run and model (provenance `ai:agent`), and collaborators see them at once.

- **Permissions.** "Modify opened files only" works: the agent changes the shared files you have open and cannot create files there. "Modify all files in Notebook/Folder" is refused for a shared notebook until agent edits become suggestions; the run does not start, and asks you to switch to "Modify opened files only" or Read Only. Read Only is unchanged.
- **Roles.** Viewers and commenters cannot edit a shared document, so neither can the agent: Edit and Write answer that your role cannot edit the file, and the agent describes the change instead.
- **Reading.** Read and Edit work on the shared document's live text from the collaboration service, not the working copy on disk or the tab's copy, which may lag. If a collaborator changed the file since the agent read it, the edit is refused and the agent reads it again.
- **Tabs and undo.** Open tabs get the agent's edits from the shared document itself, so the panel does not reload them from disk. **Undo** sends the inverse edits through the collaboration service while the document still holds exactly what the agent wrote; after anyone else's edit it is reported as a conflict and left alone.
- **AGENT_NOTES.md** in a shared notebook may have been written by collaborators. It is given to the agent as untrusted guidance for style and conventions only; it cannot widen what the agent may change.
- **Review comments** (the leave-review-comments skill) are not available for shared documents yet: they are stored only on this computer, so collaborators would not see them. The skill says so, and its tool is not offered.
- **Collaboration off or not running.** Changes to shared files fail with a clear message, and nothing is written to disk.

The same rules cover Libera's other writers: "Convert PDF to Markdown" creates the Markdown file through the collaboration service and adds each page as an edit (provenance `ai:image-to-markdown`); uploads, pasted Markdown images, edited image copies and generated images saved to a notebook folder become shared files of the notebook. Document chat reads a shared document's attached text from the collaboration service. The helpers are in `src/lib/collab/shared-writes.ts`; the tests are `scripts/collab/ai-shared-writes.test.ts` (against a fake control API) and `scripts/collab/ai-host-e2e.test.ts` (the real host and server).

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

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/agent-tools.test.ts scripts/editor/agent-route.test.ts scripts/editor/agent-chat-panel.test.ts scripts/editor/agent-skills.test.ts scripts/editor/references-agent-*.test.ts`

These cover skills (loading on demand, comment syntax and placement, feedback to the model, saving review threads), the path sandbox, every tool and its error messages, PDF reading and search, permissions, undo with drafts and conflicts, the loop's handling of malformed and cut-off tool calls, repeated calls, open tasks and stopping, parameter routing, and the panel's requests, activity view, tab syncing and undo. The `references-agent-*` tests cover child runs (isolation, concurrency, structured results, budget, stop, events and usage), WebSearch (mocked completions, fallback, when it is offered, the route and the panel toggle), and suggested edits (matching, the finish pass, remapping, decisions, the review route, and both editors and the Comments panel).
