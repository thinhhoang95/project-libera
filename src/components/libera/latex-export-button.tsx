"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { DEFAULT_LATEX_OPTIONS, MAX_LATEX_CUSTOM_INSTRUCTIONS_LENGTH, latexToday, parseLatexOptions, type LatexOptions } from "@/lib/latex-options";
import { apiRequest } from "./api-client";
import { ModalDialog } from "./modal-dialog";

export function LatexExportButton({ getMarkdown, documentPath }: { getMarkdown: () => string; documentPath: string }) {
  const t = useTranslations("latexExportButton");
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
      setSettingsError(failure instanceof Error ? failure.message : t("couldNotLoadSettings"));
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
    setStatus(t("startingExport"));
    try {
      const response = await fetch("/api/latex-export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: getMarkdown(), documentPath, options: selectedOptions }), signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || t("couldNotStartExport", { status: response.status }));
      }
      if (!response.body) throw new Error(t("exportEmpty"));
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
      if (!received) throw new Error(t("connectionEnded"));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("exportFailed"));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  function close() {
    request.current?.abort(); request.current = null;
    setBusy(false); setOpen(false); setResult(null); releaseUrls();
  }

  return <>
    <button type="button" aria-busy={busy || loadingSettings} disabled={loadingSettings} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" title={t("exportButtonTitle")} onClick={() => { if (busy) setOpen(true); else void openSettings(); }}>
      {(busy || loadingSettings) && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
      {t("latexButton")}
    </button>
    <ModalDialog open={settingsOpen} title={t("latexOptions")} description={t("latexOptionsDescription")} panelClassName="max-w-xl" onClose={() => { if (!savingSettings) setSettingsOpen(false); }}
      footer={<>
        <button type="button" disabled={savingSettings} onClick={() => setSettingsOpen(false)}>{t("cancel")}</button>
        <button type="submit" form="latex-options-form" disabled={savingSettings} className="libera-dialog-primary"><span className="libera-btn-label">{savingSettings ? t("savingSettings") : t("generatePdf")}</span></button>
      </>}>

      <form id="latex-options-form" className="space-y-5" onSubmit={async (event) => {
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
            citations: data.get("citations") === "biblatex" ? "biblatex" : "formatted",
          });
          await apiRequest<LatexOptions>("/api/preferences/latex", { method: "PUT", body: JSON.stringify(selected) });
          setOptions(selected); setSettingsOpen(false);
          void start(selected);
        } catch (failure) { setSettingsError(failure instanceof Error ? failure.message : t("checkOptions")); }
        finally { setSavingSettings(false); }
      }}>
        <label className="block space-y-1 text-sm">
          <span>{t("author")}</span>
          <input name="author" type="text" maxLength={500} defaultValue={options.author} placeholder={t("authorPlaceholder")} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("date")}</span>
          <input name="date" type="date" required min="1000-01-01" max="9999-12-31" defaultValue={options.date || latexToday()} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("paperSize")}</span>
          <select name="paperSize" defaultValue={options.paperSize} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="a4">{t("paperA4")}</option><option value="letter">{t("paperLetter")}</option><option value="a5">{t("paperA5")}</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("fontSize")}</span>
          <select name="fontSize" defaultValue={options.fontSize} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="10">{t("fontSize10")}</option><option value="11">{t("fontSize11")}</option><option value="12">{t("fontSize12")}</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("imageWidth")}</span>
          <input name="imageWidth" type="number" required min="0.01" max="1" step="any" defaultValue={options.imageWidth} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
          <span className="block text-xs text-muted-foreground">{t("imageWidthHelp")}</span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("margins")}</legend>
          <p className="text-xs text-muted-foreground">{t("marginsHelp")}</p>
          <div className="grid grid-cols-2 gap-3">
            {(["left", "right", "top", "bottom"] as const).map((side) => <label key={side} className="block space-y-1 text-sm">
              <span>{t(`side.${side}`)}</span>
              <input name={side} type="number" required min="0" step="any" defaultValue={options.margins[side]} className="block w-full rounded-md border border-border bg-card px-3 py-2" />
            </label>)}
          </div>
        </fieldset>
        <label className="block space-y-1 text-sm">
          <span>{t("header")}</span>
          <select value={headerMode} onChange={(event) => setHeaderMode(event.target.value)} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="none">{t("noText")}</option><option value="custom">{t("customText")}</option>
          </select>
        </label>
        {headerMode === "custom" && <label className="block space-y-1 text-sm"><span>{t("headerTextCentered")}</span><input name="header" type="text" maxLength={500} defaultValue={options.header} className="block w-full rounded-md border border-border bg-card px-3 py-2" /></label>}
        <label className="block space-y-1 text-sm">
          <span>{t("footer")}</span>
          <select value={footerMode} onChange={(event) => setFooterMode(event.target.value)} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="none">{t("pageNumberTotal")}</option><option value="custom">{t("customText")}</option>
          </select>
        </label>
        {footerMode === "custom" && <label className="block space-y-1 text-sm"><span>{showAppName ? t("footerTextCentered") : t("footerTextLeft")}</span><input name="footer" type="text" maxLength={500} defaultValue={options.footer} className="block w-full rounded-md border border-border bg-card px-3 py-2" /></label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAppName} onChange={(event) => setShowAppName(event.target.checked)} />{t("showAppName")}</label>
        <p className="text-xs text-muted-foreground">{showAppName ? t("appNameFooterHelp") : t("footerLeftHelp")}</p>
        <label className="block space-y-1 text-sm">
          <span>{t("citations")}</span>
          <select name="citations" defaultValue={options.citations} className="block w-full rounded-md border border-border bg-card px-3 py-2">
            <option value="formatted">{t("formattedText")}</option><option value="biblatex">{t("biblatex")}</option>
          </select>
          <span className="block text-xs text-muted-foreground">{t("citationsHelp")}</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("customInstructions")}</span>
          <textarea name="customInstructions" rows={5} maxLength={MAX_LATEX_CUSTOM_INSTRUCTIONS_LENGTH} defaultValue={options.customInstructions} placeholder={t("customInstructionsPlaceholder")} className="block w-full resize-y rounded-md border border-border bg-card px-3 py-2" />
          <span className="block text-xs text-muted-foreground">{t("customInstructionsHelp")}</span>
        </label>
        {settingsError && <p role="alert" className="text-sm text-red-600">{settingsError}</p>}

      </form>
    </ModalDialog>
    <ModalDialog open={open} title={t("latexPdfExport")} panelClassName="max-w-5xl" onClose={close}
      footer={<>
        {result && <><a className="rounded-md border border-border px-3 py-2 text-sm" href={result.source} download={result.archive ? "document-latex.zip" : "document.tex"}>{result.archive ? t("saveLatexZip") : t("saveLatex")}</a><a className="rounded-md bg-foreground px-3 py-2 text-sm text-background" href={result.pdf} download="document.pdf">{t("savePdf")}</a></>}
        {error && <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void start()}>{t("retry")}</button>}
        <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={close}>{busy ? t("cancel") : t("close")}</button>
      </>}>
      {busy && <div role="status" aria-live="polite" className="flex min-h-40 flex-col items-center justify-center gap-4 py-8 text-center">
        <LoaderCircle aria-hidden="true" className="h-9 w-9 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{status}</p>
          <p className="text-xs text-muted-foreground">{t("mayTakeFewMinutes")}</p>
        </div>
      </div>}
      {error && <pre role="alert" className="max-h-64 overflow-auto whitespace-pre-wrap text-sm text-red-600">{error}</pre>}
      {result && <iframe title={t("generatedPdfTitle")} src={result.pdf} className="h-[65vh] w-full rounded border border-border" />}
    </ModalDialog>
  </>;
}
