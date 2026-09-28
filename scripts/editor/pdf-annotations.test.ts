import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Editor } from "@tiptap/core";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import type { PdfAnnotationRect, PdfTextAnnotation } from "../../src/lib/types";
import { mergeHighlightRects } from "../../src/lib/pdf-annotation-style";
import { renderAnnotationMarkdown } from "../../src/lib/pdf-annotation-markdown";
import { TextAnnotationLayer } from "../../src/components/libera/text-annotation-layer";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
Object.assign(dom.window.HTMLElement.prototype, {
  setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
});
dom.window.document.elementFromPoint = () => null;
after(() => dom.window.close());


test("highlight rects collapse into one even band per line run", () => {
  // What a DOM selection hands back: per-span rects that overlap, duplicate
  // each other, and differ slightly in height across one line.
  const line = [
    { x: 0.1, y: 0.2, width: 0.2, height: 0.02 },
    { x: 0.1, y: 0.2, width: 0.2, height: 0.02 },
    { x: 0.28, y: 0.201, width: 0.15, height: 0.018 },
    { x: 0.431, y: 0.199, width: 0.1, height: 0.022 },
  ];
  const nextLine = [{ x: 0.1, y: 0.23, width: 0.3, height: 0.02 }];
  const merged = mergeHighlightRects([...line, ...nextLine], 600, 800);

  assert.equal(merged.length, 2, "one band per line");
  assert.ok(Math.abs(merged[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(merged[0].x + merged[0].width - 0.531) < 1e-9);
  assert.ok(merged[0].y + merged[0].height <= merged[1].y, "lines do not overlap");

  // A real gap on the same line (e.g. a column break) keeps two runs.
  const columns = mergeHighlightRects([
    { x: 0.1, y: 0.5, width: 0.3, height: 0.02 },
    { x: 0.6, y: 0.5, width: 0.3, height: 0.02 },
  ], 600, 800);
  assert.equal(columns.length, 2);
  assert.deepEqual(mergeHighlightRects([]), []);
});

test("note Markdown renders through the TipTap schema, is cached, and leaves global marked alone", () => {
  const html = renderAnnotationMarkdown("**Key** point\nsecond line\n\n- one\n- two\n\n<script>alert(1)</script>");

  assert.match(html, /<strong>Key<\/strong> point<br>second line/);
  assert.match(html, /<ul><li><p>one<\/p><\/li>/);
  assert.doesNotMatch(html, /script/);
  assert.equal(renderAnnotationMarkdown("**Key** point\nsecond line\n\n- one\n- two\n\n<script>alert(1)</script>"), html);
  assert.equal(marked.defaults.breaks, false, "the main editor's parser must keep its options");
});

test("note Markdown typesets math with KaTeX using the configured markers", () => {
  const html = renderAnnotationMarkdown("Energy $E=mc^2$, not `$x$`\n\n\\[\n\\int_0^1 x\\,dx\n\\]\n\nBad $\\frac{a$ end");
  const inline = html.match(/<span class="tiptap-mathematics-render" data-type="inline-math">/g) ?? [];

  assert.equal(inline.length, 2, "valid and invalid inline math both become math nodes");
  assert.match(html, /<span class="katex">[\s\S]*E=mc\^2/, "KaTeX output carries the TeX annotation");
  assert.match(html, /<div class="tiptap-mathematics-render" data-type="block-math"><div class="block-math-inner"><span class="katex-display">/);
  assert.match(html, /<code>\$x\$<\/code>/, "code spans stay literal");
  assert.match(html, /katex-error/, "invalid TeX renders KaTeX's inline error instead of throwing");
  assert.doesNotMatch(html, /data-type="inline-math"><\/span>/, "no empty placeholders remain");

  const brackets = { inlineMathMarkers: "\\( \\)", blockMathMarkers: "\\[ \\]" };
  const configured = renderAnnotationMarkdown("a \\(x<y\\) b and $z$", brackets);

  assert.match(configured, /data-type="inline-math"><span class="katex">[\s\S]*x&lt;y/);
  assert.match(configured, /and \$z\$/, "unconfigured markers stay text");
  assert.match(renderAnnotationMarkdown("a \\(x<y\\) b and $z$"), /and <span class="tiptap-mathematics-render"/, "cache is keyed by marker settings");
});

type LayerLog = {
  added: PdfAnnotationRect[];
  deleted: string[];
  exits: number;
  updates: [string, Partial<PdfTextAnnotation>][];
};

function note(overrides: Partial<PdfTextAnnotation> = {}): PdfTextAnnotation {
  return {
    id: "note", type: "text", pageNumber: 1, text: "**Bold** remark", fontSize: 10,
    color: "#c62828", fontFamily: "serif",
    rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
    createdAt: "2026-09-28", updatedAt: "2026-09-28",
    ...overrides,
  };
}

async function renderLayer(initial: PdfTextAnnotation[], options: { drawing?: boolean } = {}) {
  const log: LayerLog = { added: [], deleted: [], exits: 0, updates: [] };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  let setSelected: (id: string) => void = () => undefined;

  function Host() {
    const [annotations, setAnnotations] = useState(initial);
    const [selected, select] = useState("");
    setSelected = select;

    return createElement(TextAnnotationLayer, {
      annotations,
      drawing: options.drawing ?? false,
      interactive: true,
      pageSize: { width: 500, height: 700 },
      selectedAnnotationId: selected,
      onAddAnnotation: (rect) => {
        log.added.push(rect);
        const created = note({ id: "created", text: "", rect });
        setAnnotations((current) => [...current, created]);
        select(created.id);
        return created.id;
      },
      onDeleteAnnotation: (id) => {
        log.deleted.push(id);
        setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
      },
      onExitTextEditing: () => { log.exits += 1; },
      onSelectAnnotation: (annotation) => select(annotation.id),
      onUpdateAnnotation: (id, patch) => {
        log.updates.push([id, patch]);
        setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, ...patch } : annotation));
      },
    });
  }

  await act(async () => root.render(createElement(Host)));
  // Pointer maths runs against the layer's on-screen box.
  for (const layer of host.querySelectorAll<HTMLElement>(".z-30, .z-20")) {
    layer.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 500, 700);
  }

  return {
    host,
    log,
    select: (id: string) => act(async () => setSelected(id)),
    unmount: () => act(async () => root.unmount()),
  };
}

function pointer(target: Element, type: string, x = 60, y = 80) {
  target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
}

async function click(target: Element, x?: number, y?: number) {
  await act(async () => { pointer(target, "pointerdown", x, y); pointer(target, "pointerup", x, y); });
}

function editorElement(host: HTMLElement) {
  type Chain = { focus: (at: string) => Chain; insertContent: (value: string) => Chain; toggleItalic: () => Chain; run: () => boolean };
  return host.querySelector<HTMLElement & { editor?: { chain: () => Chain } }>(".pdf-note [contenteditable]");
}

test("resting notes are plain ink with Markdown formatting and no editor or backdrop", async () => {
  const layer = await renderLayer([note()]);
  const element = layer.host.querySelector<HTMLElement>(".pdf-note")!;

  assert.equal(element.querySelector("strong")?.textContent, "Bold");
  assert.equal(layer.host.querySelector("textarea, [contenteditable]"), null);
  assert.equal(element.style.color, "rgb(198, 40, 40)");
  assert.match(element.style.fontFamily, /Charter/);
  assert.equal(element.style.fontSize, "10px");
  assert.equal(element.style.background, "");
  await layer.unmount();
});

test("first click selects, second click edits, Esc commits the Markdown", async () => {
  const layer = await renderLayer([note()]);
  const element = () => layer.host.querySelector<HTMLElement>(".pdf-note")!;

  await click(element());
  assert.ok(element().hasAttribute("data-selected"));
  assert.equal(editorElement(layer.host), null, "a first click only selects");

  await click(element());
  const editor = editorElement(layer.host)!;
  assert.ok(editor, "clicking a selected note starts editing");
  assert.equal(editor.querySelector("strong")?.textContent, "Bold");

  // jsdom has no layout to map the click to a caret, so place it explicitly.
  await act(async () => { editor.editor!.chain().focus("end").insertContent(" ").toggleItalic().insertContent("added").run(); });
  await act(async () => editor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

  assert.equal(editorElement(layer.host), null, "Esc leaves editing");
  assert.ok(element().hasAttribute("data-selected"), "…but keeps the note selected");
  const [, patch] = layer.log.updates.at(-1)!;
  assert.equal(patch.text, "**Bold** remark *added*");
  assert.equal(element().querySelector("em")?.textContent, "added");
  await layer.unmount();
});

test("clicking an equation while editing reveals its source, and edits save as math", async () => {
  const layer = await renderLayer([note({ text: "Mass $m_0$ here\n\n\\[\n\\sum_i x_i\n\\]" })]);
  const element = () => layer.host.querySelector<HTMLElement>(".pdf-note")!;

  assert.ok(element().querySelector(".katex"), "resting notes are typeset");
  assert.ok(element().querySelector(".katex-display"), "display math is typeset");

  await click(element());
  await click(element());
  const { editor } = editorElement(layer.host) as unknown as { editor: Editor };
  const { view } = editor;
  // jsdom has no layout for ProseMirror to hit-test, so call the click prop directly.
  const clickMath = async (name: string) => {
    let pos = -1;
    view.state.doc.descendants((node, at) => { if (pos < 0 && node.type.name === name) pos = at; });
    assert.ok(pos >= 0, `${name} is a math node while editing`);
    const node = view.state.doc.nodeAt(pos)!;
    await act(async () => { view.someProp("handleClickOn", (handler) => handler(view, pos, node, pos, new dom.window.MouseEvent("click"), true)); });
  };

  await clickMath("inlineMath");
  const { from, to } = editor.state.selection;
  assert.equal(editor.state.doc.textBetween(from, to), "m_0", "the LaTeX is selected inside its markers");
  await act(async () => { editor.commands.insertContent("m_1^2"); });

  await clickMath("blockMath");
  const block = editor.state.selection;
  assert.equal(editor.state.doc.textBetween(block.from, block.to), "\\sum_i x_i");

  await act(async () => editorElement(layer.host)!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

  const [, patch] = layer.log.updates.at(-1)!;
  assert.equal(patch.text, "Mass $m_1^2$ here\n\n\\[\n\\sum_i x_i\n\\]", "equation source is saved unescaped");
  assert.equal(element().querySelectorAll(".katex").length, 2);
  await layer.unmount();
});

test("clicking away while editing commits, and a note left empty is discarded", async () => {
  const layer = await renderLayer([note(), note({ id: "blank", text: "", rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 } })]);
  const blank = layer.host.querySelector('[data-pdf-annotation-id="blank"]')!;

  await click(blank);
  await click(blank);
  assert.ok(editorElement(layer.host));
  await layer.select("");

  assert.equal(editorElement(layer.host), null);
  assert.deepEqual(layer.log.deleted, ["blank"]);
  assert.equal(layer.host.querySelector('[data-pdf-annotation-id="blank"]'), null);
  await layer.unmount();
});

test("dragging a note moves it locally and commits a single update on release", async () => {
  const layer = await renderLayer([note()]);
  const element = layer.host.querySelector<HTMLElement>(".pdf-note")!;

  await act(async () => {
    pointer(element, "pointerdown", 60, 80);
    pointer(element, "pointermove", 85, 80);
    pointer(element, "pointermove", 110, 115);
  });
  assert.equal(element.style.left, "100px", "follows the pointer before committing");
  assert.equal(layer.log.updates.length, 0);

  await act(async () => pointer(element, "pointerup", 110, 115));
  assert.equal(layer.log.updates.length, 1);
  const rect = layer.log.updates[0][1].rect!;
  assert.ok(Math.abs(rect.x - 0.2) < 1e-9 && Math.abs(rect.y - 0.15) < 1e-9);
  assert.equal(editorElement(layer.host), null, "a drag is not a click");
  await layer.unmount();
});

test("clicking with the text tool places a sized note and opens it for typing", async () => {
  const layer = await renderLayer([], { drawing: true });
  const surface = layer.host.querySelector(".pdf-note-draw-surface")!;

  await click(surface, 100, 140);

  assert.equal(layer.log.added.length, 1);
  const rect = layer.log.added[0];
  assert.ok(Math.abs(rect.x - 0.2) < 1e-9);
  assert.ok(rect.width * 500 >= 60 && rect.height * 700 > 30, "a click still yields a usable box");
  assert.equal(layer.log.exits, 1, "the host returns to its select tool");
  assert.ok(editorElement(layer.host), "the new note is ready for typing");
  await layer.unmount();
});

test("clipped notes open a scrollable reader that Esc collapses", async () => {
  const layer = await renderLayer([note()]);
  const element = layer.host.querySelector<HTMLElement>(".pdf-note")!;
  element.setAttribute("data-overflowing", "");

  await click(element);
  const reader = layer.host.querySelector('[role="dialog"][aria-label="Text annotation"]');
  assert.ok(reader, "reader opens on click");
  assert.equal(reader.querySelector("strong")?.textContent, "Bold");

  await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  assert.equal(layer.host.querySelector('[role="dialog"]'), null);
  assert.ok(element.hasAttribute("data-selected"), "Esc collapses before deselecting");
  await layer.unmount();
});
