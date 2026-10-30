import type { ApiError, LiberaTree } from "@/lib/types";
import { SESSION_EXPIRED_EVENT, SESSION_EXPIRED_HEADER } from "@/lib/auth-session";

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(url.startsWith("/api/gallery") ? { "X-Libera-Gallery": "catalog" } : {}),
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  // Only the local auth guard sets this marker. A wrong login password or an
  // upstream service's 401 must not sign the user out of Libera.
  if (response.status === 401 && response.headers.get(SESSION_EXPIRED_HEADER) === "1" && typeof window !== "undefined") {
    window.dispatchEvent(new window.Event(SESSION_EXPIRED_EVENT));
  }
  const payload = (await response.json().catch(() => ({}))) as Partial<ApiError>;

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed.");
  }

  return payload as T;
}

export function encodeFilePath(filePath: string) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

export function emptyTree(): LiberaTree {
  return {
    root: "",
    notebookPanelExpandedPaths: null,
    notebookGroups: [],
    notebookViewOptions: {
      hiddenGroupIds: [],
      hiddenNotebookNames: [],
      showArchive: false,
    },
    starredFilePaths: [],
    fileTags: {},
    notebooks: [],
  };
}
