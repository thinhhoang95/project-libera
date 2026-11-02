import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import {
  checkTether,
  getTetherStatus,
  previewTether,
  recreateTetheredFile,
  requestTetherSync,
  tetherBibFile,
  untetherBibFile,
} from "@/lib/references/bib-tether";
import { LibraryOpError } from "@/lib/references/library-ops";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";

// A notebook's References tethered to a .bib file (references/bib-tether.ts).
// GET ?notebook= → { tether: TetherStatus | null }.
// POST { notebook, action, … } → { tether } (or { preview }):
//   preview  { path }                         what tethering would do
//   tether   { path, prefer, create? }        tether and run the first sync
//   untether                                  stop; the file and library stay
//   sync                                      sync now
//   check                                     cheap check for missed changes (window focus)
//   resolve  { choice: "apply" | "restore" }  held deletions from the file
//   recreate                                  write the library to a file that is gone
// `path` is absolute (from the file dialog) or library-relative.

export const runtime = "nodejs";

const ACTIONS = ["preview", "tether", "untether", "sync", "check", "resolve", "recreate"] as const;
type Action = typeof ACTIONS[number];

function handleError(error: unknown) {
  if (error instanceof LibraryOpError) return jsonError(error.message, 400);
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] The .bib tether request failed.", error);
  return jsonError(storageError.status === 500 ? "The .bib file could not be synced." : storageError.message, storageError.status);
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const notebook = assertSafeSegment(request.nextUrl.searchParams.get("notebook") ?? "", "Notebook name");
    return NextResponse.json({ tether: await getTetherStatus(notebook) });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook: notebookValue, action, path, prefer, create, choice, token } = body as Record<string, unknown>;
    if (typeof notebookValue !== "string") return jsonError("Notebook name is required.");
    const notebook = assertSafeSegment(notebookValue, "Notebook name");
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return jsonError(`action must be one of ${ACTIONS.join(", ")}.`);
    switch (action as Action) {
      case "preview":
        if (typeof path !== "string") return jsonError("Choose a .bib file.");
        return NextResponse.json({ preview: await previewTether(notebook, path) });
      case "tether":
        if (typeof path !== "string") return jsonError("Choose a .bib file.");
        if (prefer !== "library" && prefer !== "file") return jsonError("prefer must be library or file.");
        return NextResponse.json({ tether: await tetherBibFile(notebook, path, { prefer, create: create === true }) });
      case "untether":
        await untetherBibFile(notebook);
        return NextResponse.json({ tether: null });
      case "sync":
        return NextResponse.json({ tether: await requestTetherSync(notebook) });
      case "check":
        return NextResponse.json({ tether: await checkTether(notebook) });
      case "resolve":
        if (choice !== "apply" && choice !== "restore") return jsonError("choice must be apply or restore.");
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return jsonError("Review the pending removals before resolving them.");
        return NextResponse.json({ tether: await requestTetherSync(notebook, { deletions: choice, deletionToken: token }) });
      case "recreate":
        return NextResponse.json({ tether: await recreateTetheredFile(notebook) });
    }
  } catch (error) {
    return handleError(error);
  }
}
