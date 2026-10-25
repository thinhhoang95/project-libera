# Create Space implementation plan

Status (2026-10-25), merged into `multi-user-profiles`. The user guide is
[docs/features/create-space.md](features/create-space.md).

- **Phase 0 is done:** types, sidecar normalization, preservation of unknown
  types and fields, consumers guarded, and `src/lib/pdf-space.ts` /
  `src/lib/pdf-space-geometry.ts`.
- **Phase 1 is done, for full-width spaces:** the Space tool (`G`), snapping
  to blank rows across the page (`src/lib/pdf-space-layout.ts`), live drag,
  a note opened for typing in each new space, ink and notes anchored to
  spaces, the resize grip and delete button, undo, and reading-position
  anchoring. Raster pieces and the detail canvas live in
  `src/components/libera/pdf-space-raster.ts` and `use-pdf-detail-canvas.ts`;
  the layer is `src/components/libera/pdf-space-layer.tsx`. Tests are in
  `scripts/editor/pdf-spaces.test.ts` and `pdf-viewer.test.ts`.
- **Still open from phase 1's list:** a stylus drawing in a space whatever the
  tool, and `↑`/`↓` resizing (moved to phase 4).
- **Phase 3 is done:** `columnBlocks` and `placeSpaceCut` in
  `src/lib/pdf-space-layout.ts` find column blocks in the ink mask.
  - Lines reaching into a gutter narrow it rather than ending the block, and
    a column may end early.
  - A page's stored blocks win over fresh analysis, and found blocks are
    trimmed so they never overlap them.
  - Spaces open in the pointer's column, snapped to blank rows in that
    column, with `Alt` for full width outside blocks.
  - Filler is paper-colored, and hatched while the tool is on.
- **Known quirk:** a heading that sits entirely left of the gutter joins the
  block as part of the left column.
- **Phases 2 and 4 are not started.**

Create Space lets a reader open blank room inside a PDF page, at any line, and
write or draw in it. The reader puts the cursor where the page should open,
drags down, and the content below slides down live. Releasing leaves an empty
space ready for typing or ink. In two-column papers, only the column under the
cursor opens.

The PDF file is never changed. A space is an annotation, like a highlight or
a note. The viewer shows the page "pulled apart"; export writes taller pages.

## Goals and non-goals

Goals:

- Spaces can be opened anywhere, live while dragging, with no visible lag.
- Two-column layouts (and full-width titles, figures and footers between
  column blocks) work without the user choosing a mode.
- Notes and ink inside a space move with the space. Every existing
  annotation, comment, search hit and citation stays attached to its text.
- Pages without spaces cost exactly what they cost today.
- Spaces undo, redo, save, sync between windows and export like other
  annotations.

Non-goals for this plan:

- Reflowing text. Content is moved in rigid pieces; lines are never rewrapped.
- Spaces in the LaTeX preview (its PDF is regenerated) or the image viewer.
- Layouts deeper than "bands of columns" (for example a two-column figure
  inside one column of a two-column page). Those get the nearest simpler
  behavior, described under [Layout analysis](#layout-analysis).

## Product behavior

### The tool

Add a **Create space** tool to the PDF toolbar beside Text and Pen, with the
shortcut `G` (free in `TOOL_SHORTCUTS`) and a lucide `UnfoldVertical` icon.
`PdfTool` gains `"space"`; the view-state tool unions in
`src/components/libera/types.ts` and `src/lib/markdown-file-links.ts` gain it
too, so the tool is remembered per tab.

1. **Hover.** With the tool active, a dashed line follows the cursor across the
   column under it (or the full page width where the page has one column). The
   line snaps to the nearest blank row, so it never splits a line of text, an
   equation or a figure. The cursor is `row-resize`. Holding `Shift` turns
   snapping off.
2. **Press and drag down.** The space opens live under the cut. Everything
   below it in that column, and everything below that column block, moves
   down. Content above the cut never moves, so what the reader is looking at
   stays still.
3. **Release.** The space is committed as one undo step. An empty note is
   placed at the top-left of the space in edit mode, so typing starts at once.
   A stylus (`pointerType === "pen"`) draws ink in the space instead, whatever
   the tool. An empty note is discarded on exit, as text notes are today.
4. **Click without dragging** opens a default space (three body lines, about
   40 pt) and starts a note in it.
5. **Drag up past the start**, or `Escape`, cancels.

### Existing spaces

- With the Create space or Select tool, hovering a space shows its outline, a
  grip on its bottom edge and a delete button. Dragging the grip resizes it,
  down to the bottom of whatever is inside. A click on empty space area
  selects it; `Delete` removes a selected space; `↑`/`↓` resize it by one line.
- Pressing at a cut that already has a space resizes that space rather than
  stacking a second one.
- Deleting a space deletes the notes and ink inside it. This is one undo step,
  so undo brings everything back; no confirmation dialog.
- A note that grows past the bottom of its space while typing grows the space
  with it. A pen stroke that ends below the space grows the space to fit.
- Notes and ink can be dragged between a space and the page; they re-anchor
  where they are dropped.
- Spaces are filled with the page's own background color (sampled at creation),
  so they also look right on slides with dark or colored backgrounds.

### Multi-column pages

In a column block (two or more columns side by side between full-width
elements), a space opens only in the column under the cursor. The block grows
by its tallest column, so the other columns end early with blank paper below
them, called **filler**. Content below the block (a full-width figure, the
footer, the next block) moves down by the block's growth.

Filler isn't a space and can't hold annotations: anything dropped into filler
snaps to the filler's top edge. While the tool is active, filler is lightly
hatched so this is visible.

## Key decisions

1. **Never re-render, never reflow.** pdf.js renders each page once at the
   current zoom, as now. A page with spaces is displayed as a few rectangular
   **pieces** of that rendering, each moved down by its own amount. Creating
   or resizing a space costs a few `drawImage` blits and CSS updates, never a
   pdf.js render.
2. **Document coordinates stay canonical.** Every stored coordinate keeps
   meaning "fraction of the original page", as today. Spaces are applied only
   when drawing on screen and when exporting. Comments, citations, search, copy,
   Markdown conversion and the text cache never see spaces.
3. **A space is an annotation** (`type: "space"`) in the same sidecar. It gets
   undo/redo, the annotation writer, cross-window sync and file move/copy
   handling for free.
4. **The resolved layout is stored with the space.** The column analysis runs
   only when a space is created. Rendering is computed purely from the stored
   numbers, so it never depends on heuristics, zoom or render timing, and it
   never changes after a heuristics update.
5. **Two kinds of anchoring.** Text-bound marks (highlight and comment rects)
   move line by line with their text. Free annotations (notes, ink, shapes)
   move rigidly with one anchor point, so a stroke is never stretched.
6. **Layers stay space-unaware.** `TextAnnotationLayer`, `PdfDrawingLayer`,
   `ScreenshotSnipLayer` and the highlight marks keep working in "fractions of
   the box I cover". The page host hands them annotations already converted to
   the displayed page, and converts what they report back to document
   coordinates. The image viewer, which shares these layers, is untouched.

## Data model

In `src/lib/types.ts`:

```ts
/** A column block's layout, in page fractions, recorded when its first space was made. */
export type PdfSpaceBand = {
  top: number;
  bottom: number;
  /** x boundaries between columns, ascending; empty for one full-width column. */
  splits: number[];
};

/** Blank room opened in the page as displayed; the PDF itself is unchanged. */
export type PdfSpaceAnnotation = {
  id: string;
  type: "space";
  pageNumber: number;
  /** The cut: a page fraction, normally at a blank row of the column. */
  y: number;
  /** Inserted height, as a fraction of the page height. */
  height: number;
  band: PdfSpaceBand;
  /** Index of the column (between `band.splits`) that opens. */
  column: number;
  /** Page background sampled at creation, used to fill the space. */
  fill?: string;
  createdAt: string;
  updatedAt: string;
};
```

`PdfAnnotation` gains `PdfSpaceAnnotation`. `PdfTextAnnotation`,
`PdfInkAnnotation` and `PdfShapeAnnotation` gain:

```ts
/**
 * The space this annotation sits in. Its y coordinates are then measured from
 * the top of that space, in page-height fractions; x is unchanged.
 */
space?: string;
```

Highlights never get `space`, because a space contains no PDF text.

A **full-width cut** is a band of zero height at the cut (`top === bottom ===
y`, `splits: []`). This means phase 1 (full-width spaces only) and phase 3
(column spaces) use one model and one set of functions.

Column extents partition the whole band: `splits` sit at gutter midpoints, and
the outer columns reach the page edges. Margin notes beside a column therefore
move with that column.

### Normalization (`src/lib/storage/annotations.ts`)

`normalizePdfAnnotations` gains a `"space"` branch and preserves `space` on
text, ink and shape annotations. Rules:

- Clamp `y` and band edges to `[0, 1]`, `top <= y <= bottom` (or the zero-height
  form), `height` to `[0.005, 1]`. A space is at most one page tall, so
  coordinates measured from its top fit the existing page-fraction clamps.
  Keep at most 32 spaces per page, and total inserted height per page at most
  3 page heights, so sheets stay bounded.
- `splits` must be ascending and inside `(0, 1)`, at most 4. `column` is
  clamped to `[0, splits.length]`.
- **Bands on one page must not overlap.** If two stored bands overlap but
  differ (for example from a merge of two sidecars), the band of the
  earliest-created space wins and the later space adopts it, re-choosing its
  column by its cut's x.
- Two spaces at the same cut in the same column are stacked in a fixed order:
  `(y, createdAt, id)`.
- An annotation whose `space` refers to a missing space drops the reference.
  This is only reachable through a hand-edited or merged sidecar; it must not
  crash and is covered by a test.

**Compatibility.** Today's normalizer drops unknown types, so an older build
(another device syncing the notebook through OneDrive, or a collaboration peer)
that saves the sidecar would delete every space. It would also strip `space`
from notes, which would jump to the top of their page. Phase 0 therefore ships
the normalizer support, with the tool hidden, at least one release before the
tool appears. While there, saving keeps what this build can't read, so the
next new type doesn't hit the same trap. On write, the server carries over
from the stored sidecar annotations of unknown types, and unknown fields of
annotations it does know (matched by id and type), each bounded in size. The
viewer never receives them, so it can't have meant to delete them.

## Geometry (`src/lib/pdf-space-geometry.ts`, new, pure)

Units: x is a fraction of page width, y a fraction of the **original** page
height. Displayed y runs from 0 to `1 + growth`. Pixels are these values times
the page's size at the current zoom, so every geometry value is
zoom-independent and computed once per change to a page's spaces.

```ts
export type PdfPageGeometry = {
  /** Extra height as a page fraction; 0 without spaces. */
  growth: number;
  /** How far document content at (x, y) moves down. */
  shiftAt(x: number, y: number): number;
  toView(point: PdfAnnotationPoint): PdfAnnotationPoint;
  /** Inverse of toView; points inside a space report it with local coordinates. */
  toDoc(point: PdfAnnotationPoint): { point: PdfAnnotationPoint; space?: string };
  /** Each space's displayed box, plus filler boxes. */
  spaces: { id: string; rect: PdfAnnotationRect; fill?: string }[];
  fillers: PdfAnnotationRect[];
  /** Document rectangles that move as one, with their shift; they tile the page. */
  pieces: { key: string; rect: PdfAnnotationRect; shift: number }[];
  /** Changes only when pieces are added or removed, not when a space is resized. */
  structureKey: string;
};

export function pdfPageGeometry(spaces: readonly PdfSpaceAnnotation[]): PdfPageGeometry;
export const IDENTITY_PAGE_GEOMETRY: PdfPageGeometry;
```

Derived flow: group a page's spaces by band (bands sorted by `top`, never
overlapping). Each band has its columns, and each column has its gaps sorted by
`(y, createdAt, id)`. A column's growth is the sum of its gap heights; a band's
growth is its tallest column's growth.

```ts
function shiftAt(x, y) {
  let shift = 0;
  for (const band of bands) {
    if (y < band.top) break;
    if (y >= band.bottom) { shift += band.growth; continue; } // also zero-height bands
    for (const gap of columnAt(band, x).gaps) if (gap.y <= y) shift += gap.height;
    break;
  }
  return shift;
}
```

- **A gap's displayed top** is `gap.y` plus the shift of everything ordered
  before it: bands above, and earlier gaps in its column.
- **`toDoc`** walks the bands in displayed coordinates in the same order:
  - Before a band: subtract the running shift.
  - Inside a gap: return the space id and local coordinates.
  - Between gaps: subtract the shift so far.
  - In filler: return the column's bottom edge (`band.bottom`, just inside),
    which implements "filler snaps to its top".
- **Pieces.** Cut the page at every band edge:
  - Outside bands, each strip is one full-width piece.
  - Inside a band, each column is cut at its gaps' y.
  - A page with n spaces in one band of c columns has at most `c + n + 2`
    pieces. Typical pages have 2–6.
- **Cost.** `shiftAt` is O(bands + gaps on the page): a handful of comparisons.
  Build `pdfPageGeometry` per page with `useMemo` on that page's spaces.

### Converting annotations

Also in this module, so it's testable without React:

```ts
/** An annotation as drawn on the displayed page, in fractions of that page's box. */
export function annotationToSurface(annotation: PdfAnnotation, geometry: PdfPageGeometry): PdfAnnotation;
/** Turns a layer's patch (surface fractions) into a document patch, re-anchoring as needed. */
export function patchFromSurface(original: PdfAnnotation, patch: Partial<PdfAnnotation>, geometry: PdfPageGeometry): Partial<PdfAnnotation>;
export function draftFromSurface<T extends PdfDrawingDraft | PdfAnnotationRect>(draft: T, geometry: PdfPageGeometry): T & { space?: string };
export function rectsFromSurface(rects: PdfAnnotationRect[], geometry: PdfPageGeometry): PdfAnnotationRect[];
```

"Surface fractions" are the layers' existing units: fractions of the box they
cover. On a page with spaces, that box is the displayed page, so
`surfaceY = viewY / (1 + growth)`.

| Annotation | Displayed position |
| --- | --- |
| Highlight rects, comment rects | Each rect shifts by `shiftAt` of its top-centre (line by line). |
| Note | Rigid: shifted by `shiftAt` of the rect's top-centre; with `space`, placed at the space's top plus local y. |
| Ink, shape | Rigid, the same way, using the top-centre of `drawingBounds`. |
| Search hits | Not converted: they mark text-layer spans, which already moved. |

`patchFromSurface` re-anchors free annotations by their new anchor point. A
note dragged from the page into a space gains `space`, and its y becomes local;
one dragged out loses it. This keeps the round trip exact: converting a
document annotation to the surface and back gives the original.

Results are memoized per annotation object (a `WeakMap` keyed by annotation,
invalidated when the geometry changes). `useStablePageGroups` already keeps
unchanged annotations identical, so a resize re-converts only one page's
annotations.

## Layout analysis

Two new modules:

- `src/components/libera/pdf-space-mask.ts` (DOM).
- `src/lib/pdf-space-layout.ts` (pure, testable on synthetic masks).

### Ink mask

Downsample the page's rendering to a grid of roughly 2 pt cells (about 300×400
for a Letter page) with one GPU `drawImage` into a small canvas, then one
`getImageData`:

- The page background is the most common color along the page border.
- A cell is **ink** when it differs noticeably from the background.

The mask is about 120 KB per page. It's built lazily, only while the Create
space tool is active, the first time a page is hovered, and cached per page
(bounded like `PdfLayoutStore`, 48 pages). It's built from the base canvas or,
on a page that already has spaces, by drawing its pieces back at their
document positions.

Using pixels rather than text runs means figures, vector drawings, equations
and scanned pages all count as content. pdf.js text extraction doesn't see any
of those.

### Bands and columns

A two-level projection XY-cut on the mask:

1. **Horizontal pass.** Find rows of blank cells across the page that are taller
   than about 1.5 body lines (thresholds mirror `verticalCut` and
   `horizontalCut` in `src/lib/pdf-markdown.ts`). They split the page into
   horizontal slabs. Rule lines and running headers stay as thin slabs of
   their own.
2. **Column pass.** In each slab, look for vertical gutters: blank cell columns
   of at least about 9 pt running the slab's full height, with substantial
   content on both sides (the `minSide` rule from `verticalCut`). A slab with
   gutters is a column block, and its `splits` are the gutter midpoints.
   Adjacent slabs with the same gutters merge, so a two-column run interrupted
   only by paragraph gaps becomes one band.
3. **Snapping.** In the chosen column, take the blank row nearest the cursor,
   and place the cut at the middle of that run of blank rows. Search at most
   about two body lines away; with nothing nearby, the cut stays where the
   cursor is, and the hover line turns amber to say it will cut through
   content.

Consistency rules when a space is created:

- If the press lands inside a band already stored on that page, reuse that band
  exactly. Spaces in one block always agree on its columns.
- If the press lands in a single-column slab, or `Alt` is held, the space is
  full-width (zero-height band at the cut).
- Otherwise use the analyzed band, trimmed so it doesn't overlap stored bands.

Deeper layouts are handled as the nearest simpler case. A figure with
sub-columns inside a column is part of that column, and its cut snaps to a
blank row. Text wrapping around a figure is usually seen as one column. Both
cases produce a reasonable, if not perfect, result, and the stored band keeps
it stable.

Budget: under 10 ms per page for mask plus analysis, done once per page per
session, on hover rather than on press.

## Rendering integration

All in `src/components/libera/pdf-viewer.tsx` unless noted.

### Page sizes and scrolling

- `pageLayouts` gains each page's geometry. `height` becomes
  `base.height × (1 + growth) × zoom`. `PdfPageView`'s sheet box uses it.
  `IntersectionObserver` and the render window need no change, because the
  page elements are the same.
- Spaces arrive in the same annotations fetch as today, before the first
  layout, so restoring the saved `scrollTop` already sees the right heights.
- Set `overflow-anchor: none` on the scroll container. Without it, Chromium's
  scroll anchoring may pick a node below the cut and scroll the page during a
  drag, which makes the content above the cut move instead.
- When another window or a sync changes spaces on pages above the viewport,
  keep the reading position by reusing `readPdfZoomAnchor` and
  `restorePdfZoomAnchor` around the update (capture before setting
  annotations, restore in a layout effect). The zoom anchor itself stays
  correct, because displayed proportions don't depend on zoom.

### Raster pieces (`src/components/libera/pdf-raster-pieces.tsx`, new)

- **No spaces (the common case):** the page canvas is shown exactly as today.
  No piece elements, no blits. A test locks this in.
- **With spaces:**
  - pdf.js renders into the page canvas as today, now held off-screen.
  - When the render finishes, each piece gets its own `<canvas>`, sized to its
    rectangle at the same backing resolution, and filled with one `drawImage`.
  - Then the source is released (`width = 0`, as unmount cleanup already
    does). The pieces tile the page, so memory is the same as today.
  - Each piece is absolutely positioned with
    `top: calc((rect.y + shift) × pageHeight)`.
- **A new cut**, which changes `structureKey`, repartitions by blitting from the
  old piece canvases into the new ones. Each new rectangle is covered by old
  ones, so no source is needed.
- **Resizing a space** changes only positions (CSS), never bitmaps.
- **On zoom,** the old pieces stay, stretched through percentage sizes, until
  the new render lands. This is how `usePdfDetailCanvas` already avoids
  flashes.

### Detail canvas (`src/components/libera/use-pdf-detail-canvas.ts`)

At high zoom the page canvas is capped (`PDF_MAX_CANVAS_PIXELS`) and a detail
canvas covers the visible region. With spaces:

- The visible displayed region is mapped back to document rectangles, using the
  pieces that intersect the viewport.
- One pdf.js render covers their union, as today.
- The result is blitted into per-piece detail canvases.

So pdf.js work stays one render per detail update, whatever the number of
pieces. This also needs `pdfDetailRegion` to take the union rectangle.
`visibleElementRect` is unchanged.

### Text layer

pdf.js positions spans with percentages of the text layer box. On a page with
spaces:

- The text layer keeps its document size: `height` set to the document height
  instead of `inset: 0`, and `overflow: visible` in `.pdf-text-layer` (the page
  box still clips).
- After `textLayer.render()`, each span is assigned the piece containing its
  box's top-centre. The span already has `PDF_TEXT_ITEM_ATTRIBUTE` for its
  item index. It gets `translate: 0 var(--pdf-piece-<n>)`.
  - The individual `translate` property composes with the `transform` that
    pdf.js sets on spans, so pdf.js styling is untouched.
- The page content root sets `--pdf-piece-<n>` in pixels for every piece.
  Raster piece canvases use the same variables. Resizing a space therefore
  updates a few custom properties rather than thousands of spans.
- Span assignment reruns only when `structureKey` changes or the text layer
  re-renders.

Because the spans themselves move:

- Find highlights (`highlightPdfMatches`) and `scrollIntoView` work unchanged.
- Selection, `pdfHighlightQuote`, copy and Markdown rebuilding work unchanged,
  because DOM order is unchanged.

### Overlays

`PdfPageContent` computes, per page, `annotationToSurface` for highlights,
comment marks, drawings and notes, and passes those to the existing layers,
with `pageSize` set to the displayed page size. Callbacks go back through the
converters:

| Callback | Conversion |
| --- | --- |
| `addDrawing`, `addTextAnnotation` | `draftFromSurface` (may set `space`) |
| `onUpdateAnnotation` | `patchFromSurface` (re-anchors) |
| `onEraseAnnotations`, `onSelectAnnotation` | ids only, unchanged |
| `selectionPageRects` (highlights and comments) | `rectsFromSurface` per page |
| `selectHighlightAtPoint` | hit-tests the surface copies |
| `captureScreenshotSnip` | snip rect via `toDoc`; a snip across a space shows document content (limitation) |

Also:

- `PdfAnnotationScrollAnchors` (pages outside the render window) receives
  surface copies.
- Scrolling to a comment's passage (`onPdfCommentFocus`) and to an annotation
  from a Markdown link (`scrollTopCenteringRect` in
  `src/lib/annotation-links.ts`) must use the displayed rect. Add a
  geometry-aware variant that `pdf-annotation-events` can call through the
  viewer, instead of computing from document fractions.
- Space outlines and filler hatching render in the new
  `pdf-space-layer.tsx`, below the text layer.

### Live drag

On each `pointermove`, coalesced to one per animation frame:

- Recompute that page's geometry with the dragged space's new height (pure,
  microseconds).
- Write the piece variables and the sheet height.
- Re-render that page's overlays. A page has tens of annotations, so this costs
  a few milliseconds. The `memo` boundaries on `PdfPageView` mean other pages
  don't re-render.

Nothing is saved during the drag. `pointerup` commits once through
`commitAnnotations` with history key `space:<id>`, so a drag is a single undo
step. Auto-grow while typing coalesces under the note's existing
`note:<id>` key.

Budget per frame: under 4 ms of script on a mid-range laptop. No pdf.js render
and no canvas allocation happen during a drag.

## Interaction layer (`src/components/libera/pdf-space-layer.tsx`, new)

Mounted in `PdfPageContent` beside `PdfDrawingLayer`. It's interactive when the
tool is `"space"`, and for space chrome when the tool is `"select"`. It owns:

- **Hover:** requests the page's mask analysis once, then draws the snapped cut
  line in the chosen column.
- **Gesture state:** `{ cut, band, column, startY, height }` in local state.
  It reports live geometry to the page host through a callback that takes the
  draft spaces.
- **Commit:** builds the `PdfSpaceAnnotation` (the id from
  `createAnnotationId`, the `fill` from the mask background) and calls a new
  `onAddSpace`. The viewer's `addSpace` commits the space and an empty note
  with `space` set together, then selects the note for editing. This reuses
  the text tool's `addTextAnnotation` path, which already returns the id it
  selects.
- **Chrome for existing spaces:** outline, bottom grip (resize gesture, same
  pipeline as creation), delete button, keyboard resize and delete when
  selected.
- **Pen input:** in a space, a stylus press is forwarded to `PdfDrawingLayer`'s
  draw gesture, regardless of tool. On stroke end, if the stroke extends below
  the space, the space grows to fit in the same commit.

Deleting a space removes the space and every annotation whose `space` matches,
in one `commitAnnotations` call.

## Other consumers of annotations

| Where | Change |
| --- | --- |
| `src/components/libera/outline-panel.tsx` | Skip `type: "space"` (otherwise it falls through to the highlight label). Notes and ink in spaces list normally. |
| `src/lib/annotation-links.ts` | `annotationLinkLabel` and `annotationAnchorRect` exclude spaces. Anchor rects of annotations in a space go through the viewer's geometry (see Overlays). |
| `src/components/libera/markdown-file-link-popup.tsx`, `use-libera-workspace.ts` | Labels: spaces aren't linkable; notes in spaces are labelled as notes. |
| `src/components/libera/references/citation-hover-card.tsx` | Counts highlights only: no change. |
| `src/lib/search/pdf-highlights.ts` | Indexes highlights only: no change. |
| `src/components/libera/pdf-annotation-events.ts` | No change in payload; listeners that place things on pages use geometry. |
| Collaboration / annotation sync | No change. Spaces travel in the same array; see Compatibility. |

Before phase 1 ships, audit every other place that draws PDF pages or places
things on them by grepping for `pageNumber` together with `getViewport`. Each
must either use the geometry or knowingly ignore spaces.

No API route changes: `/api/pdf-annotations` passes the array to the
normalizer. If a route is touched anyway, read the route-handler guide in
`node_modules/next/dist/docs/` first, as `AGENTS.md` requires.

## Export (`src/lib/pdf-annotation-export.ts`)

`burnPdfAnnotations` keeps pages without spaces exactly as today. For a page
with spaces:

1. Compute the page's geometry from its spaces. The new page is
   `width × height × (1 + growth)` in viewport points (the y-down, rotation-applied
   space the module already uses).
2. **Re-wrap the page in place,** keeping the same page object so outline
   entries, named destinations and links from other pages that point to it
   still resolve:
   - Turn the existing contents into a Form XObject with
     `document.embedPage(page)`.
   - Set new `MediaBox`/`CropBox`.
   - Remove `/Rotate`, because the rotation is applied inside.
   - Replace `Contents` with one stream that, for each piece, saves state,
     clips to the piece's displayed rectangle, applies `shift` together with
     the inverted viewport transform, draws the XObject, and restores.
   - Fill each space with its `fill` color.
   The result is vector, with selectable text and no rasterizing.
3. Burn annotations as today, after converting each to displayed coordinates.
   The burn code then sees a taller page, and notes in spaces render through
   `renderNote` as usual.
4. Remap positions that point into a re-wrapped page:
   - The page's own link annotations (`/Annots` `/Rect`).
   - `/XYZ` destinations targeting the page in outlines, named destinations and
     other pages' links. `/Fit` and `/FitH` need nothing, or only their top
     adjusted.

Spike first (half a day): confirm that pdf-lib's `embedPage` accepts a page of
the same document, and that clipping plus multiple draws of one XObject renders
correctly in pdf.js, Acrobat, Preview and Chrome.

Known limitation: tagged-PDF structure (marked content) on re-wrapped pages is
not preserved, because content inside a Form XObject loses its structure
parent. Untagged pages, and pages without spaces, are unaffected.

## Performance budget

| Situation | Budget | How it's met |
| --- | --- | --- |
| Page without spaces | Identical to today | Identity geometry; no piece elements; asserted in tests. |
| Hover with the tool, first time on a page | ≤ 10 ms once | Downsampled mask, cached. |
| Creating a cut | ≤ 5 ms | Pure geometry and a few blits. |
| Each drag frame | ≤ 4 ms script, 60 fps | CSS variables plus one page's overlays; no pdf.js, no canvas allocation. |
| Zoom with spaces | Same pdf.js work as today plus blits | One render, then repartition. |
| Detail canvas with spaces | One pdf.js render per update | Union render, blitted into pieces. |
| Memory | Same as today | Pieces tile the page; the source is released. |

Check these in a Chromium performance trace on a 30-page two-column paper and
record the numbers in `docs/audits/`, as earlier performance audits did.

## Testing

Unit tests in `scripts/editor/` (`node:test` with `tsx`, run by
`npm run test:editor`):

- `pdf-space-geometry.test.ts`:
  - `shiftAt` and `toView`/`toDoc` round trips, including a randomized
    property test over generated spaces.
  - Pieces tile the page with no gaps or overlaps.
  - Zero-height bands.
  - Stacked spaces at one cut.
  - Fillers snap to their top.
  - Annotation conversion round trips for every annotation type, including
    re-anchoring into and out of a space.
- `pdf-space-layout.test.ts` on synthetic masks:
  - Single column.
  - Two columns.
  - Two columns with a full-width figure between blocks.
  - A header rule.
  - Noise like a scanned page.
  - Dark background.
  - Snapping to the middle of a blank run.
  - The no-blank-row fallback.
  - Reuse of a stored band.
- Extend `pdf-annotations.test.ts`:
  - Normalizing spaces (clamps, overlapping bands, stacking order).
  - Keeping `space` on notes, ink and shapes.
  - Orphaned `space` references.
  - Unknown future types kept verbatim.
- Extend `pdf-annotation-export.test.ts`:
  - The page grows.
  - Contents are wrapped once per piece.
  - Link rects and `/XYZ` destinations are remapped.
  - Pages without spaces are byte-identical in content.
  - A pixel check through pdf.js that the space renders blank.
- Extend `pdf-viewer.test.ts` (jsdom):
  - A page without spaces keeps a single canvas.
  - A spaced page's sheet height.
  - Surface positions of overlays.
  - Selection rects converted to document rects.
  - A drag commits exactly one history entry.
  - Deleting a space removes its annotations, and undo restores them.

Browser checks in the in-app browser against `next dev --webpack`:

- Sample PDFs:
  - A single-column arXiv paper.
  - An IEEE and an ACM two-column paper.
  - A page with a spanning figure mid-page.
  - A rotated page.
  - A scanned PDF.
  - A dark-background slide deck.
- For each: create, resize, delete and undo spaces; type and ink in them; zoom
  in and out; find text across a moved column; copy a passage spanning a
  space; export and open the result.
- Measure drag frame times in the trace.

## Phases

### Phase 0: groundwork (no visible change)

- Types, normalizer support, unknown-type preservation and their tests.
- `pdf-space-geometry.ts` with its full test suite.
- Consumers skip `type: "space"`.

Acceptance: test suite passes. Sidecars containing spaces, written by hand,
load, round-trip through save, and render pages unchanged (the viewer ignores
spaces until phase 1).

Ship this at least one release ahead of phase 1 (see Compatibility).

### Phase 1: full-width spaces end to end

- The tool, hover line, snapping to fully blank rows (mask, horizontal pass
  only).
- Live drag, commit, notes and ink in spaces, resize and delete chrome.
- Undo, sync, scroll anchoring.
- Raster pieces, detail canvas, text-layer shifting, overlay conversion.
- Comment and link scrolling.

Until phase 2, exporting a PDF with spaces shows a notice that spaces are not
exported yet, and leaves out annotations inside spaces. It never misplaces
them.

Acceptance:

- On single-column papers, every behavior under
  [Product behavior](#product-behavior) works except column scoping.
- Pages without spaces are provably unchanged.
- The drag budget is met.

### Phase 2: vector export

- The spike, then re-wrapping, annotation burning in displayed coordinates and
  link/destination remapping.

Acceptance: exported PDFs match the viewer in pdf.js, Acrobat, Preview and
Chrome; tests above pass.

### Phase 3: multi-column spaces

- Column pass of the analysis, band merging and reuse, column-scoped gestures.
- Filler hatching and snapping, `Alt` for full-width.

Acceptance: on the sample two-column papers, a space opens only in its column,
content below the block moves by the block's growth, and existing highlights
and comments in both columns stay on their text.

### Phase 4: polish

- Auto-grow while typing and inking.
- Background fill, keyboard resize.
- Accessibility (spaces announced as "Inserted space, n lines"; the delete
  button and grip are focusable).
- The performance audit document.
- A `docs/features/create-space.md` user and maintainer page.

## Risks and open questions

- **Filler can't hold annotations.** This is simple and predictable, but a
  reader may want to write in the blank space beside a long column. If that
  turns out to matter, a later version could let a filler become a real space
  on click.
- **Full-width spaces inside a column block.** Phase 3 uses `Alt` to force
  full-width only outside blocks. A full-width cut through a block would mean
  splitting its stored band; leave this out unless readers ask for it.
- **Annotations made before a space, crossing its cut.** A stroke or note that
  straddles a new cut moves rigidly with its top and may overlap the space.
  This is the right default (strokes never stretch), but it should be
  documented.
- **pdf.js text layer internals.** The plan relies on pdf.js not setting the
  `translate` property on spans and on percentage positioning. Pin this with a
  test on the installed `pdfjs-dist` 4.10 and recheck on upgrades.
- **Older builds deleting spaces.** Mitigated by phase 0 shipping first. The
  collaboration docs should note the minimum version for spaces.
- **Snipping across a space** shows document content without the space. This
  is acceptable for v1; a later version could composite pieces into the snip.
- **Tagged-PDF structure is lost on exported pages with spaces.** Documented
  limitation.
