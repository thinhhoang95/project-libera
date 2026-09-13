import { connection } from "next/server";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { MarkdownPreviewPage } from "@/components/libera/markdown-preview-page";

export default async function Page() {
  await connection();
  return (
    <MarkdownPreviewPage
      markdownPreferences={getConfiguredMarkdownPreferences()}
    />
  );
}
