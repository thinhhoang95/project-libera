// Control routes for live PDFs' comments. Next's /api/pdf-comments comes here
// when a PDF is live, so the panel and the agent need not know the difference.

import { readAllMarks } from "../../../src/lib/collab/pdf/model";
import { ControlRoutes } from "../../../src/lib/collab/local-api";
import type { DocHub } from "../core/doc-hub";
import { PdfCommentService, type LivePdfCommentChange } from "../notebooks/pdf-comments";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { objectBody } from "./validate";

const pattern = decodeURIComponent(ControlRoutes.pdfComments(":docId"));

/**
 * A hub acquired just now may not have the server's state yet: a copy taken
 * then would leave out every mark others made. Waits for the server's state,
 * briefly when this device already holds some (offline, that is the best
 * there is), and refuses when there is nothing to copy from.
 */
export async function whenPdfStateLoaded(hub: DocHub, timeouts = { known: 3_000, unknown: 10_000 }): Promise<void> {
  if (hub.hasOpened) return;
  const known = hub.hasState;
  await new Promise<void>((resolve) => {
    let off = () => {};
    const done = () => { clearTimeout(timer); off(); resolve(); };
    const timer = setTimeout(done, known ? timeouts.known : timeouts.unknown);
    off = hub.onStatus(() => { if (hub.hasOpened || hub.isClosed) done(); });
    if (hub.hasOpened || hub.isClosed) done();
  });
  if (!hub.hasOpened && !hub.hasState) throw new ControlError(503, "offline", "This PDF's annotations have not loaded yet. Try again once you are connected.");
}

export function registerPdfRoutes(router: Router, runtime: CollabRuntime): void {
  const service = () => {
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    return new PdfCommentService(runtime.host, () => account.id);
  };
  router.add("GET", decodeURIComponent(ControlRoutes.pdfSnapshot(":docId")), async (request) => {
    const hub = runtime.host.acquire(request.params.docId);
    try {
      await whenPdfStateLoaded(hub);
      return { body: { marks: readAllMarks(hub.getDoc("annotations")).filter((record) => !record.deleted).map((record) => ({ ...record.annotation, ...(record.sourceHash ? { sourceHash: record.sourceHash } : {}) })), comments: await service().list(request.params.docId) } };
    } finally { runtime.host.release(request.params.docId); }
  });
  router.add("GET", pattern, async (request) => ({ body: await service().list(request.params.docId) }));
  router.add("POST", pattern, async (request) => ({ body: await service().change(request.params.docId, objectBody(request.body) as unknown as LivePdfCommentChange) }));
}
