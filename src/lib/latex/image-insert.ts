/* Images pasted or dropped into a .tex file: where the file is saved in the
 * project, what it is called, and the figure that shows it. Pure, so the
 * editor's paste and drop handlers stay thin (latex-image-drop.ts). The
 * preamble is never edited: a missing graphics package is only reported. */

/** Formats `\includegraphics` reads with every engine, and SVG, which the svg package's `\includesvg` reads. */
export type LatexImageExtension = "png" | "jpg" | "pdf" | "svg";

const TYPE_EXTENSIONS: Record<string, LatexImageExtension> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

const NAME_EXTENSION = /\.(png|jpe?g|pdf|svg)$/i;

/** The extension a file is saved with, or null when LaTeX cannot include it (GIF, WebP, BMP…). */
export function latexImageExtension(name: string, type: string): LatexImageExtension | null {
  const fromName = NAME_EXTENSION.exec(name)?.[1]?.toLowerCase();
  if (fromName) return fromName === "jpeg" ? "jpg" : fromName as LatexImageExtension;
  // A name with another extension (photo.webp) is not trusted over its type, nor its type over it.
  if (/\.[A-Za-z0-9]{1,5}$/.test(name)) return null;
  return TYPE_EXTENSIONS[type.toLowerCase()] ?? null;
}

/** Whether a file looks like an image or PDF at all (so a dropped .txt is left to the editor). */
export function looksLikeImageFile(name: string, type: string) {
  return type.startsWith("image/") || type === "application/pdf" || /\.(png|jpe?g|pdf|svg|gif|webp|bmp|tiff?|heic)$/i.test(name);
}

/**
 * A file name TeX reads without trouble: ASCII letters, digits, `-` and `_`,
 * no spaces and a single dot (graphicx takes the text after the first dot of
 * some names for the extension). Accents are dropped, runs of anything else
 * become one `-`. Never empty.
 */
export function sanitizeImageBaseName(name: string) {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const clean = stem.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 60).replace(/[-_]+$/, "");
  return clean || "image";
}

/** The name a clipboard image without one gets: `pasted-image-20261110-142501`. */
export function pastedImageBaseName(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `pasted-image-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Folders papers keep their graphics in, in the order one is preferred when several exist. */
export const IMAGE_FOLDERS = ["figures", "figs", "fig", "images", "imgs", "img", "graphics", "plots"];

/**
 * The folder, relative to the main file's folder, an image is saved in: an
 * existing figures/images folder of the project (one that holds files), else
 * the main file's own folder (""). `files` are notebook paths; `rootDirectory`
 * is the main file's folder as a notebook path.
 */
export function chooseImageFolder(rootDirectory: string, files: Iterable<string>) {
  const prefix = rootDirectory ? `${rootDirectory}/` : "";
  const present = new Map<string, string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const folder = rest.slice(0, slash);
    if (!present.has(folder.toLowerCase())) present.set(folder.toLowerCase(), folder);
  }
  for (const folder of IMAGE_FOLDERS) {
    const found = present.get(folder);
    if (found) return found;
  }
  return "";
}

/**
 * A file name in `folder` that no file has yet: `name.png`, then `name-2.png`…
 * `taken` holds paths relative to the main file's folder; compared without
 * case, as on macOS and Windows disks.
 */
export function uniqueImageName(base: string, extension: LatexImageExtension, folder: string, taken: Iterable<string>) {
  const used = new Set([...taken].map((path) => path.toLowerCase()));
  const at = (name: string) => (folder ? `${folder}/${name}` : name);
  for (let index = 1; ; index++) {
    const name = `${base}${index === 1 ? "" : `-${index}`}.${extension}`;
    if (!used.has(at(name).toLowerCase())) return name;
  }
}

/** `fig:<name>`, or null when the document or the project already has that label. */
export function figureLabelFor(base: string, labels: Iterable<string>) {
  const label = `fig:${base}`;
  for (const existing of labels) if (existing === label) return null;
  return label;
}

/**
 * The figure for a saved image. `path` is relative to the main file's folder,
 * as TeX resolves it. SVG goes through the svg package's `\includesvg`, which
 * takes the name without its extension; `\includegraphics` cannot read SVG.
 */
export function imageFigureLatex({ path, label }: { path: string; label: string | null }) {
  const svg = /\.svg$/i.test(path);
  const include = svg
    ? `\\includesvg[width=0.8\\linewidth]{${path.replace(/\.svg$/i, "")}}`
    : `\\includegraphics[width=0.8\\linewidth]{${path}}`;
  return [
    "\\begin{figure}[htbp]",
    "\t\\centering",
    `\t${include}`,
    "\t\\caption{}",
    ...(label ? [`\t\\label{${label}}`] : []),
    "\\end{figure}",
  ].join("\n");
}

/** Where the caret goes after inserting `latex`: inside the empty `\caption{}`. */
export function captionCaretOffset(latex: string) {
  const at = latex.indexOf("\\caption{}");
  return at < 0 ? latex.length : at + "\\caption{".length;
}

/**
 * The `\usepackage` lines the figures need and the preamble does not load,
 * for the notice to list (never added). `packages` are the loaded packages
 * with those classes and packages imply (markdown-paste/context.ts); without a
 * known `\documentclass` nothing can be said, so nothing is listed.
 */
export function missingImagePackages(info: { documentClass: string | null; packages: { has(name: string): boolean } }, paths: string[]) {
  if (!info.documentClass) return [];
  const missing: string[] = [];
  const graphics = info.packages.has("graphicx") || info.packages.has("graphics") || info.packages.has("svg");
  if (!graphics && paths.some((path) => !/\.svg$/i.test(path))) missing.push("\\usepackage{graphicx}");
  if (!info.packages.has("svg") && paths.some((path) => /\.svg$/i.test(path))) missing.push("\\usepackage{svg}");
  return missing;
}
