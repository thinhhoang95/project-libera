# Create space in PDFs

Create space opens blank room inside a PDF page so you can write or draw next to the text you are reading. Put the cursor on the line where the page should open and drag down. What is below slides down as you drag. When you let go, a note opens in the new space, ready for typing. In a two-column paper, only the column under the cursor opens.

The PDF file is never changed. A space is an annotation, saved with the PDF's highlights and notes, and the viewer shows the page pulled apart.

## Using it

Pick **Space** in the PDF toolbar (the ↕ icon), or press `G`. Press `Esc` to put it down and go back to Select, as with every PDF tool.

- **Hover.** A dashed line follows the cursor across the column under it, or across the page where there are no columns. It snaps to blank rows between lines, so a space never cuts through a line of text, an equation or a figure. In a wide blank area it stays where the cursor is. Hold `Shift` to turn snapping off.
- **Drag down** to open a space. Content above the cut never moves, so the line you are reading stays put.
- **Let go.** The space is saved as one undo step, and an empty note opens at its top-left. Type straight away. A note you leave empty is discarded, and an abandoned note leaves no undo step behind.
- **Click without dragging** opens a space about three lines (40 pt) tall, with a note in it.
- **Esc during a drag** cancels it. Dragging back above the start opens nothing.
- **`Alt` while pressing** opens a full-width space even inside columns, where the page allows it.

### Existing spaces

With the Space or Select tool, each space shows its outline, a grip on its bottom edge and a delete button (×).

- **Resize** by dragging the grip, or by pressing inside a space with the Space tool. A space never gets shorter than what it holds. Pressing at the cut of an existing space resizes it rather than stacking a second one.
- **Select** a space by clicking it with the Select tool. Press `Delete` to remove it.
- **Delete** removes the space and the notes and drawings in it, in one undo step, so `Cmd/Ctrl+Z` brings everything back.

### Writing and drawing in a space

Notes (Text tool), pen drawings and shapes made inside a space belong to it and move with it when spaces above it open or close. Highlights, comments, search matches and text selection stay on their text wherever it moves. Each pixel of content is moved as it is; text is never rewrapped.

### Two-column pages

Libera finds column blocks on the page: two or more columns side by side between full-width parts such as the title, a wide figure or the footer. Inside a block, a space opens only in the column under the cursor. The block grows by its tallest column, so the other columns end early with blank paper under them, called filler. Everything below the block moves down by the same amount.

Filler is not a space: something dropped there snaps to its top edge. While the Space tool is on, filler is lightly hatched so you can tell.

A space keeps the column layout it was made with, so later spaces on the page agree with it. The page's own background color fills spaces and filler, so they also look right on slides with colored backgrounds.

### Limits

- Up to 32 spaces per page.
- One space can be up to one page tall, and a page can grow to four times its height.
- Column blocks of up to five columns.

A drag stops growing when it reaches a limit.

### Not yet

- **Export.** Exporting the PDF with annotations leaves out spaces and the notes and drawings in them, and says so. Exporting taller pages is planned.
- A stylus does not yet draw in a space whatever the tool, and `↑`/`↓` do not yet resize a selected space.
- A heading that sits entirely left of the gutter between columns counts as part of the left column.

## Saving and syncing

Spaces are saved in the PDF's annotation side-car with the other annotations, so they follow the PDF when it is renamed or moved (see [PDF outlines and annotations](pdf-outlines.md)). They sync between windows. Undo, redo and edits from another window keep the line you were reading in place. The Annotations tab lists what is inside spaces, not the spaces themselves.

A side-car written by a newer Libera keeps annotation types and fields this version does not know about when it is saved again.

## How it works

- **Coordinates.** Annotations are stored in coordinates of the original page, so a highlight's position does not depend on the spaces above it. Each page gets a geometry from its spaces: how much taller it is, and a mapping between original and displayed positions. Overlays convert annotations to the displayed page and convert edits back. Notes, ink and shapes in a space store their position relative to the space's top.
- **Rendering.** A page with spaces is shown as rectangular pieces of its one PDF.js rendering. Each piece is its own canvas, moved by a CSS `translate`, and text-layer spans move with the piece they sit in. Opening, resizing or deleting a space copies bitmaps into new pieces; the page is never rendered again, and the bitmap is held once. The sharper detail rendering at high zoom is split into the same pieces. Pages without spaces take none of these paths.
- **Layout.** When the tool is first used on a rendering, a 400-column picture of the page's ink is built from the canvas. Cuts snap to its blank rows. Column blocks come from runs of rows that share a vertical blank gutter. A line that reaches into the gutter narrows it rather than ending the block, and a column may end early.

## Implementation

- `src/lib/pdf-space.ts`: limits, bands and columns, and normalizing and reconciling a page's spaces.
- `src/lib/pdf-space-geometry.ts`: page geometry, pieces and filler, and converting annotations between the original and the displayed page.
- `src/lib/pdf-space-layout.ts`: the ink mask, snapping, column blocks and where a cut goes.
- `src/components/libera/pdf-space-raster.ts`: raster pieces, moving text spans, and `usePdfSpaceRaster`.
- `src/components/libera/pdf-space-layer.tsx`: the tool's hover line, drags, grip and delete button.
- `src/components/libera/pdf-viewer.tsx`: geometry per page, committing and deleting spaces with undo, and the notes opened in new spaces. `use-pdf-detail-canvas.ts`: the detail rendering in pieces.
- `src/lib/storage/annotations.ts`: the side-car normalizer and keeping unknown types and fields.

[docs/create-space-plan.md](../create-space-plan.md) is the design, with the phases still to come.

## Checks

```
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/pdf-spaces.test.ts scripts/editor/pdf-viewer.test.ts
```

`pdf-spaces.test.ts` covers geometry and its round trips, reconciling stored spaces, snapping, column blocks and cut placement, and saving with unknown types kept. `pdf-viewer.test.ts` covers the tool in the viewer: opening a space and typing at once, resizing, deleting with what is inside, undo, syncing between windows, and `Esc` leaving every tool.
