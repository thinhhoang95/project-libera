import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { button, cleanup, click, hostStatus, installFakeBridge, installFakeFetch, project, removeBridge, render, submit, typeInto } from "./ui-support";
import type { LocalProject, NotificationInfo } from "../../src/lib/collab/local-api";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";

afterEach(async () => {
  await cleanup();
  setCollabStatusStore(null);
  removeBridge();
});

test("joining with a pasted link calls the host, then hands the new notebook to the shell", async () => {
  const { createElement } = await import("react");
  const { JoinNotebookDialog } = await import("../../src/components/libera/collab/join-notebook-dialog");
  installFakeBridge();
  let projects: LocalProject[] = [project({ projectId: "p0", notebook: "Mine", name: "Mine" })];
  const joined = project({ projectId: "p9", notebook: "Field notes (2)", name: "Field notes", role: "commenter" });
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects }) }),
    "GET /projects": () => ({ body: projects }),
    "POST /projects/join": (call) => {
      const { invitation } = call.body as { invitation: string };
      if (invitation !== "https://collab.test/invite/abc") {
        return { status: 400, body: { error: { code: "invalid-invitation", message: "expired" } } };
      }
      projects = [...projects, joined];
      return { body: joined };
    },
  });
  const opened: LocalProject[] = [];
  const view = await render(createElement(JoinNotebookDialog, { onClose() {}, onJoined: (item: LocalProject) => opened.push(item) }));
  const form = document.querySelector('[role="dialog"] form')!;
  const input = form.querySelector("input")!;

  await submit(form);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Paste the invitation link/);

  await typeInto(input, "https://collab.test/invite/expired");
  await submit(form);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /not valid, has expired, or was already used/);
  assert.equal(opened.length, 0);

  await typeInto(input, "  <https://collab.test/invite/abc>  ");
  await submit(form);
  assert.deepEqual(calls.filter((call) => call.path === "/projects/join").at(-1)?.body, { invitation: "https://collab.test/invite/abc" });
  assert.deepEqual(opened.map((item) => item.notebook), ["Field notes (2)"], "the name-clash suffix from the host is kept");
  await view.unmount();
});

test("a host that answers 204 still finds the new project", async () => {
  const { createElement } = await import("react");
  const { JoinNotebookDialog } = await import("../../src/components/libera/collab/join-notebook-dialog");
  let projects: LocalProject[] = [];
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects }) }),
    "GET /projects": () => ({ body: projects }),
    "POST /projects/join": () => {
      projects = [project({ projectId: "p5", notebook: "Lab" })];
      return undefined;
    },
  });
  const opened: string[] = [];
  const view = await render(createElement(JoinNotebookDialog, { onClose() {}, onJoined: (item: LocalProject) => opened.push(item.notebook) }));
  const form = document.querySelector('[role="dialog"] form')!;
  await typeInto(form.querySelector("input"), "tok");
  await submit(form);
  assert.deepEqual(opened, ["Lab"]);
  await view.unmount();
});

test("signed out, the join dialog asks to sign in first", async () => {
  const { createElement } = await import("react");
  const { JoinNotebookDialog } = await import("../../src/components/libera/collab/join-notebook-dialog");
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }) });
  let signIn = 0;
  const view = await render(createElement(JoinNotebookDialog, { onClose() {}, onJoined() {}, onSignIn: () => (signIn += 1) }));
  assert.ok(!document.querySelector('[role="dialog"] form'));
  assert.ok(!button(/^Join$/));
  await click(button("Sign in or create account"));
  assert.equal(signIn, 1);
  await view.unmount();
});

test("through the provider: join from the Library button opens the joined notebook", async () => {
  const { createElement, Fragment } = await import("react");
  const { CollabProvider } = await import("../../src/components/libera/collab/collab-provider");
  const { CollabJoinButton } = await import("../../src/components/libera/collab/collab-shell");
  installFakeBridge();
  let projects: LocalProject[] = [];
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects }) }),
    "GET /projects": () => ({ body: projects }),
    "POST /projects/join": () => {
      projects = [project({ projectId: "p7", notebook: "Group project" })];
      return { body: projects[0] };
    },
  });
  const opened: string[] = [];
  const view = await render(
    createElement(CollabProvider, { onNotebookJoined: (notebook: string) => void opened.push(notebook), onOpenPath() {}, children: createElement(Fragment, null, createElement(CollabJoinButton, { className: "" })) }),
  );
  await click(button("Join a shared notebook"));
  const form = document.querySelector('[role="dialog"] form')!;
  await typeInto(form.querySelector("input"), "tok-7");
  await submit(form);
  assert.deepEqual(opened, ["Group project"]);
  assert.ok(!document.querySelector('[role="dialog"]'), "the dialog closes");
  await view.unmount();
});

function notification(id: string, overrides: Partial<NotificationInfo>): NotificationInfo {
  return { id, kind: "mention", projectId: "p1", docId: "d1", payload: {}, createdAt: "2026-10-18T09:00:00.000Z", readAt: null, ...overrides };
}

test("the bell shows the unread count, groups by project, marks read and opens mentioned documents", async () => {
  const { createElement, act } = await import("react");
  const { NotificationsBell } = await import("../../src/components/libera/collab/notifications-bell");
  const bridge = installFakeBridge();
  const serverList: NotificationInfo[] = [
        notification("n1", { payload: { author: { displayName: "Minh" }, excerpt: "@Olive see §2" }, createdAt: "2026-10-18T10:00:00.000Z" }),
        notification("n2", { kind: "reply", projectId: "p2", docId: "d2", payload: { author: { displayName: "Ada" }, excerpt: "Agreed" } }),
        notification("n3", { kind: "thread-resolved", payload: { resolvedBy: { displayName: "Minh" }, quote: "typo" }, readAt: "2026-10-18T09:30:00.000Z" }),
        notification("n4", { kind: "invited", projectId: null, docId: null, payload: { inviter: { displayName: "Bea" }, projectName: "Grant", url: "https://collab.test/invite/g" } }),
      ];
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects: [project(), project({ projectId: "p2", name: "Lab", notebook: "Lab" })] }) }),
    // A live event is also a server row, so later list requests include it.
    "GET /notifications": () => ({ body: serverList }),
    "POST /notifications/read": () => undefined,
  });
  const openedDocs: string[] = [];
  const invitations: string[] = [];
  const view = await render(
    createElement(NotificationsBell, { onOpenDocument: (item: NotificationInfo) => openedDocs.push(item.docId!), onOpenInvitation: (url: string) => invitations.push(url) }),
  );
  assert.equal(calls.find((call) => call.path === "/notifications")?.query.get("limit"), "50");
  const bell = button("Notifications")!;
  assert.equal(bell.getAttribute("aria-label"), "Notifications, 3 unread");

  const live = notification("n5", { kind: "review-requested", projectId: "p2", docId: "d5", createdAt: "2026-10-18T11:00:00.000Z" });
  serverList.unshift(live);
  await act(async () => bridge.emit({ t: "notification", notification: live }));
  assert.equal(bell.getAttribute("aria-label"), "Notifications, 4 unread", "live notifications bump the count");

  await click(bell);
  const popover = document.querySelector('[role="dialog"][aria-label="Notifications"]')!;
  assert.ok(popover);
  assert.equal(bell.getAttribute("aria-expanded"), "true");
  const groups = [...popover.querySelectorAll("section")].map((section) => [section.getAttribute("aria-label"), section.querySelectorAll("li").length]);
  assert.deepEqual(groups, [["Lab", 2], ["Thesis", 2], ["Grant", 1]]);
  assert.match(popover.textContent!, /Minh mentioned you: @Olive see §2/);
  assert.match(popover.textContent!, /Minh resolved your comment: “typo”/);

  await click(button("Minh mentioned you", popover));
  assert.deepEqual(openedDocs, ["d1"]);
  assert.deepEqual(calls.filter((call) => call.path === "/notifications/read").map((call) => call.body), [{ ids: ["n1"] }]);
  assert.equal(bell.getAttribute("aria-label"), "Notifications, 3 unread");
  assert.ok(!document.querySelector('[role="dialog"][aria-label="Notifications"]'), "opening a document closes the list");

  await click(bell);
  await click(button("Bea invited you"));
  assert.deepEqual(invitations, ["https://collab.test/invite/g"]);

  await click(bell);
  await click(button("Mark all read"));
  assert.deepEqual(calls.filter((call) => call.path === "/notifications/read").at(-1)?.body, { all: true });
  assert.equal(bell.getAttribute("aria-label"), "Notifications");
  await view.unmount();
});

test("the bell is keyboard operable and hidden when signed out", async () => {
  const { createElement, act } = await import("react");
  const { NotificationsBell } = await import("../../src/components/libera/collab/notifications-bell");
  const { dom } = await import("./ui-support");
  installFakeBridge();
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus() }),
    "GET /notifications": () => ({ body: [notification("a", {}), notification("b", { kind: "reply", docId: "d2" })] }),
  });
  const view = await render(createElement(NotificationsBell, { onOpenDocument() {} }));
  const bell = button("Notifications")!;
  await click(bell);
  const items = [...document.querySelectorAll<HTMLElement>("[data-notification-item]")];
  assert.ok(document.activeElement === items[0], "focus moves into the list");
  const popover = document.querySelector('[role="dialog"][aria-label="Notifications"]')!;
  const key = (name: string) => act(async () => void popover.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true })));
  await key("ArrowDown");
  assert.ok(document.activeElement === items[1]);
  await key("ArrowDown");
  assert.ok(document.activeElement === items[0], "wraps around");
  await key("Escape");
  assert.ok(!document.querySelector('[role="dialog"][aria-label="Notifications"]'));
  assert.ok(document.activeElement === bell, "focus returns to the bell");
  await view.unmount();

  setCollabStatusStore(null);
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }) });
  const signedOut = await render(createElement(NotificationsBell, { onOpenDocument() {} }));
  assert.equal(signedOut.host.innerHTML, "");
  await signedOut.unmount();
});

test("clicking a mention through the provider resolves the docId to a path", async () => {
  const { createElement } = await import("react");
  const { CollabProvider } = await import("../../src/components/libera/collab/collab-provider");
  const { CollabRailButtons } = await import("../../src/components/libera/collab/collab-shell");
  installFakeBridge();
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects: [project()] }) }),
    "GET /notifications": () => ({ body: [notification("n1", { docId: "doc 1" })] }),
    "POST /notifications/read": () => undefined,
    "GET /docs/doc 1": () => ({ body: { docId: "doc 1", projectId: "p1", fileId: "f", path: "Thesis/ch1.md", kind: "markdown", role: "owner", readOnly: false } }),
  });
  const paths: string[] = [];
  const view = await render(createElement(CollabProvider, { onNotebookJoined() {}, onOpenPath: (path: string) => void paths.push(path), children: createElement(CollabRailButtons) }));
  await click(button("Notifications"));
  await click(document.querySelector("[data-notification-item]"));
  assert.deepEqual(paths, ["Thesis/ch1.md"]);
  await view.unmount();
});
