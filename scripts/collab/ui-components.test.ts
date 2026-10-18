import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { button, cleanup, click, dom, flush, render } from "./ui-support";
import type { SyncState, SyncStatus } from "../../src/lib/collab/protocol/local";
import { formatAge, initials, readableTextColor, syncWording } from "../../src/lib/collab/ui/wording";

afterEach(cleanup);

const NOW = 1_800_000_000_000;

function status(state: SyncState, overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { state, pending: 0, oldestPendingAgeMs: 0, lastAckAt: null, connected: true, ...overrides };
}

test("pill wording for each of the seven states", () => {
  const cases: Array<[SyncState, Partial<SyncStatus>, string, RegExp]> = [
    ["loading", {}, "Loading…", /Opening the shared document/],
    ["saved-local", { pending: 2, oldestPendingAgeMs: 4000 }, "Saved on this device", /not yet in the shared workspace\. 2 changes waiting, oldest 4 s\./],
    ["syncing", { pending: 3, oldestPendingAgeMs: 90_000 }, "Syncing 3…", /Sending 3 changes .* Oldest waiting 2 min\./],
    ["saved-remote", { lastAckAt: NOW - 30_000 }, "Saved to workspace", /Everything is saved to the shared workspace\. Last confirmed 30 s ago\./],
    ["offline", { pending: 1, connected: false, oldestPendingAgeMs: 7_200_000 }, "Offline — 1 change on this device", /^Offline — changes are saved on this device.*oldest 2 h/],
    ["read-only", {}, "Read-only — update required", /newer version of Libera/],
    ["access-changed", {}, "Access changed", /access to this notebook changed/],
  ];
  for (const [state, overrides, label, detail] of cases) {
    const wording = syncWording(status(state, overrides), NOW);
    assert.equal(wording.label, label, state);
    assert.match(wording.detail, detail, state);
  }
  assert.equal(syncWording(status("offline"), NOW).label, "Offline");
  assert.equal(syncWording(status("syncing"), NOW).label, "Syncing…");
  assert.match(syncWording(status("saved-local", { detail: "Host restarting." }), NOW).detail, /Host restarting\.$/);
  assert.notEqual(syncWording(status("saved-local"), NOW).tone, syncWording(status("saved-remote"), NOW).tone, "device and workspace look different");
});

test("helpers: ages, initials and readable text colours", () => {
  assert.deepEqual([500, 12_000, 125_000, 3 * 3_600_000, 3 * 86_400_000].map(formatAge), ["now", "12 s", "2 min", "3 h", "3 d"]);
  assert.equal(initials("Minh Tran Van"), "MV");
  assert.equal(initials("ada"), "A");
  assert.equal(initials("  "), "?");
  assert.equal(initials("élodie durand"), "ÉD");
  assert.equal(readableTextColor("#ffffff"), "#000000");
  assert.equal(readableTextColor("#1e3a8a"), "#ffffff");
  assert.equal(readableTextColor("#ca8a04"), "#000000");
  assert.equal(readableTextColor("not a colour"), "#ffffff");
});

test("CollabStatusPill renders icon, label, tone and a tooltip with pending details", async () => {
  const { createElement } = await import("react");
  const { CollabStatusPill } = await import("../../src/components/libera/collab/collab-status-pill");
  const states: SyncState[] = ["loading", "saved-local", "syncing", "saved-remote", "offline", "read-only", "access-changed"];
  const view = await render(createElement("div", null, states.map((state) => createElement(CollabStatusPill, { key: state, status: status(state, { pending: state === "syncing" ? 4 : 0, oldestPendingAgeMs: 61_000 }), now: NOW }))));
  const pills = [...view.host.querySelectorAll<HTMLElement>("[data-state]")];
  assert.deepEqual(pills.map((pill) => pill.dataset.state), states);
  for (const pill of pills) {
    assert.ok(pill.querySelector("svg"), "every state has an icon");
    assert.ok(pill.getAttribute("aria-label")?.includes(". "), "label and detail are announced");
    assert.equal(pill.tabIndex, 0, "keyboard users can reach the tooltip");
  }
  const local = pills[1];
  const remote = pills[3];
  assert.equal(local.textContent, "Saved on this device");
  assert.equal(remote.textContent, "Saved to workspace");
  assert.equal(local.dataset.tone, "local");
  assert.equal(remote.dataset.tone, "ok");
  assert.notEqual(local.querySelector("svg")?.getAttribute("class"), remote.querySelector("svg")?.getAttribute("class"), "different icons");

  const { act } = await import("react");
  await act(async () => {
    pills[2].dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    pills[2].dispatchEvent(new dom.window.FocusEvent("focus"));
  });
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.ok(tooltip, "focus shows the tooltip");
  assert.match(tooltip!.textContent!, /Syncing 4…/);
  assert.match(tooltip!.textContent!, /4 pending · oldest 1 min/);
  assert.equal(pills[2].getAttribute("aria-describedby"), tooltip!.id);
  await view.unmount();
});

test("CollabStatusPill compact mode and click", async () => {
  const { createElement } = await import("react");
  const { CollabStatusPill } = await import("../../src/components/libera/collab/collab-status-pill");
  let clicks = 0;
  const view = await render(createElement(CollabStatusPill, { status: status("access-changed"), compact: true, onClick: () => (clicks += 1) }));
  const pill = view.host.querySelector("button")!;
  assert.equal(pill.textContent, "", "compact shows the icon only");
  assert.match(pill.getAttribute("aria-label")!, /^Access changed\./);
  await click(pill);
  assert.equal(clicks, 1);
  await view.unmount();
});

const PEOPLE = [
  { clientId: 1, name: "Minh Tran", color: "#2563eb", section: "Introduction" },
  { clientId: 2, name: "Ada Lovelace", color: "#ca8a04" },
  { clientId: 3, name: "Grace Hopper", color: "#db2777", section: "Methods" },
  { clientId: 4, name: "Alan Turing", color: "#16a34a" },
  { clientId: 5, name: "Katherine Johnson", color: "#7c3aed", section: "Results" },
  { clientId: 6, name: "Hedy Lamarr", color: "#0891b2" },
];

test("PresenceAvatars overlaps up to max, overflows into +N, and follows on click", async () => {
  const { createElement } = await import("react");
  const { PresenceAvatars } = await import("../../src/components/libera/collab/presence-avatars");
  const followed: Array<number | string> = [];
  const view = await render(createElement(PresenceAvatars, { users: PEOPLE, max: 4, followingClientId: 3, onFollow: (id: number | string) => followed.push(id) }));
  const avatars = [...view.host.querySelectorAll<HTMLButtonElement>("button.libera-collab-avatar:not([data-overflow-trigger])")];
  assert.equal(avatars.length, 3, "max includes the overflow button");
  assert.deepEqual(avatars.map((avatar) => avatar.textContent), ["MT", "AL", "GH"]);
  assert.equal(avatars[0].getAttribute("aria-label"), "Follow Minh Tran — Introduction");
  assert.equal(avatars[2].getAttribute("aria-pressed"), "true", "the followed person is marked");
  assert.equal(avatars[1].querySelector("span")?.getAttribute("style")?.includes("color: rgb(0, 0, 0)"), true, "dark text on a light colour");

  const overflow = view.host.querySelector<HTMLButtonElement>("[data-overflow-trigger]")!;
  assert.equal(overflow.textContent, "+3");
  assert.equal(overflow.getAttribute("aria-label"), "3 more people");
  assert.equal(overflow.getAttribute("aria-expanded"), "false");
  await click(avatars[0]);
  assert.deepEqual(followed, [1]);

  await click(overflow);
  const list = view.host.querySelector('[aria-label="More people"]')!;
  assert.deepEqual([...list.querySelectorAll("li")].map((item) => item.textContent), ["AT" + "Alan Turing", "KJ" + "Katherine Johnson" + "Results", "HL" + "Hedy Lamarr"]);
  await click(button("Katherine", list));
  assert.deepEqual(followed, [1, 5]);
  assert.ok(!view.host.querySelector('[aria-label="More people"]'), "choosing closes the list");

  await click(overflow);
  const { act } = await import("react");
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.ok(!view.host.querySelector('[aria-label="More people"]'), "Escape closes the list");
  assert.ok(document.activeElement === overflow, "focus returns to +N");
  await view.unmount();
});

test("PresenceAvatars without overflow, and the quiet-mode toggle", async () => {
  const { createElement } = await import("react");
  const { PresenceAvatars } = await import("../../src/components/libera/collab/presence-avatars");
  const quietCalls: boolean[] = [];
  const view = await render(createElement(PresenceAvatars, { users: PEOPLE.slice(0, 2), quiet: false, onQuietChange: (quiet: boolean) => quietCalls.push(quiet) }));
  assert.ok(!view.host.querySelector("[data-overflow-trigger]"));
  assert.equal(view.host.querySelectorAll("button.libera-collab-avatar").length, 2);
  const toggle = button("Quiet mode", view.host)!;
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  await click(toggle);
  assert.deepEqual(quietCalls, [true]);
  await view.rerender(createElement(PresenceAvatars, { users: [], quiet: true, onQuietChange: () => {} }));
  assert.equal(button("Quiet mode", view.host)?.getAttribute("aria-pressed"), "true", "the toggle stays when alone");
  await view.rerender(createElement(PresenceAvatars, { users: [] }));
  assert.equal(view.host.innerHTML, "", "nothing to show");
  await view.unmount();
});

test("RejectedEditBanner copies the unsynced text; AccessChangedBanner exports", async () => {
  const { createElement, Fragment } = await import("react");
  const { AccessChangedBanner, RejectedEditBanner } = await import("../../src/components/libera/collab/collab-banners");
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  let exports = 0;
  let dismissed = 0;
  const view = await render(
    createElement(
      Fragment,
      null,
      createElement(RejectedEditBanner, { rejectedText: "my paragraph", reason: "You are now a commenter.", onDismiss: () => (dismissed += 1) }),
      createElement(AccessChangedBanner, { onExport: () => (exports += 1) }),
    ),
  );
  const alerts = view.host.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].textContent!, /Some of your changes were not accepted \(role changed\)/);
  assert.match(alerts[0].textContent!, /You are now a commenter\./);
  await click(button("Copy my unsynced text", alerts[0]));
  assert.deepEqual(copied, ["my paragraph"]);
  assert.match(alerts[0].textContent!, /Copied/);
  await click(button("Dismiss", alerts[0]));
  assert.equal(dismissed, 1);
  assert.match(alerts[1].textContent!, /access to this notebook changed/);
  await click(button("Export", alerts[1]));
  assert.equal(exports, 1);
  await flush();
  await view.unmount();
});
