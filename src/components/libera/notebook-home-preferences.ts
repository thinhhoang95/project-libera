export type NotebookFileSort = "updated" | "name";
export type NotebookFileView = "list" | "grid";

export const DEFAULT_NOTEBOOK_FILE_SORT: NotebookFileSort = "updated";
export const DEFAULT_NOTEBOOK_FILE_VIEW: NotebookFileView = "list";

const SORT_COOKIE_NAME = "libera-notebook-file-sort";
const VIEW_COOKIE_NAME = "libera-notebook-file-view";
const CHANGE_EVENT = "libera-notebook-home-preferences-change";
const COOKIE_OPTIONS = "Path=/; Max-Age=31536000; SameSite=Lax";

function readCookie(name: string) {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function readNotebookFileSort(): NotebookFileSort {
  const value = readCookie(SORT_COOKIE_NAME);
  return value === "name" || value === "updated"
    ? value
    : DEFAULT_NOTEBOOK_FILE_SORT;
}

export function readNotebookFileView(): NotebookFileView {
  const value = readCookie(VIEW_COOKIE_NAME);
  return value === "grid" || value === "list"
    ? value
    : DEFAULT_NOTEBOOK_FILE_VIEW;
}

function saveCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; ${COOKIE_OPTIONS}`;
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return readCookie(name) === value;
}

export function saveNotebookFileSort(value: NotebookFileSort) {
  return saveCookie(SORT_COOKIE_NAME, value);
}

export function saveNotebookFileView(value: NotebookFileView) {
  return saveCookie(VIEW_COOKIE_NAME, value);
}

export function subscribeNotebookHomePreferences(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("focus", onChange);
  };
}
