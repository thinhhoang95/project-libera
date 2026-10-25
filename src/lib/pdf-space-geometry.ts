import { columnAt, columnBounds, compareSpaces, isFullWidthBand, reconcilePageSpaces, sameBand } from "@/lib/pdf-space";
import type {
  PdfAnnotation,
  PdfAnnotationPoint,
  PdfAnnotationRect,
  PdfSpaceAnnotation,
  PdfSpaceBand,
} from "@/lib/types";

/*
 * Where things are on a page that has spaces (docs/create-space-plan.md).
 *
 * Document coordinates are the stored ones: fractions of the original page.
 * View coordinates are the page as displayed: x is unchanged, and y is still
 * measured in original page heights, so it runs from 0 to `scale`. Surface
 * coordinates are what the annotation layers use, fractions of the box they
 * cover: view y divided by `scale`.
 */

export type PdfSpacePiece = {
  key: string;
  /** Document rectangle that moves as one. Pieces tile the page. */
  rect: PdfAnnotationRect;
  /** How far the piece moves down, in page heights. */
  shift: number;
};

export type PdfPageGeometry = {
  /** Inserted height in page heights; 0 without spaces. */
  growth: number;
  /** Displayed page height over original page height: 1 + growth. */
  scale: number;
  /** How far document content at (x, y) moves down. */
  shiftAt(x: number, y: number): number;
  toView(point: PdfAnnotationPoint): PdfAnnotationPoint;
  /**
   * Inverse of toView. A point inside a space reports the space and a y
   * measured from its top; a point in filler snaps to the filler's top.
   */
  toDoc(point: PdfAnnotationPoint): { point: PdfAnnotationPoint; space?: string };
  /** Each space's cut (document y) and displayed box (view coordinates). */
  spaces: { id: string; cut: number; rect: PdfAnnotationRect; fill?: string }[];
  /** Blank paper below the shorter columns of a block, in view coordinates, with the block's paper color. */
  fillers: (PdfAnnotationRect & { fill?: string })[];
  pieces: PdfSpacePiece[];
  /** Changes when pieces are added or removed, not when a space is only resized. */
  structureKey: string;
};

type FlowColumn = { x0: number; x1: number; gaps: PdfSpaceAnnotation[]; growth: number };
type FlowBand = { band: PdfSpaceBand; fullWidth: boolean; columns: FlowColumn[]; growth: number };

const FULL_PAGE: PdfAnnotationRect = { x: 0, y: 0, width: 1, height: 1 };
// Filler snaps to just inside its block, so it maps back to the filler's top.
const FILLER_INSET = 1e-9;
// Dividing into surface fractions and back can put a boundary a few ulps
// inside a gap. That must not re-anchor content to the gap on an unchanged edit.
const BOUNDARY_EPSILON = 1e-12;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export const IDENTITY_PAGE_GEOMETRY: PdfPageGeometry = Object.freeze({
  growth: 0,
  scale: 1,
  shiftAt: () => 0,
  toView: (point: PdfAnnotationPoint) => point,
  toDoc: (point: PdfAnnotationPoint) => ({ point }),
  spaces: [],
  fillers: [],
  pieces: [{ key: "0", rect: FULL_PAGE, shift: 0 }],
  structureKey: "",
});

function buildFlow(spaces: readonly PdfSpaceAnnotation[]): FlowBand[] {
  const bands: FlowBand[] = [];

  for (const space of [...spaces].sort(compareSpaces)) {
    let flow = bands.find((candidate) => sameBand(candidate.band, space.band));
    if (!flow) {
      const fullWidth = isFullWidthBand(space.band);
      const count = fullWidth ? 1 : space.band.splits.length + 1;
      flow = {
        band: space.band,
        fullWidth,
        columns: Array.from({ length: count }, (_, column) => ({ ...columnBounds(space.band, column), gaps: [], growth: 0 })),
        growth: 0,
      };
      bands.push(flow);
    }
    const column = flow.columns[flow.fullWidth ? 0 : space.column];
    // Keep an end cut just inside the column. Otherwise filler following
    // that gap has no document edge to snap to before the block's jump.
    column.gaps.push(!flow.fullWidth && space.y === flow.band.bottom
      ? { ...space, y: space.y - 2 * FILLER_INSET }
      : space);
    column.growth += space.height;
    flow.growth = Math.max(flow.growth, column.growth);
  }

  // A full-width cut at a block's top comes before the block.
  return bands.sort((a, b) => a.band.top - b.band.top || a.band.bottom - b.band.bottom);
}

function columnOf(flow: FlowBand, x: number) {
  return flow.columns[flow.fullWidth ? 0 : columnAt(flow.band, x)];
}

/**
 * The geometry of one page from its spaces. Without spaces this is
 * {@link IDENTITY_PAGE_GEOMETRY}, so pages without spaces cost nothing.
 */
export function pdfPageGeometry(pageSpaces: readonly PdfSpaceAnnotation[]): PdfPageGeometry {
  if (!pageSpaces.length) return IDENTITY_PAGE_GEOMETRY;
  const bands = buildFlow(reconcilePageSpaces(pageSpaces));
  const growth = bands.reduce((total, flow) => total + flow.growth, 0);
  const boundaries = bands.flatMap((flow) => [flow.band.top, flow.band.bottom, ...flow.columns.flatMap((column) => column.gaps.map((gap) => gap.y))]);
  const documentPoint = (x: number, y: number) => ({ x, y: boundaries.find((boundary) => Math.abs(boundary - y) <= BOUNDARY_EPSILON) ?? clamp(y, 0, 1) });
  const before = (y: number, edge: number) => y < edge - BOUNDARY_EPSILON;

  function shiftAt(x: number, y: number) {
    let shift = 0;
    for (const flow of bands) {
      if (y < flow.band.top) break;
      if (y >= flow.band.bottom) {
        shift += flow.growth;
        continue;
      }
      for (const gap of columnOf(flow, x).gaps) {
        if (gap.y > y) break;
        shift += gap.height;
      }
      break;
    }
    return shift;
  }

  function toDoc({ x, y }: PdfAnnotationPoint): { point: PdfAnnotationPoint; space?: string } {
    let shift = 0;
    for (const flow of bands) {
      if (before(y, flow.band.top + shift)) break;
      if (!before(y, flow.band.bottom + shift + flow.growth)) {
        shift += flow.growth;
        continue;
      }
      let columnShift = shift;
      for (const gap of columnOf(flow, x).gaps) {
        const gapTop = gap.y + columnShift;
        if (before(y, gapTop)) return { point: documentPoint(x, y - columnShift) };
        if (before(y, gapTop + gap.height)) return { point: { x, y: Math.max(0, y - gapTop) }, space: gap.id };
        columnShift += gap.height;
      }
      const docY = y - columnShift;
      if (before(docY, flow.band.bottom) || flow.fullWidth) return { point: documentPoint(x, docY) };
      return { point: { x, y: Math.max(flow.band.top, flow.band.bottom - FILLER_INSET) } };
    }
    return { point: documentPoint(x, y - shift) };
  }

  const spaces: PdfPageGeometry["spaces"] = [];
  const fillers: PdfPageGeometry["fillers"] = [];
  const pieces: PdfSpacePiece[] = [];
  const addPiece = (x0: number, x1: number, y0: number, y1: number, shift: number) => {
    if (y1 > y0 && x1 > x0) pieces.push({ key: String(pieces.length), rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, shift });
  };
  let cursor = 0;
  let shiftAbove = 0;

  for (const flow of bands) {
    addPiece(0, 1, cursor, flow.band.top, shiftAbove);
    for (const column of flow.columns) {
      let top = flow.band.top;
      let shift = shiftAbove;
      for (const gap of column.gaps) {
        addPiece(column.x0, column.x1, top, gap.y, shift);
        top = Math.max(top, gap.y);
        spaces.push({
          id: gap.id,
          cut: gap.y,
          rect: { x: column.x0, y: gap.y + shift, width: column.x1 - column.x0, height: gap.height },
          ...(gap.fill ? { fill: gap.fill } : {}),
        });
        shift += gap.height;
      }
      if (!flow.fullWidth) {
        addPiece(column.x0, column.x1, top, flow.band.bottom, shift);
        if (column.growth < flow.growth) {
          const fill = flow.columns.flatMap((each) => each.gaps).find((gap) => gap.fill)?.fill;
          fillers.push({
            x: column.x0,
            y: flow.band.bottom + shiftAbove + column.growth,
            width: column.x1 - column.x0,
            height: flow.growth - column.growth,
            ...(fill ? { fill } : {}),
          });
        }
      }
    }
    cursor = Math.max(cursor, flow.band.bottom);
    shiftAbove += flow.growth;
  }
  addPiece(0, 1, cursor, 1, shiftAbove);

  return {
    growth,
    scale: 1 + growth,
    shiftAt,
    toView: ({ x, y }) => ({ x, y: y + shiftAt(x, y) }),
    toDoc,
    spaces,
    fillers,
    pieces,
    structureKey: pieces.map(({ rect }) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";"),
  };
}

/** The index of the piece holding document point (x, y); pieces are half-open boxes. */
export function pieceIndexAt(geometry: PdfPageGeometry, x: number, y: number) {
  const { pieces } = geometry;
  if (pieces.length === 1) return 0;
  let fallback = 0;
  for (let index = 0; index < pieces.length; index++) {
    const { rect } = pieces[index];
    if (x < rect.x || x >= rect.x + rect.width) continue;
    if (y >= rect.y && y < rect.y + rect.height) return index;
    if (rect.y <= y) fallback = index;
  }
  return fallback;
}

/** The pages' geometries, keyed by page number; pages without spaces are absent. */
export function pdfPageGeometries(annotations: readonly PdfAnnotation[]) {
  const spacesByPage = new Map<number, PdfSpaceAnnotation[]>();
  for (const annotation of annotations) {
    if (annotation.type === "space") {
      spacesByPage.set(annotation.pageNumber, [...(spacesByPage.get(annotation.pageNumber) ?? []), annotation]);
    }
  }
  return new Map([...spacesByPage].map(([pageNumber, spaces]) => [pageNumber, pdfPageGeometry(spaces)]));
}

// ---------------------------------------------------------------------------
// Annotations between document and surface coordinates.
//
// Marks on text (highlight rects) move line by line with their text. Notes
// and drawings move rigidly with their anchor, the top-centre of their box,
// so strokes are never stretched. An annotation with `space` is placed from
// the top of that space.

type Anchored = { space?: string };

function spaceTop(geometry: PdfPageGeometry, id: string | undefined) {
  return id === undefined ? undefined : geometry.spaces.find((space) => space.id === id)?.rect.y;
}

/** How far an annotation anchored at (x, y) moves down, in page heights. */
function rigidOffset(geometry: PdfPageGeometry, x: number, y: number, space: string | undefined) {
  const top = spaceTop(geometry, space);
  return top === undefined ? geometry.shiftAt(x, y) : top;
}

function rectToSurface(rect: PdfAnnotationRect, offset: number, scale: number): PdfAnnotationRect {
  return { x: rect.x, y: (rect.y + offset) / scale, width: rect.width, height: rect.height / scale };
}

function pointsBox(points: readonly PdfAnnotationPoint[]) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
  }
  return { centerX: points.length ? (left + right) / 2 : 0, top: points.length ? top : 0 };
}

/** A box on a line of text (a highlight or comment rect) as drawn on the surface. */
export function textRectToSurface(geometry: PdfPageGeometry, rect: PdfAnnotationRect): PdfAnnotationRect {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return rect;
  return rectToSurface(rect, geometry.shiftAt(rect.x + rect.width / 2, rect.y), geometry.scale);
}

/** Where a surface anchor sits in the document, and its space. */
function anchorFromSurface(geometry: PdfPageGeometry, x: number, surfaceY: number) {
  const viewY = surfaceY * geometry.scale;
  const { point, space } = geometry.toDoc({ x, y: viewY });
  return { y: point.y, ...(space === undefined ? {} : { space }) };
}

/** A note's box moved from the surface into the document, rigidly by its top-centre. */
export function rigidRectFromSurface(geometry: PdfPageGeometry, rect: PdfAnnotationRect): { rect: PdfAnnotationRect } & Anchored {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return { rect };
  const { y: anchorY, space } = anchorFromSurface(geometry, rect.x + rect.width / 2, rect.y);
  const height = rect.height * geometry.scale;
  const y = clamp(anchorY, 0, 0.999);
  return { rect: { x: rect.x, y, width: rect.width, height: Math.min(height, 1 - y) }, ...(space === undefined ? {} : { space }) };
}

/** A drawing's points moved from the surface into the document, rigidly by their top-centre. */
export function rigidPointsFromSurface(geometry: PdfPageGeometry, points: PdfAnnotationPoint[]): { points: PdfAnnotationPoint[] } & Anchored {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return { points };
  const box = pointsBox(points);
  const { y: anchorY, space } = anchorFromSurface(geometry, box.centerX, box.top);
  return {
    points: points.map(({ x, y }) => ({ x, y: clamp(anchorY + (y - box.top) * geometry.scale, 0, 1) })),
    ...(space === undefined ? {} : { space }),
  };
}

/** Text boxes (a selection's line rects) moved into the document, each with its own line. */
export function textRectsFromSurface(geometry: PdfPageGeometry, rects: PdfAnnotationRect[]): PdfAnnotationRect[] {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return rects;
  return rects.map((rect) => {
    const { point, space } = geometry.toDoc({ x: rect.x + rect.width / 2, y: rect.y * geometry.scale });
    // Spaces hold no PDF text; a box starting in one belongs at its cut.
    const cut = space === undefined ? undefined : geometry.spaces.find((candidate) => candidate.id === space)?.cut;
    const y = clamp(cut ?? point.y, 0, 0.999);
    return { x: rect.x, y, width: rect.width, height: Math.min(rect.height * geometry.scale, 1 - y) };
  });
}

/**
 * An area marked on the surface (a screenshot snip) as the part of the
 * original page it shows. Each edge maps on its own; an edge in a space goes
 * to the space's cut, so the spaces inside are left out.
 */
export function areaFromSurface(geometry: PdfPageGeometry, rect: PdfAnnotationRect): PdfAnnotationRect {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return rect;
  const edge = (surfaceY: number) => {
    const { point, space } = geometry.toDoc({ x: rect.x + rect.width / 2, y: surfaceY * geometry.scale });
    const cut = space === undefined ? undefined : geometry.spaces.find((candidate) => candidate.id === space)?.cut;
    return clamp(cut ?? point.y, 0, 1);
  };
  const top = edge(rect.y);
  const bottom = Math.max(top, edge(rect.y + rect.height));
  return { x: rect.x, y: top, width: rect.width, height: bottom - top };
}

/** The `space` part of a patch: set, cleared, or left out when it was never there. */
function anchorPatch(original: PdfAnnotation, space: string | undefined): Anchored {
  if (space !== undefined) return { space };
  return "space" in original && original.space !== undefined ? { space: undefined } : {};
}

const surfaceCaches = new WeakMap<PdfPageGeometry, WeakMap<PdfAnnotation, PdfAnnotation>>();

/**
 * An annotation as the layers draw it on a page with spaces, in fractions of
 * the displayed page. Unchanged annotations return the same object, so
 * memoized layers skip re-rendering.
 */
export function annotationToSurface<T extends PdfAnnotation>(annotation: T, geometry: PdfPageGeometry): T {
  if (geometry === IDENTITY_PAGE_GEOMETRY || annotation.type === "space") return annotation;
  let cache = surfaceCaches.get(geometry);
  if (!cache) surfaceCaches.set(geometry, cache = new WeakMap());
  const cached = cache.get(annotation);
  if (cached) return cached as T;

  const { scale } = geometry;
  let surface: PdfAnnotation;

  if (annotation.type === "highlight") {
    surface = {
      ...annotation,
      rects: annotation.rects.map((rect) => textRectToSurface(geometry, rect)),
    };
  } else if (annotation.type === "text") {
    const { rect } = annotation;
    surface = { ...annotation, rect: rectToSurface(rect, rigidOffset(geometry, rect.x + rect.width / 2, rect.y, annotation.space), scale) };
  } else {
    const points = annotation.type === "ink" ? annotation.points : [annotation.from, annotation.to];
    const box = pointsBox(points);
    const offset = rigidOffset(geometry, box.centerX, box.top, annotation.space);
    const move = ({ x, y }: PdfAnnotationPoint) => ({ x, y: (y + offset) / scale });
    surface = annotation.type === "ink"
      ? { ...annotation, points: annotation.points.map(move) }
      : { ...annotation, from: move(annotation.from), to: move(annotation.to) };
  }

  cache.set(annotation, surface);
  return surface as T;
}

/**
 * Turns a layer's edit, made in surface fractions, into a document patch.
 * Moving a note or drawing re-anchors it where it lands: into a space, out of
 * one, or onto the page. Edits that move nothing pass through unchanged.
 */
export function patchFromSurface(
  original: PdfAnnotation,
  patch: Partial<PdfAnnotation>,
  geometry: PdfPageGeometry,
): Partial<PdfAnnotation> {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return patch;
  const changes = patch as Record<string, unknown>;

  if (original.type === "text" && changes.rect) {
    const { rect, space } = rigidRectFromSurface(geometry, changes.rect as PdfAnnotationRect);
    return { ...patch, rect, ...anchorPatch(original, space) } as Partial<PdfAnnotation>;
  }
  if (original.type === "ink" && changes.points) {
    const { points, space } = rigidPointsFromSurface(geometry, changes.points as PdfAnnotationPoint[]);
    return { ...patch, points, ...anchorPatch(original, space) } as Partial<PdfAnnotation>;
  }
  if (original.type === "shape" && (changes.from || changes.to)) {
    const surface = annotationToSurface(original, geometry);
    const from = (changes.from ?? surface.from) as PdfAnnotationPoint;
    const to = (changes.to ?? surface.to) as PdfAnnotationPoint;
    const { points: [docFrom, docTo], space } = rigidPointsFromSurface(geometry, [from, to]);
    return { ...patch, from: docFrom, to: docTo, ...anchorPatch(original, space) } as Partial<PdfAnnotation>;
  }
  if (original.type === "highlight" && changes.rects) {
    return { ...patch, rects: textRectsFromSurface(geometry, changes.rects as PdfAnnotationRect[]) } as Partial<PdfAnnotation>;
  }
  return patch;
}
