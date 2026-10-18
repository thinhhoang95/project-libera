// The "Report sync problem" button (src/components/libera/collab/diagnostics)
// in the Collaboration dialog: loads GET /diagnostics through the local API,
// explains what is included, shows a summary and the bundle, copies it,
// saves it as a .json file, and reports a failed request.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { HostDiagnostics } from "../../src/lib/collab/ui/diagnostics-types";
import { button, cleanup, click, dom, hostStatus, installFakeBridge, installFakeFetch, removeBridge, render } from "./ui-support";

afterEach(async () => {
  await cleanup();
  removeBridge();
});

function bundle(overrides: Partial<HostDiagnostics> = {}): HostDiagnostics {
  return {
    format: 1,
    generatedAt: Date.UTC(2026, 9, 18, 14, 22, 33),
    hostVersion: 1,
    appVersion: "1.4.0",
    protocolVersion: 1,
    os: { platform: "win32", release: "10.0.26300", arch: "x64" },
    runtime: { node: "22.0.0", electron: "37.6.0" },
    connection: { current: "offline", history: [{ at: 1, state: "connected" }, { at: 2, state: "backoff" }] },
    account: { signedIn: true, accountId: "acc_1", serverUrl: "https://collab.test" },
    pending: { unackedUpdates: 3, oldestUnackedSeconds: 600, commands: 1, docsWithUnacked: 1 },
    projects: [{ projectId: "prj_1", role: "editor", revoked: false, reconcilePending: 0, docs: 2 }],
    docs: [
      {
        docId: "doc_1",
        kind: "file",
        projectId: "prj_1",
        open: true,
        state: "offline",
        pending: 3,
        oldestPendingAgeMs: 600_000,
        lastAckAt: null,
        readOnlyReason: null,
        lastSeenServerSeq: 7,
        rejected: [],
      },
    ],
    counters: { reconnects: 2, reconnectSeconds: 12, rejects: {}, divergenceChecks: 4, divergenceFailures: 1, hostRestarts: 0, telemetryReportsSent: 3 },
    divergence: [{ docId: "doc_1", at: 3, outcome: "mismatch", recovered: false, detail: "still-differs" }],
    errors: [{ at: 4, source: "sync", code: "internal", message: "Server error" }],
    store: { databaseBytes: 4096, walBytes: 0, documents: 2, projects: 1 },
    ...overrides,
  };
}

test("the account dialog offers Report sync problem; it shows, copies and saves the bundle", async () => {
  const { createElement } = await import("react");
  const { CollabAccountDialog } = await import("../../src/components/libera/collab/collab-account-dialog");
  installFakeBridge();
  const fake = installFakeFetch({
    "GET /status": () => ({ body: hostStatus({ connection: "offline" }) }),
    "GET /diagnostics": () => ({ body: bundle() }),
  });
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void (copied = text) } });
  const downloads: Array<{ name: string; href: string }> = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href });
  };
  const createObjectURL = URL.createObjectURL;
  const blobs: Blob[] = [];
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return "blob:report";
  };
  try {
    const view = await render(createElement(CollabAccountDialog, { open: true, onClose() {} }));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    await click(button(/Report sync problem/));
    assert.ok(fake.calls.some((call) => call.method === "GET" && call.path === "/diagnostics"));
    const text = dialog().textContent ?? "";
    assert.match(text, /Never included/);
    assert.match(text, /Document text, file names and notebook names/);
    assert.match(text, /3 changes in 1 document, oldest 10 min/);
    assert.match(text, /4 checked, 1 differed, 1 unresolved/);
    const pre = dialog().querySelector('pre[aria-label="Sync report"]');
    assert.equal(JSON.parse(pre?.textContent ?? "{}").appVersion, "1.4.0");
    assert.ok(dialog().querySelector('[data-warn="true"]'), "long-waiting changes are highlighted");

    await click(button("Copy"));
    assert.equal(JSON.parse(copied).docs[0].docId, "doc_1");
    assert.match(dialog().textContent ?? "", /Copied to the clipboard/);

    await click(button(/Save to file/));
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^libera-sync-report-\d{8}-\d{6}\.json$/);
    assert.equal(JSON.parse(await blobs[0].text()).format, 1);

    await click(document.querySelector('[aria-label="Close the sync report"]'));
    assert.ok(button(/Report sync problem/), "closing returns to the button");
    await view.unmount();
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = createObjectURL;
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("a failed request says so and offers a retry", async () => {
  const { createElement } = await import("react");
  const { ReportSyncProblem } = await import("../../src/components/libera/collab/diagnostics/report-sync-problem");
  let attempts = 0;
  const view = await render(
    createElement(ReportSyncProblem, {
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("The collaboration service on this device is not running. Restart Libera.");
        return bundle({ errors: [], divergence: [], pending: { unackedUpdates: 0, oldestUnackedSeconds: 0, commands: 0, docsWithUnacked: 0 } });
      },
    }),
  );
  await click(button(/Report sync problem/));
  assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /not running/);
  await click(button("Try again"));
  assert.equal(attempts, 2);
  assert.match(view.host.textContent ?? "", /Waiting to syncNothing/);
  assert.equal(view.host.querySelector('[data-warn="true"]'), null, "nothing to highlight");
});
