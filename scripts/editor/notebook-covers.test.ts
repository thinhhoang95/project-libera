import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { notebookCoverUrl, notebookIllustrationUrl } from "../../src/lib/notebook-illustrations";
import { readNotebookCover, setNotebookIllustration } from "../../src/lib/storage/notebook-covers";

const library = (selected: string) => ({
  selected,
  sets: [
    { id: "ai-seasons", name: "AI Seasons", builtIn: true as const, images: [] },
    { id: "custom-mine", name: "Mine", images: ["a", "b", "c"].map((id) => ({ id: `${id}0000000`, url: `/api/notebook-illustrations/custom-mine/${id}0000000` })) },
  ],
});

test("covers come from the notebook's pick, else the chosen set", () => {
  const monuments = { ...library("vietnamese-monuments"), sets: [{ id: "vietnamese-monuments", name: "Kỷ nguyên vươn mình", builtIn: true as const, images: [{ id: "turtle-tower", url: "/images/vietnamese-monuments/notebook-turtle-tower.png" }] }] };
  const notebook = { name: "Trips & more", createdAt: "2026-01-02T03:04:05.000Z", illustration: "sage-forest" };
  assert.equal(notebookCoverUrl(notebook, library("ai-seasons")), notebookIllustrationUrl("sage-forest", notebook.createdAt));
  assert.equal(notebookCoverUrl(notebook, monuments), "/images/vietnamese-monuments/notebook-turtle-tower.png");
  const custom = notebookCoverUrl(notebook, library("custom-mine"));
  assert.match(custom, /^\/api\/notebook-illustrations\/custom-mine\//);
  assert.equal(notebookCoverUrl(notebook, library("custom-mine")), custom, "stable for a notebook");
  assert.equal(
    notebookCoverUrl({ ...notebook, illustrationPath: ".libera-notebook-cover-0123abcd.png" }, library("custom-mine")),
    "/api/notebooks/illustration?notebook=Trips%20%26%20more&file=.libera-notebook-cover-0123abcd.png",
  );
});

test("picking a cover copies it into the notebook and replacing it deletes the old copy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-notebook-covers-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const admin = path.join(directory, "users", "admin");
    const notebook = path.join(admin, "Trips");
    await mkdir(notebook, { recursive: true });
    const setFolder = path.join(admin, ".libera", "notebook-illustrations", "custom-mine");
    await mkdir(setFolder, { recursive: true });
    await writeFile(path.join(setFolder, "a0000000.jpg"), "first");
    await writeFile(path.join(setFolder, "b0000000.jpg"), "second");
    const covers = async () => (await readdir(notebook)).filter((name) => name.startsWith(".libera-notebook-cover-"));
    const metadata = async () => JSON.parse(await readFile(path.join(notebook, ".libera-notebook.json"), "utf8"));

    const before = (await stat(notebook)).mtimeMs;
    const tree = await setNotebookIllustration("Trips", "/api/notebook-illustrations/custom-mine/a0000000");
    assert.ok(Math.abs((await stat(notebook)).mtimeMs - before) < 1, "a new cover does not count as an edit");
    const [first] = await covers();
    assert.equal((await metadata()).illustrationPath, first);
    assert.equal(tree.notebooks.find((entry) => entry.name === "Trips")?.illustrationPath, first);
    assert.equal(String((await readNotebookCover("Trips", first)).image), "first");

    // The set going away leaves the notebook's copy alone.
    await rm(setFolder, { recursive: true });
    assert.equal(String((await readNotebookCover("Trips", first)).image), "first");

    await setNotebookIllustration("Trips", "/images/vietnamese-monuments/notebook-hue-meridian-gate.png");
    const [second] = await covers();
    assert.ok(second.endsWith(".png") && second !== first);
    assert.deepEqual(await covers(), [second]);

    await setNotebookIllustration("Trips", null);
    assert.deepEqual(await covers(), []);
    assert.equal((await metadata()).illustrationPath, undefined);

    await assert.rejects(setNotebookIllustration("Trips", "/etc/passwd"), /Choose an illustration/);
    await assert.rejects(readNotebookCover("Trips", "../../secret.jpg"), /Cover not found/);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
