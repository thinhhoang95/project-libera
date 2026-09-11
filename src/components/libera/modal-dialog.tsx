"use client";

import { PanelsTopLeft, X } from "lucide-react";
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import "../../../electron/modal-dialog.css";

type ModalDialogProps = {
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
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
  icon = <PanelsTopLeft aria-hidden />,
  sectioned = false,
  open,
  panelClassName = "max-w-lg",
  title,
  onClose,
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

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
        className={`libera-dialog w-full ${panelClassName}`}
        role="dialog"
      >
        <header className="libera-dialog-header">
          <span className="libera-dialog-icon" aria-hidden="true">{icon}</span>
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
            <X aria-hidden className="h-5 w-5" />
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

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : null;
}
