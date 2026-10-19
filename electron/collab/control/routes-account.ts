// Control routes: status and the collaboration account.

import { ControlRoutes, type LocalAccount } from "../../../src/lib/collab/local-api";
import { normalizeServerUrl } from "./account";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { bad, objectBody, optionalString, requiredString } from "./validate";

function serverUrlFrom(value: unknown): string {
  try {
    return normalizeServerUrl(value);
  } catch (error) {
    throw bad(error instanceof Error ? error.message : "The server address is not valid.");
  }
}

/** Accepts an invitation token or a full invitation link (".../invitations/<token>" or "?token="). */
export function invitationToken(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("token") ?? url.searchParams.get("invitation");
    if (fromQuery) return fromQuery;
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (last) return decodeURIComponent(last);
  } catch {
    // Fall through to the error below.
  }
  throw bad("The invitation link is not valid.");
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export function registerAccountRoutes(router: Router, runtime: CollabRuntime): void {
  router.add("GET", ControlRoutes.status, () => ({ body: runtime.status() }));

  router.add("POST", ControlRoutes.signIn, async (request) => {
    const body = objectBody(request.body);
    const serverUrl = serverUrlFrom(body.serverUrl);
    const email = requiredString(body.email, "email", 320).trim();
    const password = requiredString(body.password, "password", 200);
    const auth = await runtime.accounts.login({ serverUrl, email, password });
    await runtime.signedIn(serverUrl, auth);
    return { body: runtime.status() };
  });

  router.add("POST", ControlRoutes.register, async (request) => {
    const body = objectBody(request.body);
    const serverUrl = serverUrlFrom(body.serverUrl);
    const email = requiredString(body.email, "email", 320).trim();
    const password = requiredString(body.password, "password", 200);
    const displayName = requiredString(body.displayName, "displayName", 100).trim();
    const invitation = optionalString(body.invitationToken, "invitationToken", 2000);
    const registrationCode = optionalString(body.registrationCode, "registrationCode", 200);
    const auth = await runtime.accounts.register({
      serverUrl,
      email,
      password,
      displayName,
      ...(invitation?.trim() ? { invitationToken: invitationToken(invitation) } : {}),
      ...(registrationCode?.trim() ? { registrationCode: registrationCode.trim() } : {}),
    });
    await runtime.signedIn(serverUrl, auth);
    return { status: 201, body: runtime.status() };
  });

  router.add("POST", ControlRoutes.signOut, async () => {
    await runtime.signOut();
    return { body: runtime.status() };
  });

  router.add("GET", ControlRoutes.account, () => ({ body: runtime.accounts.account }));

  router.add("PATCH", ControlRoutes.account, async (request): Promise<{ body: LocalAccount | null }> => {
    const body = objectBody(request.body);
    const displayName = optionalString(body.displayName, "displayName", 100)?.trim();
    const color = optionalString(body.color, "color", 7);
    if (displayName !== undefined && !displayName) throw bad("displayName cannot be empty.");
    if (color !== undefined && !COLOR.test(color)) throw bad("color must be a hex colour like #2563eb.");
    if (displayName === undefined && color === undefined) throw bad("Nothing to update.");
    const api = runtime.host.api;
    if (!api || !runtime.accounts.session) throw new ControlError(409, "needs-sign-in", "Sign in to the collaboration server first.");
    const account = await api.updateMe({ ...(displayName ? { displayName } : {}), ...(color ? { color } : {}) });
    await runtime.accounts.accountRefreshed(account);
    return { body: runtime.accounts.account };
  });
}
