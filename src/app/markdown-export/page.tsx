import { MarkdownPdfExportPage } from "@/components/libera/markdown-pdf-export-page";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { getConfiguredEditorThemes } from "@/lib/editor-themes-config";

export const dynamic = "force-dynamic";

export default function MarkdownExportPage() {
  const markdownPreferences = getConfiguredMarkdownPreferences();

  // PDF export uses the visual editor theme's typeface, but none of its colors.
  const textFont = getConfiguredEditorThemes().visual?.textFont ?? "";

  return <MarkdownPdfExportPage markdownPreferences={markdownPreferences} textFont={textFont} />;
}
