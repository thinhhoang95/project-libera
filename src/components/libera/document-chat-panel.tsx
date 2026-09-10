"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Settings, Send, Square, X } from "lucide-react";
import { DocumentChatExportDialog, type ChatExport } from "./document-chat-export-dialog";
import { ModalDialog } from "./modal-dialog";
import { DocumentChatSettingsDialog } from "./document-chat-settings-dialog";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import type { OpenTab } from "./types";
import { readChatResponse } from "./chat-stream-client";
import { apiRequest } from "./api-client";
import { CHAT_REASONING_EFFORTS, isChatReasoningEffort, chatExportFileName, exportChatMarkdown, MAX_CHAT_PHOTOS, MAX_CHAT_PHOTO_BYTES, messagesWithoutExcludedDocuments, newDocumentContext, normalizeChatResponseMarkdown, type ChatPhoto, validateChatStore, type ChatContext, type ChatStore, type DocumentChat } from "@/lib/document-chat";

const buttonClass = "libera-sidebar-icon-button inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-40";
function createChat(): DocumentChat {
  return { id: crypto.randomUUID(), title: "New chat", messages: [], prompt: "", selections: [] };
}

export function DocumentChatPanel({ activeTab, collapsed, onCollapsedChange, onExportSaved }: { onExportSaved?: (notebook: string) => Promise<void>; activeTab: OpenTab | null | undefined; collapsed: boolean; onCollapsedChange: (value: boolean) => void }) {
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<"low" | "medium" | "high" | "xhigh" | "max">("medium");
  const [store, setStore] = useState<ChatStore | null>(null);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportSnapshot, setExportSnapshot] = useState<ChatExport | null>(null);
  const [exporting, setExporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const deletedRequestRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const latestStore = useRef<ChatStore | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const requestRef = useRef<AbortController | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followResponseRef = useRef(true);
  const chat = store?.chats.find((item) => item.id === store.activeId);
  const lastMessageText = chat?.messages.at(-1)?.text;
  const document = useMemo<ChatContext | null>(() => activeTab?.file.fileType === "markdown" ? { kind: "document", path: activeTab.untitled ? activeTab.id : activeTab.file.path, name: activeTab.file.name, text: activeTab.draft } : null, [activeTab]);

  const includedDocument = document && !chat?.excludedDocumentPaths?.includes(document.path) ? document : null;

  useEffect(() => {
    let disposed = false;
    void apiRequest<{ history: ChatStore | null; defaultReasoningEffort?: unknown }>("/api/document-chat/state").then(({ history, defaultReasoningEffort: configuredEffort }) => {
      if (disposed) return;
      if (isChatReasoningEffort(configuredEffort)) setDefaultReasoningEffort(configuredEffort);
      if (history != null && !validateChatStore(history)) throw new Error("Saved chat history is invalid.");
      const first = createChat();
      const restored = history ?? { chats: [first], activeId: first.id };
      restored.chats = restored.chats.map((item) => {
        item = { ...item, messages: item.messages.map((message) => message.status === "streaming" ? { ...message, status: "interrupted" as const } : message) };
        const last = item.messages.at(-1);
        return last?.role === "user" ? { ...item, messages: item.messages.slice(0, -1), prompt: item.prompt || last.text, photos: [...(last.photos ?? []), ...(item.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...(last.contexts ?? []).filter((context) => context.kind === "selection"), ...item.selections] } : item;
      });
      setStore(restored);
    }).catch(() => { if (!disposed) setStorageError("Saved chats could not be loaded. Reload the app to retry."); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, []);

  const persistStore = useCallback((snapshot: ChatStore | null) => {
    if (!snapshot) return;
    saveQueue.current = saveQueue.current.then(async () => {
      if (latestStore.current !== snapshot) return;
      try {
        await apiRequest("/api/document-chat/state", { method: "PUT", body: JSON.stringify({ kind: "history", value: snapshot }) });
        setStorageError("");
      } catch { setStorageError("Chat history could not be saved. Your next change will retry saving."); }
    });
  }, []);

  useEffect(() => {
    latestStore.current = store;
    if (!pending) persistStore(store);
  }, [store, pending, persistStore]);

  useEffect(() => {
    if (!pending) return;
    persistStore(latestStore.current);
    const interval = window.setInterval(() => persistStore(latestStore.current), 1000);
    return () => window.clearInterval(interval);
  }, [pending, persistStore]);

  useEffect(() => {
    followResponseRef.current = true;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat?.id, collapsed]);

  useEffect(() => {
    const log = logRef.current;
    if (log && followResponseRef.current) log.scrollTop = log.scrollHeight;
  }, [chat?.messages.length, lastMessageText, pending]);

  function updateChat(id: string, update: (current: DocumentChat) => DocumentChat) {
    setStore((current) => current && ({ ...current, chats: current.chats.map((item) => item.id === id ? update(item) : item) }));
  }

  useEffect(() => {
    function addSelection(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== "KeyL" || !chat || !document) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      let text = "";
      if (target instanceof HTMLTextAreaElement && target.classList.contains("markdown-editor-input")) {
        text = target.value.slice(target.selectionStart, target.selectionEnd);
      } else if (target.closest(".libera-tiptap")) {
        const selection = window.getSelection();
        if (selection?.anchorNode && selection.focusNode && target.closest(".libera-tiptap")?.contains(selection.anchorNode) && target.closest(".libera-tiptap")?.contains(selection.focusNode)) text = selection.toString();
      } else return;
      event.preventDefault();
      event.stopPropagation();
      if (!text.trim()) return;
      if (chat.selections.length >= 20) { setError("Send or remove some selections before adding more."); onCollapsedChange(false); return; }
      const context: ChatContext = { ...document, kind: "selection", text };
      updateChat(chat.id, (current) => ({ ...current, selections: current.selections.some((item) => item.path === context.path && item.text === text) ? current.selections : [...current.selections, context] }));
      onCollapsedChange(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
    window.addEventListener("keydown", addSelection, true);
    return () => window.removeEventListener("keydown", addSelection, true);
  }, [chat, document, onCollapsedChange]);

  async function attachPhotos(files: File[]) {
    if (!chat || !files.length || loadingPhotos) return;
    const id = chat.id;
    if ((chat.photos?.length ?? 0) + files.length > MAX_CHAT_PHOTOS) { setError(`Attach up to ${MAX_CHAT_PHOTOS} photos per message.`); return; }
    setLoadingPhotos(true);
    setError("");
    try {
      const photos = await Promise.all(files.map(async (file): Promise<ChatPhoto> => {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || !file.size || file.size > MAX_CHAT_PHOTO_BYTES) throw new Error("Choose PNG, JPEG, WebP, or GIF photos up to 5 MB each.");
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        return { id: crypto.randomUUID(), name: file.name, dataUrl };
      }));
      updateChat(id, (current) => ({ ...current, photos: [...(current.photos ?? []), ...photos] }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not attach photos."); }
    finally { setLoadingPhotos(false); }
  }

  async function send() {
    if (!chat || (!chat.prompt.trim() && !chat.photos?.length) || requestRef.current || loadingPhotos) return;
    const id = chat.id;
    const prompt = chat.prompt;
    const selections = chat.selections;
    const photos = chat.photos ?? [];
    const message = { id: crypto.randomUUID(), role: "user" as const, text: prompt.trim(), photos, contexts: [...newDocumentContext(chat.messages, includedDocument), ...selections] };
    const messages = [...chat.messages, message];
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(id);
    setError("");
    updateChat(id, (current) => ({ ...current, title: current.messages.length || current.titleEdited ? current.title : (prompt.trim() || photos[0]?.name || "Photo chat").slice(0, 60), messages, prompt: "", selections: [], photos: [] }));
    const assistantId = crypto.randomUUID();
    let answer = "";
    let updateTimer: number | undefined;
    function publish(status?: "streaming" | "interrupted") {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      updateTimer = undefined;
      const text = answer;
      if (!text) return;
      updateChat(id, (current) => {
        const assistant = { id: assistantId, role: "assistant" as const, text, status };
        return { ...current, messages: current.messages.some((item) => item.id === assistantId)
          ? current.messages.map((item) => item.id === assistantId ? assistant : item)
          : [...current.messages, assistant] };
      });
    }
    try {
      const response = await fetch("/api/document-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true, messages: messagesWithoutExcludedDocuments(messages, chat.excludedDocumentPaths), reasoningEffort: chat.reasoningEffort }),
        signal: controller.signal,
      });
      await readChatResponse(response, controller.signal, (text) => {
        const first = !answer;
        answer += text;
        if (first) publish("streaming");
        else if (updateTimer === undefined) updateTimer = window.setTimeout(() => publish("streaming"), 50);
      });
      if (!answer.trim()) throw new Error("The model returned an empty response.");
      publish();
    } catch (cause) {
      if (deletedRequestRef.current === controller) return;
      if (answer) {
        publish("interrupted");
        setError(controller.signal.aborted ? "" : cause instanceof Error ? cause.message : "Chat failed.");
      } else {
        setError(controller.signal.aborted ? "Response stopped. Your prompt is ready to send again." : cause instanceof Error ? cause.message : "Chat failed.");
        updateChat(id, (current) => ({ ...current, messages: current.messages.filter((item) => item.id !== message.id), prompt: current.prompt || prompt, photos: [...photos, ...(current.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...selections, ...current.selections] }));
      }
    } finally {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      requestRef.current = null;
      setPending(null);
    }
  }

  async function handleChatAction(action: string | null, selectedChat = chat) {
    setMenuOpen(false);
    if (action === "manage-chats") { setSettingsOpen(true); return; }
    if (!selectedChat?.messages.length || (action !== "save-md" && action !== "save-notebook")) return;
    const snapshot = { fileName: chatExportFileName(selectedChat.title), content: exportChatMarkdown(selectedChat) };
    if (action === "save-notebook") { setExportSnapshot(snapshot); return; }
    setExporting(true);
    setError("");
    try {
      if (window.liberaExport?.saveMarkdownFile) {
        await window.liberaExport.saveMarkdownFile(snapshot);
      } else {
        const url = URL.createObjectURL(new Blob([snapshot.content], { type: "text/markdown;charset=utf-8" }));
        const anchor = window.document.createElement("a");
        anchor.href = url; anchor.download = snapshot.fileName;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export chat."); }
    finally { setExporting(false); }
  }

  async function openChatMenu(button: HTMLButtonElement) {
    if (!window.liberaMenu) { setMenuOpen(true); return; }
    const bounds = button.getBoundingClientRect();
    try {
      const action = await window.liberaMenu.popup({
        x: Math.round(bounds.left), y: Math.round(bounds.bottom),
        items: [
          { id: "manage-chats", label: "Manage Chats" },
          { id: "export-chat", label: "Export Chat", enabled: !!chat?.messages.length, submenu: [
            { id: "save-md", label: "Save MD file" },
            { id: "save-notebook", label: "Save to Notebook (or Notebook Folder)" },
          ] },
        ],
      });
      await handleChatAction(action);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open chat menu."); }
  }

  function deleteChats(ids: string[]) {
    if (!store || !ids.length) return;
    if (pending && ids.includes(pending)) {
      deletedRequestRef.current = requestRef.current;
      requestRef.current?.abort();
    }
    const fallback = createChat();
    setStore((current) => {
      if (!current) return current;
      const remaining = current.chats.filter((item) => !ids.includes(item.id));
      const chats = remaining.length ? remaining : [fallback];
      return { chats, activeId: chats.some((item) => item.id === current.activeId) ? current.activeId : chats[0].id };
    });
    setError("");
  }

  // Keep chat state and selection shortcuts alive while removing all panel UI.
  if (collapsed) return null;

  return <aside id="document-chat-panel" aria-label="Document chat" className="libera-glass-panel libera-chat-panel relative flex min-h-0 min-w-0 overflow-hidden border-l border-border bg-card">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="libera-window-drag-region flex h-12 shrink-0 items-center gap-2 px-2">
        <label className="sr-only" htmlFor="document-chat-history">Chat history</label>
        <select
          id="document-chat-history"
          className="libera-window-no-drag min-w-0 flex-1 rounded-md border border-border bg-muted p-2 text-xs"
          value={store?.activeId ?? ""}
          onChange={(event) => {
            setStore((current) => current && ({ ...current, activeId: event.target.value }));
            setError("");
          }}
        >
          {store?.chats.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button className={buttonClass} aria-label="New chat" title="New chat" disabled={!chat?.messages.length} onClick={() => { if (!chat?.messages.length) return; const next = createChat(); setStore((current) => current && ({ chats: [next, ...current.chats], activeId: next.id })); setError(""); }}><Plus size={16} /></button>
        <button ref={settingsButtonRef} type="button" className={buttonClass} aria-label="Chat settings" title="Chat settings" aria-haspopup="menu" disabled={!store || exporting} onClick={(event) => void openChatMenu(event.currentTarget)}><Settings size={16} /></button>
      </header>
        <div ref={logRef} role="log" aria-label="Chat messages" aria-live={pending === chat?.id ? "off" : "polite"} tabIndex={0} className={`min-h-0 min-w-0 flex-1 space-y-4 overflow-auto overscroll-x-contain p-4 [overflow-anchor:none] ${!chat?.messages.length ? "flex flex-col" : ""}`}
          onScroll={(event) => {
            const log = event.currentTarget;
            followResponseRef.current = log.scrollHeight - log.clientHeight - log.scrollTop < 48;
          }}
        >
          {!chat?.messages.length && <div className="mx-auto my-auto w-full max-w-xs shrink-0 space-y-3 text-center text-sm text-muted-foreground"><p>Ask a question about your document.</p><p>The current Markdown document, including unsaved edits, is sent with your prompt.</p><p>Select paragraphs in either editor and press <kbd>⌘/Ctrl + Shift + L</kbd> to add them to your prompt.</p></div>}
          {chat?.messages.map((message) => <article key={message.id} className="min-w-0 space-y-2 text-sm"><p className="text-xs font-semibold text-muted-foreground">{message.role === "user" ? "You" : "Assistant"}</p>{message.contexts?.map((context, index) => <details key={index} className="rounded-md bg-muted p-2 text-xs"><summary className="cursor-pointer break-all">{context.kind === "document" ? "Document" : "Selection"}: {context.name}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{context.text}</pre></details>)}{message.photos?.map((photo) => <div key={photo.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- User-attached local data URL. */}
            <img src={photo.dataUrl} alt={photo.name} className="max-h-48 max-w-full rounded-lg object-contain" />
          </div>)}<MarkdownRenderer
            className="libera-chat-markdown min-w-0 break-normal"
            baseFontSize={14}
            baseLineHeight={1.6}
            renderImages={false}
            content={message.role === "assistant" ? normalizeChatResponseMarkdown(message.text, message.status === "streaming") : message.text}
          />{message.status === "interrupted" && <p className="text-xs text-muted-foreground">Response interrupted</p>}</article>)}
          {pending === chat?.id && chat?.messages.at(-1)?.role !== "assistant" && <p role="status" className="libera-chat-thinking w-fit text-sm text-muted-foreground">Thinking…</p>}
        </div>
        <form className="space-y-2 border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {includedDocument && <div className="flex items-center gap-1">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={includedDocument.path}>{`Context: ${includedDocument.name}${newDocumentContext(chat?.messages ?? [], includedDocument).length ? " (current draft)" : " (already included)"}`}</p>
            <button type="button" className={buttonClass} aria-label="Remove document context" title="Remove document context" onClick={() => chat && updateChat(chat.id, (current) => ({ ...current, excludedDocumentPaths: [...(current.excludedDocumentPaths ?? []), includedDocument.path] }))}><X size={12} /></button>
          </div>}
          {!!chat?.photos?.length && <div className="flex gap-2 overflow-x-auto">
            {chat.photos.map((photo) => <div key={photo.id} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- User-attached local data URL. */}
              <img src={photo.dataUrl} alt={photo.name} className="h-16 w-16 rounded-lg object-cover" />
              <button type="button" aria-label={`Remove photo: ${photo.name}`} className="absolute right-0 top-0 rounded-full bg-card p-1" onClick={() => updateChat(chat.id, (current) => ({ ...current, photos: current.photos?.filter((item) => item.id !== photo.id) }))}><X size={12} /></button>
            </div>)}
          </div>}
          <input ref={photoInputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="Attach photos" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void attachPhotos(files); }} />

          {chat?.selections.map((context, index) => <div key={index} className="flex items-center gap-1 rounded-md bg-muted px-2 text-xs"><span className="min-w-0 flex-1 truncate" title={context.text}>{context.name}: {context.text}</span><button type="button" className={buttonClass} aria-label={`Remove selection ${index + 1}`} onClick={() => updateChat(chat.id, (current) => ({ ...current, selections: current.selections.filter((_, i) => i !== index) }))}><X size={12} /></button></div>)}
          <div className="flex flex-col gap-0.5">
          <textarea ref={composerRef} aria-label="Chat prompt" placeholder="Ask about your document…" rows={3} className="block w-full resize-none rounded-lg border border-border bg-muted p-3 text-sm outline-none focus:border-accent" value={chat?.prompt ?? ""} disabled={!chat} onChange={(event) => chat && updateChat(chat.id, (current) => ({ ...current, prompt: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Enter to send · Shift+Enter for newline</span><div className="flex items-center gap-1"><select
            aria-label="Reasoning effort" title="Reasoning effort"
            className="w-auto max-w-24 cursor-pointer appearance-none border-0 bg-transparent px-1 py-2 text-xs text-muted-foreground shadow-none outline-none focus-visible:underline"
            value={chat?.reasoningEffort ?? defaultReasoningEffort} disabled={!chat}
            onChange={(event) => { const effort = event.target.value; if (chat && isChatReasoningEffort(effort)) updateChat(chat.id, (current) => ({ ...current, reasoningEffort: effort })); }}
          >{CHAT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "Extra High" : effort[0].toUpperCase() + effort.slice(1)}</option>)}</select><button type="button" className={buttonClass} aria-label="Add photos" title="Add photos" disabled={!chat || loadingPhotos || !!pending} onClick={() => photoInputRef.current?.click()}><Plus size={16} /></button>{pending ? <button type="button" className={buttonClass} aria-label="Stop response" onClick={() => requestRef.current?.abort()}><Square size={14} /></button> : <button type="submit" className={buttonClass} aria-label="Send message" disabled={loadingPhotos || (!chat?.prompt.trim() && !chat?.photos?.length)}><Send size={16} /></button>}</div></div>
          </div>
        </form>
    </div>
    <ModalDialog open={menuOpen} title="Chat" onClose={() => setMenuOpen(false)}>
      <div className="flex flex-col gap-2">
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted" onClick={() => void handleChatAction("manage-chats")}>Manage Chats</button>
        <p className="px-2 text-xs text-muted-foreground">Export Chat</p>
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={!chat?.messages.length} onClick={() => void handleChatAction("save-md")}>Save MD file</button>
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={!chat?.messages.length} onClick={() => void handleChatAction("save-notebook")}>Save to Notebook (or Notebook Folder)</button>
      </div>
    </ModalDialog>
    {exportSnapshot && <DocumentChatExportDialog snapshot={exportSnapshot} onClose={() => setExportSnapshot(null)} onSaved={onExportSaved} />}
    {settingsOpen && store && <DocumentChatSettingsDialog
      chats={store.chats}
      activeId={store.activeId}
      onClose={() => { setSettingsOpen(false); settingsButtonRef.current?.focus(); }}
      onRename={(id, title) => updateChat(id, (current) => ({ ...current, title, titleEdited: true }))}
      onDelete={deleteChats}
    />}
  </aside>;
}
