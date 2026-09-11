"use client";

import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./modal-dialog";
import { apiRequest } from "./api-client";
import type { LiberaTree, LiberaTreeNode } from "@/lib/types";

export type ChatExport = { fileName: string; content: string };

export function DocumentChatExportDialog({ snapshot, onClose, onSaved }: {
  snapshot: ChatExport;
  onClose: () => void;
  onSaved?: (notebook: string) => Promise<void>;
}) {
  const [name, setName] = useState(snapshot.fileName);
  const [directory, setDirectory] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    void apiRequest<LiberaTree>("/api/tree").then((tree) => {
      if (disposed) return;
      const paths: string[] = [];
      function collect(nodes: LiberaTreeNode[]) {
        for (const node of nodes) if (node.kind === "folder") { paths.push(node.path); collect(node.children); }
      }
      for (const notebook of tree.notebooks) { paths.push(notebook.name); collect(notebook.children); }
      setDirectories(paths);
      setDirectory(paths[0] ?? "");
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load notebooks."); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  async function save() {
    if (savingRef.current || !directory) return;
    const requestedName = name.trim();
    if (!requestedName || /[\\/]/.test(requestedName) || requestedName === "." || requestedName === "..") { setError("Enter a file name without slashes."); return; }
    savingRef.current = true;
    setSaving(true);
    setError("");
    const notebook = directory.split("/")[0];
    try {
      await apiRequest("/api/files", { method: "POST", body: JSON.stringify({ notebook, parentPath: directory, name: /\.(md|markdown)$/i.test(requestedName) ? requestedName : `${requestedName}.md`, content: snapshot.content }) });
      onClose();
      void onSaved?.(notebook).catch(() => undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export chat."); }
    finally { savingRef.current = false; setSaving(false); }
  }

  const fieldClass = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
  return <ModalDialog open title="Save chat to notebook" onClose={() => { if (!savingRef.current) onClose(); }}>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={saving || loading} className="space-y-4">
        <label className="block text-sm">File name<input className={fieldClass} required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="block text-sm">Notebook or folder<select className={fieldClass} value={directory} onChange={(event) => setDirectory(event.target.value)}>{directories.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading notebooks…</p>}
        {!loading && !directories.length && !error && <p className="text-sm text-muted-foreground">Create a notebook to save your chat here.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="libera-dialog-actions flex justify-end gap-2"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="libera-dialog-primary disabled:opacity-40" disabled={!directory || !name.trim()}>{saving ? "Saving…" : "Save"}</button></div>
      </fieldset>
    </form>
  </ModalDialog>;
}
