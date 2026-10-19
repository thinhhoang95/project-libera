export type SearchPreferences = {
  textWeights: string;
  visionWeights: string;
  dimensions: 768 | 512 | 256 | 128;
  visionTokens: 70 | 140 | 280 | 560 | 1120;
  indexImages: boolean;
  backgroundIndexing: boolean;
  /** The index's SQLite file; empty for the default location. */
  indexFile: string;
  /** The PDF reading model's folder, laid out like its Hugging Face repository; empty for Libera's download folder. */
  readingModelDirectory: string;
};

export const DEFAULT_SEARCH_PREFERENCES: Readonly<SearchPreferences>;
export const INDEX_FILE_NAME: string;
export const MODEL_FOLDERS: Readonly<{ search: string; reading: string; readAloud: string; speech: string }>;
export const SEARCH_DIMENSIONS: SearchPreferences["dimensions"][];
export const SEARCH_VISION_TOKENS: SearchPreferences["visionTokens"][];
export function defaultModelsDirectory(options: { adminRoot: string; configPath?: string; platform?: string; localAppData?: string }): string;
export function defaultSearchIndexFile(options: { adminRoot: string; configPath?: string; platform?: string; localAppData?: string }): string;
export function normalizeSearchPreferences(input: unknown): SearchPreferences;
export function searchPreferencesFromEnvironment(env?: NodeJS.ProcessEnv): SearchPreferences;
