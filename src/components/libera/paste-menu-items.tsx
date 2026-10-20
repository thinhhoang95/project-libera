"use client";

import { ClipboardPaste, ListTree } from "lucide-react";

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
  return <>
    <button type="button" role="menuitem" className={className} disabled={disabled} onClick={() => onPaste("normal")}>
      <ClipboardPaste aria-hidden className="h-4 w-4" />
      Paste
    </button>
    <button
      type="button"
      role="menuitem"
      className={className}
      disabled={disabled}
      title="Paste so the pasted headings sit at the level of the heading before them"
      onClick={() => onPaste("peer")}
    >
      <ListTree aria-hidden className="h-4 w-4" />
      Paste with Peer Heading Level
    </button>
    <div className="my-1 border-t border-border" />
  </>;
}
