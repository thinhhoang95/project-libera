"use client";

import { BookMarked, Download, Filter, FilePlus2, ListChecks, Palette, Plus, Quote, ScrollText, Table2, Undo2 } from "lucide-react";
import { usePaletteCommands, type PaletteCommand } from "@/components/libera/command-palette/commands";
import { BIBLIOGRAPHY_FORMATS, DOCUMENT_EXPORT_FORMATS } from "@/components/libera/references/bibliography-actions";
import { EXPORT_FORMATS } from "@/components/libera/references/manage-references-dialog";
import { REFERENCE_FILTERS, runReferencesCommand, type ReferencesPanelCommand } from "@/components/libera/references/references-panel";
import { BUNDLED_CSL_STYLES, REFERENCES_ADD_REQUEST_EVENT, type ReferencesAddRequestDetail } from "@/lib/references/types";

/**
 * The reference manager's actions in the command palette, offered everywhere.
 * Each one shows the References panel for `notebook` and runs there, so they
 * work while another panel is open; the panel reports what happened.
 */
export function useReferencePaletteCommands({ notebook, canCite, onInsertBibliography }: {
  /** The notebook whose library the commands act on: the active document's, else the selected one. */
  notebook: string;
  /** A Markdown document is active, so citations and a bibliography can go in at its cursor. */
  canCite: boolean;
  onInsertBibliography: () => void;
}) {
  usePaletteCommands(null, () => {
    const group = "References";
    const noNotebook = !notebook;
    const detail = noNotebook ? "Select a notebook first" : undefined;
    const panel = (id: string, title: string, command: ReferencesPanelCommand, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
      id: `references:${id}`, title, group, detail, disabled: noNotebook, run: () => runReferencesCommand(notebook, command), ...extra,
    });
    return [
      panel("cite", "Cite a reference…", { action: "search" }, {
        icon: Quote, keywords: "citation insert @ cite reference search bibliography",
        detail: noNotebook ? detail : canCite ? "Find it in the References panel, then press ⌘/Ctrl+Enter" : "Open a Markdown document to cite into it",
      }),
      {
        id: "references:add", title: "Add references…", group, icon: Plus, detail, disabled: noNotebook,
        keywords: "import paste DOI arXiv ISBN PubMed URL BibTeX RIS new entry",
        run: () => window.dispatchEvent(new CustomEvent<ReferencesAddRequestDetail>(REFERENCES_ADD_REQUEST_EVENT, { detail: { notebook, query: "" } })),
      },
      {
        id: "references:insert-bibliography", title: "Insert bibliography here", group, icon: ScrollText, keywords: "references list :::bibliography marker",
        detail: canCite ? undefined : "Open a Markdown document and place the cursor", disabled: !canCite, run: onInsertBibliography,
      },
      panel("manage", "Manage references…", { action: "manage" }, { icon: Table2, keywords: "table bulk edit merge duplicates library" }),
      panel("generate", "Generate entries for PDFs without one", { action: "generate" }, { icon: FilePlus2, keywords: "references resolve PDF AI create" }),
      panel("fact-check", "Fact-check citations…", { action: "fact-check" }, { icon: ListChecks, keywords: "verify quotes sources agent review" }),
      panel("undo", "Undo last reference change", { action: "undo" }, { icon: Undo2, keywords: "references library revert" }),
      panel("copy-list", "Copy reference list", { action: "copy-list" }, { icon: ScrollText, keywords: "formatted library clipboard" }),
      panel("copy-bibliography", "Copy bibliography of this document", { action: "copy-bibliography" }, { icon: ScrollText, keywords: "formatted cited clipboard references" }),
      ...EXPORT_FORMATS.map((format) => panel(`export-library:${format.id}`, `Export library as ${format.label}`, { action: "export-library", format: format.id }, {
        icon: Download, keywords: `references download .${format.extension}`,
      })),
      ...BIBLIOGRAPHY_FORMATS.map((format) => panel(`export-list:${format.id}`, `Export reference list as ${format.label}`, { action: "export-list", format: format.id }, {
        icon: Download, keywords: `formatted library download .${format.extension}`,
      })),
      ...DOCUMENT_EXPORT_FORMATS.map((format) => panel(`export-bibliography:${format.id}`, `Export bibliography of this document as ${format.label}`, { action: "export-bibliography", format: format.id }, {
        icon: Download, keywords: `cited references download .${format.extension}`,
      })),
      ...BUNDLED_CSL_STYLES.map((style) => panel(`style:${style.id}`, `Citation style: ${style.label}`, { action: "style", style: style.id }, {
        icon: Palette, keywords: "references CSL format",
      })),
      ...REFERENCE_FILTERS.map((filter) => panel(`filter:${filter.id}`, `References: show ${filter.id === "all" ? "all" : filter.label.toLowerCase()}`, { action: "filter", filter: filter.id }, {
        icon: filter.id === "all" ? BookMarked : Filter, keywords: "references filter list",
      })),
    ];
  });
}
