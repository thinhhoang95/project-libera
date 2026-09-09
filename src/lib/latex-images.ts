import { unified } from "unified";
import remarkParse from "remark-parse";
import sharp from "sharp";
import type { Root, RootContent } from "mdast";

export type LatexImage = { fileName: string; body: Buffer };
type ImageLoader = (documentPath: string, source: string) => Promise<{ body: Buffer }>;

async function loadImage(documentPath: string, source: string) {
  const data = source.match(/^data:image\/(?:png|jpe?g|gif|webp);base64,([a-z0-9+/=]+)$/i);
  if (data) return { body: Buffer.from(data[1], "base64") };
  const { getMarkdownImageAssetBySource } = await import("./storage/markdown-assets");
  return getMarkdownImageAssetBySource(documentPath, source);
}

/** Resolve images using Libera's notebook-aware asset rules, never model-supplied paths. */
export async function prepareLatexImages(markdown: string, documentPath: string, signal: AbortSignal, loader: ImageLoader = loadImage) {
  const tree = unified().use(remarkParse).parse(markdown);
  const definitions = new Map<string, string>();
  const occurrences: Array<{ start: number; end: number; source: string; alt: string }> = [];
  function walk(node: Root | RootContent, visit: (node: Root | RootContent) => void) {
    visit(node);
    if ("children" in node) for (const child of node.children) walk(child, visit);
  }
  walk(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier.toUpperCase(), node.url);
  });
  walk(tree, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "image" || node.type === "imageReference") {
      const source = node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase());
      if (source) occurrences.push({ start, end, source, alt: node.alt || "" });
    } else if (node.type === "html") {
      for (const match of node.value.matchAll(/<img\b[^>]*>/gi)) {
        const source = match[0].match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
        if (source) occurrences.push({ start: start + match.index!, end: start + match.index! + match[0].length,
          source: source.replace(/&amp;/g, "&"), alt: match[0].match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || "" });
      }
    }
  });
  const images: LatexImage[] = [];
  const names = new Map<string, string>();
  let totalBytes = 0;
  for (const occurrence of occurrences) {
    signal.throwIfAborted();
    if (names.has(occurrence.source)) continue;
    if (images.length >= 100) throw new Error("Export supports up to 100 unique images at a time.");
    try {
      const asset = await loader(documentPath, occurrence.source);
      if (asset.body.length > 20 * 1024 * 1024) throw new Error("Image exceeds 20 MB.");
      // PNG works with pdflatex, including when the original is WebP/GIF or has EXIF rotation.
      const body = await sharp(asset.body, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer();
      signal.throwIfAborted();
      totalBytes += body.length;
      if (totalBytes > 50 * 1024 * 1024) throw new Error("Combined images exceed 50 MB.");
      const fileName = `image-${images.length + 1}.png`;
      images.push({ fileName, body }); names.set(occurrence.source, fileName);
    } catch (error) {
      signal.throwIfAborted();
      const label = occurrence.source.startsWith("data:") ? "embedded image" : occurrence.source;
      throw new Error(`Could not prepare image "${label}": ${error instanceof Error ? error.message : "Image could not be read."}`);
    }
  }
  for (const occurrence of occurrences.sort((a, b) => b.start - a.start)) {
    const alt = occurrence.alt.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    markdown = markdown.slice(0, occurrence.start) + `![${alt}](${names.get(occurrence.source)})` + markdown.slice(occurrence.end);
  }
  return { markdown, images };
}

export function latexImagesPrompt(images: LatexImage[], width: number) {
  if (!images.length) return "";
  return String.raw`The following image files are available in the compilation working directory: ${images.map((image) => image.fileName).join(", ")}.
Load graphicx without the draft option. Include every image at its original position in the document with \includegraphics[width=${width}\textwidth,keepaspectratio]{image-N.png}, replacing image-N.png with the exact filename in the supplied Markdown. Center images and retain captions and numbering. Use these staged relative filenames exactly; do not invent paths, omit images, draw placeholders, or use draft mode. Preserve this image width during repairs.`;
}

export function assertLatexImagesIncluded(source: string, images: LatexImage[]) {
  const activeSource = source.replace(/(?<!\\)%[^\n]*/g, "");
  const included = new Set([...activeSource.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)].map((match) => match[1]));
  const missing = images.filter((image) => !included.has(image.fileName));
  if (missing.length) throw new Error(`Include the actual images with graphicx; these images were omitted: ${missing.map((image) => image.fileName).join(", ")}.`);
  if (/\\(?:documentclass|usepackage)\s*\[[^\]]*\bdraft\b/.test(activeSource) || /\\setkeys\s*\{Gin\}\s*\{[^}]*\bdraft\b/.test(activeSource) || /\\includegraphics\*?\s*\[[^\]]*\bdraft\b/.test(activeSource)) {
    throw new Error("Remove LaTeX draft mode so images render instead of placeholder boxes.");
  }
}
