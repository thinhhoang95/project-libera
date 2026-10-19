const { randomUUID } = require("node:crypto");

// The renderer must finish its batched saves while the local server is alive.
function requestStateFlush(contents, ipcMain, timeoutMs = 10_000) {
  if (!contents || contents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    // Capture this while alive; accessing mainFrame after destruction throws.
    const frame = contents.mainFrame;
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener("state:flushed", reply);
      contents.removeListener("destroyed", destroyed);
    };
    const destroyed = () => {
      cleanup();
      reject(new Error("The window closed before its session finished saving. Reopen Libera to recover the last checkpoint."));
    };
    const reply = (event, requestId, error) => {
      if (event.sender !== contents || requestId !== id) return;
      if (contents.isDestroyed()) { destroyed(); return; }
      if (event.senderFrame !== frame) return;
      cleanup();
      if (error) reject(new Error(String(error))); else resolve();
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Saving the session timed out. Please try closing Libera again.")); }, timeoutMs);
    ipcMain.on("state:flushed", reply);
    contents.once("destroyed", destroyed);
    try { contents.send("state:flush", id); }
    catch (error) { cleanup(); reject(error); }
  });
}
module.exports = { requestStateFlush };
