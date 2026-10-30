const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  AI_SEASONS_IMAGES,
  BUILT_IN_ILLUSTRATION_SETS,
  isNotebookCoverFile,
  normalizeNotebookIllustrations,
  resolveNotebookIllustrations,
} = require("../../electron/notebook-illustrations.cjs");
const { illustrationFilePath, saveNotebookIllustrations, decodeJpegDataUrl } = require("../../electron/notebook-illustration-store.cjs");

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")}`;

test("AI Seasons matches the app's illustration map", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/notebook-illustrations.ts"), "utf8");
  for (const image of AI_SEASONS_IMAGES) assert.ok(source.includes(`"${image.id}": "${image.url}"`), image.id);
  assert.equal(AI_SEASONS_IMAGES.length, (source.match(/"\/images\/notebook-/g) ?? []).length);
});

test("every built-in illustration ships in public/images, and Kỷ nguyên vươn mình is the default", () => {
  for (const set of BUILT_IN_ILLUSTRATION_SETS) {
    for (const image of set.images) assert.ok(fs.existsSync(path.join(__dirname, "../../public/images", image.file)), image.file);
  }
  assert.equal(BUILT_IN_ILLUSTRATION_SETS[0].name, "Kỷ nguyên vươn mình");
  assert.equal(normalizeNotebookIllustrations(null).selected, "vietnamese-monuments");
  assert.equal(normalizeNotebookIllustrations({ selected: "ai-seasons" }).selected, "ai-seasons");
});

test("preferences keep valid sets, images and crops and fall back to the default set", () => {
  const preferences = normalizeNotebookIllustrations({
    selected: "custom-gone",
    sets: [
      { id: "custom-trips", name: "  Trips ", images: [
        { id: "abcdef0123456789", crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 } },
        { id: "abcdef0123456789" },
        { id: "BAD" },
        { id: "0123456789abcdef", crop: { x: 0.8, y: 0, width: 0.5, height: 1 } },
      ] },
      { id: "custom-trips", name: "Duplicate", images: [] },
      { id: "nope", name: "Bad id", images: [] },
      { id: "custom-empty", name: "", images: [] },
    ],
  });
  assert.equal(preferences.selected, "vietnamese-monuments");
  assert.deepEqual(preferences.sets, [{ id: "custom-trips", name: "Trips", images: [
    { id: "abcdef0123456789", crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 } },
    { id: "0123456789abcdef", crop: null },
  ] }]);
  assert.equal(normalizeNotebookIllustrations({ selected: "custom-trips", sets: preferences.sets }).selected, "custom-trips");
});

test("resolving lists the built-in sets first and leaves out images whose file is gone", () => {
  const library = resolveNotebookIllustrations({ selected: "custom-a", sets: [{ id: "custom-a", name: "A", images: [{ id: "aaaaaaaa1" }, { id: "bbbbbbbb2" }] }] }, {
    exists: (setId, imageId) => setId === "custom-a" && imageId === "aaaaaaaa1",
  });
  assert.equal(library.selected, "custom-a");
  assert.deepEqual(library.sets.map((set) => set.id), ["vietnamese-monuments", "ai-seasons", "custom-a"]);
  assert.deepEqual(library.sets[2].images, [{ id: "aaaaaaaa1", url: "/api/notebook-illustrations/custom-a/aaaaaaaa1" }]);
});

test("only JPEG data URLs are accepted and only cover file names are notebook covers", () => {
  assert.equal(decodeJpegDataUrl(JPEG)[0], 0xff);
  assert.throws(() => decodeJpegDataUrl("data:image/png;base64,iVBORw0KGgo="));
  assert.throws(() => decodeJpegDataUrl(`data:image/jpeg;base64,${Buffer.from("not a jpeg").toString("base64")}`));
  assert.ok(isNotebookCoverFile(".libera-notebook-cover-0123abcd.jpg"));
  assert.ok(!isNotebookCoverFile("../.libera-notebook-cover-0123abcd.jpg"));
  assert.ok(!isNotebookCoverFile("cover.jpg"));
});

test("saving writes new images, keeps unchanged ones and removes deleted sets and images", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libera-illustrations-"));
  try {
    const first = await saveNotebookIllustrations({
      selected: "custom-a",
      sets: [
        { id: "custom-a", name: "A", images: [{ id: "aaaaaaaa1", crop: null, image: JPEG, source: JPEG }, { id: "aaaaaaaa2", crop: null, image: JPEG }] },
        { id: "custom-b", name: "B", images: [{ id: "bbbbbbbb1", crop: null, image: JPEG }] },
        { id: "custom-c", name: "C", images: [{ id: "cccccccc1", crop: null }] },
      ],
    }, { adminRoot: root });
    assert.deepEqual(first.sets.map((set) => [set.id, set.images.length]), [["custom-a", 2], ["custom-b", 1], ["custom-c", 0]]);
    assert.ok(fs.existsSync(illustrationFilePath(root, "custom-a", "aaaaaaaa1", "source")));

    // A set deleted and an image re-cropped under a new id.
    const second = await saveNotebookIllustrations({
      selected: "custom-b",
      sets: [{ id: "custom-a", name: "A", images: [{ id: "aaaaaaaa1" }, { id: "aaaaaaaa3", image: JPEG }] }],
    }, { adminRoot: root });
    assert.equal(second.selected, "vietnamese-monuments");
    assert.deepEqual(second.sets[0].images.map((image) => image.id), ["aaaaaaaa1", "aaaaaaaa3"]);
    assert.ok(!fs.existsSync(path.dirname(illustrationFilePath(root, "custom-b", "bbbbbbbb1"))));
    assert.deepEqual(fs.readdirSync(path.dirname(illustrationFilePath(root, "custom-a", "aaaaaaaa1"))).sort(),
      ["aaaaaaaa1.jpg", "aaaaaaaa1.source.jpg", "aaaaaaaa3.jpg"]);

    // A moved library takes the unchanged images along.
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), "libera-illustrations-moved-"));
    try {
      const third = await saveNotebookIllustrations(second, { adminRoot: moved, previousAdminRoot: root });
      assert.equal(third.sets[0].images.length, 2);
      assert.ok(fs.existsSync(illustrationFilePath(moved, "custom-a", "aaaaaaaa1", "source")));
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }

    await assert.rejects(saveNotebookIllustrations({ sets: [{ id: "custom-x", name: "X", images: [{ id: "xxxxxxxx1", image: JPEG }] }] }, {
      adminRoot: root, checkImage: () => { throw new Error("broken"); },
    }), /broken/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
