export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "libera.theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light";
}

export function themePreferenceOrUndefined(value: unknown): ThemePreference | undefined {
  return isThemePreference(value) ? value : undefined;
}
