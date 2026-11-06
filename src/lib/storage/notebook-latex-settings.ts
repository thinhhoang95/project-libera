import { readNotebookMetadataWithFallback } from "@/lib/storage/notebook-groups";
import { writeNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { assertSafeSegment } from "@/lib/storage/paths";

/** Notebooks that never chose keep the default: on. */
export async function readNotebookLatexAutoCompile(notebook: string) {
  const metadata = await readNotebookMetadataWithFallback(assertSafeSegment(notebook, "Notebook name"));
  return metadata.latexAutoCompile ?? true;
}

export async function writeNotebookLatexAutoCompile(notebook: string, enabled: boolean) {
  const name = assertSafeSegment(notebook, "Notebook name");
  await writeNotebookMetadata(name, { ...(await readNotebookMetadataWithFallback(name)), latexAutoCompile: enabled });
}
