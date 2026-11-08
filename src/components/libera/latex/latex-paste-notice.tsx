"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* After Markdown was converted without the dialog (docs/latex-markdown-paste-plan.md
 * §6.1): what happened, the way back to the Markdown as written, the dialog,
 * the `\usepackage` lines the preamble lacks (never added by itself), and
 * anything that had to be dropped. Each paste mounts its own notice (keyed),
 * so its time on screen starts afresh; hovering or focusing it holds it. */

const VISIBLE_MS = 12_000;

export function LatexPasteNotice({ rich = false, missing, warnings, onPlain, onOptions, onClose }: {
  /** Formatted text (Word, Google Docs, a web page) rather than Markdown. */
  rich?: boolean;
  missing: string[];
  warnings: string[];
  onPlain: () => void;
  onOptions: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => closeRef.current(), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [hovered, focused]);

  const link = "whitespace-nowrap rounded px-1 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      role="status"
      className="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit min-w-0 max-w-[min(42rem,calc(100%-1.5rem))] flex-col gap-1 overflow-hidden rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{rich ? "Pasted formatted text as LaTeX." : "Pasted Markdown as LaTeX."}</span>
        <button type="button" className={link} onClick={onPlain}>Paste as plain text instead</button>
        <button type="button" className={link} onClick={onOptions}>Options…</button>
        <button type="button" aria-label="Dismiss" className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
      {missing.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-all">Needs <code className="font-mono">{missing.join(" ")}</code></span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-muted"
            onClick={() => {
              navigator.clipboard.writeText(missing.join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
            }}
          >
            {copied ? <Check aria-hidden className="h-3 w-3" /> : <Copy aria-hidden className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      {warnings.length ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
