"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** A dropdown below a toolbar button, in a portal because the toolbar scrolls
 * horizontally and would clip it. Arrow keys move between its items. */
export function ToolbarMenu({ anchorRef, label, width = 260, onClose, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 4, maxHeight: window.innerHeight - rect.bottom - 12 });
    (menuRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? menuRef.current?.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)"))?.focus();
  }, [anchorRef, width]);

  useEffect(() => {
    const outside = (event: Event) => event.target instanceof Node && !menuRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target);
    const close = (event: Event) => { if (outside(event)) onClose(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); anchorRef.current?.focus(); }
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

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999, width, maxHeight: position?.maxHeight }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
