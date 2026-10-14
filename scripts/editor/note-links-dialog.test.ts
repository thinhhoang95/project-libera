import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { extractMarkdownLinkOccurrences } from "../../src/lib/markdown-link-occurrences";
import { resolveMarkdownFileLink } from "../../src/lib/markdown-file-links";
import {
  backlinkGroups,
  filterLinkGroups,
  forwardLinkGroups,
} from "../../src/components/libera/note-links-dialog";
import type { LiberaFileNode } from "../../src/lib/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const timestamp = "2026-10-14T00:00:00.000Z";
function file(path: string, fileType: LiberaFileNode["fileType"] = "markdown", linkedFilePaths?: string[]): LiberaFileNode {
  return { kind: "file", name: path.split("/").at(-1)!, path, notebook: path.split("/")[0], fileType,
    createdAt: timestamp, updatedAt: timestamp, size: 1, linkedFilePaths };
}

test("occurrences carry lines and plain-text excerpts, including reference links", () => {
  const occurrences = extractMarkdownLinkOccurrences([
    "# Title",
    "",
    "See **the** [flight plan](Plan%20A.md#libera=x) before `takeoff`.",
    "",
    "Also [ref][p] and ![photo](skip.png).",
    "",
    "```md\n[code](wrong.md)\n```",
    "",
    "[p]: paper.pdf",
  ].join("\n"));
  assert.deepEqual(occurrences.map(({ href, line }) => [href, line]), [["Plan%20A.md#libera=x", 3], ["paper.pdf", 5]]);
  assert.deepEqual(occurrences[0].excerpt, { before: "See the ", text: "flight plan", after: " before takeoff." });
  assert.equal(occurrences[1].excerpt.text, "ref");
  const long = extractMarkdownLinkOccurrences(`${"word ".repeat(60)}[x](a.md)${" tail".repeat(60)}`)[0].excerpt;
  assert.ok(long.before.startsWith("…") && long.before.length <= 92);
  assert.ok(long.after.endsWith("…") && long.after.length <= 92);
});

test("forward links group by destination and skip self and in-note anchors", () => {
  const files = [file("N/note.md"), file("N/Plan A.md"), file("N/paper.pdf", "pdf")];
  const groups = forwardLinkGroups([
    "[a](Plan%20A.md) [b](Plan%20A.md#libera=x) [pdf](paper.pdf)",
    "[web](https://example.com/x) [gone](Missing.md) [self](note.md) [top](#title)",
  ].join("\n\n"), "N/note.md", files);
  assert.deepEqual(groups.map(({ kind, title, items }) => [kind, title, items.length]), [
    ["file", "Plan A.md", 2], ["file", "paper.pdf", 1], ["external", "example.com/x", 1], ["missing", "Missing.md", 1],
  ]);
});

test("backlinks keep only links that resolve here and reopen the source at the link line", () => {
  const files = [file("N/photo.png", "image"), file("N/a.md"), file("M/b.md")];
  const groups = backlinkGroups("N/photo.png", files, new Map([
    ["N/a.md", "intro\n\n[the photo](photo.png) and [other](b.md)"],
    ["M/b.md", "x\n\ny\n\n[pic](../N/photo.png)"],
  ]));
  assert.deepEqual(groups.map(({ title, items }) => [title, items.map((item) => item.line)]), [["a.md", [3]], ["b.md", [5]]]);
  const reopened = resolveMarkdownFileLink(groups[1].items[0].openHref, "N/photo.png", files);
  assert.equal(reopened?.file.path, "M/b.md");
  assert.equal(reopened?.metadata?.viewState?.markdown?.line, 5);
  assert.deepEqual(filterLinkGroups(groups, "B.MD pic").map((group) => group.title), ["b.md"]);
  assert.deepEqual(filterLinkGroups(groups, "photo and").map((group) => group.title), ["a.md"], "every word must match");
});

test("dialog lists both directions, searches, and opens the selected link with Enter", async () => {
  // React picks its input event strategy on load, so load it after the DOM globals.
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NoteLinksDialog } = await import("../../src/components/libera/note-links-dialog");
  const files = [file("N/note.md", "markdown", ["N/b.md"]), file("N/b.md", "markdown", ["N/note.md"]), file("N/c.md")];
  const requested: string[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
    requested.push(decodeURIComponent(url));
    return new Response(JSON.stringify({ content: "Back to the [main note](note.md) here." }));
  } });
  const opened: string[] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NoteLinksDialog, {
      content: "Read [B](b.md) then [C](c.md).", documentPath: "N/note.md", files,
      onClose() {}, onOpenLink: (href: string) => { opened.push(href); },
    })));
    assert.deepEqual(requested, ["/api/files?path=N/b.md"], "only notes indexed as linking here are read");
    const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    assert.deepEqual(tabs(), ["Backlinks1", "Forward links2"]);
    assert.match(document.querySelector('[role="tabpanel"]')!.textContent!, /Back to the main note here\./);

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search links"]')!;
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "c.md");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(tabs(), ["Backlinks0", "Forward links1"]);
    const press = (key: string) => act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
    });
    await press("Tab");
    await press("Enter");
    assert.deepEqual(opened, ["c.md"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
