export const NOTEBOOK_ILLUSTRATIONS = {
  "lavender-alpine": "/images/notebook-landscape.png",
  "sage-forest": "/images/notebook-sage-forest.png",
  "peach-dunes": "/images/notebook-peach-dunes.png",
  "azure-coast": "/images/notebook-azure-coast.png",
  "rose-garden": "/images/notebook-rose-garden.png",
  "amber-autumn": "/images/notebook-amber-autumn.png",
  "teal-waterfall": "/images/notebook-teal-waterfall.png",
  "lilac-moonrise": "/images/notebook-lilac-moonrise.png",
  "golden-meadow": "/images/notebook-golden-meadow.png",
} as const;

export type NotebookIllustration = keyof typeof NOTEBOOK_ILLUSTRATIONS;
export const NOTEBOOK_ILLUSTRATION_IDS = Object.keys(NOTEBOOK_ILLUSTRATIONS) as NotebookIllustration[];

export function isNotebookIllustration(value: unknown): value is NotebookIllustration {
  return typeof value === "string" && Object.hasOwn(NOTEBOOK_ILLUSTRATIONS, value);
}

// Older notebooks use their immutable creation time as a stable random seed.
// Keep this original pool fixed so adding artwork won't reshuffle old notebooks.
export function legacyNotebookIllustration(createdAt: string): NotebookIllustration {
  const pool: NotebookIllustration[] = ["lavender-alpine", "sage-forest", "peach-dunes", "azure-coast", "rose-garden"];
  let hash = 2166136261;
  for (const character of createdAt) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return pool[(hash >>> 0) % pool.length];
}

export function notebookIllustrationUrl(illustration: unknown, createdAt: string) {
  return NOTEBOOK_ILLUSTRATIONS[isNotebookIllustration(illustration)
    ? illustration : legacyNotebookIllustration(createdAt)];
}

type IllustratedNotebook = { name: string; createdAt: string; illustration?: unknown; illustrationPath?: string };
type IllustrationLibrary = import("../../electron/notebook-illustrations.cjs").NotebookIllustrationLibrary;

/**
 * A notebook's cover: the one the user picked for it, else one from the
 * chosen set. AI Seasons keeps each notebook's stored illustration; in any
 * other set the notebook's creation time picks an image, so it stays put as
 * long as the set does.
 */
export function notebookCoverUrl(notebook: IllustratedNotebook, library: IllustrationLibrary) {
  if (notebook.illustrationPath) {
    return `/api/notebooks/illustration?notebook=${encodeURIComponent(notebook.name)}&file=${encodeURIComponent(notebook.illustrationPath)}`;
  }
  const set = library.sets.find((candidate) => candidate.id === library.selected);
  if (!set || set.id === "ai-seasons" || !set.images.length) return notebookIllustrationUrl(notebook.illustration, notebook.createdAt);
  let hash = 2166136261;
  for (const character of `${String(notebook.illustration ?? "")}|${notebook.createdAt}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return set.images[(hash >>> 0) % set.images.length].url;
}
