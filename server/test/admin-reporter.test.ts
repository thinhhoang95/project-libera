// The error reporter (server/src/observability/reporter.ts): DSN parsing, the
// envelope, and above all that no document content, comment body, email or
// token ever leaves in a report.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  buildEvent,
  createErrorReporter,
  envelope,
  exceptionValues,
  parseDsn,
  scrubContext,
  scrubMessage,
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from "../src/observability/reporter.js";

const SECRET_TEXT = "The quarterly plan: acquire Initech";
const META = { release: "libera-collab@test", environment: "test" };

describe("scrubbing", () => {
  test("messages lose quoted text, emails, tokens, key details and long blobs", () => {
    assert.equal(scrubMessage(`Cannot apply "${SECRET_TEXT}" to doc_abc`), 'Cannot apply "[redacted]" to doc_abc');
    assert.equal(scrubMessage(`bad value '${SECRET_TEXT}'`), "bad value '[redacted]'");
    assert.equal(scrubMessage("Key (email)=(alice@example.com) already exists."), "Key (email)=([redacted]) already exists.");
    assert.equal(scrubMessage("invite sent to bob@example.org failed"), "invite sent to [email] failed");
    assert.equal(scrubMessage("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [redacted]");
    assert.equal(scrubMessage("token eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl rejected"), "token [token] rejected");
    assert.equal(scrubMessage(`update ${"QUJD".repeat(20)} failed`), "update [blob] failed");
    assert.equal(scrubMessage("word ".repeat(100)).length, 301);
    assert.equal(scrubMessage("Document doc_123 has no manifest sub-document."), "Document doc_123 has no manifest sub-document.");
  });

  test("context keeps id tags and numbers, and drops everything else", () => {
    const context: ReportContext = {
      docId: "doc_abc",
      route: "/v1/documents/:docId",
      size: 1234,
      durationMs: 5.5,
      retried: true,
      body: SECRET_TEXT,
      text: "hello",
      docIdWithSpace: "doc abc",
      accountId: "alice@example.com",
      subdoc: "content",
      "bad key": 1,
      clientId: undefined,
      code: null,
    };
    assert.deepEqual(scrubContext(context), {
      tags: { docId: "doc_abc", route: "/v1/documents/:docId", subdoc: "content" },
      extra: { size: 1234, durationMs: 5.5, retried: true },
    });
  });

  test("events carry type, scrubbed message, frames and causes, and never the content", () => {
    const cause = new Error(`yjs failed on '${SECRET_TEXT}'`);
    const error = new Error(`Update for "${SECRET_TEXT}" could not be saved`, { cause });
    (error as Error & { code: string }).code = "ECONNRESET";
    (error as Error & { body: string }).body = SECRET_TEXT;
    const event = buildEvent(error, { docId: "doc_1", body: SECRET_TEXT }, META);
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("Initech"), serialized);
    assert.equal(event.exception.values.length, 2);
    const [inner, outer] = event.exception.values;
    assert.equal(outer.type, "Error");
    assert.equal(outer.value, '[ECONNRESET] Update for "[redacted]" could not be saved');
    assert.equal(inner.value, "yjs failed on '[redacted]'");
    const frames = outer.stacktrace?.frames ?? [];
    assert.ok(frames.length > 0);
    assert.ok(frames.some((frame) => frame.filename.includes("admin-reporter.test.ts") && frame.in_app));
    assert.ok(frames.every((frame) => typeof frame.lineno === "number"));
    assert.deepEqual(event.tags, { docId: "doc_1" });
    assert.equal(event.release, "libera-collab@test");
    assert.match(event.event_id, /^[0-9a-f]{32}$/);
  });

  test("thrown non-errors report only their kind", () => {
    assert.deepEqual(exceptionValues(SECRET_TEXT), [{ type: "Non-Error string", value: "" }]);
    assert.deepEqual(exceptionValues({ text: SECRET_TEXT }), [{ type: "NonErrorObject", value: "" }]);
  });
});

describe("transport", () => {
  test("parses DSNs into envelope endpoints", () => {
    assert.deepEqual(parseDsn("https://abc123@glitchtip.example.com/7"), {
      envelopeUrl: "https://glitchtip.example.com/api/7/envelope/",
      publicKey: "abc123",
      projectId: "7",
    });
    assert.equal(parseDsn("http://key:secret@host:8000/sentry/42").envelopeUrl, "http://host:8000/sentry/api/42/envelope/");
    assert.throws(() => parseDsn("not a url"));
    assert.throws(() => parseDsn("https://host/1"), /public key/);
    assert.throws(() => parseDsn("ftp://k@host/1"));
  });

  test("posts one envelope per event with the Sentry auth header, rate limited", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const reporter = createErrorReporter({ dsn: "https://pub@errors.example/3", ...META, fetch: fakeFetch, maxPerMinute: 2 });
    assert.equal(reporter.enabled, true);
    const id = reporter.capture(new Error(`boom "${SECRET_TEXT}"`), { docId: "doc_9" });
    assert.match(id ?? "", /^[0-9a-f]{32}$/);
    reporter.capture(new Error("second"));
    assert.equal(reporter.capture(new Error("third")), null, "over the per-minute limit");
    await reporter.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://errors.example/api/3/envelope/");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.match(headers["x-sentry-auth"], /sentry_key=pub/);
    const lines = String(calls[0].init.body).trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).event_id, id);
    assert.equal(JSON.parse(lines[1]).type, "event");
    assert.equal(JSON.parse(lines[2]).tags.docId, "doc_9");
    assert.ok(!String(calls[0].init.body).includes("Initech"));
  });

  test("no DSN means no reporting, and a failing endpoint never throws", async () => {
    const off = createErrorReporter({ ...META });
    assert.equal(off.enabled, false);
    assert.equal(off.capture(new Error("x")), null);
    const failures: unknown[] = [];
    const broken = createErrorReporter({
      dsn: "https://pub@errors.example/3",
      ...META,
      fetch: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      onTransportError: (error) => failures.push(error),
    });
    assert.ok(broken.capture(new Error("x")));
    await broken.flush();
    assert.equal(failures.length, 1);
    assert.ok(envelope(buildEvent(new Error("y"), {}, META), "https://pub@errors.example/3").endsWith("\n"));
  });
});

describe("wiring", () => {
  test("unexpected HTTP errors are reported with route and ids, client errors are not", async () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory", PORT: "0" });
    const server = await buildServer({ config, jobs: false });
    const captured: Array<{ error: unknown; context?: ReportContext }> = [];
    const fake: ErrorReporter = { enabled: true, capture: (error, context) => (captured.push({ error, context }), "id"), flush: async () => undefined };
    setErrorReporter(server.context, fake);
    server.app.post("/test/boom/:docId", async () => {
      throw new Error(`Failed on "${SECRET_TEXT}"`);
    });
    try {
      const boom = await server.app.inject({ method: "POST", url: "/test/boom/doc_7", payload: { text: SECRET_TEXT } });
      assert.equal(boom.statusCode, 500);
      assert.ok(!boom.body.includes("Initech"));
      const missing = await server.app.inject({ method: "GET", url: "/v1/documents/doc_7" });
      assert.equal(missing.statusCode, 401);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].context?.area, "http");
      assert.equal(captured[0].context?.route, "/test/boom/:docId");
      assert.equal(captured[0].context?.method, "POST");
      const event = buildEvent(captured[0].error, captured[0].context, META);
      assert.ok(!JSON.stringify(event).includes("Initech"));
    } finally {
      await server.close();
    }
  });
});
