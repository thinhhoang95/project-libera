// Illustration sets for the notebook homepage covers, shared by Preferences
// (Electron), the Next server and the app; it requires nothing, as client
// code imports it (file paths are in notebook-illustration-store.cjs). The
// built-in sets ship in public/images: "Kỷ nguyên vươn mình" (Vietnamese
// monuments, the default) and "AI Seasons", the original covers, which keep
// each notebook's stored illustration. The user's own sets are stored with
// the preferences, and
// their images live in the library at
// users/admin/.libera/notebook-illustrations/<set id>/<image id>.jpg, cropped
// to the cover's 3:1 aspect, next to <image id>.source.jpg, the picture the
// crop was taken from. Each image keeps its crop as a normalized rectangle of
// the source (the gallery's CropRect), so it can be adjusted again later.
// A notebook takes an image from the chosen set at random, unless the user
// picked one for it (illustrationPath in its metadata, a copied file).
const AI_SEASONS_SET_ID = "ai-seasons";
const VIETNAMESE_MONUMENTS_SET_ID = "vietnamese-monuments";
const DEFAULT_ILLUSTRATION_SET_ID = VIETNAMESE_MONUMENTS_SET_ID;
const ILLUSTRATIONS_VERSION = 1;
const ILLUSTRATION_WIDTH = 2172;
const ILLUSTRATION_HEIGHT = 724;
const ILLUSTRATION_ASPECT = ILLUSTRATION_WIDTH / ILLUSTRATION_HEIGHT;
const MAX_ILLUSTRATION_SETS = 50;
const MAX_ILLUSTRATIONS_PER_SET = 200;
const MAX_ILLUSTRATION_SET_NAME_LENGTH = 60;
const CUSTOM_ILLUSTRATIONS_URL = "/api/notebook-illustrations";
const SET_ID_PATTERN = /^custom-[a-z0-9-]{1,40}$/;
const IMAGE_ID_PATTERN = /^[a-z0-9]{8,40}$/;

// Kept in step with NOTEBOOK_ILLUSTRATIONS in src/lib/notebook-illustrations.ts.
const AI_SEASONS_IMAGES = Object.freeze([
  ["lavender-alpine", "notebook-landscape.png"],
  ["sage-forest", "notebook-sage-forest.png"],
  ["peach-dunes", "notebook-peach-dunes.png"],
  ["azure-coast", "notebook-azure-coast.png"],
  ["rose-garden", "notebook-rose-garden.png"],
  ["amber-autumn", "notebook-amber-autumn.png"],
  ["teal-waterfall", "notebook-teal-waterfall.png"],
  ["lilac-moonrise", "notebook-lilac-moonrise.png"],
  ["golden-meadow", "notebook-golden-meadow.png"],
].map(([id, file]) => Object.freeze({ id, file, url: `/images/${file}` })));

const VIETNAMESE_MONUMENTS_IMAGES = Object.freeze([
  "turtle-tower",
  "one-pillar-pagoda",
  "hue-meridian-gate",
  "hoi-an-covered-bridge",
  "po-nagar-towers",
  "independence-palace",
].map((id) => {
  const file = `vietnamese-monuments/notebook-${id}.png`;
  return Object.freeze({ id, file, url: `/images/${file}` });
}));

const AI_SEASONS_SET = Object.freeze({ id: AI_SEASONS_SET_ID, name: "AI Seasons", builtIn: true, images: AI_SEASONS_IMAGES });
/** The default set first. Each image's `file` is relative to public/images. */
const BUILT_IN_ILLUSTRATION_SETS = Object.freeze([
  Object.freeze({ id: VIETNAMESE_MONUMENTS_SET_ID, name: "Kỷ nguyên vươn mình", builtIn: true, images: VIETNAMESE_MONUMENTS_IMAGES }),
  AI_SEASONS_SET,
]);
const BUILT_IN_ILLUSTRATIONS = Object.freeze(BUILT_IN_ILLUSTRATION_SETS.flatMap((set) => set.images));

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIllustrationSetId(value) {
  return typeof value === "string" && SET_ID_PATTERN.test(value);
}

function isIllustrationImageId(value) {
  return typeof value === "string" && IMAGE_ID_PATTERN.test(value);
}

function normalizeSetName(value) {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return name.slice(0, MAX_ILLUSTRATION_SET_NAME_LENGTH);
}

// A crop of the source in 0–1 coordinates, or null for the centered default.
function normalizeCrop(value) {
  if (!isRecord(value)) return null;
  const numbers = ["x", "y", "width", "height"].map((key) => Number(value[key]));
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0 || x < -1e-6 || y < -1e-6 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) return null;
  const round = (number) => Math.round(Math.min(1, Math.max(0, number)) * 1e6) / 1e6;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

/** The saved preference: which set covers use, and the user's own sets. */
function normalizeNotebookIllustrations(value) {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  if (!isRecord(input)) input = {};
  const sets = [];
  const setIds = new Set();
  for (const entry of Array.isArray(input.sets) ? input.sets : []) {
    if (sets.length >= MAX_ILLUSTRATION_SETS) break;
    if (!isRecord(entry) || !isIllustrationSetId(entry.id) || setIds.has(entry.id)) continue;
    const name = normalizeSetName(entry.name);
    if (!name) continue;
    const images = [];
    const imageIds = new Set();
    for (const image of Array.isArray(entry.images) ? entry.images : []) {
      if (images.length >= MAX_ILLUSTRATIONS_PER_SET) break;
      if (!isRecord(image) || !isIllustrationImageId(image.id) || imageIds.has(image.id)) continue;
      imageIds.add(image.id);
      images.push({ id: image.id, crop: normalizeCrop(image.crop) });
    }
    setIds.add(entry.id);
    sets.push({ id: entry.id, name, images });
  }
  const selected = setIds.has(input.selected) || BUILT_IN_ILLUSTRATION_SETS.some((set) => set.id === input.selected)
    ? input.selected
    : DEFAULT_ILLUSTRATION_SET_ID;
  return { version: ILLUSTRATIONS_VERSION, selected, sets };
}

function customIllustrationUrl(setId, imageId) {
  return `${CUSTOM_ILLUSTRATIONS_URL}/${setId}/${imageId}`;
}

// A notebook's own cover is a copy of the chosen image, kept beside its
// metadata so it outlives the set it came from; metadata names the file.
const NOTEBOOK_COVER_FILE_PATTERN = /^\.libera-notebook-cover-[a-z0-9]{8,40}\.(jpg|png)$/;

function isNotebookCoverFile(value) {
  return typeof value === "string" && NOTEBOOK_COVER_FILE_PATTERN.test(value);
}

/**
 * Every set with its image URLs, for the app: the covers and the picker.
 * `exists(setId, imageId)` leaves out images whose file is gone.
 */
function resolveNotebookIllustrations(value, { exists } = {}) {
  const preferences = normalizeNotebookIllustrations(value);
  const sets = BUILT_IN_ILLUSTRATION_SETS.map((set) => ({ id: set.id, name: set.name, builtIn: true, images: set.images.map(({ id, url }) => ({ id, url })) }));
  for (const set of preferences.sets) {
    const images = set.images
      .filter((image) => !exists || exists(set.id, image.id))
      .map((image) => ({ id: image.id, url: customIllustrationUrl(set.id, image.id) }));
    sets.push({ id: set.id, name: set.name, images });
  }
  return { selected: preferences.selected, sets };
}

const DEFAULT_NOTEBOOK_ILLUSTRATIONS = Object.freeze(resolveNotebookIllustrations(null));

module.exports = {
  AI_SEASONS_SET_ID,
  VIETNAMESE_MONUMENTS_SET_ID,
  DEFAULT_ILLUSTRATION_SET_ID,
  AI_SEASONS_IMAGES,
  BUILT_IN_ILLUSTRATION_SETS,
  BUILT_IN_ILLUSTRATIONS,
  ILLUSTRATION_WIDTH,
  ILLUSTRATION_HEIGHT,
  ILLUSTRATION_ASPECT,
  MAX_ILLUSTRATION_SETS,
  MAX_ILLUSTRATIONS_PER_SET,
  MAX_ILLUSTRATION_SET_NAME_LENGTH,
  DEFAULT_NOTEBOOK_ILLUSTRATIONS,
  isIllustrationSetId,
  isIllustrationImageId,
  normalizeCrop,
  normalizeNotebookIllustrations,
  customIllustrationUrl,
  isNotebookCoverFile,
  resolveNotebookIllustrations,
};
