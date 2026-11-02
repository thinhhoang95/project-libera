// Where the user's illustrations live in the library, and writes the sets from Preferences into the library (see
// notebook-illustrations.cjs). Preferences sends each set with its images:
// one that is unchanged by id alone, a new or re-cropped one with `image`,
// the 3:1 cover, and `source`, the picture it was cut from, as JPEG data
// URLs. Re-cropping gives an image a new id, so the app never shows a stale
// cached cover. Files of deleted sets and images are removed after saving.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { isIllustrationImageId, isIllustrationSetId, normalizeNotebookIllustrations } = require("./notebook-illustrations.cjs");

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function illustrationsDirectory(adminRoot) {
  return path.join(adminRoot, ".libera", "notebook-illustrations");
}

/** `kind` is "image" for the cropped cover or "source" for the picture it came from. */
function illustrationFilePath(adminRoot, setId, imageId, kind = "image") {
  if (!isIllustrationSetId(setId) || !isIllustrationImageId(imageId)) throw new Error("Invalid illustration.");
  return path.join(illustrationsDirectory(adminRoot), setId, kind === "source" ? `${imageId}.source.jpg` : `${imageId}.jpg`);
}

/** `exists` for resolveNotebookIllustrations: whether an image's cover is in the library. */
function illustrationExists(adminRoot) {
  return (setId, imageId) => fs.existsSync(illustrationFilePath(adminRoot, setId, imageId));
}

function decodeJpegDataUrl(value) {
  const match = typeof value === "string" ? /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match) throw new Error("Illustrations must be JPEG images.");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("An illustration is too large.");
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("An illustration is not a JPEG image.");
  return buffer;
}

async function writeAtomically(filePath, buffer) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporary, buffer, { mode: 0o600 });
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Saves the sets and returns the preference to store. `adminRoot` is the
 * library the files go to; `previousAdminRoot`, when the library moved, is
 * where unchanged images are copied from. `checkImage(buffer)` may throw for
 * a picture that does not decode.
 */
async function saveNotebookIllustrations(input, { adminRoot, previousAdminRoot, checkImage = () => {} }) {
  const preferences = normalizeNotebookIllustrations(input);
  const uploads = new Map();
  for (const set of Array.isArray(input?.sets) ? input.sets : []) {
    for (const image of Array.isArray(set?.images) ? set.images : []) {
      if (isIllustrationImageId(image?.id) && (image.image || image.source)) uploads.set(`${set.id}/${image.id}`, image);
    }
  }

  for (const set of preferences.sets) {
    const kept = [];
    for (const image of set.images) {
      const upload = uploads.get(`${set.id}/${image.id}`);
      const target = illustrationFilePath(adminRoot, set.id, image.id);
      const sourceTarget = illustrationFilePath(adminRoot, set.id, image.id, "source");
      if (upload?.image) {
        const cover = decodeJpegDataUrl(upload.image);
        checkImage(cover);
        await writeAtomically(target, cover);
        if (upload.source) {
          const source = decodeJpegDataUrl(upload.source);
          checkImage(source);
          await writeAtomically(sourceTarget, source);
        }
      } else if (!fs.existsSync(target) && previousAdminRoot && previousAdminRoot !== adminRoot) {
        for (const kind of ["image", "source"]) {
          const from = illustrationFilePath(previousAdminRoot, set.id, image.id, kind);
          if (!fs.existsSync(from)) continue;
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(from, kind === "source" ? sourceTarget : target);
        }
      }
      if (fs.existsSync(target)) kept.push(image);
    }
    set.images = kept;
  }

  await removeUnusedIllustrations(adminRoot, preferences);
  return preferences;
}

/** Deletes files in the illustrations folder that no saved set refers to. */
async function removeUnusedIllustrations(adminRoot, preferences) {
  const directory = illustrationsDirectory(adminRoot);
  const keep = new Map(preferences.sets.map((set) => [set.id, new Set(set.images.map((image) => image.id))]));
  let entries = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const imageIds = entry.isDirectory() ? keep.get(entry.name) : null;
    if (!imageIds) {
      await fsp.rm(entryPath, { recursive: true, force: true });
      continue;
    }
    for (const file of await fsp.readdir(entryPath)) {
      const imageId = file.replace(/(\.source)?\.jpg$/, "");
      if (!file.endsWith(".jpg") || !imageIds.has(imageId)) await fsp.rm(path.join(entryPath, file), { force: true });
    }
  }
}

module.exports = { illustrationsDirectory, illustrationFilePath, illustrationExists, saveNotebookIllustrations, removeUnusedIllustrations, decodeJpegDataUrl };
