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

The current notebook is the one holding the file you are viewing, or the notebook selected in the sidebar. The system prompt and the tools the model receives match the permission: in Read Only the agent has no editing tools at all, and every write is checked again on the server.

Only Markdown, LaTeX and plain-text files can be written. Hidden folders, `_assets` and `_archive` are never written, and paths are resolved through symlinks so nothing outside the notebook can be reached.

## What the agent knows

Each request tells the agent today's date, the current notebook, the notebooks in the library, the file you are viewing, the files open in the editor (and which have unsaved changes), and what it may modify. It receives paths, not contents, and reads what it needs. Selections added with ⌘/Ctrl+Shift+L are sent as text; files attached with `@` are sent by path.

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

## Seeing and undoing changes

Each tool call appears as one line, such as "Searching for “budget”" with its result. Lines for edits expand to a diff. Changed files are listed at the end of the reply.

Open tabs follow the agent's edits at once. If you keep typing in a file while the agent changes it, your unsaved version stays in the editor, the agent's version is saved on disk, and the panel says so.

Review comments are not part of a run's undo; delete or resolve them in the Comments panel.

Before the agent first changes a file in a run, Libera keeps the original in `users/admin/.libera/agent-runs/` (the 200 most recent runs, for up to 60 days). **Undo** restores one file or, with **Undo all**, the whole run; files the run created are removed. A file you edited after the agent is left alone and reported. Regenerating or editing an earlier message is blocked while later replies have changes that are not undone.

## Limits

A run stops after 50 model turns, 20 minutes or 5 million input tokens, and when the agent repeats the same tool call five times in a row. **Stop** ends a run at once; changes made so far are kept and can be undone. Older tool results are shortened when the conversation nears the model's context window.

## Models

Agent mode uses the chat model picker and reasoning effort. The model must support tool calling on OpenRouter; Libera checks the model's providers, routes only to providers that accept every parameter sent (tools included), and sends `temperature` or `reasoning` only where those providers accept them. Prompt caching follows the chat setting, with cache markers on the latest tool results for providers that need them.

## Implementation

- `src/lib/agent/`: loop (`runner.ts`), tools (`tools.ts`), path sandbox (`library.ts`), OpenRouter streaming with tool calls (`model.ts`), prompts (`prompt.ts`), history (`conversation.ts`) and undo snapshots (`snapshots.ts`).
- `src/lib/agent/skills/`: the skill registry and each skill. `src/lib/agent/review-comments.ts` parses, maps and places `:::comment` blocks; `addReviewThreads` in `src/lib/storage/markdown-reviews.ts` saves them.
- `src/app/api/agent/route.ts` streams the run as NDJSON events; `src/app/api/agent/undo/route.ts` restores files.
- `src/components/libera/agent-activity.tsx` renders a run; `document-chat-panel.tsx` holds the mode switch.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/agent-tools.test.ts scripts/editor/agent-route.test.ts scripts/editor/agent-chat-panel.test.ts scripts/editor/agent-skills.test.ts`

These cover skills (loading on demand, comment syntax and placement, feedback to the model, saving review threads), the path sandbox, every tool and its error messages, PDF reading and search, permissions, undo with drafts and conflicts, the loop's handling of malformed and cut-off tool calls, repeated calls, open tasks and stopping, parameter routing, and the panel's requests, activity view, tab syncing and undo.
