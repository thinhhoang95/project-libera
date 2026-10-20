import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveFile, archiveFolder, copyFileToDirectory, deleteFile, deleteFolder, moveFile, moveFileToDirectory, renameFolder, updateMarkdownFile } from "../../src/lib/storage/files";
import { deleteMarkdownImageSource, getMarkdownImageAssetBySource, markdownImageSources, writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, notebookPath } from "../../src/lib/storage/paths";
import { rewriteMarkdownImageSources } from "../../src/lib/markdown-image-sources";
import { existsSync } from "node:fs";

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-markdown-images-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Notes"); await run(); }
  finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
async function document(relative: string, content = "text") {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}
async function photo(relative: string, body = "picture") {
  const asset = await writeMarkdownImageAsset(relative, new File([body], "photo.png"));
  await document(relative, asset.markdown);
  return asset;
}
async function assertPhoto(relative: string, expected = "picture") {
  const [notebook, ...parts] = relative.split("/");
  const content = await readFile(filePathFromParts(notebook, parts), "utf8");
  const [source] = markdownImageSources(content);
  assert.ok(source, "the document still contains its image link");
  assert.equal((await getMarkdownImageAssetBySource(relative, source)).body.toString(), expected);
}

test("Markdown images survive file and folder renames, moves and archives", () => withLibrary(async () => {
  await document("Notes/old/note.md"); await photo("Notes/old/note.md");
  await moveFile("Notes/old/note.md", "Notes", "renamed.md");
  await assertPhoto("Notes/old/renamed.md");
  await renameFolder("Notes/old", "new");
  await assertPhoto("Notes/new/renamed.md");
  await archiveFolder("Notes/new");
  await assertPhoto("Notes/_archive/new/renamed.md");
  await moveFileToDirectory("Notes/_archive/new/renamed.md", "Notes");
  await archiveFile("Notes/renamed.md");
  await assertPhoto("Notes/_archive/renamed.md");
}));

test("a copied document keeps its images after deleting the original", () => withLibrary(async () => {
  await document("Notes/note.md"); await photo("Notes/note.md");
  await copyFileToDirectory("Notes/note.md", "Notes", "copy.md");
  await assertPhoto("Notes/copy.md");
  await deleteFile("Notes/note.md");
  await assertPhoto("Notes/copy.md");
}));

test("cross-notebook moves and copies carry images without overwriting destination images", () => withLibrary(async () => {
  await createNotebook("Other");
  await document("Notes/note.md"); await photo("Notes/note.md", "source");
  await document("Other/note.md"); await photo("Other/note.md", "destination");
  await copyFileToDirectory("Notes/note.md", "Other", "copy.md");
  await assertPhoto("Other/copy.md", "source");
  await moveFileToDirectory("Notes/note.md", "Other", "moved.md");
  await assertPhoto("Other/moved.md", "source");
  await assertPhoto("Other/note.md", "destination");
}));

test("saving or deleting an alias-named document cannot remove another document's image", () => withLibrary(async () => {
  await document("Notes/a b.md"); const first = await photo("Notes/a b.md", "first");
  await document("Notes/a-b.md"); await photo("Notes/a-b.md", "second");
  await updateMarkdownFile("Notes/a b.md", first.markdown);
  await assertPhoto("Notes/a-b.md", "second");
  await deleteFile("Notes/a b.md");
  await assertPhoto("Notes/a-b.md", "second");
}));

test("a shared image survives deletion of another document or its folder", () => withLibrary(async () => {
  await document("Notes/folder/note.md"); const asset = await photo("Notes/folder/note.md");
  await document("Notes/also.md", asset.markdown);
  assert.deepEqual(await deleteMarkdownImageSource({ documentPath: "Notes/folder/note.md", imageSource: asset.assetPath, nextMarkdown: "text" }), { deleted: false });
  await deleteFolder("Notes/folder");
  await assertPhoto("Notes/also.md");
}));

test("reference-style Markdown images survive saves and fenced examples do not count as images", () => withLibrary(async () => {
  await document("Notes/note.md"); const asset = await photo("Notes/note.md");
  const content = `![Photo][image]\n\n[image]: ${asset.assetPath}\n\n\`\`\`md\n![Example](_assets/missing.png)\n\`\`\``;
  await updateMarkdownFile("Notes/note.md", content);
  assert.deepEqual(markdownImageSources(content), [asset.assetPath]);
  await assertPhoto("Notes/note.md");
}));

test("concurrent image uploads with the same name do not overwrite each other", () => withLibrary(async () => {
  await document("Notes/note.md");
  const assets = await Promise.all(Array.from({ length: 8 }, (_, i) => writeMarkdownImageAsset("Notes/note.md", new File([String(i)], "photo.png"))));
  assert.equal(new Set(assets.map((asset) => asset.assetPath)).size, assets.length);
  for (const [i, asset] of assets.entries()) assert.equal((await getMarkdownImageAssetBySource("Notes/note.md", asset.assetPath)).body.toString(), String(i));
}));

test("saving and deleting moved notes clean up their original asset locations", () => withLibrary(async () => {
  await document("Notes/folder/note.md"); const asset = await photo("Notes/folder/note.md");
  await renameFolder("Notes/folder", "renamed");
  await updateMarkdownFile("Notes/renamed/note.md", "removed");
  assert.ok(!existsSync(path.join(notebookPath("Notes"), asset.assetPath)));
  const next = await photo("Notes/renamed/note.md");
  await archiveFolder("Notes/renamed");
  await deleteFolder("Notes/_archive/renamed");
  assert.ok(!existsSync(path.join(notebookPath("Notes"), next.assetPath)));
  assert.ok(!existsSync(path.join(notebookPath("Notes"), "_assets")));
}));

test("an image remains until its last saved reference is removed", () => withLibrary(async () => {
  await document("Notes/note.md"); const asset = await photo("Notes/note.md");
  await document("Notes/also.md", asset.markdown);
  await updateMarkdownFile("Notes/note.md", "removed");
  await assertPhoto("Notes/also.md");
  await updateMarkdownFile("Notes/also.md", "removed");
  assert.ok(!existsSync(path.join(notebookPath("Notes"), asset.assetPath)));
}));

test("copy rewrites reference definitions and HTML image attributes without rewriting code examples", () => withLibrary(async () => {
  await document("Notes/note.md"); const asset = await photo("Notes/note.md");
  const content = `![Photo][id]\n\n[id]: <${asset.assetPath}> "Title"\n\n<img src='${asset.assetPath}' alt='Photo'>\n\n\`![code](${asset.assetPath})\`\n\n\`\`\`md\n![example](${asset.assetPath})\n\`\`\``;
  await document("Notes/note.md", content);
  const copied = await copyFileToDirectory("Notes/note.md", "Notes", "copy.md");
  const [source] = markdownImageSources(copied.content!);
  assert.notEqual(source, asset.assetPath);
  assert.equal(copied.content, rewriteMarkdownImageSources(content, { [asset.assetPath]: source }));
  assert.ok(copied.content!.includes(`\`![code](${asset.assetPath})\``));
  assert.ok(copied.content!.includes(`![example](${asset.assetPath})`));
  await deleteFile("Notes/note.md");
  await assertPhoto("Notes/copy.md");
}));

test("image parsing handles escaped destinations and ignores comments and code", () => {
  const content = "![a [nested]](_assets/note/a\\(b\\).png \"title\")\n\n![second][]\n\n[second]: <_assets/note/second.png>\n\n<!-- <img src='_assets/note/comment.png'> -->\n\n    ![code](_assets/note/code.png)\n\n<img src=\"_assets/note/html.png\">";
  assert.deepEqual(markdownImageSources(content), ["_assets/note/a(b).png", "_assets/note/second.png", "_assets/note/html.png"]);
  const rewritten = rewriteMarkdownImageSources(content, { "_assets/note/a(b).png": "_assets/copy/new.png", "_assets/note/second.png": "_assets/copy/second.png" });
  assert.ok(rewritten.includes('![a [nested]](_assets/copy/new.png "title")'));
  assert.ok(rewritten.includes("[second]: <_assets/copy/second.png>"));
});

test("raw image URLs ignore cache queries and preserve images used by another note", () => withLibrary(async () => {
  await document("Notes/photo.png", "raw-photo");
  await document("Notes/note.md", "![photo](/api/files/raw/Notes/photo.png?v=1#view)");
  await document("Notes/also.md", "![photo](/api/files/raw/Notes/photo.png?v=2)");
  await assertPhoto("Notes/note.md", "raw-photo");
  assert.deepEqual(await deleteMarkdownImageSource({ documentPath: "Notes/note.md", imageSource: "/api/files/raw/Notes/photo.png?v=1#view", nextMarkdown: "removed" }), { deleted: false });
  await deleteFile("Notes/also.md");
  assert.deepEqual(await deleteMarkdownImageSource({ documentPath: "Notes/note.md", imageSource: "/api/files/raw/Notes/photo.png?v=1#view", nextMarkdown: "removed" }), { deleted: true });
  assert.ok(!existsSync(filePathFromParts("Notes", ["photo.png"])));
}));

test("cross-notebook moves also carry uploaded images in unsaved drafts", () => withLibrary(async () => {
  await createNotebook("Other");
  await document("Notes/note.md", "saved");
  const asset = await writeMarkdownImageAsset("Notes/note.md", new File(["draft-photo"], "photo.png"));
  const payload = await moveFileToDirectory("Notes/note.md", "Other");
  assert.equal(payload.content, "saved", "moving must not save the draft");
  const draft = rewriteMarkdownImageSources(`unsaved\n${asset.markdown}`, payload.imageSources!);
  const [source] = markdownImageSources(draft);
  assert.ok(draft.startsWith("unsaved\n"));
  assert.equal((await getMarkdownImageAssetBySource("Other/note.md", source)).body.toString(), "draft-photo");
}));

test("uploads cannot publish after their document is deleted or replaced", () => withLibrary(async () => {
  for (const replace of [false, true]) {
    await document("Notes/note.md");
    let release!: () => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upload = new File(["late"], "photo.png");
    upload.arrayBuffer = async () => { reading(); await gate; return new TextEncoder().encode("late").buffer; };
    const writing = writeMarkdownImageAsset("Notes/note.md", upload);
    const rejected = assert.rejects(writing);
    await started;
    await deleteFile("Notes/note.md");
    if (replace) await document("Notes/note.md", "replacement");
    release();
    await rejected;
    assert.ok(!existsSync(path.join(notebookPath("Notes"), "_assets")));
  }
}));

test("saving an alias or a parent note preserves another note's pending upload", () => withLibrary(async () => {
  await document("Notes/a b.md"); await photo("Notes/a b.md");
  await document("Notes/a-b.md");
  const pending = await writeMarkdownImageAsset("Notes/a-b.md", new File(["pending"], "photo.png"));
  await updateMarkdownFile("Notes/a b.md", "removed");
  assert.equal((await getMarkdownImageAssetBySource("Notes/a-b.md", pending.assetPath)).body.toString(), "pending");
  await document("Notes/folder.md");
  await document("Notes/folder/nested.md");
  const nested = await writeMarkdownImageAsset("Notes/folder/nested.md", new File(["nested"], "photo.png"));
  await deleteFile("Notes/folder.md");
  assert.equal((await getMarkdownImageAssetBySource("Notes/folder/nested.md", nested.assetPath)).body.toString(), "nested");
}));

test("raw asset URLs remain readable when the originating note moves or is deleted", () => withLibrary(async () => {
  await document("Notes/note.md"); const asset = await photo("Notes/note.md");
  await document("Notes/note.md", `![photo](${asset.rawUrl})`);
  await moveFile("Notes/note.md", "Notes", "renamed.md");
  await assertPhoto("Notes/renamed.md");
  await document("Notes/also.md", `![photo](${asset.rawUrl})`);
  await deleteFile("Notes/renamed.md");
  await assertPhoto("Notes/also.md");
}));

test("a missing source image cannot turn into an unrelated image after a cross-notebook move", () => withLibrary(async () => {
  await createNotebook("Other");
  await document("Other/note.md"); await photo("Other/note.md", "unrelated");
  await document("Notes/note.md", "![missing](_assets/note/photo.png)");
  const payload = await moveFileToDirectory("Notes/note.md", "Other", "moved.md");
  const [source] = markdownImageSources(payload.content!);
  await assert.rejects(getMarkdownImageAssetBySource("Other/moved.md", source), { code: "ENOENT" });
  await assertPhoto("Other/note.md", "unrelated");
}));

test("HTML images parse quoted attributes and entities without confusing data-src or alt text", () => {
  const html = '<img data-src="decoy.png" alt="src=\'example\' >" src="/api/markdown-assets/raw?document=Notes%2Fnote.md&amp;asset=_assets%2Fnote%2Fphoto.png">';
  const source = "/api/markdown-assets/raw?document=Notes%2Fnote.md&asset=_assets%2Fnote%2Fphoto.png";
  assert.deepEqual(markdownImageSources(html), [source]);
  assert.equal(rewriteMarkdownImageSources(html, { [source]: "_assets/copy/photo.png" }), '<img data-src="decoy.png" alt="src=\'example\' >" src="_assets/copy/photo.png">');
});
