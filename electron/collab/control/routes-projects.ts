// Control routes: projects, members, invitations, notifications. Thin proxies to the
// collab server's REST API for the signed-in account; the server enforces
// every permission (only the owner may invite or change roles).

import {
  ControlRoutes,
  type InviteRequest,
  type LocalProject,
  type MarkNotificationsReadRequest,
  type NotificationsQuery,
} from "../../../src/lib/collab/local-api";
import type { ApiClient } from "../core/api-client";
import { ApiClientError } from "../core/api-client";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { bad, objectBody, requiredString, roleValue, stringList } from "./validate";

/** ControlRoutes builders with ":name" placeholders (encoded by the builder, hence the decode) become router patterns. */
const pattern = {
  members: decodeURIComponent(ControlRoutes.members(":projectId")),
  member: decodeURIComponent(ControlRoutes.member(":projectId", ":userId")),
  invitations: decodeURIComponent(ControlRoutes.invitations(":projectId")),
  invitation: decodeURIComponent(ControlRoutes.invitation(":projectId", ":invitationId")),
  leave: decodeURIComponent(ControlRoutes.leave(":projectId")),
};

export function requireApi(runtime: CollabRuntime): ApiClient {
  const api = runtime.host.api;
  if (!runtime.accounts.account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
  if (!api || !runtime.accounts.session) throw new ControlError(409, "needs-sign-in", "Sign in to the collaboration server again.");
  return api;
}

function localProjects(runtime: CollabRuntime): LocalProject[] {
  return runtime.status().projects;
}

export function registerProjectRoutes(router: Router, runtime: CollabRuntime): void {
  // The projects joined on this machine (the UI keys them by notebook
  // folder). When the server can be asked, names and roles are refreshed
  // from it and a project it no longer lists is marked revoked.
  router.add("GET", ControlRoutes.projects, async (): Promise<{ body: LocalProject[] }> => {
    const local = localProjects(runtime);
    const api = runtime.host.api;
    if (!api || !runtime.accounts.session || local.length === 0) return { body: local };
    let remote;
    try {
      remote = await api.listProjects();
    } catch (error) {
      if (error instanceof ApiClientError && (error.transient || error.code === "needs-sign-in")) return { body: local };
      throw error;
    }
    const byId = new Map(remote.map((project) => [project.id, project]));
    return {
      body: local.map((project) => {
        const current = byId.get(project.projectId);
        return current ? { ...project, name: current.name, role: current.role } : { ...project, revoked: true };
      }),
    };
  });

  // Notifications for the signed-in account, newest first.
  router.add("GET", ControlRoutes.notifications, async (request) => {
    const unread = request.query.get("unread");
    const limitText = request.query.get("limit");
    const limit = limitText === null ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw bad("limit must be an integer from 1 to 500.");
    const before = request.query.get("before") ?? undefined;
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw bad("before must be an ISO time.");
    const query: NotificationsQuery = {
      ...(unread === null ? {} : { unread: unread === "true" || unread === "1" }),
      ...(before ? { before } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
    return { body: await requireApi(runtime).listNotifications(query) };
  });

  router.add("POST", ControlRoutes.notificationsRead, async (request) => {
    const body = objectBody(request.body);
    const ids = stringList(body.ids, "ids", 1000);
    if (body.all !== undefined && typeof body.all !== "boolean") throw bad("all must be a boolean.");
    if (!ids?.length && body.all !== true) throw bad("Send ids or all: true.");
    const read: MarkNotificationsReadRequest = { ...(ids?.length ? { ids } : {}), ...(body.all === true ? { all: true } : {}) };
    await requireApi(runtime).markNotificationsRead(read);
    return {};
  });

  router.add("GET", pattern.members, async (request) => ({ body: await requireApi(runtime).listMembers(request.params.projectId) }));

  router.add("PATCH", pattern.member, async (request) => {
    const body = objectBody(request.body);
    const role = roleValue(body.role, false);
    const member = await requireApi(runtime).changeRole(request.params.projectId, request.params.userId, { role });
    runtime.emit({ t: "project-changed", projectId: request.params.projectId });
    return { body: member };
  });

  router.add("DELETE", pattern.member, async (request) => {
    await requireApi(runtime).removeMember(request.params.projectId, request.params.userId);
    runtime.emit({ t: "project-changed", projectId: request.params.projectId });
    return {};
  });

  router.add("GET", pattern.invitations, async (request) => ({
    body: await requireApi(runtime).listInvitations(request.params.projectId),
  }));

  router.add("POST", pattern.invitations, async (request) => {
    const body = objectBody(request.body);
    const invite: InviteRequest = {
      email: requiredString(body.email, "email", 320).trim(),
      role: roleValue(body.role, false) as InviteRequest["role"],
    };
    const invitation = await requireApi(runtime).createInvitation(request.params.projectId, invite);
    return { status: 201, body: invitation };
  });

  router.add("DELETE", pattern.invitation, async (request) => {
    await requireApi(runtime).revokeInvitation(request.params.invitationId);
    return {};
  });

  router.add("POST", pattern.leave, async (request) => {
    const api = requireApi(runtime);
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    await api.removeMember(request.params.projectId, account.id);
    // The server closes the project's documents with 4003; the notebook
    // service marks the folder as no longer shared. Nothing is deleted here.
    runtime.emit({ t: "project-changed", projectId: request.params.projectId });
    runtime.statusChanged();
    return {};
  });
}
