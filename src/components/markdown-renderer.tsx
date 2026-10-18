"use client";
import { markdownBoxStyle } from "@/lib/markdown-boxes";

import type { CSSProperties } from "react";
import { memo, useCallback, useMemo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PreviewCitation, PreviewSourcePosition } from "@/lib/markdown-preview-patch";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import type { Root } from "hast";
import type { PluggableList } from "unified";
import { markdownRehypeOptions, markdownRemarkPlugins } from "@/lib/markdown-rendering";
import rehypeKatex from "rehype-katex";
import type { MathMarkerSettings } from "@/lib/math-markers";
import {
  normalizeMarkdownHighlightDelimiters,
} from "@/lib/markdown-highlights";
import {
  isSafeMarkdownTextColor,
} from "@/lib/markdown-colors";
import {
  isExternalMarkdownLink,
  isLikelyWorkspaceMarkdownLink,
} from "@/lib/markdown-file-links";
import { rehypeLiberaSanitize, type ContentTrust } from "@/lib/markdown-sanitize";
import { getCollabBridge } from "@/lib/collab/ui/bridge";
import { getCollabStatusStore } from "@/lib/collab/ui/status-store";
import {
  CitationDocumentContext,
  REFERENCES_PENDING_ATTRIBUTE,
  documentCitationsFromPreview,
  documentCitationsFromSource,
  useCitationScope,
  useFormattedCitations,
  useReferenceRender,
  type CitationDocumentValue,
} from "@/components/libera/references/reference-render-context";
import { CitationChip } from "@/components/libera/references/citation-chip";
import { BibliographyBlock } from "@/components/libera/references/bibliography-block";

type MarkdownRendererProps = {
  mathMarkers?: MathMarkerSettings;
  copyAsMarkdown?: boolean;
  baseFontSize?: number;
  baseLineHeight?: number;
  className?: string;
  content: string;
  preparedTree?: Root;
  preparedSources?: PreviewSourcePosition[];
  /** The prepared tree's citations, in order (from the preview worker). */
  preparedCitations?: PreviewCitation[];
  /** This document's index in a surrounding CitationScope (slides). */
  citationScopeIndex?: number;
  documentPath?: string;
  fontFamily?: string;
  onOpenExternalLink?: (href: string) => void;
  onOpenFileLink?: (href: string) => Promise<boolean>;
  textScale?: number;
  renderImages?: boolean;
  /**
   * "shared" renders collaborator content with the strict image policy
   * (markdown-sanitize.ts). When omitted, a document whose top-level
   * notebook is a shared project counts as shared.
   */
  contentTrust?: ContentTrust;
};

const NO_SUBSCRIPTION = () => () => {};

/**
 * Whether documentPath belongs to a shared notebook, from the collaboration
 * status the shell already keeps. Without the collaboration bridge (plain
 * browser, collaboration off, tests) nothing is subscribed and every note is
 * local, so non-shared rendering is untouched. While the status is still
 * loading, a path is treated as shared: a collaborator's image must not load
 * before the check can say no.
 */
function useContentTrust(documentPath: string | undefined, explicit: ContentTrust | undefined): ContentTrust {
  const store = explicit === undefined && documentPath && getCollabBridge() ? getCollabStatusStore() : null;
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]);
  const notebook = documentPath?.replace(/^\/+/, "").split("/")[0] ?? "";
  const getSnapshot = useCallback((): ContentTrust => {
    if (!store) return "local";
    const snapshot = store.getSnapshot();
    if (snapshot.phase === "disabled") return "local";
    if (!snapshot.status) return snapshot.phase === "loading" ? "shared" : "local";
    return snapshot.status.projects.some((project) => project.notebook === notebook) ? "shared" : "local";
  }, [store, notebook]);
  const detected = useSyncExternalStore(store ? subscribe : NO_SUBSCRIPTION, getSnapshot, () => "local" as ContentTrust);
  return explicit ?? detected;
}

function resolveMarkdownImageSource(src: string | undefined, documentPath: string | undefined) {
  if (
    !src ||
    !documentPath ||
    src.startsWith("#") ||
    src.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(src)
  ) {
    return src;
  }

  return `/api/markdown-assets/raw?document=${encodeURIComponent(
    documentPath,
  )}&asset=${encodeURIComponent(src)}`;
}

function tableCellStyle(align: unknown): CSSProperties | undefined {
  if (align === "left" || align === "center" || align === "right") {
    return { textAlign: align };
  }

  return undefined;
}

function classNames(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function markdownHeadingClassName(level: number, className: string | undefined) {
  return classNames(
    level === 1
      ? "mb-4 text-[calc(1.875rem*var(--markdown-text-scale))] font-semibold tracking-tight text-foreground"
      : undefined,
    level === 2
      ? "mb-3 mt-8 text-[calc(1.25rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level === 3
      ? "mb-3 mt-7 text-[calc(1.125rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level === 4
      ? "mb-2 mt-6 text-[calc(1rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level >= 5
      ? "mb-2 mt-5 text-[calc(1rem*var(--markdown-text-scale))] font-semibold leading-7 text-foreground"
      : undefined,
    className,
  );
}

function markdownElementProps<T extends { node?: unknown }>(props: T) {
  const { node, ...elementProps } = props;

  void node;

  return elementProps;
}

function dataAttribute(
  props: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = props[key];

  return typeof value === "string" ? value : undefined;
}

function parseExtendedMarkdownHeading(children: unknown) {
  if (typeof children !== "string") {
    return null;
  }

  const match = children.match(/^(#{7,10})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);

  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2],
  };
}

function openExternalLink(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

function markdownUrlTransform(url: string, key: string) {
  return key === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(url) ? url : defaultUrlTransform(url);
}

// Separate React work units let typing interrupt a large preview update.
// Reused worker blocks also skip conversion and reconciliation altogether.
// The worker already sanitized the block; it is sanitized again here with
// this document's trust (the worker does not know whether it is shared).
const PreparedMarkdownBlock = memo(function PreparedMarkdownBlock({ node, components, trust }: { node: Root["children"][number]; components: Components; trust: ContentTrust }) {
  const plugins = useMemo<PluggableList>(
    () => [() => () => ({ type: "root", children: [structuredClone(node)] }), [rehypeLiberaSanitize, { trust }]],
    [node, trust],
  );
  return <ReactMarkdown urlTransform={markdownUrlTransform} rehypePlugins={plugins} components={components}>{""}</ReactMarkdown>;
});

function MarkdownRendererContent({
  mathMarkers,
  copyAsMarkdown = false,
  baseFontSize = 16,
  baseLineHeight = 1.75,
  className,
  content,
  preparedTree,
  preparedSources,
  preparedCitations,
  citationScopeIndex,
  documentPath,
  fontFamily,
  onOpenExternalLink,
  onOpenFileLink,
  textScale = 1,
  renderImages = true,
  contentTrust,
}: MarkdownRendererProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trust = useContentTrust(documentPath, contentTrust);
  const citationDocument = useCitationDocumentValue({ content, mathMarkers, preparedTree, preparedCitations, citationScopeIndex });
  // KaTeX first: its output is part of what the sanitizer allows.
  const rehypePlugins = useMemo<PluggableList>(() => [rehypeKatex, [rehypeLiberaSanitize, { trust }]], [trust]);
  const configuredRemarkPlugins = useMemo(() => preparedTree ? [] : markdownRemarkPlugins(mathMarkers), [mathMarkers, preparedTree]);
  const normalizedContent = useMemo(
    () => preparedTree ? "" : normalizeMarkdownHighlightDelimiters(content),
    [content, preparedTree],
  );
  const bodyFontSize = baseFontSize * textScale;
  const scaledFontStyle = {
    fontFamily,
    "--markdown-body-font-size": `${bodyFontSize}px`,
    "--markdown-body-line-height": `${baseFontSize * baseLineHeight * textScale}px`,
    "--markdown-h1-font-size": `${bodyFontSize * 1.875}px`,
    "--markdown-h2-font-size": `${bodyFontSize * 1.25}px`,
    "--markdown-h3-font-size": `${bodyFontSize * 1.125}px`,
    "--markdown-small-font-size": `${bodyFontSize * 0.875}px`,
  } as CSSProperties;

  // Stable component types let React update existing preview nodes instead of
  // remounting every paragraph, table and equation after each source edit.
  const components = useMemo<Components>(() => ({
          h1: ({ children, className, ...props }) => (
            <h1
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(1, className)}
            >
              {children}
            </h1>
          ),
          h2: ({ children, className, ...props }) => (
            <h2
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(2, className)}
            >
              {children}
            </h2>
          ),
          h3: ({ children, className, ...props }) => (
            <h3
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(3, className)}
            >
              {children}
            </h3>
          ),
          h4: ({ children, className, ...props }) => (
            <h4
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(4, className)}
            >
              {children}
            </h4>
          ),
          h5: ({ children, className, ...props }) => (
            <h5
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(5, className)}
            >
              {children}
            </h5>
          ),
          h6: ({ children, className, ...props }) => (
            <h6
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(6, className)}
            >
              {children}
            </h6>
          ),
          p: ({ children, className, ...props }) => {
            const extendedHeading = parseExtendedMarkdownHeading(children);

            if (extendedHeading) {
              return (
                <div
                  {...markdownElementProps(props)}
                  aria-level={extendedHeading.level}
                  className={markdownHeadingClassName(
                    extendedHeading.level,
                    className,
                  )}
                  role="heading"
                >
                  {extendedHeading.text}
                </div>
              );
            }

            return (
              <p
                {...markdownElementProps(props)}
                className={classNames(
                  "mb-4 text-[calc(1rem*var(--markdown-text-scale))] leading-7 text-foreground",
                  className,
                )}
              >
                {children}
              </p>
            );
          },
          blockquote: ({ children, className, ...props }) => (
            <blockquote
              {...markdownElementProps(props)}
              style={markdownBoxStyle(dataAttribute(props, "data-box-color") ?? "")}
              className={classNames(
                "mb-4 border-l-4 border-input bg-muted py-3 pl-4 pr-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground [&>p:last-child]:mb-0",
                className,
              )}
            >
              {children}
            </blockquote>
          ),
          ul: ({ children, className, ...props }) => (
            <ul
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 list-disc space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </ul>
          ),
          ol: ({ children, className, ...props }) => (
            <ol
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 list-decimal space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </ol>
          ),
          code: ({ children, className, ...props }) => (
            <code
              {...markdownElementProps(props)}
              className={classNames(
                "rounded bg-muted px-1.5 py-0.5 font-mono text-[calc(0.875rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </code>
          ),
          mark: ({ children, className, style, ...props }) => {
            const elementProps = markdownElementProps(props);
            const highlightColor = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-highlight-color",
            );
            const highlightForeground = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-highlight-foreground",
            );
            const customHighlightStyle =
              highlightColor &&
              highlightForeground &&
              isSafeMarkdownTextColor(highlightColor) &&
              isSafeMarkdownTextColor(highlightForeground)
                ? {
                    ...style,
                    backgroundColor: highlightColor,
                    color: highlightForeground,
                  }
                : style;

            return (
              <mark
                {...elementProps}
                className={classNames(
                  "box-decoration-clone rounded bg-[var(--markdown-highlight)] px-1 py-0.5 text-[var(--markdown-highlight-foreground)]",
                  className,
                )}
                style={customHighlightStyle}
              >
                {children}
              </mark>
            );
          },
          span: ({ children, className, style, ...props }) => {
            const elementProps = markdownElementProps(props);
            if (className?.split(" ").includes("libera-citation")) {
              return <CitationChip {...elementProps} className={className}>{children}</CitationChip>;
            }
            const attributes = elementProps as Record<string, unknown>;
            const fontSize = Number(attributes["data-font-size"]);
            const lineHeight = Number(attributes["data-line-height"]);
            const markdownColor = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-color",
            );
            const textColor =
              markdownColor && isSafeMarkdownTextColor(markdownColor)
                ? markdownColor
                : undefined;

            return (
              <span
                {...elementProps}
                className={classNames(
                  textColor ? "markdown-text-color" : undefined,
                  className,
                )}
                style={{
                  ...style,
                  ...(textColor ? { color: textColor } : {}),
                  ...(fontSize >= 8 && fontSize <= 96 ? { fontSize: `${fontSize * textScale}px` } : {}),
                  ...(lineHeight >= 1 && lineHeight <= 3 ? { lineHeight } : {}),
                }}
              >
                {children}
              </span>
            );
          },
          section: ({ children, className, ...props }) => {
            const elementProps = markdownElementProps(props);
            if ((elementProps as Record<string, unknown>)["data-libera-bibliography"] !== undefined) {
              return <BibliographyBlock {...elementProps} />;
            }
            return <section {...elementProps} className={className}>{children}</section>;
          },
          u: ({ children, className, ...props }) => (
            <u
              {...markdownElementProps(props)}
              className={classNames(
                "underline decoration-foreground/60 underline-offset-2",
                className,
              )}
            >
              {children}
            </u>
          ),
          table: ({ children, className, ...props }) => (
            <div className="mb-4 overflow-x-auto rounded-lg border border-border">
              <table
                {...markdownElementProps(props)}
                className={classNames(
                  "w-full border-collapse text-left text-[calc(0.875rem*var(--markdown-text-scale))]",
                  className,
                )}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children, className, ...props }) => (
            <thead
              {...markdownElementProps(props)}
              className={classNames("bg-muted text-foreground", className)}
            >
              {children}
            </thead>
          ),
          th: ({ align, children, className, ...props }) => (
            <th
              {...markdownElementProps(props)}
              className={classNames(
                "border-b border-r border-border px-3 py-2 font-semibold last:border-r-0",
                className,
              )}
              style={tableCellStyle(align)}
            >
              {children}
            </th>
          ),
          td: ({ align, children, className, ...props }) => (
            <td
              {...markdownElementProps(props)}
              className={classNames(
                "border-b border-r border-border px-3 py-2 align-top text-foreground last:border-r-0",
                className,
              )}
              style={tableCellStyle(align)}
            >
              {children}
            </td>
          ),
          tr: ({ children, className, ...props }) => (
            <tr
              {...markdownElementProps(props)}
              className={classNames("last:[&>td]:border-b-0", className)}
            >
              {children}
            </tr>
          ),
          img: ({ alt, className, src, ...props }) => renderImages ? (
            // eslint-disable-next-line @next/next/no-img-element -- Markdown images may be authenticated local assets.
            <img
              {...markdownElementProps(props)}
              className={classNames(
                "my-4 max-h-[560px] max-w-full rounded-lg border border-border object-contain",
                className,
              )}
              src={resolveMarkdownImageSource(
                typeof src === "string" ? src : undefined,
                documentPath,
              )}
              alt={alt ?? ""}
            />
          ) : null,
          a: ({ children, className, href, ...props }) => (
            <a
              {...markdownElementProps(props)}
              className={classNames(
                "font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:text-accent",
                className,
              )}
              href={href}
              onClick={(event) => {
                if (!href) {
                  return;
                }

                if (onOpenFileLink && isLikelyWorkspaceMarkdownLink(href)) {
                  event.preventDefault();
                  void onOpenFileLink(href);
                  return;
                }

                if (isExternalMarkdownLink(href)) {
                  event.preventDefault();
                  (onOpenExternalLink ?? openExternalLink)(href);
                }
              }}
            >
              {children}
            </a>
          ),
  }), [documentPath, onOpenFileLink, onOpenExternalLink, renderImages, textScale]);

  useLayoutEffect(() => {
    if (!preparedSources || !rootRef.current) return;
    const positions = new Map(preparedSources.map((source) => [source.id, source]));
    for (const element of rootRef.current.querySelectorAll<HTMLElement>("[data-preview-source-id]")) {
      const source = positions.get(element.dataset.previewSourceId!);
      if (!source) continue;
      if (element.dataset.sourceStart !== source.start) element.dataset.sourceStart = source.start;
      if (element.dataset.sourceEnd !== source.end) element.dataset.sourceEnd = source.end;
    }
  }, [preparedSources, preparedTree, components]);

  const pendingAttribute = { [REFERENCES_PENDING_ATTRIBUTE]: citationDocument?.formatting.pending ? "true" : undefined };
  return (
    <div
      ref={rootRef} className={classNames("markdown-renderer", className)} style={scaledFontStyle} data-copy-markdown={copyAsMarkdown ? "true" : undefined} {...pendingAttribute}>
      <CitationDocumentContext.Provider value={citationDocument}>
      {preparedTree ? preparedTree.children.map((node, index) => <PreparedMarkdownBlock key={index} node={node} components={components} trust={trust} />) : <ReactMarkdown
        urlTransform={markdownUrlTransform}
        remarkPlugins={configuredRemarkPlugins}
        remarkRehypeOptions={markdownRehypeOptions}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>}
      </CitationDocumentContext.Provider>
    </div>
  );
}

const NO_PREVIEW_CITATIONS: PreviewCitation[] = [];

/**
 * This document's citations and their formatting, for the chips and the
 * bibliography inside it; null without a reference render provider. Worker
 * previews list citations with their source ids, so chips in reused blocks
 * still find their place; synchronous rendering scans the source, which
 * finds the same citations at the same offsets (citation-syntax.ts). The
 * list only changes when citations or their blocks do, and formatting only
 * when the citations themselves do.
 */
function useCitationDocumentValue({ content, mathMarkers, preparedTree, preparedCitations, citationScopeIndex }: {
  content: string;
  mathMarkers?: MathMarkerSettings;
  preparedTree?: Root;
  preparedCitations?: PreviewCitation[];
  citationScopeIndex?: number;
}): CitationDocumentValue | null {
  const references = useReferenceRender();
  const scope = useCitationScope();
  const active = references !== null;
  const prepared = preparedTree ? preparedCitations ?? NO_PREVIEW_CITATIONS : null;
  const preparedKey = useMemo(() => prepared ? JSON.stringify(prepared) : null, [prepared]);
  const list = useMemo(() => {
    if (!active) return null;
    if (preparedKey !== null) return documentCitationsFromPreview(JSON.parse(preparedKey) as PreviewCitation[]);
    return documentCitationsFromSource(normalizeMarkdownHighlightDelimiters(content), mathMarkers);
  }, [active, preparedKey, content, mathMarkers]);
  const scoped = scope !== null && citationScopeIndex !== undefined;
  const own = useFormattedCitations(scoped ? null : list?.citations ?? null);
  return useMemo(() => {
    if (!list) return null;
    if (scoped) return { list, offset: scope.offsets[citationScopeIndex] ?? 0, formatting: scope.formatting, appendedBibliography: false };
    return { list, offset: 0, formatting: own, appendedBibliography: true };
  }, [list, scoped, scope, citationScopeIndex, own]);
}

export const MarkdownRenderer = memo(MarkdownRendererContent);
MarkdownRenderer.displayName = "MarkdownRenderer";
