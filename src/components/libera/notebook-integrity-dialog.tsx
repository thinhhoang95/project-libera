"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Info, Loader2, MinusCircle } from "lucide-react";
import type { IntegrityCheckId, IntegrityCheckResult, IntegrityFinding, IntegrityProgress, IntegrityReport, IntegritySeverity, IntegrityStreamLine } from "@/lib/storage/integrity";
import type { RepairPlan, RepairResult, RepairUnmatched } from "@/lib/storage/repair";
import type { CleanupPlan, CleanupResult } from "@/lib/storage/cleanup";
import { REVIEWS_MOVED_EVENT } from "@/lib/markdown-review";
import { SESSION_EXPIRED_EVENT, SESSION_EXPIRED_HEADER } from "@/lib/auth-session";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";
import { apiRequest } from "./api-client";
import { ModalDialog } from "./modal-dialog";

// Results of the notebook check (storage/integrity.ts). The check only reads;
// each finding says what would set it right. Try to fix (storage/repair.ts)
// finds files moved outside the app by name and, once confirmed, moves their
// records to them. Acknowledge (storage/cleanup.ts) then removes what the
// check still reports as stale, once its cost is confirmed.

const secondary = "rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const danger = "rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60";
const primary = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const PREVIEW = 20;
const ORDER: IntegritySeverity[] = ["error", "warning", "info"];
/** Checks whose findings can come from a file moved outside the app. */
const MOVABLE = new Set<IntegrityCheckId>(["sidecars", "assets", "records", "references"]);

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

/** `onRepaired` refreshes the tree, whose upkeep brings indexes up to date and moves side files to files it finds again; the check waits for it. */
type DialogProps = { tree: LiberaTree; onOpenFile: (file: LiberaFileNode) => void; onClose: () => void; onRepaired?: (notebook: string) => Promise<unknown> | void };

export function NotebookIntegrityDialog({ notebook, ...props }: DialogProps & { notebook: string | null }) {
  if (!notebook) return null;
  return <IntegrityBody key={notebook} notebook={notebook} {...props} />;
}

function IntegrityBody({ notebook, tree, onOpenFile, onClose, onRepaired }: DialogProps & { notebook: string }) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<IntegrityProgress | null>(null);
  const [run, setRun] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const controller = useRef<AbortController | null>(null);
  const checking = !report && !error && !stopped;
  const [plan, setPlan] = useState<RepairPlan | null>(null);
  const [fixing, setFixing] = useState<"planning" | "applying" | null>(null);
  const [fixError, setFixError] = useState("");
  const [fixed, setFixed] = useState<RepairResult | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [cleaned, setCleaned] = useState<CleanupResult | null>(null);

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
  const checkAgain = () => { setFixed(null); setCleaned(null); setFixError(""); again(); };
  const canFix = !!report && report.findings.some((finding) => MOVABLE.has(finding.check));
  const canClear = !!report && report.findings.some((finding) => finding.clear?.length);
  const settle = async () => { try { await onRepaired?.(notebook); } catch { /* The check says what is left. */ } };
  const prepareFix = async () => {
    setFixing("planning"); setFixError(""); setFixed(null); setCleaned(null);
    try { setPlan(await apiRequest<RepairPlan>(`/api/notebooks/repair?notebook=${encodeURIComponent(notebook)}`)); }
    catch (failure) { setFixError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setFixing(null); }
  };
  const applyFix = async () => {
    if (!plan) return;
    setFixing("applying"); setFixError("");
    try {
      const result = await apiRequest<RepairResult>("/api/notebooks/repair", { method: "POST", body: JSON.stringify({ notebook, token: plan.token }) });
      setFixed(result); setPlan(null);
      window.dispatchEvent(new CustomEvent(REVIEWS_MOVED_EVENT, { detail: { paths: result.moved.map((move) => move.to) } }));
      await settle();
      again();
    } catch (failure) { setFixError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setFixing(null); }
  };
  const prepareCleanup = async () => {
    setFixing("planning"); setFixError(""); setFixed(null); setCleaned(null); setUnderstood(false);
    try { setCleanup(await apiRequest<CleanupPlan>(`/api/notebooks/cleanup?notebook=${encodeURIComponent(notebook)}`)); }
    catch (failure) { setFixError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setFixing(null); }
  };
  const applyCleanup = async () => {
    if (!cleanup) return;
    setFixing("applying"); setFixError("");
    try {
      const result = await apiRequest<CleanupResult>("/api/notebooks/cleanup", { method: "POST", body: JSON.stringify({ notebook, token: cleanup.token }) });
      setCleaned(result); setCleanup(null);
      await settle();
      again();
    } catch (failure) { setFixError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setFixing(null); }
  };
  const lost = cleanup?.items.filter((item) => item.lost).length ?? 0;
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
      description={plan
        ? "Files moved or renamed into another folder outside the app, found again by name. Nothing is changed until you confirm."
        : cleanup
          ? "What the check still reports as stale, and what removing each costs. Nothing is changed until you confirm."
          : "Checks links, images, side files, LaTeX projects and records against the disk. Nothing is changed."}
      panelClassName="max-w-2xl"
      footer={<>
        {report && <span role="status" className="mr-auto text-xs text-muted-foreground">{plural(report.counts.files, "file")} · {plural(report.counts.notes, "note")} · {plural(report.counts.sidecars, "side file")} · {(report.durationMs / 1000).toFixed(1)} s</span>}
        {cleanup ? <>
          <button className={secondary} type="button" disabled={fixing !== null} onClick={() => { setCleanup(null); setFixError(""); }}>Back</button>
          <button className={danger} type="button" disabled={fixing !== null || !cleanup.items.length || (lost > 0 && !understood)} onClick={() => void applyCleanup()}>
            {fixing === "applying" ? "Removing…" : cleanup.items.length ? `Remove ${plural(cleanup.items.length, "stale item")}` : "Nothing to remove"}
          </button>
        </> : plan ? <>
          <button className={secondary} type="button" disabled={fixing !== null} onClick={() => { setPlan(null); setFixError(""); }}>Back</button>
          <button className={primary} type="button" disabled={fixing !== null || !plan.moves.length} onClick={() => void applyFix()}>
            {fixing === "applying" ? "Fixing…" : plan.moves.length ? `Fix ${plural(plan.moves.length, "file")}` : "Nothing to fix"}
          </button>
        </> : <>
          {canFix && <button className={secondary} type="button" disabled={fixing !== null || checking} onClick={() => void prepareFix()}>{fixing === "planning" ? "Working…" : "Try to fix…"}</button>}
          {canClear && <button className={secondary} type="button" disabled={fixing !== null || checking} onClick={() => void prepareCleanup()}>Acknowledge…</button>}
          {checking
            ? <button className={secondary} type="button" onClick={stop}>Stop</button>
            : <button className={secondary} type="button" onClick={checkAgain}>Check again</button>}
          <button className={primary} type="button" onClick={onClose}>Close</button>
        </>}
      </>}
      onClose={onClose}
    >
      {fixError && <p role="alert" className="mb-2 text-sm text-destructive [overflow-wrap:anywhere]">{fixError}</p>}
      {fixed && !plan && !cleanup && <FixedSummary result={fixed} />}
      {cleaned && !cleanup && <CleanedSummary result={cleaned} />}
      {plan && <RepairPlanView plan={plan} />}
      {cleanup && <CleanupPlanView plan={cleanup} lost={lost} understood={understood} onUnderstood={setUnderstood} />}
      {!cleanup && !plan && checking && <div role="status" className="space-y-2 py-4 text-sm">
        <p className="flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{progress ? `${progress.label} (${progress.index + 1} of ${progress.total})…` : `Checking ${notebook}…`}</p>
        <progress className="h-1.5 w-full accent-primary" max={progress?.total ?? 1} value={progress ? progress.index : 0} aria-label="Checks done" />
      </div>}
      {!cleanup && !plan && stopped && <p role="status" className="py-4 text-sm text-muted-foreground">The check was stopped. Nothing was changed.</p>}
      {!cleanup && !plan && error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
      {!cleanup && !plan && report && <div className="max-h-[60vh] space-y-3 overflow-auto pr-1 text-sm [overflow-wrap:anywhere]">
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

function FixedSummary({ result }: { result: RepairResult }) {
  return <div role="status" className="mb-3 rounded-lg border border-border p-2 text-sm [overflow-wrap:anywhere]">
    <p className="font-medium">{result.moved.length ? `The records of ${plural(result.moved.length, "file")} now follow ${result.moved.length === 1 ? "it" : "them"}.` : "No records were moved."}</p>
    {result.problems.map((problem) => <p key={problem} className="text-xs text-destructive">{problem}</p>)}
  </div>;
}

function CleanedSummary({ result }: { result: CleanupResult }) {
  return <div role="status" className="mb-3 rounded-lg border border-border p-2 text-sm [overflow-wrap:anywhere]">
    <p className="font-medium">{result.cleared ? `${plural(result.cleared, "stale item")} removed.` : "Nothing was removed."}</p>
    {result.problems.map((problem) => <p key={problem} className="text-xs text-destructive">{problem}</p>)}
  </div>;
}

function CleanupPlanView({ plan, lost, understood, onUnderstood }: { plan: CleanupPlan; lost: number; understood: boolean; onUnderstood: (value: boolean) => void }) {
  const items = [...plan.items].sort((a, b) => Number(b.lost) - Number(a.lost) || a.path.localeCompare(b.path));
  return <div className="max-h-[60vh] space-y-3 overflow-auto pr-1 text-sm [overflow-wrap:anywhere]">
    {lost > 0 && <div role="note" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2">
      <p className="flex gap-2">
        <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <span>{plural(lost, "item")} below {lost === 1 ? "holds" : "hold"} things that are deleted for good: annotations, ink, comments, transcripts, code or images. This can&apos;t be undone in Libera; your sync service&apos;s version history may still have them.</span>
      </p>
      <label className="flex items-center gap-2 pl-6 font-medium">
        <input type="checkbox" checked={understood} onChange={(event) => onUnderstood(event.target.checked)} />
        I understand these are deleted for good
      </label>
    </div>}
    {items.length > 0
      ? <section className="rounded-lg border border-border">
        <h3 className="px-3 py-2 font-medium">Removed ({items.length})</h3>
        <ul className="divide-y divide-border border-t border-border">
          {items.map((item, index) => <li key={`${item.path}-${index}`} className="px-3 py-2">
            <p className="truncate text-xs font-medium" title={item.path}>{item.path}</p>
            <p className="text-xs text-muted-foreground">{item.message}</p>
            <p className={`text-xs ${item.lost ? "font-medium text-destructive" : ""}`}>{item.consequence}</p>
          </li>)}
        </ul>
      </section>
      : <p role="status" className="font-medium">Nothing stale is left to remove.</p>}
    {plan.remaining > 0 && <p className="text-xs text-muted-foreground">{plural(plan.remaining, "other finding")} {plan.remaining === 1 ? "is" : "are"} not removed: broken links, missing images or LaTeX files and damaged files need you to set them right. Side files that follow a file found again and indexes catch up when the notebook is refreshed, right after this.</p>}
  </div>;
}

function unmatchedReason(item: RepairUnmatched) {
  if (item.reason === "none") return "No file of this name is in the notebook.";
  if (item.reason === "shared-name") return "Other missing files have the same name, so which is which can't be told.";
  if (item.reason === "own") return `${item.candidates.join(", ")} already ${item.candidates.length === 1 ? "has" : "have"} records of ${item.candidates.length === 1 ? "its" : "their"} own, so ${item.candidates.length === 1 ? "it is" : "they are"} probably another file.`;
  return `Several files have this name: ${item.candidates.join(", ")}.`;
}

function RepairPlanView({ plan }: { plan: RepairPlan }) {
  return <div className="max-h-[60vh] space-y-3 overflow-auto pr-1 text-sm [overflow-wrap:anywhere]">
    <p role="note" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <span>Files are matched by name only. If a file below is a different file that happens to have the same name, it gets these records. Links in notes are not changed.</span>
    </p>
    {plan.moves.length > 0
      ? <section className="rounded-lg border border-border">
        <h3 className="px-3 py-2 font-medium">Moved files found ({plan.moves.length})</h3>
        <ul className="divide-y divide-border border-t border-border">
          {plan.moves.map((move) => <li key={move.from} className="px-3 py-2">
            <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
              <span className="truncate text-muted-foreground line-through" title={move.from}>{move.from}</span>
              <ArrowRight aria-label="now at" className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={move.to}>{move.to}</span>
            </p>
            <p className="text-xs text-muted-foreground">Follows: {move.records.join(", ")}</p>
          </li>)}
        </ul>
      </section>
      : <p role="status" className="font-medium">No moved file could be found by name.</p>}
    {plan.unmatched.length > 0 && <section className="rounded-lg border border-border">
      <h3 className="px-3 py-2 font-medium">Left as they are ({plan.unmatched.length})</h3>
      <ul className="divide-y divide-border border-t border-border">
        {plan.unmatched.map((item) => <li key={item.from} className="px-3 py-2">
          <p className="truncate text-xs font-medium" title={item.from}>{item.from}</p>
          <p className="text-xs text-muted-foreground">{item.records.join(", ")} · {unmatchedReason(item)}</p>
        </li>)}
      </ul>
    </section>}
  </div>;
}
