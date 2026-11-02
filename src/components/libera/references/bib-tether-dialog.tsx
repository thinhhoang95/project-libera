"use client";

import { AlertCircle, FilePlus2, FolderOpen, Link2, Link2Off, Loader2, RefreshCw } from "lucide-react";
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

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

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
      const result = await previewBibTether(notebook, chosen);
      if (version === previewVersion.current) setPreview(result);
    } catch (lookError) {
      if (version === previewVersion.current) setError(lookError instanceof Error ? lookError.message : "That file cannot be tethered.");
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
      onDone(result?.state === "synced" ? `Tethered to ${result.fileName}. Changes on either side are now copied to the other.` : `Tethered to ${preview?.fileName ?? "the file"}, but the first sync needs attention.`);
      if (result?.state === "synced") onClose();
    } catch (tetherError) {
      setError(tetherError instanceof Error ? tetherError.message : "The file could not be tethered.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open
      title={status ? "Tether to another .bib file" : "Tether to a .bib file"}
      description={`Keep the references of ${notebook} and a .bib file in step: adding, editing or removing an entry on either side is copied to the other as it happens.`}
      onClose={onClose}
      panelClassName="max-w-xl"
      footer={
        <>
          <button type="button" className={cancelButton} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryButton} disabled={busy || !preview} onClick={() => void tether()}>
            {busy && preview ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Link2 aria-hidden className="h-4 w-4" />} Tether
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {electron ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cancelButton} disabled={busy} onClick={() => void choose("open")}><FolderOpen aria-hidden className="h-4 w-4" /> Choose a .bib file…</button>
            <button type="button" className={cancelButton} disabled={busy} onClick={() => void choose("create")}><FilePlus2 aria-hidden className="h-4 w-4" /> New .bib file…</button>
          </div>
        ) : null}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void look(path, create); }}>
          <input
            className="libera-panel-field h-8 min-w-0 flex-1 px-2 font-mono text-[12px]"
            aria-label="Path of the .bib file"
            placeholder={electron ? "or type a path: /Users/me/thesis/refs.bib" : `${notebook}/references.bib, or a full path`}
            value={path}
            onChange={(event) => { previewVersion.current += 1; setPath(event.target.value); setPreview(null); setBusy(false); setError(""); }}
          />
          <button type="submit" className={cancelButton} disabled={busy || !path.trim()}>Check</button>
        </form>

        {busy && !preview ? <p className="flex items-center gap-2 text-muted-foreground" role="status"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Reading the file…</p> : null}
        {error ? <p role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</p> : null}

        {preview ? (
          <div className="space-y-2 rounded-lg border border-border p-3" aria-label="What tethering does">
            <p className="break-all font-mono text-[12px]">{preview.displayPath}</p>
            <p className="text-muted-foreground">
              {preview.exists ? `${plural(preview.fileEntries, "entry", "entries")} (${preview.dialect === "biblatex" ? "BibLaTeX" : "BibTeX"}).` : "A new file; it is created when you tether."}
              {" "}The library has {plural(preview.libraryEntries, "reference")}.
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{plural(preview.toLibrary, "entry", "entries")} only in the file {preview.toLibrary === 1 ? "comes" : "come"} into Libera.</li>
              <li>{plural(preview.toFile, "reference")} only in Libera {preview.toFile === 1 ? "is" : "are"} written to the file.</li>
              {preview.differing ? <li>{plural(preview.differing, "entry", "entries")} in both {preview.differing === 1 ? "has" : "have"} different values.</li> : null}
            </ul>
            {preview.differing ? (
              <fieldset className="space-y-1">
                <legend className="text-[12px] font-medium">Where the values differ, keep</legend>
                <label className="flex items-center gap-2"><input type="radio" name="tether-prefer" checked={prefer === "library"} onChange={() => setPrefer("library")} /> Libera&apos;s version</label>
                <label className="flex items-center gap-2"><input type="radio" name="tether-prefer" checked={prefer === "file"} onChange={() => setPrefer("file")} /> The file&apos;s version</label>
              </fieldset>
            ) : null}
            {preview.warnings.map((warning) => <p key={warning} className="flex gap-1.5 text-[12px] text-amber-700 dark:text-amber-400"><AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}</p>)}
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Libera rewrites only the entries that change and leaves the rest of the file as it is written, comments and custom fields included.
              Nothing is removed from a side without a matching removal on the other.
            </p>
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function TetheredView({ notebook, status, run, onClose, onDone }: Props & { status: TetherStatus }) {
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
      setError(actionError instanceof Error ? actionError.message : "That did not work.");
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
      title={`Tethered to ${status.fileName}`}
      description="Changes on either side are copied to the other as they happen."
      onClose={onClose}
      panelClassName="max-w-xl"
      footer={
        <>
          <button type="button" className={destructiveButton} disabled={Boolean(busy)} title="Stop syncing. The file and the library stay as they are." onClick={() => void act("untether", { action: "untether" }, () => `${status.fileName} is no longer tethered. It and the library stay as they are.`)}>
            <Link2Off aria-hidden className="h-4 w-4" /> Untether
          </button>
          <span className="flex-1" />
          <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => setChoosing(true)}>Change file…</button>
          <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("sync", { action: "sync" }, (result) => result?.state === "synced" ? `${status.fileName} is in sync.` : tetherStateText(result ?? status))}>
            {busy === "sync" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden className="h-4 w-4" />} Sync now
          </button>
          <button type="button" className={primaryButton} onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <p className="break-all font-mono text-[12px]">{status.displayPath}</p>
          <p className="text-muted-foreground">
            {plural(status.entries, "entry", "entries")} · {status.dialect === "biblatex" ? "BibLaTeX" : "BibTeX"} · {tetherStateText(status)}
            {absolute && window.liberaReferences ? <> · <button type="button" className="font-medium text-accent hover:underline" onClick={() => void window.liberaReferences?.revealBibFile(status.displayPath)}>Show in folder</button></> : null}
            {!absolute && window.liberaFileExplorer ? <> · <button type="button" className="font-medium text-accent hover:underline" onClick={() => void window.liberaFileExplorer?.revealItem(status.displayPath)}>Show in folder</button></> : null}
          </p>
          {!status.watching ? <p className="text-[12px] text-muted-foreground">This file&apos;s folder cannot be watched, so changes made elsewhere are picked up when you come back to Libera, or with Sync now.</p> : null}
        </div>

        {error ? <p role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</p> : null}

        {warn && status.message ? (
          <div role="alert" className="space-y-2 rounded-lg bg-destructive-muted p-3 text-[13px] text-destructive">
            <p className="flex gap-2"><AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {status.message}</p>
            {status.state === "paused" && status.pendingDeletion ? (
              <>
                <p className="break-words font-mono text-[11px]">{status.pendingDeletion.keys.join(", ")}{status.pendingDeletion.count > status.pendingDeletion.keys.length ? ", …" : ""}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={destructiveButton} disabled={Boolean(busy)} onClick={() => void act("apply", { action: "resolve", choice: "apply", token: status.pendingDeletion!.token }, () => `Removed ${plural(status.pendingDeletion!.count, "reference")} from Libera.`)}>Remove from Libera</button>
                  <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("restore", { action: "resolve", choice: "restore", token: status.pendingDeletion!.token }, () => `Put ${plural(status.pendingDeletion!.count, "reference")} back in ${status.fileName}.`)}>Put them back in the file</button>
                </div>
              </>
            ) : null}
            {status.state === "missing" ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => void act("recreate", { action: "recreate" }, () => `${status.fileName} was written again from the library.`)}>Recreate it from the library</button>
                <button type="button" className={cancelButton} disabled={Boolean(busy)} onClick={() => setChoosing(true)}>Choose the file again…</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {status.warnings.length ? (
          <ul className="space-y-1 text-[12px] text-amber-700 dark:text-amber-400" aria-label="Warnings">
            {status.warnings.map((warning) => <li key={warning} className="flex gap-1.5"><AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}</li>)}
          </ul>
        ) : null}

        {change ? (
          <div className="space-y-1 rounded-lg border border-border p-3 text-[12px]" aria-label="Last change">
            <p className="font-medium">Last change, {new Date(change.at).toLocaleString()}</p>
            <p className="text-muted-foreground">
              Into Libera: {change.toLibrary.added} added, {change.toLibrary.updated} updated, {change.toLibrary.deleted} removed.
              {" "}Into the file: {change.toFile.added} added, {change.toFile.updated} updated, {change.toFile.deleted} removed.
            </p>
            {change.kept.length ? <p className="text-muted-foreground">Edited on one side and removed on the other, so kept: <span className="font-mono">{change.kept.join(", ")}</span></p> : null}
            {change.conflicts.length ? (
              <div>
                <p>Changed on both sides; the edit with the later timestamp was kept. Available competing field values are offered on the entry&apos;s card:</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {change.conflicts.map((conflict) => <li key={`${conflict.key}:${conflict.field}`}><span className="font-mono">{conflict.key}</span> {conflict.field}: {conflict.kept === "file" ? "the file's" : "Libera's"} version</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}
