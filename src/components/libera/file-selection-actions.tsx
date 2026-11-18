"use client";

import { useTranslations } from "next-intl";
import { ListChecks, ListX } from "lucide-react";

const button = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

/** Icon-button pair for the search bar of a file/folder selector. */
export function FileSelectionActions({ onSelectAll, onClear }: { onSelectAll: () => void; onClear: () => void }) {
  const t = useTranslations("fileSelectionActions");
  return <div className="flex items-center gap-0.5">
    <button type="button" className={button} title={t("selectAll")} aria-label={t("selectAll")} onClick={onSelectAll}><ListChecks aria-hidden className="h-4 w-4" /></button>
    <button type="button" className={button} title={t("clearSelection")} aria-label={t("clearSelection")} onClick={onClear}><ListX aria-hidden className="h-4 w-4" /></button>
  </div>;
}
