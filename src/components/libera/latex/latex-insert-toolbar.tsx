"use client";

import { startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  Bold, BookMarked, ChevronDown, Code, Columns2, Hash, Heading, Image as ImageIcon, Italic, Link, List,
  Puzzle, Quote, Sigma, Superscript, Table,
} from "lucide-react";
import { useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { wrapSelection, type LatexProjectFile } from "@/lib/latex/codemirror/editing";
import { ensurePackages, insertSnippetText, insertTemplate } from "@/lib/latex/codemirror/snippets";
import {
  BIBLATEX_STYLES, BIBTEX_STYLES, CODE_LANGUAGES, bibliographyBlock, codeTemplate, figureTemplate, listTemplate, literalField,
  preambleInsertion, readBibliographySetup, restyleBibliography, sideBySideTemplate, snippetBodyFromSelection, tableTemplate,
  type BibliographyStyle,
} from "@/lib/latex/snippets";
import type { LatexEditorHandle } from "./latex-editor";
import type { LatexSnippetDialogRequest } from "./latex-snippet-dialog";
import { deleteLatexSnippet, useLatexSnippets } from "./latex-snippets-store";
import { nativeMenuPointBelow, popupNativeMenu, type NativeMenuEntry } from "../native-menu";
import { TABLE_GRID_MENU_WIDTH, TableGridPicker } from "../table-grid-picker";
import { ToolbarMenu } from "../toolbar-menu";

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
};

/** Insert tools for .tex files, shown in the LaTeX toolbar after Recompile:
 * formatting, structure, math, floats, code, references, bibliography and
 * saved snippets. Their menus are native ones, except the table size grid. */
export function LatexInsertToolbar({ editorRef, projectFiles, onSnippetDialog, missingInMainFile, onNotice }: LatexInsertToolbarProps) {
  const [open, setOpen] = useState<MenuId | null>(null);
  const anchors = useRef(new Map<MenuId, HTMLButtonElement>());
  const anchorRef = useMemo(() => ({ get current() { return open ? anchors.current.get(open) ?? null : null; } }), [open]);
  const snippets = useLatexSnippets();
  const images = projectFiles.filter((file) => file.kind === "image" || file.kind === "pdf");
  const bibFile = projectFiles.find((file) => file.kind === "bib")?.path ?? "references.bib";

  function close() { setOpen(null); }

  function reportUnavailable(packages: string[]) {
    if (!packages.length) return;
    void missingInMainFile(packages).then((missing) => {
      if (missing.length) onNotice(`This file has no preamble. Load ${missing.map((name) => `\\usepackage{${name}}`).join(", ")} in the main file.`);
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
        else onNotice(`This file has no preamble. Add \\usepackage[style=${style.value}]{biblatex} and \\addbibresource{${bibFile}} to the main file.`);
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
    if (!window.confirm(`Delete the snippet /${name}?`)) return;
    try { await deleteLatexSnippet(id); } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Could not delete the snippet.");
    }
  }

  /** A native menu's items, read from the editor as it is when the menu opens. */
  function menuItems(id: Exclude<MenuId, "table">): NativeMenuEntry[] {
    switch (id) {
      case "heading":
        return (["chapter", "section", "subsection", "subsubsection", "paragraph"] as const).map((command) => ({
          id: command, label: command[0].toUpperCase() + command.slice(1),
          onSelect: () => template((selection) => `\\${command}{\${${field(selection, "Title")}}}\${}`),
        }));
      case "list":
        return [
          { id: "itemize", label: "Bulleted List", onSelect: () => template((selection) => listTemplate("itemize", selection)) },
          { id: "enumerate", label: "Numbered List", onSelect: () => template((selection) => listTemplate("enumerate", selection)) },
          { id: "description", label: "Description List", onSelect: () => template((selection) => listTemplate("description", selection)) },
        ];
      case "math":
        return [
          { id: "inline", label: "Inline Math", onSelect: () => template((selection) => `\\(\${${field(selection, "")}}\\)\${}`) },
          { id: "display", label: "Display Math", onSelect: () => template((selection) => `\\[\n\t\${${field(selection, "")}}\n\\]\${}`) },
          { id: "equation", label: "Numbered Equation", onSelect: () => template((selection) => `\\begin{equation}\n\t\${${field(selection, "")}}\n\t\\label{eq:\${label}}\n\\end{equation}\${}`) },
          { id: "align", label: "Aligned Equations", onSelect: () => template(() => "\\begin{align}\n\t${a} &= ${b} \\\\\n\t${c} &= ${d}\n\\end{align}${}", ["amsmath"]) },
          { id: "cases", label: "Cases", onSelect: () => template(() => "\\begin{cases}\n\t${value} & \\text{if } ${condition} \\\\\n\t${other} & \\text{otherwise}\n\\end{cases}${}", ["amsmath"]) },
          { id: "matrix", label: "Matrix", onSelect: () => template(() => "\\begin{pmatrix}\n\t${a} & ${b} \\\\\n\t${c} & ${d}\n\\end{pmatrix}${}", ["amsmath"]) },
          { id: "fraction", label: "Fraction", onSelect: () => template((selection) => `\\frac{\${${field(selection, "numerator")}}}{\${denominator}}\${}`) },
        ];
      case "figure":
        return [
          { id: "empty", label: "Empty Figure", onSelect: () => template(() => figureTemplate(), ["graphicx"]) },
          ...(images.length ? [{ type: "separator" } as const, heading("images", "Images in This Folder")] : []),
          ...images.map((file) => ({ id: `image:${file.path}`, label: file.path, onSelect: () => template(() => figureTemplate(file.path), ["graphicx"]) })),
        ];
      case "subfigures":
        return [
          { id: "two", label: "Two Figures Side by Side", onSelect: () => template(() => sideBySideTemplate(2), ["graphicx", "subcaption"]) },
          { id: "three", label: "Three Figures in a Row", onSelect: () => template(() => sideBySideTemplate(3), ["graphicx", "subcaption"]) },
        ];
      case "code":
        return [
          { id: "verbatim", label: "Verbatim", onSelect: () => template((selection) => codeTemplate("verbatim", selection)) },
          { id: "listing", label: "Listing", onSelect: () => template((selection) => codeTemplate("listing", selection), ["listings"]) },
          {
            id: "languages", label: "Listing in a Language",
            submenu: CODE_LANGUAGES.map((language) => ({ id: `language:${language}`, label: language, onSelect: () => template((selection) => codeTemplate("listing", selection, language), ["listings"]) })),
          },
        ];
      case "bibliography": {
        // A document uses BibTeX or biblatex; only its own styles can be switched to.
        const bibliography = readBibliographySetup(editorRef.current?.view.state.doc.toString() ?? "");
        const styles = (system: BibliographyStyle["system"], list: BibliographyStyle[]): NativeMenuEntry[] => list.map((style) => ({
          id: `${system}:${style.value}`, label: style.label, type: "checkbox",
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
            : [heading("none", "No Snippets Yet")]),
          { type: "separator" },
          { id: "add", label: "Add Selection as Snippet…", enabled: !!selection && !selection.empty, onSelect: addSelectionAsSnippet },
          ...(sorted.length ? [
            { id: "rename", label: "Rename", submenu: each("rename", (snippet) => onSnippetDialog({ mode: "rename", snippet })) },
            { id: "delete", label: "Delete", submenu: each("delete", (snippet) => void removeSnippet(snippet.name, snippet.id)) },
          ] : []),
        ];
      }
    }
  }

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
    <div role="toolbar" aria-label="Insert LaTeX" className="libera-latex-insertbar flex shrink-0 items-center gap-0.5">
      {button(null, "Bold", <Bold aria-hidden className={iconClass} />, () => edit((view) => { wrapSelection("textbf")(view); }), `${mod}B`)}
      {button(null, "Italic", <Italic aria-hidden className={iconClass} />, () => edit((view) => { wrapSelection("textit")(view); }), `${mod}I`)}
      {separator}
      {button("heading", "Heading", <Heading aria-hidden className={iconClass} />)}
      {button("list", "List", <List aria-hidden className={iconClass} />)}
      {button("math", "Math", <Sigma aria-hidden className={iconClass} />)}
      {separator}
      {button("figure", "Insert figure", <ImageIcon aria-hidden className={iconClass} />)}
      {button("subfigures", "Side-by-side graphics", <Columns2 aria-hidden className={iconClass} />)}
      {button("table", "Insert table", <Table aria-hidden className={iconClass} />)}
      {button("code", "Code block", <Code aria-hidden className={iconClass} />)}
      {separator}
      {button(null, "Cite", <Quote aria-hidden className={iconClass} />, () => commandWithCompletion("cite"))}
      {button(null, "Cross-reference", <Hash aria-hidden className={iconClass} />, () => commandWithCompletion("ref"))}
      {button(null, "Footnote", <Superscript aria-hidden className={iconClass} />, () => edit((view) => { wrapSelection("footnote")(view); }))}
      {button(null, "Hyperlink", <Link aria-hidden className={iconClass} />, () => template((selection) => `\\href{\${https://}}{\${${field(selection, "text")}}}\${}`, ["hyperref"]))}
      {button("bibliography", "Bibliography", <BookMarked aria-hidden className={iconClass} />)}
      {separator}
      <button
        type="button"
        className="libera-latex-snippets-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Snippets${snippets.length ? ` (${snippets.length})` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open === "snippets"}
        title="Insert, rename or delete saved snippets. Type /name in the editor to insert one."
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => void toggleMenu("snippets", event.currentTarget)}
      >
        <Puzzle aria-hidden className="h-3.5 w-3.5" />
        Snippets
        {snippets.length ? <span className="rounded bg-muted px-1 text-[10px] tabular-nums">{snippets.length}</span> : null}
        <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
      </button>

      {open === "table" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Insert table" width={TABLE_GRID_MENU_WIDTH} onClose={close}>
          <TableGridPicker onPick={(rows, columns) => template(() => tableTemplate(rows, columns), ["booktabs"])} />
        </ToolbarMenu>
      ) : null}
    </div>
  );
}
