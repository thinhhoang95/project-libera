"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, Folder, Loader2, Plus, Search } from "lucide-react";
import { FileSelectionActions } from "./file-selection-actions";
import { numberFormat } from "@/lib/i18n/format";
import { apiRequest } from "./api-client";
import type { InterruptedMigration, MigrationPlan, MigrationRequest, MigrationResult } from "@/lib/storage/migration";
import type { LiberaFileNode, LiberaNotebookGroup, LiberaNotebookNode, LiberaTree, LiberaTreeNode } from "@/lib/types";
import { useCollabShell } from "./collab/collab-provider";
import { FileTypeIcon } from "./file-type";
import { ModalDialog } from "./modal-dialog";
import { NotebookDialog } from "./notebook-dialog";
import type { NotebookFormValues, OpenTab } from "./types";

// Move files between local notebooks with everything Libera keeps for them
// (src/lib/storage/migration.ts). Three steps: choose, review the server's
// plan, run. A run is refused when the notebooks changed after the review.

const ARCHIVE = "_archive";
const secondary = "rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const primary = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const field = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const PREVIEW_LIMIT = 8;

type Step = "select" | "review" | "running" | "result";

/** A migration prepared elsewhere (the tab strip's Move… to another notebook): files, destination notebook and folder. */
export type MigrationPreset = { paths: string[]; destination: string; folder: string; flat?: boolean };

type Props = {
  open: boolean;
  initialSource: string;
  /** Opens straight on the review of this migration. */
  preset?: MigrationPreset | null;
  tree: LiberaTree;
  groups: LiberaNotebookGroup[];
  unsavedTabsUnder: (paths: string[]) => OpenTab[];
  onSaveTabs: (paths: string[]) => Promise<void>;
  onRun: (request: MigrationRequest, token: string) => Promise<MigrationResult>;
  onResume: (id: string, mode: "continue" | "stop") => Promise<MigrationResult>;
  /** A migration that finished while its result never reached the app. */
  onApplyUnacknowledged: (result: MigrationResult) => Promise<void>;
  onClose: () => void;
};

function visibleChildren(nodes: LiberaTreeNode[]) {
  return nodes.filter((node) => !(node.kind === "folder" && node.name === ARCHIVE && node.path.split("/").length === 2));
}

function filesUnder(nodes: LiberaTreeNode[]): LiberaFileNode[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node] : filesUnder(node.children));
}

/** The paths to send: a folder whose every file is checked stands for all of it (hidden content included). */
function selectionPaths(nodes: LiberaTreeNode[], selected: ReadonlySet<string>): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "file") return selected.has(node.path) ? [node.path] : [];
    const files = filesUnder(node.children);
    if (files.length && files.every((file) => selected.has(file.path))) return [node.path];
    return selectionPaths(node.children, selected);
  });
}

function folderOptions(nodes: LiberaTreeNode[], depth = 0): { path: string; label: string }[] {
  return nodes.flatMap((node) => node.kind === "folder" && !(depth === 0 && node.name === ARCHIVE)
    ? [{ path: node.path.split("/").slice(1).join("/"), label: `${"  ".repeat(depth)}${node.name}` }, ...folderOptions(node.children, depth + 1)]
    : []);
}

function formatSize(bytes: number, locale: string) {
  const [value, unit, digits] = bytes < 1024 ? [bytes, "byte", 0] as const
    : bytes < 1024 * 1024 ? [bytes / 1024, "kilobyte", 1] as const
      : bytes < 1024 * 1024 * 1024 ? [bytes / 1024 / 1024, "megabyte", 1] as const
        : [bytes / 1024 / 1024 / 1024, "gigabyte", 2] as const;
  return numberFormat(locale, { style: "unit", unit, unitDisplay: "short", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function NotebookMigrationDialog(props: Props) {
  // Remounted on each open, so it always starts from the notebook it was opened on.
  if (!props.open) return null;
  return <MigrationDialogBody {...props} />;
}

function MigrationDialogBody({ initialSource, preset, tree, groups, unsavedTabsUnder, onSaveTabs, onRun, onResume, onApplyUnacknowledged, onClose }: Props) {
  const t = useTranslations("notebookMigrationDialog");
  const tCommon = useTranslations("common");
  const collab = useCollabShell();
  const localNotebooks = useMemo(
    () => tree.notebooks.filter((notebook) => !notebook.folder?.missing && !collab?.projectForNotebook(notebook.name)),
    [tree.notebooks, collab],
  );
  const [source, setSource] = useState(() => localNotebooks.some((notebook) => notebook.name === initialSource) ? initialSource : localNotebooks[0]?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset?.paths ?? []));
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState(() => preset && localNotebooks.some((notebook) => notebook.name === preset.destination && notebook.name !== initialSource) ? preset.destination : "");
  const [folder, setFolder] = useState(preset?.folder ?? "");
  const [newNotebook, setNewNotebook] = useState<NotebookFormValues | null>(null);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookError, setNewNotebookError] = useState("");
  const [step, setStep] = useState<Step>("select");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedMigration[]>([]);
  const [applied, setApplied] = useState<MigrationResult[]>([]);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [discovery, setDiscovery] = useState(0);
  const [discoveryError, setDiscoveryError] = useState("");
  const [busy, setBusy] = useState(false);
  // Opened from Move… into a notebook that can't take a migration (shared, unknown): say so from the start.
  const [error, setError] = useState(() => preset && !destination ? t("notLocalNotebook", { destination: preset.destination }) : "");

  const sourceNode = localNotebooks.find((notebook) => notebook.name === source);
  const sourceChildren = useMemo(() => visibleChildren(sourceNode?.children ?? []), [sourceNode]);
  const destinations = localNotebooks.filter((notebook) => notebook.name !== source);
  const destinationNode = destinations.find((notebook) => notebook.name === destination);
  const destinationName = newNotebook ? newNotebook.name.trim() : destinationNode?.name ?? "";
  const paths = useMemo(() => selectionPaths(sourceChildren, selected), [sourceChildren, selected]);
  const selectedFiles = useMemo(() => filesUnder(sourceChildren).filter((file) => selected.has(file.path)), [sourceChildren, selected]);
  const unsaved = unsavedTabsUnder(paths);

  // Earlier migrations: interrupted ones to resume, finished ones the app has not applied, unreadable journals.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiRequest<{ interrupted: InterruptedMigration[]; unacknowledged: MigrationResult[]; unreadable?: string[] }>("/api/notebooks/migrate");
        if (cancelled) return;
        setDiscoveryError("");
        setInterrupted(response.interrupted);
        setUnreadable(response.unreadable ?? []);
        for (const result of response.unacknowledged) await onApplyUnacknowledged(result);
        if (!cancelled && response.unacknowledged.length) setApplied((current) => [...current, ...response.unacknowledged]);
      } catch (failure) {
        if (!cancelled) setDiscoveryError(t("earlierMigrationsCheckFailed", { reason: failure instanceof Error ? failure.message : t("unknownError") }));
      }
    })();
    return () => { cancelled = true; };
    // On opening, and when asked to check again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discovery]);

  async function setAside(name: string) {
    setBusy(true);
    try {
      await apiRequest("/api/notebooks/migrate", { method: "POST", body: JSON.stringify({ action: "set-aside", name }) });
      setDiscovery((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("setAsideFailed"));
    } finally { setBusy(false); }
  }

  const request = (selection: ReadonlySet<string> = selected): MigrationRequest => ({
    source,
    // From Move…, exactly the files chosen: a folder whose files happen to be all selected is not the folder itself.
    paths: preset ? [...selection].sort() : selectionPaths(sourceChildren, selection),
    destination: {
      ...(newNotebook
        ? { notebook: destinationName, create: { color: newNotebook.color, emoji: newNotebook.emoji, groupId: newNotebook.groupId || null } }
        : { notebook: destinationName, folder }),
      // Move…: the file goes into the chosen folder itself, not under its source folders.
      ...(preset?.flat ? { flat: true } : {}),
    },
  });

  /** `extra`: files the review suggested adding; the run sends the same selection. */
  async function review(extra: string[] = []) {
    setBusy(true);
    setError("");
    try {
      const selection = extra.length ? new Set([...selected, ...extra]) : selected;
      if (extra.length) setSelected(selection);
      const next = await apiRequest<MigrationPlan>("/api/notebooks/migrate", { method: "POST", body: JSON.stringify({ action: "plan", request: request(selection) }) });
      setPlan(next);
      // The plan knows of an earlier migration this dialog is not showing: look again.
      if (next.blockers.some((blocker) => /did not finish|can't be read/.test(blocker))) setDiscovery((value) => value + 1);
      setStep("review");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("prepareFailed"));
    } finally { setBusy(false); }
  }

  // Opened from Move…: go straight to the review.
  const reviewOnOpen = useRef(Boolean(preset && destination));
  useEffect(() => {
    if (!reviewOnOpen.current) return;
    reviewOnOpen.current = false;
    void review();
    // Once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!plan) return;
    setBusy(true);
    setError("");
    setStep("running");
    try {
      setResult(await onRun(request(), plan.token));
      setStep("result");
    } catch (failure) {
      // Nothing moved (the notebooks changed, or a blocker appeared): show the plan again.
      setError(failure instanceof Error ? failure.message : t("startFailed"));
      setStep("review");
      try { setPlan(await apiRequest<MigrationPlan>("/api/notebooks/migrate", { method: "POST", body: JSON.stringify({ action: "plan", request: request() }) })); }
      catch { /* Keep the earlier plan and the error. */ }
    } finally { setBusy(false); }
  }

  async function resume(id: string, mode: "continue" | "stop") {
    setBusy(true);
    setError("");
    setStep("running");
    try {
      setResult(await onResume(id, mode));
      setInterrupted((current) => current.filter((item) => item.id !== id));
      setStep("result");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("resumeFailed"));
      setStep("select");
    } finally { setBusy(false); }
  }

  async function saveAll() {
    setBusy(true);
    setError("");
    try { await onSaveTabs(paths); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("saveFilesFailed")); }
    finally { setBusy(false); }
  }

  function chooseNewNotebook(values: NotebookFormValues) {
    const name = values.name.trim();
    if (!name) { setNewNotebookError(t("nameRequired")); return Promise.resolve(); }
    if (/[/\\]/.test(name) || name === "." || name === "..") { setNewNotebookError(t("nameUnsupported")); return Promise.resolve(); }
    if (tree.notebooks.some((notebook) => notebook.name.toLowerCase() === name.toLowerCase())) { setNewNotebookError(t("nameExists")); return Promise.resolve(); }
    setNewNotebook({ ...values, name });
    setDestination("");
    setFolder("");
    setCreatingNotebook(false);
    return Promise.resolve();
  }

  const running = step === "running";
  const close = () => { if (!running) onClose(); };
  const canReview = Boolean(source && paths.length && destinationName) && !busy;
  const blocked = Boolean(plan?.blockers.length) || unsaved.length > 0;

  const footer = step === "select" ? <>
    <span role="status" className="mr-auto text-xs text-muted-foreground">{selectedFiles.length ? t("filesSelected", { count: selectedFiles.length }) : t("noFilesSelected")}</span>
    <button className={secondary} type="button" onClick={close}>{tCommon("cancel")}</button>
    <button className={primary} type="button" disabled={!canReview} onClick={() => void review()}>{busy ? t("checking") : t("review")}</button>
  </> : step === "review" ? <>
    <button className={`${secondary} mr-auto`} type="button" disabled={busy} onClick={() => { setStep("select"); setError(""); }}>{tCommon("back")}</button>
    <button className={secondary} type="button" disabled={busy} onClick={close}>{tCommon("cancel")}</button>
    <button className={primary} type="button" disabled={busy || blocked || !plan} onClick={() => void run()}>{plan ? t("migrateButton", { count: plan.items.filter((item) => item.kind === "file").length }) : t("migrate")}</button>
  </> : step === "result" ? <button className={primary} type="button" onClick={onClose}>{tCommon("done")}</button> : null;

  return <>
    <ModalDialog
      open
      title={t("dialogTitle")}
      description={step === "select" ? t("dialogDescription") : undefined}
      panelClassName="max-w-2xl"
      footer={footer}
      onClose={close}
    >
      {step === "select" && <div className="space-y-4">
        {discoveryError && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {discoveryError} <button type="button" className="underline" onClick={() => setDiscovery((value) => value + 1)}>{t("checkAgain")}</button>
        </div>}
        {unreadable.map((name) => <div key={name} role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">{t("journalUnreadable", { name })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("journalUnreadableHelp")}</p>
          <button className={`${secondary} mt-2`} type="button" disabled={busy} onClick={() => void setAside(name)}>{t("setAside")}</button>
        </div>)}
        {applied.map((item) => <p key={item.id} role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t("appliedNotice", { count: item.moved.length, source: item.source, destination: item.destination })}</p>)}
        {interrupted.map((item) => <div key={item.id} role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">{t("interruptedTitle", { source: item.source, destination: item.destination.notebook })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("interruptedDetail", { phase: item.phase === "staging" || item.phase === "finalizing" ? item.phase : "other", moved: item.moved, total: item.total })}{item.error ? ` ${item.error}` : ""} {t("noFileHalfMoved")}</p>
          <div className="mt-2 flex gap-2">
            <button className={primary} type="button" disabled={busy} onClick={() => void resume(item.id, "continue")}>{t("moveTheRest")}</button>
            <button className={secondary} type="button" disabled={busy} onClick={() => void resume(item.id, "stop")}>{t("stopHere")}</button>
          </div>
        </div>)}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">{t("fromLabel")}
            <select className={`${field} mt-1`} value={source} onChange={(event) => { setSource(event.target.value); setSelected(new Set()); if (destination === event.target.value) setDestination(""); }}>
              {localNotebooks.map((notebook) => <option key={notebook.name} value={notebook.name}>{notebook.emoji} {notebook.name}</option>)}
            </select>
          </label>
          <div className="text-sm font-medium">{t("toLabel")}
            {newNotebook ? <div className={`${field} mt-1 flex items-center gap-2`}>
              <span aria-hidden>{newNotebook.emoji}</span><span className="truncate">{newNotebook.name}</span>
              <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">{t("newBadge")}</span>
              <button type="button" className="ml-auto text-xs underline" onClick={() => setNewNotebook(null)}>{t("change")}</button>
            </div> : <div className="mt-1 flex gap-2">
              <select aria-label={t("destinationLabel")} className={field} value={destination} onChange={(event) => { setDestination(event.target.value); setFolder(""); }}>
                <option value="">{t("chooseNotebook")}</option>
                {destinations.map((notebook) => <option key={notebook.name} value={notebook.name}>{notebook.emoji} {notebook.name}</option>)}
              </select>
              <button type="button" className={`${secondary} inline-flex shrink-0 items-center gap-1`} onClick={() => { setNewNotebookError(""); setCreatingNotebook(true); }}><Plus aria-hidden className="h-4 w-4" />{t("newNotebookButton")}</button>
            </div>}
          </div>
        </div>

        {destinationNode && folderOptions(destinationNode.children).length > 0 && <label className="block text-sm font-medium">{t("intoFolder")}
          <select className={`${field} mt-1`} value={folder} onChange={(event) => setFolder(event.target.value)}>
            <option value="">{t("topLevelFolder", { name: destinationNode.name })}</option>
            {folderOptions(destinationNode.children).map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
          </select>
        </label>}

        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 p-2">
            <Search aria-hidden className="h-4 w-4 text-muted-foreground" />
            <input aria-label={t("findLabel")} className="min-w-20 flex-1 bg-transparent text-sm outline-none" placeholder={t("findPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <FileSelectionActions onSelectAll={() => setSelected(new Set(filesUnder(sourceChildren).map((file) => file.path)))} onClear={() => setSelected(new Set())} />
          </div>
          <div className="max-h-[36vh] min-h-28 overflow-auto p-2">
            {sourceChildren.map((node) => <MigrationRow key={node.path} node={node} selected={selected} query={query.trim().toLowerCase()} onToggle={(files, checked) => setSelected((current) => {
              const next = new Set(current);
              for (const file of files) { if (checked) next.add(file); else next.delete(file); }
              return next;
            })} />)}
            {!sourceChildren.length && <p className="p-4 text-sm text-muted-foreground">{localNotebooks.length ? t("noFilesInNotebook") : t("sharedNotMigratable")}</p>}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("folderLayoutNote")}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>}

      {step === "review" && plan && <ReviewStep plan={plan} unsaved={unsaved} busy={busy} error={error} onSaveAll={() => void saveAll()} onAdd={(extra) => void review(extra)} />}

      {step === "running" && <div role="status" className="flex items-center gap-3 py-6 text-sm"><Loader2 aria-hidden className="h-5 w-5 animate-spin" />{t("movingFiles")}</div>}

      {step === "result" && result && <ResultStep result={result} busy={busy} onResume={(mode) => void resume(result.id, mode)} />}
    </ModalDialog>

    <NotebookDialog
      dialog={creatingNotebook ? { mode: "create", ...(newNotebookError ? { error: newNotebookError } : {}) } : null}
      groups={groups}
      submitting={false}
      onClose={() => setCreatingNotebook(false)}
      onSubmit={chooseNewNotebook}
    />
  </>;
}

function MigrationRow({ node, selected, query, onToggle }: { node: LiberaTreeNode | LiberaNotebookNode; selected: ReadonlySet<string>; query: string; onToggle: (files: string[], checked: boolean) => void }) {
  const t = useTranslations("notebookMigrationDialog");
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const files = node.kind === "file" ? [node.path] : filesUnder(node.children).map((file) => file.path);
  const count = files.filter((file) => selected.has(file)).length;
  const checked = files.length > 0 && count === files.length;
  const partial = count > 0 && !checked;
  useEffect(() => { if (input.current) input.current.indeterminate = partial; }, [partial]);
  const matches = (item: LiberaTreeNode | LiberaNotebookNode): boolean => item.name.toLowerCase().includes(query) || (item.kind !== "file" && item.children.some(matches));
  if (query && !matches(node)) return null;
  const open = expanded || Boolean(query);
  return <div>
    <div className={`flex items-center rounded-lg hover:bg-muted ${checked ? "bg-primary/5" : ""}`}>
      {node.kind !== "file" ? <button type="button" aria-label={open ? t("collapseItemLabel", { name: node.name }) : t("expandItemLabel", { name: node.name })} aria-expanded={open} onClick={() => setExpanded(!expanded)} className="flex h-8 w-6 shrink-0 items-center justify-center"><ChevronRight aria-hidden className={`h-3.5 w-3.5 transition ${open ? "rotate-90" : ""}`} /></button> : <span className="w-6 shrink-0" />}
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 text-sm">
        <input ref={input} type="checkbox" checked={checked} disabled={!files.length} aria-label={node.path} aria-checked={partial ? "mixed" : checked} onChange={(event) => onToggle(files, event.target.checked)} className="h-4 w-4 shrink-0 accent-primary" />
        {node.kind === "file" ? <span className="shrink-0"><FileTypeIcon fileType={node.fileType} name={node.name} /></span> : <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate" title={node.path}>{node.name}</span>
        {node.kind !== "file" && <span className="ml-auto text-xs text-muted-foreground">{count ? `${count}/` : ""}{files.length}</span>}
      </label>
    </div>
    {node.kind !== "file" && open && <div className="ml-4 border-l border-border pl-1">{node.children.map((child) => <MigrationRow key={child.path} node={child} selected={selected} query={query} onToggle={onToggle} />)}</div>}
  </div>;
}

function PathList({ paths }: { paths: string[] }) {
  const t = useTranslations("notebookMigrationDialog");
  const [all, setAll] = useState(false);
  if (!paths.length) return null;
  const shown = all ? paths : paths.slice(0, PREVIEW_LIMIT);
  return <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
    {shown.map((item) => <li key={item} className="truncate" title={item}>{item}</li>)}
    {paths.length > PREVIEW_LIMIT && <li><button type="button" className="underline" onClick={() => setAll(!all)}>{all ? t("showFewer") : t("andMore", { count: paths.length - PREVIEW_LIMIT })}</button></li>}
  </ul>;
}

function ReviewStep({ plan, unsaved, busy, error, onSaveAll, onAdd }: { plan: MigrationPlan; unsaved: OpenTab[]; busy: boolean; error: string; onSaveAll: () => void; onAdd: (paths: string[]) => void }) {
  const t = useTranslations("notebookMigrationDialog");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const files = plan.items.filter((item) => item.kind === "file");
  const others = plan.items.length - files.length;
  const hiddenEntries = plan.items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const target = [plan.destination.notebook, plan.destination.folder].filter(Boolean).join("/");
  return <div className="max-h-[56vh] space-y-3 overflow-auto pr-1 text-sm">
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <span className="font-medium">{plan.source}</span><ArrowRight aria-hidden className="h-4 w-4 text-muted-foreground" />
      <span className="font-medium">{target}</span>
      {plan.destination.create && <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">{t("newNotebookBadge")}</span>}
      <span className="ml-auto text-xs text-muted-foreground">{t(others ? hiddenEntries ? "reviewSummaryHiddenEntries" : "reviewSummaryHidden" : "reviewSummaryFiles", { files: files.length, others, hiddenEntries, size: formatSize(plan.totalBytes, locale) })}</span>
    </div>

    {plan.blockers.map((blocker) => <p key={blocker} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">{blocker}</p>)}

    {unsaved.length > 0 && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-medium">{t("unsavedChanges", { count: unsaved.length })}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("saveToMoveHint")}</p>
      <PathList paths={unsaved.map((tab) => tab.file.path)} />
      <button className={`${primary} mt-2`} type="button" disabled={busy} onClick={onSaveAll}>{busy ? tCommon("saving") : t("saveAll")}</button>
    </div>}

    {plan.warnings.map((warning) => <div key={warning.kind} className="rounded-lg border border-border p-3">
      <p className="flex items-start gap-2"><AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><span>{t(`warning.${warning.kind}`, { count: warning.paths.length, source: plan.source })}</span></p>
      <PathList paths={warning.paths} />
      {warning.kind === "latex-left-behind" && <button className={`${secondary} mt-2`} type="button" disabled={busy} onClick={() => onAdd(warning.paths)}>{t("addToMigration", { count: warning.paths.length })}</button>}
    </div>)}

    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer font-medium">{t("filesAndDestinations")}</summary>
      <PathList paths={files.map((item) => `${item.from.split("/").slice(1).join("/")} → ${item.to}`)} />
    </details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("reviewNote", { notebook: plan.destination.notebook })}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}

function ResultStep({ result, busy, onResume }: { result: MigrationResult; busy: boolean; onResume: (mode: "continue" | "stop") => void }) {
  const t = useTranslations("notebookMigrationDialog");
  const tCommon = useTranslations("common");
  const done = result.state === "done";
  return <div className="space-y-3 text-sm">
    <p className="flex items-start gap-2">
      {done ? <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
      <span>{done ? t("movedToDestination", { count: result.moved.length, destination: result.destination }) : t("stoppedAfterMoving", { moved: result.moved.length, remaining: result.remaining.length, source: result.source })}{result.moved.some((move) => move.incomplete) ? ` ${t("incompleteMovedNote", { count: result.moved.filter((move) => move.incomplete).length })}` : ""}</span>
    </p>
    {result.error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">{result.error}</p>}
    {!done && <div className="flex gap-2">
      <button className={primary} type="button" disabled={busy} onClick={() => onResume("continue")}>{tCommon("tryAgain")}</button>
      <button className={secondary} type="button" disabled={busy} onClick={() => onResume("stop")}>{t("stopHere")}</button>
    </div>}
    {result.referenceEntries.copied > 0 && <p className="text-muted-foreground">{t("referencesCopied", { count: result.referenceEntries.copied, destination: result.destination })}</p>}
    {result.referenceEntries.error && <p className="text-muted-foreground">{t("referencesFailed", { error: result.referenceEntries.error })}</p>}
    {result.bookkeeping.length > 0 && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-medium">{t("recordsNotUpdated")}</p>
      <PathList paths={result.bookkeeping} />
    </div>}
    {(result.missing?.length ?? 0) > 0 && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-medium">{t("missingHeading")}</p>
      <PathList paths={result.missing ?? []} />
    </div>}
    {result.leftovers.length > 0 ? <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-medium">{t("leftoversHeading")}</p>
      <PathList paths={result.leftovers} />
    </div> : result.check === "clean" ? <p className="text-muted-foreground">{t("checkedClean", { source: result.source })}</p>
      : result.check === "unverified" ? <p className="text-muted-foreground">{t("checkedUnverified", { source: result.source })}</p> : null}
    {done && result.check !== "unverified" && result.bookkeeping.length === 0 && <p className="text-muted-foreground">{t("checkedRecordsFollowed")}</p>}
  </div>;
}
