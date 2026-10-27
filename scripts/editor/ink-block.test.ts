import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Editor } from "@tiptap/core";
import fc from "fast-check";
import { INK_BLOCK_WIDTH, inkBlockChunk, inkBlockFrame, inkBlockSource, isInkBlockRenderingName, parseInkBlockSource } from "../../src/lib/ink/block";
import { emptyInkAuthorFile, encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import { applyInkOps, mergeInkFiles, mergePendingInkOps } from "../../src/lib/ink/merge";
import type { InkOps, InkStroke } from "../../src/lib/ink/types";
import { deleteFile, moveFileToDirectory, updateMarkdownFile } from "../../src/lib/storage/files";
import { readInk, resetInkStorageForTests, writeInk } from "../../src/lib/storage/ink";
import { getMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, notebookPath } from "../../src/lib/storage/paths";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";

const ID = "k3f9q2m8x1c4v7b0";

let counter = 0;
function stroke(y = 20, overrides: Partial<InkStroke> = {}): InkStroke {
  counter += 1;
  const samples = [{ x: 20, y, pressure: 0.4 }, { x: 300, y: y + 10, pressure: 0.8 }];
  return {
    id: `b${counter}x`,
    brush: "pen",
    color: "#1f2328",
    opacity: 1,
    width: 2,
    lineStyle: "solid",
    points: encodeInkSamples(samples),
    bounds: sampleBounds(samples),
    createdAt: new Date(1_700_000_000_000 + counter).toISOString(),
    ...overrides,
  };
}

// ---- Sources and Markdown ------------------------------------------------------

test("ink block sources are recognized wherever the asset sits", () => {
  assert.equal(parseInkBlockSource(`_assets/Notes/Lecture-3/ink-${ID}.svg`), ID);
  assert.equal(parseInkBlockSource(`_assets/Notes/Lecture-3/ink-${ID}-2.svg`), ID, "a copy beside an existing name");
  assert.equal(parseInkBlockSource(`_assets/Other/6f1e/ink-${ID}.svg`), ID);
  assert.equal(parseInkBlockSource(`/api/markdown-assets/raw?document=Notes%2Fa.md&asset=${encodeURIComponent(`_assets/a/ink-${ID}.svg`)}`), ID);
  assert.equal(parseInkBlockSource("_assets/a/photo.png"), null);
  assert.equal(parseInkBlockSource("_assets/a/ink-short.svg"), null);
  assert.equal(parseInkBlockSource("_assets/a/drawing.svg"), null);
  assert.equal(parseInkBlockSource("/api/markdown-assets/raw?asset=%E0%A4%A"), null, "malformed URI data in an image does not crash the editor");
  assert.equal(isInkBlockRenderingName(`ink-${ID}.svg`), true);
  assert.equal(isInkBlockRenderingName("logo.svg"), false);
  assert.equal(inkBlockSource("Notes/Folder A/Lecture 3.md", ID), `_assets/Folder-A/Lecture-3/ink-${ID}.svg`);
  assert.equal(inkBlockChunk(ID), `block-${ID}`);
});

test("an ink block round-trips through the Visual editor's Markdown unchanged", () => {
  const source = `# Lecture\n\nBefore the sketch.\n\n![Ink](_assets/Lecture/ink-${ID}.svg)\n\nAfter the sketch.\n`;
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/Lecture.md"), content: source, contentType: "markdown" });
  try {
    const images: string[] = [];
    editor.state.doc.descendants((node) => { if (node.type.name === "image") images.push(String(node.attrs.src)); });
    assert.deepEqual(images, [`_assets/Lecture/ink-${ID}.svg`]);
    assert.equal(editor.getMarkdown().trim(), source.trim());
  } finally {
    editor.destroy();
  }
});

// ---- Merging ---------------------------------------------------------------------

test("a block is as tall as its tallest author's frame", () => {
  const short = emptyInkAuthorFile({ key: "aaaaaa" }, inkBlockFrame(240));
  const tall = emptyInkAuthorFile({ key: "bbbbbb" }, inkBlockFrame(560));
  assert.deepEqual(mergeInkFiles([short, tall]).frame, { unit: "px", width: INK_BLOCK_WIDTH, height: 560 });
  assert.deepEqual(mergeInkFiles([tall, short]).frame, { unit: "px", width: INK_BLOCK_WIDTH, height: 560 });
});

test("batched pending changes save to the same ink as saving each one", () => {
  const visible = (file: ReturnType<typeof emptyInkAuthorFile>) => file.strokes.map((item) => item.id).sort();
  const opArbitrary = fc.oneof(
    fc.record({ kind: fc.constant("add" as const) }),
    fc.record({ kind: fc.constant("erase" as const), pick: fc.nat() }),
    fc.record({ kind: fc.constant("restore" as const), pick: fc.nat() }),
    fc.record({ kind: fc.constant("save" as const) }),
  );
  fc.assert(fc.property(fc.array(opArbitrary, { maxLength: 40 }), (steps) => {
    let stepwise = applyInkOps(emptyInkAuthorFile({ key: "aaaaaa" }, inkBlockFrame()), { add: [stroke(), stroke()] });
    let batched = stepwise;
    let pending: InkOps = {};
    const erased: InkStroke[] = [];
    for (const step of steps) {
      let ops: InkOps | null = null;
      if (step.kind === "add") ops = { add: [stroke()] };
      else if (step.kind === "erase" && stepwise.strokes.length) {
        const target = stepwise.strokes[step.pick % stepwise.strokes.length];
        erased.push(target);
        ops = { erase: [target.id] };
      } else if (step.kind === "restore" && erased.length) {
        // Undo of an erase: the same stroke added back.
        const [target] = erased.splice(step.pick % erased.length, 1);
        if (!stepwise.strokes.some((item) => item.id === target.id)) ops = { add: [target] };
      } else if (step.kind === "save") {
        batched = applyInkOps(batched, pending);
        pending = {};
      }
      if (!ops) continue;
      stepwise = applyInkOps(stepwise, ops);
      pending = mergePendingInkOps(pending, ops);
    }
    batched = applyInkOps(batched, pending);
    assert.deepEqual(visible(batched), visible(stepwise));
  }));
});

// ---- Storage ------------------------------------------------------------------------

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-ink-block-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = path.join(directory, "master");
  process.env.LIBERA_CONFIG_PATH = path.join(directory, "user-data", "config.json");
  resetInkStorageForTests();
  try { await createNotebook("Notes"); await run(); }
  finally {
    for (const [key, value] of [["LIBERA_DATA_DIR", previous.data], ["LIBERA_CONFIG_PATH", previous.config]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetInkStorageForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

async function note(relative: string, body: string) {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

const renderingPath = (source: string) => path.join(notebookPath("Notes"), ...source.split("/"));

test("saving a block's ink rewrites its SVG rendering, which the note serves as an image", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `Sketch:\n\n![Ink](${source})\n`);

  // A new block's rendering exists before anything is drawn.
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(), { rendering: source });
  const blank = await readFile(renderingPath(source), "utf8");
  assert.match(blank, /^<svg[^>]+viewBox="0 0 720 240"/);
  assert.doesNotMatch(blank, /<path/);
  assert.equal((await readInk("Notes/Lecture.md", [inkBlockChunk(ID)])).chunks[0].revision, 0, "no ink file for an empty block");

  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [stroke(), stroke(60, { brush: "highlighter", color: "#ffe45c", opacity: 0.35, width: 12 })] }, inkBlockFrame(), { rendering: source });
  const drawn = await readFile(renderingPath(source), "utf8");
  assert.equal((drawn.match(/<path/g) ?? []).length, 2);
  assert.match(drawn, /mix-blend-mode:multiply/);
  assert.doesNotMatch(drawn, /<script|on[a-z]+=/i);

  const asset = await getMarkdownImageAsset("Notes/Lecture.md", source);
  assert.equal(asset.contentType, "image/svg+xml");
  assert.equal(asset.body.toString("utf8"), drawn);

  // Other SVGs are still not note images.
  await writeFile(path.join(path.dirname(renderingPath(source)), "logo.svg"), "<svg/>");
  await assert.rejects(getMarkdownImageAsset("Notes/Lecture.md", source.replace(`ink-${ID}.svg`, "logo.svg")));
}));

test("a block's new height is recorded, and its rendering must be its own", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `![Ink](${source})\n`);
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [stroke()] }, inkBlockFrame(), { rendering: source });
  const taller = await writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(400), { rendering: source });
  assert.equal(taller.chunks[0].frame?.height, 400);
  assert.equal(taller.chunks[0].revision, 2);
  assert.match(await readFile(renderingPath(source), "utf8"), /viewBox="0 0 720 400"/);

  await assert.rejects(writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(), { rendering: source.replace(ID, "zzzzzzzzzzzz") }), /does not belong/);
  await assert.rejects(writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(), { rendering: "../../outside.svg" }));
  await assert.rejects(writeInk("Notes/Lecture.md", "text", {}, inkBlockFrame(), { rendering: source }), /Only ink blocks/);
}));

test("retrying an already saved stroke repairs a rendering whose publication failed", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `![Ink](${source})\n`);
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(), { rendering: source });
  const mark = stroke();
  // The author file landed, but the rendering is still the old empty SVG.
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [mark] }, inkBlockFrame());
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [mark] }, inkBlockFrame(), { rendering: source });
  const svg = await readFile(renderingPath(source), "utf8");
  assert.equal((svg.match(/<path/g) ?? []).length, 1);
}));

test("saving the note keeps a block's rendering even while the block is out of it", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `![Ink](${source})\n`);
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [stroke()] }, inkBlockFrame(), { rendering: source });
  await writeFile(path.join(path.dirname(renderingPath(source)), "pasted.png"), "png");

  // The block was deleted (Undo may bring it back): its rendering stays, an unused upload goes.
  await updateMarkdownFile("Notes/Lecture.md", `![Pasted](${source.replace(`ink-${ID}.svg`, "pasted.png")})\n`);
  await updateMarkdownFile("Notes/Lecture.md", "No images now.\n");
  assert.ok(existsSync(renderingPath(source)));
  assert.ok(!existsSync(path.join(path.dirname(renderingPath(source)), "pasted.png")));

  // Deleting the note takes its renderings and its ink along.
  await deleteFile("Notes/Lecture.md");
  assert.ok(!existsSync(renderingPath(source)));
  assert.ok(!existsSync(path.join(notebookPath("Notes"), "_ink", "Lecture.md")));
}));

test("a note moved to another notebook takes its block's rendering and ink", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `![Ink](${source})\n`);
  const kept = stroke();
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [kept] }, inkBlockFrame(), { rendering: source });
  await createNotebook("Other");
  await moveFileToDirectory("Notes/Lecture.md", "Other");

  const moved = await readFile(filePathFromParts("Other", ["Lecture.md"]), "utf8");
  const src = /!\[Ink\]\(([^)]+)\)/.exec(moved)?.[1] ?? "";
  assert.equal(parseInkBlockSource(src), ID, `the moved note still points at an ink rendering: ${moved}`);
  assert.equal((await getMarkdownImageAsset("Other/Lecture.md", src)).contentType, "image/svg+xml");
  assert.deepEqual((await readInk("Other/Lecture.md", [inkBlockChunk(ID)])).chunks[0].strokes.map((item) => item.stroke.id), [kept.id]);
}));

test("saves write as little as possible to a synced notebook", () => withLibrary(async () => {
  const source = inkBlockSource("Notes/Lecture.md", ID);
  await note("Notes/Lecture.md", `![Ink](${source})\n`);
  assert.equal((await readInk("Notes/Lecture.md", [inkBlockChunk(ID)], source)).chunks[0].renderingMissing, true, "a new block's rendering is written with the next Save");

  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), { add: [stroke()] }, inkBlockFrame(), { rendering: source });
  assert.equal((await readInk("Notes/Lecture.md", [inkBlockChunk(ID)], source)).chunks[0].renderingMissing, false);
  const folder = path.join(notebookPath("Notes"), "_ink", "Lecture.md");
  const [name] = await readdir(folder);
  const text = await readFile(path.join(folder, name), "utf8");
  assert.doesNotMatch(text, /\n /, "author files are compact JSON");

  // Saving again with nothing new leaves the rendering's file alone.
  const before = (await stat(renderingPath(source))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeInk("Notes/Lecture.md", inkBlockChunk(ID), {}, inkBlockFrame(), { rendering: source });
  assert.equal((await stat(renderingPath(source))).mtimeMs, before, "an unchanged rendering is not rewritten");
}));
