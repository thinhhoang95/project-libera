"use client";

import { useLayoutEffect, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { agentReviewStore } from "@/lib/agent-review/store";
import { tiptapChangesKey, type TiptapChangesMeta } from "@/lib/tiptap-changes";

const REPORT_DELAY_MS = 300;

/**
 * Manual review of the agent's changes in the Visual editor: the difference
 * between the file's review baseline and the document, shown as applied AI
 * changes (Reject restores the original). Text put in from outside (the
 * agent's next edit, a reload) is diffed again; decisions and the user's
 * edits move the baseline, which goes back to the review store.
 * `lastValue` is the Markdown the editor last published.
 */
export function useTiptapAgentReview(editor: Editor | null, path: string | null, lastValue: RefObject<string>) {
  useLayoutEffect(() => {
    if (!editor || !path) return;
    const markdown = editor.markdown;
    if (!markdown) return;
    let destroyed = false;
    let scheduled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The last baseline this editor reported, so its own report does not trigger a re-diff. */
    let reported: string | null = null;
    type Snapshot = { doc: ProseMirrorNode; before: ProseMirrorNode; source: string; published: string };
    const history: Snapshot[] = [];
    let pending: Snapshot | null = null;

    const agentChanges = () => (tiptapChangesKey.getState(editor.state)?.changes ?? []).filter((change) => change.source === "agent" && change.mode === "applied");

    function sync() {
      if (destroyed || editor!.isDestroyed) return;
      const file = agentReviewStore.get(path!);
      const current = agentChanges();
      if (!file) {
        if (current.length) editor!.view.dispatch(editor!.state.tr.setMeta(tiptapChangesKey, { type: "resolve", ids: current.map((change) => change.id) } satisfies TiptapChangesMeta).setMeta("addToHistory", false));
        return;
      }
      let before: ProseMirrorNode;
      try { before = editor!.schema.nodeFromJSON(markdown!.parse(file.baseline)); }
      catch { return; }
      reported = file.baseline;
      editor!.view.dispatch(editor!.state.tr.setMeta(tiptapChangesKey, { type: "retrack", source: "agent", before } satisfies TiptapChangesMeta).setMeta("addToHistory", false));
      remember(false);
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        sync();
      });
    }

    /** Capture before debouncing: an incoming document must not consume a
     * pending report using the incoming text and already-mapped hunks. */
    function remember(reportLater: boolean) {
      const file = agentReviewStore.get(path!);
      if (!file) return;
      const tr = editor!.state.tr;
      for (const change of [...agentChanges()].sort((a, b) => b.from - a.from)) tr.replace(change.from, change.to, new Slice(change.other, 0, 0));
      const snapshot = { doc: editor!.state.doc, before: tr.doc, source: file.baseline, published: lastValue.current };
      // Decisions do not change the document, but do change its baseline.
      const previous = history.findIndex((item) => item.doc.eq(snapshot.doc));
      if (previous >= 0) history.splice(previous, 1);
      history.push(snapshot);
      if (history.length > 100) history.shift();
      if (reportLater) pending = snapshot;
    }

    /** The captured document without the agent's remaining changes, as Markdown. */
    function report() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const snapshot = pending;
      pending = null;
      if (destroyed || !snapshot || !agentReviewStore.get(path!)) return;
      let baseline: string | undefined;
      // Keep exact Markdown when the baseline has not changed semantically.
      // In particular, opening or rejecting a hunk must not canonicalize all
      // the file's list markers, emphasis, whitespace and final newlines.
      const sources = snapshot.before.eq(snapshot.doc) ? [lastValue.current, snapshot.published] : [snapshot.source];
      for (const source of sources) {
        try {
          if (editor!.schema.nodeFromJSON(markdown!.parse(source)).eq(snapshot.before)) { baseline = source; break; }
        } catch { /* Serialize below. */ }
      }
      baseline ??= markdown!.serialize(snapshot.before.toJSON());
      reported = baseline;
      agentReviewStore.setBaseline(path!, baseline);
    }

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!agentReviewStore.get(path)) return;
      const meta = transaction.getMeta(tiptapChangesKey) as TiptapChangesMeta | undefined;
      if (meta?.type === "retrack") return;
      // The workspace replaced the document (useTiptapDraft): first publish
      // the user's edits from the previous document, then diff the new one.
      if (transaction.docChanged && transaction.getMeta("preventUpdate")) {
        report();
        schedule();
        return;
      }
      if (!transaction.docChanged && meta?.type !== "resolve") return;
      if (isHistoryTransaction(transaction)) {
        // ProseMirror history restores text, not plugin metadata. Recover the
        // baseline for that text so undo/redo of a rejection or of the user's
        // typing restores its review state as well.
        const snapshot = [...history].reverse().find((item) => item.doc.eq(editor!.state.doc));
        if (snapshot) editor!.view.dispatch(editor!.state.tr.setMeta(tiptapChangesKey, { type: "retrack", source: "agent", before: snapshot.before } satisfies TiptapChangesMeta).setMeta("addToHistory", false));
        else { sync(); }
      }
      remember(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, REPORT_DELAY_MS);
    };

    const unsubscribe = agentReviewStore.subscribe(() => {
      const file = agentReviewStore.get(path);
      if (file && file.baseline === reported) return;
      schedule();
    });
    const unregister = agentReviewStore.registerFlusher(path, report);
    editor.on("transaction", onTransaction);
    schedule();
    return () => {
      report();
      destroyed = true;
      unsubscribe();
      unregister();
      editor.off("transaction", onTransaction);
    };
  }, [editor, path, lastValue]);
}
