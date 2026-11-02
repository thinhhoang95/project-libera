// Shared by the server's auth guard and the browser; contains no signing secrets.
export const SESSION_EXPIRED_HEADER = "X-Libera-Session-Expired";
export const SESSION_EXPIRED_EVENT = "libera:session-expired";

export type SessionStatus = {
  authenticated: boolean;
  expiresAt: number | null;
};
