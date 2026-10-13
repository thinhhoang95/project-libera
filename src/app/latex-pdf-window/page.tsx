import { connection } from "next/server";
import { LatexPdfWindowPage } from "@/components/libera/latex/latex-pdf-window-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();
  const { path } = await searchParams;

  return <LatexPdfWindowPage rootPath={typeof path === "string" ? path : ""} />;
}
