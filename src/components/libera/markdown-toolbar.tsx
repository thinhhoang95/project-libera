import {
  BookCheck,
  Braces,
  ChartColumn,
  Bold,
  ChevronDown,
  ChevronUp,
  Code2,
  Heading1,
  Heading2,
  Highlighter,
  ImagePlus,
  Images,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Palette,
  ScanText,
  Scissors,
  GalleryHorizontalEnd,
  Sigma,
  Sparkles,
  Strikethrough,
  Underline,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownDisplayZoom } from "@/components/libera/markdown-display-zoom";
import { useHorizontalToolbarScroll } from "./use-horizontal-toolbar-scroll";
import { ColorPalette } from "@/components/libera/color-palette";
import { LatexExportButton } from "@/components/libera/latex-export-button";
import { ExpandMacrosButton } from "./expand-macros-button";
import {
  MARKDOWN_HIGHLIGHT_COLORS,
  MARKDOWN_TEXT_COLORS,
  type MarkdownHighlightColor,
  type MarkdownTextColor,
} from "@/lib/markdown-colors";
import type { MarkdownHeadingEnumerationScope } from "@/lib/markdown-heading-enumeration";
import { detectMarkdownHeadingNumbering } from "@/lib/markdown-heading-numbering";
import { HeadingNumberingControl } from "./heading-numbering-control";
import { saveDocumentHeadingNumbering, saveHeadingNumberingSkipTitle, useHeadingNumbering } from "./heading-numbering-state";

import { ModalDialog } from "./modal-dialog";
import { MarkdownLinkInput } from "./markdown-link-input";
import { NoteLinksButton } from "./note-links-dialog";
import { TableInsertButton } from "./table-grid-picker";
import type { MarkdownSelectionLinkOption } from "./types";
import type { LiberaFileNode } from "@/lib/types";
import { FACT_CHECK_REQUEST_EVENT, type FactCheckRequestDetail } from "@/lib/references/types";
import { usePaletteCommands } from "./command-palette/commands";

type MarkdownToolbarProps = {
  files: LiberaFileNode[];
  documentPath: string;
  canStartScreenshotSnip: boolean;
  isSlideDeck?: boolean;
  markdownBaseFontSize: number;
  markdownContent: string;
  markdownZoom: number;
  onEnumerateHeadings: (
    scope: MarkdownHeadingEnumerationScope,
    startAt?: number,
  ) => void;
  /** Number every heading now, following the structural numbering rules. */
  onNumberHeadings?: () => void;
  onRemoveHeadingNumbers?: () => void;
  onFixChatGptEquations: () => void;
  onInsert: (before: string, after?: string, placeholder?: string) => void;
  onInsertTable: (rows: number, columns: number) => void;
  onInsertExistingImage: () => void;
  onInsertFromGallery?: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onMarkdownZoomChange: (zoom: number) => void;
  onStartScreenshotSnip: (mode: "image" | "markdown") => void;
  onTogglePreviewFullscreen: () => void;
  /** Opens a link written relative to this note. */
  onOpenFileLink: (href: string) => Promise<boolean>;
  previewFullscreen: boolean;
  /** An unsaved draft: fact-checking needs a saved file. */
  untitled?: boolean;
  readSelectionLinks?: () => MarkdownSelectionLinkOption[];
  /** Opens the document with its macros expanded in a new tab (markdown-macros.ts). */
  onExpandMacros?: (markdown: string) => void;
};

const HIGHLIGHT_MENU_WIDTH = 160;
const TEXT_COLOR_MENU_WIDTH = 160;
const FLOATING_MENU_GAP = 6;
const FULL_TOOLBAR_BUTTON_COUNT = 23;

/**
 * Whether Markdown may contain a citation ([@key], [-@key], @key): a cheap
 * scan that runs on every edit, unlike the full citation parser. It can say
 * yes for an "@" in code; the fact-check then reports no citations.
 */
export function mayHaveCitations(markdown: string) {
  return /(?:^|[\s[(;])-?@[\p{L}\p{N}_]/u.test(markdown);
}

/** Starts an Agent fact-check of the document's citations (the AI panel listens for the event). */
export function FactCheckButton({ documentPath, markdown, className = "toolbar-button", disabled = false }: { documentPath: string; markdown: string; className?: string; disabled?: boolean }) {
  const hasCitations = useMemo(() => mayHaveCitations(markdown), [markdown]);
  const unavailable = disabled || !hasCitations;
  return (
    <button
      aria-label="Fact-check citations"
      className={`${className} disabled:cursor-not-allowed disabled:opacity-40`}
      title={disabled ? "Save the document first" : hasCitations ? "Fact-check citations: the agent checks each citation against its source" : "Fact-check citations: this document has no citations"}
      type="button"
      disabled={unavailable}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => window.dispatchEvent(new CustomEvent<FactCheckRequestDetail>(FACT_CHECK_REQUEST_EVENT, { detail: { path: documentPath } }))}
    >
      <BookCheck aria-hidden className="h-4 w-4" />
    </button>
  );
}

function getFloatingMenuPosition(button: HTMLElement | null, width: number) {
  if (!button) {
    return null;
  }

  const rect = button.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - FLOATING_MENU_GAP;

  return {
    left: Math.max(FLOATING_MENU_GAP, Math.min(rect.left, maxLeft)),
    top: Math.min(
      rect.bottom + FLOATING_MENU_GAP,
      window.innerHeight - FLOATING_MENU_GAP,
    ),
  };
}

const MARKDOWN_BLOCK_TEMPLATES = [
  {
    id: "chart",
    title: "Insert chart",
    icon: ChartColumn,
    keywords: "graph plot bar line pie",
    language: "chart",
    placeholder: "type: bar\ntitle: Revenue by quarter\nlabels: [Q1, Q2, Q3, Q4]\nseries:\n  2025: [12, 19, 8, 15]",
  },
  {
    id: "diagram",
    title: "Insert diagram",
    icon: Workflow,
    keywords: "mermaid flowchart",
    language: "mermaid",
    placeholder: "flowchart LR\n  idea[Idea] --> draft[Draft]\n  draft --> publish[Publish]",
  },
  {
    id: "macro-block",
    title: "Insert macro block",
    icon: Braces,
    keywords: "libera-macro latex newcommand counter",
    language: "libera-macro",
    placeholder: "\\R = $\\mathbb{R}$\n\\lab = Libera Lab",
  },
];

export function MarkdownToolbar({
  files,
  documentPath,
  canStartScreenshotSnip,
  isSlideDeck = false,
  markdownBaseFontSize,
  markdownContent,
  markdownZoom,
  onEnumerateHeadings,
  onNumberHeadings = () => undefined,
  onRemoveHeadingNumbers = () => undefined,
  onFixChatGptEquations,
  onInsert,
  onInsertTable,
  onInsertExistingImage,
  onInsertFromGallery,
  onInsertImage,
  onMarkdownZoomChange,
  onStartScreenshotSnip,
  onTogglePreviewFullscreen,
  onOpenFileLink,
  previewFullscreen,
  untitled = false,
  readSelectionLinks,
  onExpandMacros,
}: MarkdownToolbarProps) {
  const [linkDraft, setLinkDraft] = useState<{ href: string; label?: string; selectionLinks?: MarkdownSelectionLinkOption[] } | null>(null);
  const toolbarRootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const toolbarMeasureRef = useRef<HTMLDivElement>(null);
  const toolbarRowRef = useRef<HTMLDivElement>(null);
  const scrollToolbarRef = useHorizontalToolbarScroll();
  const setToolbarRowRef = useCallback((element: HTMLDivElement | null) => {
    toolbarRowRef.current = element;
    const cleanup = scrollToolbarRef(element);
    return () => {
      cleanup?.();
      toolbarRowRef.current = null;
    };
  }, [scrollToolbarRef]);
  const highlightButtonRef = useRef<HTMLButtonElement>(null);
  const highlightMenuRef = useRef<HTMLDivElement>(null);
  const textColorButtonRef = useRef<HTMLButtonElement>(null);
  const textColorMenuRef = useRef<HTMLDivElement>(null);
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false);
  const [highlightMenuPosition, setHighlightMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const [textColorMenuOpen, setTextColorMenuOpen] = useState(false);
  const [textColorMenuPosition, setTextColorMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const headingNumbering = useHeadingNumbering(documentPath, () => detectMarkdownHeadingNumbering(markdownContent));
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  const getHighlightMenuPosition = useCallback(() => {
    return getFloatingMenuPosition(highlightButtonRef.current, HIGHLIGHT_MENU_WIDTH);
  }, []);

  const getTextColorMenuPosition = useCallback(() => {
    return getFloatingMenuPosition(
      textColorButtonRef.current,
      TEXT_COLOR_MENU_WIDTH,
    );
  }, []);

  useEffect(() => {
    const measure = toolbarMeasureRef.current;
    const row = toolbarRowRef.current;

    if (!measure || !row) {
      return;
    }

    function updateToolbarCollapse() {
      const measureElement = toolbarMeasureRef.current;
      const rowElement = toolbarRowRef.current;

      if (!measureElement || !rowElement) {
        return;
      }

      const nextCollapsed = measureElement.scrollWidth > rowElement.clientWidth + 1;

      setToolbarCollapsed(nextCollapsed);

      if (!nextCollapsed) {
        setToolbarExpanded(false);
      }
    }

    updateToolbarCollapse();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateToolbarCollapse);

      return () => window.removeEventListener("resize", updateToolbarCollapse);
    }

    const observer = new ResizeObserver(updateToolbarCollapse);

    observer.observe(measure);
    observer.observe(row);
    window.addEventListener("resize", updateToolbarCollapse);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateToolbarCollapse);
    };
  }, []);

  useEffect(() => {
    if (!highlightMenuOpen && !textColorMenuOpen) {
      return;
    }

    function closeOpenMenus(event: PointerEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        (highlightButtonRef.current?.contains(target) ||
          highlightMenuRef.current?.contains(target) ||
          textColorButtonRef.current?.contains(target) ||
          textColorMenuRef.current?.contains(target))
      ) {
        return;
      }

      setHighlightMenuOpen(false);
      setTextColorMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHighlightMenuOpen(false);
        setTextColorMenuOpen(false);
      }
    }

    function repositionOpenMenus() {
      if (highlightMenuOpen) {
        const nextPosition = getHighlightMenuPosition();

        if (nextPosition) {
          setHighlightMenuPosition(nextPosition);
        }
      }

      if (textColorMenuOpen) {
        const nextPosition = getTextColorMenuPosition();

        if (nextPosition) {
          setTextColorMenuPosition(nextPosition);
        }
      }
    }

    window.addEventListener("pointerdown", closeOpenMenus);
    window.addEventListener("scroll", repositionOpenMenus, true);
    window.addEventListener("resize", repositionOpenMenus);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeOpenMenus);
      window.removeEventListener("scroll", repositionOpenMenus, true);
      window.removeEventListener("resize", repositionOpenMenus);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    getHighlightMenuPosition,
    getTextColorMenuPosition,
    highlightMenuOpen,
    textColorMenuOpen,
  ]);

  // Choices inside the toolbar's menus, for the command palette; its buttons are read from the page.
  usePaletteCommands(toolbarRootRef, () => [
    ...MARKDOWN_HIGHLIGHT_COLORS.map((color) => ({
      id: `markdown:highlight:${color.shortcut}`,
      title: `Highlight: ${color.label}`,
      group: "Markdown formatting",
      icon: Highlighter,
      run: () => insertHighlight(color),
    })),
    ...MARKDOWN_TEXT_COLORS.map((color) => ({
      id: `markdown:text-color:${color.value}`,
      title: `Text color: ${color.label}`,
      group: "Markdown formatting",
      icon: Palette,
      run: () => insertTextColor(color),
    })),
    ...MARKDOWN_BLOCK_TEMPLATES.map((block) => ({
      id: `markdown:insert-${block.id}`,
      title: block.title,
      group: "Markdown formatting",
      icon: block.icon,
      keywords: block.keywords,
      run: () => onInsert(`\n\`\`\`${block.language}\n`, "\n```\n", block.placeholder),
    })),
    {
      id: "markdown:enumerate-all-headings",
      title: "Enumerate all headings",
      group: "Markdown formatting",
      icon: ListOrdered,
      keywords: "number headings",
      run: onNumberHeadings,
    },
  ]);

  function toggleHighlightMenu() {
    if (highlightMenuOpen) {
      setHighlightMenuOpen(false);
      return;
    }

    const nextPosition = getHighlightMenuPosition();

    if (nextPosition) {
      setHighlightMenuPosition(nextPosition);
    }

    setTextColorMenuOpen(false);
    setHighlightMenuOpen(true);
  }

  function toggleTextColorMenu() {
    if (textColorMenuOpen) {
      setTextColorMenuOpen(false);
      return;
    }

    const nextPosition = getTextColorMenuPosition();

    if (nextPosition) {
      setTextColorMenuPosition(nextPosition);
    }

    setHighlightMenuOpen(false);
    setTextColorMenuOpen(true);
  }

  function toggleToolbarExpanded() {
    setHighlightMenuOpen(false);
    setTextColorMenuOpen(false);
    setToolbarExpanded((current) => !current);
  }

  function insertHighlight(color: MarkdownHighlightColor) {
    setHighlightMenuOpen(false);
    onInsert(`${color.shortcut}>>> `, " <<<", `${color.label.toLowerCase()} highlight`);
  }

  function insertTextColor(color: MarkdownTextColor) {
    setTextColorMenuOpen(false);
    onInsert(`[color=${color.value}]`, "[/color]", "colored text");
  }

  const fullscreenLabel = isSlideDeck
    ? previewFullscreen
      ? "Exit presentation"
      : "Present slides"
    : previewFullscreen
      ? "Exit preview-only mode"
      : "Preview only";

  async function handleImageChange() {
    const file = imageInputRef.current?.files?.[0];

    if (!file) {
      return;
    }

    await onInsertImage(file);

    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  function renderSecondaryControls() {
    return (
      <>
        <select
          aria-label="Box color"
          title="Apply a box to the current or selected lines"
          className="h-9 shrink-0 rounded-md border border-border bg-card px-2 text-xs"
          value=""
          onChange={(event) => onInsert(`${event.target.value === "default" ? "" : event.target.value}> `, "", "Box text")}
        >
          <option value="" disabled>Box color</option>
          <option value="default">Default grey box</option>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => (
            <option key={color.shortcut} value={color.shortcut}>{color.label} box</option>
          ))}
        </select>
        <button
          aria-label="Insert image from file"
          className="toolbar-button"
          title="Insert image from file"
          type="button"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImagePlus aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Insert existing image"
          className="toolbar-button"
          title="Insert an image already in this notebook"
          type="button"
          onClick={onInsertExistingImage}
        >
          <Images aria-hidden className="h-4 w-4" />
        </button>
        {onInsertFromGallery ? (
          <button
            aria-label="Insert image from gallery"
            className="toolbar-button"
            title="Insert images from the photo gallery"
            type="button"
            onClick={onInsertFromGallery}
          >
            <GalleryHorizontalEnd aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
        <button
          aria-label="Snip from image or PDF tab"
          className="toolbar-button disabled:cursor-not-allowed disabled:opacity-40"
          title={
            canStartScreenshotSnip
              ? "Snip from image or PDF tab"
              : "Open an image or PDF tab to snip"
          }
          type="button"
          disabled={!canStartScreenshotSnip}
          onClick={() => onStartScreenshotSnip("image")}
        >
          <Scissors aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Snip as Markdown"
          className="toolbar-button disabled:cursor-not-allowed disabled:opacity-40"
          title={
            canStartScreenshotSnip
              ? "Snip as Markdown: read a region of an image or PDF tab into text"
              : "Open an image or PDF tab to snip"
          }
          type="button"
          disabled={!canStartScreenshotSnip}
          onClick={() => onStartScreenshotSnip("markdown")}
        >
          <ScanText aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Inline code"
          className="toolbar-button"
          title="Inline code"
          type="button"
          onClick={() => onInsert("`", "`", "code")}
        >
          <Code2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Math block"
          className="toolbar-button"
          title="Math block"
          type="button"
          onClick={() => onInsert("$$\n", "\n$$", "x = y")}
        >
          <Sigma aria-hidden className="h-4 w-4" />
        </button>
        <TableInsertButton className="toolbar-button" onPick={onInsertTable} />
        <button
          aria-label="Fix ChatGPT equations"
          className="toolbar-button"
          title="Fix ChatGPT equations"
          type="button"
          onClick={onFixChatGptEquations}
        >
          <Sparkles aria-hidden className="h-4 w-4" />
        </button>
        <HeadingNumberingControl
          buttonClassName="toolbar-button"
          enabled={headingNumbering.enabled}
          skipTitle={headingNumbering.skipTitle}
          onEnumerateSelected={(startAt) => onEnumerateHeadings("selected", startAt)}
          onNumberAll={onNumberHeadings}
          onRemoveAll={() => {
            saveDocumentHeadingNumbering(documentPath, false);
            onRemoveHeadingNumbers();
          }}
          onSkipTitleChange={saveHeadingNumberingSkipTitle}
          onToggle={(enabled) => saveDocumentHeadingNumbering(documentPath, enabled)}
        />
        <MarkdownDisplayZoom markdownBaseFontSize={markdownBaseFontSize} markdownZoom={markdownZoom} onMarkdownZoomChange={onMarkdownZoomChange} />
      </>
    );
  }

  function renderFullscreenButton() {
    return (
      <button
        aria-label={fullscreenLabel}
        className="toolbar-button"
        type="button"
        aria-pressed={previewFullscreen}
        title={fullscreenLabel}
        onClick={onTogglePreviewFullscreen}
      >
        {previewFullscreen ? (
          <Minimize2 aria-hidden className="h-4 w-4" />
        ) : (
          <Maximize2 aria-hidden className="h-4 w-4" />
        )}
      </button>
    );
  }

  return (
    <div ref={toolbarRootRef} className="libera-editor-toolbar relative z-40 border-b border-border bg-card px-4 py-2">
      <ModalDialog open={!!linkDraft} title="Insert link" onClose={() => setLinkDraft(null)} footer={
        <button type="button" className="rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-40" disabled={!linkDraft?.href.trim()} onClick={() => {
          if (!linkDraft?.href.trim()) return;
          const href = linkDraft.href.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E");
          onInsert("[", `](${href})`, (linkDraft.label ?? "link").replace(/[\[\]\\]/g, "\\$&"));
          setLinkDraft(null);
        }}>Insert link</button>
      }>
        <MarkdownLinkInput files={files} markdown={markdownContent} sourcePath={documentPath} value={linkDraft?.href ?? ""} selectionLinks={linkDraft?.selectionLinks} onChange={(href, label) => setLinkDraft((current) => ({ ...current, href, label }))} />
      </ModalDialog>
      <input
        ref={imageInputRef}
        className="hidden"
        type="file"
        accept=".png,.jpg,.jpeg,.gif,.webp"
        onChange={() => void handleImageChange()}
      />
      <div
        ref={toolbarMeasureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-4 top-2 flex max-w-none items-center gap-2 whitespace-nowrap"
      >
        {Array.from({ length: FULL_TOOLBAR_BUTTON_COUNT }, (_, index) => (
          <span className="toolbar-button" key={index} />
        ))}
        <span className="inline-flex h-9 w-56 shrink-0" />
        <span className="inline-flex h-9 w-36 shrink-0" />
      </div>
      <div
        ref={setToolbarRowRef}
        role="toolbar"
        aria-label="Markdown formatting"
        tabIndex={0}
        className="libera-horizontal-toolbar flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap"
      >
        <button
          aria-label="Bold"
          className="toolbar-button"
          title="Bold (Ctrl/Cmd+B)"
          type="button"
          onClick={() => onInsert("**", "**")}
        >
          <Bold aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Italic"
          className="toolbar-button"
          title="Italic (Ctrl/Cmd+I)"
          type="button"
          onClick={() => onInsert("_", "_")}
        >
          <Italic aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Underline"
          className="toolbar-button"
          title="Underline (Ctrl/Cmd+U)"
          type="button"
          onClick={() => onInsert("<u>", "</u>")}
        >
          <Underline aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Strikethrough"
          className="toolbar-button"
          title="Strikethrough"
          type="button"
          onClick={() => onInsert("~~", "~~")}
        >
          <Strikethrough aria-hidden className="h-4 w-4" />
        </button>
        <button
          ref={highlightButtonRef}
          aria-expanded={highlightMenuOpen}
          aria-haspopup="listbox"
          aria-label="Highlight"
          className="toolbar-button"
          title="Highlight"
          type="button"
          onClick={toggleHighlightMenu}
        >
          <Highlighter aria-hidden className="h-4 w-4" />
        </button>
        {highlightMenuOpen ? (
          <div
            ref={highlightMenuRef}
            className="fixed z-50 w-40 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-1 shadow-lg"
            style={{
              left: highlightMenuPosition.left,
              top: highlightMenuPosition.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ColorPalette
              ariaLabel="Highlight colors"
              colors={MARKDOWN_HIGHLIGHT_COLORS}
              optionLabel="highlight color"
              onSelect={insertHighlight}
            />
          </div>
        ) : null}
        <button
          ref={textColorButtonRef}
          aria-expanded={textColorMenuOpen}
          aria-haspopup="listbox"
          aria-label="Text color"
          className="toolbar-button"
          title="Text color"
          type="button"
          onClick={toggleTextColorMenu}
        >
          <Palette aria-hidden className="h-4 w-4" />
        </button>
        {textColorMenuOpen ? (
          <div
            ref={textColorMenuRef}
            className="fixed z-50 w-40 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-1 shadow-lg"
            style={{
              left: textColorMenuPosition.left,
              top: textColorMenuPosition.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ColorPalette
              ariaLabel="Text colors"
              colors={MARKDOWN_TEXT_COLORS}
              optionLabel="text color"
              onSelect={insertTextColor}
            />
          </div>
        ) : null}
        <button
          aria-label="Heading 1"
          className="toolbar-button"
          title="Heading 1"
          type="button"
          onClick={() => onInsert("# ", "", "Heading")}
        >
          <Heading1 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Heading 2"
          className="toolbar-button"
          title="Heading 2"
          type="button"
          onClick={() => onInsert("## ", "", "Heading")}
        >
          <Heading2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Bulleted list"
          className="toolbar-button"
          title="Bulleted list"
          type="button"
          onClick={() => onInsert("- ", "", "List item")}
        >
          <List aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Link"
          className="toolbar-button"
          title="Link"
          type="button"
          onClick={() => setLinkDraft({ href: "", selectionLinks: readSelectionLinks?.() })}
        >
          <Link aria-hidden className="h-4 w-4" />
        </button>
        <NoteLinksButton
          className="toolbar-button"
          documentPath={documentPath}
          files={files}
          getContent={() => markdownContent}
          onOpenLink={onOpenFileLink}
        />
        {toolbarCollapsed ? (
          <button
            aria-expanded={toolbarExpanded}
            aria-label={toolbarExpanded ? "Collapse toolbar" : "Expand toolbar"}
            className="toolbar-button"
            data-command-reveal-button=""
            title={toolbarExpanded ? "Collapse toolbar" : "Expand toolbar"}
            type="button"
            onClick={toggleToolbarExpanded}
          >
            {toolbarExpanded ? (
              <ChevronUp aria-hidden className="h-4 w-4" />
            ) : (
              <ChevronDown aria-hidden className="h-4 w-4" />
            )}
          </button>
        ) : (
          renderSecondaryControls()
        )}
        {renderFullscreenButton()}
        <FactCheckButton documentPath={documentPath} markdown={markdownContent} disabled={untitled} />
        <ExpandMacrosButton className="toolbar-button" markdown={markdownContent} getMarkdown={() => markdownContent} onExpand={onExpandMacros} />
        <LatexExportButton documentPath={documentPath} getMarkdown={() => markdownContent} />
      </div>
      {toolbarCollapsed && toolbarExpanded ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {renderSecondaryControls()}
        </div>
      ) : toolbarCollapsed ? (
        // Offstage, so the command palette still lists the tools that did not fit.
        <div hidden data-command-toolbar="Markdown formatting" data-command-reveal="">
          {renderSecondaryControls()}
        </div>
      ) : null}
    </div>
  );
}
