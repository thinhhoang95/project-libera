"use client";

import { startTransition, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import type { MarkdownPreviewRequest, MarkdownPreviewResponse } from "@/lib/markdown-preview";
import type { Root } from "hast";

type Props = ComponentProps<typeof MarkdownRenderer> & { onContentReady: (content: string) => void };
type Result = { markdown: string; tree: Root };

export function MarkdownWorkerPreview({ content, mathMarkers, onContentReady, ...props }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const request = useRef<((markdown: string, mathMarkers?: Props["mathMarkers"]) => void) | null>(null);
  const inline = mathMarkers?.inlineMathMarkers;
  const block = mathMarkers?.blockMathMarkers;
  const configured = mathMarkers !== undefined;

  useEffect(() => {
    let worker: Worker | null = null;
    let disposed = false;
    let failed = false;
    let sequence = 0;
    let latest: MarkdownPreviewRequest | null = null;
    let running: MarkdownPreviewRequest | null = null;
    let previousChildren: Root["children"] = [];
    function fail() {
      failed = true;
      worker?.terminate();
      worker = null;
      // Never silently put full-document parsing back on the typing thread.
      if (!disposed) setError("Preview unavailable. Reload to retry.");
    }
    function start() {
      if (disposed || failed || running || !latest) return;
      try {
        if (!worker) {
          worker = new Worker(new URL("../../lib/markdown-preview.worker.ts", import.meta.url), { type: "module" });
          worker.onerror = fail;
          worker.onmessage = (event: MessageEvent<MarkdownPreviewResponse>) => {
            if (disposed || !running || event.data.id !== running.id) return;
            const completed = running;
            running = null;
            const response = event.data;
            // Even an obsolete reply is the base of the worker's next patch.
            const tree: Root | null = response.children ? {
              type: "root",
              children: response.children.map((node) => typeof node === "number" ? previousChildren[node] : node),
            } : null;
            if (tree) previousChildren = tree.children;
            if (latest === completed) {
              if (tree) {
                startTransition(() => {
                  // A more recent edit may have arrived before React commits.
                  setResult((previous) => !disposed && latest === completed ? { markdown: completed.markdown, tree } : previous);
                  setError("");
                });
              } else setError("Could not prepare preview. Edit the document to retry.");
            } else start();
          };
        }
        running = latest;
        worker.postMessage(running);
      } catch { fail(); }
    }
    request.current = (markdown, settings) => {
      latest = { id: ++sequence, markdown, mathMarkers: settings };
      start();
    };
    return () => { disposed = true; request.current = null; worker?.terminate(); };
  }, []);

  useEffect(() => {
    request.current?.(content, configured ? { inlineMathMarkers: inline, blockMathMarkers: block } : undefined);
  }, [content, inline, block, configured]);

  useLayoutEffect(() => { if (result) onContentReady(result.markdown); }, [result, onContentReady]);

  return <>
    {error ? <p role="status" className="mb-3 text-sm text-muted-foreground">{error}</p> : null}
    {result ? <MarkdownRenderer {...props} content={result.markdown} preparedTree={result.tree} />
      : !error ? <p role="status" className="text-sm text-muted-foreground">Preparing preview…</p> : null}
  </>;
}
