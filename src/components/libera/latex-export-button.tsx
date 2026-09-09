"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { DEFAULT_LATEX_OPTIONS, MAX_LATEX_CUSTOM_INSTRUCTIONS_LENGTH, latexToday, parseLatexOptions, type LatexOptions } from "@/lib/latex-options";
import { apiRequest } from "./api-client";
import { ModalDialog } from "./modal-dialog";

export function LatexExportButton({ getMarkdown, documentPath }: { getMarkdown: () => string; documentPath: string }) {
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [options, setOptions] = useState<LatexOptions>(DEFAULT_LATEX_OPTIONS);
  const [settingsError, setSettingsError] = useState("");
  const [headerMode, setHeaderMode] = useState("none");
  const [footerMode, setFooterMode] = useState("none");
  const [showAppName, setShowAppName] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ pdf: string; source: string; archive: boolean } | null>(null);
  const request = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);

  function releaseUrls() {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
  }
  useEffect(() => () => { request.current?.abort(); releaseUrls(); }, []);

  async function openSettings() {
    setLoadingSettings(true); setSettingsError("");
    let saved = options;
    try {
      saved = parseLatexOptions(await apiRequest<LatexOptions>("/api/preferences/latex", { cache: "no-store" }));
    } catch (failure) {
      setSettingsError(failure instanceof Error ? failure.message : "Could not load saved settings.");
    } finally {
      setOptions({ ...saved, date: saved.date || latexToday() });
      setHeaderMode(saved.header ? "custom" : "none");
      setFooterMode(saved.footer ? "custom" : "none");
      setShowAppName(saved.showAppName);
      setLoadingSettings(false); setSettingsOpen(true);
    }
  }

  async function start(selectedOptions = options) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setOpen(true); setBusy(true); setError(""); setResult(null); releaseUrls();
    setStatus("Starting LaTeX export…");
    try {
      const response = await fetch("/api/latex-export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: getMarkdown(), documentPath, options: selectedOptions }), signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Could not start LaTeX export (HTTP ${response.status}). The server failed before generation began; in a desktop build this can indicate a missing packaged dependency.`);
      }
      if (!response.body) throw new Error("The export response is empty.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let received = false;
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "progress") setStatus(event.message);
          if (event.type === "result") {
            const bytes = Uint8Array.from(atob(event.pdf), (character) => character.charCodeAt(0));
            const pdf = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            const source = event.archive
              ? URL.createObjectURL(new Blob([Uint8Array.from(atob(event.archive), (character) => character.charCodeAt(0))], { type: "application/zip" }))
              : URL.createObjectURL(new Blob([event.source], { type: "application/x-tex" }));
            urls.current = [pdf, source];
            setResult({ pdf, source, archive: !!event.archive }); received = true;
          }
        }
        if (done) break;
      }
      if (!received) throw new Error("The connection ended before the PDF was ready. Please retry.");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "LaTeX export failed.");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  function close() {
    request.current?.abort(); request.current = null;
    setBusy(false); setOpen(false); setResult(null); releaseUrls();
  }

  return <>
    <button type="button" aria-busy={busy || loadingSettings} disabled={loadingSettings} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" title="Export PDF with LaTeX" onClick={() => { if (busy) setOpen(true); else void openSettings(); }}>
      {(busy || loadingSettings) && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
      LATEX
    </button>
    <ModalDialog open={settingsOpen} title="LaTeX options" description="Choose the page layout and add custom instructions for your PDF." panelClassName="max-w-xl" onClose={() => { if (!savingSettings) setSettingsOpen(false); }}>
      <form className="max-h-[70vh] space-y-5 overflow-y-auto" onSubmit={async (event) => {
        event.preventDefault();
        if (savingSettings) return;
        const data = new FormData(event.currentTarget);
        setSavingSettings(true); setSettingsError("");
        try {
          const selected = parseLatexOptions({
            author: String(data.get("author") ?? ""),
            date: String(data.get("date") ?? ""),
            paperSize: data.get("paperSize"),
            fontSize: Number(data.get("fontSize")),
            imageWidth: Number(data.get("imageWidth")),
            margins: Object.fromEntries(["left", "right", "top", "bottom"].map((side) => [side, Number(data.get(side))])),
            header: headerMode === "custom" ? String(data.get("header") ?? "") : "",
            footer: footerMode === "custom" ? String(data.get("footer") ?? "") : "",
            showAppName,
            customInstructions: String(data.get("customInstructions") ?? ""),
          });
          await apiRequest<LatexOptions>("/api/preferences/latex", { method: "PUT", body: JSON.stringify(selected) });
          setOptions(selected); setSettingsOpen(false);
          void start(selected);
        } catch (failure) { setSettingsError(failure instanceof Error ? failure.message : "Check your options."); }
        finally { setSavingSettings(false); }
      }}>
        <label className="block space-y-1 text-sm">
          <span>Author</span>
          <input name="author" type="text" maxLength={500} defaultValue={options.author} placeholder="Author name (optional)" className="block w-full rounded-md border border-border bg-card px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Date</span>
          <input name="date" type="date" required min="1000-01-01" max="9999-12-31" defaultValue={options.date || latexToday()} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Paper size</span>
          <select name="paperSize" defaultValue={options.paperSize} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="a4">A4</option><option value="letter">Letter</option><option value="a5">A5</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Font size</span>
          <select name="fontSize" defaultValue={options.fontSize} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="10">10pt</option><option value="11">11pt</option><option value="12">12pt</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Image width (fraction of text width)</span>
          <input name="imageWidth" type="number" required min="0.01" max="1" step="any" defaultValue={options.imageWidth} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
          <span className="block text-xs text-muted-foreground">0.75 means 75% of the text width.</span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Margins (inches)</legend>
          <p className="text-xs text-muted-foreground">Adjust each margin independently.</p>
          <div className="grid grid-cols-2 gap-3">
            {(["left", "right", "top", "bottom"] as const).map((side) => <label key={side} className="block space-y-1 text-sm">
              <span className="capitalize">{side}</span>
              <input name={side} type="number" required min="0" step="any" defaultValue={options.margins[side]} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
            </label>)}
          </div>
        </fieldset>
        <label className="block space-y-1 text-sm">
          <span>Header</span>
          <select value={headerMode} onChange={(event) => setHeaderMode(event.target.value)} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="none">No text</option><option value="custom">Custom text</option>
          </select>
        </label>
        {headerMode === "custom" && <label className="block space-y-1 text-sm"><span>Header text (centered)</span><input name="header" type="text" maxLength={500} defaultValue={options.header} className="block w-full rounded-md border border-border bg-card px-3 py-2" /></label>}
        <label className="block space-y-1 text-sm">
          <span>Footer</span>
          <select value={footerMode} onChange={(event) => setFooterMode(event.target.value)} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="none">Page number / total pages</option><option value="custom">Custom text</option>
          </select>
        </label>
        {footerMode === "custom" && <label className="block space-y-1 text-sm"><span>Footer text ({showAppName ? "centered" : "left-aligned"})</span><input name="footer" type="text" maxLength={500} defaultValue={options.footer} className="block w-full rounded-md border border-border bg-card px-3 py-2" /></label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAppName} onChange={(event) => setShowAppName(event.target.checked)} />Show app name</label>
        <p className="text-xs text-muted-foreground">{showAppName ? "Libera by Thinh Hoang appears in the right footer. Footer text (or page number / total pages when blank) is centered." : "Footer text (or page number / total pages when blank) appears in the left footer."}</p>
        <label className="block space-y-1 text-sm">
          <span>Custom instructions (optional)</span>
          <textarea name="customInstructions" rows={5} maxLength={MAX_LATEX_CUSTOM_INSTRUCTIONS_LENGTH} defaultValue={options.customInstructions} placeholder="For example: Add a table of contents, use blue section headings, and keep tables near the text that references them." className="block w-full resize-y rounded-md border border-border bg-card px-3 py-2" />
          <span className="block text-xs text-muted-foreground">Tell the model how to prepare your document. Saved for future exports. Up to 10,000 characters; selected page settings take precedence.</span>
        </label>
        {settingsError && <p role="alert" className="text-sm text-red-600">{settingsError}</p>}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" disabled={savingSettings} onClick={() => setSettingsOpen(false)}>Cancel</button>
          <button type="submit" disabled={savingSettings} className="rounded-md bg-foreground px-3 py-2 text-sm text-background">{savingSettings ? "Saving settings…" : "Generate PDF"}</button>
        </div>
      </form>
    </ModalDialog>
    <ModalDialog open={open} title="LaTeX PDF export" panelClassName="max-w-5xl" onClose={close}
      footer={<>
        {result && <><a className="rounded-md border border-border px-3 py-2 text-sm" href={result.source} download={result.archive ? "document-latex.zip" : "document.tex"}>{result.archive ? "Save LaTeX + images" : "Save LaTeX"}</a><a className="rounded-md bg-foreground px-3 py-2 text-sm text-background" href={result.pdf} download="document.pdf">Save PDF</a></>}
        {error && <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void start()}>Retry</button>}
        <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={close}>{busy ? "Cancel" : "Close"}</button>
      </>}>
      {busy && <div role="status" aria-live="polite" className="flex min-h-40 flex-col items-center justify-center gap-4 py-8 text-center">
        <LoaderCircle aria-hidden="true" className="h-9 w-9 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{status}</p>
          <p className="text-xs text-muted-foreground">This may take a few minutes. You can cancel at any time.</p>
        </div>
      </div>}
      {error && <pre role="alert" className="max-h-64 overflow-auto whitespace-pre-wrap text-sm text-red-600">{error}</pre>}
      {result && <iframe title="Generated LaTeX PDF" src={result.pdf} className="h-[65vh] w-full rounded border border-border" />}
    </ModalDialog>
  </>;
}
