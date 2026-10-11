# Directory mode

Libera has two ways of working:

- **Notebook mode** (the default) shows the notebook library in the Libera data folder.
- **Directory mode** opens any folder on disk and works in it directly. The folder replaces the library until you close it.

## Opening and closing

In the desktop app, the **File** menu has:

- **Open File...** (⌘/Ctrl+O). If the file is already in the open folder (or, in Notebook mode, in a notebook), it opens in place. Otherwise Libera opens the file's folder and then the file.
- **Open Folder...** (⌘/Ctrl+Shift+O).
- **Open Recent**, which lists the last 10 folders and has **Clear Recently Opened**.
- **Close Folder**, which returns to Notebook mode.

The sidebar has an **Open folder** button. In Directory mode it also has a **Close folder** button, and the folder's actions menu has a **Close Folder** item.

Before switching, Libera saves the current session, including unsaved drafts. Notebook mode and each folder keep their own tabs, layout, expanded folders, workspaces, stars and comments. Closing a folder brings back your notebook tabs, and reopening the folder brings back its tabs.

## What is in scope

While a folder is open, the folder is the only notebook. The server refuses paths outside it, so these features all stay inside the folder:

- the sidebar and search,
- Markdown links and the link picker,
- `@` file references in AI Chat,
- deep search,
- saving drafts and chats.

Hidden entries (names starting with `.`) are skipped. So are `node_modules`, `__pycache__` and `bower_components`. A folder with more than 20,000 entries is only partly shown, and the sidebar says so.

## Where data is stored

Your documents stay where they are. Libera only writes inside the folder when you create, edit or move files, or when you paste images into Markdown (they go in `_assets/`, as in notebooks).

App state stays in the data folder, under `users/admin/.libera/directories/<id>/`. This covers sessions, PDF and image annotations, PDF text caches and review comments. Libera does not add a `.libera` folder to the folder you open.

The open folder and the recent list are kept in `users/admin/.libera/directory-mode.json`. If the open folder has been moved or its drive has been removed, Libera goes back to Notebook mode at the next load. The folder stays in **Open Recent**.

Notebook management (create, rename, delete, groups, download) is turned off while a folder is open.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/directory-mode.test.ts`
