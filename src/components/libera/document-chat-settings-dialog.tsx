"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Pencil, Trash2 } from "lucide-react";
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
  const t = useTranslations("documentChatSettingsDialog");
  const tc = useTranslations("common");
  const [selected, setSelected] = useState<string[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const selectedIds = selected.filter((id) => chats.some((chat) => chat.id === id));
  const allSelected = chats.length > 0 && selectedIds.length === chats.length;

  return <ModalDialog
    open
    sectioned
    title={t("title")}
    description={t("description")}
    panelClassName="max-w-xl"
    onClose={onClose}
    footer={<>
      <button type="button" onClick={onClose}>{tc("done")}</button>
      <button
        type="button"
        disabled={!selectedIds.length}
        className={`gap-2 ${selectedIds.length ? "bg-destructive" : ""}`}
        onClick={() => { onDelete(selectedIds); setSelected([]); }}
      >
        <Trash2 aria-hidden size={15} /> {t("deleteSelected", { count: selectedIds.length })}
      </button>
    </>}
  >
    <div className="libera-chat-manage">
      <label className="libera-chat-manage-all">
        <input type="checkbox" checked={allSelected} ref={(element) => { if (element) element.indeterminate = selectedIds.length > 0 && !allSelected; }} onChange={() => setSelected(allSelected ? [] : chats.map((chat) => chat.id))} />
        {t("selectAll")}
      </label>
      <div className="libera-chat-manage-list">
        {chats.map((chat) => {
          const title = titles[chat.id] ?? chat.title;
          const edited = !!title.trim() && title.trim() !== chat.title;
          const isSelected = selectedIds.includes(chat.id);
          return <form key={chat.id} data-chat-id={chat.id} data-selected={isSelected || undefined} className="libera-chat-manage-row" onSubmit={(event) => {
            event.preventDefault();
            if (edited) onRename(chat.id, title.trim());
            setTitles((current) => { const next = { ...current }; delete next[chat.id]; return next; });
            event.currentTarget.querySelector<HTMLInputElement>("input[type=text]")?.blur();
          }}>
            <input type="checkbox" aria-label={t("selectChatLabel", { title: chat.title })} checked={isSelected} onChange={(event) => setSelected((current) => event.target.checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))} />
            <input
              type="text"
              aria-label={t("chatNameLabel", { title: chat.title })}
              title={chat.title}
              value={title}
              maxLength={120}
              className="libera-chat-manage-title"
              onChange={(event) => setTitles((current) => ({ ...current, [chat.id]: event.target.value }))}
              // An emptied name goes back to the saved one instead of staying blank.
              onBlur={() => { if (!title.trim()) setTitles((current) => { const next = { ...current }; delete next[chat.id]; return next; }); }}
            />
            {chat.id === activeId && <span className="libera-chat-manage-badge">{t("currentChat")}</span>}
            {edited
              ? <button type="submit" className="libera-chat-manage-action" data-save aria-label={t("renameChatLabel", { title: chat.title })} title={t("renameChat")}><Check aria-hidden size={15} /></button>
              : <button type="button" className="libera-chat-manage-action" aria-label={t("renameChatLabel", { title: chat.title })} title={t("renameChat")} onClick={(event) => { const input = event.currentTarget.form?.querySelector<HTMLInputElement>("input[type=text]"); input?.focus(); input?.select(); }}><Pencil aria-hidden size={14} /></button>}
          </form>;
        })}
      </div>
    </div>
  </ModalDialog>;
}
