import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NextRequest } from "next/server";
import { GET as getSession } from "../../src/app/api/auth/session/route";
import { POST as logout } from "../../src/app/api/auth/logout/route";
import { requireAuth } from "../../src/lib/api";
import { createArchiveToken, createSessionToken, SESSION_COOKIE_NAME, verifyArchiveToken, verifySessionToken } from "../../src/lib/auth";
import { SESSION_EXPIRED_HEADER } from "../../src/lib/auth-session";
import { apiRequest, emptyTree } from "../../src/components/libera/api-client";
import { monitorSessionExpiration } from "../../src/components/libera/session-expiration";
import { useLiberaWorkspace } from "../../src/components/libera/use-libera-workspace";
import { emptyWorkspaceLibrary, parseWorkspaceLibrary } from "../../src/lib/workspaces";

function setupDom() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
}

const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
const unauthorized = () => Response.json({ error: "Authentication required." }, {
  status: 401, headers: { [SESSION_EXPIRED_HEADER]: "1" },
});

test("session status exposes the verified deadline and the guard marks expired sessions", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const token = createSessionToken();
  const request = new NextRequest("http://localhost/api/auth/session", { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
  const response = await getSession(request);
  const status = await response.json();
  assert.equal(status.authenticated, true);
  assert.equal(status.expiresAt, Date.now() + 12 * 60 * 60 * 1000);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(requireAuth(request), null);
  assert.equal(verifySessionToken(token), true);
  assert.equal(verifyArchiveToken(createArchiveToken()), true);
  assert.equal(verifySessionToken(createArchiveToken()), false);
  assert.equal(verifyArchiveToken(token), false);
  assert.equal(verifySessionToken(`${token}tampered`), false);
  context.mock.timers.setTime(status.expiresAt);
  assert.equal(verifySessionToken(token), false);
  assert.deepEqual(await (await getSession(request)).json(), { authenticated: false, expiresAt: null });
  assert.equal(requireAuth(request)?.headers.get(SESSION_EXPIRED_HEADER), "1");
  assert.deepEqual(await (await getSession(new NextRequest(request.url))).json(), { authenticated: false, expiresAt: null });
  const signedOut = await logout();
  assert.equal(signedOut.status, 200, "logout itself never requires a valid token");
  assert.equal(signedOut.cookies.get(SESSION_COOKIE_NAME)?.maxAge, 0);
  assert.equal(signedOut.cookies.get("libera_archive")?.maxAge, 0);
});

test("idle expiry locks at the deadline even when a status request hangs", async (context) => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let calls = 0;
  let expired = 0;
  globalThis.fetch = async () => {
    if (++calls > 1) return new Promise<Response>(() => {});
    return Response.json({ authenticated: true, expiresAt: Date.now() + 90_000 });
  };
  const stop = monitorSessionExpiration(() => { expired++; });
  try {
    await settle();
    context.mock.timers.tick(60_000);
    await settle();
    assert.equal(calls, 2);
    assert.equal(expired, 0);
    context.mock.timers.tick(30_000);
    assert.equal(expired, 1);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    assert.equal(expired, 1, "expiry runs once");
  } finally { stop(); context.mock.timers.reset(); globalThis.fetch = previousFetch; dom.window.close(); }
});

test("wake checks expiry immediately and ignores temporary network failures", async (context) => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let calls = 0;
  let expired = 0;
  globalThis.fetch = async () => {
    if (++calls > 1) throw new Error("offline");
    return Response.json({ authenticated: true, expiresAt: Date.now() + 90_000 });
  };
  const stop = monitorSessionExpiration(() => { expired++; });
  try {
    await settle();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    assert.equal(expired, 0);
    context.mock.timers.setTime(1_100_000); // Timers were suspended during sleep.
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(expired, 1);
  } finally { stop(); context.mock.timers.reset(); globalThis.fetch = previousFetch; dom.window.close(); }
});

test("only local session failures trigger sign-out; stopped monitors ignore late replies", async () => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  let reply!: (response: Response) => void;
  let expired = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/auth/session") return new Promise<Response>((resolve) => { reply = resolve; });
    if (url === "/api/tree") return unauthorized();
    return Response.json({ error: "Wrong password or upstream token" }, { status: 401 });
  };
  const stop = monitorSessionExpiration(() => { expired++; });
  try {
    await assert.rejects(apiRequest("/api/auth/login"));
    await assert.rejects(apiRequest("/api/gallery/archive/session"));
    await assert.rejects(apiRequest("/api/collab/account"));
    assert.equal(expired, 0);
    await assert.rejects(apiRequest("/api/tree"));
    assert.equal(expired, 1);
    stop();
    const stopNext = monitorSessionExpiration(() => { expired++; });
    stopNext();
    reply(Response.json({ authenticated: false, expiresAt: null }));
    await settle();
    assert.equal(expired, 1);
    await assert.rejects(apiRequest("/api/tree"));
    assert.equal(expired, 1, "cleanup removed the event listener");
  } finally { stop(); globalThis.fetch = previousFetch; dom.window.close(); }
});

test("logout with an expired token preserves live drafts locally and allows signing in again", async () => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  let valid = true;
  let cleanupCalls = 0;
  let cleanupSignal: AbortSignal | null | undefined;
  let disk = emptyWorkspaceLibrary();
  const tree = { ...emptyTree(), root: "/test/expiry" };
  globalThis.fetch = async (url, init) => {
    if (url === "/api/auth/session") return Response.json({ authenticated: valid, expiresAt: valid ? Date.now() + 60_000 : null });
    if (url === "/api/auth/login") { valid = true; return Response.json({ authenticated: true }); }
    if (url === "/api/auth/logout") { cleanupCalls++; cleanupSignal = init?.signal; return new Promise<Response>(() => {}); }
    if (!valid) return unauthorized();
    if (String(url).startsWith("/api/tree")) return Response.json(tree);
    if (String(url).startsWith("/api/workspaces")) {
      if (init?.method === "PUT") disk = parseWorkspaceLibrary(JSON.parse(String(init.body)));
      return Response.json(disk);
    }
    return Response.json({});
  };
  let state!: ReturnType<typeof useLiberaWorkspace>;
  function Harness() { state = useLiberaWorkspace(true); return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
    assert.equal(state.workspace.workspaceManager.ready, true);
    await act(async () => state.workspace.createUntitledFile("", undefined, { fileName: "Draft.md", content: "draft" }));
    const tabId = state.workspace.tabs[0].id;
    const unregister = state.workspace.registerEditorDraft(tabId, () => "final unsaved keystroke");
    valid = false;
    await act(async () => state.workspace.handleLogout());
    assert.equal(state.authenticated, false);
    assert.match(state.workspace.authError, /session expired/i);
    assert.equal(state.workspace.workspaceError, "");
    assert.equal(state.workspace.tabs.length, 0);
    assert.equal(cleanupCalls, 1);
    const recovery = parseWorkspaceLibrary(JSON.parse(window.localStorage.getItem("libera:workspaces:v1:/test/expiry")!));
    assert.equal(recovery.librarySession?.tabs[0].draft, "final unsaved keystroke");
    unregister();
    await act(async () => state.workspace.handleLogin({ preventDefault() {} } as React.FormEvent<HTMLFormElement>));
    assert.equal(state.authenticated, true);
    assert.equal(state.workspace.tabs[0].draft, "final unsaved keystroke");
    assert.equal(state.workspace.busy, false);
    assert.equal(state.workspace.authError, "");
    assert.equal(cleanupSignal?.aborted, true, "new sign-in cancels stale cookie cleanup");
  } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; dom.window.close(); }
});

test("expiry while workspace loading releases the keyboard and does not await cleanup", async () => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  let valid = true;
  let loading = false;
  globalThis.fetch = async (url) => {
    if (url === "/api/auth/session") return Response.json({ authenticated: valid, expiresAt: valid ? Date.now() + 60_000 : null });
    if (String(url).startsWith("/api/tree")) return Response.json({ ...emptyTree(), root: "/test/loading" });
    if (String(url).startsWith("/api/workspaces")) { loading = true; return new Promise<Response>(() => {}); }
    if (url === "/api/auth/logout") return new Promise<Response>(() => {});
    return Response.json({});
  };
  let state!: ReturnType<typeof useLiberaWorkspace>;
  function Harness() { state = useLiberaWorkspace(true); return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(loading, true);
    valid = false;
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(state.authenticated, false);
    const key = new dom.window.KeyboardEvent("keydown", { key: "a", cancelable: true });
    dom.window.dispatchEvent(key);
    assert.equal(key.defaultPrevented, false, "the workspace loading lock cannot block entering a password");
  } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; dom.window.close(); }
});
