import { SESSION_EXPIRED_EVENT, type SessionStatus } from "@/lib/auth-session";
import { apiRequest } from "./api-client";

/** Watches idle sessions too; focus checks cover suspended laptop timers. */
export function monitorSessionExpiration(onExpired: () => void) {
  const controller = new AbortController();
  let expired = false;
  let checking = false;
  let expiresAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function expire() {
    if (controller.signal.aborted || expired) return;
    expired = true;
    clearTimeout(timer);
    onExpired();
  }

  function schedule() {
    clearTimeout(timer);
    if (controller.signal.aborted || expired) return;
    // Revalidate periodically for sign-out in another window or a lost cookie.
    timer = setTimeout(() => void check(), Math.min(60_000, Math.max(0, (expiresAt ?? Date.now() + 60_000) - Date.now())));
  }

  async function check() {
    if (controller.signal.aborted || expired) return;
    if (expiresAt !== null && expiresAt <= Date.now()) { expire(); return; }
    if (checking) { schedule(); return; }
    checking = true;
    // Keep the deadline armed even while a request is slow or disconnected.
    schedule();
    try {
      const session = await apiRequest<SessionStatus>("/api/auth/session", {
        cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted || expired) return;
      if (session.authenticated === false) { expire(); return; }
      if (typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt)) expiresAt = session.expiresAt;
      if (expiresAt !== null && expiresAt <= Date.now()) expire();
    } catch {
      // Network failures do not prove expiry. The known deadline still applies.
    } finally {
      checking = false;
      schedule();
    }
  }

  function onReturn() {
    if (document.visibilityState === "visible") void check();
  }
  window.addEventListener(SESSION_EXPIRED_EVENT, expire);
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
  void check();
  return () => {
    controller.abort();
    clearTimeout(timer);
    window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  };
}
