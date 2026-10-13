"use client";

import type { EditorView } from "@codemirror/view";
import { beginAiActivity } from "@/lib/ai-activity";
import { apiRequest } from "@/components/libera/api-client";
import { readIncludeDocumentContext } from "@/components/libera/ai-document-context-preference";
import { applyAiProposal, pendingAiField, setPendingAiRequest, type AiChangeSource } from "@/lib/latex/codemirror/review";

let requestCounter = 0;
const controllers = new WeakMap<EditorView, AbortController>();

/** Where Write with AI inserts: on the caret's line when it is blank, else on
 * a new line after it, so the new block never splits a line. */
export function latexWriteInsertion(view: EditorView, pos: number) {
  const { doc } = view.state;
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return { from: line.from, to: line.from, before: "", after: "" };
  if (line.number < doc.lines) return { from: line.to + 1, to: line.to + 1, before: "", after: "\n" };
  return { from: line.to, to: line.to, before: "\n", after: "" };
}

export function isLatexAiWorking(view: EditorView) {
  return view.state.field(pendingAiField, false) != null;
}

export function cancelLatexAi(view: EditorView) {
  controllers.get(view)?.abort();
}

/** Run AI Format, AI Rewrite or Write with AI and show the result for review. */
export async function runLatexAi(view: EditorView, action: AiChangeSource, range: { from: number; to: number }, prompt: string, onError: (message: string) => void) {
  if (isLatexAiWorking(view)) return;
  const id = `latex-ai-${++requestCounter}`;
  const length = view.state.doc.length;
  const clamped = { from: Math.max(0, Math.min(range.from, length)), to: Math.max(0, Math.min(range.to, length)) };
  const target = action === "write" ? latexWriteInsertion(view, clamped.to) : { ...clamped, before: "", after: "" };
  const original = view.state.sliceDoc(target.from, target.to);
  if (action !== "write" && !original.trim()) return;
  const doc = view.state.doc.toString();
  const context = action !== "format" && readIncludeDocumentContext() ? { before: doc.slice(0, target.from), after: doc.slice(target.to) } : {};
  const controller = new AbortController();
  controllers.set(view, controller);
  const endActivity = beginAiActivity();
  onError("");
  view.dispatch({ effects: setPendingAiRequest.of({ id, from: target.from, to: target.to, kind: action }) });

  try {
    const init = { method: "POST", signal: controller.signal };
    let text: string;
    if (action === "format") {
      text = (await apiRequest<{ formattedText: string }>("/api/ai-format", { ...init, body: JSON.stringify({ text: original, format: "latex" }) })).formattedText;
    } else if (action === "rewrite") {
      text = (await apiRequest<{ rewrittenText: string }>("/api/ai-rewrite", { ...init, body: JSON.stringify({ text: original, prompt, format: "latex", ...context }) })).rewrittenText;
    } else {
      text = (await apiRequest<{ markdown: string }>("/api/ai-write", { ...init, body: JSON.stringify({ prompt, format: "latex", ...context }) })).markdown;
    }

    if (controller.signal.aborted || !view.dom.isConnected) return;
    const pending = view.state.field(pendingAiField, false);
    if (pending?.id !== id) return;
    if (!text.trim()) throw new Error("AI returned an empty response. Please retry.");
    if (action !== "write" && view.state.sliceDoc(pending.from, pending.to) !== original) {
      throw new Error("The selected text changed while AI was working. Select it again and retry.");
    }

    let replacement = text;
    if (action === "write") {
      replacement = `${target.before}${text.replace(/^\n+/, "").replace(/\s+$/, "")}${target.after}`;
    } else {
      // Keep the selection's own leading and trailing line breaks.
      const leading = original.match(/^\s*\n/)?.[0] ?? "";
      const trailing = original.match(/\n\s*$/)?.[0] ?? "";
      replacement = `${leading}${text.replace(/^\s*\n/, "").replace(/\n\s*$/, "")}${trailing}`;
    }
    applyAiProposal(view, pending.from, pending.to, replacement, action);
    view.focus();
  } catch (error) {
    if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "AI request failed.");
  } finally {
    endActivity();
    if (controllers.get(view) === controller) controllers.delete(view);
    if (view.dom.isConnected && view.state.field(pendingAiField, false)?.id === id) view.dispatch({ effects: setPendingAiRequest.of(null) });
  }
}
