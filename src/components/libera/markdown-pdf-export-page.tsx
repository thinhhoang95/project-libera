"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import type { MarkdownPreferences } from "@/lib/markdown-preferences";

type MarkdownPdfExportPayload = {
  content: string;
  documentPath?: string;
  title?: string;
};

type PendingRender = {
  reject: (reason?: unknown) => void;
  resolve: () => void;
};

type MarkdownPdfExportPageProps = {
  markdownPreferences: MarkdownPreferences;
};

function normalizePayload(payload: MarkdownPdfExportPayload): MarkdownPdfExportPayload {
  return {
    content: typeof payload.content === "string" ? payload.content : "",
    documentPath:
      typeof payload.documentPath === "string" ? payload.documentPath : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined,
  };
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForImages(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll("img"));

  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }

          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
}

async function waitForExportReady(root: HTMLElement) {
  await nextFrame();
  await nextFrame();
  await document.fonts?.ready;
  await waitForImages(root);
  await nextFrame();
}

export function MarkdownPdfExportPage({
  markdownPreferences,
}: MarkdownPdfExportPageProps) {
  const [payload, setPayload] = useState<MarkdownPdfExportPayload | null>(null);
  const pendingRendersRef = useRef<PendingRender[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const { documentElement } = document;
    const previousColorScheme = documentElement.style.colorScheme;
    const hadDarkClass = documentElement.classList.contains("dark");

    documentElement.classList.add("libera-markdown-export-mode");
    documentElement.classList.remove("dark");
    documentElement.style.colorScheme = "light";

    window.liberaMarkdownPdfExport = {
      render: (nextPayload) =>
        new Promise<void>((resolve, reject) => {
          pendingRendersRef.current.push({ reject, resolve });
          setPayload(normalizePayload(nextPayload));
        }),
    };

    return () => {
      documentElement.classList.remove("libera-markdown-export-mode");
      documentElement.classList.toggle("dark", hadDarkClass);
      documentElement.style.colorScheme = previousColorScheme;
      delete window.liberaMarkdownPdfExport;
    };
  }, []);

  useEffect(() => {
    if (!payload) {
      return;
    }

    if (payload.title) {
      document.title = payload.title;
    }

    let canceled = false;

    async function resolvePendingRenders() {
      try {
        const root = rootRef.current;

        if (!root) {
          throw new Error("Markdown export root is unavailable.");
        }

        await waitForExportReady(root);

        if (canceled) {
          return;
        }

        const pendingRenders = pendingRendersRef.current.splice(0);
        pendingRenders.forEach(({ resolve }) => resolve());
      } catch (error) {
        const pendingRenders = pendingRendersRef.current.splice(0);
        pendingRenders.forEach(({ reject }) => reject(error));
      }
    }

    void resolvePendingRenders();

    return () => {
      canceled = true;
    };
  }, [payload]);

  return (
    <main className="markdown-pdf-export-page">
      <article ref={rootRef} className="markdown-pdf-export-document">
        {payload ? (
          <MarkdownRenderer
            baseFontSize={markdownPreferences.pdfExportBaseFontSize}
            baseLineHeight={markdownPreferences.pdfExportBaseLineHeight}
            content={payload.content}
            documentPath={payload.documentPath}
          />
        ) : (
          <p className="markdown-pdf-export-loading">Preparing export...</p>
        )}
      </article>
    </main>
  );
}
