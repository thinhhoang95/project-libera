import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";
import { refreshable, refreshVisualWidgets, replaceChildrenIfChanged } from "../../src/lib/latex/codemirror/visual/widgets";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** A mounted view's contentDOM is CodeMirror's to keep (it removes nodes it did not draw), so the elements go in a plain container the stand-in view reports as its content. */
function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const view = { contentDOM: container, posAtDOM: () => { throw new Error("not a widget"); } } as unknown as EditorView;
  return Object.assign(view, { container });
}

test("a newly drawn refreshable renders once after mounting, and a later refresh still reaches it", async () => {
  const view = mount();
  let calls = 0;
  const span = document.createElement("span");
  view.container.append(span);
  refreshable(span, view, () => { calls++; });
  await Promise.resolve();
  assert.equal(calls, 1);
  refreshVisualWidgets(view);
  assert.equal(calls, 2);
  view.container.remove();
});

test("a widget reached by the plugin's refresh before its own queued one is not drawn twice", async () => {
  const view = mount();
  let calls = 0;
  const span = document.createElement("span");
  view.container.append(span);
  refreshable(span, view, () => { calls++; });
  refreshVisualWidgets(view, true);
  assert.equal(calls, 1);
  await Promise.resolve();
  assert.equal(calls, 1);
  refreshVisualWidgets(view);
  assert.equal(calls, 2);
  view.container.remove();
});

test("an element never attached does not stay skipped", async () => {
  const view = mount();
  let calls = 0;
  const span = document.createElement("span");
  refreshable(span, view, () => { calls++; });
  await Promise.resolve();
  assert.equal(calls, 0);
  view.container.append(span);
  refreshVisualWidgets(view);
  assert.equal(calls, 1);
  view.container.remove();
});

test("replaceChildrenIfChanged keeps equal nodes and replaces different ones", () => {
  const parent = document.createElement("div");
  const first = document.createElement("b");
  first.textContent = "a";
  parent.append(first, document.createTextNode("t"));
  const same = document.createElement("b");
  same.textContent = "a";
  replaceChildrenIfChanged(parent, same, document.createTextNode("t"));
  assert.equal(parent.firstChild, first);
  const other = document.createElement("b");
  other.textContent = "c";
  replaceChildrenIfChanged(parent, other, document.createTextNode("t"));
  assert.equal(parent.firstChild, other);
  const marked = document.createElement("span");
  marked.setAttribute("data-vis-refresh", "");
  parent.replaceChildren(marked);
  const again = document.createElement("span");
  again.setAttribute("data-vis-refresh", "");
  replaceChildrenIfChanged(parent, again);
  assert.equal(parent.firstChild, again);
});
