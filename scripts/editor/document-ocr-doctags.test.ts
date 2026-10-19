import assert from "node:assert/strict";
import { test } from "node:test";
import { docTagsToMarkdown, joinDocumentPages, PICTURE_PLACEHOLDER_PREFIX, type DocumentBlock } from "../../src/lib/document-ocr/doctags";

const loc = (a: number, b: number, c: number, d: number) => `<loc_${a}><loc_${b}><loc_${c}><loc_${d}>`;

test("converts headings and paragraphs, and drops page furniture and locations", () => {
  const { markdown, blocks } = docTagsToMarkdown(
    `<doctag><page_header>${loc(10, 5, 200, 12)}Journal of Things, Vol. 3</page_header>` +
      `<title>${loc(100, 40, 400, 60)}Attention Is All You Need</title>\n` +
      `<section_header_level_1>${loc(50, 80, 200, 90)}1 Introduction</section_header_level_1>\n` +
      `<text>${loc(50, 100, 450, 140)}Recurrent neural networks have been firmly\nestablished.</text>\n` +
      `<page_footer>${loc(240, 480, 260, 490)}12</page_footer></doctag><|end_of_text|>`,
  );

  assert.equal(markdown, "# Attention Is All You Need\n\n## 1 Introduction\n\nRecurrent neural networks have been firmly established.");
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "heading", "paragraph"]);
  assert.deepEqual(blocks[0].box, { x: 0.2, y: 0.08, width: 0.6, height: 0.04 });
});

test("uses the configured math markers for display and inline formulas", () => {
  const { markdown } = docTagsToMarkdown(
    `<doctag><formula>${loc(1, 1, 9, 9)}E = mc^{2}</formula>` +
      `<inline>${loc(1, 10, 9, 19)}where <formula>m</formula> is mass.</inline></doctag>`,
    { inlineMathMarkers: "$ $", blockMathMarkers: "$$ $$" },
  );

  assert.equal(markdown, "$$\nE = mc^{2}\n$$\n\nwhere $m$ is mass.");
});

test("turns OTSL tables into Markdown tables, with merged and empty cells", () => {
  const { markdown, blocks } = docTagsToMarkdown(
    `<doctag><otsl>${loc(1, 1, 400, 100)}<ched>Model<ched>BLEU<ched>Cost<nl>` +
      `<fcel>Transformer<fcel>28.4<lcel><nl><fcel>a|b<ecel><fcel>1.0<nl>` +
      `<caption>${loc(1, 101, 400, 110)}Table 1: Results.</caption></otsl></doctag>`,
  );

  assert.equal(blocks[0].kind, "table");
  assert.equal(
    markdown,
    "| Model | BLEU | Cost |\n| --- | --- | --- |\n| Transformer | 28.4 |   |\n| a\\|b |   | 1.0 |\n\nTable 1: Results.",
  );
});

test("writes lists, nested lists and code", () => {
  const { markdown } = docTagsToMarkdown(
    "<doctag><unordered_list><list_item>• First</list_item><list_item>Second" +
      "<ordered_list><list_item>1. Inner</list_item></ordered_list></list_item></unordered_list>" +
      "<code><_Python_>def f():\n    return 1</code></doctag>",
  );

  assert.equal(markdown, "- First\n- Second\n   1. Inner\n\n```python\ndef f():\n    return 1\n```");
});

test("leaves a placeholder for each picture, with its caption", () => {
  const { markdown, pictures, blocks } = docTagsToMarkdown(
    `<doctag><picture>${loc(100, 100, 300, 250)}<caption>${loc(100, 252, 300, 260)}Figure 1: The [model].</caption></picture></doctag>`,
  );

  assert.deepEqual(pictures, [{ index: 0, box: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 }, caption: "Figure 1: The [model]." }]);
  assert.equal(blocks[0].pictureIndex, 0);
  assert.equal(markdown, `![Figure 1: The model.](${PICTURE_PLACEHOLDER_PREFIX}0)\n\nFigure 1: The [model].`);
});

test("survives output cut off mid-element and escapes accidental Markdown", () => {
  const { markdown } = docTagsToMarkdown(`<doctag><text>${loc(1, 1, 9, 9)}# not a heading</text><text>${loc(1, 10, 9, 19)}The model stopped here`);
  assert.equal(markdown, "\\# not a heading\n\nThe model stopped here");
});

test("joins a paragraph across a page break, including a hyphenated word", () => {
  const page = (...blocks: Array<[DocumentBlock["kind"], string]>) => blocks.map(([kind, markdown]) => ({ kind, markdown }));

  assert.equal(
    joinDocumentPages([
      page(["paragraph", "The encoder maps an input se-"], ["footnote", "1 A footnote."]),
      page(["paragraph", "quence to a continuous representation."], ["paragraph", "Next paragraph."]),
    ]),
    "The encoder maps an input sequence to a continuous representation.\n\n1 A footnote.\n\nNext paragraph.",
  );

  assert.equal(
    joinDocumentPages([page(["paragraph", "It ends here."]), page(["paragraph", "A new paragraph starts."])]),
    "It ends here.\n\nA new paragraph starts.",
  );

  assert.equal(
    joinDocumentPages([page(["paragraph", "as shown by Smith and"]), page(["paragraph", "Jones in 2017."])]),
    "as shown by Smith and Jones in 2017.",
  );

  assert.equal(
    joinDocumentPages([page(["paragraph", "Before the heading"]), page(["heading", "## 2 Methods"])]),
    "Before the heading\n\n## 2 Methods",
  );
});
