"use client";

import { ClipboardPaste, ListTree } from "lucide-react";
import { useTranslations } from "next-intl";

/** "normal" pastes as Ctrl+V does; "peer" pastes the clipboard's headings at
 * the level of the closest heading before the insertion point. */
export type MenuPasteMode = "normal" | "peer";

export type ClipboardText = { html: string; markdown: string; plain: string };

/** The system clipboard's text, for pasting from a right-click menu. */
export async function readClipboardText(): Promise<ClipboardText> {
  const clipboard: ClipboardText = { html: "", markdown: "", plain: "" };
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!clipboard.html && item.types.includes("text/html")) clipboard.html = await (await item.getType("text/html")).text();
      if (!clipboard.plain && item.types.includes("text/plain")) clipboard.plain = await (await item.getType("text/plain")).text();
    }
  } catch {
    clipboard.plain = await navigator.clipboard.readText().catch(() => "");
  }
  return clipboard;
}

/** Paste and Paste with Peer Heading Level, the same in every Markdown
 * editor's right-click menu. */
export function PasteMenuItems({ className, disabled = false, onPaste }: {
  className: string;
  disabled?: boolean;
  onPaste: (mode: MenuPasteMode) => void;
}) {
  const t = useTranslations("pasteMenuItems");
  return <>
    <button type="button" role="menuitem" className={className} disabled={disabled} onClick={() => onPaste("normal")}>
      <ClipboardPaste aria-hidden className="h-4 w-4" />
      {t("paste")}
    </button>
    <button
      type="button"
      role="menuitem"
      className={className}
      disabled={disabled}
      title={t("peerTitle")}
      onClick={() => onPaste("peer")}
    >
      <ListTree aria-hidden className="h-4 w-4" />
      {t("pasteWithPeerHeadingLevel")}
    </button>
    <div className="my-1 border-t border-border" />
  </>;
}
