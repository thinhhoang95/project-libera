"use client";

import { canvasToPngBlob } from "@/components/libera/screenshot-capture";
import { NOTE_LINE_HEIGHT } from "@/components/libera/text-annotation-layer";
import type { PdfNoteImage, RenderPdfNote } from "@/lib/pdf-annotation-export";
import { renderAnnotationMarkdown } from "@/lib/pdf-annotation-markdown";
import { DEFAULT_PDF_TEXT_COLOR, pdfTextFontStack } from "@/lib/pdf-annotation-style";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { PdfTextAnnotation } from "@/lib/types";

// 4× PDF points ≈ 288 DPI: crisp in print, still small per note.
const RASTER_SCALE = 4;

/*
 * An SVG image cannot load anything external, so the note's own HTML is laid
 * out by the browser inside <foreignObject> with only inline styles: the
 * app's note rules, a reset matching the app's, and native MathML for
 * equations (KaTeX's HTML output needs its web fonts, which images can't load).
 */
const BASE_CSS = `
*, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
.katex-html { display: none; }
math { font-family: math, "STIX Two Math", "Cambria Math", "Latin Modern Math", serif; }
math[display="block"] { display: block math; }
img { max-width: 100%; }
`;

function noteCss() {
  const rules: string[] = [BASE_CSS];

  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;

    try {
      cssRules = sheet.cssRules;
    } catch {
      continue;
    }

    for (const rule of Array.from(cssRules)) {
      if (/\.pdf-note-(content|body)\b/.test(rule.cssText)) {
        rules.push(rule.cssText);
      }
    }
  }

  // Never let a rule close the CDATA section it is written into.
  return rules.join("\n").replaceAll("]]>", "]] >");
}

function noteBody(annotation: PdfTextAnnotation, width: number, mathMarkers?: MathMarkerSettings) {
  const body = document.createElement("div");

  body.className = "pdf-note-body";
  Object.assign(body.style, {
    color: annotation.color ?? DEFAULT_PDF_TEXT_COLOR,
    fontFamily: pdfTextFontStack(annotation.fontFamily),
    fontSize: `${annotation.fontSize}px`,
    height: "auto",
    lineHeight: String(NOTE_LINE_HEIGHT),
    overflow: "visible",
    width: `${width}px`,
  });
  body.innerHTML = `<div class="pdf-note-content">${renderAnnotationMarkdown(annotation.text, mathMarkers)}</div>`;

  return body;
}

/** How tall the note's content is when laid out at its width, in points. */
function measureHeight(body: HTMLElement) {
  const probe = body.cloneNode(true) as HTMLElement;

  Object.assign(probe.style, { left: "-100000px", position: "fixed", top: "0", visibility: "hidden" });
  document.body.append(probe);

  try {
    return probe.scrollHeight;
  } finally {
    probe.remove();
  }
}

/**
 * Renders notes as images for burning into a PDF. A note is drawn at its box
 * size, or taller when its text runs on (the viewer clips and scrolls long
 * notes, a printed page cannot), down to the bottom of the page.
 */
export function createPdfNoteRenderer(mathMarkers?: MathMarkerSettings): RenderPdfNote {
  const css = noteCss();

  return async (annotation, box): Promise<PdfNoteImage | null> => {
    const body = noteBody(annotation, box.width, mathMarkers);
    const width = box.width;
    const height = Math.max(1, Math.min(Math.max(box.height, measureHeight(body)), box.maxHeight));
    const xhtml = new XMLSerializer().serializeToString(body);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width * RASTER_SCALE}" height="${height * RASTER_SCALE}" viewBox="0 0 ${width} ${height}">` +
      `<style><![CDATA[${css}]]></style>` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    const image = new Image();

    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * RASTER_SCALE));
    canvas.height = Math.max(1, Math.round(height * RASTER_SCALE));
    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToPngBlob(canvas);

    return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
  };
}
