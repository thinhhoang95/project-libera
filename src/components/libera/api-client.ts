import type { ApiError, LiberaTree } from "@/lib/types";

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
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
    },
    starredFilePaths: [],
    notebooks: [],
  };
}
