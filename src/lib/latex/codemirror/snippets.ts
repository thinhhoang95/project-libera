import { snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  figureTemplate, indentSnippet, packageInsertion, sideBySideTemplate, tableTemplate, type LatexSnippet,
} from "../snippets";

/** Inserts a saved snippet literally (its text is never read as a template),
 * indented to the line it lands on. */
export function insertSnippetText(view: EditorView, body: string, from = view.state.selection.main.from, to = view.state.selection.main.to) {
  const line = view.state.doc.lineAt(from);
  const indent = /^[ \t]*/.exec(line.text)![0];
  const insert = indentSnippet(body, indent);
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: "input.complete" });
}

/** Loads packages the inserted code needs, mapping `range` past the change.
 * `unavailable` lists those it could not add, because this file has no
 * preamble (it is included by a main file). */
export function ensurePackages(view: EditorView, packages: string[], range = { from: view.state.selection.main.from, to: view.state.selection.main.to }) {
  const { missing, change } = packageInsertion(view.state.doc.toString(), packages);
  if (!change) return { unavailable: missing, range };
  const transaction = view.state.update({ changes: change, userEvent: "input" });
  view.dispatch(transaction);
  return { unavailable: [], range: { from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, 1) } };
}

/** Inserts a CodeMirror snippet template over `range` (the selection by
 * default); Tab then visits its fields. Returns packages it could not add. */
export function insertTemplate(view: EditorView, template: string, packages: string[] = [], range?: { from: number; to: number }) {
  // Packages first, so the template's fields stay active afterwards.
  const { unavailable, range: target } = ensurePackages(view, packages, range);
  snippet(template)(view, { label: "" }, target.from, target.to);
  view.focus();
  return unavailable;
}

/** Templates offered as `/name` in the editor, beside the saved snippets. */
export const SLASH_TEMPLATES: { name: string; detail: string; template: () => string; packages: string[] }[] = [
  { name: "figure", detail: "Figure with caption and label", template: () => figureTemplate(), packages: ["graphicx"] },
  { name: "side-by-side", detail: "Two figures side by side", template: () => sideBySideTemplate(2), packages: ["graphicx", "subcaption"] },
  { name: "three-figures", detail: "Three figures in a row", template: () => sideBySideTemplate(3), packages: ["graphicx", "subcaption"] },
  { name: "table", detail: "Table with booktabs rules", template: () => tableTemplate(3, 3), packages: ["booktabs"] },
];

function snippetInfo(body: string) {
  return () => {
    const pre = document.createElement("pre");
    pre.className = "libera-latex-snippet-info";
    const lines = body.split("\n");
    pre.textContent = lines.length > 14 ? `${lines.slice(0, 14).join("\n")}\n…` : body;
    return pre;
  };
}

/** `/name` at the start of a line or after a space offers saved snippets and
 * the built-in templates. One letter after the slash is needed to open the
 * list, so a lone slash never captures Enter. */
export function latexSnippetCompletionSource(getSnippets: () => LatexSnippet[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\/[A-Za-z0-9_-]*/);
    if (!match || (match.text.length < 2 && !context.explicit)) return null;
    if (match.from > 0 && !/\s/.test(context.state.sliceDoc(match.from - 1, match.from))) return null;
    const line = context.state.doc.lineAt(match.from);
    if (/(^|[^\\])%/.test(line.text.slice(0, match.from - line.from))) return null;

    const snippets = getSnippets();
    const taken = new Set(snippets.map((saved) => saved.name.toLocaleLowerCase()));
    const options: Completion[] = snippets.map((saved) => ({
      label: `/${saved.name}`,
      detail: "snippet",
      type: "text",
      boost: 5,
      info: snippetInfo(saved.body),
      apply: (view, _completion, from, to) => insertSnippetText(view, saved.body, from, to),
    }));
    for (const template of SLASH_TEMPLATES) {
      if (taken.has(template.name)) continue;
      options.push({
        label: `/${template.name}`,
        detail: template.detail,
        type: "keyword",
        apply: (view, _completion, from, to) => { insertTemplate(view, template.template(), template.packages, { from, to }); },
      });
    }
    return { from: match.from, options, validFor: /^\/[A-Za-z0-9_-]*$/ };
  };
}
