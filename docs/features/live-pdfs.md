# Live PDFs

In a shared notebook with live PDFs on, everyone who can annotate sees each other's marks as they are made, on any PDF in the notebook. Highlights, shapes, ink, text notes, spaces and comments are all shared. The PDF file itself is never changed. The design is in the [plan](../collaboration/pdf-realtime-plan.md).

## Turning it on

The owner chooses:

- **When sharing a notebook:** the **Live PDF annotations** box in the share dialog, on by default.
- **For a notebook already shared:** **Turn on…** under **Live PDF annotations** in the notebook's sharing dialog.

Turning it on cannot be undone. Marks already on the notebook's PDFs, on every member's computer, become visible to everyone, and the dialog says so. Members need a Libera version that supports live PDFs, and the collaboration server must be updated first. Until a member updates, they see no live marks, and their edits stay on their own computer.

## What each role can do

| | Owner | Editor | Commenter | Viewer |
|---|:-:|:-:|:-:|:-:|
| See marks, comments and who is here, live | ✓ | ✓ | ✓ | ✓ |
| Create, change and delete anyone's marks | ✓ | ✓ | ✓ | |
| Comment and reply | ✓ | ✓ | ✓ | |
| Restore a named version | ✓ | ✓ | | |
| Replace, rename or delete the PDF | ✓ | ✓ | | |

A reviewer assigned to a PDF needs at least the commenter role to annotate it.

## Working together

- **There is no Save.** Marks are saved on this device as they are made and sent when there is a connection. The pill above the PDF says where they are.
- **Who is here:** avatars above the PDF, pointers and strokes on the pages, outlines around what others have selected, and a rail beside the pages showing where each person is reading.
- **Follow:** click someone's avatar or their mark on the rail. Scrolling yourself stops following.
- **Typing together:** two people can type in one note at once. Their text merges by character.
- **Changing the same thing:** different properties of one mark both apply. If two people change the same property, such as moving the same note, the last change wins everywhere.
- **Undo** takes back only your own work, one step per press. If someone has since changed the same property, that press leaves it alone.

## Deleting

Nothing is lost by deleting. **History** above the PDF lists deleted marks with **Restore**. If someone deletes a note while you are writing in it, you get a notice with **Restore**, and what you wrote is kept with the deleted note.

Marks drawn in a space that someone else deleted stay visible at the place the space was, and go back into it if the space is restored.

## Offline

Everything works offline, on any PDF. Marks wait on this device and merge when the connection returns. Comments written offline show as pending. A PDF this computer has never opened may not show everyone's marks until it reconnects.

## History and reviews

- **History** lists deleted marks and versions. Name a version to keep a point you can return to. Restoring brings marks back as a new change, so nothing is rewound: marks added since then are deleted, and stay restorable.
- **Reviews** works as on a Markdown document, for the whole PDF. A decision applies to the PDF as a whole, and later changes to marks do not mark it outdated.

## When the PDF is replaced

Marks belong to a version of the PDF. When someone replaces the file:

- Highlights look for their quoted text on the same page and the two pages either side, and move if it is there exactly once.
- Other marks stay where they are. A banner says how many may not line up, and **Keep them here** clears it.
- People on different versions are told so.

Comments stay where they were placed, and do not move with their text. PDFs compiled from LaTeX count as replaced on every build, so their marks are flagged often.

## On disk

The shared document is the source of truth. The sidecar in `.libera/annotations` becomes a read-only copy, rewritten about once a minute so search, deep search and export keep working. It is never read back, so an old copy from a sync client cannot change anything. A sidecar that differs from that copy, such as one written by an older Libera, adds only marks the document has never seen.

Leaving the notebook, or losing access, writes the last state as an ordinary sidecar, so you keep your copy.
