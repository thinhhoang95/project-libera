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

export function createPythonFigureNodeView(documentPath: string): NodeViewRenderer {
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
    label.textContent = `Python · ${figure.cell}`;
    const rerun = button("Re-run", `Run the note's Python up to the cell “${figure.cell}” and update its figures`);
    const code = button("Code", `Open ${pythonSidecarPath(documentPath).split("/").pop()}`);
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
      rerun.textContent = "Running…";
      dom.classList.add("is-running");
      show("");
      void apiRequest<RunResult>("/api/python/run", { method: "POST", body: JSON.stringify({ document: documentPath, cell: figure.cell }) })
        .then((result) => {
          if (!editor.isDestroyed) applyFigures(editor, documentPath, result);
          const failed = result.cells.find((cell) => cell.error);
          if (result.timedOut) show("The run hit its time limit.");
          else if (failed?.error) show(`${failed.id ? `[${failed.id}]` : "Setup code"} failed at line ${failed.error.line ?? "?"}:\n${failed.error.traceback.split("\n").slice(-6).join("\n") || `${failed.error.type}: ${failed.error.message}`}`);
          else if (!result.figures.some((entry) => entry.cell === figure.cell && entry.index === figure.index)) show(`The cell “${figure.cell}” no longer draws this figure.`);
        })
        .catch((error: unknown) => show(error instanceof Error ? error.message : "Running Python failed."))
        .finally(() => {
          rerun.disabled = false;
          rerun.textContent = "Re-run";
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
