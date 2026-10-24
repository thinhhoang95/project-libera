"use client";

import { useId, useState } from "react";
import type { FocusEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/** Props the trigger element must spread so the tooltip shows on hover and on keyboard focus. */
export interface TooltipTriggerProps {
  "aria-describedby"?: string;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: (event: MouseEvent<HTMLElement>) => void;
}

type Placement = "below" | "above" | "right";

/**
 * A tooltip that, unlike `title`, also appears on keyboard focus and can hold
 * more than one line. Same look as SidebarNameTooltipButton; rendered in a
 * portal so overflow-hidden panels and the tab strip do not clip it.
 */
export function CollabTooltip({
  children,
  content,
  placement = "below",
}: {
  children: (props: TooltipTriggerProps) => ReactNode;
  content: ReactNode;
  placement?: Placement;
}) {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  function show(target: HTMLElement) {
    const bounds = target.getBoundingClientRect();
    const width = typeof window === "undefined" ? 1024 : window.innerWidth;
    const height = typeof window === "undefined" ? 768 : window.innerHeight;
    setPosition(
      placement === "right"
        ? { left: Math.min(bounds.right + 8, width - 16), top: Math.max(8, Math.min(bounds.top, height - 64)) }
        : placement === "above"
          ? { left: Math.max(8, Math.min(bounds.left, width - 296)), bottom: height - bounds.top + 6 }
          : { left: Math.max(8, Math.min(bounds.left, width - 296)), top: Math.min(bounds.bottom + 6, height - 64) },
    );
  }

  const hide = () => setPosition(null);

  return (
    <>
      {children({
        "aria-describedby": position ? id : undefined,
        onBlur: hide,
        onFocus: (event) => show(event.currentTarget),
        onMouseEnter: (event) => show(event.currentTarget),
        onMouseLeave: hide,
      })}
      {position && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[110] max-w-72 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs leading-relaxed text-foreground shadow-lg"
              id={id}
              role="tooltip"
              style={position}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
