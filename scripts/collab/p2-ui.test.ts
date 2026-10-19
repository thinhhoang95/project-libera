// Review Mode UI on shared documents (jsdom): the real provider and Comments
// panel on a replica of a real DocHub, with the local API answered by a fake
// fetch. Authors and AI attribution, Markdown bodies through the app's
// renderer (raw HTML stays text), permission-gated controls, pending chips
// through their whole lifecycle (sending, queued offline, settled, refused
// with Retry and Discard), detached threads, the @ picker, desktop
// notifications, and that local documents never touch the collab routes.

import { ACCOUNT, button, cleanup, click, dom, flush, hostStatus, installFakeBridge, render } from "./ui-support";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useEffect, useState, type ReactNode } from "react";

import { addAnchor } from "../../src/lib/collab/anchors";
import { setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import type { Command, Thread, ThreadMessage } from "../../src/lib/collab/protocol/api";
import type { HostStatus } from "../../src/lib/collab/local-api";
import { setCollabStatusStore, type CollabSnapshot, type CollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { mentionIds, mentionQueryAt } from "../../src/lib/collab/review-store/mentions";
import { newReview } from "../../src/lib/markdown-review";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { ReviewComments } from "../../src/components/libera/markdown-review-ui";
import { MentionTextarea } from "../../src/components/libera/collab/mentions/mention-textarea";
import { DESKTOP_NOTIFICATIONS_KEY, showDesktopNotification, type DesktopNotificationEnvironment } from "../../src/components/libera/collab/desktop-notifications";
import type { OpenTab } from "../../src/components/libera/types";
import { createHarness } from "./support/wire-harness";

for (const key of ["HTMLTextAreaElement", "MutationObserver", "getComputedStyle", "StorageEvent"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}

// jsdom has no layout; the panel scrolls the selected card into view.
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

const TEXT = "# Shared\n\nFirst paragraph here.\n\nSecond paragraph here.\n";
const PATH = "Shared/note.md";
const BOB = { id: "u-bob", displayName: "Bob Builder", color: "#16a34a" };
const OWNER = { id: ACCOUNT.id, displayName: ACCOUNT.displayName, color: ACCOUNT.color };

function message(id: string, threadId: string, author: typeof BOB, body: string, actor: Thread["actor"] = { kind: "user", userId: author.id }): ThreadMessage {
  return { id, threadId, actor, author, body, mentions: [], createdAt: "2026-10-18T08:00:00.000Z", editedAt: null, deletedAt: null };
}

function threadRecord(id: string, anchorId: string, quote: string, author: typeof BOB, body: string, actor?: Thread["actor"]): Thread {
  return {
    id, docId: "d1", anchorId, quote, status: "open", actor: actor ?? { kind: "user", userId: author.id }, createdBy: author,
    createdAt: "2026-10-18T08:00:00.000Z", updatedAt: "2026-10-18T08:00:00.000Z", resolvedBy: null, resolvedAt: null, suggestionIds: [],
    messages: [message(id, id, author, body, actor)],
  };
}

function statusStore(initial: HostStatus) {
  let snapshot: CollabSnapshot = { phase: "ready", status: initial };
  const listeners = new Set<() => void>();
  const store: CollabStatusStore = {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    refresh: async () => {},
    refreshProjects: async () => {},
    setStatus: (status) => { snapshot = { phase: "ready", status }; for (const listener of [...listeners]) listener(); },
  };
  return store;
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Route = (body: unknown, url: URL) => unknown | Promise<unknown>;

function installFetch(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not-found", message: `No fake for ${method} ${url.pathname}` } }), { status: 404 });
    const result = await handler(body, url);
    if (result instanceof Response) return result;
    return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
  };
  Object.defineProperty(globalThis, "fetch", { value: fetchImpl, configurable: true, writable: true });
  return calls;
}

const probe: { review: NonNullable<ReturnType<typeof useMarkdownReview>> | null } = { review: null };
function Probe() {
  const value = useMarkdownReview();
  useEffect(() => { probe.review = value; });
  return null;
}
const reviewOf = () => probe.review!;

function tab(id: string, path: string, draft: string): OpenTab {
  return { id, draft, saved: draft, status: "clean", file: { fileType: "markdown", path, name: path.split("/").at(-1)!, notebook: path.split("/")[0] } } as unknown as OpenTab;
}

function provider(activeTab: OpenTab, getDraft: () => string, children: ReactNode) {
  // createElement needs the provider's children prop for type checking.
  // eslint-disable-next-line react/no-children-prop
  return createElement(MarkdownReviewProvider, { activeTab, getDraft, applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children });
}

const card = (text: string) => [...document.querySelectorAll<HTMLElement>("article.review-comment-card")].find((element) => element.textContent?.includes(text));

test("shared threads in the Comments panel: authors, Markdown, gating, pending chips, detached", async () => {
  const bridge = installFakeBridge();
  const harness = createHarness({ text: TEXT, role: "owner" });
  const { registry } = harness.registry({ paths: [PATH] });
  setSharedDocRegistry(registry);
  const status = statusStore(hostStatus());
  setCollabStatusStore(status);
  const created: Command[] = [];
  let pendingCreate: Deferred<Thread> | null = null;
  const threads: Thread[] = [];
  const calls = installFetch({
    "POST /api/markdown-reviews": (body) => ({ ...newReview(PATH, (body as { snapshot: string }).snapshot, "local-review"), enabled: true }),
    "GET /api/collab/docs/d1/threads": () => threads,
    "GET /api/collab/commands": () => ({ pending: [], failed: [] }),
    "POST /api/collab/docs/d1/threads": async (body) => {
      const request = body as { id: string; anchorId: string; quote: string; body: string };
      pendingCreate = deferred<Thread>();
      const thread = await pendingCreate.promise;
      return { ...thread, id: request.id, anchorId: request.anchorId, quote: request.quote, messages: [message(request.id, request.id, OWNER, request.body)] };
    },
    "POST /api/collab/commands": (body) => { created.push(body as Command); return new Response(JSON.stringify({ id: (body as Command).id, queued: true }), { status: 202 }); },
    "GET /api/collab/projects/p1/members": () => [{ ...BOB, email: "bob@example.test", role: "editor", joinedAt: "" }],
  });
  try {
    await registry.bindTab("t1", PATH);
    const session = registry.sessionForTab("t1")!;
    await session.replica.whenAttached();
    const ytext = session.replica.ytext;
    const first = TEXT.indexOf("First paragraph here.");
    const second = TEXT.indexOf("Second paragraph here.");
    addAnchor(session.replica.annotations, ytext, first, first + 21, { id: "anc_bob_00001", kind: "comment", createdBy: BOB.id });
    addAnchor(session.replica.annotations, ytext, second, second + 22, { id: "anc_ai_000001", kind: "comment", createdBy: OWNER.id });
    threads.push(
      threadRecord("thr_bob_00001", "anc_bob_00001", "First paragraph here.", BOB, "Should this say **wolves**? <img src=x onerror=\"globalThis.pwned=1\">"),
      threadRecord("thr_ai_000001", "anc_ai_000001", "Second paragraph here.", OWNER, "Consider a shorter sentence.", { kind: "ai", onBehalfOf: OWNER.id, feature: "review-comments" }),
      threadRecord("thr_lost_0001", "anc_not_synced", "Gone text", BOB, "Where did this go?"),
    );
    await render(provider(tab("t1", PATH, TEXT), () => ytext.toString(), [createElement(Probe, { key: "probe" }), createElement(ReviewComments, { key: "comments" })]));
    await flush(6);
    assert.ok(reviewOf().shared, "the tab is reviewed through the shared store");
    assert.equal(reviewOf().doc?.threads.length, 3);

    // Authors, colours and the AI label.
    const bobCard = card("wolves")!;
    assert.ok(bobCard, "Bob's thread is listed");
    assert.match(bobCard.textContent ?? "", /Bob Builder/);
    assert.equal((bobCard.querySelector(".review-comment-avatar") as HTMLElement).style.background.replace(/\s/g, ""), "rgb(22,163,74)");
    assert.match(card("shorter sentence")!.textContent ?? "", /AI · requested by Olive Owner/);
    // Ordered by position: the anchored ones first, the unsynced one last.
    assert.deepEqual(reviewOf().doc!.threads.map((item) => item.id), ["thr_bob_00001", "thr_ai_000001", "thr_lost_0001"]);
    assert.match(card("Where did this go")!.textContent ?? "", /has not synced yet/);

    // Expanded: the body goes through the Markdown renderer; raw HTML stays text.
    await click(bobCard.querySelector("button[aria-expanded]"));
    const expanded = card("wolves")!;
    assert.equal(expanded.querySelector(".review-comment-body strong")?.textContent, "wolves");
    assert.equal(expanded.querySelector("img"), null);
    assert.equal((globalThis as { pwned?: number }).pwned, undefined);
    assert.equal(button("Edit comment", expanded), undefined, "only your own messages can be edited");
    assert.ok(button("Delete comment", expanded), "the owner may delete the thread");
    assert.ok(button("Resolve", expanded));

    // A new comment shows "Sending…" until the server answers.
    let sent!: Promise<boolean>;
    await act(async () => { sent = reviewOf().action("comment", { range: { start: second, end: second + 22 }, text: "Mine", mentions: [BOB.id] }); });
    await flush();
    assert.ok(card("Mine")?.querySelector('.review-comment-pending[data-state="sending"]'), "pending while sending");
    const createCall = calls.find((call) => call.method === "POST" && call.path === "/api/collab/docs/d1/threads");
    assert.deepEqual((createCall?.body as { mentions?: string[] } | undefined)?.mentions, [BOB.id], "picked mentions are sent");
    pendingCreate!.resolve(threadRecord("x", "x", "x", OWNER, "x"));
    await act(async () => { assert.equal(await sent, true); });
    await flush();
    assert.equal(card("Mine")?.querySelector(".review-comment-pending"), null, "the chip goes when the server confirms");

    // Offline: queued, then settled by the host.
    status.setStatus(hostStatus({ connection: "offline" }));
    await act(async () => { await reviewOf().action("comment", { range: { start: first, end: first + 21 }, text: "Offline one" }); });
    await flush();
    const queued = created.at(-1)!;
    assert.equal(queued.kind, "thread.create");
    assert.ok(card("Offline one")?.querySelector('.review-comment-pending[data-state="queued"]'), "pending while queued");
    const body = queued.kind === "thread.create" ? queued.body : null;
    await act(async () => {
      bridge.emit({ t: "command-settled", id: queued.id, kind: "thread.create", ok: true, status: 201, body: { ...threadRecord(body!.id, body!.anchorId, body!.quote, OWNER, body!.body) } });
    });
    await flush();
    assert.equal(card("Offline one")?.querySelector(".review-comment-pending"), null, "command-settled clears the chip");

    // A refusal keeps the card with Retry and Discard.
    await act(async () => { await reviewOf().action("comment", { range: { start: first, end: first + 21 }, text: "Refused one" }); });
    await flush();
    const refused = created.at(-1)!;
    await act(async () => {
      bridge.emit({ t: "command-settled", id: refused.id, kind: "thread.create", ok: false, status: 403, body: null, error: { code: "forbidden", message: "Your role changed." } });
    });
    await flush();
    const failedCard = card("Refused one")!;
    assert.match(failedCard.querySelector('[role="alert"]')?.textContent ?? "", /Not sent: Your role changed\./);
    const discards: string[] = [];
    calls.length = 0;
    await click(button("Discard", failedCard));
    for (const call of calls) if (call.method === "DELETE") discards.push(call.path);
    assert.deepEqual(discards, [`/api/collab/commands/${refused.id}`]);
    assert.equal(card("Refused one"), undefined, "discarded");
    status.setStatus(hostStatus());

    // Deleting the anchored text detaches the thread and offers reattach.
    await act(async () => { ytext.delete(first, 21); });
    await flush(4);
    const detached = card("wolves")!;
    assert.match(detached.textContent ?? "", /The text this comment was attached to was deleted\./);
    assert.ok(button("Reattach to selection", detached));
  } finally {
    await cleanup();
    setSharedDocRegistry(null);
    setCollabStatusStore(null);
    bridge.remove();
    harness.close();
  }
});

test("a local document never calls the collaboration routes", async () => {
  const harness = createHarness({ text: TEXT });
  const { registry } = harness.registry({ paths: ["Shared/other.md"] });
  setSharedDocRegistry(registry);
  const calls = installFetch({
    "POST /api/markdown-reviews": (body) => ({ ...newReview("Local/a.md", (body as { snapshot: string }).snapshot, "local-a"), enabled: true }),
  });
  try {
    await render(provider(tab("local", "Local/a.md", "Hello there"), () => "Hello there", [createElement(Probe, { key: "probe" }), createElement(ReviewComments, { key: "comments" })]));
    await flush(4);
    assert.equal(reviewOf().shared, null);
    assert.equal(reviewOf().doc?.key, "Local/a.md");
    await act(async () => { assert.equal(await reviewOf().action("toggle", { enabled: true }), true); });
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((call) => call.path === "/api/markdown-reviews"), JSON.stringify(calls.map((call) => call.path)));
  } finally {
    await cleanup();
    setSharedDocRegistry(null);
    harness.close();
  }
});

test("the @ picker fills mentions with member ids", async () => {
  assert.deepEqual(mentionQueryAt("Hi @bo", 6), { start: 3, query: "bo" });
  assert.equal(mentionQueryAt("mail a@b", 8), null, "an @ inside a word is not a mention");
  assert.deepEqual(mentionIds("@Bob Builder and @Ann", [{ id: "u-bob", displayName: "Bob Builder" }, { id: "u-ann", displayName: "Ann" }, { id: "u-gone", displayName: "Gone" }]), ["u-bob", "u-ann"]);

  const members = [{ id: "u-bob", displayName: "Bob Builder", email: "bob@example.test" }, { id: "u-owner", displayName: "Olive Owner" }];
  function Field() {
    const [text, setText] = useState("");
    const [ids, setIds] = useState<string[]>([]);
    return createElement("div", null,
      createElement(MentionTextarea, { projectId: "p1", value: text, members, selfId: "u-owner", "aria-label": "Comment", onChange: setText, onMentionsChange: setIds }),
      createElement("output", { "data-mentions": ids.join(",") }));
  }
  const mounted = await render(createElement(Field));
  try {
    const textarea = mounted.host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, "Ping @bo");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    const options = [...mounted.host.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    assert.equal(options.length, 1, "the author is not offered");
    assert.match(options[0] ?? "", /Bob Builder/);
    await act(async () => {
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    assert.equal(textarea.value, "Ping @Bob Builder ");
    assert.equal(mounted.host.querySelector("output")?.getAttribute("data-mentions"), "u-bob");
    assert.equal(mounted.host.querySelector('[role="listbox"]'), null);
  } finally {
    await cleanup();
  }
});

test("desktop notifications only for background windows, with a setting, opening the document", async () => {
  const shown: { title: string; options?: NotificationOptions; instance: { onclick: (() => void) | null; closed: boolean } }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requested = 0;
    static async requestPermission() { FakeNotification.requested += 1; FakeNotification.permission = "granted"; return "granted" as const; }
    onclick: (() => void) | null = null;
    closed = false;
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, options, instance: this }); }
    close() { this.closed = true; }
  }
  let focused = true;
  let focusCalls = 0;
  const environment: DesktopNotificationEnvironment = {
    Notification: FakeNotification as unknown as DesktopNotificationEnvironment["Notification"],
    hasFocus: () => focused,
    focusWindow: () => { focusCalls += 1; },
    enabled: () => dom.window.localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) !== "off",
  };
  const notification = { id: "n1", kind: "mention" as const, projectId: "p1", docId: "d1", payload: { author: { displayName: "Bob" }, excerpt: "Look here" }, createdAt: "", readAt: null };
  const opened: string[] = [];
  assert.equal(await showDesktopNotification(notification, (target) => opened.push(target.docId), environment), null, "not while the window is focused");
  focused = false;
  dom.window.localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, "off");
  assert.equal(await showDesktopNotification(notification, (target) => opened.push(target.docId), environment), null, "not when turned off");
  dom.window.localStorage.removeItem(DESKTOP_NOTIFICATIONS_KEY);
  assert.ok(await showDesktopNotification(notification, (target) => opened.push(target.docId), environment));
  assert.equal(FakeNotification.requested, 1, "permission is asked once");
  assert.equal(shown[0].title, "You were mentioned");
  assert.match(String(shown[0].options?.body), /Bob mentioned you: Look here/);
  shown[0].instance.onclick?.();
  assert.deepEqual(opened, ["d1"]);
  assert.equal(focusCalls, 1);
  assert.equal(shown[0].instance.closed, true);
});
