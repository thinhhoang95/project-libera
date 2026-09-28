import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownDisplayPreferencesProvider } from "../../src/components/libera/markdown-display-preferences";
import { OutlinePanel } from "../../src/components/libera/outline-panel";
import type { OpenTab } from "../../src/components/libera/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.addEventListener(name.replace(/^on/, ""), listener);
  },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.removeEventListener(name.replace(/^on/, ""), listener);
  },
});
after(() => dom.window.close());

test("PDF outline search filters annotations and opens the first match", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousFetch = globalThis.fetch;
  const previousCss = globalThis.CSS;
  Object.defineProperty(globalThis, "CSS", { value: { escape: (value: string) => value }, configurable: true });
  const activeTab: OpenTab = {
    id: "Notebook/notes.pdf", draft: "", saved: "", status: "clean",
    file: { kind: "file", name: "notes.pdf", path: "Notebook/notes.pdf", notebook: "Notebook", fileType: "pdf", createdAt: "", updatedAt: "", size: 0 },
  };
  const annotations = [
    { id: "first", type: "text", pageNumber: 2, text: "Methods", fontSize: 12, rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: "2026-09-28", updatedAt: "2026-09-28" },
    { id: "highlight", type: "highlight", pageNumber: 3, quote: "Selected\npassage", color: "#fde047", rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], createdAt: "2026-09-28", updatedAt: "2026-09-28" },
    { id: "second", type: "text", pageNumber: 4, text: "Results", fontSize: 12, rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: "2026-09-28", updatedAt: "2026-09-28" },
  ];
  globalThis.fetch = async () => Response.json({ annotations });
  const openedIds: Array<string | undefined> = [];
  const props = {
    activeTab,
    textareaRef: createRef<HTMLTextAreaElement>(),
    onOpenFile: async (_file: OpenTab["file"], options?: { viewState?: OpenTab["viewState"] }) => {
      openedIds.push(options?.viewState?.pdf?.selectedAnnotationId);
    },
    onSetDraft: () => assert.fail("Searching PDF annotations must not edit the document"),
  };
  const labels = () => Array.from(host.querySelectorAll("button .whitespace-normal"), (label) => label.textContent);

  try {
    await act(async () => root.render(createElement(OutlinePanel, props)));
    assert.deepEqual(labels(), ["Methods", "Selected passage", "Results"]);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search PDF annotations"]')!;
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "results");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      input.dispatchEvent(event);
    });
    assert.deepEqual(labels(), ["Results"]);
    await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(openedIds, ["second"]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      input.dispatchEvent(event);
    });
    assert.match(host.textContent ?? "", /No matching annotations/);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear annotation search"]')!.click());
    assert.deepEqual(labels(), ["Methods", "Selected passage", "Results"]);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "CSS", { value: previousCss, configurable: true });
    host.remove();
  }
});

test("outline depth collapses descendants, supports manual expansion and searches hidden headings", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousFetch = globalThis.fetch;
  let saved = { textWidth: 62, textScale: 120, outlineExpansionLevel: 6 };
  globalThis.fetch = async (_url, init) => {
    saved = JSON.parse(String(init?.body));
    return Response.json(saved);
  };
  const draft = "# First\n## Child\n### Deep\n#### Four\n##### Five\n###### Six\n## Sibling\n# Second\n### Skipped level";
  const activeTab: OpenTab = {
    id: "Notebook/outline.md", draft, saved: draft, status: "clean",
    file: { kind: "file", name: "outline.md", path: "Notebook/outline.md", notebook: "Notebook", fileType: "markdown", createdAt: "", updatedAt: "", size: 0 },
  };
  const openedLines: Array<number | undefined> = [];
  const props = {
    activeTab,
    textareaRef: createRef<HTMLTextAreaElement>(),
    onOpenFile: async (_file: OpenTab["file"], options?: { viewState?: OpenTab["viewState"] }) => {
      openedLines.push(options?.viewState?.markdown?.line);
    },
    onSetDraft: () => assert.fail("Expanding an outline must not edit the document"),
  };
  const renderOutline = (tab: OpenTab) => createElement(
    MarkdownDisplayPreferencesProvider,
    { initialPreferences: saved },
    createElement(OutlinePanel, { ...props, activeTab: tab }),
  );
  const visibleHeadings = () => Array.from(host.querySelectorAll("button[draggable]"), (button) =>
    button.querySelector(".whitespace-normal")?.textContent,
  );
  async function selectLevel(level: number) {
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = String(level);
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  }
  async function click(label: string) {
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      assert.ok(button, label);
      button.click();
    });
  }
  try {
    await act(async () => root.render(renderOutline(activeTab)));
    assert.equal(visibleHeadings().length, 9);
    await selectLevel(1);
    assert.deepEqual(visibleHeadings(), ["First", "Second"]);
    await click("Expand First");
    assert.deepEqual(visibleHeadings(), ["First", "Child", "Sibling", "Second"]);
    await click("Expand Child");
    assert.deepEqual(visibleHeadings(), ["First", "Child", "Deep", "Sibling", "Second"]);
    await click("Collapse First");
    assert.deepEqual(visibleHeadings(), ["First", "Second"]);
    await selectLevel(2);
    assert.deepEqual(visibleHeadings(), ["First", "Child", "Sibling", "Second", "Skipped level"]);
    await selectLevel(3);
    assert.deepEqual(visibleHeadings(), ["First", "Child", "Deep", "Sibling", "Second", "Skipped level"]);
    await selectLevel(6);
    assert.equal(visibleHeadings().length, 9);
    await selectLevel(1);

    const input = host.querySelector("input")!;
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Deep");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      input.dispatchEvent(event);
    });
    assert.deepEqual(visibleHeadings(), ["Deep"]);
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(openedLines, [3]);
    await click("Clear heading search");
    assert.deepEqual(visibleHeadings(), ["First", "Second"]);

    // The depth preference carries over when switching documents.
    await act(async () => root.render(renderOutline({ ...activeTab, id: "Notebook/other.md" })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(host.querySelector("select")?.value, "1");
    assert.deepEqual(visibleHeadings(), ["First", "Second"]);

    assert.deepEqual(saved, { textWidth: 62, textScale: 120, outlineExpansionLevel: 1 },
      "The selected level is saved without changing other display preferences");
    await act(async () => root.render(null));
    await act(async () => root.render(renderOutline(activeTab)));
    assert.equal(host.querySelector("select")?.value, "1", "The saved level is restored after remount");
    assert.deepEqual(visibleHeadings(), ["First", "Second"]);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    host.remove();
  }
});
