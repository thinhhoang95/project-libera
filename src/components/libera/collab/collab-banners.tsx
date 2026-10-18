"use client";

import { Check, Copy, Download, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import "./collab.css";

/** Copies text, falling back to a hidden textarea where the async clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    area.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

/** "Copied" feedback that resets after a moment. */
export function useCopyFeedback(): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    async (text: string) => {
      const ok = await copyText(text);
      setCopied(ok);
      return ok;
    },
  ];
}

const BANNER = "libera-collab-tone flex flex-wrap items-start gap-2 rounded-lg px-3 py-2 text-sm";

export interface RejectedEditBannerProps {
  /** The local text the server refused, kept so the user can paste it elsewhere. */
  rejectedText: string;
  /** Why it was refused, from the hub's `rejected` message (shown as detail). */
  reason?: string;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Shown after the hub rolled a sub-document back because the server refused
 * the update (usually a role change, collaboration map §M1.8).
 */
export function RejectedEditBanner({ rejectedText, reason, onDismiss, className = "" }: RejectedEditBannerProps) {
  const [copied, copy] = useCopyFeedback();
  return (
    <div className={`${BANNER} ${className}`} data-tone="warn" role="alert">
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Some of your changes were not accepted (role changed).</p>
        {reason ? <p className="text-xs opacity-80">{reason}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-current/30 px-2 py-1 text-xs font-medium hover:bg-current/10 disabled:opacity-60"
          disabled={!rejectedText}
          type="button"
          onClick={() => void copy(rejectedText)}
        >
          {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy my unsynced text"}
        </button>
        {onDismiss ? (
          <button aria-label="Dismiss" className="rounded-md p-1 hover:bg-current/10" type="button" onClick={onDismiss}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface AccessChangedBannerProps {
  /** Saves the local copy somewhere outside the shared notebook (e.g. the editor's Download/Export). */
  onExport: () => void;
  /** Extra detail, e.g. "You are now a viewer." */
  detail?: string;
  onDismiss?: () => void;
  className?: string;
}

/** Shown on a document whose access was revoked or reduced; the local copy stays readable. */
export function AccessChangedBanner({ onExport, detail, onDismiss, className = "" }: AccessChangedBannerProps) {
  return (
    <div className={`${BANNER} ${className}`} data-tone="danger" role="alert">
      <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Your access to this notebook changed.</p>
        <p className="text-xs opacity-80">
          {detail ?? "This copy is read-only now. Your local work is kept on this device; export it to keep editing elsewhere."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-current/30 px-2 py-1 text-xs font-medium hover:bg-current/10"
          type="button"
          onClick={onExport}
        >
          <Download aria-hidden className="h-3.5 w-3.5" />
          Export
        </button>
        {onDismiss ? (
          <button aria-label="Dismiss" className="rounded-md p-1 hover:bg-current/10" type="button" onClick={onDismiss}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
