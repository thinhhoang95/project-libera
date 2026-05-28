import { FileImage, FileText } from "lucide-react";
import type { LiberaFileNode } from "@/lib/types";

export function fileTypeLabel(fileType: LiberaFileNode["fileType"]) {
  if (fileType === "markdown") {
    return "MD";
  }

  if (fileType === "image") {
    return "IMG";
  }

  return "PDF";
}

export function FileTypeIcon({ fileType }: { fileType: LiberaFileNode["fileType"] }) {
  if (fileType === "image") {
    return <FileImage aria-hidden className="h-4 w-4" />;
  }

  return <FileText aria-hidden className="h-4 w-4" />;
}
