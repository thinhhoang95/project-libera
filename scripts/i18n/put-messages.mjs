// Replace whole namespaces in messages/<locale>.json, safely while other processes do the same.
//   node scripts/i18n/put-messages.mjs <locale> <fragment.json>
// The fragment maps dotted namespace paths to their complete new content, or to null to delete them:
//   { "spending.spendingView": { "title": "…" }, "lib.spending": { … }, "spending.oldThing": null }
// Each listed namespace is replaced as a whole (keys you leave out are removed); nothing else in the file changes.
// A lock file serialises writers, and the file is replaced atomically, so parallel agents never lose each other's work.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [locale, fragmentPath] = process.argv.slice(2);
if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale ?? "") || !fragmentPath) {
  console.error("usage: node scripts/i18n/put-messages.mjs <locale> <fragment.json>");
  process.exit(2);
}
const fragment = JSON.parse(fs.readFileSync(path.resolve(fragmentPath), "utf8"));
const file = path.join(root, "messages", `${locale}.json`);
const lock = path.join(root, "messages", `.${locale}.lock`);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 60_000;
for (;;) {
  try { fs.closeSync(fs.openSync(lock, "wx")); break; } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch {}
    if (Date.now() > deadline) { console.error(`timed out waiting for ${lock}`); process.exit(1); }
    sleep(50 + Math.random() * 100);
  }
}
try {
  const messages = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const changed = [];
  for (const [namespace, content] of Object.entries(fragment)) {
    const parts = namespace.split(".");
    let node = messages;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part];
    }
    const last = parts.at(-1);
    if (content === null) delete node[last];
    else node[last] = content;
    changed.push(`${content === null ? "-" : "="} ${namespace}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2) + "\n");
  fs.renameSync(tmp, file);
  console.log(`${locale}: ${changed.join(", ")}`);
} finally {
  fs.rmSync(lock, { force: true });
}
