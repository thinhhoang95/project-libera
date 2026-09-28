"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, Check, ChevronRight, Folder, Layers3, LogOut, Pencil, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { ModalDialog } from "./modal-dialog";
import { FileTypeIcon } from "./file-type";
import type { LiberaNotebookNode, LiberaTree, LiberaTreeNode } from "@/lib/types";
import { filterWorkspaceTree, withinPath, type SavedWorkspace, type WorkspaceScope } from "@/lib/workspaces";
import type { useSavedWorkspaces } from "./use-saved-workspaces";

export type WorkspaceManager = ReturnType<typeof useSavedWorkspaces>;
type PickerNode = LiberaTreeNode | LiberaNotebookNode;
const colors = ["#7c6fba", "#428f87", "#b77b48", "#b76783", "#5587bd", "#779450"];
const iconButton = "libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-50";
const secondary = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50";
const primary = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";

function fileCount(nodes: PickerNode[]): number {
  return nodes.reduce((count, node) => count + (node.kind === "file" ? 1 : fileCount(node.children)), 0);
}

// Expand only the branch being deselected; other folders still include future files.
export function toggleWorkspacePath(nodes: PickerNode[], paths: string[], path: string, checked: boolean): string[] {
  if (checked) return [...paths.filter((item) => !withinPath(item, path)), path];
  const result: string[] = [];
  function split(node: PickerNode) {
    if (withinPath(node.path, path)) return;
    if (!withinPath(path, node.path)) { result.push(node.path); return; }
    if (node.kind !== "file") node.children.forEach(split);
  }
  function find(nodes: PickerNode[], target: string): PickerNode | undefined {
    for (const node of nodes) {
      if (node.path === target) return node;
      if (node.kind !== "file") { const found = find(node.children, target); if (found) return found; }
    }
  }
  for (const selected of paths) {
    if (withinPath(selected, path)) continue;
    if (withinPath(path, selected)) { const node = find(nodes, selected); if (node) split(node); }
    else result.push(selected);
  }
  return result;
}

export function WorkspacesPanel({ manager, tree }: { manager: WorkspaceManager; tree: LiberaTree }) {
  const [editing, setEditing] = useState<{ workspace?: SavedWorkspace; rename?: boolean } | null>(null);
  const [deleting, setDeleting] = useState<SavedWorkspace | null>(null);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not update workspace."); }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between px-3 pb-2 pt-4">
      <h2 className="text-sm font-semibold">Workspaces</h2>
      <button className={iconButton} title="Create workspace" aria-label="Create workspace" disabled={!manager.ready || manager.switching} onClick={() => setEditing({})}><Plus className="h-4 w-4" /></button>
    </div>
    <p className="px-3 pb-4 text-xs leading-relaxed text-muted-foreground">A little room for each project. Pick up right where you left off.</p>
    {(error || manager.loadError) && <div role="alert" className="mx-3 mb-3 rounded-lg bg-destructive-muted p-3 text-xs text-destructive">{error || manager.loadError}{manager.loadError && <button className="ml-2 underline" onClick={manager.retry}>Try again</button>}</div>}
    <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-4">
      {!manager.ready && !manager.loadError && <p role="status" className="text-sm text-muted-foreground">Opening your workspaces…</p>}
      <div className="libera-notebook-section" data-selected={!manager.activeWorkspace} style={{ "--notebook-color": "#75839e" } as CSSProperties}>
        <button className="libera-notebook-row flex w-full items-center gap-3 p-3 text-left disabled:opacity-60" aria-pressed={!manager.activeWorkspace} disabled={!manager.ready || manager.switching} onClick={() => void run(() => manager.switchWorkspace(null))}>
          <span className="libera-notebook-emoji flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#75839e] text-white"><Layers3 className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">All notebooks</span><span className="text-xs text-muted-foreground">Your whole library</span></span>
        </button>
      </div>
      {manager.workspaces.map((workspace) => {
        const active = manager.activeWorkspace?.id === workspace.id;
        const count = fileCount(filterWorkspaceTree(tree, workspace.scope).notebooks);
        return <article key={workspace.id} className="libera-notebook-section" data-selected={active} style={{ "--notebook-color": workspace.color } as CSSProperties}>
          <div className="libera-notebook-row">
            <button className="flex w-full items-center gap-3 rounded-[10px] p-3 text-left disabled:opacity-60" disabled={manager.switching} aria-pressed={active} onClick={() => void run(() => manager.switchWorkspace(workspace.id))}>
              <span className="libera-notebook-emoji flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: workspace.color }}><Layers3 className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{workspace.name}</span><span className="block text-xs text-muted-foreground">{count} {count === 1 ? "file" : "files"} · {active ? "Active now" : `${workspace.session.tabs.length} saved ${workspace.session.tabs.length === 1 ? "tab" : "tabs"}`}</span></span>
              {!active && <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground"><ArrowRight aria-hidden className="h-4 w-4" /></span>}
            </button>
            <div className="flex items-center justify-end gap-1 px-3 pb-3">
              {active && <button className={`${iconButton} mr-auto`} title="Exit workspace" aria-label={`Exit ${workspace.name}`} disabled={manager.switching} onClick={() => void run(() => manager.switchWorkspace(null))}><LogOut className="h-3.5 w-3.5" /></button>}
              <button className={iconButton} title="Rename workspace" aria-label={`Rename ${workspace.name}`} disabled={manager.switching} onClick={() => setEditing({ workspace, rename: true })}><Pencil className="h-3.5 w-3.5" /></button>
              <button className={iconButton} title="Workspace settings" aria-label={`Modify ${workspace.name}`} disabled={manager.switching} onClick={() => setEditing({ workspace })}><Settings2 className="h-3.5 w-3.5" /></button>
              <button className={iconButton} title="Delete workspace" aria-label={`Delete ${workspace.name}`} disabled={manager.switching} onClick={() => setDeleting(workspace)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        </article>;
      })}
      {manager.ready && !manager.workspaces.length && <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center"><Layers3 className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /><p className="text-sm font-medium">Make space for your next idea</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Gather a few notes, papers, and images into a workspace.</p><button className={`${primary} mt-4`} onClick={() => setEditing({})}>Create a workspace</button></div>}
    </div>
    {editing && <WorkspaceSettings key={editing.workspace?.id ?? "new"} workspace={editing.workspace} renameOnly={editing.rename} tree={tree} manager={manager} onClose={() => setEditing(null)} />}
    {deleting && <ModalDialog open title={`Delete “${deleting.name}”?`} description="Your files stay in your notebooks. This removes the workspace and its saved tabs, including any unsaved drafts." onClose={() => { if (!manager.switching) setDeleting(null); }} footer={<><button className={secondary} disabled={manager.switching} onClick={() => setDeleting(null)}>Cancel</button><button className="rounded-lg bg-destructive px-4 py-2 text-sm text-white disabled:opacity-50" disabled={manager.switching} onClick={() => void run(async () => { await manager.deleteWorkspace(deleting.id); setDeleting(null); })}>Delete workspace</button></>}><p className="text-sm text-muted-foreground">This cannot be undone.</p>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}</ModalDialog>}
  </div>;
}

function WorkspaceSettings({ workspace, renameOnly, tree, manager, onClose }: { workspace?: SavedWorkspace; renameOnly?: boolean; tree: LiberaTree; manager: WorkspaceManager; onClose: () => void }) {
  const [name, setName] = useState(workspace?.name ?? "");
  const [color, setColor] = useState(workspace?.color ?? colors[manager.workspaces.length % colors.length]);
  const [scope, setScope] = useState<WorkspaceScope>(workspace?.scope ?? { mode: "include", paths: [] });
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const count = fileCount(filterWorkspaceTree(tree, scope).notebooks);
  const selected = new Set(scope.paths);
  async function save() {
    if (!name.trim()) { setError("Give your workspace a name."); return; }
    if (manager.workspaces.some((item) => item.id !== workspace?.id && item.name.toLowerCase() === name.trim().toLowerCase())) { setError("You already have a workspace with that name."); return; }
    try { await manager.saveWorkspace({ id: workspace?.id ?? crypto.randomUUID(), name: name.trim(), color, scope }); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save workspace."); }
  }
  return <ModalDialog open title={renameOnly ? "Rename workspace" : workspace ? "Shape your workspace" : "Create a workspace"} description={renameOnly ? undefined : "Choose what belongs here. Your files stay in their original notebooks."} panelClassName="max-w-2xl" onClose={() => { if (!manager.switching) onClose(); }} footer={<><span role="status" className="mr-auto text-xs text-muted-foreground">{!renameOnly && `${count} ${count === 1 ? "file" : "files"} in this workspace`}</span><button className={secondary} disabled={manager.switching} onClick={onClose}>Cancel</button><button className={primary} disabled={manager.switching || !name.trim()} type="submit" form="workspace-settings-form">{manager.switching ? "Saving…" : workspace ? "Save changes" : "Create & open"}</button></>}>
    <form id="workspace-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="block text-sm font-medium" htmlFor="workspace-name">Workspace name</label>
      <input autoFocus id="workspace-name" maxLength={100} placeholder="e.g. A new chapter" value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
      {!renameOnly && <>
        <div className="my-4 flex items-center gap-2" role="group" aria-label="Workspace color">{colors.map((value, index) => <button key={value} type="button" aria-label={`${["Lavender", "Teal", "Amber", "Rose", "Blue", "Sage"][index]} workspace color`} aria-pressed={color === value} onClick={() => setColor(value)} style={{ backgroundColor: value }} className="flex h-7 w-7 items-center justify-center rounded-full text-white outline-offset-2 focus-visible:outline-2">{value === color && <Check className="h-4 w-4" />}</button>)}</div>
        <fieldset><legend className="mb-2 text-sm font-medium">What would you like to see?</legend><div className="grid grid-cols-3 gap-2">{([['all', 'Everything'], ['include', 'Only selected'], ['exclude', 'Everything except']] as const).map(([mode, label]) => <label key={mode} className={`cursor-pointer rounded-xl border p-3 text-center text-xs transition ${scope.mode === mode ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}><input className="sr-only peer" type="radio" name="workspace-scope" value={mode} checked={scope.mode === mode} onChange={() => setScope({ mode, paths: scope.paths })} /><span className="peer-focus-visible:outline peer-focus-visible:outline-2">{label}</span></label>)}</div></fieldset>
        <p className="my-3 text-xs leading-relaxed text-muted-foreground">{scope.mode === "all" ? "All your notebooks and files, including anything you add later." : scope.mode === "include" ? "Check the files and folders to bring into this workspace. Selected folders include future files, too. Files you create or move here are added automatically." : "Check the files and folders to leave out. Files you create or move while working here stay included."}</p>
        {scope.mode !== "all" && <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 p-2"><Search className="h-4 w-4 text-muted-foreground" /><input aria-label="Find files and folders" className="min-w-20 flex-1 bg-transparent text-sm outline-none" placeholder="Find files and folders…" value={search} onChange={(event) => setSearch(event.target.value)} /><button type="button" className="text-xs underline" onClick={() => setScope({ mode: scope.mode, paths: tree.notebooks.map((node) => node.path) })}>Select all</button><button type="button" className="text-xs underline" onClick={() => setScope({ mode: scope.mode, paths: [] })}>Clear</button></div>
          <div className="max-h-[32vh] min-h-28 overflow-auto p-2">{tree.notebooks.map((node) => <PickerRow key={node.path} node={node} selected={selected} includedPaths={scope.mode === "exclude" ? scope.includedPaths : undefined} query={search.trim().toLowerCase()} onToggle={(path, checked) => setScope((value) => ({ ...value, paths: toggleWorkspacePath(tree.notebooks, value.paths, path, checked), includedPaths: value.includedPaths ? toggleWorkspacePath(tree.notebooks, value.includedPaths, path, false) : undefined }))} />)}{!tree.notebooks.length && <p className="p-4 text-sm text-muted-foreground">Create a notebook to start adding files.</p>}</div>
        </div>}
      </>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </form>
  </ModalDialog>;
}

function PickerRow({ node, selected, includedPaths = [], query, onToggle }: { node: PickerNode; selected: Set<string>; includedPaths?: string[]; query: string; onToggle: (path: string, checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const excepted = includedPaths.some((path) => withinPath(node.path, path));
  const hasExceptions = includedPaths.some((path) => withinPath(path, node.path));
  const selectedByPath = [...selected].some((path) => withinPath(node.path, path));
  const checked = selectedByPath && !excepted && !hasExceptions;
  const partial = !checked && !excepted && ((selectedByPath && hasExceptions) || [...selected].some((path) => withinPath(path, node.path)));
  useEffect(() => { if (input.current) input.current.indeterminate = partial; }, [partial]);
  function matches(item: PickerNode): boolean { return item.path.toLowerCase().includes(query) || (item.kind !== "file" && item.children.some(matches)); }
  if (query && !matches(node)) return null;
  return <div>
    <div className={`flex items-center rounded-lg hover:bg-muted ${checked ? "bg-primary/5" : ""}`}>
      {node.kind !== "file" ? <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={expanded || Boolean(query)} onClick={() => setExpanded(!expanded)} className="flex h-8 w-6 shrink-0 items-center justify-center"><ChevronRight className={`h-3.5 w-3.5 transition ${expanded || query ? "rotate-90" : ""}`} /></button> : <span className="w-6 shrink-0" />}
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 text-sm"><input ref={input} type="checkbox" checked={checked} aria-label={node.path} aria-checked={partial ? "mixed" : checked} onChange={(event) => onToggle(node.path, event.target.checked)} className="h-4 w-4 shrink-0 accent-primary" />{node.kind === "file" ? <span className="shrink-0"><FileTypeIcon fileType={node.fileType} /></span> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}<span className="truncate" title={node.path}>{node.name}</span>{node.kind !== "file" && <span className="ml-auto text-xs text-muted-foreground">{fileCount(node.children)}</span>}</label>
    </div>
    {node.kind !== "file" && (expanded || query) && <div className="ml-4 border-l border-border pl-1">{node.children.map((child) => <PickerRow key={child.path} node={child} selected={selected} includedPaths={includedPaths} query={query} onToggle={onToggle} />)}</div>}
  </div>;
}
