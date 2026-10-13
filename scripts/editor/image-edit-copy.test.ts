import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { NO_EDITS, parsePhotoEdits } from "../../src/lib/photo-edits";
import { saveEditedImageCopy } from "../../src/lib/storage/files";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookPath } from "../../src/lib/storage/paths";

test("edits to a notebook image are saved as a copy beside it", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-image-edit-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");

  try {
    await createNotebook("Trip");
    const folder = path.join(notebookPath("Trip"), "Photos");
    await mkdir(folder, { recursive: true });
    const original = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#4060a0" } }).jpeg().toBuffer();
    await writeFile(path.join(folder, "beach.jpg"), original);
    await writeFile(path.join(folder, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');

    const edits = parsePhotoEdits({ rotate: 90 });
    const first = await saveEditedImageCopy("Trip/Photos/beach.jpg", edits);
    assert.equal(first.file.path, "Trip/Photos/beach (edited).jpg");
    assert.equal(first.file.fileType, "image");
    const metadata = await sharp(await readFile(path.join(folder, "beach (edited).jpg"))).metadata();
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ["jpeg", 200, 300]);
    assert.deepEqual(await readFile(path.join(folder, "beach.jpg")), original, "The original is untouched");

    const second = await saveEditedImageCopy("Trip/Photos/beach.jpg", edits);
    assert.equal(second.file.path, "Trip/Photos/beach (edited)-1.jpg", "Earlier copies are never overwritten");

    await assert.rejects(saveEditedImageCopy("Trip/Photos/beach.jpg", NO_EDITS), /no changes/);
    // SVG files are text in a notebook, not images.
    await assert.rejects(saveEditedImageCopy("Trip/Photos/logo.svg", edits), /Only images/);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});
