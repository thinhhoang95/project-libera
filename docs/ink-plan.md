# Ink implementation plan

Status (2026-10-25): open questions settled (see [Decisions](#decisions)).
**Phase 0 is done**, with no visible change:

- the ink core in `src/lib/ink/`;
- `_ink` storage in `src/lib/storage/ink.ts`, wired into `files.ts`, `tree.ts`
  and `shared-writes.ts`;
- `/api/ink`;
- the emulated-pen harness.

Tests are `scripts/editor/ink-core.test.ts`, `ink-storage.test.ts` and
`ink-pen.test.ts`. See [Phase 0 findings](#phase-0-findings). Phases 1–4 are
not started.

Ink lets a reader write and draw with a stylus (or a mouse or finger) on PDFs,
in Markdown notes, both between paragraphs and on top of the text, and on
photos, both notebook images and gallery photos. Ink is never written into the
document itself. It lives in side-car files, like highlights and notes, which
sync with shared notebooks. It is flattened only when the reader exports.

One ink engine serves every surface. Each surface supplies three things: a
coordinate space, a place on screen, and a store. The tools, rendering, input
handling and file format are shared.

## What exists today

- **PDF pen, shapes and eraser:** `src/components/libera/pdf-drawing-layer.tsx`,
  with geometry in `src/lib/pdf-drawing.ts`.
  - Strokes are `PdfInkAnnotation` (`src/lib/types.ts:67`): page-fraction
    points, a color, and one width in PDF points. They are stored in the PDF's
    annotations side-car with highlights, notes, shapes and spaces.
  - Every stroke is one SVG `<path>`. The live stroke is React state, so the
    layer re-renders on every pointer move.
  - It reads coalesced events but no pressure, tilt or `pointerType`. A finger
    draws exactly like the pen, and nothing rejects a resting palm.
  - The whole annotation array is sent and rewritten 350 ms after each change
    (`use-annotation-writer.ts`). On a heavily annotated PDF, each stroke
    rewrites every highlight and note too.
  - Export writes ink as stroked vector paths (`pdf-annotation-export.ts:309`).
  - Create Space anchors ink to spaces through `space`. Its open item, "a
    stylus drawing in a space whatever the tool", is still open.
- **Notebook images:** text notes only. They have a per-image side-car in
  `.libera/annotations/image/by-path/` that follows moves (`files.ts`), plus a
  debounced writer and cross-window sync. Image edits are always saved as an
  `(edited)` copy.
- **Gallery photos:** edits (rotate, flip, crop, filter, adjustments) are
  *baked* into the file by sharp (`gallery.ts:766`). The editor always opens at
  `NO_EDITS`, and only the original is backed up. Photos are keyed by UUID in
  `.libera-gallery.json`. Shared albums match photos by file name and record
  edit settings on the host.
- **Markdown:** custom blocks round-trip as fenced code blocks or as images with
  recognizable file names (Python figures). Each note's assets live in
  `_assets/<note>/`, which shared notebooks sync. `.libera/` is never shared.

## Goals and non-goals

Goals:

- **Feels like paper:** ink appears under the nib within one frame of the
  pointer event, and pressure shapes the line.
- **Common tools everywhere:** pen, marker, highlighter, stroke eraser and
  partial eraser. Each has adjustable tip width, color, line style
  (solid/dashed/dotted) and opacity, with saved pen presets.
- **Stylus-aware input:** the pen draws, fingers scroll and zoom, a resting
  palm is ignored, and the pen's eraser end erases.
- **Non-destructive:** source files are never changed. Ink is in side-cars and
  follows renames, moves, copies and deletes as other side-cars do.
- **Fast with thousands of strokes per page**, and the cost of each save does
  not grow with how much ink the document already has.
- **Energy-efficient:** nothing runs while the pen is idle, React never
  re-renders per pen sample, and saves are batched.

Non-goals for this foundation (possible later):

- Handwriting recognition or ink-to-text. The format keeps sample timing so it
  can be added later.
- Live co-drawing. A collaborator's strokes appear when their ink file syncs,
  after their save, not while they draw.
- Ink over text in Markdown *source* mode (CodeMirror). Overlay ink is shown
  and drawn in the rich editor only.
- Shapes. The existing PDF shape tool stays as it is.

## Key decisions

1. **Canvas, not SVG, for strokes.** Every surface draws strokes on two
   canvases:
   - a *committed* canvas, redrawn only when strokes change or zoom settles;
   - a *live* canvas, `desynchronized: true` for low latency, holding only the
     stroke being drawn.

   SVG stays for selection frames, handles and shapes. With thousands of
   strokes, SVG costs DOM size, style recalculation and hit-testing on every
   scroll.
2. **Imperative input path.** Pointer samples go into refs and are drawn
   directly. React state changes only when a stroke is committed or erased,
   or when a tool changes.
3. **Strokes are immutable.** Editing a stroke replaces it with the same id;
   erasing removes it, or splits it into new strokes. This makes saving,
   cross-window sync and undo operations instead of whole-state snapshots.
4. **Save operations, not arrays.** Writes are
   `{ add, remove, replace }` operations applied on the server under the
   side-car lock. Writes are also per chunk: PDF ink is one file per page, so
   a stroke on page 40 never rewrites page 3.
5. **Raw samples on disk, geometry computed at render.** Libera stores the
   points with pressure (and tilt and time), not the outline polygon, so
   brushes can improve without migration. Outlines are cached per stroke as
   `Path2D` in surface units.
6. **One compact, versioned format.** Each point is quantized to fixed point,
   delta-encoded and packed as varints into base64 inside a small JSON
   envelope. This is about 5–7 bytes per sample instead of about 40 as JSON
   objects. It stays valid JSON for existing atomic-write, recovery and sync
   code. The format is `libera-ink`, version 1.
7. **Freehand ink moves to the new engine; shapes stay.** New strokes go to ink
   side-cars. Existing `PdfInkAnnotation`s are rendered by the new engine and
   migrated on a document's first ink write, keeping a `.migrated-<id>` copy as
   other migrations do.
8. **Ink lives where shared notebooks sync it.** Stroke data for any notebook
   file is kept in a hidden-from-tree `_ink/` folder, not in `.libera/`, which
   is never shared. The collab host shares it as it does `_assets/`, and
   OneDrive-style sync carries it as it carries everything else.
9. **Each author writes only their own files.** "Author" means one user on one
   computer. A chunk is the union of every author's file for it: their strokes,
   minus the strokes any author erased. Erasing someone else's stroke records
   its id in your own file.
   - No two writers ever write the same file, so nothing is lost whether files
     arrive through the collab host (whole-file blobs) or through a sync client.
   - No protocol or host changes are needed.
10. **Pressure outlines come from `perfect-freehand`** (MIT, about 5 KB, no
    dependencies), pinned to an exact version. Libera adds the highlighter,
    dashes, caching and simplification around it.
11. **Pen input is tested by emulation first.** There is no stylus hardware
    yet. The input layer is designed not to depend on how a given device treats
    `touch-action` (see Input), and is tested with emulated pen events that
    carry pressure and tilt. Tuning on real devices waits for hardware.

## Data model (`src/lib/ink/types.ts`, new, pure)

```ts
type InkBrush = "pen" | "marker" | "highlighter";
type InkLineStyle = "solid" | "dashed" | "dotted";

type InkStroke = {
  id: string;
  brush: InkBrush;
  color: `#${string}`;
  opacity: number;          // 0–1; highlighter defaults to about 0.35
  width: number;            // nominal tip width in surface units
  lineStyle: InkLineStyle;  // dashed/dotted draw at constant width
  /** Packed samples: x, y in surface units, pressure 0–1, optional tilt and dt. */
  points: string;           // base64 varint deltas, see codec
  bounds: { x: number; y: number; width: number; height: number };
  /** Where the stroke sits, for surfaces with sub-areas (a PDF space). */
  anchor?: { space?: string };
  /** For overlay ink on note text: the anchored group it belongs to. */
  group?: string;
  createdAt: string;
};

/** One author's file for one chunk. */
type InkAuthorFile = {
  format: "libera-ink";
  version: 1;
  author: { key: string; name?: string };
  /** Size and SHA-256 of the PDF or image, for reconciliation (see Storage). */
  source?: { size: number; sha256: string };
  /** Units, size and orientation of the surface this chunk's strokes use. */
  frame: InkFrame;
  strokes: InkStroke[];
  /** Ids of strokes this author erased, their own or anyone's. */
  erased: string[];
  /** Overlay ink only: text anchors of this author's groups (below). */
  groups?: InkTextGroup[];
  /** Bumped on each write of this file. */
  revision: number;
};
```

**Author key.** This is a random id per user and computer, created on first ink.
It is kept in `ink-author.json` beside the user's Libera config
(`LIBERA_CONFIG_PATH`), never in the master directory, which may sync to the
same person's other computers. It holds no name, email or account id. A merged
chunk is computed by `mergeInkFiles`:

- **Strokes:** the union of all authors' strokes, minus the union of all their
  `erased` ids.
- **Moving a stroke** (lasso) that belongs to someone else erases it and adds a
  copy with a new id to your own file.
- **Tombstones** are ids only, about 12 bytes each. An author file drops a
  tombstone once the stroke it erases is gone from every other file.

**Surface units.** Units are uniform in x and y, so a circle stays round and
widths mean the same in every direction.

| Surface | Unit | Origin | Chunk |
| --- | --- | --- | --- |
| PDF page | PDF point, unrotated page box | top-left of the page, or of the `space` | one per page |
| Markdown ink block | logical px of the block at 100% width (default 720 wide) | block top-left | one per block |
| Markdown text overlay | logical px at 100% editor zoom | the group's anchor character | one per note |
| Notebook image | pixel of the file, EXIF upright | top-left | one per image |
| Gallery photo | pixel of the **original** photo, EXIF upright | top-left | one per photo |

PDF points replace page fractions for new ink. Fractions stretch x and y
differently on non-square pages, so a pressure outline would be skewed.

**Tip width.** Width is chosen as an on-screen size, as in other note apps, and
converted to surface units when the stroke starts. Ink drawn while zoomed in is
therefore finer on the page. Presets per brush (in pt at 100%): pen
0.35/0.5/0.7/1/1.5/2.5, marker 1/2/4/6, highlighter 8/12/18. A slider covers
values between presets.

### Codec (`src/lib/ink/codec.ts`)

Each sample is quantized:

- x and y in 1/20 unit (0.05 pt ≈ 0.018 mm on PDFs);
- pressure as 8 bits;
- tilt (optional) as 8 bits for each axis;
- dt in ms (optional).

Samples are delta-encoded per field, zig-zag encoded and LEB128-packed, then
base64-encoded. A header byte records which optional fields are present.

`normalizeInkChunk` validates the input and drops malformed strokes without
failing the chunk. It also keeps unknown fields and brushes from newer versions,
as `withPreservedUnknowns` does for annotations, so an older Libera does not
destroy a newer Libera's ink.

## Storage (`src/lib/storage/ink.ts`, new)

**Notebook files.** The ink of a notebook file is in
`<notebook>/_ink/<folders>/<file name>/`, mirroring the file's path with its
extension, as Python side-cars use `_assets/<folders>/<note.md>/`. Each chunk
has one file per author, named `<chunk>.<author key>.ink`:

| Surface | Chunk files, e.g. |
| --- | --- |
| PDF | `_ink/Papers/attention.pdf/page-0001.k3f9q2.ink` |
| Markdown ink block | `_ink/Notes/Lecture 3.md/block-7f3c2a.k3f9q2.ink`, with its rendering in `_assets/Notes/Lecture 3/ink-7f3c2a.svg` |
| Markdown text overlay | `_ink/Notes/Lecture 3.md/text.k3f9q2.ink` |
| Notebook image | `_ink/Trips/map.png/image.k3f9q2.ink` |

- **Hidden folder.** `_ink` is hidden from the tree, search and file pickers as
  `_assets` is (`tree.ts:62`). The `.ink` extension is not in
  `TEXT_DOC_EXTENSIONS`, so the collab host syncs each file as a whole-file
  blob. That is safe because only its author writes it.
- **Following the file.** The `_ink/<file>/` folder follows the file through
  rename, move, copy, archive and delete in `files.ts`, at the sites listed for
  Python side-cars. Shared notebooks get the same in `moveSharedFile` and
  `deleteSharedFile` (`shared-writes.ts:478-528`). Those functions don't move
  Python side-cars today, which should be fixed at the same time.
  - **Copies** keep every author's files.
  - **Deleting the file in Libera** deletes its ink, as it deletes the file's
    annotations and other side-cars.
  - **Files deleted outside Libera** have their ink set aside in
    `.libera/orphaned-sidecars/ink/`, and it is put back if the file returns.
- **External renames.** Each author file records the size and SHA-256 of its
  PDF or image, so ink finds a PDF renamed outside Libera by its bytes, as
  other PDF side-cars do (`pdf-sidecars.ts`, a new `"ink"` kind that moves a
  folder).
- **Shared notebooks.** Writes go through `writeSharedBlob`, as image uploads
  do (`shared-writes.ts:628`). `assertNotSharedItem` refuses local writes there
  today.
- **Collaborators' changes.** When the host reports changed files under
  `_ink/` (tree-changed events), open viewers reload just those chunks. A sync
  client's changes are picked up on focus and library refresh.

**Gallery photos.** Ink is in `gallery/.libera-ink/<photoId>/photo.<author>.ink`,
keyed by the photo's id, so it follows moves within the gallery.
`copyRecordInto` and archive moves copy or move it. Shared albums get it in
phase 4 as album blobs, like `edits` and `caption`. Top-level dotfiles do not
sync by themselves.

Notes:

- **Writes** apply `{ add, erase }` operations to *this author's* file for a
  chunk, through `writeJsonAtomically` under a per-file lock. Other authors'
  files are only read.
- **API:** `GET/PATCH /api/ink?path=…&chunk=…`, with `requireAuth` and
  `toStorageError` as in `image-annotations/route.ts`.
  - `GET` returns the merged chunk.
  - For PDFs, `GET` takes a page range, so the viewer loads ink only for
    pages near the viewport.
- **Client writer** (`use-ink-writer.ts`): built on `createDeferredSave` with a
  1.5 s idle debounce, about 4× fewer wakeups than 350 ms during steady
  writing. It flushes on blur, on tab close, and through `registerStateFlusher`
  on quit and user switch. Cross-window updates go over a broadcast channel, as
  `annotation-sync.ts` does.
- **Asset cleanup:** `cleanupMarkdownImageAssets` must keep `ink-*.svg`
  renderings that a note still references, as it keeps Python figures. When a
  block is deleted from the note, its `_ink` chunk files go with its
  rendering.

## Rendering engine (`src/components/libera/ink/`, new)

```
InkSurface (one per page / block / photo)
├─ committed <canvas>   strokes, redrawn on change or zoom settle only
├─ live <canvas>        desynchronized; current stroke + predicted tail
└─ <svg> overlay        hover cursor, lasso, selection frame
```

**Geometry** (`src/lib/ink/geometry.ts`):

- **Pen outline:** `perfect-freehand`'s `getStroke`, a pressure-driven
  polygon with streamlining, thinning by pressure and velocity, round caps and
  a tapered start and end. Its options are set per brush in `tools.ts`.
- **Marker:** the same outline at constant width.
- **Highlighter:** constant width with a flat, chisel-like cap. It is drawn
  with `multiply` blending into its own canvas under the pen canvas, so
  overlapping passes do not darken and text stays legible, as PDF highlights
  already behave.
- **Dashed and dotted lines:** a stroked centerline with `setLineDash` scaled
  to the width, at constant width. Pressure is ignored for these styles.
- **On commit:** strokes are simplified with Ramer–Douglas–Peucker at a
  tolerance below one device pixel at 100% zoom. This typically removes 40–70%
  of samples without a visible change.

**Committed layer:**

- **Path2D cache:** each stroke's `Path2D` is built once in surface units and
  drawn under `setTransform(scale·dpr)`, so zooming never recomputes geometry.
- **Adding:** a new stroke is drawn *on top of* the existing bitmap, so nothing
  is redrawn. Erasing redraws only the dirty rectangle, clipped, using strokes
  found through a uniform-grid spatial index (`spatial-index.ts`).
- **Zooming:** the bitmap is scaled with CSS and re-rasterized once the zoom
  has been still for 150 ms. Its size is capped, as `use-pdf-detail-canvas.ts`
  caps the PDF detail canvas.
- **Off-screen surfaces:** surfaces outside the viewport (IntersectionObserver
  with a one-screen margin) release their canvases, then repaint from the
  cache when they return.

**Live layer:**

- A requestAnimationFrame loop runs only while a pointer is down.
- Each frame draws the stroke so far, plus the stroke's
  `getPredictedEvents()` points as a provisional tail that is replaced the
  next frame. Prediction hides about one frame of latency.
- On pointer up, the finished stroke is drawn into the committed canvas and
  the live canvas is cleared.

**Energy:**

- With no pen down, nothing runs: no animation frames, timers or polling. A
  hidden window does nothing at all.
- `pointerrawupdate` is not used. It roughly doubles the wakeups for little
  visible gain. It could be offered as an opt-in "lowest latency" mode.
- When on battery (Electron `powerMonitor.isOnBatteryPower()`, sent to the
  renderer), Libera turns prediction off and caps the raster DPR at 2.
- Saves are batched and per chunk (see Storage).

**Export:**

- **PDF:** the PDF export draws filled outline paths with pdf-lib, so
  pressure, dashes and highlighter opacity are kept as vectors.
  - `inkOps` is replaced, and legacy strokes keep their current look.
  - A later option can write real `/Ink` annotations for other readers to edit.
- **Photos:** "Export with ink" uses sharp to composite an SVG made from the
  outlines, after all color steps, so ink is not color graded. The photo is
  untouched unless the reader picks "Flatten ink into photo".
- **Markdown:** the block's SVG rendering (below) is what PDF/LaTeX export and
  other Markdown apps show.

## Input (`src/components/libera/ink/ink-input.ts`)

- **Pointer types:**
  - `pen` draws with the current tool.
  - `touch` scrolls and pinch-zooms. A "Draw with finger" setting can make it
    draw instead.
  - `mouse` draws when an ink tool is chosen, with simulated pressure from
    velocity.
- **Palm rejection:** while a pen is in range (pen `pointerover` /
  `pointermove` with no buttons) and for 500 ms after, touches are ignored.
  When a pen starts a stroke, any touch-started stroke is cancelled.
- **Eraser end and barrel button:** `buttons & 32` (and the eraser-end pointer
  on Windows Ink) erases while held, whatever the tool.
- **Stylus anywhere:** a "Pen always draws" setting, on by default when a pen
  has been seen. With it, a pen draws even when the viewer is in Select or
  Text mode, which closes Create Space's open item.
- **Hover preview:** a ring the size and color of the tip follows the hovering
  pen.
- **Samples:** Libera reads `getCoalescedEvents()` (as today), plus
  `pressure`, `tiltX`/`tiltY` and `timeStamp`. Samples are kept by the
  existing `shouldKeepSample` distance rule.
- **Libera handles finger scrolling itself on ink surfaces.** How a pen
  interacts with `touch-action` differs between devices and drivers, and
  there is no hardware to check yet. So:
  - While an ink tool is on, or a pen has been seen with "Pen always draws",
    the surface sets `touch-action: none`.
  - `ink-input.ts` forwards one-finger pans to the scroll container, with
    inertia, and two-finger pinches to the viewer's zoom.
  - With no ink tool on and no pen seen, the browser scrolls as it does today.

  This behaves the same on every device. It can be relaxed later where a
  device proves the browser can do it.
- **Emulated pen for tests.** The Chrome DevTools Protocol's
  `Input.dispatchMouseEvent` takes `pointerType: "pen"` with `force`, `tiltX`,
  `tiltY` and `twist`. A test harness drives it through Electron's
  `webContents.debugger`, or against the dev server in a browser. It covers
  drawing, pressure, the eraser button, palm rejection with emulated touches
  (`Input.dispatchTouchEvent`), finger panning and latency timing.

## Tools and toolbar (`ink-toolbar.tsx`, `src/lib/ink/tools.ts`)

- **Pen, Marker, Highlighter.** Each has width presets plus a slider, a color
  (the existing `PDF_INK_COLORS` and highlight swatches, a custom picker and
  six recent colors), a line style and an opacity.
- **Eraser.** It has two modes:
  - **Stroke** removes any stroke it touches. This is today's behavior,
    including PDF text markup.
  - **Partial** cuts strokes where the eraser circle crosses them
    (`splitStrokeByCircle` in geometry), leaving new strokes for the remaining
    pieces.

  The eraser radius is adjustable. Each eraser drag is one undo step, as
  today.
- **Lasso (phase 4).** It selects strokes to move, recolor, restyle, delete,
  copy or paste. It replaces drag-to-move for ink in Select mode.
- **Pen presets.** The toolbox keeps up to eight pens (brush, width, color,
  style) per user. Presets are stored in that user's preferences, so they
  follow user switching. All surfaces share them.
- **Undo and redo.** Each surface has a command stack of add, remove, replace
  and split operations. In Markdown, an ink block has its own stack while it
  has focus. Otherwise, inserting or deleting a block is a ProseMirror
  transaction.
- **Shortcuts:** `P` pen, `M` marker, `H` highlighter, `E` eraser (press again
  for partial), `[` and `]` for width. Every tool is also in the command
  palette, as the PDF tools are.

## Surface integrations

### PDF (`pdf-viewer.tsx`, `pdf-drawing-layer.tsx`)

- One `InkSurface` per rendered page, in the page frame below the text layer
  while drawing and above it otherwise. Its frame is the page box in points.
  Spaces become anchors: their ink's y is measured from the space top, as
  today.
- The existing Draw tool becomes the ink toolbox, and `PdfDrawingLayer` keeps
  shapes, selection and markup erasing.
- **Legacy `ink` annotations:**
  - They are converted in memory to the new format: fractions become points,
    and pressure is a constant 0.5.
  - They are written to the ink side-car on the document's first ink write and
    removed from the annotations side-car, which is kept as a `.migrated-<id>`
    copy.
  - Search, the annotations panel and the Markdown export of annotations
    (`pdf-annotation-markdown.ts`) are checked for ink consumers.

### Markdown (TipTap)

- A new block node, `inkBlock`, with attrs `{ id, width, height }`. It is a
  React NodeView hosting an `InkSurface`, with `stopEvent` for pointer input
  and `ignoreMutation`, as the Python figure view does.
- **In the note, it is an image of its own rendering:**

  ```markdown
  ![Ink](_assets/Notes/Lecture 3.md/ink-7f3c2a.svg)
  ```

  - The NodeView recognizes the `ink-` prefix, as `parsePythonFigureSource`
    recognizes Python figures, and loads the stroke data from the
    `_ink/Notes/Lecture 3.md/block-7f3c2a.*.ink` author files.
  - The SVG is regenerated when the block loses focus (not per stroke), so
    other Markdown apps, previews, slides and PDF export show the ink with no
    special support.
- **Inserting:** a toolbar button, `/ink` in the slash menu, or a pen-down in
  the note's empty margin after the last block. The block grows downward
  when the pen nears its bottom edge, and can be resized with a grip.
- **Collab:** `nodeMatchesBlock` (`tiptap-blocks.ts`) needs a case for the
  node. The block is a plain image in Y.Text, so text sync is unchanged.

### Markdown: ink over text (`tiptap-ink-overlay.tsx`, `src/lib/ink/text-anchors.ts`)

Ink drawn on a note's text circles, underlines and annotates the words, and
follows them when the note reflows: typing above, a wider window, another
font size, or a collaborator's edit.

- **Groups.** Strokes drawn within 1.5 s of each other, and near each other,
  form a group. A group moves rigidly, so a circle and its arrow stay together.
- **Anchors.** Each group is anchored to the character under its bounds' top
  left, or the nearest character in that line. Its strokes are stored as
  offsets from that character's box, in px at 100% zoom, so they scale with
  the editor's zoom and font size.
  - **On disk,** the anchor is a text quote: the anchored words, about 32
    characters of prefix and suffix, and a block index hint. This works like
    PDF highlight quotes (`pdf-highlight-quote.ts`), so it survives edits made
    in another app or by a collaborator.
  - **While the note is open,** each anchor is a ProseMirror position mapped
    through every transaction, including the ones the Y.Text binding applies.
    Libera resolves the quotes once on load and writes them back on save.
- **Rendering.**
  - Each group is one small canvas, positioned absolutely in the editor's
    content box and cached as a bitmap.
  - Reflow then costs a CSS translate per visible group. After a
    transaction, `coordsAtPos` runs once per animation frame, only for groups
    near the viewport.
  - Groups away from the viewport release their canvases, as surfaces do.
  - The live stroke uses one viewport-sized live canvas over the editor.
- **Drawing on text.**
  - With "Pen always draws", or in the editor's Ink mode, a pen stroke over
    text becomes overlay ink and leaves the selection alone.
  - A pen tap shorter than 4 px and 200 ms places the caret instead.
  - A mouse or finger keeps editing text unless Ink mode is on.
- **Detached ink.** If the anchored words are deleted, the group is drawn
  faded at its last position, and listed in the outline panel as detached ink
  with Delete and Re-anchor. Ink is never dropped silently.
- **Known limit.** A group that spans a line break, such as an underline
  across two lines, moves as one piece. It does not split when the words
  rewrap.
- **Export.** Libera's preview, PDF export and slides place each group's SVG at
  its anchor. Other Markdown apps don't show overlay ink, since Markdown has
  no way to express it, unlike ink blocks.

### Notebook images (`image-viewer.tsx`)

- An ink tool joins `"select" | "text"`. The `InkSurface` sits in
  `imageFrameRef` beside `TextAnnotationLayer`, in image pixels.
- Edits already save as an `(edited)` copy, so ink keeps matching its file.
  The copy can optionally take the ink along.

### Gallery photos (`photo-viewer.tsx`, `photo-editor.tsx`, `gallery.ts`)

- **Strokes stay put through edits.** Strokes are stored on the **original**
  photo. The side-car also stores a `view` of `{ rotate, flipH, flipV, crop }`
  describing how the current file is derived from that original.
  - When `editPhoto` bakes an edit in place, the edit's geometric part is
    composed into `view` in the same operation, so strokes stay where they
    were drawn. Ink that is cropped out is kept, and reappears on revert.
  - `revertPhoto` resets `view`.
  - "Save as copy" copies the side-car with the composed `view`.
  - New strokes are mapped back through the inverse of `view`.
- **The original's identity** is recorded. If the file changes outside
  Libera, the ink is shown dimmed with "This photo changed since it was inked",
  and the reader can keep or discard it.
- **Rendering:** the overlay sits in `PhotoOverlay`'s measured image box and
  stops pointer events from reaching the panning stage, as `onPick` does.
  Ink is drawn above color edits.
- **Saving in the photo editor never flattens ink.** Ink stays a layer,
  remapped through the edit. Flattening is only ever a deliberate "Export with
  ink" or "Flatten ink into photo".
- **Shared albums (phase 4):** each author's ink file is sent as its own blob
  in the album manifest, like `edits` and `caption`. Top-level dotfiles do not
  sync by themselves.

## Module layout

```
src/lib/ink/
  types.ts           strokes, author files, frames, brushes
  codec.ts           pack/unpack, normalize, version handling
  merge.ts           union of author files minus erased ids; tombstone pruning
  authors.ts         author key creation and lookup
  geometry.ts        perfect-freehand outlines, dashes, RDP, bounds, hit tests, split
  spatial-index.ts   uniform grid over stroke bounds
  frame.ts           surface units ↔ CSS px; photo view composition and inverse
  text-anchors.ts    stroke grouping, quote anchors, resolving and re-anchoring
  history.ts         operation-based undo/redo
  tools.ts           brush defaults, width presets, preset validation
  svg.ts             strokes → SVG (Markdown renderings, overlay export, photo export)
src/lib/storage/ink.ts           _ink paths, per-author writes, follow/orphan, migration
src/app/api/ink/route.ts
src/components/libera/ink/
  ink-surface.tsx    canvases, overlay, lifecycle
  ink-renderer.ts    committed/live drawing, dirty rects, raster caps
  ink-input.ts       pointer routing, palm rejection, prediction
  ink-toolbar.tsx    tools, widths, colors, styles, presets
  use-ink-document.ts  load by chunk, apply ops, broadcast, undo
  use-ink-writer.ts
  tiptap-ink-block.tsx
  tiptap-ink-overlay.tsx   overlay groups over the rich editor
scripts/editor/ink-pen-harness.ts  emulated pen and touch input over CDP
```

## Performance budget

| Measure | Target |
| --- | --- |
| Pen sample → pixels on screen | ≤ 1 frame after the event (plus prediction) |
| React renders per pen sample | 0 |
| Commit a stroke on a page with 5,000 strokes | < 2 ms main thread |
| Full redraw of that page at 2× DPR | < 16 ms |
| Partial erase over a dense area | < 4 ms per pointer event |
| Save after a stroke | only that chunk; < 50 KB typical |
| CPU while idle with ink on screen | ~0%: no timers or animation frames |
| Disk per minute of steady handwriting | ~40 KB |

A benchmark script (`scripts/editor/ink-bench.ts`) renders synthetic pages in
jsdom and canvas, and checks codec size and throughput. Its numbers go in
this file.

## Testing

All tests use `node --test` with tsx, in `scripts/editor/`, as other editor
tests do.

- **Codec:** fast-check round-trip tests within the quantization error.
  Tests also cover rejection of corrupt input and keeping unknown fields.
- **Geometry:** outlines are well formed for one sample, two samples and
  self-crossing strokes. Partial erase keeps every sample outside the circle.
  RDP stays within its error bound.
- **Frames:** photo `view` composition and inverse (property tests against
  `rotateCrop*`/`flipCrop`), and PDF page rotation.
- **Merge:** fast-check property tests check that merging author files is
  commutative and idempotent. Erasing another author's stroke hides it
  everywhere, tombstones are pruned only when safe, and two windows of one
  author never lose a stroke.
- **Storage:** renames, moves, copies and deletes take `_ink/<file>/` along,
  locally and in shared notebooks. Orphans are set aside, and legacy PDF ink
  migrates into the local author's files.
- **Markdown blocks:** `inkBlock` round-trips through `getMarkdown()`, survives
  `bindTiptapToYText`, and asset cleanup keeps referenced renderings.
- **Text anchors:** groups follow their words through typing above them,
  rewrapping, zoom and remote Y.Text edits. Quotes resolve after edits made
  outside Libera, and deleted words leave detached ink, not lost ink.
- **Emulated pen** (`ink-pen-harness.ts`, run against Electron): checks
  pressure reaching the outline, the eraser button, palm rejection, finger
  panning and pinch on ink surfaces, the pen tap that places the caret, and
  event-to-pixel latency.
- **Hardware pass:** none is possible yet. Pressure curves, prediction and
  palm-rejection timings stay provisional until a device is available.
  Planned devices:
  - Surface Pen on Windows (Windows Ink);
  - a Wacom tablet on Windows and macOS;
  - Sidecar or Apple Pencil on macOS;
  - a touchscreen with no pen.

  Mouse and trackpad are tested now.

## Phases

### Phase 0: ink core (no visible change), done

- Add `perfect-freehand`, pinned to an exact version (1.2.3).
- Add `src/lib/ink/*` and its tests: types, codec, author merge, geometry,
  spatial index, frames, history and SVG output.
- Add `_ink` storage and the API: per-author writes, the hidden folder, the
  `files.ts` and shared-notebook follow wiring, and PDF reconciliation.
- Build the emulated-pen harness, and use it to check pen pointer events,
  pressure and tilt, and `desynchronized` canvas support in Electron 37.

### Phase 1: PDFs end to end

- Build `InkSurface`, the input layer and the toolbox: pen, marker,
  highlighter, both erasers, widths, colors, line styles and presets.
- Replace freehand drawing in the PDF viewer and migrate legacy ink.
- Add vector export, stylus-anywhere and spaces.
- Ship a feature doc at `docs/features/ink.md`.

### Phase 2: Markdown ink blocks

- Add the `inkBlock` node, the `.ink` and `.svg` assets, and the insert
  gestures.
- Add shared-notebook writes and moves, asset-cleanup exemptions, and collab
  block matching.

### Phase 2b: ink over note text

- Add stroke grouping, quote anchors mapped through transactions, and group
  canvases over the editor.
- Add Ink mode, the pen tap that places the caret, the detached-ink list,
  and overlay ink in preview, PDF export and slides.

### Phase 3: photos

- Add ink to notebook images in `ImageViewer`.
- Add ink to gallery photos, with the `view` composed in edit, revert and copy,
  "Export with ink" and "Flatten ink into photo".

### Phase 4: polish

- Add the lasso (move, recolor, copy).
- Sync ink in shared albums.
- Tune pressure, prediction and palm rejection on real hardware.
- Write real `/Ink` annotations in PDF export.
- Add a lowest-latency mode.
- Move re-rasterizing of very dense pages to an OffscreenCanvas worker, if the
  benchmark shows it is needed.

## Phase 0 findings

**What the emulated pen showed** (Electron 37.6, Chromium 138, Windows):

- **Pen input:**
  - Pressure and tilt reach pointer events unchanged, for every sample,
    including samples coalesced into one event per frame.
  - A hovering pen sends `pointermove` with `buttons: 0`, so a pen is seen
    before it touches.
- **APIs:**
  - `getCoalescedEvents` exists only in secure contexts. The app's
    `http://127.0.0.1` origin is one; a `data:` page is not.
  - `getPredictedEvents` and `pointerrawupdate` exist.
  - A `desynchronized` 2D canvas is granted.
- **Panning:**
  - On a `touch-action: none` surface, fingers arrive as touch pointers and
    are never cancelled, so panning is up to `ink-input`.
  - On a `touch-action: auto` panel, both a finger *and the pen* scroll it.

  So an ink surface must switch to `touch-action: none` when a pen starts
  hovering, before it touches, or the pen scrolls instead of drawing.
- **Palms:** a resting palm and a pen stroke arrive as separate pointers. Both
  are delivered, so rejecting the palm is `ink-input`'s job.
- **Not testable by emulation:**
  - The pen's eraser button: CDP sends `buttons: 32` as an ordinary press.
  - Real pressure curves.
  - How a real Windows Ink pen interacts with `touch-action`.
- **Harness quirk:** for about 0.7 s after a page loads, emulated presses are
  dropped while moves get through. The harness taps until a press arrives.

**Left for later phases:**

- Copying a file *into* a shared notebook does not bring its ink yet.
- Saving an edited image copy doesn't offer to take ink along.
- Gallery-photo ink storage is phase 3.
- Migrating legacy PDF ink is phase 1.
- Shared-notebook ink moves and deletes are wired, but they are only covered by
  the existing shared-notebook tests, not by an ink-specific test with a live
  host.
- `_ink` is now a reserved name and hidden from the tree. An existing user
  folder called `_ink` would disappear from the tree.

## Risks

- **No stylus hardware yet.** Emulated events prove the code paths, but not
  how pressure feels, driver quirks, or real palm behavior. Tuning values are
  in `tools.ts` and `ink-input.ts`, so a hardware pass changes constants, not
  design.
- **Hand-made finger scrolling** must feel native, including inertia and
  overscroll. It only applies while ink is active on a surface, so normal
  reading is unaffected.
- **Platform pressure.** Pressure reaches Chromium through Windows Ink and
  Wacom drivers. Sidecar or Apple Pencil on macOS may arrive as a mouse
  without pressure. The fallback is velocity-simulated pressure.
- **Text anchors in heavily edited notes.** If the anchored words are rewritten
  in another app, the quote may not resolve, and the ink becomes detached. That
  is visible and recoverable, but noisy for notes rewritten wholesale.
- **Many authors on one page** means many small files per chunk. Reads merge
  them all. Pruning tombstones keeps them small, and the file count matters
  only for very busy shared PDFs.
- **`desynchronized` canvases** can tear or be ignored on some GPUs. Libera
  should detect this and fall back to a normal canvas, which costs about
  one frame of latency.
- **Dense pages:** thousands of strokes on a page at high zoom. These are
  handled by the raster cap, dirty rectangles and off-screen release. The
  worker in phase 4 is the escape hatch.
## Decisions

Settled 2026-10-25:

1. **Markdown ink blocks:** each block is saved in the note as an image of
   its SVG rendering, with the strokes in `_ink`. Other apps show the drawing.
2. **Ink over note text is in the foundation** (phase 2b). Groups follow the
   words they were drawn on, not the paragraph.
3. **PDF and image ink syncs** with shared notebooks. It lives in `_ink/`, not
   `.libera/`.
4. **Conflicts:** each author writes only their own files, and merging is a
   union minus erased ids. Nothing is lost, and no host or protocol changes
   are needed.
5. **Outlines** come from `perfect-freehand`.
6. **Gallery saves** always keep ink as a layer. Flattening is only ever an
   explicit export or "Flatten ink into photo".
7. **No stylus hardware is available.** Pen input is built so it does not
   depend on device behavior, and is tested with emulated pen events. Device
   tuning waits for hardware.
