const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "12h ago", "2d ago", "3mo ago", "2y ago" — or "" for an unreadable date. */
export function relativeTimeLabel(value: string | number, now = Date.now()): string {
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const age = Math.max(0, now - at);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 30 * DAY) return `${Math.floor(age / DAY)}d ago`;
  if (age < 365 * DAY) return `${Math.floor(age / (30 * DAY))}mo ago`;
  return `${Math.floor(age / (365 * DAY))}y ago`;
}

/** Full local date and time, for the tooltip behind a relative label. */
export function fullDateLabel(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
