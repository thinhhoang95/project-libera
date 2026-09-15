"use client";

import { useMarkdownReview } from "./markdown-review-context";
import { ReviewChatPanel } from "./markdown-review-ui";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Plus, MoreHorizontal, ArrowUp, Paperclip, Sparkles, BookOpen, Lightbulb, ListChecks, FileText, TextSelect, Square, X, RotateCcw, GitBranch } from "lucide-react";
import { DocumentChatExportDialog, type ChatExport } from "./document-chat-export-dialog";
import { ModalDialog } from "./modal-dialog";
import { DocumentChatSettingsDialog } from "./document-chat-settings-dialog";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { copyRenderedMarkdownSelection } from "@/lib/markdown-clipboard";
import { ChatFileComposer } from "./chat-file-composer";
import type { LiberaFileNode } from "@/lib/types";
import type { OpenTab } from "./types";
import { readChatResponse } from "./chat-stream-client";
import { apiRequest } from "./api-client";
import { CHAT_REASONING_EFFORTS, isChatReasoningEffort, chatExportFileName, exportChatMarkdown, formatChatTimestamp, MAX_CHAT_PHOTOS, MAX_CHAT_PHOTO_BYTES, messagesWithoutExcludedDocuments, newDocumentContext, normalizeChatResponseMarkdown, type ChatPhoto, validateChatStore, type ChatContext, type ChatStore, type DocumentChat } from "@/lib/document-chat";

import { DEFAULT_CHAT_FONT_SIZE, MIN_CHAT_FONT_SIZE, MAX_CHAT_FONT_SIZE, isChatFontSize } from "@/lib/chat-preferences";
import type { MathMarkerSettings } from "@/lib/math-markers";

const buttonClass = "libera-window-no-drag libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40";
function selectionExcerpt(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return `${lines.slice(0, 2).join(" ")}${lines.length > 2 ? "…" : ""}`;
}

function createChat(): DocumentChat {
  return { id: crypto.randomUUID(), title: "New chat", messages: [], prompt: "", selections: [] };
}

const ChatMessageMarkdown = memo(function ChatMessageMarkdown({ message, mathMarkers, fontSize }: {
  message: DocumentChat["messages"][number]; mathMarkers: MathMarkerSettings; fontSize: number;
}) {
  const content = useMemo(() => message.role === "assistant" ? normalizeChatResponseMarkdown(message.text, message.status === "streaming", mathMarkers) : message.text,
    [message.role, message.text, message.status, mathMarkers]);
  return <MarkdownRenderer copyAsMarkdown mathMarkers={mathMarkers} className="libera-chat-markdown min-w-0 break-normal"
    baseFontSize={fontSize} baseLineHeight={1.6} renderImages={false} content={content} />;
});

export function DocumentChatPanel({ files = [], tabs = [], activeTab, collapsed, mathMarkers, onCollapsedChange, onExportSaved, onCreateDraft }: { files?: LiberaFileNode[]; tabs?: OpenTab[]; onCreateDraft: (snapshot: ChatExport) => void; onExportSaved?: (notebook: string) => Promise<void>; activeTab: OpenTab | null | undefined; collapsed: boolean; mathMarkers: MathMarkerSettings; onCollapsedChange: (value: boolean) => void }) {
  const review = useMarkdownReview();
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<"low" | "medium" | "high" | "xhigh" | "max">("medium");
  const [fontSize, setFontSize] = useState(DEFAULT_CHAT_FONT_SIZE);
  const [fontSizeSaving, setFontSizeSaving] = useState(false);
  const [fontSizeError, setFontSizeError] = useState("");
  const [store, setStore] = useState<ChatStore | null>(null);
  const [now, setNow] = useState(() => new Date());
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
  const persistedStore = useRef<ChatStore | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followResponseRef = useRef(true);
  const chat = store?.chats.find((item) => item.id === store.activeId);
  const lastMessageText = chat?.messages.at(-1)?.text;
  const document = useMemo<ChatContext | null>(() => activeTab?.file.fileType === "markdown" ? { kind: "document", path: activeTab.untitled ? activeTab.id : activeTab.file.path, name: activeTab.file.name, text: activeTab.draft } : null, [activeTab]);

  const includedDocument = document && !chat?.excludedDocumentPaths?.includes(document.path) ? document : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    void apiRequest<{ history: ChatStore | null; fontSize?: unknown; defaultReasoningEffort?: unknown }>("/api/document-chat/state").then(({ history, fontSize: savedFontSize, defaultReasoningEffort: configuredEffort }) => {
      if (disposed) return;
      if (isChatFontSize(savedFontSize)) setFontSize(savedFontSize);
      if (isChatReasoningEffort(configuredEffort)) setDefaultReasoningEffort(configuredEffort);
      if (history != null && !validateChatStore(history)) throw new Error("Saved chat history is invalid.");
      const first = createChat();
      const restored = history ?? { chats: [first], activeId: first.id };
      restored.chats = restored.chats.map((item) => {
        item = { ...item, messages: item.messages.map((message) => message.status === "streaming" ? { ...message, status: "interrupted" as const } : message) };
        const last = item.messages.at(-1);
        return last?.role === "user" ? { ...item, messages: item.messages.slice(0, -1), prompt: item.prompt || last.text, photos: [...(last.photos ?? []), ...(item.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...(last.contexts ?? []), ...item.selections] } : item;
      });
      setStore(restored);
    }).catch(() => { if (!disposed) setStorageError("Saved chats could not be loaded. Reload the app to retry."); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, []);

  const persistStore = useCallback((snapshot: ChatStore | null) => {
    if (!snapshot) return;
    saveQueue.current = saveQueue.current.then(async () => {
      if (latestStore.current !== snapshot || persistedStore.current === snapshot) return;
      try {
        await apiRequest("/api/document-chat/state", { method: "PUT", body: JSON.stringify({ kind: "history", value: snapshot }) });
        persistedStore.current = snapshot;
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

  function branch(messageId: string) {
    if (!chat || requestRef.current || loadingPhotos || loadingFiles) return;
    const index = chat.messages.findIndex((message) => message.id === messageId && message.role === "assistant");
    if (index < 0) return;
    const branched: DocumentChat = { ...chat, id: crypto.randomUUID(), title: `${chat.title} (branch)`, titleEdited: true,
      messages: chat.messages.slice(0, index + 1), prompt: "", selections: [], photos: [] };
    setStore((current) => current && ({ chats: [...current.chats, branched], activeId: branched.id }));
    setError("");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function send(retryMessageId?: string) {
    if (!chat || (!retryMessageId && !chat.prompt.trim() && !chat.photos?.length) || requestRef.current || loadingPhotos || loadingFiles) return;
    const retryIndex = retryMessageId ? chat.messages.findIndex((message) => message.id === retryMessageId && message.role === "assistant") : -1;
    if (retryMessageId && (retryIndex < 1 || chat.messages[retryIndex - 1].role !== "user")) return;
    const id = chat.id;
    const prompt = chat.prompt;
    const selections = chat.selections;
    const photos = chat.photos ?? [];
    const message = { id: crypto.randomUUID(), role: "user" as const, text: prompt.trim(), createdAt: new Date().toISOString(), photos, contexts: [...newDocumentContext(chat.messages, includedDocument).filter((context) => !selections.some((item) => item.kind === "document" && item.path === context.path)), ...selections] };
    const messages = retryMessageId ? chat.messages.slice(0, retryIndex) : [...chat.messages, message];
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(id);
    setError("");
    updateChat(id, (current) => retryMessageId ? { ...current, messages } : ({ ...current, title: current.messages.length || current.titleEdited ? current.title : (prompt.trim() || photos[0]?.name || "Photo chat").slice(0, 60), messages, prompt: "", selections: [], photos: [] }));
    const assistantId = crypto.randomUUID();
    let createdAt: string | undefined;
    let answer = "";
    let updateTimer: number | undefined;
    function publish(status?: "streaming" | "interrupted") {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      updateTimer = undefined;
      const text = answer;
      if (!text) return;
      createdAt ??= new Date().toISOString();
      updateChat(id, (current) => {
        const assistant = { id: assistantId, role: "assistant" as const, text, status, createdAt };
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
        setError(controller.signal.aborted ? retryMessageId ? "Regeneration stopped. The original conversation was restored." : "Response stopped. Your prompt is ready to send again." : cause instanceof Error ? cause.message : "Chat failed.");
        updateChat(id, (current) => retryMessageId ? { ...current, messages: chat.messages } : ({ ...current, messages: current.messages.filter((item) => item.id !== message.id), prompt: current.prompt || prompt, photos: [...photos, ...(current.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...selections, ...current.selections] }));
      }
    } finally {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      requestRef.current = null;
      setPending(null);
    }
  }

  async function handleChatAction(action: string | null, selectedChat = chat) {
    setMenuOpen(false);
    if (action === "increase-font-size" || action === "decrease-font-size") {
      if (fontSizeSaving) return;
      const next = Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, fontSize + (action === "increase-font-size" ? 1 : -1)));
      if (next === fontSize) return;
      setFontSizeSaving(true);
      setFontSizeError("");
      try {
        await apiRequest("/api/document-chat/state", { method: "PUT", body: JSON.stringify({ kind: "font-size", value: next }) });
        setFontSize(next);
      } catch { setFontSizeError("Chat font size could not be saved. Please try again."); }
      finally { setFontSizeSaving(false); }
      return;
    }
    if (action === "manage-chats") { setSettingsOpen(true); return; }
    if (!selectedChat?.messages.length || (action !== "save-md" && action !== "save-notebook" && action !== "create-draft")) return;
    const snapshot = { fileName: chatExportFileName(selectedChat.title), content: exportChatMarkdown(selectedChat, mathMarkers) };
    if (action === "create-draft") { onCreateDraft(snapshot); return; }
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
            { id: "create-draft", label: "Create a new draft" },
            { id: "save-md", label: "Save MD file" },
            { id: "save-notebook", label: "Save to Notebook (or Notebook Folder)" },
          ] },
          { id: "increase-font-size", label: "Increase Font Size", enabled: !fontSizeSaving && fontSize < MAX_CHAT_FONT_SIZE },
          { id: "decrease-font-size", label: "Decrease Font Size", enabled: !fontSizeSaving && fontSize > MIN_CHAT_FONT_SIZE },
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
  if (review?.chatReview) return <ReviewChatPanel key={`${review.doc?.id ?? "no-document"}:${review.doc?.round ?? 1}`} files={files} tabs={tabs} />;

  return <aside style={{ "--chat-font-size": `${fontSize}px`, "--chat-small-font-size": `${fontSize * 12 / 14}px` } as CSSProperties} id="document-chat-panel" aria-label="Document chat" className="libera-glass-panel libera-chat-panel relative flex min-h-0 min-w-0 overflow-hidden border-l border-border bg-card">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="libera-chat-header libera-window-drag-region flex shrink-0 items-center gap-1 px-3">
        <span className="libera-ai-mark" aria-hidden><Sparkles size={22} /></span>
        <label className="sr-only" htmlFor="document-chat-history">Chat history</label>
        <div className="libera-window-no-drag relative min-w-0 flex-1">
          <select
            id="document-chat-history"
            className="w-full cursor-pointer appearance-none truncate border-0 bg-transparent py-2 pl-2 pr-7 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={store?.activeId ?? ""}
            onChange={(event) => {
              setStore((current) => current && ({ ...current, activeId: event.target.value }));
              setError("");
            }}
          >
            {store?.chats.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        <button className={buttonClass} aria-label="New chat" title="New chat" disabled={!chat?.messages.length} onClick={() => { if (!chat?.messages.length) return; const next = createChat(); setStore((current) => current && ({ chats: [next, ...current.chats], activeId: next.id })); setError(""); }}><Plus size={16} /></button>
        <button ref={settingsButtonRef} type="button" className={buttonClass} aria-label="Chat settings" title="Chat settings" aria-haspopup="menu" disabled={!store || exporting} onClick={(event) => void openChatMenu(event.currentTarget)}><MoreHorizontal size={17} /></button>
        <button type="button" className={`${buttonClass} libera-window-no-drag`} aria-label="Close AI panel" title="Close AI panel" onClick={() => onCollapsedChange(true)}><X size={17} /></button>
      </header>
        <div ref={logRef} role="log" aria-label="Chat messages" aria-live={pending === chat?.id ? "off" : "polite"} tabIndex={0} className={`libera-chat-log min-h-0 min-w-0 flex-1 space-y-4 overflow-auto overscroll-x-contain p-4 [overflow-anchor:none] ${!chat?.messages.length ? "flex flex-col" : ""}`}
          onScroll={(event) => {
            const log = event.currentTarget;
            followResponseRef.current = log.scrollHeight - log.clientHeight - log.scrollTop < 48;
          }}
          onCopy={(event) => { copyRenderedMarkdownSelection(event.currentTarget, event, mathMarkers); }}
        >
          {!chat?.messages.length && <div className="libera-chat-welcome">
            <span className="libera-ai-orb" aria-hidden><Sparkles size={30} strokeWidth={1.5} /></span>
            <h2>A little clarity.<br />A new possibility.</h2>
            <p>Think it through with your AI companion.</p>
            <div className="libera-chat-starters">
              {(includedDocument ? [
                { icon: BookOpen, label: "Summarize this document", prompt: "Summarize the key ideas in this document." },
                { icon: Lightbulb, label: "Explain the key ideas", prompt: "Explain the key ideas in this document in simple terms." },
                { icon: ListChecks, label: "Find questions to explore", prompt: "What questions or gaps in this document are worth exploring further?" },
              ] : [
                { icon: Lightbulb, label: "Explore a new idea", prompt: "Help me think through an idea: " },
                { icon: BookOpen, label: "Make sense of a topic", prompt: "Help me understand this topic: " },
              ]).map(({icon: Icon, label, prompt}) => <button key={label} type="button" disabled={!chat} onClick={() => { if (chat) updateChat(chat.id, (current) => ({ ...current, prompt })); composerRef.current?.focus(); }}><Icon aria-hidden size={16} /><span>{label}</span><ArrowUp aria-hidden size={13} /></button>)}
            </div>
            <p className="libera-chat-context-hint">{includedDocument ? "Your current Markdown draft is included." : "Type @ to bring a Markdown file into the conversation."}</p>
            <p className="libera-chat-context-hint">Add selected paragraphs with <kbd>⌘/Ctrl + Shift + L</kbd>.</p>
          </div>}
          {chat?.messages.map((message, messageIndex) => <article key={message.id} data-role={message.role} className="libera-chat-message min-w-0 space-y-2 text-sm"><p className="libera-chat-speaker text-xs font-semibold text-muted-foreground">{message.role === "assistant" && <Sparkles aria-hidden size={13} />}{message.role === "user" ? "You" : "Libera AI"}</p>{message.contexts?.map((context, index) => {
            const label = context.kind === "document" ? context.name : selectionExcerpt(context.text);
            const ContextIcon = context.kind === "document" ? FileText : TextSelect;
            return <details key={index} className="rounded-md bg-muted p-2 text-xs"><summary className="cursor-pointer break-all" aria-label={`${context.kind === "document" ? "Document" : "Selection"}: ${label}`}><ContextIcon aria-hidden size={13} className="mr-1 inline-block align-middle" /><span className="align-middle">{label}</span></summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{context.text}</pre></details>;
          })}{message.photos?.map((photo) => <div key={photo.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- User-attached local data URL. */}
            <img src={photo.dataUrl} alt={photo.name} className="max-h-48 max-w-full rounded-lg object-contain" />
          </div>)}<ChatMessageMarkdown message={message} mathMarkers={mathMarkers} fontSize={fontSize} />{message.status === "interrupted" && <p className="text-xs text-muted-foreground">Response interrupted</p>}
          {message.role === "assistant" && message.status !== "streaming" && <div className="flex items-center gap-1 text-muted-foreground">
            <button type="button" className={buttonClass} aria-label="Regenerate response" title="Regenerate response (replaces this response and later messages)" disabled={!!pending || loadingPhotos || loadingFiles || chat.messages[messageIndex - 1]?.role !== "user"} onClick={() => void send(message.id)}><RotateCcw aria-hidden size={14} /></button>
            <button type="button" className={buttonClass} aria-label="Branch conversation" title="Branch into a new chat from this response" disabled={!!pending || loadingPhotos || loadingFiles} onClick={() => branch(message.id)}><GitBranch aria-hidden size={14} /></button>
            {message.createdAt ? <time className="ml-1 text-xs tabular-nums" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{formatChatTimestamp(message.createdAt, now)}</time> : <span className="ml-1 text-xs">Time unavailable</span>}
          </div>}</article>)}
          {pending === chat?.id && chat?.messages.at(-1)?.role !== "assistant" && <p role="status" className="libera-chat-thinking w-fit text-sm text-muted-foreground">Thinking…</p>}
        </div>
        <form className="libera-chat-form shrink-0 space-y-2 p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {fontSizeError && <p role="alert" className="text-xs text-destructive">{fontSizeError}</p>}
          {storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {includedDocument && <div className="libera-chat-context flex items-center gap-1"><BookOpen aria-hidden size={13} className="shrink-0" />
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

          {chat?.selections.map((context, index) => <div key={index} className="flex items-center gap-1 rounded-md bg-muted px-2 text-xs"><span className="min-w-0 flex-1 truncate" title={context.kind === "document" ? context.path : context.text}>{context.kind === "document" ? `File: ${context.name}` : `${context.name}: ${context.text}`}</span><button type="button" className={buttonClass} aria-label={context.kind === "document" ? `Remove file: ${context.name}` : `Remove selection ${index + 1}`} onClick={() => updateChat(chat.id, (current) => ({ ...current, selections: current.selections.filter((_, i) => i !== index) }))}><X size={12} /></button></div>)}
          <div className="libera-chat-composer flex flex-col gap-0.5">
          <ChatFileComposer key={chat?.id ?? "loading"} chatId={chat?.id ?? "loading"} composerRef={composerRef} value={chat?.prompt ?? ""} disabled={!chat} files={files} tabs={tabs}
            onChange={(prompt) => chat && updateChat(chat.id, (current) => ({ ...current, prompt }))}
            onLoading={setLoadingFiles} onError={setError} onSend={() => void send()}
            onAttach={(context) => chat && updateChat(chat.id, (current) => ({ ...current,
              selections: [...current.selections.filter((item) => item.kind !== "document" || item.path !== context.path), context],
              excludedDocumentPaths: current.excludedDocumentPaths?.filter((path) => path !== context.path),
            }))} />
          <div className="libera-chat-composer-actions flex items-center justify-end"><div className="flex w-full items-center gap-1"><select
            aria-label="Reasoning effort" title="Reasoning effort"
            className="w-auto max-w-24 cursor-pointer appearance-none border-0 bg-transparent px-1 py-2 text-xs text-muted-foreground shadow-none outline-none focus-visible:underline"
            value={chat?.reasoningEffort ?? defaultReasoningEffort} disabled={!chat}
            onChange={(event) => { const effort = event.target.value; if (chat && isChatReasoningEffort(effort)) updateChat(chat.id, (current) => ({ ...current, reasoningEffort: effort })); }}
          >{CHAT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "Extra High" : effort[0].toUpperCase() + effort.slice(1)}</option>)}</select><button type="button" className={`${buttonClass} libera-chat-attach`} aria-label="Add photos" title="Add photos" disabled={!chat || loadingPhotos || !!pending} onClick={() => photoInputRef.current?.click()}><Paperclip size={18} /></button>{pending ? <button type="button" className={`${buttonClass} libera-chat-send`} aria-label="Stop response" onClick={() => requestRef.current?.abort()}><Square size={14} /></button> : <button type="submit" className={`${buttonClass} libera-chat-send`} aria-label="Send message" disabled={loadingPhotos || loadingFiles || (!chat?.prompt.trim() && !chat?.photos?.length)}><ArrowUp size={18} /></button>}</div></div>
          </div>
          <p className="libera-chat-key-hint">Enter to send · Shift + Enter for a new line</p>
        </form>
    </div>
    <ModalDialog open={menuOpen} title="Chat" onClose={() => setMenuOpen(false)}>
      <div className="flex flex-col gap-2">
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted" onClick={() => void handleChatAction("manage-chats")}>Manage Chats</button>
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={fontSizeSaving || fontSize >= MAX_CHAT_FONT_SIZE} onClick={() => void handleChatAction("increase-font-size")}>Increase Font Size</button>
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={fontSizeSaving || fontSize <= MIN_CHAT_FONT_SIZE} onClick={() => void handleChatAction("decrease-font-size")}>Decrease Font Size</button>
        <p className="px-2 text-xs text-muted-foreground">Export Chat</p>
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={!chat?.messages.length} onClick={() => void handleChatAction("create-draft")}>Create a new draft</button>
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
