// The takedown fence (projects.closing_at) and how long it holds.
//
// An owner whose app stops between raising the fence and deleting the project
// (a crash, a closed laptop) would otherwise leave every member's notebook
// paused for good. The fence therefore lapses after PROJECT_CLOSING_TTL_MS, and
// a takedown whose fence lapsed is refused at the final delete, so a write
// accepted after the lapse can never be missing from the owner's export.

/** Long enough for a large notebook's final export; short enough that a dead takedown frees its members. */
export const PROJECT_CLOSING_TTL_MS = 60 * 60_000;

/** Whether a fence raised at `closingAt` still holds. */
export function closingFenceActive(closingAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!closingAt) return false;
  const raised = closingAt instanceof Date ? closingAt.getTime() : Date.parse(closingAt);
  return Number.isFinite(raised) && now - raised < PROJECT_CLOSING_TTL_MS;
}
