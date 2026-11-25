"use client";

import { AlertCircle, AlertTriangle, ChevronDown, Info, Loader2, PanelRightClose, PanelRightOpen, PictureInPicture2, Play, ScrollText, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LatexTabViewState, OpenTab, OpenTabViewState } from "@/components/libera/types";
import type { LatexDiagnostic } from "@/lib/latex/build";
import { latexLibraryEntries, type LatexProjectData, type LatexProjectFile } from "@/lib/latex/codemirror/editing";
import type { BibMirrorResult } from "@/lib/references/bib-mirror";
import { useReferenceLibrary } from "@/components/libera/references/use-reference-library";
import {
  LATEX_ENGINE_LABELS, hasDocumentClass, isCompilableLatexPath, readBibEntries, readCompiledBibliography, readLatexBibliographyReferences, readLatexLabels,
  readLatexMagicComments, resolveLatexEngine, resolveLatexRootPath, resolveRelativeNotebookPath, subfilesRootPath, type BibEntrySummary, type LatexEngineSetting,
} from "@/lib/latex/project";
import { bodyStartOf, collectLatexDefinitions, readLatexInputs } from "@/lib/latex/macros/definitions";
import type { NumberingStart } from "@/lib/latex/macros/numbering";
import { chapterNumberingStart } from "@/lib/latex/macros/project-numbering";
import type { MacroSource } from "@/lib/latex/codemirror/visual";
import { hashString } from "@/lib/macros/core";
import { usesPackage } from "@/lib/latex/snippets";
import type { SynctexPdfLocation, SynctexSourceLocation } from "@/lib/latex/synctex";
import type { SynctexTextHint } from "@/lib/latex/synctex-text";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";
import type { SharedCodeMirrorSource } from "@/lib/collab/bindings/react-codemirror";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import { useHorizontalWheelScroll } from "../use-horizontal-wheel-scroll";
import { inkPower } from "../ink/ink-power";
import { autoCompileDelayMs } from "./latex-auto-compile-delay";
import { onPathsMoved } from "../path-follow";
import { latexPdfUrl, latexRequestErrorText, requestLatexCompile, useLatexBuild } from "./latex-build-store";
import { LatexCacheDialog } from "./latex-cache-dialog";
import { latexCompileMenuItems, type LatexCompileTarget } from "./latex-compile-menu";
import { nativeMenuPointBelow, popupNativeMenu } from "../native-menu";
import { collectBodyIncludes, collectMacroSources, liveTabText, useDependencyVersion } from "./latex-dependencies";
import { LatexEditor, type LatexEditorHandle } from "./latex-editor";
import { registerLatexEditor } from "./latex-editor-registry";
import { LatexInsertToolbar } from "./latex-insert-toolbar";
import { LatexPdfPreview, type PdfHighlightRequest, type PdfZoom } from "./latex-pdf-preview";
import { closeLatexPdfWindow, openLatexPdfWindow, registerLatexPdfWindowHandlers, sendLatexPdfHighlight, useLatexPdfWindowOpen } from "./latex-pdf-window";
import { LatexSnippetDialog, type LatexSnippetDialogRequest } from "./latex-snippet-dialog";
import { beginDocumentIndex } from "@/lib/latex/document-begin";
import type { LatexImageSupport } from "./latex-image-drop";

type LatexWorkspaceProps = {
  tab: OpenTab;
  files: LiberaFileNode[];
  fontFamily: string;
  /** Visual mode's typeface: the visual editors' theme font (Preferences → Markdown → Themes), as in the TipTap editor. */
  visualFontFamily?: string;
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
  /** The user's math markers (Preferences → Markdown), for Markdown pasted into the editor. */
  mathMarkers?: MathMarkerSettings;
  /** Uploads into a notebook folder: images pasted or dropped into the editor are saved with it. */
  onUploadFiles?: (notebook: string, files: File[], destinationPath?: string, options?: { throwOnError?: boolean }) => Promise<LiberaFileNode[]>;
};

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

const bibCache = new Map<string, { key: string; entries: BibEntrySummary[] }>();/** Main files found for chapter files, so reopening a chapter needs no lookup. */
const discoveredRoots = new Map<string, string | null>();
/** Files that moved: a chapter's remembered main file follows it, and so does a main file that moved. */
export function followDiscoveredRootPaths(remap: (path: string) => string) {
  for (const [path, root] of [...discoveredRoots]) {
    const moved = remap(path);
    const movedRoot = root === null ? null : remap(root);
    if (moved === path && movedRoot === root) continue;
    discoveredRoots.delete(path);
    discoveredRoots.set(moved, movedRoot);
  }
}
onPathsMoved(followDiscoveredRootPaths);
/** Each notebook's Auto Compile choice, so reopening a file starts with it. */
const notebookAutoCompile = new Map<string, boolean>();

/** The live text of another open tab for compile staging: shared tabs always (the disk copy may lag), others when edited. */
function stagedDraft(other: OpenTab): string | null {
  const shared = getSharedDocRegistry().readTabText(other.id);
  if (shared !== null) return shared;
  return other.draft === other.saved ? null : other.draft;
}

/** Whether two macro source lists are equal field by field (a missing optional field equals an undefined one). */
function sameMacroSources(a: readonly MacroSource[], b: readonly MacroSource[]) {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return left.path === right.path && left.text === right.text && left.version === right.version && left.loadedBy === right.loadedBy && left.key === right.key;
  });
}

export function LatexWorkspace({ tab, files, fontFamily, visualFontFamily, fontSizePx, lineHeight, readOpenTabs, onSetDraft, onRegisterDraft, onSave, onSetViewState, onOpenFile, collab, mathMarkers, onUploadFiles }: LatexWorkspaceProps) {
  const t = useTranslations("latex.latexWorkspace");
  const tc = useTranslations("common");
  const tCompileMenu = useTranslations("latex.latexCompileMenu");
  const tBuild = useTranslations("latex.latexBuildStore");
  const format = useFormatter();
  const formatDuration = (milliseconds: number) => milliseconds < 1000
    ? format.number(milliseconds, { style: "unit", unit: "millisecond" })
    : format.number(milliseconds / 1000, { style: "unit", unit: "second", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const filePath = tab.file.path;
  const notebook = tab.file.notebook;
  const viewState = tab.viewState?.latex;
  // Read once: the preview restores from this when it first has a layout.
  const [initialPdfScrollAnchor] = useState(() => viewState?.pdfScrollPage === undefined
    ? undefined
    : { page: viewState.pdfScrollPage, offset: viewState.pdfScrollPageOffset ?? 0 });
  const isTex = isCompilableLatexPath(filePath);
  const editorRef = useRef<LatexEditorHandle | null>(null);
  const [draftForAnalysis, setDraftForAnalysis] = useState(() => (collab ? getSharedDocRegistry().readTabText(tab.id) : null) ?? tab.draft);
  const knownLatexPaths = useMemo(() => new Set(files.filter((file) => file.fileType === "latex").map((file) => file.path)), [files]);
  // The file to typeset: a "% !TEX root" comment, the file itself when it is
  // a complete document, or else the main file that includes this chapter.
  const magicRoot = useMemo(
    () => (isTex && readLatexMagicComments(draftForAnalysis).root ? resolveLatexRootPath(filePath, draftForAnalysis, knownLatexPaths) : null),
    [isTex, draftForAnalysis, filePath, knownLatexPaths],
  );
  const standalone = useMemo(() => isTex && hasDocumentClass(draftForAnalysis), [isTex, draftForAnalysis]);
  // A subfiles chapter (`\documentclass[../main.tex]{subfiles}`) compiles on its own too, but is part of the main file it names.
  const subfilesRoot = useMemo(() => (isTex ? subfilesRootPath(filePath, draftForAnalysis, knownLatexPaths) : null), [isTex, filePath, draftForAnalysis, knownLatexPaths]);
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
  const resolvedRoot: string | null = !isTex ? null : magicRoot && magicRoot !== filePath ? magicRoot : subfilesRoot ?? (standalone ? filePath : discoveredRoot ?? null);
  // "Compile current file" typesets this file on its own, which needs its own \documentclass.
  const currentDisabledReason = !standalone ? t("noDocumentClass") : resolvedRoot === filePath ? t("alreadyMainFile") : null;
  const compileTarget: LatexCompileTarget = viewState?.compileTarget === "current" && !currentDisabledReason ? "current" : "main";
  const rootPath = compileTarget === "current" ? filePath : resolvedRoot ?? filePath;
  const editorMode = viewState?.editorMode ?? "source";
  const canCompile = compileTarget === "current" || resolvedRoot !== null;
  const build = useLatexBuild(rootPath);
  const engineSetting: LatexEngineSetting = viewState?.engine ?? "auto";
  const [autoCompile, setAutoCompile] = useState(() => notebookAutoCompile.get(notebook) ?? true);
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
  const splitPointerRef = useRef<{ x: number; y: number; frame: number } | null>(null);
  const splitSeparatorRef = useRef<HTMLDivElement>(null);
  const [bibEntries, setBibEntries] = useState<BibEntrySummary[]>([]);
  const splitRef = useRef<HTMLDivElement>(null);
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Adaptive auto-compile pause: the last compile's duration, whether the PDF is on screen, and an automatic compile owed while the window was hidden.
  const lastCompileMs = useRef<number | null>(null);
  const pdfOffScreen = useRef(false);
  const autoCompileOwed = useRef(false);
  const compileRef = useRef<() => void>(() => undefined);
  const latest = useRef({ readOpenTabs, engineSetting, onSave, autoCompile, rootPath, canCompile, draftForAnalysis });
  useEffect(() => { latest.current = { readOpenTabs, engineSetting, onSave, autoCompile, rootPath, canCompile, draftForAnalysis }; });

  useEffect(() => registerLatexEditor(tab.id, editorRef), [tab.id]);

  useEffect(() => {
    if (!isTex || notebookAutoCompile.has(notebook)) return;
    let cancelled = false;
    void apiRequest<{ enabled: boolean }>(`/api/latex/auto-compile?notebook=${encodeURIComponent(notebook)}`)
      .then(({ enabled }) => {
        // A choice made while this loaded is newer than the answer.
        if (!notebookAutoCompile.has(notebook)) notebookAutoCompile.set(notebook, enabled);
        if (!cancelled) setAutoCompile(notebookAutoCompile.get(notebook) ?? enabled);
      })
      .catch(() => { /* Stay on the default; the menu still works for this session. */ });
    return () => { cancelled = true; };
  }, [isTex, notebook]);

  function changeAutoCompile(enabled: boolean) {
    notebookAutoCompile.set(notebook, enabled);
    setAutoCompile(enabled);
    void apiRequest("/api/latex/auto-compile", { method: "PUT", body: JSON.stringify({ notebook, enabled }) })
      .catch(() => setNotice(t("autoCompileSaveError")));
  }

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
    autoCompileOwed.current = false;
    let startedAt = 0;
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
      onStart: () => { startedAt = Date.now(); editorRef.current?.markCompileStarted(); },
      onFinish: (result) => {
        if (startedAt) lastCompileMs.current = Date.now() - startedAt;
        if (result?.fresh) editorRef.current?.markCompileShown();
      },
    });
  }, [filePath, isTex, tab.draft, tab.id]);
  useEffect(() => { compileRef.current = compile; }, [compile]);

  const scheduleAutoCompile = useCallback(() => {
    if (!latest.current.autoCompile || !isTex) return;
    if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
    // A hidden window does not typeset; the compile is owed until it is shown again.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      autoCompileOwed.current = true;
      return;
    }
    const delay = autoCompileDelayMs({ lastCompileMs: lastCompileMs.current, onBattery: inkPower.onBattery, pdfHidden: pdfOffScreen.current });
    autoCompileTimer.current = setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        autoCompileOwed.current = true;
        return;
      }
      compile();
    }, delay);
  }, [compile, isTex]);

  useEffect(() => () => { if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current); }, []);

  // The compile owed while the window was hidden runs once it is visible.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "visible" || !autoCompileOwed.current) return;
      autoCompileOwed.current = false;
      if (latest.current.autoCompile) compileRef.current();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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
  /** Every file beside the document, of any kind: what a missing `\input` or image is checked against (definition diagnostics). */
  const projectPaths = useMemo(() => files.filter((file) => file.path.startsWith(`${directory}/`)).map((file) => file.path.slice(directory.length + 1)), [directory, files]);

  // Pasted and dropped images are uploaded like files added in the explorer, then shown in a figure.
  const uploadRef = useRef(onUploadFiles);
  useEffect(() => { uploadRef.current = onUploadFiles; });
  const imageSupport = useMemo<LatexImageSupport | undefined>(() => (!onUploadFiles ? undefined : {
    files: files.map((file) => file.path),
    save: async (directory, file) => {
      const [saved] = await uploadRef.current!(directory.split("/")[0], [file], directory, { throwOnError: true });
      if (!saved) throw new Error("");
      return saved.path;
    },
  }), [files, onUploadFiles]);

  // Read once per draft: the whole document is scanned.
  const bibliographyReferences = useMemo(() => readLatexBibliographyReferences(draftForAnalysis), [draftForAnalysis]);
  const bibPaths = useMemo(() => {
    const rootDirectory = rootPath.split("/").slice(0, -1).join("/");
    const references = bibliographyReferences
      .map((reference) => resolveRelativeNotebookPath(rootPath, reference))
      .filter((reference): reference is string => !!reference && knownLatexPaths.has(reference));
    if (references.length) return references;
    // Without an explicit bibliography, offer keys from .bib files beside the document.
    return [...knownLatexPaths].filter((path) => /\.bib$/i.test(path) && path.split("/").slice(0, -1).join("/") === rootDirectory).slice(0, 6);
  }, [bibliographyReferences, knownLatexPaths, rootPath]);

  const fileUpdatedAt = useMemo(() => new Map(files.map((file) => [file.path, file.updatedAt])), [files]);
  const bibKey = bibPaths.map((path) => `${path}@${fileUpdatedAt.get(path) ?? ""}`).join("|");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: BibEntrySummary[] = [];
      for (const path of bibPaths) {
        const openTab = latest.current.readOpenTabs().find((other) => other.file.path === path);
        const cacheKey = `${fileUpdatedAt.get(path) ?? ""}:${openTab ? liveTabText(openTab).length : ""}`;
        let cached = bibCache.get(path);
        if (!cached || cached.key !== cacheKey) {
          const content = (openTab ? liveTabText(openTab) : null) ?? (await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`).then((payload) => payload.content ?? "").catch(() => ""));
          cached = { key: cacheKey, entries: readBibEntries(content) };
          bibCache.set(path, cached);
        }
        entries.push(...cached.entries);
      }
      // A key in two files (one .bib loaded twice under two names) is listed once: BibTeX uses the first.
      const seen = new Set<string>();
      if (!cancelled) setBibEntries(entries.filter((entry) => !seen.has(entry.key) && !!seen.add(entry.key)));
    })();
    return () => { cancelled = true; };
    // bibKey covers the paths and their versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bibKey, build.version]);

  // Compiled bibliographies, for citations a `.bib` does not cover (arXiv sources ship the `.bbl`, not the `.bib`):
  // the main file's `.bbl`, the main file's own `thebibliography` (a chapter's citations), and this file's.
  const compiledBibPaths = useMemo(() => {
    const paths: string[] = [];
    // A `.bbl` is not a LaTeX file type (it is not edited): it is found among all the notebook's files.
    const bbl = rootPath.replace(/\.(?:tex|ltx)$/i, ".bbl");
    if (bbl !== rootPath && files.some((file) => file.path === bbl)) paths.push(bbl);
    if (rootPath !== filePath) paths.push(rootPath);
    return paths;
  }, [filePath, files, rootPath]);
  const compiledBibKey = compiledBibPaths.map((path) => `${path}@${fileUpdatedAt.get(path) ?? ""}`).join("|");
  const [compiledBibEntries, setCompiledBibEntries] = useState<BibEntrySummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: BibEntrySummary[] = [];
      for (const path of compiledBibPaths) {
        const openTab = latest.current.readOpenTabs().find((other) => other.file.path === path);
        const cacheKey = `compiled:${fileUpdatedAt.get(path) ?? ""}:${openTab ? liveTabText(openTab).length : ""}`;
        let cached = bibCache.get(`compiled:${path}`);
        if (!cached || cached.key !== cacheKey) {
          const content = (openTab ? liveTabText(openTab) : null) ?? (await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`).then((payload) => payload.content ?? "").catch(() => ""));
          cached = { key: cacheKey, entries: readCompiledBibliography(content) };
          bibCache.set(`compiled:${path}`, cached);
        }
        entries.push(...cached.entries);
      }
      if (!cancelled) setCompiledBibEntries(entries);
    })();
    return () => { cancelled = true; };
    // compiledBibKey covers the paths and their versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledBibKey, build.version]);
  // This file's own `thebibliography`, read again only when it changes.
  const ownBibliographyText = useMemo(() => {
    const start = draftForAnalysis.search(/\\begin\s*\{thebibliography\}/);
    if (start < 0) return "";
    const end = draftForAnalysis.indexOf("\\end{thebibliography}", start);
    return draftForAnalysis.slice(start, end < 0 ? draftForAnalysis.length : end);
  }, [draftForAnalysis]);
  const ownBibliography = useMemo(() => (ownBibliographyText ? readCompiledBibliography(ownBibliographyText) : []), [ownBibliographyText]);
  // A `.bib` entry comes first; a compiled one fills in what it does not have.
  const allBibEntries = useMemo(() => (ownBibliography.length || compiledBibEntries.length ? [...bibEntries, ...ownBibliography, ...compiledBibEntries] : bibEntries), [bibEntries, compiledBibEntries, ownBibliography]);

  // Definitions the Visual mode needs from other files: the main file's
  // preamble (for a chapter), and the macro files and local packages a
  // preamble loads, and theirs. Read live from open tabs (shared ones from
  // their Y.Text), and read again when any of them changes.
  const ownPreamble = useMemo(() => draftForAnalysis.slice(0, bodyStartOf(draftForAnalysis) || 0), [draftForAnalysis]);
  // The files this one inputs: a body's `\input` of a `\providecommand` list a script generates (2610.16732) defines for the text after it.
  const bodyInputs = useMemo(() => (isTex ? readLatexInputs(draftForAnalysis).map((input) => input.path).join("\u0000") : ""), [isTex, draftForAnalysis]);
  const preambleHash = useMemo(() => hashString(ownPreamble), [ownPreamble]);
  const bodyInputsHash = useMemo(() => hashString(bodyInputs), [bodyInputs]);
  const [macroSources, setMacroSources] = useState<MacroSource[]>([]);
  const [macroPaths, setMacroPaths] = useState<string[]>([]);
  const macroVersion = useDependencyVersion(macroPaths, readOpenTabs, fileUpdatedAt);
  const readLiveText = useCallback(async (path: string) => {
    const open = latest.current.readOpenTabs().find((other) => other.file.path === path);
    if (open) return liveTabText(open);
    return apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`).then((payload) => payload.content ?? "").catch(() => "");
  }, []);
  const knownFiles = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const macroKey = `${rootPath}|${ownPreamble.length}|${preambleHash}|${bodyInputsHash}|${macroVersion}`;
  useEffect(() => {
    if (!isTex) return;
    let cancelled = false;
    void collectMacroSources({
      filePath, rootPath, ownPreamble, ownBody: latest.current.draftForAnalysis.slice(ownPreamble.length), known: knownFiles, readText: readLiveText, version: (path) => String(fileUpdatedAt.get(path) ?? ""),
    }).then(({ sources, paths }) => {
      if (cancelled) return;
      setMacroSources((current) => (sameMacroSources(current, sources) ? current : sources));
      setMacroPaths((current) => (current.join("\u0000") === paths.join("\u0000") ? current : paths));
    });
    return () => { cancelled = true; };
    // macroKey covers the preambles and the versions of the files read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macroKey, isTex, knownFiles]);

  // A chapter's counters continue from where its main file includes it; the
  // files included before it (and the definitions of theorems and counters)
  // count, so they are read live too.
  const [chapterStart, setNumberingStartState] = useState<NumberingStart | null>(null);
  const [chapterPaths, setChapterPaths] = useState<string[]>([]);
  const chapterVersion = useDependencyVersion(chapterPaths, readOpenTabs, fileUpdatedAt);
  const isChapter = isTex && rootPath !== filePath;
  const numberingStart = isChapter ? chapterStart : null;
  useEffect(() => {
    if (!isChapter) return;
    let cancelled = false;
    const read: string[] = [];
    const readText = async (path: string) => { read.push(path); return readLiveText(path); };
    // The main file's definitions in TeX's order, with its macro files, as the editor reads them: its preamble's (the
    // definitions its body makes before this chapter apply from where they are, which chapterNumberingStart reads).
    const rootSource = macroSources.find((source) => source.path === rootPath);
    const base = rootSource ? collectLatexDefinitions(macroSources.map((source) => {
      const body = source === rootSource ? beginDocumentIndex(source.text) : -1;
      return body >= 0 ? { ...source, text: source.text.slice(0, body) } : source;
    })) : undefined;
    void chapterNumberingStart(filePath, rootPath, readText, base).then((start) => {
      if (cancelled) return;
      setNumberingStartState((current) => (JSON.stringify(current) === JSON.stringify(start) ? current : start));
      setChapterPaths((current) => (current.join("\u0000") === read.join("\u0000") ? current : read));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [filePath, rootPath, isChapter, chapterVersion, macroSources, readLiveText, build.version]);

  // The files this one includes in its body: their sections, equations and
  // figures advance this file's numbers (a section after an included chapter).
  const [numberingIncludes, setNumberingIncludes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [includePaths, setIncludePaths] = useState<string[]>([]);
  const includeVersion = useDependencyVersion(includePaths, readOpenTabs, fileUpdatedAt);
  useEffect(() => {
    if (!isTex) return;
    let cancelled = false;
    void collectBodyIncludes({ filePath, rootPath, text: latest.current.draftForAnalysis, known: knownFiles, readText: readLiveText }).then(({ includes, paths }) => {
      if (cancelled) return;
      setNumberingIncludes((current) => (current.size === includes.size && [...includes].every(([key, text]) => current.get(key) === text) ? current : includes));
      setIncludePaths((current) => (current.join("\u0000") === paths.join("\u0000") ? current : paths));
    });
    return () => { cancelled = true; };
  }, [bodyInputs, filePath, rootPath, isTex, includeVersion, knownFiles, readLiveText]);

  // Refreshed after each compile, which follows edits in any open file.
  const otherLabels = useMemo(() => {
    void build.version;
    return readOpenTabs()
      .filter((other) => other.id !== tab.id && other.file.fileType === "latex" && other.file.notebook === tab.file.notebook)
      .flatMap((other) => readLatexLabels(liveTabText(other)));
  }, [build.version, readOpenTabs, tab.file.notebook, tab.id]);

  // The notebook's References: `\cite` offers their keys even before any .bib is referenced.
  const { library: referenceLibrary } = useReferenceLibrary(isTex ? tab.file.notebook : null);
  const libraryEntries = useMemo(() => latexLibraryEntries(referenceLibrary), [referenceLibrary]);
  // A chapter's bibliography lives in its main file; only a main file gets the add-bibliography hint.
  const hasBibliography = rootPath !== filePath || bibliographyReferences.length > 0;
  const enableBibMirror = useCallback(() => {
    void apiRequest<{ mirror: BibMirrorResult }>("/api/references/bib-mirror", { method: "POST", body: JSON.stringify({ notebook, enabled: true }) })
      .then(({ mirror }) => setNotice(mirror.status === "protected"
        ? t("bibMirrorEdited", { edited: mirror.editedPath ?? "", path: mirror.path })
        : t("bibMirrorGenerated", { path: mirror.path })))
      .catch((error: unknown) => setNotice(error instanceof Error && error.message ? error.message : t("couldNotEnableBibMirror")));
  }, [notebook, t]);
  const project = useMemo<LatexProjectData>(
    () => ({ labels: otherLabels, bibEntries: allBibEntries, files: projectFiles, allPaths: projectPaths, libraryEntries, hasBibliography, enableBibMirror }),
    [allBibEntries, otherLabels, projectFiles, projectPaths, libraryEntries, hasBibliography, enableBibMirror],
  );

  /** Of packages a chapter file could not load itself, those its main file lacks too. */
  const missingInMainFile = useCallback(async (packages: string[]) => {
    if (rootPath === filePath) return packages;
    const open = latest.current.readOpenTabs().find((other) => other.file.path === rootPath);
    const text = (open ? liveTabText(open) : null) ?? await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(rootPath)}`).then((payload) => payload.content ?? "").catch(() => null);
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
      setSyncError(t("fileNotInNotebook", { path }));
      return;
    }
    await onOpenFile(file, { viewState: { latex: { revealLine: { line, hint, nonce: Date.now() } } } });
  }, [filePath, files, onOpenFile, t]);

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
      setSyncError(error instanceof Error && error.message ? error.message : t("sourceSpotError"));
    }
  }, [build.buildId, openNotebookPath, rootPath, t]);

  const forwardSync = useCallback(async (location: { line: number; column: number }) => {
    if (!build.buildId || !isTex) return;
    setSyncError("");
    try {
      const { locations } = await apiRequest<{ locations: SynctexPdfLocation[] }>("/api/latex/synctex", {
        method: "POST",
        body: JSON.stringify({ direction: "forward", rootPath, buildId: build.buildId, path: filePath, line: location.line, column: location.column }),
      });
      if (locations.length) {
        // Asking for a spot in the PDF needs the PDF on screen.
        onSetViewState({ pdfHidden: false });
        setHighlight({ locations, nonce: Date.now() });
      }
    } catch (error) {
      setSyncError(error instanceof Error && error.message ? error.message : t("pdfSpotError"));
    }
  }, [build.buildId, filePath, isTex, onSetViewState, rootPath, t]);

  /* ---- PDF in a separate window ------------------------------------------------- */

  const pdfWindowOpen = useLatexPdfWindowOpen(rootPath);
  const showsPdfWindow = isTex && canCompile && pdfWindowOpen;
  const pdfHidden = viewState?.pdfHidden ?? false;
  useEffect(() => { pdfOffScreen.current = pdfHidden && !showsPdfWindow; }, [pdfHidden, showsPdfWindow]);

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
      onSetViewState({ pdfHidden: false });
    } else if (!openLatexPdfWindow(rootPath)) {
      setSyncError(t("pdfWindowError"));
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

  // Requests to select a range (a citation found from the References panel).
  const revealRange = viewState?.revealRange;
  useEffect(() => {
    if (!revealRange) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.revealRange(revealRange.start, revealRange.end, revealRange.snippet);
      onSetViewState({ revealRange: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [onSetViewState, revealRange]);

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

  function splitPercentAt(clientX: number, clientY: number) {
    const container = splitRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const wide = window.matchMedia("(min-width: 1024px)").matches;
    return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ((wide ? clientX - rect.left : clientY - rect.top) / (wide ? rect.width : rect.height)) * 100));
  }

  // A drag moves the split through a CSS variable once per frame; React hears about it once, at the end.
  function paintSplit() {
    const pointer = splitPointerRef.current;
    if (!pointer) return;
    pointer.frame = 0;
    const percent = splitPercentAt(pointer.x, pointer.y);
    if (percent === null) return;
    latestSplit.current = percent;
    splitRef.current?.style.setProperty("--markdown-split", `${percent}%`);
    splitSeparatorRef.current?.setAttribute("aria-valuenow", String(Math.round(percent)));
  }

  function updateSplit(clientX: number, clientY: number) {
    const pointer = splitPointerRef.current;
    if (!pointer) return;
    pointer.x = clientX;
    pointer.y = clientY;
    if (!pointer.frame) pointer.frame = requestAnimationFrame(paintSplit);
  }

  function startSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    splitPointerRef.current = { x: event.clientX, y: event.clientY, frame: 0 };
    splitRef.current?.classList.add("select-none");
  }

  /** Paints where the pointer last was, then hands the split to React and storage. */
  function endSplitDrag(clientX?: number, clientY?: number) {
    const pointer = splitPointerRef.current;
    if (!pointer) return;
    if (clientX !== undefined && clientY !== undefined) { pointer.x = clientX; pointer.y = clientY; }
    cancelAnimationFrame(pointer.frame);
    paintSplit();
    splitPointerRef.current = null;
    splitRef.current?.classList.remove("select-none");
    setSplit(latestSplit.current, true);
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
  // A stable identity for the PDF pages (they are memoized): it always calls the latest inverseSync.
  const inverseSyncRef = useRef(inverseSync);
  useEffect(() => { inverseSyncRef.current = inverseSync; });
  const onInverseSync = useCallback((location: Parameters<typeof inverseSync>[0]) => { void inverseSyncRef.current(location); }, []);
  const resolvedEngine = useMemo(() => resolveLatexEngine(draftForAnalysis, engineSetting), [draftForAnalysis, engineSetting]);
  const pdfUrl = build.buildId ? latexPdfUrl(rootPath, build.buildId) : null;

  const status = isTex && !canCompile
    ? needsDiscovery && discoveredRoot === undefined ? t("findingMainFile") : t("noMainFile")
    : build.compiling
    ? t("compiling")
    : build.requestError
      ? latexRequestErrorText(build.requestError, tBuild("compileFailed"))
      : !result
        ? isTex ? t("notCompiledYet") : ""
        : result.status === "failure"
          ? t("compileFailed")
          : result.status === "error"
            ? t("compiledWithErrorsIn", { duration: formatDuration(result.durationMs) })
            : t("compiledIn", { duration: formatDuration(result.durationMs) });

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
      visualFontFamily={visualFontFamily}
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
      editorMode={isTex ? editorMode : "source"}
      macroSources={macroSources}
      auxData={build.aux ?? null}
      numberingStart={numberingStart}
      numberingIncludes={numberingIncludes}
      rootPath={rootPath}
      mathMarkers={mathMarkers}
      engine={engineSetting}
      images={isTex ? imageSupport : undefined}
    />
  );

  async function openCompileMenu() {
    const anchor = compileMenuAnchorRef.current;
    if (!anchor) return;
    setCompileMenuOpen(true);
    await popupNativeMenu(latexCompileMenuItems({
      target: compileTarget,
      mainName: resolvedRoot ? resolvedRoot.split("/").at(-1)! : needsDiscovery && discoveredRoot === undefined ? t("findingMainFile") : t("noMainFileFound"),
      currentName: tab.file.name,
      currentDisabledReason,
      onSelect: (target) => onSetViewState({ compileTarget: target }),
      autoCompile,
      onAutoCompileChange: changeAutoCompile,
      engine: engineSetting,
      resolvedEngine: resolveLatexEngine(draftForAnalysis, "auto"),
      onEngineChange: (engine) => onSetViewState({ engine }),
      clearCacheDisabled: !canCompile || build.compiling,
      onClearCache: () => setCacheDialogOpen(true),
      t: tCompileMenu,
    }), nativeMenuPointBelow(anchor));
    setCompileMenuOpen(false);
  }

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
              <button type="button" className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium disabled:opacity-50" disabled={!canCompile} onClick={compile} title={t("recompileTitle", { name: rootPath.split("/").at(-1) ?? "", shortcut: compileShortcut })} aria-keyshortcuts="Meta+Enter Control+Enter">
                {build.compiling ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden className="h-3.5 w-3.5" />}
                {compileTarget === "current" ? t("recompileFile") : t("recompile")}
                <kbd className="hidden @min-[80rem]:inline">{compileShortcut}</kbd>
              </button>
              <button
                type="button"
                className="inline-flex items-center px-1.5"
                aria-label={t("compileOptions")}
                aria-haspopup="menu"
                aria-expanded={compileMenuOpen}
                title={t(autoCompile ? "compileOptionsAutoTitle" : "compileOptionsTitle", { engine: LATEX_ENGINE_LABELS[resolvedEngine] })}
                onClick={() => void openCompileMenu()}
              >
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
            <LatexInsertToolbar
              editorRef={editorRef}
              projectFiles={projectFiles}
              onSnippetDialog={setSnippetDialog}
              missingInMainFile={missingInMainFile}
              onNotice={setNotice}
              fontSizePx={fontSizePx}
              visualMode={editorMode === "visual"}
            />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{t("nonTexHint", { kind: /\.bib$/i.test(filePath) ? t("bibliographyDatabase") : t("latexSource") })}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isTex && rootPath !== filePath ? <span className="max-w-[10rem] shrink-0 truncate text-xs text-muted-foreground" title={t("typesettingTitle", { path: rootPath })}>{t("mainFile", { name: rootPath.split("/").at(-1) ?? "" })}</span> : null}
          {isTex ? (
            <button
              type="button"
              className="libera-latex-status inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              aria-expanded={logOpen}
              onClick={() => { setLogOpen((open) => !open); onSetViewState({ logOpen: !logOpen }); }}
              title={status ? t("statusWithLogs", { status }) : t("showLogs")}
            >
              <span className={`sr-only max-w-[14rem] truncate @min-[80rem]:not-sr-only ${result?.status === "failure" || build.requestError ? "text-destructive" : ""}`}>{status}</span>
              {counts.error ? <span className="inline-flex items-center gap-0.5 text-destructive"><AlertCircle aria-hidden className="h-3.5 w-3.5" />{counts.error}</span> : null}
              {counts.warning ? <span className="libera-latex-warning-count inline-flex items-center gap-0.5"><AlertTriangle aria-hidden className="h-3.5 w-3.5" />{counts.warning}</span> : null}
              <ScrollText aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {isTex ? (
          // Pinned: on narrow panes the toolbar scrolls, and with the PDF hidden this is the way back.
          <div className="libera-latex-pane-toggles sticky right-0 z-10 flex shrink-0 items-center gap-2 bg-card pl-1">
            <button
              type="button"
              className="libera-latex-icon-button disabled:opacity-50"
              aria-label={pdfHidden ? t("showPdfPane") : t("hidePdfPane")}
              title={showsPdfWindow ? t("pdfInSeparateWindow") : pdfHidden ? t("showPdfPane") : t("hidePdfPane")}
              disabled={showsPdfWindow}
              onClick={() => onSetViewState({ pdfHidden: !pdfHidden })}
            >
              {pdfHidden ? <PanelRightOpen aria-hidden className="h-4 w-4" /> : <PanelRightClose aria-hidden className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className="libera-latex-icon-button disabled:opacity-50"
              aria-label={pdfWindowOpen ? t("showPdfBeside") : t("openPdfWindow")}
              aria-pressed={pdfWindowOpen}
              title={pdfWindowOpen ? t("closePdfWindowTitle") : t("openPdfWindowTitle")}
              disabled={!canCompile}
              onClick={togglePdfWindow}
            >
              <PictureInPicture2 aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ) : null}
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
          <button type="button" aria-label={tc("dismiss")} className="shrink-0 rounded p-0.5 hover:bg-destructive/10" onClick={() => { setAiError(""); setSyncError(""); }}><X aria-hidden className="h-4 w-4" /></button>
        </div>
      ) : null}

      {notice ? (
        <div role="status" className="flex items-start gap-2 border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label={tc("dismiss")} className="shrink-0 rounded p-0.5 hover:bg-card" onClick={() => setNotice("")}><X aria-hidden className="h-4 w-4" /></button>
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
          className="markdown-split-grid min-h-0 flex-1 overflow-hidden"
          // Hidden, the editor stacks over the log; the preview stays mounted to keep its PDF and place.
          style={pdfHidden ? { display: "flex", flexDirection: "column" } : { "--markdown-split": `${splitPercent}%` } as CSSProperties}
        >
          <div className="grid min-h-0 min-w-0 flex-1">{editor}</div>
          <div
            ref={splitSeparatorRef}
            aria-label={t("resizeEditorAndPdf")}
            aria-orientation="vertical"
            aria-valuemax={MAX_SPLIT}
            aria-valuemin={MIN_SPLIT}
            aria-valuenow={Math.round(splitPercent)}
            className="markdown-split-resizer group flex cursor-row-resize items-center justify-center bg-muted outline-none hover:bg-input focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground lg:cursor-col-resize"
            role="separator"
            style={pdfHidden ? { display: "none" } : undefined}
            tabIndex={0}
            onPointerDown={startSplitDrag}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event.clientX, event.clientY); }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              endSplitDrag(event.clientX, event.clientY);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => endSplitDrag()}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 5;
              if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); setSplit(Math.max(MIN_SPLIT, latestSplit.current - step), true); }
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); setSplit(Math.min(MAX_SPLIT, latestSplit.current + step), true); }
            }}
          >
            <span className="h-1 w-10 rounded-full bg-input transition group-hover:bg-muted-foreground lg:h-10 lg:w-1" />
          </div>
          <div className={pdfHidden ? "contents" : "flex min-h-0 min-w-0 flex-col overflow-hidden"}>
            <LatexPdfPreview
              url={pdfUrl}
              hidden={pdfHidden}
              zoom={(viewState?.pdfZoom ?? "width") as PdfZoom}
              initialScrollTop={viewState?.pdfScrollTop}
              initialScrollLeft={viewState?.pdfScrollLeft}
              initialScrollAnchor={initialPdfScrollAnchor}
              highlight={highlight}
              busy={build.compiling}
              downloadUrl={build.buildId ? latexPdfUrl(rootPath, build.buildId, true) : null}
              emptyState={!canCompile ? (
                needsDiscovery && discoveredRoot === undefined
                  ? <span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t("findingMainFile")}</span>
                  : <span className="max-w-sm">{t.rich("noDocumentClassHint", { code: (chunks) => <code>{chunks}</code> })}</span>
              ) : build.compiling ? <span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t("compilingDocument")}</span> : result?.status === "failure" ? t("documentDidNotCompile") : t("pressRecompile")}
              onZoomChange={(zoom) => onSetViewState({ pdfZoom: zoom })}
              onScrollChange={(scrollTop, scrollLeft, anchor) => onSetViewState({
                pdfScrollTop: scrollTop, pdfScrollLeft: scrollLeft, pdfScrollPage: anchor?.page, pdfScrollPageOffset: anchor?.offset,
              })}
              onInverseSync={onInverseSync}
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
  const t = useTranslations("latex.latexWorkspace");
  const [showInfo, setShowInfo] = useState(false);
  const visible = diagnostics.filter((diagnostic) => showInfo || diagnostic.severity !== "info");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (rawLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rawLog, log]);

  return (
    <section aria-label={t("compileLogLabel")} className="libera-latex-log flex max-h-[45%] min-h-32 shrink-0 flex-col border-t border-border bg-card">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium text-foreground">{t("problems")}</span>
        <div className="ml-2 inline-flex rounded-md border border-border p-0.5">
          <button type="button" className={`rounded px-2 py-0.5 ${rawLog ? "text-muted-foreground" : "bg-muted text-foreground"}`} onClick={() => onRawLogChange(false)}>{t("listView")}</button>
          <button type="button" className={`rounded px-2 py-0.5 ${rawLog ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => onRawLogChange(true)}>{t("rawLog")}</button>
        </div>
        {!rawLog ? (
          <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={showInfo} onChange={(event) => setShowInfo(event.target.checked)} />
            {t("boxWarnings")}
          </label>
        ) : null}
        <button type="button" aria-label={t("closeLog")} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted" onClick={onClose}><X aria-hidden className="h-3.5 w-3.5" /></button>
      </div>
      {rawLog ? (
        <pre ref={logRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground">{log || t("noLogYet")}</pre>
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
                {diagnostic.severity === "error" ? <AlertCircle aria-label={t("diagnosticError")} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> : diagnostic.severity === "warning" ? <AlertTriangle aria-label={t("diagnosticWarning")} className="libera-latex-warning-count mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info aria-label={t("diagnosticNote")} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-foreground">{diagnostic.message}</span>
                  {diagnostic.details ? <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{diagnostic.details.split("\n")[0]}</span> : null}
                </span>
                {diagnostic.path ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{diagnostic.path.split("/").at(-1)}{diagnostic.line ? `:${diagnostic.line}` : ""}</span> : null}
              </button>
            </li>
          )) : <li className="px-3 py-2 text-muted-foreground">{diagnostics.length ? t("onlyBoxWarnings") : t("noProblems")}</li>}
        </ul>
      )}
    </section>
  );
}
