import { strokeSamples } from "@/lib/ink/codec";
import { centerlinePath, outlinePath, strokeOutline } from "@/lib/ink/geometry";
import { dashPattern } from "@/lib/ink/tools";
import { isHexColor, type InkFrame, type InkStroke } from "@/lib/ink/types";

/*
 * Strokes as a standalone SVG: Markdown ink block renderings, overlay ink in
 * exports, and photos exported with ink. Highlighters sit in their own
 * multiply-blended group under the pens, as they do on screen.
 */

const opacityAttribute = (opacity: number) => (opacity < 1 ? ` fill-opacity="${Math.round(opacity * 1000) / 1000}"` : "");

/** One stroke's SVG element, in surface units. */
export function strokeSvgElement(stroke: InkStroke) {
  const color = isHexColor(stroke.color) ? stroke.color : "#000000";
  const samples = strokeSamples(stroke);

  if (stroke.lineStyle !== "solid") {
    const dash = dashPattern(stroke.lineStyle, stroke.width).map((value) => Math.round(value * 100) / 100).join(" ");
    const opacity = stroke.opacity < 1 ? ` stroke-opacity="${Math.round(stroke.opacity * 1000) / 1000}"` : "";
    return `<path d="${centerlinePath(samples)}" fill="none" stroke="${color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"${opacity}/>`;
  }

  const outline = outlinePath(strokeOutline(samples, stroke.brush, stroke.width));
  return outline ? `<path d="${outline}" fill="${color}"${opacityAttribute(stroke.opacity)}/>` : "";
}

/**
 * Strokes as an SVG the size of `frame`. With `view`, the SVG is the view's
 * size and strokes are drawn through its matrix: a gallery photo's ink, stored
 * on the original, over the photo as edited since.
 */
export function inkToSvg(strokes: readonly InkStroke[], frame: InkFrame, title = "Ink", view?: { width: number; height: number; matrix: readonly number[] }) {
  const highlights = strokes.filter((stroke) => stroke.brush === "highlighter").map(strokeSvgElement).join("");
  const pens = strokes.filter((stroke) => stroke.brush !== "highlighter").map(strokeSvgElement).join("");
  const safeTitle = title.replace(/[<>&"]/g, (character) => `&#${character.charCodeAt(0)};`);
  const width = view?.width ?? frame.width;
  const height = view?.height ?? frame.height;
  const transform = view ? ` transform="matrix(${view.matrix.map((value) => Math.round(value * 1e6) / 1e6).join(" ")})"` : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<title>${safeTitle}</title>`,
    `<g${transform}>`,
    highlights ? `<g style="mix-blend-mode:multiply">${highlights}</g>` : "",
    pens,
    "</g>",
    "</svg>",
  ].join("");
}
