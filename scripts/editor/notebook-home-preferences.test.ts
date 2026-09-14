import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  readNotebookFileSort,
  readNotebookFileView,
  saveNotebookFileSort,
  saveNotebookFileView,
  subscribeNotebookHomePreferences,
} from "../../src/components/libera/notebook-home-preferences";
import {
  parseSidebarSortToken,
  readSidebarSortToken,
  saveSidebarSortPreference,
} from "../../src/components/libera/sidebar-sort-preference";

test("notebook home view and sort preferences persist in validated host cookies", () => {
  const dom = new JSDOM("<!doctype html>", { url: "http://127.0.0.1:43127" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Event: dom.window.Event,
  });

  try {
    assert.equal(readNotebookFileSort(), "updated");
    assert.equal(readNotebookFileView(), "list");

    let changes = 0;
    const unsubscribe = subscribeNotebookHomePreferences(() => { changes += 1; });
    assert.equal(saveNotebookFileSort("name"), true);
    assert.equal(saveNotebookFileView("grid"), true);
    assert.equal(readNotebookFileSort(), "name");
    assert.equal(readNotebookFileView(), "grid");
    assert.equal(changes, 2);
    unsubscribe();

    dom.window.document.cookie = "libera-notebook-file-sort=invalid; Path=/";
    dom.window.document.cookie = "libera-notebook-file-view=invalid; Path=/";
    assert.equal(readNotebookFileSort(), "updated");
    assert.equal(readNotebookFileView(), "list");
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Event: previousEvent,
    });
    dom.window.close();
  }
});

test("all sidebar sort choices persist in a validated host cookie", () => {
  const dom = new JSDOM("<!doctype html>", { url: "http://127.0.0.1:43127" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Event: dom.window.Event,
  });

  try {
    assert.deepEqual(parseSidebarSortToken(readSidebarSortToken()), {
      key: "updatedAt",
      direction: "desc",
    });

    for (const key of ["name", "createdAt", "updatedAt", "interactedAt"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        assert.equal(saveSidebarSortPreference({ key, direction }), true);
        assert.deepEqual(parseSidebarSortToken(readSidebarSortToken()), { key, direction });
      }
    }

    dom.window.document.cookie = "libera-sidebar-sort=invalid; Path=/";
    assert.deepEqual(parseSidebarSortToken(readSidebarSortToken()), {
      key: "updatedAt",
      direction: "desc",
    });
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Event: previousEvent,
    });
    dom.window.close();
  }
});
