# Where Was I

Come back to a notebook and see where you left off. Each notebook's home opens with a **Where you left off** card that recaps your last session there and lists what changed since.

## Using it

Open a notebook (with no file tab active) to see its home. The card sits above the notebook's statistics and shows:

- **A short recap.** Two to four bullet points, written by an AI model, about what you did in the notebook during your last session: what you drafted, rewrote, or reviewed.
- **The files that session touched**, edited files first, then new ones, then viewed ones. Each is marked **Edited**, **New**, **Viewed**, or **Collaborators** (changed only by others in a shared notebook). **New** covers notes you created and files that arrived without being opened, such as uploads, saved recordings, or files the AI Agent wrote. Hover over a file to see a short excerpt of the change, and click any file to open it.
- **Changed since you left.** Files added or changed after your session ended: a collaborator's edits in a shared notebook, files from another computer in a synced folder, or files another program added or edited. Files added since are marked **New**. Files you have already opened in this session are left out.

The header gives when the session ended, how long it lasted, how many files you edited, and, if it was recorded on another computer, which one.

Some details:

- The card appears once a notebook has a finished session. A notebook you have not worked in since installing this version shows no card.
- The session in progress never replaces the recap. While you work, the card keeps describing your previous session; your current one becomes "where you left off" after you quit.
- **×** hides the card for that notebook until Libera restarts.
- While the recap is being written, the card shows a placeholder for a few seconds. If it fails, the card says so and offers **Try again**. The file list is shown either way.

## Settings

**Preferences → AI → Where Was I**:

| Setting | Default | What it does |
| --- | --- | --- |
| Show where you left off on notebook homes | On | Off hides the card and stops recording sessions. |
| Summarize the last session with AI | On | Off keeps the card and file lists but sends nothing to a model. |
| Model | `deepseek/deepseek-v4.1-flash` | Any OpenRouter model. A small, inexpensive one is enough. |
| Reasoning effort | Low | |

Changes apply without a restart. An open notebook home refreshes its card when you return from Preferences or bring Libera back into view. The model fields are greyed out while either switch is off. Summaries also need an OpenRouter key, entered in the **OPENAI_API_KEY** field of Preferences → General. Without one, the card shows the files and a note about turning summaries on.

Turning the feature off does not delete records already saved. They stay in each notebook's `.libera/where-was-i/` folder and are shown again if you turn it back on. Delete that folder to remove them.

## Privacy and cost

Everything is stored inside the notebook on your computer. Only the summary goes to the AI model, through OpenRouter with your key, and it sends:

- the notebook's name and the session's start and end times,
- the paths of the files you opened or added, and whether each was edited, new, or viewed,
- for edited text files, how many characters were added and removed and at most two short excerpts of the change (240 characters per side).

Full documents, PDFs, images, and keystrokes are never sent. A request is about 1,500 to 2,000 characters, and each finished session is summarized once, so the cost per session is a tiny fraction of a cent with the default model.

## What is recorded

A session lasts from when the app opens to when it quits. Reloading the window, for example after signing in again, continues the same session. For each notebook Libera keeps:

- up to 12 files: edited files first, then files added during the session, then the most recently viewed ones. At most 6 of them are new files you never opened, so a large upload leaves room for the rest,
- for text files (Markdown, LaTeX, code and other plain text): the characters added and removed, and the two largest changed passages, each clipped to 240 characters per side.

A file counts as added in the session when its creation date falls after the session started, whether you created it in Libera, uploaded it, or another program put it there. A note you create and write in is recorded as new, and its excerpt shows what you wrote. A new file you never opened is recorded with its name only.

When the record is written, Libera also saves a compact list of the notebook's files, as a 4-byte hash of each path (about 5 characters per file, at most 5,000 files). It stays on your computer and is never sent to the model. The next time, it tells which files are new since then. If the notebook grows beyond that limit or a linked folder's list becomes incomplete, any earlier inventory is cleared and dates are used instead.

PDFs, images, and recordings you open count as viewed. Text files above 400,000 characters are marked as edited without excerpts. A file closed and reopened in the same session is merged into one entry.

Edits are measured between the text when the file opened and its text at the end:

- **When you close a file**, its saved text is used, so a draft you discard does not count as an edit. Shared documents use their live text, including edits that have not yet reached the tab's preview.
- **When the app quits**, open files use their current draft, which Libera restores at the next launch.

## When it is written

Nothing is written while you type. The session is kept in memory and written only at these moments:

1. **A file you edited is closed.** Closing a file you only viewed writes nothing; it is saved at the next trigger.
2. **The app quits**, the window unloads, or you sign out. This also covers notebooks that gained files during the session, even if you never opened anything in them. This uses the same save step that already runs before Libera exits. A failed write never holds up quitting.

A notebook's record is sent only if it changed since the last write. The server also skips the write if the file's content would not change.

The summary is made at most once per finished session: the first time you open that notebook's home after the session ended. The bullets are stored with the record and reused afterwards. If a request fails, Libera waits 3 minutes before trying that session again, so a rate limit or a bad key cannot turn every visit into a request. **Try again** retries right away.

## Synced folders and shared notebooks

Records are stored as `<notebook>/.libera/where-was-i/<device>.json`, one file per installation. A linked folder keeps it in its state folder in the data directory instead. Each file holds this installation's last two sessions and the newest summary it made.

- **Synced folders (OneDrive and the like).** Each computer writes only its own file, so the sync client never has to resolve a conflict. The home shows the newest finished session from any computer and names that computer when it is not this one.
- **Shared notebooks.** The collaboration host never shares `.libera` files, so your record stays on your computer and collaborators keep their own. While you work, a shared document also receives other people's edits. Libera notes whether each change was made in your window or arrived from someone else:
  - files changed only by others are marked **Collaborators**,
  - files changed by both are marked **Edited**, and the model is told the changes include collaborators',
  - the model is told which edits were not yours, so the recap does not credit you with them.

  Files that collaborators changed while you were away appear under **Updated by collaborators since you left**. They are not sent to the model.

"Changed since you left" decides, for each file, whether it is new or updated since your last session ended. A one-minute allowance covers saves that finish while the app quits.

- **New:** its path is not in the session's list of known files. This catches files copied in with Finder or synced from elsewhere, which keep their original dates.
- **Updated:** its modified time is after the session ended.
- **Without a list** (a session recorded before this version, or a very large linked folder), dates decide. A file is new if its creation time or its inode change time is later than the end of the session. The inode change time moves whenever a file is copied in, even when the copy keeps its other dates. It also moves when a sync client changes only a file's metadata, which is why the list is preferred when there is one.

## Troubleshooting

- **No card.** The notebook has no finished session yet, Where Was I is turned off, or you hid it with **×**. Quit and reopen Libera after working in the notebook.
- **"Couldn't summarize your last session."** Check the OpenRouter key and the model in Preferences. The provider's own reason (for example a temporary rate limit) is in Libera's server log. Try another model if the problem continues.
- **A file is missing from the list.** Files that were renamed, moved, or deleted since the session are left out.

## How it works

| Part | File |
| --- | --- |
| Types, limits, change excerpts, input checks | `src/lib/where-was-i.ts` |
| The session in memory and when it is written | `src/components/libera/where-was-i-tracker.ts` |
| Per-device record files | `src/lib/storage/where-was-i.ts` |
| File creation and inode change times in the library tree | `src/lib/storage/tree.ts` (`createdAt`, `changedAt`) |
| Settings, prompt, and the model call | `src/lib/where-was-i-ai.ts` |
| API: `GET` the card, `PUT` a session, `POST` a summary | `src/app/api/where-was-i/route.ts` |
| The card on the notebook home | `src/components/libera/where-was-i-card.tsx` |
| Preferences | `electron/ai-preferences.cjs`, `electron/setup.html` |
| Tests | `scripts/editor/where-was-i.test.ts`, `scripts/lib/ai-preferences.test.cjs` |

The tracker follows the open tabs. A new tab records its starting text, and a closed tab is turned into an entry. When it writes, it also reads the library tree for files created since the session started and for the notebook's list of known files. For shared documents, the starting text is taken when the document finishes loading, and the editor reports whether each change came from this window or from someone else.

The server checks everything a client sends against the same limits, ignores notebooks that do not exist, and writes each record file one update at a time.

Settings are read from the config file on each request (`aiFunctions.whereWasI`: `enabled`, `summarize`, `model`, `reasoningEffort`). Without a config file they come from the environment: `LIBERA_WHERE_WAS_I_ENABLED`, `LIBERA_WHERE_WAS_I_SUMMARIZE`, `LIBERA_AI_WHERE_WAS_I_MODEL`, and `LIBERA_AI_WHERE_WAS_I_REASONING_EFFORT`.
