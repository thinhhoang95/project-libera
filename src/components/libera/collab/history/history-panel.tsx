"use client";

// Version history of a shared document (plan M2.4, M2.5), opened from the
// file actions menu ("History…"):
//
// - the revision list: automatic checkpoints, named versions and the
//   checkpoints taken before restores and accept-all, with author and time;
// - "Name this version…" (editors and owners);
// - a read-only view of any revision, and a diff between two revisions or a
//   revision and now, with inserted text coloured by who wrote it;
// - "Restore this version" and "Restore selection" (editors and owners),
//   applied by the server as forward edits after a checkpoint.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { History, LoaderCircle, RotateCcw, Tag } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { Revision, RevisionKind, UserSummary } from "@/lib/collab/protocol/api";
import { can, type Role } from "@/lib/collab/protocol/roles";
import { describeError } from "@/lib/collab/ui/client";
import { timeAgo } from "@/lib/collab/ui/wording";
import { ShowMoreButton, usePagedList } from "../../list-controls";
import { loadProjectMembers } from "../mentions/mention-textarea";
import { attributeUpdates, type Attribution, type AttributedRange } from "./attribution";
import { contentUpdates, historyApi, type HistoryApi } from "./history-api";

export interface HistoryTarget {
  docId: string;
  projectId: string;
  path: string;
  role: Role;
}

const KIND_LABELS: Record<RevisionKind, string> = {
  auto: "Automatic",
  named: "Named version",
  "session-end": "Session end",
  "pre-accept-all": "Before accept all",
  "pre-restore": "Before restore",
  "review-base": "Review start",
};

export function revisionTitle(revision: Revision): string {
  return revision.label ?? KIND_LABELS[revision.kind] ?? "Checkpoint";
}

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];

function attributionMarks(ranges: AttributedRange[]): Extension {
  return EditorView.decorations.of((view) => {
    const builder = new RangeSetBuilder<Decoration>();
    const length = view.state.doc.length;
    for (const range of ranges) {
      const from = Math.min(range.start, length), to = Math.min(range.end, length);
      if (to <= from) continue;
      builder.add(from, to, Decoration.mark({
        class: "libera-history-author",
        attributes: { style: `background-color: ${range.author.color}33; border-bottom: 2px solid ${range.author.color}`, title: range.author.label, "data-author": range.author.label },
      }));
    }
    return builder.finish();
  });
}

/** A read-only CodeMirror view of a revision; reports the selected range for "Restore selection" (also the review checkpoint view). */
export function RevisionView({ text, onSelection, className = "max-h-[55vh] min-h-48 rounded-lg border border-border" }: { text: string; onSelection: (range: { start: number; end: number } | null) => void; className?: string }) {
  const parent = useRef<HTMLDivElement | null>(null);
  const report = useRef(onSelection);
  useEffect(() => { report.current = onSelection; });
  useEffect(() => {
    if (!parent.current) return;
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: text,
        extensions: [readOnly, EditorView.updateListener.of((update) => {
          if (!update.selectionSet) return;
          const { from, to } = update.state.selection.main;
          report.current(to > from ? { start: from, end: to } : null);
        })],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={parent} className={`libera-history-view overflow-auto text-[13px] ${className}`} aria-label="Revision text" />;
}

export function DiffView({ attribution, before, className = "max-h-[55vh] rounded-lg border border-border" }: { attribution: Attribution; before: string; className?: string }) {
  const parent = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!parent.current) return;
    const view = new MergeView({
      parent: parent.current,
      a: { doc: before, extensions: readOnly },
      b: { doc: attribution.after, extensions: [readOnly, attributionMarks(attribution.ranges)] },
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }, [attribution, before]);
  return <div ref={parent} className={`libera-history-diff overflow-auto text-[13px] ${className}`} aria-label="Changes" />;
}

function byWhom(user: UserSummary | null): string {
  return user ? user.displayName : "Libera";
}

// The version history dialog's two panes: a frame each, a header row of one
// height, a body that fills the rest and scrolls, and an optional footer.
const pane = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border";
const paneHeader = "flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs";
const paneFooter = "flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2";
const paneBody = "min-h-0 flex-1";
const paneNote = "flex items-center gap-2 p-3 text-xs text-muted-foreground";

export interface DocumentHistoryPanelProps {
  target: HistoryTarget;
  onClose: () => void;
  api?: HistoryApi;
}

type Compare = { kind: "none" } | { kind: "now" } | { kind: "revision"; id: string };

export function DocumentHistoryPanel({ target, onClose, api = historyApi }: DocumentHistoryPanelProps) {
  const { docId, role } = target;
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<{ id: string; text: string } | null>(null);
  const [compare, setCompare] = useState<Compare>({ kind: "none" });
  const [diff, setDiff] = useState<{ key: string; before: string; attribution: Attribution } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [confirming, setConfirming] = useState<"whole" | "selection" | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const canName = can(role, "name-revision");
  const canRestore = can(role, "restore");

  const applyRevisions = useCallback((outcome: { list: Revision[] } | { error: unknown }): Revision[] | null => {
    if ("error" in outcome) {
      setError(describeError(outcome.error));
      setRevisions((current) => current ?? []);
      return null;
    }
    setRevisions(outcome.list);
    setNow(Date.now());
    setError("");
    setSelectedId((current) => current ?? outcome.list[0]?.id ?? null);
    return outcome.list;
  }, []);
  const fetchRevisions = useCallback(() => api.revisions(docId).then((list) => ({ list }), (error: unknown) => ({ error })), [api, docId]);
  const refresh = useCallback(async () => applyRevisions(await fetchRevisions()), [applyRevisions, fetchRevisions]);
  useEffect(() => {
    let live = true;
    void fetchRevisions().then((outcome) => { if (live) applyRevisions(outcome); });
    return () => { live = false; };
  }, [fetchRevisions, applyRevisions]);

  const selected = revisions?.find((revision) => revision.id === selectedId) ?? null;
  // Automatic versions add up: the newest 20, then 40 more at a time. The
  // selected version stays listed.
  const page = usePagedList(revisions ?? [], docId, revisions?.findIndex((revision) => revision.id === selectedId) ?? -1);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    api.content(docId, selectedId).then(
      (loaded) => { if (live) { setContent({ id: selectedId, text: loaded.text }); setSelection(null); setConfirming(null); } },
      (cause: unknown) => { if (live) setError(describeError(cause)); },
    );
    return () => { live = false; };
  }, [api, docId, selectedId]);

  const compareKey = compare.kind === "none" || !selected ? null : `${selected.id}:${compare.kind === "now" ? "now" : compare.id}`;
  useEffect(() => {
    if (!compareKey || !selected || !revisions) return;
    let live = true;
    const other = compare.kind === "revision" ? revisions.find((revision) => revision.id === compare.id) ?? null : null;
    // Always older → newer, so inserted text is the newer side's.
    const [older, newer] = other && other.serverSeq < selected.serverSeq ? [other, selected] : [selected, other];
    (async () => {
      const members = await loadProjectMembers(target.projectId).catch(() => []);
      const users = new Map(members.map((member) => [member.id, member as UserSummary]));
      const toSeq = newer ? newer.serverSeq : null;
      const page = await contentUpdates(api, docId, toSeq);
      const attribution = attributeUpdates(page, older.serverSeq, toSeq, users);
      // The server's text of the older revision is the truth when the log
      // was compacted below it; the replay then starts at a later snapshot.
      const before = (await api.content(docId, older.id)).text;
      if (live) setDiff({ key: compareKey, before, attribution });
    })().catch((cause: unknown) => { if (live) setError(describeError(cause)); });
    return () => { live = false; };
  }, [api, docId, compareKey, compare, selected, revisions, target.projectId]);

  async function nameVersion() {
    const label = naming?.trim();
    if (!label) return;
    setBusy("name");
    try {
      const revision = await api.nameVersion(docId, label);
      setNaming(null);
      setResult(`Saved “${revisionTitle(revision)}”.`);
      await refresh();
      setSelectedId(revision.id);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function restore(kind: "whole" | "selection") {
    if (!selected) return;
    setBusy("restore");
    setConfirming(null);
    try {
      const restored = await api.restore(docId, { revisionId: selected.id, ...(kind === "selection" && selection ? { range: selection } : {}) });
      const list = await refresh();
      const checkpoint = list?.find((revision) => revision.id === restored.checkpointRevisionId);
      setResult(`${kind === "selection" ? "The selected section was" : "The document was"} restored from “${revisionTitle(selected)}”. The text before the restore was saved as a checkpoint${checkpoint ? ` (${revisionTitle(checkpoint)})` : ""}, so this can be undone from History.`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  const otherRevisions = useMemo(() => (revisions ?? []).filter((revision) => revision.id !== selectedId), [revisions, selectedId]);
  const shownDiff = diff && diff.key === compareKey ? diff : null;
  const diffBusy = compareKey !== null && !shownDiff && !error;

  return <ModalDialog open title="Version history" description={target.path} panelClassName="max-w-5xl w-full" onClose={onClose} footer={<button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onClose}>Close</button>}>
    {/* Two panes of one height: the list scrolls in its own pane, and the
        version (or the diff) fills the other, whatever either holds. */}
    <div className="libera-history grid gap-3 md:h-[min(68vh,46rem)] md:grid-cols-[16rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <aside className={pane} aria-label="Revisions">
        <div className={paneHeader}>
          {naming === null
            ? <>
              <span className="min-w-0 flex-1 font-semibold">Versions{revisions?.length ? <span className="ml-1 font-normal tabular-nums text-muted-foreground">{revisions.length}</span> : null}</span>
              {canName && <button type="button" className="review-button" onClick={() => setNaming("")}><Tag aria-hidden size={14} /> Name this version…</button>}
            </>
            : <form className="flex min-w-0 flex-1 gap-1" onSubmit={(event) => { event.preventDefault(); void nameVersion(); }}>
              <input autoFocus aria-label="Version name" className="libera-panel-field h-7 min-w-0 flex-1 px-2 text-xs" maxLength={200} placeholder="Version name" value={naming} onChange={(event) => setNaming(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setNaming(null); } }} />
              <button type="submit" className="review-button" disabled={!naming.trim() || busy === "name"}>Save</button>
            </form>}
        </div>
        <ol className="max-h-72 min-h-0 flex-1 space-y-1 overflow-auto p-1.5 md:max-h-none">
          {revisions === null ? <li className="flex items-center gap-2 p-1.5 text-xs text-muted-foreground"><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading…</li> : !revisions.length ? <li className="p-1.5 text-xs text-muted-foreground">No versions yet. Libera saves one after five idle minutes and when you close the document.</li> : page.visible.map((revision) => (
            <li key={revision.id}>
              <button type="button" aria-pressed={revision.id === selectedId} data-revision-kind={revision.kind} className="w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted aria-pressed:bg-muted" onClick={() => { setSelectedId(revision.id); setCompare({ kind: "none" }); setResult(""); }}>
                <span className="block font-medium">{revisionTitle(revision)}</span>
                <span className="block text-[11px] text-muted-foreground">{revision.kind === "named" ? "Named" : KIND_LABELS[revision.kind]} · {byWhom(revision.createdBy)} · <span title={new Date(revision.createdAt).toLocaleString()}>{timeAgo(Math.max(0, now - Date.parse(revision.createdAt)))}</span></span>
              </button>
            </li>
          ))}
          {page.remaining > 0 ? <li><ShowMoreButton remaining={page.remaining} onClick={page.showMore} /></li> : null}
        </ol>
      </aside>
      <section className={pane} aria-label="Revision">
        <div className={paneHeader}>
          {selected ? <>
            <History aria-hidden size={14} className="shrink-0" /><strong className="min-w-0 truncate">{revisionTitle(selected)}</strong>
            <label className="ml-auto inline-flex min-w-0 items-center gap-1">Compare with
              <select aria-label="Compare with" className="libera-panel-field h-7 min-w-0 max-w-64 px-1 text-xs" value={compare.kind === "revision" ? compare.id : compare.kind} onChange={(event) => { const value = event.target.value; setCompare(value === "none" ? { kind: "none" } : value === "now" ? { kind: "now" } : { kind: "revision", id: value }); }}>
                <option value="none">Nothing (show this version)</option>
                <option value="now">The current text</option>
                {otherRevisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionTitle(revision)} · {new Date(revision.createdAt).toLocaleString()}</option>)}
              </select>
            </label>
          </> : <span className="text-muted-foreground">{revisions?.length ? "Choose a version" : "Version"}</span>}
        </div>
        {(error || result) && <div className="shrink-0 space-y-1 border-b border-border px-3 py-2">
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {result && <p role="status" className="text-xs">{result}</p>}
        </div>}
        <div className="flex min-h-72 flex-1 flex-col md:min-h-0">
          {compare.kind === "none"
            ? (content && content.id === selectedId ? <RevisionView text={content.text} onSelection={setSelection} className={paneBody} /> : selected ? <p className={paneNote}><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading this version…</p> : null)
            : diffBusy || !shownDiff ? <p className={paneNote}><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Comparing…</p>
              : <DiffView attribution={shownDiff.attribution} before={shownDiff.before} className={paneBody} />}
        </div>
        {compare.kind !== "none" && shownDiff && shownDiff.attribution.authors.length > 0 && <ul className={paneFooter} aria-label="Authors of the changes">
          {shownDiff.attribution.authors.map((author) => <li key={author.key} className="inline-flex items-center gap-1 text-[11px]" data-author-kind={author.kind}><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: author.color }} />{author.label}</li>)}
        </ul>}
        {canRestore && selected && compare.kind === "none" && <div className={paneFooter}>
          {confirming
            ? <>
              <span className="text-xs">{confirming === "whole" ? "Replace the whole document with this version? Everyone sees the change; a checkpoint is saved first." : "Replace that section of the document with the selected text of this version?"}</span>
              <button type="button" className="review-button" disabled={busy === "restore"} onClick={() => void restore(confirming)}>Restore</button>
              <button type="button" className="review-button" onClick={() => setConfirming(null)}>Cancel</button>
            </>
            : <>
              <button type="button" className="review-button" disabled={!!busy} onClick={() => setConfirming("whole")}><RotateCcw aria-hidden size={14} /> Restore this version</button>
              <button type="button" className="review-button" disabled={!!busy || !selection} title={selection ? "Restore only the selected text" : "Select text in the version first"} onClick={() => setConfirming("selection")}>Restore selection</button>
            </>}
        </div>}
      </section>
    </div>
  </ModalDialog>;
}
