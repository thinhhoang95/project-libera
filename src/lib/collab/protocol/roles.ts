// Roles and the permission matrix (collaboration map §4).
// The server enforces these. Clients use the same functions to hide actions.

import type { Actor } from "./actor";

export type Role = "owner" | "editor" | "commenter" | "viewer";

export const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Sub-documents of a shared file, plus the project manifest. */
export type Subdoc = "content" | "annotations" | "meta" | "manifest";

export const SUBDOCS: readonly Subdoc[] = ["content", "annotations", "meta", "manifest"];

export function isSubdoc(value: unknown): value is Subdoc {
  return typeof value === "string" && (SUBDOCS as readonly string[]).includes(value);
}

/** Whether `role` may send CRDT updates for `subdoc`. */
export function canWriteSubdoc(role: Role, subdoc: Subdoc): boolean {
  switch (subdoc) {
    case "content":
    case "meta":
    case "manifest":
      return roleAtLeast(role, "editor");
    case "annotations":
      return roleAtLeast(role, "commenter");
  }
}

export type Action =
  | "read"
  | "comment"
  | "suggest"
  | "decide"
  | "restore"
  | "manage-files"
  | "request-review"
  | "name-revision"
  | "invite"
  | "change-roles"
  | "rename-project"
  | "delete-project"
  | "view-audit";

const MINIMUM: Record<Action, Role> = {
  read: "viewer",
  comment: "commenter",
  suggest: "commenter",
  decide: "editor",
  restore: "editor",
  "manage-files": "editor",
  "request-review": "editor",
  "name-revision": "editor",
  invite: "owner",
  "change-roles": "owner",
  "rename-project": "owner",
  "delete-project": "owner",
  "view-audit": "owner",
};

/** Actions an AI actor may never take, whatever the user's role (map §4). */
const HUMAN_ONLY: ReadonlySet<Action> = new Set([
  "decide",
  "restore",
  "invite",
  "change-roles",
  "rename-project",
  "delete-project",
  "request-review",
]);

export function can(role: Role, action: Action, actor?: Actor): boolean {
  if (actor?.kind === "ai" && HUMAN_ONLY.has(action)) return false;
  return roleAtLeast(role, MINIMUM[action]);
}
