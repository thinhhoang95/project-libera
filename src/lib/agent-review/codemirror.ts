import { Prec, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { addReviewHunks, decideReviewHunks, latexReviewExtension, resolveReviewHunks, reviewHunksField, type ReviewHunk } from "@/lib/latex/codemirror/review";
import { agentReviewStore, reviewTextHunks } from "./store";

/* Manual review of the agent's changes in a CodeMirror editor (Markdown
 * Source, LaTeX, plain text). The pending changes are the difference between
 * the file's review baseline and the editor's text, shown with the same
 * Accept/Reject hunks as AI Rewrite. Hunks follow the user's edits; text the
 * workspace puts in from outside (the agent's next edit, a reload) is
 * diffed against the baseline again. Every decision, and every edit outside
 * the hunks, moves the baseline, which goes back to the review store. */

export const agentReviewHunks = (state: EditorState) => state.field(reviewHunksField, false)?.filter((hunk) => hunk.source === "agent") ?? [];

/** The text without the given hunks: each one's original back in its place. */
export function textWithoutHunks(doc: string, hunks: readonly ReviewHunk[]) {
  let text = "";
  let pos = 0;
  for (const hunk of [...hunks].sort((a, b) => a.from - b.from)) {
    text += doc.slice(pos, hunk.from) + hunk.original;
    pos = hunk.to;
  }
  return text + doc.slice(pos);
}

let hunkCounter = 0;

/** The agent hunks that turn `baseline` into `doc`. */
export function agentHunksBetween(baseline: string, doc: string): ReviewHunk[] {
  return reviewTextHunks(baseline, doc).map((hunk) => ({
    id: `agent-${(hunkCounter++).toString(36)}`,
    from: hunk.fromB,
    to: hunk.toB,
    original: baseline.slice(hunk.fromA, hunk.toA),
    source: "agent",
  }));
}

/**
 * `outside` tells text put in by the workspace (not typed) from the user's
 * edits; each editor marks it differently.
 */
export function agentReviewCodeMirror(path: string, { outside }: { outside: (transaction: Transaction) => boolean }): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private scheduled = false;
    private destroyed = false;
    /** The last baseline this editor reported, so its own report does not trigger a re-diff. */
    private reported: string | null = null;
    private readonly unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.unsubscribe = agentReviewStore.subscribe(() => {
        const file = agentReviewStore.get(path);
        if (file && file.baseline === this.reported) return;
        this.schedule();
      });
      this.schedule();
    }

    /** Views cannot dispatch while updating; sync right after. */
    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.destroyed) this.sync();
      });
    }

    /** Brings the hunks in line with the store's baseline. */
    sync() {
      const { state } = this.view;
      const file = agentReviewStore.get(path);
      const current = agentReviewHunks(state);
      // Nothing to compare and nothing to resolve: no need to read the text.
      if (!file && !current.length) return;
      const doc = state.doc.toString();
      const baseline = file ? state.toText(file.baseline).toString() : "";
      if (file && textWithoutHunks(doc, current) === baseline) return;
      const next = file ? agentHunksBetween(baseline, doc) : [];
      if (!current.length && !next.length) return;
      this.reported = file?.baseline ?? null;
      this.view.dispatch({
        effects: [resolveReviewHunks.of(current.map((hunk) => hunk.id)), ...(next.length ? [addReviewHunks.of(next)] : [])],
        annotations: Transaction.addToHistory.of(false),
      });
    }

    update(update: ViewUpdate) {
      if (!agentReviewStore.get(path)) return;
      if (update.transactions.some((transaction) => transaction.docChanged && outside(transaction))) {
        this.schedule();
        return;
      }
      const before = agentReviewHunks(update.startState);
      const after = agentReviewHunks(update.state);
      if (!update.docChanged && before.length === after.length && before.every((hunk, index) => hunk === after[index])) return;
      // Accepting moves a hunk into the baseline; rejecting or typing changes
      // the text around the hunks, which the baseline keeps as well.
      const file = agentReviewStore.get(path)!;
      const text = textWithoutHunks(update.state.doc.toString(), after);
      const baseline = file.baseline.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
      this.reported = baseline;
      agentReviewStore.setBaseline(path, baseline);
    }

    destroy() {
      this.destroyed = true;
      this.unsubscribe();
    }
  });
  return [
    latexReviewExtension(),
    plugin,
    EditorView.editorAttributes.of({ class: "libera-ai-review" }),
    // Only while there are changes: otherwise the keys keep their usual meaning.
    Prec.high(keymap.of([
      { key: "Mod-Shift-Enter", run: (view) => decideReviewHunks(view, "all", "accept") },
      { key: "Mod-Shift-Backspace", run: (view) => decideReviewHunks(view, "all", "reject") },
    ])),
  ];
}
