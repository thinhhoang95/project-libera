// Shared setup for the collaboration UI tests: a jsdom window (installed on
// import, before React loads so it picks the DOM event strategy), a fake
// fetch that routes `/api/collab/*` calls, a fake `window.liberaCollab`, and
// small render and input helpers.
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import type { HostEvent, HostStatus, LiberaCollabBridge, LocalProject } from "../../src/lib/collab/local-api";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "localStorage",
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type FakeReply = { status?: number; body?: unknown } | undefined;
export type FakeHandler = (call: FakeCall) => FakeReply | Promise<FakeReply>;

/**
 * Installs a global fetch answering `/api/collab` routes from `routes`, keyed
 * "METHOD /path" (path without the prefix and query). Unknown routes answer
 * 404 with an error body so tests notice them.
 */
export function installFakeFetch(routes: Record<string, FakeHandler>) {
  const calls: FakeCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/collab/, ""));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path, query: url.searchParams, body };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    const reply = handler ? await handler(call) : { status: 404, body: { error: { code: "not-found", message: `No fake for ${method} ${path}` } } };
    const status = reply?.status ?? (reply?.body === undefined ? 204 : 200);
    return new Response(status === 204 ? null : JSON.stringify(reply?.body ?? null), { status, headers: { "Content-Type": "application/json" } });
  };
  Object.defineProperty(globalThis, "fetch", { value: fetchImpl, configurable: true, writable: true });
  return { calls, fetch: fetchImpl };
}

export function installFakeBridge() {
  const listeners = new Set<(event: HostEvent) => void>();
  let nudges = 0;
  const bridge: LiberaCollabBridge = {
    attach: () => Promise.reject(new Error("not used")),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    nudge() {
      nudges += 1;
    },
  };
  Object.defineProperty(dom.window, "liberaCollab", { value: bridge, configurable: true, writable: true });
  return {
    bridge,
    get listenerCount() {
      return listeners.size;
    },
    get nudges() {
      return nudges;
    },
    emit(event: HostEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    remove() {
      Reflect.deleteProperty(dom.window, "liberaCollab");
    },
  };
}

export function removeBridge() {
  Reflect.deleteProperty(dom.window, "liberaCollab");
}

export const ACCOUNT = { id: "u-owner", email: "owner@example.com", displayName: "Olive Owner", color: "#2563eb", serverUrl: "https://collab.test" };

export function project(overrides: Partial<LocalProject> = {}): LocalProject {
  return { projectId: "p1", name: "Thesis", role: "owner", notebook: "Thesis", revoked: false, reconcilePending: 0, ...overrides };
}

export function hostStatus(overrides: Partial<HostStatus> = {}): HostStatus {
  return { hostVersion: 1, connection: "connected", account: ACCOUNT, projects: [], pendingCommands: 0, ...overrides };
}

/** Lets pending promises and React updates settle. */
export async function flush(times = 3) {
  const { act } = await import("react");
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const mounted = new Set<() => Promise<void>>();

export async function render(element: ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    mounted.delete(unmount);
    await act(async () => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  await act(async () => root.render(element));
  await flush();
  return {
    host,
    async rerender(next: ReactElement) {
      await act(async () => root.render(next));
      await flush();
    },
    unmount,
  };
}

/** Unmounts whatever a failed test left behind, so later tests start from an empty page. */
export async function cleanup() {
  for (const unmount of [...mounted]) await unmount();
  document.body.innerHTML = "";
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("click: element not found");
  const { act } = await import("react");
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

export async function typeInto(element: Element | null | undefined, value: string) {
  if (!element) throw new Error("typeInto: element not found");
  const { act } = await import("react");
  const input = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

export async function selectValue(element: Element | null | undefined, value: string) {
  if (!element) throw new Error("selectValue: element not found");
  const { act } = await import("react");
  const select = element as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush();
}

export async function submit(form: Element | null | undefined) {
  if (!form) throw new Error("submit: form not found");
  const { act } = await import("react");
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** The first button whose text or aria-label matches. */
export function button(text: string | RegExp, root: ParentNode = document): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((candidate) => {
    const label = [candidate.getAttribute("aria-label"), candidate.textContent].filter(Boolean).join(" ").trim();
    return typeof text === "string" ? label.includes(text) : text.test(label);
  });
}
