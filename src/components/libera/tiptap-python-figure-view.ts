import type { NodeViewRenderer } from "@tiptap/core";
import { markdownAssetSource } from "@/lib/tiptap-markdown";
import { ownsPythonFigureSource, parsePythonFigureSource, pythonSidecarHref, pythonSidecarPath, type PythonFigure } from "@/lib/python/sidecar";
import { apiRequest } from "./api-client";

// The Visual editor's images. A figure made by the note's Python
// (py-<cell>.<n>.<hash>.png, see lib/python/sidecar.ts) gets a bar on hover:
// Re-run runs the sidecar up to its cell and points the note's images of
// every re-run cell at the new figures, as one undoable edit; Code opens the
// sidecar. Every other image is the plain <img> it always was.

type RunResult = {
  figures: PythonFigure[];
  completed: string[];
  previousSources?: string[];
  timedOut: boolean;
  cells: Array<{ id: string | null; line: number; error: { type: string; message: string; traceback: string; line: number | null } | null }>;
};

function plainImage(documentPath: string, attrs: Record<string, unknown>) {
  const image = document.createElement("img");
  image.src = markdownAssetSource(documentPath, String(attrs.src ?? ""));
  image.alt = String(attrs.alt ?? "");
  if (attrs.title) image.title = String(attrs.title);
  return image;
}

function button(label: string, title: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.title = title;
  return element;
}

/** Sent (bubbling) by Code with `{ href }`, the sidecar relative to the note (pythonSidecarHref); the editor opens it as it opens links. */
export const PYTHON_FIGURE_OPEN_CODE_EVENT = "libera:python-figure-open-code";

/** A translator for the "tiptapPythonFigureView" messages, passed in from the React side (node views have no hooks). */
export type PythonFigureTranslate = (key: string, values?: Record<string, string | number>) => string;

// English, for callers that pass no translator (tests, other editors).
const ENGLISH: Record<string, string> = {
  figureLabel: "Python · {cell}",
  rerunButton: "Re-run",
  codeButton: "Code",
  rerunTitle: "Run the note's Python up to the cell “{cell}” and update its figures",
  openCodeTitle: "Open {file}",
  runningLabel: "Running…",
  timeLimitMessage: "The run hit its time limit.",
  setupCode: "Setup code",
  failedMessage: "{target} failed at line {line}:\n{detail}",
  noLongerDrawsMessage: "The cell “{cell}” no longer draws this figure.",
  runFailedError: "Running Python failed.",
};
const englishTranslate: PythonFigureTranslate = (key, values = {}) => (ENGLISH[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));

export function createPythonFigureNodeView(documentPath: string, t: PythonFigureTranslate = englishTranslate): NodeViewRenderer {
  return ({ node, editor }) => {
    const image = plainImage(documentPath, node.attrs);
    const figure = parsePythonFigureSource(String(node.attrs.src ?? ""));
    if (!figure) return { dom: image };

    const dom = document.createElement("div");
    dom.className = "libera-python-figure";
    dom.contentEditable = "false";
    const bar = document.createElement("div");
    bar.className = "libera-python-figure-bar";
    const label = document.createElement("span");
    label.textContent = t("figureLabel", { cell: figure.cell });
    const rerun = button(t("rerunButton"), t("rerunTitle", { cell: figure.cell }));
    const code = button(t("codeButton"), t("openCodeTitle", { file: pythonSidecarPath(documentPath).split("/").pop() ?? "" }));
    bar.append(label, rerun, code);
    const message = document.createElement("pre");
    message.className = "libera-python-figure-message";
    message.hidden = true;
    dom.append(image, bar, message);

    const show = (text: string) => {
      message.textContent = text;
      message.hidden = !text;
    };
    // Pressing a button leaves the editor's selection where it is.
    for (const element of [rerun, code]) element.addEventListener("mousedown", (event) => event.preventDefault());

    code.addEventListener("click", () => {
      dom.dispatchEvent(new CustomEvent(PYTHON_FIGURE_OPEN_CODE_EVENT, { bubbles: true, detail: { href: pythonSidecarHref(documentPath) } }));
    });

    rerun.addEventListener("click", () => {
      if (rerun.disabled) return;
      rerun.disabled = true;
      rerun.textContent = t("runningLabel");
      dom.classList.add("is-running");
      show("");
      void apiRequest<RunResult>("/api/python/run", { method: "POST", body: JSON.stringify({ document: documentPath, cell: figure.cell }) })
        .then((result) => {
          if (!editor.isDestroyed) applyFigures(editor, documentPath, result);
          const failed = result.cells.find((cell) => cell.error);
          if (result.timedOut) show(t("timeLimitMessage"));
          else if (failed?.error) show(t("failedMessage", {
            target: failed.id ? `[${failed.id}]` : t("setupCode"),
            line: failed.error.line ?? "?",
            detail: failed.error.traceback.split("\n").slice(-6).join("\n") || `${failed.error.type}: ${failed.error.message}`,
          }));
          else if (!result.figures.some((entry) => entry.cell === figure.cell && entry.index === figure.index)) show(t("noLongerDrawsMessage", { cell: figure.cell }));
        })
        .catch((error: unknown) => show(error instanceof Error ? error.message : t("runFailedError")))
        .finally(() => {
          rerun.disabled = false;
          rerun.textContent = t("rerunButton");
          dom.classList.remove("is-running");
        });
    });

    return {
      dom,
      // Clicks in the bar are the view's own; the editor ignores them.
      stopEvent: (event) => event.target instanceof Node && (bar.contains(event.target) || message.contains(event.target)),
      ignoreMutation: () => true,
    };
  };
}

/** Points the note's images of every finished cell at its new figures, as one transaction. */
function applyFigures(editor: Parameters<NodeViewRenderer>[0]["editor"], documentPath: string, result: RunResult) {
  const next = new Map(result.figures.map((entry) => [`${entry.cell}.${entry.index}`, entry.src]));
  const completed = new Set(result.completed);
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "image") return;
    const figure = parsePythonFigureSource(String(node.attrs.src ?? ""));
    if (!figure || !completed.has(figure.cell) || !ownsPythonFigureSource(documentPath, String(node.attrs.src), result.previousSources)) return;
    const src = next.get(`${figure.cell}.${figure.index}`);
    if (src && src !== node.attrs.src) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}
