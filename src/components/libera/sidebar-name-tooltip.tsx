"use client";

import { useId, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";

type SidebarNameTooltipButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  fullName: string;
  /** Extra lines under the name, rendered when the tooltip opens so times stay fresh. */
  renderDetails?: () => ReactNode;
};

export function SidebarNameTooltipButton({
  children,
  fullName,
  onBlur,
  onDragStart,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  renderDetails,
  ...buttonProps
}: SidebarNameTooltipButtonProps) {
  const tooltipId = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  function showTooltip(target: HTMLButtonElement) {
    const bounds = target.getBoundingClientRect();

    setPosition({
      left: Math.max(8, Math.min(bounds.right + 8, window.innerWidth - 16)),
      top: Math.max(
        24,
        Math.min(bounds.top + bounds.height / 2, window.innerHeight - 24),
      ),
    });
  }

  return (
    <>
      <button
        {...buttonProps}
        aria-describedby={position ? tooltipId : undefined}
        onBlur={(event) => {
          setPosition(null);
          onBlur?.(event);
        }}
        onDragStart={(event) => {
          setPosition(null);
          onDragStart?.(event);
        }}
        onFocus={(event) => {
          showTooltip(event.currentTarget);
          onFocus?.(event);
        }}
        onMouseEnter={(event) => {
          showTooltip(event.currentTarget);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setPosition(null);
          onMouseLeave?.(event);
        }}
      >
        {children}
      </button>
      {position && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[110] -translate-y-1/2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-lg"
              id={tooltipId}
              role="tooltip"
              style={{
                left: position.left,
                maxWidth: `min(28rem, calc(100vw - ${position.left + 8}px))`,
                top: position.top,
              }}
            >
              <div className="break-all">{fullName}</div>
              {renderDetails?.()}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
