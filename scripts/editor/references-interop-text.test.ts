import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { buildAgentSystemPrompt } from "../../src/lib/agent/prompt";
import { copyRenderedMarkdownSelection, getRenderedSelectionMarkdown } from "../../src/lib/markdown-clipboard";
import { markdownPassageWords } from "../../src/lib/markdown-outline-navigation";
import { getMarkdownWordCountStats } from "../../src/lib/markdown-word-count";
import { chunkMarkdown, documentPrompt, embeddingText } from "../../src/lib/search/chunking";

const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "Element", "HTMLElement", "DOMParser"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
after(() => dom.window.close());

// The "Rendered citation DOM" contract: RAW is the source token, HTML-escaped.
const RAW = `[see @smith2020sparse, p. 3; -@doe_2019, "quoted" & <more>]`;
const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function preview() {
  const host = document.createElement("div");
  host.innerHTML = [
    `<div class="markdown-body" data-copy-markdown="">`,
    `<p>Sparse codes help <span class="libera-citation" data-libera-citation="${escapeAttribute(RAW)}">(see Smith, 2020, p. 3; 2019, “quoted” &amp; &lt;more&gt;)</span> a lot.</p>`,
    `<p>Unknown <span class="libera-citation libera-citation-unresolved" data-libera-citation="[@nobody]">[@nobody]</span> and <em>more</em> <span class="libera-citation" data-libera-citation="[@a_b; @c]">(<i>A</i> 2001; C 2002)</span></p>`,
    `<section class="libera-bibliography" data-libera-bibliography=""><h2>References</h2><p>Smith, J. (2020). <i>Sparse coding</i>.</p></section>`,
    `<p>After the list.</p>`,
    `</div>`,
  ].join("");
  document.body.replaceChildren(host);
  return host.firstElementChild as HTMLElement;
}

function selectAll(container: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(container);
  return range;
}

test("copying the preview writes citation tokens and drops the bibliography", () => {
  const container = preview();
  const markdown = getRenderedSelectionMarkdown(container, selectAll(container));
  assert.equal(markdown, [
    `Sparse codes help ${RAW} a lot.`,
    "",
    "Unknown [@nobody] and *more* [@a_b; @c]",
    "",
    "After the list.",
  ].join("\n"));
  assert.doesNotMatch(markdown, /References|Smith, J\.|liberacite/);
});

test("a selection that starts or ends inside a citation copies the whole token", () => {
  const container = preview();
  const [first, , second] = container.querySelectorAll<HTMLElement>("[data-libera-citation]");
  let range = document.createRange();
  range.setStart(first.firstChild!, 5);
  range.setEnd(container.querySelector("p")!.lastChild!, 4);
  assert.equal(getRenderedSelectionMarkdown(container, range), `${RAW} a l`);

  range = document.createRange();
  range.setStart(container.querySelector("p")!.firstChild!, 7);
  range.setEnd(first.firstChild!, 2);
  assert.equal(getRenderedSelectionMarkdown(container, range), `codes help ${RAW}`);

  range = document.createRange();
  range.setStart(second.querySelector("i")!.firstChild!, 0);
  range.setEnd(second.lastChild!, 2);
  assert.equal(getRenderedSelectionMarkdown(container, range), "[@a_b; @c]", "inside one citation");

  range = document.createRange();
  range.setStart(container.querySelector("section h2")!.firstChild!, 3);
  range.setEnd(container.lastElementChild!.firstChild!, 5);
  assert.equal(getRenderedSelectionMarkdown(container, range), "After", "a selection starting in the bibliography");
});

test("the copy handler puts the tokens on the clipboard", () => {
  const container = preview();
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(selectAll(container));
  const data = new Map<string, string>();
  let prevented = false;
  const handled = copyRenderedMarkdownSelection(container.parentElement!, {
    clipboardData: { clearData: () => data.clear(), setData: (type: string, value: string) => void data.set(type, value) } as unknown as DataTransfer,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.match(data.get("text/plain")!, /Sparse codes help \[see @smith2020sparse, p\. 3; -@doe_2019, "quoted" & <more>\] a lot\./);
});

test("search embeds a citation as its keys", () => {
  assert.equal(
    embeddingText("markdown", "As shown [@smith2020sparse, p. 12; -@doe:2019] and [link](https://x.y), but not `[@code]`."),
    "As shown smith2020sparse doe:2019 and link, but not `[@code]`.",
  );
  assert.equal(embeddingText("markdown", "Mail me@example.com [@]"), "Mail me@example.com [@]");
  assert.equal(embeddingText("latex", "\\cite{x} [@a]"), "\\cite{x} [@a]", "only Markdown has citations");
  const [chunk] = chunkMarkdown("# Methods\n\nWe follow [see @lee2019deep, ch. 2].");
  assert.match(documentPrompt("markdown", "Paper", chunk), /We follow lee2019deep\./);
  assert.match(chunk.text, /\[see @lee2019deep, ch\. 2\]/, "passages keep the source text for keyword search");
});

test("outline passage words read a citation as its keys", () => {
  assert.equal(markdownPassageWords("- See [@Smith2020, p. 3; @doe] **now** and [x](y)"), "see smith2020 doe now and x");
  assert.equal(markdownPassageWords("$[@not]$ text"), "text");
});

test("word count counts one word per cited item", () => {
  assert.equal(getMarkdownWordCountStats("One [@a; @b, p. 12] two").words, 4);
  assert.equal(getMarkdownWordCountStats("[see @smith2020sparse, chapter 3, emphasis added]").words, 1);
  assert.equal(getMarkdownWordCountStats("Code `[@x; @y]` here").words, 2);
  assert.equal(getMarkdownWordCountStats("Text [@a].\n\n:::bibliography\n:::\n").words, 2, "the bibliography marker is not counted");
  assert.equal(getMarkdownWordCountStats("Mail me@example.com").words, 3);
});

test("the agent prompt describes citations and stays static", () => {
  const options = { permission: "notebook" as const, mathInstruction: "Use $ for math." };
  const prompt = buildAgentSystemPrompt(options);
  for (const syntax of ["[@key]", "[@key, p. 12]", "[@a; @b]", "[-@key]"]) assert.ok(prompt.includes(syntax), syntax);
  assert.match(prompt, /References library/);
  assert.match(prompt, /never invent a citation key/);
  assert.equal(buildAgentSystemPrompt(options), prompt);
});
