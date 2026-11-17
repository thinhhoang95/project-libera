// Windows-only investigation harness; never loads Libera or its user profile.
// See docs/audits/2026-11-18-windows-font-discovery.md for commands.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  if (process.platform !== "win32") throw new Error("This diagnostic requires Windows.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "libera-font-probe-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  const child = spawn(require("electron"), [__filename, ...process.argv.slice(2), `--user-data-dir=${profile}`], {
    env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const timer = setTimeout(() => child.kill(), 60_000);
  child.once("error", (error) => { console.error(error); process.exitCode = 1; });
  child.once("close", (code) => {
    clearTimeout(timer);
    try {
      const line = output.split(/\r?\n/).find((entry) => entry.startsWith("FONT_REPORT "));
      if (!line) throw new Error(`No font report (exit ${code}). ${output}`);
      console.log(JSON.stringify(JSON.parse(line.slice("FONT_REPORT ".length)), null, 2));
      process.exitCode = code ?? 1;
    } catch (error) { console.error(error); process.exitCode = 1; }
    // Only the throwaway directory just created above is removed.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, session } = require("electron");
  const http = require("node:http");
  const addonArg = process.argv.find((arg) => arg.startsWith("--refresh-addon="));
  const register = process.argv.includes("--register-local-faces");
  const families = ["B612 Mono", "Berkeley Mono Trial", "Figtree", "Google Sans Code", "IBM Plex Mono", "Inter", "Consolas"];
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const report = { versions: { electron: process.versions.electron, chrome: process.versions.chrome }, register, windows: [] };
    if (addonArg) report.refreshedFamilyCount = require(path.resolve(addonArg.slice("--refresh-addon=".length))).refresh();
    // Permission grants apply only to this throwaway diagnostic session.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "local-fonts");
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "local-fonts"));
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'");
      response.end("<!doctype html><html><body>Font diagnostic</body></html>");
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      for (const sandbox of [true, false]) {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox, nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
        try {
          await win.loadURL(`http://127.0.0.1:${server.address().port}`);
          const result = await win.webContents.executeJavaScript(`(${async function (families, register) {
            const queries = [];
            let fonts;
            for (let i = 0; i < 3; i++) {
              fonts = await window.queryLocalFonts();
              queries.push({ faces: fonts.length, families: [...new Set(fonts.map((font) => font.family))].sort() });
            }
            const localFaces = [];
            for (const family of families) {
              const metadata = fonts.find((font) => font.family === family && font.style === "Regular");
              if (!metadata) { localFaces.push({ family, status: "not enumerated" }); continue; }
              try {
                // local() takes a full or PostScript face name, not generally a family name.
                const face = await new FontFace(family, `local(${JSON.stringify(metadata.fullName)})`).load();
                if (register) document.fonts.add(face);
                localFaces.push({ family, fullName: metadata.fullName, status: "loaded" });
              } catch (error) { localFaces.push({ family, status: error.message }); }
            }
            families.forEach((family, index) => {
              const element = document.createElement("div");
              element.id = `font-${index}`;
              element.style.fontFamily = `${JSON.stringify(family)}, monospace`;
              element.textContent = "Hamburgefontsiv 0123456789";
              document.body.append(element);
            });
            await document.fonts.ready;
            document.body.getBoundingClientRect();
            return { queries, localFaces };
          }})(${JSON.stringify(families)}, ${register})`, true);
          // Complete layout/paint before asking which font actually drew each sample.
          await win.webContents.capturePage();
          win.webContents.debugger.attach("1.3");
          await win.webContents.debugger.sendCommand("DOM.enable");
          await win.webContents.debugger.sendCommand("CSS.enable");
          const { root } = await win.webContents.debugger.sendCommand("DOM.getDocument");
          const rendered = [];
          for (const [index, family] of families.entries()) {
            const { nodeId } = await win.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: `#font-${index}` });
            const { fonts } = await win.webContents.debugger.sendCommand("CSS.getPlatformFontsForNode", { nodeId });
            rendered.push({ requestedFamily: family, fonts });
          }
          win.webContents.debugger.detach();
          report.windows.push({ sandbox, ...result, rendered });
        } finally { win.destroy(); }
      }
      console.log(`FONT_REPORT ${JSON.stringify(report)}`);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    app.quit();
  }).catch((error) => { console.error(error); app.exit(1); });
}
