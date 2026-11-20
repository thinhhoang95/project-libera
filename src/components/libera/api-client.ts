import type { ApiError, LiberaLinkRewrites, LiberaMoveStep, LiberaTree } from "@/lib/types";
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
    // The status lets a caller tell "not found" from other failures; a move that happened anyway says what it did (committedMove).
    const committed = payload as unknown as Partial<CommittedMove>;
    throw Object.assign(new Error(payload.error ?? "Request failed."), {
      status: response.status,
      ...(committed.moved && Array.isArray(committed.unfinished) ? { committed: { moved: committed.moved, unfinished: committed.unfinished, ...(committed.links ? { links: committed.links } : {}) } } : {}),
    });
  }

  return payload as T;
}

/** A move the server made although the request failed after it (MoveCommittedError, storage/files.ts): where the file went and what did not follow. */
export type CommittedMove = { moved: { from: string; to: string }; unfinished: LiberaMoveStep[]; links?: LiberaLinkRewrites };

/** The committed move an apiRequest error carries, or null when nothing moved. */
export function committedMove(error: unknown): CommittedMove | null {
  return (error as { committed?: CommittedMove } | null)?.committed ?? null;
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
      showFileDetails: true,
    },
    starredFilePaths: [],
    fileTags: {},
    notebooks: [],
  };
}
