import type { EditorView } from "@codemirror/view";
import { insertLatexAt, isViewAlive } from "@/lib/latex/codemirror/markdown-paste";
import type { LatexImageRequest } from "@/lib/latex/codemirror/image-paste";
import { latexProjectField } from "@/lib/latex/codemirror/editing";
import { macroSourcesField } from "@/lib/latex/codemirror/visual/model";
import {
  captionCaretOffset, chooseImageFolder, figureLabelFor, imageFigureLatex, latexImageExtension, missingImagePackages, pastedImageBaseName,
  sanitizeImageBaseName, uniqueImageName,
} from "@/lib/latex/image-insert";
import { readPreambleInfo } from "@/lib/latex/markdown-paste/context";

/* Saving pasted and dropped images into the project and putting a figure
 * for each where they were pasted or dropped (image-paste.ts catches them). */

export type LatexImageSupport = {
  /** Notebook paths of the project's files, to find a figures folder and free names. */
  files: string[];
  /** Saves `file` into the folder `directory` (a notebook path); resolves to the saved file's notebook path. A taken name rejects with status 409. */
  save: (directory: string, file: File) => Promise<string>;
};

export type LatexImageInsertResult = {
  /** What to tell the user, or null after a plain success. */
  message: string | null;
  /** `\usepackage` lines the preamble lacks, offered to copy (never added). */
  missing: string[];
};

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** A file a browser names generically (a screenshot is "image.png"): named by the time instead. */
const GENERIC_NAME = /^(?:image|blob|clipboard|untitled)(?:\.[A-Za-z0-9]+)?$/i;

export async function saveAndInsertImages(request: LatexImageRequest, rootPath: string, support: LatexImageSupport): Promise<LatexImageInsertResult> {
  const { range } = request;
  const view = range.view;
  const rootDirectory = rootPath.split("/").slice(0, -1).join("/");
  const folder = chooseImageFolder(rootDirectory, support.files);
  const directory = folder ? `${rootDirectory}/${folder}` : rootDirectory;
  const prefix = rootDirectory ? `${rootDirectory}/` : "";
  const taken = new Set(support.files.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)));
  const saved: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const file of request.files) {
    const extension = latexImageExtension(file.name, file.type);
    if (!extension || file.size > MAX_IMAGE_BYTES) { skipped.push(file.name || file.type); continue; }
    const base = !file.name || GENERIC_NAME.test(file.name) ? pastedImageBaseName(new Date()) : sanitizeImageBaseName(file.name);
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const name = uniqueImageName(base, extension, folder, taken);
      const relative = folder ? `${folder}/${name}` : name;
      try {
        await support.save(directory, new File([file], name, { type: file.type, lastModified: file.lastModified || Date.now() }));
        taken.add(relative);
        saved.push(relative);
        done = true;
      } catch (error) {
        // Someone else's file has that name (not in the tree yet): try the next one.
        if ((error as { status?: number }).status === 409) { taken.add(relative); continue; }
        failed.push(error instanceof Error ? error.message : "The image could not be saved.");
        break;
      }
    }
  }
  const problems = [
    ...(skipped.length ? [`LaTeX cannot include ${skipped.join(", ")}: use PNG, JPEG, PDF or SVG.`] : []),
    ...failed.slice(0, 1),
  ];
  if (!saved.length || !isViewAlive(view)) {
    range.release();
    return { message: problems.join(" ") || null, missing: [] };
  }

  const state = view.state;
  const labels = new Set<string>(state.field(latexProjectField, false)?.labels ?? []);
  for (const match of state.doc.toString().matchAll(/\\label\s*\{([^}]*)\}/g)) labels.add(match[1].trim());
  const figures = saved.map((path) => {
    const label = figureLabelFor(path.split("/").at(-1)!.replace(/\.[^.]+$/, ""), labels);
    if (label) labels.add(label);
    return imageFigureLatex({ path, label });
  });
  const latex = figures.join("\n\n");
  const inserted = insertLatexAt(range, { latex, block: true });
  const sources = state.field(macroSourcesField, false) ?? [];
  const missing = missingImagePackages(readPreambleInfo([state.doc.toString(), ...sources.map((source) => source.text)]), saved);
  if (inserted) placeCaretInCaption(view, inserted.from, inserted.text);
  const savedNote = `Saved ${saved.length === 1 ? saved[0] : `${saved.length} images in ${folder || "the main file's folder"}`}.`;
  return {
    message: inserted ? [savedNote, ...problems].join(" ") : `${savedNote} The place it was pasted changed meanwhile, so no figure was inserted.`,
    missing: inserted ? missing : [],
  };
}

function placeCaretInCaption(view: EditorView, from: number, text: string) {
  const caret = from + captionCaretOffset(text);
  if (caret <= view.state.doc.length && view.state.sliceDoc(caret - "\\caption{".length, caret) === "\\caption{") {
    view.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
  }
  view.focus();
}
