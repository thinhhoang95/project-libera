"use client";

import { Check, Eraser } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LATEX_ENGINE_LABELS, type LatexEngine, type LatexEngineSetting } from "@/lib/latex/project";

export type LatexCompileTarget = "main" | "current";

const itemClass = "flex w-full items-start gap-2 rounded px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
const sectionLabelClass = "px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const MENU_WIDTH = 300;

/** Compile options behind the Recompile button: which file to typeset, the
 * engine, auto compile and the build cache. Rendered in a portal because the
 * toolbar scrolls horizontally and would clip it. */
export function LatexCompileMenu({
  anchorRef, target, mainName, currentName, currentDisabledReason, onSelect,
  autoCompile, onAutoCompileChange, engine, resolvedEngine, onEngineChange, clearCacheDisabled, onClearCache, onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  target: LatexCompileTarget;
  mainName: string;
  currentName: string;
  /** Why the current file cannot be typeset on its own, if it cannot. */
  currentDisabledReason: string | null;
  onSelect: (target: LatexCompileTarget) => void;
  autoCompile: boolean;
  onAutoCompileChange: (value: boolean) => void;
  engine: LatexEngineSetting;
  /** The engine "Auto" resolves to for this document. */
  resolvedEngine: LatexEngine;
  onEngineChange: (engine: LatexEngineSetting) => void;
  clearCacheDisabled: boolean;
  onClearCache: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)), top: rect.bottom + 4, maxHeight: window.innerHeight - rect.bottom - 12 });
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchorRef]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || anchorRef.current?.contains(event.target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); anchorRef.current?.focus(); }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  const options: { value: LatexCompileTarget; label: string; detail: string; disabled?: boolean }[] = [
    { value: "main", label: "Compile main file", detail: mainName },
    { value: "current", label: "Compile current file", detail: currentDisabledReason ?? currentName, disabled: !!currentDisabledReason },
  ];
  const engines: { value: LatexEngineSetting; label: string }[] = [
    { value: "auto", label: `Auto (${LATEX_ENGINE_LABELS[resolvedEngine]})` },
    { value: "pdflatex", label: "pdfLaTeX" },
    { value: "xelatex", label: "XeLaTeX" },
    { value: "lualatex", label: "LuaLaTeX" },
  ];

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Compile options"
      className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999, width: MENU_WIDTH, maxHeight: position?.maxHeight }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={target === option.value}
          className={itemClass}
          disabled={option.disabled}
          onClick={() => { onSelect(option.value); onClose(); }}
        >
          <Check aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${target === option.value ? "" : "invisible"}`} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{option.label}</span>
            <span className="block truncate text-xs text-muted-foreground" title={option.detail}>{option.detail}</span>
          </span>
        </button>
      ))}
      <div className="mt-1 border-t border-border pt-1">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={autoCompile}
          className={itemClass}
          title="Compile automatically when you pause typing"
          onClick={() => onAutoCompileChange(!autoCompile)}
        >
          <Check aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${autoCompile ? "" : "invisible"}`} />
          <span className="min-w-0 flex-1 font-medium">Auto compile</span>
        </button>
      </div>
      <div className="mt-1 border-t border-border pt-1" role="group" aria-label="TeX engine">
        <div className={sectionLabelClass} title="A “% !TEX program = …” line in the document takes precedence.">TeX engine</div>
        {engines.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={engine === option.value}
            className={itemClass}
            onClick={() => { onEngineChange(option.value); onClose(); }}
          >
            <Check aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${engine === option.value ? "" : "invisible"}`} />
            <span className="min-w-0 flex-1">{option.label}</span>
          </button>
        ))}
      </div>
      <div className="mt-1 border-t border-border pt-1">
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          disabled={clearCacheDisabled}
          title="Delete cached build files so the next compile starts clean"
          onClick={() => { onClose(); onClearCache(); }}
        >
          <Eraser aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">Clear cache…</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
