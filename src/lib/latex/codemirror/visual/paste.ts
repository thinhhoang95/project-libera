import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { insertLargeText, utf8Length } from "../../../collab/bindings/codemirror";
import { htmlToLatex } from "./html2latex";
import { plainPasteEvents } from "../markdown-paste";

/* Pasting rich text in the Visual mode converts it to LaTeX
 * (docs/latex-visual-editor-plan.md §6.7). Plain text is pasted as it is,
 * since it may be LaTeX, and inside math only plain text is used. */

const MATH = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math", "VerbatimEnvironment", "Comment"]);
const LARGE_PASTE_BYTES = 64 * 1024;

function insideMathOrVerbatim(view: EditorView, pos: number) {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(pos, -1); node; node = node.parent) {
    // Right after a formula's closing delimiter is outside it; a comment runs to the end of its line.
    if (MATH.has(node.name) && (node.name === "Comment" ? pos > node.from : pos > node.from && pos < node.to)) return true;
  }
  return false;
}

export const pasteHtmlAsLatex = EditorView.domEventHandlers({
  paste(event, view) {
    // ⇧⌘V, or a paste the Markdown paste kept literal (math, a comment, the preamble): plain text.
    if (plainPasteEvents.has(event)) return false;
    const html = event.clipboardData?.getData("text/html");
    if (!html || view.state.readOnly) return false;
    if (insideMathOrVerbatim(view, view.state.selection.main.from)) return false;
    const latex = htmlToLatex(html);
    if (latex === null) return false;
    event.preventDefault();
    if (utf8Length(latex) > LARGE_PASTE_BYTES) insertLargeText(view, latex, { userEvent: "input.paste" });
    else view.dispatch(view.state.replaceSelection(latex), { userEvent: "input.paste", scrollIntoView: true });
    return true;
  },
});
