"use client";

import { AlertCircle, AlertTriangle, ChevronDown, Info, Loader2, PictureInPicture2, Play, ScrollText, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { LatexTabViewState, OpenTab, OpenTabViewState } from "@/components/libera/types";
import type { LatexDiagnostic } from "@/lib/latex/build";
import type { LatexProjectData, LatexProjectFile } from "@/lib/latex/codemirror/editing";
import {
  LATEX_ENGINE_LABELS, hasDocumentClass, isCompilableLatexPath, readBibEntries, readLatexBibliographyReferences, readLatexLabels,
  readLatexMagicComments, resolveLatexEngine, resolveLatexRootPath, resolveRelativeNotebookPath, type BibEntrySummary, type LatexEngineSetting,
} from "@/lib/latex/project";
import { usesPackage } from "@/lib/latex/snippets";
import type { SynctexPdfLocation, SynctexSourceLocation } from "@/lib/latex/synctex";
import type { SynctexTextHint } from "@/lib/latex/synctex-text";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { SharedCodeMirrorSource } from "@/lib/collab/bindings/react-codemirror";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import { useHorizontalWheelScroll } from "../use-horizontal-wheel-scroll";
import { latexPdfUrl, requestLatexCompile, useLatexBuild } from "./latex-build-store";
import { LatexCacheDialog } from "./latex-cache-dialog";
import { LatexCompileMenu, type LatexCompileTarget } from "./latex-compile-menu";
import { LatexEditor, type LatexEditorHandle } from "./latex-editor";
import { registerLatexEditor } from "./latex-editor-registry";
import { LatexInsertToolbar } from "./latex-insert-toolbar";
import { LatexPdfPreview, type PdfHighlightRequest, type PdfZoom } from "./latex-pdf-preview";
import { closeLatexPdfWindow, openLatexPdfWindow, registerLatexPdfWindowHandlers, sendLatexPdfHighlight, useLatexPdfWindowOpen } from "./latex-pdf-window";
import { LatexSnippetDialog, type LatexSnippetDialogRequest } from "./latex-snippet-dialog";

type LatexWorkspaceProps = {
  tab: OpenTab;
  files: LiberaFileNode[];
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  readOpenTabs: () => OpenTab[];
  onSetDraft: (value: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onSave: () => Promise<void>;
  onSetViewState: (patch: LatexTabViewState) => void;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
  /** Shared tab: the editor binds the shared Y.Text and never publishes drafts. */
  collab?: SharedCodeMirrorSource;
};

const AUTO_COMPILE_DELAY_MS = 1200;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const compileShortcut = IS_MAC ? "⌘↵" : "Ctrl+Enter";
const SPLIT_STORAGE_KEY = "libera.latexEditorPreviewSplitPercent";
const MIN_SPLIT = 22;
const MAX_SPLIT = 78;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|eps|svg)$/i;

function readStoredSplit() {
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(SPLIT_STORAGE_KEY) ?? "");
    return Number.isFinite(stored) ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, stored)) : 50;
  } catch {
    return 50;
  }
}

function fileKind(file: LiberaFileNode): LatexProjectFile["kind"] {
  if (file.fileType === "latex") return /\.bib$/i.test(file.name) ? "bib" : /\.tex$/i.test(file.name) ? "tex" : "other";
  if (file.fileType === "pdf") return "pdf";
  if (file.fileType === "image" || IMAGE_FILE.test(file.name)) return "image";
  return "other";
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

const bibCache = new Map<string, { key: string; entries: BibEntrySummary[] }>();
/** Main files found for chapter files, so reopening a chapter needs no lookup. */
const discoveredRoots = new Map<string, string | null>();

/** The live text of another open tab for compile staging: shared tabs always (the disk copy may lag), others when edited. */
function stagedDraft(other: OpenTab): string | null {
  const shared = getSharedDocRegistry().readTabText(other.id);
  if (shared !== null) return shared;
  return other.draft === other.saved ? null : other.draft;
}

export function LatexWorkspace({ tab, files, fontFamily, fontSizePx, lineHeight, readOpenTabs, onSetDraft, onRegisterDraft, onSave, onSetViewState, onOpenFile, collab }: LatexWorkspaceProps) {
  const filePath = tab.file.path;
  const viewState = tab.viewState?.latex;
  const isTex = isCompilableLatexPath(filePath);
  const editorRef = useRef<LatexEditorHandle | null>(null);
  const [draftForAnalysis, setDraftForAnalysis] = useState(() => (collab ? getSharedDocRegistry().readTabText(tab.id) : null) ?? tab.draft);
  const knownLatexPaths = useMemo(() => new Set(files.filter((file) => file.fileType === "latex").map((file) => file.path)), [files]);
  // The file to typeset: a "% !TEX root" comment, the file itself when it is
  // a complete document, or else the main file that includes this chapter.
  const magicRoot = isTex && readLatexMagicComments(draftForAnalysis).root ? resolveLatexRootPath(filePath, draftForAnalysis, knownLatexPaths) : null;
  const standalone = isTex && hasDocumentClass(draftForAnalysis);
  const needsDiscovery = isTex && !standalone && (!magicRoot || magicRoot === filePath);
  const [discoveredRoot, setDiscoveredRoot] = useState<string | null | undefined>(() => discoveredRoots.get(filePath));
  useEffect(() => {
    if (!needsDiscovery || discoveredRoot !== undefined) return;
    let cancelled = false;
    void apiRequest<{ rootPath: string | null }>(`/api/latex/root?path=${encodeURIComponent(filePath)}`)
      .then(({ rootPath: found }) => found)
      .catch(() => null)
      .then((found) => {
        discoveredRoots.set(filePath, found);
        if (!cancelled) setDiscoveredRoot(found);
      });
    return () => { cancelled = true; };
  }, [discoveredRoot, filePath, needsDiscovery]);
  const resolvedRoot: string | null = !isTex ? null : magicRoot && magicRoot !== filePath ? magicRoot : standalone ? filePath : discoveredRoot ?? null;
  // "Compile current file" typesets this file on its own, which needs its own \documentclass.
  const currentDisabledReason = !standalone ? "Has no \\documentclass, so it cannot be typeset on its own" : resolvedRoot === filePath ? "This file is already the main file" : null;
  const compileTarget: LatexCompileTarget = viewState?.compileTarget === "current" && !currentDisabledReason ? "current" : "main";
  const rootPath = compileTarget === "current" ? filePath : resolvedRoot ?? filePath;
  const canCompile = compileTarget === "current" || resolvedRoot !== null;
  const build = useLatexBuild(rootPath);
  const engineSetting: LatexEngineSetting = viewState?.engine ?? "auto";
  const autoCompile = viewState?.autoCompile ?? true;
  const [aiError, setAiError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const [snippetDialog, setSnippetDialog] = useState<LatexSnippetDialogRequest | null>(null);
  const [highlight, setHighlight] = useState<PdfHighlightRequest | null>(null);
  const [logOpen, setLogOpen] = useState(viewState?.logOpen ?? false);
  const [rawLog, setRawLog] = useState(false);
  const [cacheDialogOpen, setCacheDialogOpen] = useState(false);
  const [compileMenuOpen, setCompileMenuOpen] = useState(false);
  const compileMenuAnchorRef = useRef<HTMLDivElement>(null);
  // The toolbar overflows sideways on narrow panes: no scrollbar, but the wheel scrolls it.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(toolbarRef);
  // The workspace renders on the client only, so storage can seed the state.
  const [splitPercent, setSplitPercent] = useState(readStoredSplit);
  const latestSplit = useRef(splitPercent);
  const [dragging, setDragging] = useState(false);
  const [bibEntries, setBibEntries] = useState<BibEntrySummary[]>([]);
  const splitRef = useRef<HTMLDivElement>(null);
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ readOpenTabs, engineSetting, onSave, autoCompile, rootPath, canCompile });
  useEffect(() => { latest.current = { readOpenTabs, engineSetting, onSave, autoCompile, rootPath, canCompile }; });

  useEffect(() => registerLatexEditor(tab.id, editorRef), [tab.id]);

  const shared = !!collab;
  const handleChange = useCallback((value: string) => {
    // A shared editor reports its text for analysis only; its edits are
    // already in the Y.Text, and re-applying a snapshot could undo a
    // collaborator's newer edit.
    if (!shared) onSetDraft(value);
    setDraftForAnalysis(value);
  }, [onSetDraft, shared]);

  /* ---- Compiling ------------------------------------------------------------ */

  const compile = useCallback(() => {
    if (!isTex || !latest.current.canCompile) return;
    const { rootPath: root } = latest.current;
    if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
    void requestLatexCompile(root, {
      read: () => {
        const drafts: Record<string, string> = { [filePath]: editorRef.current?.text() ?? tab.draft };
        for (const other of latest.current.readOpenTabs()) {
          if (other.id === tab.id || other.untitled || other.file.fileType !== "latex") continue;
          const staged = stagedDraft(other);
          if (staged !== null) drafts[other.file.path] = staged;
        }
        return { engine: latest.current.engineSetting, drafts };
      },
      onStart: () => editorRef.current?.markCompileStarted(),
      onFinish: (result) => { if (result?.fresh) editorRef.current?.markCompileShown(); },
    });
  }, [filePath, isTex, tab.draft, tab.id]);

  const scheduleAutoCompile = useCallback(() => {
    if (!latest.current.autoCompile || !isTex) return;
    if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
    autoCompileTimer.current = setTimeout(compile, AUTO_COMPILE_DELAY_MS);
  }, [compile, isTex]);

  useEffect(() => () => { if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current); }, []);

  // Show a PDF as soon as the document opens or the compile target changes.
  const initialCompileRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialCompileRef.current === rootPath || !isTex || !canCompile) return;
    initialCompileRef.current = rootPath;
    if (!build.result && !build.compiling) compile();
  }, [build.compiling, build.result, canCompile, compile, isTex, rootPath]);

  // A failed compile without a PDF opens the log so the cause is visible.
  const [seenVersion, setSeenVersion] = useState(build.version);
  if (build.version !== seenVersion) {
    setSeenVersion(build.version);
    if (build.result?.status === "failure" || build.requestError) setLogOpen(true);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      if (tab.status !== "saving") void onSave();
    } else if (key === "enter" && !event.shiftKey) {
      event.preventDefault();
      compile();
    }
  }

  /* ---- Project data for completion ------------------------------------------ */

  const directory = filePath.split("/").slice(0, -1).join("/");
  const projectFiles = useMemo<LatexProjectFile[]>(() => files
    .filter((file) => file.path.startsWith(`${directory}/`) && file.path !== filePath)
    .map((file) => ({ path: file.path.slice(directory.length + 1), kind: fileKind(file) }))
    .filter((file) => file.kind !== "other")
    .sort((left, right) => left.path.localeCompare(right.path)), [directory, filePath, files]);

  const bibPaths = useMemo(() => {
    const rootDirectory = rootPath.split("/").slice(0, -1).join("/");
    const references = readLatexBibliographyReferences(draftForAnalysis)
      .map((reference) => resolveRelativeNotebookPath(rootPath, reference))
      .filter((reference): reference is string => !!reference && knownLatexPaths.has(reference));
    if (references.length) return references;
    // Without an explicit bibliography, offer keys from .bib files beside the document.
    return [...knownLatexPaths].filter((path) => /\.bib$/i.test(path) && path.split("/").slice(0, -1).join("/") === rootDirectory).slice(0, 6);
  }, [draftForAnalysis, knownLatexPaths, rootPath]);

  const fileUpdatedAt = useMemo(() => new Map(files.map((file) => [file.path, file.updatedAt])), [files]);
  const bibKey = bibPaths.map((path) => `${path}@${fileUpdatedAt.get(path) ?? ""}`).join("|");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: BibEntrySummary[] = [];
      for (const path of bibPaths) {
        const openTab = latest.current.readOpenTabs().find((other) => other.file.path === path);
        const cacheKey = `${fileUpdatedAt.get(path) ?? ""}:${openTab?.draft.length ?? ""}`;
        let cached = bibCache.get(path);
        if (!cached || cached.key !== cacheKey) {
          const content = openTab?.draft ?? (await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`).then((payload) => payload.content ?? "").catch(() => ""));
          cached = { key: cacheKey, entries: readBibEntries(content) };
          bibCache.set(path, cached);
        }
        entries.push(...cached.entries);
      }
      if (!cancelled) setBibEntries(entries);
    })();
    return () => { cancelled = true; };
    // bibKey covers the paths and their versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bibKey, build.version]);

  // Refreshed after each compile, which follows edits in any open file.
  const otherLabels = useMemo(() => {
    void build.version;
    return readOpenTabs()
      .filter((other) => other.id !== tab.id && other.file.fileType === "latex" && other.file.notebook === tab.file.notebook)
      .flatMap((other) => readLatexLabels(other.draft));
  }, [build.version, readOpenTabs, tab.file.notebook, tab.id]);

  const project = useMemo<LatexProjectData>(() => ({ labels: otherLabels, bibEntries, files: projectFiles }), [bibEntries, otherLabels, projectFiles]);

  /** Of packages a chapter file could not load itself, those its main file lacks too. */
  const missingInMainFile = useCallback(async (packages: string[]) => {
    if (rootPath === filePath) return packages;
    const open = latest.current.readOpenTabs().find((other) => other.file.path === rootPath);
    const text = open?.draft ?? await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(rootPath)}`).then((payload) => payload.content ?? "").catch(() => null);
    return text === null ? packages : packages.filter((name) => !usesPackage(text, name));
  }, [filePath, rootPath]);

  /* ---- SyncTeX ---------------------------------------------------------------- */

  const openNotebookPath = useCallback(async (path: string, line: number, hint?: SynctexTextHint) => {
    if (path === filePath) {
      editorRef.current?.revealCompiledLine(line, 0, hint);
      return;
    }
    const file = files.find((candidate) => candidate.path === path);
    if (!file) {
      setSyncError(`${path} is not in this notebook.`);
      return;
    }
    await onOpenFile(file, { viewState: { latex: { revealLine: { line, hint, nonce: Date.now() } } } });
  }, [filePath, files, onOpenFile]);

  const inverseSync = useCallback(async ({ hint, ...location }: { page: number; x: number; y: number; hint?: SynctexTextHint }) => {
    if (!build.buildId) return;
    setSyncError("");
    try {
      const { location: source } = await apiRequest<{ location: SynctexSourceLocation | null }>("/api/latex/synctex", {
        method: "POST",
        body: JSON.stringify({ direction: "inverse", rootPath, buildId: build.buildId, ...location }),
      });
      if (source) await openNotebookPath(source.path, source.line, hint);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not find this spot in the source.");
    }
  }, [build.buildId, openNotebookPath, rootPath]);

  const forwardSync = useCallback(async (location: { line: number; column: number }) => {
    if (!build.buildId || !isTex) return;
    setSyncError("");
    try {
      const { locations } = await apiRequest<{ locations: SynctexPdfLocation[] }>("/api/latex/synctex", {
        method: "POST",
        body: JSON.stringify({ direction: "forward", rootPath, buildId: build.buildId, path: filePath, line: location.line, column: location.column }),
      });
      if (locations.length) setHighlight({ locations, nonce: Date.now() });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not find this spot in the PDF.");
    }
  }, [build.buildId, filePath, isTex, rootPath]);

  /* ---- PDF in a separate window ------------------------------------------------- */

  const pdfWindowOpen = useLatexPdfWindowOpen(rootPath);
  const showsPdfWindow = isTex && canCompile && pdfWindowOpen;

  useEffect(() => {
    if (!showsPdfWindow) return;
    return registerLatexPdfWindowHandlers(rootPath, { onInverseSync: (location) => void inverseSync(location), onCompile: compile });
  }, [compile, inverseSync, rootPath, showsPdfWindow]);

  useEffect(() => {
    if (showsPdfWindow && highlight) sendLatexPdfHighlight(rootPath, highlight);
  }, [highlight, rootPath, showsPdfWindow]);

  function togglePdfWindow() {
    if (pdfWindowOpen) {
      closeLatexPdfWindow(rootPath);
    } else if (!openLatexPdfWindow(rootPath)) {
      setSyncError("Could not open the PDF window. Please allow pop-up windows and try again.");
    }
  }

  // Requests from other views to reveal a line (outline, SyncTeX from another file).
  const revealLine = viewState?.revealLine;
  useEffect(() => {
    if (!revealLine) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.revealLine(revealLine.line, revealLine.hint);
      onSetViewState({ revealLine: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [onSetViewState, revealLine]);

  /* ---- Split ------------------------------------------------------------------ */

  function setSplit(value: number, persist = false) {
    latestSplit.current = value;
    setSplitPercent(value);
    if (persist) {
      try {
        if (window.localStorage.getItem(SPLIT_STORAGE_KEY) !== String(value)) window.localStorage.setItem(SPLIT_STORAGE_KEY, String(value));
      } catch { /* Storage may be unavailable. */ }
    }
  }

  function updateSplit(clientX: number, clientY: number) {
    const container = splitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const wide = window.matchMedia("(min-width: 1024px)").matches;
    const percent = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ((wide ? clientX - rect.left : clientY - rect.top) / (wide ? rect.width : rect.height)) * 100));
    setSplit(percent);
  }

  function startSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  /* ---- Diagnostics -------------------------------------------------------------- */

  const result = build.result;
  const diagnostics = useMemo(() => result?.diagnostics ?? [], [result]);
  const fileDiagnostics = useMemo(() => diagnostics.filter((diagnostic) => diagnostic.path === filePath && diagnostic.severity !== "info"), [diagnostics, filePath]);
  const counts = useMemo(() => ({
    error: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warning: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    info: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
  }), [diagnostics]);
  const resolvedEngine = resolveLatexEngine(draftForAnalysis, engineSetting);
  const pdfUrl = build.buildId ? latexPdfUrl(rootPath, build.buildId) : null;

  const status = isTex && !canCompile
    ? needsDiscovery && discoveredRoot === undefined ? "Finding the main file…" : "No main file"
    : build.compiling
    ? "Compiling…"
    : build.requestError
      ? build.requestError
      : !result
        ? isTex ? "Not compiled yet" : ""
        : result.status === "failure"
          ? "Compile failed"
          : result.status === "error"
            ? `Compiled with errors in ${formatDuration(result.durationMs)}`
            : `Compiled in ${formatDuration(result.durationMs)}`;

  function revealDiagnostic(diagnostic: LatexDiagnostic) {
    if (!diagnostic.path || !diagnostic.line) return;
    void openNotebookPath(diagnostic.path, diagnostic.line);
  }

  const editor = (
    <LatexEditor
      key={tab.id}
      documentPath={filePath}
      fileName={tab.file.name}
      value={tab.draft}
      fontFamily={fontFamily}
      fontSizePx={fontSizePx}
      lineHeight={lineHeight}
      initialViewState={viewState}
      diagnostics={fileDiagnostics}
      project={project}
      editorRef={editorRef}
      onChange={handleChange}
      onEdit={scheduleAutoCompile}
      onRegisterDraft={onRegisterDraft}
      collab={collab}
      onViewStateChange={onSetViewState}
      onCompile={compile}
      onForwardSync={(location) => void forwardSync(location)}
      onAiError={setAiError}
      onAddSnippet={(body) => { if (body.trim()) setSnippetDialog({ mode: "create", body }); }}
    />
  );

  const logPanel = logOpen ? (
    <LatexLogPanel
      diagnostics={diagnostics}
      log={result?.log || result?.output || ""}
      rawLog={rawLog}
      onRawLogChange={setRawLog}
      onReveal={revealDiagnostic}
      onClose={() => { setLogOpen(false); onSetViewState({ logOpen: false }); }}
    />
  ) : null;

  return (
    <div className="libera-latex-workspace flex min-h-0 flex-1 flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      {/* A container, so narrow panes drop the status text and shortcut hint. */}
      <div ref={toolbarRef} className="libera-latex-toolbar libera-horizontal-toolbar @container flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-border bg-card px-3">
        {isTex ? (
          <>
            <div ref={compileMenuAnchorRef} className="libera-latex-compile flex shrink-0 items-stretch overflow-hidden rounded-lg">
              <button type="button" className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium disabled:opacity-50" disabled={!canCompile} onClick={compile} title={`Recompile ${rootPath.split("/").at(-1)} (${compileShortcut})`} aria-keyshortcuts="Meta+Enter Control+Enter">
                {build.compiling ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden className="h-3.5 w-3.5" />}
                {compileTarget === "current" ? "Recompile file" : "Recompile"}
                <kbd className="hidden @min-[80rem]:inline">{compileShortcut}</kbd>
              </button>
              <button
                type="button"
                className="inline-flex items-center px-1.5"
                aria-label="Compile options"
                aria-haspopup="menu"
                aria-expanded={compileMenuOpen}
                title={`Compile options · ${LATEX_ENGINE_LABELS[resolvedEngine]}${autoCompile ? " · auto compile on" : ""}`}
                onClick={() => setCompileMenuOpen((open) => !open)}
              >
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
            {compileMenuOpen ? (
              <LatexCompileMenu
                anchorRef={compileMenuAnchorRef}
                target={compileTarget}
                mainName={resolvedRoot ? resolvedRoot.split("/").at(-1)! : needsDiscovery && discoveredRoot === undefined ? "Finding the main file…" : "No main file found"}
                currentName={tab.file.name}
                currentDisabledReason={currentDisabledReason}
                onSelect={(target) => onSetViewState({ compileTarget: target })}
                autoCompile={autoCompile}
                onAutoCompileChange={(value) => onSetViewState({ autoCompile: value })}
                engine={engineSetting}
                resolvedEngine={resolveLatexEngine(draftForAnalysis, "auto")}
                onEngineChange={(engine) => onSetViewState({ engine })}
                clearCacheDisabled={!canCompile || build.compiling}
                onClearCache={() => setCacheDialogOpen(true)}
                onClose={() => setCompileMenuOpen(false)}
              />
            ) : null}
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
            <LatexInsertToolbar
              editorRef={editorRef}
              projectFiles={projectFiles}
              onSnippetDialog={setSnippetDialog}
              missingInMainFile={missingInMainFile}
              onNotice={setNotice}
            />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{/\.bib$/i.test(filePath) ? "Bibliography database" : "LaTeX source"} · compile the main .tex file to see changes</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isTex && rootPath !== filePath ? <span className="max-w-[10rem] shrink-0 truncate text-xs text-muted-foreground" title={`Typesetting ${rootPath} (set by % !TEX root)`}>Main file: {rootPath.split("/").at(-1)}</span> : null}
          {isTex ? (
            <button
              type="button"
              className="libera-latex-status inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              aria-expanded={logOpen}
              onClick={() => { setLogOpen((open) => !open); onSetViewState({ logOpen: !logOpen }); }}
              title={status ? `${status} · Show logs and problems` : "Show logs and problems"}
            >
              <span className={`sr-only max-w-[14rem] truncate @min-[80rem]:not-sr-only ${result?.status === "failure" || build.requestError ? "text-destructive" : ""}`}>{status}</span>
              {counts.error ? <span className="inline-flex items-center gap-0.5 text-destructive"><AlertCircle aria-hidden className="h-3.5 w-3.5" />{counts.error}</span> : null}
              {counts.warning ? <span className="libera-latex-warning-count inline-flex items-center gap-0.5"><AlertTriangle aria-hidden className="h-3.5 w-3.5" />{counts.warning}</span> : null}
              <ScrollText aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {isTex ? (
            <button
              type="button"
              className="libera-latex-icon-button disabled:opacity-50"
              aria-label={pdfWindowOpen ? "Show PDF beside the editor" : "Open PDF in a separate window"}
              aria-pressed={pdfWindowOpen}
              title={pdfWindowOpen ? "Close the PDF window and show the PDF beside the editor" : "Open the PDF in a separate window"}
              disabled={!canCompile}
              onClick={togglePdfWindow}
            >
              <PictureInPicture2 aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {snippetDialog ? <LatexSnippetDialog request={snippetDialog} onClose={() => { setSnippetDialog(null); editorRef.current?.view.focus(); }} /> : null}

      {cacheDialogOpen && isTex && canCompile ? (
        <LatexCacheDialog
          rootPath={rootPath}
          onClose={() => setCacheDialogOpen(false)}
          onCleared={(recompile) => { if (recompile) compile(); }}
        />
      ) : null}

      {aiError || syncError ? (
        <div role="alert" className="flex items-start gap-2 border-b border-destructive/40 bg-destructive-muted px-4 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1">{aiError || syncError}</span>
          <button type="button" aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-destructive/10" onClick={() => { setAiError(""); setSyncError(""); }}><X aria-hidden className="h-4 w-4" /></button>
        </div>
      ) : null}

      {notice ? (
        <div role="status" className="flex items-start gap-2 border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-card" onClick={() => setNotice("")}><X aria-hidden className="h-4 w-4" /></button>
        </div>
      ) : null}

      {showsPdfWindow ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid min-h-0 flex-1">{editor}</div>
          {logPanel}
        </div>
      ) : isTex ? (
        <div
          ref={splitRef}
          className={`markdown-split-grid min-h-0 flex-1 overflow-hidden ${dragging ? "select-none" : ""}`}
          style={{ "--markdown-split": `${splitPercent}%` } as CSSProperties}
        >
          {editor}
          <div
            aria-label="Resize LaTeX editor and PDF"
            aria-orientation="vertical"
            aria-valuemax={MAX_SPLIT}
            aria-valuemin={MIN_SPLIT}
            aria-valuenow={Math.round(splitPercent)}
            className="markdown-split-resizer group flex cursor-row-resize items-center justify-center bg-muted outline-none hover:bg-input focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground lg:cursor-col-resize"
            role="separator"
            tabIndex={0}
            onPointerDown={startSplitDrag}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event.clientX, event.clientY); }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              updateSplit(event.clientX, event.clientY);
              setSplit(latestSplit.current, true);
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => { setDragging(false); setSplit(latestSplit.current, true); }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 5;
              if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); setSplit(Math.max(MIN_SPLIT, latestSplit.current - step), true); }
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); setSplit(Math.min(MAX_SPLIT, latestSplit.current + step), true); }
            }}
          >
            <span className="h-1 w-10 rounded-full bg-input transition group-hover:bg-muted-foreground lg:h-10 lg:w-1" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <LatexPdfPreview
              url={pdfUrl}
              zoom={(viewState?.pdfZoom ?? "width") as PdfZoom}
              initialScrollTop={viewState?.pdfScrollTop}
              initialScrollLeft={viewState?.pdfScrollLeft}
              highlight={highlight}
              busy={build.compiling}
              downloadUrl={build.buildId ? latexPdfUrl(rootPath, build.buildId, true) : null}
              emptyState={!canCompile ? (
                needsDiscovery && discoveredRoot === undefined
                  ? <span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />Finding the main file…</span>
                  : <span className="max-w-sm">This file has no <code>\documentclass</code>, and no main file includes it. Add <code>% !TEX root = main.tex</code> as its first line to typeset it with its main file.</span>
              ) : build.compiling ? <span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />Compiling your document…</span> : result?.status === "failure" ? "The document did not compile. Open the log to see why." : "Press Recompile to typeset the document."}
              onZoomChange={(zoom) => onSetViewState({ pdfZoom: zoom })}
              onScrollChange={(scrollTop, scrollLeft) => onSetViewState({ pdfScrollTop: scrollTop, pdfScrollLeft: scrollLeft })}
              onInverseSync={(location) => void inverseSync(location)}
            />
            {logPanel}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1">{editor}</div>
      )}
    </div>
  );
}

function LatexLogPanel({ diagnostics, log, rawLog, onRawLogChange, onReveal, onClose }: {
  diagnostics: LatexDiagnostic[];
  log: string;
  rawLog: boolean;
  onRawLogChange: (raw: boolean) => void;
  onReveal: (diagnostic: LatexDiagnostic) => void;
  onClose: () => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const visible = diagnostics.filter((diagnostic) => showInfo || diagnostic.severity !== "info");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (rawLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rawLog, log]);

  return (
    <section aria-label="Compile log" className="libera-latex-log flex max-h-[45%] min-h-32 shrink-0 flex-col border-t border-border bg-card">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium text-foreground">Problems</span>
        <div className="ml-2 inline-flex rounded-md border border-border p-0.5">
          <button type="button" className={`rounded px-2 py-0.5 ${rawLog ? "text-muted-foreground" : "bg-muted text-foreground"}`} onClick={() => onRawLogChange(false)}>List</button>
          <button type="button" className={`rounded px-2 py-0.5 ${rawLog ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => onRawLogChange(true)}>Raw log</button>
        </div>
        {!rawLog ? (
          <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={showInfo} onChange={(event) => setShowInfo(event.target.checked)} />
            Box warnings
          </label>
        ) : null}
        <button type="button" aria-label="Close log" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted" onClick={onClose}><X aria-hidden className="h-3.5 w-3.5" /></button>
      </div>
      {rawLog ? (
        <pre ref={logRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground">{log || "No log yet."}</pre>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto py-1 text-xs">
          {visible.length ? visible.map((diagnostic, index) => (
            <li key={index}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                disabled={!diagnostic.path || !diagnostic.line}
                onClick={() => onReveal(diagnostic)}
                title={diagnostic.details}
              >
                {diagnostic.severity === "error" ? <AlertCircle aria-label="Error" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> : diagnostic.severity === "warning" ? <AlertTriangle aria-label="Warning" className="libera-latex-warning-count mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info aria-label="Note" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-foreground">{diagnostic.message}</span>
                  {diagnostic.details ? <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{diagnostic.details.split("\n")[0]}</span> : null}
                </span>
                {diagnostic.path ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{diagnostic.path.split("/").at(-1)}{diagnostic.line ? `:${diagnostic.line}` : ""}</span> : null}
              </button>
            </li>
          )) : <li className="px-3 py-2 text-muted-foreground">{diagnostics.length ? "Only box warnings. Turn on “Box warnings” to see them." : "No problems."}</li>}
        </ul>
      )}
    </section>
  );
}
