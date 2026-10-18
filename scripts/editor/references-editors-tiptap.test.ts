import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { MarkdownManager } from "@tiptap/markdown";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { CITATION_SYNTAX_CASES, serializeCitation } from "../../src/lib/references/citation-syntax";
import {
  CITATION_NODE_NAME, citationRawForTrigger, citationTokenAt, convertLiteralCitations, tiptapCitationTriggerAt, updateCitationNode,
} from "../../src/lib/tiptap-citation";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
after(() => dom.window.close());

const extensions = () => [...createMarkdownExtensions("Notebook/note.md"), ...createMathExtensions()];

function create(content: string) {
  return new Editor({ extensions: extensions(), content, contentType: "markdown" });
}

function citationRaws(json: JSONContent): string[] {
  const raws: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === CITATION_NODE_NAME) raws.push(String(node.attrs?.raw));
    node.content?.forEach(walk);
  };
  walk(json);
  return raws;
}

// Cases the Visual editor cannot represent as the scanner sees them:
// - front matter: TipTap has no front matter, so its YAML is read as Markdown;
// - CRLF: Marked normalizes line endings to LF, so the raw differs by the CR
//   (the citation and its items are the same);
// - a citation continued on a quoted line: TipTap's blockquote holds the
//   paragraph without the `> ` prefix, so the raw lacks it (saving restores it).
const SKIPPED = new Set(["front matter"]);
const normalizeRaw = (name: string, raw: string) => name === "CRLF line break" ? raw.replace(/\r\n/g, "\n")
  : name === "multi-line citation in a blockquote" ? raw.replace(/\n> /g, "\n") : raw;

test("the TipTap Markdown parse agrees with the shared citation grammar table", () => {
  const manager = new MarkdownManager({ extensions: extensions() });
  const failures: string[] = [];
  for (const entry of CITATION_SYNTAX_CASES) {
    if (SKIPPED.has(entry.name)) continue;
    const raws = citationRaws(manager.parse(entry.source));
    const expected = entry.expected.map((citation) => normalizeRaw(entry.name, citation.raw));
    if (JSON.stringify(raws) !== JSON.stringify(expected)) failures.push(`${entry.name}: got ${JSON.stringify(raws)}, expected ${JSON.stringify(expected)}`);
  }
  assert.deepEqual(failures, []);
});

test("citations round-trip byte for byte through the Visual editor", () => {
  const source = [
    "# Results [@a]",
    "",
    "As shown [see @smith2020sparse, p. 12; -@lee2019, ch. 3] and [@doe:2020.a/b].",
    "",
    "> Quoted [see",
    "> @a] here.",
    "",
    "- item [@b, pp. 33-35 and passim]",
    "- **bold** [@c] and `[@code]`",
    "",
    "1. Sparse [@a, § 4.2]",
    "",
    "Math $x$ then [@a,p.3] and see [@d].",
  ].join("\n");
  const editor = create(source);
  assert.equal(editor.getMarkdown(), source);
  assert.deepEqual(citationRaws(editor.getJSON()), ["[@a]", "[see @smith2020sparse, p. 12; -@lee2019, ch. 3]", "[@doe:2020.a/b]", "[see\n@a]", "[@b, pp. 33-35 and passim]", "[@c]", "[@a, § 4.2]", "[@a,p.3]", "[@d]"]);
  editor.destroy();
});

test("an unrelated edit keeps every citation byte-identical (no \\[@key\\] escaping)", () => {
  const source = "Intro [@a, p. 3] and [see -@b; @c, ch. 2].\n\nSecond paragraph.";
  const editor = create(source);
  const end = editor.state.doc.content.size - 1;
  editor.commands.insertContentAt(end, " More text.");
  const markdown = editor.getMarkdown();
  assert.ok(markdown.includes("Intro [@a, p. 3] and [see -@b; @c, ch. 2]."), markdown);
  assert.ok(!markdown.includes("\\["), markdown);
  assert.ok(markdown.endsWith("Second paragraph. More text."), markdown);
  editor.destroy();
});

test("typing a complete [@key] in the Visual editor turns it into a citation node", () => {
  const editor = create("Text ");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  const typed = "[@smith2020]";
  const view = editor.view;
  for (const char of typed) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
  assert.deepEqual(citationRaws(editor.getJSON()), ["[@smith2020]"]);
  assert.equal(editor.getMarkdown(), "Text [@smith2020]");
  editor.destroy();
});

test("inline insertion of [@key] Markdown (Cite at cursor) produces a citation node", async () => {
  const { replaceTiptapRangeWithMarkdown } = await import("../../src/lib/tiptap-editor-actions");
  const editor = create("Before after");
  const at = 8; // after "Before " inside the paragraph
  replaceTiptapRangeWithMarkdown(editor, { from: at, to: at }, "[@key2020]");
  assert.deepEqual(citationRaws(editor.getJSON()), ["[@key2020]"]);
  assert.equal(editor.getMarkdown(), "Before [@key2020]after");
  editor.destroy();
});

test("parseHTML reads preview citations and renderHTML writes the contract DOM", () => {
  const editor = create("");
  editor.commands.setContent('<p>See <span class="libera-citation libera-citation-unresolved" data-libera-citation="[@a, p. 3 &amp; 4]" data-formatted="true">(Smith, 2020, p. 3)</span>.</p>', { contentType: "html" } as never);
  assert.deepEqual(citationRaws(editor.getJSON()), ["[@a, p. 3 & 4]"]);
  assert.equal(editor.getMarkdown(), "See [@a, p. 3 & 4].");
  const html = editor.getHTML();
  assert.match(html, /<span class="libera-citation" data-libera-citation="\[@a, p\. 3 &amp; 4\]">\[@a, p\. 3 &amp; 4\]<\/span>/);
  editor.destroy();
});

test("the inline token rule: not after !, not escaped, not before ( or [", () => {
  assert.equal(citationTokenAt("[@a, p. 3] x"), "[@a, p. 3]");
  assert.equal(citationTokenAt("![@a]", 1), null);
  assert.equal(citationTokenAt("\[@a]", 1), null);
  assert.equal(citationTokenAt("[@a](url)"), null);
  assert.equal(citationTokenAt("[@a][ref]"), null);
  assert.equal(citationTokenAt("[@a]", 0, "!"), null, "a ! ending the previous Markdown token");
  assert.equal(citationTokenAt("[see above]"), null);
});

test("pasted text with citations becomes nodes, except inside code and links", () => {
  const editor = create("x");
  const schema = editor.schema;
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("See [@a] and ![@img] or \\[@esc] then [@b](url) "),
    schema.text("[@code]", [schema.marks.code.create()]),
    schema.text(" [@link]", [schema.marks.link.create({ href: "x" })]),
  ]);
  const converted = convertLiteralCitations(new Slice(paragraph.content, 0, 0).content, schema);
  const raws: string[] = [];
  converted.forEach((node) => { if (node.type.name === CITATION_NODE_NAME) raws.push(node.attrs.raw); });
  assert.deepEqual(raws, ["[@a]"]);
  editor.destroy();
});

test("copying a citation node yields its raw token", () => {
  const editor = create("A [see @a, p. 4] b");
  let citationPos = -1;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === CITATION_NODE_NAME) citationPos = pos; });
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, citationPos)));
  const content = editor.state.selection.content().content.toJSON();
  assert.equal(editor.markdown!.serialize({ type: "doc", content }), "[see @a, p. 4]");
  // Plain text copy reads the token too (leafText).
  assert.equal(editor.state.doc.textBetween(0, editor.state.doc.content.size), "A [see @a, p. 4] b");
  editor.destroy();
});

test("popover edits replace raw with serializeCitation output", () => {
  const editor = create("A [@a,p.3] b");
  let pos = -1;
  editor.state.doc.descendants((node, at) => { if (node.type.name === CITATION_NODE_NAME) pos = at; });
  const items = [{ key: "a", label: "chapter" as const, locator: "3", prefix: "see", suppressAuthor: true }, { key: "b", suffix: "emphasis added" }];
  assert.equal(updateCitationNode(editor, pos, { items }), true);
  assert.equal(editor.getMarkdown(), `A ${serializeCitation({ items })} b`);
  assert.equal(editor.getMarkdown(), "A [see -@a, ch. 3; @b, emphasis added] b");
  // Removing every item removes the citation.
  updateCitationNode(editor, pos, { items: [] });
  assert.equal(editor.getMarkdown(), "A  b");
  editor.destroy();
});

function triggerAt(editor: Editor, pos: number) {
  return tiptapCitationTriggerAt(editor.state.doc.resolve(pos));
}

function endOf(editor: Editor, text: string) {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return;
    const index = node.text!.indexOf(text);
    if (index >= 0) found = pos + index + text.length;
  });
  assert.ok(found >= 0, `text ${text} not found`);
  return found;
}

test("the TipTap @ trigger fires in prose and never in code, math, emails or links", () => {
  const editor = create("Prose @smi\n\nMail me@exa\n\n`code @smi`\n\n```\nblock @smi\n```\n\nMath $x @y$ after @ok\n\n[see @le");
  const prose = triggerAt(editor, endOf(editor, "@smi"));
  assert.equal(prose?.query, "smi");
  assert.equal(prose?.insideCitation, false);
  assert.equal(triggerAt(editor, endOf(editor, "me@exa")), null);
  assert.equal(triggerAt(editor, endOf(editor, "code @smi")), null);
  assert.equal(triggerAt(editor, endOf(editor, "block @smi")), null);
  assert.equal(triggerAt(editor, endOf(editor, "after @ok"))?.query, "ok");
  const inside = triggerAt(editor, endOf(editor, "[see @le"));
  assert.equal(inside?.insideCitation, true);
  assert.equal(inside?.open, "[see ");
  assert.equal(citationRawForTrigger(inside!, "lee2019"), "[see @lee2019]");
  assert.equal(citationRawForTrigger({ insideCitation: false }, "lee2019"), "[@lee2019]");
  // Inline math is an atom: no text position lies inside it.
  let mathCount = 0;
  editor.state.doc.descendants((node) => { if (node.type.name === "inlineMath") mathCount += 1; });
  assert.equal(mathCount, 1);
  editor.destroy();
});

test("the controller reports the @ suggestion while typing", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TiptapCitationLayer, useTiptapCitations } = await import("../../src/components/libera/references/tiptap-citation-view");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  let controller: ReturnType<typeof useTiptapCitations> | null = null;
  function Capture() {
    controller = useTiptapCitations();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Capture)));
  const editor = new Editor({
    extensions: [...createMarkdownExtensions("Notebook/note.md", { citationNodeView: controller!.nodeView }), ...controller!.extensions, ...createMathExtensions()],
    content: "Hello", contentType: "markdown",
  });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  await act(async () => root.render(createElement(TiptapCitationLayer, { editor, citations: controller! })));
  // Type " @smi" one character at a time, as the user would.
  for (const char of " @smi") editor.view.dispatch(editor.state.tr.insertText(char));
  const suggestion = controller!.getSuggestion();
  assert.ok(suggestion, "the suggestion opened");
  assert.equal(suggestion!.trigger.query, "smi");
  assert.equal(editor.state.selection instanceof TextSelection, true);
  editor.destroy();
  await act(async () => root.unmount());
  container.remove();
});
