// Shared harness for the Visual-bridge tests: headless Tiptap editors (jsdom)
// bridged to their own Y.Docs, a network that syncs the docs on demand, and a
// raw Y.Text participant standing in for a CodeMirror user.

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { bindTiptapToYText, type TiptapYTextBridge, type TiptapYTextBridgeOptions } from "../../src/lib/collab/bindings/tiptap-ytext";
import { TiptapCollabHistory } from "../../src/lib/collab/bindings/tiptap-history";
import { serializeRun, editorMarkdownCodec } from "../../src/lib/collab/bindings/tiptap-blocks";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  const value = (dom.window as unknown as Record<string, unknown>)[key];
  const bound = key === "getComputedStyle" || key === "requestAnimationFrame" || key === "cancelAnimationFrame";
  Object.defineProperty(globalThis, key, { value: bound ? (value as (...args: unknown[]) => unknown).bind(dom.window) : value, configurable: true });
}

export const NETWORK = Symbol("network");

/** Syncs Y.Docs. With `auto` every update is delivered at once; otherwise on `deliver()`. */
export class Network {
  private queues = new Map<Y.Doc, Uint8Array[]>();
  constructor(readonly docs: Y.Doc[], public auto = false) {
    for (const doc of docs) {
      this.queues.set(doc, []);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === NETWORK) return;
        for (const other of docs) {
          if (other === doc) continue;
          if (this.auto) Y.applyUpdate(other, update, NETWORK);
          else this.queues.get(other)!.push(update);
        }
      });
    }
  }

  /** Delivers queued updates (in random order per destination when `shuffle` is given). */
  deliver(shuffle?: () => number) {
    for (let guard = 0; guard < 1000; guard++) {
      const pending = this.docs.filter((doc) => this.queues.get(doc)!.length);
      if (!pending.length) return;
      const doc = shuffle ? pending[Math.floor(shuffle() * pending.length)] : pending[0];
      const queue = this.queues.get(doc)!;
      const index = shuffle ? Math.floor(shuffle() * queue.length) : 0;
      // Yjs tolerates out-of-order updates: it holds them until dependencies arrive.
      Y.applyUpdate(doc, queue.splice(index, 1)[0], NETWORK);
    }
    throw new Error("Network did not settle.");
  }
}

export interface Participant {
  doc: Y.Doc;
  ytext: Y.Text;
  editor: Editor;
  bridge: TiptapYTextBridge;
  awareness: Awareness;
  errors: unknown[];
}

export function createEditor(content = "") {
  const [InlineMath, BlockMath] = createMathExtensions();
  return new Editor({
    extensions: [...createMarkdownExtensions("Notes/shared.md"), TiptapCollabHistory, InlineMath, BlockMath],
    content,
    contentType: "markdown",
  });
}

/**
 * With `emptyEditor`, the editor starts empty and the bridge builds the
 * document block by block (linear), instead of Tiptap parsing the whole note.
 */
export function createVisualParticipant(doc: Y.Doc, options: Partial<TiptapYTextBridgeOptions> = {}, { emptyEditor = false } = {}): Participant {
  const ytext = doc.getText(ContentKeys.source);
  const editor = createEditor(emptyEditor ? "" : ytext.toString());
  const awareness = new Awareness(doc);
  const errors: unknown[] = [];
  const bridge = bindTiptapToYText({ editor, ytext, awareness, cursorRequiresFocus: false, flushDelay: 1_000_000, onError: (error) => errors.push(error), ...options });
  return { doc, ytext, editor, bridge, awareness, errors };
}

/** Three participants: two Visual editors and a raw Y.Text (a CodeMirror user). */
export function setupTrio(source: string, options: Partial<TiptapYTextBridgeOptions> = {}, clientIds?: number[]) {
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  // Fixed client ids make concurrent-merge order reproducible.
  if (clientIds) docs.forEach((doc, index) => { doc.clientID = clientIds[index]; });
  const network = new Network(docs);
  docs[0].getText(ContentKeys.source).insert(0, source);
  network.deliver();
  const a = createVisualParticipant(docs[0], options);
  const b = createVisualParticipant(docs[1], options);
  const c = { doc: docs[2], ytext: docs[2].getText(ContentKeys.source) };
  return { network, a, b, c, destroy() { for (const p of [a, b]) { p.bridge.destroy(); p.editor.destroy(); p.awareness.destroy(); } } };
}

/** The Markdown an editor's document stands for, with the bridge's block separators. */
export function serializedMarkdown(editor: Editor) {
  const nodes: import("@tiptap/pm/model").Node[] = [];
  editor.state.doc.forEach((node) => nodes.push(node));
  return serializeRun(editorMarkdownCodec(editor), nodes, false, false);
}

/** Position of `needle` in the document text plus `offset` (inside one text node). */
export function posOf(editor: Editor, needle: string, offset = 0) {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle) + offset;
    return true;
  });
  if (found < 0) throw new Error(`Text ${JSON.stringify(needle)} not found in ${JSON.stringify(editor.state.doc.textContent)}`);
  return found;
}

export function select(editor: Editor, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
}

/** Types like a user: one transaction per character at the selection. */
export function type(editor: Editor, text: string) {
  for (const char of text) editor.view.dispatch(editor.state.tr.insertText(char));
}

export function flushAll(...participants: { bridge: TiptapYTextBridge }[]) {
  for (const participant of participants) participant.bridge.flush();
}

/** Delivers everything until quiet: bridges flush, docs sync, remote changes apply. */
export function settle(network: Network, ...participants: { bridge: TiptapYTextBridge }[]) {
  for (let round = 0; round < 5; round++) {
    flushAll(...participants);
    network.deliver();
  }
}

export function assertConverged(trio: ReturnType<typeof setupTrio>, options: { canonical?: boolean } = {}) {
  const { a, b, c } = trio;
  const text = c.ytext.toString();
  assert.equal(a.ytext.toString(), text, "A's Y.Text differs");
  assert.equal(b.ytext.toString(), text, "B's Y.Text differs");
  for (const participant of [a, b]) {
    assert.deepEqual(participant.bridge.verify(), [], "bridge out of step");
    assert.deepEqual(participant.errors, []);
    if (options.canonical) assert.equal(serializedMarkdown(participant.editor), text, "serialized document differs from Y.Text");
  }
  return text;
}

test("harness: three docs sync through the network", () => {
  const trio = setupTrio("Hello");
  try {
    assert.equal(trio.b.ytext.toString(), "Hello");
    assert.equal(trio.a.editor.state.doc.textContent, "Hello");
    trio.c.ytext.insert(5, "!");
    trio.network.deliver();
    assertConverged(trio, { canonical: true });
    assert.equal(trio.b.editor.state.doc.textContent, "Hello!");
  } finally { trio.destroy(); }
});
