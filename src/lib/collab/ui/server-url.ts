// The collaboration server URL the sign-in form starts with: the one the
// user last signed in to on this device, else the build's default.

const STORAGE_KEY = "libera.collab.serverUrl";

/** Inlined at build time; set NEXT_PUBLIC_LIBERA_COLLAB_SERVER_URL to point builds elsewhere. */
export const DEFAULT_COLLAB_SERVER_URL =
  process.env.NEXT_PUBLIC_LIBERA_COLLAB_SERVER_URL || "https://collab.libera.intuelle.com";

export function lastServerUrl(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_COLLAB_SERVER_URL;
  } catch {
    return DEFAULT_COLLAB_SERVER_URL;
  }
}

export function rememberServerUrl(url: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // Private mode or storage disabled: the default is used next time.
  }
}

/** Trims, adds https:// when no scheme was typed, and drops a trailing slash. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
