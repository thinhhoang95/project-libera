import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler } from "react";
import { draftRevision } from "../../src/components/libera/tab-chrome";
import { useDependencyVersion } from "../../src/components/libera/latex/latex-dependencies";
import type { OpenTab } from "../../src/components/libera/types";

function setupDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return dom;
}

function tabOf(id: string, draft: string): OpenTab {
  const file = { path: `Notes/${id}.tex`, name: `${id}.tex`, fileType: "latex", notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"];
  return { id, draft, saved: draft, status: "clean", file };
}

type Updated = ReadonlyMap<string, string | number | undefined>;
const NO_UPDATES: Updated = new Map();

async function mount() {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const state = { tabs: [tabOf("dep", "one"), tabOf("other", "x")], reads: 0, renders: 0, version: "" };
  const readOpenTabs = () => { state.reads++; return state.tabs; };
  const paths = ["Notes/dep.tex"];
  function Host({ updatedAt }: { updatedAt: Updated }) {
    state.version = useDependencyVersion(paths, readOpenTabs, updatedAt);
    return createElement(Profiler, { id: "h", onRender: () => { state.renders++; } }, null);
  }
  const render = async (updatedAt: Updated = NO_UPDATES) => { await act(async () => root.render(createElement(Host, { updatedAt }))); };
  /** What libera-app.tsx does: replace the tabs and publish the keys that changed. */
  const edit = async (id: string, draft: string) => {
    const previous = state.tabs;
    state.tabs = previous.map((tab) => (tab.id === id ? { ...tab, draft } : tab));
    await act(async () => { draftRevision.publish(previous, state.tabs); });
  };
  return { state, render, edit, cleanup: () => { act(() => root.unmount()); dom.window.close(); } };
}

test("an idle dependency version does no work while nothing changes", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const host = await mount();
  try {
    await host.render();
    const reads = host.state.reads;
    const renders = host.state.renders;
    const first = host.state.version;
    assert.ok(first);
    // Only the slow fallback (30 s) may look, and it renders nothing when nothing changed.
    await act(async () => { mock.timers.tick(29_000); });
    assert.equal(host.state.reads, reads, `signature computed ${host.state.reads - reads} times in 29 s`);
    await act(async () => { mock.timers.tick(31_000); });
    assert.equal(host.state.renders, renders, "no render while idle");
    assert.equal(host.state.version, first);
  } finally { host.cleanup(); mock.timers.reset(); }
});

test("a draft publication of the dependency changes the version once; another tab's changes nothing", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const host = await mount();
  try {
    await host.render();
    const first = host.state.version;
    const reads = host.state.reads;
    await host.edit("other", "y");
    assert.equal(host.state.reads, reads, "an unrelated tab triggers no recomputation");
    assert.equal(host.state.version, first);
    await host.edit("dep", "two");
    assert.notEqual(host.state.version, first, "the dependency's text changed the version");
    const second = host.state.version;
    await act(async () => { mock.timers.tick(5000); });
    assert.equal(host.state.version, second);
  } finally { host.cleanup(); mock.timers.reset(); }
});

test("a change on disk (updatedAt) changes the version", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const host = await mount();
  try {
    host.state.tabs = [tabOf("other", "x")];
    await host.render(new Map([["Notes/dep.tex", "t1"]]));
    const first = host.state.version;
    assert.ok(first);
    await host.render(new Map([["Notes/dep.tex", "t2"]]));
    assert.notEqual(host.state.version, first);
  } finally { host.cleanup(); mock.timers.reset(); }
});

test("a hidden window does no work; showing it checks at once", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const host = await mount();
  try {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    await host.render();
    await act(async () => { mock.timers.tick(60_000); });
    assert.equal(host.state.reads, 0, "no work while hidden");
    assert.equal(host.state.version, "");
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    assert.ok(host.state.version, "showing the window computes the version");
  } finally { host.cleanup(); mock.timers.reset(); }
});
