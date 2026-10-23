import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { OpenTab } from "../../src/components/libera/types";

function tab(path: string, fileType: string, extra: Partial<OpenTab> = {}): OpenTab {
  const name = path.split("/").at(-1)!;
  return { id: path, file: { kind: "file", name, path, fileType }, draft: "", saved: "", ...extra } as unknown as OpenTab;
}

test("the palette offers Generate and Show definitions, and Generate asks the AI panel for a run", async () => {
  const dom = new JSDOM("<!doctype html><body><div id=\"root\"></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "localStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  for (const [key, value] of Object.entries({ IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  const { collectPaletteCommands } = await import("../../src/components/libera/command-palette/commands");
  const { DefinitionsPaletteCommands } = await import("../../src/components/libera/definitions-panel");
  const { OUTLINE_VIEW_EVENT, readStoredOutlineView } = await import("../../src/components/libera/outline-view");
  const { DEFINITIONS_REQUEST_EVENT, DEFINITIONS_RUN_FINISHED_EVENT } = await import("../../src/lib/definitions");

  const root = createRoot(dom.window.document.getElementById("root")!);
  let shown = 0;
  const render = (activeTab: OpenTab | null) => act(() => root.render(createElement(DefinitionsPaletteCommands, { activeTab, onShow: () => { shown++; } })));
  const commands = () => collectPaletteCommands(null).filter((command) => command.group === "Definitions");

  await render(null);
  assert.deepEqual(commands().map((command) => [command.title, Boolean(command.disabled)]), [["Generate definitions", true], ["Show definitions", false]]);
  await render(tab("Notes/draft.md", "markdown", { untitled: true }));
  assert.match(commands()[0].detail ?? "", /Save this document/);
  await render(tab("Notes/photo.png", "image"));
  assert.equal(commands()[0].disabled, true);

  await render(tab("Research/paper.pdf", "pdf"));
  const requests: { path: string; requestId: string }[] = [];
  const views: string[] = [];
  dom.window.addEventListener(DEFINITIONS_REQUEST_EVENT, (event) => requests.push((event as CustomEvent).detail));
  dom.window.addEventListener(OUTLINE_VIEW_EVENT, (event) => views.push((event as CustomEvent).detail));
  const [generate, show] = commands();
  assert.equal(generate.disabled, false);
  assert.match(generate.detail ?? "", /reads paper\.pdf/);
  generate.run();
  assert.equal(shown, 1);
  assert.deepEqual(views, ["definitions"]);
  assert.equal(readStoredOutlineView(), "definitions");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "Research/paper.pdf");

  // While the run goes on, Generate waits; the run's end frees it again.
  assert.deepEqual([commands()[0].title, commands()[0].disabled], ["Generating definitions…", true]);
  dom.window.dispatchEvent(new dom.window.CustomEvent(DEFINITIONS_RUN_FINISHED_EVENT, { detail: { requestId: requests[0].requestId } }));
  assert.equal(commands()[0].disabled, false);

  show.run();
  assert.equal(shown, 2);
  assert.deepEqual(views, ["definitions", "definitions"]);
  await act(() => root.unmount());
  assert.deepEqual(commands(), []);
});
