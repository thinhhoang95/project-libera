// Visual (Tiptap) editor ↔ shared Y.Text block bridge (collaboration map §7.2,
// decision record docs/collaboration/decisions/D1-visual-bridge.md).
//
// Y.Text holds the file's exact Markdown source; ProseMirror keeps its own
// document. The bridge keeps the two in step one block at a time:
//
// - Local → Y: after a ProseMirror change, only the top-level nodes that
//   changed are serialized, and only the characters that differ from their
//   current source are sent. Untouched blocks keep their exact bytes.
// - Y → local: a Y.Text change marks the source tiles it touched; only those
//   are re-tiled with remark, reparsed and swapped into ProseMirror, with the
//   selection mapped through by source offset.
//
// Both directions meet in `sync()`, which runs the local phase before the
// remote phase so local and remote changes never interleave inside a block
// without a three-way merge (see `rebaseOps`).

import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import type { Awareness } from "y-protocols/awareness";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Provenance } from "../protocol/actor";
import type { RelativePositionJSON } from "../protocol/schema";
import {
  alignRun, alignedOffset, alignedPosition, editorMarkdownCodec, gapEdge, gapEmptyParagraphs, isEmptyParagraph,
  nodeMatchesBlock, serializeRun, sourceBlocks, tileEnd, tilesForBlocks, type MarkdownCodec, type Tile,
} from "./tiptap-blocks";
import { createRemoteCursorPlugin, publishAwarenessCursor, relativePositionToSourceOffset, type RemoteCursorSource } from "./tiptap-cursors";
import { collabHistoryFallbackPlugins, collabHistoryTarget, setCollabHistoryTarget } from "./tiptap-history";
import { applyTextOps, deltaToOps, diffText, mapOffset, rebaseOps, type TextDelta, type TextOp } from "./tiptap-text-diff";

/** Transaction meta set on every ProseMirror transaction the bridge dispatches. */
export const TIPTAP_BRIDGE_META = "liberaCollabBridge";
/** Local changes are sent to Y.Text at most this often while typing. */
export const TIPTAP_BRIDGE_FLUSH_MS = 50;

const TYPING: Provenance = { source: "typing" };
const PASTE: Provenance = { source: "paste" };
const SELECTION_META = "liberaBridgeSelection";

let nextBridgeId = 1;

/**
 * Origin of every Y transaction the bridge makes. Read `provenance` in the
 * Y.Doc `update` handler (synchronously, as for any origin) to forward it.
 * Each bridge uses its own subclass, so its UndoManager tracks only itself.
 */
export class TiptapBridgeOrigin {
  constructor(readonly bridgeId: number, readonly provenance: Provenance) {}
}

/** Provenance for a Y transaction origin, including undo/redo by a bridge's UndoManager. */
export function provenanceOfOrigin(origin: unknown): Provenance | undefined {
  if (origin instanceof TiptapBridgeOrigin) return origin.provenance;
  if (origin instanceof Y.UndoManager) return { source: "undo" };
  return undefined;
}

export interface TiptapYTextBridgeOptions {
  editor: Editor;
  /** The shared source text (`ContentKeys.source` of the content sub-document). */
  ytext: Y.Text;
  /** Presence: publishes the local cursor and renders remote ones. */
  awareness?: Awareness | null;
  /** Render remote carets (default true when `awareness` is given). */
  renderRemoteCursors?: boolean;
  /** Publish the local cursor only while the editor has focus, like y-codemirror.next (default true). */
  cursorRequiresFocus?: boolean;
  /** Throttle for local → Y serialization (default 50 ms). */
  flushDelay?: number;
  /** Y.UndoManager capture timeout: changes closer than this merge into one undo step (default 500 ms). */
  captureTimeout?: number;
  /** Start in the D1 fallback: a live, read-only rendered view. */
  readOnlyReason?: string | null;
  onReadOnlyChange?: (reason: string | null) => void;
  /** Called when a sync step throws. The bridge rebuilds from Y.Text and turns read-only. */
  onError?: (error: unknown) => void;
}

export interface TiptapBridgeIssue {
  tile: number;
  kind: Tile["kind"] | "document";
  message: string;
}

export interface TiptapYTextBridge {
  readonly editor: Editor;
  readonly ytext: Y.Text;
  /** Local-origin undo manager on the shared Y.Text. */
  readonly undoManager: Y.UndoManager;
  /** Origin class of this bridge's Y transactions (each instance carries a Provenance). */
  readonly originClass: typeof TiptapBridgeOrigin;
  /** Sends pending local changes now (held while an IME composition is active). */
  flush(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Ends the current undo capture group. */
  stopCapturing(): void;
  /**
   * Runs `fn` (ProseMirror edits) as one undo step, flushed immediately with
   * `provenance` (for AI actions: `{ source: "ai", feature }`).
   */
  captureTransaction<T>(fn: () => T, provenance?: Provenance): T;
  /** Provenance for the next local flush (pending changes are flushed first). */
  setNextProvenance(provenance: Provenance | null): void;
  /** True for origins of this bridge's own Y transactions. */
  isLocalOrigin(origin: unknown): boolean;
  /** Y.Text offset for a document position (approximate inside inline formatting). */
  posToSourceOffset(pos: number): number;
  /** Document position for a Y.Text offset (approximate inside inline formatting). */
  sourceOffsetToPos(offset: number): number;
  posToRelativePosition(pos: number, assoc?: number): Y.RelativePosition;
  relativePositionToPos(position: Y.RelativePosition | RelativePositionJSON): number | null;
  /** D1 fallback: make the Visual editor a read-only live view (null to allow editing again). */
  setReadOnly(reason: string | null): void;
  readonly readOnlyReason: string | null;
  /** True when ProseMirror, the block map and Y.Text are all in step. */
  isSynced(): boolean;
  /** The awareness the bridge publishes the local cursor to, if any. */
  readonly awareness: Awareness | null;
  /**
   * Fires after each sync that changed the document or block map. With
   * `awareness`, the bridge is a `RemoteCursorSource` for `createRemoteCursorPlugin`.
   */
  subscribe(listener: () => void): () => void;
  /** Consistency check for tests and diagnostics; empty when in step. */
  verify(): TiptapBridgeIssue[];
  destroy(): void;
}

/** Binds a Tiptap editor (built with `createMarkdownExtensions`) to a shared Y.Text. */
export function bindTiptapToYText(options: TiptapYTextBridgeOptions): TiptapYTextBridge {
  return new Bridge(options);
}

const sameNode = (a: ProseMirrorNode, b: ProseMirrorNode) => a === b || a.eq(b);
const isPaste = (tr: Transaction) => !!tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste" || tr.getMeta("uiEvent") === "drop";

function children(doc: ProseMirrorNode, from: number, to: number) {
  const nodes: ProseMirrorNode[] = [];
  for (let index = from; index < to; index++) nodes.push(doc.child(index));
  return nodes;
}

function nodePosition(doc: ProseMirrorNode, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function nearSelection(doc: ProseMirrorNode, anchor: number, head: number): Selection {
  const clamp = (pos: number) => Math.max(0, Math.min(doc.content.size, pos));
  const $anchor = doc.resolve(clamp(anchor)), $head = doc.resolve(clamp(head));
  if ($anchor.parent.inlineContent && $head.parent.inlineContent) return TextSelection.between($anchor, $head);
  return Selection.near($head);
}

interface Span {
  lo: number;
  hi: number;
  tiles: Tile[];
  leftEdge: boolean;
  rightEdge: boolean;
}

class Bridge implements TiptapYTextBridge, RemoteCursorSource {
  readonly editor: Editor;
  readonly ytext: Y.Text;
  readonly undoManager: Y.UndoManager;
  readonly originClass: typeof TiptapBridgeOrigin;
  readonly awareness: Awareness;
  private readonly doc: Y.Doc;
  private readonly codec: MarkdownCodec;
  private readonly id = nextBridgeId++;
  private readonly options: TiptapYTextBridgeOptions;
  private readonly flushDelay: number;

  private tiles: Tile[] = [];
  /** The ProseMirror document the tiles describe. */
  private baseDoc!: ProseMirrorNode;
  /** Maps positions in `baseDoc` to the current document (local, unflushed steps). */
  private pendingMapping = new Mapping();
  private hasDirty = false;
  /** Conservative index range of dirty tiles, so the remote phase does not scan every tile. */
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private queue: TextOp[][] = [];
  private definitions = "";
  private firstNodes: number[] | null = null;
  private definitionsStale = true;

  private syncing = false;
  private again = false;
  private inLocalWrite = false;
  /** >0 while ProseMirror must not receive a nested dispatch. */
  private blocked = 0;
  private held = false;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDelay = Infinity;
  private pendingProvenance: Provenance | null = null;
  private nextProvenance: Provenance | null = null;
  private listeners = new Set<() => void>();
  private registeredPlugins: string[] = [];
  private readOnly: string | null = null;
  private readonly window: Window | null = typeof window === "undefined" ? null : window;

  constructor(options: TiptapYTextBridgeOptions) {
    const { editor, ytext } = options;
    if (!ytext.doc) throw new Error("The Y.Text must belong to a Y.Doc.");
    this.options = options;
    this.editor = editor;
    this.ytext = ytext;
    this.doc = ytext.doc;
    this.codec = editorMarkdownCodec(editor);
    this.flushDelay = options.flushDelay ?? TIPTAP_BRIDGE_FLUSH_MS;
    this.awareness = options.awareness as Awareness;
    this.originClass = class extends TiptapBridgeOrigin {};
    this.undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([this.originClass]), captureTimeout: options.captureTimeout ?? 500 });

    this.rebuild();
    ytext.observe(this.onYEvent);
    editor.on("beforeTransaction", this.onBeforeTransaction);
    editor.on("transaction", this.onTransaction);
    editor.on("selectionUpdate", this.onSelection);
    editor.on("blur", this.onBlur);
    editor.view.dom.addEventListener("compositionend", this.onCompositionEnd);
    this.window?.addEventListener("pagehide", this.onPageHide);
    this.undoManager.on("stack-item-added", this.onStackItemStored);
    this.undoManager.on("stack-item-updated", this.onStackItemStored);
    this.undoManager.on("stack-item-popped", this.onStackItemPopped);

    setCollabHistoryTarget(editor, this);
    const plugins = [];
    // Without TiptapCollabHistory in the extensions, register the equivalent keymap.
    if (!editor.extensionManager.extensions.some((extension) => extension.name === "liberaCollabHistory")) plugins.push(...collabHistoryFallbackPlugins(editor));
    if (options.awareness && options.renderRemoteCursors !== false) plugins.push(createRemoteCursorPlugin(this));
    for (const plugin of plugins) {
      // In front, so the undo keymap runs before Tiptap's history keymap.
      editor.registerPlugin(plugin, (added, existing) => [added, ...existing]);
      this.registeredPlugins.push((plugin as unknown as { key: string }).key);
    }
    if (options.readOnlyReason) this.setReadOnly(options.readOnlyReason);
  }

  // -------------------------------------------------------------------------
  // Public API

  get readOnlyReason() { return this.readOnly; }

  flush() { this.sync(); }

  undo() {
    this.sync();
    return this.undoManager.undo() !== null;
  }

  redo() {
    this.sync();
    return this.undoManager.redo() !== null;
  }

  canUndo() { return this.undoManager.canUndo() || this.editor.state.doc !== this.baseDoc; }
  canRedo() { return this.undoManager.canRedo(); }

  stopCapturing() { this.undoManager.stopCapturing(); }

  captureTransaction<T>(fn: () => T, provenance?: Provenance): T {
    this.sync();
    this.undoManager.stopCapturing();
    this.nextProvenance = provenance ?? this.nextProvenance;
    try {
      return fn();
    } finally {
      this.sync();
      this.nextProvenance = null;
      this.undoManager.stopCapturing();
    }
  }

  setNextProvenance(provenance: Provenance | null) {
    this.sync();
    this.nextProvenance = provenance;
  }

  isLocalOrigin(origin: unknown) { return origin instanceof this.originClass; }

  isSynced() {
    return !this.destroyed && !this.hasDirty && this.queue.length === 0 && !this.editor.isDestroyed && this.editor.state.doc === this.baseDoc;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setReadOnly(reason: string | null) {
    if (this.readOnly === reason) return;
    this.readOnly = reason;
    if (!this.editor.isDestroyed) this.editor.setEditable(!reason, false);
    this.options.onReadOnlyChange?.(reason);
  }

  posToSourceOffset(pos: number): number {
    const doc = this.editor.state.doc;
    const base = doc === this.baseDoc ? pos : this.pendingMapping.invert().map(pos, -1);
    const $pos = this.baseDoc.resolve(Math.max(0, Math.min(base, this.baseDoc.content.size)));
    let node = $pos.index(0);
    // Between two top-level nodes: the end of the one before.
    if ($pos.depth === 0 && node > 0) node--;
    const first = this.nodeIndexes();
    const index = this.tileOfNode(Math.min(node, Math.max(0, this.baseDoc.childCount - 1)));
    const tile = this.tiles[index];
    const at = $pos.posAtIndex(first[index], 0);
    const nodes = children(this.baseDoc, first[index], first[index] + tile.count);
    const text = tile.pmText ?? tile.text;
    let offset = alignedOffset(alignRun(nodes, text), base - at);
    if (tile.pmText !== undefined && tile.pmText !== tile.text) offset = mapOffset(diffText(tile.pmText, tile.text), offset);
    return tile.start + Math.max(0, Math.min(tile.text.length, offset));
  }

  sourceOffsetToPos(offset: number): number {
    const target = this.tileForInsert(Math.max(0, Math.min(offset, this.ytext.length)));
    const index = this.nodeIndexes()[target];
    const at = nodePosition(this.baseDoc, index);
    const tile = this.tiles[target];
    const nodes = children(this.baseDoc, index, index + tile.count);
    let local = offset - tile.start;
    if (tile.pmText !== undefined && tile.pmText !== tile.text) local = mapOffset(diffText(tile.text, tile.pmText), local);
    const relative = alignedPosition(alignRun(nodes, tile.pmText ?? tile.text), local);
    const pos = at + (relative ?? 0);
    return this.editor.state.doc === this.baseDoc ? pos : this.pendingMapping.map(pos);
  }

  posToRelativePosition(pos: number, assoc = 0) {
    return Y.createRelativePositionFromTypeIndex(this.ytext, this.posToSourceOffset(pos), assoc);
  }

  relativePositionToPos(position: Y.RelativePosition | RelativePositionJSON) {
    const offset = relativePositionToSourceOffset(this.ytext, position);
    return offset === null ? null : this.sourceOffsetToPos(offset);
  }

  verify(): TiptapBridgeIssue[] {
    const issues: TiptapBridgeIssue[] = [];
    const doc = this.editor.state.doc;
    if (doc !== this.baseDoc) issues.push({ tile: -1, kind: "document", message: "Local changes are not flushed." });
    if (this.hasDirty || this.queue.length) issues.push({ tile: -1, kind: "document", message: "Remote changes are not applied." });
    const source = this.ytext.toString();
    if (this.tiles.map((tile) => tile.text).join("") !== source) issues.push({ tile: -1, kind: "document", message: "Tiles do not spell the Y.Text." });
    const total = this.tiles.reduce((sum, tile) => sum + tile.count, 0);
    if (total !== doc.childCount) issues.push({ tile: -1, kind: "document", message: `Tiles count ${total} nodes, the document has ${doc.childCount}.` });
    if (issues.length) return issues;
    let index = 0, offset = 0;
    const whole = this.tiles.every((tile) => tile.kind === "gap" || tile.type === "definition") && total === 1;
    this.tiles.forEach((tile, i) => {
      if (tile.start !== offset) issues.push({ tile: i, kind: tile.kind, message: `Tile starts at ${tile.start}, expected ${offset}.` });
      offset += tile.text.length;
      const nodes = children(doc, index, index + tile.count);
      index += tile.count;
      if (tile.kind === "gap") {
        const expected = whole ? (i === 0 ? 1 : 0) : gapEmptyParagraphs(this.codec, tile.text, gapEdge(i, this.tiles.length, true, true));
        if (tile.count !== expected || !nodes.every(isEmptyParagraph)) issues.push({ tile: i, kind: "gap", message: `Gap ${JSON.stringify(tile.text)} holds ${tile.count} nodes, expected ${expected} empty paragraphs.` });
      } else if (tile.kind === "block") {
        const parsed = this.parseBlock(tile.text);
        if (Fragment.fromArray(parsed).eq(Fragment.fromArray(nodes))) return;
        // Locally edited blocks keep the user's nodes; their serialization is the
        // source, possibly with edge whitespace that remark counts as gap.
        const lf = (text: string) => text.replace(/\r\n/g, "\n");
        const serialized = nodes.map((node) => isEmptyParagraph(node) ? "" : this.codec.serializeNode(node)).join("\n\n");
        const lead = serialized.length - serialized.trimStart().length, trail = serialized.length - serialized.trimEnd().length;
        if (serialized !== lf(tile.text) && lf(source.slice(tile.start - lead, tileEnd(tile) + trail)) !== serialized) issues.push({ tile: i, kind: "block", message: `Block ${JSON.stringify(tile.text)} is shown as ${JSON.stringify(serialized)}.` });
      } else issues.push({ tile: i, kind: "dirty", message: "Unreconciled tile." });
    });
    return issues;
  }

  destroy() {
    if (this.destroyed) return;
    if (!this.editor.isDestroyed) {
      try { this.localPhase(true); } catch (error) { this.options.onError?.(error); }
    }
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ytext.unobserve(this.onYEvent);
    this.editor.off("beforeTransaction", this.onBeforeTransaction);
    this.editor.off("transaction", this.onTransaction);
    this.editor.off("selectionUpdate", this.onSelection);
    this.editor.off("blur", this.onBlur);
    this.window?.removeEventListener("pagehide", this.onPageHide);
    this.undoManager.off("stack-item-added", this.onStackItemStored);
    this.undoManager.off("stack-item-updated", this.onStackItemStored);
    this.undoManager.off("stack-item-popped", this.onStackItemPopped);
    this.undoManager.destroy();
    if (collabHistoryTarget(this.editor) === this) setCollabHistoryTarget(this.editor, null);
    if (!this.editor.isDestroyed) {
      this.editor.view.dom.removeEventListener("compositionend", this.onCompositionEnd);
      // Plugin keys are "name$" or "name$N"; unregisterPlugin matches by "name$" prefix.
      for (const key of this.registeredPlugins) this.editor.unregisterPlugin(key.replace(/\$\d*$/, ""));
    }
    // Others should not see a caret for a closed editor.
    if (this.awareness?.getLocalState()?.cursor) this.awareness.setLocalStateField("cursor", null);
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Event handlers

  private onYEvent = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin instanceof this.originClass) return;
    this.queue.push(deltaToOps(event.delta as TextDelta));
    // Our own write is still updating the tiles; its events come first.
    if (this.inLocalWrite) return;
    this.drainQueue();
    this.requestSync();
  };

  private onBeforeTransaction = ({ transaction }: { transaction: Transaction }) => {
    // Send typing before a paste, so each change carries its own provenance.
    if (this.destroyed || !transaction.docChanged || transaction.getMeta(TIPTAP_BRIDGE_META) || !isPaste(transaction)) return;
    if (this.editor.state.doc === this.baseDoc || this.editor.view.composing) return;
    this.blocked++;
    try { this.localPhase(); } catch (error) { this.fail(error); } finally { this.blocked--; }
  };

  private onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
    if (this.destroyed) return;
    const own = !!transaction.getMeta(TIPTAP_BRIDGE_META);
    let changed = false, paste = false;
    for (const tr of own ? appendedTransactions : [transaction, ...appendedTransactions]) {
      if (!tr.docChanged) continue;
      this.pendingMapping.appendMapping(tr.mapping);
      changed = true;
      paste ||= isPaste(tr);
    }
    if (changed) {
      if (paste) this.pendingProvenance = PASTE;
      else this.pendingProvenance ??= TYPING;
      this.schedule(paste ? 0 : this.flushDelay);
    }
    if (this.held && !this.editor.view.composing) this.schedule(0);
  };

  private onSelection = () => {
    if (!this.destroyed && this.isSynced()) this.publishCursor();
  };

  private onBlur = () => { this.sync(); };
  private onPageHide = () => { this.sync(); };
  private onCompositionEnd = () => {
    // ProseMirror applies the composed text right after compositionend.
    setTimeout(() => { if (!this.destroyed) this.sync(); }, 0);
  };

  private onStackItemStored = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
    if (this.destroyed || this.editor.isDestroyed) return;
    const { anchor, head } = this.editor.state.selection;
    stackItem.meta.set(SELECTION_META, { anchor: this.posToRelativePosition(anchor), head: this.posToRelativePosition(head) });
  };

  private onStackItemPopped = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
    const stored = stackItem.meta.get(SELECTION_META) as { anchor: Y.RelativePosition; head: Y.RelativePosition } | undefined;
    if (!stored || this.destroyed || !this.isSynced()) return;
    const anchor = this.relativePositionToPos(stored.anchor), head = this.relativePositionToPos(stored.head);
    if (anchor === null || head === null) return;
    const state = this.editor.state;
    const tr = state.tr.setSelection(nearSelection(state.doc, anchor, head)).setMeta(TIPTAP_BRIDGE_META, "selection").setMeta("addToHistory", false);
    this.dispatch(tr);
  };

  // -------------------------------------------------------------------------
  // Scheduling

  private schedule(delay: number) {
    if (this.destroyed || (this.timer !== null && delay >= this.timerDelay)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerDelay = delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDelay = Infinity;
      this.sync();
    }, delay);
  }

  private requestSync() {
    if (this.syncing) { this.again = true; return; }
    if (this.blocked > 0) { this.schedule(0); return; }
    this.sync();
  }

  private sync() {
    if (this.destroyed || this.editor.isDestroyed) return;
    if (this.syncing) { this.again = true; return; }
    if (this.blocked > 0) { this.schedule(0); return; }
    if (this.editor.view.composing) { this.held = true; return; }
    this.held = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; this.timerDelay = Infinity; }
    this.syncing = true;
    let changed = false;
    try {
      do {
        this.again = false;
        changed = this.localPhase() || changed;
        this.drainQueue();
        changed = this.remotePhase() || changed;
      } while (this.again || this.queue.length);
    } catch (error) {
      this.syncing = false;
      this.fail(error);
      return;
    }
    this.syncing = false;
    if (changed) this.listeners.forEach((listener) => listener());
    this.publishCursor();
  }

  private fail(error: unknown) {
    this.options.onError?.(error);
    this.queue = [];
    // Inside a ProseMirror dispatch: rebuild right after it instead.
    if (this.blocked > 0) { setTimeout(() => this.recover()); return; }
    this.recover();
  }

  private recover() {
    if (this.destroyed || this.editor.isDestroyed) return;
    this.queue = [];
    try {
      this.rebuild();
    } catch (rebuildError) {
      this.options.onError?.(rebuildError);
    }
    this.setReadOnly("The Visual editor could not stay in step with the shared document. Switch to Source to edit it.");
  }

  private publishCursor() {
    const awareness = this.options.awareness;
    if (!awareness || this.destroyed || !this.isSynced()) return;
    if (this.options.cursorRequiresFocus !== false && !this.editor.view.hasFocus()) return;
    const { anchor, head } = this.editor.state.selection;
    publishAwarenessCursor(awareness, this.ytext, this.posToSourceOffset(anchor), this.posToSourceOffset(head));
  }

  private dispatch(tr: Transaction) {
    // Before dispatching: appended transactions from other plugins are local
    // changes on top of this document and are recorded by onTransaction.
    this.baseDoc = tr.doc;
    this.pendingMapping = new Mapping();
    this.blocked++;
    try { this.editor.view.dispatch(tr); } finally { this.blocked--; }
  }

  // -------------------------------------------------------------------------
  // Building

  /** Re-tiles the whole source and replaces the document if it differs (bind and recovery only). */
  private rebuild() {
    const source = this.ytext.toString();
    this.tiles = tilesForBlocks(source, 0, sourceBlocks(source));
    this.firstNodes = null;
    this.definitionsStale = true;
    this.hasDirty = false;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    const nodes = this.buildNodes(this.tiles, true, true);
    const fragment = Fragment.fromArray(nodes);
    const state = this.editor.state;
    if (state.doc.content.eq(fragment)) { this.adopt(state.doc); return; }
    const tr = state.tr.replaceWith(0, state.doc.content.size, fragment);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(state.selection.head, tr.doc.content.size))));
    this.dispatch(tr.setMeta("addToHistory", false).setMeta(TIPTAP_BRIDGE_META, "rebuild"));
    // Another plugin appended a change to the rebuilt document: send it.
    if (this.editor.state.doc !== this.baseDoc) this.schedule(0);
  }

  private definitionsText() {
    if (this.definitionsStale) {
      this.definitions = this.tiles.filter((tile) => tile.kind === "block" && tile.type === "definition").map((tile) => tile.text).join("\n\n");
      this.definitionsStale = false;
    }
    return this.definitions;
  }

  /** Nodes for one source block. Reference definitions elsewhere in the note are appended so links resolve. */
  private parseBlock(text: string) {
    const definitions = this.definitionsText();
    return this.codec.parse(definitions && text.includes("]") ? `${text}\n\n${definitions}` : text);
  }

  /** Parses tiles into nodes and sets their counts. */
  private buildNodes(tiles: Tile[], leftEdge: boolean, rightEdge: boolean) {
    const nodes: ProseMirrorNode[] = [];
    const paragraph = this.codec.schema.nodes.paragraph;
    tiles.forEach((tile, index) => {
      if (tile.kind === "gap") {
        tile.count = gapEmptyParagraphs(this.codec, tile.text, gapEdge(index, tiles.length, leftEdge, rightEdge));
        for (let k = 0; k < tile.count; k++) nodes.push(paragraph.create());
      } else {
        const parsed = this.parseBlock(tile.text);
        tile.count = parsed.length;
        nodes.push(...parsed);
      }
    });
    // ProseMirror documents need a block: an empty note is one empty paragraph.
    if (leftEdge && rightEdge && nodes.length === 0) {
      tiles[0].count = 1;
      nodes.push(paragraph.create());
    }
    return nodes;
  }

  /** Gives new tiles the counts of nodes that already stand for them, or returns false. */
  private assignCounts(tiles: Tile[], nodes: readonly ProseMirrorNode[], leftEdge: boolean, rightEdge: boolean) {
    const counts: number[] = [];
    let index = 0;
    for (let k = 0; k < tiles.length; k++) {
      const tile = tiles[k];
      if (tile.kind === "gap") {
        const empties = gapEmptyParagraphs(this.codec, tile.text, gapEdge(k, tiles.length, leftEdge, rightEdge));
        for (let m = 0; m < empties; m++) if (!isEmptyParagraph(nodes[index + m])) return false;
        counts.push(empties);
        index += empties;
      } else if (tile.type === "definition") {
        counts.push(0);
      } else {
        const node = nodes[index];
        if (!node || !nodeMatchesBlock(node, tile.type ?? "", tile.text)) return false;
        counts.push(1);
        index++;
      }
    }
    if (leftEdge && rightEdge && index === 0 && nodes.length === 1 && isEmptyParagraph(nodes[0])) { counts[0] = 1; index = 1; }
    if (index !== nodes.length) return false;
    tiles.forEach((tile, k) => { tile.count = counts[k]; });
    return true;
  }

  // -------------------------------------------------------------------------
  // Tile lookup

  /** first[i]: index of the first top-level node of tile i (cached until the tiles change). */
  private nodeIndexes(): number[] {
    if (!this.firstNodes) {
      const first = new Array<number>(this.tiles.length + 1);
      first[0] = 0;
      for (let i = 0; i < this.tiles.length; i++) first[i + 1] = first[i] + this.tiles[i].count;
      this.firstNodes = first;
    }
    return this.firstNodes;
  }

  /**
   * Replaces `remove` tiles at `index`, keeping the node-index cache current.
   * A keystroke swaps tiles one for one with the same node counts, so the
   * usual update touches only the replaced entries.
   */
  private spliceTiles(index: number, remove: number, tiles: Tile[]) {
    const removed = this.tiles.splice(index, remove, ...tiles);
    // Keep the dirty range covering tiles that this splice moves.
    const growth = tiles.length - remove;
    if (growth > 0 && index <= this.dirtyMax) this.dirtyMax += growth;
    if (growth < 0 && index < this.dirtyMin && this.dirtyMin !== Infinity) this.dirtyMin = Math.max(index, this.dirtyMin + growth);
    const first = this.firstNodes;
    if (!first) return;
    const delta = tiles.reduce((sum, tile) => sum + tile.count, 0) - removed.reduce((sum, tile) => sum + tile.count, 0);
    const inner: number[] = [];
    for (let k = 0, at = first[index]; k < tiles.length; k++) inner.push(at += tiles[k].count);
    if (remove === tiles.length) {
      for (let k = 0; k < inner.length; k++) first[index + 1 + k] = inner[k];
    } else first.splice(index + 1, remove, ...inner);
    if (delta) for (let k = index + 1 + tiles.length; k < first.length; k++) first[k] += delta;
  }

  // Indices only move down when tiles before them merge, and every merge goes
  // through here, so [dirtyMin, dirtyMax] always covers the dirty tiles.
  private noteDirty(from: number, to: number) {
    this.dirtyMin = Math.min(this.dirtyMin, from);
    this.dirtyMax = Math.max(this.dirtyMax, to);
  }

  /** Index of the tile holding top-level node `node`. */
  private tileOfNode(node: number) {
    const first = this.nodeIndexes();
    let lo = 0, hi = this.tiles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (first[mid] <= node) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Index of the tile holding the character at `offset`. */
  private tileForChar(offset: number) {
    const tiles = this.tiles;
    let lo = 0, hi = tiles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tiles[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Tile an insertion at `offset` belongs to: text typed at a block's edge belongs to the block. */
  private tileForInsert(offset: number) {
    const index = this.tileForChar(offset);
    const tile = this.tiles[index];
    if (tile.start === offset && index > 0 && tile.kind === "gap" && this.tiles[index - 1].kind !== "gap") return index - 1;
    return index;
  }

  /** Merges tiles `from..to` into one dirty tile with `op` applied. */
  private markDirty(from: number, to: number, op: TextOp) {
    const parts = this.tiles.slice(from, to + 1);
    const start = parts[0].start;
    const text = parts.map((tile) => tile.text).join("");
    const pmText = parts.map((tile) => tile.pmText ?? tile.text).join("");
    const count = parts.reduce((sum, tile) => sum + tile.count, 0);
    const next = text.slice(0, op.from - start) + op.insert + text.slice(op.to - start);
    if (parts.some((tile) => tile.type === "definition") || op.insert.includes("]:")) this.definitionsStale = true;
    this.spliceTiles(from, to - from + 1, [{ kind: "dirty", start, text: next, pmText, count }]);
    this.noteDirty(from, to);
    const shift = op.insert.length - (op.to - op.from);
    if (shift) for (let i = from + 1; i < this.tiles.length; i++) this.tiles[i].start += shift;
    this.hasDirty = true;
  }

  private drainQueue() {
    while (this.queue.length) {
      const ops = this.queue.shift()!;
      // Simultaneous operations: apply from the end so earlier offsets stay valid.
      for (let k = ops.length - 1; k >= 0; k--) {
        const op = ops[k];
        if (op.from === op.to) {
          const index = this.tileForInsert(op.from);
          this.markDirty(index, index, op);
        } else this.markDirty(this.tileForChar(op.from), this.tileForChar(op.to - 1), op);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Local → Y

  /** Sends local ProseMirror changes to Y.Text. Returns whether anything was sent. */
  private localPhase(force = false): boolean {
    const doc = this.editor.state.doc;
    const base = this.baseDoc;
    if (doc === base) return false;
    if (!force && this.editor.view.composing) { this.held = true; return false; }
    const oldCount = base.childCount, newCount = doc.childCount;
    let a = 0;
    while (a < oldCount && a < newCount && sameNode(base.child(a), doc.child(a))) a++;
    let b = 0;
    while (b < oldCount - a && b < newCount - a && sameNode(base.child(oldCount - 1 - b), doc.child(newCount - 1 - b))) b++;
    const oldEnd = oldCount - b, delta = newCount - oldCount;
    if (a === oldEnd && delta === 0) { this.adopt(doc); return false; }

    const tiles = this.tiles;
    const first = this.nodeIndexes();
    const tileOfNode = (node: number) => this.tileOfNode(node);
    let t0: number, t1: number;
    if (a < oldEnd) {
      t0 = tileOfNode(a);
      t1 = tileOfNode(oldEnd - 1);
    } else {
      // Nodes inserted between existing ones: inside a multi-node tile, or into a gap.
      const inside = tileOfNode(a);
      if (first[inside] < a) t0 = t1 = inside;
      else {
        let gap = -1;
        for (let i = Math.max(0, inside - 2); i < tiles.length && first[i] <= a; i++) {
          if (tiles[i].kind !== "block" && first[i + 1] >= a) { gap = i; break; }
        }
        if (gap >= 0) t0 = t1 = gap;
        else { t1 = inside; t0 = Math.max(0, inside - 1); }
      }
    }
    const regionNodes = (from: number, to: number) => children(doc, first[from], first[to + 1] + delta);
    let nodes = regionNodes(t0, t1);
    const simple = t0 === t1 && tiles[t0].kind === "block" && nodes.length === tiles[t0].count && !nodes.some(isEmptyParagraph);
    if (!simple) {
      // Structural change: rewrite from the end of the block on the left to the
      // start of the block on the right, so blank lines (empty paragraphs) and
      // block separators are regenerated consistently.
      if (t0 > 0 && tiles[t0].kind === "block") t0--;
      while (t0 > 0 && tiles[t0 - 1].kind !== "block") t0--;
      if (t1 < tiles.length - 1 && tiles[t1].kind === "block") t1++;
      while (t1 < tiles.length - 1 && tiles[t1 + 1].kind !== "block") t1++;
      nodes = regionNodes(t0, t1);
    }
    let replacement = simple
      ? nodes.map((node) => this.codec.serializeNode(node)).join("\n\n")
      : serializeRun(this.codec, nodes, t0 > 0, t1 < tiles.length - 1);
    if (simple) {
      // remark leaves a paragraph's edge spaces in the neighbouring gaps, yet the
      // node still shows them. Diff against block plus those spaces, so a space
      // typed at the edge is sent once and an existing one is not sent again.
      const before = t0 > 0 && tiles[t0 - 1].kind === "gap" ? /[ \t]*$/.exec(tiles[t0 - 1].text)![0] : "";
      const after = t0 < tiles.length - 1 && tiles[t0 + 1].kind === "gap" ? /^[ \t]*/.exec(tiles[t0 + 1].text)![0] : "";
      if (before || after) {
        const left = before ? tiles[t0 - 1].text.slice(0, -before.length) : "";
        const right = after ? tiles[t0 + 1].text.slice(after.length) : "";
        // Spaces the serializer dropped at an edge stay where they are.
        const lead = /^[ \t]*/.exec(replacement)![0], trail = /[ \t]*$/.exec(replacement)![0];
        replacement = left + (lead ? "" : before) + replacement + (trail ? "" : after) + right;
        if (before) t0--;
        if (after) t1++;
        // The gaps' empty paragraphs are part of the rewritten tiles now.
        nodes = regionNodes(t0, t1);
      }
    }
    let baseText = "", theirs = "";
    for (let i = t0; i <= t1; i++) {
      baseText += tiles[i].pmText ?? tiles[i].text;
      theirs += tiles[i].text;
    }
    // The serializer writes "\n"; keep a Windows note's CRLF line endings.
    const crlf = baseText.includes("\r\n") || (!baseText.includes("\n") && (tiles[t0 - 1]?.text ?? tiles[t1 + 1]?.text ?? "").includes("\r\n"));
    if (crlf) replacement = replacement.replace(/\r?\n/g, "\r\n");
    const start = tiles[t0].start;
    const localOps = diffText(baseText, replacement);
    // Remote changes already in these tiles but not yet in ProseMirror: rebase.
    const ops = baseText === theirs ? localOps : rebaseOps(localOps, diffText(baseText, theirs));
    const finalText = applyTextOps(theirs, ops);
    if (tiles.slice(t0, t1 + 1).some((tile) => tile.type === "definition") || replacement.includes("]:")) this.definitionsStale = true;
    // The re-tiling (and a reparse, if the source now means something else)
    // happens in the remote phase, which treats this like any changed tile.
    this.spliceTiles(t0, t1 - t0 + 1, [{ kind: "dirty", start, text: finalText, pmText: replacement, count: nodes.length }]);
    this.noteDirty(t0, t1);
    const shift = finalText.length - theirs.length;
    if (shift) for (let i = t0 + 1; i < tiles.length; i++) tiles[i].start += shift;
    this.hasDirty = true;
    this.adopt(doc);
    const explicit = this.nextProvenance;
    const provenance = explicit ?? this.pendingProvenance ?? TYPING;
    this.pendingProvenance = null;
    this.nextProvenance = null;
    if (!ops.length) return true;
    // A change with explicit provenance (an AI action) is its own undo step.
    if (explicit) this.undoManager.stopCapturing();
    this.inLocalWrite = true;
    try {
      this.doc.transact(() => {
        for (let k = ops.length - 1; k >= 0; k--) {
          const op = ops[k];
          if (op.to > op.from) this.ytext.delete(start + op.from, op.to - op.from);
          if (op.insert) this.ytext.insert(start + op.from, op.insert);
        }
      }, new this.originClass(this.id, provenance));
    } finally {
      this.inLocalWrite = false;
    }
    if (explicit) this.undoManager.stopCapturing();
    // Remote updates that arrived during our write are behind it in Y order.
    if (this.queue.length && !this.syncing) {
      this.drainQueue();
      this.requestSync();
    }
    return true;
  }

  private adopt(doc: ProseMirrorNode) {
    this.baseDoc = doc;
    this.pendingMapping = new Mapping();
  }

  // -------------------------------------------------------------------------
  // Y → local

  /** Re-tiles changed tiles and replaces their nodes. Returns whether tiles changed. */
  private remotePhase(): boolean {
    if (!this.hasDirty) return false;
    const state = this.editor.state;
    if (state.doc !== this.baseDoc) return false;
    const tr = state.tr;
    const ends = [state.selection.anchor, state.selection.head];
    let moved = false;
    // A pass can mark neighbours stale (see markStaleEdges); a few passes settle it.
    for (let pass = 0; this.hasDirty && pass < 8; pass++) {
      this.hasDirty = false;
      const low = this.dirtyMin, high = Math.min(this.dirtyMax, this.tiles.length - 1);
      this.dirtyMin = Infinity;
      this.dirtyMax = -1;
      for (let index = high; index >= low; index--) {
        if (this.tiles[index].kind !== "dirty") continue;
        const span = this.resolveSpan(index);
        moved = this.applySpan(span, tr, ends) || moved;
        index = span.lo;
      }
    }
    if (!tr.docChanged) return true;
    // A selection outside the replaced nodes is mapped by ProseMirror itself.
    if (moved) tr.setSelection(nearSelection(tr.doc, ends[0], ends[1]));
    this.dispatch(tr.setMeta("addToHistory", false).setMeta(TIPTAP_BRIDGE_META, "remote"));
    return true;
  }

  /**
   * The smallest run of tiles around dirty tile `index` whose re-tiling is
   * stable: the clean blocks on either side parse to themselves. Otherwise
   * (an unclosed fence, merged lists) widen, doubling each time.
   */
  private resolveSpan(index: number): Span {
    const tiles = this.tiles;
    let lo = index, hi = index;
    while (lo > 0 && tiles[lo - 1].kind !== "block") lo--;
    while (hi < tiles.length - 1 && tiles[hi + 1].kind !== "block") hi++;
    let stepLeft = 1, stepRight = 1;
    for (;;) {
      const left = lo - 1, right = hi + 1;
      const hasLeft = left >= 0, hasRight = right < tiles.length;
      const windowFrom = hasLeft ? left : lo, windowTo = hasRight ? right : hi;
      const start = tiles[windowFrom].start;
      let text = "";
      for (let i = windowFrom; i <= windowTo; i++) text += tiles[i].text;
      const blocks = sourceBlocks(text, start);
      const leftOk = !hasLeft || (blocks.length > 0 && blocks[0].start === tiles[left].start && blocks[0].end === tileEnd(tiles[left]));
      const last = blocks.at(-1);
      const rightOk = !hasRight || (!!last && last.start === tiles[right].start && last.end === tileEnd(tiles[right]));
      if (leftOk && rightOk) {
        const interior = blocks.slice(hasLeft ? 1 : 0, hasRight ? blocks.length - 1 : blocks.length);
        const from = tiles[lo].start, to = tileEnd(tiles[hi]);
        return { lo, hi, tiles: tilesForBlocks(text.slice(from - start, to - start), from, interior), leftEdge: !hasLeft, rightEdge: !hasRight };
      }
      if (!leftOk) {
        for (let passed = 0; lo > 0 && passed < stepLeft;) if (tiles[--lo].kind === "block") passed++;
        while (lo > 0 && tiles[lo - 1].kind !== "block") lo--;
        stepLeft *= 2;
      }
      if (!rightOk) {
        for (let passed = 0; hi < tiles.length - 1 && passed < stepRight;) if (tiles[++hi].kind === "block") passed++;
        while (hi < tiles.length - 1 && tiles[hi + 1].kind !== "block") hi++;
        stepRight *= 2;
      }
    }
  }

  /** Swaps a span's tiles (and, if needed, nodes) in. `ends` holds the selection, mapped in place. */
  private applySpan(span: Span, tr: Transaction, ends: number[]): boolean {
    const { lo, hi, leftEdge, rightEdge } = span;
    const old = this.tiles.slice(lo, hi + 1);
    const nodeStart = this.nodeIndexes()[lo];
    const oldCount = old.reduce((sum, tile) => sum + tile.count, 0);
    const oldNodes = children(tr.doc, nodeStart, nodeStart + oldCount);
    if (old.some((tile) => tile.type === "definition") || span.tiles.some((tile) => tile.type === "definition")) this.definitionsStale = true;
    const represented = old.every((tile) => !tile.stale && (tile.pmText === undefined || tile.pmText === tile.text));
    const oldText = old.map((tile) => tile.pmText ?? tile.text).join("");
    const newText = span.tiles.map((tile) => tile.text).join("");
    const newCount = () => span.tiles.reduce((sum, tile) => sum + tile.count, 0);
    // The nodes already mean this source (a local edit, or text that changed back).
    if (represented && this.assignCounts(span.tiles, oldNodes, leftEdge, rightEdge)) {
      this.spliceTiles(lo, hi - lo + 1, span.tiles);
      this.markStaleEdges(lo, span.tiles.length, nodeStart, newCount(), tr.doc, oldText, newText);
      return false;
    }
    const nodes = this.buildNodes(span.tiles, leftEdge, rightEdge);
    this.spliceTiles(lo, hi - lo + 1, span.tiles);
    if (Fragment.fromArray(nodes).eq(Fragment.fromArray(oldNodes))) {
      this.markStaleEdges(lo, span.tiles.length, nodeStart, newCount(), tr.doc, oldText, newText);
      return false;
    }
    const from = nodePosition(tr.doc, nodeStart);
    const to = from + oldNodes.reduce((sum, node) => sum + node.nodeSize, 0);
    let changes: TextOp[] | null = null;
    let oldAlign: ReturnType<typeof alignRun> | null = null, newAlign: ReturnType<typeof alignRun> | null = null;
    const inside = ends.map((pos) => pos > from && pos < to);
    const restored = ends.map((pos, k) => {
      if (!inside[k]) return pos;
      // Keep the caret on the same source character: position → source offset
      // in the old text → mapped through the change → position in the new nodes.
      changes ??= diffText(oldText, newText);
      oldAlign ??= alignRun(oldNodes, oldText);
      newAlign ??= alignRun(nodes, newText);
      const offset = mapOffset(changes, alignedOffset(oldAlign, pos - from), -1);
      return from + (alignedPosition(newAlign, offset) ?? 0);
    });
    const steps = tr.steps.length;
    tr.replaceWith(from, to, nodes);
    this.markStaleEdges(lo, span.tiles.length, nodeStart, newCount(), tr.doc, oldText, newText);
    if (tr.steps.length === steps) return false;
    const map = tr.steps[tr.steps.length - 1].getMap();
    ends.forEach((pos, k) => { ends[k] = inside[k] ? restored[k] : map.map(pos); });
    return inside.some(Boolean);
  }

  /**
   * remark puts a paragraph's edge whitespace in the neighbouring gap. When a
   * remote change rewrote that whitespace, a locally typed node next to it may
   * still show a space the source no longer has: reparse such neighbours.
   */
  private markStaleEdges(lo: number, length: number, nodeStart: number, count: number, doc: ProseMirrorNode, oldText: string, newText: string) {
    const lead = (text: string) => /^\s*/.exec(text)![0], trail = (text: string) => /\s*$/.exec(text)![0];
    const left = lo - 1, right = lo + length;
    if (left >= 0 && lead(oldText) !== lead(newText)) this.markStaleBlock(left, nodeStart - this.tiles[left].count, doc);
    if (right < this.tiles.length && trail(oldText) !== trail(newText)) this.markStaleBlock(right, nodeStart + count, doc);
  }

  private markStaleBlock(index: number, nodeIndex: number, doc: ProseMirrorNode) {
    const tile = this.tiles[index];
    if (tile.kind !== "block" || tile.count === 0) return;
    const nodes = children(doc, nodeIndex, nodeIndex + tile.count);
    const first = nodes[0].textContent, last = nodes[nodes.length - 1].textContent;
    if (!/^\s/.test(first) && !/\s$/.test(last)) return;
    const serialized = nodes.map((node) => isEmptyParagraph(node) ? "" : this.codec.serializeNode(node)).join("\n\n");
    if (serialized === tile.text) return;
    const before = this.tiles[index - 1]?.text ?? "", after = this.tiles[index + 1]?.text ?? "";
    const leadLength = serialized.length - serialized.trimStart().length, trailLength = serialized.length - serialized.trimEnd().length;
    const around = before + tile.text + after;
    if (around.slice(before.length - leadLength, before.length + tile.text.length + trailLength) === serialized) return;
    this.tiles[index] = { ...tile, kind: "dirty", pmText: tile.text, stale: true };
    this.noteDirty(index, index);
    this.hasDirty = true;
  }
}
