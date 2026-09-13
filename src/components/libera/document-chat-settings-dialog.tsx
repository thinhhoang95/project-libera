"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { ModalDialog } from "./modal-dialog";
import type { DocumentChat } from "@/lib/document-chat";

type Props = {
  chats: DocumentChat[];
  activeId: string;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (ids: string[]) => void;
};

export function DocumentChatSettingsDialog({ chats, activeId, onClose, onRename, onDelete }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const selectedIds = selected.filter((id) => chats.some((chat) => chat.id === id));
  const allSelected = chats.length > 0 && selectedIds.length === chats.length;

  return <ModalDialog
    open
    title="Chat settings"
    description="Rename chats or select conversations to delete."
    panelClassName="max-w-xl"
    onClose={onClose}
    footer={<>
      <button type="button" className="rounded-lg px-3 py-2 text-sm hover:bg-muted" onClick={onClose}>Done</button>
      <button
        type="button"
        disabled={!selectedIds.length}
        className="inline-flex items-center gap-2 rounded-lg bg-destructive px-3 py-2 text-sm text-white disabled:opacity-40"
        onClick={() => { onDelete(selectedIds); setSelected([]); }}
      >
        <Trash2 aria-hidden size={15} /> Delete selected ({selectedIds.length})
      </button>
    </>}
  >
    <label className="mb-3 flex items-center gap-2 text-sm">
      <input type="checkbox" checked={allSelected} ref={(element) => { if (element) element.indeterminate = selectedIds.length > 0 && !allSelected; }} onChange={() => setSelected(allSelected ? [] : chats.map((chat) => chat.id))} />
      Select all
    </label>
    <div className="max-h-[50vh] space-y-2 overflow-y-auto">
      {chats.map((chat) => {
        const title = titles[chat.id] ?? chat.title;
        return <form key={chat.id} className="flex items-center gap-2 rounded-lg border border-border p-2" onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) onRename(chat.id, title.trim());
        }}>
          <input type="checkbox" aria-label={`Select chat: ${chat.title}`} checked={selectedIds.includes(chat.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))} />
          <div className="min-w-0 flex-1">
            <input aria-label={`Chat name: ${chat.title}`} value={title} maxLength={120} required className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" onChange={(event) => setTitles((current) => ({ ...current, [chat.id]: event.target.value }))} />
            {chat.id === activeId && <span className="text-xs text-muted-foreground">Current chat</span>}
          </div>
          <button type="submit" disabled={!title.trim() || title.trim() === chat.title} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40" aria-label={`Rename chat: ${chat.title}`} title="Rename chat">
            <Pencil aria-hidden size={16} />
          </button>
        </form>;
      })}
    </div>
  </ModalDialog>;
}
