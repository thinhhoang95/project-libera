/** Interface languages Libera ships. English is the source language and the fallback for missing messages. */
export const LOCALES = ["en", "fr", "vi", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Pseudo-locale for development: every English message accented and padded ~40%, in brackets. Text that still
 * shows plain English was never extracted, and the padding shows where longer languages would overflow.
 */
export const PSEUDO_LOCALE = "en-XA";
export type AppLocale = Locale | typeof PSEUDO_LOCALE;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function isAppLocale(value: unknown): value is AppLocale {
  return value === PSEUDO_LOCALE || isLocale(value);
}

/** Best supported locale for an Accept-Language header ("fr-CA,fr;q=0.9,en;q=0.8" -> "fr"). */
export function matchAcceptLanguage(header: string | null | undefined): Locale {
  const ranked = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { base: tag.toLowerCase().split("-")[0], q: q ? Number(q.slice(2)) || 0 : 1, index };
    })
    .filter((entry) => entry.base && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.map((entry) => entry.base).find(isLocale) ?? DEFAULT_LOCALE;
}
