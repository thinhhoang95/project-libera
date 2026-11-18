import { dateTimeFormat, numberFormat } from "@/lib/i18n/format";
import {
  MODEL_SLOTS, OTHER_MODELS,
  type BinUnit, type Breakdown, type Component, type PeriodRange, type UsageReport,
} from "@/lib/spending";

/** Components take the first five categorical slots in their stacking order. */
const COMPONENT_COLORS: Record<Component, string> = {
  input: "var(--sp-1)",
  output: "var(--sp-2)",
  cacheRead: "var(--sp-3)",
  cacheWrite: "var(--sp-4)",
  other: "var(--sp-5)",
};

/** A model's color comes from its place in the overall order, so it is the same in every period. */
export function modelColor(model: string, order: string[]) {
  const index = order.indexOf(model);
  return model === OTHER_MODELS || index < 0 || index >= MODEL_SLOTS ? "var(--sp-other)" : `var(--sp-${index + 1})`;
}

export function seriesColor(key: string, breakdown: Breakdown, order: string[]) {
  return breakdown === "component" ? COMPONENT_COLORS[key as Component] ?? "var(--sp-other)" : modelColor(key, order);
}

export function componentColor(component: Component) {
  return COMPONENT_COLORS[component];
}

/** The report narrowed to one model, or as it is. */
export function filterReport(report: UsageReport, model: string | null): UsageReport {
  return model ? { ...report, buckets: report.buckets.filter((bucket) => bucket.model === model) } : report;
}

const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const DAY_YEAR: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const MONTH: Intl.DateTimeFormatOptions = { month: "short" };
const MONTH_YEAR: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };
const HOUR: Intl.DateTimeFormatOptions = { hour: "numeric" };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" };

export function formatDay(time: number, locale: string) {
  return dateTimeFormat(locale, WEEKDAY).format(time);
}

export function formatShortDay(time: number, locale: string) {
  return dateTimeFormat(locale, DAY).format(time);
}

export function formatShortMonth(time: number, locale: string) {
  return dateTimeFormat(locale, MONTH).format(time);
}

/** "Sep 25 – Oct 24, 2026"; the end is the last day in the range that has begun. */
export function formatRange(range: PeriodRange, locale: string, now = Date.now()) {
  const last = Math.min(range.end, Math.max(range.start + 1, now + 1)) - 1;
  const sameDay = new Date(range.start).toDateString() === new Date(last).toDateString();
  if (sameDay) return dateTimeFormat(locale, DAY_YEAR).format(range.start);
  const sameYear = new Date(range.start).getFullYear() === new Date(last).getFullYear();
  // formatRange collapses the shared year and puts the dash where the locale wants it.
  return sameYear
    ? dateTimeFormat(locale, DAY_YEAR).formatRange(range.start, last)
    : `${dateTimeFormat(locale, DAY_YEAR).format(range.start)} – ${dateTimeFormat(locale, DAY_YEAR).format(last)}`;
}

/** Axis label for a bin start. */
export function binLabel(time: number, unit: BinUnit, multiYear: boolean, locale: string) {
  if (unit === "hour") return dateTimeFormat(locale, HOUR).format(time);
  if (unit === "month") {
    const date = new Date(time);
    return multiYear && date.getMonth() === 0 ? String(date.getFullYear()) : dateTimeFormat(locale, MONTH).format(time);
  }
  return dateTimeFormat(locale, DAY).format(time);
}

/** Tooltip title for a bin; `weekOf` words a week ("Week of Sep 22, 2026"). */
export function binTitle(start: number, end: number, unit: BinUnit, locale: string, weekOf: (date: string) => string) {
  if (unit === "hour") return `${dateTimeFormat(locale, DAY).format(start)}, ${dateTimeFormat(locale, HOUR).formatRange(start, end)}`;
  if (unit === "day") return formatDay(start, locale);
  if (unit === "week") return weekOf(dateTimeFormat(locale, DAY_YEAR).format(start));
  return dateTimeFormat(locale, MONTH_YEAR).format(start);
}

/** Short weekday names, Monday first, in the interface language. */
export function weekdayNames(locale: string) {
  const monday = Date.UTC(2024, 0, 1, 12); // a Monday
  return Array.from({ length: 7 }, (_, index) => dateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(monday + index * 86_400_000));
}

export function formatPercent(value: number, locale: string) {
  const digits = value && value < 0.1 ? 1 : 0;
  if (!value) return numberFormat(locale, { style: "percent" }).format(0);
  if (value < 0.001) return `<${numberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0.001)}`;
  return numberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Round axis maxima: 1, 2, 2.5, 5 × 10ⁿ, split into four steps. */
export function niceScale(max: number) {
  if (!(max > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power;
  return { max: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}
