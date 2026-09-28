import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import postcss from "postcss";

test("PDF.js measurement canvases stay hidden when two document languages share fonts", async () => {
  const dom = new JSDOM('<!doctype html><body style="display:flex;flex-direction:column"><main><div id="first"></div><div id="second"></div><canvas id="page"></canvas></main></body>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  // Exercise the real TextLayer and its shared font cache; only canvas metrics
  // are stubbed because JSDOM does not provide a drawing implementation.
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      canvas: this,
      measureText: () => ({ width: 100, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    } as unknown as CanvasRenderingContext2D;
  } as typeof dom.window.HTMLCanvasElement.prototype.getContext;

  const { TextLayer } = await import("pdfjs-dist");
  const css = postcss.parse(readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8"));
  const style = dom.window.document.createElement("style");
  // Preserve the selector so accidentally scoping this rule to a viewer fails:
  // PDF.js inserts the helpers under body, outside either document viewer.
  css.walkRules((rule) => {
    if (rule.selector.includes("hiddenCanvasElement")) style.textContent += rule.toString();
  });
  dom.window.document.head.append(style);

  try {
    for (const [id, lang] of [["first", "en"], ["second", "en-US"]]) {
      const layer = new TextLayer({
        container: dom.window.document.getElementById(id)!,
        viewport: {
          scale: 1, rotation: 0,
          rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 },
        } as ConstructorParameters<typeof TextLayer>[0]["viewport"],
        textContentSource: {
          lang,
          items: [{ str: "Shared font", dir: "ltr", width: 100, height: 12,
            transform: [12, 0, 0, 12, 40, 700], fontName: "font", hasEOL: false }],
          styles: { font: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
        },
      });
      await layer.render();
      assert.equal(layer.textDivs[0].textContent, "Shared font");
    }

    const helpers = [...dom.window.document.querySelectorAll<HTMLCanvasElement>("body > canvas.hiddenCanvasElement")];
    assert.equal(helpers.length, 2);
    assert.ok(helpers[1].width > 0 && helpers[1].height > 0,
      "A second language with cached fonts leaves an opaque canvas at its default size");
    for (const canvas of helpers) {
      assert.equal(dom.window.getComputedStyle(canvas).display, "none",
        "Font-measurement canvases must not appear as black rectangles or shrink the workspace");
    }
    assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById("page")!).display, "none",
      "Visible PDF page canvases must remain visible");
  } finally {
    TextLayer.cleanup();
    dom.window.close();
  }
});
