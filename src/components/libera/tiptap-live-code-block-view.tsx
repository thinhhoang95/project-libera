"use client";

import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MACRO_BLOCK_LANGUAGE, isMacroBlockLanguage, parseMacroDefinitions } from "@/lib/markdown-macros";
import { NotebookLiveBlock, isLiveCodeBlock } from "./slide-live-blocks";

// The Visual editor's code blocks. A ```chart, ```mermaid or ```html live block keeps
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

/**
 * A ```libera-macro block (docs/features/markdown-macros.md): a header that
 * counts its definitions and folds the block away. It starts folded when it
 * has definitions, open when it is new.
 */
function MacroBlockView({ node }: ReactNodeViewProps) {
  const code = node.textContent;
  const definitions = useMemo(() => parseMacroDefinitions(code), [code]);
  const count = definitions.macros.size;
  const [open, setOpen] = useState(() => count === 0);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <NodeViewWrapper className="libera-macro-block" data-open={open ? "true" : "false"}>
      <button type="button" contentEditable={false} className="libera-macro-block-header" aria-expanded={open} onClick={() => setOpen(!open)}
        title={open ? "Fold the macro definitions" : "Show the macro definitions"}>
        <Chevron className="size-3.5" aria-hidden />
        <span>Macros: {count} definition{count === 1 ? "" : "s"}</span>
        {definitions.errors.length ? <span className="libera-macro-block-problems">· {definitions.errors.length} problem{definitions.errors.length === 1 ? "" : "s"}</span> : null}
      </button>
      <pre hidden={!open}>
        <NodeViewContent<"code"> as="code" className={`language-${MACRO_BLOCK_LANGUAGE}`} />
      </pre>
      {open && definitions.errors.length ? (
        <ul className="libera-macro-block-errors" contentEditable={false}>
          {definitions.errors.map((error) => <li key={`${error.line}:${error.message}`}>Line {error.line}: {error.message}</li>)}
        </ul>
      ) : null}
    </NodeViewWrapper>
  );
}

function LiveCodeBlockView(props: ReactNodeViewProps & { documentPath: string }) {
  if (isMacroBlockLanguage(props.node.attrs.language)) return <MacroBlockView {...props} />;
  return <CodeBlockWithLiveView {...props} />;
}

function CodeBlockWithLiveView({ documentPath, node }: ReactNodeViewProps & { documentPath: string }) {
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

/** Starting points for the toolbar's Insert chart, Insert diagram and Insert interactive HTML. */
export const LIVE_BLOCK_TEMPLATES = {
  diagram: codeBlockContent("mermaid", [
    "flowchart LR",
    "  idea[Idea] --> draft[Draft]",
    "  draft --> review{Review}",
    "  review -->|Changes| draft",
    "  review -->|Approved| publish[Publish]",
  ].join("\n")),
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
