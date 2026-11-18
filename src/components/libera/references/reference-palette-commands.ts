"use client";

import { useTranslations } from "next-intl";
import { BookMarked, Download, FileType2, Filter, FilePlus2, ListChecks, Palette, Plus, Quote, ScrollText, Table2, Undo2 } from "lucide-react";
import { usePaletteCommands, type PaletteCommand } from "@/components/libera/command-palette/commands";
import { requestReferenceForFile, type ActiveReferencePdf } from "@/components/libera/references/add-reference-box";
import { BIBLIOGRAPHY_FORMATS, bibliographyFormatLabel, DOCUMENT_EXPORT_FORMATS, documentExportFormatLabel } from "@/components/libera/references/bibliography-actions";
import { fileBaseName } from "@/components/libera/references/reference-display";
import { EXPORT_FORMATS } from "@/components/libera/references/manage-references-dialog";
import { REFERENCE_FILTERS, runReferencesCommand, type ReferencesPanelCommand } from "@/components/libera/references/references-panel";
import { BUNDLED_CSL_STYLES, REFERENCES_ADD_REQUEST_EVENT, type ReferencesAddRequestDetail } from "@/lib/references/types";

/**
 * The reference manager's actions in the command palette, offered everywhere.
 * Each one shows the References panel for `notebook` and runs there, so they
 * work while another panel is open; the panel reports what happened.
 */
export function useReferencePaletteCommands({ notebook, canCite, activePdf = null, onInsertBibliography }: {
  /** The notebook whose library the commands act on: the active document's, else the selected one. */
  notebook: string;
  /** A Markdown document is active, so citations and a bibliography can go in at its cursor. */
  canCite: boolean;
  /** The PDF open in the active tab, which can be added to its notebook's library. */
  activePdf?: ActiveReferencePdf | null;
  onInsertBibliography: () => void;
}) {
  const t = useTranslations("references.referencePaletteCommands");
  const tFormats = useTranslations("references.bibliographyActions");
  usePaletteCommands(null, () => {
    const group = t("group");
    const noNotebook = !notebook;
    const detail = noNotebook ? t("selectNotebookFirst") : undefined;
    const panel = (id: string, title: string, command: ReferencesPanelCommand, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
      id: `references:${id}`, title, group, detail, disabled: noNotebook, run: () => runReferencesCommand(notebook, command), ...extra,
    });
    return [
      panel("cite", t("citeTitle"), { action: "search" }, {
        icon: Quote, keywords: "citation insert @ cite reference search bibliography",
        detail: noNotebook ? detail : canCite ? t("citeDetailInPanel") : t("citeDetailOpenMarkdown"),
      }),
      {
        id: "references:add", title: t("addReferences"), group, icon: Plus, detail, disabled: noNotebook,
        keywords: "import paste DOI arXiv ISBN PubMed URL BibTeX RIS new entry",
        run: () => window.dispatchEvent(new CustomEvent<ReferencesAddRequestDetail>(REFERENCES_ADD_REQUEST_EVENT, { detail: { notebook, query: "" } })),
      },
      ...(activePdf ? [{
        id: "references:add-active-pdf", title: t("addActivePdf"), group, icon: FileType2,
        detail: fileBaseName(activePdf.path), keywords: "create entry reference library paper resolve current open PDF",
        run: () => requestReferenceForFile(activePdf.notebook, activePdf.path),
      }] : []),
      {
        id: "references:insert-bibliography", title: t("insertBibliography"), group, icon: ScrollText, keywords: "references list :::bibliography marker",
        detail: canCite ? undefined : t("insertBibliographyDetail"), disabled: !canCite, run: onInsertBibliography,
      },
      panel("manage", t("manageReferences"), { action: "manage" }, { icon: Table2, keywords: "table bulk edit merge duplicates library" }),
      panel("generate", t("generateEntries"), { action: "generate" }, { icon: FilePlus2, keywords: "references resolve PDF AI create" }),
      panel("fact-check", t("factCheck"), { action: "fact-check" }, { icon: ListChecks, keywords: "verify quotes sources agent review" }),
      panel("undo", t("undoReferenceChange"), { action: "undo" }, { icon: Undo2, keywords: "references library revert" }),
      panel("copy-list", t("copyReferenceList"), { action: "copy-list" }, { icon: ScrollText, keywords: "formatted library clipboard" }),
      panel("copy-bibliography", t("copyBibliography"), { action: "copy-bibliography" }, { icon: ScrollText, keywords: "formatted cited clipboard references" }),
      ...EXPORT_FORMATS.map((format) => panel(`export-library:${format.id}`, t("exportLibrary", { format: format.label }), { action: "export-library", format: format.id }, {
        icon: Download, keywords: `references download .${format.extension}`,
      })),
      ...BIBLIOGRAPHY_FORMATS.map((format) => panel(`export-list:${format.id}`, t("exportReferenceList", { format: bibliographyFormatLabel(format.id, tFormats) }), { action: "export-list", format: format.id }, {
        icon: Download, keywords: `formatted library download .${format.extension}`,
      })),
      ...DOCUMENT_EXPORT_FORMATS.map((format) => panel(`export-bibliography:${format.id}`, t("exportBibliography", { format: documentExportFormatLabel(format.id, tFormats) }), { action: "export-bibliography", format: format.id }, {
        icon: Download, keywords: `cited references download .${format.extension}`,
      })),
      ...BUNDLED_CSL_STYLES.map((style) => panel(`style:${style.id}`, t("citationStyle", { style: style.label }), { action: "style", style: style.id }, {
        icon: Palette, keywords: "references CSL format",
      })),
      ...REFERENCE_FILTERS.map((filter) => panel(`filter:${filter.id}`, t(`filterShow.${filter.id}`), { action: "filter", filter: filter.id }, {
        icon: filter.id === "all" ? BookMarked : Filter, keywords: "references filter list",
      })),
    ];
  });
}
