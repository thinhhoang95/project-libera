import assert from "node:assert/strict";
import test from "node:test";
import { filterPhotos, groupPhotos, indexAtOffset, ME, nearestPhoto, NO_FILTER, photoContributor, timeChangepoints, UNKNOWN_CONTRIBUTOR } from "../../src/lib/gallery-timeline";

const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();
const photo = (createdAt: string, addedBy?: string | null) => ({ createdAt, ...(addedBy === undefined ? {} : { shared: { addedBy: addedBy ?? undefined } }) });
const now = new Date(2026, 9, 24, 15);

test("auto grouping starts a section where the time between photos jumps", () => {
  // A morning burst, an afternoon burst, then a trip two weeks later.
  const photos = [
    at(2026, 9, 1, 9, 0), at(2026, 9, 1, 9, 5), at(2026, 9, 1, 9, 12), at(2026, 9, 1, 9, 20),
    at(2026, 9, 1, 16, 0), at(2026, 9, 1, 16, 3), at(2026, 9, 1, 16, 9),
    at(2026, 9, 15, 10), at(2026, 9, 15, 18), at(2026, 9, 16, 9), at(2026, 9, 17, 11),
  ].map((time) => photo(time));
  const sections = groupPhotos(photos, "auto", now);
  assert.deepEqual(sections.map((section) => section.photos.length), [4, 3, 4]);
  assert.equal(sections[2].label.includes("15"), true);
  // The two bursts of Sep 1 carry their start times.
  assert.notEqual(sections[0].label, sections[1].label);
  assert.ok(sections[0].label.includes("·") && sections[1].label.includes("·"));
  assert.equal(sections[2].label.includes("17"), true);
  // Newest first gives the same sections, reversed.
  assert.deepEqual(groupPhotos([...photos].reverse(), "auto", now).map((section) => section.photos.length), [4, 3, 4]);
});

test("auto never splits close photos and always splits a gap of over a week", () => {
  const minutes = Array.from({ length: 6 }, (_, index) => Date.UTC(2026, 0, 1, 10, index * 30));
  assert.deepEqual(timeChangepoints(minutes), []);
  const weekly = Array.from({ length: 5 }, (_, index) => Date.UTC(2026, 0, 1 + index * 9));
  assert.deepEqual(timeChangepoints(weekly), [1, 2, 3, 4]);
  // A photo a day keeps going as one section, until the month changes.
  const daily = Array.from({ length: 6 }, (_, index) => new Date(2026, 8, 28 + index, 12).getTime());
  assert.deepEqual(timeChangepoints(daily), [3]);
});

test("calendar groupings follow days, Monday weeks, months and years", () => {
  const photos = [at(2026, 10, 24), at(2026, 10, 19, 8), at(2026, 10, 18), at(2026, 9, 30), at(2025, 12, 31)].map((time) => photo(time));
  assert.deepEqual(groupPhotos(photos, "day", now).map((section) => section.photos.length), [1, 1, 1, 1, 1]);
  assert.equal(groupPhotos(photos, "day", now)[0].label, "Today");
  const weeks = groupPhotos(photos, "week", now);
  assert.deepEqual(weeks.map((section) => section.photos.length), [2, 1, 1, 1]);
  assert.equal(weeks[0].label, "This week");
  const months = groupPhotos(photos, "month", now);
  assert.deepEqual(months.map((section) => section.photos.length), [3, 1, 1]);
  assert.equal(months[0].label, "This month");
  assert.deepEqual(groupPhotos(photos, "year", now).map((section) => section.label), ["2026", "2025"]);
});

test("the filter keeps chosen contributors within the days given", () => {
  const photos = [
    photo(at(2026, 3, 1)), photo(at(2026, 3, 10), "me-account"), photo(at(2026, 3, 10, 23, 59), "alex"),
    photo(at(2026, 3, 11, 0, 1), "sam"), photo(at(2026, 3, 12), null),
  ];
  assert.equal(filterPhotos(photos, NO_FILTER, "me-account"), photos);
  assert.deepEqual(filterPhotos(photos, { contributors: [ME], from: "", to: "" }, "me-account"), photos.slice(0, 2));
  assert.deepEqual(filterPhotos(photos, { contributors: [ME, "alex"], from: "2026-03-05", to: "2026-03-10" }, "me-account"), photos.slice(1, 3));
  assert.deepEqual(filterPhotos(photos, { contributors: [], from: "2026-03-11", to: "" }, "me-account"), photos.slice(3));
  assert.equal(photoContributor(photos[4], "me-account"), UNKNOWN_CONTRIBUTOR);
});

test("jump to date finds the nearest photo, and the seeker finds the row at an offset", () => {
  const photos = [at(2026, 5, 20), at(2026, 3, 2), at(2025, 1, 1)].map((time) => photo(time));
  assert.equal(nearestPhoto(photos, "2026-04-30"), photos[0]);
  assert.equal(nearestPhoto(photos, "2025-08-01"), photos[2]);
  assert.equal(nearestPhoto(photos, "not a day"), undefined);
  assert.equal(indexAtOffset([0, 100, 200], 150), 1);
  assert.equal(indexAtOffset([0, 100, 200], 0), 0);
  assert.equal(indexAtOffset([0, 100, 200], 999), 2);
  assert.equal(indexAtOffset([], 10), -1);
});
