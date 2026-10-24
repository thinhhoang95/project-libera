"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { initials, readableTextColor } from "@/lib/collab/ui/wording";
import { CollabTooltip } from "./collab-tooltip";
import "./collab.css";

/** One remote collaborator, as the awareness state describes them. */
export interface PresenceUser {
  /** Awareness client id; unique per editor instance, so one person on two devices appears twice. */
  clientId: number | string;
  name: string;
  /** Hex colour from the account, the same one used for the cursor. */
  color: string;
  /** Where they are, e.g. the heading above their cursor. */
  section?: string;
}

export interface PresenceAvatarsProps {
  users: PresenceUser[];
  /** Avatars shown before the "+N" overflow button. Defaults to 4. */
  max?: number;
  /** Highlights the avatar of the user being followed. */
  followingClientId?: PresenceUser["clientId"] | null;
  /** Called when an avatar (or an overflow row) is activated; the caller scrolls to that cursor. */
  onFollow?: (clientId: PresenceUser["clientId"]) => void;
  /** Quiet mode hides remote cursors and selections. Omit both to hide the toggle. */
  quiet?: boolean;
  onQuietChange?: (quiet: boolean) => void;
  /** "above" when the avatars sit at the bottom of the window, in the status bar. */
  popoverPlacement?: "below" | "above";
  className?: string;
}

function Avatar({ user, size = "h-6 w-6" }: { user: PresenceUser; size?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex ${size} shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold`}
      style={{ backgroundColor: user.color, color: readableTextColor(user.color) }}
    >
      {initials(user.name)}
    </span>
  );
}

function describe(user: PresenceUser) {
  return user.section ? `${user.name} — ${user.section}` : user.name;
}

/**
 * Overlapping avatars of the people in the open document. Each avatar is a
 * button that follows that person; the "+N" button lists the rest.
 */
export function PresenceAvatars({
  users,
  max = 4,
  followingClientId = null,
  onFollow,
  quiet,
  onQuietChange,
  popoverPlacement = "below",
  className = "",
}: PresenceAvatarsProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPosition, setOverflowPosition] = useState<{ right: number; bottom: number } | null>(null);
  const overflowId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleCount = users.length > max ? Math.max(0, max - 1) : users.length;
  const visible = users.slice(0, visibleCount);
  const hidden = users.slice(visibleCount);

  useEffect(() => {
    if (!overflowOpen) return;
    function close(event: Event) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          setOverflowOpen(false);
          containerRef.current?.querySelector<HTMLButtonElement>("[data-overflow-trigger]")?.focus();
        }
        return;
      }
      if (!containerRef.current?.contains(event.target as Node)) setOverflowOpen(false);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [overflowOpen]);

  if (!users.length && quiet === undefined) {
    return null;
  }

  return (
    <div ref={containerRef} className={`relative inline-flex items-center gap-1.5 ${className}`} role="group" aria-label="People in this document">
      {users.length ? (
        <div className="flex items-center pl-1.5">
          {visible.map((user) => {
            const following = followingClientId === user.clientId;
            return (
              <CollabTooltip key={user.clientId} placement={popoverPlacement} content={<span><span className="font-semibold">{user.name}</span>{user.section ? <span className="block text-muted-foreground">{user.section}</span> : null}{onFollow ? <span className="block text-muted-foreground">{following ? "Following" : "Click to follow"}</span> : null}</span>}>
                {(tooltip) => (
                  <button
                    {...tooltip}
                    aria-label={onFollow ? `${following ? "Following" : "Follow"} ${describe(user)}` : describe(user)}
                    aria-pressed={onFollow ? following : undefined}
                    className="libera-collab-avatar -ml-1.5 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                    data-following={following}
                    disabled={!onFollow}
                    type="button"
                    onClick={() => onFollow?.(user.clientId)}
                  >
                    <Avatar user={user} />
                  </button>
                )}
              </CollabTooltip>
            );
          })}
          {hidden.length ? (
            <button
              aria-controls={overflowId}
              aria-expanded={overflowOpen}
              aria-haspopup="true"
              aria-label={`${hidden.length} more ${hidden.length === 1 ? "person" : "people"}`}
              className="libera-collab-avatar -ml-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              data-overflow-trigger
              title={hidden.map(describe).join("\n")}
              type="button"
              onClick={() => {
                // Above the avatars, the list is fixed so a scrolling status bar does not clip it.
                const bounds = popoverPlacement === "above" ? containerRef.current?.getBoundingClientRect() : undefined;
                setOverflowPosition(bounds ? { right: window.innerWidth - bounds.right, bottom: window.innerHeight - bounds.top + 4 } : null);
                setOverflowOpen((open) => !open);
              }}
            >
              +{hidden.length}
            </button>
          ) : null}
        </div>
      ) : null}
      {overflowOpen && hidden.length ? (
        <ul
          aria-label="More people"
          className={`libera-collab-popover z-50 max-h-64 w-56 overflow-auto rounded-lg p-1 ${overflowPosition ? "fixed" : "absolute right-0 top-full mt-1"}`}
          id={overflowId}
          style={overflowPosition ?? undefined}
        >
          {hidden.map((user) => (
            <li key={user.clientId}>
              <button
                aria-pressed={onFollow ? followingClientId === user.clientId : undefined}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-default"
                disabled={!onFollow}
                type="button"
                onClick={() => {
                  onFollow?.(user.clientId);
                  setOverflowOpen(false);
                }}
              >
                <Avatar user={user} size="h-5 w-5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{user.name}</span>
                  {user.section ? <span className="block truncate text-muted-foreground">{user.section}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {onQuietChange && quiet !== undefined ? (
        <button
          aria-label="Quiet mode (hide other people's cursors)"
          aria-pressed={quiet}
          className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded-md"
          title={quiet ? "Quiet mode is on: other cursors are hidden" : "Quiet mode: hide other cursors"}
          type="button"
          onClick={() => onQuietChange(!quiet)}
        >
          {quiet ? <EyeOff aria-hidden className="h-3.5 w-3.5" /> : <Eye aria-hidden className="h-3.5 w-3.5" />}
        </button>
      ) : null}
    </div>
  );
}
