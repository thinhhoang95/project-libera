"use client";

import { startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  Bold, BookMarked, ChevronDown, Code, Columns2, Hash, Heading, Image as ImageIcon, Italic, Link, List,
  Puzzle, Quote, Sigma, SpellCheck, Superscript, Table,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { wrapSelection, type LatexProjectFile } from "@/lib/latex/codemirror/editing";
import { toggleLatexFormat } from "@/lib/latex/codemirror/visual/keys";
import { ensurePackages, insertSnippetText, insertTemplate } from "@/lib/latex/codemirror/snippets";
import {
  BIBLATEX_STYLES, BIBTEX_STYLES, CODE_LANGUAGES, bibliographyBlock, codeTemplate, figureTemplate, listTemplate, literalField,
  preambleInsertion, readBibliographySetup, restyleBibliography, sideBySideTemplate, snippetBodyFromSelection, tableTemplate,
  type BibliographyStyle,
} from "@/lib/latex/snippets";
import type { LatexEditorHandle } from "./latex-editor";
import type { LatexSnippetDialogRequest } from "./latex-snippet-dialog";
import { deleteLatexSnippet, useLatexSnippets } from "./latex-snippets-store";
import { MarkdownDisplayZoom } from "../markdown-display-zoom";
import { useMarkdownDisplayPreference, useMarkdownDisplayPreferenceActions } from "../markdown-display-preferences";
import { nativeMenuPointBelow, popupNativeMenu, type NativeMenuEntry } from "../native-menu";
import { TABLE_GRID_MENU_WIDTH, TableGridPicker } from "../table-grid-picker";
import { ToolbarMenu } from "../toolbar-menu";
import { tableSizeMenu, useAppMenuEditor } from "../app-menu";

type MenuId = "heading" | "list" | "math" | "figure" | "subfigures" | "table" | "code" | "bibliography" | "snippets";

/** The selection as the text of a one-line template field. */
const field = (selection: string, fallback: string) => literalField(selection.trim().replace(/\s*\n\s*/g, " ")) || fallback;

/** A greyed-out line naming the items below it, as a native menu has no section headings. */
const heading = (id: string, label: string): NativeMenuEntry => ({ id, label, enabled: false });

type LatexInsertToolbarProps = {
  editorRef: MutableRefObject<LatexEditorHandle | null>;
  /** Files beside this one, with paths relative to it. */
  projectFiles: LatexProjectFile[];
  onSnippetDialog: (request: LatexSnippetDialogRequest) => void;
  /** Of packages this file could not load (it has no preamble), those the main file lacks too. */
  missingInMainFile: (packages: string[]) => Promise<string[]>;
  onNotice: (message: string) => void;
  /** The editor's text size, already scaled by the shared text zoom. */
  fontSizePx: number;
  /** Whether the editor is in the Visual mode, the only one where spelling is checked. */
  visualMode?: boolean;
};

/** Insert tools for .tex files, shown in the LaTeX toolbar after Recompile:
 * formatting, structure, math, floats, code, references, bibliography and
 * saved snippets. Their menus are native ones, except the table size grid. */
export function LatexInsertToolbar({ editorRef, projectFiles, onSnippetDialog, missingInMainFile, onNotice, fontSizePx, visualMode = false }: LatexInsertToolbarProps) {
  const t = useTranslations("latex.latexInsertToolbar");
  const tStyles = useTranslations("lib.latex.snippets");
  const tAppMenu = useTranslations("appMenu");
  const textScale = useMarkdownDisplayPreference("latexTextScale");
  const latexSpellcheck = useMarkdownDisplayPreference("latexSpellcheck");
  const { updatePreferences } = useMarkdownDisplayPreferenceActions();
  const [open, setOpen] = useState<MenuId | null>(null);
  const anchors = useRef(new Map<MenuId, HTMLButtonElement>());
  const toolbarRef = useRef<HTMLDivElement>(null);
  const anchorRef = useMemo(() => ({ get current() { return open ? anchors.current.get(open) ?? null : null; } }), [open]);
  const snippets = useLatexSnippets();
  const images = projectFiles.filter((file) => file.kind === "image" || file.kind === "pdf");
  const bibFile = projectFiles.find((file) => file.kind === "bib")?.path ?? "references.bib";

  function close() { setOpen(null); }

  function reportUnavailable(packages: string[]) {
    if (!packages.length) return;
    void missingInMainFile(packages).then((missing) => {
      if (missing.length) onNotice(t("missingPackagesNotice", { packages: missing.map((name) => `\\usepackage{${name}}`).join(", ") }));
    });
  }

  /** Runs an edit on the editor, closes the menu and returns focus to the text. */
  function edit(action: (view: EditorView, selection: string) => string[] | void) {
    const view = editorRef.current?.view;
    close();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    reportUnavailable(action(view, view.state.sliceDoc(from, to)) ?? []);
    view.focus();
  }

  const template = (build: (selection: string) => string, packages: string[] = []) => edit((view, selection) => insertTemplate(view, build(selection), packages));

  /** Inserts a command with an empty argument and opens its completion list. */
  function commandWithCompletion(command: string, packages: string[] = []) {
    edit((view) => {
      const unavailable = ensurePackages(view, packages).unavailable;
      const at = view.state.selection.main.to;
      view.dispatch({ changes: { from: at, insert: `\\${command}{}` }, selection: { anchor: at + command.length + 2 }, userEvent: "input" });
      queueMicrotask(() => startCompletion(view));
      return unavailable;
    });
  }

  function applyBibliographyStyle(style: BibliographyStyle) {
    edit((view) => {
      const doc = view.state.doc.toString();
      const restyle = restyleBibliography(doc, style);
      if (restyle) {
        view.dispatch({ changes: restyle, userEvent: "input" });
        return ensurePackages(view, style.packages ?? []).unavailable;
      }
      if (style.system === "biblatex") {
        const preamble = preambleInsertion(doc, [`\\usepackage[style=${style.value}]{biblatex}`, `\\addbibresource{${bibFile}}`]);
        if (preamble) view.dispatch({ changes: preamble, userEvent: "input" });
        else onNotice(t("biblatexPreambleNotice", { style: style.value, file: bibFile }));
      }
      const unavailable = style.system === "bibtex" ? ensurePackages(view, style.packages ?? []).unavailable : [];
      insertSnippetText(view, bibliographyBlock(style, bibFile));
      return unavailable;
    });
  }

  function addSelectionAsSnippet() {
    const view = editorRef.current?.view;
    close();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const body = snippetBodyFromSelection(view.state.sliceDoc(from, to), /^[ \t]*/.exec(view.state.doc.lineAt(from).text)![0]);
    if (body.trim()) onSnippetDialog({ mode: "create", body });
  }

  async function removeSnippet(name: string, id: string) {
    if (!window.confirm(t("confirmDeleteSnippet", { name }))) return;
    try { await deleteLatexSnippet(id); } catch (reason) {
      onNotice(reason instanceof Error && reason.message ? reason.message : t("deleteSnippetError"));
    }
  }

  /**
   * A native menu's items, read from the editor as it is when the menu opens.
   * The menu bar's copy (`menuBar`) is built ahead of time, so it does not
   * depend on the selection.
   */
  function menuItems(id: Exclude<MenuId, "table">, menuBar = false): NativeMenuEntry[] {
    switch (id) {
      case "heading":
        return (["chapter", "section", "subsection", "subsubsection", "paragraph"] as const).map((command) => ({
          id: command, label: t(`headingLevel.${command}`),
          onSelect: () => template((selection) => `\\${command}{\${${field(selection, "Title")}}}\${}`),
        }));
      case "list":
        return [
          { id: "itemize", label: t("bulletedList"), onSelect: () => template((selection) => listTemplate("itemize", selection)) },
          { id: "enumerate", label: t("numberedList"), onSelect: () => template((selection) => listTemplate("enumerate", selection)) },
          { id: "description", label: t("descriptionList"), onSelect: () => template((selection) => listTemplate("description", selection)) },
        ];
      case "math":
        return [
          { id: "inline", label: t("inlineMath"), onSelect: () => template((selection) => `\\(\${${field(selection, "")}}\\)\${}`) },
          { id: "display", label: t("displayMath"), onSelect: () => template((selection) => `\\[\n\t\${${field(selection, "")}}\n\\]\${}`) },
          { id: "equation", label: t("numberedEquation"), onSelect: () => template((selection) => `\\begin{equation}\n\t\${${field(selection, "")}}\n\t\\label{eq:\${label}}\n\\end{equation}\${}`) },
          { id: "align", label: t("alignedEquations"), onSelect: () => template(() => "\\begin{align}\n\t${a} &= ${b} \\\\\n\t${c} &= ${d}\n\\end{align}${}", ["amsmath"]) },
          { id: "cases", label: t("cases"), onSelect: () => template(() => "\\begin{cases}\n\t${value} & \\text{if } ${condition} \\\\\n\t${other} & \\text{otherwise}\n\\end{cases}${}", ["amsmath"]) },
          { id: "matrix", label: t("matrix"), onSelect: () => template(() => "\\begin{pmatrix}\n\t${a} & ${b} \\\\\n\t${c} & ${d}\n\\end{pmatrix}${}", ["amsmath"]) },
          { id: "fraction", label: t("fraction"), onSelect: () => template((selection) => `\\frac{\${${field(selection, "numerator")}}}{\${denominator}}\${}`) },
        ];
      case "figure":
        return [
          { id: "empty", label: t("emptyFigure"), onSelect: () => template(() => figureTemplate(), ["graphicx"]) },
          ...(images.length ? [{ type: "separator" } as const, heading("images", t("imagesInFolder"))] : []),
          ...images.map((file) => ({ id: `image:${file.path}`, label: file.path, onSelect: () => template(() => figureTemplate(file.path), ["graphicx"]) })),
        ];
      case "subfigures":
        return [
          { id: "two", label: t("twoFiguresSideBySide"), onSelect: () => template(() => sideBySideTemplate(2), ["graphicx", "subcaption"]) },
          { id: "three", label: t("threeFiguresInRow"), onSelect: () => template(() => sideBySideTemplate(3), ["graphicx", "subcaption"]) },
        ];
      case "code":
        return [
          { id: "verbatim", label: t("verbatim"), onSelect: () => template((selection) => codeTemplate("verbatim", selection)) },
          { id: "listing", label: t("listing"), onSelect: () => template((selection) => codeTemplate("listing", selection), ["listings"]) },
          {
            id: "languages", label: t("listingInLanguage"),
            submenu: CODE_LANGUAGES.map((language) => ({ id: `language:${language}`, label: language, onSelect: () => template((selection) => codeTemplate("listing", selection, language), ["listings"]) })),
          },
        ];
      case "bibliography": {
        // A document uses BibTeX or biblatex; only its own styles can be switched to.
        const bibliography = readBibliographySetup(editorRef.current?.view.state.doc.toString() ?? "");
        const styles = (system: BibliographyStyle["system"], list: BibliographyStyle[]): NativeMenuEntry[] => list.map((style) => ({
          id: `${system}:${style.value}`, label: tStyles(`bibliographyStyles.${system}.${style.value}`), type: "checkbox",
          checked: bibliography.system === system && bibliography.style === style.value,
          enabled: !bibliography.system || bibliography.system === system,
          onSelect: () => applyBibliographyStyle(style),
        }));
        return [
          heading("bibtex", "BibTeX"), ...styles("bibtex", BIBTEX_STYLES),
          { type: "separator" },
          heading("biblatex", "biblatex"), ...styles("biblatex", BIBLATEX_STYLES),
        ];
      }
      case "snippets": {
        const selection = editorRef.current?.view.state.selection.main;
        const sorted = [...snippets].sort((left, right) => left.name.localeCompare(right.name));
        const each = (prefix: string, action: (snippet: (typeof sorted)[number]) => void) => sorted.map((snippet) => ({ id: `${prefix}:${snippet.id}`, label: `/${snippet.name}`, onSelect: () => action(snippet) }));
        return [
          ...(sorted.length
            ? each("insert", (snippet) => edit((view) => { insertSnippetText(view, snippet.body); }))
            : [heading("none", t("noSnippetsYet"))]),
          { type: "separator" },
          { id: "add", label: t("addSelectionAsSnippet"), enabled: menuBar || (!!selection && !selection.empty), onSelect: addSelectionAsSnippet },
          ...(sorted.length ? [
            { id: "rename", label: t("rename"), submenu: each("rename", (snippet) => onSnippetDialog({ mode: "rename", snippet })) },
            { id: "delete", label: t("delete"), submenu: each("delete", (snippet) => void removeSnippet(snippet.name, snippet.id)) },
          ] : []),
        ];
      }
    }
  }

  const cite = () => commandWithCompletion("cite");
  const crossReference = () => commandWithCompletion("ref");
  const footnote = () => edit((view) => { wrapSelection("footnote")(view); });
  const hyperlink = () => template((selection) => `\\href{\${https://}}{\${${field(selection, "text")}}}\${}`, ["hyperref"]);

  // The macOS menu bar's Format and Insert menus, with the toolbar's tools.
  useAppMenuEditor(toolbarRef, () => ({
    format: [
      { id: "bold", label: t("bold"), onSelect: () => edit((view) => { toggleLatexFormat("textbf")(view); }) },
      { id: "italic", label: t("italic"), onSelect: () => edit((view) => { toggleLatexFormat("textit")(view); }) },
      { type: "separator" },
      { id: "heading", label: t("heading"), submenu: menuItems("heading", true) },
      { id: "list", label: t("list"), submenu: menuItems("list", true) },
      { type: "separator" },
      { id: "bibliography", label: t("bibliographyStyle"), submenu: menuItems("bibliography", true) },
    ],
    insert: [
      { id: "math", label: t("math"), submenu: menuItems("math", true) },
      { id: "figure", label: t("figure"), submenu: menuItems("figure", true) },
      { id: "subfigures", label: t("sideBySideGraphics"), submenu: menuItems("subfigures", true) },
      tableSizeMenu((rows, columns) => template(() => tableTemplate(rows, columns), ["booktabs"]), tAppMenu),
      { id: "code", label: t("codeBlock"), submenu: menuItems("code", true) },
      { type: "separator" },
      { id: "cite", label: t("citation"), onSelect: cite },
      { id: "ref", label: t("crossReference"), onSelect: crossReference },
      { id: "footnote", label: t("footnote"), onSelect: footnote },
      { id: "hyperlink", label: t("hyperlink"), onSelect: hyperlink },
      { type: "separator" },
      { id: "snippets", label: t("snippetsMenu"), submenu: menuItems("snippets", true) },
    ],
  }));

  async function toggleMenu(id: MenuId, element: HTMLElement) {
    if (id === "table") {
      setOpen((current) => current === id ? null : id);
      return;
    }
    setOpen(id);
    await popupNativeMenu(menuItems(id), nativeMenuPointBelow(element));
    setOpen((current) => current === id ? null : current);
  }

  function button(id: MenuId | null, label: string, icon: ReactNode, onClick?: () => void, shortcut?: string) {
    const isMenu = id !== null;
    return (
      <button
        type="button"
        ref={isMenu ? (element) => { if (element) anchors.current.set(id, element); else anchors.current.delete(id); } : undefined}
        className={`libera-latex-icon-button${isMenu ? " libera-latex-menu-button" : ""}`}
        aria-label={label}
        title={shortcut ? `${label} (${shortcut})` : label}
        aria-haspopup={isMenu ? "menu" : undefined}
        aria-expanded={isMenu ? open === id : undefined}
        // Keep the editor's selection highlighted while using the toolbar.
        onMouseDown={(event) => event.preventDefault()}
        onClick={isMenu ? (event) => void toggleMenu(id, event.currentTarget) : onClick}
      >
        {icon}
        {isMenu ? <ChevronDown aria-hidden className="h-3 w-3 opacity-70" /> : null}
      </button>
    );
  }

  const separator = <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
  const iconClass = "h-4 w-4";
  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";

  return (
    <div ref={toolbarRef} role="toolbar" aria-label={t("toolbarLabel")} className="libera-latex-insertbar flex shrink-0 items-center gap-0.5">
      {button(null, t("bold"), <Bold aria-hidden className={iconClass} />, () => edit((view) => { toggleLatexFormat("textbf")(view); }), `${mod}B`)}
      {button(null, t("italic"), <Italic aria-hidden className={iconClass} />, () => edit((view) => { toggleLatexFormat("textit")(view); }), `${mod}I`)}
      {separator}
      {button("heading", t("heading"), <Heading aria-hidden className={iconClass} />)}
      {button("list", t("list"), <List aria-hidden className={iconClass} />)}
      {button("math", t("math"), <Sigma aria-hidden className={iconClass} />)}
      {separator}
      {button("figure", t("insertFigure"), <ImageIcon aria-hidden className={iconClass} />)}
      {button("subfigures", t("sideBySideGraphicsButton"), <Columns2 aria-hidden className={iconClass} />)}
      {button("table", t("insertTable"), <Table aria-hidden className={iconClass} />)}
      {button("code", t("codeBlockButton"), <Code aria-hidden className={iconClass} />)}
      {separator}
      {button(null, t("cite"), <Quote aria-hidden className={iconClass} />, cite)}
      {button(null, t("crossReferenceButton"), <Hash aria-hidden className={iconClass} />, crossReference)}
      {button(null, t("footnoteButton"), <Superscript aria-hidden className={iconClass} />, footnote)}
      {button(null, t("hyperlinkButton"), <Link aria-hidden className={iconClass} />, hyperlink)}
      {button("bibliography", t("bibliography"), <BookMarked aria-hidden className={iconClass} />)}
      {separator}
      <button
        type="button"
        className="libera-latex-snippets-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={snippets.length ? t("snippetsLabelWithCount", { count: snippets.length }) : t("snippetsLabel")}
        aria-haspopup="menu"
        aria-expanded={open === "snippets"}
        title={t("snippetsTitle")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => void toggleMenu("snippets", event.currentTarget)}
      >
        <Puzzle aria-hidden className="h-3.5 w-3.5" />
        {t("snippetsLabel")}
        {snippets.length ? <span className="rounded bg-muted px-1 text-[10px] tabular-nums">{snippets.length}</span> : null}
        <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
      </button>
      {separator}
      {/* Saved with the display settings. Source mode never checks: every command name would be flagged. */}
      <button
        type="button"
        className="libera-latex-icon-button"
        aria-label={t("checkSpelling")}
        aria-pressed={latexSpellcheck}
        disabled={!visualMode}
        title={!visualMode ? t("spellingVisualOnly") : latexSpellcheck ? t("spellingOn") : t("spellingOff")}
        style={latexSpellcheck && visualMode ? undefined : { opacity: 0.45 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => updatePreferences({ latexSpellcheck: !latexSpellcheck })}
      >
        <SpellCheck aria-hidden className={iconClass} />
      </button>
      {/* The LaTeX editor's own zoom (text size and line height), apart from Markdown's. */}
      <span className="px-1">
        <MarkdownDisplayZoom compact subject="text" markdownBaseFontSize={fontSizePx / (textScale / 100)} markdownZoom={textScale} onMarkdownZoomChange={(zoom) => updatePreferences({ latexTextScale: zoom })} />
      </span>

      {open === "table" ? (
        <ToolbarMenu anchorRef={anchorRef} label={t("tableMenuLabel")} width={TABLE_GRID_MENU_WIDTH} onClose={close}>
          <TableGridPicker onPick={(rows, columns) => template(() => tableTemplate(rows, columns), ["booktabs"])} />
        </ToolbarMenu>
      ) : null}
    </div>
  );
}
