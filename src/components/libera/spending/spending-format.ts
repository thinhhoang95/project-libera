import {
  MODEL_SLOTS, OTHER_MODELS, PERIODS,
  type BinUnit, type Breakdown, type Component, type PeriodRange, type SpendingPeriod, type UsageReport,
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

export function periodLabel(period: SpendingPeriod) {
  return PERIODS.find((item) => item.key === period)?.label ?? period;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });
const monthYearFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export function formatDay(time: number) {
  return weekdayFormat.format(time);
}

export function formatShortDay(time: number) {
  return dayFormat.format(time);
}

/** "Sep 25 – Oct 24, 2026"; the end is the last day in the range that has begun. */
export function formatRange(range: PeriodRange, now = Date.now()) {
  const last = Math.min(range.end, Math.max(range.start + 1, now + 1)) - 1;
  const sameDay = new Date(range.start).toDateString() === new Date(last).toDateString();
  if (sameDay) return dayYearFormat.format(range.start);
  const sameYear = new Date(range.start).getFullYear() === new Date(last).getFullYear();
  return `${sameYear ? dayFormat.format(range.start) : dayYearFormat.format(range.start)} – ${dayYearFormat.format(last)}`;
}

/** Axis label for a bin start. */
export function binLabel(time: number, unit: BinUnit, multiYear: boolean) {
  if (unit === "hour") return hourFormat.format(time);
  if (unit === "month") {
    const date = new Date(time);
    return multiYear && date.getMonth() === 0 ? String(date.getFullYear()) : monthFormat.format(time);
  }
  return dayFormat.format(time);
}

/** Tooltip title for a bin. */
export function binTitle(start: number, end: number, unit: BinUnit) {
  if (unit === "hour") return `${dayFormat.format(start)}, ${hourFormat.format(start)}–${hourFormat.format(end)}`;
  if (unit === "day") return formatDay(start);
  if (unit === "week") return `Week of ${dayYearFormat.format(start)}`;
  return monthYearFormat.format(start);
}

export function formatPercent(value: number) {
  if (!value) return "0%";
  if (value < 0.001) return "<0.1%";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/** Round axis maxima: 1, 2, 2.5, 5 × 10ⁿ, split into four steps. */
export function niceScale(max: number) {
  if (!(max > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power;
  return { max: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}
