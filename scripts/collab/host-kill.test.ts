// S3: the host's SQLite log survives an abrupt kill mid-typing with zero loss
// of committed updates (implementation plan Phase 0, M1.3).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { HostStore, HostStoreLockedError } from "../../electron/collab/core/store";
import { tempDir } from "./support/host-helpers";

const TYPIST = path.join(__dirname, "support", "host-typist.ts");

interface RunResult {
  seqs: number[];
  latencies: number[];
  finished: boolean;
}

function runAndKill(dbPath: string, killAfterMs: number, onReady?: () => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", TYPIST, dbPath, "200000"], {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const seqs: number[] = [];
    const latencies: number[] = [];
    let buffer = "";
    let finished = false;
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready") {
          onReady?.();
          // Kill at a random moment once typing has started.
          timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
          continue;
        }
        if (line === "done") {
          finished = true;
          continue;
        }
        const [seq, ms] = line.split(" ");
        if (seq && ms) {
          seqs.push(Number(seq));
          latencies.push(Number(ms));
        }
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (!signal && code !== 0 && !finished) {
        reject(new Error(`typist exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ seqs, latencies, finished });
    });
  });
}

test("S3: every committed local_seq survives SIGKILL and the doc decodes", { timeout: 120_000 }, async () => {
  const temp = tempDir("libera-kill-");
  const allLatencies: number[] = [];
  try {
    for (let round = 0; round < 3; round += 1) {
      const dbPath = temp.file(`kill-${round}.sqlite`);
      const killAfterMs = 1500 + Math.floor(Math.random() * 2500);
      let lockChecked = false;
      const result = await runAndKill(dbPath, killAfterMs, () => {
        // While the typist owns the file, a second host must fail fast.
        try {
          new HostStore({ path: dbPath }).close();
        } catch (error) {
          lockChecked = error instanceof HostStoreLockedError;
        }
      });
      assert.ok(lockChecked, "a second host on a live database is refused");
      assert.ok(!result.finished, "the typist was killed before it finished");
      // Only a sanity floor: under parallel test load the typist is slower, and
      // what matters is that every committed seq survives, however many there are.
      assert.ok(result.seqs.length > 100, `typed ${result.seqs.length} updates before the kill`);
      allLatencies.push(...result.latencies);

      const store = new HostStore({ path: dbPath });
      const rows = store.allUpdates("kill-doc");
      const present = new Set(rows.map((row) => row.localSeq));
      const missing = result.seqs.filter((seq) => !present.has(seq));
      assert.deepEqual(missing, [], "every printed (committed) local_seq is present");

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.mergeUpdates(rows.map((row) => row.update)));
      assert.equal(doc.store.pendingStructs, null, "no update is missing its dependencies");
      const text = doc.getText("source").toString();
      const expected = Array.from({ length: rows.length }, (_, index) => `${index},`).join("");
      assert.equal(text, expected, "the log decodes to the typed prefix");
      console.log(
        `[host-kill] round ${round + 1}: killed after ${killAfterMs} ms, ${result.seqs.length} printed, ${rows.length} in the log`,
      );
      store.close();
    }
    allLatencies.sort((a, b) => a - b);
    const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)];
    const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
    console.log(`[host-kill] append commit latency over ${allLatencies.length} appends: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    assert.ok(p95 < 50, `p95 append commit ${p95} ms`);
  } finally {
    temp.cleanup();
  }
});
