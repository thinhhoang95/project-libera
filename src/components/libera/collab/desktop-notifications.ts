"use client";

// Desktop notifications (plan M2.3). A `notification` host event that arrives
// while the window is not focused also becomes an HTML5 Notification, which
// Electron shows as a native one; clicking it brings the window forward and
// opens the document. The bell keeps the full list either way. A per-device
// setting (the bell's "Desktop alerts" switch) turns them off.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { NotificationInfo } from "@/lib/collab/local-api";
import { useHostEvents } from "@/lib/collab/ui/hooks";
import { describeNotification } from "@/lib/collab/ui/wording";

export const DESKTOP_NOTIFICATIONS_KEY = "libera.collab.desktopNotifications";

const listeners = new Set<() => void>();

export function desktopNotificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, enabled ? "on" : "off");
  } catch {
    // Storage may be unavailable; the switch still applies for this session.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === DESKTOP_NOTIFICATIONS_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDesktopNotificationsSetting(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, desktopNotificationsEnabled, () => true);
  return [enabled, setDesktopNotificationsEnabled];
}

const TITLES: Partial<Record<NotificationInfo["kind"], string>> = {
  mention: "You were mentioned",
  reply: "New reply",
  "thread-resolved": "Comment resolved",
  "review-requested": "Review requested",
  "review-decided": "Review decided",
  invited: "Notebook invitation",
};

type NotificationConstructor = {
  new (title: string, options?: NotificationOptions): Notification;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
};

export interface DesktopNotificationEnvironment {
  Notification?: NotificationConstructor;
  hasFocus(): boolean;
  focusWindow(): void;
  enabled(): boolean;
}

function browserEnvironment(): DesktopNotificationEnvironment {
  return {
    Notification: typeof window !== "undefined" && "Notification" in window ? (window.Notification as unknown as NotificationConstructor) : undefined,
    hasFocus: () => typeof document !== "undefined" && document.hasFocus(),
    focusWindow: () => window.focus(),
    enabled: desktopNotificationsEnabled,
  };
}

/**
 * Shows `notification` on the desktop unless the window is focused, the
 * user turned alerts off or the system refused permission. Resolves to the
 * Notification shown, or null.
 */
export async function showDesktopNotification(
  notification: NotificationInfo,
  onOpen: (notification: NotificationInfo & { docId: string }) => void,
  environment: DesktopNotificationEnvironment = browserEnvironment(),
): Promise<Notification | null> {
  const Ctor = environment.Notification;
  if (!Ctor || !environment.enabled() || environment.hasFocus()) return null;
  let permission = Ctor.permission;
  if (permission === "default") {
    try {
      permission = await Ctor.requestPermission();
    } catch {
      return null;
    }
  }
  if (permission !== "granted") return null;
  const shown = new Ctor(TITLES[notification.kind] ?? "Libera", { body: describeNotification(notification), tag: notification.id });
  shown.onclick = () => {
    environment.focusWindow();
    if (notification.docId) onOpen({ ...notification, docId: notification.docId });
    shown.close();
  };
  return shown;
}

/** Mounted once per window (CollabProvider). */
export function useDesktopNotifications(onOpen: (notification: NotificationInfo & { docId: string }) => void): void {
  const open = useRef(onOpen);
  useEffect(() => { open.current = onOpen; });
  useHostEvents("notification", (event) => {
    void showDesktopNotification(event.notification, (target) => open.current(target)).catch(() => undefined);
  });
}
