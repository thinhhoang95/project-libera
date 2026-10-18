import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import { REFERENCES_UPDATED_EVENT, type ReferenceLibrary, type ReferenceLibraryOp } from "../../src/lib/references/types";
import {
  applyReferenceOps,
  fetchReferenceLibrary,
  resetReferenceLibraryCache,
  useReferenceLibrary,
} from "../../src/components/libera/references/use-reference-library";

/** A fake /api/references backed by the real pure ops, with a hook to change it behind the client's back. */
function fakeServer() {
  const server = { library: emptyReferenceLibrary(), gets: 0, patches: [] as { revision: number; ops: ReferenceLibraryOp[] }[], beforePatch: [] as (() => void)[] };
  const commit = (ops: ReferenceLibraryOp[]) => {
    const { library, changed } = applyLibraryOps(server.library, ops, new Date().toISOString());
    if (changed) server.library = { ...library, revision: server.library.revision + 1 };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method || init.method === "GET") {
      server.gets += 1;
      assert.match(url, /\/api\/references\?notebook=My%20Notes$/);
      return Response.json({ library: server.library });
    }
    const body = JSON.parse(String(init.body)) as { notebook: string; revision: number; ops: ReferenceLibraryOp[] };
    assert.equal(body.notebook, "My Notes");
    server.patches.push({ revision: body.revision, ops: body.ops });
    server.beforePatch.shift()?.();
    if (body.revision !== server.library.revision) return Response.json({ error: "The reference library changed in another window.", library: server.library }, { status: 409 });
    try { commit(body.ops); } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
    return Response.json({ library: server.library });
  };
  return { server, commit, fetch: fetch as typeof globalThis.fetch };
}

class Channel {
  static open = new Set<Channel>();
  static posted: unknown[] = [];
  listeners: ((event: MessageEvent) => void)[] = [];
  constructor(readonly name: string) { Channel.open.add(this); }
  addEventListener(_type: string, receive: (event: MessageEvent) => void) { this.listeners.push(receive); }
  postMessage(data: unknown) {
    Channel.posted.push(data);
    for (const channel of Channel.open) {
      if (channel !== this && channel.name === this.name) for (const receive of channel.listeners) receive({ data: structuredClone(data) } as MessageEvent);
    }
  }
  close() { Channel.open.delete(this); }
}

test("the client store loads, applies, retries once on a conflict, announces changes and follows other windows", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  for (const key of ["window", "document", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, CustomEvent: dom.window.CustomEvent });
  const originalFetch = globalThis.fetch;
  const originalChannel = globalThis.BroadcastChannel;
  const { server, commit, fetch } = fakeServer();
  globalThis.fetch = fetch;
  globalThis.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
  const events: unknown[] = [];
  window.addEventListener(REFERENCES_UPDATED_EVENT, (event) => events.push((event as CustomEvent).detail));
  const seen: { library: ReferenceLibrary | null; loading: boolean; error: string | null }[] = [];
  let api: ReturnType<typeof useReferenceLibrary> | null = null;
  function Probe() {
    api = useReferenceLibrary("My Notes");
    seen.push({ library: api.library, loading: api.loading, error: api.error });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(seen[0].loading, true);
    assert.equal(seen.at(-1)!.library?.revision, 0);
    assert.equal(seen.at(-1)!.loading, false);
    assert.equal(server.gets, 1);
    assert.equal(Channel.open.size, 1, "one channel listens while the library is shown");

    // A plain change.
    let library!: ReferenceLibrary;
    await act(async () => { library = await api!.apply([{ op: "add", entry: { key: "a", csl: { type: "book", title: "A" } } }]); });
    assert.equal(library.revision, 1);
    assert.equal(seen.at(-1)!.library?.revision, 1);
    assert.deepEqual(events, [{ notebook: "My Notes", revision: 1 }]);
    assert.equal(Channel.posted.length, 1);
    assert.equal((Channel.posted[0] as { notebook: string }).notebook, "My Notes");
    assert.equal(server.gets, 1, "this window's own announcements do not reload it");
    assert.equal(Channel.open.size, 1, "the publishing channel was closed");

    // Another window changed the library: the ops are re-applied once on the newer revision.
    server.beforePatch.push(() => commit([{ op: "add", entry: { key: "b", csl: { type: "book", title: "B" } } }]));
    await act(async () => { library = await applyReferenceOps("My Notes", [{ op: "set-style", style: "ieee" }]); });
    assert.deepEqual(server.patches.slice(-2).map((request) => request.revision), [1, 2]);
    assert.equal(library.revision, 3);
    assert.equal(library.style, "ieee");
    assert.equal(Object.keys(library.entries).length, 2);
    assert.deepEqual(events.at(-1), { notebook: "My Notes", revision: 3 });

    // A second conflict is reported, and the newest library is kept.
    server.beforePatch.push(() => commit([{ op: "set-style", style: "nature" }]), () => commit([{ op: "set-style", style: "vancouver" }]));
    await act(async () => {
      await assert.rejects(applyReferenceOps("My Notes", [{ op: "set-style", style: "apa" }]), /changed in another window/);
    });
    assert.equal(seen.at(-1)!.library?.revision, 5);
    assert.equal(seen.at(-1)!.library?.style, "vancouver");

    // Invalid ops surface the server's message and change nothing.
    await assert.rejects(applyReferenceOps("My Notes", [{ op: "delete", id: "ref_x" }]), /no longer in the library/);

    // Another window announces a change: this one reloads; stale or own messages are ignored.
    commit([{ op: "set-style", style: "apa" }]);
    const remote = new Channel("libera-references");
    await act(async () => {
      remote.postMessage({ sender: "other-window", notebook: "My Notes", revision: 6 });
      remote.postMessage({ sender: "other-window", notebook: "My Notes", revision: 2 });
      remote.postMessage({ sender: "other-window", notebook: "Other", revision: 9 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(server.gets, 2);
    assert.equal(seen.at(-1)!.library?.revision, 6);
    remote.close();

    // Without BroadcastChannel everything still works.
    globalThis.BroadcastChannel = undefined as unknown as typeof BroadcastChannel;
    await act(async () => { library = await applyReferenceOps("My Notes", [{ op: "set-style", style: "ieee" }]); });
    assert.equal(library.revision, 7);

    await act(async () => root.unmount());
    assert.equal(Channel.open.size, 0, "the listening channel is closed when nothing shows the library");

    resetReferenceLibraryCache();
    assert.equal((await fetchReferenceLibrary("My Notes")).revision, 7);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.BroadcastChannel = originalChannel;
    resetReferenceLibraryCache();
    dom.window.close();
  }
});
