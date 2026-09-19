// Electron 37's UpdateWindowAccentColor runs after focus/blur notifications and
// resets DWMWA_CAPTION_COLOR, exposing a native caption behind transparent UI.
// Reapplying the material restores DWMWA_COLOR_NONE for the caption while
// leaving the DWM border, shadow and sizing frame intact.
// https://github.com/electron/electron/blob/v37.6.0/shell/browser/native_window_views_win.cc
function maintainWindowsBackdrop(window, nativeTheme, material = "acrylic") {
  let pending = null;

  const refresh = () => {
    if (pending !== null || window.isDestroyed()) return;
    // Must run after Electron finishes its native focus/theme message handler.
    pending = setImmediate(() => {
      pending = null;
      if (!window.isDestroyed()) window.setBackgroundMaterial(material);
    });
  };

  window.on("focus", refresh);
  window.on("blur", refresh);
  window.on("show", refresh);
  nativeTheme.on("updated", refresh);
  // Accent-color changes can repaint the caption without changing focus/theme.
  const messages = [0x0320, 0x001a]; // WM_DWMCOLORIZATIONCOLORCHANGED, WM_SETTINGCHANGE
  for (const message of messages) window.hookWindowMessage(message, refresh);

  window.once("closed", () => {
    if (pending !== null) clearImmediate(pending);
    nativeTheme.removeListener("updated", refresh);
    // Native message hooks are released with the HWND on destruction.
  });
  refresh();
}

module.exports = { maintainWindowsBackdrop };
