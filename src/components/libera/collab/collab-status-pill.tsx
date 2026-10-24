"use client";

import {
  CloudCheck,
  CloudOff,
  HardDrive,
  LoaderCircle,
  Lock,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { SyncState, SyncStatus } from "@/lib/collab/protocol/local";
import { formatAge, syncWording } from "@/lib/collab/ui/wording";
import { CollabTooltip } from "./collab-tooltip";
import "./collab.css";

const ICONS: Record<SyncState, LucideIcon> = {
  loading: LoaderCircle,
  "saved-local": HardDrive,
  syncing: RefreshCw,
  "saved-remote": CloudCheck,
  offline: CloudOff,
  "read-only": Lock,
  "access-changed": ShieldAlert,
  deleted: Lock,
};

const SPINNING: ReadonlySet<SyncState> = new Set(["loading", "syncing"]);

export interface CollabStatusPillProps {
  /** The document's status, as the DocHub sends it in `{ t: "status" }` (protocol/local.ts). */
  status: SyncStatus;
  /**
   * Icon only, for narrow tabs. The label stays available to screen readers
   * and in the tooltip. Defaults to false.
   */
  compact?: boolean;
  /**
   * Makes the pill a button, e.g. to open the collaboration panel or, on
   * access-changed, the export banner. Without it the pill is a focusable
   * status with a tooltip.
   */
  onClick?: () => void;
  className?: string;
  /** "above" when the pill sits at the bottom of the window. Defaults to "below". */
  tooltipPlacement?: "below" | "above";
  /** Clock for the "last confirmed" age; tests pass a fixed value. */
  now?: number;
}

/**
 * Durability state of one shared document (collaboration map §6), in place
 * of the unsaved-changes dot. Shows an icon and a short label; the tooltip
 * adds the detail, the pending count and the oldest pending age.
 */
export function CollabStatusPill({ status, compact = false, onClick, className = "", tooltipPlacement = "below", now }: CollabStatusPillProps) {
  const wording = syncWording(status, now);
  const Icon = ICONS[status.state];
  const pendingLine =
    status.pending > 0
      ? `${status.pending} pending · oldest ${formatAge(status.oldestPendingAgeMs)}`
      : status.state === "saved-remote"
        ? "Nothing pending"
        : null;
  const classes = `libera-collab-tone inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full text-[11px] font-medium leading-none ${
    compact ? "w-6 justify-center" : "px-2"
  } ${onClick ? "cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]" : "focus-visible:outline-2 focus-visible:outline-[var(--ring)]"} ${className}`;
  const content = (
    <>
      <Icon aria-hidden className={`h-3.5 w-3.5 shrink-0 ${SPINNING.has(status.state) ? "libera-collab-spin animate-spin" : ""}`} />
      {compact ? null : <span className="truncate">{wording.label}</span>}
    </>
  );

  return (
    <CollabTooltip
      placement={tooltipPlacement}
      content={
        <span className="block">
          <span className="block font-semibold">{wording.label}</span>
          <span className="block text-muted-foreground">{wording.detail}</span>
          {pendingLine ? <span className="mt-0.5 block text-muted-foreground">{pendingLine}</span> : null}
        </span>
      }
    >
      {(tooltip) =>
        onClick ? (
          <button
            {...tooltip}
            aria-label={`${wording.label}. ${wording.detail}`}
            className={classes}
            data-state={status.state}
            data-tone={wording.tone}
            type="button"
            onClick={onClick}
          >
            {content}
          </button>
        ) : (
          <span
            {...tooltip}
            aria-label={`${wording.label}. ${wording.detail}`}
            className={classes}
            data-state={status.state}
            data-tone={wording.tone}
            role="img"
            tabIndex={0}
          >
            {content}
          </span>
        )
      }
    </CollabTooltip>
  );
}
