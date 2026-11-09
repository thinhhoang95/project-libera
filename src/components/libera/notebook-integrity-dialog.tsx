"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, MinusCircle } from "lucide-react";
import type { IntegrityCheckResult, IntegrityFinding, IntegrityProgress, IntegrityReport, IntegritySeverity, IntegrityStreamLine } from "@/lib/storage/integrity";
import { SESSION_EXPIRED_EVENT, SESSION_EXPIRED_HEADER } from "@/lib/auth-session";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";
import { ModalDialog } from "./modal-dialog";

// Results of the notebook check (storage/integrity.ts). The check only reads;
// each finding says what would set it right.

const secondary = "rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const primary = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const PREVIEW = 20;
const ORDER: IntegritySeverity[] = ["error", "warning", "info"];

function findFile(tree: LiberaTree, libraryPath: string): LiberaFileNode | null {
  const visit = (nodes: LiberaTreeNode[]): LiberaFileNode | null => {
    for (const node of nodes) {
      if (node.kind === "file" && node.path === libraryPath) return node;
      if (node.kind === "folder" && libraryPath.startsWith(`${node.path}/`)) { const found = visit(node.children); if (found) return found; }
    }
    return null;
  };
  const notebook = tree.notebooks.find((item) => libraryPath.startsWith(`${item.name}/`));
  return notebook ? visit(notebook.children) : null;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Runs the check through the streamed route, reporting each check as it starts. */
async function streamCheck(notebook: string, signal: AbortSignal, onProgress: (progress: IntegrityProgress) => void): Promise<IntegrityReport> {
  const response = await fetch(`/api/notebooks/verify?stream=1&notebook=${encodeURIComponent(notebook)}`, { signal });
  if (response.status === 401 && response.headers.get(SESSION_EXPIRED_HEADER) === "1") window.dispatchEvent(new window.Event(SESSION_EXPIRED_EVENT));
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "The check could not run.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += value ?? "";
    const lines = buffered.split("\n");
    buffered = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as IntegrityStreamLine;
      if (message.type === "progress") onProgress(message);
      else if (message.type === "report") return message.report;
      else throw new Error(message.error);
    }
    if (done) throw new Error("The check stopped before it finished.");
  }
}

function SeverityIcon({ severity }: { severity: IntegritySeverity }) {
  if (severity === "error") return <AlertCircle aria-label="Error" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  if (severity === "warning") return <AlertTriangle aria-label="Warning" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  return <Info aria-label="Note" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

function StatusIcon({ status }: { status: IntegrityCheckResult["status"] }) {
  if (status === "ok") return <CheckCircle2 aria-label="No problems" className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "findings") return <AlertTriangle aria-label="Findings" className="h-4 w-4 shrink-0 text-amber-600" />;
  if (status === "incomplete") return <MinusCircle aria-label="Partly checked" className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <AlertCircle aria-label="Could not run" className="h-4 w-4 shrink-0 text-destructive" />;
}

export function NotebookIntegrityDialog({ notebook, tree, onOpenFile, onClose }: { notebook: string | null; tree: LiberaTree; onOpenFile: (file: LiberaFileNode) => void; onClose: () => void }) {
  if (!notebook) return null;
  return <IntegrityBody key={notebook} notebook={notebook} tree={tree} onOpenFile={onOpenFile} onClose={onClose} />;
}

function IntegrityBody({ notebook, tree, onOpenFile, onClose }: { notebook: string; tree: LiberaTree; onOpenFile: (file: LiberaFileNode) => void; onClose: () => void }) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<IntegrityProgress | null>(null);
  const [run, setRun] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const controller = useRef<AbortController | null>(null);
  const checking = !report && !error && !stopped;

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    streamCheck(notebook, abort.signal, setProgress)
      .then((value) => { if (!abort.signal.aborted) setReport(value); })
      .catch((failure: Error) => { if (!abort.signal.aborted) setError(failure.message); });
    // Closing the dialog stops the check on the server too.
    return () => abort.abort();
  }, [notebook, run]);

  const again = () => { setReport(null); setError(""); setStopped(false); setProgress(null); setRun((value) => value + 1); };
  const stop = () => { controller.current?.abort(); setStopped(true); };
  const bySeverity = (severity: IntegritySeverity) => report?.findings.filter((finding) => finding.severity === severity).length ?? 0;
  // A check that could not run, or only partly, means the report can't say the notebook is clear.
  const partial = report?.checks.filter((check) => check.status === "failed" || check.status === "incomplete") ?? [];
  const counted = report ? ORDER.filter(bySeverity).map((severity) => plural(bySeverity(severity), severity === "info" ? "note" : severity)).join(", ") : "";
  const summary = report && (partial.length
    ? `Partly checked: ${plural(partial.length, "check")} could not run completely.${counted ? ` Found so far: ${counted}.` : ""}`
    : counted || "No problems found.");

  return (
    <ModalDialog
      open
      title={`Check ${notebook}`}
      description="Checks links, images, side files, LaTeX projects and records against the disk. Nothing is changed."
      panelClassName="max-w-2xl"
      footer={<>
        {report && <span role="status" className="mr-auto text-xs text-muted-foreground">{plural(report.counts.files, "file")} · {plural(report.counts.notes, "note")} · {plural(report.counts.sidecars, "side file")} · {(report.durationMs / 1000).toFixed(1)} s</span>}
        {checking
          ? <button className={secondary} type="button" onClick={stop}>Stop</button>
          : <button className={secondary} type="button" onClick={again}>Check again</button>}
        <button className={primary} type="button" onClick={onClose}>Close</button>
      </>}
      onClose={onClose}
    >
      {checking && <div role="status" className="space-y-2 py-4 text-sm">
        <p className="flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{progress ? `${progress.label} (${progress.index + 1} of ${progress.total})…` : `Checking ${notebook}…`}</p>
        <progress className="h-1.5 w-full accent-primary" max={progress?.total ?? 1} value={progress ? progress.index : 0} aria-label="Checks done" />
      </div>}
      {stopped && <p role="status" className="py-4 text-sm text-muted-foreground">The check was stopped. Nothing was changed.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {report && <div className="max-h-[60vh] space-y-3 overflow-auto pr-1 text-sm">
        <p role="status" className={`font-medium ${partial.length ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-2" : ""}`}>{summary}</p>
        {report.checks.map((check) => {
          const findings = report.findings.filter((finding) => finding.check === check.id)
            .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.path.localeCompare(b.path));
          const showAll = expanded.has(check.id);
          return <section key={check.id} className="rounded-lg border border-border">
            <h3 className="flex items-center gap-2 px-3 py-2 font-medium">
              <StatusIcon status={check.status} />
              <span className="min-w-0 flex-1">{check.label}</span>
              {findings.length > 0 && <span className="text-xs text-muted-foreground">{findings.length}</span>}
            </h3>
            {check.note && <p className="px-3 pb-2 text-xs text-muted-foreground">{check.note}</p>}
            {findings.length > 0 && <ul className="divide-y divide-border border-t border-border">
              {(showAll ? findings : findings.slice(0, PREVIEW)).map((finding, index) => <FindingRow key={`${finding.path}-${index}`} finding={finding} file={findFile(tree, finding.path)} onOpenFile={onOpenFile} />)}
              {findings.length > PREVIEW && <li className="px-3 py-2"><button type="button" className="text-xs underline" onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (showAll) next.delete(check.id); else next.add(check.id);
                return next;
              })}>{showAll ? "Show fewer" : `Show all ${findings.length}`}</button></li>}
            </ul>}
          </section>;
        })}
      </div>}
    </ModalDialog>
  );
}

function FindingRow({ finding, file, onOpenFile }: { finding: IntegrityFinding; file: LiberaFileNode | null; onOpenFile: (file: LiberaFileNode) => void }) {
  return <li className="flex gap-2 px-3 py-2">
    <SeverityIcon severity={finding.severity} />
    <div className="min-w-0 flex-1">
      {file
        ? <button type="button" className="block max-w-full truncate text-left text-xs font-medium underline" title={finding.path} onClick={() => onOpenFile(file)}>{finding.path}</button>
        : <p className="truncate text-xs font-medium" title={finding.path}>{finding.path}</p>}
      <p>{finding.message}</p>
      {finding.fix && <p className="text-xs text-muted-foreground">{finding.fix}</p>}
    </div>
  </li>;
}
