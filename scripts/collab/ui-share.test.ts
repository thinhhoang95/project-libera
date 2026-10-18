import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ACCOUNT,
  button,
  cleanup,
  click,
  dom,
  flush,
  hostStatus,
  installFakeBridge,
  installFakeFetch,
  project,
  removeBridge,
  render,
  selectValue,
  submit,
  typeInto,
} from "./ui-support";
import type { Invitation, LocalProject, Member } from "../../src/lib/collab/local-api";
import type { Role } from "../../src/lib/collab/protocol/roles";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";

afterEach(async () => {
  await cleanup();
  setCollabStatusStore(null);
  removeBridge();
});

function member(id: string, displayName: string, role: Role): Member {
  return { id, displayName, email: `${id}@example.com`, color: "#16a34a", role, joinedAt: "2026-10-01T00:00:00.000Z" };
}

function invitation(id: string, email: string, role: Role, extra: Partial<Invitation> = {}): Invitation {
  return {
    id,
    projectId: "p1",
    email,
    role,
    invitedBy: ACCOUNT.id,
    createdAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-24T00:00:00.000Z",
    acceptedAt: null,
    ...extra,
  };
}

/** A small in-memory project the fake routes manipulate. */
function fakeProjectServer(myRole: Role, startShared: boolean) {
  const state = {
    projects: startShared ? [project({ role: myRole })] : ([] as LocalProject[]),
    members: [member(ACCOUNT.id, ACCOUNT.displayName, myRole), member("u-ed", "Eddie Editor", "editor"), member("u-view", "Vera Viewer", "viewer")],
    invitations: [invitation("i-old", "old@example.com", "commenter", { url: "https://collab.test/invite/old" })],
  };
  if (myRole !== "owner") state.members.unshift(member("u-boss", "Bea Owner", "owner"));
  const fetch = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects: state.projects }) }),
    "GET /projects": () => ({ body: state.projects }),
    "GET /projects/p1/members": () => ({ body: state.members }),
    "GET /projects/p1/invitations": () =>
      myRole === "owner" ? { body: state.invitations } : { status: 403, body: { error: { code: "forbidden", message: "owners only" } } },
    "POST /projects/p1/invitations": (call) => {
      const body = call.body as { email: string; role: Role };
      const created = invitation("i-new", body.email, body.role, { token: "tok-new", url: "https://collab.test/invite/tok-new" });
      state.invitations = [created, ...state.invitations];
      return { status: 201, body: created };
    },
    "DELETE /projects/p1/invitations/i-old": () => {
      state.invitations = state.invitations.filter((item) => item.id !== "i-old");
      return undefined;
    },
    "PATCH /projects/p1/members/u-ed": (call) => {
      state.members = state.members.map((item) => (item.id === "u-ed" ? { ...item, role: (call.body as { role: Role }).role } : item));
      return { body: state.members.find((item) => item.id === "u-ed") };
    },
    "DELETE /projects/p1/members/u-view": () => {
      state.members = state.members.filter((item) => item.id !== "u-view");
      return undefined;
    },
    "POST /projects/p1/leave": () => {
      state.projects = [];
      return undefined;
    },
  });
  return { state, ...fetch };
}

async function openDialog(notebook = "Thesis") {
  const { createElement } = await import("react");
  const { ShareNotebookDialog } = await import("../../src/components/libera/collab/share-notebook-dialog");
  let closed = 0;
  const view = await render(createElement(ShareNotebookDialog, { notebook, onClose: () => (closed += 1) }));
  return { view, closed: () => closed };
}

test("sharing shows live progress, then switches to member management", async () => {
  const bridge = installFakeBridge();
  const server = fakeProjectServer("owner", false);
  let finishShare: () => void = () => {};
  server.state.projects = [];
  const routes = server.calls;
  // Hold the share request open so progress events arrive while it runs.
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      if (input.endsWith("/projects/share")) {
        routes.push({ method: "POST", path: "/projects/share", query: new URLSearchParams(), body: JSON.parse(String(init?.body)) });
        await new Promise<void>((resolve) => (finishShare = resolve));
        server.state.projects = [project({ name: "Our thesis" })];
        return new Response(JSON.stringify(server.state.projects[0]), { status: 200 });
      }
      return originalFetch(input, init);
    },
  });
  const { view } = await openDialog();
  const dialog = () => document.querySelector('[role="dialog"]')!;
  assert.match(dialog().textContent!, /Share notebook/);
  const name = dialog().querySelector<HTMLInputElement>("input")!;
  assert.equal(name.value, "Thesis", "defaults to the notebook name");
  await typeInto(name, "Our thesis");
  const form = dialog().querySelector("form")!;
  const { act } = await import("react");
  // The share request stays pending, so the submit's act scope must end
  // before it resolves: act only waits for the synchronous dispatch here.
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
  assert.deepEqual(routes.find((call) => call.path === "/projects/share")?.body, { notebook: "Thesis", name: "Our thesis" });
  assert.ok(button("Sharing…"), "the button shows the request is running");

  await act(async () => {
    bridge.emit({ t: "share-progress", notebook: "Other", progress: { phase: "uploading-files", done: 9, total: 9 } });
    bridge.emit({ t: "share-progress", notebook: "Thesis", progress: { phase: "importing-documents", done: 3, total: 12 } });
  });
  const bar = dialog().querySelector('[role="progressbar"]')!;
  assert.equal(bar.getAttribute("aria-valuenow"), "25");
  assert.match(dialog().textContent!, /Importing documents \(3 of 12\)/);
  await act(async () => bridge.emit({ t: "share-progress", notebook: "Thesis", progress: { phase: "uploading-files", done: 6, total: 8 } }));
  assert.equal(dialog().querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"), "75");

  await act(async () => finishShare());
  await flush(5);
  assert.match(dialog().querySelector("h2")!.textContent!, /Share “Our thesis”/);
  assert.ok(dialog().querySelector('form[aria-label="Invite people"]'), "owners can invite");
  assert.match(dialog().textContent!, /People with access/);
  assert.match(dialog().textContent!, /Eddie Editor/);
  await view.unmount();
});

test("owner invites with a role, copies the link and revokes a pending invitation", async () => {
  installFakeBridge();
  const server = fakeProjectServer("owner", true);
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  const { view } = await openDialog();
  const dialog = () => document.querySelector('[role="dialog"]')!;

  const roles = [...dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  assert.deepEqual(roles.map((radio) => radio.value), ["editor", "commenter", "viewer"]);
  const labels = roles.map((radio) => radio.closest("label")!.textContent);
  assert.match(labels[0]!, /Editor.*Edits text and files/);
  assert.match(labels[1]!, /Commenter.*cannot edit directly/);
  assert.match(labels[2]!, /Viewer.*Reads documents/);

  const form = dialog().querySelector('form[aria-label="Invite people"]')!;
  await submit(form);
  assert.match(form.textContent!, /Enter an email address/);
  await typeInto(form.querySelector('input[type="email"]'), "new@example.com");
  await click(roles[1]);
  await submit(form);
  assert.deepEqual(server.calls.find((call) => call.method === "POST" && call.path === "/projects/p1/invitations")?.body, {
    email: "new@example.com",
    role: "commenter",
  });
  const link = dialog().querySelector<HTMLInputElement>('input[aria-label="Invitation link"]');
  assert.equal(link?.value, "https://collab.test/invite/tok-new");
  await click(button(/^\s*Copy link$/, form));
  assert.deepEqual(copied, ["https://collab.test/invite/tok-new"]);

  const pending = dialog().querySelector('[aria-labelledby="collab-pending-invitations"]')!;
  assert.match(pending.textContent!, /new@example\.com/);
  assert.match(pending.textContent!, /old@example\.com.*Commenter/);
  await click(button("Copy invitation link for old@example.com", pending));
  assert.equal(copied.at(-1), "https://collab.test/invite/old");
  await click(button("Revoke invitation for old@example.com", pending));
  await click(button(/^Revoke$/, pending));
  assert.ok(server.calls.some((call) => call.method === "DELETE" && call.path === "/projects/p1/invitations/i-old"));
  assert.doesNotMatch(dialog().textContent!, /old@example\.com/);
  await view.unmount();
});

test("owner changes roles and removes members; owners and self are not editable", async () => {
  installFakeBridge();
  const server = fakeProjectServer("owner", true);
  const { view } = await openDialog();
  const members = () => document.querySelector('[aria-labelledby="collab-members"]')!;
  const selects = [...members().querySelectorAll("select")];
  assert.deepEqual(selects.map((select) => select.getAttribute("aria-label")), ["Role for Eddie Editor", "Role for Vera Viewer"]);
  assert.match(members().textContent!, /Olive Owner \(you\)/);
  assert.ok(!button("Remove Olive Owner", members()));

  await selectValue(selects[0], "viewer");
  assert.deepEqual(server.calls.find((call) => call.method === "PATCH")?.body, { role: "viewer" });
  assert.equal(members().querySelector<HTMLSelectElement>('select[aria-label="Role for Eddie Editor"]')?.value, "viewer");

  await click(button("Remove Vera Viewer", members()));
  await click(button(/^Remove Vera Viewer$/, members()));
  assert.ok(server.calls.some((call) => call.method === "DELETE" && call.path === "/projects/p1/members/u-view"));
  assert.doesNotMatch(members().textContent!, /Vera Viewer/);
  assert.ok(!button("Leave this notebook"), "owners cannot leave their own notebook");
  await view.unmount();
});

test("an editor sees members read-only, no invitations, and can leave", async () => {
  installFakeBridge();
  const server = fakeProjectServer("editor", true);
  const { view, closed } = await openDialog();
  const dialog = () => document.querySelector('[role="dialog"]')!;
  assert.ok(!dialog().querySelector('form[aria-label="Invite people"]'));
  assert.ok(!dialog().querySelector("select"), "no role changes");
  assert.ok(!button("Remove Vera"));
  assert.ok(!server.calls.some((call) => call.path.endsWith("/invitations")), "invitations are not requested");
  assert.match(dialog().textContent!, /Bea Owner.*Owner/);

  await click(button("Leave this notebook"));
  assert.match(dialog().textContent!, /Leave “Thesis”\?/);
  await click(button(/^Leave notebook$/));
  assert.ok(server.calls.some((call) => call.method === "POST" && call.path === "/projects/p1/leave"));
  assert.equal(closed(), 1);
  await view.unmount();
});

test("viewers and commenters cannot manage either; server errors are shown", async () => {
  installFakeBridge();
  const server = fakeProjectServer("viewer", true);
  server.state.members = [];
  const { view } = await openDialog();
  assert.ok(!document.querySelector('form[aria-label="Invite people"]'));
  assert.ok(button("Leave this notebook"));
  await view.unmount();

  setCollabStatusStore(null);
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects: [project()] }) }),
    "GET /projects/p1/members": () => ({ status: 403, body: { error: { code: "forbidden", message: "x" } } }),
    "GET /projects/p1/invitations": () => ({ body: [] }),
  });
  const failing = await openDialog();
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /do not have permission/);
  assert.ok(button("Try again"));
  await failing.view.unmount();
});

test("a revoked notebook explains that the local copy stays", async () => {
  installFakeBridge();
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ projects: [project({ revoked: true, role: "editor" })] }) }) });
  const { view } = await openDialog();
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent!, /no longer shared with you/);
  assert.match(dialog.textContent!, /stays on this device as a read-only copy/);
  assert.ok(!dialog.querySelector("form"));
  await view.unmount();
});

test("the Notebooks badge shows shared and revoked states", async () => {
  const { createElement, Fragment } = await import("react");
  const { ProjectBadge } = await import("../../src/components/libera/collab/collab-shell");
  const view = await render(
    createElement(
      Fragment,
      null,
      createElement(ProjectBadge, { project: project({ role: "commenter" }) }),
      createElement(ProjectBadge, { project: project({ revoked: true }) }),
      createElement(ProjectBadge, { project: project({ reconcilePending: 2 }) }),
    ),
  );
  const badges = [...view.host.querySelectorAll('[role="img"]')];
  assert.deepEqual(badges.map((badge) => badge.getAttribute("aria-label")), [
    "Shared · Commenter",
    "No longer shared — read-only copy",
    "Shared · Owner · 2 to review",
  ]);
  assert.deepEqual(badges.map((badge) => badge.getAttribute("data-tone")), ["neutral", "danger", "warn"]);
  await view.unmount();
});
