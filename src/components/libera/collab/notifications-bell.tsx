"use client";

import { Bell, CheckCheck, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { NotificationInfo } from "@/lib/collab/local-api";
import { collabClient, describeError } from "@/lib/collab/ui/client";
import { useCollabProjects, useCollabStatus, useHostEvents } from "@/lib/collab/ui/hooks";
import { describeNotification, timeAgo } from "@/lib/collab/ui/wording";
import "./collab.css";

const PAGE = 50;

export interface NotificationGroup {
  projectId: string | null;
  title: string;
  items: NotificationInfo[];
}

/** Groups newest-first notifications by project, groups ordered by their newest item. */
export function groupNotifications(
  notifications: NotificationInfo[],
  projectName: (projectId: string) => string | undefined,
): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  const sorted = [...notifications].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const notification of sorted) {
    const key = notification.projectId ?? "";
    let group = groups.get(key);
    if (!group) {
      const payloadName = typeof notification.payload?.projectName === "string" ? notification.payload.projectName : undefined;
      group = {
        projectId: notification.projectId,
        title: (notification.projectId && projectName(notification.projectId)) || payloadName || "Other",
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(notification);
  }
  return [...groups.values()];
}

function fetchNotifications(): Promise<{ items: NotificationInfo[] } | { error: string }> {
  return collabClient.notifications({ limit: PAGE }).then(
    (items) => ({ items }),
    (caught: unknown) => ({ error: describeError(caught) }),
  );
}

export interface NotificationsBellProps {
  /** Opens the document a notification is about (mentions, replies, reviews). */
  onOpenDocument: (notification: NotificationInfo & { docId: string }) => void;
  /** Opens the join dialog for an "invited" notification. */
  onOpenInvitation?: (invitation: string) => void;
}

/** Bell in the left rail: unread count, a list grouped by project, mark read. Hidden when signed out. */
export function NotificationsBell({ onOpenDocument, onOpenInvitation }: NotificationsBellProps) {
  const { signedIn, enabled } = useCollabStatus();
  if (!enabled || !signedIn) return null;
  return <NotificationsBellInner onOpenDocument={onOpenDocument} onOpenInvitation={onOpenInvitation} />;
}

function NotificationsBellInner({ onOpenDocument, onOpenInvitation }: NotificationsBellProps) {
  const popoverId = useId();
  const { projectById } = useCollabProjects();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<NotificationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // Ages are computed against the time the list was opened, not re-read on every render.
  const [now, setNow] = useState(0);
  const open = anchor !== null;

  const applyResult = useCallback((result: { items: NotificationInfo[] } | { error: string }) => {
    if ("items" in result) {
      setItems(result.items);
      setError("");
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  const load = useCallback(() => fetchNotifications().then(applyResult), [applyResult]);

  useEffect(() => {
    let live = true;
    void fetchNotifications().then((result) => {
      if (live) applyResult(result);
    });
    return () => {
      live = false;
    };
  }, [applyResult]);

  useHostEvents("notification", (event) => {
    setItems((current) => [event.notification, ...current.filter((item) => item.id !== event.notification.id)].slice(0, PAGE));
  });

  const unread = items.filter((item) => !item.readAt).length;
  const groups = useMemo(() => groupNotifications(items, (projectId) => projectById(projectId)?.name), [items, projectById]);

  const close = useCallback((refocus: boolean) => {
    setAnchor(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    (popover?.querySelector<HTMLElement>("[data-notification-item]") ?? popover?.querySelector<HTMLElement>("[data-popover-focus]"))?.focus();
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    }
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open, close]);

  function toggle() {
    if (open) {
      close(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setNow(Date.now());
    setAnchor({ left: (rect?.right ?? 48) + 8, bottom: Math.max(8, window.innerHeight - (rect?.bottom ?? 0)) });
    void load();
  }

  async function markRead(ids: string[] | "all") {
    const readAt = new Date().toISOString();
    const previous = items;
    setItems((current) => current.map((item) => (ids === "all" || ids.includes(item.id) ? { ...item, readAt: item.readAt ?? readAt } : item)));
    try {
      await collabClient.markNotificationsRead(ids === "all" ? { all: true } : { ids });
    } catch (caught) {
      setItems(previous);
      setError(describeError(caught));
    }
  }

  function activate(notification: NotificationInfo) {
    if (!notification.readAt) void markRead([notification.id]);
    const invitation = typeof notification.payload?.url === "string" ? notification.payload.url : undefined;
    if (notification.kind === "invited" && invitation && onOpenInvitation) {
      close(false);
      onOpenInvitation(invitation);
    } else if (notification.docId) {
      close(false);
      onOpenDocument({ ...notification, docId: notification.docId });
    }
  }

  function onPopoverKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = [...(popoverRef.current?.querySelectorAll<HTMLElement>("[data-notification-item]") ?? [])];
    if (!list.length) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="libera-sidebar-icon-button relative inline-flex h-9 w-9 items-center justify-center rounded-lg"
        title="Notifications"
        type="button"
        onClick={toggle}
      >
        <Bell aria-hidden className="h-4 w-4" />
        {unread ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-semibold leading-none text-[var(--accent-foreground)]"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              aria-label="Notifications"
              className="libera-collab-popover fixed z-[60] flex max-h-[min(32rem,calc(100vh-16px))] w-80 flex-col overflow-hidden rounded-xl"
              id={popoverId}
              role="dialog"
              style={{ left: anchor.left, bottom: anchor.bottom }}
              onKeyDown={onPopoverKeyDown}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">Notifications</h2>
                <button
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  data-popover-focus
                  disabled={!unread}
                  type="button"
                  onClick={() => void markRead("all")}
                >
                  <CheckCheck aria-hidden className="h-3.5 w-3.5" /> Mark all read
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {error ? (
                  <p className="px-2 py-2 text-xs text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
                {loading && !items.length ? (
                  <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground" role="status">
                    <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </p>
                ) : !items.length ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">No notifications yet.</p>
                ) : (
                  groups.map((group) => (
                    <section key={group.projectId ?? "other"} aria-label={group.title} className="mb-1.5 last:mb-0">
                      <h3 className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</h3>
                      <ul>
                        {group.items.map((notification) => {
                          const actionable =
                            Boolean(notification.docId) || (notification.kind === "invited" && Boolean(onOpenInvitation) && typeof notification.payload?.url === "string");
                          return (
                            <li key={notification.id}>
                              <button
                                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                                data-notification-item
                                data-unread={!notification.readAt}
                                type="button"
                                onClick={() => (actionable ? activate(notification) : void markRead([notification.id]))}
                              >
                                <span
                                  aria-hidden
                                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${notification.readAt ? "bg-transparent" : "bg-[var(--accent)]"}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className={`line-clamp-3 ${notification.readAt ? "text-muted-foreground" : "font-medium text-foreground"}`}>
                                    {describeNotification(notification)}
                                  </span>
                                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                    {timeAgo(now - Date.parse(notification.createdAt))}
                                    {notification.readAt ? "" : " · unread"}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
