import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LatexOutline } from "../../src/components/libera/latex/latex-outline";
import type { OpenTab } from "../../src/components/libera/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
after(() => dom.window.close());

const source = ["\\section{Intro}", "\\subsection{Background}", "\\subsubsection{History}", "\\section{Method}"].join("\n");
const tab: OpenTab = {
  id: "Notebook/paper.tex", draft: source, saved: source, status: "clean",
  viewState: { latex: { line: 2 } },
  file: { kind: "file", name: "paper.tex", path: "Notebook/paper.tex", notebook: "Notebook", fileType: "latex", createdAt: "", updatedAt: "", size: 0 },
};

const titles = (host: HTMLElement) => Array.from(host.querySelectorAll('[role="treeitem"] .whitespace-normal'), (node) => node.textContent);

test("a LaTeX file's sections show as the same collapsible tree as Markdown headings", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: unknown[] = [];
  try {
    await act(async () => root.render(createElement(LatexOutline, {
      activeTab: tab,
      expansionLevel: 2,
      onExpansionLevelChange: () => undefined,
      onOpenFile: async (_file, options) => { opened.push(options?.viewState?.latex?.revealLine?.line); },
    })));

    assert.match(host.textContent ?? "", /Sections/);
    assert.ok(host.querySelector('select[aria-label="Outline expansion level"]'));
    // \section is this file's top level, so it is level 1 and level 3 starts closed.
    assert.deepEqual(titles(host), ["Intro", "Background", "Method"]);
    assert.equal(host.querySelector('[role="treeitem"]')?.getAttribute("aria-level"), "1");
    assert.match(host.querySelector('[aria-current="location"]')?.textContent ?? "", /Background.*L\. 2/);

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Expand Background"]')!.click());
    assert.deepEqual(titles(host), ["Intro", "Background", "History", "Method"]);

    const method = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="treeitem"] button')).find((button) => button.textContent?.includes("Method"))!;
    await act(async () => method.click());
    assert.deepEqual(opened, [4]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
