// Control routes for live PDFs' comments. Next's /api/pdf-comments comes here
// when a PDF is live, so the panel and the agent need not know the difference.

import { ControlRoutes } from "../../../src/lib/collab/local-api";
import { PdfCommentService, type LivePdfCommentChange } from "../notebooks/pdf-comments";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { objectBody } from "./validate";

const pattern = decodeURIComponent(ControlRoutes.pdfComments(":docId"));

export function registerPdfRoutes(router: Router, runtime: CollabRuntime): void {
  const service = () => {
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    return new PdfCommentService(runtime.host, () => account.id);
  };
  router.add("GET", pattern, async (request) => ({ body: await service().list(request.params.docId) }));
  router.add("POST", pattern, async (request) => ({ body: await service().change(request.params.docId, objectBody(request.body) as unknown as LivePdfCommentChange) }));
}
