const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createPreferencesOverlay } = require("../../electron/preferences-overlay.cjs");

function createHost() {
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => Boolean(this.destroyed);
      this.webContents.focus = () => { this.focused = true; };
      this.webContents.close = () => {
        this.destroyed = true;
        this.webContents.emit("destroyed");
      };
    }
    setBackgroundColor(color) { this.background = color; }
    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const parent = new EventEmitter();
  const container = new EventEmitter();
  let size = { width: 1200, height: 800 };
  container.getBounds = () => size;
  container.addChildView = (child) => { container.child = child; };
  container.removeChildView = () => { container.child = null; };
  parent.contentView = container;
  parent.isDestroyed = () => Boolean(parent.destroyed);
  parent.focus = () => { parent.focused = true; };
  parent.webContents = { focus: () => { parent.workspaceFocused = true; } };
  const host = createPreferencesOverlay(parent, { WebContentsView, preload: "/preload.cjs" });
  const view = container.child;
  return { host, parent, view, resize: (next) => { size = next; container.emit("bounds-changed"); } };
}

test("Preferences covers the parent content, tracks resizing, and focuses only after loading", () => {
  const { host, parent, view, resize } = createHost();
  assert.equal(view.background, "#00000000");
  assert.equal(view.visible, false);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1200, height: 800 });
  view.webContents.emit("did-finish-load");
  assert.equal(view.visible, true);
  assert.equal(view.focused, true);
  resize({ width: 900, height: 650 });
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 900, height: 650 });
  let closed = 0;
  host.on("closed", () => { closed += 1; });
  host.close();
  host.close();
  assert.equal(closed, 1);
  assert.equal(view.destroyed, true);
  assert.equal(parent.contentView.child, null);
  assert.equal(parent.workspaceFocused, true);
  assert.equal(parent.contentView.listenerCount("bounds-changed"), 0);
  assert.equal(parent.listenerCount("closed"), 0);
  assert.equal(parent.destroyed, undefined);
});

test("Closing the parent or losing the settings renderer cleans up the overlay", () => {
  for (const cause of ["parent", "renderer"]) {
    const { host, parent, view } = createHost();
    if (cause === "parent") {
      parent.destroyed = true;
      parent.emit("closed");
    } else {
      view.webContents.close();
    }
    assert.equal(host.isDestroyed(), true);
    assert.equal(view.destroyed, true);
    assert.equal(parent.contentView.listenerCount("bounds-changed"), 0);
  }
});

test("Preferences dismisses through its own bridge and prevents dismissal during save", async () => {
  let closes = 0;
  let requestClose;
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: "http://localhost/?mode=configuration&presentation=overlay",
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ hasApiKey: true, hasPasswordHash: true, dataDir: "/tmp/notebooks" }),
        close: () => { closes += 1; },
        onRequestClose: (listener) => { requestClose = listener; },
      };
      window.liberaWindow = { close: () => assert.fail("Must not close the main app window") };
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const { document, KeyboardEvent, MouseEvent } = dom.window;
    assert.equal(document.documentElement.dataset.presentation, "overlay");
    assert.equal(document.querySelector('[role="dialog"]').getAttribute("aria-modal"), "true");
    document.querySelector("#header-close-button").click();
    document.querySelector("#close-button").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelector("main").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    requestClose();
    assert.equal(closes, 5);
    document.querySelector("#setup-form").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    assert.equal(closes, 5);
    document.querySelector("#save-button").disabled = true;
    requestClose();
    document.querySelector("#header-close-button").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(closes, 5);
  } finally {
    dom.window.close();
  }
});
