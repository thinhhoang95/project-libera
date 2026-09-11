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
