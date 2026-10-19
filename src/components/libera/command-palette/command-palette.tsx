"use client";

import { ChevronRight, CornerDownLeft, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon } from "@/components/libera/file-type";
import { fuzzyMatch, searchNotebookTree } from "@/components/libera/notebook-search";
import type { LiberaFileNode, LiberaTree } from "@/lib/types";
import { collectPaletteCommands, OPEN_COMMAND_PALETTE_EVENT, type PaletteCommand, type PaletteMode } from "./commands";

const RECENT_COMMANDS_KEY = "libera.commandPalette.recentCommands";
const RECENT_COMMAND_LIMIT = 6;
const FILE_RESULT_LIMIT = 60;
/** Typing this first switches Quick Open to commands, as in VS Code. */
const COMMAND_PREFIX = ">";

type CommandPaletteProps = {
  tree: LiberaTree;
  recentFiles: LiberaFileNode[];
  selectedNotebookName?: string;
  onOpenFile: (file: LiberaFileNode, placement: "tab" | "right") => void;
};

type Row =
  | { kind: "file"; key: string; file: LiberaFileNode; nameIndices: number[]; pathIndices: number[] }
  | { kind: "command"; key: string; command: PaletteCommand; indices: number[]; recent: boolean };

/** Where focus and the text selection were, so a command acts on what the person was working on. */
type Origin = { element: Element | null; ranges: Range[] };

function readRecentCommands(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rememberCommand(id: string) {
  try {
    const next = [id, ...readRecentCommands().filter((entry) => entry !== id)].slice(0, RECENT_COMMAND_LIMIT);
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Recent commands are a convenience; the palette works without them.
  }
}

function captureOrigin(): Origin {
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  return { element: document.activeElement, ranges };
}

function restoreOrigin(origin: Origin) {
  const { element, ranges } = origin;
  if (element instanceof HTMLElement && element.isConnected && element !== document.body) element.focus({ preventScroll: true });
  // Inputs keep their own selection; elsewhere (a PDF text selection) put it back.
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return;
  const live = ranges.filter((range) => range.startContainer.isConnected && range.endContainer.isConnected);
  const selection = window.getSelection();
  if (!selection || !live.length) return;
  selection.removeAllRanges();
  live.forEach((range) => selection.addRange(range));
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const marked = new Set(indices);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(runMarked ? <mark key={key} className="bg-transparent font-semibold text-foreground underline decoration-accent/60 underline-offset-2">{run}</mark> : <span key={key}>{run}</span>);
    run = "";
  };
  [...text].forEach((char, index) => {
    if (marked.has(index) !== runMarked) {
      flush(index);
      runMarked = marked.has(index);
    }
    run += char;
  });
  flush(text.length);
  return <>{parts}</>;
}

/** Shows a toolbar button's own icon inside the palette. */
function CopiedIcon({ element }: { element: Element }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4"
      ref={(node) => {
        node?.replaceChildren(element.cloneNode(true));
      }}
    />
  );
}

function folderOf(file: LiberaFileNode) {
  return file.path.split("/").slice(0, -1).join("/");
}

/**
 * Quick Open (⌘/Ctrl+P) finds a file in the notebooks; the command palette
 * (⌘/Ctrl+Shift+P) runs a tool from the focused editor's or viewer's toolbar.
 * Both are one box: a leading ">" means commands.
 */
export function CommandPalette({ tree, recentFiles, selectedNotebookName, onOpenFile }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [commands, setCommands] = useState<PaletteCommand[]>([]);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<Origin>({ element: null, ranges: [] });
  const openRef = useRef(false);
  const valueRef = useRef("");
  const mode: PaletteMode = value.startsWith(COMMAND_PREFIX) ? "commands" : "files";
  const query = mode === "commands" ? value.slice(COMMAND_PREFIX.length).trim() : value.trim();

  useEffect(() => {
    openRef.current = open;
    valueRef.current = value;
  }, [open, value]);

  const show = useCallback((nextMode: PaletteMode) => {
    if (!openRef.current) {
      originRef.current = captureOrigin();
      // Read the toolbars before the palette takes focus.
      setCommands(collectPaletteCommands(originRef.current.element));
      setRecentCommandIds(readRecentCommands());
    }
    setValue(nextMode === "commands" ? COMMAND_PREFIX : "");
    setActiveIndex(0);
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    });
  }, []);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => restoreOrigin(originRef.current));
  }, []);

  // ⌘/Ctrl+P and ⌘/Ctrl+Shift+P, read before the editors (which use ⌘/Ctrl+P for nothing else).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.code !== "KeyP" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const nextMode: PaletteMode = event.shiftKey ? "commands" : "files";
      const currentMode: PaletteMode = valueRef.current.startsWith(COMMAND_PREFIX) ? "commands" : "files";
      if (openRef.current && currentMode === nextMode) close();
      else show(nextMode);
    }
    function handleOpenRequest(event: Event) {
      show((event as CustomEvent<PaletteMode>).detail === "commands" ? "commands" : "files");
    }
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest);
    };
  }, [close, show]);

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    if (mode === "files") {
      if (!query) {
        return recentFiles.map((file) => ({ kind: "file", key: file.path, file, nameIndices: [], pathIndices: [] }));
      }
      const recent = new Set(recentFiles.map((file) => file.path));
      return searchNotebookTree(tree, query, {
        fuzzy: true,
        limit: FILE_RESULT_LIMIT,
        boost: (file) => (file.notebook === selectedNotebookName ? 80 : 0) + (recent.has(file.path) ? 60 : 0),
      }).flatMap((hit) => hit.type === "file"
        ? [{ kind: "file" as const, key: hit.file.path, file: hit.file, nameIndices: hit.nameIndices, pathIndices: hit.pathIndices }]
        : []);
    }

    const recentRank = new Map(recentCommandIds.map((id, index) => [id, index]));
    if (!query) {
      const recent = commands.filter((command) => recentRank.has(command.id))
        .sort((left, right) => (recentRank.get(left.id) ?? 0) - (recentRank.get(right.id) ?? 0));
      const rest = commands.filter((command) => !recentRank.has(command.id));
      return [
        ...recent.map((command) => ({ kind: "command" as const, key: `recent:${command.id}`, command, indices: [], recent: true })),
        ...rest.map((command) => ({ kind: "command" as const, key: command.id, command, indices: [], recent: false })),
      ];
    }
    return commands
      .flatMap((command) => {
        const titleMatch = fuzzyMatch(command.title, query);
        const otherMatch = titleMatch ? null : fuzzyMatch(`${command.group ?? ""} ${command.title} ${command.detail ?? ""} ${command.keywords ?? ""}`, query);
        const match = titleMatch ?? (otherMatch ? { score: otherMatch.score / 2, indices: [] } : null);
        if (!match) return [];
        const score = match.score + (recentRank.has(command.id) ? 40 - (recentRank.get(command.id) ?? 0) * 5 : 0) - (command.disabled ? 10_000 : 0);
        return [{ score, row: { kind: "command" as const, key: command.id, command, indices: match.indices, recent: recentRank.has(command.id) } }];
      })
      .sort((left, right) => right.score - left.score)
      .map(({ row }) => row);
  }, [commands, mode, open, query, recentCommandIds, recentFiles, selectedNotebookName, tree]);

  const clampedIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${clampedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, rows]);

  function choose(row: Row | undefined, placement: "tab" | "right" = "tab") {
    if (!row) return;
    if (row.kind === "file") {
      close(false);
      onOpenFile(row.file, placement);
      return;
    }
    if (row.command.disabled) return;
    rememberCommand(row.command.id);
    close(false);
    // Give focus and the selection back first: toolbar actions apply to them.
    requestAnimationFrame(() => {
      restoreOrigin(originRef.current);
      row.command.run();
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // Keys typed here are for the palette, not the editor or viewer underneath.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((clampedIndex + step + rows.length) % rows.length);
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, Math.min(rows.length - 1, clampedIndex + (event.key === "PageDown" ? 8 : -8))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[clampedIndex], event.metaKey || event.ctrlKey ? "right" : "tab");
    }
  }

  if (!open) return null;

  const emptyMessage = mode === "files"
    ? query ? "No files match." : "No recent files yet. Type to search your notebooks."
    : commands.length ? "No commands match." : "Nothing here has tools. Focus an editor or viewer, then try again.";

  return createPortal(
    <div
      data-libera-overlay=""
      data-command-palette=""
      className="fixed inset-0 z-[80] flex justify-center bg-black/20 px-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Go to file" : "Command palette"}
        className="flex max-h-[min(32rem,76vh)] w-full max-w-xl flex-col self-start overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          {mode === "files"
            ? <Search aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            : <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="libera-command-palette-list"
            aria-activedescendant={rows.length ? `libera-command-palette-row-${clampedIndex}` : undefined}
            aria-label={mode === "files" ? "Search files by name" : "Search commands"}
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder={mode === "files" ? "Go to file… (type > for commands)" : "Run a command…"}
            value={value}
            onBlur={(event) => {
              if (!event.currentTarget.closest("[data-command-palette]")?.contains(event.relatedTarget as Node | null)) close(false);
            }}
            onChange={(event) => {
              setValue(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={listRef} id="libera-command-palette-list" role="listbox" aria-label={mode === "files" ? "Files" : "Commands"} className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.length ? rows.map((row, index) => {
            const active = index === clampedIndex;
            const sectionLabel = mode === "files"
              ? index === 0 && !query ? "Recently opened" : null
              : row.kind === "command" && !query && (index === 0 || (rows[index - 1].kind === "command" && (rows[index - 1] as Extract<Row, { kind: "command" }>).recent !== row.recent))
                ? row.recent ? "Recently used" : "All commands"
                : null;
            return (
              <div key={row.key}>
                {sectionLabel ? <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{sectionLabel}</div> : null}
                <div
                  id={`libera-command-palette-row-${index}`}
                  role="option"
                  aria-selected={active}
                  aria-disabled={row.kind === "command" && row.command.disabled ? true : undefined}
                  data-row-index={index}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ${active ? "bg-muted" : ""} ${row.kind === "command" && row.command.disabled ? "cursor-default opacity-45" : ""}`}
                  onMouseMove={() => {
                    if (!active) setActiveIndex(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => choose(row, event.metaKey || event.ctrlKey ? "right" : "tab")}
                >
                  {row.kind === "file" ? (
                    <>
                      <span aria-hidden className="libera-tab-file-icon shrink-0" data-type={row.file.fileType}>
                        <FileTypeIcon fileType={row.file.fileType} name={row.file.name} />
                      </span>
                      <span className="min-w-0 truncate">
                        <Highlighted text={row.file.name} indices={row.nameIndices} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {row.pathIndices.length
                          ? <Highlighted text={row.file.path} indices={row.pathIndices} />
                          : folderOf(row.file)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                        {row.command.icon ? <row.command.icon className="h-4 w-4" /> : row.command.iconElement ? <CopiedIcon element={row.command.iconElement} /> : null}
                      </span>
                      <span className="min-w-0 truncate">
                        <Highlighted text={row.command.title} indices={row.indices} />
                        {row.command.checked ? <span className="ml-1.5 text-xs text-accent">● on</span> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={row.command.detail}>{row.command.detail}</span>
                      {row.command.group ? <span className="shrink-0 text-[11px] text-muted-foreground">{row.command.group}</span> : null}
                      {row.command.shortcut ? <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{row.command.shortcut}</kbd> : null}
                    </>
                  )}
                  {active ? <CornerDownLeft aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                </div>
              </div>
            );
          }) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ to move</span>
          <span>Enter to {mode === "files" ? "open" : "run"}</span>
          {mode === "files" ? <span>Ctrl/⌘+Enter to open beside</span> : null}
          <span className="ml-auto">{mode === "files" ? "> for commands · Ctrl/⌘+Shift+P" : "Delete > for files · Ctrl/⌘+P"}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
