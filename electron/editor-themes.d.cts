export type EditorThemeScope = "visual" | "source" | "latex";
export type EditorThemeColorKey = "background" | "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "lists";
export type EditorThemeAppearance = Record<EditorThemeColorKey, string>;
/** A theme's colors and typefaces; a font of "" is the system font. */
export type EditorThemeColors = { name: string; light: EditorThemeAppearance; dark: EditorThemeAppearance; textFont: string; codeFont: string };
export type EditorTheme = EditorThemeColors & { id: string; builtIn?: true };
export type EditorThemePreferences = Record<EditorThemeScope, string> & { version: 2; themes: EditorTheme[] };
export type ResolvedEditorTheme = { light: EditorThemeAppearance; dark: EditorThemeAppearance; textFont: string; codeFont: string };
export type ResolvedEditorThemes = Record<EditorThemeScope, ResolvedEditorTheme | null>;
/** The settings saved before editor themes held them: the heading accent and the fonts. */
export type LegacyHeadingAccent = { headingColor?: unknown; headingPalette?: unknown; textFont?: unknown; codeFont?: unknown };
export const EDITOR_THEME_SCOPES: readonly EditorThemeScope[];
export const EDITOR_THEME_COLOR_KEYS: readonly EditorThemeColorKey[];
export const DEFAULT_EDITOR_THEME_ID: "default";
export const MAX_EDITOR_THEMES: number;
export const MAX_EDITOR_THEME_NAME_LENGTH: number;
export const MAX_EDITOR_THEME_FONT_LENGTH: number;
export const APP_PAGE: Readonly<Record<"light" | "dark", Readonly<{ background: string; text: string }>>>;
export const BUILT_IN_EDITOR_THEMES: readonly Readonly<EditorTheme>[];
export function normalizeEditorThemes(value: unknown, legacy?: LegacyHeadingAccent): EditorThemePreferences;
export function resolveEditorThemes(value: unknown, legacy?: LegacyHeadingAccent): ResolvedEditorThemes;
export function createEditorThemesFile(themes: unknown, exportedAt?: string): { format: string; version: number; exportedAt: string; themes: EditorThemeColors[] };
export function parseEditorThemesFile(value: unknown): EditorThemeColors[];
