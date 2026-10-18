"use client";

import { useMarkdownReview } from "./markdown-review-context";
import { ReviewChatPanel } from "./markdown-review-ui";
import { readRegisteredEditorSelection } from "./editor-selection-registry";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Plus, MoreHorizontal, ArrowUp, Paperclip, Sparkles, BookOpen, Lightbulb, ListChecks, FileText, TextSelect, Square, X, RotateCcw, GitBranch, Pencil, Copy, Check, Eye, Image as ImageIcon, Tag, Bot, MessagesSquare, Search, SpellCheck, FilePlus2 } from "lucide-react";
import { DocumentChatExportDialog, type ChatExport, type ChatNotebookExport } from "./document-chat-export-dialog";
import { ModalDialog } from "./modal-dialog";
import { DocumentChatSettingsDialog } from "./document-chat-settings-dialog";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { copyRenderedMarkdownSelection } from "@/lib/markdown-clipboard";
import { markdownLinkWorkspacePath } from "@/lib/markdown-file-links";
import { ChatFileComposer } from "./chat-file-composer";
import { isTextFileType, type LiberaFileNode, type LiberaFilePayload } from "@/lib/types";
import type { OpenTab } from "./types";
import { readAgentEvents, readChatResponse } from "./chat-stream-client";
import { AgentRunView } from "./agent-activity";
import { ChatTokenUsage } from "./chat-token-usage";
import { chatUsageRequests } from "@/lib/chat-token-usage";
import { apiRequest } from "./api-client";
import { createDeferredSave, registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
import { CHAT_REASONING_EFFORTS, chatHasPhotoSource, isChatMode, isChatReasoningEffort, chatExportFileName, exportChatMarkdown, formatChatTimestamp, MAX_CHAT_PHOTOS, MAX_CHAT_PHOTO_BYTES, messagesWithoutExcludedDocuments, newChatContexts, newDocumentContext, normalizeChatResponseMarkdown, type ChatMessage, type ChatMode, type ChatPhoto, validateChatStore, type ChatContext, type ChatStore, type DocumentChat } from "@/lib/document-chat";
import { AGENT_PERMISSION_LABELS, AGENT_PERMISSIONS, compactAgentRunRecord, isAgentPermission, type AgentPermission, type AgentRunRecord, type UndoResult } from "@/lib/agent/types";

import { DEFAULT_CHAT_FONT_SIZE, MIN_CHAT_FONT_SIZE, MAX_CHAT_FONT_SIZE, isChatFontSize } from "@/lib/chat-preferences";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { QuickPrompt } from "@/lib/quick-prompts";

const buttonClass = "libera-window-no-drag libera-sidebar-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40";
function selectionExcerpt(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return `${lines.slice(0, 2).join(" ")}${lines.length > 2 ? "…" : ""}`;
}

/** A photo on screen outside the chat, such as in the gallery viewer. `source` names its version. */
export type ChatViewedPhoto = { source: string; name: string; url: string };

function readDataUrl(blob: Blob, name: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${name}.`));
    reader.readAsDataURL(blob);
  });
}

// Gallery photos may be SVG or larger than the chat accepts; re-encode those
// as JPEG, stepping down in size until the photo fits.
async function viewedPhotoDataUrl(photo: ChatViewedPhoto, signal: AbortSignal) {
  const response = await fetch(photo.url, { signal });
  if (!response.ok) throw new Error(`Could not read ${photo.name}.`);
  const blob = await response.blob();
  if (/^image\/(png|jpeg|webp|gif)$/.test(blob.type) && blob.size && blob.size <= MAX_CHAT_PHOTO_BYTES) return readDataUrl(blob, photo.name);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    for (const side of [2048, 1536, 1024]) {
      const scale = Math.min(1, side / Math.max(image.naturalWidth || side, image.naturalHeight || side));
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.round((image.naturalWidth || side) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || side) * scale));
      const context = canvas.getContext("2d");
      if (!context) break;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
      if (encoded && encoded.size <= MAX_CHAT_PHOTO_BYTES) return readDataUrl(encoded, photo.name);
    }
  } catch { /* Reported below. */ }
  finally { URL.revokeObjectURL(objectUrl); }
  throw new Error(`${photo.name} could not be prepared for the chat.`);
}

function createChat(mode: ChatMode = "chat", agentPermission?: AgentPermission): DocumentChat {
  return { id: crypto.randomUUID(), title: "New chat", messages: [], prompt: "", selections: [], ...(mode === "agent" ? { mode, agentPermission } : {}) };
}

const CHAT_MODE_STORAGE_KEY = "libera.chatMode";
const AGENT_PERMISSION_STORAGE_KEY = "libera.agentPermission";
const DEFAULT_AGENT_PERMISSION: AgentPermission = "open-files";

function readStoredPreference<T>(key: string, accept: (value: unknown) => value is T): T | undefined {
  try {
    const value = window.localStorage.getItem(key);
    return accept(value) ? value : undefined;
  } catch { return undefined; }
}

function storePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Preferences are a convenience. */ }
}

/** The visible text of an agent run, for copying, exporting and later turns. */
function agentRunText(run: AgentRunRecord) {
  return run.steps.flatMap((step) => step.kind === "text" && step.text.trim() ? [step.text.trim()] : []).join("\n\n");
}

function hasUnrevertedAgentChanges(messages: ChatMessage[]) {
  return messages.some((message) => message.agent?.changes.some((change) => !change.reverted));
}

/** Earlier turns for a request: Agent replies keep their file changes but not their step log. */
function requestMessages(messages: ChatMessage[], agent: boolean) {
  return messages.map(({ agent: run, ...message }) => agent && run
    ? { ...message, agent: { ...run, steps: [], tasks: [] } }
    : message);
}

const ChatMessageMarkdown = memo(function ChatMessageMarkdown({ message, mathMarkers, fontSize, onOpenFileLink }: {
  message: DocumentChat["messages"][number]; mathMarkers: MathMarkerSettings; fontSize: number; onOpenFileLink: (href: string) => Promise<boolean>;
}) {
  const content = useMemo(() => message.role === "assistant" ? normalizeChatResponseMarkdown(message.text, message.status === "streaming", mathMarkers) : message.text,
    [message.role, message.text, message.status, mathMarkers]);
  return <MarkdownRenderer copyAsMarkdown mathMarkers={mathMarkers} className="libera-chat-markdown min-w-0 break-normal"
    baseFontSize={fontSize} baseLineHeight={1.6} renderImages={false} content={content} onOpenFileLink={onOpenFileLink} />;
});

/** How Agent mode reads and updates the editor: live drafts in, changed files back out. */
export type AgentWorkspaceBridge = {
  /** Notebook selected in the sidebar, used when no file is open. */
  notebook?: string;
  readTabDraft: (path: string) => string | null;
  syncTabFromDisk: (path: string, baseline?: string) => Promise<{ content: string; keptDraft: boolean } | null>;
  restoreTabAfterUndo: (path: string, result: { status: "restored" | "deleted"; content?: string; draft?: string }) => void;
  refreshAfterChanges: (createdPaths: string[]) => Promise<void>;
  openFile: (path: string) => void;
};

export function DocumentChatPanel({ viewedPhoto = null, files = [], tabs = [], attachmentRequest, onAttachmentHandled, quickPrompts = [], activeTab, collapsed, mathMarkers, onCollapsedChange, onExportSaved, onSaveToNotebook, onCreateDraft, agentWorkspace }: { files?: LiberaFileNode[]; tabs?: OpenTab[]; attachmentRequest?: { id: string; tab: OpenTab } | null; onAttachmentHandled?: (id: string) => void; quickPrompts?: QuickPrompt[]; onCreateDraft: (snapshot: ChatExport) => void; onExportSaved?: (notebook: string) => Promise<void>; onSaveToNotebook?: (input: ChatNotebookExport) => Promise<void>; activeTab: OpenTab | null | undefined; collapsed: boolean; mathMarkers: MathMarkerSettings; onCollapsedChange: (value: boolean) => void; viewedPhoto?: ChatViewedPhoto | null; agentWorkspace?: AgentWorkspaceBridge }) {
  const review = useMarkdownReview();
  // Agent runs finish after awaits; reach the review of whatever document is open then.
  const reviewRef = useRef(review);
  useEffect(() => { reviewRef.current = review; }, [review]);
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<"low" | "medium" | "high" | "xhigh" | "max">("medium");
  const [model, setModel] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
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
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [undoingRunId, setUndoingRunId] = useState<string | null>(null);
  const [defaultMode, setDefaultMode] = useState<ChatMode>("chat");
  const [defaultPermission, setDefaultPermission] = useState<AgentPermission>(DEFAULT_AGENT_PERMISSION);
  // Agent runs call back into the workspace after awaits; always use the latest bridge.
  const agentWorkspaceRef = useRef(agentWorkspace);
  // Replies link files by workspace path; open them in the editor rather than navigating the window.
  const openChatFileLink = useCallback(async (href: string) => {
    const path = markdownLinkWorkspacePath(href);
    if (!path) return false;
    agentWorkspaceRef.current?.openFile(path);
    return true;
  }, []);
  useEffect(() => { agentWorkspaceRef.current = agentWorkspace; }, [agentWorkspace]);
  const latestStore = useRef<ChatStore | null>(null);
  const fontSizeWrite = useRef<Promise<unknown> | null>(null);
  const historyWriter = useMemo(() => createDeferredSave(async (body) => {
    await apiRequest("/api/document-chat/state", { method: "PUT", body, keepalive: stateRequestKeepalive(body) });
    setStorageError("");
  }, () => setStorageError("Chat history could not be saved. Your next change will retry saving.")), []);
  const requestRef = useRef<AbortController | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const handledAttachmentRequest = useRef<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followResponseRef = useRef(true);
  const readingPositionsRef = useRef(new Map<string, { top: number; follow: boolean }>());
  const chat = store?.chats.find((item) => item.id === store.activeId);
  const mode: ChatMode = chat?.mode ?? "chat";
  const agentMode = mode === "agent";
  const permission: AgentPermission = chat?.agentPermission ?? defaultPermission;
  const lastMessageText = chat?.messages.at(-1)?.text;
  const lastMessageSteps = chat?.messages.at(-1)?.agent?.steps.length;
  const viewedFile = activeTab && !activeTab.untitled && !activeTab.gallery ? activeTab.file : null;
  // "Modify all files in Notebook/Folder" applies to the notebook of the file in view, else the selected one.
  const agentNotebook = viewedFile?.notebook ?? agentWorkspace?.notebook;
  const openTextFileCount = tabs.filter((tab) => !tab.untitled && !tab.gallery && isTextFileType(tab.file.fileType)).length;
  // A photo being viewed covers the editors, so it replaces the document as context.
  const document = useMemo<ChatContext | null>(() => !viewedPhoto && (isTextFileType(activeTab?.file.fileType) || activeTab?.file.fileType === "pdf") ? { kind: "document", path: activeTab.untitled ? activeTab.id : activeTab.file.path, name: activeTab.file.name, text: activeTab.file.fileType === "pdf" ? "" : activeTab.draft } : null, [activeTab, viewedPhoto]);

  const includedDocument = document && !chat?.excludedDocumentPaths?.includes(document.path) ? document : null;
  const includedPhoto = viewedPhoto && !chat?.excludedPhotoSources?.includes(viewedPhoto.source) ? viewedPhoto : null;
  // Sent once per conversation; a copy waiting in the composer (a restored unsent message) counts too.
  const photoAlreadyIncluded = !!includedPhoto && !!chat && (chatHasPhotoSource(chat.messages, includedPhoto.source) || !!chat.photos?.some((photo) => photo.source === includedPhoto.source));
  const pendingPhoto = photoAlreadyIncluded ? null : includedPhoto;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    void apiRequest<{ history: ChatStore | null; fontSize?: unknown; model?: unknown; alternativeModels?: unknown; defaultReasoningEffort?: unknown }>("/api/document-chat/state").then(({ history, fontSize: savedFontSize, model: configuredModel, alternativeModels, defaultReasoningEffort: configuredEffort }) => {
      if (disposed) return;
      if (isChatFontSize(savedFontSize)) setFontSize(savedFontSize);
      if (typeof configuredModel === "string" && configuredModel.trim()) {
        const availableModels = Array.from(new Set([configuredModel, ...(Array.isArray(alternativeModels) ? alternativeModels : [])]
          .filter((candidate): candidate is string => typeof candidate === "string" && !!candidate.trim())
          .map((candidate) => candidate.trim())));
        setModel(configuredModel.trim());
        setModels(availableModels);
      }
      if (isChatReasoningEffort(configuredEffort)) setDefaultReasoningEffort(configuredEffort);
      if (history != null && !validateChatStore(history)) throw new Error("Saved chat history is invalid.");
      const storedMode = readStoredPreference(CHAT_MODE_STORAGE_KEY, isChatMode) ?? "chat";
      const storedPermission = readStoredPreference(AGENT_PERMISSION_STORAGE_KEY, isAgentPermission) ?? DEFAULT_AGENT_PERMISSION;
      setDefaultMode(storedMode);
      setDefaultPermission(storedPermission);
      const first = createChat(storedMode, storedPermission);
      const restored = history ?? { chats: [first], activeId: first.id };
      if (history) historyWriter.markSaved({ kind: "history", value: history });
      restored.chats = restored.chats.map((item) => {
        item = { ...item, messages: item.messages.map((message) => message.status === "streaming" ? { ...message, status: "interrupted" as const } : message) };
        const last = item.messages.at(-1);
        return last?.role === "user" ? { ...item, messages: item.messages.slice(0, -1), prompt: item.prompt || last.text, photos: [...(last.photos ?? []), ...(item.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...(last.contexts ?? []), ...item.selections] } : item;
      });
      setStore(restored);
    }).catch(() => { if (!disposed) setStorageError("Saved chats could not be loaded. Reload the app to retry."); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, []);

  useEffect(() => {
    latestStore.current = store;
    if (store) historyWriter.schedule({ kind: "history", value: store }, pending ? 30_000 : 1000);
  }, [store, pending, historyWriter]);

  useEffect(() => {
    const flush = () => {
      if (latestStore.current) historyWriter.schedule({ kind: "history", value: latestStore.current });
      return Promise.all([historyWriter.flush(), fontSizeWrite.current]);
    };
    const unregister = registerStateFlusher(flush);
    return () => { unregister(); void flush().catch(() => undefined); };
  }, [historyWriter]);

  useLayoutEffect(() => {
    const id = chat?.id;
    const log = logRef.current;
    if (!id || !log || collapsed) return;
    const positions = readingPositionsRef.current;
    const saved = positions.get(id);
    followResponseRef.current = saved?.follow ?? true;
    log.scrollTop = saved && !saved.follow ? saved.top : log.scrollHeight;
    positions.set(id, { top: log.scrollTop, follow: followResponseRef.current });
  }, [chat?.id, collapsed, review?.chatReview]);

  useEffect(() => {
    const log = logRef.current;
    if (log && followResponseRef.current) log.scrollTop = log.scrollHeight;
  }, [chat?.messages.length, lastMessageText, lastMessageSteps, pending]);

  const updateChat = useCallback((id: string, update: (current: DocumentChat) => DocumentChat) => {
    setStore((current) => current && ({ ...current, chats: current.chats.map((item) => item.id === id ? update(item) : item) }));
  }, []);

  useEffect(() => {
    function addSelection(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== "KeyL" || !chat || !document) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      let text = "";
      if (activeTab?.file.fileType === "markdown" && target instanceof HTMLTextAreaElement && target.classList.contains("markdown-editor-input")) {
        text = target.value.slice(target.selectionStart, target.selectionEnd);
      } else if ((activeTab?.file.fileType === "latex" || activeTab?.file.fileType === "text" || activeTab?.file.fileType === "markdown") && target.closest("[data-libera-code-editor]")) {
        // CodeMirror editors, including the CodeMirror Markdown Source editor.
        text = readRegisteredEditorSelection(target) ?? "";
      } else if (activeTab?.file.fileType === "markdown" && target.closest(".libera-tiptap")) {
        const selection = window.getSelection();
        if (selection?.anchorNode && selection.focusNode && target.closest(".libera-tiptap")?.contains(selection.anchorNode) && target.closest(".libera-tiptap")?.contains(selection.focusNode)) text = selection.toString();
      } else if (activeTab?.file.fileType === "pdf") {
        if (target.closest("#document-chat-panel")) return;
        // PDF text layers do not take keyboard focus; the event may target body.
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        const focus = selection?.focusNode;
        const layer = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest(".pdf-text-layer");
        const viewer = layer?.closest<HTMLElement>(".libera-pdf-viewer");
        const focusLayer = (focus instanceof Element ? focus : focus?.parentElement)?.closest(".pdf-text-layer");
        if (!viewer || viewer.dataset.pdfPath !== document.path || !focus || !viewer.contains(focus) || !focusLayer) return;
        text = selection!.toString();
      } else return;
      event.preventDefault();
      event.stopPropagation();
      if (!text.trim()) return;
      if (chat.selections.length >= 20) { setError("Send or remove some selections before adding more."); onCollapsedChange(false); return; }
      const context: ChatContext = { ...document, kind: "selection", text };
      updateChat(chat.id, (current) => {
        const selections = current.selections.some((item) => item.kind === "selection" && item.path === context.path && item.text === text) ? current.selections : [...current.selections, context];
        // Retain the source PDF even if the user switches tabs before sending.
        const source = activeTab?.file.fileType === "pdf" && !current.excludedDocumentPaths?.includes(document.path) ? newChatContexts(current.messages, [...selections, document]) : selections;
        return { ...current, selections: source };
      });
      onCollapsedChange(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
    window.addEventListener("keydown", addSelection, true);
    return () => window.removeEventListener("keydown", addSelection, true);
  }, [chat, document, activeTab?.file.fileType, onCollapsedChange, updateChat]);

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

  const attachFile = useCallback(async (file: LiberaFileNode, requestedTab?: OpenTab): Promise<boolean> => {
    if (!chat || loadingFiles) return false;
    const chatId = chat.id;
    setLoadingFiles(true);
    setError("");
    try {
      const tab = requestedTab ?? tabs.find((item) => !item.untitled && item.file.path === file.path);
      if (file.fileType === "image") {
        if ((chat.photos?.length ?? 0) >= MAX_CHAT_PHOTOS) throw new Error(`Attach up to ${MAX_CHAT_PHOTOS} photos per message.`);
        if (!file.size || file.size > MAX_CHAT_PHOTO_BYTES) throw new Error(`${file.name} must be 5 MB or smaller to attach.`);
        const rawPath = file.path.split("/").map(encodeURIComponent).join("/");
        // Gallery photo tabs carry their own URL; their path is not a notebook path.
        const response = await fetch(tab?.gallery && tab.rawUrl ? tab.rawUrl : `/api/files/raw/${rawPath}`);
        if (!response.ok) throw new Error(`Could not read ${file.name}.`);
        const blob = await response.blob();
        if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type) || !blob.size || blob.size > MAX_CHAT_PHOTO_BYTES) {
          throw new Error("Choose PNG, JPEG, WebP, or GIF photos up to 5 MB each.");
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(blob);
        });
        updateChat(chatId, (current) => ({ ...current, photos: [...(current.photos ?? []), { id: crypto.randomUUID(), name: file.name, dataUrl }] }));
      } else {
        const path = tab?.untitled ? tab.id : file.path;
        const existing = [...chat.selections, ...chat.messages.flatMap((message) => message.contexts ?? [])]
          .find((context) => context.kind === "document" && context.path === path);
        let text: string;
        if (existing && (file.fileType === "markdown" || existing.text)) {
          text = existing.text;
        } else if (file.fileType === "pdf") {
          ({ text } = await apiRequest<{ text: string }>(`/api/document-chat/pdf?path=${encodeURIComponent(file.path)}`));
        } else if (tab) {
          text = tab.draft;
        } else {
          const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(file.path)}`);
          if (!isTextFileType(payload.file.fileType) || typeof payload.content !== "string") throw new Error(`Could not read ${file.name}.`);
          text = payload.content;
        }
        if (text.length > 500_000) throw new Error(`${file.name} is too large to attach (maximum 500,000 characters).`);
        const context: ChatContext = { kind: "document", path, name: file.name, text };
        updateChat(chatId, (current) => ({ ...current,
          selections: newChatContexts(current.messages, [...current.selections.filter((item) => item.kind !== "document" || item.path !== path), context]),
          excludedDocumentPaths: current.excludedDocumentPaths?.filter((excludedPath) => excludedPath !== path),
        }));
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach file.");
      return false;
    } finally {
      setLoadingFiles(false);
    }
  }, [chat, loadingFiles, tabs, updateChat]);

  useEffect(() => {
    if (!attachmentRequest || !chat || loadingFiles || handledAttachmentRequest.current === attachmentRequest.id) return;
    handledAttachmentRequest.current = attachmentRequest.id;
    onAttachmentHandled?.(attachmentRequest.id);
    review?.setChatReview(false);
    void attachFile(attachmentRequest.tab.file, attachmentRequest.tab);
  }, [attachmentRequest, attachFile, chat, loadingFiles, onAttachmentHandled, review]);

  function startEdit(message: { id: string; text: string }) {
    if (pending || requestRef.current || loadingPhotos || loadingFiles) return;
    setEditing({ id: message.id, text: message.text });
  }
  function submitEdit() {
    if (!editing) return;
    const edit = editing;
    setEditing(null);
    void send(undefined, edit);
  }
  async function copyResponse(message: { id: string; text: string }) {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => current === message.id ? null : current), 1500);
    } catch { setError("Could not copy to the clipboard."); }
  }

  function branch(messageId: string) {
    if (!chat || requestRef.current || loadingPhotos || loadingFiles) return;
    const index = chat.messages.findIndex((message) => message.id === messageId && message.role === "assistant");
    if (index < 0) return;
    const branched: DocumentChat = { ...chat, id: crypto.randomUUID(), title: `${chat.title} (branch)`, titleEdited: true,
      usageRequests: chatUsageRequests(chat).filter((request) => chat.messages.slice(0, index + 1).some((message) => message.id === request.messageId)),
      messages: chat.messages.slice(0, index + 1), prompt: "", selections: [], photos: [] };
    setStore((current) => current && ({ chats: [...current.chats, branched], activeId: branched.id }));
    setError("");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function send(retryMessageId?: string, edit?: { id: string; text: string }) {
    const replay = Boolean(retryMessageId || edit);
    if (!chat || (!replay && !chat.prompt.trim() && !chat.photos?.length && !pendingPhoto) || requestRef.current || loadingPhotos || loadingFiles) return;
    if (!replay && pendingPhoto && (chat.photos?.length ?? 0) >= MAX_CHAT_PHOTOS) { setError(`Attach up to ${MAX_CHAT_PHOTOS} photos per message, including the one you are viewing.`); return; }
    const retryIndex = retryMessageId ? chat.messages.findIndex((message) => message.id === retryMessageId && message.role === "assistant") : -1;
    if (retryMessageId && (retryIndex < 1 || chat.messages[retryIndex - 1].role !== "user")) return;
    const editIndex = edit ? chat.messages.findIndex((item) => item.id === edit.id && item.role === "user") : -1;
    if (edit && (editIndex < 0 || (!edit.text.trim() && !chat.messages[editIndex].photos?.length))) return;
    if (replay && hasUnrevertedAgentChanges(chat.messages.slice(retryMessageId ? retryIndex : editIndex))) {
      setError("Undo the agent's file changes in the replies below first, so regenerating does not lose track of them.");
      return;
    }
    const agent = chat.mode === "agent";
    if (agent && permission === "notebook" && !agentNotebook) { setError("Open a file or select a notebook first, so the agent knows which notebook it may change."); return; }
    const id = chat.id;
    const prompt = chat.prompt;
    const selections = chat.selections;
    const photos = chat.photos ?? [];
    // In Agent mode the open file is passed by path; the agent reads what it needs.
    const message = { id: crypto.randomUUID(), role: "user" as const, text: prompt.trim(), createdAt: new Date().toISOString(), photos, contexts: newChatContexts(chat.messages, [...selections, ...(includedDocument && !agent ? [includedDocument] : [])]).sort((a, b) => Number(a.kind === "selection") - Number(b.kind === "selection")) };
    const messages = edit ? [...chat.messages.slice(0, editIndex), { ...chat.messages[editIndex], text: edit.text.trim(), createdAt: new Date().toISOString() }]
      : retryMessageId ? chat.messages.slice(0, retryIndex) : [...chat.messages, message];
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(id);
    setError("");
    setNotice("");
    let committed = false;
    const assistantId = crypto.randomUUID();
    let createdAt: string | undefined;
    let answer = "";
    let updateTimer: number | undefined;
    const run: AgentRunRecord | null = agent ? { runId: "", permission, steps: [], tasks: [], changes: [] } : null;
    let runStarted = false;
    let syncQueue = Promise.resolve();
    function publish(status?: "streaming" | "interrupted") {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      updateTimer = undefined;
      const text = run ? agentRunText(run) : answer;
      if (run ? !runStarted : !text) return;
      createdAt ??= new Date().toISOString();
      const record = run ? compactAgentRunRecord(structuredClone(run)) : undefined;
      updateChat(id, (current) => {
        const assistant: ChatMessage = { id: assistantId, role: "assistant", text, status, createdAt, ...(record ? { agent: record } : {}) };
        return { ...current, messages: current.messages.some((item) => item.id === assistantId)
          ? current.messages.map((item) => item.id === assistantId ? assistant : item)
          : [...current.messages, assistant] };
      });
    }
    function schedule() {
      if (updateTimer === undefined) updateTimer = window.setTimeout(() => publish("streaming"), 50);
    }
    try {
      if (!replay) {
        message.contexts = await Promise.all(message.contexts
          .filter((context) => context.kind !== "document" || !chat.excludedDocumentPaths?.includes(context.path))
          .map(async (context) => {
            if (agent || context.kind !== "document" || context.text || !/\.pdf$/i.test(context.path)) return context;
            const { text } = await apiRequest<{ text: string }>(`/api/document-chat/pdf?path=${encodeURIComponent(context.path)}`, { signal: controller.signal });
            return { ...context, text };
          }));
        if (pendingPhoto) message.photos = [...photos, { id: crypto.randomUUID(), name: pendingPhoto.name, dataUrl: await viewedPhotoDataUrl(pendingPhoto, controller.signal), source: pendingPhoto.source }];
      }
      controller.signal.throwIfAborted();
      updateChat(id, (current) => replay ? { ...current, messages } : ({ ...current,
        title: current.messages.length || current.titleEdited ? current.title : (prompt.trim() || message.photos[0]?.name || "Photo chat").slice(0, 60), messages,
        prompt: current.prompt === prompt ? "" : current.prompt,
        selections: current.selections.filter((item) => !selections.includes(item)),
        photos: current.photos?.filter((item) => !photos.includes(item)) ?? [],
      }));
      committed = true;
      // Keep the request ledger separate from replies so regenerations and failed
      // attempts retain their usage even when the visible conversation changes.
      updateChat(id, (current) => ({ ...current, usageRequests: [...chatUsageRequests(chat), { id: assistantId, messageId: messages.at(-1)!.id }] }));
      if (run) {
        const bridge = agentWorkspaceRef.current;
        // The agent sees what the user sees: unsaved drafts of open files go with
        // the request, and each tab follows the agent's edits unless the user types.
        const openTabs = tabs.filter((tab) => !tab.untitled && !tab.gallery && isTextFileType(tab.file.fileType));
        const baselines = new Map<string, string>();
        const drafts: Record<string, string> = {};
        for (const tab of openTabs) {
          const draft = bridge?.readTabDraft(tab.file.path) ?? tab.draft;
          baselines.set(tab.file.path, draft);
          if (draft !== tab.saved) drafts[tab.file.path] = draft;
        }
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        const keptDrafts: string[] = [];
        let failure = "";
        let doneMessage = "";
        const response = await fetch("/api/agent", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: id, model, reasoningEffort: chat.reasoningEffort, permission: run.permission,
            messages: requestMessages(messages, true),
            activeFile: activeTab && !activeTab.untitled && !activeTab.gallery ? activeTab.file.path : undefined,
            openFiles: openTabs.map((tab) => tab.file.path), drafts, notebook: bridge?.notebook,
          }),
          signal: controller.signal,
        });
        await readAgentEvents(response, controller.signal, (event) => {
          if (event.type === "run_started") { run.runId = event.runId; runStarted = true; publish("streaming"); }
          else if (event.type === "text_delta") {
            const last = run.steps.at(-1);
            if (last?.kind === "text") last.text += event.text; else run.steps.push({ kind: "text", text: event.text });
            schedule();
          } else if (event.type === "tool_started") {
            run.steps.push({ kind: "tool", id: event.id, name: event.name, summary: event.summary, status: "running", ...(event.diff ? { diff: event.diff } : {}) });
            publish("streaming");
          } else if (event.type === "tool_finished") {
            const step = run.steps.find((item) => item.kind === "tool" && item.id === event.id);
            if (step?.kind === "tool") Object.assign(step, { status: event.status, result: event.result, ...(event.detail ? { detail: event.detail } : {}) });
            schedule();
          } else if (event.type === "tasks_updated") { run.tasks = event.tasks; schedule(); }
          else if (event.type === "file_changed") {
            const existing = run.changes.find((change) => change.path === event.path);
            if (existing) existing.created ||= event.created; else run.changes.push({ path: event.path, created: event.created });
            publish("streaming");
            // Shared files changed through the collab host: the tab's live replica already has the edit.
            if (event.shared) return;
            const changedPath = event.path;
            syncQueue = syncQueue.then(async () => {
              const synced = await agentWorkspaceRef.current?.syncTabFromDisk(changedPath, baselines.get(changedPath)).catch(() => null);
              if (synced?.keptDraft) { if (!keptDrafts.includes(changedPath)) keptDrafts.push(changedPath); }
              else if (synced) baselines.set(changedPath, synced.content);
            });
          } else if (event.type === "comments_added") {
            if (event.count) {
              const existing = run.comments?.find((entry) => entry.path === event.path);
              if (existing) existing.count += event.count; else run.comments = [...(run.comments ?? []), { path: event.path, count: event.count }];
              schedule();
            }
          } else if (event.type === "usage") {
            usage.inputTokens += event.usage.inputTokens;
            usage.outputTokens += event.usage.outputTokens;
            usage.cachedTokens += event.usage.cachedTokens ?? 0;
            const total = { ...usage };
            updateChat(id, (current) => ({ ...current, usageRequests: current.usageRequests?.map((request) => request.id === assistantId ? { ...request, usage: total } : request) }));
          } else if (event.type === "done") { run.outcome = event.outcome; doneMessage = event.message ?? ""; }
          else if (event.type === "error") failure = event.message;
        });
        await syncQueue;
        // The agent wrote threads into the document's review; show them if that document is open.
        const currentReview = reviewRef.current;
        if (currentReview?.doc && run.comments?.some((entry) => entry.path === currentReview.doc!.key)) {
          await currentReview.reload();
          currentReview.showComments();
        }
        if (failure || (run.outcome === "error" && !run.steps.length && !run.changes.length)) {
          if (!run.steps.length && !run.changes.length) throw new Error(failure || doneMessage || "The agent run failed.");
          run.outcome = "error";
        }
        publish();
        if (failure || run.outcome === "error") setError(failure || doneMessage || "The agent run failed.");
        else if (doneMessage) setNotice(doneMessage);
        if (keptDrafts.length) setNotice(`You kept typing in ${keptDrafts.join(", ")}, so your unsaved version stays in the editor. The agent's version is saved on disk; saving the tab replaces it.`);
      } else {
        const response = await fetch("/api/document-chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stream: true, sessionId: id, messages: requestMessages(messagesWithoutExcludedDocuments(messages, chat.excludedDocumentPaths), false), model, reasoningEffort: chat.reasoningEffort }),
          signal: controller.signal,
        });
        await readChatResponse(response, controller.signal, (text) => {
          const first = !answer;
          answer += text;
          if (first) publish("streaming");
          else if (updateTimer === undefined) updateTimer = window.setTimeout(() => publish("streaming"), 50);
        }, (usage) => {
          updateChat(id, (current) => ({ ...current, usageRequests: current.usageRequests?.map((request) => request.id === assistantId ? { ...request, usage } : request) }));
        });
        if (!answer.trim()) throw new Error("The model returned an empty response.");
        publish();
      }
    } catch (cause) {
      if (deletedRequestRef.current === controller) return;
      await syncQueue;
      const produced = run ? runStarted && (run.steps.length > 0 || run.changes.length > 0) : !!answer;
      if (produced) {
        if (run) {
          run.outcome = controller.signal.aborted ? "stopped" : "error";
          publish();
        } else publish("interrupted");
        setError(controller.signal.aborted ? "" : cause instanceof Error ? cause.message : "Chat failed.");
      } else {
        setError(controller.signal.aborted ? replay ? "Regeneration stopped. The original conversation was restored." : "Response stopped. Your prompt is ready to send again." : cause instanceof Error ? cause.message : "Chat failed.");
        if (committed) updateChat(id, (current) => replay ? { ...current, messages: chat.messages } : ({ ...current, messages: current.messages.filter((item) => item.id !== message.id && item.id !== assistantId), prompt: current.prompt || prompt, photos: [...photos, ...(current.photos ?? [])].slice(0, MAX_CHAT_PHOTOS), selections: [...selections, ...current.selections] }));
      }
    } finally {
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      requestRef.current = null;
      setPending(null);
      if (run?.changes.length) await agentWorkspaceRef.current?.refreshAfterChanges(run.changes.filter((change) => change.created).map((change) => change.path));
    }
  }

  async function undoAgentChanges(messageId: string, run: AgentRunRecord, paths?: string[]) {
    if (!chat || !run.runId || undoingRunId) return;
    const chatId = chat.id;
    setUndoingRunId(run.runId);
    setError("");
    setNotice("");
    try {
      const { results } = await apiRequest<{ results: UndoResult[] }>("/api/agent/undo", { method: "POST", body: JSON.stringify({ runId: run.runId, paths }) });
      const bridge = agentWorkspaceRef.current;
      for (const result of results) {
        if ((result.status === "restored" || result.status === "deleted") && !result.shared) bridge?.restoreTabAfterUndo(result.path, { status: result.status, content: result.content, draft: result.draft });
      }
      const undone = new Set(results.filter((result) => result.status === "restored" || result.status === "deleted" || result.status === "already-reverted").map((result) => result.path));
      updateChat(chatId, (current) => ({ ...current, messages: current.messages.map((message) => message.id === messageId && message.agent
        ? { ...message, agent: { ...message.agent, changes: message.agent.changes.map((change) => undone.has(change.path) ? { ...change, reverted: true } : change) } }
        : message) }));
      const problems = results.filter((result) => result.status === "conflict" || result.status === "missing").map((result) => result.message ?? result.path);
      if (problems.length) setError(problems.join(" "));
      if (results.some((result) => result.status === "deleted")) await bridge?.refreshAfterChanges([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not undo the agent's changes.");
    } finally {
      setUndoingRunId(null);
    }
  }

  function changeMode(next: ChatMode) {
    if (!chat || pending) return;
    setDefaultMode(next);
    storePreference(CHAT_MODE_STORAGE_KEY, next);
    updateChat(chat.id, (current) => ({ ...current, mode: next, agentPermission: current.agentPermission ?? defaultPermission }));
    setError("");
    setNotice("");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function changePermission(next: AgentPermission) {
    if (!chat || pending) return;
    setDefaultPermission(next);
    storePreference(AGENT_PERMISSION_STORAGE_KEY, next);
    updateChat(chat.id, (current) => ({ ...current, agentPermission: next }));
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
        const write = apiRequest("/api/document-chat/state", { method: "PUT", body: JSON.stringify({ kind: "font-size", value: next }) });
        fontSizeWrite.current = write;
        await write;
        setFontSize(next);
      } catch { setFontSizeError("Chat font size could not be saved. Please try again."); }
      finally { fontSizeWrite.current = null; setFontSizeSaving(false); }
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
            { id: "save-notebook", label: "Save to Notebook or Folder" },
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
    const fallback = createChat(defaultMode, defaultPermission);
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
    <div aria-hidden className="libera-chat-glow" data-active={pending === chat?.id} />
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
        <button className={buttonClass} aria-label="New chat" title="New chat" disabled={!chat?.messages.length} onClick={() => { if (!chat?.messages.length) return; const next = createChat(defaultMode, defaultPermission); setStore((current) => current && ({ chats: [next, ...current.chats], activeId: next.id })); setError(""); setNotice(""); }}><Plus size={16} /></button>
        <button ref={settingsButtonRef} type="button" className={buttonClass} aria-label="Chat settings" title="Chat settings" aria-haspopup="menu" disabled={!store || exporting} onClick={(event) => void openChatMenu(event.currentTarget)}><MoreHorizontal size={17} /></button>
        <button type="button" className={`${buttonClass} libera-window-no-drag`} aria-label="Close AI panel" title="Close AI panel" onClick={() => onCollapsedChange(true)}><X size={17} /></button>
      </header>
      {/* Mode and permission are chosen before a conversation starts, then fixed. */}
      {!chat?.messages.length && <div className="libera-chat-modebar libera-window-no-drag flex shrink-0 items-center justify-center gap-2">
        <div className="libera-mode-switch" role="group" aria-label="Assistant mode">
          <button type="button" aria-pressed={!agentMode} disabled={!chat || !!pending} title="Chat: talk through the open document and your attachments" onClick={() => changeMode("chat")}><MessagesSquare aria-hidden size={13} />Chat</button>
          <button type="button" aria-pressed={agentMode} disabled={!chat || !!pending} title="Agent: searches your library, reads files, and can edit them" onClick={() => changeMode("agent")}><Bot aria-hidden size={13} />Agent</button>
        </div>
        {agentMode && <label className="libera-agent-permission" title={`Agent permission: ${AGENT_PERMISSION_LABELS[permission]}`}>
          <span className="sr-only">Agent permission</span>
          <select value={permission} disabled={!chat || !!pending} onChange={(event) => { const next = event.target.value; if (isAgentPermission(next)) changePermission(next); }}>
            {AGENT_PERMISSIONS.map((item) => <option key={item} value={item}>{AGENT_PERMISSION_LABELS[item]}</option>)}
          </select>
          <ChevronDown aria-hidden size={13} />
        </label>}
      </div>}
        <div ref={logRef} role="log" aria-label="Chat messages" aria-live={pending === chat?.id ? "off" : "polite"} tabIndex={0} className={`libera-chat-log min-h-0 min-w-0 flex-1 space-y-4 overflow-auto overscroll-x-contain p-4 [overflow-anchor:none] ${!chat?.messages.length ? "flex flex-col" : ""}`}
          onScroll={(event) => {
            const log = event.currentTarget;
            followResponseRef.current = log.scrollHeight - log.clientHeight - log.scrollTop < 48;
            // Snapshot during the event: a removed log may report zero in cleanup.
            if (chat) readingPositionsRef.current.set(chat.id, { top: log.scrollTop, follow: followResponseRef.current });
          }}
          onCopy={(event) => { copyRenderedMarkdownSelection(event.currentTarget, event, mathMarkers); }}
        >
          {!chat?.messages.length && agentMode && <div className="libera-chat-welcome">
            <span className="libera-ai-orb" aria-hidden><Bot size={30} strokeWidth={1.5} /></span>
            <h2>Hand over the legwork.<br />Keep the last word.</h2>
            <p>{permission === "read-only" ? "The agent searches your library and reads what it needs, without changing anything." : "The agent searches your library, reads what it needs, and edits files for you."}</p>
            <div className="libera-chat-starters">
              {(viewedFile?.fileType === "pdf" ? [
                { icon: BookOpen, label: "Summarize this PDF", prompt: "Summarize the PDF I'm viewing, citing page numbers." },
                { icon: Search, label: "Find notes on the same topics", prompt: "Find notes in this notebook that discuss the topics of the PDF I'm viewing, and explain how they relate." },
              ] : viewedFile && isTextFileType(viewedFile.fileType) ? [
                ...(permission === "read-only" ? [] : [
                  { icon: SpellCheck, label: "Fix typos and grammar", prompt: "Fix spelling and grammar mistakes in the file I'm viewing. Keep my wording and formatting otherwise." },
                  { icon: ListChecks, label: "Add a summary at the top", prompt: "Add a short summary section at the top of the file I'm viewing." },
                ]),
                { icon: Search, label: "Find related notes", prompt: "Find other notes in this notebook related to the file I'm viewing, and explain how they connect." },
              ] : [
                { icon: Search, label: "Find everything about a topic", prompt: "Find everything in my notes about: " },
                { icon: ListChecks, label: "Collect open questions and TODOs", prompt: "List the open questions and TODOs across the notes in this notebook, with the file each comes from." },
                ...(permission === "notebook" ? [{ icon: FilePlus2, label: "Create an index note", prompt: "Create a note named Index.md in this notebook that links to every note, grouped by folder, with a one-line description of each." }] : []),
              ]).map(({icon: Icon, label, prompt}) => <button key={label} type="button" disabled={!chat} onClick={() => { if (chat) updateChat(chat.id, (current) => ({ ...current, prompt })); composerRef.current?.focus(); }}><Icon aria-hidden size={16} /><span>{label}</span><ArrowUp aria-hidden size={13} /></button>)}
            </div>
            <p className="libera-chat-context-hint">{permission === "read-only" ? "Read Only: the agent will not change any file."
              : permission === "open-files" ? (openTextFileCount ? `It can modify the ${openTextFileCount === 1 ? "file" : `${openTextFileCount} files`} open in the editor. Changes show up right away and can be undone.` : "Open the files you want it to change. It can still search and read the rest.")
              : agentNotebook ? `It can modify and create files in “${agentNotebook}”. Changes show up right away and can be undone.` : "Open a file or select a notebook for it to work in."}</p>
            <p className="libera-chat-context-hint">Type @ to point it at a file, or add selected text with <kbd>⌘/Ctrl + Shift + L</kbd>.</p>
          </div>}
          {!chat?.messages.length && !agentMode && <div className="libera-chat-welcome">
            <span className="libera-ai-orb" aria-hidden><Sparkles size={30} strokeWidth={1.5} /></span>
            <h2>A little clarity.<br />A new possibility.</h2>
            <p>Think it through with your AI companion.</p>
            <div className="libera-chat-starters">
              {(includedPhoto ? [
                { icon: Eye, label: "Describe this photo", prompt: "Describe this photo in detail." },
                { icon: Tag, label: "Suggest a title and caption", prompt: "Suggest a short title and a one-sentence caption for this photo." },
                { icon: Lightbulb, label: "Write a prompt to recreate it", prompt: "Write an image-generation prompt that would recreate this photo, covering subject, composition, lighting, and style." },
              ] : includedDocument ? [
                { icon: BookOpen, label: "Summarize this document", prompt: "Summarize the key ideas in this document." },
                { icon: Lightbulb, label: "Explain the key ideas", prompt: "Explain the key ideas in this document in simple terms." },
                { icon: ListChecks, label: "Find questions to explore", prompt: "What questions or gaps in this document are worth exploring further?" },
              ] : [
                { icon: Lightbulb, label: "Explore a new idea", prompt: "Help me think through an idea: " },
                { icon: BookOpen, label: "Make sense of a topic", prompt: "Help me understand this topic: " },
              ]).map(({icon: Icon, label, prompt}) => <button key={label} type="button" disabled={!chat} onClick={() => { if (chat) updateChat(chat.id, (current) => ({ ...current, prompt })); composerRef.current?.focus(); }}><Icon aria-hidden size={16} /><span>{label}</span><ArrowUp aria-hidden size={13} /></button>)}
            </div>
            <p className="libera-chat-context-hint">{includedPhoto ? "The photo you are viewing is included." : includedDocument ? (activeTab?.file.fileType === "pdf" ? "Your current PDF’s text will be included." : activeTab?.file.fileType === "latex" ? "Your current LaTeX source is included." : activeTab?.file.fileType === "text" ? `Your current ${activeTab.file.name} is included.` : "Your current Markdown draft is included.") : "Type @ to bring a file into the conversation."}</p>
            {!viewedPhoto && <p className="libera-chat-context-hint">Add selected paragraphs with <kbd>⌘/Ctrl + Shift + L</kbd>.</p>}
          </div>}
          {chat?.messages.map((message, messageIndex) => <article key={message.id} data-role={message.role} className="libera-chat-message min-w-0 space-y-2 text-sm"><div className="flex items-center justify-between gap-2"><p className="libera-chat-speaker text-xs font-semibold text-muted-foreground">{message.role === "assistant" && (message.agent ? <Bot aria-hidden size={13} /> : <Sparkles aria-hidden size={13} />)}{message.role === "user" ? "You" : message.agent ? "Libera Agent" : "Libera AI"}</p>{message.role === "user" && editing?.id !== message.id && <button type="button" className="libera-window-no-drag libera-sidebar-icon-button -my-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground disabled:opacity-40" aria-label="Edit message" title={hasUnrevertedAgentChanges(chat.messages.slice(messageIndex)) ? "Undo the agent's changes below before editing this message" : "Edit message (regenerates from here)"} disabled={!!pending || loadingPhotos || loadingFiles || hasUnrevertedAgentChanges(chat.messages.slice(messageIndex))} onClick={() => startEdit(message)}><Pencil aria-hidden size={14} /></button>}</div>{message.contexts?.map((context, index) => {
            const label = context.kind === "document" ? context.name : selectionExcerpt(context.text);
            const ContextIcon = context.kind === "document" ? FileText : TextSelect;
            return <details key={index} className="rounded-md bg-muted p-2 text-xs"><summary className="cursor-pointer break-all" aria-label={`${context.kind === "document" ? "Document" : "Selection"}: ${label}`}><ContextIcon aria-hidden size={13} className="mr-1 inline-block align-middle" /><span className="align-middle">{label}</span></summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{context.text}</pre></details>;
          })}{message.photos?.map((photo) => <div key={photo.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- User-attached local data URL. */}
            <img src={photo.dataUrl} alt={photo.name} className="max-h-48 max-w-full rounded-lg object-contain" />
          </div>)}{editing?.id === message.id ? <div className="space-y-2">
            <textarea autoFocus aria-label="Edit message" className="min-h-20 w-full resize-y rounded-lg border border-input bg-card p-2 text-sm outline-none focus:border-ring" value={editing.text} onChange={(event) => setEditing({ id: message.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitEdit(); } }} />
            <div className="flex items-center justify-end gap-2"><span className="mr-auto text-xs text-muted-foreground">Later messages will be replaced.</span><button type="button" className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-muted" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={!editing.text.trim() && !message.photos?.length} onClick={submitEdit}>Save &amp; regenerate</button></div>
          </div> : message.agent ? <AgentRunView run={message.agent} streaming={message.status === "streaming"} mathMarkers={mathMarkers} fontSize={fontSize}
            undoing={undoingRunId === message.agent.runId} onUndo={(paths) => void undoAgentChanges(message.id, message.agent!, paths)} onOpenFile={(path) => agentWorkspace?.openFile(path)} onOpenFileLink={openChatFileLink} />
            : <ChatMessageMarkdown message={message} mathMarkers={mathMarkers} fontSize={fontSize} onOpenFileLink={openChatFileLink} />}{message.status === "interrupted" && <p className="text-xs text-muted-foreground">Response interrupted</p>}
          {message.role === "assistant" && message.status !== "streaming" && <div className="flex items-center gap-1 text-muted-foreground">
            <button type="button" className={buttonClass} aria-label="Copy response as Markdown" title="Copy response as Markdown" onClick={() => void copyResponse(message)}>{copiedId === message.id ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}</button>
            <button type="button" className={buttonClass} aria-label="Regenerate response" title={hasUnrevertedAgentChanges(chat.messages.slice(messageIndex)) ? "Undo the agent's file changes before regenerating" : "Regenerate response (replaces this response and later messages)"} disabled={!!pending || loadingPhotos || loadingFiles || chat.messages[messageIndex - 1]?.role !== "user" || hasUnrevertedAgentChanges(chat.messages.slice(messageIndex))} onClick={() => void send(message.id)}><RotateCcw aria-hidden size={14} /></button>
            <button type="button" className={buttonClass} aria-label="Branch conversation" title="Branch into a new chat from this response" disabled={!!pending || loadingPhotos || loadingFiles} onClick={() => branch(message.id)}><GitBranch aria-hidden size={14} /></button>
            {message.createdAt ? <time className="ml-1 text-xs tabular-nums" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{formatChatTimestamp(message.createdAt, now)}</time> : <span className="ml-1 text-xs">Time unavailable</span>}
          </div>}</article>)}
          {pending === chat?.id && chat?.messages.at(-1)?.role !== "assistant" && <p role="status" className="libera-chat-thinking w-fit text-sm text-muted-foreground">Thinking…</p>}
        </div>
        <form className="libera-chat-form shrink-0 space-y-2 p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {fontSizeError && <p role="alert" className="text-xs text-destructive">{fontSizeError}</p>}
          {storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
          {agentMode && <div className="libera-chat-context flex items-center gap-1"><Bot aria-hidden size={13} className="shrink-0" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={viewedFile?.path}>{`${viewedFile ? `Viewing ${viewedFile.name} · ` : ""}${permission === "read-only" ? "Read only"
              : permission === "open-files" ? `Can modify ${openTextFileCount} open file${openTextFileCount === 1 ? "" : "s"}`
              : agentNotebook ? `Can modify files in ${agentNotebook}` : "No notebook selected"}`}</p>
          </div>}
          {!agentMode && includedDocument && <div className="libera-chat-context flex items-center gap-1"><BookOpen aria-hidden size={13} className="shrink-0" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={includedDocument.path}>{`Context: ${includedDocument.name}${newDocumentContext(chat?.messages ?? [], includedDocument).length ? (activeTab?.file.fileType === "pdf" ? " (PDF text)" : " (current draft)") : " (already included)"}`}</p>
            <button type="button" className={buttonClass} aria-label="Remove document context" title="Remove document context" onClick={() => chat && updateChat(chat.id, (current) => ({ ...current, excludedDocumentPaths: [...(current.excludedDocumentPaths ?? []), includedDocument.path] }))}><X size={12} /></button>
          </div>}
          {viewedPhoto && (includedPhoto ? <div className="libera-chat-context flex items-center gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- Thumbnail of the photo being viewed. */}
            <img src={includedPhoto.url} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={includedPhoto.name}>{`Context: ${includedPhoto.name}${photoAlreadyIncluded ? " (already included)" : " (photo)"}`}</p>
            <button type="button" className={buttonClass} aria-label="Remove photo context" title="Remove photo context" onClick={() => chat && updateChat(chat.id, (current) => ({ ...current, excludedPhotoSources: [...(current.excludedPhotoSources ?? []), includedPhoto.source] }))}><X size={12} /></button>
          </div> : <div className="libera-chat-context flex items-center gap-1"><ImageIcon aria-hidden size={13} className="shrink-0" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={viewedPhoto.name}>{`${viewedPhoto.name} is not included`}</p>
            <button type="button" className="libera-window-no-drag rounded-full px-2 py-1 text-xs font-medium hover:bg-muted" onClick={() => chat && updateChat(chat.id, (current) => ({ ...current, excludedPhotoSources: current.excludedPhotoSources?.filter((source) => source !== viewedPhoto.source) }))}>Include</button>
          </div>)}
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
          <ChatFileComposer key={chat?.id ?? "loading"} chatId={chat?.id ?? "loading"} composerRef={composerRef} value={chat?.prompt ?? ""} disabled={!chat} files={files} quickPrompts={quickPrompts}
            {...(agentMode ? { placeholder: "Ask the agent to find, read or edit… Type @ for files" } : {})}
            onChange={(prompt) => chat && updateChat(chat.id, (current) => ({ ...current, prompt }))}
            onSend={() => void send()} onAttachFile={(file) => attachFile(file)} />
          <div className="libera-chat-composer-actions flex items-center justify-end"><div className="flex w-full items-center gap-1"><select
            aria-label="Reasoning effort" title="Reasoning effort"
            className="w-auto max-w-24 cursor-pointer appearance-none border-0 bg-transparent px-1 py-2 text-xs text-muted-foreground shadow-none outline-none focus-visible:underline"
            value={chat?.reasoningEffort ?? defaultReasoningEffort} disabled={!chat}
            onChange={(event) => { const effort = event.target.value; if (chat && isChatReasoningEffort(effort)) updateChat(chat.id, (current) => ({ ...current, reasoningEffort: effort })); }}
          >{CHAT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "Extra High" : effort[0].toUpperCase() + effort.slice(1)}</option>)}</select><button type="button" className={`${buttonClass} libera-chat-attach`} aria-label="Add photos" title="Add photos" disabled={!chat || loadingPhotos || !!pending} onClick={() => photoInputRef.current?.click()}><Paperclip size={18} /></button>{pending ? <button type="button" className={`${buttonClass} libera-chat-send`} aria-label="Stop response" onClick={() => requestRef.current?.abort()}><Square size={14} /></button> : <button type="submit" className={`${buttonClass} libera-chat-send`} aria-label="Send message" disabled={loadingPhotos || loadingFiles || (!chat?.prompt.trim() && !chat?.photos?.length && !pendingPhoto)}><ArrowUp size={18} /></button>}</div></div>
          </div>
          {chat && <ChatTokenUsage chat={chat} model={model} models={models} onModelChange={setModel} />}
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
        <button type="button" className="rounded-lg p-2 text-left text-sm hover:bg-muted disabled:opacity-40" disabled={!chat?.messages.length} onClick={() => void handleChatAction("save-notebook")}>Save to Notebook or Folder</button>
      </div>
    </ModalDialog>
    {exportSnapshot && <DocumentChatExportDialog snapshot={exportSnapshot} onClose={() => setExportSnapshot(null)} onSaved={onExportSaved} onSaveToNotebook={onSaveToNotebook} />}
    {settingsOpen && store && <DocumentChatSettingsDialog
      chats={store.chats}
      activeId={store.activeId}
      onClose={() => { setSettingsOpen(false); settingsButtonRef.current?.focus(); }}
      onRename={(id, title) => updateChat(id, (current) => ({ ...current, title, titleEdited: true }))}
      onDelete={deleteChats}
    />}
  </aside>;
}
