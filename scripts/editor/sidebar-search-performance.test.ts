// Sidebar search and window listeners stay out of the shell's per-publication
// path: typing in the search box wakes only the box, and a draft, caret or
// scroll publication does not remove and re-add the keyboard and
// beforeunload listeners.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { emptyTree } from "../../src/components/libera/api-client";
import { emptyWorkspaceLibrary } from "../../src/lib/workspaces";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";

const timestamp = "2026-09-09T00:00:00.000Z";
const noteFile = (name: string): LiberaFileNode => ({ kind: "file", fileType: "markdown", path: `Alpha/${name}.md`, name: `${name}.md`, notebook: "Alpha", size: 0, createdAt: timestamp, updatedAt: timestamp });
const notebook: LiberaNotebookNode = { kind: "notebook", name: "Alpha", path: "Alpha", createdAt: timestamp, updatedAt: timestamp, color: "#000000", emoji: "", groupId: null, children: [noteFile("Apple"), noteFile("Banana"), noteFile("Apricot")] };
const tree: LiberaTree = { ...emptyTree(), lastNotebookName: "Alpha", notebooks: [notebook] };

function installDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
}

function mockFetch() {
  return async (url: unknown) => {
    const href = String(url);
    if (href.startsWith("/api/files?")) {
      const path = new URL(href, "http://localhost").searchParams.get("path")!;
      return Response.json({ file: { ...noteFile(path.split("/")[1].replace(".md", "")) }, content: "saved" });
    }
    if (href.startsWith("/api/workspaces")) return Response.json(emptyWorkspaceLibrary());
    return Response.json(tree);
  };
}

type Act = typeof import("react").act;
let act: Act;
async function loadReact() {
  // After the DOM exists: react-dom decides at import time whether input events are supported.
  act = (await import("react")).act;
  return { act, createElement: (await import("react")).createElement, createRoot: (await import("react-dom/client")).createRoot };
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }

test("search keystrokes do not render the workspace consumer; the box shows results and the workspace can clear it", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch() as typeof fetch;
  const { createElement, createRoot } = await loadReact();
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  const { SidebarSearch } = await import("../../src/components/libera/sidebar-search");
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  let renders = 0;
  function Harness() {
    renders++;
    workspace = useLiberaWorkspace(true).workspace;
    return createElement(SidebarSearch, { store: workspace.sidebarSearch, tree: workspace.tree, onDeepSearch: () => undefined, onSelectSearchResult: workspace.selectSearchResult });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await settle();
    const before = renders;
    const input = document.querySelector("input") as HTMLInputElement;
    const type = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    };
    for (const text of ["a", "ap", "app", "appl"]) await type(text);
    await settle();
    assert.equal(renders, before, "typing did not render the workspace consumer");
    const labels = () => [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    assert.ok(labels().some((label) => label.includes("Apple.md")), "the box lists the match");
    assert.ok(!labels().some((label) => label.includes("Banana.md")));
    assert.equal(input.value, "appl");

    await act(async () => { workspace.sidebarSearch.reset(); });
    await settle();
    assert.equal(input.value, "", "the workspace clears the box");
    assert.ok(!labels().some((label) => label.includes("Apple.md")));

    await type("ban");
    await settle();
    const result = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Banana.md"))!;
    await act(async () => { result.click(); });
    await settle();
    assert.equal(input.value, "", "opening a result clears the box");
    assert.equal(workspace.tabs.some((tab) => tab.id === "Alpha/Banana.md"), true, "and opens it");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("draft, caret and scroll publications leave the window listeners alone; beforeunload still sees the latest draft", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch() as typeof fetch;
  const { createElement, createRoot } = await loadReact();
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  const calls: string[] = [];
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await workspace.openFile(noteFile("Apple")); });
    await settle();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => { calls.push(`add ${type}`); return (add as (...args: unknown[]) => void)(type, ...rest); }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => { calls.push(`remove ${type}`); return (remove as (...args: unknown[]) => void)(type, ...rest); }) as typeof window.removeEventListener;
    const unloadWarns = () => {
      const event = new dom.window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(unloadWarns(), false, "nothing unsaved yet");

    await act(async () => { workspace.setActiveDraft("changed after mount"); });
    await act(async () => { workspace.setActiveTabViewState({ markdown: { editorScrollTop: 40, selectionStart: 3 } }); });
    await act(async () => { workspace.setActiveDraft("changed again"); });
    await act(async () => { workspace.setActiveTabViewState({ markdown: { editorScrollTop: 80, selectionStart: 9 } }); });
    const listenerCalls = calls.filter((call) => /keydown|beforeunload/.test(call));
    assert.deepEqual(listenerCalls, [], "no keydown or beforeunload listener was removed or added");
    assert.equal(unloadWarns(), true, "the unsaved draft made after mount still warns");

    const ctrlTab = (shift: boolean) => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: shift, cancelable: true }));
    await act(async () => { await workspace.openFile(noteFile("Apricot")); });
    await act(async () => { ctrlTab(false); });
    assert.equal(workspace.activeTabId, "Alpha/Apple.md", "Ctrl+Tab returns to the previous tab");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("the open-tab history follows tab ids only", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch() as typeof fetch;
  const { createElement, createRoot } = await loadReact();
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await workspace.openFile(noteFile("Apple")); });
    await act(async () => { await workspace.openFile(noteFile("Apricot")); });
    await act(async () => { workspace.closeTab("Alpha/Apricot.md"); });
    await settle();
    await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true })); });
    assert.equal(workspace.activeTabId, "Alpha/Apple.md", "a closed tab is dropped from the history");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
