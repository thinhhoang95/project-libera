import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { contextualPanelTabs, createPageTab, isContextualPanelTab } from "../../src/components/libera/page-tabs";
import { PdfDocumentOutline } from "../../src/components/libera/pdf-outline-panel";
import type { OpenTab } from "../../src/components/libera/types";
import { PDF_OUTLINE_REQUEST_EVENT, PDF_OUTLINE_RUN_FINISHED_EVENT, PDF_OUTLINE_UPDATED_EVENT, type PdfOutlinePayload, type PdfOutlineRequestDetail } from "../../src/lib/pdf-outline";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
after(() => dom.window.close());

const pdfTab: OpenTab = {
  id: "Notebook/book.pdf", draft: "", saved: "", status: "clean",
  file: { kind: "file", name: "book.pdf", path: "Notebook/book.pdf", notebook: "Notebook", fileType: "pdf", createdAt: "", updatedAt: "", size: 0 },
};

async function mount(payloads: PdfOutlinePayload[], run: (host: HTMLElement, opened: Array<NonNullable<OpenTab["viewState"]>["pdf"]>) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => Response.json(payloads[Math.min(call++, payloads.length - 1)]);
  const opened: Array<NonNullable<OpenTab["viewState"]>["pdf"]> = [];
  try {
    await act(async () => root.render(createElement(PdfDocumentOutline, {
      activeTab: pdfTab,
      expansionLevel: 2,
      onExpansionLevelChange: () => undefined,
      onOpenFile: async (_file, options) => { opened.push(options?.viewState?.pdf); },
    })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await run(host, opened);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    host.remove();
  }
}

const titles = (host: HTMLElement) => Array.from(host.querySelectorAll('[role="treeitem"] .whitespace-normal'), (node) => node.textContent);

test("a PDF's bookmarks show as a collapsible tree that opens their page and spot", async () => {
  await mount([{
    path: pdfTab.file.path, stale: false, generated: null,
    embedded: [
      { id: "b1", title: "Part I", level: 1, page: 1 },
      { id: "b2", title: "Chapter 1", level: 2, page: 3, top: 0.4 },
      { id: "b3", title: "Section 1.1", level: 3, page: 4 },
      { id: "b4", title: "Web link", level: 1 },
    ],
  }], async (host, opened) => {
    assert.match(host.textContent ?? "", /Bookmarks/);
    assert.deepEqual(titles(host), ["Part I", "Chapter 1", "Web link"]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Expand Chapter 1"]')!.click());
    assert.deepEqual(titles(host), ["Part I", "Chapter 1", "Section 1.1", "Web link"]);
    const chapter = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="treeitem"] button')).find((button) => button.textContent?.includes("Chapter 1") && !button.getAttribute("aria-label"))!;
    await act(async () => chapter.click());
    assert.equal(opened[0]?.reveal?.page, 3);
    assert.equal(opened[0]?.reveal?.top, 0.4);
    // No page, nothing to open; no AI actions for bookmarks.
    assert.equal(host.querySelector('button[aria-label="Regenerate outline"]'), null);
  });
});

test("without bookmarks the tab offers to generate an outline, then shows it with what verification left", async () => {
  const empty: PdfOutlinePayload = { path: pdfTab.file.path, embedded: [], generated: null, stale: false };
  const generated: PdfOutlinePayload = {
    path: pdfTab.file.path, embedded: [], stale: true,
    generated: {
      version: 1, documentPath: pdfTab.file.path, generatedAt: "2026-10-24T10:00:00.000Z", model: "test/model", source: null, pageCount: 40,
      entries: [{ id: "o1", title: "1 Introduction", level: 1, page: 2 }, { id: "o2", title: "1.1 Mangled $x$", level: 2, page: 3, unverified: true }],
      problems: [{ code: "title-not-found", severity: "warning", id: "o2", message: "“1.1 Mangled $x$” is not in page 3's text." }],
    },
  };
  const requests: PdfOutlineRequestDetail[] = [];
  const listen = (event: Event) => requests.push((event as CustomEvent<PdfOutlineRequestDetail>).detail);
  window.addEventListener(PDF_OUTLINE_REQUEST_EVENT, listen);
  try {
    await mount([empty, generated], async (host) => {
      assert.match(host.textContent ?? "", /no bookmarks of its own/);
      const generate = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Generate outline"))!;
      await act(async () => generate.click());
      assert.deepEqual(requests.map((request) => request.path), [pdfTab.file.path]);
      assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /outlining the PDF in parallel parts/);

      // The agent saves, then its run ends.
      await act(async () => {
        window.dispatchEvent(new CustomEvent(PDF_OUTLINE_UPDATED_EVENT, { detail: { path: pdfTab.file.path } }));
        window.dispatchEvent(new CustomEvent(PDF_OUTLINE_RUN_FINISHED_EVENT, { detail: { requestId: requests[0].requestId } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.match(host.textContent ?? "", /AI outline/);
      assert.deepEqual(titles(host), ["1 Introduction", "1.1 Mangled $x$"]);
      assert.match(host.textContent ?? "", /changed since this outline was generated/);
      assert.match(host.querySelector("details summary")?.textContent ?? "", /1 note from verification/);
      assert.match(host.textContent ?? "", /with test\/model/);
      assert.ok(host.querySelector('button[aria-label="Delete outline"]'));
    });
  } finally {
    window.removeEventListener(PDF_OUTLINE_REQUEST_EVENT, listen);
  }
});

test("a PDF tab brings the Annotations rail tab without opening it; pages keep theirs", () => {
  assert.deepEqual(contextualPanelTabs(pdfTab).map((tab) => [tab.id, tab.autoOpen ?? false]), [["pdf-annotations", false]]);
  assert.deepEqual(contextualPanelTabs({ ...pdfTab, gallery: true } as OpenTab), []);
  assert.deepEqual(contextualPanelTabs({ ...pdfTab, file: { ...pdfTab.file, fileType: "markdown", name: "a.md", path: "Notebook/a.md" } }), []);
  assert.deepEqual(contextualPanelTabs(createPageTab("spending")).map((tab) => [tab.id, tab.autoOpen]), [["spending", true]]);
  assert.ok(isContextualPanelTab("pdf-annotations"));
  assert.ok(!isContextualPanelTab("outlines"));
});
