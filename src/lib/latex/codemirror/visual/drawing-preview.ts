import { Facet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cropBox, documentPreamble, drawingSource, previewHash } from "../../drawing-preview";
import { macroSourcesField } from "./model";

/* The "Preview" action of a drawing placeholder (TikZ and friends, "Drawn in
 * the PDF"): on a click only, the picture is compiled on its own with the
 * project's preamble (/api/latex/preview), its page is rendered with pdf.js
 * and cropped to the ink, and the image is shown in the placeholder. Results
 * are kept by a hash of the preamble and the picture, so an unchanged picture
 * is never compiled again and a redrawn placeholder shows its image at once.
 * Nothing here changes the document. */

export type DrawingPreviewConfig = {
  /** The main file, whose folder the picture is compiled from. */
  rootPath: string;
  engine: () => string;
  /** Compiles a picture: its PDF, or an error message to show. */
  compile: (request: { rootPath: string; engine: string; preamble: string; picture: string }) => Promise<{ pdf: ArrayBuffer } | { error: string; retry?: boolean }>;
};

/** Set by the editor; without it placeholders have no Preview action. */
export const drawingPreviewConfig = Facet.define<DrawingPreviewConfig, DrawingPreviewConfig | null>({ combine: (values) => values.at(-1) ?? null });

type Result = { image: string; width: number } | { error: string };
const results = new Map<string, Result>();
const pending = new Map<string, Promise<Result>>();
const MAX_RESULTS = 80;

function remember(hash: string, result: Result) {
  results.set(hash, result);
  if (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
}

/** The preamble the picture is compiled with: the open file's, else the main file's (a chapter). */
export function previewPreamble(state: EditorState) {
  const own = documentPreamble(state.doc.sliceString(0, Math.min(state.doc.length, 400_000)));
  if (own !== null) return own;
  for (const source of state.field(macroSourcesField, false) ?? []) {
    const preamble = documentPreamble(source.text);
    if (preamble !== null) return preamble;
  }
  return null;
}

/** The PDF's first page as a PNG cropped to its ink, at about twice the page's size. */
async function renderCropped(pdfData: ArrayBuffer): Promise<Result> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfData) }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 2400 / Math.max(1, base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { error: "The preview could not be drawn." };
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const box = cropBox(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { margin: Math.round(6 * scale) });
    if (!box) return { error: "The picture compiled to an empty page." };
    const cropped = document.createElement("canvas");
    cropped.width = box.width;
    cropped.height = box.height;
    cropped.getContext("2d")!.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    // Shown at the page's own size (1 PDF point per CSS pixel), as the PDF viewer would at 100 %.
    return { image: cropped.toDataURL("image/png"), width: Math.round(box.width / scale) };
  } finally {
    void pdf.destroy();
  }
}

/** Adds the Preview action to a drawing placeholder. `floatSource` reads the float's source when called. */
export function attachDrawingPreview(view: EditorView, placeholder: HTMLElement, drawing: string, floatSource: () => string | null) {
  const config = view.state.facet(drawingPreviewConfig);
  if (!config) return;
  placeholder.dataset.drawing = drawing;
  placeholder.spellcheck = false;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-vis-drawing-preview-button";
  button.textContent = "Preview";
  button.title = "Compile this picture on its own with the document's preamble";
  button.style.cssText = "margin-top:0.25em;font:inherit;font-size:0.8em;padding:0.1em 0.6em;border:1px solid currentColor;border-radius:0.4em;opacity:0.75;cursor:pointer;background:none;color:inherit";
  const output = document.createElement("span");
  output.className = "cm-vis-drawing-preview";
  output.style.cssText = "display:block;max-width:100%";
  placeholder.append(button, output);

  /** What to compile, read from the document as it is now. */
  const request = (): { error: string } | { preamble: string; picture: string; engine: string; hash: string } => {
    const preamble = previewPreamble(view.state);
    if (preamble === null) return { error: "No preamble found to compile the picture with." };
    const figure = placeholder.closest(".cm-vis-figure");
    const same = figure ? Array.from(figure.querySelectorAll<HTMLElement>(".cm-vis-figure-drawing")).filter((other) => other.dataset.drawing === drawing) : [placeholder];
    const source = floatSource();
    const picture = source === null ? null : drawingSource(source, drawing, Math.max(0, same.indexOf(placeholder)));
    if (!picture) return { error: "The picture's source could not be found." };
    const engine = config.engine();
    return { preamble, picture, engine, hash: previewHash(engine, config.rootPath, preamble, picture) };
  };

  const show = (result: Result) => {
    if ("error" in result) {
      const message = document.createElement("span");
      message.className = "cm-vis-drawing-preview-error";
      message.style.cssText = "display:block;font-size:0.8em;opacity:0.8;white-space:normal";
      message.textContent = result.error;
      output.replaceChildren(message);
      button.textContent = "Retry";
      return;
    }
    const image = document.createElement("img");
    image.src = result.image;
    image.alt = "Preview of the picture";
    image.style.cssText = `display:block;max-width:100%;width:${result.width}px;height:auto;margin:0.4em auto 0;background:#fff`;
    output.replaceChildren(image);
    button.textContent = "Refresh preview";
    button.title = "Compile again if the picture or the preamble changed";
  };

  // A placeholder redrawn after an edit shows its picture again if it was compiled before (no compile here).
  requestAnimationFrame(() => {
    if (!placeholder.isConnected) return;
    // Nothing was ever previewed: the lookup cannot hit, so skip slicing and hashing the document.
    if (results.size === 0) return;
    const current = request();
    if ("hash" in current) {
      const known = results.get(current.hash);
      if (known && !("error" in known)) show(known);
    }
  });

  const run = async () => {
    const current = request();
    if (!("hash" in current)) { show({ error: current.error }); return; }
    const known = results.get(current.hash);
    if (known && !("error" in known)) { show(known); return; }
    button.disabled = true;
    button.textContent = "Compiling…";
    let job = pending.get(current.hash);
    if (!job) {
      job = (async (): Promise<Result> => {
        const compiled = await config.compile({ rootPath: config.rootPath, engine: current.engine, preamble: current.preamble, picture: current.picture });
        if ("error" in compiled) return { error: compiled.error };
        return renderCropped(compiled.pdf);
      })().catch((): Result => ({ error: "The preview could not be made." }));
      pending.set(current.hash, job);
      void job.then((result) => { pending.delete(current.hash); if (!("error" in result)) remember(current.hash, result); });
    }
    const result = await job;
    button.disabled = false;
    show(result);
  };
  button.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
  button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void run(); });
}
