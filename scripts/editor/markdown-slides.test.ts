import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markdownSlideIndexAtOffset,
  parseMarkdownSlides,
  visibleMarkdownSlides,
} from "../../src/lib/markdown-slides";

test("deck metadata makes a title slide; --- starts each slide", () => {
  const deck = parseMarkdownSlides([
    '$title = "Results"',
    '$author = ["Ada", "Grace"]',
    "$date = 2026",
    "---",
    "$title = \"Method\"",
    "",
    "Body",
  ].join("\n"));

  assert.equal(deck.title, "Results");
  assert.deepEqual(deck.author, ["Ada", "Grace"]);
  assert.equal(deck.date, "2026");
  assert.deepEqual(deck.slides.map((slide) => [slide.kind, slide.title]), [["title", "Results"], ["slide", "Method"]]);
  assert.equal(deck.slides[1].content, "Body");
  assert.deepEqual(deck.diagnostics, []);
});

test("bare metadata values are text; broken JSON is a warning", () => {
  const deck = parseMarkdownSlides("$title = My talk\n$subtitle = [oops\n---\nBody");

  assert.equal(deck.title, "My talk");
  assert.equal(deck.subtitle, undefined);
  assert.equal(deck.diagnostics.length, 1);
  assert.match(deck.diagnostics[0].message, /\$subtitle/);
});

test("a slide opening with $math$ keeps it as content", () => {
  const deck = parseMarkdownSlides("---\n$x^2$ grows fast");

  assert.equal(deck.slides[0].content, "$x^2$ grows fast");
  assert.deepEqual(deck.diagnostics, []);
});

test("a leading # or ## heading becomes the slide title", () => {
  const deck = parseMarkdownSlides("# The deck\n---\n## Motivation\n\nWhy it matters\n---\n### Small heading stays");

  assert.equal(deck.title, "The deck");
  assert.equal(deck.slides[1].title, "Motivation");
  assert.equal(deck.slides[1].content, "Why it matters");
  assert.equal(deck.slides[2].title, undefined);
  assert.equal(deck.slides[2].content, "### Small heading stays");
});

test("YAML-style front matter is deck metadata", () => {
  const deck = parseMarkdownSlides([
    "---",
    "title: Field notes",
    "author:",
    "  - Ada",
    "  - 'Grace'",
    "theme: dark",
    "---",
    "First slide",
  ].join("\n"));

  assert.equal(deck.title, "Field notes");
  assert.deepEqual(deck.author, ["Ada", "Grace"]);
  assert.equal(deck.theme, "dark");
  assert.deepEqual(deck.slides.map((slide) => slide.kind), ["title", "slide"]);
  assert.equal(deck.slides[1].content, "First slide");
});

test("a first slide that only looks like key: value stays a slide", () => {
  const deck = parseMarkdownSlides("---\nNote: read this\n---\nSecond");

  assert.deepEqual(deck.slides.map((slide) => slide.content), ["Note: read this", "Second"]);
});

test("??? starts speaker notes", () => {
  const deck = parseMarkdownSlides("---\n## Plan\n\nShown\n\n???\nSay it slowly");

  assert.equal(deck.slides[0].content, "Shown");
  assert.equal(deck.slides[0].notes, "Say it slowly");
});

test("-- after a blank line is a build step; under text it is a heading underline", () => {
  const deck = parseMarkdownSlides("---\nFirst\n\n--\n\nSecond\n\n--\nThird\n--");
  const [slide] = deck.slides;

  assert.equal(slide.stepCount, 3);
  assert.deepEqual(slide.segments.map((segment) => [segment.step, segment.content]), [
    [0, "First"],
    [1, "Second"],
    [2, "Third\n--"],
  ]);
});

test("||| splits columns, and steps run across them in reading order", () => {
  const deck = parseMarkdownSlides("---\n$columns = [2, 1]\nLeft\n\n--\n\nLeft later\n|||\nRight");
  const [slide] = deck.slides;

  assert.equal(slide.columnCount, 2);
  assert.deepEqual(slide.columnWidths, [2, 1]);
  assert.deepEqual(slide.segments.map((segment) => [segment.column, segment.step]), [[0, 0], [0, 1], [1, 1]]);
});

test("markers inside code fences and HTML comments are content", () => {
  const deck = parseMarkdownSlides("---\n```yaml\n---\n--\n???\n```\n<!--\n---\n-->\nAfter");

  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0].notes, "");
  assert.equal(deck.slides[0].stepCount, 1);
  assert.match(deck.slides[0].content, /After$/);
});

test("citation indexes count every segment across the deck", () => {
  const deck = parseMarkdownSlides("$title = T\n---\nA\n|||\nB\n---\nC");

  assert.deepEqual(
    deck.slides.flatMap((slide) => slide.segments.map((segment) => segment.citationIndex)),
    [0, 1, 2, 3],
  );
});

test("deck options are validated with warnings", () => {
  const deck = parseMarkdownSlides([
    "$theme = neon",
    "$aspect = 4:3",
    "$accent = #ff0066",
    "$paginate = false",
    "$footer = false",
    "---",
    "$layout = sideways",
    "Body",
  ].join("\n"));

  assert.equal(deck.theme, "light");
  assert.equal(deck.aspect.width, 720);
  assert.equal(deck.accent, "#ff0066");
  assert.equal(deck.paginate, false);
  assert.equal(deck.footer, false);
  assert.equal(deck.slides[0].layout, "default");
  assert.equal(deck.diagnostics.length, 2);
});

test("hidden slides stay in the deck but not the presentation", () => {
  const deck = parseMarkdownSlides("---\nA\n---\n$hidden = true\nB\n---\nC");

  assert.equal(deck.slides.length, 3);
  assert.deepEqual(visibleMarkdownSlides(deck).map((slide) => slide.content), ["A", "C"]);
});

test("the caret maps to the slide that contains it", () => {
  const source = "$title = T\n---\nFirst\n---\nSecond";
  const deck = parseMarkdownSlides(source);

  assert.equal(markdownSlideIndexAtOffset(deck, 0), 0);
  assert.equal(markdownSlideIndexAtOffset(deck, source.indexOf("First")), 1);
  assert.equal(markdownSlideIndexAtOffset(deck, source.length), 2);
  assert.equal(deck.slides[2].bodyStart, source.indexOf("Second"));
});
