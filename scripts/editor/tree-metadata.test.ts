import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pdfTextCacheDirectoryPath } from "../../src/lib/storage/paths";
import {
  getFileMetadata,
  getTree,
  resetTreeMaintenance,
  setTreeMaintenanceClock,
  TREE_MAINTENANCE_INTERVAL_MS,
} from "../../src/lib/storage/tree";

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-tree-metadata-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  resetTreeMaintenance();
  try {
    await run(path.join(directory, "users/admin"));
  } finally {
    resetTreeMaintenance();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

test("metadata by path matches the tree's node and carries a note's link targets", async () => {
  await withLibrary(async (root) => {
    await mkdir(path.join(root, "Alpha/sub"), { recursive: true });
    await writeFile(path.join(root, "Alpha/sub/note.md"), "See [other](../other.md) and [site](https://example.com)");
    await writeFile(path.join(root, "Alpha/other.md"), "Other");
    await writeFile(path.join(root, "Alpha/data.bin"), "x");
    const tree = await getTree();
    const [note, missing, hidden, unsupported, outside] = await getFileMetadata([
      "Alpha/sub/note.md", "Alpha/gone.md", "Alpha/.hidden.md", "Alpha/data.bin", "../etc/passwd",
    ]);
    const alpha = tree.notebooks.find((node) => node.name === "Alpha")!;
    const folder = alpha.children.find((node) => node.kind === "folder")!;
    assert.equal(folder.kind, "folder");
    const shown = folder.kind === "folder" ? folder.children[0] : null;
    // Links are resolved against the shown tree by the client, so the node comes without them.
    const { linkedFilePaths, ...shownBare } = shown as NonNullable<typeof shown> & { linkedFilePaths?: string[] };
    assert.deepEqual(linkedFilePaths, ["Alpha/other.md"]);
    assert.deepEqual(note.metadata?.node, shownBare, "same node as the tree computes");
    assert.ok(note.metadata?.linkDestinations?.includes("../other.md"));
    assert.equal(missing.metadata, null);
    assert.equal(hidden.metadata, null);
    assert.equal(unsupported.metadata, null);
    assert.equal(outside.metadata, null);
  });
});

test("throttled reads run a notebook's sidecar upkeep at most once per interval; ordinary reads always do", async () => {
  await withLibrary(async (root) => {
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await writeFile(path.join(root, "Notes/a.md"), "a");
    let now = 1_000_000;
    setTreeMaintenanceClock(() => now);
    const orphan = (name: string) => path.join(pdfTextCacheDirectoryPath("Notes", []), `${name}.pdf.json`);
    const plant = async (name: string) => {
      await mkdir(pdfTextCacheDirectoryPath("Notes", []), { recursive: true });
      await writeFile(orphan(name), "{}");
    };

    await plant("one");
    await getTree({ maintenance: "throttled" });
    assert.equal(await exists(orphan("one")), false, "the first throttled read does the upkeep");

    await plant("two");
    now += 1000;
    await getTree({ maintenance: "throttled" });
    assert.equal(await exists(orphan("two")), true, "a routine read inside the interval skips it");

    now += TREE_MAINTENANCE_INTERVAL_MS;
    await getTree({ maintenance: "throttled" });
    assert.equal(await exists(orphan("two")), false, "it runs again once the interval has passed");

    await plant("three");
    await getTree();
    assert.equal(await exists(orphan("three")), false, "a read that is not throttled always does it");
  });
});
