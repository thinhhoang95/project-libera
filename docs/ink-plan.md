# Ink implementation plan

Status (2026-10-25): proposal, not started. Nothing below is implemented.

Ink lets a reader write and draw with a stylus (or a mouse or finger) on PDFs,
in Markdown notes and on photos, both notebook images and gallery photos. Ink
is never written into the document itself. It lives in side-car files, like
highlights and notes, and is flattened only when the reader exports.

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
- Free ink over Markdown *prose* that reflows with the text. Notes get ink
  *blocks*, i.e. drawing areas between paragraphs. See open question 2.
- Live co-drawing in shared notebooks beyond whole-block file sync.
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
  createdAt: string;
};

type InkChunk = {
  format: "libera-ink";
  version: 1;
  /** Units, size and orientation of the surface this chunk's strokes use. */
  frame: InkFrame;
  strokes: InkStroke[];
  /** Bumped on each write; clients send the revision they built on. */
  revision: number;
};
```

**Surface units.** Units are uniform in x and y, so a circle stays round and
widths mean the same in every direction.

| Surface | Unit | Origin | Chunk |
| --- | --- | --- | --- |
| PDF page | PDF point, unrotated page box | top-left of the page, or of the `space` | one per page |
| Markdown ink block | logical px of the block at 100% width (default 720 wide) | block top-left | one per block |
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

| Surface | Side-car | Follows the file via |
| --- | --- | --- |
| PDF | `<notebook>/.libera/ink/pdf/by-path/<path>/page-0001.json` … plus `manifest.json` holding the PDF's size and SHA-256 | a new `"ink"` kind in `pdf-sidecars.ts` (moves a directory), plus `files.ts` rename/move/copy/archive/delete |
| Notebook image | `<notebook>/.libera/ink/image/by-path/<path>.json` | the same `files.ts` sites as image annotations |
| Gallery photo | `gallery/.libera-ink/<photoId>.json` | photo id; `copyRecordInto` and archive moves copy or move it |
| Markdown block | `_assets/<note folders>/<note>/ink-<blockId>.ink` | Python-side-car wiring in `markdown-assets.ts` and `files.ts`; shared notebooks sync it |

Notes:

- **Writes** go through `writeJsonAtomically` inside the side-car lock
  (`withPdfSidecar`-style). The server applies operations to the chunk on disk
  and returns the new revision. A client whose base revision is stale gets the
  merged chunk back. Ids make add/remove commutative, so two windows on one PDF
  never lose strokes.
- **API:** `GET/PATCH /api/ink?surface=pdf|image|gallery|markdown&path=…&chunk=…`
  with `requireAuth` and `toStorageError`, as in `image-annotations/route.ts`.
  The PDF `GET` returns the manifest and the pages requested, so the viewer
  loads ink only for pages near the viewport.
- **Client writer** (`use-ink-writer.ts`): built on `createDeferredSave` with a
  1.5 s idle debounce, about 4× fewer wakeups than 350 ms during steady
  writing. It flushes on blur, on tab close, and through `registerStateFlusher`
  on quit and user switch. Cross-window updates go over a broadcast channel, as
  `annotation-sync.ts` does.
- **External renames** of PDFs are reconciled by bytes, as other PDF side-cars
  are. Missing PDFs' ink is set aside in `.libera/orphaned-sidecars/ink/`.
- **Shared notebooks:** `.libera/` is not shared. PDF and image ink therefore
  stays on this computer, as PDF annotations do today.
  - Markdown ink blocks are in `_assets/` with a non-text extension, so they
    sync as whole-file blobs, last writer wins *per block*.
  - Shared notes need a `writeSharedBlob` path, like images
    (`shared-writes.ts:628`).
  - `moveSharedFile`/`deleteSharedFile` must carry `ink-*.ink` along. They do
    not move Python side-cars today either, which should be fixed at the same
    time.
- **Asset cleanup:** `cleanupMarkdownImageAssets` must exempt `.ink` files
  that a note still references, as it exempts `.py`.

## Rendering engine (`src/components/libera/ink/`, new)

```
InkSurface (one per page / block / photo)
├─ committed <canvas>   strokes, redrawn on change or zoom settle only
├─ live <canvas>        desynchronized; current stroke + predicted tail
└─ <svg> overlay        hover cursor, lasso, selection frame
```

**Geometry** (`src/lib/ink/geometry.ts`):

- **Pen outline:** a pressure-driven polygon, the perfect-freehand approach:
  streamline, thinning by pressure and velocity, round caps and a tapered
  start and end. See open question 3.
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
- **`touch-action`:** the surface needs `touch-action: none` for pen strokes,
  but fingers must still scroll. Phase 1 starts with a hardware spike: either
  Chromium in Electron 37 already separates pen from touch here, or touch pans
  must be forwarded to the scroll container by hand. See Risks.

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
    recognizes Python figures, and loads the stroke data from
    `ink-7f3c2a.ink` beside it.
  - The SVG is regenerated when the block loses focus (not per stroke), so
    other Markdown apps, previews, slides and PDF export show the ink with no
    special support.
- **Inserting:** a toolbar button, `/ink` in the slash menu, or a pen-down in
  the note's empty margin after the last block. The block grows downward
  when the pen nears its bottom edge, and can be resized with a grip.
- **Collab:** `nodeMatchesBlock` (`tiptap-blocks.ts`) needs a case for the
  node. The block is a plain image in Y.Text, so text sync is unchanged.

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
- **Shared albums (phase 4):** ink is sent as its own blob in the album
  manifest, like `edits` and `caption`. Top-level dotfiles do not sync by
  themselves.

## Module layout

```
src/lib/ink/
  types.ts           strokes, chunks, frames, brushes
  codec.ts           pack/unpack, normalize, version handling
  geometry.ts        smoothing, outlines, RDP, bounds, hit tests, split
  spatial-index.ts   uniform grid over stroke bounds
  frame.ts           surface units ↔ CSS px; photo view composition and inverse
  history.ts         operation-based undo/redo
  tools.ts           brush defaults, width presets, preset validation
  svg.ts             strokes → SVG (Markdown preview, photo export)
src/lib/storage/ink.ts           side-car paths, locked op application, migration
src/app/api/ink/route.ts
src/components/libera/ink/
  ink-surface.tsx    canvases, overlay, lifecycle
  ink-renderer.ts    committed/live drawing, dirty rects, raster caps
  ink-input.ts       pointer routing, palm rejection, prediction
  ink-toolbar.tsx    tools, widths, colors, styles, presets
  use-ink-document.ts  load by chunk, apply ops, broadcast, undo
  use-ink-writer.ts
  tiptap-ink-block.tsx
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
- **Storage:** concurrent ops from two "windows" merge. Stale revisions are
  handled, renames follow, orphans are set aside, and migration from legacy
  PDF ink works.
- **Markdown:** `inkBlock` round-trips through `getMarkdown()`, survives
  `bindTiptapToYText`, and asset cleanup keeps referenced `.ink` files.
- **Hardware pass** before each phase ships:
  - Surface Pen on Windows (Windows Ink);
  - a Wacom tablet on Windows and macOS;
  - Sidecar or Apple Pencil on macOS;
  - a mouse and a trackpad;
  - a touchscreen with no pen.

## Phases

### Phase 0: ink core (no visible change)

- Add `src/lib/ink/*` and its tests: types, codec, geometry, spatial index,
  frames, history and SVG output.
- Add side-car storage and the API, with PDF reconciliation and `files.ts`
  wiring.
- Run the hardware spike for `touch-action`, pressure on each platform, and
  `desynchronized` canvas support in Electron 37.

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

### Phase 3: photos

- Add ink to notebook images in `ImageViewer`.
- Add ink to gallery photos, with the `view` composed in edit, revert and copy,
  "Export with ink" and "Flatten ink into photo".

### Phase 4: polish

- Add the lasso (move, recolor, copy).
- Sync ink in shared albums.
- Write real `/Ink` annotations in PDF export.
- Add a lowest-latency mode.
- Move re-rasterizing of very dense pages to an OffscreenCanvas worker, if the
  benchmark shows it is needed.

## Risks and open questions

Risks:

- **Pen versus finger scrolling.** If `touch-action: none` also stops finger
  panning, Libera must pan by hand from touch events. This is contained in
  `ink-input.ts`, but needs care for momentum scrolling. The phase 0 spike
  decides.
- **Platform pressure.** Pressure reaches Chromium through Windows Ink and
  Wacom drivers. Sidecar or Apple Pencil on macOS may arrive as a mouse
  without pressure. The fallback is velocity-simulated pressure.
- **`desynchronized` canvases** can tear or be ignored on some GPUs. Libera
  should detect this and fall back to a normal canvas, which costs about
  one frame of latency.
- **Dense pages:** thousands of strokes on a page at high zoom. These are
  handled by the raster cap, dirty rectangles and off-screen release. The
  worker in phase 4 is the escape hatch.
- **Sync conflicts:** sync clients such as OneDrive do not merge side-cars.
  Per-page chunks make conflicts rarer than one file per PDF, but two
  computers inking the same page can still conflict.

Open questions:

1. **Markdown form:** an image of an SVG rendering with the strokes in a
   `.ink` file beside it (proposed, portable), or a fenced ` ```ink ` block
   that only Libera can show?
2. **Ink over Markdown text:** is drawing *on* paragraphs (circling words,
   margin notes) needed in this foundation, or are ink blocks enough for now?
   Reflowing ink over text is a separate, larger design.
3. **Stroke outlines:** write the outline code in-house (pdf-drawing and
   detection already have smoothing code), or add `perfect-freehand` (MIT,
   about 5 KB, no dependencies)?
4. **Gallery ink:** should "Save" in the photo editor offer to flatten ink, or
   always keep ink as a layer (proposed)?
5. **Shared notebooks:** is PDF and image ink staying on this computer
   acceptable for now, as PDF annotations do? Sharing it means moving it out of
   `.libera/`.
6. **Hardware:** which stylus and platform matter most, so the spike and
   tuning start there?
