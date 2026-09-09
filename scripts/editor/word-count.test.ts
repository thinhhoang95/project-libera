import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getMarkdownWordCountStats } from "../../src/lib/markdown-word-count";
import { useWordCount, WORD_COUNT_DELAY_MS } from "../../src/components/libera/use-word-count";

test("word counts retain the dialog's Markdown and reading-time rules", () => {
  assert.deepEqual(getMarkdownWordCountStats(""), {
    characters: 0, charactersNoSpaces: 0, lines: 0, paragraphs: 0, readingMinutes: 0, words: 0,
  });
  assert.deepEqual(getMarkdownWordCountStats("Hello world\n\nGood day"), {
    characters: 21, charactersNoSpaces: 17, lines: 3, paragraphs: 2, readingMinutes: 1, words: 4,
  });
  assert.equal(getMarkdownWordCountStats("# Hello **world**\n\n[Read this](https://example.com) `ignored code`\n```\nalso ignored\n```").words, 4);
  assert.equal(getMarkdownWordCountStats("word ".repeat(201)).readingMinutes, 2);
});

test("status counts wait for a pause, cancel stale work, and reset for another document", async (context) => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>");
  const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot(document.getElementById("root")!);
  let stats: ReturnType<typeof useWordCount>;
  function Harness({ content }: { content: string }) {
    stats = useWordCount(content);
    return null;
  }
  const render = async (content: string, key = "first") => {
    await act(async () => root.render(createElement(Harness, { content, key })));
  };
  const tick = async (ms: number) => {
    await act(async () => context.mock.timers.tick(ms));
  };
  try {
    await render("One");
    const initial = stats!;
    await render("One two");
    await tick(WORD_COUNT_DELAY_MS - 1);
    assert.equal(stats!, initial);
    await render("One two three");
    await tick(WORD_COUNT_DELAY_MS - 1);
    assert.equal(stats!, initial);
    await tick(1);
    assert.equal(stats!.words, 3);
    const settled = stats!;
    await render("One two three");
    await tick(WORD_COUNT_DELAY_MS * 2);
    assert.equal(stats!, settled);
    await render("Pending old document edit");
    await render("New document", "second");
    assert.equal(stats!.words, 2);
    await tick(WORD_COUNT_DELAY_MS);
    assert.equal(stats!.words, 2);
    await render("Pending edit before unmount");
    await act(async () => root.unmount());
    const beforeUnmount = stats!;
    await tick(WORD_COUNT_DELAY_MS);
    assert.equal(stats!, beforeUnmount);
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset();
    dom.window.close();
    globals.forEach((key, index) => {
      if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
