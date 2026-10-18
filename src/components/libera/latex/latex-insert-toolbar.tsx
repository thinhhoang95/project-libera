"use client";

import { startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  Bold, BookMarked, BookmarkPlus, Check, ChevronDown, Code, Columns2, Hash, Heading, Image as ImageIcon, Italic, Link, List,
  Pencil, Puzzle, Quote, Sigma, Superscript, Table, Trash2,
} from "lucide-react";
import { useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { wrapSelection, type LatexProjectFile } from "@/lib/latex/codemirror/editing";
import { ensurePackages, insertSnippetText, insertTemplate } from "@/lib/latex/codemirror/snippets";
import {
  BIBLATEX_STYLES, BIBTEX_STYLES, CODE_LANGUAGES, bibliographyBlock, codeTemplate, figureTemplate, listTemplate, literalField, matchingSnippets,
  preambleInsertion, readBibliographySetup, restyleBibliography, sideBySideTemplate, snippetBodyFromSelection, tableTemplate,
  type BibliographyStyle, type LatexSnippet,
} from "@/lib/latex/snippets";
import type { LatexEditorHandle } from "./latex-editor";
import type { LatexSnippetDialogRequest } from "./latex-snippet-dialog";
import { deleteLatexSnippet, useLatexSnippets } from "./latex-snippets-store";
import { TABLE_GRID_MENU_WIDTH, TableGridPicker } from "../table-grid-picker";
import { ToolbarMenu } from "../toolbar-menu";

type MenuId = "heading" | "list" | "math" | "figure" | "subfigures" | "table" | "code" | "bibliography" | "snippets";

const itemClass = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
const sectionLabelClass = "px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

/** The selection as the text of a one-line template field. */
const field = (selection: string, fallback: string) => literalField(selection.trim().replace(/\s*\n\s*/g, " ")) || fallback;

function MenuItem({ icon, label, detail, checked, disabled, onSelect }: { icon?: ReactNode; label: ReactNode; detail?: ReactNode; checked?: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role={checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={checked} className={itemClass} disabled={disabled} onClick={onSelect}>
      {checked !== undefined ? <Check aria-hidden className={`h-4 w-4 shrink-0 ${checked ? "" : "invisible"}`} /> : icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{detail}</span> : null}
    </button>
  );
}

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
 * saved snippets. */
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

  const hasSelection = (() => {
    const selection = editorRef.current?.view.state.selection.main;
    return !!selection && !selection.empty;
  })();
  const bibliography = open === "bibliography" ? readBibliographySetup(editorRef.current?.view.state.doc.toString() ?? "") : null;

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
        onClick={isMenu ? () => setOpen((current) => current === id ? null : id) : onClick}
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
        ref={(element) => { if (element) anchors.current.set("snippets", element); else anchors.current.delete("snippets"); }}
        className="libera-latex-snippets-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Snippets${snippets.length ? ` (${snippets.length})` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open === "snippets"}
        title="Insert, rename or delete saved snippets. Type /name in the editor to insert one."
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => current === "snippets" ? null : "snippets")}
      >
        <Puzzle aria-hidden className="h-3.5 w-3.5" />
        Snippets
        {snippets.length ? <span className="rounded bg-muted px-1 text-[10px] tabular-nums">{snippets.length}</span> : null}
        <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
      </button>

      {open === "heading" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Heading" width={220} onClose={close}>
          {(["chapter", "section", "subsection", "subsubsection", "paragraph"] as const).map((command) => (
            <MenuItem key={command} label={command[0].toUpperCase() + command.slice(1)} detail={`\\${command}`}
              onSelect={() => template((selection) => `\\${command}{\${${field(selection, "Title")}}}\${}`)} />
          ))}
        </ToolbarMenu>
      ) : null}

      {open === "list" ? (
        <ToolbarMenu anchorRef={anchorRef} label="List" width={240} onClose={close}>
          <MenuItem label="Bulleted list" detail="itemize" onSelect={() => template((selection) => listTemplate("itemize", selection))} />
          <MenuItem label="Numbered list" detail="enumerate" onSelect={() => template((selection) => listTemplate("enumerate", selection))} />
          <MenuItem label="Description list" detail="description" onSelect={() => template((selection) => listTemplate("description", selection))} />
        </ToolbarMenu>
      ) : null}

      {open === "math" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Math" width={260} onClose={close}>
          <MenuItem label="Inline math" detail="\( \)" onSelect={() => template((selection) => `\\(\${${field(selection, "")}}\\)\${}`)} />
          <MenuItem label="Display math" detail="\[ \]" onSelect={() => template((selection) => `\\[\n\t\${${field(selection, "")}}\n\\]\${}`)} />
          <MenuItem label="Numbered equation" detail="equation" onSelect={() => template((selection) => `\\begin{equation}\n\t\${${field(selection, "")}}\n\t\\label{eq:\${label}}\n\\end{equation}\${}`)} />
          <MenuItem label="Aligned equations" detail="align" onSelect={() => template(() => "\\begin{align}\n\t${a} &= ${b} \\\\\n\t${c} &= ${d}\n\\end{align}${}", ["amsmath"])} />
          <MenuItem label="Cases" detail="cases" onSelect={() => template(() => "\\begin{cases}\n\t${value} & \\text{if } ${condition} \\\\\n\t${other} & \\text{otherwise}\n\\end{cases}${}", ["amsmath"])} />
          <MenuItem label="Matrix" detail="pmatrix" onSelect={() => template(() => "\\begin{pmatrix}\n\t${a} & ${b} \\\\\n\t${c} & ${d}\n\\end{pmatrix}${}", ["amsmath"])} />
          <MenuItem label="Fraction" detail="\frac" onSelect={() => template((selection) => `\\frac{\${${field(selection, "numerator")}}}{\${denominator}}\${}`)} />
        </ToolbarMenu>
      ) : null}

      {open === "figure" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Insert figure" width={300} onClose={close}>
          <MenuItem icon={<ImageIcon aria-hidden className="h-4 w-4 shrink-0" />} label="Empty figure" detail="figure" onSelect={() => template(() => figureTemplate(), ["graphicx"])} />
          {images.length ? <div className={sectionLabelClass}>Images in this folder</div> : null}
          {images.map((file) => (
            <MenuItem key={file.path} label={<span className="font-mono text-xs" title={file.path}>{file.path}</span>} onSelect={() => template(() => figureTemplate(file.path), ["graphicx"])} />
          ))}
        </ToolbarMenu>
      ) : null}

      {open === "subfigures" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Side-by-side graphics" width={260} onClose={close}>
          <MenuItem label="Two figures side by side" detail="subfigure" onSelect={() => template(() => sideBySideTemplate(2), ["graphicx", "subcaption"])} />
          <MenuItem label="Three figures in a row" detail="subfigure" onSelect={() => template(() => sideBySideTemplate(3), ["graphicx", "subcaption"])} />
          <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">Each panel gets its own caption and label. Uses the subcaption package.</p>
        </ToolbarMenu>
      ) : null}

      {open === "table" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Insert table" width={TABLE_GRID_MENU_WIDTH} onClose={close}>
          <TableGridPicker onPick={(rows, columns) => template(() => tableTemplate(rows, columns), ["booktabs"])} />
        </ToolbarMenu>
      ) : null}

      {open === "code" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Code block" width={240} onClose={close}>
          <MenuItem label="Verbatim" detail="verbatim" onSelect={() => template((selection) => codeTemplate("verbatim", selection))} />
          <MenuItem label="Listing" detail="lstlisting" onSelect={() => template((selection) => codeTemplate("listing", selection), ["listings"])} />
          <div className={sectionLabelClass}>Listing in a language</div>
          {CODE_LANGUAGES.map((language) => (
            <MenuItem key={language} label={language} onSelect={() => template((selection) => codeTemplate("listing", selection, language), ["listings"])} />
          ))}
        </ToolbarMenu>
      ) : null}

      {open === "bibliography" && bibliography ? (
        <ToolbarMenu anchorRef={anchorRef} label="Bibliography style" width={330} onClose={close}>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">
            {bibliography.system ? "Choose a style to switch this document’s bibliography." : `Inserts a bibliography for ${bibFile} at the cursor.`}
          </p>
          <div className={sectionLabelClass}>BibTeX</div>
          {BIBTEX_STYLES.map((style) => (
            <MenuItem key={style.value} label={style.label} detail={style.value} checked={bibliography.system === "bibtex" && bibliography.style === style.value}
              disabled={bibliography.system === "biblatex"} onSelect={() => applyBibliographyStyle(style)} />
          ))}
          <div className={sectionLabelClass}>biblatex</div>
          {BIBLATEX_STYLES.map((style) => (
            <MenuItem key={style.value} label={style.label} detail={style.value} checked={bibliography.system === "biblatex" && bibliography.style === style.value}
              disabled={bibliography.system === "bibtex"} onSelect={() => applyBibliographyStyle(style)} />
          ))}
          {bibliography.system ? <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">This document uses {bibliography.system === "biblatex" ? "biblatex" : "BibTeX"}, so only its styles apply.</p> : null}
        </ToolbarMenu>
      ) : null}

      {open === "snippets" ? (
        <ToolbarMenu anchorRef={anchorRef} label="Snippets" width={340} onClose={close}>
          <SnippetsMenu
            snippets={snippets}
            hasSelection={hasSelection}
            onInsert={(snippet) => edit((view) => { insertSnippetText(view, snippet.body); })}
            onAdd={addSelectionAsSnippet}
            onRename={(snippet) => { close(); onSnippetDialog({ mode: "rename", snippet }); }}
            onError={onNotice}
          />
        </ToolbarMenu>
      ) : null}
    </div>
  );
}

function SnippetsMenu({ snippets, hasSelection, onInsert, onAdd, onRename, onError }: {
  snippets: LatexSnippet[];
  hasSelection: boolean;
  onInsert: (snippet: LatexSnippet) => void;
  onAdd: () => void;
  onRename: (snippet: LatexSnippet) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const shown = query.trim() ? matchingSnippets(snippets, query.trim().replace(/^\//, "")) : [...snippets].sort((left, right) => left.name.localeCompare(right.name));

  async function remove(snippet: LatexSnippet) {
    setDeleting(snippet.id);
    try { await deleteLatexSnippet(snippet.id); } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not delete the snippet.");
    } finally { setDeleting(null); setConfirming(null); }
  }

  return (
    <>
      {snippets.length > 5 ? (
        <input
          data-autofocus
          type="search"
          value={query}
          placeholder="Filter snippets"
          aria-label="Filter snippets"
          className="mb-1 w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && shown[0]) { event.preventDefault(); onInsert(shown[0]); } }}
        />
      ) : null}
      {!snippets.length ? (
        <p className="px-2.5 py-2 text-sm text-muted-foreground">No snippets yet. Select some LaTeX, right-click it and choose <span className="font-medium text-foreground">Add as Snippet</span>.</p>
      ) : !shown.length ? (
        <p className="px-2.5 py-2 text-sm text-muted-foreground">No snippet matches “{query}”.</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((snippet) => (
            <li key={snippet.id} className="group flex items-center gap-0.5 rounded hover:bg-muted focus-within:bg-muted">
              {confirming === snippet.id ? (
                <div className="flex w-full items-center gap-2 px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">Delete <span className="font-mono">/{snippet.name}</span>?</span>
                  <button type="button" role="menuitem" className="rounded px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10" disabled={deleting === snippet.id} onClick={() => void remove(snippet)}>Delete</button>
                  <button type="button" role="menuitem" className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-card" onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              ) : (
                <>
                  <button type="button" role="menuitem" className="min-w-0 flex-1 rounded px-2.5 py-1.5 text-left focus-visible:outline-none" title={snippet.body.slice(0, 800)} onClick={() => onInsert(snippet)}>
                    <span className="block truncate font-mono text-sm text-foreground">/{snippet.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{snippet.body.split("\n").find((line) => line.trim())?.trim()}</span>
                  </button>
                  <button type="button" className="libera-latex-icon-button opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Rename /${snippet.name}`} title="Rename" onClick={() => onRename(snippet)}>
                    <Pencil aria-hidden className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className="libera-latex-icon-button is-danger opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Delete /${snippet.name}`} title="Delete" onClick={() => setConfirming(snippet.id)}>
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 border-t border-border pt-1">
        <MenuItem icon={<BookmarkPlus aria-hidden className="h-4 w-4 shrink-0" />} label="Add selection as snippet…" disabled={!hasSelection} onSelect={onAdd} />
        <p className="px-2.5 pb-1 pt-1 text-xs text-muted-foreground">Tip: type <span className="font-mono">/name</span> in the editor to insert a snippet.</p>
      </div>
    </>
  );
}
