"use client";

import { Play, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { useContentTrust, type MarkdownCodeBlock } from "@/components/markdown-renderer";
import { safeImageUrl, type ContentTrust } from "@/lib/markdown-sanitize";
import {
  SLIDE_THEME_TOKENS,
  buildSlideChartConfig,
  isSlideChartDataFile,
  parseSlideChartCsv,
  parseSlideChartSpec,
  slideChartInlineTable,
  slideSeriesPalette,
  type SlideChartTable,
} from "@/lib/slide-charts";
import { buildSlideDiagramConfig, slideDiagramErrorMessage } from "@/lib/slide-diagrams";

export type SlideBlockMode = "export" | "presenter" | "preview";

type SlideBlockProps = {
  /** Where the block sits, for its labels: a slide, or a note in a notebook. */
  context?: "note" | "slide";
  documentPath?: string;
  fontFamily?: string;
  mode: SlideBlockMode;
  source: string;
  theme: string;
};

/** Set on a chart or frame until it has drawn; PDF export waits for none to remain. */
export const SLIDE_BLOCK_PENDING_ATTRIBUTE = "data-slide-block-pending";
const FRAME_READY_TIMEOUT_MS = 6000;

function themeTokens(theme: string) {
  return SLIDE_THEME_TOKENS[theme] ?? SLIDE_THEME_TOKENS.light;
}

/** Canvas resolution: slides are scaled up in the presenter and printed in export. */
function chartPixelRatio(mode: SlideBlockMode) {
  const base = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  return mode === "preview" ? base : Math.min(4, Math.max(3, base * 2));
}

/** A path relative to the deck's folder, as a workspace path (no escaping the notebook). */
function resolveDeckRelativePath(documentPath: string, relative: string) {
  const parts = documentPath.split("/").slice(0, -1);
  const notebookDepth = 1;

  for (const segment of relative.trim().split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > notebookDepth) parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join("/");
}

function BlockMessage({ children }: { children: string }) {
  return (
    <div className="markdown-slide-block-message">
      <TriangleAlert aria-hidden className="h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** The chart's data as a table for screen readers (identity is never color alone). */
function ChartDataTable({ table, title }: { table: SlideChartTable; title?: string }) {
  return (
    <table className="sr-only">
      {title ? <caption>{title}</caption> : null}
      <thead>
        <tr>
          <th />
          {table.series.map((series) => (
            <th key={series.name}>{series.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.labels.map((label, row) => (
          <tr key={`${label}:${row}`}>
            <th>{label}</th>
            {table.series.map((series) => (
              <td key={series.name}>{series.values[row] ?? ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A ```chart block: settings and data in YAML or JSON, drawn with Chart.js
 * in the slide's theme. Data only, so it renders in every notebook.
 */
export function SlideChart({ documentPath, fontFamily, mode, source, theme }: SlideBlockProps) {
  const parsed = useMemo(() => parseSlideChartSpec(source), [source]);
  const spec = "spec" in parsed ? parsed.spec : null;
  const inlineTable = useMemo(() => (spec ? slideChartInlineTable(spec) : null), [spec]);
  const dataFile = spec && isSlideChartDataFile(spec.data) ? spec.data!.trim() : null;
  const [fileData, setFileData] = useState<{ key: string; table?: SlideChartTable; error?: string } | null>(null);
  const fileKey = dataFile && documentPath ? resolveDeckRelativePath(documentPath, dataFile) : null;
  const fileState = fileData && fileData.key === fileKey ? fileData : null;
  const table = dataFile ? fileState?.table ?? null : inlineTable;
  const error = "error" in parsed ? parsed.error : dataFile && !documentPath ? "Save the deck to read chart data from a file." : fileState?.error;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!fileKey) return;
    let canceled = false;

    fetch(`/api/files/raw/${encodeFilePath(fileKey)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not read ${dataFile} (${response.status}).`);
        return parseSlideChartCsv(await response.text());
      })
      .then((nextTable) => {
        if (!canceled) setFileData({ key: fileKey, table: nextTable });
      })
      .catch((reason: unknown) => {
        if (!canceled) setFileData({ key: fileKey, error: reason instanceof Error ? reason.message : String(reason) });
      });

    return () => {
      canceled = true;
    };
  }, [dataFile, fileKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;

    if (!spec || !canvas || !wrapper || (!table && !spec.datasets)) {
      return;
    }

    let canceled = false;
    let chart: { destroy: () => void } | null = null;
    wrapper.setAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE, "true");

    void import("chart.js/auto").then(({ Chart }) => {
      if (canceled) return;
      const tokens = themeTokens(theme);
      const config = buildSlideChartConfig(spec, table, tokens, { animate: mode === "presenter" });

      Chart.defaults.font.family = fontFamily ?? getComputedStyle(wrapper).fontFamily;
      (config.options as Record<string, unknown>).devicePixelRatio = chartPixelRatio(mode);
      chart = new Chart(canvas, config as never);
      requestAnimationFrame(() => wrapper.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE));
    });

    return () => {
      canceled = true;
      chart?.destroy();
      wrapper.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE);
    };
  }, [fontFamily, mode, spec, table, theme]);

  if (error) {
    return <BlockMessage>{error}</BlockMessage>;
  }

  return (
    <div
      ref={wrapperRef}
      className="markdown-slide-chart"
      style={{ height: spec?.height }}
      {...{ [SLIDE_BLOCK_PENDING_ATTRIBUTE]: "true" }}
    >
      <canvas ref={canvasRef} role="img" aria-label={spec?.title ?? "Chart"} />
      {table ? <ChartDataTable table={table} title={spec?.title} /> : null}
    </div>
  );
}

let diagramQueue: Promise<unknown> = Promise.resolve();
let diagramSequence = 0;

const DIAGRAM_IMAGE_ATTRIBUTES = ["src", "href", "xlink:href"];

/**
 * Whether an image in a diagram label may load. Strict mode still allows
 * <img> in labels, so a shared notebook's diagrams load only https: images
 * (as with its Markdown images, a collaborator cannot make readers fetch a
 * local route); a relative path would resolve against the app, not the
 * notebook, so it never loads.
 */
function diagramImageAllowed(url: string, trust: ContentTrust) {
  if (trust === "shared") return /^https:\/\//i.test(url.trim());
  return safeImageUrl(url, "local") !== null;
}

/**
 * One diagram's SVG. Mermaid's configuration is global, so renders take
 * turns: configure for this block's theme, then draw. The SVG goes into the
 * page, so on top of Mermaid's strict mode it is sanitized again here.
 */
function renderDiagram(source: string, config: ReturnType<typeof buildSlideDiagramConfig>, trust: ContentTrust) {
  const run = diagramQueue.then(async () => {
    const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import("mermaid"), import("dompurify")]);
    mermaid.initialize(config);
    const { svg } = await mermaid.render(`libera-diagram-${++diagramSequence}`, source);
    // The hook is DOMPurify's global state; sanitizing is synchronous, so it applies to this call only.
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (!/^(img|image)$/i.test(node.nodeName)) return;
      for (const name of DIAGRAM_IMAGE_ATTRIBUTES) {
        const value = node.getAttribute(name);
        if (value !== null && !diagramImageAllowed(value, trust)) node.removeAttribute(name);
      }
    });
    try {
      return DOMPurify.sanitize(svg, {
        ADD_TAGS: ["foreignObject"],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
      });
    } finally {
      DOMPurify.removeHook("afterSanitizeAttributes");
    }
  });
  diagramQueue = run.catch(() => undefined);
  return run;
}

/**
 * A ```mermaid block: a flowchart, sequence, class, state, ER, Gantt, pie,
 * mind map, timeline or other Mermaid diagram, drawn as SVG in the slide's
 * theme. Mermaid runs in strict mode (no scripts, click handlers or HTML in
 * labels), so diagrams render in every notebook, shared ones included.
 */
export function SlideDiagram({ documentPath, fontFamily, source, theme }: SlideBlockProps) {
  const trust = useContentTrust(documentPath);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const key = `${theme}\n${trust}\n${fontFamily ?? ""}\n${source}`;
  // The last drawing stays up while the next one renders, so editing does not flicker.
  const [result, setResult] = useState<{ key: string; svg?: string; error?: string } | null>(null);

  useEffect(() => {
    let canceled = false;
    // Lettered like the text around it: a slide's body size, or a note's.
    const style = wrapperRef.current ? getComputedStyle(wrapperRef.current) : null;
    const family = fontFamily ?? style?.fontFamily ?? "sans-serif";

    renderDiagram(source, buildSlideDiagramConfig(themeTokens(theme), family, style?.fontSize), trust).then(
      (svg) => {
        if (!canceled) setResult({ key, svg });
      },
      (reason: unknown) => {
        if (!canceled) setResult({ key, error: slideDiagramErrorMessage(reason) });
      },
    );

    return () => {
      canceled = true;
    };
  }, [fontFamily, key, source, theme, trust]);

  return (
    <div
      ref={wrapperRef}
      className="markdown-slide-diagram"
      {...(result?.key === key ? {} : { [SLIDE_BLOCK_PENDING_ATTRIBUTE]: "true" })}
    >
      {result?.error ? <BlockMessage>{result.error}</BlockMessage> : null}
      {result?.svg ? <div dangerouslySetInnerHTML={{ __html: result.svg }} /> : null}
    </div>
  );
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

let chartLibrary: Promise<string> | null = null;

/**
 * Chart.js's browser build as text, fetched once. A sandboxed frame has an
 * opaque origin and cannot load scripts from the app, so it gets the library
 * inline.
 */
function loadChartLibrary() {
  chartLibrary ??= fetch("/api/slide-libraries/chart")
    .then((response) => (response.ok ? response.text() : ""))
    .catch(() => "");
  return chartLibrary.then((text) => {
    if (!text) chartLibrary = null;
    return text;
  });
}

/** Script text safe to place inside <script>…</script>. */
function inlineScript(text: string) {
  return text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function frameDocument({
  allowNetwork,
  chartSource,
  fontFamily,
  frameId,
  mode,
  source,
  theme,
}: {
  allowNetwork: boolean;
  chartSource: string;
  fontFamily?: string;
  frameId: string;
  mode: SlideBlockMode;
  source: string;
  theme: string;
}) {
  const tokens = themeTokens(theme);
  const net = allowNetwork ? " https:" : "";
  // The frame runs the author's code with an opaque origin: no cookies, no
  // app APIs, no parent access. Shared notebooks also get no network.
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    allowNetwork ? "connect-src https:" : "",
  ]
    .filter(Boolean)
    .join("; ");
  const settings = JSON.stringify({
    colors: slideSeriesPalette(tokens.dark),
    frameId,
    mode,
    pixelRatio: chartPixelRatio(mode),
    theme: { ...tokens, name: theme },
  }).replace(/</g, "\\u003c");
  const font = fontFamily ?? "system-ui, -apple-system, 'Segoe UI', sans-serif";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<style>
html,body{margin:0;padding:0;background:transparent;color:${tokens.foreground};font:16px/1.5 ${font};color-scheme:${tokens.dark ? "dark" : "light"};overflow:hidden}
*,*::before,*::after{box-sizing:border-box}
</style>
<script>(() => {
  const settings = ${settings};
  const post = (message) => parent.postMessage({ ...message, liberaSlideFrame: settings.frameId }, "*");
  let lastHeight = 0;
  const report = () => {
    const body = document.body;
    if (!body) return;
    const height = Math.ceil(body.scrollHeight);
    if (height !== lastHeight) { lastHeight = height; post({ type: "height", height }); }
  };
  window.libera = { colors: settings.colors, mode: settings.mode, theme: settings.theme };
  document.addEventListener("DOMContentLoaded", () => { new ResizeObserver(report).observe(document.body); report(); });
  let loaded = false;
  // Browsers pause animation frames in offscreen frames, and Chart.js sizes
  // its canvases in one, so a chart that starts offscreen stays 0x0 until
  // something resizes it. Resize every chart directly, then measure.
  const resizeCharts = () => {
    if (window.Chart) Object.values(window.Chart.instances).forEach((chart) => chart.resize());
  };
  window.addEventListener("load", () => setTimeout(() => { loaded = true; resizeCharts(); report(); post({ type: "ready" }); }, 60));
  // The slide asks again once it is listening, and whenever the frame comes into view.
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data !== "libera:report") return;
    resizeCharts();
    lastHeight = 0;
    report();
    if (loaded) post({ type: "ready" });
  });
  window.addEventListener("error", (event) => post({ type: "error", message: String(event.message || "Script error") }));
  if (settings.mode === "presenter") {
    window.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      post({ type: "key", key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey });
    });
  }
  window.__liberaSettings = settings;
})();</script>
<script>${inlineScript(chartSource)}</script>
<script>(() => {
  const settings = window.__liberaSettings;
  if (!window.Chart) return;
  const defaults = window.Chart.defaults;
  defaults.color = settings.theme.muted;
  defaults.borderColor = settings.theme.rule;
  defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
  defaults.devicePixelRatio = settings.pixelRatio;
  if (settings.mode !== "presenter") defaults.animation = false;
})();</script>
</head><body>
${source}
</body></html>`;
}

let frameSequence = 0;

/**
 * A ```html live block: the author's HTML, CSS and JavaScript in a sandboxed
 * frame, with Chart.js loaded (`Chart`) and the slide's palette as
 * `libera.colors` and `libera.theme`. It grows to fit its content unless the
 * block sets `height=…`. In a shared notebook it runs only when the reader
 * asks, and never with network access.
 */
export function SlideLiveHtml({ context = "slide", documentPath, fontFamily, meta, mode, source, theme }: SlideBlockProps & { meta?: string }) {
  const trust = useContentTrust(documentPath);
  const [runShared, setRunShared] = useState(false);
  const [frameId] = useState(() => `slide-frame-${++frameSequence}`);
  const [height, setHeight] = useState<number | null>(null);
  // Keyed by document, so an error goes away once the code changes.
  const [scriptError, setScriptError] = useState<{ doc: string; message: string } | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Browsers can leave a sandboxed frame without layout when it starts out
  // hidden or offscreen, so the frame mounts once it is first in view (PDF
  // export scrolls each one into view), and a frame that never reports a
  // size after coming into view is replaced with a new one.
  const [inView, setInView] = useState(false);
  const [generation, setGeneration] = useState(0);
  const sizedRef = useRef(false);
  const replacementsRef = useRef(0);
  const fixedHeight = Number(/\bheight=(\d+)/.exec(meta ?? "")?.[1]) || null;
  const allowed = trust === "local" || runShared;
  const [chartSource, setChartSource] = useState<string | null>(null);
  const srcDoc = useMemo(
    () =>
      allowed && chartSource !== null
        ? frameDocument({
            allowNetwork: trust === "local",
            chartSource,
            fontFamily,
            frameId,
            mode,
            source,
            theme,
          })
        : "",
    [allowed, chartSource, fontFamily, frameId, mode, source, theme, trust],
  );

  useEffect(() => {
    if (!allowed) return;
    let canceled = false;
    void loadChartLibrary().then((text) => {
      if (!canceled) setChartSource(text);
    });
    return () => {
      canceled = true;
    };
  }, [allowed]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (inView || !wrapper) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setInView(true);
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [inView]);

  // A layout effect, so the listener is in place before the frame can report.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    sizedRef.current = false;
    if (!srcDoc) {
      // Still fetching the chart library: export must wait for this frame.
      frame.setAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE, "true");
      return;
    }

    frame.setAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE, "true");
    const timeout = window.setTimeout(() => frame.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE), FRAME_READY_TIMEOUT_MS);

    function handleMessage(event: MessageEvent) {
      const data = event.data as { liberaSlideFrame?: string; type?: string; height?: unknown; message?: unknown; key?: unknown } | null;
      if (!frame || event.source !== frame.contentWindow || data?.liberaSlideFrame !== frameId) return;

      if (data.type === "height" && typeof data.height === "number") {
        sizedRef.current = true;
        setHeight(Math.min(Math.max(data.height, 24), 4000));
      } else if (data.type === "ready") {
        frame.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE);
      } else if (data.type === "error") {
        setScriptError({ doc: srcDoc, message: String(data.message) });
      } else if (data.type === "key" && typeof data.key === "string") {
        // Keys pressed inside the frame still drive the presentation.
        const key = data as unknown as KeyboardEventInit;
        window.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      }
    }

    window.addEventListener("message", handleMessage);
    // Coming into view: have the frame size its charts and measure again.
    let replaceTimer = 0;
    const visibility = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      frame.contentWindow?.postMessage("libera:report", "*");
      window.clearTimeout(replaceTimer);
      replaceTimer = window.setTimeout(() => {
        if (!sizedRef.current && replacementsRef.current < 2) {
          replacementsRef.current += 1;
          setGeneration((current) => current + 1);
        }
      }, 1500);
    });
    visibility.observe(frame);
    return () => {
      visibility.disconnect();
      window.clearTimeout(replaceTimer);
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      frame.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE);
    };
  }, [frameId, generation, inView, srcDoc]);

  if (!allowed) {
    return (
      <div className="markdown-slide-live-gate">
        <p>{`This ${context === "note" ? "block" : "slide"} has interactive HTML from a shared notebook.`}</p>
        {mode === "export" ? null : (
          <button type="button" onClick={() => setRunShared(true)}>
            <Play aria-hidden className="h-3.5 w-3.5" />
            Run it (without network access)
          </button>
        )}
      </div>
    );
  }

  if (!inView) {
    return (
      <div
        ref={wrapperRef}
        className="markdown-slide-live"
        style={{ height: fixedHeight ?? height ?? 160 }}
        {...(mode === "export" ? { [SLIDE_BLOCK_PENDING_ATTRIBUTE]: "true" } : {})}
      />
    );
  }

  return (
    <div ref={wrapperRef} className="markdown-slide-live">
      <iframe
        key={generation}
        ref={frameRef}
        className="markdown-slide-live-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={(event) => event.currentTarget.contentWindow?.postMessage("libera:report", "*")}
        style={{ height: fixedHeight ?? height ?? 160 }}
        title={context === "note" ? "Interactive content" : "Interactive slide content"}
      />
      {scriptError?.doc === srcDoc && mode !== "export" ? <BlockMessage>{`Script error: ${scriptError.message}`}</BlockMessage> : null}
    </div>
  );
}

const LIVE_META = /(?:^|\s)live(?:\s|$)/;

/** Whether a fenced block renders live: ```chart, ```mermaid, or ```html with `live` in its info string. */
export function isLiveCodeBlock(language: string | undefined, meta: string | undefined) {
  return language === "chart" || language === "mermaid" || (language === "html" && LIVE_META.test(meta ?? ""));
}

/** The renderer for a live block (see isLiveCodeBlock), in a slide or a note. */
export function SlideLiveBlock({ language, meta, ...props }: SlideBlockProps & { language?: string; meta?: string }) {
  if (language === "chart") return <SlideChart {...props} />;
  if (language === "mermaid") return <SlideDiagram {...props} />;
  return <SlideLiveHtml {...props} meta={meta} />;
}

function subscribeAppTheme(listener: () => void) {
  // ThemeSync and PDF export both toggle the root's `dark` class.
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
  return () => observer.disconnect();
}

/** The app's light or dark theme, as a slide theme name (notes follow the app). */
function useAppSlideTheme() {
  return useSyncExternalStore(
    subscribeAppTheme,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
}

/**
 * A ```chart, ```mermaid or ```html live block in a note: the slide
 * renderers, themed like the app instead of a deck.
 */
export function NotebookLiveBlock({
  block,
  documentPath,
  fontFamily,
  mode = "preview",
}: {
  block: MarkdownCodeBlock;
  documentPath?: string;
  fontFamily?: string;
  mode?: SlideBlockMode;
}) {
  const theme = useAppSlideTheme();
  const props = { context: "note" as const, documentPath, fontFamily, mode, source: block.code, theme };

  return (
    <div className="markdown-notebook-block">
      <SlideLiveBlock {...props} language={block.language} meta={block.meta} />
    </div>
  );
}

/** MarkdownRenderer's renderCodeBlock for notes: live blocks render, other code stays code. */
export function useNotebookCodeBlockRenderer(documentPath: string | undefined, fontFamily: string | undefined, mode: SlideBlockMode = "preview") {
  return useCallback(
    (block: MarkdownCodeBlock) =>
      isLiveCodeBlock(block.language, block.meta) ? (
        <NotebookLiveBlock block={block} documentPath={documentPath} fontFamily={fontFamily} mode={mode} />
      ) : null,
    [documentPath, fontFamily, mode],
  );
}

function waitUntil(done: () => boolean, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (done()) resolve(true);
      else if (Date.now() - startedAt > timeoutMs) resolve(false);
      else window.setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Resolve once no chart or frame under `root` is still drawing (PDF export).
 * Live frames only lay out on screen, so each pending block is scrolled into
 * view in turn; one that never finishes is given up on after `perBlockMs`.
 */
export async function waitForSlideBlocksReady(root: HTMLElement, { perBlockMs = 6000, totalMs = 90000 } = {}) {
  const selector = `[${SLIDE_BLOCK_PENDING_ATTRIBUTE}]`;
  const deadline = Date.now() + totalMs;

  for (let pending = root.querySelector<HTMLElement>(selector); pending && Date.now() < deadline; pending = root.querySelector<HTMLElement>(selector)) {
    const block = pending;
    block.scrollIntoView({ block: "center" });
    const finished = await waitUntil(() => !block.isConnected || !block.hasAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE), Math.min(perBlockMs, deadline - Date.now()));
    if (!finished) block.removeAttribute(SLIDE_BLOCK_PENDING_ATTRIBUTE);
  }

  window.scrollTo(0, 0);
}
