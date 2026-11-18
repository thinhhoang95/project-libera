"use client";

import { AlertCircle, FilePlus2, FolderOpen, Link2, Link2Off, Loader2, RefreshCw } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { previewBibTether, tetherStateText, type BibTetherRequest } from "@/components/libera/references/use-bib-tether";
import type { TetherPreview, TetherStatus } from "@/lib/references/bib-tether-types";

// Tether a notebook's References to a .bib file, and see or change the
// tether afterwards (lib/references/bib-tether.ts). Choosing a file shows
// what the first sync would do before anything is written.

const cancelButton = "inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50";
const primaryButton = "inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
const destructiveButton = "inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

type Props = {
  open: boolean;
  notebook: string;
  status: TetherStatus | null;
  run: (request: BibTetherRequest) => Promise<TetherStatus | null>;
  onClose: () => void;
  /** Reports a finished action in the panel's notice line. */
  onDone: (message: string) => void;
};

export function BibTetherDialog(props: Props) {
  if (!props.open) return null;
  return props.status ? <TetheredView {...props} status={props.status} /> : <ChooseView {...props} />;
}

function ChooseView({ notebook, status, run, onClose, onDone }: Props) {
  const t = useTranslations("references.bibTetherDialog");
  const tc = useTranslations("common");
  const electron = typeof window !== "undefined" && Boolean(window.liberaReferences);
  const [path, setPath] = useState("");
  const [create, setCreate] = useState(false);
  const [preview, setPreview] = useState<TetherPreview | null>(null);
  const [prefer, setPrefer] = useState<"library" | "file">("library");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewVersion = useRef(0);

  async function look(chosen: string, creating: boolean) {
    const version = ++previewVersion.current;
    setPath(chosen);
    setCreate(creating);
    setPreview(null);
    setError("");
    if (!chosen.trim()) return;
    setBusy(true);
    try {
      const result = await previewBibTether(notebook, chosen, t("chooseFailed"));
      if (version === previewVersion.current) setPreview(result);
    } catch (lookError) {
      if (version === previewVersion.current) setError(lookError instanceof Error && lookError.message ? lookError.message : t("chooseFailed"));
    } finally {
      if (version === previewVersion.current) setBusy(false);
    }
  }

  async function choose(mode: "open" | "create") {
    const chosen = await window.liberaReferences?.chooseBibFile(mode);
    if (chosen) await look(chosen, mode === "create");
  }

  async function tether() {
    setBusy(true);
    setError("");
    try {
      const result = await run({ action: "tether", path, prefer, create: create || !preview?.exists });
      onDone(result?.state === "synced" ? t("tetheredSynced", { name: result.fileName }) : t("tetheredNeedsAttention", { name: preview?.fileName ?? t("theFile") }));
      if (result?.state === "synced") onClose();
    } catch (tetherError) {
      setError(tetherError instanceof Error && tetherError.message ? tetherError.message : t("tetherFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open
      title={status ? t("changeTitle") : t("newTitle")}
      description={t("description", { notebook })}
      onClose={onClose}
      panelClassName="max-w-xl"
      footer={
        <>
          <button type="button" className={cancelButton} onClick={onClose}>{tc("cancel")}</button>
          <button type="button" className={primaryButton} disabled={busy || !preview} onClick={() => void tether()}>
            {busy && preview ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Link2 aria-hidden className="h-4 w-4" />} {t("tether")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {electron ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cancelButton} disabled={busy} onClick={() => void choose("open")}><FolderOpen aria-hidden className="h-4 w-4" /> {t("chooseFile")}</button>
            <button type="button" className={cancelButton} disabled={busy} onClick={() => void choose("create")}><FilePlus2 aria-hidden className="h-4 w-4" /> {t("newFile")}</button>
          </div>
        ) : null}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void look(path, create); }}>
          <input
            className="libera-panel-field h-8 min-w-0 flex-1 px-2 font-mono text-[12px]"
            aria-label={t("pathAria")}
            placeholder={electron ? t("pathPlaceholderElectron") : t("pathPlaceholderWeb", { notebook })}
            value={path}
            onChange={(event) => { previewVersion.current += 1; setPath(event.target.value); setPreview(null); setBusy(false); setError(""); }}
          />
          <button type="submit" className={cancelButton} disabled={busy || !path.trim()}>{t("check")}</button>
        </form>

        {busy && !preview ? <p className="flex items-center gap-2 text-muted-foreground" role="status"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {t("readingFile")}</p> : null}
        {error ? <p role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</p> : null}

        {preview ? (
          <div className="space-y-2 rounded-lg border border-border p-3" aria-label={t("summaryAria")}>
            <p className="break-all font-mono text-[12px]">{preview.displayPath}</p>
            <p className="text-muted-foreground">
              {preview.exists ? t("fileSummary", { count: preview.fileEntries, dialect: preview.dialect === "biblatex" ? "BibLaTeX" : "BibTeX" }) : t("newFileSummary")}
              {" "}{t("libraryCount", { count: preview.libraryEntries })}
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{t("onlyInFile", { count: preview.toLibrary })}</li>
              <li>{t("onlyInLibera", { count: preview.toFile })}</li>
              {preview.differing ? <li>{t("differing", { count: preview.differing })}</li> : null}
            </ul>
            {preview.differing ? (
              <fieldset className="space-y-1">
                <legend className="text-[12px] font-medium">{t("keepLegend")}</legend>
                <label className="flex items-center gap-2"><input type="radio" name="tether-prefer" checked={prefer === "library"} onChange={() => setPrefer("library")} /> {t("keepLibera")}</label>
                <label className="flex items-center gap-2"><input type="radio" name="tether-prefer" checked={prefer === "file"} onChange={() => setPrefer("file")} /> {t("keepFile")}</label>
              </fieldset>
            ) : null}
            {preview.warnings.map((warning) => <p key={warning} className="flex gap-1.5 text-[12px] text-amber-700 dark:text-amber-400"><AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}</p>)}
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t("rewriteNote")}
            </p>
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function TetheredView({ notebook, status, run, onClose, onDone }: Props & { status: TetherStatus }) {
  const t = useTranslations("references.bibTetherDialog");
  const tTether = useTranslations("references.useBibTether");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const stateText = (value: TetherStatus) => tetherStateText(value, Date.now(), tTether, locale);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const absolute = !status.insideLibrary;

  async function act(label: string, request: BibTetherRequest, done: (result: TetherStatus | null) => string) {
    setBusy(label);
    setError("");
    try {
      const result = await run(request);
      onDone(done(result));
      if (request.action === "untether") onClose();
    } catch (actionError) {
      setError(actionError instanceof Error && actionError.message ? actionError.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (choosing) return <ChooseView notebook={notebook} status={status} run={run} onClose={() => setChoosing(false)} onDone={(message) => { onDone(message); onClose(); }} open />;

  const change = status.lastChange;
  const warn = status.state !== "synced";
  return (
    <ModalDialog
      open
      title={t("tetheredTitle", { name: status.fileName })}
      description={t("tetheredDescription")}
      onClose={onClose}
      panelClassName="max-w-xl"
      footer={
        <>
          <button type="button" className={destructiveButton} disabled={Boolean(busy)} title={t("untetherHint")} onClick={() => void act("untether", { action: "untether" }, () => t("untetheredDone", { name: status.fileName }))}>
            <Link2Off aria-hidden className="h-4 w-4" /> {t("untether")}
          </button>
          <span className="flex-1" />
          <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => setChoosing(true)}>{t("changeFile")}</button>
          <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("sync", { action: "sync" }, (result) => result?.state === "synced" ? t("inSync", { name: status.fileName }) : stateText(result ?? status))}>
            {busy === "sync" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden className="h-4 w-4" />} {t("syncNow")}
          </button>
          <button type="button" className={primaryButton} onClick={onClose}>{tc("done")}</button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <p className="break-all font-mono text-[12px]">{status.displayPath}</p>
          <p className="text-muted-foreground">
            {(() => {
              const values = { count: status.entries, dialect: status.dialect === "biblatex" ? "BibLaTeX" : "BibTeX", state: stateText(status) };
              const reveal = absolute && window.liberaReferences ? () => void window.liberaReferences?.revealBibFile(status.displayPath)
                : !absolute && window.liberaFileExplorer ? () => void window.liberaFileExplorer?.revealItem(status.displayPath) : null;
              return reveal
                ? t.rich("entryLineWithLink", { ...values, link: (chunks) => <button type="button" className="font-medium text-accent hover:underline" onClick={reveal}>{chunks}</button> })
                : t("entryLine", values);
            })()}
          </p>
          {!status.watching ? <p className="text-[12px] text-muted-foreground">{t("unwatchable")}</p> : null}
        </div>

        {error ? <p role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</p> : null}

        {warn && status.message ? (
          <div role="alert" className="space-y-2 rounded-lg bg-destructive-muted p-3 text-[13px] text-destructive">
            <p className="flex gap-2"><AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {status.message}</p>
            {status.state === "paused" && status.pendingDeletion ? (
              <>
                <p className="break-words font-mono text-[11px]">{status.pendingDeletion.keys.join(", ")}{status.pendingDeletion.count > status.pendingDeletion.keys.length ? ", …" : ""}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={destructiveButton} disabled={Boolean(busy)} onClick={() => void act("apply", { action: "resolve", choice: "apply", token: status.pendingDeletion!.token }, () => t("removedDone", { count: status.pendingDeletion!.count }))}>{t("removeFromLibera")}</button>
                  <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("restore", { action: "resolve", choice: "restore", token: status.pendingDeletion!.token }, () => t("putBackDone", { count: status.pendingDeletion!.count, name: status.fileName }))}>{t("putThemBack")}</button>
                </div>
              </>
            ) : null}
            {status.state === "missing" ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("recreate", { action: "recreate" }, () => t("recreatedDone", { name: status.fileName }))}>{t("recreate")}</button>
                <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => setChoosing(true)}>{t("chooseAgain")}</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {status.warnings.length ? (
          <ul className="space-y-1 text-[12px] text-amber-700 dark:text-amber-400" aria-label={t("warningsAria")}>
            {status.warnings.map((warning) => <li key={warning} className="flex gap-1.5"><AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}</li>)}
          </ul>
        ) : null}

        {change ? (
          <div className="space-y-1 rounded-lg border border-border p-3 text-[12px]" aria-label={t("lastChangeAria")}>
            <p className="font-medium">{t("lastChange", { date: format.dateTime(new Date(change.at), { dateStyle: "medium", timeStyle: "short" }) })}</p>
            <p className="text-muted-foreground">
              {t("intoLibera", { added: change.toLibrary.added, updated: change.toLibrary.updated, removed: change.toLibrary.deleted })}
              {" "}{t("intoFile", { added: change.toFile.added, updated: change.toFile.updated, removed: change.toFile.deleted })}
            </p>
            {change.kept.length ? <p className="text-muted-foreground">{t.rich("keptBoth", { keys: change.kept.join(", "), mono: (chunks) => <span className="font-mono">{chunks}</span> })}</p> : null}
            {change.conflicts.length ? (
              <div>
                <p>{t("conflictsIntro")}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {change.conflicts.map((conflict) => <li key={`${conflict.key}:${conflict.field}`}>{t.rich("conflictLine", { key: conflict.key, field: conflict.field, kept: conflict.kept, mono: (chunks) => <span className="font-mono">{chunks}</span> })}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}
