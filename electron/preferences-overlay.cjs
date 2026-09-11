const { EventEmitter } = require("node:events");

// Keep the settings renderer isolated, but compose it over the workspace rather
// than placing a second native window (and its frame) around the dialog.
function createPreferencesOverlay(parentWindow, { WebContentsView, preload }) {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
  });
  const host = new EventEmitter();
  const container = parentWindow.contentView;
  let closed = false;
  host.webContents = view.webContents;
  host.isDestroyed = () => closed;
  host.focus = () => {
    if (!closed && !parentWindow.isDestroyed()) {
      parentWindow.focus();
      view.webContents.focus();
    }
  };

  function resize() {
    if (closed || parentWindow.isDestroyed()) return;
    const { width, height } = container.getBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  host.close = () => {
    if (closed) return;
    closed = true;
    container.removeListener("bounds-changed", resize);
    parentWindow.removeListener("closed", host.close);
    if (!parentWindow.isDestroyed()) {
      container.removeChildView(view);
      parentWindow.webContents.focus();
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
    host.emit("closed");
  };

  view.setBackgroundColor("#00000000");
  view.setVisible(false);
  container.addChildView(view);
  container.on("bounds-changed", resize);
  parentWindow.once("closed", host.close);
  view.webContents.once("destroyed", host.close);
  view.webContents.once("did-finish-load", () => {
    if (closed) return;
    view.setVisible(true);
    host.focus();
  });
  resize();
  return host;
}

module.exports = { createPreferencesOverlay };
