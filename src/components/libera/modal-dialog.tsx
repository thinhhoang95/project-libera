import { X } from "lucide-react";
import { useEffect, useId } from "react";
import type { ReactNode } from "react";

type ModalDialogProps = {
  children: ReactNode;
  footer?: ReactNode;
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
};

export function ModalDialog({
  children,
  description,
  footer,
  open,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6"
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
        className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-xl"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm leading-6 text-zinc-500" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950"
            type="button"
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
