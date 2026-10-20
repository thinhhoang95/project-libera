"use client";

import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { NotebookLiveBlock, isLiveCodeBlock } from "./slide-live-blocks";

// The Visual editor's code blocks. A ```chart or ```html live block keeps
// its code editable and shows what it draws underneath, as the preview does;
// every other code block renders as the plain <pre><code> it always was.

/** Typing pauses this long before the chart or frame is redrawn. */
const REDRAW_DELAY_MS = 500;

/**
 * The code block's `language` attribute is the whole Markdown info string
 * ("html live height=300"); its first word is the language.
 */
function codeBlockInfo(value: unknown) {
  const [language = "", ...meta] = String(value ?? "").trim().split(/\s+/);
  return { language: language || undefined, meta: meta.join(" ") || undefined };
}

function LiveCodeBlockView({ documentPath, node }: ReactNodeViewProps & { documentPath: string }) {
  const { language, meta } = codeBlockInfo(node.attrs.language);
  const live = isLiveCodeBlock(language, meta);
  const code = node.textContent;
  const [drawn, setDrawn] = useState(code);

  useEffect(() => {
    if (!live || code === drawn) return;
    const timer = window.setTimeout(() => setDrawn(code), REDRAW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [code, drawn, live]);

  return (
    <NodeViewWrapper>
      <pre>
        <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
      </pre>
      {live ? (
        <div className="libera-tiptap-live-block" contentEditable={false}>
          <NotebookLiveBlock block={{ code: drawn, language, meta }} documentPath={documentPath} />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function codeBlockContent(language: string, code: string) {
  return { type: "codeBlock", attrs: { language }, content: [{ type: "text", text: code }] };
}

/** Starting points for the toolbar's Insert chart and Insert interactive HTML. */
export const LIVE_BLOCK_TEMPLATES = {
  chart: codeBlockContent("chart", [
    "type: bar",
    "title: Revenue by quarter",
    "labels: [Q1, Q2, Q3, Q4]",
    "series:",
    "  2025: [12, 19, 8, 15]",
    "  2026: [14, 22, 11, 18]",
  ].join("\n")),
  // Chart.js is loaded as `Chart`; `libera.colors` and `libera.theme` follow the app theme.
  html: codeBlockContent("html live", [
    "<label>Value: <input id=\"value\" type=\"range\" min=\"0\" max=\"100\" value=\"40\"></label>",
    "<output id=\"out\">40</output>",
    "<script>",
    "  const input = document.getElementById(\"value\");",
    "  input.addEventListener(\"input\", () => { document.getElementById(\"out\").textContent = input.value; });",
    "</script>",
  ].join("\n")),
};

/** The code block node view for one document (charts read data files next to it). */
export function createLiveCodeBlockNodeView(documentPath: string) {
  function CodeBlockView(props: ReactNodeViewProps) {
    return <LiveCodeBlockView {...props} documentPath={documentPath} />;
  }
  return ReactNodeViewRenderer(CodeBlockView);
}
