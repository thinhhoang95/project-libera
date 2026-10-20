import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { button, cleanup, flush, hostStatus, installFakeBridge, installFakeFetch, project, removeBridge, render } from "./ui-support";
import type { HostConnection, HostEvent } from "../../src/lib/collab/local-api";
import { createCollabClient } from "../../src/lib/collab/ui/client";
import { createCollabStatusStore, setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { CONNECTION_WORDING, connectionWording } from "../../src/lib/collab/ui/wording";

afterEach(async () => {
  await cleanup();
  setCollabStatusStore(null);
  removeBridge();
});

function fakeEvents() {
  const listeners = new Set<(event: HostEvent) => void>();
  return {
    subscribe(listener: (event: HostEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: HostEvent) => listeners.forEach((listener) => listener(event)),
    get size() {
      return listeners.size;
    },
  };
}

test("the store fetches once, follows status events and refetches projects on project-changed", async () => {
  let statusCalls = 0;
  let projects = [project()];
  const { fetch } = installFakeFetch({
    "GET /status": () => {
      statusCalls += 1;
      return { body: hostStatus({ connection: "connecting", projects }) };
    },
    "GET /projects": () => ({ body: projects }),
  });
  const events = fakeEvents();
  const store = createCollabStatusStore({ client: createCollabClient({ fetch }), subscribeEvents: events.subscribe, hasLiveEvents: () => true });
  assert.equal(store.getSnapshot().phase, "loading");
  const seen: string[] = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().status?.connection ?? store.getSnapshot().phase));
  const unsubscribeSecond = store.subscribe(() => {});
  await flush();
  assert.equal(statusCalls, 1, "two subscribers share one request");
  assert.equal(events.size, 1);
  assert.equal(store.getSnapshot().phase, "ready");

  events.emit({ t: "status", status: hostStatus({ connection: "offline", pendingCommands: 3 }) });
  assert.equal(store.getSnapshot().status?.connection, "offline");
  assert.equal(store.getSnapshot().status?.pendingCommands, 3);

  projects = [project(), project({ projectId: "p2", notebook: "Lab", name: "Lab" })];
  events.emit({ t: "project-changed", projectId: "p2" });
  await flush();
  assert.deepEqual(store.getSnapshot().status?.projects.map((item) => item.projectId), ["p1", "p2"]);
  assert.equal(store.getSnapshot().status?.connection, "offline", "a project refresh keeps the live connection state");
  assert.deepEqual(seen.slice(0, 2), ["connecting", "offline"]);

  unsubscribe();
  unsubscribeSecond();
  assert.equal(events.size, 0, "the last unsubscribe stops listening");
});

test("a 503 collab-disabled hides the feature; other errors keep the last status", async () => {
  let mode: "disabled" | "ok" | "down" = "disabled";
  const { fetch } = installFakeFetch({
    "GET /status": () =>
      mode === "disabled"
        ? { status: 503, body: { error: { code: "collab-disabled", message: "LIBERA_COLLAB is not set" } } }
        : mode === "down"
          ? { status: 500, body: { error: { code: "internal", message: "boom" } } }
          : { body: hostStatus() },
  });
  const store = createCollabStatusStore({ client: createCollabClient({ fetch }), subscribeEvents: () => () => {}, hasLiveEvents: () => true });
  const stop = store.subscribe(() => {});
  await flush();
  assert.equal(store.getSnapshot().phase, "disabled");
  assert.equal(store.getSnapshot().status, null);

  mode = "ok";
  await store.refresh();
  assert.equal(store.getSnapshot().phase, "ready");
  mode = "down";
  await store.refresh();
  assert.equal(store.getSnapshot().phase, "ready", "a blip does not hide shared badges");
  assert.equal(store.getSnapshot().status?.connection, "connected");
  assert.match(store.getSnapshot().error ?? "", /went wrong/);
  stop();
});

test("without live events the store polls, and stops once disabled", async () => {
  let calls = 0;
  const { fetch } = installFakeFetch({
    "GET /status": () => {
      calls += 1;
      return calls >= 3 ? { status: 503, body: { error: { code: "collab-disabled", message: "off" } } } : { body: hostStatus() };
    },
  });
  const store = createCollabStatusStore({ client: createCollabClient({ fetch }), subscribeEvents: () => () => {}, hasLiveEvents: () => false, pollMs: 5 });
  const stop = store.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 3, "polled until the host said disabled, then stopped");
  assert.equal(store.getSnapshot().phase, "disabled");
  stop();
});

test("useCollabStatus renders the GET status, then live status events, with or without the bridge", async () => {
  const { createElement } = await import("react");
  const { useCollabStatus } = await import("../../src/lib/collab/ui/hooks");
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "connecting" }) }) });
  const bridge = installFakeBridge();
  function Probe() {
    const collab = useCollabStatus();
    return createElement("p", { id: "probe" }, `${collab.phase}:${collab.status?.connection ?? "-"}:${collab.signedIn}:${collab.enabled}`);
  }
  const view = await render(createElement(Probe));
  const text = () => document.getElementById("probe")?.textContent;
  assert.equal(text(), "ready:connecting:true:true");
  const { act } = await import("react");
  await act(async () => bridge.emit({ t: "status", status: hostStatus({ connection: "needs-sign-in" }) }));
  assert.equal(text(), "ready:needs-sign-in:true:true");
  await act(async () => bridge.emit({ t: "status", status: hostStatus({ connection: "signed-out", account: null }) }));
  assert.equal(text(), "ready:signed-out:false:true");
  await view.unmount();
  assert.equal(bridge.listenerCount, 0);

  // Plain browser: no window.liberaCollab at all.
  setCollabStatusStore(null);
  removeBridge();
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "offline" }) }) });
  const plain = await render(createElement(Probe));
  assert.equal(text(), "ready:offline:true:true");
  await plain.unmount();
});

test("useHostEvents delivers only the requested kind and tolerates a missing bridge", async () => {
  const { createElement, useState } = await import("react");
  const { useHostEvents } = await import("../../src/lib/collab/ui/hooks");
  const bridge = installFakeBridge();
  function Probe() {
    const [seen, setSeen] = useState<string[]>([]);
    useHostEvents("share-progress", (event) => setSeen((current) => [...current, `${event.progress.phase}:${event.progress.done}`]));
    return createElement("p", { id: "events" }, seen.join(","));
  }
  const view = await render(createElement(Probe));
  const { act } = await import("react");
  await act(async () => {
    bridge.emit({ t: "share-progress", notebook: "N", progress: { phase: "importing-documents", done: 1, total: 4 } });
    bridge.emit({ t: "project-changed", projectId: "p1" });
    bridge.emit({ t: "share-progress", notebook: "N", progress: { phase: "done", done: 4, total: 4 } });
  });
  assert.equal(document.getElementById("events")?.textContent, "importing-documents:1,done:4");
  await view.unmount();

  removeBridge();
  const bare = await render(createElement(Probe));
  assert.equal(document.getElementById("events")?.textContent, "");
  await bare.unmount();
});

test("every connection state has wording; the required sentences are exact", () => {
  const states: HostConnection[] = ["signed-out", "connecting", "connected", "offline", "needs-sign-in", "update-required"];
  assert.deepEqual(Object.keys(CONNECTION_WORDING).sort(), [...states].sort());
  for (const state of states) {
    const wording = connectionWording(state);
    assert.ok(wording.label && wording.detail, state);
  }
  assert.equal(connectionWording("needs-sign-in").detail, "Sign in again to keep syncing; your edits are saved on this device.");
  assert.match(connectionWording("offline").detail, /^Offline — changes are saved on this device/);
  assert.match(connectionWording("update-required").detail, /Update Libera/);
});

test("the account dialog words each connection state and points update-required to the updater", async () => {
  const { createElement } = await import("react");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  const bridge = installFakeBridge();
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "offline", pendingCommands: 2 }) }) });
  let checked = 0;
  Object.defineProperty(window, "liberaUpdater", {
    configurable: true,
    value: { check: async () => { checked += 1; return { status: "downloaded", currentVersion: "1" }; } },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  const dialog = () => document.querySelector('[role="dialog"]')!;
  assert.match(dialog().textContent!, /Offline — changes are saved on this device/);
  assert.match(dialog().textContent!, /2 comments or decisions are waiting/);
  await (await import("./ui-support")).click(button("Reconnect now"));
  assert.equal(bridge.nudges, 1);

  const { act } = await import("react");
  await act(async () => bridge.emit({ t: "status", status: hostStatus({ connection: "needs-sign-in" }) }));
  assert.match(dialog().textContent!, /Sign in again to keep syncing; your edits are saved on this device/);
  const email = document.querySelector<HTMLInputElement>('input[type="email"]');
  assert.equal(email?.value, "owner@example.com", "re-sign-in keeps the account's email");

  await act(async () => bridge.emit({ t: "status", status: hostStatus({ connection: "update-required" }) }));
  await (await import("./ui-support")).click(button("Check for updates"));
  assert.equal(checked, 1);
  assert.match(dialog().textContent!, /Restart Libera to install/);
  await view.unmount();
  Reflect.deleteProperty(window, "liberaUpdater");
});

test("sign in, profile colour and sign out go through the client", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let status = hostStatus({ connection: "signed-out", account: null });
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: status }),
    "GET /account/shared-sign-in": () => ({ body: { state: "none" } }),
    "POST /account/sign-in": (call) => {
      const body = call.body as { password: string };
      if (body.password !== "right") return { status: 401, body: { error: { code: "unauthorized", message: "no" } } };
      status = hostStatus();
      return { body: status };
    },
    "PATCH /account": (call) => {
      status = hostStatus({ account: { ...status.account!, ...(call.body as object) } });
      return { body: status.account };
    },
    "POST /account/sign-out": () => {
      status = hostStatus({ connection: "signed-out", account: null });
      return undefined;
    },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  const field = (id: string) => document.querySelector<HTMLInputElement>(`input[id$="${id}"]`);
  await support.typeInto(field("-server"), "collab.test/");
  await support.typeInto(field("-email"), "owner@example.com");
  await support.typeInto(field("-password"), "wrong");
  await support.submit(document.querySelector('form[aria-label="Sign in"]'));
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /email or password is not correct/);
  await support.typeInto(field("-password"), "right");
  await support.submit(document.querySelector('form[aria-label="Sign in"]'));
  const signIn = calls.filter((call) => call.path === "/account/sign-in").at(-1)!;
  assert.deepEqual(signIn.body, { serverUrl: "https://collab.test", email: "owner@example.com", password: "right" });
  assert.equal(localStorage.getItem("libera.collab.serverUrl"), "https://collab.test");
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Connected/);

  await support.click(document.querySelector('[role="radio"][aria-label="Colour #db2777"]'));
  await support.submit(document.querySelector('form[aria-label="Profile"]'));
  assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, { displayName: "Olive Owner", color: "#db2777" });

  await support.click(button("Sign out of collaboration"));
  await support.click(button(/^\s*Sign out$/));
  assert.ok(calls.some((call) => call.path === "/account/sign-out"));
  assert.ok(document.querySelector('form[aria-label="Sign in"]'), "back to the sign-in form");
  await view.unmount();
});

test("signed out: unlock with the master password, then Continue as … the other computer's account", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let status = hostStatus({ connection: "signed-out", account: null });
  let offer: unknown = { state: "locked" };
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: status }),
    "GET /account/shared-sign-in": () => ({ body: offer }),
    "POST /api/auth/collab-unlock": (call) => {
      if ((call.body as { password: string }).password !== "master") return { status: 403, body: { error: "That is not your Libera master password." } };
      offer = { state: "available", accountId: "acc_owner", email: "owner@example.com", serverUrl: "https://collab.test" };
      return { body: { ok: true } };
    },
    "POST /account/shared-sign-in": () => {
      status = hostStatus();
      return { body: status };
    },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  await flush();
  const group = () => document.querySelector('[aria-label="Sign in from your other computer"]');
  assert.ok(group(), "the shared sign-in is offered above the form");
  await support.typeInto(document.querySelector<HTMLInputElement>('input[id$="-master"]'), "nope");
  await support.submit(group()!.querySelector("form"));
  assert.match(group()!.textContent!, /not your Libera master password/);

  await support.typeInto(document.querySelector<HTMLInputElement>('input[id$="-master"]'), "master");
  await support.submit(group()!.querySelector("form"));
  await support.click(button(/Continue as owner@example\.com/));
  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/account/shared-sign-in")?.body, { accountId: "acc_owner", serverUrl: "https://collab.test" });
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Connected/);
  assert.equal(group(), null, "nothing to offer once signed in");
  await view.unmount();
});

test("Continue keeps a transient error visible and lets the person retry", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let status = hostStatus({ connection: "signed-out", account: null });
  let attempts = 0;
  installFakeFetch({
    "GET /status": () => ({ body: status }),
    "GET /account/shared-sign-in": () => ({ body: { state: "available", accountId: "acc_1", email: "a@example.com", serverUrl: "https://collab.test" } }),
    "POST /account/shared-sign-in": () => {
      if (++attempts === 1) return { status: 503, body: { error: { code: "network", message: "offline" } } };
      status = hostStatus();
      return { body: status };
    },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  await support.click(button(/Continue as a@example/));
  const group = document.querySelector('[aria-label="Sign in from your other computer"]');
  assert.ok(group?.querySelector('[role="alert"]'), "the error stays visible");
  assert.ok(button(/Continue as a@example/), "the same choice can be retried");
  await support.click(button(/Continue as a@example/));
  assert.equal(attempts, 2);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Connected/);
  await view.unmount();
});

test("Continue refreshes a stale offer and requires choosing the new identity", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let status = hostStatus({ connection: "signed-out", account: null });
  let offer = { state: "available", accountId: "acc_1", email: "first@example.com", serverUrl: "https://first.test" };
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: status }),
    "GET /account/shared-sign-in": () => ({ body: offer }),
    "POST /account/shared-sign-in": (call) => {
      if ((call.body as { accountId: string }).accountId === "acc_1") {
        offer = { state: "available", accountId: "acc_2", email: "second@example.com", serverUrl: "https://second.test" };
        return { status: 409, body: { error: { code: "offer-changed", message: "The account changed. Check it before continuing." } } };
      }
      status = hostStatus();
      return { body: status };
    },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  await support.click(button(/Continue as first@example/));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /account changed/);
  assert.ok(button(/Continue as second@example/));
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "refresh never signs in by itself");
  await support.click(button(/Continue as second@example/));
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.body), [
    { accountId: "acc_1", serverUrl: "https://first.test" },
    { accountId: "acc_2", serverUrl: "https://second.test" },
  ]);
  await view.unmount();
});

test("a revoked offer keeps its explanation visible after discovery returns none", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let revoked = false;
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }),
    "GET /account/shared-sign-in": () => ({ body: revoked ? { state: "none" } : { state: "available", accountId: "acc_1", email: "a@example.com", serverUrl: "https://collab.test" } }),
    "POST /account/shared-sign-in": () => {
      revoked = true;
      return { status: 403, body: { error: { code: "refused", message: "This sign-in was revoked. Sign in with your email and password." } } };
    },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  await support.click(button(/Continue as a@example/));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /revoked/);
  assert.ok(button("Check again"));
  await view.unmount();
});

test("discovery errors can be retried without reopening the dialog", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let failed = true;
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }),
    "GET /account/shared-sign-in": () => failed
      ? { status: 503, body: { error: { code: "host-unavailable", message: "restarting" } } }
      : { body: { state: "available", accountId: "acc_1", email: "a@example.com", serverUrl: "https://collab.test" } },
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  assert.ok(document.querySelector('[role="alert"]'));
  failed = false;
  await support.click(button("Check again"));
  assert.ok(button(/Continue as a@example/));
  assert.equal(document.querySelector('[role="alert"]'), null);
  await view.unmount();
});

test("delayed offers are discovered by polling and reconnect events, with cleanup on close", async (context) => {
  const { createElement, act } = await import("react");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  let poll: (() => void) | undefined;
  context.mock.method(window, "setInterval", (callback: () => void) => { poll = callback; return 123; });
  const cleared = context.mock.method(window, "clearInterval", () => {});
  let available = false;
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }),
    "GET /account/shared-sign-in": () => ({ body: available ? { state: "available", accountId: "acc_1", email: "a@example.com", serverUrl: "https://collab.test" } : { state: "none" } }),
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  available = true;
  await act(async () => poll!());
  await flush();
  assert.ok(button(/Continue as a@example/), "the file arriving later becomes visible");
  available = false;
  await act(async () => window.dispatchEvent(new Event("online")));
  await flush();
  assert.ok(button("Check again"));
  available = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await flush();
  assert.ok(button(/Continue as a@example/));
  await view.unmount();
  assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === 123));
  const checked = calls.length;
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  poll!();
  await flush();
  assert.equal(calls.length, checked, "unmounted discovery stops timers and listeners");
});

test("create account sends the optional invitation", async () => {
  const { createElement } = await import("react");
  const support = await import("./ui-support");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  const { calls } = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }),
    "POST /account/register": () => ({ body: hostStatus() }),
  });
  const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
  await support.click(button("Create account"));
  const field = (id: string) => document.querySelector<HTMLInputElement>(`input[id$="${id}"]`);
  await support.typeInto(field("-server"), "https://collab.test");
  await support.typeInto(field("-name"), "Ada");
  await support.typeInto(field("-email"), "ada@example.com");
  await support.typeInto(field("-password"), "secret-pass");
  await support.typeInto(field("-invitation"), "  tok-123 ");
  await support.submit(document.querySelector('form[aria-label="Create a collaboration account"]'));
  assert.deepEqual(calls.find((call) => call.path === "/account/register")?.body, {
    serverUrl: "https://collab.test",
    email: "ada@example.com",
    password: "secret-pass",
    displayName: "Ada",
    invitationToken: "tok-123",
  });
  await view.unmount();
});

test("with collaboration disabled the shell shows nothing collaborative", async () => {
  const { createElement, Fragment } = await import("react");
  const { CollabProvider, useCollabShell } = await import("../../src/components/libera/collab/collab-provider");
  const { CollabJoinButton, CollabRailButtons, SharedNotebookBadge, collabNotebookMenuItems } = await import(
    "../../src/components/libera/collab/collab-shell"
  );
  installFakeBridge();
  installFakeFetch({ "GET /status": () => ({ status: 503, body: { error: { code: "collab-disabled", message: "off" } } }) });
  let menu: unknown[] = ["unset"];
  function MenuProbe() {
    const shell = useCollabShell();
    menu = collabNotebookMenuItems(shell, { name: "Thesis" });
    return null;
  }
  const view = await render(
    createElement(CollabProvider, { onNotebookJoined() {}, onOpenPath() {}, children: createElement(Fragment, null, createElement(CollabRailButtons), createElement(SharedNotebookBadge, { notebook: "Thesis" }), createElement(CollabJoinButton, { className: "" }), createElement(MenuProbe)) }),
  );
  assert.equal(view.host.innerHTML, "");
  assert.equal(document.querySelectorAll("button").length, 0);
  assert.deepEqual(menu, []);
  await view.unmount();

  // Enabled and signed in: the same tree shows the rail, the badge and the share item.
  setCollabStatusStore(null);
  installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ projects: [project({ notebook: "Thesis" })] }) }),
    "GET /notifications": () => ({ body: [] }),
  });
  const enabled = await render(
    createElement(CollabProvider, { onNotebookJoined() {}, onOpenPath() {}, children: createElement(Fragment, null, createElement(CollabRailButtons), createElement(SharedNotebookBadge, { notebook: "Thesis" }), createElement(CollabJoinButton, { className: "" }), createElement(MenuProbe)) }),
  );
  assert.ok(button("Collaboration: Connected"));
  assert.ok(button("Notifications"));
  assert.ok(button("Join a shared notebook"));
  assert.ok(document.querySelector('[aria-label="Shared · Owner"]'));
  assert.deepEqual(menu, [{ type: "separator" }, { id: "collab:manage", label: "Sharing and members…" }]);
  await enabled.unmount();
});

test("signed out: rail button only, no bell, no join, no share item", async () => {
  const { createElement, Fragment } = await import("react");
  const { CollabProvider, useCollabShell } = await import("../../src/components/libera/collab/collab-provider");
  const { CollabJoinButton, CollabRailButtons, collabNotebookMenuItems } = await import("../../src/components/libera/collab/collab-shell");
  installFakeFetch({ "GET /status": () => ({ body: hostStatus({ connection: "signed-out", account: null }) }) });
  let menu: unknown[] = ["unset"];
  function MenuProbe() {
    menu = collabNotebookMenuItems(useCollabShell(), { name: "Thesis" });
    return null;
  }
  const view = await render(
    createElement(CollabProvider, { onNotebookJoined() {}, onOpenPath() {}, children: createElement(Fragment, null, createElement(CollabRailButtons), createElement(CollabJoinButton, { className: "" }), createElement(MenuProbe)) }),
  );
  assert.ok(button("Collaboration: Not signed in"));
  assert.ok(!button("Notifications"));
  assert.ok(!button("Join a shared notebook"));
  assert.deepEqual(menu, []);
  await view.unmount();
});

test("the share item is offered only for normal, unshared notebooks", async () => {
  const { collabNotebookMenuItems } = await import("../../src/components/libera/collab/collab-shell");
  const shell = {
    visible: true,
    signedIn: true,
    projectForNotebook: (name: string) =>
      name === "Shared" ? project({ notebook: "Shared" }) : name === "Gone" ? project({ notebook: "Gone", revoked: true }) : undefined,
    canShareNotebook: (notebook: { name: string; folder?: unknown }) => !notebook.folder && !["Shared", "Gone"].includes(notebook.name),
    openAccount() {},
    openShare() {},
    openJoin() {},
    openNotificationTarget() {},
  };
  assert.deepEqual(collabNotebookMenuItems(shell, { name: "Plain" }), [{ type: "separator" }, { id: "collab:share", label: "Share notebook…" }]);
  assert.deepEqual(collabNotebookMenuItems(shell, { name: "Linked", folder: { path: "/x" } }), []);
  assert.deepEqual(collabNotebookMenuItems(shell, { name: "Gone" }), []);
  assert.equal((collabNotebookMenuItems(shell, { name: "Shared" })[1] as { id: string }).id, "collab:manage");
});
