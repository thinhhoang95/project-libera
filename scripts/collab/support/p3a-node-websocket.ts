// Node's own Event, captured before a jsdom window replaces the global.
// Node's WebSocket (undici) dispatches its events through Node's EventTarget,
// which refuses events built on a jsdom Event; tests that open real sockets
// and a jsdom window restore it (restoreNodeEvent) after importing the window.
const NodeEvent = globalThis.Event;

export function restoreNodeEvent(): void {
  Object.defineProperty(globalThis, "Event", { value: NodeEvent, configurable: true, writable: true });
}
