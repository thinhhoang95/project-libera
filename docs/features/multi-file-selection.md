# Multiple-file selection in the notebook rail

Pick several files in the left rail, then move or delete them together.

## Selecting

- Ctrl+Click (Cmd+Click on macOS) on a file row toggles it, without opening it.
- Shift+Click selects the visible file rows between the last toggled file and the clicked one.
- A plain click opens the file as before and clears the selection. Esc clears it.
- Files only, and one notebook at a time: Ctrl+Click on a file of another notebook starts a new selection there.
- Selected rows are highlighted and carry `aria-selected` (`role="treeitem"`, inside a `role="tree"` with `aria-multiselectable`).
- After a refresh, paths that are no longer files of the tree leave the selection.

The rules (toggle, range, same-notebook, pruning, which menu applies, what a drag carries) are in
`src/components/libera/file-selection.ts`, a pure module with its own test.

## Acting on it

Right-click a row that is one of two or more selected files: the menu offers
**Move N files…** and **Delete N files…** for the whole selection. Any other row keeps
the single-file menu. Dragging a selected row drags the whole selection (`DragSlot` holds a list; a
drop still consumes it synchronously, before any await).

- **Move, same notebook** (Move dialog, or a drop on a folder of the notebook): one confirmation
  names open tabs with unsaved edits; then `POST /api/files/batch`. Each moved file is followed by
  `followFileMove` (open tabs, notices), and the tree is read once at the end.
- **Move, another notebook** (a drop on another notebook or its folder, or a Move destination there):
  the migration dialog opens with every selected path preset.
- **Delete**: a confirmation lists the first few files and the count, and warns about open tabs with
  unsaved edits. Tabs close and drafts are forgotten for each file that was deleted.

## The batch route

`POST /api/files/batch`, with items `{ path, fileId? }` of one notebook:

- `{ action: "move", items, destinationDirectory }`
  - 409 `{ error, problems: [{ path, message }] }`: refused before anything moved.
  - 200 `{ moved: [{ from, to, payload, unfinished? }], failed: { path, error } | null, notMoved: string[], unchanged: string[] }`.
    The first failure stops the batch. `moved` is every file that is at its destination now.
- `{ action: "delete", items }` gives 200 `{ deleted: string[], failed: [{ path, error }], unfinished?: [{ path, steps }] }`. A failure does not stop the others. `deleted` is every file that is gone.

`src/lib/storage/batch-files.ts` never handles records. It checks the whole batch first (no two
files land on one name, each destination is free of files and of the records of a file that was there before
(`assertNoLeftoverRecords`), each source is still the file selected by `fileId`), then calls the single
operations, `moveFileToDirectory` and `deleteFile`, one file at a time. So every file keeps every record, gets
whatever the single move does, and leaves the notebook sound for Check Notebook (`docs/features/notebook-integrity.md`).

## Shared notebooks

Items go through the same wrappers the single operations use (`moveSharedFile`, `deleteSharedFile`),
each with its host file id as `fileId`.

- **Storage is decided per item, before anything changes.** A path is in a local notebook, in the active files of a shared
  notebook (handled by the host), or in a shared notebook's `_archive` (recovery storage, kept on this computer only).
  A selection that mixes the shared notebook's files with its archive is refused whole with a 409 (each file listed with
  its storage), whichever file was selected first. So is a move whose destination is in the other storage (shared files
  into the archive, archived files into the shared folders). Select one kind at a time.
- **The layout is checked against the host's manifest.** `preflightSharedMove` reads the notebook's file list once per
  batch and compares names with the host's own key (`manifestPathKey`: Unicode NFC and case folded, so `é` typed in
  two ways clash). Two files landing on one name, and a file landing on a name that a stationary file, a selected file
  already in the destination, or a folder holds, are refused up front. If the list cannot be read, the batch is refused.
- **A host commit counts.** When a wrapper throws `SharedOperationUnfinishedError` (the host moved or deleted the file but a
  later step, such as the records kept on this computer, stayed behind), the file is counted as moved (`moved[].unfinished`,
  `payload` null) or deleted (`unfinished[]`), not failed, and the batch goes on. The app follows every committed file in
  tabs, the tree and saved workspaces (one write for the whole batch), and says what stayed behind; Check Notebook settles it.
- **No work per file.** A shared delete passes `deferRefresh`, so a wrapper does not read the tree or wait for the disk after
  each file. The app refreshes the affected notebook's tree once after the batch (and the host's tree event covers a slow follower).

## File identity

Local file nodes now carry `fileId` (`localFileIdentity`, stamped in `src/lib/storage/tree.ts`; shared notebooks get theirs
from the host's listing). Single and batch move, archive and delete send it, and a path that holds another file by then is refused.
