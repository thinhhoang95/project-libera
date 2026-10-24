import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { fuzzyMatch, searchNotebookTree } from "../../src/components/libera/notebook-search";
import type { LiberaFileNode, LiberaTree } from "../../src/lib/types";

function file(notebook: string, path: string): LiberaFileNode {
  const name = path.split("/").at(-1)!;
  return { kind: "file", name, path: `${notebook}/${path}`, notebook, fileType: name.endsWith(".pdf") ? "pdf" : "markdown", createdAt: "", updatedAt: "", size: 0 };
}

const tree = {
  root: "",
  notebookPanelExpandedPaths: null,
  notebookGroups: [],
  notebookViewOptions: {},
  starredFilePaths: [],
  fileTags: {},
  notebooks: [
    { kind: "notebook", name: "Thesis", children: [
      file("Thesis", "meeting-notes.md"),
      { kind: "folder", name: "chapters", path: "Thesis/chapters", notebook: "Thesis", createdAt: "", updatedAt: "", children: [file("Thesis", "chapters/intro.md"), file("Thesis", "chapters/methods.md")] },
    ] },
    { kind: "notebook", name: "Reading", children: [file("Reading", "notes on methods.pdf")] },
  ],
} as unknown as LiberaTree;

test("fuzzy matching finds letters in order and prefers word starts", () => {
  assert.deepEqual(fuzzyMatch("meeting-notes.md", "notes")?.indices, [8, 9, 10, 11, 12]);
  assert.ok(fuzzyMatch("meeting-notes.md", "mtgnts"));
  assert.equal(fuzzyMatch("meeting-notes.md", "mtgnts", false), null);
  assert.equal(fuzzyMatch("intro.md", "xyz"), null);
  assert.ok(fuzzyMatch("methods.md", "met")!.score > fuzzyMatch("comets.md", "met")!.score);
});

test("the sidebar search matches names as typed and lists notebooks", () => {
  const hits = searchNotebookTree(tree, "methods", { includeNotebooks: true });
  assert.deepEqual(hits.map((hit) => hit.label), ["Thesis/chapters/methods.md", "Reading/notes on methods.pdf"]);
  assert.deepEqual(searchNotebookTree(tree, "thesis", { includeNotebooks: true }).map((hit) => hit.type), ["notebook"]);
  assert.deepEqual(searchNotebookTree(tree, "mtgnts"), []);
});

test("Quick Open matches fuzzily, by folder too, and ranks boosted files first", () => {
  assert.equal(searchNotebookTree(tree, "mtgnts", { fuzzy: true })[0]?.label, "Thesis/meeting-notes.md");
  const byFolder = searchNotebookTree(tree, "chapters intro", { fuzzy: true });
  assert.equal(byFolder[0]?.label, "Thesis/chapters/intro.md");
  assert.ok(byFolder[0].pathIndices.length > 0);
  const boosted = searchNotebookTree(tree, "methods", { fuzzy: true, boost: (candidate) => candidate.notebook === "Reading" ? 500 : 0 });
  assert.equal(boosted[0]?.label, "Reading/notes on methods.pdf");
});

test("the palette reads only the active scope's toolbars, offstage ones included", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section data-command-scope="1">
      <div role="toolbar" aria-label="Formatting">
        <button aria-label="Bold" title="Bold (Ctrl/Cmd+B)"><svg></svg></button>
        <button aria-label="Snip" title="Open an image to snip" disabled></button>
        <select aria-label="Text style"><option value="" disabled>Style</option><option value="1">Heading 1</option></select>
        <div role="radiogroup" aria-label="Ink color"><button role="radio" aria-checked="true" aria-label="Red"></button></div>
        <div role="radiogroup" aria-label="Note color"><button role="radio" aria-checked="false" aria-label="Red"></button></div>
      </div>
      <div hidden data-command-toolbar="Formatting" data-command-reveal><button aria-label="Insert table"></button></div>
    </section>
    <section><div role="toolbar" aria-label="Other pane"><button aria-label="Italic"></button></div></section>
  </body>`, { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "HTMLSelectElement", "Element", "Node", "Event", "requestAnimationFrame"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "requestAnimationFrame" ? dom.window.requestAnimationFrame.bind(dom.window) : dom.window[key] });
  }
  // jsdom lays nothing out: treat elements not inside [hidden] as shown.
  dom.window.Element.prototype.getClientRects = function (this: Element) {
    return (this.closest("[hidden]") ? [] : [{}]) as unknown as DOMRectList;
  };
  const { collectPaletteCommands } = await import("../../src/components/libera/command-palette/commands");

  const commands = collectPaletteCommands(null);
  const titles = commands.map((command) => command.title);
  // Swatches with the same name in two pickers are told apart, and show which is chosen.
  assert.deepEqual(titles, ["Bold", "Snip", "Text style: Heading 1", "Ink color: Red", "Note color: Red", "Insert table"]);
  assert.deepEqual(commands.slice(3, 5).map((command) => command.checked), [true, false]);
  const bold = commands[0];
  assert.equal(bold.shortcut, "Ctrl/Cmd+B");
  assert.equal(bold.group, "Formatting");
  assert.ok(bold.iconElement);
  assert.equal(commands[1].disabled, true);

  const select = dom.window.document.querySelector("select")!;
  let changed = "";
  select.addEventListener("change", () => { changed = select.value; });
  commands[2].run();
  assert.equal(changed, "1");
});

test("⌘/Ctrl+Shift+P runs a toolbar tool and ⌘/Ctrl+P opens a file", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section data-command-scope="1"><div role="toolbar" aria-label="Formatting"><button aria-label="Bold" id="bold"></button><button aria-label="Italic"></button></div></section>
    <div id="root"></div>
  </body>`, { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "Event", "KeyboardEvent", "CustomEvent", "localStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  for (const [key, value] of Object.entries({ IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.Element.prototype.getClientRects = function () {
    return [{}] as unknown as DOMRectList;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)));
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  const { CommandPalette } = await import("../../src/components/libera/command-palette/command-palette");

  let bolded = 0;
  dom.window.document.getElementById("bold")!.addEventListener("click", () => { bolded += 1; });
  const opened: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(createElement(CommandPalette, { tree, recentFiles: [], selectedNotebookName: "Thesis", onOpenFile: (target, placement) => opened.push(`${target.path}@${placement}`) }));
  });
  const press = async (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...init }));
      await frame();
    });
  };
  const type = async (text: string) => {
    const input = dom.window.document.querySelector<HTMLInputElement>("[data-command-palette] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    return input;
  };
  const options = () => [...dom.window.document.querySelectorAll("[role=option]")].map((option) => option.textContent);

  await press(dom.window, "p", { ctrlKey: true, shiftKey: true });
  assert.equal(dom.window.document.querySelector<HTMLInputElement>("[data-command-palette] input")?.value, ">");
  assert.ok(options()[0]?.startsWith("Bold"));
  const input = await type(">ital");
  assert.ok(options()[0]?.startsWith("Italic"));
  await type(">bold");
  await press(input, "Enter");
  await act(async () => { await frame(); });
  assert.equal(bolded, 1);
  assert.equal(dom.window.document.querySelector("[data-command-palette]"), null);

  await press(dom.window, "p", { ctrlKey: true });
  const fileInput = await type("mtgnts");
  assert.ok(options()[0]?.includes("meeting-notes.md"));
  await press(fileInput, "Enter", { ctrlKey: true });
  assert.deepEqual(opened, ["Thesis/meeting-notes.md@right"]);

  // Pressing the shortcut again closes the palette.
  await press(dom.window, "p", { ctrlKey: true });
  await press(dom.window, "p", { ctrlKey: true });
  assert.equal(dom.window.document.querySelector("[data-command-palette]"), null);
  await act(async () => root.unmount());
});
