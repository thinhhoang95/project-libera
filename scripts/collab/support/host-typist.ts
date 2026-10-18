// S3 kill-test child: types into a document through the host store as fast
// as it can and prints "<local_seq> <commitMs>" after each committed append.
// The parent kills it at a random moment and checks that every printed
// local_seq survived. Output uses writeSync so a line is only printed after
// its commit returned, and is never buffered past a kill.
//
// Usage: node --import tsx scripts/collab/support/host-typist.ts <db> <count>

import { writeSync } from "node:fs";

import * as Y from "yjs";

import { HostStore } from "../../../electron/collab/core/store";

const [dbPath, countArg] = process.argv.slice(2);
if (!dbPath) {
  console.error("usage: host-typist.ts <db> [count]");
  process.exit(2);
}
const count = Number(countArg ?? 100_000);

const store = new HostStore({ path: dbPath });
writeSync(1, "ready\n");
const doc = new Y.Doc();
const text = doc.getText("source");
let pending: Uint8Array | null = null;
doc.on("update", (update: Uint8Array) => {
  pending = update;
});

for (let index = 0; index < count; index += 1) {
  // Each update appends after the previous one, so a missing row would leave
  // every later row unintegrable and the decoded text short.
  text.insert(text.length, `${index},`);
  const update = pending as Uint8Array | null;
  if (!update) continue;
  const started = performance.now();
  const localSeq = store.appendLocal("kill-doc", "content", update, { source: "typing" });
  const elapsed = performance.now() - started;
  writeSync(1, `${localSeq} ${elapsed.toFixed(3)}\n`);
}
store.close();
writeSync(1, "done\n");
