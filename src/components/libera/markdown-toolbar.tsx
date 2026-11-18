import {
  BookCheck,
  Braces,
  ChartColumn,
  Bold,
  Code2,
  Heading1,
  Heading2,
  Highlighter,
  ImagePlus,
  Images,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Maximize2,
  Minimize2,
  Palette,
  Quote,
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
import { useTranslations } from "next-intl";
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
import { saveDocumentHeadingNumbering, saveHeadingNumberingMaxDepth, saveHeadingNumberingSkipTitle, useHeadingNumbering } from "./heading-numbering-state";

import { ModalDialog } from "./modal-dialog";
import { MarkdownLinkInput } from "./markdown-link-input";
import { NoteLinksButton } from "./note-links-dialog";
import { TableInsertButton } from "./table-grid-picker";
import type { MarkdownSelectionLinkOption } from "./types";
import type { LiberaFileNode } from "@/lib/types";
import { FACT_CHECK_REQUEST_EVENT, type FactCheckRequestDetail } from "@/lib/references/types";
import { usePaletteCommands } from "./command-palette/commands";
import { tableSizeMenu, useAppMenuEditor } from "./app-menu";

type MarkdownToolbarProps = {
  files: LiberaFileNode[];
  documentPath: string;
  canStartScreenshotSnip: boolean;
  isSlideDeck?: boolean;
  markdownContent: string;
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
  /** Indents or outdents the list item(s) under the caret or selection. */
  onShiftList?: (direction: "indent" | "outdent") => void;
  onInsertExistingImage: () => void;
  onInsertFromGallery?: () => void;
  onInsertImage: (file: File) => Promise<void>;
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
  const t = useTranslations("markdownToolbar");
  const hasCitations = useMemo(() => mayHaveCitations(markdown), [markdown]);
  const unavailable = disabled || !hasCitations;
  return (
    <button
      aria-label={t("factCheckAriaLabel")}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-40`}
      title={disabled ? t("factCheckSaveFirstTitle") : hasCitations ? t("factCheckAgentTitle") : t("factCheckNoCitationsTitle")}
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

// The placeholder is text inserted into the document, so it stays English.
const MARKDOWN_BLOCK_TEMPLATES = [
  {
    id: "chart",
    icon: ChartColumn,
    keywords: "graph plot bar line pie",
    language: "chart",
    placeholder: "type: bar\ntitle: Revenue by quarter\nlabels: [Q1, Q2, Q3, Q4]\nseries:\n  2025: [12, 19, 8, 15]",
  },
  {
    id: "diagram",
    icon: Workflow,
    keywords: "mermaid flowchart",
    language: "mermaid",
    placeholder: "flowchart LR\n  idea[Idea] --> draft[Draft]\n  draft --> publish[Publish]",
  },
  {
    id: "macro-block",
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
  markdownContent,
  onEnumerateHeadings,
  onNumberHeadings = () => undefined,
  onRemoveHeadingNumbers = () => undefined,
  onFixChatGptEquations,
  onInsert,
  onInsertTable,
  onShiftList,
  onInsertExistingImage,
  onInsertFromGallery,
  onInsertImage,
  onStartScreenshotSnip,
  onTogglePreviewFullscreen,
  onOpenFileLink,
  previewFullscreen,
  untitled = false,
  readSelectionLinks,
  onExpandMacros,
}: MarkdownToolbarProps) {
  const t = useTranslations("markdownToolbar");
  const tColor = useTranslations("lib.markdownColors.color");
  const tAppMenu = useTranslations("appMenu");
  const colorName = (color: { label: string }) => tColor(color.label.toLowerCase());
  const [linkDraft, setLinkDraft] = useState<{ href: string; label?: string; selectionLinks?: MarkdownSelectionLinkOption[] } | null>(null);
  const toolbarRootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollToolbarRef = useHorizontalToolbarScroll();
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
  const headingNumbering = useHeadingNumbering(documentPath, (maxDepth) => detectMarkdownHeadingNumbering(markdownContent, maxDepth));

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
      title: t("paletteHighlightTitle", { color: colorName(color) }),
      group: t("paletteGroupMarkdownFormatting"),
      icon: Highlighter,
      run: () => insertHighlight(color),
    })),
    ...MARKDOWN_TEXT_COLORS.map((color) => ({
      id: `markdown:text-color:${color.value}`,
      title: t("paletteTextColorTitle", { color: colorName(color) }),
      group: t("paletteGroupMarkdownFormatting"),
      icon: Palette,
      run: () => insertTextColor(color),
    })),
    ...MARKDOWN_BLOCK_TEMPLATES.map((block) => ({
      id: `markdown:insert-${block.id}`,
      title: t(`blockTitle.${block.id}`),
      group: t("paletteGroupMarkdownFormatting"),
      icon: block.icon,
      keywords: block.keywords,
      run: () => onInsert(`\n\`\`\`${block.language}\n`, "\n```\n", block.placeholder),
    })),
    {
      id: "markdown:enumerate-all-headings",
      title: t("paletteEnumerateAllHeadings"),
      group: t("paletteGroupMarkdownFormatting"),
      icon: ListOrdered,
      keywords: "number headings",
      run: onNumberHeadings,
    },
  ]);

  // The macOS menu bar's Format and Insert menus, for the Source editors (textarea and CodeMirror).
  useAppMenuEditor(toolbarRootRef, () => ({
    format: [
      { id: "bold", label: t("menuBold"), onSelect: () => onInsert("**", "**") },
      { id: "italic", label: t("menuItalic"), onSelect: () => onInsert("_", "_") },
      { id: "underline", label: t("menuUnderline"), onSelect: () => onInsert("<u>", "</u>") },
      { id: "strikethrough", label: t("menuStrikethrough"), onSelect: () => onInsert("~~", "~~") },
      { id: "inline-code", label: t("menuInlineCode"), onSelect: () => onInsert("`", "`", "code") },
      { type: "separator" },
      {
        id: "highlight",
        label: t("menuHighlight"),
        submenu: MARKDOWN_HIGHLIGHT_COLORS.map((color) => ({ id: `highlight-${color.shortcut}`, label: colorName(color), onSelect: () => insertHighlight(color) })),
      },
      {
        id: "text-color",
        label: t("menuTextColor"),
        submenu: MARKDOWN_TEXT_COLORS.map((color) => ({ id: `text-color-${color.value}`, label: colorName(color), onSelect: () => insertTextColor(color) })),
      },
      { type: "separator" },
      {
        id: "heading",
        label: t("menuHeading"),
        submenu: [1, 2, 3].map((level) => ({ id: `heading-${level}`, label: t("menuHeadingLevel", { level }), onSelect: () => onInsert(`${"#".repeat(level)} `, "", "Heading") })),
      },
      {
        id: "list",
        label: t("menuList"),
        submenu: [
          { id: "bulleted", label: t("menuBulletedList"), onSelect: () => onInsert("- ", "", "List item") },
          { id: "numbered", label: t("menuNumberedList"), onSelect: () => onInsert("1. ", "", "List item") },
          ...(onShiftList ? [
            { type: "separator" as const },
            { id: "indent", label: t("menuIndentListItem"), onSelect: () => onShiftList("indent") },
            { id: "outdent", label: t("menuOutdentListItem"), onSelect: () => onShiftList("outdent") },
          ] : []),
        ],
      },
      { id: "quote", label: t("menuQuote"), onSelect: () => onInsert("> ", "", "Quote") },
      {
        id: "box",
        label: t("menuBox"),
        submenu: [
          { id: "box-default", label: t("menuDefaultGreyBox"), onSelect: () => onInsert("> ", "", "Box text") },
          ...MARKDOWN_HIGHLIGHT_COLORS.map((color) => ({ id: `box-${color.shortcut}`, label: t("menuColorBox", { color: colorName(color) }), onSelect: () => onInsert(`${color.shortcut}> `, "", "Box text") })),
        ],
      },
      { type: "separator" },
      {
        id: "heading-numbers",
        label: t("menuHeadingNumbers"),
        submenu: [
          { id: "number-all", label: t("menuNumberAllHeadings"), onSelect: onNumberHeadings },
          {
            id: "remove-all",
            label: t("menuRemoveHeadingNumbers"),
            onSelect: () => {
              saveDocumentHeadingNumbering(documentPath, false);
              onRemoveHeadingNumbers();
            },
          },
        ],
      },
      { id: "fix-chatgpt-equations", label: t("menuFixChatGptEquations"), onSelect: onFixChatGptEquations },
    ],
    insert: [
      { id: "link", label: t("menuLink"), onSelect: () => setLinkDraft({ href: "", selectionLinks: readSelectionLinks?.() }) },
      {
        id: "image",
        label: t("menuImage"),
        submenu: [
          { id: "image-file", label: t("menuImageFromFile"), onSelect: () => imageInputRef.current?.click() },
          { id: "image-existing", label: t("menuImageFromNotebook"), onSelect: onInsertExistingImage },
          ...(onInsertFromGallery ? [{ id: "image-gallery", label: t("menuImageFromGallery"), onSelect: onInsertFromGallery }] : []),
          { type: "separator" },
          { id: "snip-image", label: t("menuSnipFromImage"), enabled: canStartScreenshotSnip, onSelect: () => onStartScreenshotSnip("image") },
          { id: "snip-markdown", label: t("menuSnipAsMarkdown"), enabled: canStartScreenshotSnip, onSelect: () => onStartScreenshotSnip("markdown") },
        ],
      },
      tableSizeMenu(onInsertTable, tAppMenu),
      { type: "separator" },
      { id: "math-block", label: t("menuMathBlock"), onSelect: () => onInsert("$$\n", "\n$$", "x = y") },
      { id: "code-block", label: t("menuCodeBlock"), onSelect: () => onInsert("\n```\n", "\n```\n", "code") },
      ...MARKDOWN_BLOCK_TEMPLATES.map((block) => ({
        id: block.id,
        label: t(`blockMenu.${block.id}`),
        onSelect: () => onInsert(`\n\`\`\`${block.language}\n`, "\n```\n", block.placeholder),
      })),
    ],
  }));

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
      ? t("exitPresentation")
      : t("presentSlides")
    : previewFullscreen
      ? t("exitPreviewOnly")
      : t("previewOnly");

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
        <button
          aria-label={t("quote")}
          className="toolbar-button"
          title={t("quoteTitle")}
          type="button"
          onClick={() => onInsert("> ", "", "Quote")}
        >
          <Quote aria-hidden className="h-4 w-4" />
        </button>
        <select
          aria-label={t("boxColor")}
          title={t("boxColorTitle")}
          className="h-9 shrink-0 rounded-md border border-border bg-card px-2 text-xs"
          value=""
          onChange={(event) => onInsert(`${event.target.value === "default" ? "" : event.target.value}> `, "", "Box text")}
        >
          <option value="" disabled>{t("boxColor")}</option>
          <option value="default">{t("defaultGreyBox")}</option>
          {MARKDOWN_HIGHLIGHT_COLORS.map((color) => (
            <option key={color.shortcut} value={color.shortcut}>{t("colorBox", { color: colorName(color) })}</option>
          ))}
        </select>
        <button
          aria-label={t("insertImageFromFile")}
          className="toolbar-button"
          title={t("insertImageFromFile")}
          type="button"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImagePlus aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("insertExistingImage")}
          className="toolbar-button"
          title={t("insertExistingImageTitle")}
          type="button"
          onClick={onInsertExistingImage}
        >
          <Images aria-hidden className="h-4 w-4" />
        </button>
        {onInsertFromGallery ? (
          <button
            aria-label={t("insertImageFromGallery")}
            className="toolbar-button"
            title={t("insertImageFromGalleryTitle")}
            type="button"
            onClick={onInsertFromGallery}
          >
            <GalleryHorizontalEnd aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
        <button
          aria-label={t("snipFromImage")}
          className="toolbar-button disabled:cursor-not-allowed disabled:opacity-40"
          title={
            canStartScreenshotSnip
              ? t("snipFromImage")
              : t("snipNeedsImageTab")
          }
          type="button"
          disabled={!canStartScreenshotSnip}
          onClick={() => onStartScreenshotSnip("image")}
        >
          <Scissors aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("snipAsMarkdown")}
          className="toolbar-button disabled:cursor-not-allowed disabled:opacity-40"
          title={
            canStartScreenshotSnip
              ? t("snipAsMarkdownTitle")
              : t("snipNeedsImageTab")
          }
          type="button"
          disabled={!canStartScreenshotSnip}
          onClick={() => onStartScreenshotSnip("markdown")}
        >
          <ScanText aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("inlineCode")}
          className="toolbar-button"
          title={t("inlineCode")}
          type="button"
          onClick={() => onInsert("`", "`", "code")}
        >
          <Code2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("mathBlock")}
          className="toolbar-button"
          title={t("mathBlock")}
          type="button"
          onClick={() => onInsert("$$\n", "\n$$", "x = y")}
        >
          <Sigma aria-hidden className="h-4 w-4" />
        </button>
        <TableInsertButton className="toolbar-button" onPick={onInsertTable} />
        <button
          aria-label={t("fixChatGptEquations")}
          className="toolbar-button"
          title={t("fixChatGptEquations")}
          type="button"
          onClick={onFixChatGptEquations}
        >
          <Sparkles aria-hidden className="h-4 w-4" />
        </button>
        <HeadingNumberingControl
          buttonClassName="toolbar-button"
          enabled={headingNumbering.enabled}
          maxDepth={headingNumbering.maxDepth ?? 0}
          skipTitle={headingNumbering.skipTitle}
          onEnumerateSelected={(startAt) => onEnumerateHeadings("selected", startAt)}
          onNumberAll={onNumberHeadings}
          onRemoveAll={() => {
            saveDocumentHeadingNumbering(documentPath, false);
            onRemoveHeadingNumbers();
          }}
          onMaxDepthChange={saveHeadingNumberingMaxDepth}
          onSkipTitleChange={saveHeadingNumberingSkipTitle}
          onToggle={(enabled) => saveDocumentHeadingNumbering(documentPath, enabled)}
        />
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
      <ModalDialog open={!!linkDraft} title={t("insertLinkTitle")} onClose={() => setLinkDraft(null)} footer={
        <button type="button" className="rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-40" disabled={!linkDraft?.href.trim()} onClick={() => {
          if (!linkDraft?.href.trim()) return;
          const href = linkDraft.href.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E");
          onInsert("[", `](${href})`, (linkDraft.label ?? "link").replace(/[\[\]\\]/g, "\\$&"));
          setLinkDraft(null);
        }}>{t("insertLinkButton")}</button>
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
        ref={scrollToolbarRef}
        role="toolbar"
        aria-label={t("toolbarAriaLabel")}
        tabIndex={0}
        className="libera-horizontal-toolbar flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap [&>*]:shrink-0"
      >
        <button
          aria-label={t("bold")}
          className="toolbar-button"
          title={t("boldTitle")}
          type="button"
          onClick={() => onInsert("**", "**")}
        >
          <Bold aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("italic")}
          className="toolbar-button"
          title={t("italicTitle")}
          type="button"
          onClick={() => onInsert("_", "_")}
        >
          <Italic aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("underline")}
          className="toolbar-button"
          title={t("underlineTitle")}
          type="button"
          onClick={() => onInsert("<u>", "</u>")}
        >
          <Underline aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("strikethrough")}
          className="toolbar-button"
          title={t("strikethrough")}
          type="button"
          onClick={() => onInsert("~~", "~~")}
        >
          <Strikethrough aria-hidden className="h-4 w-4" />
        </button>
        <button
          ref={highlightButtonRef}
          aria-expanded={highlightMenuOpen}
          aria-haspopup="listbox"
          aria-label={t("highlight")}
          className="toolbar-button"
          title={t("highlight")}
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
              ariaLabel={t("highlightColors")}
              colors={MARKDOWN_HIGHLIGHT_COLORS}
              kind="highlight"
              onSelect={insertHighlight}
            />
          </div>
        ) : null}
        <button
          ref={textColorButtonRef}
          aria-expanded={textColorMenuOpen}
          aria-haspopup="listbox"
          aria-label={t("textColor")}
          className="toolbar-button"
          title={t("textColor")}
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
              ariaLabel={t("textColors")}
              colors={MARKDOWN_TEXT_COLORS}
              kind="text"
              onSelect={insertTextColor}
            />
          </div>
        ) : null}
        <button
          aria-label={t("heading1")}
          className="toolbar-button"
          title={t("heading1")}
          type="button"
          onClick={() => onInsert("# ", "", "Heading")}
        >
          <Heading1 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("heading2")}
          className="toolbar-button"
          title={t("heading2")}
          type="button"
          onClick={() => onInsert("## ", "", "Heading")}
        >
          <Heading2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label={t("bulletedList")}
          className="toolbar-button"
          title={t("bulletedList")}
          type="button"
          onClick={() => onInsert("- ", "", "List item")}
        >
          <List aria-hidden className="h-4 w-4" />
        </button>
        {onShiftList ? (
          <>
            <button
              aria-label={t("outdentListItem")}
              className="toolbar-button"
              title={t("outdentListItem")}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onShiftList("outdent")}
            >
              <ListIndentDecrease aria-hidden className="h-4 w-4" />
            </button>
            <button
              aria-label={t("indentListItem")}
              className="toolbar-button"
              title={t("indentListItem")}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onShiftList("indent")}
            >
              <ListIndentIncrease aria-hidden className="h-4 w-4" />
            </button>
          </>
        ) : null}
        <button
          aria-label={t("link")}
          className="toolbar-button"
          title={t("link")}
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
        {renderSecondaryControls()}
        {renderFullscreenButton()}
        <FactCheckButton documentPath={documentPath} markdown={markdownContent} disabled={untitled} />
        <ExpandMacrosButton className="toolbar-button" markdown={markdownContent} getMarkdown={() => markdownContent} onExpand={onExpandMacros} />
        <LatexExportButton documentPath={documentPath} getMarkdown={() => markdownContent} />
      </div>
    </div>
  );
}
