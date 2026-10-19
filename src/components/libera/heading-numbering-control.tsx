"use client";

import { Check, ChevronDown, ListOrdered, ListX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MENU_WIDTH = 288;
const MENU_GAP = 6;
const itemClass = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The heading numbering toolbar control, the same in every Markdown editor: a
 * toggle that makes the document structurally numbered, and a chevron menu with
 * "Skip the first level-1 heading", one-off numbering and removing numbers.
 */
export function HeadingNumberingControl({
  buttonClassName,
  disabled = false,
  enabled,
  skipTitle,
  onEnumerateSelected,
  onNumberAll,
  onRemoveAll,
  onSkipTitleChange,
  onToggle,
}: {
  buttonClassName: string;
  disabled?: boolean;
  enabled: boolean;
  skipTitle: boolean;
  /** Numbers only the selected headings from a start value (when numbering is off). */
  onEnumerateSelected?: (startAt: number) => void;
  onNumberAll: () => void;
  onRemoveAll: () => void;
  onSkipTitleChange: (skipTitle: boolean) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [startAt, setStartAt] = useState("1");
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !chevronRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  function toggleMenu() {
    if (menu) { setMenu(null); return; }
    const rect = chevronRef.current?.getBoundingClientRect();
    if (!rect) return;
    setStartAt("1");
    setMenu({
      left: Math.max(MENU_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_GAP)),
      top: Math.min(rect.bottom + MENU_GAP, window.innerHeight - MENU_GAP),
    });
  }

  function run(action: () => void) {
    setMenu(null);
    action();
  }

  return <>
    <button
      type="button"
      aria-label="Heading Numbering"
      aria-pressed={enabled}
      title={enabled ? "Heading numbering is on: headings are numbered automatically" : "Number headings automatically"}
      className={buttonClassName}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onToggle(!enabled)}
    >
      <ListOrdered aria-hidden className="h-4 w-4" />
    </button>
    <button
      ref={chevronRef}
      type="button"
      aria-label="Heading numbering options"
      aria-haspopup="menu"
      aria-expanded={!!menu}
      title="Heading numbering options"
      className={buttonClassName}
      style={{ marginLeft: -4, paddingLeft: 0, paddingRight: 0, width: 16 }}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggleMenu}
    >
      <ChevronDown aria-hidden className="h-3 w-3" />
    </button>
    {menu ? createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label="Heading numbering"
        className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-1 shadow-lg"
        style={{ left: menu.left, top: menu.top }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={skipTitle}
          className={itemClass}
          onClick={() => onSkipTitleChange(!skipTitle)}
        >
          <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-sm border border-border">
            {skipTitle ? <Check className="h-3 w-3" /> : null}
          </span>
          Skip the first level-1 heading (title)
        </button>
        <div className="my-1 border-t border-border" />
        <button type="button" role="menuitem" className={itemClass} onClick={() => run(onNumberAll)}>
          <ListOrdered aria-hidden className="h-4 w-4 text-muted-foreground" />
          Enumerate All Headings
        </button>
        <button type="button" role="menuitem" className={itemClass} onClick={() => run(onRemoveAll)}>
          <ListX aria-hidden className="h-4 w-4 text-muted-foreground" />
          Remove All Heading Numbers
        </button>
        {onEnumerateSelected && !enabled ? (
          <form
            className="mt-1 border-t border-border px-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = Math.floor(Number(startAt));
              run(() => onEnumerateSelected(Number.isFinite(parsed) ? Math.max(1, parsed) : 1));
            }}
          >
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="heading-numbering-selected-start">
              Enumerate Selected Headings
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="heading-numbering-selected-start"
                aria-label="Selected heading start value"
                type="number"
                min="1"
                step="1"
                value={startAt}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-sm"
                onChange={(event) => setStartAt(event.target.value)}
              />
              <button type="submit" className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground">Apply</button>
            </div>
          </form>
        ) : null}
      </div>,
      document.body,
    ) : null}
  </>;
}
