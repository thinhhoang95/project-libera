# Workspaces

Open **Workspaces** in the left rail (⌘/Ctrl+4). Create a named, colored workspace, then choose its notebook visibility:

- **Everything** includes the library and future files.
- **Only selected** includes checked files or folders.
- **Everything except** hides checked files or folders.

The picker supports search, select all, clear, and partial folder selections. Whole selected folders include future children. Workspaces filter the notebook panel, notebook home, recent files, and search results. Library-level hidden notebook/group preferences do not hide an explicitly selected workspace item. Archive visibility is saved separately for each workspace.

Each workspace card has rename, settings, and delete buttons. The active card and the notebook panel also offer Exit Workspace. Exiting restores the All notebooks session. Deleting a workspace removes its saved session and drafts; it never deletes notebook files.

## View settings and groups

Each workspace saves its sidebar sorting, notebook-home sorting, list/grid layout, archive visibility, notebook groups, and notebook-to-group assignments. Switching or reopening restores those settings; exiting restores the library view. Creating, renaming, deleting, or reorganizing a group affects only the active workspace. Notebook names and file contents still belong to the shared library.

New workspaces start with a copy of the library's sorting and groups. Existing workspaces inherit those settings once when first loaded after this update, then keep their own independent copies. Library-level hidden groups and notebooks do not override a workspace's file selection. Empty workspace groups remain available so they can be edited later.

## Continuity

Sessions retain tab order, the active tab (or notebook home), notebook selection, expanded folders, unsaved drafts, and the view state already tracked by Markdown, PDF, and image viewers. Changing visibility does not discard open tabs or drafts. A new workspace starts with an empty tab strip. On reopening, clean tabs load current file contents and dirty tabs retain their saved drafts. Missing clean files are skipped; drafts from missing files become untitled documents so they can be saved elsewhere.

Normal checkpoints are queued and written atomically through the authenticated `/api/workspaces` endpoint to `.libera-workspaces.json` in the admin data directory. Workspace transitions wait for successful writes. A browser recovery journal covers page closure. Electron additionally writes `.libera-workspaces-recovery.json` synchronously through a main-window-only IPC channel at shutdown; this works even when the Next server has stopped and the next launch uses a different port. Startup validates both disk copies and uses the newer valid snapshot.

File and folder renames made in the app update workspace selections and saved tab paths. Workspaces are views of the same underlying library; saving a document still updates that shared file.

## New and moved files

Files created, saved, copied, uploaded, or moved within Libera while a workspace is active are automatically included in that workspace. This also covers saving an untitled draft, creating slides, saving a chat to a notebook, and creating folders or notebooks. Moving a file outside a selected folder keeps it in the active workspace. Changes are saved with the workspace and survive switching and reopening.

For **Only selected**, the affected paths are added to the selection. For **Everything except**, affected paths become narrow inclusion exceptions; unrelated files in an excluded folder remain hidden. You can change those choices in workspace settings. Other workspaces retain their existing visibility rules, while in-app renames and moves update their explicit paths and saved tabs. Deleting files or folders removes stale selections.

Tracking happens only after a successful file operation and stays associated with the workspace where the operation began. Switching waits for pending tracked file operations. Files added while **All notebooks** is active are not automatically added to saved workspaces.

Changes made outside Libera still follow the saved scope and require a tree refresh (for example, switching workspaces or reloading the app); there is currently no filesystem watcher for the sidebar. External renames do not remap explicit workspace selections. Archiving a folder remaps its saved workspace paths, including when an existing archive folder forces a different destination name.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/workspaces.test.ts`

Covers selection, partial folders, hidden groups, independent drafts for the same file in different workspaces, tab restoration, disk recovery, missing files, failed writes, renames, deletion, authentication, validation, workspace-specific sorting controls and layouts, independent group editing and assignment, older snapshot migration, and restored settings after switching and reopening.
