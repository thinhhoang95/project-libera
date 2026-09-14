export type SidebarSortKey = "name" | "createdAt" | "updatedAt" | "interactedAt";
export type SidebarSortDirection = "asc" | "desc";

export type SidebarSortPreference = {
  key: SidebarSortKey;
  direction: SidebarSortDirection;
};

export const DEFAULT_SIDEBAR_SORT_TOKEN = "updatedAt:desc";

const COOKIE_NAME = "libera-sidebar-sort";
const CHANGE_EVENT = "libera-sidebar-sort-change";
const VALID_TOKENS = new Set([
  "name:asc",
  "name:desc",
  "createdAt:asc",
  "createdAt:desc",
  "updatedAt:asc",
  "updatedAt:desc",
  "interactedAt:asc",
  "interactedAt:desc",
]);

export function readSidebarSortToken() {
  const value = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  return value && VALID_TOKENS.has(value) ? value : DEFAULT_SIDEBAR_SORT_TOKEN;
}

export function parseSidebarSortToken(token: string): SidebarSortPreference {
  const validToken = VALID_TOKENS.has(token) ? token : DEFAULT_SIDEBAR_SORT_TOKEN;
  const [key, direction] = validToken.split(":") as [SidebarSortKey, SidebarSortDirection];
  return { key, direction };
}

export function saveSidebarSortPreference(preference: SidebarSortPreference) {
  const token = `${preference.key}:${preference.direction}`;
  if (!VALID_TOKENS.has(token)) return false;
  document.cookie = `${COOKIE_NAME}=${token}; Path=/; Max-Age=31536000; SameSite=Lax`;
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return readSidebarSortToken() === token;
}

export function subscribeSidebarSortPreference(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("focus", onChange);
  };
}
