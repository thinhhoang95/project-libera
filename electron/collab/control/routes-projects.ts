// Control routes: projects, members, invitations. Thin proxies to the
// collab server's REST API for the signed-in account; the server enforces
// every permission (only the owner may invite or change roles).

import { ControlRoutes, type InviteRequest, type LocalProject } from "../../../src/lib/collab/local-api";
import type { ListedProject, ProjectListing } from "../../../src/lib/collab/host-client";
import type { ApiClient } from "../core/api-client";
import { ApiClientError } from "../core/api-client";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { objectBody, requiredString, roleValue } from "./validate";

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
  router.add("GET", ControlRoutes.projects, async (): Promise<{ body: ProjectListing }> => {
    const local = localProjects(runtime);
    const byId = new Map(local.map((project) => [project.projectId, project]));
    const fromLocal = (project: LocalProject): ListedProject => ({
      projectId: project.projectId,
      name: project.name,
      role: project.role,
      ownerId: null,
      manifestDocId: null,
      createdAt: null,
      local: project,
    });
    const api = runtime.host.api;
    if (!api || !runtime.accounts.session) {
      return { body: { source: "local", projects: local.map(fromLocal), detail: "Not signed in to the collaboration server." } };
    }
    try {
      const remote = await api.listProjects();
      const projects: ListedProject[] = remote.map((project) => ({
        projectId: project.id,
        name: project.name,
        role: project.role,
        ownerId: project.ownerId,
        manifestDocId: project.manifestDocId,
        createdAt: project.createdAt,
        local: byId.get(project.id) ?? null,
      }));
      // Joined here but no longer listed by the server: access was revoked.
      const listed = new Set(remote.map((project) => project.id));
      for (const project of local) {
        if (!listed.has(project.projectId)) projects.push({ ...fromLocal(project), local: { ...project, revoked: true } });
      }
      return { body: { source: "server", projects } };
    } catch (error) {
      if (error instanceof ApiClientError && (error.transient || error.code === "needs-sign-in")) {
        return { body: { source: "local", projects: local.map(fromLocal), detail: error.message } };
      }
      throw error;
    }
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
