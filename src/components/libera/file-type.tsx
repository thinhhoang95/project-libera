import { FileCode2, FileImage, FileText } from "lucide-react";
import type { LiberaFileNode } from "@/lib/types";

const PROSE_TEXT_FILE = /\.(txt|text|log|rst|adoc|org|textile)$|^(readme|license|licence|changelog|authors|contributors|copying|notice|todo)$/i;

export function fileTypeLabel(fileType: LiberaFileNode["fileType"], name?: string) {
  if (fileType === "markdown") {
    return "MD";
  }

  if (fileType === "latex") {
    return /\.bib$/i.test(name ?? "") ? "BIB" : "TEX";
  }

  if (fileType === "image") {
    return "IMG";
  }

  if (fileType === "text") {
    const extension = name?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
    return extension ? extension.toUpperCase() : "TXT";
  }

  return "PDF";
}

export function FileTypeIcon({ fileType, name }: { fileType: LiberaFileNode["fileType"]; name?: string }) {
  if (fileType === "image") {
    return <FileImage aria-hidden className="h-4 w-4" />;
  }

  if (fileType === "latex" || (fileType === "text" && !PROSE_TEXT_FILE.test(name ?? ""))) {
    return <FileCode2 aria-hidden className="h-4 w-4" />;
  }

  return <FileText aria-hidden className="h-4 w-4" />;
}
