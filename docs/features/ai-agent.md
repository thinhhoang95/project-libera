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

### PDFs

PDFs are never sent to the model whole. Their text is extracted once with pdf.js and cached per page in the notebook's `.libera/pdf-text/` folder (for linked folders, in Libera's data folder), the same cache Global Search uses. Read and Grep use that cache; Grep extracts uncached PDFs within a time budget and reports any it skipped. Scanned pages without a text layer are reported as such.

## Seeing and undoing changes

Each tool call appears as one line, such as "Searching for “budget”" with its result. Lines for edits expand to a diff. Changed files are listed at the end of the reply.

Open tabs follow the agent's edits at once. If you keep typing in a file while the agent changes it, your unsaved version stays in the editor, the agent's version is saved on disk, and the panel says so.

Before the agent first changes a file in a run, Libera keeps the original in `users/admin/.libera/agent-runs/` (the 200 most recent runs, for up to 60 days). **Undo** restores one file or, with **Undo all**, the whole run; files the run created are removed. A file you edited after the agent is left alone and reported. Regenerating or editing an earlier message is blocked while later replies have changes that are not undone.

## Limits

A run stops after 50 model turns, 20 minutes or 5 million input tokens, and when the agent repeats the same tool call five times in a row. **Stop** ends a run at once; changes made so far are kept and can be undone. Older tool results are shortened when the conversation nears the model's context window.

## Models

Agent mode uses the chat model picker and reasoning effort. The model must support tool calling on OpenRouter; Libera checks the model's providers, routes only to providers that accept every parameter sent (tools included), and sends `temperature` or `reasoning` only where those providers accept them. Prompt caching follows the chat setting, with cache markers on the latest tool results for providers that need them.

## Implementation

- `src/lib/agent/`: loop (`runner.ts`), tools (`tools.ts`), path sandbox (`library.ts`), OpenRouter streaming with tool calls (`model.ts`), prompts (`prompt.ts`), history (`conversation.ts`) and undo snapshots (`snapshots.ts`).
- `src/app/api/agent/route.ts` streams the run as NDJSON events; `src/app/api/agent/undo/route.ts` restores files.
- `src/components/libera/agent-activity.tsx` renders a run; `document-chat-panel.tsx` holds the mode switch.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/agent-tools.test.ts scripts/editor/agent-route.test.ts scripts/editor/agent-chat-panel.test.ts`

These cover the path sandbox, every tool and its error messages, PDF reading and search, permissions, undo with drafts and conflicts, the loop's handling of malformed and cut-off tool calls, repeated calls, open tasks and stopping, parameter routing, and the panel's requests, activity view, tab syncing and undo.
