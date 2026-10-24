import type { InviteRequest } from "@/lib/collab/local-api";
import type { ShareOptions } from "@/lib/storage/gallery";
import { StorageError } from "@/lib/storage/errors";
import { text } from "./route-helpers";

const ROLES = new Set(["editor", "commenter", "viewer"]);
const MAX_INVITATIONS = 50;

/** Share options from a request body: name, privacy switches and invitations. */
export function shareOptions(body: Record<string, unknown>): ShareOptions {
  const invitations: InviteRequest[] = [];
  for (const item of Array.isArray(body.invitations) ? body.invitations.slice(0, MAX_INVITATIONS) : []) {
    const email = text((item as { email?: unknown })?.email).trim();
    const role = text((item as { role?: unknown })?.role) || "viewer";
    if (!email) continue;
    if (email.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new StorageError(`${email} is not an email address.`);
    if (!ROLES.has(role)) throw new StorageError("Members can be contributors, commenters or viewers.");
    invitations.push({ email, role: role as InviteRequest["role"] });
  }
  return {
    name: text(body.name).trim().slice(0, 200) || undefined,
    keepLocation: body.keepLocation === true,
    sharePrompts: body.sharePrompts === true,
    invitations,
  };
}
