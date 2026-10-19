# Detection and Segmentation

Find, outline and count objects in a photo with Ultralytics' [YOLOE-26](https://docs.ultralytics.com/models/yoloe/), on this computer. Describe what to find in words, or box examples of it. Correct what the model found, tag what it missed, measure it all, and save the results with a record of what was edited by hand.

## Where to find it

The scan button (**Detection and Segmentation**) opens the tool from:

- the toolbar of an image tab (an image file in a notebook), and
- the toolbar of the Image Gallery's photo viewer, including the Protected Archive.

The tool covers the window: the photo on the left, with its tools, and **Prompts**, **Detections** and **Statistics** tabs on the right. Esc leaves the current tool, then closes it.

## First run: the model

The first time, the panel offers the download, listing what is still missing:

| What | Size | From |
|---|---|---|
| A private Python runtime with PyTorch and Ultralytics | about 1 GB | uv (Astral) from GitHub, packages from PyPI |
| MobileCLIP2-B, the text encoder for text prompts | 254 MB | Ultralytics' GitHub release v8.4.0 |
| The chosen YOLOE-26 variant's weights | 12–172 MB | Ultralytics' GitHub release v8.4.0 |

Click **Download and install**. The panel shows each step: uv is downloaded and its checksum verified, a managed Python 3.12 is installed, then Ultralytics 8.4.182 with PyTorch, then the weights. Closing the tool does not stop it. Nothing is installed system-wide: everything goes into Libera's application data, or the folder chosen in Preferences, in a `yoloe-26/` folder:

```
yoloe-26/
  yoloe-26s-seg.pt …        the weights of each variant you used
  mobileclip2_b.ts          the text encoder
  runtime/
    uv/                     uv itself
    python/                 the managed Python
    venv/                   Ultralytics, PyTorch, OpenCV
    cache/                  uv's download cache
    config/                 Ultralytics settings (sync off)
    installed.json          versions, written when the install finishes
```

Downloads resume after an interruption. Another variant downloads (weights only) the first time you choose it in the **Model** menu.

YOLOE-26 takes new text and visual prompts only through Ultralytics in Python: an ONNX export bakes its classes in. That is why Libera installs a runtime here, unlike its other local models, which run in Node through ONNX.

Ultralytics and the YOLOE-26 weights are licensed AGPL-3.0.

### Variants

The prompt models (`yoloe-26*-seg.pt`), which accept text and visual prompts. mAP50-95 on LVIS minival, from Ultralytics:

| Variant | Weights | Parameters | Text prompts | Visual prompts |
|---|---|---|---|---|
| YOLOE-26n | 12 MB | 4.8M | 24.7 | 21.9 |
| YOLOE-26s (default) | 31 MB | 13M | 30.8 | 28.6 |
| YOLOE-26m | 70 MB | 28M | 35.4 | 33.9 |
| YOLOE-26l | 79 MB | 32M | 37.8 | 36.3 |
| YOLOE-26x | 172 MB | 70M | 40.6 | 38.5 |

On a laptop CPU the nano model takes about a tenth of a second per photo once loaded. The first run takes longer (around 20 seconds) while Python starts and MobileCLIP loads; the model then stays loaded for five minutes after the last run.

## Prompts

Each prompt is one class: everything it finds carries its label. Prompts with the same label are counted together. The **Prompts** tab lists them with their color, kind and, after a run, how many objects each found. Rename one by editing its label, or remove it.

- **Text prompts.** Type what to find and press Enter. Separate several with commas: `red blood cell, white blood cell, platelet`. Short noun phrases work best.
- **Draw on photo.** Choose **Draw example** (or **Draw on photo**) and drag a box around an example of the object. YOLOE finds others like it. Further boxes add examples to the same prompt until you stop drawing (Esc); the **+** on a prompt adds more later. More examples make a steadier prompt.
- **Upload reference…** Use another image that shows the object. Box one or more examples in it, or use the whole image when it shows just the object. The reference is kept with the prompt (downscaled to 1280 px), so a saved file can be run again.

Text and visual prompts can be mixed in one run. Visual prompts often score lower than text prompts, especially in cluttered scenes: if one finds nothing, lower the confidence in **Run settings** or add more examples.

Press **Detect** (⌘/Ctrl+Enter). If the prompts change after a run, the panel says so; detect again to update.

**Run settings** under the prompts override Preferences for this photo: confidence threshold, IoU threshold, inference size (640, 960 or 1280 px; larger finds smaller objects) and maximum detections.

## Results

### On the photo

Each object is drawn in its label's color, with its number, label and confidence. Scroll to zoom, drag to pan when zoomed in, double-click empty photo to fit. **Layers** turns on or off:

- **Masks**: the instance outlines.
- **Boxes**: bounding boxes (dashed when masks are shown).
- **Labels**.
- **Centroids**: each outline's area-weighted centre.
- **Quadrat density**: the grid used for quadrat analysis, shaded and labelled with each cell's count.
- **Prompt examples**: the boxes drawn as visual prompts.

Hovering an object highlights its row in the table; clicking selects it.

### Detections tab

A table of every object at or above the **Confidence ≥** slider, which filters without running again. Sort by number, label, confidence or area. Columns: number, label, confidence, source (Model, ✱ Edited or ✎ Manual), area and centroid, in pixels or the calibrated unit. Selecting a row shows its box, area, equivalent diameter, perimeter, circularity and outline, with buttons to edit, revert or delete it.

### Statistics tab

All figures cover model detections at or above the confidence filter, plus every manual and edited object.

- **Summary**: objects (with how many are edited and manual), density, area covered and mean confidence.
- **Counts and density** per label: n, share, density (per megapixel, or per unit² when calibrated), coverage and confidence (mean ± SD).
- **Size and shape** per label: area mean ± SD, median [IQR], range, coefficient of variation, equivalent diameter, perimeter, circularity and aspect ratio. Histograms of area and confidence for all objects or one label.
- **Spatial distribution** per label:
  - centroid mean (x̄, ȳ);
  - nearest-neighbour distance (mean ± SD);
  - the Clark–Evans aggregation index R with Donnelly's (1978) edge correction for the image rectangle, its z score and two-sided p, and the pattern it suggests (clustered, random, or regular);
  - quadrat analysis on a grid with five cells on the shorter side: variance/mean ratio (index of dispersion), χ² with q − 1 degrees of freedom and two-sided p, and Morisita's index Iδ.
- **Methods** explains each formula. With fewer than five objects the tests are not interpreted.

Notes on the measurements:

- Areas and perimeters come from each outline (shoelace formula). An object without an outline uses its box.
- Coverage sums outline areas, so overlapping masks count twice.
- Equivalent diameter is 2√(A/π); circularity is 4πA/P² (1 for a circle); aspect ratio is the box's long side over its short side.
- SD is the sample standard deviation; CV is SD/mean.
- Confidence statistics leave out manual objects, which have no model score.

### Scale

Sizes are in pixels until a scale is set. In the **Statistics** tab, give the length of one pixel and its unit (nm, µm, mm, cm or m), or choose **Measure scale bar** (also **Set scale** on the photo): drag along a scale bar, then type its length. Areas, perimeters, diameters, distances and densities then use that unit. The scale is saved with the results.

## Tagging and editing by hand

### Tag what the model missed

The **Tag** tools on the photo's toolbar outline an object by hand. A **Label** field appears beside them; it suggests the labels already in use, and a new label gets its own color.

- **Box**: drag a box around the object.
- **Polygon**: click to place points. Click the first point, double-click, or press Enter to close. Backspace removes the last point; Esc discards the polygon.
- **Freehand**: draw around the object. The stroke is steadied, reduced to at most 32 control points, and drawn as a smooth curve through them, ready to refine.

Tagging does not need a model run: tagging a photo from scratch works too.

### Edit an outline

Double-click an object (on the photo or in the table), or select it and press **Edit shape**.

- **Mask outlines** from the model are simplified to at most 24 control points (Ramer–Douglas–Peucker) and drawn as a smooth curve through them: a closed centripetal Catmull–Rom spline, which passes through every point without loops or cusps.
- **Drag a point** to move it. **Drag a hollow midpoint** to insert a point there. **Double-click a point**, or select it and press Delete, to remove it (at least three remain).
- **Drag inside the outline** to move the whole object.
- **Boxes** have four corner handles; the opposite corner stays fixed and the box stays axis-aligned.
- Press Enter, or click empty photo, when done.

Measurements and statistics update as you drag. Hand-drawn polygons keep straight edges; freehand and edited masks use the smooth curve.

### Relabel, delete, revert and undo

In the selected object's panel: edit the label to relabel it, **Delete** it (or press Delete), or **Revert** an edited object to what the model found. **Undo** on the toolbar (⌘/Ctrl+Z) steps back through every change: tags, edits, relabels, deletions, and the merge after a new run.

### How hand work is marked

- **Model**: found by the model, untouched.
- **✱ Edited**: found by the model, then reshaped or relabelled by hand. The model's label, confidence, box and outline are kept as the original.
- **✎ Manual**: tagged by hand. It has no confidence score and is never hidden by the confidence filter. Edited objects are not hidden either.

The table's Source column, the labels on the photo, the selected object's panel, the footer (edited, manual and removed counts) and the Statistics summary all show this.

### Detecting again

A new run replaces the model's untouched detections and keeps every manual and edited object. New detections that overlap a kept object (box IoU above 0.5, or above 0.7 with an edited object's original box) are left out, and so are ones matching a deleted detection, so deleted objects stay deleted. Objects are renumbered: new model detections first, by confidence, then the kept ones.

## Saving and loading

- **Save detection file** (the JSON button) writes `<photo>.detections.json`.
- **Open detection file** (the folder button) loads one back: the prompts, objects, scale, confidence filter and model settings return, and the overlays are drawn again. If the file was made for an image of a different shape, the panel warns that the overlays may not line up.
- **Save table as CSV** writes one row per object shown: id, label, origin, confidence (empty for manual), box, centroid, area, perimeter, equivalent diameter and circularity, in the calibrated unit.

### The JSON file

```jsonc
{
  "format": "libera-detection",
  "version": 1,
  "createdAt": "2026-10-19T07:32:06.000Z",
  "generator": { "app": "LiBERA for Vy Tran", "version": "7.0.0" },
  "image": { "name": "cells.jpg", "width": 2048, "height": 1536, "source": "Lab/cells.jpg" },
  "model": {                       // null when every object was tagged by hand
    "family": "YOLOE-26", "variant": "s", "name": "YOLOE-26s", "weights": "yoloe-26s-seg.pt",
    "textEncoder": "MobileCLIP2-B", "framework": "Ultralytics 8.4.182", "device": "cpu",
    "imageSize": 640, "confidence": 0.25, "iou": 0.7, "maxDetections": 300
  },
  "prompts": [
    { "id": "p1", "type": "text", "label": "cell", "text": "cell", "color": "#3987e5" },
    { "id": "p2", "type": "visual", "label": "nucleus", "color": "#d95926", "source": "photo",
      "width": 2048, "height": 1536, "boxes": [[120, 88, 160, 130]], "thumbnail": "data:image/jpeg;base64,…" }
    // an uploaded reference also has "name" and "reference" (the downscaled image as a data URL)
  ],
  "scale": { "unit": "µm", "perPixel": 0.325 },   // "px" when uncalibrated
  "displayConfidence": 0.25,
  "detections": [
    {
      "id": 1, "promptId": "p1", "label": "cell", "confidence": 0.91,
      "box": [x1, y1, x2, y2],                     // image pixels
      "polygon": [[x, y], …],                      // the outline; empty for a box
      "area": 1834.5, "perimeter": 160.2, "centroid": [x, y],   // pixels
      "origin": "model",                           // "model" | "edited" | "manual"
      "shape": "polygon"                           // "polygon" | "box"
    },
    {
      "id": 2, "promptId": "p1", "label": "cell", "confidence": 0.44, "…": "…",
      "origin": "edited", "shape": "polygon",
      "controlPoints": [[x, y], …], "curve": "smooth",         // "smooth" | "linear"
      "original": { "label": "cell", "confidence": 0.44, "box": [...], "polygon": [...] },
      "editedAt": "2026-10-19T07:30:36.204Z"
    },
    {
      "id": 3, "promptId": "manual", "label": "cell", "confidence": 1, "…": "…",
      "origin": "manual", "shape": "box", "editedAt": "…"
    }
  ],
  "removedDetections": [
    { "id": 4, "label": "cell", "confidence": 0.31, "box": [...], "origin": "model", "removedAt": "…" }
  ],
  "provenance": { "model": 1, "edited": 1, "manual": 1, "removed": 1 },
  "statistics": { "overall": { … }, "classes": [ … ], "unit": "µm", "imageArea": 332236.8 },
  "timing": { "loadMs": 68, "promptMs": 108, "inferenceMs": 91, "speed": { … } }
}
```

Areas, perimeters and centroids are stored in pixels, whatever the scale. When a file is opened they are recomputed from the outlines, and the statistics are recomputed too, so an edited file cannot disagree with its measurements.

## Preferences

Preferences → **Detection and Segmentation**. Changes apply to the next run, without restarting.

- **Default variant**: n, s (default), m, l or x.
- **Run on**: CPU (default), Apple GPU (Metal) or NVIDIA GPU (CUDA). A GPU PyTorch cannot reach is reported when you detect.
- **Confidence threshold** (default 0.25), **IoU threshold** (0.7), **Maximum detections per photo** (300), **Inference size** (640, 960 or 1280 px).
- **Model folder**: where the weights and runtime go; empty uses Libera's application data. The line under it says what is installed.

A web deployment sets `LIBERA_DETECTION_VARIANT`, `LIBERA_DETECTION_DEVICE`, `LIBERA_DETECTION_CONFIDENCE`, `LIBERA_DETECTION_IOU`, `LIBERA_DETECTION_MAX_DETECTIONS`, `LIBERA_DETECTION_IMAGE_SIZE` and `LIBERA_DETECTION_MODEL_DIR` instead.

## How it works

1. **Setup** (`src/lib/detection/runtime.ts`, `/api/detection`). The pinned uv release for the platform is downloaded and checked against its SHA-256, then runs `uv venv --python 3.12` and `uv pip install ultralytics==8.4.182` with Ultralytics' CLIP fork (pinned by commit, as an archive, so git is not needed). The weights come through the shared model downloader (`src/lib/models/downloader.ts`), with size checks and resume. `GET /api/detection` reports what is installed and the progress; `POST` starts; `DELETE` cancels.
2. **Run** (`/api/detection/detect`). The browser sends the photo (converted to PNG first when it is not JPEG, PNG, WebP, BMP or TIFF), the prompts and any reference images. The server writes them to a temporary folder, deleted after the run.
3. **Worker** (`electron/detection-worker.py`, `src/lib/detection/worker-client.ts`). The runtime's Python runs the worker, with the weights folder as its working directory and one JSON request and reply per line. Text prompts are embedded with MobileCLIP2-B (and cached), and each visual prompt's boxes with YOLOE's visual prompt encoder. The embeddings are joined into one class list (`set_classes`), and the photo is predicted. Mask outlines are simplified to about 0.75 px. The worker keeps one model loaded and exits after five idle minutes.
4. **Results** (`src/lib/detection/results.ts`, `src/lib/detection/geometry.ts`). Measurements, statistics, file parsing, control-point fitting, the smooth curve and edits are plain TypeScript shared by the browser and server.
5. **Interface** (`src/components/libera/detection/`). `detection-tool.tsx` (the tool), `detection-canvas.tsx` (the photo, overlays, drawing and handles), `detection-statistics.tsx`, `reference-dialog.tsx` and `detection-client.ts` (API calls, the file and CSV formats).

The Electron app passes the worker's location as `LIBERA_DETECTION_WORKER_PATH`; `next dev` and `next start` use `electron/detection-worker.py` from the project.

## Limits

- One photo at a time; there is no batch mode.
- Prompt colors repeat after eight labels; every object and row also names its label.
- Platforms with a uv release are supported: macOS (Apple silicon and Intel) and Windows (x64 and Arm). Windows has not been tested yet.
- Annotations made here are not shared in collaborative notebooks; share the JSON file instead.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/detection-results.test.ts`

Covers preferences, folder inspection, measurements, descriptive statistics, the χ² tail, nearest-neighbour and quadrat patterns, statistics by label with scale and confidence filter, control-point fitting and the smooth curve, edited and manual provenance, and reading saved files. The worker and setup are not exercised by the tests; they were checked by hand with YOLOE-26n.
