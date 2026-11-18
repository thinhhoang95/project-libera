import { dateTimeFormat, numberFormat } from "@/lib/i18n/format";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Unit = "minute" | "hour" | "day" | "month" | "year";

/** The age as a whole number of the largest fitting unit, or `null` below a minute ("just now"). */
function ageParts(age: number): { count: number; unit: Unit } | null {
  if (age < MINUTE) return null;
  if (age < HOUR) return { count: Math.floor(age / MINUTE), unit: "minute" };
  if (age < DAY) return { count: Math.floor(age / HOUR), unit: "hour" };
  if (age < 30 * DAY) return { count: Math.floor(age / DAY), unit: "day" };
  if (age < 365 * DAY) return { count: Math.floor(age / (30 * DAY)), unit: "month" };
  return { count: Math.floor(age / (365 * DAY)), unit: "year" };
}

function parse(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

/**
 * "now", "5m ago", "12h ago", … in English; "il y a 5 min", … in French — or "" for an unreadable date.
 * English keeps its compact narrow style; other languages use the short style, because some narrow forms are
 * not readable on their own (French narrow is "-5 min").
 */
export function relativeTimeLabel(value: string | number, now = Date.now(), locale = "en"): string {
  const at = parse(value);
  if (!Number.isFinite(at)) return "";
  const parts = ageParts(Math.max(0, now - at));
  const style = locale === "en" || locale.startsWith("en-") ? "narrow" : "short";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
  return parts ? rtf.format(-parts.count, parts.unit) : rtf.format(0, "second");
}

/** Compact age without "ago", for dense lists: "now", "5m", "12h", "2d" (the units come from `Intl`, in `locale`). */
export function relativeTimeShort(value: string | number, now = Date.now(), locale = "en"): string {
  const at = parse(value);
  if (!Number.isFinite(at)) return "";
  const parts = ageParts(Math.max(0, now - at));
  if (!parts) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  // The narrow month ("3m") is indistinguishable from the narrow minute, so months use the short form.
  return numberFormat(locale, {
    style: "unit", unit: parts.unit, unitDisplay: parts.unit === "month" ? "short" : "narrow",
  }).format(parts.count);
}

/** Full local date and time, for the tooltip behind a relative label. */
export function fullDateLabel(value: string | number, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return locale ? dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date) : date.toLocaleString();
}
