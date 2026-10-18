// A jsdom window for the edlib tests. Import it before any editor module:
// lib0/dom (used by y-codemirror.next's remote carets) captures `document`
// when it loads.
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "DOMParser", "MutationObserver", "KeyboardEvent", "MouseEvent", "Event"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, "getComputedStyle", { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
// jsdom cannot lay out text, so CodeMirror's measure pass is never scheduled.
for (const target of [globalThis, dom.window]) {
  Object.defineProperty(target, "requestAnimationFrame", { value: () => 0, configurable: true });
  Object.defineProperty(target, "cancelAnimationFrame", { value: () => {}, configurable: true });
}
