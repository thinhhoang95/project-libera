"use client";

// The buttons in a live PDF's strip: versions and deleted marks, and reviews.

import { ClipboardCheck, History, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ShowMoreButton, usePagedList } from "@/components/libera/list-controls";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { historyApi } from "@/components/libera/collab/history/history-api";
import { revisionTitle } from "@/components/libera/collab/history/history-panel";
import { RequestReviewDialog } from "@/components/libera/collab/reviews/request-review";
import { ReviewsPanel } from "@/components/libera/collab/reviews/reviews-panel";
import type { SharedPdfState } from "@/lib/collab/pdf/react";
import type { Revision } from "@/lib/collab/protocol/api";
import { can, type Role } from "@/lib/collab/protocol/roles";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import { dateTimeFormat } from "@/lib/i18n/format";

type Shared = Extract<SharedPdfState, { kind: "shared" }>;

const BUTTON = "inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

function markKey(type: string) {
  return type === "text" ? "note" : type === "ink" ? "stroke" : type === "space" ? "space" : type === "shape" ? "shape" : "highlight";
}

/** Thrown when marks have not reached the server in time; the dialog words it. */
class MarksStillSyncing extends Error {}

/** How long naming a version waits for marks still on their way to the server. */
const SETTLE_MS = 5_000;

/**
 * Waits until this device's marks have reached the server. A version is taken
 * there, so without this it could miss what the person sees on screen.
 */
async function settled({ session }: Shared): Promise<void> {
  const { replica } = session;
  replica.flush();
  // "Nothing pending" counts only once the server has acknowledged something
  // since the last update this window sent; an older status may still be on
  // its way from before the hub received that update.
  const synced = () => replica.syncedSinceLastSend();
  if (synced()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new MarksStillSyncing("Some marks are still syncing. Try again once the status says they are saved to the workspace."));
    }, SETTLE_MS);
    const stop = replica.subscribe(() => {
      if (!synced()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

const DELETED_PAGE = 50;

function HistoryDialog({ shared, role, canAnnotate, onClose }: { shared: Shared; role: Role; canAnnotate: boolean; onClose: () => void }) {
  const { docId } = shared.session;
  const t = useTranslations("collab.pdfCollabTools");
  const tCommon = useTranslations("common");
  const tHistory = useTranslations("collab.history.historyPanel");
  const tDescribe = useDescribeError();
  const describeError = (cause: unknown) => (cause instanceof MarksStillSyncing ? t("stillSyncing") : tDescribe(cause));
  const locale = useLocale();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(() => shared.store.deleted());
  const [deletedShown, setDeletedShown] = useState(DELETED_PAGE);
  // Versions: the newest 20, then 40 more at a time.
  const versions = usePagedList(revisions ?? [], docId);
  useEffect(() => shared.store.subscribe(() => setDeleted(shared.store.deleted())), [shared.store]);
  useEffect(() => {
    let active = true;
    historyApi.revisions(docId).then((list) => { if (active) setRevisions(list); }, (cause: unknown) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <ModalDialog open title={t("historyTitle")} description={shared.resolved.path} onClose={onClose}>
      <div className="space-y-4 text-sm">
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold">{t("deletedMarks")}</h3>
          {deleted.length ? deleted.slice(0, deletedShown).map((record) => (
            <div key={record.annotation.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{t("deletedMark", { mark: t(`marks.${markKey(record.annotation.type)}`), page: record.annotation.pageNumber, hasText: record.annotation.type === "text" && record.annotation.text ? "yes" : "no", text: record.annotation.type === "text" ? record.annotation.text ?? "" : "" })}</span>
              <button type="button" className={BUTTON} disabled={!canAnnotate} onClick={() => shared.store.restore(record.annotation.id)}>
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                {t("restore")}
              </button>
            </div>
          )) : <p className="text-xs text-muted-foreground">{t("nothingDeleted")}</p>}
          {deleted.length > deletedShown ? (
            <button type="button" className={BUTTON} onClick={() => setDeletedShown((shown) => shown + DELETED_PAGE)}>
              {t("showOlder", { count: deleted.length - deletedShown })}
            </button>
          ) : null}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold">{t("versions")}</h3>
          {can(role, "name-revision") ? (
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (label.trim()) void run(async () => {
                await settled(shared);
                await historyApi.nameVersion(docId, label.trim());
                setLabel("");
              });
            }}>
              <input aria-label={t("versionName")} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm" maxLength={200} placeholder={t("nameThisVersion")} value={label} onChange={(event) => setLabel(event.target.value)} />
              <button type="submit" className={BUTTON} disabled={busy || !label.trim()}>{tCommon("save")}</button>
            </form>
          ) : null}
          {revisions === null ? <p className="text-xs text-muted-foreground">{tCommon("loading")}</p> : revisions.length ? versions.visible.map((revision) => (
            <div key={revision.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{revisionTitle(revision, tHistory)} · {dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt))}</span>
              {can(role, "restore") ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(() => historyApi.restore(docId, { revisionId: revision.id }))}>{t("restore")}</button> : null}
            </div>
          )) : <p className="text-xs text-muted-foreground">{t("noVersions")}</p>}
          <ShowMoreButton remaining={versions.remaining} onClick={versions.showMore} />
        </section>
      </div>
    </ModalDialog>
  );
}

/** Versions, deleted marks and reviews of a live PDF. */
export function PdfCollabTools({ shared, canAnnotate }: { shared: Shared; canAnnotate: boolean }) {
  const t = useTranslations("collab.pdfCollabTools");
  const [open, setOpen] = useState<"history" | "reviews" | "request" | null>(null);
  const { role } = shared.resolved;
  return (
    <>
      <button type="button" className={BUTTON} onClick={() => setOpen("history")}>
        <History aria-hidden className="h-3.5 w-3.5" />
        {t("history")}
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen("reviews")}>
        <ClipboardCheck aria-hidden className="h-3.5 w-3.5" />
        {t("reviews")}
      </button>
      {open === "history" ? <HistoryDialog canAnnotate={canAnnotate} role={role} shared={shared} onClose={() => setOpen(null)} /> : null}
      {open === "reviews" ? (
        <ModalDialog open title={t("reviews")} description={shared.resolved.path} onClose={() => setOpen(null)}>
          <div className="space-y-2">
            {can(role, "request-review") ? <button type="button" className={BUTTON} onClick={() => setOpen("request")}>{t("requestReview")}</button> : null}
            <ReviewsPanel session={shared.session} />
          </div>
        </ModalDialog>
      ) : null}
      {open === "request" ? <RequestReviewDialog documentOnly session={shared.session} selection={null} onClose={() => setOpen("reviews")} /> : null}
    </>
  );
}
