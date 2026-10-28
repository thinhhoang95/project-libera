// End-to-end check of real-time collaboration with two real Libera desktop
// instances (Electron, production standalone build, LIBERA_COLLAB=1) and the
// real collab server (server/, started in a child process).
//
//   node --import tsx scripts/collab/e2e/two-users.ts
//
// See README.md in this folder for prerequisites and options. Everything the
// run creates lives under one work directory (E2E_WORK_DIR, or a new temp
// dir); screenshots, logs and results.json stay there, the throwaway
// profiles and server data are removed after a passing run unless E2E_KEEP=1.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, startServerProcess, type ServerProcess } from "../support/server-process";
import { DOM, sleep, waitFor, type CdpPage } from "./cdp";
import { generatedPassword, LiberaInstance, PROJECT_ROOT } from "./instance";

// ---------------------------------------------------------------- setup

const WORK = process.env.E2E_WORK_DIR
  ? path.resolve(process.env.E2E_WORK_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  : mkdtempSync(path.join(tmpdir(), "libera-e2e-"));
const SHOTS = path.join(WORK, "screenshots");
const KEEP = process.env.E2E_KEEP === "1";
mkdirSync(SHOTS, { recursive: true });

const NOTEBOOK = "Thesis";
const SEED_NOTES = "# Thesis notes\n\nThis notebook is shared between Alice and Bob.\n\n- first point\n- second point\n";
const SEED_TEX = [
  "\\documentclass{article}",
  "\\title{A Small Paper}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{Introduction}",
  "Collaborative editing keeps both copies in step.",
  "\\end{document}",
  "",
].join("\n");

const RUN_ID = Math.random().toString(36).slice(2, 8);

interface StepResult {
  id: string;
  title: string;
  ok: boolean;
  ms: number;
  notes: string[];
  error?: string;
}
const results: StepResult[] = [];
const timings: Record<string, number> = {};
const observations: string[] = [];
let shotCount = 0;

function log(message: string) {
  const line = `[e2e ${new Date().toISOString().slice(11, 23)}] ${message}`;
  console.log(line);
  appendFileSync(path.join(WORK, "e2e.log"), `${line}\n`);
}

async function shot(page: CdpPage | null, name: string): Promise<void> {
  if (!page) return;
  const file = path.join(SHOTS, `${String(++shotCount).padStart(2, "0")}-${name}.png`);
  try {
    await page.screenshot(file);
  } catch (error) {
    log(`screenshot ${name} failed: ${(error as Error).message}`);
  }
}

let current: StepResult | null = null;
function note(message: string) {
  log(`  · ${message}`);
  current?.notes.push(message);
}
function observe(message: string) {
  log(`  ! ${message}`);
  observations.push(message);
  current?.notes.push(`OBSERVED: ${message}`);
}

/** Runs one step; a hard step's failure aborts the run, a soft one is recorded and the run continues. */
async function step(id: string, title: string, run: () => Promise<void>, options: { soft?: boolean } = {}): Promise<boolean> {
  const result: StepResult = { id, title, ok: false, ms: 0, notes: [] };
  results.push(result);
  current = result;
  log(`STEP ${id}: ${title}`);
  const started = Date.now();
  try {
    await run();
    result.ok = true;
    return true;
  } catch (error) {
    result.error = (error as Error).message;
    log(`  FAILED: ${result.error}`);
    await shot(alice.page, `FAIL-${id}-alice`);
    await shot(bob.page, `FAIL-${id}-bob`);
    if (!options.soft) throw error;
    return false;
  } finally {
    result.ms = Date.now() - started;
    current = null;
    writeResults();
  }
}

function writeResults() {
  writeFileSync(path.join(WORK, "results.json"), `${JSON.stringify({ workDir: WORK, results, timings, observations }, null, 2)}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- page-side expressions

const js = {
  /** Text of the visible CodeMirror editor, from its EditorView. */
  cmText: `(() => { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view; return v ? v.state.doc.toString() : null; })()`,
  /** Visible text of the Visual (Tiptap/ProseMirror) editor. */
  pmText: `(() => { const p = document.querySelector(".ProseMirror"); return p ? p.innerText : null; })()`,
  pill: `(() => { const p = document.querySelector(".libera-shared-tab-chrome [data-state]"); return p ? { state: p.dataset.state, label: (p.textContent || "").trim(), detail: p.getAttribute("aria-label") } : null; })()`,
  sharedDoc: `(document.querySelector(".libera-shared-tab-chrome")?.dataset.sharedDoc ?? null)`,
  presence: `[...document.querySelectorAll('[aria-label="People in this document"] button')].map((b) => b.getAttribute("aria-label"))`,
  rail: `(document.querySelector("button[aria-label^='Collaboration']")?.getAttribute("aria-label") ?? null)`,
  /** Which editor has the keyboard focus: "cm", "pm" or a description of the focused element. */
  focus: `(() => { const a = document.activeElement; if (!a) return "none"; if (a.closest(".cm-content")) return "cm"; if (a.closest(".ProseMirror")) return "pm"; return a.tagName + "." + a.className; })()`,
  /** Element holding the DOM selection's anchor (outerHTML start), to spot a caret stuck in a widget. */
  selectionAt: `(() => { const s = getSelection(); const n = s && s.anchorNode; if (!n) return null; const el = n.nodeType === 3 ? n.parentElement : n; return (el.outerHTML || el.nodeName).slice(0, 120) + " @" + s.anchorOffset; })()`,
  dialogText: `(document.querySelector('[role="dialog"]')?.innerText ?? null)`,
  status: `fetch("/api/collab/status").then(async (r) => ({ http: r.status, body: await r.json().catch(() => null) }))`,
};

async function cmText(page: CdpPage): Promise<string | null> {
  return page.evaluate<string | null>(js.cmText);
}

/** Focuses the editor and moves the caret to the start or end with a real Ctrl+Home / Ctrl+End. */
async function focusEditor(page: CdpPage, kind: "cm" | "pm", where: "end" | "start") {
  const selector = kind === "cm" ? ".cm-content" : ".ProseMirror";
  await page.click(`document.querySelector(${JSON.stringify(selector)})`, `${kind === "cm" ? "CodeMirror" : "Visual"} editor`, 20_000, false);
  await page.key(where === "end" ? "End" : "Home", { code: where === "end" ? "End" : "Home", keyCode: where === "end" ? 35 : 36, modifiers: 2 });
}

async function waitText(page: CdpPage, read: string, includes: string[], what: string, timeoutMs = 15_000): Promise<string> {
  return waitFor(
    async () => {
      const text = await page.evaluate<string | null>(read);
      return text !== null && includes.every((part) => text.includes(part)) ? text : null;
    },
    { timeoutMs, message: what, intervalMs: 25 },
  );
}

async function waitDisk(file: string, includes: string[], what: string, timeoutMs = 15_000): Promise<string> {
  return waitFor(
    () => {
      try {
        const text = readFileSync(file, "utf8");
        return includes.every((part) => text.includes(part)) ? text : null;
      } catch {
        return null;
      }
    },
    { timeoutMs, message: what, intervalMs: 25 },
  );
}

async function waitPill(page: CdpPage, state: string, who: string, timeoutMs = 30_000) {
  return waitFor(
    async () => {
      const pill = await page.evaluate<{ state: string; label: string } | null>(js.pill);
      return pill && pill.state === state ? pill : null;
    },
    { timeoutMs, message: `${who}: status pill to reach "${state}"`, intervalMs: 100 },
  );
}

// ---------------------------------------------------------------- UI flows

async function localLogin(instance: LiberaInstance) {
  const page = instance.page!;
  await page.fill(`document.querySelector("input#password")`, instance.localPassword, "login password field", 60_000);
  await page.click(`document.querySelector("form button[type=submit]")`, "login button");
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[aria-label="Left panel tabs"]') && !!document.querySelector("button[aria-label^='Collaboration']")`), {
    timeoutMs: 30_000,
    message: `${instance.name}: the app shell did not appear after logging in`,
  });
}

/**
 * Opens Collaboration from the rail. The status must recover by itself
 * after the local login (bug 1 regression check: no "Try again").
 */
async function openCollabDialog(instance: LiberaInstance) {
  const page = instance.page!;
  const rail = await waitFor(() => page.evaluate<string | null>(js.rail).then((label) => (label && !/Unavailable/.test(label) ? label : null)), {
    timeoutMs: 15_000,
    message: `${instance.name}: the rail still says "Collaboration: Unavailable" 15 s after logging in (stale status from the login screen)`,
  });
  note(`${instance.name}: rail button says ${JSON.stringify(rail)}`);
  await page.click(`document.querySelector("button[aria-label^='Collaboration']")`, "Collaboration rail button");
  await waitFor(() => page.evaluate<string | null>(js.dialogText).then((t) => t?.startsWith("Collaboration") && !t.includes("Checking the collaboration service")), {
    timeoutMs: 15_000,
    message: `${instance.name}: the Collaboration dialog did not open`,
  });
  const text = (await page.evaluate<string>(js.dialogText)) ?? "";
  if (text.includes("Try again")) {
    const live = await page.evaluate<{ http: number; body: { connection?: string } | null }>(js.status);
    throw new Error(`${instance.name}: the Collaboration dialog shows an error with "Try again" (${JSON.stringify(text.split(String.fromCharCode(10)).filter(Boolean)[2] ?? "")}) while GET /api/collab/status answers ${live.http} ${live.body?.connection ?? ""}`);
  }
}

async function registerCollab(instance: LiberaInstance, account: { email: string; password: string; name: string }, serverUrl: string) {
  const page = instance.page!;
  await openCollabDialog(instance);
  const dialog = DOM.dialog("Collaboration");
  await page.click(DOM.byText(`[role="dialog"] [role="group"] button`, "Create account"), "Create account toggle");
  await page.fill(DOM.byLabel("Server", dialog), serverUrl, "Server field");
  await page.fill(DOM.byLabel("Your name", dialog), account.name, "Your name field");
  await page.fill(DOM.byLabel("Email", dialog), account.email, "Email field");
  await page.fill(DOM.byLabel("Password", dialog), account.password, "Password field");
  await shot(page, `collab-register-form-${instance.name.toLowerCase()}`);
  await page.click(DOM.byText(`[role="dialog"] form button[type=submit]`, "Create account"), "Create account submit");
  const started = Date.now();
  const connected = () => page.evaluate<string | null>(js.dialogText).then((t) => (t && /\nConnected\n/.test(t) ? t : null));
  const text = await waitFor(connected, { timeoutMs: 15_000, message: `${instance.name}: the dialog did not show "Connected" within 15 s of "Create account"` }).catch(async (error) => {
    const live = await page.evaluate<{ body: { connection?: string } | null }>(js.status).catch(() => null);
    const shown = await page.evaluate<string | null>(`document.querySelector('[role="dialog"] [data-tone] p.font-medium')?.textContent ?? null`).catch(() => null);
    throw new Error(`${(error as Error).message}; the dialog shows ${JSON.stringify(shown)} and GET /api/collab/status says ${JSON.stringify(live?.body?.connection)}`);
  });
  timings[`${instance.name}: create account → dialog shows Connected`] = Date.now() - started;
  note(`${instance.name}: ${text.split("\n").filter(Boolean).slice(2, 6).join(" | ")}`);
  await shot(page, `collab-connected-${instance.name.toLowerCase()}`);
  await page.click(DOM.byText(`[role="dialog"] button`, "Close"), "Close");
  // Debug knob: reload this window after signing in (what the stale-status workaround does).
  if ((process.env.E2E_RELOAD_AFTER_SIGNIN ?? "").split(",").includes(instance.name)) {
    note(`${instance.name}: reloading the window (E2E_RELOAD_AFTER_SIGNIN)`);
    await page.send("Page.reload");
    await waitFor(() => page.evaluate<string | null>(js.rail).then((label) => label?.startsWith("Collaboration: Connected")), { timeoutMs: 30_000, message: `${instance.name}: not Connected after reloading` });
  }
}

async function openFile(instance: LiberaInstance, name: string, folder?: string) {
  const page = instance.page!;
  if (folder) {
    const visible = await page.evaluate<boolean>(`!!(${DOM.byText("button", name)})`);
    if (!visible) await page.click(DOM.byText("button", folder), `${folder} folder in the tree`);
  }
  await page.click(DOM.byText("button", name), `${name} in the tree`);
  await waitFor(() => page.evaluate<string | null>(js.sharedDoc), {
    timeoutMs: 30_000,
    message: `${instance.name}: ${name} did not open as a shared document (no shared-tab chrome)`,
  });
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector(".cm-content") || !!document.querySelector(".ProseMirror")`), {
    timeoutMs: 20_000,
    message: `${instance.name}: no editor appeared for ${name}`,
  });
}

async function setMarkdownMode(instance: LiberaInstance, mode: "Visual" | "Source") {
  const page = instance.page!;
  await instance.chooseMenuItem(["Editor Mode", mode]);
  await page.click(`document.querySelector("button[aria-label='File actions']")`, "File actions button");
  await waitFor(() => page.evaluate<boolean>(mode === "Source" ? `!!document.querySelector(".cm-content")` : `!!document.querySelector(".ProseMirror")`), {
    timeoutMs: 15_000,
    message: `${instance.name}: the editor did not switch to ${mode}`,
  });
  const offered = (await instance.menusOffered()).at(-1);
  assert(offered?.clicked === mode, `${instance.name}: the file menu did not offer Editor Mode → ${mode} (${JSON.stringify(offered)})`);
}

/** Types `text` and measures until `check` sees it on the other side. */
async function typeAndMeasure(
  writer: CdpPage,
  text: string,
  remote: () => Promise<unknown>,
  label: string,
): Promise<number> {
  const focus = await writer.evaluate<string>(js.focus);
  const started = Date.now();
  await writer.insertText(text);
  const probe = text.trim().split(/\s+/).at(-1) ?? text.trim();
  const own = focus === "cm" ? js.cmText : focus === "pm" ? js.pmText : null;
  if (!own) throw new Error(`${writer.label}: no editor had focus before typing (focus: ${focus})`);
  await waitText(writer, own, [probe], `${writer.label}: the typed text did not appear in the writer's own ${focus === "cm" ? "Source" : "Visual"} editor`, 3_000);
  const local = Date.now() - started;
  await remote();
  const ms = Date.now() - started;
  timings[label] = ms;
  note(`${label}: ${ms} ms (own editor ${local} ms)`);
  return ms;
}

async function typeSlowly(page: CdpPage, text: string, delayMs: number) {
  for (const char of text) {
    await page.insertText(char);
    await sleep(delayMs);
  }
}

// ---------------------------------------------------------------- the run

const alicePort = { debug: 0, inspect: 0 };
let alice: LiberaInstance;
let bob: LiberaInstance;
let server: ServerProcess | null = null;
const serverLog = path.join(WORK, "collab-server.log");

function attachServerLog(proc: ServerProcess) {
  const write = (chunk: Buffer) => appendFileSync(serverLog, chunk);
  proc.child.stdout?.on("data", write);
  proc.child.stderr?.on("data", write);
}

async function main() {
  log(`work dir: ${WORK}`);
  for (const required of [".next/standalone/server.js", "electron/collab/dist/host.cjs"]) {
    assert(existsSync(path.join(PROJECT_ROOT, required)), `${required} is missing. Build first: set LIBERA_COLLAB=1, then npm run electron:build-next && npm run electron:prepare-standalone`);
  }

  const serverPort = await freePort();
  const serverData = path.join(WORK, "server-data");
  const serverEnv = { PUBLIC_URL: `http://127.0.0.1:${serverPort}` };
  alicePort.debug = await freePort();
  alicePort.inspect = await freePort();
  alice = new LiberaInstance({ name: "Alice", root: path.join(WORK, "alice"), debugPort: alicePort.debug, inspectPort: alicePort.inspect, logFile: path.join(WORK, "electron-alice.log") });
  bob = new LiberaInstance({ name: "Bob", root: path.join(WORK, "bob"), debugPort: await freePort(), inspectPort: await freePort(), logFile: path.join(WORK, "electron-bob.log") });
  const accounts = {
    alice: { name: "Alice", email: `alice-${RUN_ID}@example.test`, password: generatedPassword() },
    bob: { name: "Bob", email: `bob-${RUN_ID}@example.test`, password: generatedPassword() },
  };
  // Throwaway credentials stay in the work directory, never in the console.
  writeFileSync(path.join(WORK, "credentials.json"), JSON.stringify({ alice: { local: alice.localPassword, ...accounts.alice }, bob: { local: bob.localPassword, ...accounts.bob } }, null, 2));

  await step("0", "Start the collab server and prepare two profiles", async () => {
    server = await startServerProcess({ port: serverPort, dataDir: serverData, env: serverEnv });
    attachServerLog(server);
    note(`server at ${server.url}`);
    for (const instance of [alice, bob]) instance.writeConfig();
    mkdirSync(alice.file(`${NOTEBOOK}/paper`), { recursive: true });
    writeFileSync(alice.file(`${NOTEBOOK}/notes.md`), SEED_NOTES);
    writeFileSync(alice.file(`${NOTEBOOK}/paper/main.tex`), SEED_TEX);
  });

  await step("1", "Launch both apps and log in through the login form", async () => {
    const started = Date.now();
    await Promise.all([alice.launch(), bob.launch()]);
    timings["launch both (to page target)"] = Date.now() - started;
    await shot(alice.page, "login-screen-alice");
    await Promise.all([localLogin(alice), localLogin(bob)]);
    timings["launch + local login"] = Date.now() - started;
    await shot(alice.page, "logged-in-alice");
    await shot(bob.page, "logged-in-bob");
  });

  await step("2", "Create collaboration accounts through the Collaboration dialog", async () => {
    await registerCollab(alice, accounts.alice, server!.url);
    await registerCollab(bob, accounts.bob, server!.url);
  });

  let invitation = "";
  await step("3", `Alice shares "${NOTEBOOK}" and invites Bob as editor`, async () => {
    const page = alice.page!;
    await alice.chooseMenuItem(["Share notebook…"]);
    await page.click(`document.querySelector("button[aria-label='Notebook actions for ${NOTEBOOK}']")`, "Notebook actions button");
    await waitFor(() => page.evaluate<string | null>(js.dialogText).then((t) => t?.startsWith("Share notebook")), { timeoutMs: 15_000, message: "the Share notebook dialog did not open" });
    const offered = (await alice.menusOffered()).at(-1);
    assert(offered?.clicked === "Share notebook…", `the notebook menu did not offer "Share notebook…": ${JSON.stringify(offered?.items)}`);
    const started = Date.now();
    await page.click(DOM.byText(`[role="dialog"] button[type=submit]`, "Share"), "Share button");
    await waitFor(() => page.evaluate<string | null>(js.dialogText).then((t) => t?.includes(`Owner · ${NOTEBOOK}`)), { timeoutMs: 60_000, message: "sharing did not finish (no Owner view)" });
    timings["share notebook"] = Date.now() - started;
    note(`shared in ${timings["share notebook"]} ms`);
    // The member list loads after the owner view appears; typing earlier can be lost.
    await waitFor(() => page.evaluate<string | null>(js.dialogText).then((t) => t?.includes("People with access")), { timeoutMs: 15_000, message: "the member list did not load" });
    await page.fill(DOM.byLabel("Invite by email", DOM.dialog("Share")), accounts.bob.email, "Invite by email field");
    await sleep(300);
    const kept = await page.evaluate<string | null>(`(${DOM.byLabel("Invite by email", DOM.dialog("Share"))})?.value ?? null`);
    assert(kept === accounts.bob.email, `the "Invite by email" field lost the typed address within 300 ms (now ${JSON.stringify(kept)})`);
    const role = await page.evaluate<string | null>(`document.querySelector('[role="dialog"] input[type=radio]:checked')?.value ?? null`);
    assert(role === "editor", `the default invitation role is ${role}, expected editor`);
    await page.click(DOM.byText(`[role="dialog"] button[type=submit]`, "Invite"), "Invite button");
    invitation = await waitFor(() => page.evaluate<string | null>(`document.querySelector("input[aria-label='Invitation link']")?.value || null`), { timeoutMs: 15_000, message: "no invitation link appeared" });
    note(`invitation link host: ${new URL(invitation).host}`);
    await shot(page, "share-invited-alice");
    await page.click(DOM.byText(`[role="dialog"] button`, "Done"), "Done");
    const badge = await waitFor(() => page.evaluate<string | null>(`document.querySelector('[aria-label^="Shared ·"]')?.getAttribute("aria-label") ?? null`), { timeoutMs: 10_000, message: "no shared badge on the notebook" });
    note(`badge: ${badge}`);
  });

  let bobNotebook = NOTEBOOK;
  await step("4", "Bob joins with the invitation link", async () => {
    const page = bob.page!;
    await page.click(`document.querySelector("button[aria-label='Join a shared notebook']")`, "Join a shared notebook button");
    await page.fill(DOM.byLabel("Invitation link or code", DOM.dialog("Join a shared notebook")), invitation, "invitation field");
    const started = Date.now();
    await page.click(DOM.byText(`[role="dialog"] button[type=submit]`, "Join"), "Join button");
    await waitFor(() => page.evaluate<string | null>(js.dialogText).then((t) => t === null), {
      timeoutMs: 60_000,
      message: "the Join dialog did not close",
    }).catch(async (error) => {
      throw new Error(`${(error as Error).message}: ${JSON.stringify(await page.evaluate(js.dialogText))}`);
    });
    timings["join notebook"] = Date.now() - started;
    const status = await page.evaluate<{ body: { projects: Array<{ notebook: string; role: string; name: string }> } }>(js.status);
    const project = status.body.projects.find((candidate) => candidate.name === NOTEBOOK);
    assert(project, `Bob's host lists no "${NOTEBOOK}" project: ${JSON.stringify(status.body.projects)}`);
    assert(project.role === "editor", `Bob's role is ${project.role}, expected editor`);
    bobNotebook = project.notebook;
    note(`joined in ${timings["join notebook"]} ms; notebook folder "${bobNotebook}", role ${project.role}`);
    await shot(page, "joined-bob");
  });

  await step("5", "The notebook is in Bob's tree with the same files on disk", async () => {
    const page = bob.page!;
    await waitFor(() => page.evaluate<boolean>(`!!(${DOM.byText("button", "notes.md")})`), { timeoutMs: 20_000, message: "notes.md is not in Bob's tree" });
    for (const relative of ["notes.md", "paper/main.tex"]) {
      const bobFile = bob.file(`${bobNotebook}/${relative}`);
      await waitFor(() => existsSync(bobFile), { timeoutMs: 30_000, message: `${relative} did not appear on Bob's disk` });
      const mine = readFileSync(alice.file(`${NOTEBOOK}/${relative}`));
      const theirs = await waitFor(() => {
        const bytes = readFileSync(bobFile);
        return bytes.equals(mine) ? bytes : null;
      }, { timeoutMs: 15_000, message: `${relative} differs between Alice's and Bob's disks` });
      const seed = Buffer.from(relative === "notes.md" ? SEED_NOTES : SEED_TEX);
      note(`${relative}: ${theirs.length} bytes, identical on both disks; equal to the seeded file: ${theirs.equals(seed)}`);
      if (!theirs.equals(seed)) observe(`${relative} changed when shared: seeded ${JSON.stringify(seed.toString())}, now ${JSON.stringify(theirs.toString())}`);
    }
    note(`marker present on Bob's side: ${existsSync(bob.file(`${bobNotebook}/.libera-shared.json`))}`);
    await shot(page, "tree-bob");
  });

  const marker = (who: string) => `${who}-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
  const aliceNotes = alice.file(`${NOTEBOOK}/notes.md`);
  const bobNotes = () => bob.file(`${bobNotebook}/notes.md`);

  let afterAlice = "";
  await step("6", "Alice types in Source; Bob sees it in Visual and on disk", async () => {
    await Promise.all([openFile(alice, "notes.md"), openFile(bob, "notes.md")]);
    await setMarkdownMode(alice, "Source");
    const bobMode = await bob.page!.evaluate<string>(`document.querySelector(".ProseMirror") ? "visual" : document.querySelector(".cm-content") ? "source" : "none"`);
    note(`Bob's editor: ${bobMode}`);
    if (bobMode !== "visual") await setMarkdownMode(bob, "Visual");
    const docs = await Promise.all([alice.page!.evaluate(js.sharedDoc), bob.page!.evaluate(js.sharedDoc)]);
    assert(docs[0] === docs[1], `the two tabs are bound to different documents: ${docs.join(" vs ")}`);

    const first = marker("alice");
    await focusEditor(alice.page!, "cm", "end");
    const beforeAlice = (await cmText(alice.page!)) ?? "";
    // A real Enter key: Input.insertText("\n") does not reliably add a line in CodeMirror.
    await alice.page!.key("Enter", { code: "Enter", keyCode: 13, text: "\r" });
    await typeAndMeasure(alice.page!, `Alice was here ${first}.`, () => waitText(bob.page!, js.pmText, [first], "Alice's text did not reach Bob's Visual editor"), "notes.md Alice Source → Bob Visual DOM");
    const diskStarted = Date.now();
    await waitDisk(bobNotes(), [first], "Alice's text did not reach Bob's disk");
    note(`…and Bob's disk ${Date.now() - diskStarted} ms after his editor`);
    await shot(alice.page, "notes-alice-source");
    await shot(bob.page, "notes-bob-visual");

    afterAlice = (await cmText(alice.page!)) ?? "";
    const typed = `\nAlice was here ${first}.`;
    if (afterAlice !== beforeAlice + typed) note(`after Enter + text at the end, Alice's source ends ${JSON.stringify(afterAlice.slice(-90))}, not ${JSON.stringify((beforeAlice + typed).slice(-90))}`);
  });

  await step("6b", "Bob types at the end in Visual; Alice sees it in Source and on disk", async () => {
    const back = marker("bobvisual");
    await focusEditor(bob.page!, "pm", "end");
    const where = await bob.page!.evaluate<string | null>(js.selectionAt);
    note(`Bob's DOM selection after Ctrl+End is in: ${where}`);
    await typeAndMeasure(bob.page!, ` Bob replied ${back}`, () => waitText(alice.page!, js.cmText, [back], "Bob's Visual typing did not reach Alice's Source editor"), "notes.md Bob Visual → Alice Source DOM");
    await waitDisk(aliceNotes, [back], "Bob's Visual typing did not reach Alice's disk");
    const aliceText = (await cmText(alice.page!)) ?? "";
    note(`Alice's text after the round trip ends with ${JSON.stringify(aliceText.slice(-80))}`);
    const bobInsert = ` Bob replied ${back}`;
    if (aliceText.replace(bobInsert, "") !== afterAlice) {
      observe(`Bob typed only ${JSON.stringify(bobInsert)} in Visual, but the shared source changed elsewhere too: before ${JSON.stringify(afterAlice.slice(-90))}, after ${JSON.stringify(aliceText.slice(-110))}`);
    }
  }, { soft: true }).then(async (ok) => {
    if (ok) return;
    const where = await bob.page!.evaluate<string | null>(js.selectionAt).catch(() => null);
    observe(`Bob's typing in Visual was dropped; his DOM selection is in ${where}`);
    // Put Bob's caret back into real text so the rest of the run can go on.
    const rect = await bob.page!.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const p = document.querySelector(".ProseMirror p"); const b = p.getBoundingClientRect(); return { x: b.x + b.width - 2, y: b.y + 2, width: 1, height: Math.max(1, b.height - 4) }; })()`);
    await bob.page!.clickRect(rect);
  });

  await step("7", "Both type concurrently in Source; both converge", async () => {
    await setMarkdownMode(bob, "Source");
    const a = marker("A");
    const b = marker("B");
    await focusEditor(alice.page!, "cm", "end");
    await focusEditor(bob.page!, "cm", "start");
    const started = Date.now();
    await Promise.all([typeSlowly(alice.page!, ` [${a}]`, 15), typeSlowly(bob.page!, `[${b}] `, 15)]);
    const converged = await waitFor(
      async () => {
        const [left, right] = await Promise.all([cmText(alice.page!), cmText(bob.page!)]);
        return left !== null && left === right && left.includes(`[${a}]`) && left.includes(`[${b}]`) ? left : null;
      },
      { timeoutMs: 20_000, message: "the two Source editors did not converge to the same text containing both inserts", intervalMs: 25 },
    );
    timings["concurrent typing → converged editors (from first key)"] = Date.now() - started;
    assert(converged.startsWith(`[${b}] `), `Bob's insert at the start was moved: ${JSON.stringify(converged.slice(0, 60))}`);
    assert(converged.trimEnd().endsWith(`[${a}]`), `Alice's insert at the end was moved: ${JSON.stringify(converged.slice(-60))}`);
    await waitDisk(aliceNotes, [a, b], "Alice's disk did not get both inserts");
    await waitFor(() => readFileSync(aliceNotes, "utf8") === converged && readFileSync(bobNotes(), "utf8") === converged, {
      timeoutMs: 15_000,
      message: "the files on disk do not equal the converged text",
    });
    note(`converged (${converged.length} chars); both disks equal the editors`);
    await shot(alice.page, "concurrent-alice");
    await shot(bob.page, "concurrent-bob");
  });

  await step("8", 'The status pill reaches "Saved to workspace"', async () => {
    for (const instance of [alice, bob]) {
      const pill = await waitPill(instance.page!, "saved-remote", instance.name);
      assert(pill.label === "Saved to workspace", `${instance.name}: pill label is ${JSON.stringify(pill.label)}`);
      note(`${instance.name}: ${pill.label}`);
    }
  });

  await step("9", "Presence avatars show the other user", async () => {
    const seen = await Promise.all([
      waitFor(() => alice.page!.evaluate<string[]>(js.presence).then((list) => (list.some((label) => label.includes("Bob")) ? list : null)), { timeoutMs: 15_000, message: "Alice does not see Bob in the presence avatars" }),
      waitFor(() => bob.page!.evaluate<string[]>(js.presence).then((list) => (list.some((label) => label.includes("Alice")) ? list : null)), { timeoutMs: 15_000, message: "Bob does not see Alice in the presence avatars" }),
    ]);
    note(`Alice sees ${JSON.stringify(seen[0])}; Bob sees ${JSON.stringify(seen[1])}`);
    await shot(alice.page, "presence-alice");
  }, { soft: true });

  await step("9b", "Alice comments on a passage (Review mode, Ctrl+Alt+M); Bob sees it in Comments with Alice as author", async () => {
    const page = alice.page!;
    const comment = `Comment from Alice ${marker("c")}`;
    await page.click(`document.querySelector('button.review-toggle[aria-label="Review mode"]')`, "Review mode button");
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('button.review-toggle[aria-label="Review mode"]')?.getAttribute("aria-pressed") === "true"`), { timeoutMs: 10_000, message: "Review mode did not turn on" });
    // Caret into the paragraph to comment on (a bare caret selects its paragraph).
    const line = `[...document.querySelectorAll(".cm-content .cm-line")].find((l) => l.textContent.includes("shared between")) || null`;
    await page.click(line, "the paragraph line in Source", 10_000, false);
    await page.key("m", { code: "KeyM", keyCode: 77, modifiers: 3 });
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('.review-popover[aria-label="Passage review"]')`), { timeoutMs: 10_000, message: "Ctrl+Alt+M did not open the Passage review popover" });
    const addButton = DOM.byText(".review-popover button.review-button", "Add comment");
    const composer = `!!document.querySelector('[aria-label="New review comment"]')`;
    /** Mouse click; when it has no effect, records what the mouse hit and falls back to a DOM click(). */
    /** A real mouse click must have its effect (bug 5 regression check: no DOM click() fallback). */
    const clickWithFallback = async (finder: string, what: string, effect: string) => {
      const hit = await page.evaluate<string>(`(() => { const el = (${finder}); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === el || el.contains(top) ? "the button itself" : (top ? top.outerHTML.slice(0, 120) : "nothing"); })()`);
      // Record what the mouse events hit, and whether the button was replaced meanwhile.
      await page.evaluate(`(() => {
        const button = (${finder});
        const log = window.__e2eClick = { events: [], removed: 0, button };
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          document.addEventListener(type, (e) => log.events.push(type + ":" + (e.target === button ? "button" : (e.target && e.target.nodeName)) + (button.isConnected ? "" : "(button detached)") + (e.defaultPrevented ? "(prevented)" : "")), { capture: true, once: true });
        }
        const pop = document.querySelector(".review-popover");
        if (pop) new MutationObserver((records) => { for (const r of records) log.removed += r.removedNodes.length; }).observe(pop, { childList: true, subtree: true });
      })()`);
      await page.click(finder, what);
      if (await waitFor(() => page.evaluate<boolean>(effect), { timeoutMs: 5_000, message: what }).catch(() => false)) return;
      // The submit button disappears when the popover closes; the card may still be on its way.
      if (!(await page.evaluate<boolean>(`!!(${finder})`))) return;
      await shot(page, `comment-click-ignored-${what.replace(/[^A-Za-z0-9]+/g, "-")}`);
      const trace = await page.evaluate(`(() => { const l = window.__e2eClick; return { events: l.events, nodesRemovedFromPopover: l.removed, buttonStillConnected: l.button.isConnected, buttonDisabled: l.button.disabled }; })()`).catch(() => null);
      throw new Error(`a real mouse click on ${what} had no effect within 5 s (the point under the mouse is ${hit}; events ${JSON.stringify(trace)})`);
    };
    await clickWithFallback(addButton, `the popover's "Add comment" button`, composer);
    await page.fill(`document.querySelector('[aria-label="New review comment"]')`, comment, "New review comment field");
    await shot(page, "comment-composer-alice");
    let aliceMissing = "";
    const posted = `[...document.querySelectorAll("article.review-comment-card")].some((c) => c.textContent.includes(${JSON.stringify(comment)}))`;
    // In-page timestamps (not CDP polling): when the submit click happens and
    // when each panel first shows the card. MutationObserver, not timers, which
    // are throttled in a hidden window.
    const watchCard = `(() => {
      window.__e2eCardAt = null;
      const check = () => { if (window.__e2eCardAt === null && ${posted}) window.__e2eCardAt = Date.now(); };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
      return true;
    })()`;
    await bob.page!.click(`document.querySelector("#left-panel-tab-comments")`, "Comments tab (Bob)");
    await bob.page!.evaluate(watchCard);
    await page.evaluate(watchCard);
    await page.evaluate(`(() => { window.__e2eSubmitAt = null; document.addEventListener("click", () => { window.__e2eSubmitAt = Date.now(); }, { capture: true, once: true }); return true; })()`);
    await clickWithFallback(`document.querySelector(".review-popover form button")`, `the composer's "Add comment" submit button`, posted);
    const popoverError = await page.evaluate<string | null>(`document.querySelector(".review-popover [role=alert], .review-popover .text-destructive")?.textContent ?? null`);
    if (popoverError) note(`popover error: ${popoverError}`);
    await waitFor(() => page.evaluate<boolean>(posted), { timeoutMs: 15_000, message: "the comment did not appear in Alice's Comments panel" }).catch(async (error) => {
      const docId = await page.evaluate<string | null>(js.sharedDoc);
      const stored = await page.evaluate(`(async () => { const r = await fetch("/api/collab/docs/${docId}/threads"); return { http: r.status, body: (await r.text()).slice(0, 600) }; })()`).catch((e) => String(e));
      const queued = await page.evaluate(`(async () => { const r = await fetch("/api/collab/commands"); return { http: r.status, body: (await r.text()).slice(0, 600) }; })()`).catch((e) => String(e));
      const panel = await page.evaluate<string | null>(`document.querySelector('section.review-comments')?.innerText.slice(0, 300) ?? null`);
      aliceMissing = `${(error as Error).message}. Panel: ${JSON.stringify(panel)}. GET threads: ${JSON.stringify(stored)}. GET commands: ${JSON.stringify(queued)}`;
      observe(`Alice's comment was stored but is not in her own Comments panel: ${aliceMissing}`);
    });
    const submitAt = await page.evaluate<number | null>("window.__e2eSubmitAt");
    const aliceAt = await page.evaluate<number | null>("window.__e2eCardAt");
    if (!aliceMissing) {
      assert(submitAt && aliceAt, "no in-page timestamps for the submit click and Alice's card");
      timings["comment submit click → card in Alice's own panel (in-page)"] = aliceAt - submitAt;
      assert(aliceAt - submitAt < 1_500, `Alice's own panel showed her comment ${aliceAt - submitAt} ms after the click (budget 1.5 s)`);
    }
    const bobPage = bob.page!;
    await bobPage.click(`document.querySelector("#left-panel-tab-comments")`, "Comments tab");
    const card = await waitFor(
      () => bobPage.evaluate<{ author: string; text: string } | null>(`(() => {
        const card = [...document.querySelectorAll("article.review-comment-card")].find((c) => c.textContent.includes(${JSON.stringify(comment)}));
        return card ? { author: (card.querySelector(".review-comment-author")?.textContent || "").trim(), text: card.textContent.trim().slice(0, 200) } : null;
      })()`),
      { timeoutMs: 20_000, message: "Alice's comment did not appear in Bob's Comments panel" },
    ).catch(() => null);
    await shot(page, "comment-alice");
    await shot(bobPage, "comment-bob");
    if (card) {
      const bobAt = await bobPage.evaluate<number | null>("window.__e2eCardAt");
      assert(submitAt && bobAt, "no in-page timestamp for Bob's card");
      timings["comment submit click → card in Bob's panel (in-page)"] = bobAt - submitAt;
      assert(bobAt - submitAt < 1_500, `Bob's panel showed the comment ${bobAt - submitAt} ms after Alice's click (budget 1.5 s)`);
      assert(card.author.includes("Alice"), `the comment's author on Bob's side is ${JSON.stringify(card.author)}, expected Alice`);
      note(`Bob sees the comment with author ${JSON.stringify(card.author)}`);
    } else {
      const docId = await bobPage.evaluate<string | null>(js.sharedDoc);
      const stored = await bobPage.evaluate<{ http: number; count: number }>(`(async () => { const r = await fetch("/api/collab/docs/${docId}/threads"); const b = await r.json().catch(() => []); return { http: r.status, count: Array.isArray(b) ? b.length : -1 }; })()`).catch(() => null);
      observe(`Alice's comment is not in Bob's Comments panel after 20 s; Bob's GET /api/collab/docs/<docId>/threads answers ${JSON.stringify(stored)}`);
    }
    if (aliceMissing || !card) {
      // Does it show after a reload (load path) even though the live path missed it?
      await page.send("Page.reload");
      await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("#left-panel-tab-comments") && Object.keys(document.querySelector("#left-panel-tab-comments")).some((k) => k.startsWith("__reactProps"))`), { timeoutMs: 30_000, message: "Alice's window did not come back" });
      await sleep(2000);
      await page.click(`document.querySelector("#left-panel-tab-notebook")`, "Notebook tab");
      await openFile(alice, "notes.md");
      await page.click(`document.querySelector("#left-panel-tab-comments")`, "Comments tab");
      const after = await waitFor(() => page.evaluate<boolean>(posted), { timeoutMs: 15_000, message: "x" }).catch(() => false);
      observe(`after reloading Alice's window, her own comment ${after ? "does" : "still does not"} show in her Comments panel`);
      await shot(page, "comment-alice-after-reload");
      throw new Error(`the new comment did not show live in ${[aliceMissing ? "Alice's" : "", card ? "" : "Bob's"].filter(Boolean).join(" and ")} Comments panel`);
    }
    // Back to the tree for the next steps.
    for (const instance of [alice, bob]) {
      if (await instance.page!.evaluate<boolean>(`!!document.querySelector('.review-popover')`)) await instance.page!.key("Escape", { code: "Escape", keyCode: 27 });
      await instance.page!.click(`document.querySelector("#left-panel-tab-notebook")`, "Notebook tab");
    }
  }, { soft: true }).then(async (ok) => {
    if (ok) return;
    for (const instance of [alice, bob]) {
      await instance.page?.key("Escape", { code: "Escape", keyCode: 27 }).catch(() => undefined);
      await instance.page?.click(`document.querySelector("#left-panel-tab-notebook")`, "Notebook tab", 5_000).catch(() => undefined);
    }
  });

  await step("9c", "Alice types with Suggesting on; Bob accepts the suggestion; both converge", async () => {
    const page = alice.page!;
    const bobPage = bob.page!;
    const mark = marker("sugg");
    const toggle = `document.querySelector(".libera-collab-suggesting-toggle")`;
    await page.click(toggle, "Suggesting toggle");
    await waitFor(() => page.evaluate<boolean>(`(${toggle})?.getAttribute("aria-pressed") === "true"`), { timeoutMs: 10_000, message: "Suggesting did not turn on" });
    await focusEditor(page, "cm", "end");
    const started = Date.now();
    await page.insertText(` Suggested ${mark}.`);
    await shot(page, "suggesting-alice");
    const bobSource = await bobPage.evaluate<string | null>(js.cmText);
    note(`before accepting, Bob's source contains the suggested text: ${!!bobSource?.includes(mark)} (expected false)`);
    if (bobSource?.includes(mark)) observe("text typed with Suggesting on went straight into Bob's source before anyone accepted it");
    await bobPage.click(`document.querySelector("#left-panel-tab-comments")`, "Comments tab");
    await bobPage.click(DOM.byText(`button[role="tab"]`, /^Suggestions/), "Suggestions tab");
    const card = `[...document.querySelectorAll("li.libera-suggestion-card")].find((c) => c.textContent.includes(${JSON.stringify(mark)})) || null`;
    const seen = await waitFor(() => bobPage.evaluate<{ author: string; state: string } | null>(`(() => { const c = (${card}); return c ? { author: (c.querySelector('[data-testid="suggestion-author"]')?.textContent || "").trim(), state: c.dataset.state } : null; })()`), {
      timeoutMs: 20_000,
      message: "Alice's suggestion did not appear in Bob's Suggestions panel",
    });
    timings["suggestion typed → visible in Bob's Suggestions panel"] = Date.now() - started;
    note(`Bob sees the suggestion by ${JSON.stringify(seen.author)} (${seen.state})`);
    assert(seen.author.includes("Alice"), `the suggestion's author is ${JSON.stringify(seen.author)}, expected Alice`);
    await shot(bobPage, "suggestion-bob");
    const accepted = Date.now();
    await bobPage.click(`(${card})?.querySelector('[data-action="accept"]')`, "Accept button");
    const converged = await waitFor(async () => {
      const [left, right] = await Promise.all([cmText(page), cmText(bobPage)]);
      return left !== null && left === right && left.includes(mark) ? left : null;
    }, { timeoutMs: 20_000, message: "after Accept the two sources did not converge on the accepted text" });
    timings["Accept → both sources contain the accepted text"] = Date.now() - accepted;
    await waitDisk(aliceNotes, [mark], "the accepted suggestion did not reach Alice's disk");
    await waitDisk(bobNotes(), [mark], "the accepted suggestion did not reach Bob's disk");
    note(`converged on ${JSON.stringify(converged.slice(-80))}`);
    await shot(page, "suggestion-accepted-alice");
    await shot(bobPage, "suggestion-accepted-bob");
  }, { soft: true }).then(async () => {
    // Leave Suggesting off and the tree visible for the next steps.
    const toggle = `document.querySelector(".libera-collab-suggesting-toggle")`;
    if (await alice.page!.evaluate<boolean>(`(${toggle})?.getAttribute("aria-pressed") === "true"`).catch(() => false)) await alice.page!.click(toggle, "Suggesting toggle", 5_000).catch(() => undefined);
    for (const instance of [alice, bob]) await instance.page?.click(`document.querySelector("#left-panel-tab-notebook")`, "Notebook tab", 5_000).catch(() => undefined);
  });

  await step("10", "Typing in paper/main.tex (LaTeX editor)", async () => {
    await Promise.all([openFile(alice, "main.tex", "paper"), openFile(bob, "main.tex", "paper")]);
    await Promise.all([
      waitText(alice.page!, js.cmText, ["\\maketitle"], "Alice's LaTeX editor did not load main.tex"),
      waitText(bob.page!, js.cmText, ["\\maketitle"], "Bob's LaTeX editor did not load main.tex"),
    ]);
    const tex = marker("texalice");
    await focusEditor(alice.page!, "cm", "end");
    await typeAndMeasure(alice.page!, `% ${tex}\n`, () => waitText(bob.page!, js.cmText, [tex], "Alice's LaTeX typing did not reach Bob's editor"), "main.tex Alice → Bob DOM");
    await waitDisk(bob.file(`${bobNotebook}/paper/main.tex`), [tex], "Alice's LaTeX typing did not reach Bob's disk");
    const texBob = marker("texbob");
    await focusEditor(bob.page!, "cm", "start");
    await typeAndMeasure(bob.page!, `% ${texBob}\n`, () => waitText(alice.page!, js.cmText, [texBob], "Bob's LaTeX typing did not reach Alice's editor"), "main.tex Bob → Alice DOM");
    await waitDisk(alice.file(`${NOTEBOOK}/paper/main.tex`), [texBob], "Bob's LaTeX typing did not reach Alice's disk");
    const [left, right] = await Promise.all([cmText(alice.page!), cmText(bob.page!)]);
    assert(left === right, "main.tex differs between the two editors");
    await waitPill(alice.page!, "saved-remote", "Alice (main.tex)");
    await shot(alice.page, "latex-alice");
    await shot(bob.page, "latex-bob");
  }, { soft: true });

  const offlineMarks: string[] = [];
  await step("10b", "A file Alice creates appears in Bob's tree and on his disk, without a reload", async () => {
    const status = await alice.page!.evaluate<{ body: { projects: Array<{ projectId: string; name: string }> } }>(js.status);
    const project = status.body.projects.find((candidate) => candidate.name === NOTEBOOK);
    assert(project, "Alice has no shared project");
    const name = "from-alice.md";
    const created = await alice.page!.evaluate<number>(
      `fetch(${JSON.stringify(`/api/collab/projects/${encodeURIComponent(project.projectId)}/files`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create-file", path: ${JSON.stringify(name)}, content: "# From Alice" }) }).then((r) => r.status)`,
    );
    assert(created === 200, `create-file answered ${created}`);
    const started = Date.now();
    await waitFor(() => bob.page!.evaluate<boolean>(`!!(${DOM.byText("button", name)})`), { timeoutMs: 20_000, message: `${name} did not appear in Bob's Notebooks tree` });
    timings["collaborator's new file → in Bob's tree"] = Date.now() - started;
    await waitFor(() => { try { return readFileSync(bob.file(`${bobNotebook}/${name}`), "utf8") === "# From Alice"; } catch { return false; } }, { timeoutMs: 10_000, message: `${name} is not on Bob's disk` });
    note(`${name} showed up in Bob's tree after ${timings["collaborator's new file → in Bob's tree"]} ms`);
    await shot(bob.page, "new-file-in-bob-tree");
  });

  await step("11", "Server down: Alice keeps typing, the pill shows offline with a pending count", async () => {
    await Promise.all([openFile(alice, "notes.md"), openFile(bob, "notes.md")]);
    await Promise.all([alice, bob].map((instance) => waitFor(() => instance.page!.evaluate<boolean>(`!!document.querySelector(".cm-content")`), { timeoutMs: 10_000, message: `${instance.name}: notes.md is not in Source mode` })));
    await server!.stop();
    server = null;
    const downAt = Date.now();
    note("collab server stopped");
    const offline = await waitPill(alice.page!, "offline", "Alice", 60_000);
    timings["server stop → Alice pill offline"] = Date.now() - downAt;
    note(`Alice's pill: ${offline.label}`);
    await focusEditor(alice.page!, "cm", "end");
    for (let index = 0; index < 3; index++) {
      const mark = marker(`offline${index}`);
      offlineMarks.push(mark);
      const started = Date.now();
      await alice.page!.insertText(` (${mark})`);
      await waitText(alice.page!, js.cmText, [mark], "Alice's own editor did not show her offline typing", 2_000);
      const echo = Date.now() - started;
      timings[`offline keystroke → own editor #${index + 1}`] = echo;
      assert(echo < 1_000, `the editor took ${echo} ms to show an offline edit`);
      await sleep(300);
    }
    const bobOffline = marker("bobOffline");
    offlineMarks.push(bobOffline);
    await focusEditor(bob.page!, "cm", "start");
    await bob.page!.insertText(`(${bobOffline}) `);
    const pill = await waitFor(
      async () => {
        const value = await alice.page!.evaluate<{ state: string; label: string } | null>(js.pill);
        return value && value.state === "offline" && /Offline — \d+ changes? on this device/.test(value.label) ? value : null;
      },
      { timeoutMs: 15_000, message: "Alice's pill does not show 'Offline — N changes on this device'" },
    );
    note(`Alice's pill: ${pill.label}`);
    await waitDisk(aliceNotes, offlineMarks.slice(0, 3), "Alice's offline edits did not reach her disk");
    note("Alice's offline edits are on her disk");
    await shot(alice.page, "offline-alice");
    await shot(bob.page, "offline-bob");
  });

  await step("12", "Server back on the same port and data: both converge", async () => {
    const started = Date.now();
    server = await startServerProcess({ port: serverPort, dataDir: serverData, env: serverEnv });
    attachServerLog(server);
    note(`server restarted in ${Date.now() - started} ms`);
    const listening = Date.now();
    const converged = await waitFor(
      async () => {
        const [left, right] = await Promise.all([cmText(alice.page!), cmText(bob.page!)]);
        return left !== null && left === right && offlineMarks.every((mark) => left.includes(mark)) ? left : null;
      },
      { timeoutMs: 90_000, message: "the editors did not converge after the server came back", intervalMs: 100 },
    );
    timings["server restart → editors converged"] = Date.now() - started;
    const reconnectMs = Date.now() - listening;
    timings["server listening → editors converged"] = reconnectMs;
    // Backoff is capped at 10 s and a /healthz probe shortcuts it; ~10 s is the budget.
    assert(reconnectMs < 10_000, `the editors converged ${reconnectMs} ms after the server was listening again (budget 10 s)`);
    for (const instance of [alice, bob]) await waitPill(instance.page!, "saved-remote", instance.name, 60_000);
    timings["server restart → both pills Saved to workspace"] = Date.now() - started;
    await waitFor(() => readFileSync(aliceNotes, "utf8") === converged && readFileSync(bobNotes(), "utf8") === converged, { timeoutMs: 15_000, message: "the disks do not equal the converged text after reconnecting" });
    note(`converged with all ${offlineMarks.length} offline edits; disks equal`);
    await shot(alice.page, "reconnected-alice");
    await shot(bob.page, "reconnected-bob");
  });

  await step("13", "Quit both apps; the host flushes; reopening shows the same text", async () => {
    const finalText = await cmText(alice.page!);
    assert(finalText !== null, "no final text");
    const quits = await Promise.all([alice.quit(), bob.quit()]);
    note(`exit codes ${quits.map((q) => q.code).join(", ")}; quit took ${quits.map((q) => q.ms).join(" / ")} ms`);
    for (const instance of [alice, bob]) {
      assert(instance.currentLog.includes("[collab-host] Flushed and stopped."), `${instance.name}: no "[collab-host] Flushed and stopped." in the log`);
    }
    note('both logs say "[collab-host] Flushed and stopped."');
    assert(readFileSync(aliceNotes, "utf8") === finalText, "Alice's file on disk differs from her last editor text");
    assert(readFileSync(bobNotes(), "utf8") === finalText, "Bob's file on disk differs from Alice's last editor text");

    await alice.launch();
    await localLogin(alice);
    // The collaboration account is remembered: no sign-in after a relaunch.
    const restored = await waitFor(async () => {
      const current = await alice.page!.evaluate<{ body: { connection?: string; account?: { email?: string } | null } | null }>(js.status);
      return current.body?.connection === "connected" && current.body.account?.email === accounts.alice.email ? current.body : null;
    }, { timeoutMs: 30_000, message: "after relaunch Alice is not connected as herself without signing in" });
    note(`after relaunch: ${restored.connection} as ${restored.account?.email}, no sign-in`);
    const railStarted = Date.now();
    const firstRail = await alice.page!.evaluate<string | null>(js.rail);
    const rail = await waitFor(() => alice.page!.evaluate<string | null>(js.rail).then((label) => (label && !/Unavailable/.test(label) ? label : null)), {
      timeoutMs: 15_000,
      message: `after relaunch the rail still says ${JSON.stringify(firstRail)} 15 s after logging in, although the host is connected`,
    });
    timings["relaunch: login → rail recovers from the login-screen status"] = Date.now() - railStarted;
    note(`after relaunch the rail said ${JSON.stringify(firstRail)} right after login, then ${JSON.stringify(rail)} after ${Date.now() - railStarted} ms`);
    await alice.page!.click(DOM.byText("button", "notes.md"), "notes.md in the tree");
    await waitFor(() => alice.page!.evaluate<string | null>(js.sharedDoc), { timeoutMs: 15_000, message: "after relaunch notes.md opened as a plain local file (no shared-tab chrome)" });
    const reopened = await waitFor(async () => (await cmText(alice.page!)) ?? (await alice.page!.evaluate<string | null>(js.pmText)), { timeoutMs: 15_000, message: "no editor text after reopening" });
    const sameAsSource = reopened === finalText;
    note(`reopened editor text equals the text before quitting: ${sameAsSource}${sameAsSource ? "" : ` (${JSON.stringify(reopened.slice(0, 120))})`}`);
    if (!sameAsSource) {
      // Visual shows rendered text; compare on the markers instead.
      for (const mark of offlineMarks) assert(reopened.includes(mark), `reopened text lacks ${mark}`);
    }
    await shot(alice.page, "reopened-alice");
    await alice.quit();
    assert(alice.currentLog.includes("[collab-host] Flushed and stopped."), "Alice: no flush line after the second quit");
  });
}

function printSummary() {
  console.log("\n================ e2e summary ================");
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.id.padStart(2)}  ${result.title}  (${(result.ms / 1000).toFixed(1)} s)${result.error ? `\n        ${result.error}` : ""}`);
  }
  console.log("\nTimings (ms):");
  for (const [label, ms] of Object.entries(timings)) console.log(`  ${String(ms).padStart(6)}  ${label}`);
  if (observations.length) {
    console.log("\nObservations:");
    for (const item of observations) console.log(`  - ${item}`);
  }
  console.log(`\nScreenshots: ${SHOTS}\nResults: ${path.join(WORK, "results.json")}`);
}

let exitCode = 0;
main()
  .catch((error) => {
    exitCode = 1;
    log(`run aborted: ${(error as Error).stack ?? error}`);
  })
  .finally(async () => {
    if (exitCode !== 0 || results.some((result) => !result.ok)) {
      if (process.env.E2E_PAUSE_ON_FAIL === "1") {
        const resume = path.join(WORK, "resume");
        writeFileSync(path.join(WORK, "paused.json"), JSON.stringify({ alice: alice?.debugPort, bob: bob?.debugPort, server: (server as ServerProcess | null)?.url ?? null }));
        log(`paused for inspection (E2E_PAUSE_ON_FAIL); create ${resume} to clean up`);
        while (!existsSync(resume)) await sleep(500);
      }
    }
    for (const instance of [alice, bob]) {
      if (!instance) continue;
      if (instance.running) {
        await instance.quit(20_000).catch(() => {
          log(`${instance.name} did not quit; killing its own process tree`);
          instance.kill();
        });
      }
    }
    await (server as ServerProcess | null)?.stop().catch(() => undefined);
    if (results.some((result) => !result.ok)) exitCode = 1;
    writeResults();
    printSummary();
    if (exitCode === 0 && !KEEP) {
      for (const dir of [alice?.root, bob?.root, path.join(WORK, "server-data")]) if (dir) rmSync(dir, { recursive: true, force: true });
      log("removed the throwaway profiles and server data (set E2E_KEEP=1 to keep them)");
    }
    process.exit(exitCode);
  });
