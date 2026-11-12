"use client";

import { X } from "lucide-react";
import { useContext, useEffect, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import "../../../electron/modal-dialog.css";
import { PortalDocumentContext } from "./detached-window";

/** Open dialogs, oldest first: Escape and Tab belong to the topmost (a dialog opened from another). */
const openDialogs: string[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableIn(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === container.ownerDocument.activeElement);
}

type ModalDialogProps = {
  children: ReactNode;
  footer?: ReactNode;
  sectioned?: boolean;
  open: boolean;
  panelClassName?: string;
  title: string;
  description?: string;
  onClose: () => void;
};

export function ModalDialog({
  children,
  description,
  footer,
  sectioned = false,
  open,
  panelClassName = "max-w-lg",
  title,
  onClose,
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  // A dialog opened from a panel in a detached window belongs in that window.
  const hostDocument = useContext(PortalDocumentContext) ?? (typeof document === "undefined" ? null : document);

  const onCloseRef = useRef(onClose);
  const sectionRef = useRef<HTMLElement>(null);
  // What had focus as the dialog opened, read while rendering: before a field takes focus with autoFocus.
  const opener = useMemo(() => {
    if (!open || !hostDocument) return null;
    const active = hostDocument.activeElement as HTMLElement | null;
    return active && typeof active.focus === "function" && active !== hostDocument.body ? active : null;
  }, [open, hostDocument]);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    openDialogs.push(titleId);
    // Focus moves into the dialog (unless a field took it with autoFocus) and returns where it was on close.
    const section = sectionRef.current;
    const previous = opener && !section?.contains(opener) ? opener : null;
    const doc = section?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    if (section && !section.contains(doc.activeElement)) {
      const body = section.querySelector<HTMLElement>(".libera-dialog-body");
      (focusableIn(body ?? section)[0] ?? section).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (openDialogs.at(-1) !== titleId) return;
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      // Tab stays inside the topmost dialog.
      if (event.key !== "Tab" || !sectionRef.current) return;
      const focusable = focusableIn(sectionRef.current);
      if (!focusable.length) { event.preventDefault(); sectionRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const active = doc.activeElement;
      if (!sectionRef.current.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }

    view.addEventListener("keydown", handleKeyDown);
    return () => {
      view.removeEventListener("keydown", handleKeyDown);
      openDialogs.splice(openDialogs.lastIndexOf(titleId), 1);
      // Without scrolling: a tall opener (an editor) would otherwise jump to its top or its caret.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, titleId, opener]);

  if (!open) {
    return null;
  }

  const dialog = (
    <div
      className="libera-dialog-overlay fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`libera-dialog w-full outline-none ${panelClassName}`}
        ref={sectionRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="libera-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="libera-dialog-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="libera-dialog-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            aria-label="Close dialog"
            className="libera-dialog-close"
            type="button"
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        <div className="libera-dialog-body">
          {sectioned ? children : <div className="libera-dialog-section">{children}</div>}
        </div>
        {footer ? (
          <footer className="libera-dialog-footer">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );

  return hostDocument ? createPortal(dialog, hostDocument.body) : null;
}
