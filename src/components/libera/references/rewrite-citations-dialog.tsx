"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { fileBaseName } from "@/components/libera/references/reference-display";
import type { OpenReferenceDraft } from "@/components/libera/references/use-reference-citations";

// Update citations after a key change (docs/references/plan.md §1.4, "Key
// change"): after renaming a key, or merging entries (whose keys become
// aliases of the kept one), the old keys keep working, and this dialog offers
// to rewrite the citations that still use them, through
// POST /api/references/rewrite. It previews every file with its open draft
// in place of the saved text, applies against the previewed hashes, puts the
// same change into open tabs, reports what was skipped, and can undo.

export type CitationRewriteRequest = {
  id: number;
  /** Old key → new key. */
  map: Record<string, string>;
  /** Why: a renamed key, or entries merged into `keep`. */
  reason: { kind: "rename" } | { kind: "merge"; keep: string };
};

export type RewritePreviewFile = { path: string; count: number; excerpts: { line: number; before: string; after: string }[] };
export type RewritePreviewResponse = { files: RewritePreviewFile[]; expected: Record<string, string> };
export type RewriteSkip = { path: string; reason: string };
export type RewriteApplyResponse = { rewriteId: string | null; changed: string[]; skipped: RewriteSkip[]; draftEdits: Record<string, string> };
export type RewriteUndoResponse = { restored: string[]; skipped: RewriteSkip[] };

/** What a rewrite did to an open tab's draft, for undo. */
export type TabRewriteChange = { before: string; after: string };
export type ApplyCitationRewriteToTab = (path: string, map: Record<string, string>, options: { savedRewritten: boolean }) => TabRewriteChange | null;
export type RevertCitationRewriteInTab = (path: string, change: TabRewriteChange, options: { refreshSaved: boolean }) => Promise<void> | void;

async function postRewrite<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const response = await fetch("/api/references/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === "string" && result.error ? result.error : fallback);
  return result;
}

/** The open drafts of a notebook's files, as the rewrite API takes them. */
export function notebookDrafts(notebook: string, drafts: OpenReferenceDraft[]) {
  const result: Record<string, string> = {};
  for (const draft of drafts) if (draft.path.startsWith(`${notebook}/`)) result[draft.path] = draft.text;
  return result;
}

export function previewRewrite(notebook: string, map: Record<string, string>, drafts: Record<string, string>) {
  return postRewrite<RewritePreviewResponse>({ notebook, map, dryRun: true, drafts }, "Could not find the citations to update.");
}

export function applyRewrite(notebook: string, map: Record<string, string>, expected: Record<string, string>, drafts: Record<string, string>) {
  return postRewrite<RewriteApplyResponse>({ notebook, map, dryRun: false, expected, drafts }, "Could not update the citations.");
}

export function undoRewrite(notebook: string, rewriteId: string) {
  return postRewrite<RewriteUndoResponse>({ notebook, undo: rewriteId }, "Could not undo the citation update.");
}

/** Skips that a new preview can pick up: the file changed after the preview, or was not in it. */
export function isStaleSkip(skip: RewriteSkip) {
  return /preview again/i.test(skip.reason);
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function keyList(keys: string[]) {
  const shown = keys.slice(0, 4).join(", ");
  return keys.length > 4 ? `${shown} and ${keys.length - 4} more` : shown;
}

type Round = { rewriteId: string | null; tabs: Array<{ path: string; change: TabRewriteChange; savedRewritten: boolean }> };
type Phase =
  | { kind: "loading" }
  | { kind: "preview"; preview: RewritePreviewResponse; draftPaths: Set<string> }
  | { kind: "applying" }
  | { kind: "done"; result: RewriteApplyResponse; tabCount: number }
  | { kind: "undoing" }
  | { kind: "undone"; restored: string[]; skipped: RewriteSkip[]; tabCount: number }
  | { kind: "error"; message: string; retry: "preview" | "none" };

type DialogProps = {
  notebook: string;
  request: CitationRewriteRequest | null;
  /** Unsaved text of open Markdown tabs; those of this notebook are rewritten as drafts. */
  openDrafts: OpenReferenceDraft[];
  onApplyToTab?: ApplyCitationRewriteToTab;
  onRevertTab?: RevertCitationRewriteInTab;
  /** Saved files changed: the citation index should be reloaded. */
  onChanged?: () => void;
  onClose: () => void;
};

export function RewriteCitationsDialog(props: DialogProps) {
  if (!props.request) return null;
  return <RewriteDialogBody key={props.request.id} {...props} request={props.request} />;
}

function RewriteDialogBody({ notebook, request, openDrafts, onApplyToTab, onRevertTab, onChanged, onClose }: DialogProps & { request: CitationRewriteRequest }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rounds, setRounds] = useState<Round[]>([]);
  // The drafts and tab callbacks of the latest render: a request reads them when it is sent and when it answers.
  const latest = useRef({ openDrafts, onApplyToTab, onRevertTab, onChanged });
  useEffect(() => {
    latest.current = { openDrafts, onApplyToTab, onRevertTab, onChanged };
  });
  const oldKeys = Object.keys(request.map);
  const target = [...new Set(Object.values(request.map))];
  const busy = phase.kind === "loading" || phase.kind === "applying" || phase.kind === "undoing";

  const runPreview = useCallback(async () => {
    setPhase({ kind: "loading" });
    const drafts = notebookDrafts(notebook, latest.current.openDrafts);
    try {
      const preview = await previewRewrite(notebook, request.map, drafts);
      setPhase({ kind: "preview", preview, draftPaths: new Set(Object.keys(drafts)) });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Could not find the citations to update.", retry: "preview" });
    }
  }, [notebook, request.map]);

  useEffect(() => {
    // The preview loads when the dialog opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runPreview();
  }, [runPreview]);

  async function apply(preview: RewritePreviewResponse) {
    setPhase({ kind: "applying" });
    try {
      const result = await applyRewrite(notebook, request.map, preview.expected, notebookDrafts(notebook, latest.current.openDrafts));
      // Open tabs take the same rewrite: their drafts (rewritten live, so typing since the preview stays) and, for files written on disk, their saved copy.
      const changed = new Set(result.changed);
      const tabs: Round["tabs"] = [];
      for (const path of new Set([...result.changed, ...Object.keys(result.draftEdits)])) {
        const change = latest.current.onApplyToTab?.(path, request.map, { savedRewritten: changed.has(path) });
        if (change) tabs.push({ path, change, savedRewritten: changed.has(path) });
      }
      setRounds((current) => [...current, { rewriteId: result.rewriteId, tabs }]);
      if (result.changed.length) latest.current.onChanged?.();
      setPhase({ kind: "done", result, tabCount: tabs.filter((tab) => tab.change.before !== tab.change.after).length });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Could not update the citations.", retry: "preview" });
    }
  }

  async function undo() {
    setPhase({ kind: "undoing" });
    const restored: string[] = [];
    const skipped: RewriteSkip[] = [];
    let tabCount = 0;
    try {
      for (const round of [...rounds].reverse()) {
        const result = round.rewriteId ? await undoRewrite(notebook, round.rewriteId) : { restored: [], skipped: [] };
        restored.push(...result.restored);
        skipped.push(...result.skipped);
        const files = new Set(result.restored);
        for (const tab of round.tabs) {
          await latest.current.onRevertTab?.(tab.path, tab.change, { refreshSaved: tab.savedRewritten && files.has(tab.path) });
          tabCount += 1;
        }
      }
      setRounds([]);
      if (restored.length) latest.current.onChanged?.();
      setPhase({ kind: "undone", restored, skipped, tabCount });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Could not undo the citation update.", retry: "none" });
    }
  }

  const title = request.reason.kind === "merge" ? `Update citations to ${request.reason.keep}` : `Update citations of ${keyList(oldKeys)}`;
  const description = request.reason.kind === "merge"
    ? `The merged keys (${keyList(oldKeys)}) are now aliases of ${request.reason.keep}, so documents citing them keep working. You can also rewrite those citations to ${request.reason.keep}.`
    : `${keyList(oldKeys)} stays an alias of ${keyList(target)}, so documents citing it keep working. You can also rewrite those citations to the new key.`;
  const cancelButton = "rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50";
  const primaryButton = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
  const canUndo = rounds.some((round) => round.rewriteId || round.tabs.length);

  let body: ReactNode;
  let footer: ReactNode;
  switch (phase.kind) {
    case "loading":
    case "applying":
    case "undoing":
      body = (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          {phase.kind === "loading" ? "Finding citations…" : phase.kind === "applying" ? "Updating citations…" : "Undoing…"}
        </p>
      );
      footer = <button type="button" className={cancelButton} disabled>Close</button>;
      break;
    case "error":
      body = <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{phase.message}</div>;
      footer = (
        <>
          <button type="button" className={cancelButton} onClick={onClose}>Close</button>
          {phase.retry === "preview" ? <button type="button" className={primaryButton} onClick={() => void runPreview()}>Try again</button> : null}
        </>
      );
      break;
    case "preview": {
      const { files } = phase.preview;
      const total = files.reduce((sum, file) => sum + file.count, 0);
      body = files.length ? (
        <div className="space-y-3 text-sm">
          <p>{plural(total, "citation", "citations")} in {plural(files.length, "document", "documents")} still use {plural(oldKeys.length, "the old key", "the old keys")}.</p>
          <ul className="max-h-[50vh] space-y-2 overflow-auto" aria-label="Documents to update">
            {files.map((file) => (
              <li key={file.path} className="rounded-lg border border-border p-2" data-path={file.path}>
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={file.path}>{fileBaseName(file.path)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{plural(file.count, "citation", "citations")}</span>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">{file.path}{phase.draftPaths.has(file.path) ? " · unsaved changes included" : ""}</p>
                <ul className="mt-1 space-y-1 font-mono text-[11px]">
                  {file.excerpts.map((excerpt) => (
                    <li key={excerpt.line} aria-label={`Line ${excerpt.line}`}>
                      <span className="text-muted-foreground">{excerpt.line}:</span>
                      <del className="block whitespace-pre-wrap break-words text-destructive">{excerpt.before}</del>
                      <ins className="block whitespace-pre-wrap break-words text-accent no-underline">{excerpt.after}</ins>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No document cites {keyList(oldKeys)} any more. There is nothing to update.</p>
      );
      footer = files.length ? (
        <>
          <button type="button" className={cancelButton} onClick={onClose}>Not now</button>
          <button type="button" className={primaryButton} onClick={() => void apply(phase.preview)}>Update {plural(total, "citation", "citations")}</button>
        </>
      ) : <button type="button" className={cancelButton} onClick={onClose}>Close</button>;
      break;
    }
    case "done": {
      const { result, tabCount } = phase;
      const stale = result.skipped.filter(isStaleSkip);
      body = (
        <div className="space-y-2 text-sm" role="status" aria-label="Update result">
          <p>
            {result.changed.length ? `Updated ${plural(result.changed.length, "saved document", "saved documents")}` : "No saved document was changed"}
            {tabCount ? ` and ${plural(tabCount, "open tab", "open tabs")}` : ""}.
          </p>
          {result.changed.length ? (
            <ul className="max-h-40 overflow-auto text-xs text-muted-foreground" aria-label="Updated documents">
              {result.changed.map((path) => <li key={path} title={path}>{path}</li>)}
            </ul>
          ) : null}
          {result.skipped.length ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">{plural(result.skipped.length, "document was", "documents were")} left unchanged:</p>
              <ul className="max-h-40 space-y-0.5 overflow-auto text-xs" aria-label="Skipped documents">
                {result.skipped.map((skip) => <li key={skip.path}><span className="font-medium">{fileBaseName(skip.path)}</span>: {skip.reason}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      );
      footer = (
        <>
          {canUndo ? <button type="button" className={cancelButton} onClick={() => void undo()}>Undo</button> : null}
          {stale.length ? <button type="button" className={cancelButton} onClick={() => void runPreview()}>Preview again</button> : null}
          <button type="button" className={primaryButton} onClick={onClose}>Done</button>
        </>
      );
      break;
    }
    case "undone":
      body = (
        <div className="space-y-2 text-sm" role="status" aria-label="Undo result">
          <p>Restored {plural(phase.restored.length, "saved document", "saved documents")}{phase.tabCount ? ` and ${plural(phase.tabCount, "open tab", "open tabs")}` : ""}.</p>
          {phase.skipped.length ? (
            <ul className="max-h-40 space-y-0.5 overflow-auto text-xs" aria-label="Documents not restored">
              {phase.skipped.map((skip) => <li key={skip.path}><span className="font-medium">{fileBaseName(skip.path)}</span>: {skip.reason}</li>)}
            </ul>
          ) : null}
        </div>
      );
      footer = <button type="button" className={primaryButton} onClick={onClose}>Done</button>;
      break;
  }

  return (
    <ModalDialog open title={title} description={description} panelClassName="max-w-xl" onClose={() => { if (!busy) onClose(); }} footer={footer}>
      {body}
    </ModalDialog>
  );
}
