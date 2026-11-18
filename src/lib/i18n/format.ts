/**
 * Locale-aware formatting for code outside React components. Inside a component, prefer next-intl's `useFormatter()`
 * (it already knows the interface locale); pass `useLocale()` into helpers like these when they are shared with
 * non-React code. Never pin "en" here: text sent to AI models is the only place that stays English.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, locale: string, options: object, make: () => T): T {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (!value) cache.set(key, (value = make()));
  return value;
}

export function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(numberFormats, locale, options, () => new Intl.NumberFormat(locale, options));
}

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  return cached(dateFormats, locale, options, () => new Intl.DateTimeFormat(locale, options));
}
