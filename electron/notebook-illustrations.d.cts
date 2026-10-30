/** A crop of the source picture in 0–1 coordinates, like the gallery's CropRect. */
export type IllustrationCrop = { x: number; y: number; width: number; height: number };
export type StoredIllustration = { id: string; crop: IllustrationCrop | null };
export type StoredIllustrationSet = { id: string; name: string; images: StoredIllustration[] };
export type NotebookIllustrationPreferences = { version: 1; selected: string; sets: StoredIllustrationSet[] };
export type ResolvedIllustration = { id: string; url: string };
export type ResolvedIllustrationSet = { id: string; name: string; builtIn?: true; images: ResolvedIllustration[] };
/** Every set with its image URLs, and the one covers use. */
export type NotebookIllustrationLibrary = { selected: string; sets: ResolvedIllustrationSet[] };
export type BuiltInIllustration = { id: string; file: string; url: string };

export const AI_SEASONS_SET_ID: "ai-seasons";
export const VIETNAMESE_MONUMENTS_SET_ID: "vietnamese-monuments";
export const DEFAULT_ILLUSTRATION_SET_ID: string;
export const AI_SEASONS_IMAGES: readonly Readonly<BuiltInIllustration>[];
/** The default set first; each image's `file` is relative to public/images. */
export const BUILT_IN_ILLUSTRATION_SETS: readonly Readonly<{ id: string; name: string; builtIn: true; images: readonly Readonly<BuiltInIllustration>[] }>[];
export const BUILT_IN_ILLUSTRATIONS: readonly Readonly<BuiltInIllustration>[];
export const ILLUSTRATION_WIDTH: number;
export const ILLUSTRATION_HEIGHT: number;
export const ILLUSTRATION_ASPECT: number;
export const MAX_ILLUSTRATION_SETS: number;
export const MAX_ILLUSTRATIONS_PER_SET: number;
export const MAX_ILLUSTRATION_SET_NAME_LENGTH: number;
export const DEFAULT_NOTEBOOK_ILLUSTRATIONS: Readonly<NotebookIllustrationLibrary>;
export function isIllustrationSetId(value: unknown): value is string;
export function isIllustrationImageId(value: unknown): value is string;
export function normalizeCrop(value: unknown): IllustrationCrop | null;
export function normalizeNotebookIllustrations(value: unknown): NotebookIllustrationPreferences;
export function customIllustrationUrl(setId: string, imageId: string): string;
export function isNotebookCoverFile(value: unknown): value is string;
export function resolveNotebookIllustrations(value: unknown, options?: { exists?: (setId: string, imageId: string) => boolean }): NotebookIllustrationLibrary;
