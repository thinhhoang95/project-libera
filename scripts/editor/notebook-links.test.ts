import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractNotebookLinkDestinations, forgetNotebookLinkReads, resetNotebookLinkReadCache, setNotebookLinkClock } from "../../src/lib/storage/notebook-links";
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
    assert.deepEqual(Object.keys(JSON.parse(initial).files["Alpha/nested/note.md"]).sort(), ["contentHash", "destinations"],
      "no timestamps or sizes, which differ between computers");
    const touched = new Date("2026-03-04T05:06:07.000Z");
    await utimes(source, touched, touched);
    assert.deepEqual(await related(), ["Beta space"]);
    assert.equal((await stat(cache)).mtimeMs, initialMtime, "a timestamp-only change does not rewrite metadata");

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

test("the link index skips unchanged notes, rereads after the recheck window, and never overrules the saved index", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-notebook-links-cache-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users/admin");
  const source = path.join(root, "Alpha/note.md");
  const index = path.join(root, "Alpha/.libera/notebook-links.json");
  const [first, second] = ["[one](../Beta/a.md)", "[two](../Zeta/b.md)"]; // Same length: a rewrite keeps the size.
  assert.equal(first.length, second.length);
  async function destinations() {
    await getTree();
    return JSON.parse(await readFile(index, "utf8")).files["Alpha/note.md"].destinations as string[];
  }
  // Stats frozen at one moment, as a write that preserves size, mtime and ctime looks.
  let frozen: Awaited<ReturnType<typeof stat>> | null = null;
  const realStat = fsp.stat;
  const realReadFile = fsp.readFile;
  let reads = 0;
  mock.method(fsp, "stat", (target: string, options?: object) => frozen && target === source ? Promise.resolve(frozen) : realStat(target, options as never));
  mock.method(fsp, "readFile", (target: unknown, ...rest: unknown[]) => {
    if (target === source) reads += 1;
    return (realReadFile as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
  });
  // The storage modules import these by name: copy the mocks into the built-in module's exports.
  syncBuiltinESMExports();
  let time = 1_000_000;
  try {
    resetNotebookLinkReadCache();
    setNotebookLinkClock(() => time);
    await mkdir(path.join(root, "Alpha"), { recursive: true });
    await writeFile(source, first);
    assert.deepEqual(await destinations(), ["../Beta/a.md"]);
    assert.equal(reads, 1);
    await getTree();
    assert.equal(reads, 1, "an unchanged note is not read again");

    const saved = await stat(source, { bigint: true });
    frozen = saved as never;
    await writeFile(source, second);
    await getTree();
    assert.equal(reads, 1, "a write that keeps its stats is not seen inside the window");
    time += 7 * 60_000;
    assert.deepEqual(await destinations(), ["../Zeta/b.md"]);
    assert.equal(reads, 2, "it is read again once the window has passed");

    await writeFile(source, first);
    await getTree();
    assert.equal(reads, 2);
    forgetNotebookLinkReads("Alpha", "Alpha/note.md");
    assert.deepEqual(await destinations(), ["../Beta/a.md"]);
    assert.equal(reads, 3, "a forgotten note is read on the next refresh");

    // Another computer saved a newer index for this note: the cached read must not overwrite it.
    await writeFile(source, second);
    const written = JSON.parse(await readFile(index, "utf8"));
    written.files["Alpha/note.md"] = { contentHash: "from-another-computer", destinations: ["../Other/c.md"] };
    await writeFile(index, JSON.stringify(written));
    await getTree();
    assert.equal(reads, 4, "a saved hash that differs from the cached one sends the note back to be read");
    const after = JSON.parse(await readFile(index, "utf8")).files["Alpha/note.md"];
    assert.notEqual(after.contentHash, "from-another-computer");
    assert.deepEqual(after.destinations, ["../Zeta/b.md"], "rebuilt from the bytes, not from the stale cache");
    await getTree();
    assert.equal(reads, 4, "once saved and cached agree, nothing is read again");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    resetNotebookLinkReadCache();
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
