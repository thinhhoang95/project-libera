import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type * as Y from "yjs";

import { signAccessToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { MessageType, type AckMessage } from "../src/protocol.js";
import { newClientId, SyncTestClient, type SentUpdate } from "./support/sync-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");
const childScript = join(here, "support", "sync-child-server.ts");
const JWT_SECRET = "kill-test-secret-kill-test-secret";

interface Child {
  process: ChildProcess;
  wsUrl: string;
}

async function startChild(dataDir: string, fixture: Record<string, string>): Promise<Child> {
  const child = spawn(process.execPath, ["--import", "tsx", childScript], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: `pglite://${dataDir}`, JWT_SECRET, SYNC_FIXTURE: JSON.stringify(fixture) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout! });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not start: ${stderr}`)), 30_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve((JSON.parse(line) as { url: string }).url);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited with ${code}: ${stderr}`));
    });
  });
  return { process: child, wsUrl: `${url.replace(/^http/, "ws")}/sync` };
}

async function stopChild(child: Child, signal: NodeJS.Signals): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  const exited = new Promise((resolve) => child.process.once("exit", resolve));
  child.process.kill(signal);
  await exited;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function insert(text: string) {
  return (doc: Y.Doc) => {
    const source = doc.getText("source");
    source.insert(source.length, text);
  };
}

test("no acknowledged update is lost when the server is killed", { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "libera-sync-kill-"));
  const fixture = { accountId: "acc_killtest", projectId: "prj_killtest", docId: "doc_killtest" };
  const config = loadConfig({ NODE_ENV: "test", JWT_SECRET });
  const { token } = await signAccessToken(config, fixture.accountId, "fam_killtest");
  const clientId = newClientId();
  const { docId } = fixture;
  let child = await startChild(dataDir, fixture);
  try {
    const writer = await SyncTestClient.connect(child.wsUrl, { token, clientId });
    assert.ok(writer.welcome);
    await writer.open(docId);

    const sent: SentUpdate[] = [];
    let streaming = true;
    const pump = (async () => {
      for (let index = 0; streaming; index += 1) {
        sent.push(writer.edit(docId, "content", insert(`<${index}>`)));
        await delay(index % 4 === 0 ? 1 : 0);
      }
    })();
    // Wait for some acks, then kill at a random moment while updates are in flight.
    while (!writer.received.some((m) => m.type === MessageType.Ack)) await delay(10);
    await delay(100 + Math.floor(Math.random() * 500));
    await stopChild(child, "SIGKILL");
    streaming = false;
    await pump;
    await writer.closed;

    const acked = new Set(
      writer.received.filter((m): m is AckMessage => m.type === MessageType.Ack).map((ack) => ack.clientSeq),
    );
    assert.ok(acked.size > 0);
    assert.ok(sent.length > acked.size, "some updates were still unacknowledged");

    child = await startChild(dataDir, fixture);
    const reader = await SyncTestClient.connect(child.wsUrl, { token, clientId: newClientId() });
    await reader.open(docId);
    const recovered = reader.text(docId);
    sent.forEach((update, index) => {
      if (acked.has(update.clientSeq)) assert.ok(recovered.includes(`<${index}>`), `acked update ${index} survived`);
    });
    await reader.close();

    // The writer reconnects with the same clientId and resends everything unacknowledged.
    const resender = await SyncTestClient.connect(child.wsUrl, { token, clientId });
    await resender.open(docId);
    const unacked = sent.filter((update) => !acked.has(update.clientSeq));
    for (const update of unacked) resender.sendUpdate(update);
    await Promise.all(unacked.map((update) => resender.acked(update)));
    await resender.close();

    const final = await SyncTestClient.connect(child.wsUrl, { token, clientId: newClientId() });
    await final.open(docId);
    const text = final.text(docId);
    assert.equal(text, writer.text(docId), "the server converges to the writer's state");
    sent.forEach((_, index) => {
      assert.equal(text.split(`<${index}>`).length - 1, 1, `update ${index} appears exactly once`);
    });
    await final.close();
  } finally {
    await stopChild(child, "SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
});
