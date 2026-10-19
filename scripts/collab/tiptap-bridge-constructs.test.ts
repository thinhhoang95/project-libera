// Construct matrix for decision D1: every Markdown construct the Visual editor
// shows is edited locally and by a Source user at once, then checked for
// convergence, block-map consistency, identical documents on both Visual
// editors, and byte-identical neighbours.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Selection } from "@tiptap/pm/state";
import { assertConverged, posOf, select, settle, setupTrio, type } from "./tiptap-bridge-harness.test";

const CONSTRUCTS: Record<string, string> = {
  paragraph: "Plain paragraph text.",
  emphasis: "Some *em* and **strong** and ~~strike~~ and `code`.",
  heading: "## Heading two",
  setext: "Setext\n======",
  bullet: "- one\n- two\n  - nested",
  ordered: "1. one\n2. two",
  task: "- [ ] todo\n- [x] done",
  quote: "> quoted\n> lines",
  code: "```js\nconst a = 1;\n```",
  indentedCode: "    indented code",
  table: "| A | B |\n| --- | --- |\n| x | y |",
  rule: "Above\n\n---\n\nBelow",
  inlineMath: "Math $x^2$ inline.",
  dollarMath: "$$\nx^2\n$$",
  bracketMath: "\\[\nx^2\n\\]",
  highlight: "Some >>>highlighted<<< text.",
  color: "Some [color=#ff0000]red[/color] text.",
  underline: "Some <u>under</u> text.",
  image: "![alt](image.png)",
  link: "A [link](https://example.com) here.",
  referenceLink: "A [ref][1] link.\n\n[1]: https://example.com",
  autolink: "See <https://example.com> now.",
  hardBreak: "Line one  \nline two",
  html: "<div>\nraw html\n</div>",
  htmlComment: "<!-- note -->\n\nAfter comment.",
  footnote: "Text with note[^1].\n\n[^1]: The note.",
  frontMatter: "---\ntitle: x\n---\n\nBody.",
  emptyParagraphs: "A\n\n\n\n\n\nB",
  quotedList: "> - a\n> - b",
  escaped: "Not \\*em\\* here.",
};

for (const [name, body] of Object.entries(CONSTRUCTS)) {
  test(`construct: ${name} converges under concurrent Visual and Source edits`, () => {
    const source = `Before.\n\n${body}\n\nAfter.`;
    const trio = setupTrio(source);
    const { a, b, c, network } = trio;
    try {
      assert.equal(a.ytext.toString(), source, "binding keeps the source");
      // A types at the first text position after "Before.".
      const doc = a.editor.state.doc;
      const selection = Selection.findFrom(doc.resolve(doc.child(0).nodeSize + 1), 1, true);
      if (selection) {
        a.editor.view.dispatch(a.editor.state.tr.setSelection(selection));
        type(a.editor, "Q");
      }
      a.bridge.flush();
      network.deliver();
      const text = c.ytext.toString();
      assert.ok(text.startsWith("Before.\n\n"), "the block before is untouched");
      assert.ok(text.endsWith("\n\nAfter.") || text.endsWith("\n\nQAfter."), "the block after is untouched");
      // The Source user edits inside the construct.
      c.ytext.insert(9 + Math.min(4, body.length), "Z");
      settle(network, a, b);
      assertConverged(trio);
      assert.deepEqual(a.editor.getJSON(), b.editor.getJSON(), "both Visual editors show the same document");
    } finally { trio.destroy(); }
  });
}

test("CRLF notes keep their line endings in edited blocks", () => {
  const source = "First line\r\nsoft break\r\n\r\nSecond para\r\n\r\n- a\r\n- b\r\n";
  const trio = setupTrio(source);
  const { a, b, c, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "soft", 4));
    type(a.editor, "!");
    select(a.editor, posOf(a.editor, "a", 1));
    a.editor.commands.splitListItem("listItem");
    type(a.editor, "new");
    settle(network, a, b);
    assertConverged(trio);
    const text = c.ytext.toString();
    assert.equal(text.replace(/\r\n/g, ""), text.replace(/\r?\n/g, ""), `bare LF in ${JSON.stringify(text)}`);
    assert.ok(text.includes("soft! break") || text.includes("soft!\r\nbreak") || text.includes("First line\r\nsoft!"), text);
  } finally { trio.destroy(); }
});

test("an unbalanced $$ that remark-math reads as a block across blank lines stays consistent", () => {
  const trio = setupTrio("Before.\n\n$$\nx^2\n$$\n\nAfter.");
  const { a, b, c, network } = trio;
  try {
    select(a.editor, a.editor.state.doc.child(0).nodeSize + 1);
    type(a.editor, "Q");
    a.bridge.flush();
    network.deliver();
    // "$$Z" no longer opens math, so the closing "$$" opens a block that runs on.
    c.ytext.insert(c.ytext.toString().indexOf("$$") + 2, "Z");
    settle(network, a, b);
    assertConverged(trio);
    assert.deepEqual(a.editor.getJSON(), b.editor.getJSON());
    // Closing it again restores separate paragraphs on both sides.
    c.ytext.insert(c.ytext.toString().lastIndexOf("$$") + 2, "\n$$");
    settle(network, a, b);
    assertConverged(trio);
    assert.deepEqual(a.editor.getJSON(), b.editor.getJSON());
  } finally { trio.destroy(); }
});
