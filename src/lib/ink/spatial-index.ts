import type { InkRect } from "@/lib/ink/types";

/**
 * A uniform grid over stroke bounds, so the eraser and dirty-rect redraws
 * look only at strokes near a point instead of every stroke on the page.
 */
export class InkSpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly rects = new Map<string, InkRect>();

  /** `cellSize` in surface units; about a tenth of the page width works well. */
  constructor(private readonly cellSize: number) {
    if (!(cellSize > 0)) throw new RangeError("The cell size must be positive.");
  }

  get size() {
    return this.rects.size;
  }

  private *cellKeys(rect: InkRect) {
    const left = Math.floor(rect.x / this.cellSize);
    const right = Math.floor((rect.x + rect.width) / this.cellSize);
    const top = Math.floor(rect.y / this.cellSize);
    const bottom = Math.floor((rect.y + rect.height) / this.cellSize);
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) yield `${column},${row}`;
    }
  }

  insert(id: string, rect: InkRect) {
    if (this.rects.has(id)) this.remove(id);
    this.rects.set(id, rect);
    for (const key of this.cellKeys(rect)) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(id);
    }
  }

  remove(id: string) {
    const rect = this.rects.get(id);
    if (!rect) return;
    this.rects.delete(id);
    for (const key of this.cellKeys(rect)) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (cell && !cell.size) this.cells.delete(key);
    }
  }

  clear() {
    this.cells.clear();
    this.rects.clear();
  }

  /** Ids whose rects intersect `rect`. */
  query(rect: InkRect): Set<string> {
    const found = new Set<string>();
    for (const key of this.cellKeys(rect)) {
      for (const id of this.cells.get(key) ?? []) {
        if (found.has(id)) continue;
        const other = this.rects.get(id)!;
        if (other.x <= rect.x + rect.width && rect.x <= other.x + other.width && other.y <= rect.y + rect.height && rect.y <= other.y + other.height) found.add(id);
      }
    }
    return found;
  }
}
