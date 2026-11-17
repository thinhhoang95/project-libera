import assert from "node:assert/strict";
import "./setup.cjs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { AllSelection, NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";

function setupDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    innerHeight: 768, innerWidth: 1024,
  });
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect(),
  });
  return dom;
}
async function settle(delay: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });
}
function liveEditor(): Editor {
  return (document.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
}

const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
const source = [
  "# Title", "", "Plain paragraph one.", "", words, "",
  "- a", "  - b", "    - c", "- d", "",
  "1. one", "2. two", "",
  "- [ ] task a", "  - [ ] sub task", "- [x] task b", "",
  "> quoted text", "", "Tail paragraph.", "",
].join("\n");

async function mount(shared = false) {
  const dom = setupDom();
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  const root = createRoot(document.getElementById("root")!);
  let commits = 0;
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Profiler, { id: "e", onRender: () => commits++ }, createElement(TiptapMarkdownEditor, {
      documentPath: "Notes/toolbar.md", value: source, fontSizePx: 16, lineHeight: 1.5, markdownZoom: 100,
      onMarkdownZoomChange: () => {}, onRegisterDraft: () => () => {},
      onChange: () => {}, onViewStateChange: () => {}, onSave: async () => {}, onOpenFileLink: async () => false,
    }))));
  });
  await settle(100);
  void shared;
  return { dom, root, editor: liveEditor(), commits: () => commits, resetCommits: () => { commits = 0; } };
}

test("the toolbar's list and history state equals the original dry-runs over random editor states", async () => {
  const { listHistoryState, legacyListHistoryState } = await import("../../src/components/libera/tiptap-markdown-editor");
  const { root, editor } = await mount();
  try {
    let seed = 12345;
    const random = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const seen = { sink: 0, lift: 0, undo: 0, redo: 0, outside: 0, total: 0 };
    await act(async () => {
      for (let step = 0; step < 600; step++) {
        // Random edits wear the lists away; start again from the full document now and then.
        if (step % 25 === 0) editor.commands.setContent(source, { contentType: "markdown" });
        const { doc } = editor.state;
        const kind = random(10);
        let selection: Selection;
        const itemTexts: number[] = [];
        doc.descendants((node, pos) => { if (node.isTextblock && /^(listItem|taskItem)$/.test(doc.resolve(pos).parent.type.name)) itemTexts.push(pos + 1); });
        if (kind >= 6 && itemTexts.length) {
          const a = itemTexts[random(itemTexts.length)], b = random(2) ? a : itemTexts[random(itemTexts.length)];
          selection = TextSelection.between(doc.resolve(a), doc.resolve(b));
        } else if (kind === 0) selection = new AllSelection(doc);
        else if (kind === 1) {
          const pos = random(doc.content.size);
          const node = doc.nodeAt(pos);
          selection = node && NodeSelection.isSelectable(node) ? NodeSelection.create(doc, pos) : Selection.near(doc.resolve(pos));
        } else {
          const a = doc.resolve(random(doc.content.size + 1)), b = random(3) === 0 ? a : doc.resolve(random(doc.content.size + 1));
          selection = TextSelection.between(a, b);
        }
        editor.view.dispatch(editor.state.tr.setSelection(selection));
        const action = random(8);
        if (action === 0) editor.commands.sinkListItem(random(2) ? "listItem" : "taskItem");
        else if (action === 1) editor.commands.liftListItem(random(2) ? "listItem" : "taskItem");
        else if (action === 2) editor.commands.insertContent("x");
        else if (action === 3) editor.commands.undo();
        else if (action === 4) editor.commands.redo();
        else if (action === 5 && random(4) === 0) editor.commands.deleteSelection();
        for (const shared of [false, true]) {
          const expected = legacyListHistoryState(editor), actual = listHistoryState(editor, shared);
          assert.deepEqual(actual, expected, `step ${step}, shared ${shared}`);
          if (!shared) {
            seen.total++;
            if (expected.canSinkListItem) seen.sink++;
            if (expected.canLiftListItem) seen.lift++;
            if (expected.undo) seen.undo++;
            if (expected.redo) seen.redo++;
            if (!expected.canSinkListItem && !expected.canLiftListItem) seen.outside++;
          }
        }
      }
    });
    // The random walk must exercise both answers of every flag.
    assert.ok(seen.sink > 10 && seen.lift > 10 && seen.undo > 10 && seen.redo > 5 && seen.outside > 10, JSON.stringify(seen));
    assert.ok(seen.sink < seen.total && seen.undo < seen.total, JSON.stringify(seen));
  } finally {
    await act(async () => root.unmount());
  }
});

test("typing in a plain paragraph runs no can() dry-run; list state is still asked inside a list", async () => {
  const { root, editor } = await mount();
  try {
    let calls = 0;
    const originalCan = editor.can.bind(editor);
    editor.can = ((...args: Parameters<Editor["can"]>) => { calls++; return originalCan(...args); }) as Editor["can"];
    let target = 0;
    editor.state.doc.descendants((node, pos) => { if (!target && node.isTextblock && node.textContent === "Plain paragraph one.") target = pos + 1; });
    await act(async () => { editor.commands.setTextSelection(target + 5); });
    calls = 0;
    for (let i = 0; i < 20; i++) await act(async () => { editor.commands.insertContent("x"); });
    assert.equal(calls, 0, "typing in a paragraph must not run can()");

    let item = 0;
    editor.state.doc.descendants((node, pos) => { if (!item && node.isTextblock && node.textContent === "d") item = pos + 1; });
    await act(async () => { editor.commands.setTextSelection(item); });
    assert.ok(calls > 0, "inside a list item the sink/lift state is still computed");
    assert.equal((document.querySelector('[aria-label="Indent list item"], [title="Indent list item"]') as HTMLButtonElement).disabled, false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("dragging a selection renders nothing and reads the text once after the pause; collapsing clears at once", async () => {
  const { root, editor, commits, resetCommits } = await mount();
  try {
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (!start && node.isTextblock && node.textContent === words) start = pos + 1; });
    await act(async () => { editor.commands.setTextSelection(start); });
    await settle(400);
    const proto = Object.getPrototypeOf(editor.state.doc) as { textBetween: (...args: unknown[]) => string };
    const originalTextBetween = proto.textBetween;
    let extractions = 0;
    proto.textBetween = function (this: unknown, ...args: unknown[]) { extractions++; return originalTextBetween.apply(this, args); };
    try {
      resetCommits();
      for (let step = 1; step <= 40; step++) await act(async () => { editor.commands.setTextSelection({ from: start, to: start + step }); });
      assert.equal(commits(), 0, "no React commit while the selection is moving");
      assert.equal(extractions, 0, "no text extraction while the selection is moving");
      await settle(400);
      assert.equal(extractions, 1, "one extraction after the pause");
      const counts = () => document.querySelector('[aria-label="Document word counts"]')!.textContent ?? "";
      assert.match(counts(), /Words: \d+\/\d+/);
      await act(async () => { editor.commands.setTextSelection(start); });
      assert.doesNotMatch(counts(), /\//, "collapsing the selection clears the counts immediately");
    } finally {
      proto.textBetween = originalTextBetween;
    }
  } finally {
    await act(async () => root.unmount());
  }
});
