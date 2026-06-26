import { MarkdownPdfExportPage } from "@/components/libera/markdown-pdf-export-page";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";

export const dynamic = "force-dynamic";

export default function MarkdownExportPage() {
  const markdownPreferences = getConfiguredMarkdownPreferences();

  return <MarkdownPdfExportPage markdownPreferences={markdownPreferences} />;
}
