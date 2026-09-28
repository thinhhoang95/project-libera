import { connection } from "next/server";
import { FileWindowPage } from "@/components/libera/file-window-page";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { getFileType } from "@/lib/storage/file-types";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();
  const { path } = await searchParams;
  const filePath = typeof path === "string" ? path : "";
  const fileType = filePath ? getFileType(filePath) : null;

  return (
    <FileWindowPage
      filePath={filePath}
      fileType={fileType === "pdf" || fileType === "image" ? fileType : null}
      mathMarkers={getConfiguredMarkdownPreferences()}
    />
  );
}
