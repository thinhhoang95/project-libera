"use client";

// The buttons in a live PDF's strip: versions and deleted marks, and reviews.

import { ClipboardCheck, History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { historyApi } from "@/components/libera/collab/history/history-api";
import { RequestReviewDialog } from "@/components/libera/collab/reviews/request-review";
import { ReviewsPanel } from "@/components/libera/collab/reviews/reviews-panel";
import type { SharedPdfState } from "@/lib/collab/pdf/react";
import type { Revision } from "@/lib/collab/protocol/api";
import { can, type Role } from "@/lib/collab/protocol/roles";
import { describeError } from "@/lib/collab/ui/client";

type Shared = Extract<SharedPdfState, { kind: "shared" }>;

const BUTTON = "inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

function markLabel(type: string) {
  return type === "text" ? "Note" : type === "ink" ? "Stroke" : type === "space" ? "Space" : type === "shape" ? "Shape" : "Highlight";
}

function HistoryDialog({ shared, role, canAnnotate, onClose }: { shared: Shared; role: Role; canAnnotate: boolean; onClose: () => void }) {
  const { docId } = shared.session;
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(() => shared.store.deleted());
  useEffect(() => shared.store.subscribe(() => setDeleted(shared.store.deleted())), [shared.store]);
  useEffect(() => {
    let active = true;
    historyApi.revisions(docId).then((list) => { if (active) setRevisions(list); }, (cause: unknown) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [docId]);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setRevisions(await historyApi.revisions(docId));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog open title="Annotation history" description={shared.resolved.path} onClose={onClose}>
      <div className="space-y-4 text-sm">
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold">Deleted marks</h3>
          {deleted.length ? deleted.slice(0, 50).map((record) => (
            <div key={record.annotation.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{markLabel(record.annotation.type)}, page {record.annotation.pageNumber}{record.annotation.type === "text" && record.annotation.text ? `: ${record.annotation.text}` : ""}</span>
              <button type="button" className={BUTTON} disabled={!canAnnotate} onClick={() => shared.store.restore(record.annotation.id)}>
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                Restore
              </button>
            </div>
          )) : <p className="text-xs text-muted-foreground">Nothing has been deleted.</p>}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold">Versions</h3>
          {can(role, "name-revision") ? (
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (label.trim()) void run(async () => { await historyApi.nameVersion(docId, label.trim()); setLabel(""); });
            }}>
              <input aria-label="Version name" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm" maxLength={200} placeholder="Name this version" value={label} onChange={(event) => setLabel(event.target.value)} />
              <button type="submit" className={BUTTON} disabled={busy || !label.trim()}>Save</button>
            </form>
          ) : null}
          {revisions === null ? <p className="text-xs text-muted-foreground">Loading…</p> : revisions.length ? revisions.map((revision) => (
            <div key={revision.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{revision.label ?? revision.kind} · {new Date(revision.createdAt).toLocaleString()}</span>
              {can(role, "restore") ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(() => historyApi.restore(docId, { revisionId: revision.id }))}>Restore</button> : null}
            </div>
          )) : <p className="text-xs text-muted-foreground">No versions yet.</p>}
        </section>
      </div>
    </ModalDialog>
  );
}

/** Versions, deleted marks and reviews of a live PDF. */
export function PdfCollabTools({ shared, canAnnotate }: { shared: Shared; canAnnotate: boolean }) {
  const [open, setOpen] = useState<"history" | "reviews" | "request" | null>(null);
  const { role } = shared.resolved;
  return (
    <>
      <button type="button" className={BUTTON} onClick={() => setOpen("history")}>
        <History aria-hidden className="h-3.5 w-3.5" />
        History
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen("reviews")}>
        <ClipboardCheck aria-hidden className="h-3.5 w-3.5" />
        Reviews
      </button>
      {open === "history" ? <HistoryDialog canAnnotate={canAnnotate} role={role} shared={shared} onClose={() => setOpen(null)} /> : null}
      {open === "reviews" ? (
        <ModalDialog open title="Reviews" description={shared.resolved.path} onClose={() => setOpen(null)}>
          <div className="space-y-2">
            {can(role, "request-review") ? <button type="button" className={BUTTON} onClick={() => setOpen("request")}>Request review…</button> : null}
            <ReviewsPanel session={shared.session} />
          </div>
        </ModalDialog>
      ) : null}
      {open === "request" ? <RequestReviewDialog documentOnly session={shared.session} selection={null} onClose={() => setOpen("reviews")} /> : null}
    </>
  );
}
