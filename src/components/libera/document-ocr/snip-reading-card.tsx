"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarkdownScreenshotSnipSession } from "@/components/libera/types";

/** Shown while a Markdown snip is read: the elapsed time and a way to stop. */
export function SnipReadingCard({ session, onCancel }: { session: MarkdownScreenshotSnipSession | null; onCancel: () => void }) {
  const startedAt = session?.converting?.startedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return null;
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));

  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-lg"
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin text-muted-foreground" />
      <span>Reading the snip into Markdown… {seconds}s</span>
      <button type="button" className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
