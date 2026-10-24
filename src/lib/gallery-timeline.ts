/** How the gallery splits photos into dated sections, filters them, and finds a date in them. */

export type GalleryGrouping = "auto" | "day" | "week" | "month" | "year";

export const GALLERY_GROUPINGS: GalleryGrouping[] = ["auto", "day", "week", "month", "year"];
export const GROUPING_LABEL: Record<GalleryGrouping, string> = { auto: "Auto", day: "Day", week: "Week", month: "Month", year: "Year" };

type Dated = { createdAt: string };
export type PhotoSection<T> = { key: string; label: string; photos: T[] };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Auto never splits photos taken closer together than this… */
const AUTO_MIN_GAP = 3 * HOUR;
/** …and always splits photos taken further apart. */
const AUTO_MAX_GAP = 7 * DAY;
/** A gap this many times longer than the usual gap around it starts a new section. */
const AUTO_GAP_FACTOR = 8;
const AUTO_WINDOW = 8;
/** With no nearby photos to compare with, a gap this long starts a new section. */
const AUTO_LONE_GAP = 36 * HOUR;

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Weeks start on Monday. */
function startOfWeek(date: Date) {
  const start = startOfDay(date);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function shortDate(date: Date, now: Date, withYear = date.getFullYear() !== now.getFullYear()) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

export function dayLabel(date: Date, now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return "Today";
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function weekLabel(start: Date, now: Date) {
  if (dayKey(start) === dayKey(startOfWeek(now))) return "This week";
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${shortDate(start, now, start.getFullYear() !== end.getFullYear() || start.getFullYear() !== now.getFullYear())} – ${shortDate(end, now)}`;
}

function monthLabel(date: Date, now: Date) {
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "This month";
  return date.toLocaleDateString(undefined, { month: "long", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** The days a run of photos covers, earliest first whatever the sort order. */
function spanLabel(first: Date, last: Date, now: Date) {
  const [start, end] = first <= last ? [first, last] : [last, first];
  if (dayKey(start) === dayKey(end)) return dayLabel(start, now);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    const month = start.toLocaleDateString(undefined, { month: "short" });
    return `${month} ${start.getDate()} – ${end.getDate()}${start.getFullYear() === now.getFullYear() ? "" : `, ${start.getFullYear()}`}`;
  }
  return `${shortDate(start, now, start.getFullYear() !== end.getFullYear() || start.getFullYear() !== now.getFullYear())} – ${shortDate(end, now)}`;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Indexes where Auto starts a new section: where the time between two photos
 * jumps well above the usual gap around it (an outing, a trip, a busy
 * afternoon of generating), where it is simply long, or where a new month
 * starts after a pause.
 *
 * The usual gap is taken from the photos on either side up to the next
 * longer gap, so a burst of photos on another day does not make a sparse
 * trip look like several events.
 */
export function timeChangepoints(times: number[]) {
  const gaps = times.slice(1).map((time, index) => Math.abs(time - times[index]));
  const breaks: number[] = [];
  gaps.forEach((gap, index) => {
    if (gap <= AUTO_MIN_GAP) return;
    const before = new Date(times[index]);
    const after = new Date(times[index + 1]);
    if (gap > AUTO_MAX_GAP || before.getFullYear() !== after.getFullYear() || before.getMonth() !== after.getMonth()) { breaks.push(index + 1); return; }
    const around: number[] = [];
    for (let other = index - 1; other >= Math.max(0, index - AUTO_WINDOW) && gaps[other] <= gap; other -= 1) around.push(gaps[other]);
    for (let other = index + 1; other < Math.min(gaps.length, index + 1 + AUTO_WINDOW) && gaps[other] <= gap; other += 1) around.push(gaps[other]);
    if (around.length ? gap > AUTO_GAP_FACTOR * median(around) : gap > AUTO_LONE_GAP) breaks.push(index + 1);
  });
  return breaks;
}

/** Photos in the order shown, cut into sections; each section is one run of the list. */
export function groupPhotos<T extends Dated>(photos: T[], grouping: GalleryGrouping, now = new Date()): Array<PhotoSection<T>> {
  if (grouping === "auto") {
    const times = photos.map((photo) => Date.parse(photo.createdAt));
    const sections: Array<PhotoSection<T>> = [];
    const bounds = [0, ...timeChangepoints(times), photos.length];
    for (let index = 0; index + 1 < bounds.length; index += 1) {
      const slice = photos.slice(bounds[index], bounds[index + 1]);
      if (!slice.length) continue;
      const first = new Date(slice[0].createdAt);
      sections.push({ key: `auto-${first.getTime()}-${bounds[index]}`, label: spanLabel(first, new Date(slice.at(-1)!.createdAt), now), photos: slice });
    }
    // Several sections on one day are told apart by the time they start.
    const repeated = new Set(sections.filter((section, index) => sections[index - 1]?.label === section.label).map((section) => section.label));
    for (const section of sections) {
      if (!repeated.has(section.label)) continue;
      const times = section.photos.map((photo) => Date.parse(photo.createdAt));
      section.label += ` · ${new Date(Math.min(...times)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    }
    return sections;
  }
  const sections: Array<PhotoSection<T>> = [];
  for (const photo of photos) {
    const date = new Date(photo.createdAt);
    const key = grouping === "day" ? dayKey(date)
      : grouping === "week" ? dayKey(startOfWeek(date))
        : grouping === "month" ? `${date.getFullYear()}-${date.getMonth()}`
          : `${date.getFullYear()}`;
    const last = sections.at(-1);
    if (last?.key === key) { last.photos.push(photo); continue; }
    const label = grouping === "day" ? dayLabel(date, now)
      : grouping === "week" ? weekLabel(startOfWeek(date), now)
        : grouping === "month" ? monthLabel(date, now)
          : `${date.getFullYear()}`;
    sections.push({ key, label, photos: [photo] });
  }
  return sections;
}

/** The photo taken closest to `date` (a `yyyy-mm-dd` day, local time), for Jump to date. */
export function nearestPhoto<T extends Dated>(photos: T[], day: string): T | undefined {
  const target = parseDay(day);
  if (target === null) return undefined;
  const noon = target + 12 * HOUR;
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const photo of photos) {
    const distance = Math.abs(Date.parse(photo.createdAt) - noon);
    if (distance < bestDistance) { best = photo; bestDistance = distance; }
  }
  return best;
}

/** Local midnight of a `yyyy-mm-dd` day, or null. */
export function parseDay(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function toDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Who added a photo: "me" for this account's own photos, else the member's account id. */
export const ME = "me";
export const UNKNOWN_CONTRIBUTOR = "unknown";

export function photoContributor(photo: { shared?: { addedBy?: string } }, myAccountId: string | undefined) {
  if (!photo.shared) return ME;
  const addedBy = photo.shared.addedBy;
  if (!addedBy) return UNKNOWN_CONTRIBUTOR;
  return addedBy === myAccountId ? ME : addedBy;
}

export type GalleryFilter = {
  /** Contributors to show; empty shows everyone. */
  contributors: string[];
  /** Inclusive `yyyy-mm-dd` days; "" leaves that end open. */
  from: string;
  to: string;
};

export const NO_FILTER: GalleryFilter = { contributors: [], from: "", to: "" };

export function filterCount(filter: GalleryFilter) {
  return (filter.contributors.length ? 1 : 0) + (filter.from || filter.to ? 1 : 0);
}

export function filterPhotos<T extends Dated & { shared?: { addedBy?: string } }>(photos: T[], filter: GalleryFilter, myAccountId: string | undefined) {
  const from = filter.from ? parseDay(filter.from) : null;
  const toStart = filter.to ? parseDay(filter.to) : null;
  const to = toStart === null ? null : toStart + DAY;
  const contributors = filter.contributors.length ? new Set(filter.contributors) : null;
  if (from === null && to === null && !contributors) return photos;
  return photos.filter((photo) => {
    const time = Date.parse(photo.createdAt);
    if (from !== null && time < from) return false;
    if (to !== null && time >= to) return false;
    return !contributors || contributors.has(photoContributor(photo, myAccountId));
  });
}

/** For the seeker: the last of `tops` (ascending) at or above `offset`. */
export function indexAtOffset(tops: number[], offset: number) {
  let low = 0;
  let high = tops.length - 1;
  if (high < 0) return -1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tops[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
