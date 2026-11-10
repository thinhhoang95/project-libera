"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* After images were pasted or dropped: where they were saved, what could not
 * be, and the `\usepackage` lines the preamble lacks (listed with Copy, never
 * added). Hovering or focusing it holds it on screen. */

const VISIBLE_MS = 10_000;

export function LatexImageNotice({ message, missing, onClose }: { message: string | null; missing: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [held, setHeld] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => closeRef.current(), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [held]);

  return (
    <div
      role="status"
      className="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit min-w-0 max-w-[min(42rem,calc(100%-1.5rem))] flex-col gap-1 overflow-hidden rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="flex items-start gap-2">
        {message ? <span className="min-w-0 break-words">{message}</span> : null}
        <button type="button" aria-label="Dismiss" className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
      {missing.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-all">The preamble does not load it. Needs <code className="font-mono">{missing.join(" ")}</code></span>
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
    </div>
  );
}
