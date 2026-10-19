import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractNotebookLinkDestinations } from "../../src/lib/storage/notebook-links";
import { getTree } from "../../src/lib/storage/tree";
import { updateMarkdownFile } from "../../src/lib/storage/files";
import { markdownLinkWorkspacePath } from "../../src/lib/markdown-file-links";

test("extracts actual Markdown links, including references, but ignores code and images", () => {
  assert.deepEqual(extractNotebookLinkDestinations([
    "[one](../Beta/a.md#libera=test)",
    "[two][target]", "[TARGET]: ../Gamma/a.pdf",
    "`[code](../Wrong/a.md)`", "![image](../Wrong/a.png)",
    "```md", "[example](../Wrong/a.md)", "```",
  ].join("\n\n")), ["../Beta/a.md#libera=test", "../Gamma/a.pdf"]);
});

test("persists links, reuses unchanged metadata, and reconciles saves, external edits, moves and deletes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-notebook-links-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users/admin");
  const source = path.join(root, "Alpha/nested/note.md");
  const cache = path.join(root, "Alpha/.libera/notebook-links.json");
  async function related() {
    const tree = await getTree();
    return tree.notebooks.find((notebook) => notebook.name === "Alpha")!.relatedNotebookNames;
  }
  try {
    for (const name of ["Alpha/nested", "Beta space", "Gamma"]) {
      await mkdir(path.join(root, name), { recursive: true });
    }
    await writeFile(path.join(root, "Beta space/target.md"), "target");
    await writeFile(path.join(root, "Gamma/target.pdf"), "pdf");
    await writeFile(source, [
      "[beta](../../Beta%20space/target.md#heading)",
      "[duplicate](../../Beta%20space/target.md)",
      "[self](note.md)", "[external](https://example.com)",
      "[missing](../../Missing/note.md)",
    ].join("\n"));
    assert.deepEqual(await related(), ["Beta space"]);
    const sourceNode = (await getTree()).notebooks.find((notebook) => notebook.name === "Alpha")!
      .children.flatMap((node) => node.kind === "folder" ? node.children : [node])
      .find((node) => node.path === "Alpha/nested/note.md");
    assert.deepEqual(sourceNode?.kind === "file" && sourceNode.linkedFilePaths, ["Beta space/target.md"],
      "resolved, de-duplicated targets exclude self, external and missing links");
    const initial = await readFile(cache, "utf8");
    const initialMtime = (await stat(cache)).mtimeMs;
    assert.deepEqual(await related(), ["Beta space"]);
    assert.equal(await readFile(cache, "utf8"), initial);
    assert.equal((await stat(cache)).mtimeMs, initialMtime, "unchanged loads do not rewrite metadata");

    await updateMarkdownFile("Alpha/nested/note.md", "[gamma](../../Gamma/target.pdf)");
    assert.deepEqual(await related(), ["Gamma"]);
    await writeFile(source, "links removed externally");
    assert.deepEqual(await related(), []);
    await writeFile(source, "[beta](../../Beta%20space/target.md)");
    assert.deepEqual(await related(), ["Beta space"]);
    await rm(path.join(root, "Beta space/target.md"));
    assert.deepEqual(await related(), [], "deleted targets are not related");
    await writeFile(path.join(root, "Beta space/target.md"), "restored");
    assert.deepEqual(await related(), ["Beta space"], "targets resolve from cached destinations");
    await rename(source, path.join(root, "Alpha/note.md"));
    assert.deepEqual(await related(), [], "relative destinations are resolved at the new source path");
    await writeFile(cache, "invalid sync payload");
    assert.deepEqual(await related(), [], "corrupt cache is rebuilt");
    await rm(path.join(root, "Alpha/note.md"));
    assert.deepEqual(await related(), []);
    assert.deepEqual(JSON.parse(await readFile(cache, "utf8")).files, {});
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("panel highlights related notebooks in both grouped and ungrouped sections", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { NotebookPanel } = await import("../../src/components/libera/notebook-panel");
  const { emptyTree } = await import("../../src/components/libera/api-client");
  const timestamp = "2026-09-25T00:00:00.000Z";
  const tree = emptyTree();
  tree.notebookGroups = [{ id: "group", title: "Group", description: "", createdAt: timestamp, updatedAt: timestamp }];
  tree.notebooks = ["Alpha", "Beta", "Gamma", "Unrelated"].map((name) => ({
    kind: "notebook", name, path: name, color: "#008888", emoji: "📓",
    groupId: name === "Gamma" ? "group" : null,
    createdAt: timestamp, updatedAt: timestamp, children: [],
    relatedNotebookNames: name === "Alpha" ? ["Beta", "Gamma"] : [],
  }));
  // Server rendering exercises the actual section markup without invoking actions.
  const noop = async () => {};
  const props: import("../../src/components/libera/notebook-panel").NotebookPanelProps = {
    tree, selectedNotebookName: "Alpha", activeTabId: "", expanded: new Set<string>(),
    fileInteractions: {}, query: "", searchResults: [], uploadInputRef: { current: null },
    onDuplicateMarkdown: noop, onCopyFile: noop, onArchiveFile: noop,
    onArchiveFolder: noop, onCreateFolder: noop, onCreateMarkdown: noop,
    onCreateSlides: noop, onCreateNotebook: noop, onCreateNotebookGroup: noop,
    onDeleteNotebook: noop, onDeleteNotebookGroup: noop, onDeleteFile: noop,
    onDeleteFolder: noop, onDownloadFile: noop, onDownloadNotebook: noop,
    onEditNotebook: noop, onEditNotebookGroup: noop, onMoveFile: noop,
    onOpenFile: noop, onQueryChange: noop, onRenameFolder: noop, onRenameFile: noop,
    onSelectNotebook: noop, onSelectSearchResult: noop, onStartUpload: noop,
    onToggleFileStar: noop, onEditFileTags: noop, onToggleNotebook: noop, onUploadChange: noop,
    onUploadFiles: noop, onUpdateNotebookViewOptions: noop,
  };
  function sections(selectedNotebookName: string) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(NotebookPanel, { ...props, selectedNotebookName })));
    return [...dom.window.document.querySelectorAll('.libera-notebook-section[data-related="true"]')]
      .map((section) => section.textContent);
  }
  const highlighted = sections("Alpha");
  assert.equal(highlighted.length, 2);
  assert.ok(highlighted.some((text) => text?.includes("Beta")));
  assert.ok(highlighted.some((text) => text?.includes("Gamma")));
  assert.deepEqual(sections("Beta"), [], "changing selection clears previous related highlights");
});

test("panel highlights files that link to the open file, with counts on collapsed containers", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { NotebookPanel } = await import("../../src/components/libera/notebook-panel");
  const { emptyTree } = await import("../../src/components/libera/api-client");
  const timestamp = "2026-10-14T00:00:00.000Z";
  const file = (path: string, fileType: "markdown" | "pdf" | "image", linkedFilePaths?: string[]) => ({
    kind: "file" as const, name: path.split("/").at(-1)!, path, notebook: path.split("/")[0],
    fileType, createdAt: timestamp, updatedAt: timestamp, size: 1, linkedFilePaths,
  });
  const tree = emptyTree();
  tree.notebooks = [
    { kind: "notebook", name: "Alpha", path: "Alpha", color: "#008888", emoji: "📓", groupId: null,
      createdAt: timestamp, updatedAt: timestamp, children: [
        file("Alpha/photo.png", "image"),
        file("Alpha/paper.pdf", "pdf"),
        file("Alpha/a.md", "markdown", ["Alpha/photo.png"]),
        file("Alpha/b.md", "markdown", ["Alpha/paper.pdf"]),
        { kind: "folder", name: "deep", path: "Alpha/deep", notebook: "Alpha",
          createdAt: timestamp, updatedAt: timestamp,
          children: [file("Alpha/deep/c.md", "markdown", ["Alpha/photo.png"])] },
      ] },
    { kind: "notebook", name: "Beta", path: "Beta", color: "#008888", emoji: "📓", groupId: null,
      createdAt: timestamp, updatedAt: timestamp,
      children: [file("Beta/d.md", "markdown", ["Alpha/photo.png", "Alpha/paper.pdf"])] },
  ];
  const noop = async () => {};
  const props = {
    tree, selectedNotebookName: "Alpha", activeTabId: "", expanded: new Set(["Alpha"]),
    fileInteractions: {}, query: "", searchResults: [], uploadInputRef: { current: null },
  } as unknown as import("../../src/components/libera/notebook-panel").NotebookPanelProps;
  const render = (activeTabId: string) => new JSDOM(renderToStaticMarkup(createElement(NotebookPanel,
    new Proxy({ ...props, activeTabId }, { get: (target, key) => key in target ? target[key as keyof typeof target] : noop }),
  ))).window.document;
  const highlighted = (document: Document) =>
    [...document.querySelectorAll('[data-backlink="true"]')].map((row) => row.textContent?.trim());

  let document = render("Alpha/photo.png");
  assert.deepEqual(highlighted(document), ["a.md"], "only expanded rows are listed");
  const counts = [...document.querySelectorAll(".libera-backlink-count")].map((badge) => badge.getAttribute("aria-label"));
  assert.deepEqual(counts.sort(), ["1 file links to the open file", "1 file links to the open file"],
    "collapsed folder and notebook show their counts");
  document = render("Alpha/paper.pdf");
  assert.deepEqual(highlighted(document), ["b.md"]);
  assert.deepEqual(highlighted(render("Alpha/a.md")), [], "files without backlinks highlight nothing");
});

test("chat links resolve to workspace paths", () => {
  assert.equal(markdownLinkWorkspacePath("Research/Plan%20A/./ROB-Kmin.md#libera=x"), "Research/Plan A/ROB-Kmin.md");
  assert.equal(markdownLinkWorkspacePath("https://example.com/a.md"), null);
  assert.equal(markdownLinkWorkspacePath("../outside.md"), null);
});
