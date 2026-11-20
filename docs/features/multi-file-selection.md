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
  - 200 `{ moved: [{ from, to, payload }], failed: { path, error } | null, notMoved: string[], unchanged: string[] }`.
    The first failure stops the batch.
- `{ action: "delete", items }` gives 200 `{ deleted: string[], failed: [{ path, error }] }`. A failure does not stop the others.

`src/lib/storage/batch-files.ts` never handles records. It checks the whole batch first (no two
files land on one name, each destination is free of files and of the records of a file that was there before
(`assertNoLeftoverRecords`), each source is still the file selected by `fileId`), then calls the single
operations, `moveFileToDirectory` and `deleteFile`, one file at a time. So every file keeps every record, gets
whatever the single move does, and leaves the notebook sound for Check Notebook (`docs/features/notebook-integrity.md`).

## Shared notebooks

Items go through the same wrappers the single operations use (`moveSharedFile`, `deleteSharedFile`),
each with its host file id as `fileId`. Only name uniqueness is checked up front; the host checks the rest per file.

## File identity

Local file nodes now carry `fileId` (`localFileIdentity`, stamped in `src/lib/storage/tree.ts`; shared notebooks get theirs
from the host's listing). Single and batch move, archive and delete send it, and a path that holds another file by then is refused.
